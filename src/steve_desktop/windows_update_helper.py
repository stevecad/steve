"""Standalone, windowless Python updater. Runs outside the installation it replaces."""
import argparse
import ctypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import psutil


def inventory(folder):
    result = {}
    for path in sorted(folder.rglob('*')):
        if path.is_symlink() or path.is_junction():
            raise ValueError('Update paths cannot contain links or junctions.')
        if path.is_file():
            with path.open('rb') as stream:
                result[path.relative_to(folder).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return result


def protected_json(path):
    import win32crypt
    if not path.exists():
        return {}
    _, value = win32crypt.CryptUnprotectData(path.read_bytes(), None, None, None, 1)
    return json.loads(value)


def staged(profile):
    from steve_desktop.update_manifest import verify_stored
    root = (profile / 'updates').resolve()
    state = protected_json(profile / 'windows-update.dpapi')
    config = protected_json(profile / 'updates.dpapi')
    resources = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[2]))
    channel = json.loads((resources / 'assets/update-channel.json').read_text(encoding='utf-8'))
    settings = {'override': config['override']} if isinstance(config.get('override'), dict) else {}
    verify_stored(state['manifest'], channel, settings, 'windows-x64')
    candidate = root / state['candidate']
    if candidate.name != 'Steve' or not candidate.resolve().is_relative_to(root):
        raise ValueError('Candidate outside update directory.')
    for part in (candidate, *candidate.parents):
        if part == root.parent:
            break
        if part.is_symlink() or part.is_junction():
            raise ValueError('Candidate contains a link or junction.')
    if not candidate.is_dir() or inventory(candidate) != state['files']:
        raise ValueError('Staged update files have changed. Download the update again.')
    return candidate.resolve()


def spawn(command, cwd):
    """Do not leak this frozen helper's DLL/plugin search paths to another app."""
    env = dict(os.environ)
    for key in ('QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH', 'PYTHONHOME', 'PYTHONPATH'):
        env.pop(key, None)
    previous = ctypes.create_unicode_buffer(32768)
    ctypes.windll.kernel32.GetDllDirectoryW(len(previous), previous)
    ctypes.windll.kernel32.SetDllDirectoryW(None)
    try:
        return subprocess.Popen(command, cwd=cwd, env=env, creationflags=subprocess.CREATE_NO_WINDOW,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        ctypes.windll.kernel32.SetDllDirectoryW(previous.value or None)


def running(installed):
    executable = installed / 'Steve.exe'
    for process in psutil.process_iter(['exe']):
        try:
            if process.info['exe'] and Path(process.info['exe']).resolve() == executable:
                return True
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
    return False


def wait_for_exit(installed, parent, created):
    try:
        process = psutil.Process(parent)
        if abs(process.create_time() - created) < .01:
            process.wait()  # Never terminate an application containing unsaved work.
    except psutil.NoSuchProcess:
        pass
    deadline = time.monotonic() + 30
    while running(installed):
        if time.monotonic() >= deadline:
            raise RuntimeError('Steve is still running; update was not installed.')
        time.sleep(.2)


def smoke(candidate, root):
    process = spawn([str(candidate / 'Steve.exe'), '--smoke-test', '--update-smoke'], root)
    try:
        code = process.wait(timeout=120)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise RuntimeError('Update startup verification timed out.')
    if code:
        raise RuntimeError('Update startup verification failed.')


def activate(installed, candidate, root, progress):
    """Swap only checked sibling directories, retaining the old app on failure."""
    backup = installed.with_name('Steve.previous')
    if backup.exists():
        raise RuntimeError('Previous update backup already exists; recovery required.')
    if running(installed):
        raise RuntimeError('Steve reopened; update was not installed.')
    progress('Checking the new version…')
    smoke(candidate, root)
    records = installed / 'uninstall'
    target_records = candidate / 'uninstall'
    if target_records.exists():
        raise ValueError('Candidate contains installer records; download a fresh candidate.')
    if records.exists():
        if records.is_symlink() or records.is_junction():
            raise ValueError('Installer records contain a link or junction.')
        inventory(records)
        shutil.copytree(records, target_records)
    if running(installed):
        raise RuntimeError('Steve reopened; update was not installed.')
    progress('Installing Steve…')
    installed.rename(backup)
    try:
        candidate.rename(installed)
    except Exception:
        backup.rename(installed)
        raise
    warning = None
    try:
        # This fixed sibling was created by the immediately preceding rename.
        if backup.parent != installed.parent or backup.name != 'Steve.previous' or backup.is_symlink() or backup.is_junction():
            raise ValueError('Invalid backup directory.')
        shutil.rmtree(backup)
    except OSError:
        warning = 'Previous-version cleanup needs attention.'
    return warning


def apply(installed, profile, parent, created, restart=False, progress=lambda message: None):
    installed, profile = Path(installed).absolute(), Path(profile).resolve()
    root = profile / 'updates'
    root.mkdir(parents=True, exist_ok=True)
    report = root / 'last-update.json'
    result = {'status': 'failed', 'time': datetime.now(timezone.utc).isoformat()}
    try:
        if installed.name != 'Steve' or installed.is_symlink() or installed.is_junction():
            raise ValueError('Invalid application directory.')
        installed = installed.resolve()
        if root.is_relative_to(installed) or installed.is_relative_to(root):
            raise ValueError('Updater must run outside the installation.')
        if getattr(sys, 'frozen', False) and Path(sys.executable).resolve().is_relative_to(installed):
            raise ValueError('Updater executable is inside the installation.')
        if not (installed / 'Steve.exe').is_file():
            raise ValueError('Installed executable is missing.')
        os.chdir(root)
        progress('Waiting for Steve to close…')
        wait_for_exit(installed, parent, created)
        progress('Verifying the downloaded update…')
        candidate = staged(profile)
        warning = activate(installed, candidate, root, progress)
        result['status'] = 'installed'
        if warning:
            result['warning'] = warning
    except Exception as exc:
        result['error'] = str(exc)
    finally:
        # One attempt per authenticated staging record; avoid a startup retry loop.
        (profile / 'windows-update.dpapi').unlink(missing_ok=True)
        temporary = report.with_suffix('.tmp')
        temporary.write_text(json.dumps(result), encoding='utf-8')
        os.replace(temporary, report)
    if restart and (installed / 'Steve.exe').is_file():
        spawn([str(installed / 'Steve.exe')], root)
    return 0 if result['status'] == 'installed' else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--installed', type=Path, required=True)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--parent', type=int, required=True)
    parser.add_argument('--created', type=float, required=True)
    parser.add_argument('--restart', action='store_true')
    args = parser.parse_args()
    from PySide6.QtCore import QThread, Signal, Qt, QTimer
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication, QProgressDialog

    class Worker(QThread):
        stage = Signal(str)
        result = Signal(int)

        def run(self):
            self.result.emit(apply(args.installed, args.profile, args.parent, args.created,
                                   args.restart, self.stage.emit))

    app = QApplication([])
    app.setApplicationName('Steve')
    app.setStyleSheet('QWidget { background: #171d1f; color: #e7eeeb; font: 11pt "Segoe UI"; } '
                     'QProgressBar { border: 1px solid #344a42; border-radius: 4px; background: #101617; } '
                     'QProgressBar::chunk { background: #a7e9cb; }')
    icon = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[2])) / 'assets/steve.ico'
    app.setWindowIcon(QIcon(str(icon)))
    dialog = QProgressDialog('Preparing the update…', None, 0, 0)
    dialog.setWindowTitle('Updating Steve')
    dialog.setWindowFlag(Qt.WindowCloseButtonHint, False)
    dialog.setMinimumSize(440, 130)
    dialog.setMinimumDuration(0)
    dialog.show()
    worker = Worker()
    worker.stage.connect(dialog.setLabelText)
    outcome = [1]
    worker.result.connect(lambda code: outcome.__setitem__(0, code))
    worker.finished.connect(app.quit)
    QTimer.singleShot(0, worker.start)
    app.exec()
    worker.wait()
    return outcome[0]

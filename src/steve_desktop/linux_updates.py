"""Verified per-user Linux bundles, atomic activation and startup rollback.

The original AppImage/tarball remains a stable launcher. Mutable state is
authenticated by the OS-backed vault; complete bundles live outside projects.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import select
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import uuid

from packaging.version import Version


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def state_vault(profile):
    from steve_desktop.vault import Vault
    return Vault(Path(profile) / 'update-state.dpapi')


def prune_bundles(profile):
    state=state_vault(profile).load()
    keep={state[key]['directory'] for key in ('active','previous','pending') if state.get(key)}
    root=Path(profile)/'updates/bundles'
    if not root.is_dir():return
    for path in root.iterdir():
        try:uuid.UUID(path.name)
        except ValueError:continue
        if path.name in keep or path.is_symlink() or not path.is_dir():continue
        if Path(sys.executable).resolve().is_relative_to(path.resolve()):continue
        shutil.rmtree(path)


def write_report(profile, **fields):
    root = Path(profile) / 'updates'
    root.mkdir(parents=True, exist_ok=True)
    target = root / 'last-update.json'
    temporary = target.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(dict(fields, time=time.time()), stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(target)


def bundle_path(profile, bundle):
    name = bundle['directory']
    if not isinstance(name, str) or not name or Path(name).name != name or name in ('.', '..'):
        raise ValueError('Invalid update bundle directory.')
    root = (Path(profile) / 'updates/bundles').resolve()
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError('Update bundle is outside its storage directory.')
    return path


def executable(profile, bundle):
    return bundle_path(profile, bundle) / 'package/Steve/usr/lib/steve/Steve'


def inventory(root):
    result = {}
    for path in sorted(Path(root).rglob('*')):
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            if not path.resolve().is_relative_to(Path(root).resolve()) or not path.exists():
                raise ValueError('Update contains a broken or escaping symbolic link.')
            result[name] = {'link': os.readlink(path)}
        elif path.is_file():
            result[name] = {'sha256': digest(path), 'mode': path.stat().st_mode & 0o777}
        elif path.is_dir():
            result[name] = {'directory': True}
        else:
            raise ValueError('Update contains a special file.')
    return result


def extract_bundle(archive, destination):
    """Preserve internal Qt/OCP links, reject traversal, hard links and devices."""
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tarfile.open(archive, 'r|gz') as tar:
        names = set()
        size=0
        for member in tar:
            size+=member.size
            if len(names)>=100000 or size>8_000_000_000:
                raise ValueError('Update expands beyond the package limits.')
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts or
                    path.parts[0] != 'Steve' or '\\' in member.name or
                    member.name in names or not (member.isdir() or member.isfile() or member.issym())):
                raise ValueError('Unsafe path or file type in Linux update.')
            names.add(member.name)
            if member.issym() and (path == PurePosixPath('Steve') or PurePosixPath(member.linkname).is_absolute()):
                raise ValueError('Unsafe symbolic link in Linux update.')
            tar.extract(member,destination,filter='data')
    app = destination / 'Steve/usr/lib/steve/Steve'
    if not app.is_file() or app.is_symlink() or not os.access(app, os.X_OK):
        raise ValueError('Linux update is missing its executable.')
    for path in destination.rglob('*'):
        if path.is_symlink() and (not path.exists() or not path.resolve().is_relative_to(destination.resolve())):
            raise ValueError('Update contains a broken or escaping symbolic link.')
    return app


def stage_bundle(profile, archive, manifest, public_keys, host):
    """`manifest` was just fetched and verified (including expiry) by the caller."""
    from steve_desktop.update_manifest import verify_manifest
    verified = verify_manifest(manifest, public_keys, expected_platform='linux-x64', host=host, check_expiry=False)
    if digest(archive) != verified['sha256']:
        raise ValueError('Update checksum does not match signed manifest.')
    directory = str(uuid.uuid4())
    root = Path(profile) / 'updates/bundles' / directory
    root.mkdir(parents=True, mode=0o700)
    try:
        extract_bundle(archive, root / 'package')
        metadata=json.loads((root/'package/Steve/bundle.json').read_text())
        if metadata != {'schema':1,'version':manifest['version'],'platform':'linux-x64'}:
            raise ValueError('Update bundle metadata does not match its signed manifest.')
        files = root / 'inventory.json'
        files.write_text(json.dumps(inventory(root / 'package'), sort_keys=True, separators=(',', ':')))
        descriptor = {'directory': directory, 'manifest': manifest, 'inventory_sha256': digest(files)}
        state = state_vault(profile).load()
        state['pending'] = descriptor
        state_vault(profile).save(state)
        return descriptor
    except BaseException:
        shutil.rmtree(root)
        raise


def verify_bundle(profile, bundle):
    # Installed bundles stay valid after their feed manifest expires; only the
    # signature, platform and download host are re-checked on every launch.
    from steve_desktop.local_updates import stored_manifest
    stored_manifest(bundle['manifest'], profile, 'linux-x64')
    root = bundle_path(profile, bundle)
    files = root / 'inventory.json'
    try:
        if digest(files) != bundle['inventory_sha256']:
            raise ValueError('Update inventory has changed.')
        if inventory(root / 'package') != json.loads(files.read_text()):
            raise ValueError('Update bundle is incomplete or has changed.')
    except FileNotFoundError as exc:
        raise ValueError('Update bundle is incomplete.') from exc
    return executable(profile, bundle)


def candidate_environment():
    from steve_desktop.host_environment import host_environment
    env = host_environment()
    env['PYINSTALLER_RESET_ENVIRONMENT'] = '1'
    env.pop('STEVE_BUNDLE_READY_FD', None)
    env.pop('STEVE_BUNDLE_CHILD', None)
    return env


def smoke_bundle(profile, bundle):
    app = verify_bundle(profile, bundle)
    env = candidate_environment()
    result = subprocess.run([str(app), '--update-info'], env=env, capture_output=True, text=True, timeout=30)
    if result.returncode or json.loads(result.stdout)['version'] != bundle['manifest']['version']:
        raise ValueError('Update executable version does not match its signed manifest.')
    logpath = bundle_path(profile, bundle) / 'startup.log'
    with logpath.open('wb') as log:
        for attempt in range(2):
            log.write(f'Startup verification attempt {attempt+1}\n'.encode());log.flush()
            try:
                result = subprocess.run([str(app), '--smoke-test', '--update-smoke'], env=env,
                                        stdout=log, stderr=log, timeout=120)
            except subprocess.TimeoutExpired:
                if attempt==0:continue
                raise
            if result.returncode==0:break
    if result.returncode:
        raise ValueError('Update startup verification failed; the working version was retained.')
    verify_bundle(profile, bundle)


def process_identity(pid):
    try:
        fields=(Path('/proc')/str(pid)/'stat').read_text().rsplit(') ',1)[1].split()
        return None if fields[0]=='Z' else fields[19]
    except (FileNotFoundError,ProcessLookupError):
        return None


def wait_for_parent(pid, timeout=180, identity=None):
    current=process_identity(pid)
    if current is None or (identity is not None and current!=identity):return
    if hasattr(os,'pidfd_open'):
        try:fd=os.pidfd_open(pid)
        except ProcessLookupError:return
        try:
            if not select.select([fd], [], [], timeout)[0]:
                raise TimeoutError('Steve is still running; the update remains staged.')
        finally:os.close(fd)
        return
    # Some standalone Python builds lack pidfd_open. Linux start ticks protect
    # the fallback from waiting for an unrelated process after PID reuse.
    deadline=time.monotonic()+timeout
    while process_identity(pid)==current:
        if time.monotonic()>=deadline:
            raise TimeoutError('Steve is still running; the update remains staged.')
        time.sleep(.1)


def stable_launcher():
    """The original package the person runs: the AppImage file, or the extracted installation's executable.

    Inside an activated bundle the launcher that started it is in STEVE_BUNDLE_LAUNCHER (set by launch_bundle);
    an AppImage's own mount path changes on every launch, so its file path is used instead.
    """
    return os.environ.get('STEVE_BUNDLE_LAUNCHER') or os.environ.get('APPIMAGE') or sys.executable


def reopen(launcher):
    """Start the stable launcher again, detached, after a successful activation ("Restart and update")."""
    # A fresh launch: host libraries, PyInstaller told to start as its own application, and nothing from this
    # update process or the bundle it came from that would steer the launcher (an AppImage sets its own again).
    env = candidate_environment()
    for name in ('STEVE_BUNDLE_LAUNCHER', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'):
        env.pop(name, None)
    return subprocess.Popen([str(launcher)], env=env, cwd=str(Path.home()), stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True, close_fds=True)


def activate(profile, directory, parent_pid, parent_identity=None, restart=None):
    """Invoked by a detached copy of the verified candidate runtime.

    `restart` is the stable launcher to start again once the new version is active; a failed or deferred
    activation never reopens Steve.
    """
    from PySide6.QtCore import QLockFile
    profile = Path(profile).resolve()
    try:
        if parent_pid is not None:wait_for_parent(parent_pid,identity=parent_identity)
    except Exception as exc:
        write_report(profile,status='deferred',error=str(exc))
        return 1
    lock = QLockFile(str(profile / 'instance.lock'))
    lock.setStaleLockTime(0)
    if not lock.tryLock(1000):
        write_report(profile, status='deferred', error='Steve reopened; the update remains staged.')
        return 0
    bundle = None
    installed = False
    try:
        state = state_vault(profile).load()
        bundle = state.get('pending')
        if not bundle or bundle['directory'] != directory:
            return 0
        if state.get('active') and Version(bundle['manifest']['version'])<=Version(state['active']['manifest']['version']):
            state.pop('pending',None)
            state_vault(profile).save(state)
            return 0
        smoke_bundle(profile, bundle)
        # Vault.save uses a flushed temporary file and atomic replace. Neither
        # the running executable nor the previous complete bundle is modified.
        state = state_vault(profile).load()
        if state.get('pending', {}).get('directory') != directory:
            return 0
        state['previous'] = state.get('active')
        state['active'] = bundle
        state.pop('pending', None)
        state_vault(profile).save(state)
        installed = True
        try:
            write_report(profile, status='installed', version=bundle['manifest']['version'])
            prune_bundles(profile)
        except OSError:
            pass  # A cleanup failure cannot invalidate an activated healthy bundle.
        return 0
    except OSError as exc:
        # Disk/permission failures are retriable, not evidence of a bad release.
        try:write_report(profile,status='deferred',error=str(exc))
        except OSError:pass
        return 1
    except Exception as exc:
        if bundle:
            state = state_vault(profile).load()
            state['failed'] = list(dict.fromkeys([*state.get('failed', []), bundle['manifest']['sha256']]))[-8:]
            state.pop('pending', None)
            state_vault(profile).save(state)
        write_report(profile, status='failed', error=str(exc))
        return 1
    finally:
        lock.unlock()
        # After the profile lock is released, or the reopened Steve would find it held.
        if installed and restart:
            try:
                reopen(restart)
            except OSError as exc:
                try:write_report(profile, status='installed', version=bundle['manifest']['version'],
                                 error='Steve could not be reopened: ' + str(exc))
                except OSError:pass


def schedule_activation(profile, bundle, restart=None):
    """`restart`: the stable launcher to reopen after a successful activation (see stable_launcher)."""
    app = verify_bundle(profile, bundle)
    logpath = Path(profile) / 'updates/apply.log'
    command = [str(app), '--apply-linux-update', str(Path(profile).resolve()),
               bundle['directory'], str(os.getpid()), process_identity(os.getpid())]
    if restart:
        command.append(str(restart))
    with logpath.open('ab') as log:
        subprocess.Popen(command, env=candidate_environment(),
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True, close_fds=True)


def notify_ready():
    value = os.environ.pop('STEVE_BUNDLE_READY_FD', None)
    if value:
        fd = int(value)
        try:
            os.write(fd, b'1')
        except BrokenPipeError:
            pass
        finally:
            os.close(fd)


def watch_frontend_ready(window):
    if not os.environ.get('STEVE_BUNDLE_READY_FD'):
        return
    from PySide6.QtCore import QTimer
    timer=QTimer(window)
    window.bundle_ready_timer=timer
    def ready(value):
        if value:
            timer.stop()
            notify_ready()
    timer.timeout.connect(lambda: window.cad_panel.page.runJavaScript(
        "document.readyState === 'complete' && !!document.querySelector('#root > *')",ready))
    timer.start(100)


def launch_bundle(app, args, timeout=45):
    """Monitor startup; report failure only before the new GUI/MCP is ready."""
    read_fd, write_fd = os.pipe()
    env = candidate_environment()
    env.update(STEVE_BUNDLE_CHILD=str(app), STEVE_BUNDLE_READY_FD=str(write_fd))
    env['STEVE_BUNDLE_LAUNCHER']=os.environ.get('STEVE_BUNDLE_LAUNCHER') or os.environ.get('APPIMAGE') or sys.executable
    try:
        child = subprocess.Popen([str(app), *args], env=env, pass_fds=(write_fd,))
    finally:
        os.close(write_fd)
    try:
        ready = bool(select.select([read_fd], [], [], timeout)[0] and os.read(read_fd, 1) == b'1')
    finally:
        os.close(read_fd)
    if not ready:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        return None
    previous_handlers = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous_handlers[sig] = signal.signal(sig, lambda signum, frame: child.send_signal(signum) if child.poll() is None else None)
    try:
        return child.wait()
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)


def bootstrap():
    """The original package selects a complete authenticated version on launch."""
    if sys.platform != 'linux' or not getattr(sys, 'frozen', False):
        return None
    if any(flag in sys.argv for flag in ('--cad-worker', '--smoke-test', '--apply-linux-update', '--update-info')):
        return None
    if os.environ.get('STEVE_BUNDLE_CHILD') == str(Path(sys.executable)):
        return None
    from steve_desktop.local_updates import VERSION
    from steve_desktop.vault import data_directory
    profile = data_directory()
    vault = state_vault(profile)
    try:
        state = vault.load()
    except Exception as exc:
        write_report(profile,status='rolled-back',error='Update state could not be opened: '+str(exc))
        return None
    if state.get('pending') and not any(flag in sys.argv for flag in ('--mcp','--update-check','--update-status')):
        from steve_desktop.vault import Vault
        try:
            if Vault(profile/'updates.dpapi').load().get('automatic',True):
                # Recover an interrupted shutdown/download on the next GUI launch.
                activate(profile,state['pending']['directory'],None)
                state=vault.load()
        except Exception as exc:
            write_report(profile,status='deferred',error=str(exc))
    while state.get('active'):
        bundle = state['active']
        if Version(bundle['manifest']['version']) < Version(VERSION):
            return None
        try:
            app = verify_bundle(profile, bundle)
            if app.resolve() == Path(sys.executable).resolve():
                return None
            for _ in range(2):
                result = launch_bundle(app, sys.argv[1:])
                if result is not None:
                    return result
            raise ValueError('The updated application failed before startup completed.')
        except Exception as exc:
            try:
                state = vault.load()
                if (state.get('active') or {}).get('directory') != bundle['directory']:
                    return None
                state['failed'] = list(dict.fromkeys([*state.get('failed', []), bundle['manifest']['sha256']]))[-8:]
                state['active'] = state.pop('previous', None)
                vault.save(state)
            except Exception:
                write_report(profile,status='rolled-back',error=str(exc))
                return None
            write_report(profile, status='rolled-back', error=str(exc))
    return None

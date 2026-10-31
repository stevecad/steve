"""Authenticated staging and startup recovery for the Windows installer layout."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
from steve_desktop.vault import Vault
from steve_desktop.paths import RESOURCE_ROOT


def inventory(folder, progress=lambda: None):
    files={}
    for path in sorted(folder.rglob('*')):
        if path.is_symlink():raise ValueError('Update contains a symbolic link.')
        if path.is_file():
            with path.open('rb') as stream:files[path.relative_to(folder).as_posix()]=hashlib.file_digest(stream,'sha256').hexdigest()
            progress()
    return files


def remember(profile, candidate, manifest):
    root=Path(profile)/'updates'
    candidate=Path(candidate).resolve()
    if not candidate.is_relative_to(root.resolve()):raise ValueError('Candidate outside update folder.')
    Vault(Path(profile)/'windows-update.dpapi').save({
        'candidate':candidate.relative_to(root.resolve()).as_posix(),
        'manifest':manifest,'files':inventory(candidate)})


def pending(profile, progress=lambda: None):
    from steve_desktop.local_updates import VERSION, stored_manifest
    from packaging.version import Version
    vault=Vault(Path(profile)/'windows-update.dpapi')
    state=vault.load()
    if not state:return None
    config=Vault(Path(profile)/'updates.dpapi').load()
    manifest=stored_manifest(state['manifest'],profile,'windows-x64')
    if Version(manifest['version'])<=Version(VERSION):
        vault.path.unlink(missing_ok=True)
        if config.pop('apply_requested',None):Vault(Path(profile)/'updates.dpapi').save(config)
        return None
    root=(Path(profile)/'updates').resolve()
    candidate=root/state['candidate']
    if not candidate.resolve().is_relative_to(root) or candidate.name!='Steve':raise ValueError('Invalid staged update path.')
    if not candidate.is_dir():raise ValueError('Staged update files are missing.')
    if inventory(candidate,progress)!=state['files']:raise ValueError('Staged update files have changed. Download the update again.')
    return candidate


def launch(profile, candidate, *, restart=False):
    root=(Path(profile)/'updates').resolve()
    import psutil
    helper=root/'SteveUpdate.exe'
    shutil.copy2(RESOURCE_ROOT/'packaging/SteveUpdate.exe',helper)
    command=[str(helper),'--installed',str(Path(sys.executable).resolve().parent),
             '--profile',str(Path(profile).resolve()),'--parent',str(os.getpid()),
             '--created',str(psutil.Process().create_time())]
    if restart:command.append('--restart')
    return subprocess.Popen(command,cwd=str(root),creationflags=subprocess.CREATE_NO_WINDOW)



def on_startup(profile, app):
    """Called with the profile's instance lock held, before opening any document."""
    import json
    if not getattr(sys,'frozen',False) or os.name!='nt':return False
    if not (Path(profile)/'windows-update.dpapi').exists():return False
    config=Vault(Path(profile)/'updates.dpapi').load()
    if not config.get('automatic',True) and not config.get('apply_requested',False):return False
    from PySide6.QtWidgets import QProgressDialog
    dialog=QProgressDialog('Verifying the downloaded update…',None,0,0)
    dialog.setWindowTitle('Steve update');dialog.setMinimumDuration(0);dialog.show();app.processEvents()
    try:
        candidate=pending(profile,app.processEvents)
        if candidate:
            launch(profile,candidate,restart=True)
            return True
    except Exception as exc:
        root=Path(profile)/'updates'
        (root/'last-update.json').write_text(json.dumps({'status':'failed','error':str(exc)}),encoding='utf-8')
        # Do not trap the user in an update loop; the existing app stays usable.
        Vault(Path(profile)/'windows-update.dpapi').path.unlink(missing_ok=True)
    finally:dialog.close()
    return False

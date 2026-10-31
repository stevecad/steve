"""Read compatibility only. Retired product identifiers never appear in the UI."""
from pathlib import Path
import shutil
import sqlite3
from contextlib import closing
import tempfile

ARCHIVE_FORMATS = ('steve.project', 'stevelocal.project')


def migrate_profile(base):
    base = Path(base).resolve()
    # Steve may also host other applications/runtimes; CAD owns only this child.
    target = base / 'Steve' / 'CAD'
    markers = ('credentials.dpapi', 'chats.dpapi', 'mcp-settings.dpapi', 'agent-settings.dpapi', 'cad/catalog.json')
    if any((target / name).exists() for name in markers):
        return target
    candidates = [base / name for name in ('SteveLocal', 'SubscriptionAgent')]
    source = next((p for p in candidates if any((p / name).exists() for name in markers)), None)
    if source is None:
        return target
    # Copy first: keep the original intact if interruption or a locked file aborts.
    # No deletion of the old profile is needed to switch the application name.
    staging = Path(tempfile.mkdtemp(prefix='Steve-migration-',dir=base))
    if (source / 'instance.lock').exists():
        from PySide6.QtCore import QLockFile
        lock = QLockFile(str(source / 'instance.lock'))
        if not lock.tryLock(100):
            raise RuntimeError('Close the previous Steve application before migrating your profile.')
        lock.unlock()
    shutil.copytree(source, staging, dirs_exist_ok=True, ignore=shutil.ignore_patterns('instance.lock'))
    migrate_memory(staging / 'memory.sqlite3')
    if target.exists():
        if any(target.iterdir()):
            raise RuntimeError('The Steve profile folder already contains files. Both profiles have been preserved.')
        target.rmdir()
    target.parent.mkdir(exist_ok=True)
    staging.rename(target)
    return target


def migrate_memory(path):
    if not path.exists(): return
    with closing(sqlite3.connect(path)) as db, db:
        if not db.execute("SELECT name FROM sqlite_master WHERE name='memory_files'").fetchone(): return
        rows = db.execute("SELECT path FROM memory_files WHERE path LIKE 'stevelocal/%'").fetchall()
        for (old,) in rows:
            new = 'steve/' + old.split('/', 1)[1]
            if not db.execute('SELECT 1 FROM memory_files WHERE path=?', (new,)).fetchone():
                db.execute('UPDATE memory_files SET path=? WHERE path=?', (new, old))


def legacy_keyring_key(keyring):
    return keyring.get_password('SteveLocal', 'vault-encryption-key')

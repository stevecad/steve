"""Run checks with a disposable home, Secret Service, D-Bus session and X server."""
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import re


def unmount_session_filesystems(runtime):
    runtime=Path(runtime)
    if runtime.name!='run' or not runtime.parent.name.startswith('steve-check-'):
        raise ValueError('Refusing to detach filesystems outside an isolated Steve test session.')
    unmount=shutil.which('fusermount3') or shutil.which('fusermount')
    if not unmount:return
    mounts=[]
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        entry,kind=line.split(' - ',1)
        if not kind.split()[0].startswith('fuse'):continue
        name=re.sub(r'\\([0-7]{3})',lambda match:chr(int(match[1],8)),entry.split()[4])
        path=Path(name)
        if path.is_relative_to(runtime):mounts.append(path)
    for path in sorted(mounts,key=lambda path:len(path.parts),reverse=True):
        subprocess.run([unmount,'-u','-z',str(path)],check=True,timeout=15)


def main():
    if sys.platform != 'linux':
        raise SystemExit('This helper requires Linux.')
    args = sys.argv[1:]
    inside = args and args[0] == '--inside-session'
    if inside:
        args.pop(0)
    if args and args[0] == '--':
        args.pop(0)
    if not args:
        raise SystemExit('Usage: python tools/linux_session.py -- COMMAND [ARGS...]')
    if inside:
        subprocess.run(['gnome-keyring-daemon', '--unlock', '--components=secrets'],
                       input=secrets.token_urlsafe(32).encode(), stdout=subprocess.DEVNULL, check=True)
        try:
            return subprocess.run(args).returncode
        finally:
            # Browser tests can activate a document-portal FUSE mount. Detach
            # this session's mount while D-Bus is alive, before deleting its home.
            unmount_session_filesystems(os.environ['XDG_RUNTIME_DIR'])
    for tool in ('dbus-run-session', 'gnome-keyring-daemon', 'xvfb-run'):
        if not shutil.which(tool):
            raise SystemExit(f'Missing {tool}; see docs/LINUX.md for build dependencies.')
    with tempfile.TemporaryDirectory(prefix='steve-check-') as folder:
        env = dict(os.environ, HOME=folder, XDG_CONFIG_HOME=folder + '/config',
                   XDG_DATA_HOME=folder + '/data', XDG_CACHE_HOME=folder + '/cache',
                   XDG_RUNTIME_DIR=folder + '/run', QT_QPA_PLATFORM='xcb',
                   QT_QUICK_BACKEND='software', QT_OPENGL='software',
                   QTWEBENGINE_CHROMIUM_FLAGS='--disable-gpu --disable-dev-shm-usage')
        Path(env['XDG_RUNTIME_DIR']).mkdir(mode=0o700)
        env.pop('DBUS_SESSION_BUS_ADDRESS', None)
        env.pop('GNOME_KEYRING_CONTROL', None)
        env.pop('QTWEBENGINE_DISABLE_SANDBOX', None)
        # Activated desktop services must inherit the same DISPLAY as the test.
        try:
            return subprocess.run(['xvfb-run', '-a', 'dbus-run-session', '--', sys.executable,
                                   str(Path(__file__).resolve()), '--inside-session', '--', *args], env=env).returncode
        finally:
            # Catch services that mounted GVfs/portal filesystems during teardown.
            unmount_session_filesystems(env['XDG_RUNTIME_DIR'])


if __name__ == '__main__':
    raise SystemExit(main())

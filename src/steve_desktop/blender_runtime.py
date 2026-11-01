"""Optional Blender 4.5 runtime: pinned archives on Windows and Linux, Blender.app on macOS."""
import hashlib
import os
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

VERSION = '4.5.9'
RELEASE = 'https://download.blender.org/release/Blender4.5/'
# Official 4.5.9 archives are a few hundred megabytes. These caps stop a
# redirected or truncated response from filling the disk before the SHA-256
# check can reject it, and reject a zip-bomb header after the hash matches.
MAX_DOWNLOAD = 2 * 1024**3
MAX_UNPACKED = 8 * 1024**3
PACKAGES = {
    ('Windows', 'AMD64'): ('windows-x64.zip', '41da973b9bf95bb312cbeff4d1982feb13259b43c821686b9bafea4dfe5477cf'),
    ('Windows', 'ARM64'): ('windows-arm64.zip', '1415f53f483a8d9040f459ab8c3a330c4523ef8f76f5f2db5a95fb2d5be54d4d'),
    ('Linux', 'x86_64'): ('linux-x64.tar.xz', 'dcdc3eca6c9825bb35a8033b689c053f3cb5a9b0cd2a61b2eac2a49436b4ad3d'),
}


def executable(folder):
    return Path(folder) / ('blender.exe' if os.name == 'nt' else 'blender')


def environment():
    # An external Blender owns its Python and shared libraries, including in frozen Steve.
    env = dict(os.environ)
    env.pop('PYTHONHOME', None)
    env.pop('PYTHONPATH', None)
    if 'LD_LIBRARY_PATH_ORIG' in env:
        env['LD_LIBRARY_PATH'] = env['LD_LIBRARY_PATH_ORIG']
    elif getattr(__import__('sys'), 'frozen', False):
        env.pop('LD_LIBRARY_PATH', None)
    return env


def probe(path):
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise ValueError('Choose the Blender executable, not its folder.')
    result = subprocess.run([str(path), '--version'], capture_output=True, text=True,
                            timeout=15, env=environment(), creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    match = re.search(r'Blender (\d+)\.(\d+)\.(\d+)', result.stdout)
    if result.returncode or not match:
        raise ValueError('This executable did not identify itself as Blender.')
    if tuple(map(int, match.groups()[:2])) != (4, 5):
        raise ValueError('Steve currently supports Blender 4.5 LTS, matching Studio.')
    return {'path': str(path), 'version': '.'.join(match.groups()), 'build': hashlib.sha256(result.stdout.encode()).hexdigest()}


def discover(root, configured=''):
    candidates = [configured, os.environ.get('STEVE_BLENDER', '')]
    candidates += [str(executable(p)) for p in sorted(Path(root).glob('blender-4.5.*'), reverse=True)]
    candidates += [shutil.which('blender') or '']
    if os.name == 'nt':
        candidates += [str(p) for p in (Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Blender Foundation').glob('Blender 4.5*/blender.exe')]
    elif platform.system() == 'Darwin':
        bundles = (Path('/Applications/Blender.app'), Path.home() / 'Applications' / 'Blender.app')
        candidates += [str(bundle / 'Contents' / 'MacOS' / 'Blender') for bundle in bundles]
    else:
        candidates += ['/usr/bin/blender', '/snap/bin/blender']
    for candidate in filter(None, candidates):
        try:
            return probe(candidate)
        except (OSError, ValueError, subprocess.SubprocessError):
            if candidate == configured:
                raise
    return None


def install(root, cancel, progress):
    """Verify a pinned official archive before extracting into a staging directory."""
    package = PACKAGES.get((platform.system(), platform.machine()))
    if not package:
        raise ValueError('Automatic installation is unavailable for this architecture. Configure Blender 4.5 LTS manually.')
    suffix, expected = package
    name = f'blender-{VERSION}-{suffix}'
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    destination = root / name.removesuffix('.zip').removesuffix('.tar.xz')
    if executable(destination).is_file():
        return probe(executable(destination))
    staging = Path(tempfile.mkdtemp(prefix='.installing-', dir=root))
    archive = staging / name
    try:
        digest = hashlib.sha256()
        with urllib.request.urlopen(RELEASE + name, timeout=30) as response, archive.open('wb') as out:
            total = int(response.headers.get('Content-Length', 0) or 0)
            if total > MAX_DOWNLOAD:
                raise ValueError('Blender download exceeds the size limit.')
            done = 0
            while chunk := response.read(1024 * 1024):
                if cancel.is_set():
                    raise ValueError('Blender installation cancelled.')
                done += len(chunk)
                if done > MAX_DOWNLOAD:
                    raise ValueError('Blender download exceeds the size limit.')
                out.write(chunk)
                digest.update(chunk)
                progress(f'Downloading Blender: {done // (1024 * 1024)} MB' + (f' / {total // (1024 * 1024)} MB' if total else ''))
        if digest.hexdigest() != expected:
            raise ValueError('Blender download failed its SHA-256 verification.')
        progress('Extracting verified Blender runtime…')
        if name.endswith('.zip'):
            with zipfile.ZipFile(archive) as source:
                if sum(entry.file_size for entry in source.infolist()) > MAX_UNPACKED:
                    raise ValueError('Blender archive expands too far.')
                for entry in source.infolist():
                    if cancel.is_set():
                        raise ValueError('Blender installation cancelled.')
                    filename = entry.filename.replace('\\', '/')
                    path = PurePosixPath(filename)
                    if (stat.S_ISLNK(entry.external_attr >> 16) or ':' in filename or
                            path.is_absolute() or '..' in path.parts or
                            not (staging / filename).resolve().is_relative_to(staging.resolve())):
                        raise ValueError('Unsafe Blender archive path.')
                    source.extract(entry, staging)
        else:
            with tarfile.open(archive) as source:
                if sum(member.size for member in source.getmembers()) > MAX_UNPACKED:
                    raise ValueError('Blender archive expands too far.')
            with tarfile.open(archive) as source:
                source.extractall(staging, filter='data')
        if cancel.is_set():
            raise ValueError('Blender installation cancelled.')
        unpacked = next(p for p in staging.iterdir() if p.is_dir() and executable(p).is_file())
        probe(executable(unpacked))
        destination = root / unpacked.name
        if destination.exists():
            return probe(executable(destination))
        unpacked.rename(destination)
        return probe(executable(destination))
    finally:
        shutil.rmtree(staging)

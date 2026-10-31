"""Package and verify a Linux x64 frozen Steve directory as AppImage and tar.gz."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch_tool(name, entry):
    target = ROOT / 'build/appimage-tools' / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file() or sha256(target) != entry['sha256']:
        temporary = target.with_suffix('.download')
        with urllib.request.urlopen(entry['url'], timeout=120) as response, temporary.open('wb') as out:
            shutil.copyfileobj(response, out)
        if sha256(temporary) != entry['sha256']:
            temporary.unlink()
            raise ValueError(f'{name} checksum mismatch; review packaging/appimage-tools.json.')
        temporary.replace(target)
    target.chmod(0o755)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=ROOT / 'dist/Steve')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/linux')
    parser.add_argument('--headless', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'linux' or platform.machine() != 'x86_64':
        parser.error('Build on Linux x86_64; cross compilation is not supported.')
    package, output = args.package.resolve(), args.output.resolve()
    if not (package / 'Steve').is_file():
        parser.error('Run python tools/build.py first.')
    version = tomllib.loads((ROOT / 'pyproject.toml').read_text())['project']['version']
    output.mkdir(parents=True, exist_ok=True)
    appdir = ROOT / 'build/Steve.AppDir'
    if appdir.exists():
        shutil.rmtree(appdir)
    payload = appdir / 'usr/lib/steve'
    shutil.copytree(package, payload, symlinks=True)
    shutil.copy2(ROOT / 'packaging/linux/AppRun', appdir / 'AppRun')
    (appdir / 'AppRun').chmod(0o755)
    shutil.copy2(ROOT / 'packaging/linux/steve.desktop', appdir / 'steve.desktop')
    shutil.copy2(ROOT / 'assets/steve-logo.svg', appdir / 'steve.svg')
    (appdir / '.DirIcon').symlink_to('steve.svg')
    # Desktop launchers resolve this executable within the AppImage.
    (appdir / 'usr/bin').mkdir()
    (appdir / 'usr/bin/Steve').symlink_to('../lib/steve/Steve')
    (appdir / 'bundle.json').write_text(json.dumps({'schema':1,'version':version,'platform':'linux-x64'})+'\n')
    if shutil.which('desktop-file-validate'):
        subprocess.run(['desktop-file-validate', str(appdir / 'steve.desktop')], check=True)

    def check(command, logname, env=None):
        if args.headless:
            command = [sys.executable, str(ROOT / 'tools/linux_session.py'), '--', *command]
        logpath = ROOT / 'build/verification' / logname
        logpath.parent.mkdir(parents=True, exist_ok=True)
        with logpath.open('w') as log:
            for attempt in range(2 if logname.endswith('smoke.log') else 1):
                log.write(f'Verification attempt {attempt+1}\n');log.flush()
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=log, timeout=300)
                if result.returncode==0:break
        if result.returncode:
            raise RuntimeError(f'Package verification failed; see {logpath}')

    # Check the relocated payload, including its actual native CAD worker.
    check([sys.executable, str(ROOT / 'checks/check_package.py'), str(payload)], 'appdir-check.log')
    pins = json.loads((ROOT / 'packaging/appimage-tools.json').read_text())
    tool = fetch_tool('appimagetool', pins['appimagetool'])
    runtime = fetch_tool('runtime', pins['runtime'])
    image = output / f'Steve-{version}-linux-x86_64.AppImage'
    env = dict(os.environ, ARCH='x86_64', VERSION=version, APPIMAGE_EXTRACT_AND_RUN='1')
    subprocess.run([str(tool), '--runtime-file', str(runtime), '--comp', 'zstd',
                    '--mksquashfs-opt=-processors', '--mksquashfs-opt=' + str(min(8, os.cpu_count() or 1)),
                    str(appdir), str(image)], cwd=ROOT, env=env, check=True)
    image.chmod(0o755)
    check([str(image), '--smoke-test'], 'appimage-smoke.log', env)
    check([sys.executable, '-m', 'unittest', 'tests.test_local_mcp'], 'appimage-mcp.log',
          dict(env, STEVE_TEST_BINARY=str(image)))
    archive = output / f'Steve-{version}-linux-x86_64.tar.gz'
    with tarfile.open(archive, 'w:gz', compresslevel=3, dereference=False) as tar:
        tar.add(appdir, arcname='Steve')
    info = output / 'build-info.json'
    info.write_text(json.dumps({'version': version, 'platform': 'linux-x86_64',
        'python': platform.python_version(), 'libc': platform.libc_ver(),
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True)),
        'tools': pins, 'appdir_verified': True, 'appimage_smoke': True, 'appimage_mcp': True,
        'appimage_test_mode': 'extract-and-run'}, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(f'{sha256(p)}  {p.name}\n' for p in (image, archive, info)))
    print(f'Verified Linux packages: {image}\n{archive}', flush=True)


if __name__ == '__main__':
    main()

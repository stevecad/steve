"""Build and verify the frozen desktop using the current Python environment."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--headless', action='store_true', help='Verify in an isolated Linux desktop session.')
    args = parser.parse_args()
    npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
    if not npm:
        parser.error('Install Node.js and run npm ci in cad-web first.')
    subprocess.run([npm, 'run', 'build'], cwd=ROOT / 'cad-web', check=True)
    if sys.platform == 'win32':
        # The sketch solver's Node runtime is downloaded and SHA-256 verified, never committed.
        subprocess.run([sys.executable, str(ROOT / 'tools/fetch_node.py')], cwd=ROOT, check=True)
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--clean', '--noconfirm',
                    '--distpath', str(ROOT / 'dist'), '--workpath', str(ROOT / 'build'),
                    str(ROOT / 'packaging/Steve.spec')], cwd=ROOT, check=True)
    command = [sys.executable, str(ROOT / 'checks/check_package.py'), str(ROOT / 'dist/Steve')]
    if args.headless:
        command = [sys.executable, str(ROOT / 'tools/linux_session.py'), '--', *command]
    subprocess.run(command, cwd=ROOT, check=True)


if __name__ == '__main__':
    main()

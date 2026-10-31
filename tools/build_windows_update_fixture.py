"""Build an isolated frozen Windows version from this checkout, without editing it."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version',required=True)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    if sys.platform!='win32':parser.error('Use a Windows build host.')
    from packaging.version import Version
    Version(args.version)
    fixture=args.output.resolve()
    fixture.mkdir(parents=True,exist_ok=False)
    for folder in ('src','packaging','checks','tests','vendor','assets','bundled-skills','pdf-fonts','THIRD-PARTY-LICENSES'):
        shutil.copytree(ROOT/folder,fixture/folder,ignore=shutil.ignore_patterns('__pycache__','*.egg-info'))
    shutil.copytree(ROOT/'cad-web/dist',fixture/'cad-web/dist')
    project=(ROOT/'pyproject.toml').read_text()
    (fixture/'pyproject.toml').write_text(re.sub(r'(?m)^version = "[^"]+"',f'version = "{args.version}"',project,count=1))
    updates=fixture/'src/steve_desktop/local_updates.py'
    updates.write_text(re.sub(r"(?m)^VERSION='[^']+'$",f"VERSION='{args.version}'",updates.read_text(),count=1),encoding='utf-8')
    env=dict(os.environ,PYTHONPATH=str(fixture/'src'),PYINSTALLER_CONFIG_DIR=str(fixture/'pyinstaller-cache'))
    subprocess.run([sys.executable,'-X','utf8','-m','PyInstaller','--clean','--noconfirm',
        '--distpath',str(fixture/'dist'),'--workpath',str(fixture/'build'),str(fixture/'packaging/Steve.spec')],cwd=fixture,env=env,check=True)
    subprocess.run([sys.executable,'-X','utf8',str(fixture/'checks/check_package.py'),str(fixture/'dist/Steve')],cwd=fixture,env=env,check=True)

if __name__=='__main__':main()

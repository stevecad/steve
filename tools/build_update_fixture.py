"""Build a private older-version fixture without changing the working checkout."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version',required=True)
    parser.add_argument('--appimage',action='store_true')
    args=parser.parse_args()
    from packaging.version import Version
    current=tomllib.loads((ROOT/'pyproject.toml').read_text())['project']['version']
    if Version(args.version)>=Version(current):parser.error('The fixture must be older than the current version.')
    fixture=ROOT/'build/update-fixture'
    if fixture.exists():shutil.rmtree(fixture)
    fixture.mkdir(parents=True)
    ignore=shutil.ignore_patterns('__pycache__','*.egg-info')
    for folder in ('src','packaging','checks','tests'):
        shutil.copytree(ROOT/folder,fixture/folder,ignore=ignore)
    for folder in ('vendor','assets','bundled-skills','pdf-fonts','THIRD-PARTY-LICENSES'):
        (fixture/folder).symlink_to(ROOT/folder,target_is_directory=True)
    shutil.copytree(ROOT/'cad-web/dist',fixture/'cad-web/dist')
    (fixture/'tools').mkdir()
    for name in ('build_appimage.py','linux_session.py'):
        shutil.copy2(ROOT/'tools'/name,fixture/'tools'/name)
    project=(ROOT/'pyproject.toml').read_text().replace(f'version = "{current}"',f'version = "{args.version}"')
    (fixture/'pyproject.toml').write_text(project)
    updates=fixture/'src/steve_desktop/local_updates.py'
    updates.write_text(re.sub(r"(?m)^VERSION='[^']+'$",f"VERSION='{args.version}'",updates.read_text(),count=1))
    env=dict(os.environ,PYTHONPATH=str(fixture/'src'),PYINSTALLER_CONFIG_DIR=str(fixture/'pyinstaller-cache'))
    subprocess.run([sys.executable,'-m','PyInstaller','--clean','--noconfirm',
                    '--distpath',str(fixture/'dist'),'--workpath',str(fixture/'build'),
                    str(fixture/'packaging/Steve.spec')],cwd=fixture,env=env,check=True)
    subprocess.run([sys.executable,str(fixture/'tools/linux_session.py'),'--',sys.executable,
                    str(fixture/'checks/check_package.py'),str(fixture/'dist/Steve')],cwd=fixture,env=env,check=True)
    if args.appimage:
        # Share only the checksum-verified packaging tools, not mutable AppDirs.
        (ROOT/'build/appimage-tools').mkdir(parents=True,exist_ok=True)
        (fixture/'build/appimage-tools').symlink_to(ROOT/'build/appimage-tools',target_is_directory=True)
        subprocess.run([sys.executable,str(fixture/'tools/build_appimage.py'),'--headless'],cwd=fixture,env=env,check=True)
    print(f'Older-version test fixture: {fixture}',flush=True)


if __name__=='__main__':main()

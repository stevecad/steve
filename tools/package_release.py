"""Index verified, unsigned CI packages for local signing; never publish or sign."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tomllib
import zipfile

ROOT=Path(__file__).resolve().parents[1]


def file_info(path):
    with path.open('rb') as stream:sha256=hashlib.file_digest(stream,'sha256').hexdigest()
    with path.open('rb') as stream:sha384=hashlib.file_digest(stream,'sha384').hexdigest()
    return {'name':path.name,'size':path.stat().st_size,'sha256':sha256,'sha384':sha384}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform',choices=('linux-x64','windows-x64'),required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    version=tomllib.loads((ROOT/'pyproject.toml').read_text())['project']['version']
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    evidence=json.loads((ROOT/'build/verification/package-verification.json').read_text())
    if not all(evidence.get(key) for key in ('frozen_code_matches','frontend_and_skills_match','offline_smoke',
            'frozen_stdio_mcp_build_export_stop_cancel','frozen_cad_cancel_crash_recovery')):
        raise ValueError('Complete frozen package verification before indexing a release.')
    binary=ROOT/'dist/Steve'/('Steve.exe' if args.platform=='windows-x64' else 'Steve')
    if file_info(binary)['sha256']!=evidence['sha256']:
        raise ValueError('The frozen executable changed after verification.')
    dirty=subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True)
    if dirty:raise ValueError('Release builds require a clean source checkout.')
    if args.platform=='windows-x64':
        package=binary.parent
        if (package/'uninstall').exists():raise ValueError('Use a portable package without installer records.')
        archive=output/f'Steve-{version}-windows-x64.zip'
        with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as result:
            for path in sorted(package.rglob('*')):
                if path.is_symlink():raise ValueError('Windows portable archives cannot contain symlinks.')
                if path.is_file():result.write(path,'Steve/'+path.relative_to(package).as_posix())
        installer=ROOT/f'dist/installer/Steve-Setup-{version}-windows-x64.exe'
        target=output/installer.name
        if installer.resolve()!=target:shutil.copy2(installer,target)
        paths=[archive,target]
    else:
        paths=[output/f'Steve-{version}-linux-x86_64.AppImage',output/f'Steve-{version}-linux-x86_64.tar.gz']
    files=[file_info(path) for path in paths]
    info={'schema':1,'version':version,'platform':args.platform,
          'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
          'repository':os.environ.get('GITHUB_REPOSITORY','stevecad/steve'),
          'run_id':os.environ.get('GITHUB_RUN_ID'),'run_attempt':os.environ.get('GITHUB_RUN_ATTEMPT'),
          'python':platform.python_version(),'unsigned':True,'verified':True,'artifacts':files}
    (output/'release-build.json').write_text(json.dumps(info,sort_keys=True,indent=2)+'\n',encoding='utf-8')
    (output/'SHA384SUMS').write_text(''.join(f"{item['sha384']}  {item['name']}\n" for item in files))
    if args.platform=='windows-x64':
        (output/'SHA256SUMS').write_text(''.join(f"{item['sha256']}  {item['name']}\n" for item in files))
    print(json.dumps({'platform':args.platform,'version':version,'commit':info['commit'],'artifacts':[p.name for p in paths]}))


if __name__=='__main__':main()

from pathlib import Path
import argparse,hashlib,json,os,subprocess,sys,types
from PyInstaller.archive.readers import CArchiveReader
source=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description='Verify a frozen Steve package against this checkout.')
parser.add_argument('package',type=Path)
parser.add_argument('--evidence',type=Path,default=source/'build/verification')
args=parser.parse_args()
package=args.package.resolve()
executable=package/('Steve.exe' if sys.platform == 'win32' else 'Steve')
app=CArchiveReader(str(executable))
archive=app.open_embedded_archive(next(k for k in app.toc if k.endswith('.pyz')))
def signature(c):return c.co_code,c.co_names,c.co_varnames,tuple(signature(v) if isinstance(v,types.CodeType) else v for v in c.co_consts)
for name in ['app','cad_webview','paths','cad_worker','cad_resources','cad_process','cad_kernel','cad_cache','cad_dependencies','cad_parallel','cad_strategy','cad_costs','cad_cost_profiles','agent_features','cad_server','cad_live','cad_service','cad_assistant','vault','legacy_profile','local_mcp','local_git','local_studio','local_blender','blender_runtime','blender_diagnostics','studio_connection','local_updates','linux_updates','smoke_features','runtime','host_environment']:
    assert signature(archive.extract('steve_desktop.'+name))==signature(compile((source/'src/steve_desktop'/(name+'.py')).read_text(encoding='utf-8-sig'),name,'exec')),name
for folder in ['bundled-skills','cad-web/dist']:
    for file in (source/folder).rglob('*'):
        if file.is_file():assert file.read_bytes()==(package/'_internal'/folder/file.relative_to(source/folder)).read_bytes(),str(file)
assert signature(archive.extract('steve_desktop.windows_updates'))==signature(compile((source/'src/steve_desktop/windows_updates.py').read_text(encoding='utf-8'),'windows_updates.py','exec')),'windows_updates'
assert signature(archive.extract('steve.reporting'))==signature(compile((source/'vendor/steve/reporting.py').read_text(encoding='utf-8-sig'),'reporting.py','exec')),'steve.reporting'
assert signature(archive.extract('steve.reporting_cache'))==signature(compile((source/'vendor/steve/reporting_cache.py').read_text(encoding='utf-8-sig'),'reporting_cache.py','exec')),'steve.reporting_cache'
for file in (source/'vendor').rglob('*.py'):
    assert file.read_bytes()==(package/'_internal/vendor'/file.relative_to(source/'vendor')).read_bytes(),str(file)
if sys.platform == 'win32':
    import pefile
    helper=package/'_internal/packaging/SteveUpdate.exe'
    assert pefile.PE(str(helper)).OPTIONAL_HEADER.Subsystem==2, 'Updater must be windowless'
    helper_archive=CArchiveReader(str(helper))
    helper_python=helper_archive.open_embedded_archive(next(k for k in helper_archive.toc if k.endswith('.pyz')))
    for name in ('windows_update_helper','update_manifest'):
        assert signature(helper_python.extract('steve_desktop.'+name))==signature(compile((source/'src/steve_desktop'/(name+'.py')).read_text(encoding='utf-8'),name,'exec')),name
    assert not (package/'_internal/packaging/apply-update.ps1').exists()
assert (source/'assets/update-channel.json').read_bytes()==(package/'_internal/assets/update-channel.json').read_bytes()
out=args.evidence;out.mkdir(parents=True,exist_ok=True)
with (out/'packaged-smoke.log').open('w',encoding='utf-8') as log:
    for attempt in range(2):
        log.write(f'Smoke attempt {attempt+1}\n');log.flush()
        try:check=subprocess.run([str(executable),'--smoke-test'],stdout=log,stderr=log,timeout=120)
        except subprocess.TimeoutExpired:
            if attempt==0:continue
            raise
        if check.returncode==0:break
assert check.returncode==0,f'Packaged smoke failed; see {out / "packaged-smoke.log"}'
env=dict(os.environ,STEVE_TEST_BINARY=str(executable))
if sys.platform=='linux':
    with (out/'frozen-process-lifetime.log').open('w',encoding='utf-8') as log:
        check=subprocess.run([sys.executable,'-m','unittest','tests.test_cad_process'],cwd=source,env=env,stdout=log,stderr=log,timeout=90)
    assert check.returncode==0,f'Frozen process lifetime check failed; see {out / "frozen-process-lifetime.log"}'
with (out/'frozen-stdio-mcp.log').open('w',encoding='utf-8') as log:
    check=subprocess.run([sys.executable,'-X','utf8','-m','unittest','tests.test_local_mcp'],
                         cwd=source,env=env,stdout=log,stderr=log,timeout=180)
assert check.returncode==0,('Frozen stdio MCP check failed:\n' + (out/'frozen-stdio-mcp.log').read_text(encoding='utf-8',errors='replace')[-12000:])
with (out/'frozen-cad.log').open('w',encoding='utf-8') as log:
    check=subprocess.run([sys.executable,str(source/'checks/check_frozen_cad.py'),str(executable)],
                         cwd=source,env=env,stdout=log,stderr=log,timeout=180)
assert check.returncode==0,f'Frozen CAD check failed; see {out / "frozen-cad.log"}'
result={'executable':str(executable),'sha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
        'frozen_code_matches':True,'frontend_and_skills_match':True,'offline_smoke':True,'frozen_stdio_mcp_build_export_stop_cancel':True,
        'frozen_cad_cancel_crash_recovery':True}
(out/'package-verification.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))


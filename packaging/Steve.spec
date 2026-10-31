import os
import sys
import importlib.metadata
import shutil
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, copy_metadata, collect_submodules
ROOT = str(Path(SPECPATH).parent)
vendor = os.path.join(ROOT, 'vendor')
sys.path.insert(0, vendor)
sys.path.insert(0, os.path.join(ROOT, "src"))

datas = collect_data_files('pydantic_ai') + collect_data_files('genai_prices')
datas += copy_metadata('pydantic-ai-slim', recursive=True)
datas += copy_metadata('openai', recursive=True)
datas += copy_metadata('fastmcp-slim', recursive=True)
datas += collect_data_files('fastmcp')
datas += collect_data_files('mcp')
datas += collect_data_files('pydantic_ai_harness')
datas += copy_metadata('pydantic-ai-harness', recursive=True)
datas += [(os.path.join(ROOT, 'assets', 'steve-logo.svg'), 'assets')]
datas += [(os.path.join(ROOT, 'assets', 'update-channel.json'), 'assets')]
if sys.platform == 'win32':
    exec(compile(Path(ROOT, 'packaging/SteveUpdate.spec').read_text(), 'SteveUpdate.spec', 'exec'))
    datas += [(update_exe.name, 'packaging')]
datas += [(os.path.join(ROOT, 'bundled-skills'), 'bundled-skills')]
datas += [(os.path.join(ROOT, 'pdf-fonts'), 'pdf-fonts')]
datas += [(os.path.join(ROOT, 'THIRD-PARTY-LICENSES'), 'THIRD-PARTY-LICENSES')]
if sys.platform == 'linux':
    # Include notices from the actual Linux environment, including its keyring
    # backend and dependencies absent from the original Windows notice snapshot.
    for distribution in importlib.metadata.distributions():
        for file in distribution.files or []:
            if '.dist-info/licenses/' in str(file):
                datas.append((str(distribution.locate_file(file)),
                              'THIRD-PARTY-LICENSES/python/' + str(file.parent)))
datas += [(vendor, 'vendor'), (os.path.join(ROOT, 'cad-web', 'dist'), 'cad-web/dist')]
datas += copy_metadata('cadquery') + copy_metadata('cadquery-ocp')
hidden = collect_submodules('cadquery') + collect_submodules('OCP')
hidden += collect_submodules('steve') + ['upstream_runtime', 'upstream_parse', 'steve_sketch']
binaries = []
if sys.platform == 'win32':
    # vendor/solver/node.exe is fetched by tools/fetch_node.py (pinned SHA-256), not committed.
    import importlib.util
    _spec = importlib.util.spec_from_file_location('fetch_node', os.path.join(ROOT, 'tools', 'fetch_node.py'))
    fetch_node = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(fetch_node)
    if not fetch_node.verified():
        raise RuntimeError('vendor/solver/node.exe is missing or unverified; run python tools/fetch_node.py first.')
if sys.platform == 'linux':
    # Constrained sketches run the bundled WASM solver, including on hosts with
    # no Node installation. Collect the executable's native dependencies too.
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Install Node.js before building the Linux package.')
    binaries.append((node, 'vendor/solver'))
    node_license = Path(node).resolve().parents[1] / 'LICENSE'
    if node_license.is_file():
        datas.append((str(node_license), 'THIRD-PARTY-LICENSES/node'))
    # keyring discovers backends through entry points, outside static analysis.
    datas += copy_metadata('keyring')
    hidden += ['keyring.backends.SecretService', 'secretstorage', 'jeepney']

a = Analysis([os.path.join(ROOT, 'packaging', 'launcher.py')], pathex=[os.path.join(ROOT, 'src'), vendor], binaries=binaries, datas=datas,
             hiddenimports=hidden + collect_submodules('steve_desktop'), hookspath=[], hooksconfig={}, runtime_hooks=[],
             excludes=[], noarchive=False, optimize=0)
# Qt 6.12 imports Windows' unversioned ICU API. A third-party ICU on PATH
# can be incorrectly bundled by dependency discovery and lacks those exports.
# On this Windows 11 target, let Qt resolve the OS-provided ICU library.
if sys.platform == 'win32':
    a.binaries = [entry for entry in a.binaries
                  if os.path.basename(entry[0]).lower() not in {'icuuc.dll', 'icudt78.dll'}]
pyz = PYZ(a.pure)
# Frozen Python ignores PYTHONUTF8. Studio source/drawings use UTF-8 text on
# every platform, including Windows hosts whose default locale is CP1252.
exe = EXE(pyz, a.scripts, [('X utf8=1', None, 'OPTION')], exclude_binaries=True, name='Steve',
          icon=os.path.join(ROOT, 'assets', 'steve.ico') if sys.platform == 'win32' else None,
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=os.environ.get('STEVE_DEBUG') == '1')
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='Steve')

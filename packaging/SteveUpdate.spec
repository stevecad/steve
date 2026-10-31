import os
from pathlib import Path
ROOT = str(Path(SPECPATH).parent)

# A self-contained, windowless Python helper can outlive/replace Steve without
# locking its DLLs or depending on PowerShell or a system Python installation.
update_analysis = Analysis([os.path.join(ROOT, 'packaging', 'update_launcher.py')],
    pathex=[os.path.join(ROOT, 'src')],
    datas=[(os.path.join(ROOT, 'assets', name), 'assets') for name in ('steve.ico', 'update-channel.json')],
    hiddenimports=[], excludes=[], noarchive=False, optimize=0)
update_analysis.binaries = [entry for entry in update_analysis.binaries
    if os.path.basename(entry[0]).lower() not in {'icuuc.dll', 'icudt78.dll'}]
update_pyz = PYZ(update_analysis.pure)
update_exe = EXE(update_pyz, update_analysis.scripts, update_analysis.binaries, update_analysis.datas,
    [('X utf8=1', None, 'OPTION')], name='SteveUpdate',
    icon=os.path.join(ROOT, 'assets', 'steve.ico'), console=False, upx=False)

"""Isolated packaged-runtime acceptance; never uses the user's CAD profile."""
import json
import tempfile
import time
from pathlib import Path


def verify(output):
    from steve_desktop.cad_server import LocalCadServer
    from steve_desktop.cad_worker import WORKER
    output=Path(output).resolve()
    output.mkdir(parents=True,exist_ok=True)
    WORKER.spares=0
    with tempfile.TemporaryDirectory(prefix='steve-packaged-blender-') as folder:
        server=LocalCadServer(Path(folder)/'CAD')
        try:
            assert server.local_blender.runtime, 'Set STEVE_BLENDER to a compatible Blender executable.'
            for mode in ('save','full'):
                entry=server.submit({'kind':'blender','name':'Packaged verification','code':'import bpy\nbpy.ops.mesh.primitive_cube_add(size=20)\n','files':{},'links':{},'mode':mode})
                deadline=time.monotonic()+120
                while entry['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.1)
                if entry['status'] in ('queued','running'):server.cancellations[entry['id']].set()
                assert entry['status']=='succeeded',entry.get('error') or 'Packaged Blender test timed out.'
                _,result,path=server.build_folder(entry['id'])
                assert Path(result.export('BLEND')['path']).read_bytes()[:7]==b'BLENDER'
                assert (path/'preview.glb').read_bytes()[:4]==b'glTF'
                if mode=='full':assert (path/'view-isometric.png').read_bytes()[:8]==b'\x89PNG\r\n\x1a\n'
                else:assert not (path/'view-isometric.png').exists()
            (output/'blender-package.json').write_text(json.dumps({'passed':True,'checked_modes':['save','full'],'runtime':server.local_blender.runtime,'metadata':entry['metadata']},indent=2),encoding='utf-8')
        finally:
            server.close();WORKER.close()

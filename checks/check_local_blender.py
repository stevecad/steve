"""Actual Blender acceptance on Windows/Linux. Set STEVE_BLENDER or use --install.

Uses an isolated temporary profile. Does not launch the human's Blender editor.
"""
import argparse
import asyncio
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

import httpx
from steve_desktop.blender_runtime import install
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_worker import WORKER

SCENE = '''import bpy
from mathutils import Vector
bpy.ops.mesh.primitive_cube_add(size=20)
cube=bpy.context.object
cube.name='Product'
cube.location.x=0
cube.keyframe_insert(data_path='location',frame=1)
cube.location.x=5
cube.keyframe_insert(data_path='location',frame=2)
bpy.ops.object.camera_add(location=(45,-55,40))
camera=bpy.context.object
camera.rotation_euler=((Vector((0,0,0))-camera.location).to_track_quat('-Z','Y').to_euler())
camera.data.clip_end=10000
scene=bpy.context.scene
scene.camera=camera
scene.frame_start=1
scene.frame_end=2
scene.render.resolution_x=64
scene.render.resolution_y=64
scene.render.resolution_percentage=100
scene.cycles.samples=1
scene.cycles.use_denoising=False
bpy.ops.object.light_add(type='AREA',location=(10,-20,50))
bpy.context.object.data.energy=30000
bpy.context.object.data.shape='DISK'
bpy.context.object.data.size=30
'''


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--install',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    if args.install:
        runtime=install(args.install,threading.Event(),lambda message:print(message,flush=True))
        os.environ['STEVE_BLENDER']=runtime['path']
    WORKER.spares=1
    reports=[]
    with tempfile.TemporaryDirectory(prefix='steve-blender-acceptance-') as directory:
        with patch('steve_desktop.cad_server.os.cpu_count',return_value=1):
            server=LocalCadServer(Path(directory)/'CAD')
        assert server.executor._max_workers==1
        try:
            assert server.local_blender.runtime, 'Configure STEVE_BLENDER or pass --install.'
            def build(document,mode='preview'):
                started=time.monotonic()
                entry=server.submit({**document,'mode':mode})
                while entry['status'] in ('queued','running'):
                    if time.monotonic()-started>240:
                        server.cancellations[entry['id']].set()
                        raise AssertionError('Acceptance-test deadline exceeded')
                    time.sleep(.1)
                assert entry['status']=='succeeded',entry.get('error')
                reports.append({'mode':mode,'name':entry['name'],'seconds':round(time.monotonic()-started,2),'cached':entry.get('cached',False)})
                print(reports[-1],flush=True)
                return entry

            doc={'kind':'blender','name':'Product scene','code':SCENE,'files':{},'links':{}}
            preview=build(doc)
            assert preview['metadata']['objects']>=1
            _,result,folder=server.build_folder(preview['id'])
            assert result.inspect('Product')['object']
            assert Path(result.export('GLB')['path']).read_bytes()[:4]==b'glTF'
            assert build(doc)['cached'] is True
            changed=build({**doc,'code':SCENE.replace('size=20','size=30')})
            assert changed['_blender_cache']!=preview['_blender_cache']
            native=build(doc,'save')
            assert 'blend' in native['artifacts'] and 'animation' not in native['artifacts']
            assert not any(name.startswith('view_') for name in native['artifacts'])
            full=build(doc,'full')
            _,result,folder=server.build_folder(full['id'])
            assert Path(result.export('BLEND')['path']).read_bytes()[:7]==b'BLENDER'
            assert Path(result.export('MP4')['path']).stat().st_size>0
            assert (folder/'view-isometric.png').read_bytes()[:8]==b'\x89PNG\r\n\x1a\n'
            camera=build({**doc,'look':{'view':'camera','shading':'rendered'}},'render')
            assert 'view_camera' in camera['artifacts']
            with httpx.Client(base_url=server.url,headers={'X-Steve-Session':server.token}) as client:
                for name in ('blend','animation','view_isometric'):
                    response=client.get(full['artifacts'][name])
                    assert response.status_code==200 and response.content
                with patch('steve_desktop.local_blender.subprocess.Popen') as launch:
                    response=client.post('/v1/local/blender/open',json={'build_id':full['id']})
                    assert response.status_code==200,response.text
                    assert '--disable-autoexec' in launch.call_args.args[0]
                    assert Path(launch.call_args.args[0][-1]).is_file()
            cad=server.create_document({'kind':'part','name':'Linked CAD','code':'from steve import Model\nmodel=Model()\nmodel.box("plate",20,30,4)\nresult=model.result()\n','files':{},'links':{}})
            linked=build({'kind':'blender','name':'CAD product scene','code':'from links import plate\nplate(name="Product")\n','files':{},'links':{'plate':{'document_id':cad['id'],'revision':cad['revision']}}})
            assert linked['metadata']['objects']>0
            assert all(abs(a-b)<.01 for a,b in zip(linked['metadata']['bounds_mm'],[20,30,4])),linked['metadata']['bounds_mm']
            from steve_desktop.cad_service import cad_tools
            server.context.update(document=doc,build_id=preview['id'])
            tools=cad_tools(server.folder,None,lambda text:None).tools
            current=tools['cad_read'].function()
            exported=asyncio.run(tools['cad_export'].function(expected_revision=current['revision'],format='BLEND'))
            assert Path(exported['path']).is_file(),exported
            rendered=asyncio.run(tools['blender_render'].function(view='camera'))
            assert any(path.endswith('view-camera.png') for path in rendered['files']),rendered
            assert build({**doc,'code':SCENE})['cached']
            failed=server.submit({**doc,'code':'raise ValueError("deliberate scene error")'})
            while failed['status'] in ('queued','running'):time.sleep(.1)
            assert failed['status']=='failed' and 'deliberate scene error' in failed['error']
            assert server.build_folder(preview['id'])[2].is_dir()
            stopped=server.submit({**doc,'code':'import time\nwhile True: time.sleep(0.1)\n'})
            while stopped['status']=='queued':time.sleep(.05)
            time.sleep(1)
            started=time.monotonic();server.cancellations[stopped['id']].set()
            while stopped['status'] in ('queued','running') and time.monotonic()-started<15:time.sleep(.1)
            assert stopped['status']=='failed' and 'cancelled' in stopped['error']
            assert build(doc)['cached']
            reports.append({'cancel_seconds':round(time.monotonic()-started,2)})
            (args.output/'results.json').write_text(json.dumps(reports,indent=2),encoding='utf-8')
            import shutil
            for name in ('result.blend','view-isometric.png','animation.mp4'):
                shutil.copyfile(folder/name,args.output/name)
            print('PASS: real preview, editing, inspection, cache, full renders, animation, camera, CAD link, exports, native launch arguments, failure recovery and cancellation.',flush=True)
        finally:
            server.close()
            WORKER.close()


if __name__=='__main__':
    main()

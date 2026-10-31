"""Verify Blender exports through the actual Qt desktop request interceptor/downloads."""
import argparse
import json
import os
import tempfile
import time
from pathlib import Path

os.environ.setdefault('QSG_RHI_BACKEND','opengl')
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import QUrl
from steve_desktop.cad_webview import LocalCadWeb
from steve_desktop.cad_worker import WORKER
from check_local_blender import SCENE


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=True)
    app=QApplication([])
    WORKER.spares=0
    with tempfile.TemporaryDirectory(prefix='steve-blender-desktop-') as directory:
        web=LocalCadWeb(Path(directory)/'CAD')
        completed=[];downloads=[]
        web.profile.downloadRequested.disconnect(web.download)
        def download(item):
            downloads.append(item)
            item.setDownloadDirectory(str(args.output.resolve()))
            item.setDownloadFileName('native-'+('scene.blend' if item.url().path().endswith('/blend') else 'render.png'))
            item.stateChanged.connect(lambda state:completed.append((state.name,item.interruptReasonString())))
            item.accept()
        web.profile.downloadRequested.connect(download)
        def wait(predicate,seconds=60):
            deadline=time.monotonic()+seconds
            while not predicate() and time.monotonic()<deadline:
                app.processEvents();time.sleep(.01)
            assert predicate(),completed
        try:
            ready=[];web.view.loadFinished.connect(lambda ok:ready.append(ok))
            wait(lambda:bool(ready))
            entry=web.server.submit({'kind':'blender','name':'Qt export','code':SCENE,'files':{},'links':{},'mode':'full'})
            wait(lambda:entry['status'] not in ('queued','running'))
            assert entry['status']=='succeeded',entry.get('error')
            for name in ('view_isometric','blend'):
                url=entry['artifacts'][name]
                web.page.runJavaScript("(()=>{const a=document.createElement('a');a.href="+json.dumps(url)+";a.download='export';a.click();})()")
                wait(lambda:any(state in ('DownloadCompleted','DownloadInterrupted','DownloadCancelled') for state,reason in completed))
                print(name,completed,flush=True)
                assert completed[-1][0]=='DownloadCompleted',completed
                completed.clear()
            assert (args.output/'native-scene.blend').read_bytes()[:7]==b'BLENDER'
            assert (args.output/'native-render.png').read_bytes()[:8]==b'\x89PNG\r\n\x1a\n'
            print('PASS: actual Qt PNG and .blend downloads.',flush=True)
        finally:
            web.shutdown();web.deleteLater();app.processEvents();WORKER.close()


if __name__=='__main__':main()

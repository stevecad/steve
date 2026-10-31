"""Real installer + signed HTTPS updates in a separate Windows app/profile.

The installer must be compiled with a UNIQUE InstallerAppId/InstallerAppName.
Never point --root at a real installation. No installed binary is patched.
"""
import argparse
import base64
import ctypes
import hashlib
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import threading
import time
import zipfile
import httpx
import psutil
from websockets.sync.client import connect
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
from checks.check_linux_updates import tls_files
from steve_desktop.vault import Vault
from steve_desktop.windows_updates import inventory
from datetime import datetime, timedelta, timezone
from steve_desktop.update_manifest import format_expires, signed_payload

def wait_for(work, timeout=180):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        try:
            value=work()
            if value:return value
        except (OSError,httpx.HTTPError,ValueError,KeyError,StopIteration):pass
        time.sleep(.25)
    raise TimeoutError('Verification condition did not complete.')

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));return sock.getsockname()[1]

def evaluate(port, expression):
    pages=httpx.get(f'http://127.0.0.1:{port}/json',trust_env=False).json()
    page=next(p for p in pages if p.get('type')=='page' and p.get('url','').startswith('http://127.0.0.1'))
    with connect(page['webSocketDebuggerUrl']) as ws:
        ws.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':"location.origin === 'null' ? {__page_not_ready: true} : ("+expression+")",'awaitPromise':True,'returnByValue':True}}))
        while True:
            data=json.loads(ws.recv(timeout=20))
            if data.get('id')==1:
                if data.get('result',{}).get('exceptionDetails'):raise RuntimeError(str(data['result']['exceptionDetails']))
                value=data['result']['result'].get('value')
                if isinstance(value,dict) and value.get('__page_not_ready'):raise ValueError('Page is navigating')
                return value

def close_window(pid):
    user=ctypes.windll.user32
    callback=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
    def close(hwnd,_):
        owner=ctypes.c_ulong();user.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        if owner.value==pid and user.IsWindowVisible(hwnd):user.PostMessageW(hwnd,0x10,0,0)
        return True
    user.EnumWindows(callback(close),0)

def observe_progress(case, stop, seen):
    user=ctypes.windll.user32
    callback=ctypes.WINFUNCTYPE(ctypes.c_bool,ctypes.c_void_p,ctypes.c_void_p)
    def inspect(hwnd,_):
        if not user.IsWindowVisible(hwnd):return True
        title=ctypes.create_unicode_buffer(512);user.GetWindowTextW(hwnd,title,512)
        if title.value not in ('Updating Steve','Steve update'):return True
        owner=ctypes.c_ulong();user.GetWindowThreadProcessId(hwnd,ctypes.byref(owner))
        try:command=' '.join(psutil.Process(owner.value).cmdline())
        except psutil.Error:return True
        if str(case).lower() in command.lower():
            seen.add(title.value)
            if title.value=='Updating Steve':
                seen.add('helper:'+Path(psutil.Process(owner.value).exe()).name.lower())
        return True
    while not stop.wait(.1):
        user.EnumWindows(callback(inspect),0)
        for process in psutil.process_iter(['name','cmdline']):
            try:
                if (process.info['name'] or '').lower() in ('powershell.exe','pwsh.exe','cmd.exe') and str(case).lower() in ' '.join(process.info['cmdline'] or []).lower():
                    seen.add('shell:'+process.info['name'].lower())
            except psutil.Error:pass


def screenshot(port, path):
    pages=httpx.get(f'http://127.0.0.1:{port}/json',trust_env=False).json()
    page=next(p for p in pages if p.get('type')=='page' and p.get('url','').startswith('http://127.0.0.1'))
    with connect(page['webSocketDebuggerUrl'],max_size=8*1024*1024) as ws:
        ws.send(json.dumps({'id':1,'method':'Page.captureScreenshot','params':{'format':'png'}}))
        while True:
            data=json.loads(ws.recv(timeout=20))
            if data.get('id')==1:
                path.write_bytes(base64.b64decode(data['result']['data']));return

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer',type=Path,required=True)
    parser.add_argument('--candidate',type=Path,required=True)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--version',default='0.3.7')
    parser.add_argument('--installed-version',default='0.3.6')
    args=parser.parse_args();root=args.root.resolve();root.mkdir(parents=True,exist_ok=False)
    real=Path(os.environ['LOCALAPPDATA'])/'Programs/Steve'
    real_before=inventory(real)
    key=ec.generate_private_key(ec.SECP384R1());public=base64.b64encode(key.public_key().public_bytes(Encoding.DER,PublicFormat.SubjectPublicKeyInfo)).decode()
    archive=root/'update.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=1) as output:
        for path in sorted(args.candidate.resolve().rglob('*')):
            if path.is_file():output.write(path,'Steve/'+path.relative_to(args.candidate.resolve()).as_posix())
    with archive.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
    ca,cert,tls_key=tls_files(root)
    manifest={};requests=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            requests.append(self.path)
            if self.path=='/feed':
                data=json.dumps(manifest).encode();self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            elif self.path=='/update.zip':
                self.send_response(200);self.send_header('Content-Length',str(archive.stat().st_size));self.end_headers()
                import shutil
                with archive.open('rb') as stream:shutil.copyfileobj(stream,self.wfile)
            else:self.send_error(404)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,tls_key)
    server.socket=context.wrap_socket(server.socket,server_side=True)
    fields={'version':args.version,'platform':'windows-x64','url':f'https://127.0.0.1:{server.server_port}/update.zip','sha256':digest,'expires':format_expires(datetime.now(timezone.utc)+timedelta(days=1))}
    manifest.update(fields,signature=base64.b64encode(key.sign(signed_payload(fields),ec.ECDSA(hashes.SHA384()))).decode())
    threading.Thread(target=server.serve_forever,daemon=True).start()
    report={}
    try:
        for mode in ('normal_exit','interrupted_shutdown'):
            case=root/mode;case.mkdir();installed=case/'Programs/Steve';profile=case/'profile/Steve/CAD';profile.mkdir(parents=True)
            subprocess.run([str(args.installer.resolve()),'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',f'/DIR={installed}',f'/LOG={case / "install.log"}'],check=True,timeout=180)
            assert installed.is_dir() and (installed/'uninstall').is_dir()
            records=inventory(installed/'uninstall')
            Vault(profile/'updates.dpapi').save({'override':{'source':f'https://127.0.0.1:{server.server_port}/feed','public_keys':[public]},'automatic':True})
            (profile/'keep.step').write_bytes(b'user CAD work preserved')
            port=free_port();env=dict(os.environ,LOCALAPPDATA=str(case/'profile'),SSL_CERT_FILE=str(ca),QTWEBENGINE_REMOTE_DEBUGGING=f'127.0.0.1:{port}')
            log=(case/'app.log').open('wb')
            app=subprocess.Popen([str(installed/'Steve.exe')],cwd=installed,env=env,stdout=log,stderr=log)
            status=lambda:evaluate(port,"fetch('/v1/local/updates').then(r=>r.json())")
            before=wait_for(status);assert before['version']==args.installed_version,before
            def ready():
                value=status()
                if value.get('update_error'):raise RuntimeError(value['message'])
                return value.get('ready')
            wait_for(ready,timeout=240)
            wait_for(lambda:evaluate(port,"!!document.querySelector('[data-update-notice]')"))
            layout=evaluate(port,"({viewport:document.querySelector('main').getBoundingClientRect().height,window:innerHeight,notice:document.querySelector('[data-update-notice]').getBoundingClientRect().height})")
            assert layout['viewport']>layout['window']*.5 and layout['notice']<100,layout
            screenshot(port,case/'update-notice.png')
            seen=set();stop=threading.Event()
            observer=threading.Thread(target=observe_progress,args=(case,stop,seen),daemon=True);observer.start()
            if mode=='normal_exit':
                close_window(app.pid);app.wait(90)
            else:
                # Simulate an interrupted process only inside this disposable test installation.
                app.kill();app.wait(30)
                for proc in psutil.process_iter(['exe']):
                    if proc.info['exe'] and Path(proc.info['exe']).resolve()==(installed/'Steve.exe').resolve():proc.kill()
                app=subprocess.Popen([str(installed/'Steve.exe')],cwd=installed,env=env,stdout=log,stderr=log)
                app.wait(180)  # Startup hands off to the helper and exits before replacement.
            result_path=profile/'updates/last-update.json'
            result=wait_for(lambda:json.loads(result_path.read_text(encoding='utf-8-sig')) if result_path.exists() else None,timeout=240)
            stop.set();observer.join(5)
            assert result['status']=='installed',result
            assert 'Updating Steve' in seen,seen
            assert 'helper:steveupdate.exe' in seen,seen
            assert not any(item.startswith('shell:') for item in seen),seen
            if mode=='interrupted_shutdown':assert 'Steve update' in seen,seen
            if mode=='normal_exit':app=subprocess.Popen([str(installed/'Steve.exe')],cwd=installed,env=env,stdout=log,stderr=log)
            updated=wait_for(lambda:(s if (s:=status())['version']==args.version else None),timeout=180)
            assert inventory(installed/'uninstall')==records
            assert (profile/'keep.step').read_bytes()==b'user CAD work preserved'
            for proc in psutil.process_iter(['exe']):
                if proc.info['exe'] and Path(proc.info['exe']).resolve()==(installed/'Steve.exe').resolve():close_window(proc.pid)
            wait_for(lambda:not any(p.info['exe'] and Path(p.info['exe']).resolve()==(installed/'Steve.exe').resolve() for p in psutil.process_iter(['exe'])),90)
            log.close()
            subprocess.run([str(next((installed/'uninstall').glob('unins*.exe'))),'/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART'],check=True,timeout=90,cwd=case)
            assert not (installed/'Steve.exe').exists()
            assert (profile/'keep.step').exists()
            report[mode]={'installer':True,'automatic_signed_https_download':True,'workspace_notice':True,'viewport_layout':layout,'visible_progress':sorted(seen),'installed_version':updated['version'],'python_updater_without_shell':True,'uninstaller_preserved':True,'user_data_preserved':True,'uninstall':True}
        assert inventory(real)==real_before,'The real installed app changed during the test.'
        report['real_installation_unchanged']=True
        report['downloads']=requests.count('/update.zip')
        assert report['downloads']==2,'Startup recovery should reuse the staged download.'
    finally:
        server.shutdown();server.server_close()
        (root/'result.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()

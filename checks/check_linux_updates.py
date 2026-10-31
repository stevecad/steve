"""Exercise real signed HTTPS updates and rollback between two frozen versions."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tarfile
import tempfile
import threading
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from steve_desktop.linux_updates import digest, executable, state_vault
from steve_desktop.vault import Vault
from steve_desktop.update_manifest import format_expires, signed_payload

ROOT=Path(__file__).resolve().parents[1]


def tls_files(root):
    now=datetime.now(timezone.utc)
    ca_key=ec.generate_private_key(ec.SECP256R1())
    ca_name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Steve disposable update test CA')])
    ca=(x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True,content_commitment=False,key_encipherment=False,
            data_encipherment=False,key_agreement=False,key_cert_sign=True,crl_sign=True,encipher_only=None,decipher_only=None),critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()),critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),critical=False)
        .sign(ca_key,hashes.SHA256()))
    key=ec.generate_private_key(ec.SECP256R1())
    leaf=(x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')]))
        .issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
        .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),critical=False)
        .sign(ca_key,hashes.SHA256()))
    ca_path,cert_path,key_path=(root/name for name in ('ca.pem','server.pem','server-key.pem'))
    ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    cert_path.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    key_path.chmod(0o600)
    return ca_path,cert_path,key_path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-package',type=Path,required=True)
    parser.add_argument('--old-appimage',type=Path)
    parser.add_argument('--new-bundle',type=Path,required=True)
    parser.add_argument('--format',choices=('all','directory','appimage'),default='all')
    args=parser.parse_args()
    archive=args.new_bundle.resolve()
    with tarfile.open(archive,'r|gz') as tar:
        for member in tar:
            if member.name=='Steve/bundle.json':
                metadata=json.load(tar.extractfile(member))
                break
        else:raise ValueError('The new bundle has no version metadata.')
    report={}
    with tempfile.TemporaryDirectory(prefix='steve signed update ') as temporary:
        root=Path(temporary)
        ca,cert,tls_key=tls_files(root)
        signing_key=ec.generate_private_key(ec.SECP384R1())
        public=base64.b64encode(signing_key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)).decode()
        errors=[];requests=[];manifest={}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                requests.append(self.path)
                if self.path=='/feed':
                    if self.headers.get('Authorization'):errors.append('The public feed must not receive credentials')
                    data=json.dumps(manifest).encode()
                    self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
                elif self.path=='/bundle.tar.gz':
                    if self.headers.get('Authorization'):errors.append('The download host must not receive credentials')
                    self.send_response(200);self.send_header('Content-Length',str(archive.stat().st_size));self.end_headers()
                    with archive.open('rb') as stream:shutil.copyfileobj(stream,self.wfile)
                else:self.send_error(404)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert,tls_key)
        server.socket=context.wrap_socket(server.socket,server_side=True)
        port=server.server_address[1]
        fields={'version':metadata['version'],'platform':'linux-x64','url':f'https://127.0.0.1:{port}/bundle.tar.gz','sha256':digest(archive),'expires':format_expires(datetime.now(timezone.utc)+timedelta(days=1))}
        manifest.update(fields,signature=base64.b64encode(signing_key.sign(signed_payload(fields),ec.ECDSA(hashes.SHA384()))).decode())
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            formats={'directory':args.old_package.resolve()/'Steve'}
            if args.old_appimage:formats['appimage']=args.old_appimage.resolve()
            if args.format!='all':formats={args.format:formats[args.format]}
            for kind,launcher in formats.items():
                case=root/kind;profile=case/'data/Steve';profile.mkdir(parents=True)
                env=dict(os.environ,XDG_DATA_HOME=str(case/'data'),SSL_CERT_FILE=str(ca),APPIMAGE_EXTRACT_AND_RUN='1')
                Vault(profile/'updates.dpapi').save({'override':{'source':f'https://127.0.0.1:{port}/feed','public_keys':[public]},'automatic':True})
                (profile/'drawing.step').write_bytes(b'preserve user project')
                original_hash=digest(launcher)
                def run(flag):
                    result=subprocess.run([str(launcher),flag],env=env,capture_output=True,text=True,timeout=300)
                    assert result.returncode==0,(kind,flag,result.stdout,result.stderr)
                    return json.loads(result.stdout.strip().splitlines()[-1])
                old=run('--update-info')['version']
                result=run('--update-check')
                assert result['version']==old and result['ready'] and result['automatic'],result
                deadline=time.monotonic()+180
                while True:
                    state=state_vault(profile).load()
                    if state.get('active',{}).get('manifest',{}).get('version')==metadata['version']:break
                    failure=profile/'updates/last-update.json'
                    if failure.is_file() and json.loads(failure.read_text()).get('status')=='failed':
                        logs='\n'.join(p.read_text(errors='replace')[-12000:] for p in (profile/'updates/bundles').glob('*/startup.log'))
                        raise AssertionError(failure.read_text()+'\n'+logs)
                    if time.monotonic()>deadline:
                        log=profile/'updates/apply.log'
                        raise AssertionError('Automatic activation timed out: '+(log.read_text() if log.is_file() else 'no helper log'))
                    time.sleep(.2)
                updated=run('--update-status')
                assert updated['version']==metadata['version'],updated
                assert digest(launcher)==original_hash,'The stable launcher was overwritten'
                assert (profile/'drawing.step').read_bytes()==b'preserve user project'
                # A damaged installed bundle must roll back through the same original launcher.
                active=state['active']
                (executable(profile,active).parents[3]/'bundle.json').write_text('corrupt update fixture')
                rolled_back=run('--update-status')
                assert rolled_back['version']==old,rolled_back
                assert state_vault(profile).load().get('active') is None
                assert (profile/'drawing.step').read_bytes()==b'preserve user project'
                report[kind]={'from':old,'to':updated['version'],'signed_https_download':True,
                    'automatic_apply_after_exit':True,'original_launcher_preserved':True,
                    'relaunch_selected_updated_bundle':True,'corrupt_bundle_rollback':True,'projects_preserved':True}
            assert not errors,errors
            assert requests.count('/bundle.tar.gz')==len(formats),requests
        finally:
            server.shutdown();server.server_close();thread.join(5)
    output=ROOT/'build/verification/linux-auto-updates.json'
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()

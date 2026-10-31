from pathlib import Path
import argparse,base64,json,subprocess,tempfile
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat
from steve_desktop.vault import Vault
from steve_desktop.windows_updates import remember
from datetime import datetime, timedelta, timezone
from steve_desktop.update_manifest import format_expires, signed_payload
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser()
parser.add_argument('--helper',type=Path,default=root/'dist/Steve/_internal/packaging/SteveUpdate.exe')
args=parser.parse_args()
report={}
with tempfile.TemporaryDirectory() as folder:
    base=Path(folder)
    for succeeds in (False,True):
        case=base/str(succeeds);installed=case/'apps/Steve';candidate=case/'updates/pending/Steve'
        installed.mkdir(parents=True);candidate.mkdir(parents=True)
        (installed/'old.txt').write_text('preserve on failure')
        (installed/'Steve.exe').write_bytes(b'old-runtime')
        (installed/'uninstall').mkdir()
        (installed/'uninstall/unins000.dat').write_bytes(b'installer-owned records')
        source=case/'Test.cs';source.write_text('class Program { static int Main(string[] args) { return '+('0' if succeeds else '1')+'; } }')
        compile=subprocess.run(['C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe','/nologo','/out:'+str(candidate/'Steve.exe'),str(source)],capture_output=True,text=True)
        assert compile.returncode==0,compile.stdout+compile.stderr
        result_file=case/'updates/result.json'
        key=ec.generate_private_key(ec.SECP384R1())  # disposable test key
        public=base64.b64encode(key.public_key().public_bytes(Encoding.DER,PublicFormat.SubjectPublicKeyInfo)).decode()
        Vault(case/'updates.dpapi').save({'override':{'source':'https://example.test/latest.json','public_keys':[public]}})
        fields={'version':'99.0.0','platform':'windows-x64','url':'https://example.test/update.zip','sha256':'a'*64,'expires':format_expires(datetime.now(timezone.utc)+timedelta(days=1))}
        manifest={**fields,'signature':base64.b64encode(key.sign(signed_payload(fields),ec.ECDSA(hashes.SHA384()))).decode()}
        remember(case,candidate,manifest)
        result_file=case/'updates/last-update.json'
        proc=subprocess.run([str(args.helper.resolve()),'--installed',str(installed),'--profile',str(case),
            '--parent','999999','--created','0'],cwd=case,capture_output=True,text=True,timeout=90)

        result=json.loads(result_file.read_text(encoding='utf-8-sig'))
        if succeeds:
            assert proc.returncode==0,(proc.stdout,proc.stderr,result)
            assert (installed/'Steve.exe').exists() and not (installed/'old.txt').exists()
            assert not installed.with_name('Steve.previous').exists()
        else:
            assert proc.returncode!=0 and (installed/'old.txt').read_text()=='preserve on failure'
        assert (installed/'uninstall/unins000.dat').read_bytes()==b'installer-owned records'
        report['success' if succeeds else 'failed_startup_preserves_install']=result
out=root/'build/update-verification';out.mkdir(parents=True,exist_ok=True)
(out/'installation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))

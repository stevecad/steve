import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import hashlib
from types import SimpleNamespace
import httpx
from fastapi import FastAPI
from steve_desktop.local_updates import verify_manifest,extract_package,LocalUpdates,default_channel
from steve_desktop.update_manifest import public_key_list
from steve_desktop.vault import Vault
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_document import bracket
from steve_desktop.local_git import LocalGit
from tests.update_signing import expires_in, keypair, sign


def channel_with(public):
    return {'host':'dl.stevecad.studio','platforms':{'windows-x64':{'source':'https://dl.stevecad.studio/windows/latest.json','public_keys':[public]}}}


class UpdateTests(unittest.TestCase):
    def setUp(self):
        # Exercise the Windows update contract even when the suite runs on Linux.
        support=patch('steve_desktop.local_updates.supports_portable_updates',return_value=True)
        support.start()
        self.addCleanup(support.stop)
        target=patch('steve_desktop.local_updates.update_platform',return_value='windows-x64')
        target.start()
        self.addCleanup(target.stop)

    def test_shipped_channel_is_dl_stevecad_studio_and_needs_no_configuration(self):
        for target,folder in (('windows-x64','windows'),('linux-x64','linux')):
            defaults=default_channel(target)
            self.assertEqual(defaults['source'],f'https://dl.stevecad.studio/{folder}/latest.json')
            self.assertEqual(defaults['host'],'dl.stevecad.studio')
            self.assertTrue(defaults['public_keys'])
            self.assertEqual(public_key_list(defaults['public_keys']),defaults['public_keys'])
            self.assertFalse(defaults['override'])

    def test_older_saved_feed_key_and_token_are_dropped_but_opt_out_is_kept(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            Vault(root/'updates.dpapi').save({'source':'https://api.github.com/repos/stevecad/steve/releases/latest',
                                               'public_key':'jsX1mS+x8KCOCAUMABDJah6Il5jpk5HBX9/HxabVpbU=','token':'old-secret','automatic':False})
            updater=LocalUpdates(SimpleNamespace(folder=root/'cad',app=FastAPI()))
            try:
                self.assertEqual(updater.config,{'automatic':False})
                self.assertEqual(Vault(root/'updates.dpapi').load(),{'automatic':False})
                self.assertEqual(updater.status()['source'],default_channel('windows-x64')['source'])
                self.assertNotIn('old-secret',json.dumps(updater.status()))
            finally:updater.close()

    def test_download_verifies_signature_and_sends_no_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            updater=LocalUpdates(SimpleNamespace(folder=Path(folder)/'cad',app=FastAPI()))
            key,public=keypair()
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as z:z.writestr('Steve/Steve.exe',b'fixture')
            archive=data.getvalue()
            url='https://dl.stevecad.studio/windows/Steve-9999.0.0-windows-x64.zip'
            manifest=sign(key,version='9999.0.0',platform='windows-x64',url=url,sha256=hashlib.sha256(archive).hexdigest())
            calls=[]
            def handle(request):
                calls.append(str(request.url))
                self.assertNotIn('authorization',request.headers)
                if str(request.url)=='https://dl.stevecad.studio/windows/latest.json':return httpx.Response(200,json=manifest)
                self.assertEqual(str(request.url),url)
                return httpx.Response(200,content=archive)
            client=httpx.Client
            try:
                with patch('steve_desktop.local_updates.shipped_channel',return_value=channel_with(public)), \
                     patch('steve_desktop.local_updates.httpx.Client',side_effect=lambda **kw:client(transport=httpx.MockTransport(handle),**kw)):
                    updater.check()
                self.assertTrue(updater.status()['ready'],updater.message)
                self.assertEqual(calls,['https://dl.stevecad.studio/windows/latest.json',url])
                self.assertEqual((updater.pending/'Steve.exe').read_bytes(),b'fixture')
            finally:updater.close()

    def test_older_or_same_version_is_not_downloaded(self):
        with tempfile.TemporaryDirectory() as folder:
            updater=LocalUpdates(SimpleNamespace(folder=Path(folder)/'cad',app=FastAPI()))
            key,public=keypair()
            calls=[]
            manifest=sign(key,version='0.0.1',platform='windows-x64',url='https://dl.stevecad.studio/windows/old.zip',sha256='a'*64)
            def handle(request):
                calls.append(str(request.url));return httpx.Response(200,json=manifest)
            client=httpx.Client
            try:
                with patch('steve_desktop.local_updates.shipped_channel',return_value=channel_with(public)), \
                     patch('steve_desktop.local_updates.httpx.Client',side_effect=lambda **kw:client(transport=httpx.MockTransport(handle),**kw)):
                    updater.check()
                self.assertEqual(calls,['https://dl.stevecad.studio/windows/latest.json'])
                self.assertFalse(updater.status()['ready'])
                self.assertEqual(updater.message,'Steve is up to date.')
            finally:updater.close()

    def test_signed_manifest_tampering_expiry_and_host(self):
        key,public=keypair()
        url='https://dl.stevecad.studio/windows/Steve.zip'
        manifest=sign(key,version='0.3.1',platform='windows-x64',url=url,sha256='a'*64)
        fields={k:manifest[k] for k in ('version','platform','url','sha256','expires')}
        self.assertEqual(verify_manifest(manifest,public),fields)
        _,other=keypair()
        self.assertEqual(verify_manifest(manifest,[other,public]),fields)  # Rotation: any listed key.
        with self.assertRaisesRegex(ValueError,'trusted'):verify_manifest(manifest,[other])
        for change in [{'version':'0.3.2'},{'url':'https://dl.stevecad.studio/windows/Other.zip'},{'sha256':'b'*64},{'expires':expires_in(30)}]:
            with self.subTest(change=change), self.assertRaises(ValueError):verify_manifest({**manifest,**change},public)
        with self.assertRaises(ValueError):verify_manifest({k:v for k,v in manifest.items() if k!='expires'},public)
        expired=sign(key,**{**fields,'expires':expires_in(-1)})
        with self.assertRaisesRegex(ValueError,'expired'):verify_manifest(expired,public)
        self.assertEqual(verify_manifest(expired,public,check_expiry=False)['version'],'0.3.1')
        for bad in ('http://dl.stevecad.studio/x.zip','https://evil.test/x.zip','https://user@dl.stevecad.studio/x.zip',
                    'https://dl.stevecad.studio.evil.test/x.zip','https://dl.stevecad.studio:8443/x.zip'):
            with self.subTest(url=bad), self.assertRaisesRegex(ValueError,'HTTPS'):
                verify_manifest(sign(key,**{**fields,'url':bad}),public)
        self.assertEqual(verify_manifest(sign(key,**{**fields,'url':'https://mirror.test/x.zip'}),public,host='mirror.test')['url'],'https://mirror.test/x.zip')
        for naive in ('2030-01-01T00:00:00','2030-01-01T00:00:00+02:00','soon'):
            with self.subTest(expires=naive), self.assertRaisesRegex(ValueError,'expir'):
                verify_manifest(sign(key,**{**fields,'expires':naive}),public)

    def test_archive_paths_and_expected_executable(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ['../escape','Steve/../../escape','C:/escape','Steve/link/../../../escape']:
                data=io.BytesIO()
                with zipfile.ZipFile(data,'w') as z:z.writestr(name,'bad')
                data.seek(0)
                with self.assertRaises(ValueError):extract_package(data,root)
            data=io.BytesIO()
            with zipfile.ZipFile(data,'w') as z:z.writestr('Steve/Steve.exe',b'test executable')
            data.seek(0);self.assertEqual(extract_package(data,root),root/'Steve')


class UnsupportedUpdateTests(unittest.TestCase):
    def test_unsupported_platform_does_not_download_windows_updates(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch('steve_desktop.local_updates.supports_portable_updates',return_value=False), \
             patch('steve_desktop.local_updates.update_platform',return_value=None), \
             patch('steve_desktop.local_updates.httpx.Client') as client:
            updater=LocalUpdates(SimpleNamespace(folder=Path(folder)/'cad',app=FastAPI()))
            try:
                updater.check()
                self.assertFalse(updater.status()['supports_updates'])
                self.assertFalse(updater.status()['automatic'])
                self.assertFalse(updater.status()['ready'])
                self.assertIn('Download',updater.status()['message'])
                client.assert_not_called()
            finally:updater.close()


class GitTests(unittest.TestCase):
    def test_real_git_push_pull_and_studio_source_import(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);remote=root/'remote.git';checkout=root/'checkout';checkout.mkdir()
            subprocess.run(['git','init','--bare',str(remote)],check=True,capture_output=True)
            subprocess.run(['git','init','-b','main',str(checkout)],check=True,capture_output=True)
            subprocess.run(['git','-C',str(checkout),'remote','add','origin',str(remote)],check=True,capture_output=True)
            server=LocalCadServer(root/'profile/cad');service=server.local_git
            item={'id':'test','url':'https://example.test/cad.git','branch':'main','path':str(checkout),'token':''}
            service.config['test']=item
            original=subprocess.run
            def local_transport(command,*args,**kwargs):
                # Only this disposable fixture uses file transport; production refuses it.
                return original([x.replace('protocol.file.allow=never','protocol.file.allow=always') for x in command],*args,**kwargs)
            try:
                doc=server.create_document(bracket())
                with patch('steve_desktop.local_git.subprocess.run',side_effect=local_transport):
                    service.action('test','push',{'message':'Test CAD source'})
                    self.assertTrue((checkout/doc['id']/'main.py').exists())
                    meta=json.loads((checkout/doc['id']/'steve.json').read_text())
                    self.assertEqual(meta['steve'],1)
                    service.action('test','pull',{})
                    service.action('test','import',{})
                self.assertEqual(len(server.state['documents']),2)
                self.assertEqual(server.state['documents'][doc['id']]['code'],doc['code'])
                self.assertNotIn('token',json.dumps(service.status()))
                for path in ['../escape','.git/config']:
                    with self.assertRaises(ValueError):service.safe_file(checkout,path)
            finally:server.close()

    def test_symlink_above_the_checkout_is_not_an_escape(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            real = base / 'real-home'
            (real / 'Steve' / 'repositories').mkdir(parents=True)
            home = base / 'home-link'
            home.symlink_to(real, target_is_directory=True)
            checkout = home / 'Steve' / 'repositories' / 'uuid'
            checkout.mkdir()
            (checkout / 'main.py').write_text('print(1)\n')
            self.assertEqual(LocalGit.safe_file(checkout, 'main.py'), checkout / 'main.py')
            self.assertEqual(LocalGit.safe_file(checkout, 'components/plate.py'), checkout / 'components/plate.py')
            linked = checkout / 'alias'
            linked.symlink_to(checkout / 'main.py')
            for path in ('alias', '../uuid-outside', '.git/config'):
                with self.subTest(path=path):
                    with self.assertRaises(ValueError):
                        LocalGit.safe_file(checkout, path)

import base64
import copy
import hashlib
import io
import json
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from urllib.parse import parse_qs, urlencode
from urllib.request import urlopen

import httpx

from steve_desktop.studio_connection import StudioConnection, StudioError, ORIGIN
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_archive import create_archive, MANIFEST
from steve_desktop.local_studio import LocalStudio

CLIENT = 'app_0123456789abcdef'
DESKTOP = {'client_id':'app_stevedesktop0001','name':'Steve desktop','public':True,
           'redirect_uri':'http://127.0.0.1/callback','redirect_ports':'any',
           'scopes':['designs:read','designs:write','files:write','profile']}
CAPS = {'api':'steve','sync_version':1,'server':{'id':'server-one'},
        'features':['projects','workspaces','project_snapshots'],
        'oauth':{'profile_scope':'profile','desktop_client':DESKTOP,'code_challenge_methods':['S256'], **{key: ORIGIN + path for key,path in
                 [('authorization_endpoint','/oauth/authorize'),('token_endpoint','/oauth/token'),('revocation_endpoint','/oauth/revoke')]}}}
PLACES = {'account':'account-one','current':'personal-one','workspaces':[
    {'id':'personal-one','name':'Personal','allowed':True}, {'id':'team-denied','name':'Denied','allowed':False}]}


class ConnectionTests(unittest.TestCase):
    def test_display_profile_is_optional_encrypted_and_cleared_on_account_change(self):
        with tempfile.TemporaryDirectory() as directory:
            result = {**PLACES, 'account_profile': {'name': ' Alex Morgan ', 'email': 'alex@example.test',
                      'avatar_url': 'https://images.example.test/avatar.png', 'access_token': 'never expose'}}
            c = StudioConnection(Path(directory), transport=httpx.MockTransport(lambda request: httpx.Response(200, json={})))
            c.request = lambda path: httpx.Response(200, json=result)
            c.workspaces()
            self.assertEqual(c.session['account_profile'], {'name': 'Alex Morgan', 'email': 'alex@example.test',
                             'avatar_url': 'https://images.example.test/avatar.png'})
            self.assertNotIn(b'alex@example.test', c.vault.path.read_bytes())
            self.assertEqual(c.vault.load()['account_profile'], c.session['account_profile'])
            for avatar in ('http://example.test/a', 'javascript:alert(1)', 'https://[invalid', 'https://user:pass@example.test/a'):
                result['account_profile']['avatar_url'] = avatar
                c.workspaces()
                self.assertNotIn('avatar_url', c.session['account_profile'])
            result = {**PLACES, 'account': 'other-account'}
            c.workspaces()
            self.assertEqual(c.session['account_profile'], {})
            c.disconnect()
            self.assertEqual(c.vault.load(), {})
            c.close()

    def test_desktop_discovery_rejects_missing_and_unsafe_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            c=StudioConnection(Path(directory))
            for change in (None, {'public':False}, {'redirect_uri':'https://elsewhere.example/callback'},
                           {'redirect_ports':'fixed'}, {'scopes':['designs:write']}, {'client_id':'invalid'}):
                with self.subTest(change=change):
                    c.capabilities=copy.deepcopy(CAPS)
                    if change is None:
                        del c.capabilities['oauth']['desktop_client']
                    else:
                        c.capabilities['oauth']['desktop_client'].update(change)
                    with self.assertRaises(StudioError):c.publisher_client()
            c.close()

    def test_profile_scope_is_optional_and_refresh_preserves_or_clears_it(self):
        with tempfile.TemporaryDirectory() as directory:
            c=StudioConnection(Path(directory));c.capabilities=copy.deepcopy(CAPS)
            client=c.publisher_client()
            self.assertEqual(c.login_scope(client),'designs:read profile')
            self.assertEqual(c.login_scope(CLIENT),'designs:read')
            c.session={'refresh_token':'old','client_id':client,'account_profile':{'name':'Previously shared'}}
            self.assertTrue(c.profile_consent_required())
            tokens={'access_token':'a','refresh_token':'r','expires_in':900}
            c.save_tokens(tokens,client,requested_scope=c.login_scope(client))
            self.assertEqual(c.vault.load()['scope'],'designs:read profile')
            self.assertFalse(c.profile_consent_required())
            c.save_tokens(tokens,client)
            self.assertEqual(c.session['scope'],'designs:read profile')
            c.save_tokens({**tokens,'scope':'designs:read'},client)
            self.assertTrue(c.profile_consent_required())
            self.assertNotIn('account_profile',c.session)
            for scope in (None,'designs:write'):
                c.capabilities['oauth']['profile_scope']=scope
                self.assertEqual(c.login_scope(client),'designs:read')
            c.capabilities=copy.deepcopy(CAPS)
            c.capabilities['oauth']['desktop_client']['scopes']=['designs:read']
            self.assertEqual(c.login_scope(client),'designs:read')
            c.close()

    def test_damaged_session_does_not_prevent_local_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'studio-session.dpapi').write_bytes(b'not a valid encrypted session')
            c=StudioConnection(Path(directory),client_id=CLIENT)
            self.assertEqual(c.session,{})
            self.assertIn('local CAD is unaffected',c.storage_error)
            c.close()

    def test_real_loopback_pkce_storage_refresh_and_disconnect(self):
        with tempfile.TemporaryDirectory() as directory:
            calls, browser, challenge = [], [], []
            def handle(request):
                calls.append(request.url.path)
                if request.url.path.endswith('capabilities'):
                    return httpx.Response(200,json=CAPS)
                if request.url.path == '/oauth/token':
                    fields=parse_qs(request.content.decode())
                    self.assertEqual(fields['client_id'],[DESKTOP['client_id']])
                    self.assertNotIn('client_secret',fields)
                    if fields['grant_type']==['authorization_code']:
                        proof=base64.urlsafe_b64encode(hashlib.sha256(fields['code_verifier'][0].encode()).digest()).rstrip(b'=').decode()
                        self.assertEqual(proof,challenge[0])
                    else:
                        self.assertEqual(fields['refresh_token'],['refresh-secret'])
                    return httpx.Response(200,json={'access_token':'access-secret','refresh_token':'refresh-secret', 'expires_in':900,'scope':'designs:read profile'})
                if request.url.path.endswith('workspaces'):
                    self.assertEqual(request.headers['Authorization'],'Bearer access-secret')
                    return httpx.Response(200,json=PLACES)
                return httpx.Response(200,json={})
            connection=StudioConnection(Path(directory),transport=httpx.MockTransport(handle))
            def open_browser(url):
                from urllib.parse import urlsplit
                fields=parse_qs(urlsplit(url).query);challenge.append(fields['code_challenge'][0]);browser.append(url)
                self.assertEqual(fields['client_id'],[DESKTOP['client_id']])
                self.assertEqual(fields['scope'],['designs:read profile'])
                def callback():
                    with urlopen(fields['redirect_uri'][0]+'?'+urlencode({'state':fields['state'][0],'code':'code-secret'})) as result:
                        self.assertEqual(result.status,200)
                threading.Thread(target=callback).start()
                return True
            self.assertEqual(connection.login(open_browser=open_browser)['account'],'account-one')
            raw=connection.vault.path.read_bytes()
            self.assertNotIn(b'access-secret',raw);self.assertNotIn(b'refresh-secret',raw)
            connection.session['expires_at']=0
            connection.workspaces()
            self.assertEqual(calls.count('/oauth/token'),2)
            self.assertEqual(len(browser),1)
            connection.disconnect();self.assertEqual(connection.vault.load(),{})
            connection.close()

    def test_cross_origin_and_ambiguous_refresh_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            def handle(request):
                raise httpx.ReadError('interrupted', request=request)
            c=StudioConnection(Path(directory),client_id=CLIENT,transport=httpx.MockTransport(handle))
            c.capabilities=CAPS;c.session={'refresh_token':'consume-once','client_id':CLIENT}
            with self.assertRaises(StudioError):c.url('https://evil.example/token')
            with self.assertRaises(httpx.ReadError):c.refresh()
            self.assertNotIn('refresh_token',c.vault.load())
            c.close()


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();root=Path(self.temp.name)
        self.source=LocalCadServer(root/'source');self.target=LocalCadServer(root/'target')
        self.doc=self.source.create_document({'name':'Offline bracket','kind':'part','code':'from steve import Model\nmodel=Model()\nmodel.box("plate",10,20,3)\nresult=model.result()\n','files':{},'links':{}})
        self.snapshot='a'*64;self.make_package();self.download_calls=0;self.request_headers=[]
        self.response_mode='normal'
        self.connection=StudioConnection(root/'connection',client_id=CLIENT,transport=httpx.MockTransport(self.handle))
        self.connection.capabilities=CAPS
        self.connection.session={'server':'server-one','origin':ORIGIN,'account':'account-one','client_id':CLIENT,
                                 'access_token':'access','refresh_token':'refresh','expires_at':time.time()+1000}
        self.sync=LocalStudio(self.target,self.connection)

    def tearDown(self):
        self.sync.close();self.connection.close();self.target.close();self.source.close();self.temp.cleanup()

    def test_status_exposes_display_identity_without_credentials(self):
        self.connection.session['account_profile'] = {'name': 'Alex Morgan', 'email': 'alex@example.test'}
        status = self.sync.status()
        self.assertEqual(status['account'], {'id': 'account-one', 'name': 'Alex Morgan', 'email': 'alex@example.test'})
        self.assertNotIn('access_token', json.dumps(status))
        self.assertNotIn('refresh_token', json.dumps(status))
        self.connection.disconnect()
        self.assertIsNone(self.sync.status()['account'])

    def make_package(self):
        original=create_archive(self.source,self.doc,self.doc['id'],self.doc['revision'])
        with zipfile.ZipFile(io.BytesIO(original)) as z:entries={n:z.read(n) for n in z.namelist()}
        manifest=json.loads(entries[MANIFEST]);manifest['studio']={'complete':True,'unresolved':[],'snapshot':self.snapshot}
        entries[MANIFEST]=json.dumps(manifest).encode();out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:
            for name,content in entries.items():z.writestr(name,content)
        self.raw=out.getvalue();self.digest=hashlib.sha256(self.raw).hexdigest()

    def handle(self,request):
        self.request_headers.append(dict(request.headers))
        if request.url.path.endswith('/snapshot'):
            if request.headers.get('if-none-match')=='"'+self.snapshot+'"':return httpx.Response(304)
            return httpx.Response(200,json={'snapshot':self.snapshot,'root':{'document_id':self.doc['id'],'revision':self.doc['revision']},
                'complete':True,'format':'steve.project','version':2,'unresolved':[],
                'package':{'url':'/api/v1/project-snapshots/'+self.snapshot,'bytes':len(self.raw),'sha256':self.digest}})
        if '/project-snapshots/' in request.url.path:
            self.download_calls+=1
            if self.response_mode=='interrupt':
                raw=self.raw
                class Interrupted(httpx.SyncByteStream):
                    def __iter__(self):
                        yield raw[:131072]
                        raise httpx.ReadError('Simulated transfer interruption')
                return httpx.Response(200,stream=Interrupted())
            raw=self.raw if self.response_mode=='normal' else b'X'+self.raw[1:]
            if request.headers.get('range'):
                offset=int(request.headers['range'][6:-1])
                return httpx.Response(206,content=raw[offset:],headers={'Content-Range':f'bytes {offset}-{len(raw)-1}/{len(raw)}'})
            return httpx.Response(200,content=raw)
        if request.url.path.endswith('workspaces'):return httpx.Response(200,json=PLACES)
        return httpx.Response(200,json={'workspace':'personal-one','projects':[self.project()],'next':None})

    def project(self):
        return {'id':self.doc['id'],'name':self.doc['name'],'state':'live','revision':self.doc['revision']}

    def test_download_unchanged_refresh_local_edits_and_remote_change(self):
        self.sync.download('personal-one',self.project())
        row=next(iter(self.target.state['studio_sync'].values()));local=row['local_id']
        self.assertEqual(self.target.state['documents'][local]['code'],self.doc['code'])
        self.target.state['documents'][local]['code']+='\n# local edit\n'
        self.sync.download('personal-one',self.project());self.assertEqual(self.download_calls,1)
        self.assertEqual(len(self.target.state['documents']),1)
        self.snapshot='b'*64;self.make_package()
        self.sync.download('personal-one',self.project())
        self.assertEqual(len(self.target.state['documents']),2)
        self.assertIn('# local edit',self.target.state['documents'][local]['code'])
        self.sync.mark_missing('personal-one',self.doc['id'],'Gone')
        self.assertEqual(len(self.target.state['documents']),2)

    def test_resume_and_account_isolation(self):
        key=self.sync.key('personal-one',self.doc['id'])
        partial=self.sync.downloads/(key+'-'+self.digest+'.partial');partial.write_bytes(self.raw[:100])
        self.sync.download('personal-one',self.project())
        self.assertTrue(any(x.get('range')=='bytes=100-' for x in self.request_headers))
        self.connection.session['account']='other-account'
        self.assertNotEqual(key,self.sync.key('personal-one',self.doc['id']))
        self.assertEqual(self.sync.status()['copies'],[])

    def test_bad_checksum_never_imports(self):
        self.response_mode='corrupt'
        with self.assertRaisesRegex(StudioError,'checksum'):self.sync.download('personal-one',self.project())
        self.assertEqual(self.target.state['documents'],{})

    def test_denied_team_never_downloads(self):
        self.sync.run('download',{'workspace':'team-denied','projects':[self.doc['id']]})
        self.assertIn('Allow Steve',self.sync.error)
        self.assertEqual(self.download_calls,0)

    def test_download_build_inspect_edit_export_offline(self):
        self.sync.download('personal-one',self.project())
        self.connection.disconnect()
        local=next(iter(self.target.state['documents'].values()))
        def build(doc):
            entry=self.target.submit(doc)
            deadline=time.monotonic()+90
            while entry['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.1)
            self.assertEqual(entry['status'],'succeeded',entry.get('error'))
            return self.target.build_folder(entry['id'])[1]
        built=build(local);geometry=built.inspect()
        self.assertTrue(geometry['valid']);self.assertEqual(geometry['solids'],1)
        self.assertAlmostEqual(geometry['volume'],600,places=5)
        changed={**local,'code':local['code'].replace('10,20,3','10,20,6')}
        built=build(changed)
        self.assertAlmostEqual(built.inspect()['volume'],1200,places=5)
        exported=built.export('STEP',built.current()['id'])
        self.assertTrue(exported)
        self.assertEqual(self.download_calls,1)

    def test_cancelled_download_does_not_import(self):
        self.connection.cancel.set()
        with self.assertRaisesRegex(StudioError,'cancelled'):self.sync.download('personal-one',self.project())
        self.assertEqual(self.target.state['documents'],{})

    def test_local_api_rejects_untrusted_callers(self):
        from fastapi.testclient import TestClient
        with TestClient(self.target.app) as client:
            self.assertEqual(client.get('/v1/local/studio').status_code,403)
            self.assertEqual(client.post('/v1/local/studio/connect',json={}).status_code,403)

    def test_interrupted_stream_resumes_without_partial_import(self):
        self.doc['files']={'notes.txt':'x'*250000};self.make_package()
        self.response_mode='interrupt'
        with self.assertRaises(httpx.ReadError):self.sync.download('personal-one',self.project())
        self.assertEqual(self.target.state['documents'],{})
        self.response_mode='normal'
        self.sync.download('personal-one',self.project())
        self.assertTrue(any(x.get('range')=='bytes=131072-' for x in self.request_headers))
        self.assertEqual(next(iter(self.target.state['documents'].values()))['files']['notes.txt'],'x'*250000)

    def test_restart_keeps_local_project_without_credentials(self):
        self.sync.download('personal-one',self.project())
        identifier=next(iter(self.target.state['documents']))
        folder=self.target.folder
        self.target.close()
        self.target=LocalCadServer(folder)
        self.assertEqual(self.target.state['documents'][identifier]['code'],self.doc['code'])
        self.assertEqual(next(iter(self.target.state['studio_sync'].values()))['local_id'],identifier)
        self.assertFalse(self.target.local_studio.status()['connected'])

    def test_nested_pins_survive_download_without_latest_substitution(self):
        child=copy.deepcopy(self.doc)
        self.source.update_document(child['id'],{**child,'code':child['code'].replace('10,20,3','90,20,3')})
        self.doc=self.source.create_document({'name':'Pinned assembly','kind':'design',
            'code':'from links import bracket\nresult=bracket()\n','files':{},
            'links':{'bracket':{'document_id':child['id'],'revision':1}}})
        self.make_package();self.sync.download('personal-one',self.project())
        row=next(iter(self.target.state['studio_sync'].values()))
        root=self.target.state['documents'][row['local_id']]
        pin=root['links']['bracket']
        self.assertNotEqual(pin['document_id'],child['id'])
        self.assertEqual(self.target.revision(pin['document_id'],pin['revision'])['code'],child['code'])

    def test_stop_syncing_keeps_local_copies(self):
        from fastapi.testclient import TestClient
        self.sync.download('personal-one',self.project())
        # The server's installed service owns the routes; use the same identity.
        self.target.local_studio.connection.session=self.connection.session.copy()
        with TestClient(self.target.app,headers={'X-Steve-Session':self.target.token}) as client:
            result=client.post('/v1/local/studio/unlink',json={'workspace':'personal-one','project':self.doc['id']})
            self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(self.target.state['studio_sync'],{})
        self.assertEqual(len(self.target.state['documents']),1)


if __name__=='__main__':unittest.main()

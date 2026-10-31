import base64
import copy
import hashlib
import io
import json
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch
from pathlib import Path
from PIL import Image
from fastapi.testclient import TestClient
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_archive import create_archive, read_archive, restore_archive, MANIFEST


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.server=LocalCadServer(Path(self.temp.name)/'original')
        self.other=LocalCadServer(Path(self.temp.name)/'restored')
        self.client=TestClient(self.server.app,headers={'X-Steve-Session':self.server.token})
        self.target=TestClient(self.other.app,headers={'X-Steve-Session':self.other.token})
        self.images=[]
        for fmt in ('PNG','JPEG','WEBP'):
            raw=io.BytesIO();Image.new('RGB',(32,24),(13,92,183)).save(raw,fmt)
            item=self.client.post('/v1/decal-images?name='+fmt,content=raw.getvalue(),headers={'Content-Type':Image.MIME[fmt]}).json()
            self.images.append(item)
        self.child=self.server.create_document({'name':'Pinned part','kind':'part','code':'from steve import Model\nmodel=Model()\nmodel.box("box", 10, 20, 30)\n'+''.join(f'model.decal("d{i}", image="{a["id"]}", on="box.top", width=5)\n' for i,a in enumerate(self.images))+'result=model.result()\n','files':{},'links':{}})
        self.root={'name':'Portable assembly','kind':'design','code':'from links import plate\nresult=plate()\n','files':{'params.py':'length = 20\n','images/logo.png':base64.b64encode(self.client.get(self.images[0]['url']).content).decode()},'links':{'plate':{'document_id':self.child['id'],'revision':1,'component':None}}}

    def tearDown(self):
        self.client.close();self.target.close();self.server.close();self.other.close();self.temp.cleanup()

    def rewritten(self,raw,mutate):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:files={n:z.read(n) for n in z.namelist()}
        mutate(files);out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:
            for n,v in files.items():z.writestr(n,v)
        return out.getvalue()

    def test_fresh_workspace_preserves_pinned_source_and_lossy_image_bytes(self):
        original=copy.deepcopy(self.child)
        self.server.update_document(self.child['id'],{**self.child,'code':self.child['code'].replace('10, 20, 30','40, 50, 60')})
        raw=create_archive(self.server,self.root)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            self.assertEqual(z.read('main.py').decode(),self.root['code'])
            self.assertEqual(z.read('linked/001/model.py').decode(),original['code'])
            self.assertEqual(z.read('images/logo.png'),self.client.get(self.images[0]['url']).content)
        response=self.target.post('/v1/local/import-project',content=raw)
        self.assertEqual(response.status_code,201,response.text)
        imported=response.json()['root'];self.assertEqual(response.json()['imported'],2)
        self.assertIsNone(imported.get('studio_origin'))
        ref=imported['links']['plate'];self.assertNotEqual(ref['document_id'],self.child['id'])
        self.assertEqual(ref['revision'],1);self.assertIn('component',ref)
        self.assertEqual(self.other.revision(ref['document_id'])['code'],original['code'])
        for item in self.images:
            self.assertEqual(self.target.get(item['url']).content,self.client.get(item['url']).content)
            self.assertEqual(self.target.get(item['thumbnail_url']).status_code,200)
        # A second import creates a copy, preserving existing documents and IDs.
        again=restore_archive(self.other,raw)
        self.assertNotEqual(again['root']['id'],imported['id'])
        self.assertEqual(len(self.other.state['documents']),4)

    def test_component_link_selector_is_preserved(self):
        self.root['links']['plate']['component']='bracket'
        restored=restore_archive(self.other,create_archive(self.server,self.root))
        self.assertEqual(restored['root']['links']['plate']['component'],'bracket')
        self.assertEqual(self.other.resolve_links(restored['root'])['links']['plate']['component'],'bracket')

    def test_computed_asset_ids_are_resolved_or_rejected_instead_of_silently_omitted(self):
        image_id=self.images[0]['id']
        doc={'name':'Constant image','kind':'part','code':f'IMAGE="img_" + "{image_id[4:]}"\nmodel.decal("label", image=IMAGE, on="box.top", width=5)\n','files':{},'links':{}}
        _,assets=read_archive(create_archive(self.server,doc))
        self.assertEqual([entry['id'] for entry,data in assets],[image_id])
        doc['code']=doc['code'].replace('image=IMAGE','image=choose_image()')
        with self.assertRaisesRegex(ValueError,'runtime-generated'):create_archive(self.server,doc)

    def test_missing_source_asset_prevents_incomplete_export(self):
        (self.server.folder/'decal-images'/(self.images[0]['id']+'.image')).unlink()
        with self.assertRaisesRegex(ValueError,'Missing decal image'):create_archive(self.server,self.root)

    def test_export_never_writes_an_archive_larger_than_import_accepts(self):
        with patch('steve_desktop.cad_archive.MAX_ARCHIVE',1):
            with self.assertRaisesRegex(ValueError,'transfer size'):create_archive(self.server,self.root)

    def test_tampered_missing_and_traversal_archives_do_not_change_catalog(self):
        raw=create_archive(self.server,self.root)
        corruptions=[lambda f:f.update({'main.py':b'result = None'}),lambda f:f.pop(next(n for n in f if n.startswith('assets/decals/'))),lambda f:f.update({'../escape.py':b''}),lambda f:f.update({MANIFEST:b'[]'})]
        for mutation in corruptions:
            response=self.target.post('/v1/local/import-project',content=self.rewritten(raw,mutation))
            self.assertEqual(response.status_code,422,response.text)
            self.assertEqual(self.other.state['documents'],{})
            self.assertEqual(self.other.state.get('decal_images',{}),{})

    def test_step_bytes_are_included_and_identity_retained(self):
        # Transfer verifies bytes/identity; the CAD build verifies the solid in the UI test.
        data=b'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;'
        digest=hashlib.sha256(data).hexdigest()
        folder=self.server.folder/'imports';folder.mkdir(exist_ok=True);(folder/(digest+'.step')).write_bytes(data)
        self.root['files']['components/imported.py']=f'from steve import Model\nm=Model()\nm.import_step("part",source="{digest}")\nresult=m.result()\n'
        raw=create_archive(self.server,self.root)
        documents,assets=read_archive(raw)
        self.assertEqual(next(d for e,d in assets if e['kind']=='step'),data)
        self.assertEqual(documents[0]['files'],self.root['files'])

    def test_restored_component_link_builds_only_the_selected_component(self):
        design=self.server.create_document({'name':'Two components','kind':'design',
            'code':'from steve import Design\nfrom components.one import one\nfrom components.two import two\nd=Design()\nd.add(one)\nd.add(two,at=(50,0,0))\nresult=d.result()\n',
            'files':{'components/one.py':'from steve import Component\none=Component("one")\none.box("box",10,10,10)\n','components/two.py':'from steve import Component\ntwo=Component("two")\ntwo.box("box",20,20,20)\n'},'links':{}})
        root={'name':'One component only','kind':'design','code':'from steve import Design\nfrom links import selected\nd=Design()\nd.add(selected())\nresult=d.result()\n','files':{},'links':{'selected':{'document_id':design['id'],'revision':1,'component':'one'}}}
        imported=restore_archive(self.other,create_archive(self.server,root))['root']
        build=self.other.submit(imported);until=time.monotonic()+120
        while build['status'] in ('queued','running') and time.monotonic()<until:time.sleep(.1)
        self.assertEqual(build['status'],'succeeded',build.get('error'))
        geometry=self.other.build_folder(build['id'])[1].inspect()
        self.assertEqual(geometry['solids'],1)
        self.assertAlmostEqual(geometry['volume'],1000,places=4)

if __name__=='__main__':unittest.main()

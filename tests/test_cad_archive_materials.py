import copy,hashlib,io,json,tempfile,time,unittest,zipfile
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_archive import create_archive,read_archive,restore_archive,MANIFEST


class MaterialArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.original=LocalCadServer(Path(self.temp.name)/'original')
        self.target=LocalCadServer(Path(self.temp.name)/'target')
        self.client=TestClient(self.target.app,headers={'X-Steve-Session':self.target.token})
        self.identifier='my:transfer-alloy'
        self.fields={'name':'Transfer alloy','category':'aluminum','based_on':'aluminum-6061-t6','description':'Custom test alloy','color':'#c8102e','properties':{'density':5}}
        self.original.state['materials']={self.identifier:copy.deepcopy(self.fields)}
        self.doc={'name':'Material transfer','kind':'part','code':'# précision and formatting stay\nfrom steve import Model\nMATERIAL = "my:" + "transfer-alloy"\nm=Model()\nm.box("box",60,40,20)\nm.material(MATERIAL)  # user note\nresult=m.result()\n','files':{},'links':{}}

    def tearDown(self):
        self.client.close();self.original.close();self.target.close();self.temp.cleanup()

    def build_mass(self,server,doc):
        job=server.submit(doc);until=time.monotonic()+120
        while job['status'] in ('queued','running') and time.monotonic()<until:time.sleep(.1)
        self.assertEqual(job['status'],'succeeded',job.get('error'))
        metadata=json.loads((server.build_folder(job['id'])[2]/'studio-metadata.json').read_text(encoding='utf-8'))
        return metadata['modeling']['materials']['mass']

    def test_fresh_restore_preserves_source_mass_color_and_reexport(self):
        raw=create_archive(self.original,self.doc)
        docs,assets=read_archive(raw)
        self.assertEqual(len(assets),1)
        restored=restore_archive(self.target,raw)
        self.assertEqual(restored['root']['code'],self.doc['code'])
        self.assertEqual(restored['remapped_materials'],0)
        self.assertEqual(self.target.state['materials'][self.identifier]['color'],'#c8102e')
        self.assertEqual(self.build_mass(self.target,restored['root']),240)
        again=read_archive(create_archive(self.target,restored['root']))
        self.assertEqual(again[1][0][0]['material'],self.fields)
        restore_archive(self.target,raw)
        self.assertEqual(len(self.target.state['materials']),1)

    def test_conflict_remaps_unicode_source_without_altering_existing_users(self):
        self.doc['code']=self.doc['code'].replace('m.material(MATERIAL)', 'label="précision"; m.material(MATERIAL)')
        self.target.state['materials']={self.identifier:{**self.fields,'properties':{'density':8}}}
        existing=self.target.create_document(self.doc)
        raw=create_archive(self.original,self.doc)
        result=restore_archive(self.target,raw)
        self.assertEqual(result['remapped_materials'],1)
        new_id=next(i for i in self.target.state['materials'] if i!=self.identifier)
        self.assertIn('m.material('+repr(new_id)+')  # user note',result['root']['code'])
        self.assertTrue(result['root']['code'].startswith('# précision and formatting stay\n'))
        self.assertEqual(self.target.revision(existing['id'])['code'],self.doc['code'])
        self.assertEqual(self.build_mass(self.target,existing),384)
        self.assertEqual(self.build_mass(self.target,result['root']),240)
        second=restore_archive(self.target,raw)
        self.assertEqual(result['root']['code'],second['root']['code'])
        self.assertEqual(len(self.target.state['materials']),2)
        _,assets=read_archive(create_archive(self.target,result['root']))
        self.assertEqual([e['id'] for e,_ in assets],[new_id])

    def test_linked_module_literal_ids_remap_together(self):
        child=self.original.create_document({**self.doc,'code':self.doc['code'].replace('MATERIAL = "my:" + "transfer-alloy"','MATERIAL = "my:transfer-alloy"')})
        assembly={'name':'Linked materials','kind':'design','code':'from links import child\nresult=child()\n',
                  'files':{'params.py':'ALLOY = "my:transfer-alloy"\n'},'links':{'child':{'document_id':child['id'],'revision':1}}}
        self.target.state['materials']={self.identifier:{**self.fields,'properties':{'density':8}}}
        result=restore_archive(self.target,create_archive(self.original,assembly))
        ref=result['root']['links']['child'];linked=self.target.revision(ref['document_id'])
        self.assertNotIn('my:transfer-alloy',result['root']['files']['params.py'])
        self.assertNotIn('my:transfer-alloy',linked['code'])
        _,assets=read_archive(create_archive(self.target,result['root']))
        self.assertEqual(len(assets),1)

    def rewrite(self,raw,change):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:files={n:z.read(n) for n in z.namelist()}
        manifest=json.loads(files[MANIFEST]);change(files,manifest)
        files[MANIFEST]=json.dumps(manifest).encode();out=io.BytesIO()
        with zipfile.ZipFile(out,'w') as z:
            for name,data in files.items():z.writestr(name,data)
        return out.getvalue()

    def test_bad_or_missing_definition_is_rejected_before_catalog_changes(self):
        raw=create_archive(self.original,self.doc)
        def invalid(files,manifest):
            entry=manifest['assets'][0]
            fields=json.loads(files[entry['path']]);fields['properties']['density']=-2
            data=json.dumps(fields).encode();files[entry['path']]=data;entry['sha256']=hashlib.sha256(data).hexdigest()
        def legacy(files,manifest):manifest.update(version=1,assets=[])
        for mutation in (invalid,legacy):
            before=copy.deepcopy(self.target.state)
            response=self.client.post('/v1/local/import-project',content=self.rewrite(raw,mutation))
            self.assertEqual(response.status_code,422,response.text)
            self.assertEqual(self.target.state,before)

    def test_missing_or_dynamic_material_blocks_incomplete_exports(self):
        self.original.state['materials']={}
        with self.assertRaisesRegex(ValueError,'Missing custom material'):create_archive(self.original,self.doc)
        dynamic={**self.doc,'code':self.doc['code'].replace('m.material(MATERIAL)','m.material(choose_material())')}
        with self.assertRaisesRegex(ValueError,'runtime-generated material'):create_archive(self.original,dynamic)

    def test_complete_legacy_archive_remains_readable(self):
        doc={**self.doc,'code':'from steve import Model\nm=Model()\nm.box("box",10,10,10)\nresult=m.result()\n'}
        raw=create_archive(self.original,doc)
        legacy=self.rewrite(raw,lambda files,manifest:manifest.update(version=1))
        result=restore_archive(self.target,legacy)
        self.assertEqual(result['root']['code'],doc['code'])
        self.assertEqual(result['materials'],0)

    def test_failed_document_import_rolls_back_added_material(self):
        raw=create_archive(self.original,self.doc);before=copy.deepcopy(self.target.state)
        with patch.object(type(self.target.project),'import_package',side_effect=ValueError('Import failure')):
            with self.assertRaisesRegex(ValueError,'Import failure'):restore_archive(self.target,raw)
        self.assertEqual(self.target.state,before)


if __name__=='__main__':unittest.main()

import copy
import json
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_materials import MaterialBody, _checked, UNITS, STRICT
from fastapi import HTTPException
from pydantic import ValidationError


class MaterialTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.server=LocalCadServer(Path(self.temp.name))
        self.client=TestClient(self.server.app,headers={'X-Steve-Session':self.server.token})
        self.body={'name':' Test  alloy ','category':'aluminum','based_on':'aluminum-6061-t6',
                   'description':' Local\nvalues ','color':'#ABCDEF','properties':{'density':5}}

    def tearDown(self):
        self.client.close();self.server.close();self.temp.cleanup()

    def test_create_edit_and_delete_persist(self):
        response=self.client.post('/v1/materials',json=self.body)
        self.assertEqual(response.status_code,200,response.text)
        material=response.json();identifier=material['id']
        self.assertEqual(material['name'],'Test alloy')
        self.assertEqual(material['color'],'#abcdef')
        changed={**self.body,'properties':{'density':8,'thermal_expansion':-2}}
        self.assertEqual(self.client.put('/v1/materials/'+identifier,json=changed).status_code,200)
        saved=json.loads(self.server.path.read_text(encoding='utf-8'))['materials'][identifier]
        self.assertEqual(saved['properties'],changed['properties'])
        self.assertEqual(self.client.delete('/v1/materials/'+identifier).status_code,200)
        self.assertEqual(self.client.get('/v1/materials').json(),{'materials':[]})
        self.assertEqual(self.client.put('/v1/materials/'+identifier,json=self.body).status_code,404)

    def test_invalid_create_and_update_leave_saved_state_unchanged(self):
        good=self.client.post('/v1/materials',json=self.body).json()
        before=copy.deepcopy(self.server.state)
        invalid=[{'name':'   '},{'name':'a'*101},{'category':'missing-category'},
                 {'based_on':'my:private'},{'color':'red'},{'properties':{'density':-1}},
                 {'properties':{'density':0}},{'properties':{'density':True}},
                 {'properties':{'poisson_ratio':.5}},{'properties':{'bogus':1}}]
        for change in invalid:
            for url in ('/v1/materials','/v1/materials/'+good['id']):
                request=self.client.post if url=='/v1/materials' else self.client.put
                response=request(url,json={**self.body,**change})
                self.assertEqual(response.status_code,422,(change,response.text))
                self.assertEqual(self.server.state,before)

    def test_physical_bounds_match_upstream_semantics(self):
        for key,(_,low,high) in UNITS.items():
            for value in (low-1,high+1,float('inf'),float('nan')):
                with self.assertRaises(HTTPException):
                    _checked(MaterialBody(**{**self.body,'properties':{key:value}}))
            checked=_checked(MaterialBody(**{**self.body,'properties':{key:(low+high)/2}}))
            self.assertIn(key,checked['properties'])
            if key in STRICT:
                with self.assertRaises(HTTPException):_checked(MaterialBody(**{**self.body,'properties':{key:low}}))
        checked=_checked(MaterialBody(**{**self.body,'properties':{'density':None}}))
        self.assertEqual(checked['properties'],{})


if __name__=='__main__':unittest.main()

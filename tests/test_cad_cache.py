import concurrent.futures
import copy
import json
from pathlib import Path
import tempfile
import unittest
from steve_desktop.cad_service import CadProject

DOCUMENT = {'name':'Cached assembly','kind':'design','code':'''from steve import Design
from components.block import block
design=Design()
design.add(block,name="left")
design.add(block,name="right",at=(30,0,0))
result=design.result()
''', 'files':{'params.py':'width=10\n','components/block.py':'''from steve import Component
from params import width
block=Component("block")
block.box("body",width,10,10)
'''}}


class ComponentCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.cache=self.root/'cache'

    def tearDown(self):
        self.temp.cleanup()

    def build(self, name, document=None):
        project=CadProject.create(self.root/name)
        project.cache_folder=self.cache
        geometry=project.build(copy.deepcopy(document or DOCUMENT))
        component=geometry['upstream']['components']['block']
        topology=json.loads((project.revision_folder(geometry['revision'])/'topology.json').read_text())
        self.assertFalse((project.revision_folder(geometry['revision'])/'component-cache-out').exists())
        return geometry,component,topology

    def test_reuse_dependencies_corruption_and_external_inputs(self):
        first,component,topology=self.build('cold')
        self.assertEqual(component['cache'],'miss')
        second,component,again=self.build('warm')
        self.assertEqual(component['cache'],'hit')
        self.assertEqual(first['size'],second['size'])
        self.assertEqual(topology,again)
        changed=copy.deepcopy(DOCUMENT);changed['files']['params.py']='width=12\n'
        third,component,_=self.build('changed',changed)
        self.assertEqual(component['cache'],'miss')
        self.assertEqual(third['size'],[42,10,10])
        # A syntactically valid but altered record must be rejected by checksum.
        for path in self.cache.glob('*.json'):
            path.write_text('{}')
        repaired,component,_=self.build('corrupted')
        self.assertEqual(component['cache'],'miss')
        self.assertEqual(repaired['size'],first['size'])
        external=copy.deepcopy(DOCUMENT);external['_imports_map']={'fixture':'a'*64}
        _,component,_=self.build('external-input',external)
        self.assertEqual(component['cache'],'miss')

    def test_parallel_publish_and_failed_build_does_not_publish(self):
        with concurrent.futures.ThreadPoolExecutor(2) as executor:
            results=list(executor.map(self.build,['one','two']))
        self.assertEqual(results[0][0]['size'],results[1][0]['size'])
        _,component,_=self.build('reuse')
        self.assertEqual(component['cache'],'hit')
        before={p.name:p.read_bytes() for p in self.cache.iterdir()}
        bad=copy.deepcopy(DOCUMENT)
        bad['files']['params.py']='width=23\n'
        bad['code']+='\nraise ValueError("failure after components built")\n'
        with self.assertRaisesRegex(ValueError,'failure after components'):
            self.build('failed',bad)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.cache.iterdir()})

if __name__=='__main__':unittest.main()

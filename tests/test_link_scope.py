import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'vendor'))
from steve import links


def part(identifier,code,children=None):
 return dict(document_id=identifier,revision=1,kind='part',code=code,files={},links=children or {})

BOX='import cadquery as cq\nwidth=10\nresult=cq.Workplane("XY").box(width,2,3)\n'

class LinkedScopeTests(unittest.TestCase):
 def test_nested_build_preserves_parent_cache_root_and_document_identity(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder)
   nested=part('nested','from links import shared\nresult=shared(width=4).result\n',{'shared':part('inner',BOX)})
   links.register({'shared':part('outer',BOX),'nested':nested,'later':part('later',BOX)},root)
   first=links.Link('shared')(width=12)
   inner=links.Link('nested')()
   self.assertIs(links.Link('shared')(width=12),first)
   self.assertEqual(links._ROOT,root)
   self.assertEqual(links.DOCUMENTS[id(first.result)],'outer')
   self.assertEqual(links.DOCUMENTS[id(inner.result)],'nested')
   self.assertAlmostEqual(first.result.val().Volume(),72)
   self.assertAlmostEqual(inner.result.val().Volume(),24)
   links.Link('later')()
   self.assertTrue((root/'later'/'v2'/'main.py').is_file())
   self.assertEqual(len(links._BUILT),3)

 def test_failed_nested_build_restores_parent_scope(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder)
   bad=part('bad','from links import shared\nshared()\nraise RuntimeError("failed nested job")\n',{'shared':part('inner',BOX)})
   links.register({'shared':part('outer',BOX),'bad':bad},root)
   first=links.Link('shared')()
   with self.assertRaisesRegex(RuntimeError,'failed nested job'):links.Link('bad')()
   self.assertIs(links.Link('shared')(),first)
   self.assertEqual(links._ROOT,root)
   self.assertEqual(set(links._SOURCES),{'shared','bad'})
   self.assertEqual(len(links._BUILT),1)

if __name__=='__main__':unittest.main()

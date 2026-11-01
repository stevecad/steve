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

 def test_linked_documents_import_their_own_helper_modules(self):
  # Helper modules of the same name in separately written documents: each linked document imports its own, never
  # the host's or another linked document's, and the host's own module is back once the links have built.
  with tempfile.TemporaryDirectory() as host_folder,tempfile.TemporaryDirectory() as folder:
   (Path(host_folder)/'helpers.py').write_text('host_width = 1\n')
   sys.path.insert(0,host_folder)
   try:
    import helpers
    uses='import cadquery as cq\nfrom helpers import {name}\nsize = 2\nresult = cq.Workplane("XY").box({name}, size, size)\n'
    def doc(identifier,name,files):
     return dict(document_id=identifier,revision=1,kind='part',name=identifier,code=uses.format(name=name),files=files,links={})
    links.register({
     'first':doc('first','width_a',{'helpers.py':'width_a = 7\n'}),
     'second':doc('second','width_b',{'helpers.py':'from parts.sizes import B as width_b\n','parts/sizes.py':'B = 9\n'}),
     'third':doc('third','width_c',{'helpers.py':'from parts.sizes import C as width_c\n','parts/sizes.py':'C = 3\n'}),
    },Path(folder))
    widths={alias:round(links.Link(alias)().result.val().BoundingBox().xlen,6) for alias in ('first','second','third')}
    self.assertEqual(widths,{'first':7,'second':9,'third':3})
    self.assertIs(sys.modules.get('helpers'),helpers)
    self.assertNotIn('parts',sys.modules)
    other=links.Link('first')(size=5).result.val().BoundingBox()
    self.assertEqual((round(other.xlen,6),round(other.ylen,6)),(7,5))
   finally:
    sys.path.remove(host_folder)
    sys.modules.pop('helpers',None)

if __name__=='__main__':unittest.main()

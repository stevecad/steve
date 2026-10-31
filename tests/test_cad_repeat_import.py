"""Repeated imports own independent topology before and after placement."""
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from steve_desktop import cad_document  # Establish the pinned runtime import path.
import cadquery as cq
from steve import Model, imports


class RepeatedImportTests(unittest.TestCase):
    def test_repeated_import_faces_and_placement_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shape = cq.Compound.makeCompound([
                cq.Workplane('XY').box(10,20,4).val(),
                cq.Workplane('XY').circle(3).extrude(12).translate((30,0,0)).val(),
            ])
            source = root/'source.step'
            cq.exporters.export(shape,str(source))
            sha = hashlib.sha256(source.read_bytes()).hexdigest()
            source.rename(root/(sha+'.step'))
            with patch.dict(imports._FILES,{},clear=True), patch.dict(imports._SOLIDS,{},clear=True), patch.object(imports,'_ROOT',root):
                model = Model()
                model.import_step('first',sha)
                model.import_step('second',sha)
                self.assertEqual(len(model.bodies),4)
                for k in (1,2):
                    self.assertFalse(model.bodies[f'first_{k}'].isSame(model.bodies[f'second_{k}']))
                compound = cq.Compound.makeCompound(list(model.bodies.values()))
                self.assertEqual(len(compound.Solids()),4)
                refs = model.refs(compound)['faces']
                self.assertEqual(sum(ref.startswith('first.') for ref in refs.values()),9)
                self.assertEqual(sum(ref.startswith('second.') for ref in refs.values()),9)
                original = {name:body.Center().toTuple() for name,body in model.bodies.items()}
                model.move('place_second',['second_1','second_2'],translate=(0,60,0))
                for name,body in model.bodies.items():
                    center=body.Center().toTuple()
                    self.assertTrue(body.isValid())
                    expected=tuple(v+(60 if name.startswith('second') and i==1 else 0) for i,v in enumerate(original[name]))
                    for actual,wanted in zip(center,expected):self.assertAlmostEqual(actual,wanted,places=7)


if __name__ == '__main__':
    unittest.main()

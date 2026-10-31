import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor'))
from modeling.rename import RenameError, rename_parameter

class PlaneRenameTests(unittest.TestCase):
    def test_references_and_scopes(self):
        code = '''import cadquery as cq
plane_1 = cq.Plane(origin=(0,0,10))
label = "plane_1"
# plane_1 is the datum
with model.sketch("s", on=plane_1): pass
def local(plane_1): return plane_1
def use_global(): return plane_1
obj.plane_1 = plane_1
'''
        renamed = rename_parameter(code, 'plane_1', 'mount_plane', construction_plane=True)
        self.assertIn('on=mount_plane', renamed)
        self.assertIn('def local(plane_1): return plane_1', renamed)
        self.assertIn('def use_global(): return mount_plane', renamed)
        self.assertIn('obj.plane_1 = mount_plane', renamed)
        self.assertIn('label = "plane_1"', renamed)
        self.assertIn('# plane_1 is the datum', renamed)

    def test_rejects_collision_and_non_plane(self):
        for code, name in [('plane_1 = cq.Plane()\nmount_plane = 3', 'mount_plane'),
                           ('plane_1 = 3', 'mount_plane'),
                           ('plane_1 = cq.Plane()', 'class'),
                           ('plane_1 = cq.Plane()\nplane_1 = cq.Plane()', 'mount_plane')]:
            with self.subTest(code=code, name=name), self.assertRaises(RenameError):
                rename_parameter(code, 'plane_1', name, construction_plane=True)

    def test_parameter_contract_unchanged(self):
        with self.assertRaises(RenameError):
            rename_parameter('plane_1 = cq.Plane()', 'plane_1', 'mount_plane')
        self.assertIn('width = 10', rename_parameter('length = 10', 'length', 'width'))

if __name__ == '__main__': unittest.main()

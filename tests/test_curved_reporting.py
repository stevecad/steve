import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from steve_desktop import cad_service  # Initialize the vendored runtime path.
import cadquery as cq
from scipy.integrate import quad
from OCP.BRepBuilderAPI import BRepBuilderAPI_NurbsConvert
from steve.reporting import surface_area, face_area
from steve.reporting_curved import curved_area


class CurvedReportingTests(unittest.TestCase):
    def test_large_assembly_reuses_area_across_reporting_passes(self):
        from steve.reporting import planar_area
        assembly=cq.Assembly()
        block=cq.Workplane('XY').box(1,1,1).val()
        for index in range(400):
            assembly.add(block,name=f'block_{index}',loc=cq.Location((index*2,0,0)))
        face_area.cache_clear()
        try:
            with patch('steve.reporting.planar_area',wraps=planar_area) as integrate:
                self.assertAlmostEqual(surface_area(assembly.toCompound()),2400)
                first=integrate.call_count
                self.assertEqual(first,2400)
                self.assertAlmostEqual(surface_area(assembly.toCompound()),2400)
                self.assertEqual(integrate.call_count,first)
        finally:
            face_area.cache_clear()

    def test_analytic_oracles_under_import_conversion_and_transforms(self):
        radius, bore, height = 20, 5, 30
        ellipse_perimeter = 4 * quad(lambda t: math.hypot(20 * math.sin(t), 10 * math.cos(t)), 0, math.pi / 2)[0]
        fixtures = [
            ('ellipse', cq.Workplane('XY').ellipse(20, 10).extrude(5).val(), 400 * math.pi + ellipse_perimeter * 5),
            ('torus', cq.Solid.makeTorus(radius, bore), 4 * math.pi ** 2 * radius * bore),
            ('cone', cq.Solid.makeCone(20, 10, height), math.pi * 30 * math.hypot(height, 10) + math.pi * 500),
            ('sphere_bore', cq.Workplane('XY').sphere(radius).val().cut(cq.Solid.makeCylinder(bore, 60, cq.Vector(0, 0, -30))), 4 * math.pi * (radius + bore) * math.sqrt(radius ** 2 - bore ** 2)),
            ('sector', cq.Solid.makeCylinder(radius, height, angleDegrees=120), 2 * math.pi * radius * height / 3 + 2 * math.pi * radius ** 2 / 3 + 2 * radius * height),
        ]
        with tempfile.TemporaryDirectory() as folder:
            for name, shape, expected in fixtures:
                step = Path(folder) / 'fixture.step'
                cq.exporters.export(shape, str(step))
                variants = [shape, cq.importers.importStep(str(step)).val(),
                            cq.Shape.cast(BRepBuilderAPI_NurbsConvert(shape.wrapped, True).Shape()),
                            shape.rotate((0, 0, 0), (1, 2, 3), 67).translate((132, -57, 29)),
                            cq.Shape.cast(shape.wrapped.Reversed())]
                for index, variant in enumerate(variants):
                    with self.subTest(fixture=name, variant=index):
                        before = [(face.hashCode(), face.Area(), face.Center().toTuple()) for face in variant.Faces()]
                        self.assertTrue(math.isclose(surface_area(variant), expected, rel_tol=1e-8))
                        self.assertEqual(before, [(face.hashCode(), face.Area(), face.Center().toTuple()) for face in variant.Faces()])

    def test_budget_failure_preserves_kernel_fallback(self):
        face = cq.Workplane('XY').sphere(20).val().Faces()[0]
        with self.assertRaisesRegex(ValueError, 'budget'):
            curved_area(face, max_evaluations=1)
        face_area.cache_clear()
        with patch('steve.reporting_curved.curved_area', side_effect=ValueError('budget')):
            with self.assertLogs('steve.reporting', level='WARNING'):
                self.assertEqual(surface_area(face), face.Area())
        face_area.cache_clear()


if __name__ == '__main__':
    unittest.main()

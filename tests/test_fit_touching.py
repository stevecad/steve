"""Zero-clearance fit checks: parts resting on round faces are listed as touching.

Meshes of round faces lie slightly inside the true surface, so a pair the mesh pre-check finds apart must still be
measured unless the faces' exact boxes are apart too.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor'))


def bar(name, corner, size, height):
    (x, y), (w, h) = corner, size
    return (f'from steve import Component\n\n{name} = Component("{name}")\n'
            f'{name}.box("body", {w}, {h}, {height}, at=({x}, {y}, 0), centered=False)\n')


def build(files, main):
    """A design built through the runtime's own entry, in a fresh folder, as a CAD worker runs it."""
    import upstream_runtime as run
    import steve.design as d
    import steve.model as m
    for name in [n for n in sys.modules if n in {'params', 'components'} or n.startswith('components.')]:
        del sys.modules[name]
    d._DESIGNS.clear(); d._COMPONENTS.clear(); m._ACTIVE.clear(); run._REFS.clear(); run._OWNERS.clear()
    folder = tempfile.mkdtemp()
    previous = os.getcwd()
    os.chdir(folder)
    try:
        return run.build({'kind': 'design', 'name': 't', 'code': main, 'files': files, 'mode': 'preview', 'links': {}})
    finally:
        os.chdir(previous)
        while folder in sys.path:
            sys.path.remove(folder)


# A hollow round tube (radius 20, along Z) with flat bars and a round rod against it: one bar flat along its length (a
# line contact), one turned 45 degrees about the tube's axis, a rod crossing it at right angles (a point contact), and
# two bars 0.1 mm clear (one turned, so its box overlaps the tube's), and a seated bar whose placement was rounded to
# 0.00002 mm (as placements through rotations are): still a seat.
TUBE = '''from steve import Component

tube = Component("tube")
tube.cylinder("body", 20, 100)
tube.cylinder("bore", 17, 100, op="cut")
'''
ROD = '''from steve import Component

rod = Component("rod")
rod.cylinder("body", 5, 80)
'''
CURVED = '''from steve import Design
from components.tube import tube
from components.bar import bar
from components.rod import rod

design = Design("frame")
design.add(tube)
design.add(bar, name="along")
design.add(bar, at=((0, 0, 0), ("Z", 45)), name="turned")
design.add(rod, at=((-40, -25, 70), ("Y", 90)), name="crossing")
design.add(bar, at=((-0.0000141, 0.0000141, 0), ("Z", 135)), name="rounded")
design.add(bar, at=((-0.1, 0, 0), ("Z", 180)), name="clear")
design.add(bar, at=((-0.0707107, -0.0707107, 0), ("Z", 225)), name="clear_turned")
design.fit_check("fit", motion=False)
result = design.result()
'''


class RoundFaceTouchingTests(unittest.TestCase):
    def test_parts_resting_on_a_tube_touch_and_clear_ones_do_not(self):
        import steve.design as d
        files = {'components/tube.py': TUBE, 'components/rod.py': ROD,
                 'components/bar.py': bar('bar', (20, -5), (10, 10), 40)}
        real = d._workers
        reports = []
        try:
            for workers in (1, 3):  # one process, and forked workers: the same touching pairs
                d._workers = lambda workers=workers: workers
                reports.append(build(files, CURVED)['modeling']['design']['kinematics']['fits'][0])
        finally:
            d._workers = real
        report = reports[0]
        seats = {frozenset((item['a'], item['b'])) for item in report.get('touching', [])}
        self.assertTrue(report.get('clear'), report)
        self.assertFalse(report.get('issues'), report)
        self.assertEqual(seats, {frozenset(('tube', 'along')), frozenset(('tube', 'turned')), frozenset(('tube', 'crossing')),
                                 frozenset(('tube', 'rounded'))})
        self.assertEqual(report.get('touching_count'), 4)
        for item in report['touching']:
            self.assertLessEqual(item['min_distance_mm'], d.TOUCH_MM)
            self.assertTrue(item['points'])
        self.assertEqual(reports[1].get('touching'), report.get('touching'))


if __name__ == '__main__':
    unittest.main()

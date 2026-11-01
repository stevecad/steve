"""Fit-check overlap of a part pressed very shallowly into another.

A boolean that misses where the two parts' faces cross returns one solid whole as their common volume. That answer
is believed only when the solid really lies inside the other part; otherwise the boolean is asked again, and a pair
no attempt answers plausibly is unverified, never a full-volume clash.
"""
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'vendor'))

import cadquery as cq  # noqa: E402

WIDTH, HEIGHT, RADIUS, DEPTH = 180.0, 70.0, 8.0, 10.0   # the pocket: a rounded rectangle DEPTH deep
SECTION, PRESS, FLOOR = 3.0, 0.2, 12.0                 # the band's square section, how far it presses in, its base


def right_edge(half_w, half_h, r, shift, y):
    """x of a rounded rectangle's right-hand outline at height y (|y| <= half_h)."""
    straight = half_h - r
    if abs(y) <= straight:
        return half_w + shift
    return half_w - r + shift + math.sqrt(max(r * r - (abs(y) - straight) ** 2, 0.0))


class ShallowPressOverlapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        block = (cq.Workplane('XY').box(240, 110, 20, centered=(True, True, False))
                 .cut(cq.Workplane('XY').workplane(offset=20 - DEPTH).rect(WIDTH, HEIGHT).extrude(DEPTH)
                      .edges('|Z').fillet(RADIUS)))
        where = os.path.join(tempfile.mkdtemp(), 'block.step')
        cq.exporters.export(block, where)
        cls.block = cq.importers.importStep(where).val()   # imported, as a STEP part is

        def rounded(w, h, r):
            return cq.Workplane('XY').workplane(offset=FLOOR).rect(w, h).extrude(SECTION).edges('|Z').fillet(r)
        # 0.5 mm inside the pocket all round, then moved towards +x: PRESS into that wall.
        cls.outer = (WIDTH - 1, HEIGHT - 1, RADIUS - 0.5)
        cls.band = (rounded(*cls.outer).cut(rounded(cls.outer[0] - 2 * SECTION, cls.outer[1] - 2 * SECTION, cls.outer[2] - SECTION))
                    .translate((0.5 + PRESS, 0, 0)).val())
        # Independently of any boolean: the band only crosses the pocket's outline on its +x side, so the sliver is the
        # strip between the two right-hand outlines, integrated over y (midpoint rule), times the section's height.
        steps, top = 200000, cls.outer[1] / 2
        area = moment = 0.0
        for i in range(steps):
            y = -top + (i + 0.5) * 2 * top / steps
            xb = right_edge(cls.outer[0] / 2, cls.outer[1] / 2, cls.outer[2], 0.5 + PRESS, y)
            xp = right_edge(WIDTH / 2, HEIGHT / 2, RADIUS, 0.0, y)
            if xb > xp:
                area += (xb - xp) * 2 * top / steps
                moment += (xb * xb - xp * xp) / 2 * 2 * top / steps
        cls.sliver, cls.sliver_x = area * SECTION, moment / area

    def test_overlap_is_the_sliver_not_the_whole_band(self):
        import steve.design as d
        found = d._exact_overlap(self.block, self.band)
        self.assertIsNotNone(found)
        self.assertLess(abs(found[0] - self.sliver), 0.01 * self.sliver, (found, self.sliver))
        self.assertLess(found[0], 0.5 * self.band.Volume())
        self.assertLess(abs(found[2][0] - self.sliver_x), 0.01)
        self.assertTrue(WIDTH / 2 < found[2][0] < WIDTH / 2 + PRESS, found)
        self.assertLess(abs(found[2][1]), 1e-6)
        self.assertLess(abs(found[2][2] - (FLOOR + SECTION / 2)), 0.05)

    def test_a_whole_band_answer_is_asked_again_or_unverified(self):
        import steve.design as d
        real, band = d._boolean_common, self.band
        try:
            d._boolean_common = lambda a, b, use_obb, fuzzy: band.wrapped if use_obb else real(a, b, use_obb, fuzzy)
            retried = d._exact_overlap(self.block, band)
            d._boolean_common = lambda a, b, use_obb, fuzzy: band.wrapped
            never = d._exact_overlap(self.block, band)
        finally:
            d._boolean_common = real
        self.assertIsNotNone(retried)
        self.assertLess(abs(retried[0] - self.sliver), 0.01 * self.sliver, (retried, self.sliver))
        self.assertIsNone(never)

    def test_a_solid_truly_inside_reports_its_whole_volume(self):
        import steve.design as d
        for z in (4.0, 0.0):  # inside the block's floor, and flush with its underside
            cube = cq.Workplane('XY').box(2, 2, 2, centered=(True, True, False)).translate((110, 0, z)).val()
            held = d._exact_overlap(self.block, cube)
            self.assertIsNotNone(held, z)
            self.assertLess(abs(held[0] - 8.0), 1e-3, held)
            self.assertLess(abs(held[2][0] - 110), 1e-3, held)


if __name__ == '__main__':
    unittest.main()

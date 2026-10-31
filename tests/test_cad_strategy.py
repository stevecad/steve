import unittest
from steve_desktop.cad_strategy import choose_components


def cost(geometry, restore=.05, write=.05):
    return {'geometry_seconds': geometry, 'restore_seconds': restore, 'write_seconds': write}


class StrategyTests(unittest.TestCase):
    def setUp(self):
        self.plan = {'reason': None, 'levels': [['a', 'b', 'c']], 'dependencies': {'a': [], 'b': [], 'c': []}}

    def test_tiny_work_stays_serial(self):
        result = choose_components(self.plan, ['a', 'b', 'c'], {p: cost(.05) for p in 'abc'}, 8)
        self.assertEqual(result['mode'], 'serial')

    def test_expensive_independent_work_uses_parallel(self):
        result = choose_components(self.plan, ['a', 'b', 'c'], {p: cost(3) for p in 'abc'}, 5)
        self.assertEqual(result['mode'], 'parallel')
        self.assertEqual(result['selected'], ['a', 'b', 'c'])

    def test_mixed_work_leaves_cheap_components_serial(self):
        result = choose_components(self.plan, ['a', 'b', 'c'], {'a': cost(3), 'b': cost(3), 'c': cost(.01)}, 8)
        self.assertEqual(result['mode'], 'mixed')
        self.assertEqual(result['selected'], ['a', 'b'])

    def test_cached_components_do_not_justify_fanout(self):
        result = choose_components(self.plan, ['c'], {p: cost(3) for p in 'abc'}, 8)
        self.assertEqual(result['mode'], 'serial')

    def test_dependency_chain_has_no_parallel_benefit(self):
        plan = {'reason': None, 'levels': [['a'], ['b'], ['c']],
                'dependencies': {'a': [], 'b': ['a'], 'c': ['a', 'b']}}
        self.assertEqual(choose_components(plan, list('abc'), {p: cost(3) for p in 'abc'}, 8)['mode'], 'serial')

    def test_unknown_costs_or_cold_workers_stay_serial(self):
        self.assertEqual(choose_components(self.plan, list('abc'), {}, 8)['mode'], 'serial')
        self.assertEqual(choose_components(self.plan, list('abc'), {p: cost(3) for p in 'abc'}, 1)['mode'], 'serial')

    def test_unknown_prerequisite_stays_serial(self):
        plan = {'reason': None, 'levels': [['a'], ['b', 'c']], 'dependencies': {'a': [], 'b': ['a'], 'c': ['a']}}
        self.assertEqual(choose_components(plan, list('abc'), {'b': cost(3), 'c': cost(3)}, 8)['mode'], 'serial')

    def test_expensive_cache_restoration_stays_serial(self):
        result = choose_components(self.plan, list('abc'), {p: cost(1, restore=1) for p in 'abc'}, 8)
        self.assertEqual(result['mode'], 'serial')

    def test_does_not_depend_on_cold_replacement_workers(self):
        result = choose_components(self.plan, list('abc'), {p: cost(3) for p in 'abc'}, 4)
        self.assertEqual(result['mode'], 'mixed')
        self.assertEqual(result['selected'], ['a', 'b'])


if __name__ == '__main__':
    unittest.main()

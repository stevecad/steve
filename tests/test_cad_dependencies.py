import unittest
from steve_desktop.cad_dependencies import component_plan


def component(name, prefix=''):
    return prefix + f'from steve import Component\n{name}=Component("{name}")\n{name}.box("body",10,20,30)\n'


class ComponentPlanTests(unittest.TestCase):
    def document(self):
        return {'kind': 'design', 'name': 'Graph', 'code':
                'from steve import Design\nfrom components import left, right, top\n'
                'design=Design()\ndesign.add(left.left)\ndesign.add(right.right)\ndesign.add(top.top)\nresult=design.result()\n',
                'files': {'components/left.py': component('left'),
                          'components/right.py': component('right'),
                          'components/top.py': component('top', 'from components.left import left\n'),
                          'components/unused.py': 'raise RuntimeError("must not execute")'}}

    def test_independent_branches_then_dependent_component(self):
        plan = component_plan(self.document())
        self.assertEqual(plan['levels'], [['components/left.py', 'components/right.py'], ['components/top.py']])
        self.assertEqual(plan['dependencies']['components/top.py'], ['components/left.py'])

    def test_shared_dependency_is_scheduled_once(self):
        doc = self.document()
        doc['files']['components/right.py'] = component('right', 'from components.left import left\n')
        self.assertEqual(component_plan(doc)['levels'], [['components/left.py'], ['components/right.py', 'components/top.py']])

    def test_cycles_fall_back_without_partial_plan(self):
        doc = self.document()
        doc['files']['components/left.py'] = component('left', 'from components.top import top\n')
        self.assertEqual(component_plan(doc)['reason'], 'cyclic component dependencies')
        self.assertEqual(component_plan(doc)['levels'], [])

    def test_dynamic_and_mutating_source_stays_serial(self):
        for prefix in ('import os\n', 'from missing import values\n', 'exec("pass")\n',
                       'params.width=2\n', 'values[0]=2\n', 'from .params import width\n',
                       'from params import *\n', 'def helper():\n return 2\n'):
            with self.subTest(prefix=prefix):
                doc = self.document()
                doc['files']['components/left.py'] = prefix + doc['files']['components/left.py']
                plan = component_plan(doc)
                self.assertEqual(plan['levels'], [])
                self.assertTrue(plan['reason'])

    def test_plain_parameters_and_math_are_supported(self):
        doc = self.document()
        doc['files']['params.py'] = 'from math import sin, pi\nwidth=10+sin(pi)\n'
        doc['files']['components/left.py'] = component('left', 'from params import width\n').replace('10,20,30', 'width,20,30')
        self.assertIsNone(component_plan(doc)['reason'])


if __name__ == '__main__':
    unittest.main()

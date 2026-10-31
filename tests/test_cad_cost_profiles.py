import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from steve_desktop.cad_cost_profiles import family_key, record_costs, observed_costs


class CostProfileTests(unittest.TestCase):
    def document(self):
        return {'files': {'params.py': 'width=10\ncount=4\n', 'components/a.py':
                         'from steve import Component\nfrom params import width,count\na=Component("a")\n'
                         'for i in range(count):\n a.box("body"+str(i),width,20,30,at=(0,i*40,0),op="new")\n'},
                'links': {}, 'materials': {}}

    def test_dimension_edit_reuses_family_but_pattern_count_does_not(self):
        doc = self.document()
        key = family_key(doc, 'components/a.py')
        doc['files']['params.py'] = 'width=12\ncount=4\n'
        self.assertEqual(family_key(doc, 'components/a.py'), key)
        doc['files']['params.py'] = 'width=12\ncount=40\n'
        self.assertNotEqual(family_key(doc, 'components/a.py'), key)

    def test_literal_loop_and_branch_changes_are_distinct(self):
        doc = self.document()
        doc['files']['components/a.py'] = doc['files']['components/a.py'].replace('range(count)', 'range(4)')
        key = family_key(doc, 'components/a.py')
        doc['files']['components/a.py'] = doc['files']['components/a.py'].replace('range(4)', 'range(40)')
        self.assertNotEqual(family_key(doc, 'components/a.py'), key)

    def test_observed_restore_and_write_costs_are_retained_separately(self):
        with tempfile.TemporaryDirectory() as folder, patch('steve_desktop.cad_cost_profiles.profile_version', return_value='test'):
            doc = self.document()
            item = {'file': 'components/a.py', 'geometry_seconds': 2, 'write_seconds': .1,
                    'restore_seconds': None, 'runtime_version': 'runtime', 'cache_version': 1, 'cache': 'miss'}
            record_costs(folder, doc, [item])
            record_costs(folder, doc, [{**item, 'cache': 'hit', 'write_seconds': 0, 'restore_seconds': .2}])
            costs, missing = observed_costs(folder, doc, ['components/a.py'])
            self.assertEqual(missing, ['components/a.py'])
            self.assertEqual(costs['components/a.py']['write_seconds'], .1)
            self.assertEqual(costs['components/a.py']['restore_seconds'], .2)
            altered = copy.deepcopy(doc)
            altered['materials'] = {'custom': {'density': 1000}}
            self.assertEqual(observed_costs(folder, altered, ['components/a.py'])[0], {})

    def test_old_version_or_corrupt_profile_falls_back(self):
        with tempfile.TemporaryDirectory() as folder, patch('steve_desktop.cad_cost_profiles.profile_version', return_value='new'):
            path = Path(folder) / 'cost-profiles.json'
            for content in ('broken', json.dumps({'version': 'old', 'entries': {}})):
                path.write_text(content)
                self.assertEqual(observed_costs(folder, self.document(), ['components/a.py'])[0], {})


if __name__ == '__main__':
    unittest.main()

"""Pinned local revisions expose the same update state as Studio's document API."""
import copy
import tempfile
import unittest
from fastapi.testclient import TestClient
from steve_desktop.cad_document import bracket
from steve_desktop.cad_server import LocalCadServer


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = LocalCadServer(self.temp.name)
        self.client = TestClient(self.server.app, headers={'x-steve-session': self.server.token})
        self.part = self.client.post('/v1/documents', json=bracket()).json()
        self.design = self.client.post('/v1/documents', json={
            'name': 'Linked bracket', 'kind': 'design', 'code': 'from links import bracket\nresult = bracket()',
            'files': {}, 'links': {'bracket': {'document_id': self.part['id'], 'revision': 1}},
        }).json()
        self.url = '/v1/documents/' + self.design['id']

    def tearDown(self):
        self.client.close()
        self.server.close()
        self.temp.cleanup()

    def test_new_revision_is_reported_without_advancing_the_pin(self):
        first = self.client.get(self.url).json()
        self.assertEqual(first['link_status']['bracket'], {
            'revision': 1, 'latest': 1, 'name': self.part['name'], 'kind': 'part'})
        edited = {**self.part, 'name': 'Wider bracket', 'code': self.part['code'].replace('width = 80', 'width = 100')}
        self.assertEqual(self.client.put('/v1/documents/' + self.part['id'], json=edited).status_code, 200)
        current = self.client.get(self.url).json()
        self.assertEqual(current['link_status']['bracket'], {
            'revision': 1, 'latest': 2, 'name': 'Wider bracket', 'kind': 'part'})
        self.assertEqual(current['links']['bracket']['revision'], 1)
        resolved = self.server.resolve_links(current)
        self.assertEqual(resolved['links']['bracket']['code'], self.part['code'])
        self.assertNotIn('link_status', self.server.state['documents'][self.design['id']])
        update = {**current, 'links': {'bracket': {'document_id': self.part['id'], 'revision': 2}}}
        self.assertEqual(self.client.put(self.url, json=update).status_code, 200)
        selected = self.client.get(self.url).json()
        self.assertEqual(selected['link_status']['bracket']['revision'], 2)
        self.assertEqual(self.server.resolve_links(selected)['links']['bracket']['code'], edited['code'])

    def test_trashed_and_missing_targets_match_upstream_status(self):
        self.client.post('/v1/trash', json={'ids': [self.part['id']]})
        current = self.client.get(self.url).json()
        self.assertTrue(current['link_status']['bracket']['trashed'])
        self.assertEqual(current['link_status']['bracket']['latest'], 1)
        self.assertEqual(self.server.resolve_links(current)['links']['bracket']['code'], self.part['code'])
        self.client.post('/v1/trash/restore', json={'ids': [self.part['id']]})
        self.assertNotIn('trashed', self.client.get(self.url).json()['link_status']['bracket'])
        self.server.state['documents'].pop(self.part['id'])
        self.assertEqual(self.client.get(self.url).json()['link_status']['bracket'], {
            'revision': 1, 'latest': None, 'name': None, 'kind': None})

    def test_preview_attaches_to_canonical_document(self):
        build = copy.deepcopy(self.design)
        build.update(id='preview-fixture', status='succeeded')
        self.server.state['builds'][build['id']] = build
        response = self.client.post(self.url + '/preview', json={'revision': 1, 'build_id': build['id']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.server.revision(self.design['id'])['preview_build_id'], build['id'])
        self.assertEqual(self.client.get(self.url).json()['preview_build_id'], build['id'])


if __name__ == '__main__':
    unittest.main()

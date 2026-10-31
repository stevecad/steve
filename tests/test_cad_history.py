"""Revision provenance, save messages and non-destructive local restoration."""
import copy
import json
import tempfile
import unittest
from fastapi.testclient import TestClient
from steve_desktop.cad_document import bracket
from steve_desktop.cad_server import LocalCadServer


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = LocalCadServer(self.temp.name)
        self.client = TestClient(self.server.app, headers={'x-steve-session': self.server.token})

    def tearDown(self):
        self.client.close()
        self.server.close()
        self.temp.cleanup()

    def build_record(self, doc, identifier, status='succeeded'):
        # Metadata-only fixture: real geometry and viewport restoration are exercised by the Qt UI check.
        self.server.state['builds'][identifier] = {**copy.deepcopy(doc), 'id': identifier, 'status': status}
        return identifier

    def test_messages_preview_restore_and_persistence(self):
        first = bracket()
        first['preview_build_id'] = self.build_record(first, 'first')
        doc = self.client.post('/v1/documents', json={**first, 'message': 'Initial bracket — Ø6'}).json()
        url = '/v1/documents/' + doc['id']
        second = {**doc, 'code': doc['code'].replace('width = 80', 'width = 100')}
        second['preview_build_id'] = self.build_record(second, 'second')
        saved = self.client.put(url, json={**second, 'message': 'Wider mounting plate'}).json()
        history = self.client.get(url + '/history').json()['revisions']
        self.assertEqual([r['message'] for r in history], ['Wider mounting plate', 'Initial bracket — Ø6'])
        self.assertEqual([r['preview_build_id'] for r in history], ['second', 'first'])
        self.assertEqual(self.client.get(url + '/history/1').json()['document']['code'], first['code'])
        restored = self.client.post(url + '/history/restore', json={'revision': 2, 'commit_id': '1'}).json()
        self.assertEqual(restored['document']['revision'], 3)
        self.assertEqual(restored['document']['code'], first['code'])
        self.assertEqual(restored['document']['message'], 'Restored revision 1')
        self.assertEqual(restored['model']['id'], 'first')
        self.assertEqual(self.client.get(url + '/history/2').json()['document']['code'], saved['code'])
        self.assertEqual(self.client.post(url + '/history/restore', json={'revision': 2, 'commit_id': '1'}).status_code, 409)
        persisted = json.loads(self.server.path.read_text(encoding='utf-8'))
        self.assertEqual(persisted['documents'][doc['id']]['revision'], 3)
        self.assertEqual([r['message'] for r in persisted['history'][doc['id']]], ['Initial bracket — Ø6', 'Wider mounting plate'])
        # A regular subsequent save must not inherit the previous save's message.
        plain = self.client.put(url, json={**first, 'revision': 3}).json()
        self.assertIsNone(plain['message'])

    def test_unbuilt_changes_cannot_claim_old_geometry(self):
        source = bracket()
        old = self.build_record(source, 'original')
        doc = self.client.post('/v1/documents', json={**source, 'preview_build_id': old}).json()
        url = '/v1/documents/' + doc['id']
        changed = {**doc, 'code': source['code'].replace('width = 80', 'width = 120')}
        saved = self.client.put(url, json=changed).json()
        self.assertIsNone(saved['preview_build_id'])
        self.assertEqual(self.client.post(url + '/preview', json={'revision': 2, 'build_id': old}).status_code, 422)
        pending = self.build_record(changed, 'pending', 'running')
        self.assertEqual(self.client.post(url + '/preview', json={'revision': 2, 'build_id': pending}).status_code, 422)
        current = self.build_record(changed, 'current')
        self.assertEqual(self.client.post(url + '/preview', json={'revision': 1, 'build_id': current}).status_code, 409)
        self.assertEqual(self.client.post(url + '/preview', json={'revision': 2, 'build_id': current}).json()['preview_build_id'], current)
        # Reject stale references already written by older app versions, too.
        self.server.state['documents'][doc['id']]['preview_build_id'] = old
        self.assertIsNone(self.client.get(url + '/history').json()['revisions'][0]['preview_build_id'])

    def test_message_validation_and_preview_source_dependencies(self):
        for message in (42, [], 'x' * 201):
            self.assertEqual(self.client.post('/v1/documents', json={**bracket(), 'message': message}).status_code, 422)
        original = bracket()
        build = self.build_record(original, 'original')
        for change in ({'files': {'params.py': 'width=99'}}, {'links': {'plate': {'document_id': 'other', 'revision': 1}}}):
            self.assertIsNone(self.server.matching_preview({**original, **change}, build))
        self.assertEqual(self.server.matching_preview({**original, 'name': 'Renamed'}, build), build)


if __name__ == '__main__':
    unittest.main()

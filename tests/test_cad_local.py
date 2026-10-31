import copy
import tempfile
import threading
import time
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from steve_desktop.cad_document import bracket, change_parameters
from steve_desktop.cad_live import fingerprint, source
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_service import CadProject


class LocalCadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.server = LocalCadServer(self.temp.name)
        self.client = TestClient(self.server.app, headers={'x-steve-session': self.server.token})

    def tearDown(self):
        self.client.close()
        self.server.close()
        self.temp.cleanup()

    def test_cpu_budget_api_and_persistence(self):
        status = self.client.get('/v1/local/performance')
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()['cpu_percent'], 80)
        self.assertEqual(status.json()['isolation'], 'fresh_process_per_job')
        for value in (0, 101, True, '80'):
            self.assertEqual(self.client.put('/v1/local/performance', json={'cpu_percent': value}).status_code, 422)
        self.assertEqual(self.client.put('/v1/local/performance', json={'cpu_percent': 50}).json()['cpu_percent'], 50)
        import json
        self.assertEqual(json.loads(self.server.path.read_text())['settings']['local.cpu_percent'], 50)
        self.assertEqual(self.client.put('/v1/local/performance', json={'cpu_percent': 80}).json()['cpu_percent'], 80)

    def test_studio_source_file_limit(self):
        from steve_desktop.cad_document import validate
        doc = {**bracket(), 'files': {f'components/part_{i}.py': '# component\n' for i in range(200)}}
        validate(doc)
        doc['files']['one_too_many.py'] = ''
        with self.assertRaisesRegex(ValueError, '200'):
            validate(doc)

    def test_private_session_and_saved_revision_conflicts(self):
        with TestClient(self.server.app) as anonymous:
            self.assertEqual(anonymous.get('/v1/documents').status_code, 403)
        self.assertEqual(self.client.get('/v1/documents', headers={'origin': 'https://example.com'}).status_code, 403)
        doc = self.client.post('/v1/documents', json=bracket()).json()
        changed = {**doc, 'name': 'Bracket v2'}
        self.assertEqual(self.client.put('/v1/documents/' + doc['id'], json=changed).status_code, 200)
        self.assertEqual(self.client.put('/v1/documents/' + doc['id'], json=changed).status_code, 409)
        history = self.client.get(f"/v1/documents/{doc['id']}/history").json()
        self.assertEqual([d['revision'] for d in history['revisions']], [2, 1])
        self.client.post('/v1/trash', json={'ids': [doc['id']]})
        self.assertEqual(self.client.get('/v1/documents').json()['documents'], [])
        self.client.post('/v1/trash/restore', json={'ids': [doc['id']]})
        self.assertEqual(len(self.client.get('/v1/documents').json()['documents']), 1)

    def test_shared_build_edit_export_reopen_and_rollback(self):
        self.server.context = {'document': bracket(), 'selection': [], 'document_id': None, 'build_id': None}
        project = self.server.project
        initial = project.read()
        geometry = project.build(bracket(), initial['revision'])
        self.assertEqual(geometry['size'], [80, 50, 40])
        self.assertEqual(geometry['solids'], 1)
        first_build = geometry['build_id']
        self.assertTrue(self.server.pending)
        self.client.post('/v1/local/context', json={**self.server.context, 'ack': self.server.pending['version']})
        edited = project.parameters({'width': 100}, geometry['revision'])
        self.assertEqual(edited['size'], [100, 50, 40])
        self.client.post('/v1/local/context', json={**self.server.context, 'ack': self.server.pending['version']})
        exported = project.export('STEP', edited['revision'])
        import cadquery as cq
        from cadquery import occ_compat
        occ_compat.enable()
        shape = cq.importers.importStep(exported['path']).val()
        self.assertAlmostEqual(shape.Volume(), edited['volume'], places=4)
        bad = {**project.read()['document'], 'code': 'raise ValueError("failed rebuild")'}
        with self.assertRaisesRegex(ValueError, 'failed rebuild'):
            project.build(bad, edited['revision'])
        self.assertEqual(project.read()['revision'], edited['revision'])
        self.assertEqual(project.inspect()['size'], [100, 50, 40])
        restored = project.restore('1')
        self.assertEqual(restored['size'], [80, 50, 40])
        self.assertTrue(self.server.build_folder(first_build)[2].joinpath('preview.glb').exists())
        self.assertEqual(len(project.state()['revisions']), 2)

    def test_human_edit_during_agent_build_is_preserved(self):
        self.server.context = {'document': bracket(), 'selection': []}
        initial = self.server.project.read()
        code = {**bracket(), 'code': 'import time\ntime.sleep(0.5)\n' + bracket()['code']}
        errors = []
        def build():
            try:
                self.server.project.build(code, initial['revision'])
            except ValueError as exc:
                errors.append(str(exc))
        thread = threading.Thread(target=build)
        thread.start()
        time.sleep(.15)
        changed = change_parameters(bracket(), {'width': 120})
        with self.server.lock:
            self.server.context['document'] = changed
        thread.join(30)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors and 'human edited' in errors[0])
        self.assertEqual(self.server.project.read()['revision'], fingerprint(changed))
        self.assertIsNone(self.server.pending)

    def test_multifile_design_and_pinned_link(self):
        part = self.server.create_document({'name': 'Pin', 'kind': 'part', 'code': 'from steve import Model\nmodel=Model()\nmodel.box("body", 10, 20, 30)\nresult=model.result()\n'})
        design = {'name': 'Assembly', 'kind': 'design', 'code': 'from steve import Design\nfrom links import pin\nfrom params import offset\ndesign=Design()\ndesign.add(pin(), at=(offset,0,0))\nresult=design.result()\n',
                  'files': {'params.py': 'offset=40\n'}, 'links': {'pin': {'document_id': part['id'], 'revision': 1}}, 'mode': 'full'}
        self.server.context = {'document': design, 'selection': []}
        result = self.server.project.build(design, fingerprint(design))
        self.assertEqual(result['size'], [10, 20, 30])
        entry, project, folder = self.server.build_folder(result['build_id'])
        self.assertTrue(entry['metadata']['body_meshes'])
        self.assertTrue((folder / 'assembly.step').exists())
        self.assertEqual(self.client.get(f"/v1/builds/{entry['id']}/body-mesh/0").status_code, 200)
        components = entry['metadata']['component_steps']
        self.assertTrue(components)
        component = self.client.get(f"/v1/builds/{entry['id']}/components/{components[0]['key']}")
        self.assertEqual(component.status_code, 200)
        self.assertIn(b'ISO-10303-21', component.content)
        for resolution in ('medium', 'coarse'):
            response = self.client.post(f"/v1/builds/{entry['id']}/print-mesh?resolution={resolution}")
            self.assertEqual(response.status_code, 200, response.text)
            mesh = self.client.get(f"/v1/builds/{entry['id']}/body-mesh/0?resolution={resolution}")
            self.assertEqual(mesh.status_code, 200)
            self.assertGreater(len(mesh.content), 80)

    def test_step_import_roundtrip(self):
        data = Path(__file__).parents[2] / 'cad-demo/manual-bracket.step'
        if not data.exists():
            self.skipTest('Manual export fixture unavailable')
        response = self.client.post('/v1/imports', files={'file': ('bracket.step', data.read_bytes(), 'application/octet-stream')})
        self.assertEqual(response.status_code, 202)
        record = response.json()
        deadline = time.monotonic() + 30
        while record['status'] == 'validating' and time.monotonic() < deadline:
            time.sleep(.1)
            record = self.client.get('/v1/imports/' + record['id']).json()
        self.assertEqual(record['status'], 'ready', record.get('error'))
        self.assertEqual(record['solids'], 1)
        self.server.context = {'document': None, 'selection': []}
        result = self.server.project.build({'name': 'Imported bracket', 'kind': 'part', 'code': record['part_code']})
        for actual, wanted in zip(result['size'], [100, 50, 40]):
            self.assertAlmostEqual(actual, wanted, places=5)

    def test_mcp_package_preserves_revision_pins(self):
        source_part = {**bracket(), 'document_id': 'remote-part', 'revision': 7}
        assembly = {'name': 'Remote assembly', 'kind': 'design', 'document_id': 'remote-assembly', 'revision': 3,
                    'code': 'from steve import Design\nfrom links import bracket\ndesign=Design()\ndesign.add(bracket())\nresult=design.result()\n',
                    'links': {'bracket': {'document_id': 'remote-part', 'revision': 7}}, 'files': {'params.py': '# parameters\n'}}
        answer = self.server.project.import_package([assembly, source_part])
        local = answer['root']
        self.assertEqual(local['studio_origin']['revision'], 3)
        ref = local['links']['bracket']
        self.assertNotEqual(ref['document_id'], 'remote-part')
        self.assertEqual(ref['revision'], 1)
        self.assertEqual(self.server.revision(ref['document_id'])['studio_origin']['revision'], 7)
        with self.assertRaisesRegex(ValueError, 'missing a pinned'):
            self.server.project.import_package([assembly])


if __name__ == '__main__':
    unittest.main()

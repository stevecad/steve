"""Exercise automatic fanout through the desktop's actual build endpoint."""
import tempfile
import time
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from steve_desktop.cad_server import LocalCadServer


class ParallelServerTests(unittest.TestCase):
    def test_build_endpoint_prepares_components_and_reports_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            server = LocalCadServer(Path(directory) / 'cad')
            try:
                doc = {'kind': 'design', 'name': 'Endpoint assembly', 'links': {}, '_parallel_components': True,
                       'code': 'from steve import Design\nfrom components.a import a\nfrom components.b import b\n'
                               'design=Design()\ndesign.add(a)\ndesign.add(b,at=(40,0,0))\nresult=design.result()\n',
                       'files': {f'components/{name}.py': f'from steve import Component\n{name}=Component("{name}")\n'
                                 f'{name}.box("body",10,20,30)\n' for name in ('a', 'b')}}
                with TestClient(server.app, headers={'x-steve-session': server.token}) as client:
                    response = client.post('/v1/builds', json=doc)
                    self.assertEqual(response.status_code, 202, response.text)
                    identifier = response.json()['id']
                    deadline = time.monotonic() + 60
                    progress = []
                    while time.monotonic() < deadline:
                        result = client.get('/v1/builds/' + identifier).json()
                        if item := (result.get('metadata') or {}).get('progress'):
                            progress.append(item)
                        if result['status'] in ('succeeded', 'failed'):
                            break
                        time.sleep(.02)
                    self.assertEqual(result['status'], 'succeeded', result.get('error'))
                    preparation = result['component_preparation']
                    self.assertIsNone(preparation['reason'], preparation)
                    self.assertEqual(len(preparation['jobs']), 2)
                    self.assertTrue(any(item['stage'] == 'components' for item in progress), progress)
                    project = server.build_folder(identifier)[1]
                    geometry = project.inspect()
                    self.assertEqual(geometry['solids'], 2)
                    self.assertAlmostEqual(geometry['volume'], 12000)
                    self.assertEqual({c['cache'] for c in geometry['upstream']['components'].values()}, {'hit'})
            finally:
                server.close()


if __name__ == '__main__':
    unittest.main()

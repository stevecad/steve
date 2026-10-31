import io
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from fastapi.testclient import TestClient
from steve_desktop.cad_server import LocalCadServer

DRAWING = {'name': 'Inspection plate', 'kind': 'part', 'mode': 'full', 'code': '''import cadquery as cq
from steve.drawing import Drawing
result = cq.Workplane("XY").box(120, 60, 10).faces(">Z").workplane().hole(12)
Drawing(result, title="Inspection plate", fields={"number":"PL-001", "material":"6061-T6"},
        notes=["Break sharp edges.", "Diameter \u2300 12 mm; tolerance \u00b1 0.1 mm"])
Drawing(result, title="Plate detail", sheet="A4", orientation="portrait", views=("front",), scale=(1,1))
'''}


class DrawingTests(unittest.TestCase):
    def test_fonts_artifacts_and_product_package(self):
        with tempfile.TemporaryDirectory() as folder:
            server = LocalCadServer(folder)
            try:
                with TestClient(server.app, headers={'x-steve-session':server.token}) as client:
                    response = client.post('/v1/builds', json=DRAWING)
                    self.assertEqual(response.status_code, 202, response.text)
                    identifier = response.json()['id']
                    until = time.monotonic() + 90
                    while time.monotonic() < until:
                        build = client.get('/v1/builds/'+identifier).json()
                        if build['status'] in ('succeeded', 'failed'): break
                        time.sleep(.05)
                    self.assertEqual(build['status'], 'succeeded', build.get('error'))
                    report = build['metadata']['drawings']
                    self.assertNotIn('pdf_error', report)
                    self.assertEqual(len(report['sheets']), 2)
                    pdf = client.get(build['artifacts']['drawings_pdf'])
                    self.assertEqual(pdf.status_code, 200)
                    self.assertTrue(pdf.content.startswith(b'%PDF-1.7'))
                    self.assertEqual(pdf.content.count(b'/Type /Page /Parent'), 2)
                    self.assertIn(b'/FontFile2', pdf.content)
                    self.assertIn(b'/ToUnicode', pdf.content)
                    svg = client.get(build['artifacts']['drawing'])
                    self.assertIn('PL-001', svg.text)
                    archive = client.get(build['artifacts']['drawings']).content
                    with zipfile.ZipFile(io.BytesIO(archive)) as package:
                        self.assertEqual(len([n for n in package.namelist() if n.endswith('.svg')]), 2)
                        self.assertEqual(len([n for n in package.namelist() if n.endswith('.dxf')]), 2)
                    merged = client.post('/v1/product-drawings', json={'build_ids':[identifier, identifier]})
                    self.assertEqual(merged.status_code, 200, merged.text)
                    self.assertEqual(merged.json()['pages'], 4)
                    downloaded = client.get(merged.json()['url'])
                    self.assertEqual(downloaded.status_code, 200)
                    self.assertEqual(downloaded.content.count(b'/Type /Page /Parent'), 4)
                    self.assertEqual(client.post('/v1/product-drawings',json={'build_ids':[]}).status_code,422)
                    self.assertEqual(client.post('/v1/product-drawings',json={'build_ids':['missing']}).status_code,404)
                    self.assertEqual(client.get('/v1/product-drawings/'+'0'*64).status_code,404)
                    self.assertEqual(TestClient(server.app).get(merged.json()['url']).status_code,403)
            finally:
                server.close()


if __name__ == '__main__': unittest.main()

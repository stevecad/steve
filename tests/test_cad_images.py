import io
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from fastapi.testclient import TestClient
from steve_desktop.cad_server import LocalCadServer

class DecalImagesTests(unittest.TestCase):
    def test_upload_render_bytes_thumbnail_dedupe_and_reopen(self):
        with tempfile.TemporaryDirectory() as folder:
            server=LocalCadServer(folder)
            try:
                client=TestClient(server.app); client.headers['X-Steve-Session']=server.token
                raw=io.BytesIO(); Image.new('RGBA',(800,400),(255,90,20,128)).save(raw,'PNG')
                response=client.post('/v1/decal-images?name=Logo.png',content=raw.getvalue(),headers={'Content-Type':'image/png'})
                self.assertEqual(response.status_code,201,response.text)
                item=response.json(); self.assertEqual((item['width'],item['height']),(800,400))
                self.assertEqual(client.get(item['url']).status_code,200)
                image=Image.open(io.BytesIO(client.get(item['url']).content)); self.assertEqual(image.mode,'RGBA')
                thumb=Image.open(io.BytesIO(client.get(item['thumbnail_url']).content)); self.assertLessEqual(max(thumb.size),360)
                self.assertEqual(client.post('/v1/decal-images',content=raw.getvalue(),headers={'Content-Type':'image/png'}).json()['id'],item['id'])
                self.assertEqual(client.post('/v1/decal-images',content=b'garbage',headers={'Content-Type':'image/png'}).status_code,415)
                self.assertEqual(client.get('/v1/decal-images').json()['images'][0]['id'],item['id'])
            finally: server.close()
            reopened=LocalCadServer(folder)
            try:
                client=TestClient(reopened.app);client.headers['X-Steve-Session']=reopened.token
                self.assertEqual(client.get(item['url']).status_code,200)
            finally: reopened.close()

if __name__=='__main__': unittest.main()

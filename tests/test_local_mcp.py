import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path
import httpx
from steve_desktop.cad_server import LocalCadServer
from steve_desktop.cad_document import bracket
from steve_desktop.runtime import make_mcp, ServerConfig
from steve_desktop.vault import data_directory


class LocalMCPTests(unittest.TestCase):
    def test_real_stdio_build_inspect_export_and_stop(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict(os.environ,{'LOCALAPPDATA':folder,'XDG_DATA_HOME':folder,'HOME':folder}):
            server=LocalCadServer(data_directory()/'cad')
            deadline=time.monotonic()+20
            while not server.server.started:
                if not server.thread.is_alive() or time.monotonic()>=deadline:
                    server.close()
                    self.fail('Local CAD HTTP server did not start')
                time.sleep(.01)
            async def check():
                async with httpx.AsyncClient(base_url=server.url,headers={'X-Steve-Session':server.token},trust_env=False,timeout=20) as desktop:
                    self.assertFalse((await desktop.get('/v1/local/mcp-server')).json()['running'])
                    self.assertEqual((await desktop.get('/v1/mcp-bridge/tools')).status_code,403)
                    self.assertTrue((await desktop.post('/v1/local/mcp-server/start')).json()['running'])
                    binary=os.environ.get('STEVE_TEST_BINARY')
                    config=ServerConfig(name='steve',transport='stdio',command=binary or sys.executable,
                        args=['--mcp'] if binary else ['-m', 'steve_desktop', '--mcp'],
                        env={'LOCALAPPDATA':folder,'XDG_DATA_HOME':folder,'HOME':folder,
                             **({'APPIMAGE_EXTRACT_AND_RUN':os.environ['APPIMAGE_EXTRACT_AND_RUN']}
                                if 'APPIMAGE_EXTRACT_AND_RUN' in os.environ else {})})
                    async with make_mcp(config) as client:
                        names=[t.name for t in await client.list_tools()]
                        self.assertEqual(len(names),len(set(names)))
                        self.assertIn('blender_render',names)
                        async def call(name,args):
                            response=await client.client.call_tool(name,args)
                            self.assertFalse(response.is_error,response)
                            return json.loads(response.content[0].text)
                        self.assertIsNone((await call('cad_read',{}))['document'])
                        built=await call('cad_build',{'document':bracket(),'expected_revision':None})
                        self.assertNotIn('error',built)
                        geometry=await call('cad_inspect',{'expected_revision':built['revision']})
                        self.assertGreater(geometry['volume'],0)
                        exported=await call('cad_export',{'expected_revision':built['revision'],'format':'STEP'})
                        self.assertTrue(Path(exported['path']).is_file())
                        # A running CAD build must be cancelled by Stop, not merely hidden.
                        server.pending=None
                        slow=bracket();slow['code']='import time\ntime.sleep(20)\n'+slow['code']
                        task=asyncio.create_task(client.client.call_tool('cad_build',{'document':slow,'expected_revision':built['revision']},raise_on_error=False))
                        for _ in range(100):
                            if any(b['status']=='running' for b in server.state['builds'].values()):break
                            await asyncio.sleep(.1)
                        else:self.fail('Slow CAD build did not start')
                        await desktop.post('/v1/local/mcp-server/stop')
                        self.assertTrue((await asyncio.wait_for(task,10)).is_error)
                        for _ in range(100):
                            if not any(b['status'] in ('queued','running') for b in server.state['builds'].values()):break
                            await asyncio.sleep(.1)
                        else:self.fail('Stop did not cancel the CAD worker')
                        result=await client.client.call_tool('cad_read',{},raise_on_error=False)
                        self.assertTrue(result.is_error)
                    self.assertFalse(server.local_mcp.vault.path.exists())
            try: asyncio.run(check())
            finally: server.close()

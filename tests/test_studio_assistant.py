import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from steve_desktop.app import Window
from steve_desktop.service import Service, ModelChoice
from steve_desktop.vault import Vault

APP = QApplication.instance() or QApplication([])

class StudioAssistantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.window = Window(Service(Vault(Path(self.temp.name)/'auth.dpapi')))
        self.window.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen)
        self.window.show_result([ModelChoice(slug='test', display_name='Test', visibility='list', supported_reasoning_levels=[{'effort':'high'}])])
        self.bridge = self.window.local_assistant
    def tearDown(self):
        if self.window.chat_panel.busy:
            self.window.chat_panel.stop_run()
            self.wait(lambda: not self.window.chat_panel.busy)
        self.window.close(); APP.processEvents(); self.temp.cleanup()
    def wait(self, predicate):
        end=time.monotonic()+40
        while not predicate():
            self.assertLess(time.monotonic(),end)
            APP.processEvents()
            time.sleep(.01)
        APP.processEvents()
    def test_studio_run_stream_history_delete_and_effort(self):
        received=[]
        async def fake(source,model,prompt,history,settings,approve,activity,delta):
            received.append(settings)
            delta('First '); await asyncio.sleep(.03); delta('answer')
            return 'First answer', []
        conversation=self.bridge.create()
        with patch('steve_desktop.chat_ui.chat',fake):
            run=self.bridge.start({'request_id':'one','conversation_id':conversation['conversation_id'],'message':'Hello','model':'test','effort':'high'})
            self.assertEqual(self.bridge.start({'request_id':'one'})['run_id'],'one')
            self.wait(lambda: self.bridge.get_run('one')['status']=='succeeded')
            self.wait(lambda: not self.window.chat_panel.busy)
        self.assertEqual(received[0]['reasoning_effort'],'high')
        self.assertEqual(self.bridge.events('one',0)[-1][0],'done')
        self.assertEqual(self.bridge.conversation(conversation['conversation_id'])['turns'][-1]['assistant'],'First answer')
        self.assertTrue(self.window.chat_panel.isHidden())
        self.assertFalse(hasattr(self.window,'cad_dock'))
        self.assertEqual(self.bridge.delete([conversation['conversation_id']])['deleted'],[conversation['conversation_id']])
    def test_account_actions_stay_in_studio_and_refresh_catalog(self):
        connected = [False]
        service = self.window.service
        async def models():
            return [ModelChoice(slug='subscription-model', display_name='Subscription model', visibility='list')]
        def login(cancel):
            connected[0] = True
        def logout():
            connected[0] = False
        with patch.object(service, 'signed_in', lambda: connected[0]), patch.object(service, 'login', login), patch.object(service, 'logout', logout), patch.object(service, 'models', models):
            self.bridge.account_action('login')
            self.wait(lambda: not self.bridge.account()['busy'])
            self.assertTrue(self.bridge.account()['connected'])
            self.assertEqual(self.bridge.account()['models'][0]['id'], 'subscription-model')
            self.assertIs(self.window.sections.currentWidget(), self.window.workspace)
            self.bridge.account_action('models')
            self.wait(lambda: not self.bridge.account()['busy'])
            self.bridge.account_action('logout')
            self.wait(lambda: not self.bridge.account()['busy'])
            self.assertFalse(self.bridge.account()['connected'])
            self.assertEqual(self.bridge.account()['models'], [])

    def test_settings_persist_redact_credentials_and_connect_mcp(self):
        import sys
        from fastapi import HTTPException
        bridge = self.bridge
        folder = self.temp.name
        bridge.workspace(folder)
        bridge.save_agent({'system_prompt': 'Local CAD only.', 'memory_enabled': True, 'scripts_enabled': False, 'skill_libraries': [folder]})
        self.assertEqual(self.window.agent_settings.vault.load()['system_prompt'], 'Local CAD only.')
        with self.assertRaises(HTTPException): bridge.save_agent({'approval_mode': 'ask'})
        with self.assertRaises(HTTPException): bridge.workspace(str(Path(folder)/'missing'))
        config = {'name': 'sample', 'transport': 'stdio', 'command': sys.executable,
                  'args': [str(Path(__file__).parent / 'fixtures/sample_mcp_server.py')],
                  'env': {'SAMPLE_KEY': 'private-environment'}, 'token': 'private-token'}
        settings = bridge.save_server(config)
        self.assertNotIn('private-token', str(settings))
        self.assertNotIn('private-environment', str(settings))
        self.assertTrue(settings['servers'][0]['has_token'])
        bridge.save_server({**settings['servers'][0], 'original_name': 'sample', 'token': ''})
        stored = self.window.tools_panel.vault.load()['servers'][0]
        self.assertEqual(stored['token'], 'private-token')
        self.assertEqual(stored['env'], {'SAMPLE_KEY': 'private-environment'})
        bridge.server_action('sample', 'connect')
        self.wait(lambda: not bridge.settings()['mcp_busy'])
        self.assertIn('add_numbers', bridge.settings()['mcp_status'])
        self.assertIs(self.window.sections.currentWidget(), self.window.workspace)
        bridge.server_action('sample', 'toggle')
        self.assertFalse(bridge.settings()['servers'][0]['enabled'])
        bridge.server_action('sample', 'delete')
        self.assertEqual(bridge.settings()['servers'], [])

    def test_memory_and_settings_http_require_session_and_detect_conflicts(self):
        from concurrent.futures import ThreadPoolExecutor
        import httpx
        server = self.window.cad_panel.server
        def requests():
            with httpx.Client(base_url=server.url, timeout=12) as client:
                self.assertEqual(client.get('/v1/assistant/settings').status_code, 403)
                client.headers['X-Steve-Session'] = server.token
                response = client.get('/v1/assistant/settings')
                self.assertEqual(response.status_code, 200)
                self.assertNotIn('approval_mode', response.json()['agent'])
                note = client.get('/v1/assistant/memory').json()
                first = client.put('/v1/assistant/memory', json={**note, 'content': 'CAD units: mm.'})
                self.assertEqual(first.status_code, 200)
                saved = client.get('/v1/assistant/memory').json()
                second = client.put('/v1/assistant/memory', json={**saved, 'content': 'CAD units: inches.'})
                self.assertEqual(second.status_code, 200)
                conflict = client.put('/v1/assistant/memory', json={**saved, 'content': 'Stale note'})
                self.assertEqual(conflict.status_code, 409)
                self.assertEqual(client.get('/v1/assistant/memory').json()['content'], 'CAD units: inches.')
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(requests)
            self.wait(future.done)
            future.result()

    def test_stop_retains_request_and_partial_answer(self):
        async def slow(source,model,prompt,history,settings,approve,activity,delta):
            delta('Partial'); await asyncio.sleep(60)
        conversation=self.bridge.create()
        with patch('steve_desktop.chat_ui.chat',slow):
            self.bridge.start({'request_id':'stop','conversation_id':conversation['conversation_id'],'message':'Long task','model':'test'})
            self.wait(lambda: bool(self.bridge.runs['stop']['_text']))
            self.bridge.stop('stop')
            self.wait(lambda: self.bridge.get_run('stop')['status']=='stopped')
            self.wait(lambda: not self.window.chat_panel.busy)
        turn=self.bridge.conversation(conversation['conversation_id'])['turns'][-1]
        self.assertEqual((turn['user'],turn['assistant']),('Long task','Partial'))

    def test_images_reach_model_and_persist_in_conversation(self):
        from tests.test_chat_images import png
        from pydantic_ai.messages import ModelRequest, UserPromptPart, ModelResponse, TextPart, BinaryContent
        image = self.bridge.images.save(png(), 'Bracket.png')
        received = []
        async def fake(source, model, prompt, history, settings, approve, activity, delta):
            received.append(prompt)
            return 'An image of a bracket.', [ModelRequest(parts=[UserPromptPart(prompt)]), ModelResponse(parts=[TextPart('An image of a bracket.')])]
        conversation = self.bridge.create()
        with patch('steve_desktop.chat_ui.chat', fake):
            self.bridge.start({'request_id':'image', 'conversation_id':conversation['conversation_id'], 'message':'', 'model':'test', 'attachments':[image['id']]})
            self.wait(lambda: self.bridge.get_run('image')['status']=='succeeded')
            self.wait(lambda: not self.window.chat_panel.busy)
        self.assertIsInstance(received[0][0], BinaryContent)
        self.assertEqual(self.bridge.conversation(conversation['conversation_id'])['turns'][0]['attachments'][0]['id'], image['id'])
        saved = self.window.chat_panel.store.load()['chats'][0]
        self.assertEqual(saved['messages'][0]['attachments'][0]['id'], image['id'])
        self.assertEqual(saved['title'], 'Image')

    def test_failure_records_diagnostic_reference(self):
        from steve_desktop.diagnostics import Diagnostics
        async def failing(*args): raise ValueError('A useful failure reason')
        conversation = self.bridge.create()
        with patch('steve_desktop.chat_ui.chat', failing):
            self.bridge.start({'request_id':'error', 'conversation_id':conversation['conversation_id'], 'message':'Test', 'model':'test'})
            self.wait(lambda: self.bridge.get_run('error')['status']=='failed')
            self.wait(lambda: not self.window.chat_panel.busy)
        entry = Diagnostics(self.temp.name).read()[0]
        self.assertIn(entry['id'], self.bridge.get_run('error')['error'])
        self.assertEqual(entry['errors'][0]['message'], 'A useful failure reason')

    def test_attachment_http_validation_and_session_protection(self):
        import httpx
        from concurrent.futures import ThreadPoolExecutor
        from tests.test_chat_images import png
        server = self.window.cad_panel.server
        def requests():
            with httpx.Client(base_url=server.url, timeout=12) as client:
                self.assertEqual(client.post('/v1/assistant/attachments', content=png()).status_code, 403)
                self.assertEqual(client.get('/v1/assistant/diagnostics').status_code, 403)
                client.headers['X-Steve-Session'] = server.token
                uploaded = client.post('/v1/assistant/attachments?name=Sketch.png', content=png())
                self.assertEqual(uploaded.status_code, 200)
                meta = uploaded.json()
                for url in (meta['url'], meta['thumbnail_url']):
                    response = client.get(url)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers['content-type'], 'image/png')
                    self.assertEqual(response.headers['cache-control'], 'no-store')
                    self.assertTrue(response.content.startswith(b'\x89PNG'))
                self.assertEqual(client.post('/v1/assistant/attachments',content=b'invalid').status_code,422)
                self.assertEqual(client.get('/v1/assistant/attachments/missing').status_code,404)
                self.assertEqual(client.get('/v1/assistant/diagnostics').json()['entries'], [])
        with ThreadPoolExecutor(1) as pool:
            future=pool.submit(requests); self.wait(future.done); future.result()

if __name__=='__main__': unittest.main()

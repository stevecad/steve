import asyncio
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen

import httpx2
from pydantic_ai.providers.openai_chatgpt import OpenAIChatGPTCredentials
from pydantic_ai.exceptions import UserError
from steve_desktop.service import Service, AppError, visible_models
from steve_desktop.vault import Vault, data_directory


def credentials():
    return OpenAIChatGPTCredentials(client_id='test-client', access_token='secret-access',
                                   refresh_token='secret-refresh', scope='chatgpt.tokens.use.direct')


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.vault = Vault(Path(self.temp.name) / 'state.dpapi')
        self.service = Service(self.vault)

    @unittest.skipUnless(os.name == 'nt', 'Windows data directory compatibility')
    def test_steve_directory_preserves_existing_profile(self):
        root = Path(self.temp.name)
        with patch.dict(os.environ, {'LOCALAPPDATA': str(root)}):
            self.assertEqual(data_directory(), root / 'Steve' / 'CAD')
            legacy = root / 'SubscriptionAgent'
            legacy.mkdir()
            stored = Vault(legacy / 'credentials.dpapi')
            stored.save({'test': 'preserved'})
            self.assertEqual(data_directory(), root / 'Steve' / 'CAD')
            self.assertEqual(Vault(data_directory() / 'credentials.dpapi').load(), {'test': 'preserved'})
            (root / 'Steve' / 'CAD' / 'cache').mkdir()
            self.assertEqual(data_directory(), root / 'Steve' / 'CAD')
            Vault(root / 'Steve' / 'CAD' / 'credentials.dpapi').save({'current': True})
            self.assertEqual(data_directory(), root / 'Steve' / 'CAD')
            self.assertEqual(stored.load(), {'test': 'preserved'})

    def test_encrypted_roundtrip_and_logout(self):
        self.vault.save({'host_id': 'urn:uuid:test'})
        asyncio.run(self.service.source.save(credentials()))
        self.assertNotIn(b'secret-access', self.vault.path.read_bytes())
        self.assertEqual(asyncio.run(self.service.source.load()).refresh_token, 'secret-refresh')
        self.service.logout()
        self.assertEqual(self.vault.load(), {'host_id': 'urn:uuid:test'})

    def test_catalog_order_and_visibility(self):
        models = visible_models({'models': [
            {'slug': 'b', 'display_name': 'B', 'visibility': 'list'},
            {'slug': 'hidden', 'display_name': 'Hidden', 'visibility': 'hide'},
            {'slug': 'a', 'display_name': 'A', 'visibility': 'list'}]})
        self.assertEqual([m.slug for m in models], ['b', 'a'])

    def test_models_use_oauth_header_and_real_response_shape(self):
        asyncio.run(self.service.source.save(credentials()))
        def respond(request):
            self.assertEqual(str(request.url), 'https://api.openai.com/v1/models')
            self.assertEqual(request.headers['authorization'], 'Bearer secret-access')
            return httpx2.Response(200, json={'models': [
                {'slug': 'test', 'display_name': 'Test model', 'visibility': 'list'}]})
        client = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
        with patch('steve_desktop.service.AsyncClient', return_value=client):
            self.assertEqual(asyncio.run(self.service.models())[0].slug, 'test')

    def test_cancel_does_not_save_credentials(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch('steve_desktop.service.webbrowser.open', return_value=True):
            with self.assertRaisesRegex(AppError, 'cancelled'):
                self.service.login(cancelled)
        self.assertNotIn('credentials', self.vault.load())

    def test_401_refresh_is_persisted_and_replayed(self):
        asyncio.run(self.service.source.save(credentials()))
        seen = []
        def respond(request):
            seen.append(str(request.url))
            if request.url.host == 'auth.openai.com':
                return httpx2.Response(200, json={'access_token': 'new-access',
                                                'refresh_token': 'new-refresh'})
            if request.headers['authorization'] == 'Bearer secret-access':
                return httpx2.Response(401, json={'error': 'expired'})
            self.assertEqual(request.headers['authorization'], 'Bearer new-access')
            return httpx2.Response(200, json={'models': []})
        client = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
        with patch('steve_desktop.service.AsyncClient', return_value=client):
            self.assertEqual(asyncio.run(self.service.models()), [])
        self.assertEqual(len(seen), 3)
        self.assertEqual(asyncio.run(self.service.source.load()).refresh_token, 'new-refresh')

    def test_missing_plan_permission_never_sends_request(self):
        saved = credentials()
        saved.scope = 'openid'
        asyncio.run(self.service.source.save(saved))
        def respond(request):
            self.fail('A request was sent without plan permission')
        client = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
        with patch('steve_desktop.service.AsyncClient', return_value=client):
            with self.assertRaises(UserError):
                asyncio.run(self.service.models())

    def test_callback_state_and_success(self):
        observations = []
        def browser(url):
            query = parse_qs(urlsplit(url).query)
            callback = query['redirect_uri'][0]
            def send():
                try:
                    urlopen(callback + '?state=wrong&code=bad', timeout=5)
                except Exception as exc:
                    observations.append(getattr(exc, 'code', None))
                with urlopen(callback + '?state=' + query['state'][0] + '&code=good&client_id=test-client', timeout=5) as r:
                    observations.append(r.status)
            thread = threading.Thread(target=send)
            thread.start()
            return True
        async def exchange(_flow, code, *, client_id):
            self.assertEqual(code, 'good')
            self.assertEqual(client_id, 'test-client')
            return credentials()
        with patch('steve_desktop.service.webbrowser.open', side_effect=browser), patch(
            'steve_desktop.service.OpenAIChatGPTOAuthFlow.exchange_code', exchange
        ):
            self.service.login(threading.Event())
        self.assertEqual(observations, [400, 200])
        self.assertTrue(self.service.signed_in())


if __name__ == '__main__':
    unittest.main()

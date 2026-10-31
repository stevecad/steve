import asyncio
import base64
import hashlib
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import urlopen

import httpx2
from steve_desktop.mcp_auth import DesktopOAuth, EncryptedStore, forget_session, session_path
from steve_desktop.runtime import ServerConfig


class OAuthTests(unittest.TestCase):
    def test_encrypted_storage_and_isolation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tokens.dpapi'
            async def check():
                await EncryptedStore(path).put('token', {'secret': 'private-token'}, collection='oauth')
                self.assertEqual(await EncryptedStore(path).get('token', collection='oauth'), {'secret': 'private-token'})
                self.assertIsNone(await EncryptedStore(path).get('token', collection='other'))
                self.assertNotIn(b'private-token', path.read_bytes())
                await EncryptedStore(path).delete('token', collection='oauth')
                self.assertIsNone(await EncryptedStore(path).get('token', collection='oauth'))
            asyncio.run(check())

    def test_browser_pkce_callback_and_saved_session(self):
        state = {'browsers': 0, 'exchanges': 0, 'refreshes': 0}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, value, status=200, headers=None):
                data = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path.startswith('/.well-known/oauth-protected-resource'):
                    self.reply({'resource': origin + '/mcp', 'authorization_servers': [origin]})
                elif self.path.startswith('/.well-known/'):
                    self.reply({'issuer': origin, 'authorization_endpoint': origin + '/authorize',
                                'token_endpoint': origin + '/token', 'registration_endpoint': origin + '/register',
                                'response_types_supported': ['code'], 'code_challenge_methods_supported': ['S256'],
                                'token_endpoint_auth_methods_supported': ['none']})
                elif self.headers.get('Authorization') == 'Bearer test-access':
                    self.reply({'authenticated': True})
                else:
                    self.reply({}, 401, {'WWW-Authenticate': f'Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource"'})

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                if self.path == '/register':
                    self.reply({**json.loads(body), 'client_id': 'test-client'}, 201)
                else:
                    fields = parse_qs(body.decode())
                    if fields.get('grant_type') == ['refresh_token']:
                        if fields.get('refresh_token') != ['test-refresh']:
                            self.reply({'error': 'invalid_grant'}, 400)
                            return
                        state['refreshes'] += 1
                        self.reply({'access_token': 'test-access', 'refresh_token': 'test-refresh', 'token_type': 'Bearer', 'expires_in': 3600})
                        return
                    challenge = base64.urlsafe_b64encode(hashlib.sha256(fields['code_verifier'][0].encode()).digest()).rstrip(b'=').decode()
                    if challenge != state['challenge']:
                        self.reply({'error': 'invalid_grant'}, 400)
                        return
                    state['exchanges'] += 1
                    self.reply({'access_token': 'test-access', 'refresh_token': 'test-refresh', 'token_type': 'Bearer', 'expires_in': 3600})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        origin = f'http://127.0.0.1:{server.server_port}'
        threading.Thread(target=server.serve_forever, daemon=True).start()
        browser_threads = []
        def browser(url):
            state['browsers'] += 1
            query = parse_qs(urlsplit(url).query)
            state['challenge'] = query['code_challenge'][0]
            callback = query['redirect_uri'][0] + '?' + urlencode({'code': 'approved-code', 'state': query['state'][0], 'iss': origin})
            def visit():
                for _ in range(100):
                    try:
                        with urlopen(callback, timeout=1) as response:
                            response.read()
                        return
                    except OSError:
                        time.sleep(.05)
            thread = threading.Thread(target=visit, daemon=True)
            thread.start()
            browser_threads.append(thread)
            return True
        try:
            with tempfile.TemporaryDirectory() as directory, patch('steve_desktop.mcp_auth.webbrowser.open', browser):
                config = ServerConfig(name='test', url=origin + '/mcp')
                async def request():
                    async with httpx2.AsyncClient(auth=DesktopOAuth(config, directory), timeout=15) as client:
                        response = await client.get(config.url)
                        self.assertEqual(response.status_code, 200)
                asyncio.run(asyncio.wait_for(request(), 20))
                asyncio.run(asyncio.wait_for(request(), 20))
                self.assertEqual(state['browsers'], 1)
                self.assertEqual(state['exchanges'], 1)
                self.assertNotIn(b'test-access', session_path(config, directory).read_bytes())
                asyncio.run(EncryptedStore(session_path(config, directory)).put(
                    config.url + '/token_expiry', {'expires_at': time.time() - 3600}, collection='mcp-oauth-token-expiry'))
                asyncio.run(asyncio.wait_for(request(), 20))
                self.assertEqual(state['refreshes'], 1)
                self.assertEqual(state['browsers'], 1)
                forget_session(config, directory)
                self.assertFalse(session_path(config, directory).exists())
        finally:
            server.shutdown()
            server.server_close()
            for thread in browser_threads:
                thread.join(2)

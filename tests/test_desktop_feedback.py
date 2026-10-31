"""Desktop bug reports / feature requests forwarded to Studio's /api/v1/desktop-feedback (mocked)."""
import base64
import copy
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from steve_desktop.diagnostics import Diagnostics, redact_report, tail_bytes
from steve_desktop.local_feedback import LocalFeedback
from steve_desktop.studio_connection import ORIGIN, StudioConnection

DESKTOP = {'client_id': 'app_stevedesktop0001', 'public': True, 'redirect_uri': 'http://127.0.0.1/callback',
           'redirect_ports': 'any', 'scopes': ['designs:read', 'profile', 'feedback:write']}
CAPS = {'api': 'steve', 'sync_version': 1, 'server': {'id': 'server-one'}, 'features': ['projects', 'workspaces', 'project_snapshots'],
        'oauth': {'profile_scope': 'profile', 'desktop_client': DESKTOP, 'code_challenge_methods': ['S256'],
                  **{key: ORIGIN + path for key, path in [('authorization_endpoint', '/oauth/authorize'),
                     ('token_endpoint', '/oauth/token'), ('revocation_endpoint', '/oauth/revoke')]}}}
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32


class RedactionTests(unittest.TestCase):
    def test_home_paths_emails_and_tokens_are_removed(self):
        text = ('C:\\Users\\Jane Doe\\Documents\\bracket.step\n"C:\\\\Users\\\\jdoe\\\\AppData\\\\Local"\n'
                'C:/Users/jdoe/x\n/home/alex/projects/x.py\n/Users/kim/Library/x\n/srv/people/morgan/file\n'
                'mail alex.morgan@example.co.uk or a+b@test.io\nAuthorization: Bearer abc.def\naccess-secret-value\nmorgan wrote it\n')
        result = redact_report(text, ['access-secret-value'], home='/srv/people/morgan', user='morgan')
        for leaked in ('Jane Doe', 'jdoe', 'alex', 'kim', 'morgan', 'example.co.uk', 'a+b@', 'abc.def', 'access-secret-value'):
            self.assertNotIn(leaked, result)
        self.assertIn('C:\\Users\\[user]\\Documents\\bracket.step', result)
        self.assertIn('/home/[user]/projects/x.py', result)
        self.assertIn('[home]/file', result)
        self.assertIn('[email]', result)
        self.assertEqual(redact_report(result, home='/srv/people/morgan', user='morgan'), result)  # Idempotent.

    def test_resolved_home_and_hyphenated_api_keys_are_removed(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            resolved = base / 'data' / 'disk' / 'u-9f3a'
            resolved.mkdir(parents=True)
            home = base / 'homes' / 'alex'
            home.parent.mkdir()
            home.symlink_to(resolved, target_is_directory=True)
            text = (f'open {resolved}/bracket.step\n'
                    'api-key: supersecretvalue\nX-API-Key: othersecretvalue\n')
            result = redact_report(text, home=str(home), user='alex')
            self.assertNotIn('u-9f3a', result)
            self.assertNotIn('supersecretvalue', result)
            self.assertNotIn('othersecretvalue', result)
            self.assertIn('[home]/bracket.step', result)
            self.assertIn('api-key: [redacted]', result)
            self.assertEqual(redact_report(result, home=str(home), user='alex'), result)

    def test_log_is_capped_to_its_most_recent_whole_lines(self):
        log = '\n'.join(f'line {n}' for n in range(1000))
        kept, truncated = tail_bytes(log, 100)
        self.assertTrue(truncated)
        self.assertLessEqual(len(kept.encode()), 100)
        self.assertTrue(kept.endswith('line 999'))
        self.assertTrue(kept.startswith('line '))
        self.assertEqual(tail_bytes('short', 100), ('short', False))


class FeedbackForwardingTests(unittest.TestCase):
    def setUp(self):
        self.profile = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.enterContext(patch('steve_desktop.local_feedback.update_platform', return_value='linux-x64'))
        self.requests = []
        self.reports = {}
        self.respond = None
        self.connection = StudioConnection(self.profile, transport=httpx.MockTransport(self.handle))
        self.addCleanup(self.connection.close)
        self.sign_in('designs:read profile feedback:write')
        worker = ThreadPoolExecutor(max_workers=1)
        self.addCleanup(worker.shutdown)
        app = FastAPI()
        self.feedback = LocalFeedback(SimpleNamespace(folder=self.profile / 'cad', app=app),
                                      SimpleNamespace(connection=self.connection, worker=worker))
        self.http = TestClient(app)

    def sign_in(self, scope):
        self.connection.session = {'origin': ORIGIN, 'server': 'server-one', 'account': 'account-one', 'client_id': DESKTOP['client_id'],
                                   'access_token': 'access-secret', 'refresh_token': 'refresh-secret', 'scope': scope,
                                   'expires_at': time.time() + 3600}

    def handle(self, request):
        path = request.url.path
        if path == '/api/v1/capabilities':
            return httpx.Response(200, json=CAPS)
        self.requests.append(request)
        self.assertEqual(request.headers['authorization'], 'Bearer access-secret')
        if self.respond:
            answer = self.respond(request)
            if answer is not None:
                return answer
        if path == '/api/v1/desktop-feedback/config':
            return httpx.Response(200, json={'enabled': True, 'max_log_bytes': 262144, 'max_screenshot_bytes': 2097152,
                                             'retention_days': 30, 'sends': ['what you write']})
        if path == '/api/v1/desktop-feedback/reports' and request.method == 'POST':
            body = json.loads(request.content)
            known = body['client_report_id'] in self.reports
            identifier = self.reports.setdefault(body['client_report_id'], str(uuid.uuid4()))
            return httpx.Response(200 if known else 201, json={'id': identifier, 'status': 'received'})
        if path == '/api/v1/desktop-feedback/reports':
            return httpx.Response(200, json={'reports': [
                {'id': 'r1', 'kind': 'bug', 'title': 'Fillet fails', 'status': 'fixed', 'reply': 'Fixed in 0.3.9',
                 'public_issue_url': 'https://github.com/stevecad/steve/issues/42', 'fixed_in': '0.3.9',
                 'created_at': '2026-10-01T00:00:00Z', 'updated_at': '2026-10-05T00:00:00Z'},
                {'id': 'r2', 'kind': 'feature', 'title': 'Idea', 'status': 'in_progress', 'reply': None,
                 'public_issue_url': 'https://evil.test/issues/1', 'fixed_in': None,
                 'created_at': '2026-10-02T00:00:00Z', 'updated_at': '2026-10-02T00:00:00Z'}]})
        return httpx.Response(404, json={'error': {'code': 'not_found'}})

    def report(self, **change):
        body = {'client_report_id': str(uuid.uuid4()), 'kind': 'bug', 'what': ' The fillet failed ', 'expected': 'A rounded edge',
                'log': None, 'screenshot': None}
        body.update(change)
        return body

    def test_config_preview_and_report_forward_exactly_the_disclosed_fields(self):
        try:
            raise ValueError(f'Could not open {Path.home()}/designs/secret-bracket.step for alex@example.test (token=access-secret)')
        except ValueError as exc:
            Diagnostics(self.profile).record(exc, 'Open document')
        config = self.http.get('/v1/feedback/config').json()
        self.assertTrue(config['enabled'])
        self.assertEqual(config['platform'], 'linux-x64')
        self.assertEqual(config['sends'], ['what you write'])
        # The page polls config for the app version: Studio is asked at most every few minutes.
        self.http.get('/v1/feedback/config')
        self.assertEqual([r.url.path for r in self.requests], ['/api/v1/desktop-feedback/config'])
        preview = self.http.get('/v1/feedback/preview').json()
        self.assertIn('Open document', preview['log'])
        for leaked in (str(Path.home()), 'alex@example.test', 'access-secret'):
            self.assertNotIn(leaked, preview['log'])
        screenshot = 'data:image/png;base64,' + base64.b64encode(PNG).decode()
        body = self.report(log=preview['log'], screenshot=screenshot)
        sent = self.http.post('/v1/feedback/bug', json=body)
        self.assertEqual(sent.status_code, 200, sent.text)
        self.assertEqual(sent.json()['id'], self.reports[body['client_report_id']])
        forwarded = json.loads(self.requests[-1].content)
        self.assertEqual(self.requests[-1].url.path, '/api/v1/desktop-feedback/reports')
        self.assertEqual(set(forwarded), {'client_report_id', 'kind', 'what', 'expected', 'app_version', 'platform', 'os', 'log', 'screenshot'})
        self.assertEqual(forwarded['what'], 'The fillet failed')
        self.assertEqual(forwarded['log'], preview['log'])
        self.assertEqual(base64.b64decode(forwarded['screenshot']), PNG)
        self.assertNotIn('refresh-secret', self.requests[-1].content.decode())
        self.assertNotIn('access-secret', self.requests[-1].content.decode())
        # Leaving the log out and attaching nothing sends only the text and app details.
        self.http.post('/v1/feedback/bug', json=self.report(expected=''))
        self.assertEqual(set(json.loads(self.requests[-1].content)), {'client_report_id', 'kind', 'what', 'app_version', 'platform', 'os'})

    def test_invalid_reports_never_reach_studio(self):
        for change in ({'client_report_id': 'not-a-uuid'}, {'kind': 'question'}, {'what': '  '}, {'what': 'x' * 8001},
                       {'expected': 'x' * 4001}, {'document': 'contents'}, {'screenshot': 'data:image/gif;base64,R0lGOD'},
                       {'screenshot': base64.b64encode(b'not an image').decode()}):
            with self.subTest(change=list(change)):
                self.assertGreaterEqual(self.http.post('/v1/feedback/bug', json=self.report(**change)).status_code, 400)
        self.assertEqual(self.requests, [])

    def test_my_reports_map_status_reply_issue_and_seen(self):
        reports = self.http.get('/v1/feedback/reports').json()['reports']
        self.assertEqual([r['id'] for r in reports], ['r1', 'r2'])
        self.assertEqual(reports[0]['issue'], 42)
        self.assertTrue(reports[0]['unseen'])
        self.assertEqual(reports[0]['fixed_in'], '0.3.9')
        self.assertIsNone(reports[1]['url'])  # Only stevecad/steve issues are linked.
        self.assertFalse(reports[1]['unseen'])
        self.http.post('/v1/feedback/reports/seen')
        self.assertFalse(self.http.get('/v1/feedback/reports').json()['reports'][0]['unseen'])

    def test_not_signed_in_reports_why_and_sends_nothing(self):
        self.connection.session = {}
        config = self.http.get('/v1/feedback/config').json()
        self.assertFalse(config['enabled'])
        self.assertEqual(config['reason'], 'sign_in_required')
        self.assertIn('Sign in to STEVE', config['message'])
        response = self.http.post('/v1/feedback/bug', json=self.report())
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()['detail']['code'], 'sign_in_required')
        self.assertEqual(self.http.get('/v1/feedback/reports').status_code, 401)
        self.assertEqual(self.requests, [])

    def test_missing_feedback_scope_asks_to_sign_in_again(self):
        connection = self.connection
        connection.capabilities = copy.deepcopy(CAPS)
        self.assertEqual(connection.login_scope(DESKTOP['client_id']), 'designs:read profile feedback:write')
        self.sign_in('designs:read profile')
        config = self.http.get('/v1/feedback/config').json()
        self.assertEqual((config['enabled'], config['reason']), (False, 'consent_required'))
        self.assertIn('Sign in to STEVE again', config['message'])
        response = self.http.post('/v1/feedback/bug', json=self.report())
        self.assertEqual((response.status_code, response.json()['detail']['code']), (403, 'consent_required'))
        self.assertEqual(self.requests, [])
        # Studio revoked the permission although the stored grant still lists it.
        self.sign_in('designs:read profile feedback:write')
        self.respond = lambda request: httpx.Response(403, json={'error': {'code': 'insufficient_scope', 'message': 'Missing scope'}})
        response = self.http.post('/v1/feedback/bug', json=self.report())
        self.assertEqual((response.status_code, response.json()['detail']['code']), (403, 'consent_required'))
        # A Studio that does not offer the permission is not asked for it.
        connection.capabilities['oauth']['desktop_client']['scopes'] = ['designs:read', 'profile']
        self.assertEqual(connection.login_scope(DESKTOP['client_id']), 'designs:read profile')
        self.assertEqual(self.http.get('/v1/feedback/config').json()['reason'], 'not_offered')

    def test_retries_reuse_the_client_report_id_and_never_duplicate(self):
        failures = [1]
        def flaky(request):
            if request.method == 'POST' and failures:
                failures.pop()
                raise httpx.ConnectError('connection reset')
        self.respond = flaky
        body = self.report()
        first = self.http.post('/v1/feedback/bug', json=body)
        self.assertEqual(first.status_code, 200, first.text)
        posted = [json.loads(r.content)['client_report_id'] for r in self.requests if r.method == 'POST']
        self.assertEqual(posted, [body['client_report_id']] * 2)
        # The dialog sends the same report again (e.g. after a timeout): Studio answers with the same report.
        again = self.http.post('/v1/feedback/bug', json=body)
        self.assertEqual(again.json()['id'], first.json()['id'])
        self.assertEqual(len(self.reports), 1)
        # Offline: a clear, retryable error.
        self.respond = lambda request: (_ for _ in ()).throw(httpx.ConnectError('offline'))
        offline = self.http.post('/v1/feedback/bug', json=self.report())
        self.assertEqual((offline.status_code, offline.json()['detail']['code']), (503, 'unavailable'))


if __name__ == '__main__':
    unittest.main()

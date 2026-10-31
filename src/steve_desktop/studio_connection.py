"""Studio's public-client OAuth and read-only project-sync transport.

This connection never uses the browser's credentials or the assistant's MCP session.
All requests are serialized by the owning LocalStudio operation worker, including
refresh-token rotation. Credentials are saved before another request is attempted.
"""
import base64
import hashlib
import re
import secrets
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

import httpx

from steve_desktop.vault import Vault

ORIGIN = 'https://stevecad.studio'
SCOPE = 'designs:read'
FEEDBACK_SCOPE = 'feedback:write'


class StudioError(ValueError):
    def __init__(self, message, code='studio_error', status=0):
        super().__init__(message)
        self.code, self.status = code, status


def checked_response(response):
    if response.is_success or response.status_code == 304:
        return response
    try:
        body = response.json()
        detail = body.get('error', body.get('detail', body))
        if not isinstance(detail, dict):
            detail = {'code': str(detail)}
        code = detail.get('code', 'request_failed')
        message = detail.get('message') or body.get('error_description') or code
        if code in ('invalid_token', 'invalid_grant'):
            message = 'Your Studio session ended. Connect to Steve Studio again.'
        elif code == 'invalid_client':
            message = 'Studio has disabled or does not recognize Steve desktop. Contact your Studio administrator; local CAD remains available.'
        unresolved = detail.get('unresolved', [])
        if unresolved:
            message += '\n' + '\n'.join(str(x.get('message') or x.get('reason')) for x in unresolved[:20])
    except (ValueError, AttributeError, TypeError):
        code, message = 'request_failed', 'Studio could not complete the request.'
    # Do not include URLs, request bodies, bearer tokens or token endpoint responses.
    raise StudioError(f'{message} (HTTP {response.status_code})', str(code), response.status_code)


class StudioConnection:
    def __init__(self, profile, *, origin=ORIGIN, client_id=None, transport=None):
        self.origin = origin.rstrip('/')
        self.vault = Vault(profile / 'studio-session.dpapi')
        self.storage_error = ''
        try:
            self.session = self.vault.load()
            if not isinstance(self.session, dict):
                raise ValueError('Invalid session storage')
        except Exception:
            # An optional cloud connection must not prevent local CAD from opening.
            self.session = {}
            self.storage_error = 'Could not read the encrypted Studio session. Connect again to restore access; local CAD is unaffected.'
        self.http = httpx.Client(timeout=httpx.Timeout(120, connect=20), follow_redirects=False, transport=transport)
        self.client_id = client_id
        self.capabilities = None
        self.cancel = threading.Event()

    def url(self, path):
        url = urljoin(self.origin + '/', path)
        parsed = urlsplit(url)
        if (parsed.scheme, parsed.netloc) != (urlsplit(self.origin).scheme, urlsplit(self.origin).netloc) or parsed.username or parsed.password or parsed.fragment:
            raise StudioError('Studio returned an unsafe endpoint address.')
        return url

    def discover(self):
        result = checked_response(self.http.get(self.url('/api/v1/capabilities'))).json()
        if result.get('api') != 'steve' or result.get('sync_version') != 1 or not {'projects', 'workspaces', 'project_snapshots'} <= set(result.get('features', [])):
            raise StudioError('This Studio server does not support the required project-sync version.')
        if not result.get('server', {}).get('id'):
            raise StudioError('Studio did not provide its server identity.')
        if 'S256' not in result.get('oauth', {}).get('code_challenge_methods', []):
            raise StudioError('Studio does not support secure desktop sign-in.')
        for key in ('authorization_endpoint', 'token_endpoint', 'revocation_endpoint'):
            self.url(result['oauth'][key])
        if self.session and (self.session.get('server') != result['server']['id'] or self.session.get('origin') != self.origin):
            raise StudioError('Studio server identity changed. Disconnect and sign in again.')
        self.capabilities = result
        return result

    def publisher_client(self):
        if self.client_id:
            return self.client_id
        if self.capabilities is None:
            self.discover()
        config = self.capabilities['oauth'].get('desktop_client')
        if not isinstance(config, dict):
            raise StudioError('This Studio server has not enabled desktop sign-in yet. No manual account setup is required.', 'publisher_not_configured')
        identifier = config.get('client_id')
        if (not isinstance(identifier, str) or not re.fullmatch(r'app_[a-z0-9]{16}', identifier)
            or config.get('public') is not True
            or config.get('redirect_uri') != 'http://127.0.0.1/callback'
            or config.get('redirect_ports') != 'any'
            or not isinstance(config.get('scopes'), list) or SCOPE not in config['scopes']):
            raise StudioError('Studio advertised an unsupported desktop sign-in configuration.', 'unsupported_desktop_client')
        return identifier

    def login_scope(self, client):
        oauth = (self.capabilities or {}).get('oauth', {})
        desktop = oauth.get('desktop_client')
        desktop = desktop if isinstance(desktop, dict) else {}
        # Ask only for the published display-profile permission, and only for
        # the publisher client whose advertised permissions include it.
        profile = (oauth.get('profile_scope') == 'profile'
                   and client == desktop.get('client_id')
                   and isinstance(desktop.get('scopes'), list)
                   and 'profile' in desktop['scopes'])
        # Bug reports and feature requests (desktop feedback) need their own grant.
        feedback = (client == desktop.get('client_id') and isinstance(desktop.get('scopes'), list)
                    and FEEDBACK_SCOPE in desktop['scopes'])
        return SCOPE + (' profile' if profile else '') + (' ' + FEEDBACK_SCOPE if feedback else '')

    def has_scope(self, scope):
        return bool(self.session.get('refresh_token')) and scope in self.session.get('scope', SCOPE).split()

    def feedback_offered(self):
        """Whether this Studio lets the desktop client ask for the feedback permission."""
        desktop = ((self.capabilities or {}).get('oauth') or {}).get('desktop_client')
        return isinstance(desktop, dict) and isinstance(desktop.get('scopes'), list) and FEEDBACK_SCOPE in desktop['scopes']

    def profile_consent_required(self):
        requested = self.login_scope(self.session.get('client_id'))
        return bool(self.session.get('refresh_token') and 'profile' in requested.split()
                    and 'profile' not in self.session.get('scope', SCOPE).split())

    def save_tokens(self, value, client_id=None, requested_scope=None):
        if not isinstance(value.get('access_token'), str) or not isinstance(value.get('refresh_token'), str):
            raise StudioError('Studio returned an invalid sign-in response.')
        scope = value.get('scope', requested_scope or self.session.get('scope', SCOPE))
        if (value.get('token_type', 'Bearer').lower() != 'bearer'
                or not isinstance(scope, str) or SCOPE not in scope.split()):
            raise StudioError('Studio did not grant project read access.')
        self.session = {**self.session, 'origin': self.origin, 'server': self.capabilities['server']['id'],
                        'client_id': client_id or self.publisher_client(), 'access_token': value['access_token'],
                        'refresh_token': value['refresh_token'], 'scope': ' '.join(scope.split()), 'expires_at': time.time() + int(value.get('expires_in', 900))}
        if 'profile' not in scope.split():
            self.session.pop('account_profile', None)
        self.vault.save(self.session)

    def login(self, notify=lambda text: None, open_browser=webbrowser.open):
        self.discover()
        client = self.publisher_client()
        scope = self.login_scope(client)
        verifier, state = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        answer = {}
        class Callback(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(handler):
                parsed = urlsplit(handler.path)
                query = parse_qs(parsed.query)
                valid = parsed.path == '/callback' and query.get('state') == [state] and not answer
                if valid and (len(query.get('code', [])) == 1 or query.get('error')):
                    answer.update(query)
                handler.send_response(200 if valid else 400)
                handler.send_header('Content-Type', 'text/plain; charset=utf-8')
                handler.send_header('Cache-Control', 'no-store')
                handler.end_headers()
                handler.wfile.write(b'Return to Steve to finish connecting.' if valid else b'Invalid sign-in callback.')

        with ThreadingHTTPServer(('127.0.0.1', 0), Callback) as listener:
            listener.timeout = .25
            redirect = f'http://127.0.0.1:{listener.server_port}/callback'
            url = self.url(self.capabilities['oauth']['authorization_endpoint']) + '?' + urlencode({
                'response_type': 'code', 'client_id': client, 'redirect_uri': redirect, 'scope': scope,
                'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
            notify('Finish signing in to Studio in your browser.')
            if not open_browser(url):
                raise StudioError('Could not open the sign-in browser.')
            deadline = time.monotonic() + 300
            while not answer and not self.cancel.is_set() and time.monotonic() < deadline:
                listener.handle_request()
        if self.cancel.is_set():
            raise StudioError('Sign-in cancelled.')
        if not answer or answer.get('error') or not answer.get('code'):
            raise StudioError('Studio sign-in was cancelled or timed out.')
        response = self.http.post(self.url(self.capabilities['oauth']['token_endpoint']), data={
            'grant_type': 'authorization_code', 'client_id': client, 'redirect_uri': redirect,
            'code': answer['code'][0], 'code_verifier': verifier})
        tokens = checked_response(response).json()
        self.session.pop('account', None)
        self.session.pop('account_profile', None)
        self.save_tokens(tokens, client, requested_scope=scope)
        return self.workspaces()

    def refresh(self):
        if not self.session.get('refresh_token'):
            raise StudioError('Connect to Steve Studio to continue.', 'sign_in_required')
        # Persist consumption before sending: an ambiguous network failure must not
        # replay a rotating refresh token and revoke the whole sign-in.
        token = self.session.pop('refresh_token')
        self.vault.save(self.session)
        response = self.http.post(self.url(self.capabilities['oauth']['token_endpoint']), data={
            'grant_type': 'refresh_token', 'client_id': self.session['client_id'], 'refresh_token': token})
        self.save_tokens(checked_response(response).json(), self.session['client_id'])

    def request(self, path, *, workspace=None, headers=None, params=None, stream=False, method='GET', json=None):
        if self.capabilities is None:
            self.discover()
        if not self.session.get('access_token'):
            raise StudioError('Connect to Steve Studio to continue.', 'sign_in_required')
        if time.time() >= self.session.get('expires_at', 0) - 30:
            self.refresh()
        extra = dict(headers or {})
        if workspace:
            extra['X-Steve-Workspace'] = workspace
        for attempt in range(2):
            # A 401 means the request was not processed, so a single retry after the
            # token refresh is safe for writes too (they also carry idempotency keys).
            request = self.http.build_request(method, self.url(path), params=params, json=json,
                headers={**extra, 'Authorization': 'Bearer ' + self.session['access_token']})
            response = self.http.send(request, stream=stream)
            if response.status_code != 401 or attempt:
                if stream and not response.is_success:
                    response.read()
                    response.close()
                return checked_response(response)
            response.close()
            self.refresh()

    def workspaces(self):
        result = self.request('/api/v1/workspaces').json()
        if not isinstance(result.get('account'), str) or not isinstance(result.get('workspaces'), list):
            raise StudioError('Studio did not return an account identity.')
        self.session['account'] = result['account']
        # Optional display metadata; never treat the OAuth application's name as the person.
        profile = result.get('account_profile')
        profile = profile if isinstance(profile, dict) else {}
        self.session['account_profile'] = {key: profile[key].strip() for key in ('name', 'email', 'avatar_url')
                                           if isinstance(profile.get(key), str) and profile[key].strip()}
        avatar = self.session['account_profile'].get('avatar_url', '')
        try:
            parsed = urlsplit(avatar)
        except ValueError:
            parsed = urlsplit('')
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            self.session['account_profile'].pop('avatar_url', None)
        self.vault.save(self.session)
        return result

    def disconnect(self):
        session = self.session
        self.session = {}
        self.vault.save({})
        token = session.get('refresh_token') or session.get('access_token')
        if token:
            # Revocation is best-effort; local credentials are always removed.
            try:
                checked_response(self.http.post(self.url('/oauth/revoke'), data={
                    'token': token, 'client_id': session['client_id']}))
            except (httpx.HTTPError, StudioError):
                return 'Disconnected locally. Studio could not confirm revocation; revoke Steve in Connected apps if needed.'
        return 'Disconnected. Your local projects remain available.'

    def close(self):
        self.cancel.set()
        self.http.close()

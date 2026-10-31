"""Bug reports and feature requests, sent to STEVE Studio with the person's own sign-in.

Reports are stored only by Studio (/api/v1/desktop-feedback/*). A report carries what
the person wrote, the app version and OS, the app's local log after redaction (the
dialog shows it first; the person may leave it out) and a screenshot only when they
attach one. Never tokens, document contents or file paths outside the redacted log.
All Studio requests run on the serialized Studio worker, like project sync.
"""
import base64
import binascii
import json
import platform
import re
import threading
import time
import uuid
from concurrent.futures import TimeoutError as FutureTimeout

import httpx
from fastapi import HTTPException

from steve_desktop.diagnostics import local_log, redact_report, tail_bytes
from steve_desktop.local_updates import VERSION, update_platform
from steve_desktop.studio_connection import FEEDBACK_SCOPE, StudioError

API = '/api/v1/desktop-feedback'
LIMITS = {'max_log_bytes': 262144, 'max_screenshot_bytes': 2097152, 'retention_days': 30}
SENDS = ['what you write', 'app version and OS',
         'the app\'s local log (paths with your username, emails and tokens removed)', 'a screenshot, if you tick it']
RESOLVED = ('fixed', 'declined', 'duplicate')
STATUSES = ('received', 'in_progress', *RESOLVED)
ISSUE = re.compile(r'https://github\.com/stevecad/steve/issues/(\d+)')
MESSAGES = {
    'sign_in_required': 'Sign in to STEVE to report a bug or request a feature.',
    'consent_required': 'Sign in to STEVE again and allow Steve desktop to send reports.',
    'not_offered': 'STEVE Studio doesn’t accept reports from Steve desktop yet.',
    'unsupported_platform': 'Reports can be sent from Steve for Windows x64 and Linux x64.',
    'unavailable': 'Couldn’t reach STEVE. Check your connection and try again.',
    'busy': 'STEVE is busy with another Studio operation. Try again in a moment.',
}


def operating_system():
    return platform.platform(terse=False)[:200]


def problem(status, code, message=None):
    return HTTPException(status, {'code': code, 'message': message or MESSAGES[code]})


def screenshot_bytes(value, limit):
    """Plain base64 of a PNG/JPEG (the dialog sends a data URL)."""
    if value.startswith('data:'):
        header, _, value = value.partition(',')
        if header not in ('data:image/png;base64', 'data:image/jpeg;base64'):
            raise problem(422, 'invalid_screenshot', 'Attach a PNG or JPEG screenshot.')
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise problem(422, 'invalid_screenshot', 'The screenshot could not be read.') from None
    if not (data.startswith(b'\x89PNG\r\n\x1a\n') or data.startswith(b'\xff\xd8\xff')):
        raise problem(422, 'invalid_screenshot', 'Attach a PNG or JPEG screenshot.')
    if len(data) > limit:
        raise problem(413, 'screenshot_too_large', 'The screenshot is too large to send. Attach a smaller one.')
    return base64.b64encode(data).decode('ascii')


class LocalFeedback:
    def __init__(self, server, studio):
        self.server = server
        self.studio = studio
        self.connection = studio.connection
        self.profile = server.folder.parent
        self.limits = dict(LIMITS)
        self.sends = list(SENDS)
        self.seen_path = self.profile / 'feedback-seen.json'
        self.lock = threading.Lock()
        self.latest = []
        self.cached = None  # (session key, time, config): the page polls config for the app version.
        app = server.app

        @app.get('/v1/feedback/config')
        def config():
            return self.config()

        @app.get('/v1/feedback/preview')
        def preview():
            return self.preview()

        @app.post('/v1/feedback/bug')
        def send(body: dict):
            return self.send(body)

        @app.get('/v1/feedback/reports')
        def reports():
            return {'reports': self.reports()}

        @app.post('/v1/feedback/reports/seen')
        def seen():
            self.mark_seen()
            return None

    # Studio calls -------------------------------------------------------------
    def on_worker(self, call, timeout=150):
        """Run on the Studio worker so token refreshes never race with project sync."""
        future = self.studio.worker.submit(call)
        try:
            return future.result(timeout)
        except FutureTimeout:
            future.cancel()
            raise problem(503, 'busy') from None

    def account_state(self):
        """'ready', or why reports can't be sent yet. Runs on the Studio worker."""
        if update_platform() is None:
            return 'unsupported_platform'
        if not self.connection.session.get('refresh_token'):
            return 'sign_in_required'
        if self.connection.capabilities is None:
            self.connection.discover()
        if not self.connection.feedback_offered():
            return 'not_offered'
        if not self.connection.has_scope(FEEDBACK_SCOPE):
            return 'consent_required'
        return 'ready'

    def studio_call(self, method, path, body=None):
        def call():
            state = self.account_state()
            if state != 'ready':
                raise problem(401 if state == 'sign_in_required' else 403, state)
            for attempt in range(2):
                try:
                    return self.connection.request(API + path, method=method, json=body).json()
                except httpx.TransportError:
                    # The same client_report_id makes a resend safe if the first one arrived.
                    if attempt:
                        raise
        try:
            return self.on_worker(call)
        except HTTPException:
            raise
        except StudioError as exc:
            self.cached = None
            if exc.code in ('sign_in_required', 'invalid_token', 'invalid_grant') or exc.status == 401:
                raise problem(401, 'sign_in_required') from None
            if exc.status == 403 and ('scope' in exc.code or not self.connection.has_scope(FEEDBACK_SCOPE)):
                raise problem(403, 'consent_required') from None
            raise problem(exc.status if 400 <= exc.status < 600 else 502, exc.code or 'studio_error', str(exc)) from None
        except httpx.HTTPError:
            raise problem(503, 'unavailable') from None
        except ValueError:
            raise problem(502, 'studio_error', 'STEVE returned an answer Steve couldn’t read. Try again later.') from None

    # Routes -------------------------------------------------------------------
    def describe(self):
        return {'version': VERSION, 'platform': update_platform(), 'os': operating_system(), **self.limits, 'sends': self.sends}

    def config(self):
        session = self.connection.session
        key = (session.get('account'), session.get('scope'), bool(session.get('refresh_token')))
        cached = self.cached
        if cached and cached[0] == key and time.monotonic() - cached[1] < 300:
            return {**cached[2], **self.describe()}
        result = self.fresh_config()
        if result['enabled'] or result['reason'] in ('sign_in_required', 'consent_required', 'not_offered', 'disabled'):
            self.cached = (key, time.monotonic(), result)
        return result

    def fresh_config(self):
        if update_platform() is None:
            state = 'unsupported_platform'
        elif not self.connection.session.get('refresh_token'):
            state = 'sign_in_required'  # Known without asking Studio.
        else:
            try:
                state = self.on_worker(self.account_state, timeout=60)
            except HTTPException as exc:
                return {**self.describe(), 'enabled': False, 'reason': exc.detail['code'], 'message': exc.detail['message']}
            except (StudioError, httpx.HTTPError, ValueError):
                state = 'unavailable'
        if state != 'ready':
            return {**self.describe(), 'enabled': False, 'reason': state, 'message': MESSAGES[state]}
        try:
            remote = self.studio_call('GET', '/config')
        except HTTPException as exc:
            return {**self.describe(), 'enabled': False, 'reason': exc.detail['code'], 'message': exc.detail['message']}
        for key in LIMITS:
            if isinstance(remote.get(key), int) and remote[key] > 0:
                self.limits[key] = min(remote[key], LIMITS[key] * 4)
        if isinstance(remote.get('sends'), list) and all(isinstance(x, str) for x in remote['sends']):
            self.sends = remote['sends'][:10]
        enabled = remote.get('enabled') is True
        return {**self.describe(), 'enabled': enabled, 'reason': None if enabled else 'disabled',
                'message': '' if enabled else 'Reporting is turned off in STEVE right now.'}

    def redacted_log(self):
        secrets = [self.connection.session.get(key) for key in ('access_token', 'refresh_token')]
        return redact_report(local_log(self.profile), secrets)

    def preview(self):
        """Exactly what is attached besides the person's text (the dialog shows it)."""
        log, truncated = tail_bytes(self.redacted_log(), self.limits['max_log_bytes'])
        return {'app_version': VERSION, 'platform': update_platform(), 'os': operating_system(), 'log': log,
                'log_truncated': truncated, 'max_log_bytes': self.limits['max_log_bytes'],
                'max_screenshot_bytes': self.limits['max_screenshot_bytes'], 'sends': self.sends}

    def send(self, body):
        if not isinstance(body, dict) or set(body) - {'client_report_id', 'kind', 'what', 'expected', 'log', 'screenshot'}:
            raise problem(422, 'invalid_report', 'The report has unexpected fields.')
        try:
            report_id = str(uuid.UUID(str(body.get('client_report_id'))))
        except ValueError:
            raise problem(422, 'invalid_report', 'The report needs an identifier.') from None
        kind, what, expected = body.get('kind'), body.get('what'), body.get('expected') or ''
        if kind not in ('bug', 'feature'):
            raise problem(422, 'invalid_report', 'Choose a bug report or a feature request.')
        if not isinstance(what, str) or not what.strip() or len(what.strip()) > 8000:
            raise problem(422, 'invalid_report', 'Describe it in 1 to 8,000 characters.')
        if not isinstance(expected, str) or len(expected.strip()) > 4000:
            raise problem(422, 'invalid_report', 'Keep the second answer under 4,000 characters.')
        target = update_platform()
        if target is None:
            raise problem(403, 'unsupported_platform')
        payload = {'client_report_id': report_id, 'kind': kind, 'what': what.strip(), 'app_version': VERSION,
                   'platform': target, 'os': operating_system()}
        if expected.strip():
            payload['expected'] = expected.strip()
        log = body.get('log')
        if log is not None:
            if not isinstance(log, str):
                raise problem(422, 'invalid_report', 'The log could not be read.')
            # The dialog sends the log it showed; redact and cap again so nothing else leaves.
            secrets = [self.connection.session.get(key) for key in ('access_token', 'refresh_token')]
            log, _ = tail_bytes(redact_report(log, secrets), self.limits['max_log_bytes'])
            if log.strip():
                payload['log'] = log
        screenshot = body.get('screenshot')
        if screenshot is not None:
            if not isinstance(screenshot, str):
                raise problem(422, 'invalid_screenshot', 'The screenshot could not be read.')
            payload['screenshot'] = screenshot_bytes(screenshot, self.limits['max_screenshot_bytes'])
        result = self.studio_call('POST', '/reports', payload)
        if not isinstance(result.get('id'), str):
            raise problem(502, 'studio_error', 'STEVE didn’t confirm the report. Send it again; it won’t be duplicated.')
        return {'id': result['id'], 'status': result.get('status', 'received'), 'client_report_id': report_id,
                'issue': None, 'url': None}

    # "My reports" ---------------------------------------------------------------
    def account_key(self):
        session = self.connection.session
        return json.dumps([session.get('server'), session.get('account')])

    def load_seen(self):
        try:
            value = json.loads(self.seen_path.read_text(encoding='utf-8'))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def reports(self):
        result = self.studio_call('GET', '/reports')
        rows = result.get('reports') if isinstance(result, dict) else None
        if not isinstance(rows, list):
            raise problem(502, 'studio_error', 'STEVE returned an unreadable list of reports.')
        seen = self.load_seen().get(self.account_key(), {})
        reports = []
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get('id'), str):
                continue
            status = row.get('status') if row.get('status') in STATUSES else 'received'
            url = row.get('public_issue_url') if isinstance(row.get('public_issue_url'), str) else None
            match = ISSUE.fullmatch(url or '')
            reports.append({
                'id': row['id'], 'kind': 'feature' if row.get('kind') == 'feature' else 'bug',
                'title': str(row.get('title') or 'Report'), 'status': status,
                'reply': row.get('reply') if isinstance(row.get('reply'), str) else None,
                'fixed_in': row.get('fixed_in') if isinstance(row.get('fixed_in'), str) else None,
                'created_at': row.get('created_at'), 'updated_at': row.get('updated_at'),
                'resolved_at': row.get('updated_at') if status in RESOLVED else None,
                'issue': int(match.group(1)) if match else None, 'url': url if match else None,
                'unseen': status in RESOLVED and seen.get(row['id']) != status})
        with self.lock:
            self.latest = [(r['id'], r['status']) for r in reports]
        return reports

    def mark_seen(self):
        with self.lock:
            latest = list(self.latest)
        stored = self.load_seen()
        account = stored.setdefault(self.account_key(), {})
        account.update({identifier: status for identifier, status in latest if status in RESOLVED})
        temporary = self.seen_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(stored), encoding='utf-8')
        temporary.replace(self.seen_path)

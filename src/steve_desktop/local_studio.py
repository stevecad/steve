"""Optional Studio project downloads. All CAD execution remains local."""
import base64
import copy
import hashlib
import io
import json
import re
import threading
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from steve_desktop.cad_archive import MAX_ARCHIVE, read_archive, restore_archive
from steve_desktop.studio_connection import StudioConnection, StudioError


class LocalStudio:
    def __init__(self, server, connection=None):
        self.server = server
        self.connection = connection or StudioConnection(server.folder.parent)
        self.lock = threading.RLock()
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix='studio-sync')
        self.future = None
        self.message = 'Connect to download your Studio projects.'
        self.error = self.connection.storage_error
        self.workspaces = []
        self.projects = []
        self.workspace = ''
        self.closed = threading.Event()
        self.downloads = server.folder.parent / 'studio-downloads'
        self.downloads.mkdir(exist_ok=True)
        @server.app.get('/v1/local/studio')
        def status():
            return self.status()

        @server.app.post('/v1/local/studio/{action}')
        def action(action: str, body: dict):
            if action == 'unlink':
                with self.lock, server.lock:
                    if self.future and not self.future.done():
                        raise HTTPException(409, 'Wait for the current Studio operation to finish.')
                    if not isinstance(body.get('workspace'), str) or not isinstance(body.get('project'), str):
                        raise HTTPException(422, 'Choose a downloaded project.')
                    server.state.get('studio_sync', {}).pop(self.key(body['workspace'], body['project']), None)
                    server.save()
                    self.message = 'Stopped syncing this project. All local copies remain available.'
                return self.status()
            if action == 'automatic':
                if type(body.get('enabled')) is not bool:
                    raise HTTPException(422, 'Provide an automatic refresh preference.')
                with server.lock:
                    server.state.setdefault('settings', {})['studio.automatic'] = body['enabled']
                    server.save()
                return self.status()
            if action == 'cancel':
                self.connection.cancel.set()
                return self.status()
            if action not in ('connect', 'disconnect', 'list', 'download', 'refresh'):
                raise HTTPException(404, 'Unknown Studio action')
            with self.lock:
                if self.future and not self.future.done():
                    raise HTTPException(409, 'A Studio operation is still running.')
                self.connection.cancel.clear()
                self.error = ''
                self.message = 'Connecting…' if action == 'connect' else 'Working…'
                self.future = self.worker.submit(self.run, action, copy.deepcopy(body))
            return self.status()

        self.timer = threading.Thread(target=self.automatic_refresh, name='studio-refresh', daemon=True)
        self.timer.start()

    def automatic_refresh(self):
        # Never opens a sign-in browser. Failures leave all local projects available.
        while not self.closed.wait(300):
            with self.lock, self.server.lock:
                session = self.connection.session
                if not session.get('refresh_token') or not self.server.state.get('settings', {}).get('studio.automatic', True):
                    continue
                if self.future and not self.future.done():
                    continue
                groups = list(dict.fromkeys(v['identity'][2] for v in self.server.state.get('studio_sync', {}).values()
                    if v['identity'][:2] == [session.get('server'), session.get('account')]))
                if groups:
                    self.connection.cancel.clear()
                    self.future = self.worker.submit(self.refresh_groups, groups)

    def refresh_groups(self, groups):
        failures = []
        for workspace in groups:
            if self.closed.is_set() or self.connection.cancel.is_set():
                return
            self.run('refresh', {'workspace': workspace})
            if self.error:
                failures.append(self.error)
        if failures:
            with self.lock:
                self.error = '\n'.join(failures)

    def notify(self, text):
        with self.lock:
            self.message = text

    def identity(self, workspace):
        session = self.connection.session
        if not all(session.get(key) for key in ('server', 'account')):
            raise StudioError('Connect to Studio to identify your account.')
        return [session['server'], session['account'], workspace]

    def key(self, workspace, identifier):
        return hashlib.sha256(json.dumps([*self.identity(workspace), identifier]).encode()).hexdigest()

    def status(self):
        with self.lock, self.server.lock:
            session = self.connection.session
            copies = [copy.deepcopy(v) for v in self.server.state.get('studio_sync', {}).values()
                      if v['identity'][:2] == [session.get('server'), session.get('account')]]
            return {'profile_consent_required': self.connection.profile_consent_required(),
                    'connected': bool(session.get('refresh_token')), 'busy': bool(self.future and not self.future.done()),
                    'account': {'id': session['account'], **session.get('account_profile', {})} if session.get('refresh_token') and session.get('account') else None,
                    'automatic': self.server.state.get('settings', {}).get('studio.automatic', True),
                    'message': self.message, 'error': self.error, 'workspaces': copy.deepcopy(self.workspaces),
                    'workspace': self.workspace, 'projects': copy.deepcopy(self.projects), 'copies': copies}

    def run(self, action, body):
        try:
            with self.lock:
                self.error = ''
            if action == 'disconnect':
                self.notify(self.connection.disconnect())
                with self.lock:
                    self.workspaces, self.projects, self.workspace = [], [], ''
                return
            result = self.connection.login(self.notify) if action == 'connect' else self.connection.workspaces()
            with self.lock:
                self.workspaces = result['workspaces']
            workspace = body.get('workspace') or self.workspace or result['current']
            allowed = {x['id'] for x in result['workspaces'] if x.get('allowed')}
            if workspace not in allowed:
                raise StudioError('Allow Steve desktop access to this team in Studio Settings → Teams.')
            rows = self.list_projects(workspace)
            with self.lock:
                self.workspace, self.projects = workspace, rows
            if action in ('download', 'refresh'):
                identifiers = body.get('projects', [])
                if not isinstance(identifiers, list) or len(identifiers) > 100 or any(not isinstance(x, str) for x in identifiers):
                    raise StudioError('Select at most 100 CAD projects per sync.')
                if action == 'refresh':
                    with self.server.lock:
                        identifiers = [v['remote_id'] for v in self.server.state.get('studio_sync', {}).values()
                                       if v['identity'] == self.identity(workspace)]
                by_id = {x['id']: x for x in rows}
                failures = []
                for index, identifier in enumerate(dict.fromkeys(identifiers)):
                    if self.connection.cancel.is_set():
                        raise StudioError('Sync cancelled. Completed downloads and local work are preserved.')
                    project = by_id.get(identifier)
                    if not project or project.get('state') != 'live':
                        self.mark_missing(workspace, identifier, 'In Studio Trash' if project else 'No longer available in Studio')
                        continue
                    self.notify(f'Downloading {index + 1} of {len(identifiers)}: {project["name"]}')
                    try:
                        self.download(workspace, project)
                    except StudioError as exc:
                        if exc.status in (401, 403, 429, 503):
                            raise
                        failures.append(f'{project["name"]}: {exc}')
                if failures:
                    raise StudioError('\n'.join(failures))
                self.notify('Sync complete. Open a downloaded project to build it locally. Existing copies and edits are preserved.')
            else:
                self.notify(f'Connected · {len(rows)} CAD projects. Choose projects to download.')
        except (StudioError, ValueError) as exc:
            with self.lock:
                self.error = str(exc)
                self.message = 'Studio operation needs attention. Your local work is preserved.'
        except httpx.HTTPError:
            with self.lock:
                self.error = 'Studio connection interrupted. Retry when connected; local work is preserved.'
        except Exception:
            # Avoid logging request/credential-bearing exception representations.
            with self.lock:
                self.error = 'Studio could not complete this operation. Local projects were preserved.'

    def list_projects(self, workspace):
        rows, seen, cursor = [], set(), None
        for _ in range(1000):
            if self.connection.cancel.is_set():
                raise StudioError('Sync cancelled.')
            params = {'limit': 200, 'trashed': 'true'}
            if cursor:
                params['after'] = cursor
            result = self.connection.request('/api/v1/projects', workspace=workspace, params=params).json()
            if result.get('workspace') != workspace or not isinstance(result.get('projects'), list):
                raise StudioError('Studio returned a mismatched workspace listing.')
            rows.extend(result['projects'])
            cursor = result.get('next')
            if not cursor:
                return rows
            if cursor in seen:
                raise StudioError('Studio returned a repeated listing cursor. Retry the listing.')
            seen.add(cursor)
        raise StudioError('Studio listing exceeded the supported page count.')

    def mark_missing(self, workspace, identifier, reason):
        with self.server.lock:
            row = self.server.state.get('studio_sync', {}).get(self.key(workspace, identifier))
            if row:
                row['status'] = reason + ' · local copy retained'
                self.server.save()

    def download(self, workspace, project):
        key = self.key(workspace, project['id'])
        with self.server.lock:
            previous = copy.deepcopy(self.server.state.get('studio_sync', {}).get(key))
            exists = previous and previous['local_id'] in self.server.state['documents']
            # Studio limits mass reads to 200 changed documents per ten minutes.
            # Keep a conservative account-wide budget across restarts and retries.
            identity = json.dumps(self.identity(workspace)[:2])
            reads = self.server.state.setdefault('studio_reads', {})
            recent = [t for t in reads.get(identity, []) if t > time.time() - 600]
            if len(recent) >= 150:
                raise StudioError('Studio download budget reached. Automatic refresh will retry later; completed copies remain available.', 'sync_pacing', 429)
        response = self.connection.request('/api/v1/projects/' + quote(project['id'], safe='') + '/snapshot',
            workspace=workspace, headers={'If-None-Match': '"' + previous['snapshot'] + '"'} if exists else {})
        if response.status_code == 304:
            if not exists:
                raise StudioError('Studio returned unchanged for a project with no local copy.')
            with self.server.lock:
                self.server.state['studio_sync'][key]['status'] = 'Up to date with Studio · local edits retained'
                self.server.save()
            return
        snapshot = response.json()
        with self.server.lock:
            reads[identity] = recent + [time.time()]
            self.server.save()
        package = snapshot.get('package', {})
        digest = package.get('sha256', '')
        if (snapshot.get('complete') is not True or snapshot.get('unresolved') or
            snapshot.get('format') != 'steve.project' or snapshot.get('version') != 2 or
            snapshot.get('root', {}).get('document_id') != project['id'] or
            not re.fullmatch('[0-9a-f]{64}', snapshot.get('snapshot', '')) or
            not re.fullmatch('[0-9a-f]{64}', digest) or
            type(package.get('bytes')) is not int or not 0 < package['bytes'] <= MAX_ARCHIVE):
            raise StudioError('Studio returned an incomplete or unsupported project snapshot.')
        # Isolate resumable packages by authenticated server/account/workspace.
        path = self.downloads / (key + '-' + digest + '.partial')
        size = path.stat().st_size if path.exists() else 0
        if size > package['bytes']:
            path.unlink()
            size = 0
        if size < package['bytes']:
            downloaded = self.connection.request(package['url'], workspace=workspace, stream=True,
                headers={'Accept-Encoding': 'identity', **({'Range': f'bytes={size}-', 'If-Range': '"' + digest + '"'} if size else {})})
            representation = downloaded.headers.get('Repr-Digest')
            expected = 'sha-256=:' + base64.b64encode(bytes.fromhex(digest)).decode() + ':'
            if representation and representation != expected:
                downloaded.close()
                raise StudioError('Studio returned a mismatched package digest header.')
            if downloaded.status_code == 206:
                if downloaded.headers.get('Content-Range') != f'bytes {size}-{package["bytes"] - 1}/{package["bytes"]}':
                    downloaded.close()
                    raise StudioError('Studio returned an invalid resumed download range.')
                mode = 'ab'
            elif downloaded.status_code == 200:
                mode, size = 'wb', 0
            else:
                downloaded.close()
                raise StudioError('Unexpected project download status.')
            try:
                notified = 0
                with path.open(mode) as out:
                    for chunk in downloaded.iter_bytes(128 * 1024):
                        if self.connection.cancel.is_set():
                            raise StudioError('Download cancelled; retry to resume.')
                        size += len(chunk)
                        if size > package['bytes']:
                            raise StudioError('Studio returned more bytes than the declared package length.')
                        out.write(chunk)
                        if time.monotonic() - notified > .5:
                            self.notify(f'Downloading {project["name"]}: {size * 100 // package["bytes"]}%')
                            notified = time.monotonic()
                if size != package['bytes']:
                    raise StudioError('Download interrupted; retry to resume.')
            finally:
                downloaded.close()
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            path.unlink()
            raise StudioError('Studio project checksum failed. Retry the download.')
        documents, _ = read_archive(raw)
        if (documents[0]['document_id'], documents[0]['revision']) != (project['id'], snapshot['root']['revision']):
            raise StudioError('Project archive identity does not match the requested snapshot.')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            manifest = json.loads(archive.read('steve-project.json'))
        studio = manifest.get('studio', {})
        if studio.get('complete') is not True or studio.get('unresolved') or studio.get('snapshot') != snapshot['snapshot']:
            raise StudioError('Project manifest does not match the complete Studio snapshot.')
        if self.connection.cancel.is_set():
            raise StudioError('Sync cancelled before import.')
        with self.server.lock:
            before = copy.deepcopy(self.server.state)
            try:
                imported = restore_archive(self.server, raw)
                row = {'identity': self.identity(workspace), 'remote_id': project['id'], 'name': project['name'],
                       'local_id': imported['root']['id'], 'revision': snapshot['root']['revision'],
                       'snapshot': snapshot['snapshot'], 'sha256': digest, 'downloaded_at': time.time(),
                       'previous_copies': ([previous['local_id']] + previous.get('previous_copies', [])) if previous else [],
                       'status': 'New Studio snapshot downloaded · previous local copy retained' if previous else 'Available offline',
                       'runtime': studio.get('runtime_version'), 'reference_build': studio.get('reference_build')}
                self.server.state.setdefault('studio_sync', {})[key] = row
                self.server.save()
            except Exception:
                self.server.state = before
                self.server.save()
                raise
        # These are our own content-addressed cache files, never project files.
        for cached in self.downloads.glob(key + '-*.partial'):
            cached.unlink(missing_ok=True)

    def close(self):
        self.closed.set()
        self.connection.cancel.set()
        self.worker.shutdown(wait=False, cancel_futures=True)
        # Close the HTTP pool only once the serialized operation has released it.
        if self.future and not self.future.done():
            self.future.add_done_callback(lambda _: self.connection.close())
        else:
            self.connection.close()

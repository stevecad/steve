"""Loopback-only API adapter for the upstream CAD workspace. CAD runs locally."""

from steve_desktop.paths import RESOURCE_ROOT
import copy
import json
import os
import secrets
import socket
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
import uvicorn
from steve_desktop.cad_service import CadProject, atomic_json
from steve_desktop.cad_document import bracket, validate
from modeling.api import router as modeling_router
from steve_desktop.cad_live import SERVERS, LiveProject, source
from steve_desktop.cad_materials import MaterialBody, _checked as checked_material
import queue
import logging

CANCELLED = 'Stopped: you cancelled it.'


def now():
    return datetime.now(timezone.utc).isoformat()


class LocalCadServer:
    def __init__(self, folder):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.path = self.folder / 'catalog.json'
        self.lock = threading.RLock()
        self.session_path = self.folder / 'session.json'
        self.context = json.loads(self.session_path.read_text(encoding='utf-8')) if self.session_path.exists() else {}
        self.pending = None
        self.event_version = 0
        self.desktop_actions = queue.Queue()
        SERVERS[str(self.folder.resolve())] = self
        self.state = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {'documents': {}, 'builds': {}, 'active': None, 'settings': {}}
        self.token = secrets.token_urlsafe(32)
        self.executor = ThreadPoolExecutor(max_workers=max(1, os.cpu_count() or 1), thread_name_prefix='local-cad')
        self.cancellations = {}
        self.app = FastAPI(title='Steve CAD', docs_url=None, redoc_url=None)
        self.routes()
        from steve_desktop.cad_worker import WORKER
        WORKER.configure(self.state['settings'].get('local.cpu_percent', 80))
        self.socket = socket.socket()
        self.socket.bind(('127.0.0.1', 0))
        self.port = self.socket.getsockname()[1]
        self.url = f'http://127.0.0.1:{self.port}'
        self.server = uvicorn.Server(uvicorn.Config(self.app, log_level='warning', access_log=False))
        self.thread = threading.Thread(target=lambda: self.server.run(sockets=[self.socket]), daemon=True)
        self.thread.start()

    def save(self):
        with self.lock:
            atomic_json(self.path, self.state)

    def project_for(self, document_id):
        if document_id not in self.state['documents']:
            raise HTTPException(404, 'Document not found')
        return CadProject(self.folder / 'documents' / document_id)

    @property
    def project(self):
        return LiveProject(self)

    def update_document(self, document_id, body):
        validate(body)
        existing = self.state['documents'].get(document_id)
        if not existing:
            raise HTTPException(404, 'Document not found')
        if body.get('revision') != existing['revision']:
            raise HTTPException(409, 'Document changed. Reopen or reconcile your edits.')
        if body['kind'] != existing['kind']:
            raise HTTPException(422, 'Document kind cannot change.')
        history = self.state.setdefault('history', {}).setdefault(document_id, [])
        history.append(copy.deepcopy(existing))
        existing.update(source(body), preview_build_id=self.matching_preview(body, body.get('preview_build_id', existing.get('preview_build_id'))),
                        message=(body.get('message') or '').strip() or None,
                        revision=existing['revision'] + 1, updated_at=now())
        self.save()
        return existing

    def create_document(self, body):
        validate(body)
        identifier = str(uuid.uuid4())
        doc = {**body, 'id': identifier, 'revision': 1, 'created_at': now(), 'updated_at': now(),
               'preview_build_id': self.matching_preview(body, body.get('preview_build_id')),
               'message': (body.get('message') or '').strip() or None,
               'files': body.get('files', {}), 'links': body.get('links', {}),
               'folder_id': None, 'folder_path': None, 'branch_count': 0}
        CadProject.create(self.folder / 'documents' / identifier, body['name'])
        self.state['documents'][identifier] = doc
        self.state['active'] = identifier
        self.save()
        return doc

    def matching_preview(self, document, build_id):
        """Only attach successful geometry built from this revision's source."""
        if not isinstance(build_id, str):
            return None
        build = self.state['builds'].get(build_id)
        if not build or build['status'] != 'succeeded':
            return None
        keys = ('kind', 'code', 'files', 'links')
        if any(source(build)[key] != source(document)[key] for key in keys):
            return None
        return build_id

    def submit(self, body):
        validate(body)
        identifier = str(uuid.uuid4())
        entry = {**body, 'id': identifier, 'status': 'queued', 'mode': body.get('mode', 'preview'),
                 'created_at': now(), 'started_at': None, 'finished_at': None, 'artifacts': {}, 'metadata': None, 'error': None}
        self.state['builds'][identifier] = entry
        cancel = threading.Event()
        self.cancellations[identifier] = cancel
        self.save()
        executor = self.local_blender.scene_jobs if body.get('kind') == 'blender' else self.executor
        executor.submit(self.build, identifier, cancel)
        return entry

    def revision(self, identifier, revision=None):
        doc = self.state['documents'].get(identifier)
        if doc and (revision is None or doc['revision'] == revision):
            return copy.deepcopy(doc)
        doc = next((d for d in self.state.get('history', {}).get(identifier, []) if d['revision'] == revision), None)
        if not doc:
            raise ValueError('Linked document revision is not available locally.')
        return copy.deepcopy(doc)

    def resolve_links(self, document, seen=()):
        document = copy.deepcopy(document)
        links = {}
        for alias, ref in document.get('links', {}).items():
            key = (ref['document_id'], ref['revision'])
            if key in seen or len(seen) >= 16:
                raise ValueError('Cyclic or excessively deep linked documents.')
            linked = self.resolve_links(self.revision(*key), (*seen, key))
            links[alias] = {**linked, 'document_id': key[0], **({'component': ref['component']} if ref.get('component') else {})}
        document['links'] = links
        return document

    def build(self, identifier, cancel):
        from steve_desktop.cad_worker import WORKER
        try:
            if self.state['builds'][identifier]['kind'] == 'blender':
                return self.local_blender.build(identifier, cancel)
            from steve_desktop.cad_parallel import prepare_components
            document = self.resolve_links(self.state['builds'][identifier])
            document['_imports_dir'] = str((self.folder / 'imports').resolve())
            document['_imports_map'] = {k: v['sha256'] for k, v in self.state.get('imports', {}).items() if v['status'] == 'ready'}
            document['materials'] = self.state.get('materials', {})
            cache_root = self.folder / 'cache' / 'components'
            from steve_desktop.cad_dependencies import component_plan
            from steve_desktop.cad_cost_profiles import observed_costs
            from steve_desktop.cad_strategy import choose_components
            plan = component_plan(document)
            paths = [path for level in plan['levels'] for path in level]
            try:
                costs, missing = observed_costs(cache_root, document, paths)
                strategy = choose_components(plan, missing, costs, WORKER.status()['ready'])
            except Exception:
                logging.getLogger(__name__).exception('CAD timing profile unavailable; using serial execution')
                strategy = {'selected': [], 'mode': 'serial', 'reason': 'timing profile unavailable'}
            self.state['builds'][identifier]['component_strategy'] = strategy
            def preparation_progress(done, total):
                with self.lock:
                    entry = self.state['builds'][identifier]
                    entry.update(status='running', started_at=entry['started_at'] or now(),
                                 metadata={'progress': {'stage': 'components', 'done': done, 'of': total}})
                    self.save()
            # The explicit flag remains useful for verification. Normal builds
            # use observed costs and stay serial when the estimate is uncertain.
            preparation = (prepare_components(document, self.folder / 'builds' / identifier,
                                              cache_root, cancel, WORKER, preparation_progress,
                                              selected=None if document.get('_parallel_components') is True else strategy['selected'])
                           if document.get('_parallel_components') is True or strategy['selected'] else
                           {'levels': [], 'jobs': [], 'cached': [], 'reason': strategy['reason']})
            self.state['builds'][identifier]['component_preparation'] = preparation
            with WORKER.lease(cancel):
                self._build(identifier, cancel)
        except Exception as exc:
            with self.lock:
                self.state['builds'][identifier].update(status='failed', error=CANCELLED if cancel.is_set() else str(exc), logs=str(exc), finished_at=now())
                self.save()

    def _build(self, identifier, cancel):
        entry = self.state['builds'][identifier]
        try:
            project = CadProject.create(self.folder / 'builds' / identifier, entry['name'])
            project.cache_folder = self.folder / 'cache' / 'components'
            entry.update(status='running', started_at=entry['started_at'] or now(), metadata={'progress': {'stage': 'main'}})
            self.save()
            resolved = self.resolve_links(entry)
            from steve_desktop.cad_live import fingerprint
            entry['_resolved_fingerprint'] = fingerprint(resolved)
            resolved['_imports_dir'] = str((self.folder / 'imports').resolve())
            resolved['_imports_map'] = {k: v['sha256'] for k, v in self.state.get('imports', {}).items() if v['status'] == 'ready'}
            resolved['materials'] = self.state.get('materials', {})
            result = project.build(resolved, cancel=cancel)
            entry['timing'] = project.last_kernel_report
            revision = result['revision']
            folder = project.revision_folder(revision)
            metadata = json.loads((folder / 'studio-metadata.json').read_text(encoding='utf-8'))
            try:
                from steve_desktop.cad_cost_profiles import record_costs
                record_costs(project.cache_folder, resolved, metadata.get('local_component_costs', []))
            except Exception:
                logging.getLogger(__name__).exception('Could not retain CAD timing observations')
            entry.update(status='succeeded', metadata=metadata, _revision=revision,
                         artifacts={'preview': f'/v1/builds/{identifier}/artifacts/preview',
                                    'topology': f'/v1/builds/{identifier}/artifacts/topology',
                                    'step': f'/v1/builds/{identifier}/artifacts/step'})
            optional = {'drawing': 'drawing.svg', 'drawings': 'drawings.zip', 'drawings_pdf': 'drawings.pdf',
                        'sheet_metal': 'sheet-metal.json', 'sheet_metal_export': 'sheet-metal.zip', 'bodies_mesh': 'bodies-mesh.zip'}
            for key, filename in optional.items():
                if (folder / filename).exists():
                    entry['artifacts'][key] = f'/v1/builds/{identifier}/artifacts/{key}'
        except Exception as exc:
            entry.update(status='failed', error=CANCELLED if cancel.is_set() else str(exc), logs=str(exc))
        finally:
            entry['finished_at'] = now()
            with self.lock:
                self.save()

    def build_folder(self, identifier):
        entry = self.state['builds'].get(identifier)
        if not entry or entry['status'] != 'succeeded':
            raise HTTPException(404, 'Successful build not found')
        if entry.get('kind') == 'blender':
            from steve_desktop.local_blender import BlenderResult
            folder = self.folder / 'cache' / 'blender' / entry['_blender_cache']
            return entry, BlenderResult(folder, entry['metadata']), folder
        project = CadProject(self.folder / 'builds' / identifier)
        project.cache_folder = self.folder / 'cache' / 'components'
        return entry, project, project.revision_folder(entry['_revision'])

    def routes(self):
        app = self.app

        @app.exception_handler(ValueError)
        async def invalid(request, exception):
            return JSONResponse({'detail': str(exception)}, status_code=422)

        @app.middleware('http')
        async def protect(request: Request, call_next):
            if request.url.path.startswith('/v1/mcp-bridge/'):
                if not self.local_mcp.authorized(request):
                    return JSONResponse({'detail': 'Local MCP server is stopped or credentials are invalid'}, status_code=403)
                return await call_next(request)
            if not secrets.compare_digest(request.headers.get('x-steve-session', ''), self.token):
                return JSONResponse({'detail': 'Desktop session required'}, status_code=403)
            origin = request.headers.get('origin')
            if origin and origin != self.url:
                return JSONResponse({'detail': 'Origin rejected'}, status_code=403)
            return await call_next(request)

        app.include_router(modeling_router)
        from steve_desktop.cad_documents import install
        install(self)
        from steve_desktop.cad_imports import install as install_imports
        install_imports(self)
        from steve_desktop.cad_parts import install as install_parts
        install_parts(self)
        from steve_desktop.cad_drawings import install as install_drawings
        install_drawings(self)
        from steve_desktop.cad_folders import install as install_folders
        install_folders(self)
        from steve_desktop.cad_images import install as install_images
        install_images(self)
        from steve_desktop.cad_archive import install as install_archive
        install_archive(self)

        @app.get('/health')
        def health():
            return {'ok': True}

        @app.get('/v1/auth/config')
        def auth_config():
            return {'mode': 'dev', 'workspaces': ['design'], 'unavailable': {'simulate': 'CAD only locally', 'manufacture': 'CAD only locally', 'electronics': 'CAD only locally'}, 'blender_installed': self.local_blender.runtime is not None}

        @app.get('/v1/auth/me')
        def account():
            return {'mode': 'dev', 'name': 'Local', 'username': 'local', 'email': '', 'workspace': 'local', 'person': 'local', 'admin': False}

        @app.get('/v1/workspaces')
        def workspaces():
            return {'workspaces': [], 'personal': 'local'}

        @app.get('/v1/examples')
        def examples():
            return {'mounting_bracket': bracket()['code']}

        @app.get('/v1/examples/catalog')
        def examples_catalog():
            return {'examples': [{'id': 'mounting_bracket', 'description': 'Parametric mounting bracket', **bracket()}]}

        @app.get('/v1/documents')
        def documents(search: str = '', kind: str = '', limit: int = 100, offset: int = 0):
            docs = [d for d in self.state['documents'].values() if not d.get('deleted_at') and search.lower() in d['name'].lower() and (not kind or kind == d['kind'])]
            return {'documents': sorted(docs, key=lambda d: d['updated_at'], reverse=True)[offset:offset+min(limit,100)]}

        @app.get('/v1/files')
        def files(search: str = '', kind: str = ''):
            return {'files': documents(search, kind)['documents']}

        @app.get('/v1/documents/{document_id}')
        def document(document_id: str):
            with self.lock:
                self.project_for(document_id)
                self.state['active'] = document_id
                doc = copy.deepcopy(self.state['documents'][document_id])
                status = {}
                for alias, ref in doc.get('links', {}).items():
                    latest = self.state['documents'].get(ref['document_id'])
                    status[alias] = {
                        'revision': ref['revision'],
                        'latest': latest['revision'] if latest else None,
                        'name': latest['name'] if latest else None,
                        'kind': latest['kind'] if latest else None,
                        **({'trashed': True} if latest and latest.get('deleted_at') else {}),
                    }
                if status:
                    doc['link_status'] = status
                return doc

        @app.post('/v1/documents', status_code=201)
        def create(body: dict):
            with self.lock:
                return self.create_document(body)

        @app.put('/v1/documents/{document_id}')
        def update(document_id: str, body: dict):
            with self.lock:
                return self.update_document(document_id, body)

        @app.post('/v1/documents/{document_id}/preview')
        def preview(document_id: str, body: dict):
            with self.lock:
                self.project_for(document_id)
                self.state['active'] = document_id
                doc = self.state['documents'][document_id]
                if body['revision'] != doc['revision']:
                    raise HTTPException(409, 'Revision changed')
                preview_id = self.matching_preview(doc, body['build_id'])
                if not preview_id:
                    raise HTTPException(422, 'The model must be a successful build of this revision.')
                doc['preview_build_id'] = preview_id
                self.save()
                return doc

        @app.get('/v1/builds')
        def builds(limit: int = 100):
            return {'builds': list(reversed(list(self.state['builds'].values())))[:min(limit,100)]}

        @app.post('/v1/builds', status_code=202)
        def submit(body: dict):
            with self.lock:
                return self.submit(body)

        @app.get('/v1/builds/{build_id}')
        def get_build(build_id: str):
            if build_id not in self.state['builds']:
                raise HTTPException(404, 'Build not found')
            return self.state['builds'][build_id]

        @app.post('/v1/builds/{build_id}/cancel')
        def cancel_build(build_id: str):
            if build_id in self.cancellations:
                self.cancellations[build_id].set()
            return {**get_build(build_id), 'stop': 'stopping'}

        @app.api_route('/v1/builds/{build_id}/step', methods=['GET', 'POST'])
        def step(build_id: str):
            entry, project, folder = self.build_folder(build_id)
            target = folder / 'result.step'
            if not target.exists():
                result = project.export('STEP', entry['_revision'])
                import shutil
                shutil.copyfile(result['path'], target)
            entry['step'] = 'ready'
            return {'state': 'ready', 'job': 'succeeded', 'error': None, 'url': entry['artifacts']['step']}

        @app.get('/v1/builds/{build_id}/components/{key:path}')
        def component_step(build_id: str, key: str):
            import zipfile
            entry, project, folder = self.build_folder(build_id)
            component = next((c for c in entry['metadata'].get('component_steps') or [] if c['key'] == key), None)
            if not component:
                raise HTTPException(404, 'Component STEP not found. Make a full build first.')
            with zipfile.ZipFile(folder / 'components-step.zip') as archive:
                return Response(archive.read(component['file']), media_type='application/step')

        @app.api_route('/v1/builds/{build_id}/print-mesh', methods=['GET', 'POST'])
        def print_mesh(build_id: str, resolution: str = 'fine'):
            if resolution not in ('fine', 'medium', 'coarse'):
                raise HTTPException(422, 'Unknown mesh resolution')
            entry, project, folder = self.build_folder(build_id)
            key = 'body_meshes' if resolution == 'fine' else 'body_meshes_' + resolution
            with project.lock:
                if not entry['metadata'].get(key):
                    derived = folder / ('mesh-' + resolution)
                    derived.mkdir(exist_ok=True)
                    document = json.loads((folder/'document.json').read_text(encoding='utf-8'))
                    document.update(mode='print_mesh', mesh_resolution=resolution)
                    atomic_json(derived/'document.json', document)
                    cancel = threading.Event()
                    self.cancellations[build_id + ':' + resolution] = cancel
                    project.run_kernel(['derive', derived], cancel)
                    metadata = json.loads((derived/'derivation.json').read_text(encoding='utf-8'))
                    entry['metadata'][key] = metadata['body_meshes']
                    self.save()
            return {'status': 'succeeded', 'error': None}

        @app.get('/v1/builds/{build_id}/body-mesh/{index}')
        def body_mesh(build_id: str, index: int, resolution: str = 'fine'):
            import zipfile
            if resolution not in ('fine', 'medium', 'coarse'):
                raise HTTPException(422, 'Unknown mesh resolution')
            entry, project, folder = self.build_folder(build_id)
            key = 'body_meshes' if resolution == 'fine' else 'body_meshes_' + resolution
            manifest = entry['metadata'].get(key) or []
            if index < 0 or index >= len(manifest):
                raise HTTPException(404, 'Body mesh not found')
            archive_path = folder / 'bodies-mesh.zip' if resolution == 'fine' else folder / ('mesh-' + resolution) / 'bodies-mesh.zip'
            if not archive_path.exists():
                archive_path = folder / ('mesh-' + resolution) / 'bodies-mesh.zip'
            with zipfile.ZipFile(archive_path) as archive:
                return Response(archive.read(manifest[index]['file']), media_type='application/octet-stream')

        @app.get('/v1/builds/{build_id}/artifacts/{artifact}')
        def artifact(build_id: str, artifact: str):
            entry, project, folder = self.build_folder(build_id)
            names = {'preview': 'preview.glb', 'topology': 'topology.json', 'step': 'result.step'}
            names.update(drawing='drawing.svg', drawings='drawings.zip', drawings_pdf='drawings.pdf', sheet_metal='sheet-metal.json',
                         sheet_metal_export='sheet-metal.zip', bodies_mesh='bodies-mesh.zip')
            names.update(blend='result.blend', animation='animation.mp4')
            names.update({f'view_{view}': f'view-{view}.png' for view in ('isometric', 'top', 'front', 'right', 'camera')})
            if artifact not in names:
                raise HTTPException(404, 'Artifact not found')
            if artifact == 'step':
                step(build_id)
            if not (folder / names[artifact]).is_file():
                raise HTTPException(404, 'Artifact is not available in this build.')
            return FileResponse(folder / names[artifact], filename=names[artifact] if artifact in ('step', 'blend', 'animation') else None)

        @app.get('/v1/materials')
        def materials():
            return {'materials': list(self.state.get('materials', {}).values())}

        def store_material(body, identifier):
            record = {**checked_material(body), 'id': identifier, 'updated_at': now()}
            with self.lock:
                self.state.setdefault('materials', {})[identifier] = record
                self.save()
            return record

        @app.post('/v1/materials')
        def create_material(body: MaterialBody):
            return store_material(body, 'my:' + uuid.uuid4().hex)

        @app.put('/v1/materials/{identifier}')
        def update_material(identifier: str, body: MaterialBody):
            if identifier not in self.state.get('materials', {}):
                raise HTTPException(404, 'Material not found')
            return store_material(body, identifier)

        @app.delete('/v1/materials/{identifier}')
        def delete_material(identifier: str):
            with self.lock:
                if self.state.get('materials', {}).pop(identifier, None) is None:
                    raise HTTPException(404, 'Material not found')
                self.save()
            return None

        @app.api_route('/v1/settings', methods=['GET', 'PUT'])
        @app.api_route('/v1/account/settings', methods=['GET', 'PUT', 'PATCH'])
        async def settings(request: Request):
            if request.method != 'GET':
                self.state['settings'].update(await request.json())
                self.save()
            return {'settings': self.state['settings'], 'revision': 1}

        @app.get('/v1/terms')
        def terms():
            return {'required': False, 'accepted': True}

        @app.get('/v1/connectors/panels')
        def panels():
            return {'panels': []}

        @app.get('/v1/local/context')
        def context():
            return copy.deepcopy(self.context)

        @app.get('/v1/local/performance')
        def performance():
            from steve_desktop.cad_worker import WORKER
            return WORKER.status()

        @app.put('/v1/local/performance')
        def configure_performance(body: dict):
            from steve_desktop.cad_worker import WORKER
            if set(body) != {'cpu_percent'}:
                raise HTTPException(422, 'Provide cpu_percent only.')
            try:
                WORKER.configure(body['cpu_percent'])
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from None
            with self.lock:
                self.state['settings']['local.cpu_percent'] = body['cpu_percent']
                self.save()
            return WORKER.status()

        @app.post('/v1/local/context')
        def sync_context(body: dict):
            with self.lock:
                if self.pending and body.get('ack') == self.pending['version']:
                    self.pending = None
                if not self.pending:
                    doc = body.get('document')
                    if doc is not None:
                        validate(doc)
                    context = {k: body.get(k) for k in ('document', 'document_id', 'build_id', 'selection')}
                    if context != self.context:
                        self.context = context
                        atomic_json(self.session_path, self.context)
                return {'pending': copy.deepcopy(self.pending)}

        @app.post('/v1/local/desktop/{action}')
        def desktop_action(action: str):
            if action not in ('steve', 'account', 'mcp', 'agent'):
                raise HTTPException(404, 'Unknown desktop action')
            self.desktop_actions.put(action)
            return {'ok': True}

        from steve_desktop.local_mcp import LocalMCP
        self.local_mcp = LocalMCP(self)
        from steve_desktop.local_git import LocalGit
        self.local_git = LocalGit(self)
        from steve_desktop.local_studio import LocalStudio
        self.local_studio = LocalStudio(self)
        from steve_desktop.local_feedback import LocalFeedback
        self.local_feedback = LocalFeedback(self, self.local_studio)  # /v1/feedback/*: reports go to Studio only.
        from steve_desktop.local_blender import LocalBlender
        self.local_blender = LocalBlender(self)
        from steve_desktop.local_updates import LocalUpdates
        self.local_updates = LocalUpdates(self)
        assets = RESOURCE_ROOT / 'cad-web' / 'dist'
        if assets.exists():
            app.mount('/', StaticFiles(directory=assets, html=True), name='cad-ui')

    def close(self):
        for event in list(self.cancellations.values()):
            event.set()
        self.local_blender.close()
        self.local_studio.close()
        self.local_mcp.stop()
        SERVERS.pop(str(self.folder.resolve()), None)
        for event in self.cancellations.values():
            event.set()
        self.server.should_exit = True
        self.executor.shutdown(wait=True, cancel_futures=True)
        self.thread.join(timeout=3)
        self.local_updates.close()

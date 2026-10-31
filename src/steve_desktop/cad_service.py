"""Transactional local CAD projects, shared by the desktop and Steve's tools."""

from steve_desktop.paths import RESOURCE_ROOT
import asyncio
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from steve_desktop.cad_document import validate, bracket, FORMAT_HELP, change_parameters, source_model

_locks = {}
_locks_guard = threading.Lock()


def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('w', encoding='utf-8') as stream:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class CadProject:
    def __init__(self, folder):
        self.folder = Path(folder).resolve()
        self.path = self.folder / 'project.steve'
        self.cache_folder = self.folder / '.cache' / 'components'
        with _locks_guard:
            self.lock = _locks.setdefault(str(self.folder).casefold(), threading.RLock())

    @classmethod
    def create(cls, folder, name='Untitled design'):
        project = cls(folder)
        project.folder.mkdir(parents=True, exist_ok=True)
        if project.path.exists():
            raise ValueError('This folder already contains a Steve project.')
        (project.folder / 'revisions').mkdir(exist_ok=True)
        atomic_json(project.path, {'schema': 1, 'name': name, 'revisions': [], 'cursor': -1})
        return project

    def state(self):
        state = json.loads(self.path.read_text(encoding='utf-8'))
        if state.get('schema') != 1:
            raise ValueError('Unsupported Steve project version.')
        return state

    def current(self):
        state = self.state()
        return state['revisions'][state['cursor']] if state['cursor'] >= 0 else None

    def revision_folder(self, revision):
        if not isinstance(revision, str) or len(revision) != 12 or any(c not in '0123456789abcdef' for c in revision):
            raise ValueError('Invalid revision id.')
        folder = self.folder / 'revisions' / revision
        if folder.is_symlink() or not folder.resolve().is_relative_to(self.folder):
            raise ValueError('Revision path leaves the project.')
        return folder

    def read(self):
        with self.lock:
            revision = self.current()
            if not revision:
                return {'revision': None, 'document': None, 'format': FORMAT_HELP}
            return {'revision': revision['id'], 'document': json.loads((self.revision_folder(revision['id']) / 'document.json').read_text(encoding='utf-8')),
                    'format': FORMAT_HELP}

    def geometry(self):
        with self.lock:
            revision = self.current()
            if not revision:
                return None
            data = json.loads((self.revision_folder(revision['id']) / 'geometry.json').read_text(encoding='utf-8'))
            data['revision'] = revision['id']
            return data

    def run_kernel(self, args, cancel=None):
        from steve_desktop.cad_worker import WORKER
        if args[0] in ('build', 'derive'):
            args = [*args, self.cache_folder]
        self.last_kernel_report = WORKER.execute(args, cancel)

    def build(self, document, expected_revision=None, message='Model updated', cancel=None):
        document = copy.deepcopy(validate(document))
        with self.lock:
            current = self.current()
            actual = current['id'] if current else None
            if expected_revision != actual:
                raise ValueError('The model changed since you read it. Read the current revision before editing.')
            revision = uuid.uuid4().hex[:12]
            staging = self.folder / ('build-' + revision)
            staging.mkdir()
            try:
                atomic_json(staging / 'document.json', document)
                self.run_kernel(['build', staging], cancel)
                if cancel and cancel.is_set():
                    raise ValueError('Build cancelled.')
                state = self.state()
                # Retain abandoned redo revisions in the history list; parent links preserve provenance.
                entry = {'id': revision, 'parent': actual, 'message': message[:200],
                         'time': datetime.now(timezone.utc).isoformat(), 'name': document['name']}
                destination = self.revision_folder(revision)
                staging.rename(destination)
                state['revisions'].append(entry)
                state['cursor'] = len(state['revisions']) - 1
                state['name'] = document['name']
                atomic_json(self.path, state)
                (self.folder / 'draft.json').unlink(missing_ok=True)
                return self.inspect()
            finally:
                if staging.exists():
                    shutil.rmtree(staging)

    def inspect(self, entity=None, expected_revision=None):
        with self.lock:
            geometry = self.geometry()
            if geometry is None:
                return {'revision': None, 'status': 'No built model'}
            if expected_revision and expected_revision != geometry['revision']:
                raise ValueError('Selection belongs to an older build. Select the geometry again.')
            if entity:
                item = next((x for x in geometry['faces'] + geometry['edges'] if x['id'] == entity or x.get('reference') == entity), None)
                if item is None:
                    raise ValueError('Unknown topology id.')
                return {'revision': geometry['revision'], 'units': 'mm', **{k: v for k, v in item.items() if k not in ('vertices', 'triangles', 'points')}}
            result = {k: v for k, v in geometry.items() if k not in ('faces', 'edges')}
            result['faces'] = [{k: v for k, v in f.items() if k not in ('vertices', 'triangles')} for f in geometry['faces']]
            result['edges'] = [{k: v for k, v in e.items() if k != 'points'} for e in geometry['edges']]
            selection_path = self.folder / 'selection.json'
            if selection_path.exists():
                selection = json.loads(selection_path.read_text(encoding='utf-8'))
                if selection.get('revision') == geometry['revision']:
                    result['selection'] = selection
            return result

    def parameters(self, values, expected_revision, cancel=None):
        snapshot = self.read()
        if not snapshot['document']:
            raise ValueError('Create a model first.')
        doc = change_parameters(snapshot['document'], values)
        return self.build(doc, expected_revision, 'Parameters: ' + ', '.join(values), cancel)

    def restore(self, revision):
        with self.lock:
            state = self.state()
            index = next((i for i, item in enumerate(state['revisions']) if item['id'] == revision), None)
            if index is None:
                raise ValueError('Revision not found.')
            state['cursor'] = index
            state['name'] = state['revisions'][index]['name']
            atomic_json(self.path, state)
            return self.inspect()

    def undo(self):
        current = self.current()
        if current and current.get('parent'):
            return self.restore(current['parent'])
        raise ValueError('No earlier revision.')

    def redo(self):
        current = self.current()
        candidates = [r for r in self.state()['revisions'] if r.get('parent') == (current or {}).get('id')]
        if candidates:
            return self.restore(candidates[-1]['id'])
        raise ValueError('No later revision.')

    def export(self, kind='STEP', expected_revision=None, cancel=None):
        kind = kind.upper()
        if kind not in ('STEP', 'STL', '3MF'):
            raise ValueError('Choose STEP, STL or 3MF.')
        with self.lock:
            current = self.current()
            if not current or expected_revision != current['id']:
                raise ValueError('Read the current revision before exporting.')
            target = self.folder / 'exports'
            target.mkdir(exist_ok=True)
            filename = f'model-{current["id"]}.{kind.lower()}'
            path = target / filename
            temporary = target / ('pending-' + filename)
            try:
                self.run_kernel(['export', self.revision_folder(current['id']), temporary, kind], cancel)
                os.replace(temporary, path)
            finally:
                temporary.unlink(missing_ok=True)
            return {'revision': current['id'], 'format': kind, 'path': str(path), 'bytes': path.stat().st_size}


def cad_tools(folder, approve, activity):
    from pydantic_ai.toolsets.function import FunctionToolset
    from steve_desktop.cad_live import project_for_tools
    project = project_for_tools(folder)

    async def run(name, arguments, function, *args):
        activity('Running · CAD / ' + name)
        cancel = threading.Event()
        try:
            result = await asyncio.to_thread(function, *args, cancel=cancel)
            activity('Completed · CAD / ' + name)
            return result
        except asyncio.CancelledError:
            cancel.set()
            raise
        except ValueError as exc:
            return {'error': str(exc), 'last_good_model_preserved': True}

    def cad_read() -> dict:
        """Read the active CAD document, revision and supported modeling format before editing."""
        return project.read()

    def cad_inspect(entity: str | None = None, expected_revision: str | None = None) -> dict:
        """Inspect exact built geometry, dimensions, volume, faces, edges and user's selection. IDs are revision-specific."""
        try:
            return project.inspect(entity, expected_revision)
        except ValueError as exc:
            return {'error': str(exc)}

    async def cad_build(document: dict, expected_revision: str | None = None, message: str = 'Steve updated the model') -> dict:
        """Build Studio-compatible CAD or Blender Python source (kind part, design or blender; code/files/links). Preserves the last good scene on failure."""
        return await run('cad_build', {'document': document, 'expected_revision': expected_revision}, project.build, document, expected_revision, message)

    async def cad_set_parameters(values: dict[str, float], expected_revision: str) -> dict:
        """Edit named dimensions and rebuild the model atomically. Read and inspect the resulting revision."""
        return await run('cad_set_parameters', {'values': values, 'expected_revision': expected_revision}, project.parameters, values, expected_revision)

    async def cad_export(expected_revision: str, format: str = 'STEP') -> dict:
        """Export CAD as STEP/STL/3MF, or Blender scenes as BLEND/GLB/MP4. Read the current revision first."""
        return await run('cad_export', {'format': format, 'expected_revision': expected_revision}, project.export, format, expected_revision)

    async def blender_render(view: str = 'camera', animation: bool = False) -> dict:
        """Render the active Blender scene locally. Views: camera, isometric, top, front, right. Animation renders the scene's frame range and returns MP4 plus .blend. Returns local artifact paths; never uses a cloud renderer."""
        if not hasattr(project, 'server'):
            return {'error': 'Open the Blender scene in Steve first.'}
        if view not in ('camera', 'isometric', 'top', 'front', 'right'):
            return {'error': 'Choose camera, isometric, top, front or right.'}
        def render(cancel=None):
            import time
            context = project.read()
            document = context['document']
            if not document or document['kind'] != 'blender':
                raise ValueError('Open a Blender scene first.')
            entry = project.server.submit({**document, 'mode': 'full' if animation else 'render' if view == 'camera' else 'views', 'look': {'view': view, 'shading': 'rendered'}})
            while entry['status'] in ('queued', 'running'):
                if cancel and cancel.is_set():
                    project.server.cancellations[entry['id']].set()
                    raise ValueError('Render cancelled.')
                time.sleep(.1)
            if entry['status'] != 'succeeded':
                raise ValueError(entry.get('error') or 'Render failed.')
            _, _, folder = project.server.build_folder(entry['id'])
            return {'build_id': entry['id'], 'metadata': entry['metadata'],
                    'files': [str(path) for path in folder.iterdir() if path.suffix in ('.png', '.mp4', '.blend')]}
        return await run('blender_render', {'view': view, 'animation': animation}, render)

    def cad_revisions() -> dict:
        """List saved model revisions, parent history and active revision."""
        return project.state()

    async def cad_restore(revision: str) -> dict:
        """Restore a prior model revision without deleting later versions."""
        return await asyncio.to_thread(project.restore, revision)

    def cad_api_reference(class_name: str = 'Model', method: str | None = None) -> dict:
        """Read exact upstream CAD API signatures and documentation. Classes: Model, Sketch, Component, Design."""
        import ast
        names = {'Model': 'model.py', 'Sketch': 'sketch.py', 'Component': 'design.py', 'Design': 'design.py'}
        if class_name not in names:
            return {'error': 'Choose Model, Sketch, Component or Design.'}
        path = RESOURCE_ROOT / 'vendor' / 'steve' / names[class_name]
        tree = ast.parse(path.read_text(encoding='utf-8'))
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == class_name)
        methods = [n for n in cls.body if isinstance(n, ast.FunctionDef) and not n.name.startswith('_')]
        if method:
            methods = [n for n in methods if n.name == method]
        return {'class': class_name, 'methods': [{'name': n.name, 'signature': ast.unparse(n.args), 'doc': ast.get_docstring(n)} for n in methods]}

    def cad_source_package() -> dict:
        """Read open source plus every pinned linked document for transfer through Studio's configured MCP. Does not publish anything."""
        return project.package() if hasattr(project, 'package') else project.read()

    async def cad_import_package(documents: list[dict]) -> dict:
        """Import a complete source package read through Studio MCP. Root first; include every pinned dependency. Builds remain local."""
        if not hasattr(project, 'import_package'):
            return {'error': 'Open the CAD workspace first.'}
        try:
            return await asyncio.to_thread(project.import_package, documents)
        except ValueError as exc:
            return {'error': str(exc)}

    async def cad_find_parts(query: str = '', catalog: str = 'standard') -> dict:
        """Search standard STEP parts online, or McMaster parts the user already imported locally (catalog='mcmaster')."""
        if not hasattr(project, 'server'):
            return {'error': 'Open the CAD workspace first.'}
        try:
            if catalog == 'standard':
                return await asyncio.to_thread(project.server.parts.standard_search, query=query)
            if catalog == 'mcmaster':
                return project.server.parts.mcmaster_list(query)
            return {'error': 'Choose standard or mcmaster.'}
        except Exception as exc:
            return {'error': str(getattr(exc, 'detail', exc))}

    async def cad_import_catalog_part(identifier: str, catalog: str = 'standard') -> dict:
        """Cache a real catalog STEP locally. Returns sha256 for Model.import_step plus provenance. If validating, call again until ready before cad_build. McMaster accepts previously user-downloaded parts only. Does not edit the model."""
        if not hasattr(project, 'server'):
            return {'error': 'Open the CAD workspace first.'}
        try:
            if catalog == 'standard':
                return await asyncio.to_thread(project.server.parts.standard_import, identifier)
            if catalog == 'mcmaster':
                return project.server.parts.mcmaster_get(identifier, use=True)
            return {'error': 'Choose standard or mcmaster.'}
        except Exception as exc:
            return {'error': str(getattr(exc, 'detail', exc))}

    return FunctionToolset([blender_render, cad_api_reference, cad_read, cad_inspect, cad_build, cad_set_parameters, cad_export, cad_revisions, cad_restore, cad_source_package, cad_import_package, cad_find_parts, cad_import_catalog_part], sequential=True)

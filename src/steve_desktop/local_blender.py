"""Studio-compatible Blender scenes executed on the desktop, without a cloud kernel."""
import copy
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import HTTPException
from steve_desktop import blender_runtime
from steve_desktop.cad_process import run
from steve_desktop.cad_service import atomic_json
from steve_desktop.cad_live import fingerprint, source
from steve_desktop.paths import RESOURCE_ROOT

RUNTIME = RESOURCE_ROOT / 'vendor' / 'blender'


class BlenderResult:
    def __init__(self, folder, metadata):
        self.folder, self.metadata = Path(folder), metadata

    def inspect(self, entity=None, revision=None):
        if entity:
            objects = self.metadata.get('object_details', {})
            if entity not in objects:
                raise ValueError('No Blender object with that name was found.')
            return {'object': objects[entity]}
        return copy.deepcopy(self.metadata)

    def export(self, format, revision=None, cancel=None):
        names = {'BLEND': 'result.blend', 'GLB': 'preview.glb', 'MP4': 'animation.mp4'}
        name = names.get(format.upper())
        if not name or not (self.folder / name).is_file():
            raise ValueError('This Blender artifact is unavailable. Build in full for .blend and animation export.')
        return {'path': str(self.folder / name), 'format': format.upper()}


class LocalBlender:
    def __init__(self, server):
        self.server = server
        self.root = server.folder.parent / 'runtimes' / 'blender'
        self.runtime = None
        self.error = ''
        self.message = 'Install Blender 4.5 LTS or choose an existing installation.'
        self.install_cancel = threading.Event()
        self.installer = ThreadPoolExecutor(max_workers=1, thread_name_prefix='blender-install')
        self.install_future = None
        self.jobs = threading.Lock()
        # Keep CAD link builds out of the scene queue: a one-core host must not
        # deadlock waiting for a CAD job queued behind its own Blender scene.
        self.scene_jobs = ThreadPoolExecutor(max_workers=1, thread_name_prefix='blender-scene')
        try:
            self.runtime = blender_runtime.discover(self.root, server.state.get('settings', {}).get('blender.path', ''))
        except Exception as exc:
            self.error = str(exc)
        if self.runtime:
            self.message = f"Blender {self.runtime['version']} is ready."

        @server.app.get('/v1/local/blender')
        def status():
            return self.status()

        @server.app.post('/v1/local/blender/{action}')
        def action(action: str, body: dict):
            if action == 'cancel-install':
                self.install_cancel.set()
            elif action == 'configure':
                if self.install_future and not self.install_future.done():
                    raise HTTPException(409, 'Wait for installation to finish or cancel it.')
                try:
                    self.configure(blender_runtime.probe(body.get('path', '')))
                except Exception as exc:
                    raise HTTPException(422, str(exc)) from exc
            elif action == 'install':
                if not self.install_future or self.install_future.done():
                    self.install_cancel.clear()
                    self.install_future = self.installer.submit(self.install)
            elif action == 'open':
                identifier = body.get('build_id')
                entry = server.state['builds'].get(identifier, {})
                if entry.get('kind') != 'blender' or entry.get('status') != 'succeeded':
                    raise HTTPException(422, 'Build a Blender scene first.')
                _, project, _ = server.build_folder(identifier)
                path = project.export('BLEND')['path']
                if not self.runtime:
                    raise HTTPException(422, 'Configure Blender first.')
                # This is the explicit human action to open Blender's native editor.
                subprocess.Popen([self.runtime['path'], '--disable-autoexec', path], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=blender_runtime.environment(),
                                 start_new_session=os.name != 'nt',
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            else:
                raise HTTPException(404, 'Unknown Blender action.')
            return self.status()

    def configure(self, runtime):
        self.runtime = runtime
        self.error = ''
        self.message = f"Blender {runtime['version']} is ready."
        with self.server.lock:
            self.server.state.setdefault('settings', {})['blender.path'] = runtime['path']
            self.server.save()

    def status(self):
        return {'installed': self.runtime is not None, 'runtime': self.runtime,
                'busy': bool(self.install_future and not self.install_future.done()),
                'message': self.message, 'error': self.error}

    def install(self):
        self.error = ''
        try:
            self.configure(blender_runtime.install(self.root, self.install_cancel, lambda message: setattr(self, 'message', message)))
        except Exception as exc:
            self.error = str(exc)

    def links(self, document, cancel):
        links = {}
        for alias, ref in document.get('links', {}).items():
            linked = self.server.revision(ref['document_id'], ref.get('revision'))
            if linked['kind'] not in ('part', 'design'):
                raise ValueError('Blender scenes can link CAD parts and designs only.')
            if ref.get('component'):
                raise ValueError('Link the complete CAD document to Blender; individual component links are not supported yet.')
            resolved_key = fingerprint(self.server.resolve_links(linked))
            with self.server.lock:
                built = next((b for b in reversed(list(self.server.state['builds'].values()))
                              if b['status'] == 'succeeded' and fingerprint(b) == fingerprint(linked)
                              and (not linked.get('links') or b.get('_resolved_fingerprint') == resolved_key)), None)
                if not built:
                    built = self.server.submit({**source(linked), 'mode': 'preview'})
            while built['status'] in ('queued', 'running'):
                if cancel.wait(.1):
                    raise ValueError('Blender build cancelled.')
            if built['status'] != 'succeeded':
                raise ValueError(f"Linked CAD build failed: {built.get('error')}")
            _, _, folder = self.server.build_folder(built['id'])
            path = folder / 'preview.glb'
            with path.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            links[alias] = {'path': path, 'file': digest + '.glb', 'name': linked['name']}
        return links

    def build(self, identifier, cancel):
        entry = self.server.state['builds'][identifier]
        if not self.runtime:
            raise ValueError('Install or configure Blender in Settings → Blender first.')
        runtime = copy.deepcopy(self.runtime)
        mode = entry.get('mode', 'preview')
        if mode not in ('preview', 'full', 'views', 'render', 'save'):
            raise ValueError('Unknown Blender build mode.')
        # Serialize scene processes so simultaneous renders do not oversubscribe CPU/GPU memory.
        while not self.jobs.acquire(timeout=.1):
            if cancel.is_set():
                raise ValueError('Blender build cancelled.')
        try:
            if cancel.is_set():
                raise ValueError('Blender build cancelled.')
            entry.update(status='running', started_at=entry.get('started_at') or time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                         metadata={'progress': {'stage': 'links'}})
            links = self.links(entry, cancel)
            request = {**source(entry), 'links': {a: {'file': v['file'], 'name': v['name']} for a, v in links.items()}}
            if mode == 'views':
                request['look'] = entry.get('look', {})
            runtime_digest = hashlib.sha256(b''.join(p.read_bytes() for p in sorted(RUNTIME.glob('*.py')))).hexdigest()
            key = hashlib.sha256(json.dumps([request, mode, runtime, runtime_digest], sort_keys=True).encode()).hexdigest()
            cache = self.server.folder / 'cache' / 'blender' / key
            staging = self.server.folder / 'builds' / identifier / 'blender'
            if not (cache / 'result.json').is_file():
                staging.mkdir(parents=True, exist_ok=True)
                (staging / 'imports').mkdir(exist_ok=True)
                for linked in links.values():
                    shutil.copyfile(linked['path'], staging / 'imports' / linked['file'])
                atomic_json(staging / 'request.json', request)
                from steve_desktop.cad_worker import WORKER
                threads = max(1, (os.cpu_count() or 1) * WORKER.budget.percent // 100)
                command = [runtime['path'], '--background', '--factory-startup', '--disable-autoexec', '--offline-mode',
                           '-noaudio', '--threads', str(threads), '--python-exit-code', '1',
                           '--python', str(RUNTIME / 'blender_run.py'), '--', mode, '0']
                finished = threading.Event()
                def progress():
                    while not finished.wait(.25):
                        try:
                            value = json.loads((staging / 'progress.json').read_bytes())
                            with self.server.lock:
                                entry['metadata'] = {'progress': value}
                        except (OSError, ValueError):
                            pass
                monitor = threading.Thread(target=progress, daemon=True)
                monitor.start()
                try:
                    with (staging / 'blender.log').open('wb') as log:
                        code = run(command, log, cancel, budget=WORKER.budget, cwd=staging, output_limit=None, external=True)
                finally:
                    finished.set()
                    monitor.join()
                report = json.loads((staging / 'result.json').read_bytes()) if (staging / 'result.json').is_file() else {}
                if code or not report.get('ok'):
                    raise ValueError(report.get('error') or 'Blender exited without a valid result. Check the build log.')
                if cancel.is_set():
                    raise ValueError('Blender build cancelled.')
                cache.parent.mkdir(parents=True, exist_ok=True)
                from steve_desktop.cad_service import rename_when_released
                rename_when_released(staging, cache)
                entry['cached'] = False
            else:
                entry['cached'] = True
            report = json.loads((cache / 'result.json').read_bytes())
            artifacts = {'preview': 'preview.glb', 'blend': 'result.blend', 'animation': 'animation.mp4'}
            artifacts.update({f'view_{view}': f'view-{view}.png' for view in ('isometric', 'top', 'front', 'right', 'camera')})
            entry.update(status='succeeded', metadata=report['metadata'], _revision=key[:12], _blender_cache=key,
                         artifacts={name: f'/v1/builds/{identifier}/artifacts/{name}' for name, file in artifacts.items() if (cache / file).is_file()})
        finally:
            self.jobs.release()
            entry['finished_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            self.server.save()

    def close(self):
        self.install_cancel.set()
        self.scene_jobs.shutdown(wait=True)
        self.installer.shutdown(wait=False, cancel_futures=True)

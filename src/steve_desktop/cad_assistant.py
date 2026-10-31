"""Studio assistant protocol backed by the existing local, encrypted agent sessions.
All controller access is marshalled to Qt's main thread; HTTP never touches widgets.
"""
import asyncio
import copy
import json
import queue
import uuid
from concurrent.futures import Future
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from steve_desktop.chat_images import ChatImages, MAX_BYTES


def now():
    return datetime.now(timezone.utc).isoformat()


from steve_desktop.local_settings import LocalSettings


class LocalAssistant(LocalSettings):
    def __init__(self, window, server):
        self.window, self.server = window, server
        self.commands = queue.Queue()
        self.runs = {}
        self.current = None
        self.panel = window.chat_panel
        self.panel.headless = True
        self.images = ChatImages(self.panel.store.path.parent)
        self.install()

    async def ask(self, operation, *args):
        future = Future()
        self.commands.put((future, operation, args))
        return await asyncio.wait_for(asyncio.wrap_future(future), 15)

    def poll(self):
        for _ in range(30):
            try:
                future, operation, args = self.commands.get_nowait()
            except queue.Empty:
                break
            if future.cancelled():
                continue
            try:
                value = getattr(self, operation)(*args)
                if not future.done():
                    future.set_result(copy.deepcopy(value))
            except Exception as exc:
                if not future.done():
                    future.set_exception(exc)

    def session(self, identifier):
        found = next((s for s in self.panel.sessions if s['id'] == identifier), None)
        if not found:
            raise HTTPException(404, 'Conversation not found')
        return found

    def conversation(self, identifier):
        session = self.session(identifier)
        turns = []
        for message in session['messages']:
            if message['role'] == 'You':
                turns.append({'user': message['text'], 'attachments': message.get('attachments', []), 'assistant': ''})
            elif turns:
                turns[-1]['assistant'] += message['text']
            else:
                turns.append({'user': '', 'assistant': message['text']})
        active = self.current if self.current and self.current['conversation_id'] == identifier and self.current['status'] in ('queued', 'running') else None
        return {'conversation_id': identifier, 'title': session['title'], 'provider': 'openai',
                'created_at': session.get('created_at', now()), 'updated_at': session.get('updated_at', now()),
                'turn_count': len(turns), 'preview': turns[-1]['assistant'][:160] if turns else '',
                'turns': turns, 'settings': {'auto_compact': False, 'planning': False, 'subagents': False},
                'settings_revision': 1, 'plan': [], 'queued': [], 'busy': bool(active),
                'active_run_id': active['run_id'] if active else None}

    def conversations(self, search, offset):
        rows = [self.conversation(s['id']) for s in self.panel.sessions if search.casefold() in s['title'].casefold()]
        return {'conversations': rows[offset:offset+30], 'has_more': len(rows) > offset+30}

    def create(self):
        if self.panel.busy:
            raise HTTPException(409, 'Stop the current run before starting a new conversation.')
        self.panel.new_chat()
        self.panel.active.update(created_at=now(), updated_at=now())
        self.panel.store.save({'chats': self.panel.sessions})
        return self.conversation(self.panel.active['id'])

    def delete(self, identifiers):
        deleted, skipped = [], []
        for identifier in identifiers:
            if self.panel.busy and self.panel.active['id'] == identifier:
                skipped.append({'id': identifier, 'reason': 'Steve is still working.'})
            elif any(s['id'] == identifier for s in self.panel.sessions):
                self.panel.sessions[:] = [s for s in self.panel.sessions if s['id'] != identifier]
                deleted.append(identifier)
        self.panel.store.save({'chats': self.panel.sessions})
        self.panel.reload_chats()
        if self.panel.active and self.panel.active['id'] in deleted:
            self.panel.active = None
            if self.panel.sessions:
                self.panel.select_chat(0)
        return {'deleted': deleted, 'skipped': skipped}

    def config(self):
        models = list(self.panel.model_choices.values())
        default = self.panel.models.currentData() or (models[0].slug if models else '')
        rows = []
        for model in models:
            efforts = [x['effort'] for x in model.supported_reasoning_levels if x.get('effort') in ('none','minimal','low','medium','high','xhigh','max')]
            rows.append({'id': model.slug, 'label': model.display_name, 'default': model.slug == default,
                         'price_per_million': None, 'efforts': efforts})
        return {'providers': [{'id': 'openai', 'model': default, 'configured': bool(models), 'models': rows}],
                'default': 'openai', 'defaults': {'auto_compact': False, 'planning': False, 'subagents': False},
                'preferences': self.server.state.get('assistant_preferences', {'default_model': None}),
                'steering': False, 'stop': True, 'key_storage': 'ready', 'local': True}

    def account(self):
        busy = bool(self.window.worker and self.window.worker.isRunning())
        try:
            connected = self.window.service.signed_in()
        except Exception:
            connected = False
        return {'connected': connected, 'busy': busy,
                'action': self.window.worker.action if busy else None,
                'message': self.window.status.text(),
                'models': self.config()['providers'][0]['models'],
                'agent_busy': self.panel.busy}

    def account_action(self, action):
        if action not in ('login', 'models', 'logout', 'cancel'):
            raise HTTPException(404, 'Unknown account action')
        if action == 'cancel':
            if self.window.worker and self.window.worker.isRunning():
                self.window.cancel_login()
        else:
            if self.panel.busy or self.window.worker and self.window.worker.isRunning():
                raise HTTPException(409, 'Wait for the current operation to finish.')
            self.window.start(action)
        return self.account()

    def preferences(self, body):
        choice = body.get('default_model')
        if choice and (choice.get('provider') != 'openai' or choice.get('model') not in self.panel.model_choices):
            raise HTTPException(422, 'Choose an available subscription model.')
        self.server.state['assistant_preferences'] = {'default_model': choice}
        self.server.save()
        return self.server.state['assistant_preferences']

    def emit(self, run, name, data):
        run['_events'].append((name, data))

    def start(self, body):
        identifier = body.get('request_id') or str(uuid.uuid4())
        if identifier in self.runs:
            return self.public(self.runs[identifier])
        if self.panel.busy:
            raise HTTPException(409, 'Steve is already working. Stop or wait before sending another message.')
        attachments, content = self.images.resolve(body.get('attachments', []))
        message = str(body.get('message', '')).strip()
        if (not message and not attachments) or len(message) > 50000:
            raise HTTPException(422, 'Enter a message or attach an image (up to 50,000 characters).')
        session = self.session(body['conversation_id'])
        model = body.get('model') or self.panel.models.currentData()
        if model not in self.panel.model_choices:
            raise HTTPException(422, 'Select an available subscription model.')
        self.panel.select_chat(self.panel.sessions.index(session))
        self.panel.models.setCurrentIndex(self.panel.models.findData(model))
        effort = body.get('effort') or self.server.state.get('settings', {}).get('assistant.effort')
        effort = None if effort in (None, 'auto') else effort
        index = self.panel.effort.findData(effort)
        if index < 0:
            raise HTTPException(422, 'This model does not offer that effort level.')
        self.panel.effort.setCurrentIndex(index)
        self.panel.composer.setPlainText(message)
        run = {'run_id': identifier, 'conversation_id': session['id'], 'status': 'running',
               'provider': 'openai', 'model': model, 'message': message, 'attachments': attachments, 'result': None, 'error': None,
               'created_at': now(), 'events_url': f'/v1/assistant/runs/{identifier}/events', '_events': [], '_text': ''}
        self.panel.send_message(attachments=attachments, image_content=content)
        if not self.panel.busy:
            raise HTTPException(409, self.panel.state.text())
        self.runs[identifier] = self.current = run
        self.emit(run, 'status', {'status': 'running'})
        worker = self.panel.worker
        worker.delta.connect(lambda delta: self.delta(run, delta))
        worker.activity.connect(lambda value: self.emit(run, 'tool', {'call_id': str(len(run['_events'])), 'name': value, 'status': 'finished', 'agent': 'steve'}))
        worker.completed.connect(lambda result: self.done(run, result))
        worker.failed.connect(lambda error: self.failed(run, error))
        return self.public(run)

    def delta(self, run, delta):
        run['_text'] += delta
        self.emit(run, 'text', {'segment': run['run_id'], 'text': run['_text'], 'agent': 'steve'})

    def done(self, run, result):
        run.update(status='succeeded', result={'conversation_id': run['conversation_id'], 'user': run['message'], 'attachments': run['attachments'], 'assistant': result[0]})
        self.session(run['conversation_id'])['updated_at'] = now()
        self.emit(run, 'done', {})

    def failed(self, run, error):
        run.update(status='stopped' if run.get('stop_requested') else 'failed', error=error)
        # Preserve partial output and the request in history, including after restart.
        session = self.session(run['conversation_id'])
        session['messages'].extend([{'role': 'You', 'text': run['message'], 'attachments': run['attachments']}, {'role': 'Steve', 'text': run['_text'] or error}])
        self.panel.store.save({'chats': self.panel.sessions})
        self.emit(run, run['status'], {})

    @staticmethod
    def public(run):
        return {k: v for k, v in run.items() if not k.startswith('_')}

    def get_run(self, identifier):
        if identifier not in self.runs:
            raise HTTPException(404, 'Run not found')
        return self.public(self.runs[identifier])

    def events(self, identifier, offset):
        self.get_run(identifier)
        return self.runs[identifier]['_events'][offset:]

    def stop(self, identifier):
        run = self.runs.get(identifier)
        if not run:
            raise HTTPException(404, 'Run not found')
        if run['status'] == 'running':
            run['stop_requested'] = True
            self.panel.stop_run()
        return {**self.public(run), 'returned': []}

    def install(self):
        router = APIRouter(prefix='/v1/assistant')
        @router.get('/diagnostics')
        async def diagnostics():
            from steve_desktop.diagnostics import Diagnostics
            log = Diagnostics(self.panel.store.path.parent)
            entries = await asyncio.to_thread(log.read)
            return {'path': str(log.vault.path), 'entries': entries}
        @router.post('/attachments')
        async def upload_image(request: Request, name: str = 'Image'):
            data = bytearray()
            async for chunk in request.stream():
                if len(data) + len(chunk) > MAX_BYTES:
                    raise HTTPException(413, 'Choose an image smaller than 8 MB.')
                data.extend(chunk)
            return await asyncio.to_thread(self.images.save, bytes(data), name)
        @router.get('/attachments/{identifier}')
        @router.get('/attachments/{identifier}/thumbnail')
        async def read_image(identifier: str):
            meta, data = await asyncio.to_thread(self.images.load, identifier)
            return Response(data, media_type=meta['media_type'], headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})
        @router.get('/skills')
        async def skills():
            from steve_desktop.agent_features import Skills, PortableFiles, skill_library_paths
            settings = await self.ask('settings')
            libraries = []
            for index, path in enumerate(skill_library_paths(settings['agent'])):
                try:
                    catalog = await Skills('/', workspace=PortableFiles(path)).load()
                    libraries.append({'path': path, 'bundled': index == 0, 'skills': [{'name': s.name, 'description': s.description} for s in catalog.skills], 'warnings': [s.message for s in catalog.skipped]})
                except Exception:
                    libraries.append({'path': path, 'skills': [], 'warnings': ['Could not load this library. Check its files and permissions.']})
            return libraries
        @router.get('/settings')
        async def settings(): return await self.ask('settings')
        @router.put('/settings/agent')
        async def agent(body: dict): return await self.ask('save_agent', body)
        @router.put('/settings/workspace')
        async def workspace(body: dict): return await self.ask('workspace', body.get('path', ''))
        @router.put('/settings/server')
        async def server(body: dict): return await self.ask('save_server', body)
        @router.post('/settings/server/{name}/{action}')
        async def server_action(name: str, action: str): return await self.ask('server_action', name, action)
        @router.get('/memory')
        async def memory(path: str = 'steve/main/MEMORY.md'):
            from steve_desktop.agent_features import memory_store
            store = memory_store(self.window.agent_settings.directory)
            entry = await store.read(path, max_chars=65536)
            paths = await store.list_paths(limit=1000)
            return {'path': path, 'paths': sorted(set(paths + ['steve/main/MEMORY.md'])), 'content': entry.content if entry else '', 'version': entry.version if entry else None}
        @router.put('/memory')
        async def write_memory(body: dict):
            from steve_desktop.agent_features import memory_store
            if not isinstance(body.get('content'), str) or len(body['content'])>65536: raise HTTPException(422, 'Note exceeds 65,536 characters.')
            try:
                result = await memory_store(self.window.agent_settings.directory).write(body['path'], body['content'], expected_version=body.get('version'))
            except Exception: raise HTTPException(409, 'Note changed or could not be saved. Reload before editing again.') from None
            return {'version':result.version}
        @router.get('/account')
        async def account(): return await self.ask('account')
        @router.post('/account/{action}')
        async def account_action(action: str): return await self.ask('account_action', action)
        @router.get('/config')
        async def config(): return await self.ask('config')
        @router.put('/preferences')
        async def preferences(body: dict): return await self.ask('preferences', body)
        @router.get('/conversations')
        async def conversations(search: str = '', offset: int = 0): return await self.ask('conversations', search, max(0, offset))
        @router.post('/conversations')
        async def create(): return await self.ask('create')
        @router.post('/conversations/delete')
        async def delete_many(body: dict): return await self.ask('delete', body.get('ids', []))
        @router.get('/conversations/{identifier}')
        async def conversation(identifier: str): return await self.ask('conversation', identifier)
        @router.delete('/conversations/{identifier}')
        async def delete(identifier: str):
            result = await self.ask('delete', [identifier])
            if result['skipped']: raise HTTPException(409, result['skipped'][0]['reason'])
            return None
        @router.post('/runs')
        async def start(body: dict): return await self.ask('start', body)
        @router.get('/runs/{identifier}')
        async def status(identifier: str): return await self.ask('get_run', identifier)
        @router.post('/runs/{identifier}/cancel')
        async def stop(identifier: str): return await self.ask('stop', identifier)
        @router.get('/runs/{identifier}/events')
        async def events(identifier: str, request: Request):
            await self.ask('get_run', identifier)
            async def stream():
                offset = 0
                while not await request.is_disconnected():
                    batch = await self.ask('events', identifier, offset)
                    for name, data in batch:
                        offset += 1
                        yield f'id: {offset}\nevent: {name}\ndata: {json.dumps(data)}\n\n'
                        if name in ('done', 'failed', 'stopped'): return
                    if not batch: yield ': heartbeat\n\n'
                    await asyncio.sleep(.1)
            return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})
        # Insert API routes ahead of the frontend's catch-all static mount.
        mount = self.server.app.router.routes.pop()
        self.server.app.include_router(router)
        self.server.app.router.routes.append(mount)

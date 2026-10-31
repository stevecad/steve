"""Local document/library organization, with Studio's folder contract."""
import uuid
from fastapi import HTTPException


def install(server):
    app = server.app
    folders = server.state.setdefault('folders', {})

    def path(identifier):
        parts, seen = [], set()
        while identifier:
            if identifier in seen or identifier not in folders or len(seen) >= 16:
                raise ValueError('Invalid folder hierarchy.')
            seen.add(identifier)
            folder = folders[identifier]
            parts.insert(0, folder['name'])
            identifier = folder['parent_id']
        return '/'.join(parts) or None

    def refresh():
        for doc in server.state['documents'].values():
            doc['folder_path'] = path(doc.get('folder_id'))
        server.save()

    @app.get('/v1/folders')
    def listing():
        return {'folders': list(folders.values()), 'max_depth': 16}

    @app.post('/v1/folders')
    def create(body: dict):
        from steve_desktop.cad_server import now
        name = str(body.get('name', '')).strip()
        if not name or len(name) > 120:
            raise ValueError('Choose a folder name between 1 and 120 characters.')
        parent = body.get('parent_id')
        path(parent)
        record = {'id': str(uuid.uuid4()), 'name': name, 'parent_id': parent, 'library': False, 'created_at': now()}
        with server.lock:
            folders[record['id']] = record
            refresh()
        return record

    @app.post('/v1/folders/{identifier}')
    def update(identifier: str, body: dict):
        with server.lock:
            if identifier not in folders:
                raise HTTPException(404, 'Folder not found')
            original = folders[identifier]
            changed = {**original, **{k: v for k, v in body.items() if k in ('name', 'parent_id', 'library')}}
            if not isinstance(changed['name'], str) or not changed['name'].strip():
                raise ValueError('Folder name is required.')
            folders[identifier] = changed
            try:
                for key in folders:
                    path(key)
            except ValueError:
                folders[identifier] = original
                raise
            refresh()
            return changed

    @app.post('/v1/documents/{identifier}/folder')
    def place(identifier: str, body: dict):
        with server.lock:
            doc = server.state['documents'].get(identifier)
            if not doc:
                raise HTTPException(404, 'Document not found')
            folder = body.get('folder_id')
            doc.update(folder_id=folder, folder_path=path(folder))
            server.save()
            return {'document_id': identifier, 'folder_id': folder, 'folder_path': doc['folder_path']}

    @app.delete('/v1/folders/{identifier}')
    def remove(identifier: str, contents: str = ''):
        with server.lock:
            folder = folders.get(identifier)
            if not folder:
                raise HTTPException(404, 'Folder not found')
            children = [f for f in folders.values() if f['parent_id'] == identifier]
            docs = [d for d in server.state['documents'].values() if d.get('folder_id') == identifier]
            if (children or docs) and contents != 'up':
                raise HTTPException(409, 'Folder contains documents or subfolders.')
            for child in children:
                child['parent_id'] = folder['parent_id']
            for doc in docs:
                doc['folder_id'] = folder['parent_id']
            del folders[identifier]
            refresh()
            return {'deleted': identifier, 'folders': len(children), 'documents': len(docs)}

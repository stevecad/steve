"""Local document revisions and source packages using Studio's HTTP contracts."""
import copy
from fastapi import HTTPException


def install(server):
    app = server.app

    @app.get('/v1/documents/{identifier}/package')
    def package(identifier: str, revision: int | None = None):
        documents, seen = [], set()

        def visit(doc):
            key = (doc['id'], doc['revision'])
            if key in seen:
                return
            seen.add(key)
            documents.append({**doc, 'document_id': doc['id']})
            for ref in doc.get('links', {}).values():
                visit(server.revision(ref['document_id'], ref['revision']))
        with server.lock:
            visit(server.revision(identifier, revision))
        return {'documents': documents}

    @app.get('/v1/documents/{identifier}/history')
    def history(identifier: str):
        with server.lock:
            documents = [*server.state.get('history', {}).get(identifier, []), server.revision(identifier)]
            return {'document_id': identifier, 'revisions': [
                {'event_id': d['revision'], 'revision': d['revision'], 'recorded_at': d['updated_at'], 'commit_id': str(d['revision']),
                 'message': d.get('message'), 'preview_build_id': server.matching_preview(d, d.get('preview_build_id'))}
                for d in reversed(documents)]}

    @app.get('/v1/documents/{identifier}/history/{commit}')
    def historical(identifier: str, commit: int):
        return {'commit_id': str(commit), 'document': server.revision(identifier, commit)}

    @app.post('/v1/documents/{identifier}/history/restore')
    def restore(identifier: str, body: dict):
        if body.get('branch', 'main') != 'main':
            raise HTTPException(422, 'This local document has only a main revision history.')
        with server.lock:
            previous = server.revision(identifier, int(body['commit_id']))
            previous['revision'] = body['revision']
            previous['message'] = f"Restored revision {body['commit_id']}"
            doc = server.update_document(identifier, previous)
            build = server.state['builds'].get(doc.get('preview_build_id'))
            if build is None:
                build = server.submit(doc)
            return {'document': doc, 'model': build, 'restored_from': body['commit_id']}

    def references(identifier):
        designs = [{'id': d['id'], 'name': d['name'], 'trashed': bool(d.get('deleted_at')), 'branches': []}
                   for d in server.state['documents'].values()
                   if any(ref.get('document_id') == identifier for ref in d.get('links', {}).values())]
        return {'designs': designs, 'studies': [], 'programs': [], 'count': len(designs),
                'used_by': f'Used by {len(designs)} designs' if designs else ''}

    @app.get('/v1/documents/{identifier}/references')
    def read_references(identifier: str):
        return references(identifier)

    @app.post('/v1/trash')
    def trash(body: dict):
        from steve_desktop.cad_server import now
        moved, skipped = [], []
        with server.lock:
            for identifier in body.get('ids', []):
                doc = server.state['documents'].get(identifier)
                if not doc or doc.get('deleted_at'):
                    skipped.append({'id': identifier, 'reason': 'Document not found or already in Trash.'})
                    continue
                doc.update(deleted_at=now(), deleted_by='Local')
                moved.append({'document': copy.deepcopy(doc), 'used_by': references(identifier)['used_by']})
            server.save()
        return {'moved': moved, 'skipped': skipped}

    @app.get('/v1/trash')
    def list_trash():
        return {'retention_days': None, 'documents': [
            {**d, 'purge_at': None, 'references': references(d['id']), 'used_by': references(d['id'])['used_by']}
            for d in server.state['documents'].values() if d.get('deleted_at')]}

    @app.post('/v1/trash/restore')
    def untrash(body: dict):
        restored, skipped = [], []
        with server.lock:
            for identifier in body.get('ids', []):
                doc = server.state['documents'].get(identifier)
                if not doc or not doc.get('deleted_at'):
                    skipped.append({'id': identifier, 'reason': 'Document is not in Trash.'})
                    continue
                doc.pop('deleted_at', None)
                doc.pop('deleted_by', None)
                restored.append(copy.deepcopy(doc))
            server.save()
        return {'restored': restored, 'skipped': skipped}

"""One document boundary for human and agent edits in the local Studio viewport."""
import copy
import hashlib
import json
import threading
import time
from pathlib import Path
from steve_desktop.cad_document import FORMAT_HELP, change_parameters, validate

SERVERS = {}


def source(doc):
    return {k: doc.get(k, {} if k in ('files', 'links') else '') for k in ('name', 'kind', 'code', 'files', 'links')}


def fingerprint(doc):
    return hashlib.sha256(json.dumps(source(doc), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class LiveProject:
    def __init__(self, server):
        self.server = server
        self.folder = server.folder

    def read(self):
        with self.server.lock:
            context = copy.deepcopy(self.server.context)
        doc = context.get('document')
        return {'revision': fingerprint(doc) if doc else None, 'document': doc,
                'selection': context.get('selection', []), 'build_id': context.get('build_id'), 'format': FORMAT_HELP}

    def built(self):
        context = self.read()
        identifier = context.get('build_id')
        if not identifier:
            raise ValueError('The open document has no successful build yet.')
        entry, project, folder = self.server.build_folder(identifier)
        if fingerprint(entry) != context['revision']:
            raise ValueError('The source has unbuilt changes. Build it before inspecting or exporting.')
        return context, entry, project, folder

    def inspect(self, entity=None, expected_revision=None):
        context, entry, project, _ = self.built()
        if expected_revision and expected_revision != context['revision']:
            raise ValueError('The document changed. Read it again before inspecting.')
        result = project.inspect(entity, entry['_revision'])
        result.update(revision=context['revision'], selection=context['selection'], build_id=entry['id'])
        return result

    def build(self, document, expected_revision=None, message='Steve updated the model', cancel=None):
        document = copy.deepcopy(validate(document))
        with self.server.lock:
            before = self.read()
            if self.server.pending or expected_revision != before['revision']:
                raise ValueError('The open document changed or is still updating. Read it again before editing.')
            expected_document = before['document']
            entry = self.server.submit(document)
        while entry['status'] in ('queued', 'running'):
            if cancel and cancel.is_set():
                self.server.cancellations[entry['id']].set()
                raise ValueError('Build cancelled.')
            time.sleep(.05)
        if entry['status'] != 'succeeded':
            raise ValueError(entry.get('error') or 'Build failed.')
        with self.server.lock:
            if self.read()['revision'] != expected_revision or self.server.pending:
                raise ValueError('A human edited the document during the build. Their changes were preserved; read again to reconcile.')
            doc_id = self.server.context.get('document_id')
            existing = self.server.state['documents'].get(doc_id)
            if existing:
                doc = self.server.update_document(doc_id, {**document, 'revision': existing['revision'], 'preview_build_id': entry['id']})
            else:
                doc = self.server.create_document({**document, 'preview_build_id': entry['id']})
            self.server.event_version += 1
            self.server.pending = {'version': self.server.event_version, 'expected': expected_document, 'document': copy.deepcopy(doc), 'build': copy.deepcopy(entry)}
            self.server.context.update(document=source(doc), document_id=doc['id'], build_id=entry['id'], selection=[])
            self.server.save()
        result = self.inspect()
        result['message'] = message
        return result

    def parameters(self, values, expected_revision, cancel=None):
        current = self.read()
        if not current['document']:
            raise ValueError('Open or create a CAD document first.')
        return self.build(change_parameters(current['document'], values), expected_revision, 'Parameters updated', cancel)

    def export(self, kind='STEP', expected_revision=None, cancel=None):
        context, entry, project, _ = self.built()
        if expected_revision != context['revision']:
            raise ValueError('Read the current document before exporting.')
        if entry.get('kind') == 'blender' and kind.upper() in ('BLEND', 'MP4') and not entry.get('artifacts', {}).get('blend' if kind.upper() == 'BLEND' else 'animation'):
            entry = self.server.submit({**source(entry), 'mode': 'save' if kind.upper() == 'BLEND' else 'full'})
            while entry['status'] in ('queued', 'running'):
                if cancel and cancel.is_set():
                    self.server.cancellations[entry['id']].set()
                    raise ValueError('Export cancelled.')
                time.sleep(.1)
            if entry['status'] != 'succeeded':
                raise ValueError(entry.get('error') or 'Blender export failed.')
            _, project, _ = self.server.build_folder(entry['id'])
        result = project.export(kind, entry['_revision'], cancel)
        result['revision'] = context['revision']
        return result

    def state(self):
        doc_id = self.server.context.get('document_id')
        return {'document_id': doc_id, 'revision': self.read()['revision'],
                'revisions': copy.deepcopy(self.server.state.get('history', {}).get(doc_id, []))}

    def restore(self, revision):
        history = self.state()['revisions']
        doc = next((d for d in history if str(d['revision']) == str(revision)), None)
        if not doc:
            raise ValueError('Saved document revision not found.')
        return self.build(source(doc), self.read()['revision'], 'Restored revision ' + str(revision))

    def import_package(self, documents, from_studio=True):
        """Import MCP-returned source packages; remap pinned links as one transaction."""
        import uuid
        if not documents or len(documents) > 100:
            raise ValueError('Provide a root document and at most 99 linked documents.')
        documents = copy.deepcopy(documents)
        keys = [(d.get('document_id') or d.get('id'), d.get('revision')) for d in documents]
        if len(set(keys)) != len(keys):
            raise ValueError('Duplicate document revisions in package.')
        mapping = {key: str(uuid.uuid4()) for key in keys}
        prepared = []
        for key, doc in zip(keys, documents):
            validate(doc)
            links = {}
            for alias, ref in doc.get('links', {}).items():
                target = (ref['document_id'], ref['revision'])
                if target not in mapping:
                    raise ValueError('The package is missing a pinned linked revision. Fetch the complete Studio package first.')
                links[alias] = {**ref, 'document_id': mapping[target], 'revision': 1}
            prepared.append((key, {**source(doc), 'links': links, 'studio_origin': doc.get('studio_origin') or ({'document_id': key[0], 'revision': key[1]} if from_studio else None)}))
        from steve_desktop.cad_server import now
        from steve_desktop.cad_service import CadProject
        with self.server.lock:
            for key, doc in prepared:
                identifier = mapping[key]
                CadProject.create(self.folder / 'documents' / identifier, doc['name'])
                self.server.state['documents'][identifier] = {**doc, 'id': identifier, 'revision': 1,
                    'created_at': now(), 'updated_at': now(), 'preview_build_id': None, 'folder_id': None,
                    'folder_path': None, 'branch_count': 0}
            self.server.save()
        return {'root': copy.deepcopy(self.server.state['documents'][mapping[keys[0]]]), 'imported': len(prepared),
                'message': 'Source imported locally. Use cad_build with this root to build and display it locally.'}

    def package(self):
        current = self.read()
        if not current['document']:
            return current
        collected, seen = [], set()
        def visit(doc, identifier=None, revision=None):
            key = (identifier, revision)
            if key in seen:
                return
            seen.add(key)
            collected.append({**source(doc), 'document_id': identifier, 'revision': revision,
                              'studio_origin': doc.get('studio_origin')})
            for ref in doc.get('links', {}).values():
                linked = self.server.revision(ref['document_id'], ref['revision'])
                visit(linked, linked['id'], linked['revision'])
        with self.server.lock:
            identifier = self.server.context.get('document_id')
            saved = self.server.state['documents'].get(identifier, {})
            visit({**saved, **current['document']}, identifier, saved.get('revision'))
        return {'documents': collected, 'source_revision': current['revision'],
                'message': 'Current local source. Publish through the configured Studio MCP only when requested; remap linked document IDs and pin returned remote revisions.'}


def project_for_tools(folder):
    from steve_desktop.cad_service import CadProject
    server = SERVERS.get(str(Path(folder).resolve()))
    return LiveProject(server) if server else CadProject(folder)

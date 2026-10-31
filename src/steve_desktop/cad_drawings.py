"""Local product drawing packages, with the same CAD PDF merger as Studio."""
import hashlib
import re
import uuid
from fastapi import HTTPException
from fastapi.responses import FileResponse
from steve_desktop.cad_pdf import merge


def install(server):
    @server.app.post('/v1/product-drawings')
    def merge_builds(body: dict):
        ids = body.get('build_ids')
        if not isinstance(ids, list) or not 1 <= len(ids) <= 200 or any(not isinstance(value, str) for value in ids):
            raise HTTPException(422, 'Choose between 1 and 200 builds.')
        pdfs = []
        for identifier in ids:
            entry, _, folder = server.build_folder(identifier)
            path = folder / 'drawings.pdf'
            if not entry.get('artifacts', {}).get('drawings_pdf') or not path.is_file():
                raise HTTPException(409, 'A build has no PDF of its drawing sheets.')
            pdfs.append(path.read_bytes())
        merged = merge(pdfs)
        sha = hashlib.sha256(merged).hexdigest()
        folder = server.folder / 'product-drawings'
        folder.mkdir(exist_ok=True)
        pending = folder / (uuid.uuid4().hex + '.tmp')
        try:
            pending.write_bytes(merged)
            pending.replace(folder / (sha + '.pdf'))
        finally:
            pending.unlink(missing_ok=True)
        return {'url': f'/v1/product-drawings/{sha}', 'pages': merged.count(b'/Type /Page /Parent'), 'bytes': len(merged)}

    @server.app.get('/v1/product-drawings/{sha}')
    def download(sha: str, name: str = 'product'):
        if not re.fullmatch(r'[a-f0-9]{64}', sha):
            raise HTTPException(404, 'Drawing package not found.')
        path = server.folder / 'product-drawings' / (sha + '.pdf')
        if not path.is_file():
            raise HTTPException(404, 'Drawing package not found.')
        stem = re.sub(r'[^A-Za-z0-9._-]+', '_', name).strip('_.')[:80] or 'product'
        return FileResponse(path, media_type='application/pdf', filename=stem + '-drawings.pdf')

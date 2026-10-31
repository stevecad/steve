"""Content-addressed STEP/Fusion imports, checked by the local upstream kernel."""
import hashlib
import json
from pathlib import Path
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from steve_desktop.cad_service import CadProject

MAX_BYTES = 200 * 1024 * 1024


async def uploaded_file(request, suffixes=('.step', '.stp', '.f3d')):
    form = await request.form(max_files=1, max_fields=0, max_part_size=MAX_BYTES)
    try:
        file = form.get('file')
        if not hasattr(file, 'read'):
            raise HTTPException(422, 'Choose a CAD file.')
        filename = Path((file.filename or 'import.step').replace('\\', '/')).name
        if Path(filename).suffix.lower() not in suffixes:
            raise HTTPException(415, 'Choose ' + ', '.join(suffixes) + '.')
        data = await file.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            raise HTTPException(413, 'Import must be between 1 byte and 200 MB.')
        return filename, data
    finally:
        await form.close()


def install(server):
    app = server.app
    root = server.folder / 'imports'
    root.mkdir(exist_ok=True)

    def inspect_import(record):
        try:
            folder = root / record['id']
            project = CadProject(folder) if folder.exists() else CadProject.create(folder, record['name'])
            project.run_kernel(['inspect-import', root / (record['sha256'] + '.step'), project.folder / 'import.json'])
            report = json.loads((project.folder / 'import.json').read_text(encoding='utf-8'))
            record.update(report, status='ready')
        except Exception as exc:
            record.update(status='failed', error=str(exc))
        finally:
            server.save()

    def register(filename, data):
        from steve_desktop.cad_server import now
        if not data or len(data) > MAX_BYTES:
            raise HTTPException(413, 'Import must be between 1 byte and 200 MB.')
        sha = hashlib.sha256(data).hexdigest()
        with server.lock:
            records = server.state.setdefault('imports', {})
            if sha in records and records[sha]['status'] != 'failed' and (root / (sha + '.step')).exists():
                return records[sha]
            (root / (sha + '.step')).write_bytes(data)
            code = f'from steve import Model\n\nmodel = Model()\nmodel.import_step("imported", "{sha}")\nresult = model.result()\n'
            record = {'id': sha, 'sha256': sha, 'filename': filename, 'name': Path(filename).stem,
                      'size': len(data), 'status': 'validating', 'error': None, 'solids': None, 'faces': None,
                      'bounds_mm': None, 'volume_mm3': None, 'solid_names': [], 'build_id': None,
                      'part_code': code, 'created_at': now(), 'url': f'/v1/imports/{sha}/file'}
            records[sha] = record
            server.save()
            server.executor.submit(inspect_import, record)
        return record

    server.register_import = register

    @app.post('/v1/imports', status_code=202)
    async def upload(request: Request):
        filename, data = await uploaded_file(request)
        return register(filename, data)

    @app.get('/v1/imports/{identifier}')
    def read(identifier: str):
        record = server.state.get('imports', {}).get(identifier)
        if not record:
            raise HTTPException(404, 'Import not found')
        return record

    @app.get('/v1/imports/{identifier}/file')
    def download(identifier: str):
        record = read(identifier)
        return FileResponse(root / (record['sha256'] + '.step'), filename=record['filename'])

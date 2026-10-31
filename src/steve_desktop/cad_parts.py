"""Local storage for Studio's Standard Parts and McMaster dialogs.

Public catalog lookup is online; original STEP bytes and validation remain local.
No Studio account, database, hosted build, or McMaster scraping is involved.
"""
import hashlib
import io
import re
import threading
import zipfile
import zlib
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from steve_desktop.cad_imports import MAX_BYTES, uploaded_file
from steve_desktop import cad_catalog as catalog
from steve_desktop import cad_vendor as vendor


def step_bytes(data):
    if not data.lstrip(b'\xef\xbb\xbf \t\r\n').startswith(b'ISO-10303-21;'):
        raise HTTPException(415, 'That file is not a STEP file (ISO-10303-21).')
    return data


def unpack_step(filename, data):
    if not filename.lower().endswith('.zip'):
        return filename, step_bytes(data)
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = [m for m in archive.infolist() if not m.is_dir() and m.filename.lower().endswith(('.step', '.stp'))]
            if not members:
                raise HTTPException(422, 'This ZIP contains no STEP file. Choose 3-D STEP on McMaster.')
            member = max(members, key=lambda m: m.file_size)
            if member.file_size > MAX_BYTES:
                raise HTTPException(413, 'The STEP file exceeds 200 MB.')
            if member.file_size > 16 * 1024 * 1024 and member.file_size > 100 * max(1, member.compress_size):
                raise HTTPException(422, 'Unusually large ZIP expansion. Import the STEP file directly.')
            with archive.open(member) as stream:
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES or len(data) != member.file_size:
                raise HTTPException(413, 'The expanded STEP file is too large or has an invalid size.')
            # Never extract archive paths to disk.
            return Path(member.filename.replace('\\', '/')).name, step_bytes(data)
    except (zipfile.BadZipFile, zlib.error, EOFError, RuntimeError, NotImplementedError):
        raise HTTPException(422, 'This ZIP could not be read. Import the STEP file directly.') from None


def fetch_bytes(url, hosts, limit):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in hosts or parsed.port not in (None, 443) or parsed.username or parsed.password:
        raise HTTPException(422, 'The catalog download is not on an approved source host.')
    try:
        with catalog.client().stream('GET', url) as response:
            if response.status_code != 200:
                raise HTTPException(503, f'The catalog download failed ({response.status_code}).')
            data = bytearray()
            for chunk in response.iter_bytes(65536):
                data.extend(chunk)
                if len(data) > limit:
                    raise HTTPException(413, 'The catalog download exceeds the size limit.')
            return bytes(data)
    except httpx.TransportError:
        raise HTTPException(503, catalog.UNAVAILABLE) from None


class PartsLibrary:
    def __init__(self, server):
        self.server = server
        self.lock = threading.RLock()
        self.images = server.folder / 'catalog-images'
        self.images.mkdir(exist_ok=True)

    def compact(self, item):
        result = catalog.compact(item)
        if result['thumbnail']:
            key = hashlib.sha256(result['thumbnail'].encode()).hexdigest()
            with self.server.lock:
                self.server.state.setdefault('catalog_images', {})[key] = result['thumbnail']
            result['thumbnail'] = f'/v1/standard-parts/images/{key}'
        return result

    def standard_search(self, **kwargs):
        # Upstream search compacts items; proxy its thumbnails through this local server.
        result = catalog.search(**kwargs)
        with self.server.lock:
            for item in result['items']:
                if item.get('thumbnail'):
                    key = hashlib.sha256(item['thumbnail'].encode()).hexdigest()
                    self.server.state.setdefault('catalog_images', {})[key] = item['thumbnail']
                    item['thumbnail'] = f'/v1/standard-parts/images/{key}'
            self.server.save()
        return result

    def standard_import(self, part_id):
        # A previously imported catalog part remains available offline, pinned to its stored SHA.
        with self.lock:
            item = self.server.state.get('standard_parts', {}).get(part_id)
            if not item:
                item = catalog.part(part_id)
            sha = str(item.get('sha256', '')).lower()
            if not re.fullmatch('[0-9a-f]{64}', sha):
                raise HTTPException(422, 'The catalog did not provide a valid STEP checksum.')
            record = self.server.state.get('imports', {}).get(sha)
            path = self.server.folder / 'imports' / (sha + '.step')
            if not record or record['status'] == 'failed' or not path.exists():
                data = step_bytes(fetch_bytes(item.get('stepUrl', ''), catalog.DOWNLOAD_HOSTS, MAX_BYTES))
                if hashlib.sha256(data).hexdigest() != sha:
                    raise HTTPException(422, 'The downloaded STEP does not match the catalog checksum; it was not imported.')
                name = re.sub(r'[^\w .-]', '_', item.get('name') or part_id)[:120] + '.step'
                record = self.server.register_import(name, data)
            with self.server.lock:
                self.server.state.setdefault('standard_parts', {})[part_id] = item
                self.server.save()
            return {**record, 'standard_part': {**self.compact(item), 'provenance': catalog.provenance(item)}}

    def public_mcmaster(self, item):
        record = self.server.state.get('imports', {}).get(item['sha256'], {})
        return {**item, 'status': record.get('status'), 'solids': record.get('solids'), 'bounds_mm': record.get('bounds_mm'),
                'provenance': vendor.provenance(item['part_number'], item['title'], item['sha256'], item['first_used'][:10])}

    def mcmaster_list(self, search=''):
        with self.server.lock:
            items = sorted(self.server.state.get('mcmaster_parts', {}).values(), key=lambda p: p['last_used'], reverse=True)
            return {'parts': [self.public_mcmaster(p) for p in items if all(w in (p['part_number']+' '+p['title']).lower() for w in search.lower().split())],
                    'catalog': 'https://www.mcmaster.com/'}

    def mcmaster_get(self, number, use=False):
        from steve_desktop.cad_server import now
        number = vendor.normalize_part_number(number)
        with self.server.lock:
            item = self.server.state.get('mcmaster_parts', {}).get(number)
            record = self.server.state.get('imports', {}).get(item['sha256']) if item else None
            if not record:
                raise HTTPException(404, 'Download this part’s 3-D STEP from McMaster and import it first.')
            if use:
                item['last_used'] = now()
                self.server.save()
            return {**record, 'mcmaster': self.public_mcmaster(item)}

    def mcmaster_upload(self, filename, data, part_number='', title=''):
        from steve_desktop.cad_server import now
        original = filename
        filename, data = unpack_step(filename, data)
        number = vendor.normalize_part_number(part_number) or vendor.part_number_from_filename(filename) or vendor.part_number_from_filename(original)
        if not vendor.PART_NUMBER_RE.fullmatch(number):
            raise HTTPException(422, 'Enter the McMaster-Carr part number (for example 91251A540).')
        title = ' '.join(title.split())[:120] or vendor.catalog_description(number, filename)
        record = self.server.register_import(filename, data)
        with self.server.lock:
            records = self.server.state.setdefault('mcmaster_parts', {})
            previous = records.get(number, {})
            records[number] = {'part_number': number, 'title': title, 'sha256': record['sha256'], 'filename': filename,
                               'url': vendor.product_url(number), 'first_used': previous.get('first_used', now()), 'last_used': now()}
            self.server.save()
            return {**record, 'mcmaster': self.public_mcmaster(records[number])}


def checked(call):
    try:
        return call()
    except LookupError:
        raise HTTPException(404, 'This part is not in the step.parts catalog.') from None
    except catalog.Unavailable as exc:
        raise HTTPException(503, str(exc)) from None


def install(server):
    app = server.app
    library = server.parts = PartsLibrary(server)

    @app.get('/v1/standard-parts')
    def search(q: str = '', category: list[str] = Query(default=[]), family: list[str] = Query(default=[]),
               standard: list[str] = Query(default=[]), tag: list[str] = Query(default=[]), page: int = 1, page_size: int = 24):
        return checked(lambda: library.standard_search(query=q, category=category, family=family, standard=standard, tag=tag, page=page, page_size=page_size))

    @app.get('/v1/standard-parts/images/{key}')
    def image(key: str):
        url = server.state.get('catalog_images', {}).get(key)
        if not re.fullmatch('[0-9a-f]{64}', key) or not url:
            raise HTTPException(404, 'Catalog image not found.')
        path = library.images / (key + '.png')
        if not path.exists():
            data = fetch_bytes(url, {catalog.IMAGE_HOST}, 8 * 1024 * 1024)
            if not data.startswith(b'\x89PNG\r\n\x1a\n'):
                raise HTTPException(415, 'Catalog thumbnail is not a PNG image.')
            with library.lock:
                temporary = path.with_suffix('.tmp')
                temporary.write_bytes(data)
                temporary.replace(path)
        return FileResponse(path, media_type='image/png', headers={'Cache-Control': 'private, max-age=86400'})

    @app.get('/v1/standard-parts/{part_id}')
    def part(part_id: str):
        result = checked(lambda: library.compact(catalog.part(part_id)))
        server.save()
        return result

    @app.post('/v1/standard-parts/{part_id}/import')
    def standard_import(part_id: str):
        body = checked(lambda: library.standard_import(part_id))
        return JSONResponse(body, status_code=202 if body['status'] == 'validating' else 201)

    @app.get('/v1/vendor-parts/mcmaster')
    def mcmaster_list(search: str = ''):
        return library.mcmaster_list(search)

    @app.get('/v1/vendor-parts/mcmaster/{number}')
    def mcmaster_get(number: str):
        return library.mcmaster_get(number)

    @app.post('/v1/vendor-parts/mcmaster/{number}/use')
    def mcmaster_use(number: str):
        return library.mcmaster_get(number, use=True)

    @app.post('/v1/vendor-parts/mcmaster')
    async def mcmaster_upload(request: Request, part_number: str = '', title: str = Query(default='', max_length=200)):
        import asyncio
        filename, data = await uploaded_file(request, ('.step', '.stp', '.zip'))
        body = await asyncio.to_thread(library.mcmaster_upload, filename, data, part_number, title)
        return JSONResponse(body, status_code=202 if body['status'] == 'validating' else 201)

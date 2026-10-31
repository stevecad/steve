import asyncio
import hashlib
import re
from pathlib import Path
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse
from steve_desktop.cad_service import atomic_json
from steve_desktop.cad_image_normalize import normalize


def install(server):
    app = server.app
    folder = server.folder / 'decal-images'
    folder.mkdir(exist_ok=True)
    def get(identifier):
        if not re.fullmatch(r'img_[0-9a-f]{12}', identifier):
            raise HTTPException(404, 'Image not found')
        item = server.state.get('decal_images', {}).get(identifier)
        if not item: raise HTTPException(404, 'Image not found')
        return item
    @app.post('/v1/decal-images', status_code=201)
    async def upload(request: Request, name: str = ''):
        kind = request.headers.get('content-type', '').split(';')[0].strip()
        if kind not in ('image/png', 'image/jpeg', 'image/webp'):
            raise HTTPException(415, 'Upload PNG, JPEG or WebP.')
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8_000_000: raise HTTPException(413, 'Image must be at most 8 MB.')
        if not raw: raise HTTPException(422, 'Image is empty.')
        data, media_type, width, height, thumb = await asyncio.to_thread(normalize, bytes(raw))
        identifier = 'img_' + hashlib.sha256(data).hexdigest()[:12]
        with server.lock:
            images = server.state.setdefault('decal_images', {})
            if identifier in images: return images[identifier]
            metadata = {'id': identifier, 'name': ' '.join(name.split())[:200] or 'Decal image',
                        'media_type': media_type, 'width': width, 'height': height, 'size': len(data),
                        'url': f'/v1/decal-images/{identifier}', 'thumbnail_url': f'/v1/decal-images/{identifier}/thumbnail'}
            for suffix, contents in (('.image', data), ('.webp', thumb)):
                path = folder / (identifier + suffix)
                temporary = path.with_suffix('.tmp')
                temporary.write_bytes(contents)
                temporary.replace(path)
            images[identifier] = metadata
            server.save()
            return metadata
    @app.get('/v1/decal-images')
    def images():
        with server.lock: return {'images': list(reversed(list(server.state.get('decal_images', {}).values())))}
    @app.get('/v1/decal-images/{identifier}')
    def image(identifier: str):
        item = get(identifier)
        return FileResponse(folder/(identifier+'.image'), media_type=item['media_type'], headers={'X-Content-Type-Options':'nosniff'})
    @app.get('/v1/decal-images/{identifier}/thumbnail')
    def thumbnail(identifier: str):
        get(identifier)
        return FileResponse(folder/(identifier+'.webp'), media_type='image/webp', headers={'X-Content-Type-Options':'nosniff'})

"""Validated, encrypted local image attachments for Steve conversations."""
import base64
import io
import re
import uuid
import warnings
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic_ai.messages import BinaryContent
from steve_desktop.vault import Vault

MAX_BYTES = 8 * 1024 * 1024
MAX_IMAGES = 4


class ChatImages:
    def __init__(self, directory):
        self.directory = Path(directory) / 'chat-images'

    def vault(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-f0-9]{32}', identifier):
            raise HTTPException(404, 'Image attachment not found.')
        return Vault(self.directory / (identifier + '.dpapi'))

    def save(self, data, name):
        if not data or len(data) > MAX_BYTES:
            raise HTTPException(413, 'Choose an image smaller than 8 MB.')
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as original:
                    if original.format not in ('PNG', 'JPEG', 'WEBP', 'GIF'):
                        raise ValueError('Unsupported image format')
                    if original.width * original.height > 25_000_000:
                        raise ValueError('Image dimensions exceed 25 megapixels')
                    original.seek(0)
                    image = ImageOps.exif_transpose(original).convert('RGBA')
                    image.thumbnail((1568, 1568), Image.Resampling.LANCZOS)
                    clean = Image.new('RGBA', image.size)
                    clean.paste(image)
                    output = io.BytesIO()
                    clean.save(output, format='PNG')
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise HTTPException(422, 'Choose a valid PNG, JPEG, WebP or GIF image up to 25 megapixels.') from None
        identifier = uuid.uuid4().hex
        raw = output.getvalue()
        metadata = {'id': identifier, 'name': str(name)[:200] or 'Image', 'media_type': 'image/png',
                    'width': clean.width, 'height': clean.height, 'size': len(raw),
                    'url': f'/v1/assistant/attachments/{identifier}',
                    'thumbnail_url': f'/v1/assistant/attachments/{identifier}/thumbnail'}
        self.vault(identifier).save({'meta': metadata, 'data': base64.b64encode(raw).decode('ascii')})
        return metadata

    def load(self, identifier):
        stored = self.vault(identifier).load()
        if not stored:
            raise HTTPException(404, 'Image attachment not found. Attach it again.')
        return stored['meta'], base64.b64decode(stored['data'], validate=True)

    def resolve(self, identifiers):
        if not isinstance(identifiers, list) or len(identifiers) > MAX_IMAGES:
            raise HTTPException(422, 'Attach up to four images per message.')
        images = [self.load(identifier) for identifier in identifiers]
        return ([meta for meta, _ in images],
                [BinaryContent(data=data, media_type=meta['media_type']) for meta, data in images])

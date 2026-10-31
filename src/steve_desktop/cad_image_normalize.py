"""Upstream Studio image normalization, separated from its hosted storage layer.
Source: app/attachments.py at the revision recorded in UPSTREAM.txt.
"""
from io import BytesIO
import threading
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
MAX_EDGE = 2048
MAX_PIXELS = 25_000_000
JPEG_MAX_PIXELS = 200_000_000
FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif"}
Image.MAX_IMAGE_PIXELS = JPEG_MAX_PIXELS
DECODING = threading.BoundedSemaphore(2)

def _too_large(width: int, height: int) -> HTTPException:
    return HTTPException(413, f"That image is {width} x {height} pixels; images can be at most {MAX_PIXELS // 1_000_000} megapixels.")


def normalize(raw, max_edge=MAX_EDGE, lossy=False):
    """Decodes, bounds and re-encodes an image (dropping EXIF and other metadata); returns (bytes, media_type, w, h, thumbnail).
    Every image the API decodes comes through here. `max_edge` bounds the long side; `lossy` re-encodes an opaque image
    as JPEG whatever it came as (smaller, for a model to look at)."""
    with DECODING:
        return _normalize(raw, max_edge, lossy)


def _normalize(raw, max_edge=MAX_EDGE, lossy=False):
    try:
        with Image.open(BytesIO(raw)) as probe:
            kind, (width, height) = probe.format, probe.size
            probe.verify()
        if kind not in FORMATS:
            raise HTTPException(415, "Attach a PNG, JPEG, WebP or GIF image.")
        if width * height > (JPEG_MAX_PIXELS if kind == "JPEG" else MAX_PIXELS):
            raise _too_large(width, height)
        with Image.open(BytesIO(raw)) as source:
            source.seek(0)  # First frame of an animation.
            if kind == "JPEG":
                # Decode at 1/2, 1/4 or 1/8 scale, still at least max_edge on the long side: cheap, and no visible loss.
                scale = max_edge / max(width, height)
                source.draft(source.mode, (max(1, int(width * scale)), max(1, int(height * scale))))
            if source.size[0] * source.size[1] > MAX_PIXELS:
                raise _too_large(width, height)
            image = ImageOps.exif_transpose(source)
            image.load()
    except HTTPException:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise HTTPException(415, "That file isn't a readable image.") from None
    alpha = image.mode in {"RGBA", "LA", "PA"} or (image.mode == "P" and "transparency" in image.info)
    image = image.convert("RGBA" if alpha else "RGB")
    if max(image.size) > max_edge:
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    out = BytesIO()
    if (kind == "JPEG" or lossy) and not alpha:
        image.save(out, "JPEG", quality=90 if kind == "JPEG" else 85, optimize=True)
        media_type = "image/jpeg"
    elif kind == "WEBP":
        image.save(out, "WEBP", quality=90, method=4)
        media_type = "image/webp"
    else:  # PNG, and GIF as its first frame: lossless.
        image.save(out, "PNG", optimize=True)
        media_type = "image/png"
    thumb = image.copy()
    thumb.thumbnail((360, 360), Image.Resampling.LANCZOS)
    small = BytesIO()
    thumb.save(small, "WEBP", quality=82, method=4)
    return out.getvalue(), media_type, image.width, image.height, small.getvalue()


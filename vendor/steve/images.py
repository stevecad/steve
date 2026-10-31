"""Logo images kept in a design beside main.py (logo.png), drawn only in a drawing's title block cell
({"image": "logo.png"} in Drawing(title_block=...)).

Deliberately narrow: a PNG or JPEG file beside main.py (no folders), at most MAX_BYTES and MAX_SIDE pixels
a side, accepted only by its actual bytes (the PNG or JPEG signature, and the pixel size its header gives), never by
its name. Never SVG or any other format, never a URL, never served as a page; its only use is a title block cell.
Widening any of that is a person's decision, never part of another change.

A document keeps the file as base64 text (its files are text: in its history, inside its source limit); a build writes
the bytes beside main.py. Standard library only: the API checks a file with the same code when it's saved. Errors name
the file and the rule, never its content.
"""
from __future__ import annotations

import base64
import binascii
import re
import struct
import zlib

NAME = re.compile(r"[a-z][a-z0-9_]{0,63}\.(?:png|jpe?g)")
MAX_BYTES = 512 * 1024
MAX_SIDE = 4096
PNG = b"\x89PNG\r\n\x1a\n"
MEDIA = {"png": "image/png", "jpeg": "image/jpeg"}
# JPEG start-of-frame markers (ITU T.81 B.1.1.3): every SOFn but DHT (C4), JPG (C8) and DAC (CC).
SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


class ImageError(ValueError):
    pass


def decode(path: str, text: str) -> bytes:
    """A document's stored image file (base64 text) as its bytes."""
    if not isinstance(text, str) or len(text) > (MAX_BYTES + 2) // 3 * 4 + 4:
        raise ImageError(f"{path} is larger than {MAX_BYTES // 1024} KB: a logo image is at most {MAX_BYTES // 1024} KB.")
    try:
        return base64.b64decode(text.strip(), validate=True)
    except (binascii.Error, ValueError):
        raise ImageError(f"{path} isn't a stored image file (base64): add it again with Import logo….") from None


def encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _png(path: str, data: bytes) -> tuple[int, int]:
    """A PNG's (width, height), from its IHDR chunk, once its chunks read through to IEND with their CRCs right."""
    at, size, seen = len(PNG), None, set()
    while True:
        if at + 12 > len(data):
            raise ImageError(f"{path} isn't a complete PNG image (it ends early).")
        length, kind = struct.unpack(">I4s", data[at:at + 8])
        body = data[at + 8:at + 8 + length]
        if len(body) != length or at + 12 + length > len(data):
            raise ImageError(f"{path} isn't a complete PNG image (it ends early).")
        if zlib.crc32(kind + body) & 0xFFFFFFFF != struct.unpack(">I", data[at + 8 + length:at + 12 + length])[0]:
            raise ImageError(f"{path} isn't a valid PNG image (a damaged chunk).")
        if size is None:
            if kind != b"IHDR" or length != 13:
                raise ImageError(f"{path} isn't a valid PNG image (no header).")
            size = struct.unpack(">II", body[:8])
        seen.add(kind)
        at += 12 + length
        if kind == b"IEND":
            break
    if b"IDAT" not in seen:
        raise ImageError(f"{path} isn't a valid PNG image (no image data).")
    return size


def _jpeg(path: str, data: bytes) -> tuple[int, int]:
    """A JPEG's (width, height), from its start-of-frame segment."""
    at = 2
    while at + 4 <= len(data):
        if data[at] != 0xFF:
            raise ImageError(f"{path} isn't a valid JPEG image (a damaged segment).")
        marker = data[at + 1]
        if marker == 0xFF:  # Fill bytes before a marker.
            at += 1
            continue
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # Markers without a length.
            at += 2
            continue
        if marker in (0xD9, 0xDA):  # The image's end, or its scan, before any frame header.
            break
        length = struct.unpack(">H", data[at + 2:at + 4])[0]
        if length < 2 or at + 2 + length > len(data):
            raise ImageError(f"{path} isn't a complete JPEG image (it ends early).")
        if marker in SOF:
            if length < 8:
                raise ImageError(f"{path} isn't a valid JPEG image (a damaged frame header).")
            height, width = struct.unpack(">HH", data[at + 5:at + 9])
            return width, height
        at += 2 + length
    raise ImageError(f"{path} isn't a valid JPEG image (no frame header).")


def check(path: str, data: bytes) -> tuple[str, int, int]:
    """("png" or "jpeg", width, height) of a logo image's bytes, or ImageError naming the file and the rule it breaks."""
    if len(data) > MAX_BYTES:
        raise ImageError(f"{path} is larger than {MAX_BYTES // 1024} KB: a logo image is at most {MAX_BYTES // 1024} KB.")
    if data.startswith(PNG):
        kind, (width, height) = "png", _png(path, data)
    elif data.startswith(b"\xff\xd8\xff"):
        kind, (width, height) = "jpeg", _jpeg(path, data)
    else:
        raise ImageError(f"{path} isn't a PNG or JPEG image: a logo is a PNG or JPEG file (SVG and other formats aren't taken).")
    if not (1 <= width <= MAX_SIDE and 1 <= height <= MAX_SIDE):
        raise ImageError(f"{path} is {width} × {height} pixels: a logo image is 1 to {MAX_SIDE} pixels a side.")
    if path.endswith(".png") != (kind == "png"):
        raise ImageError(f"{path} is a {'PNG' if kind == 'png' else 'JPEG'} image: name it {path.rsplit('.', 1)[0]}"
                         f".{'png' if kind == 'png' else 'jpg'}.")
    return kind, width, height


def read(path: str) -> tuple[bytes, str, int, int]:
    """The design's logo image `path` (a .png or .jpg beside main.py): its bytes, kind, width and height in pixels."""
    from .tables import _root
    if not isinstance(path, str) or not NAME.fullmatch(path):
        raise ImageError("A logo image is one of the design's .png or .jpg files beside main.py, like \"logo.png\": "
                         "lowercase letters, digits and underscores, no folders.")
    file = _root() / path
    if not file.is_file():
        raise ImageError(f"This design has no {path}. Add it in the Source panel: file switcher → Import logo….")
    if file.stat().st_size > MAX_BYTES:
        raise ImageError(f"{path} is larger than {MAX_BYTES // 1024} KB: a logo image is at most {MAX_BYTES // 1024} KB.")
    data = file.read_bytes()
    return (data, *check(path, data))


def write(path, text: str) -> None:
    """A build's copy of a stored image file: its bytes, or nothing a drawing could take when it isn't one."""
    from pathlib import Path
    try:
        data = decode(str(path), text)
    except ImageError:
        data = b""
    Path(path).write_bytes(data)

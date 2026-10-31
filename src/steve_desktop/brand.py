"""Original STEVE site logo, shared by the app and Windows icon."""

from steve_desktop.paths import RESOURCE_ROOT
from pathlib import Path
import struct
from PySide6.QtCore import Qt, QRectF, QBuffer, QIODevice
from PySide6.QtGui import QPainter, QPixmap, QIcon
from PySide6.QtSvg import QSvgRenderer


def logo(size=64):
    image = QPixmap(size, size)
    image.fill(Qt.GlobalColor.transparent)
    renderer = QSvgRenderer(str(RESOURCE_ROOT / 'assets/steve-logo.svg'))
    if not renderer.isValid():
        raise RuntimeError('Steve logo asset is missing or invalid.')
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    renderer.render(painter)
    painter.end()
    return image


def app_icon():
    icon = QIcon()
    for size in (16, 24, 32, 48, 64, 128, 256):
        icon.addPixmap(logo(size))
    return icon


def write_ico(path):
    sizes = (16, 24, 32, 48, 64, 128, 256)
    blobs = []
    for size in sizes:
        buffer = QBuffer()
        buffer.open(QIODevice.OpenModeFlag.WriteOnly)
        logo(size).save(buffer, 'PNG')
        blobs.append(bytes(buffer.data()))
    offset = 6 + 16 * len(blobs)
    entries = []
    for size, blob in zip(sizes, blobs):
        entries.append(struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(blob), offset))
        offset += len(blob)
    Path(path).write_bytes(struct.pack('<HHH', 0, 1, len(blobs)) + b''.join(entries) + b''.join(blobs))

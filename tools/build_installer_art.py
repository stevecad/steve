"""Render installer artwork from Steve's existing vector logo."""
from pathlib import Path
from PySide6.QtCore import QRectF
from PySide6.QtGui import QFont, QImage, QPainter, QColor
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import QApplication

root = Path(__file__).resolve().parents[1]
app = QApplication([])
logo = QSvgRenderer(str(root / 'assets/steve-logo.svg'))
for name, width, height in [('installer-banner', 328, 628), ('installer-icon', 110, 110)]:
    image = QImage(width, height, QImage.Format.Format_RGB32)
    image.fill(QColor('#10191b'))
    painter = QPainter(image)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    if name == 'installer-banner':
        logo.render(painter, QRectF(40, 72, 112, 112))
        painter.setPen(QColor('#ecf4f0'))
        painter.setFont(QFont('Segoe UI', 34, QFont.Weight.DemiBold))
        painter.drawText(QRectF(40, 215, 260, 80), 'Steve')
        painter.setPen(QColor('#a5d7c4'))
        painter.setFont(QFont('Segoe UI', 16))
        painter.drawText(QRectF(40, 300, 260, 60), 'CAD on your machine.')
    else:
        logo.render(painter, QRectF(15, 15, 80, 80))
    painter.end()
    assert image.save(str(root / 'assets' / (name + '.bmp')))

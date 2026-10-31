"""Desktop graphics setup. Call before creating QApplication or WebEngine views."""
import os


def configure_graphics():
    if os.name != 'nt':
        return
    # Qt documents OpenGL as the compatibility path for WebEngine graphics
    # integration issues. Keep Chromium and the QWidget compositor on shared GL.
    # Override only through the app-specific switch for reproducible diagnostics.
    backend = os.environ.get('STEVE_GRAPHICS', 'opengl')
    if backend not in ('opengl', 'd3d11'):
        raise ValueError('STEVE_GRAPHICS must be opengl or d3d11')
    os.environ['QSG_RHI_BACKEND'] = backend
    from PySide6.QtCore import QCoreApplication, Qt
    from PySide6.QtQuick import QQuickWindow, QSGRendererInterface
    if QCoreApplication.instance() is not None:
        raise RuntimeError('Configure graphics before QApplication')
    QCoreApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    QQuickWindow.setGraphicsApi(QSGRendererInterface.GraphicsApi.OpenGL if backend == 'opengl' else QSGRendererInterface.GraphicsApi.Direct3D11)

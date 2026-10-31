"""Desktop host for the upstream CAD UI, served by the private local CAD adapter."""
import base64
import json
import sys
from pathlib import Path
from PySide6.QtCore import QUrl, Qt, Signal, QEvent, QBuffer, QIODevice
from PySide6.QtGui import QColor, QDesktopServices, QKeySequence, QImageReader
from PySide6.QtWidgets import QWidget, QVBoxLayout, QFileDialog, QApplication
from PySide6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage, QWebEngineUrlRequestInterceptor, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from steve_desktop.cad_server import LocalCadServer


class LocalRequests(QWebEngineUrlRequestInterceptor):
    def __init__(self, server, parent):
        super().__init__(parent)
        self.server = server

    def interceptRequest(self, info):
        url = info.requestUrl()
        if url.scheme() in ('data', 'blob', 'qrc', 'about'):
            return
        if url.host() == '127.0.0.1' and url.port() == self.server.port and url.scheme() == 'http':
            info.setHttpHeader(b'X-Steve-Session', self.server.token.encode())
        else:
            info.block(True)


class CadPage(QWebEnginePage):
    def __init__(self, profile, parent=None):
        super().__init__(profile, parent)
        self.paste_handler = None
        self.newWindowRequested.connect(self.open_external)

    def triggerAction(self, action, checked=False):
        if action == QWebEnginePage.WebAction.Paste and self.paste_handler is not None:
            self.paste_handler()
        else:
            super().triggerAction(action, checked)

    def native_paste(self):
        super().triggerAction(QWebEnginePage.WebAction.Paste)

    def open_external(self, request):
        # Explicit catalog and open-source credit links open in the user's browser. Never navigate the
        # privileged local CAD view to a remote site or forward its session header.
        url = request.requestedUrl()
        if request.isUserInitiated() and url.scheme() == 'https' and url.host() in ('www.mcmaster.com', 'www.step.parts', 'step.parts', 'github.com') and url.port(-1) in (-1, 443) and not url.userName() and not url.password():
            QDesktopServices.openUrl(url)

    def javaScriptConsoleMessage(self, level, message, line, source):
        print(f'CAD UI [{level.name}] {message} ({line})', flush=True)


class LocalCadWeb(QWidget):
    def __init__(self, folder, parent=None):
        super().__init__(parent)
        self.server = LocalCadServer(folder)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.view = QWebEngineView()
        self._paste_key = None
        self.profile = QWebEngineProfile(self)
        self.interceptor = LocalRequests(self.server, self.profile)
        self.profile.setUrlRequestInterceptor(self.interceptor)
        self.page = CadPage(self.profile, self.view)
        self.page.paste_handler = self.paste
        self.page.setBackgroundColor(QColor("#101719"))
        self.view.setPage(self.page)
        # Limit paste interception to the view and its keyboard focus widget.
        # An application-wide Python filter also wraps private Qt Quick objects;
        # PySide6 6.12 can crash while identifying those objects on Linux.
        if sys.platform == 'linux':
            self.view.installEventFilter(self)
            self.install_paste_filter()
            self.view.loadFinished.connect(self.install_paste_filter)
        else:
            QApplication.instance().installEventFilter(self)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, False)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, False)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        # The private local UI can copy text from explicit button actions. This
        # does not enable JavaScript clipboard reads or programmatic paste.
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)
        self.page.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanPaste, False)
        self.page.fullScreenRequested.connect(self.fullscreen)
        self.profile.downloadRequested.connect(self.download)
        layout.addWidget(self.view)
        self.view.setUrl(QUrl(self.server.url))

    def install_paste_filter(self, *_):
        proxy = self.view.focusProxy()
        if proxy is not None:
            proxy.installEventFilter(self)

    def eventFilter(self, watched, event):
        if (event.type() == QEvent.Type.ShortcutOverride
                and isinstance(watched, QWidget)
                and (watched is self.view or self.view.isAncestorOf(watched))
                and event.matches(QKeySequence.StandardKey.Paste)):
            event.accept()
            return True
        if (event.type() == QEvent.Type.KeyRelease
                and self._paste_key == event.key()
                and isinstance(watched, QWidget)
                and (watched is self.view or self.view.isAncestorOf(watched))):
            self._paste_key = None
            return True
        if (event.type() == QEvent.Type.KeyPress
                and isinstance(watched, QWidget)
                and (watched is self.view or self.view.isAncestorOf(watched))
                and event.matches(QKeySequence.StandardKey.Paste)):
            self._paste_key = event.key()
            self.page.triggerAction(QWebEnginePage.WebAction.Paste)
            return True
        return super().eventFilter(watched, event)

    def paste(self):
        # Some applications publish only encoded PNG/JPEG clipboard data.
        # Chromium's native paste can omit that image on Windows. Forward
        # it to the composer's existing attachment handler for this explicit
        # paste only. Never watch or change the system clipboard.
        clipboard = QApplication.clipboard()
        mime = clipboard.mimeData()
        if mime is not None and not mime.hasFormat('application/x-qt-image'):
            for kind in ('image/png', 'image/jpeg', 'image/webp'):
                if not mime.hasFormat(kind):
                    continue
                data = mime.data(kind)
                if not data or len(data) > 8 * 1024 * 1024:
                    break
                buffer = QBuffer()
                buffer.setData(data)
                buffer.open(QIODevice.OpenModeFlag.ReadOnly)
                reader = QImageReader(buffer)
                size = reader.size()
                if not size.isValid() or size.width() * size.height() > 25_000_000:
                    break
                image = reader.read()
                if not image.isNull():
                    encoded = json.dumps(base64.b64encode(bytes(data)).decode('ascii'))
                    script = """(() => {
                        const input = document.querySelector('#chat-message');
                        if (!input || input.disabled || document.activeElement !== input) return false;
                        const data = Uint8Array.from(atob(%s), c => c.charCodeAt(0));
                        const transfer = new DataTransfer();
                        transfer.items.add(new File([data], 'Pasted image', {type: %s}));
                        input.dispatchEvent(new ClipboardEvent('paste', {
                            clipboardData: transfer, bubbles: true, cancelable: true
                        }));
                        return true;
                    })()""" % (encoded, json.dumps(kind))
                    self.page.runJavaScript(script, self._image_paste_finished)
                    return True
                break
        # Dispatch native formats through one action, rather than allowing
        # both Qt shortcut handling and Chromium's key handling to paste.
        self.page.native_paste()

    def _image_paste_finished(self, handled):
        if getattr(self, '_shutdown', False):
            return
        if not handled:
            # Preserve normal native paste in source editors and other fields.
            self.page.native_paste()

    @property
    def project(self):
        return self.server.project

    def fullscreen(self, request):
        request.accept()
        if getattr(self, '_shutdown', False):
            return
        if request.toggleOn() and hasattr(self.window(), 'show_desktop'):
            self.window().show_desktop('cad')
        self.window().showFullScreen() if request.toggleOn() else self.window().showNormal()

    def download(self, item):
        filename, _ = QFileDialog.getSaveFileName(self, 'Export CAD', item.downloadFileName())
        if filename:
            path = Path(filename)
            item.setDownloadDirectory(str(path.parent))
            item.setDownloadFileName(path.name)
            item.accept()
        else:
            item.cancel()

    def shutdown(self):
        if getattr(self, '_shutdown', False):
            return
        self._shutdown = True
        self.view.stop()
        # A WebEngine profile must outlive its pages. Explicitly drain deferred
        # deletion here because application exit (and diagnostic event pumps)
        # may otherwise destroy QObject parents before the event loop drains.
        self.page.deleteLater()
        QApplication.sendPostedEvents(self.page, QEvent.Type.DeferredDelete)
        self.profile.deleteLater()
        QApplication.sendPostedEvents(self.profile, QEvent.Type.DeferredDelete)
        self.server.close()

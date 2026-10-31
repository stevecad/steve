import asyncio
import os
import sys
import threading
import tempfile
from pathlib import Path

if __name__=='__main__' and '--watch-process' in sys.argv:
    from steve_desktop.process_watch import main as watch_main
    raise SystemExit(watch_main(sys.argv[sys.argv.index('--watch-process')+1:]))

if __name__ == '__main__' and sys.platform == 'linux':
    from steve_desktop.linux_updates import bootstrap, activate
    if '--apply-linux-update' in sys.argv:
        index=sys.argv.index('--apply-linux-update')
        raise SystemExit(activate(sys.argv[index+1],sys.argv[index+2],int(sys.argv[index+3]),
                                  sys.argv[index+4] if len(sys.argv)>index+4 else None,
                                  sys.argv[index+5] if len(sys.argv)>index+5 else None))
    if '--update-info' in sys.argv:
        import json
        from steve_desktop.local_updates import VERSION,update_platform
        print(json.dumps({'version':VERSION,'platform':update_platform()}))
        raise SystemExit(0)
    delegated=bootstrap()
    if delegated is not None:
        raise SystemExit(delegated)
    if '--update-check' in sys.argv or '--update-status' in sys.argv:
        import json
        from types import SimpleNamespace
        from fastapi import FastAPI
        from steve_desktop.local_updates import LocalUpdates
        from steve_desktop.vault import data_directory
        from steve_desktop.linux_updates import notify_ready
        profile=data_directory()
        profile.mkdir(parents=True,exist_ok=True)
        updater=LocalUpdates(SimpleNamespace(folder=profile/'cad',app=FastAPI()))
        notify_ready()
        if '--update-check' in sys.argv:
            updater.check()
            status=updater.status()
            updater.close()
        else:
            status=updater.status()
            updater.closed.set()
        print(json.dumps(status))
        raise SystemExit(0)

if __name__ == '__main__' and '--mcp' in sys.argv:
    from steve_desktop.local_mcp import serve_stdio
    asyncio.run(serve_stdio())
    raise SystemExit(0)

# Windowed Windows executables have no console streams. The OAuth callback's
# HTTP server configures logging and calls isatty() even with logging suppressed.
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

# A CAD worker needs the kernel, not Qt WebEngine or the assistant's AI SDKs.
# Dispatch before importing the desktop so each clean spare starts cheaply.
if __name__ == '__main__' and '--blender-smoke' in sys.argv:
    from steve_desktop.blender_diagnostics import verify
    verify(sys.argv[sys.argv.index('--blender-smoke') + 1])
    raise SystemExit(0)

if __name__ == '__main__' and '--cad-worker' in sys.argv:
    from steve_desktop.cad_kernel import main as kernel_main
    raise SystemExit(kernel_main(sys.argv[sys.argv.index('--cad-worker') + 1:]))

from PySide6.QtCore import QLockFile, QThread, Signal, QTimer, Qt
from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTableWidget, QTableWidgetItem, QHeaderView, QMessageBox, QSplitter, QTabWidget,
)
from steve_desktop.interface import Interface
from steve_desktop.chat_ui import ChatPanel, ToolsController
from steve_desktop.settings_store import AgentSettings
from steve_desktop.brand import app_icon
from steve_desktop.service import Service, AppError
from steve_desktop.vault import Vault, data_directory


class Worker(QThread):
    result = Signal(object)
    error = Signal(str)

    def __init__(self, service, action, parent=None):
        super().__init__(parent)
        self.service, self.action = service, action
        self.cancel = threading.Event()

    def run(self):
        try:
            if self.action == 'login':
                self.service.login(self.cancel)
            if self.action == 'logout':
                self.service.logout()
                self.result.emit(None)
            else:
                self.result.emit(asyncio.run(self.service.models()))
        except AppError as exc:
            self.error.emit(str(exc))
        except Exception as exc:
            from steve_desktop.diagnostics import report_error
            self.error.emit(report_error(exc, self.service.vault.path.parent, f'Account: {self.action}', source=self.service.source))


class Window(QWidget, Interface):
    def __init__(self, service):
        super().__init__()
        self.service = service
        self.worker = None
        self.closing = False
        self.setWindowTitle('Steve')
        self.setWindowIcon(app_icon())
        self.resize(1640, 980)
        self.setMinimumSize(1180, 720)
        self.setup(self)
        self.tools_panel = ToolsController(Vault(service.vault.path.parent / 'mcp-settings.dpapi'), self)
        self.agent_settings = AgentSettings(service.vault.path.parent, self)
        self.chat_panel = ChatPanel(self, self.tools_panel)
        from steve_desktop.cad_webview import LocalCadWeb
        self.cad_panel = LocalCadWeb(service.vault.path.parent / 'cad', self)
        self.workspace = self.cad_panel
        self.chat_panel.hide()
        from steve_desktop.cad_assistant import LocalAssistant
        self.local_assistant = LocalAssistant(self, self.cad_panel.server)
        self.sections.addWidget(self.workspace)
        self.sections.setCurrentWidget(self.workspace)
        self.rail.hide()
        self.desktop_poll = QTimer(self)
        self.desktop_poll.timeout.connect(self.poll_desktop)
        self.desktop_poll.start(100)
        self.login.clicked.connect(lambda: self.start('login'))
        self.refresh.clicked.connect(lambda: self.start('models'))
        self.logout.clicked.connect(lambda: self.start('logout'))
        self.cancel.clicked.connect(self.cancel_login)
        try:
            signed_in = service.signed_in()
            self.refresh.setEnabled(signed_in)
            self.logout.setEnabled(signed_in)
            if signed_in:
                self.status.setText('Restoring your connection…')
                QTimer.singleShot(0, lambda: self.start('models'))
        except Exception:
            self.status.setText('Stored credentials could not be opened by this Windows account.')

    def navigate(self, index):
        self.show_desktop({0: 'account', 2: 'mcp', 3: 'agent'}.get(index, 'cad'))

    def show_desktop(self, action):
        if not hasattr(self, 'cad_panel'):
            return
        self.rail.hide()
        self.sections.setCurrentWidget(self.workspace)
        if action in ('account', 'mcp', 'agent', 'steve'):
            import json
            self.cad_panel.page.runJavaScript(
                "window.dispatchEvent(new CustomEvent('steve:navigate', {detail: "
                + json.dumps(action) + "}));")

    def poll_desktop(self):
        self.local_assistant.poll()
        import queue
        try:
            while True:
                action = self.cad_panel.server.desktop_actions.get_nowait()
                if action == 'close':
                    # "Restart and update": the server thread asks; the normal closeEvent rules apply here.
                    self.close()
                else:
                    self.show_desktop(action)
        except queue.Empty:
            pass

    def start(self, action):
        if self.chat_panel.busy:
            return
        if self.worker and self.worker.isRunning():
            return
        self.status.setText('Complete sign-in in your browser (up to 3 minutes).' if action == 'login' else 'Working…')
        for button in (self.login, self.refresh, self.logout):
            button.setEnabled(False)
        self.cancel.setVisible(action == 'login')
        self.cancel.setEnabled(True)
        self.worker = Worker(self.service, action, self)
        self.worker.result.connect(self.show_result)
        self.worker.error.connect(self.show_error)
        self.worker.finished.connect(self.finished)
        self.worker.start()

    def cancel_login(self):
        self.worker.cancel.set()
        self.cancel.setEnabled(False)
        self.status.setText('Cancelling sign-in…')

    def show_error(self, message):
        self.status.setText(message)
        self.set_connection(False)

    def show_result(self, models):
        self.models = models or []
        self.render_models()
        self.chat_panel.update_models(self.models)
        self.set_connection(models is not None)
        if models is None:
            self.status.setText('Signed out on this device. App access can be revoked in ChatGPT settings.')
        else:
            self.status.setText(f'{len(models)} models synced from your account. Model listing does not send a prompt.')

    def finished(self):
        self.cancel.setVisible(False)
        self.login.setEnabled(True)
        try:
            signed_in = self.service.signed_in()
        except Exception:
            signed_in = False
        self.refresh.setEnabled(signed_in)
        self.logout.setEnabled(signed_in)
        if self.closing:
            self.close()

    def closeEvent(self, event):
        self.chat_panel.save_draft()
        if self.chat_panel.busy:
            self.closing = True
            self.chat_panel.stop_run()
            event.ignore()
            return
        if self.tools_panel.probe and self.tools_panel.probe.isRunning():
            self.tools_panel.probe.stop()
            self.tools_panel.probe.finished.connect(self.close)
            event.ignore()
            return
        if self.worker and self.worker.isRunning():
            self.closing = True
            self.worker.cancel.set()
            self.status.setText('Finishing the current request before closing…')
            event.ignore()
        else:
            self.desktop_poll.stop()
            self.chat_panel.draft_timer.stop()
            self.cad_panel.shutdown()
            event.accept()


def main():
    if '--cad-worker' in sys.argv:
        from steve_desktop.cad_kernel import main as kernel_main
        return kernel_main(sys.argv[sys.argv.index('--cad-worker') + 1:])
    from steve_desktop.desktop_graphics import configure_graphics
    configure_graphics()
    app = QApplication(sys.argv)
    app.setStyle('Fusion')
    app.setApplicationName('Steve')
    app.setWindowIcon(app_icon())
    import ctypes
    if os.name == 'nt':
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('Steve.Desktop')
    if '--smoke-test' in sys.argv:
        from steve_desktop.runtime import make_mcp, ServerConfig, calculate
        assert calculate('17*19') == '323'
        make_mcp(ServerConfig(name='startup_check', url='http://127.0.0.1:1/mcp', auth_mode='none'))
        if '--mcp-test-url' in sys.argv:
            from urllib.parse import urlsplit
            test_url = sys.argv[sys.argv.index('--mcp-test-url') + 1]
            assert urlsplit(test_url).hostname == '127.0.0.1'
            async def check_mcp():
                async with make_mcp(ServerConfig(name='startup_check', url=test_url, auth_mode='none')) as server:
                    assert 'add_numbers' in [tool.name for tool in await server.list_tools()]
                    result = await server.client.call_tool('add_numbers', {'a': 17, 'b': 19})
                    assert '36' in str(result)
            asyncio.run(check_mcp())
        with tempfile.TemporaryDirectory() as folder:
            from steve_desktop.smoke_features import check_features, check_webview
            asyncio.run(check_features(folder))
            window = Window(Service(Vault(Path(folder) / 'test.dpapi')))
            if '--update-smoke' in sys.argv:
                window.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen,True)
            check_webview(window)
            app.processEvents()
            assert window.login.isEnabled() and not window.refresh.isEnabled()
            assert not window.grab().isNull()
            window.close()
        return 0
    folder = data_directory()
    folder.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(folder / 'instance.lock'))
    lock.setStaleLockTime(0)
    if not lock.tryLock(100):
        if sys.platform=='linux':
            from steve_desktop.linux_updates import notify_ready
            notify_ready()
        QMessageBox.information(None, 'Steve', 'Steve or its previous version is already open.')
        return 0
    if os.name=='nt':
        from steve_desktop.windows_updates import on_startup
        if on_startup(folder,app):return 0
    window = Window(Service(Vault(folder / 'credentials.dpapi')))
    window.show()
    if sys.platform=='linux':
        from steve_desktop.linux_updates import watch_frontend_ready
        watch_frontend_ready(window)
    return app.exec()


if __name__ == '__main__':
    sys.exit(main())

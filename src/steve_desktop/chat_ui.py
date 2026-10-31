import asyncio
import html
import json
import threading
import uuid
from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QObject, QThread, Signal, Qt, QTimer
from PySide6.QtGui import QFont, QShortcut, QKeySequence
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QComboBox,
    QTextBrowser, QPlainTextEdit, QLineEdit, QListWidget, QDialog,
    QFormLayout, QCheckBox, QDialogButtonBox, QFileDialog, QMessageBox,
    QSplitter, QFrame, QMenu, QInputDialog, QScrollArea, QApplication,
)
from pydantic_ai.messages import ModelMessagesTypeAdapter
from steve_desktop.runtime import chat, ServerConfig, make_mcp
from steve_desktop.vault import Vault
from steve_desktop.interface import label
from markdown_it import MarkdownIt
from steve_desktop.ui_components import ChoiceBox, card, centered_content, icon

MARKDOWN = MarkdownIt('commonmark', {'html': False, 'breaks': True})
# Chat content cannot cause image downloads or local-file reads.
MARKDOWN.renderer.rules['image'] = lambda tokens, idx, options, env: '[image omitted]'


def safe_error(exc):
    from pydantic_ai.exceptions import ModelHTTPError, UsageLimitExceeded
    from mcp.client.auth.exceptions import OAuthFlowError, OAuthRegistrationError
    if isinstance(exc, BaseExceptionGroup):
        return safe_error(exc.exceptions[0])
    if isinstance(exc, TimeoutError):
        return 'Connection or sign-in timed out. Connect again to retry.'
    if isinstance(exc, OAuthRegistrationError):
        return 'This server could not register Steve for login. It may require a pre-registered OAuth client ID in Edit server.'
    if isinstance(exc, OAuthFlowError):
        return 'MCP sign-in failed. Check the server authentication settings, then connect again.'
    if isinstance(exc, ModelHTTPError):
        return f'OpenAI rejected the request (HTTP {exc.status_code}). Check model availability and subscription usage.'
    if isinstance(exc, UsageLimitExceeded):
        return 'This turn reached its request or tool-call limit.'
    return f'{type(exc).__name__}: Steve could not complete the request.'


class ChatWorker(QThread):
    completed = Signal(object)
    failed = Signal(str)
    activity = Signal(str)
    delta = Signal(str)
    approval = Signal(object)

    def __init__(self, source, model, prompt, history, settings, parent=None):
        super().__init__(parent)
        self.source, self.model, self.prompt = source, model, prompt
        self.history, self.settings = history, settings
        self.loop = self.task = None
        self.stopped = threading.Event()

    def stop(self):
        self.stopped.set()
        if self.loop and self.task:
            try:
                self.loop.call_soon_threadsafe(self.task.cancel)
            except RuntimeError:
                pass

    async def approve(self, source, name, arguments):
        # Compatibility for integrations calling the previous callback interface.
        return True

    async def execute(self):
        self.loop = asyncio.get_running_loop()
        self.task = asyncio.current_task()
        self.approval_lock = asyncio.Lock()
        if self.stopped.is_set():
            raise asyncio.CancelledError
        return await chat(self.source, self.model, self.prompt, self.history,
                          self.settings, self.approve, self.activity.emit, self.delta.emit)

    def run(self):
        try:
            self.completed.emit(asyncio.run(self.execute()))
        except asyncio.CancelledError:
            self.failed.emit('Stopped. Any tools already completed are not undone.')
        except Exception as exc:
            from steve_desktop.diagnostics import report_error
            self.failed.emit(report_error(exc, self.settings['_data_dir'], 'Assistant request', self.settings, self.source))
        finally:
            self.loop = self.task = None


class ProbeWorker(QThread):
    result = Signal(str)
    progress = Signal(str)

    def __init__(self, config, parent=None, oauth_dir=None):
        super().__init__(parent)
        self.config, self.oauth_dir = config, oauth_dir
        self.loop = self.task = None
        self.stopped = threading.Event()

    stop = ChatWorker.stop

    def run(self):
        async def probe():
            self.loop = asyncio.get_running_loop()
            self.task = asyncio.current_task()
            if self.stopped.is_set():
                raise asyncio.CancelledError
            async with asyncio.timeout(360):
                async with make_mcp(self.config, self.oauth_dir, self.progress.emit) as server:
                    tools = await server.list_tools()
                    return f'Connected · {len(tools)} tools\n' + '\n'.join(t.name for t in tools)
        try:
            self.result.emit(asyncio.run(probe()))
        except asyncio.CancelledError:
            self.result.emit('Connection cancelled.')
        except Exception as exc:
            from steve_desktop.diagnostics import report_error
            self.result.emit(report_error(exc, Path(self.oauth_dir).parent, f'MCP connect: {self.config.name}', self.config.model_dump()))
        finally:
            self.loop = self.task = None


class ToolsController(QObject):
    """MCP connection state. All editing and progress display belongs to Steve Settings."""
    def __init__(self, vault, parent=None):
        super().__init__(parent)
        self.vault, self.probe = vault, None
        self.result = ''
        self.settings = vault.load() or {'servers': [], 'workspace': ''}
        if not self.settings.get('workspace') and not self.settings.get('workspace_configured'):
            directory = vault.path.parent / 'workspace'
            directory.mkdir(parents=True, exist_ok=True)
            self.settings.update(workspace=str(directory), workspace_configured=True)
            self.save()

    def save(self):
        self.vault.save(self.settings)

    def set_result(self, message):
        self.result = message

    def test_server(self, index):
        if self.probe and self.probe.isRunning():
            return
        self.result = 'Connecting…'
        self.probe = ProbeWorker(ServerConfig.model_validate(self.settings['servers'][index]), self,
                                 self.vault.path.parent / 'mcp-sessions')
        self.probe.progress.connect(self.set_result)
        self.probe.result.connect(self.set_result)
        self.probe.start()

    def forget_login(self, index):
        from steve_desktop.mcp_auth import forget_session
        forget_session(ServerConfig.model_validate(self.settings['servers'][index]), self.vault.path.parent / 'mcp-sessions')
        self.result = 'Saved browser sign-in removed from this device. Connect to sign in again.'


class Composer(QPlainTextEdit):
    send_requested = Signal()

    def keyPressEvent(self, event):
        modifiers = event.modifiers()
        if (event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter)
                and modifiers & Qt.KeyboardModifier.ControlModifier
                and not modifiers & (Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.AltModifier | Qt.KeyboardModifier.MetaModifier)):
            event.accept()
            if not event.isAutoRepeat():
                self.send_requested.emit()
            return
        super().keyPressEvent(event)


from steve_desktop.chat_management import ChatManagement


class ChatPanel(QWidget, ChatManagement):
    def resizeEvent(self, event):
        super().resizeEvent(event)
        self.column.setFixedWidth(max(280, self.width() - 16))

    def __init__(self, window, tools):
        super().__init__(window)
        self.window, self.tools = window, tools
        self.store = Vault(window.service.vault.path.parent / 'chats.dpapi')
        self.sessions = self.store.load().get('chats', [])
        self.worker = None
        self.dialog = None
        self.pending = ''
        self.streamed = ''
        self.history = []
        self.active = None
        outer = QHBoxLayout(self)
        outer.setContentsMargins(8, 0, 8, 0)
        self.column = QWidget()
        self.column.setMaximumWidth(980)
        outer.addWidget(self.column, 1, Qt.AlignmentFlag.AlignHCenter)
        layout = QVBoxLayout(self.column)
        layout.setContentsMargins(8, 16, 8, 12)
        layout.setSpacing(12)
        heading = QHBoxLayout()
        self.chat_title = label('New task', 'connectionTitle')
        self.chat_title.setMaximumWidth(430)
        self.chat_title.setWordWrap(True)
        heading.addWidget(self.chat_title, 1)
        self.models = ChoiceBox(title='Choose a model')
        self.models.setMinimumWidth(110)
        self.models.setToolTip('Model for this conversation')
        self.effort = ChoiceBox(title='Reasoning effort')
        self.effort.setMinimumWidth(100)
        self.effort.setToolTip('Reasoning effort for this model. Higher effort may take longer. Ultra requires a delegation harness and is not available here.')
        self.model_choices = {}
        self.models.currentIndexChanged.connect(self.update_efforts)
        self.chat_actions = QPushButton('•••')
        self.chat_actions.setFixedSize(40, 40)
        self.chat_actions.setToolTip('Conversation actions')
        self.chat_actions.clicked.connect(self.show_actions)
        heading.addWidget(self.chat_actions)
        layout.addLayout(heading)
        context_row = QHBoxLayout()
        self.workspace_status = label('', 'small')
        context_row.addWidget(self.workspace_status, 1)
        layout.addLayout(context_row)
        self.update_workspace_status()
        self.new = window.new_chat
        self.chats = window.chat_list
        self.transcript = QTextBrowser()
        self.transcript.setOpenExternalLinks(False)
        self.transcript.setOpenLinks(False)
        text_font = QFont('Segoe UI')
        text_font.setPixelSize(16)
        self.transcript.setFont(text_font)
        self.transcript.document().setDefaultStyleSheet('''
            p { margin-top: 8px; margin-bottom: 12px; line-height: 145%; }
            li { margin-bottom: 7px; line-height: 145%; }
            ul, ol { margin-top: 8px; margin-bottom: 16px; }
            pre { background-color: #1b2729; padding: 14px; font-family: Consolas; }
            code { color: #bde9d3; font-family: Consolas; }
            h1, h2, h3 { color: #e7f2ec; margin-top: 22px; }
        ''')
        self.transcript.setStyleSheet('QTextBrowser { background: transparent; border: none; padding: 18px 12px; font-size: 16px; }')
        layout.addWidget(self.transcript, 1)
        self.activity_toggle = QPushButton('Tool activity')
        self.activity_toggle.setObjectName('quiet')
        self.activity_toggle.setCheckable(True)
        self.activity_toggle.hide()
        layout.addWidget(self.activity_toggle)
        self.activity_log = QPlainTextEdit()
        self.activity_log.setReadOnly(True)
        self.activity_log.setMaximumHeight(90)
        self.activity_log.hide()
        self.activity_toggle.toggled.connect(self.activity_log.setVisible)
        layout.addWidget(self.activity_log)
        composer_frame = QFrame()
        composer_frame.setObjectName('composerFrame')
        composer_frame.setStyleSheet('QFrame#composerFrame { background: #192326; border: 1px solid #40574d; border-radius: 16px; } QFrame#composerFrame QLabel { background: transparent; }')
        composer_layout = QVBoxLayout(composer_frame)
        composer_layout.setContentsMargins(14, 10, 12, 10)
        composer_layout.setSpacing(4)
        self.composer = Composer()
        self.composer.setFont(text_font)
        self.composer.document().setDefaultFont(text_font)
        self.composer.setStyleSheet('QPlainTextEdit { background: transparent; border: none; padding: 6px; font-size: 16px; }')
        self.composer.setPlaceholderText('Message Steve…')
        self.composer.setFixedHeight(72)
        self.composer.textChanged.connect(self.resize_composer)
        self.composer.send_requested.connect(self.send_message)
        composer_layout.addWidget(self.composer)
        row = QHBoxLayout()
        controls = QHBoxLayout()
        controls.addWidget(self.models, 1)
        controls.addWidget(self.effort, 1)
        composer_layout.addLayout(controls)
        row.addWidget(label('Ctrl+Enter to send', 'small'))
        row.addStretch(1)
        self.state = label('Choose a model to start chatting.', 'muted')
        self.state.setWordWrap(True)
        self.stop = QPushButton('Stop')
        self.stop.setEnabled(False)
        self.stop.hide()
        self.send = QPushButton('Send')
        self.send.setToolTip('Send message (Ctrl+Enter)')
        self.send.setObjectName('primary')
        row.addWidget(self.stop)
        row.addWidget(self.send)
        composer_layout.addLayout(row)
        layout.addWidget(composer_frame)
        self.state.setStyleSheet('color: #8da49a; font-size: 12px; padding: 2px 4px;')
        layout.addWidget(self.state)
        self.new.clicked.connect(self.new_chat)
        self.send.clicked.connect(self.send_message)
        self.stop.clicked.connect(self.stop_run)
        self.chats.currentRowChanged.connect(self.select_chat)
        self.chats.itemClicked.connect(lambda item: self.window.show_desktop('steve'))
        self.chats.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.chats.customContextMenuRequested.connect(self.chat_context_menu)
        window.chat_search.textChanged.connect(self.filter_chats)
        self.draft_timer = QTimer(self)
        self.draft_timer.setSingleShot(True)
        self.draft_timer.setInterval(650)
        self.draft_timer.timeout.connect(self.save_draft)
        self.composer.textChanged.connect(lambda: self.draft_timer.start())
        self.reload_chats()
        if self.sessions:
            self.chats.setCurrentRow(0)
            self.select_chat(0)
        else:
            self.new_chat()

    @property
    def busy(self):
        return bool(self.worker and self.worker.isRunning())

    def resize_composer(self):
        lines = self.composer.document().blockCount()
        self.composer.setFixedHeight(min(160, max(72, 30 + lines * 23)))

    def reload_chats(self):
        self.chats.blockSignals(True)
        self.chats.clear()
        for session in self.sessions:
            self.chats.addItem(session['title'])
            self.chats.item(self.chats.count() - 1).setToolTip(session['title'])
        self.chats.blockSignals(False)
        self.filter_chats()

    def new_chat(self):
        if self.busy:
            return
        self.save_draft()
        self.active = {'id': str(uuid.uuid4()), 'title': 'New task', 'messages': [], 'history': [], 'activity': []}
        self.sessions.insert(0, self.active)
        self.reload_chats()
        self.chats.setCurrentRow(0)
        self.select_chat(0)
        self.window.show_desktop('steve')

    def select_chat(self, index):
        if self.busy or not 0 <= index < len(self.sessions):
            return
        if self.active is not self.sessions[index]:
            self.save_draft()
        self.active = self.sessions[index]
        self.composer.blockSignals(True)
        self.composer.setPlainText(self.active.get('draft', ''))
        self.composer.blockSignals(False)
        self.chat_title.setText(self.active['title'])
        self.window.show_desktop('steve')
        self.history = ModelMessagesTypeAdapter.validate_python(self.active.get('history', []))
        model_index = self.models.findData(self.active.get('model'))
        if model_index >= 0:
            self.models.setCurrentIndex(model_index)
        self.update_efforts()
        self.activity_log.setPlainText('\n'.join(self.active.get('activity', [])))
        self.activity_toggle.setChecked(False)
        self.update_activity_toggle()
        self.pending = self.streamed = ''
        self.render()

    def update_models(self, models):
        selected = self.models.currentData() or (self.active or {}).get('model')
        self.model_choices = {model.slug: model for model in models}
        self.models.clear()
        for model in models:
            self.models.addItem(model.display_name, model.slug)
        index = self.models.findData(selected)
        if index >= 0:
            self.models.setCurrentIndex(index)
        self.update_efforts()
        self.state.setText('Ready.' if models else 'Connect your account in Settings → Account.')

    def update_workspace_status(self):
        workspace = self.tools.settings.get('workspace')
        self.workspace_status.setText('Workspace · ' + (Path(workspace).name if workspace else 'Not selected'))
        self.workspace_status.setToolTip(workspace or 'Choose a workspace in Settings → Tools & MCP')

    def update_efforts(self):
        previous = (self.active or {}).get('reasoning_effort') or self.effort.currentData()
        self.effort.clear()
        self.effort.addItem('Effort: default', None)
        model = self.model_choices.get(self.models.currentData())
        if model:
            levels = [entry['effort'] for entry in model.supported_reasoning_levels if entry.get('effort') in {'none','minimal','low','medium','high','xhigh','max'}]
            if not levels:
                from pydantic_ai.profiles.openai import openai_model_profile
                accepted = openai_model_profile(model.slug).get('openai_reasoning_efforts', ())
                levels = [level for level in ('none','minimal','low','medium','high','xhigh','max') if level in accepted]
            for level in levels:
                self.effort.addItem('Effort: ' + level, level)
            index = self.effort.findData(previous)
            self.effort.setCurrentIndex(max(0, index))
        self.effort.setEnabled(self.effort.count() > 1 and not self.busy)

    def render(self):
        if getattr(self, "headless", False):
            return
        scrollbar = self.transcript.verticalScrollBar()
        old_scroll = scrollbar.value()
        follow = scrollbar.maximum() - old_scroll < 45
        messages = list(self.active['messages']) if self.active else []
        if self.pending:
            messages += [{'role': 'You', 'text': self.pending}, {'role': 'Steve', 'text': self.streamed or 'Thinking…'}]
        if not messages:
            self.transcript.setHtml('<br><br><h1 style="color:#e5efe9;font-size:23px;font-weight:500">Build with Steve.</h1><p style="color:#96afa2;font-size:16px">Describe a part, refine a dimension, or select geometry to work on it together.</p>')
            return
        rendered = []
        for message in messages:
            color = '#addec7' if message['role'] in ('Steve', 'Steve') else '#e1bb88'
            rendered.append(f'<p style="color:{color};font-size:13px;margin-top:22px;margin-bottom:10px"><b>{html.escape("Steve" if message["role"] == "Steve" else message["role"])}</b></p>'
                            f'<div style="color:#e4ece7;font-size:16px">{MARKDOWN.render(message["text"])}</div>')
        self.transcript.setHtml(''.join(rendered))
        scrollbar.setValue(scrollbar.maximum() if follow else old_scroll)

    def send_message(self, checked=False, *, attachments=None, image_content=None):
        if self.busy or self.window.worker and self.window.worker.isRunning():
            return
        prompt = self.composer.toPlainText().strip()
        if (not prompt and not image_content) or not self.models.currentData():
            self.state.setText('Enter a message and select an available model.')
            return
        if len(prompt) > 50000:
            self.state.setText('Keep each message below 50,000 characters.')
            return
        if self.tools.probe and self.tools.probe.isRunning():
            self.state.setText('Wait for the MCP connection test to finish.')
            return
        self.active['draft'] = ''
        self.pending, self.streamed = prompt, ''
        self.pending_attachments = attachments or []
        self.composer.clear()
        self.render()
        self.set_busy(True)
        settings = json.loads(json.dumps(self.tools.settings))
        settings.update(self.window.agent_settings.values())
        settings['_data_dir'] = str(self.tools.vault.path.parent)
        settings['reasoning_effort'] = self.effort.currentData()
        self.active['reasoning_effort'] = self.effort.currentData()
        settings['_oauth_dir'] = str(self.tools.vault.path.parent / 'mcp-sessions')
        if getattr(self.window, 'cad_panel', None):
            settings['_cad_project'] = str(self.window.cad_panel.project.folder)
        model_prompt = ([prompt, *image_content] if prompt else image_content) if image_content else prompt
        self.worker = ChatWorker(self.window.service.source, self.models.currentData(), model_prompt,
                                 self.history, settings, self)
        self.worker.completed.connect(self.completed)
        self.worker.failed.connect(self.failed)
        self.worker.delta.connect(self.on_delta)
        self.worker.activity.connect(self.on_activity)
        self.worker.finished.connect(self.finished)
        self.state.setText('Working…')
        self.worker.start()

    def set_busy(self, busy):
        for widget in (self.new, self.send, self.chats, self.models, self.effort, 
                       self.window.login, self.window.logout, self.window.refresh):
            widget.setEnabled(not busy)
        self.stop.setEnabled(busy)
        self.stop.setVisible(busy)
        if not busy:
            self.effort.setEnabled(self.effort.count() > 1)

    def on_delta(self, delta):
        self.streamed += delta
        self.render()

    def on_activity(self, text):
        entry = datetime.now().strftime('%H:%M:%S') + '  ' + text
        self.active.setdefault('activity', []).append(entry)
        self.activity_log.appendPlainText(entry)
        self.update_activity_toggle()

    def update_activity_toggle(self):
        count = len(self.active.get('activity', [])) if self.active else 0
        self.activity_toggle.setVisible(count > 0)
        self.activity_toggle.setText(f'Tool activity · {count} events')

    def completed(self, result):
        text, history = result
        if not self.active['messages']:
            self.active['title'] = self.pending[:45] or 'Image'
        self.active['messages'].extend([{'role': 'You', 'text': self.pending, 'attachments': self.pending_attachments}, {'role': 'Steve', 'text': text}])
        self.history = history
        self.active['history'] = ModelMessagesTypeAdapter.dump_python(history, mode='json')
        self.active['model'] = self.models.currentData()
        self.pending = self.streamed = ''
        self.render()
        try:
            self.store.save({'chats': self.sessions})
            self.state.setText('Done · saved on this device.')
        except Exception:
            self.state.setText('Reply received, but saving failed. This chat is currently in memory only.')
        index = self.sessions.index(self.active)
        self.reload_chats()
        self.chats.setCurrentRow(index)
        self.chat_title.setText(self.active['title'])

    def failed(self, error):
        self.composer.setPlainText(self.pending)
        self.pending = self.streamed = ''
        self.render()
        self.state.setText(error)
        self.on_activity(error)
        try:
            self.store.save({'chats': self.sessions})
        except Exception:
            pass

    def finished(self):
        if self.dialog:
            self.dialog.reject()
        self.set_busy(False)
        self.window.finished()

    def stop_run(self):
        if self.worker:
            self.worker.stop()
            self.state.setText('Stopping… Completed tool actions are not undone.')

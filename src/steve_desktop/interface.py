from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QWidget, QFrame, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QLineEdit, QScrollArea, QStackedWidget, QListWidget, QTreeWidget,
)
from steve_desktop.brand import logo
from steve_desktop.ui_components import AccordionButton, icon

STYLE = '''
QTreeWidget { background: transparent; border: none; outline: none; font-size: 12px; }
QTreeWidget::item { height: 29px; border-radius: 4px; }
QTreeWidget::item:selected { background: #244338; color: #b7edd5; }
QDoubleSpinBox { background: #10191e; border: 1px solid #35434b; border-radius: 5px; padding: 7px; min-width: 60px; }
QSplitter::handle { background: #2c3741; width: 1px; }
QTabBar::tab { padding: 10px 12px; }

QFrame#settingsCard { background: #1a2425; border: 1px solid #2b3837; border-radius: 14px; }
QFrame#settingsCard QLabel, QFrame#settingsCard QCheckBox { background: transparent; }
QTabWidget::pane { border: none; background: transparent; }
QTabBar::tab { color: #98aba1; background: transparent; padding: 12px 20px; border-bottom: 2px solid transparent; }
QTabBar::tab:selected { color: #c5ebd5; border-bottom: 2px solid #a9dbbd; }
QTabBar::tab:hover { color: #e5eee9; background: #1d2926; }
QListWidget { outline: none; }
QListWidget::item { padding: 10px; border-radius: 7px; }
QListWidget::item:selected { background: #284036; color: #d3eddf; }
QListWidget::item:hover { background: #22312b; }
QMenu { background: #1a2422; border: 1px solid #405248; padding: 7px; }
QMenu::item { padding: 10px 24px; border-radius: 6px; }
QMenu::item:selected { background: #2a4034; }
QPushButton:focus, QLineEdit:focus, QPlainTextEdit:focus { border-color: #8ebda2; }
QCheckBox { spacing: 10px; background: transparent; }
QCheckBox::indicator { width: 17px; height: 17px; border: 1px solid #556b5f; border-radius: 5px; background: #18211e; }
QCheckBox::indicator:checked { background: #9ed8b9; border-color: #9ed8b9; }
QToolTip { color: #e8f1eb; background: #25352c; border: 1px solid #496351; padding: 6px; }

QComboBox { background: #1c2825; border: 1px solid #384b41; border-radius: 7px; padding: 9px; }
QPlainTextEdit, QListWidget { background: #161f22; border: 1px solid #2d3d38; border-radius: 8px; padding: 8px; }
QPushButton#navigation { text-align: left; background: transparent; border: none; padding: 12px; color: #95aaa0; }
QPushButton#navigation:checked { background: #1b352a; color: #bcebd1; }
QWidget { background: #141b1e; color: #e9eeec; font-family: "Segoe UI"; font-size: 14px; }
QFrame#rail { background: #0c1114; border-right: 1px solid #253036; }
QFrame#rail QLabel { background: transparent; }
QLabel#brand { font-size: 21px; font-weight: 700; letter-spacing: -0.5px; }
QLabel#eyebrow { color: #80928c; font-size: 10px; font-weight: 600; letter-spacing: 2px; }
QLabel#title { font-size: 32px; font-weight: 600; letter-spacing: -1px; }
QLabel#muted { color: #90a19b; }
QLabel#small { color: #92a49a; font-size: 12px; }
QLabel#badge { background: #16352b; color: #a6edc6; border-radius: 10px; padding: 5px 10px; font-size: 12px; }
QLabel#neutralBadge { background: #202a2e; color: #a0b1aa; border-radius: 10px; padding: 5px 10px; font-size: 12px; }
QFrame#rail QLabel#nav { background: #1b2c27; color: #b8f0d1; border-radius: 8px; padding: 12px 15px; font-weight: 600; }
QFrame#connection { background: #18221f; border: 1px solid #31463b; border-radius: 14px; }
QFrame#connection QLabel { background: transparent; border: none; }
QLabel#connectionTitle { font-size: 16px; font-weight: 600; }
QPushButton { background: #222e2a; border: 1px solid #384a42; border-radius: 7px; padding: 9px 15px; color: #dce9e2; font-weight: 600; }
QPushButton:hover { background: #2e4037; border-color: #5d7d6a; }
QPushButton:pressed { background: #3d5146; }
QPushButton:disabled { background: #18201d; color: #53635b; border-color: #28342e; }
QPushButton#primary { background: #a9edc6; color: #11291d; border: 1px solid #a9edc6; }
QPushButton#primary:hover { background: #c3f7d8; }
QPushButton#primary:disabled { background: #364e41; color: #7f9b89; border-color: #364e41; }
QPushButton#quiet { background: transparent; border: none; color: #8ca197; text-align: left; padding: 8px 0; }
QPushButton#quiet:hover { color: #c6e4d2; }
QLineEdit { background: #181f23; border: 1px solid #2b363b; border-radius: 8px; padding: 11px 14px; selection-background-color: #3b6752; }
QLineEdit:focus { border-color: #81b99a; }
QScrollArea { border: none; background: transparent; }
QScrollBar:vertical { background: #111619; width: 7px; margin: 0; }
QScrollBar::handle:vertical { background: #34443d; border-radius: 3px; min-height: 35px; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
QFrame#modelCard { background: #192024; border: 1px solid #2a3539; border-radius: 10px; }
QFrame#modelCard:hover { background: #1d2828; border-color: #425b4e; }
QFrame#modelCard QLabel { background: transparent; border: none; }
QLabel#modelName { font-size: 15px; font-weight: 600; }
QLabel#modelId { color: #82958b; font-family: 'Cascadia Code', 'Consolas'; font-size: 12px; }
QFrame#modelCard QLabel#modelMark { color: #9cc8af; font-size: 20px; background: #22332b; border-radius: 9px; }
QLabel#available { color: #97c3a8; font-size: 12px; }
QLabel#status { color: #9bb0a3; font-size: 12px; }
QLabel#emptyTitle { font-size: 21px; font-weight: 600; }
'''


def label(text, name=None):
    widget = QLabel(text)
    widget.setTextFormat(Qt.TextFormat.PlainText)
    if name:
        widget.setObjectName(name)
    return widget


class Interface:
    def setup(self, window):
        window.setStyleSheet(STYLE)
        shell = QHBoxLayout(window)
        shell.setContentsMargins(0, 0, 0, 0)
        shell.setSpacing(0)
        rail = QFrame()
        self.rail = rail
        rail.setObjectName('rail')
        rail.setFixedWidth(224)
        left = QVBoxLayout(rail)
        left.setContentsMargins(16, 20, 16, 16)
        left.setSpacing(16)
        brand_row = QHBoxLayout()
        mark = QLabel()
        mark.setPixmap(logo(34))
        brand_row.addWidget(mark)
        brand_row.addWidget(label('Steve', 'brand'), 1)
        left.addLayout(brand_row)
        left.addSpacing(8)
        left.addWidget(label('PROJECT', 'eyebrow'))
        self.project_tree = QTreeWidget()
        self.project_tree.setHeaderHidden(True)
        self.project_tree.setIndentation(14)
        self.project_tree.setMinimumHeight(180)
        left.addWidget(self.project_tree, 2)
        self.new_chat = QPushButton('New task')
        self.new_chat.setIcon(icon('plus'))
        self.new_chat.setCursor(Qt.CursorShape.PointingHandCursor)
        left.addWidget(self.new_chat)
        self.chat_search = QLineEdit()
        self.chat_search.setPlaceholderText('Search conversations')
        self.chat_search.setClearButtonEnabled(True)
        left.addWidget(self.chat_search)
        left.addWidget(label('TASKS', 'eyebrow'))
        self.chat_list = QListWidget()
        self.chat_list.setObjectName('chatList')
        self.chat_list.setStyleSheet('QListWidget { background: transparent; border: none; padding: 0; } QListWidget::item { padding: 12px 8px; border-radius: 8px; } QListWidget::item:selected { background: #243b31; color: #d4efdf; }')
        left.addWidget(self.chat_list, 1)
        self.settings_toggle = AccordionButton()
        self.settings_toggle.setCheckable(True)
        self.settings_toggle.setObjectName('navigation')
        left.addWidget(self.settings_toggle)
        self.settings_menu = QWidget()
        self.settings_menu.setStyleSheet('QWidget { background: transparent; }')
        settings_layout = QVBoxLayout(self.settings_menu)
        settings_layout.setContentsMargins(12, 2, 0, 6)
        settings_layout.setSpacing(3)
        self.nav_models = QPushButton('Account')
        self.nav_tools = QPushButton('Tools && MCP')
        self.nav_agent = QPushButton('Agent preferences')
        for button, symbol in ((self.nav_models, 'account'), (self.nav_tools, 'plug'), (self.nav_agent, 'sliders')):
            button.setIcon(icon(symbol, size=18))
            button.setCursor(Qt.CursorShape.PointingHandCursor)
        for button in (self.nav_models, self.nav_tools, self.nav_agent):
            button.setObjectName('navigation')
            button.setCheckable(True)
            settings_layout.addWidget(button)
        self.logout = QPushButton('Sign out')
        self.logout.setObjectName('navigation')
        self.logout.setIcon(icon('logout', size=18))
        settings_layout.addWidget(self.logout)
        left.addWidget(self.settings_menu)
        self.settings_menu.hide()
        self.settings_toggle.toggled.connect(self.settings_menu.setVisible)
        self.settings_toggle.toggled.connect(lambda _: self.settings_toggle.update())
        self.session = label('Not connected', 'small')
        left.addWidget(self.session)
        shell.addWidget(rail)
        main = QWidget()
        content = QVBoxLayout(main)
        content.setContentsMargins(32, 29, 32, 22)
        content.setSpacing(18)
        top = QHBoxLayout()
        top.addWidget(label('SETTINGS / ACCOUNT', 'eyebrow'))
        top.addStretch()
        self.badge = label('NOT CONNECTED', 'neutralBadge')
        top.addWidget(self.badge)
        content.addLayout(top)
        heading = QVBoxLayout()
        heading.setSpacing(5)
        heading.addWidget(label('Account', 'title'))
        heading.addWidget(label('Your ChatGPT subscription and model access.', 'muted'))
        content.addLayout(heading)
        connection = QFrame()
        connection.setObjectName('connection')
        account = QHBoxLayout(connection)
        account.setContentsMargins(20, 18, 20, 18)
        description = QVBoxLayout()
        description.setSpacing(5)
        description.addWidget(label('ChatGPT', 'connectionTitle'))
        self.account_detail = label('Connect your subscription to get started.', 'muted')
        description.addWidget(self.account_detail)
        account.addLayout(description, 1)
        self.login = QPushButton('Connect account')
        self.login.setObjectName('primary')
        account.addWidget(self.login)
        self.cancel = QPushButton('Cancel')
        self.cancel.hide()
        account.addWidget(self.cancel)
        content.addWidget(connection)
        tools = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText('Search models…')
        self.search.setClearButtonEnabled(True)
        tools.addWidget(self.search, 1)
        self.refresh = QPushButton('↻  Refresh')
        self.refresh.setToolTip('Fetch the latest model catalog for your account.')
        tools.addWidget(self.refresh)
        content.addLayout(tools)
        self.count = label('AVAILABLE MODELS', 'eyebrow')
        content.addWidget(self.count)
        self.pages = QStackedWidget()
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.list_widget = QWidget()
        self.cards = QVBoxLayout(self.list_widget)
        self.cards.setContentsMargins(0, 0, 9, 0)
        self.cards.setSpacing(8)
        self.cards.addStretch()
        self.scroll.setWidget(self.list_widget)
        self.pages.addWidget(self.scroll)
        empty = QWidget()
        empty_layout = QVBoxLayout(empty)
        empty_layout.addStretch()
        self.empty_title = label('A home for your models.', 'emptyTitle')
        self.empty_detail = label('Connect your ChatGPT account to see what’s available.', 'muted')
        for item in (self.empty_title, self.empty_detail):
            item.setAlignment(Qt.AlignmentFlag.AlignCenter)
            empty_layout.addWidget(item)
        empty_layout.addStretch()
        self.pages.addWidget(empty)
        self.pages.setCurrentIndex(1)
        content.addWidget(self.pages, 1)
        self.status = label('Ready when you are.', 'status')
        self.status.setWordWrap(True)
        content.addWidget(self.status)
        self.sections = QStackedWidget()
        self.sections.addWidget(main)
        shell.addWidget(self.sections, 1)
        self.models = []
        self.search.textChanged.connect(self.render_models)

    def set_connection(self, connected):
        self.session.setText('●  ChatGPT connected' if connected else 'Not connected')
        self.badge.setText('●  CONNECTED' if connected else 'NOT CONNECTED')
        self.badge.setObjectName('badge' if connected else 'neutralBadge')
        self.badge.style().unpolish(self.badge)
        self.badge.style().polish(self.badge)
        self.account_detail.setText('Subscription linked to this device.' if connected else 'Connect your subscription to get started.')
        self.login.setText('Reconnect' if connected else 'Connect account')

    def render_models(self):
        while self.cards.count() > 1:
            item = self.cards.takeAt(0)
            item.widget().deleteLater()
        query = self.search.text().casefold().strip()
        models = [m for m in self.models if query in (m.display_name + ' ' + m.slug).casefold()]
        self.count.setText(f'AVAILABLE MODELS   /   {len(models):02d}')
        self.pages.setCurrentIndex(0 if models else 1)
        if not models:
            self.empty_title.setText('No matching models.' if query else 'A home for your models.')
            self.empty_detail.setText('Try a different name or model ID.' if query else 'Connect or refresh your account to see available models.')
        for model in models:
            card = QFrame()
            card.setObjectName('modelCard')
            card.setFixedHeight(74)
            row = QHBoxLayout(card)
            row.setContentsMargins(16, 10, 18, 10)
            row.setSpacing(14)
            mark = label('◇', 'modelMark')
            mark.setFixedSize(40, 40)
            mark.setAlignment(Qt.AlignmentFlag.AlignCenter)
            row.addWidget(mark)
            text = QVBoxLayout()
            text.setSpacing(3)
            text.addWidget(label(model.display_name, 'modelName'))
            model_id = label(model.slug, 'modelId')
            model_id.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            text.addWidget(model_id)
            row.addLayout(text, 1)
            row.addWidget(label('●  Available', 'available'))
            self.cards.insertWidget(self.cards.count() - 1, card)

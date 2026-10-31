from pathlib import Path
from PySide6.QtWidgets import QMenu, QInputDialog, QFileDialog, QMessageBox


class ChatManagement:
    def save_draft(self):
        if self.active is not None:
            self.active['draft'] = self.composer.toPlainText()
            try:
                self.store.save({'chats': self.sessions})
            except OSError:
                self.state.setText('Draft could not be saved.')

    def filter_chats(self, *args):
        query = self.window.chat_search.text().casefold()
        for i, session in enumerate(self.sessions):
            self.chats.item(i).setHidden(query not in session['title'].casefold())

    def show_actions(self):
        menu = QMenu(self)
        rename = menu.addAction('Rename task…')
        export = menu.addAction('Export conversation…')
        menu.addSeparator()
        delete = menu.addAction('Delete task…')
        action = menu.exec(self.chat_actions.mapToGlobal(self.chat_actions.rect().bottomLeft()))
        if self.busy or not self.active:
            return
        if action == rename:
            text, ok = QInputDialog.getText(self, 'Rename task', 'Task name', text=self.active['title'])
            if ok and text.strip():
                self.active['title'] = text.strip()[:120]
                self.chat_title.setText(self.active['title'])
                self.reload_chats()
                self.save_draft()
        elif action == export:
            filename, _ = QFileDialog.getSaveFileName(self, 'Export conversation', 'conversation.txt', 'Text (*.txt)')
            if filename:
                Path(filename).write_text('\n\n'.join(m['role'] + '\n' + m['text'] for m in self.active['messages']), encoding='utf-8')
        elif action == delete:
            if QMessageBox.question(self, 'Delete task', 'Delete this conversation? CAD project files and revisions will be kept.') == QMessageBox.StandardButton.Yes:
                self.sessions.remove(self.active)
                self.active = None
                self.store.save({'chats': self.sessions})
                self.reload_chats()
                if self.sessions:
                    self.chats.setCurrentRow(0)
                    self.select_chat(0)
                else:
                    self.new_chat()

    def chat_context_menu(self, point):
        item = self.chats.itemAt(point)
        if item and not self.busy:
            self.chats.setCurrentItem(item)
            self.show_actions()

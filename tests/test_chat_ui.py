import asyncio
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from PySide6.QtWidgets import QApplication, QCheckBox, QPushButton
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from steve_desktop.app import Window
from steve_desktop.service import Service, ModelChoice
from steve_desktop.vault import Vault

APP = QApplication.instance() or QApplication([])


class ChatUITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.window = Window(Service(Vault(Path(self.temp.name) / 'auth.dpapi')))
        self.window.setAttribute(Qt.WidgetAttribute.WA_DontShowOnScreen)
        self.window.show()
        self.window.show_desktop('steve')
        self.window.show_result([ModelChoice(slug='test', display_name='Test', visibility='list')])

    def tearDown(self):
        if self.window.chat_panel.busy:
            self.window.chat_panel.stop_run()
            self.wait_for(lambda: not self.window.chat_panel.busy)
        self.window.close()
        APP.processEvents()
        self.temp.cleanup()

    def wait_for(self, predicate):
        end = time.monotonic() + 5
        while not predicate():
            if time.monotonic() > end:
                self.fail('UI worker timed out')
            QTest.qWait(10)
        APP.processEvents()

    def test_tools_execute_without_approval_prompts(self):
        decisions = []
        async def fake_chat(source, model, prompt, history, settings, approve, activity, delta):
            decisions.append(await approve('sample', 'sample_write', {'path': 'note.txt'}))
            decisions.append(await approve('Local', 'run_command', {'command': 'test'}))
            return 'Done.', []
        panel = self.window.chat_panel
        with patch('steve_desktop.chat_ui.chat', fake_chat):
            panel.composer.setPlainText('Run tools')
            panel.send_message()
            self.wait_for(lambda: not panel.busy)
        self.assertEqual(decisions, [True, True])
        self.assertIsNone(panel.dialog)
        self.assertNotIn('approval_mode', self.window.local_assistant.config())
        self.assertNotIn('approval_mode', self.window.local_assistant.settings()['agent'])

    def test_stop_restores_prompt_and_unblocks_ui(self):
        async def slow_chat(*args):
            await asyncio.sleep(60)
        panel = self.window.chat_panel
        with patch('steve_desktop.chat_ui.chat', slow_chat):
            panel.composer.setPlainText('My unfinished request')
            panel.send_message()
            QTest.qWait(50)
            panel.stop_run()
            self.wait_for(lambda: not panel.busy)
        self.assertEqual(panel.composer.toPlainText(), 'My unfinished request')
        self.assertTrue(panel.send.isEnabled())
        self.assertFalse(panel.stop.isEnabled())

    def test_sidebar_settings_prompt_and_model_effort(self):
        window = self.window
        panel = window.chat_panel
        self.assertIs(panel.chats, window.chat_list)
        for action in ('account', 'mcp', 'agent', 'steve'):
            window.show_desktop(action)
            self.assertIs(window.sections.currentWidget(), window.workspace)
            self.assertTrue(window.rail.isHidden())
        window.local_assistant.save_agent({'system_prompt': 'Answer succinctly.'})
        self.assertEqual(window.agent_settings.vault.load()['system_prompt'], 'Answer succinctly.')
        panel.update_models([ModelChoice(slug='test', display_name='Test', visibility='list',
            supported_reasoning_levels=[{'effort': 'low'}, {'effort': 'high'}, {'effort': 'ultra'}])])
        self.assertEqual([panel.effort.itemData(i) for i in range(panel.effort.count())], [None, 'low', 'high'])
        panel.effort.setCurrentIndex(2)
        received = []
        async def fake_chat(source, model, prompt, history, settings, *args):
            received.append(settings)
            return 'Done.', []
        window.new_chat.click()
        self.assertEqual(window.sections.currentWidget(), window.workspace)
        self.assertTrue(window.chat_panel.isHidden())
        self.assertIs(window.workspace, window.cad_panel)
        with patch('steve_desktop.chat_ui.chat', fake_chat):
            panel.composer.setPlainText('Hi')
            panel.send_message()
            self.wait_for(lambda: not panel.busy)
        self.assertEqual(received[0]['system_prompt'], 'Answer succinctly.')
        self.assertEqual(received[0]['reasoning_effort'], 'high')
        self.assertEqual(panel.active['reasoning_effort'], 'high')

    def test_ctrl_enter_sends_once_and_enter_inserts_newline(self):
        calls = []
        async def fake_chat(source, model, prompt, *args):
            calls.append(prompt)
            await asyncio.sleep(0.15)
            return 'Sent.', []
        panel = self.window.chat_panel
        with patch('steve_desktop.chat_ui.chat', fake_chat):
            panel.composer.setPlainText('Hello')
            panel.composer.moveCursor(panel.composer.textCursor().MoveOperation.End)
            QTest.keyClick(panel.composer, Qt.Key.Key_Return)
            self.assertEqual(panel.composer.toPlainText(), 'Hello\n')
            self.assertEqual(calls, [])
            QTest.keyClick(panel.composer, Qt.Key.Key_Return, Qt.KeyboardModifier.ControlModifier)
            QTest.keyClick(panel.composer, Qt.Key.Key_Return, Qt.KeyboardModifier.ControlModifier)
            self.wait_for(lambda: not panel.busy)
        self.assertEqual(calls, ['Hello'])
        self.assertEqual(panel.composer.toPlainText(), '')

    def test_wide_window_keeps_readable_column_and_hides_empty_activity(self):
        self.window.resize(1900, 1000)
        APP.processEvents()
        panel = self.window.chat_panel
        self.assertLessEqual(panel.column.width(), 980)
        self.assertGreaterEqual(panel.column.width(), 300)
        self.window.resize(1030, 820)
        APP.processEvents()
        self.assertGreater(panel.column.width(), 280)
        self.assertTrue(panel.activity_log.isHidden())
        self.assertTrue(panel.activity_toggle.isHidden())
        panel.on_activity('Completed · Local / calculate')
        self.assertFalse(panel.activity_toggle.isHidden())
        panel.activity_toggle.click()
        self.assertFalse(panel.activity_log.isHidden())


if __name__ == '__main__':
    unittest.main()

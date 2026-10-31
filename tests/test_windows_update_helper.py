import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from steve_desktop import windows_update_helper as helper


class PythonUpdateHelper(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # Windows runners may expose TEMP through its 8.3 alias; the updater
        # resolves paths before persisting or launching them.
        self.root = Path(self.temp.name).resolve()
        self.installed = self.root / 'Programs/Steve'
        self.profile = self.root / 'profile'
        self.candidate = self.profile / 'updates/job/Steve'
        self.installed.mkdir(parents=True)
        self.candidate.mkdir(parents=True)
        (self.installed / 'Steve.exe').write_bytes(b'old')
        (self.candidate / 'Steve.exe').write_bytes(b'new')
        (self.installed / 'uninstall').mkdir()
        (self.installed / 'uninstall/record.dat').write_bytes(b'installer')
        (self.profile / 'windows-update.dpapi').write_bytes(b'authenticated-state')

    def run_update(self):
        with patch.object(helper, 'staged', return_value=self.candidate), \
                patch.object(helper, 'wait_for_exit'), patch.object(helper.os, 'chdir'), \
                patch.object(helper, 'running', return_value=False):
            code = helper.apply(self.installed, self.profile, 123, 1)
        report = json.loads((self.profile / 'updates/last-update.json').read_text())
        self.assertFalse((self.profile / 'windows-update.dpapi').exists())
        return code, report

    def test_replacement_preserves_installer_and_reports_success(self):
        with patch.object(helper, 'smoke'):
            code, report = self.run_update()
        self.assertEqual((code, report['status']), (0, 'installed'))
        self.assertEqual((self.installed / 'Steve.exe').read_bytes(), b'new')
        self.assertEqual((self.installed / 'uninstall/record.dat').read_bytes(), b'installer')
        self.assertFalse(self.installed.with_name('Steve.previous').exists())

    def test_failed_startup_leaves_old_installation_untouched(self):
        with patch.object(helper, 'smoke', side_effect=RuntimeError('startup failed')):
            code, report = self.run_update()
        self.assertEqual((code, report['status']), (1, 'failed'))
        self.assertEqual((self.installed / 'Steve.exe').read_bytes(), b'old')
        self.assertIn('startup failed', report['error'])

    def test_failed_swap_restores_previous_version(self):
        original = Path.rename
        def rename(path, destination):
            if path == self.candidate:
                raise PermissionError('replacement blocked')
            return original(path, destination)
        with patch.object(helper, 'smoke'), patch.object(Path, 'rename', rename):
            code, report = self.run_update()
        self.assertEqual(code, 1)
        self.assertEqual((self.installed / 'Steve.exe').read_bytes(), b'old')
        self.assertIn('replacement blocked', report['error'])

    def test_reopened_app_prevents_swap(self):
        with patch.object(helper, 'smoke'), patch.object(helper, 'running', side_effect=[False, True]):
            with self.assertRaisesRegex(RuntimeError, 'reopened'):
                helper.activate(self.installed, self.candidate, self.profile / 'updates', lambda _: None)
        self.assertEqual((self.installed / 'Steve.exe').read_bytes(), b'old')

    @unittest.skipUnless(os.name == 'nt', 'Windows DPAPI')
    def test_helper_rechecks_authenticated_signature_and_files(self):
        from steve_desktop.vault import Vault
        from steve_desktop.windows_updates import remember
        from tests.update_signing import keypair, sign
        key, public = keypair()
        Vault(self.profile / 'updates.dpapi').save({'override': {'source': 'https://example.test/windows/latest.json', 'public_keys': [public]}})
        manifest = sign(key, version='99.0.0', platform='windows-x64', url='https://example.test/update.zip', sha256='a' * 64)
        remember(self.profile, self.candidate, manifest)
        self.assertEqual(helper.staged(self.profile), self.candidate)
        (self.candidate / 'Steve.exe').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'changed'):
            helper.staged(self.profile)
        (self.candidate / 'Steve.exe').write_bytes(b'new')
        state = Vault(self.profile / 'windows-update.dpapi').load()
        state['manifest']['version'] = '100.0.0'
        Vault(self.profile / 'windows-update.dpapi').save(state)
        with self.assertRaisesRegex(ValueError, 'trusted'):
            helper.staged(self.profile)

    @unittest.skipUnless(os.name == 'nt', 'Windows process launch')
    def test_launch_copies_windowless_helper_outside_installation(self):
        import subprocess
        from steve_desktop import windows_updates
        resources = self.root / 'resources'
        (resources / 'packaging').mkdir(parents=True)
        (resources / 'packaging/SteveUpdate.exe').write_bytes(b'helper')
        with patch.object(windows_updates, 'RESOURCE_ROOT', resources), \
                patch.object(windows_updates.subprocess, 'Popen') as spawn:
            windows_updates.launch(self.profile, self.candidate, restart=True)
        command = spawn.call_args.args[0]
        self.assertEqual(Path(command[0]), self.profile / 'updates/SteveUpdate.exe')
        self.assertIn('--restart', command)
        self.assertEqual(spawn.call_args.kwargs['creationflags'], subprocess.CREATE_NO_WINDOW)
        self.assertNotIn('powershell', ' '.join(command).lower())

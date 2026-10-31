import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from steve_desktop.vault import Vault
from steve_desktop.windows_updates import remember,pending
from tests.update_signing import expires_in, keypair, sign

class StagedWindowsUpdates(unittest.TestCase):
    def test_restart_verifies_files_signature_and_version(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);candidate=profile/'updates/job/Steve';candidate.mkdir(parents=True)
            (candidate/'Steve.exe').write_bytes(b'test runtime')
            key,public=keypair()
            Vault(profile/'updates.dpapi').save({'override':{'source':'https://example.test/windows/latest.json','public_keys':[public]},'automatic':True})
            # Staged updates stay installable after the feed manifest's expiry.
            manifest=sign(key,version='99.0.0',platform='windows-x64',url='https://example.test/update.zip',sha256='a'*64,expires=expires_in(-1))
            remember(profile,candidate,manifest)
            self.assertEqual(pending(profile),candidate)
            (candidate/'Steve.exe').write_bytes(b'changed runtime')
            with self.assertRaisesRegex(ValueError,'changed'):pending(profile)
            (candidate/'Steve.exe').write_bytes(b'test runtime')
            with patch('steve_desktop.local_updates.VERSION','99.0.0'):
                self.assertIsNone(pending(profile))
            self.assertFalse((profile/'windows-update.dpapi').exists())

    def test_failure_report_visible_after_restart(self):
        from fastapi import FastAPI
        from types import SimpleNamespace
        from steve_desktop.local_updates import LocalUpdates
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);(profile/'updates').mkdir()
            (profile/'updates/last-update.json').write_text(json.dumps({'status':'failed','error':'Installation is locked'}),encoding='utf-8-sig')
            with patch('steve_desktop.local_updates.update_platform',return_value='windows-x64'):
                updater=LocalUpdates(SimpleNamespace(folder=profile/'cad',app=FastAPI()))
                try:
                    self.assertTrue(updater.status()['update_error'])
                    self.assertIn('Installation is locked',updater.status()['message'])
                finally:updater.close()

    def test_successful_current_release_check_clears_old_failure(self):
        import httpx
        from fastapi import FastAPI
        from types import SimpleNamespace
        from steve_desktop.local_updates import LocalUpdates, VERSION
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);(profile/'updates').mkdir()
            report=profile/'updates/last-update.json'
            report.write_text(json.dumps({'status':'failed','error':'Old helper locked installation'}))
            key,public=keypair()
            manifest=sign(key,version=VERSION,platform='windows-x64',url='https://example.test/update.zip',sha256='a'*64)
            Vault(profile/'updates.dpapi').save({'override':{'source':'https://example.test/windows/latest.json','public_keys':[public]},'automatic':False})
            client=httpx.Client
            with patch('steve_desktop.local_updates.update_platform',return_value='windows-x64'):
                updater=LocalUpdates(SimpleNamespace(folder=profile/'cad',app=FastAPI()))
                try:
                    self.assertTrue(updater.update_error)
                    with patch('steve_desktop.local_updates.httpx.Client',side_effect=lambda **kw:client(transport=httpx.MockTransport(lambda request:httpx.Response(200,json=manifest)),**kw)):
                        updater.check()
                    self.assertFalse(updater.update_error)
                    self.assertEqual(updater.message,'Steve is up to date.')
                    self.assertFalse(report.exists())
                finally:updater.close()

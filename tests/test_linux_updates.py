import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import patch, Mock

import httpx
from fastapi import FastAPI

from steve_desktop import linux_updates as linux
from steve_desktop.local_updates import LocalUpdates, verify_manifest
from steve_desktop.vault import Vault
from tests.update_signing import expires_in, keypair, sign


@unittest.skipUnless(sys.platform == 'linux', 'Linux bundle updater')
class LinuxUpdateTests(unittest.TestCase):
    def setUp(self):
        # This suite models 0.3.5 -> 0.3.6 independently of the release version.
        self.enterContext(patch('steve_desktop.local_updates.VERSION', '0.3.5'))
        self.temp = tempfile.TemporaryDirectory(prefix='steve updates ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = self.root / 'profile'
        self.profile.mkdir()
        self.key, self.public = keypair()
        Vault(self.profile / 'updates.dpapi').save({'override': {'source': 'https://feed.test/linux/latest.json', 'public_keys': [self.public]}, 'automatic': True})
        (self.profile / 'drawing.step').write_bytes(b'user project')

    def package(self, version='0.3.6', smoke=0, ready=True, reported=None):
        directory = self.root / ('fixture-' + str(time.monotonic_ns()))
        app = directory / 'Steve'
        binary = app / 'usr/lib/steve/Steve'
        binary.parent.mkdir(parents=True)
        binary.write_text(f'#!{sys.executable}\n'
            'import json,os,sys\n'
            f'if "--update-info" in sys.argv: print(json.dumps({{"version":{reported or version!r}}}))\n'
            f'elif "--smoke-test" in sys.argv: sys.exit({smoke})\n'
            'else:\n'
            ' fd=os.environ.get("STEVE_BUNDLE_READY_FD")\n'
            f' if fd and {ready!r}: os.write(int(fd),b"1");os.close(int(fd))\n'
            f' sys.exit({0 if ready else 9})\n')
        binary.chmod(0o755)
        (binary.parent / 'library.so.1').write_bytes(b'bundled native library')
        (binary.parent / 'library.so').symlink_to('library.so.1')
        (app / 'bundle.json').write_text(json.dumps({'schema': 1, 'version': version, 'platform': 'linux-x64'}))
        archive = directory / 'bundle.tar.gz'
        with tarfile.open(archive, 'w:gz', dereference=False) as tar:
            tar.add(app, arcname='Steve')
        return archive, sign(self.key, version=version, platform='linux-x64', url='https://feed.test/linux/bundle.tar.gz',
                             sha256=linux.digest(archive))

    def stage(self, **kwargs):
        archive, manifest = self.package(**kwargs)
        return linux.stage_bundle(self.profile, archive, manifest, self.public, 'feed.test')

    def updater(self):
        updater = LocalUpdates(SimpleNamespace(folder=self.profile / 'cad', app=FastAPI()))
        self.addCleanup(updater.close)
        return updater

    def test_linux_is_automatic_by_default(self):
        Vault(self.profile / 'updates.dpapi').save({'override': {'source': 'https://feed.test/linux/latest.json', 'public_keys': [self.public]}})
        updater = self.updater()
        self.assertTrue(updater.status()['supports_updates'])
        self.assertTrue(updater.status()['automatic'])

    def test_linux_signature_platform_and_checksum_are_required(self):
        archive, manifest = self.package()
        self.assertEqual(verify_manifest(manifest, self.public, 'linux-x64', host='feed.test')['platform'], 'linux-x64')
        with self.assertRaises(ValueError):verify_manifest(manifest, self.public, 'windows-x64', host='feed.test')
        with self.assertRaises(Exception):linux.stage_bundle(self.profile, archive, {**manifest, 'version': '0.3.7'}, self.public, 'feed.test')
        archive.write_bytes(archive.read_bytes() + b'tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):linux.stage_bundle(self.profile, archive, manifest, self.public, 'feed.test')
        self.assertFalse(linux.state_vault(self.profile).load().get('pending'))

    def test_safe_internal_links_survive_and_inventory_detects_corruption(self):
        bundle = self.stage()
        app = linux.verify_bundle(self.profile, bundle)
        self.assertTrue((app.parent / 'library.so').is_symlink())
        (app.parent / 'library.so.1').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'):linux.verify_bundle(self.profile, bundle)

    def test_traversal_devices_hard_links_and_escaping_symlinks_are_rejected(self):
        for name, kind, link in [('../escape', tarfile.REGTYPE, ''),
                                  ('/Steve/escape', tarfile.REGTYPE, ''),
                                  ('Steve/link', tarfile.SYMTYPE, '../../escape'),
                                  ('Steve/hard', tarfile.LNKTYPE, 'Steve/file'),
                                  ('Steve/device', tarfile.CHRTYPE, '')]:
            with self.subTest(name=name, kind=kind):
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode='w:gz') as tar:
                    member = tarfile.TarInfo(name)
                    member.type, member.linkname = kind, link
                    tar.addfile(member)
                output.seek(0)
                archive = self.root / 'unsafe.tar.gz'
                archive.write_bytes(output.read())
                with self.assertRaises((ValueError, tarfile.TarError)):
                    linux.extract_bundle(archive, self.root / ('unsafe-' + str(time.monotonic_ns())))
        self.assertFalse((self.root / 'escape').exists())

    def test_activation_preserves_projects_and_keeps_previous_version(self):
        first = self.stage(version='0.3.5')
        self.assertEqual(linux.activate(self.profile, first['directory'], 9999999), 0)
        second = self.stage(version='0.3.6')
        self.assertEqual(linux.activate(self.profile, second['directory'], 9999999), 0)
        state = linux.state_vault(self.profile).load()
        self.assertEqual(state['active'], second)
        self.assertEqual(state['previous'], first)
        self.assertNotIn('pending', state)
        self.assertEqual((self.profile / 'drawing.step').read_bytes(), b'user project')

    def test_failed_smoke_and_wrong_version_keep_working_version(self):
        working = self.stage(version='0.3.5')
        self.assertEqual(linux.activate(self.profile, working['directory'], 9999999), 0)
        for options in ({'smoke': 1}, {'reported': '0.3.4'}):
            failed = self.stage(**options)
            self.assertEqual(linux.activate(self.profile, failed['directory'], 9999999), 1)
            state = linux.state_vault(self.profile).load()
            self.assertEqual(state['active'], working)
            self.assertIn(failed['manifest']['sha256'], state['failed'])
            self.assertNotIn('pending', state)

    def fetch(self, updater, manifest, archive=None):
        feed = 'https://feed.test/linux/latest.json'
        calls = []
        def handle(request):
            calls.append(str(request.url))
            self.assertNotIn('authorization', request.headers)
            if str(request.url) == feed:
                return httpx.Response(200, json=manifest)
            self.assertEqual(str(request.url), manifest['url'])
            return httpx.Response(200, content=archive.read_bytes())
        client = httpx.Client
        with patch('steve_desktop.local_updates.httpx.Client', side_effect=lambda **kw: client(transport=httpx.MockTransport(handle), **kw)):
            updater.check()
        return calls

    def test_download_from_the_feed_without_credentials(self):
        updater = self.updater()
        archive, manifest = self.package()
        calls = self.fetch(updater, manifest, archive)
        self.assertTrue(updater.status()['ready'], updater.message)
        self.assertEqual(calls, ['https://feed.test/linux/latest.json', manifest['url']])
        self.assertEqual(updater.linux_pending['manifest'], manifest)
        restored = self.updater()
        self.assertTrue(restored.status()['ready'])
        self.assertEqual(restored.linux_pending, updater.linux_pending)

    def test_tampered_expired_or_foreign_host_manifests_download_nothing(self):
        archive, manifest = self.package()
        expired = sign(self.key, **{k: manifest[k] for k in ('version', 'platform', 'url', 'sha256')}, expires=expires_in(-1))
        elsewhere = sign(self.key, **{k: manifest[k] for k in ('version', 'platform', 'sha256')}, url='https://other.test/bundle.tar.gz')
        for name, bad, message in (('tampered', {**manifest, 'version': '9.9.9'}, 'trusted'), ('expired', expired, 'expired'),
                                   ('foreign host', elsewhere, 'feed.test'), ('unsigned expiry', {**manifest, 'expires': expires_in(400)}, 'trusted')):
            with self.subTest(name):
                updater = self.updater()
                calls = self.fetch(updater, bad)
                self.assertEqual(calls, ['https://feed.test/linux/latest.json'])
                self.assertFalse(updater.status()['ready'])
                self.assertTrue(updater.status()['update_error'])
                self.assertIn(message, updater.status()['message'])
                self.assertFalse(linux.state_vault(self.profile).load().get('pending'))
        self.assertEqual((self.profile/'drawing.step').read_bytes(), b'user project')

    def test_installed_bundle_keeps_working_after_its_feed_manifest_expires(self):
        bundle = self.stage()
        with patch('steve_desktop.update_manifest.datetime') as clock:
            clock.now.return_value = datetime.now(timezone.utc) + timedelta(days=400)
            clock.fromisoformat = datetime.fromisoformat
            self.assertTrue(linux.verify_bundle(self.profile, bundle).is_file())

    def test_opt_out_is_preserved_and_does_not_schedule_install(self):
        updater = self.updater()
        bundle = self.stage()
        updater.pending = linux.executable(self.profile, bundle)
        updater.linux_pending = bundle
        updater.config['automatic'] = False
        with patch('steve_desktop.local_updates.sys.frozen', True, create=True), \
             patch('steve_desktop.linux_updates.schedule_activation') as schedule:
            updater.close()
            schedule.assert_not_called()

    def test_background_linux_check_runs_without_user_action(self):
        updater = self.updater()
        updater.closed = Mock()
        updater.closed.wait.side_effect = [False, True]
        with patch('steve_desktop.local_updates.sys.frozen', True, create=True), \
             patch.object(updater, 'check') as check:
            updater.background()
            check.assert_called_once()

    def test_helper_waits_for_the_running_application_to_exit(self):
        bundle = self.stage()
        parent = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
        self.addCleanup(lambda: parent.terminate() if parent.poll() is None else None)
        helper = subprocess.Popen([sys.executable, '-m', 'steve_desktop', '--apply-linux-update',
            str(self.profile), bundle['directory'], str(parent.pid)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(.5)
            self.assertIsNone(helper.poll())
            self.assertFalse(linux.state_vault(self.profile).load().get('active'))
            parent.terminate()
            parent.wait(10)
            out, err = helper.communicate(timeout=30)
            self.assertEqual(helper.returncode, 0, (out, err))
            self.assertEqual(linux.state_vault(self.profile).load()['active'], bundle)
        finally:
            if helper.poll() is None:helper.kill();helper.wait()

    def test_failed_real_start_rolls_back_to_previous_healthy_bundle(self):
        previous = self.stage(version='0.3.5')
        self.assertEqual(linux.activate(self.profile, previous['directory'], 9999999), 0)
        failed = self.stage(version='0.3.6', ready=False)
        self.assertEqual(linux.activate(self.profile, failed['directory'], 9999999), 0)
        with patch('steve_desktop.linux_updates.sys.frozen', True, create=True), \
             patch('steve_desktop.local_updates.VERSION', '0.3.4'), \
             patch('steve_desktop.vault.data_directory', return_value=self.profile):
            self.assertEqual(linux.bootstrap(), 0)
        state = linux.state_vault(self.profile).load()
        self.assertEqual(state['active'], previous)
        self.assertIn(failed['manifest']['sha256'], state['failed'])

    def test_corrupt_first_update_falls_back_to_original_package(self):
        bundle = self.stage()
        self.assertEqual(linux.activate(self.profile, bundle['directory'], 9999999), 0)
        linux.executable(self.profile, bundle).write_bytes(b'corrupt')
        with patch('steve_desktop.linux_updates.sys.frozen', True, create=True), \
             patch('steve_desktop.local_updates.VERSION', '0.3.4'), \
             patch('steve_desktop.vault.data_directory', return_value=self.profile):
            self.assertIsNone(linux.bootstrap())
        self.assertIsNone(linux.state_vault(self.profile).load()['active'])

    def test_next_gui_launch_completes_an_interrupted_shutdown(self):
        bundle=self.stage()
        with patch('steve_desktop.linux_updates.sys.frozen',True,create=True), \
             patch('steve_desktop.linux_updates.sys.argv',['Steve']), \
             patch('steve_desktop.local_updates.VERSION','0.3.4'), \
             patch('steve_desktop.vault.data_directory',return_value=self.profile):
            self.assertEqual(linux.bootstrap(),0)
        self.assertEqual(linux.state_vault(self.profile).load()['active'],bundle)

    def test_startup_recovery_respects_opt_out(self):
        self.stage()
        Vault(self.profile/'updates.dpapi').save({'override':{'source':'https://feed.test/linux/latest.json','public_keys':[self.public]},'automatic':False})
        with patch('steve_desktop.linux_updates.sys.frozen',True,create=True), \
             patch('steve_desktop.linux_updates.sys.argv',['Steve']), \
             patch('steve_desktop.vault.data_directory',return_value=self.profile), \
             patch('steve_desktop.linux_updates.activate') as activate:
            self.assertIsNone(linux.bootstrap())
            activate.assert_not_called()

    def test_atomic_state_write_failure_retains_active_and_pending(self):
        working=self.stage(version='0.3.5')
        self.assertEqual(linux.activate(self.profile,working['directory'],9999999),0)
        pending=self.stage()
        original=Vault.save
        def save(vault,value):
            if vault.path==self.profile/'update-state.dpapi' and value.get('active')==pending:
                raise OSError(28,'Simulated disk full')
            return original(vault,value)
        with patch.object(Vault,'save',new=save):
            self.assertEqual(linux.activate(self.profile,pending['directory'],9999999),1)
        state=linux.state_vault(self.profile).load()
        self.assertEqual(state['active'],working)
        self.assertEqual(state['pending'],pending)
        self.assertNotIn(pending['manifest']['sha256'],state.get('failed',[]))

    def test_interrupted_download_does_not_change_the_working_bundle(self):
        working=self.stage(version='0.3.5')
        self.assertEqual(linux.activate(self.profile,working['directory'],9999999),0)
        updater=self.updater()
        archive,manifest=self.package()
        class BrokenDownload(httpx.SyncByteStream):
            def __iter__(self):
                yield archive.read_bytes()[:100]
                raise httpx.ReadError('Simulated interrupted download')
        def handle(request):
            return httpx.Response(200,json=manifest) if request.url.host=='feed.test' else httpx.Response(200,stream=BrokenDownload())
        client=httpx.Client
        with patch('steve_desktop.local_updates.httpx.Client',side_effect=lambda **kw:client(transport=httpx.MockTransport(handle),**kw)):
            updater.check()
        self.assertFalse(updater.status()['ready'])
        state=linux.state_vault(self.profile).load()
        self.assertEqual(state['active'],working)
        self.assertNotIn('pending',state)
        self.assertEqual(linux.verify_bundle(self.profile,working),linux.executable(self.profile,working))

    def test_reopened_app_defers_activation(self):
        from PySide6.QtCore import QLockFile
        bundle=self.stage()
        lock=QLockFile(str(self.profile/'instance.lock'))
        self.assertTrue(lock.tryLock(0))
        try:
            self.assertEqual(linux.activate(self.profile,bundle['directory'],9999999),0)
            state=linux.state_vault(self.profile).load()
            self.assertEqual(state['pending'],bundle)
            self.assertFalse(state.get('active'))
        finally:lock.unlock()

    def test_transient_candidate_startup_failure_is_retried_before_quarantine(self):
        bundle=self.stage()
        probe=SimpleNamespace(returncode=0,stdout=json.dumps({'version':'0.3.6'}))
        with patch('steve_desktop.linux_updates.subprocess.run',side_effect=[probe,SimpleNamespace(returncode=1),SimpleNamespace(returncode=0)]) as run:
            self.assertEqual(linux.activate(self.profile,bundle['directory'],9999999),0)
            self.assertEqual(run.call_count,3)
        self.assertEqual(linux.state_vault(self.profile).load()['active'],bundle)

    def test_transient_relaunch_failure_keeps_the_new_version_after_retry(self):
        bundle=self.stage()
        self.assertEqual(linux.activate(self.profile,bundle['directory'],9999999),0)
        with patch('steve_desktop.linux_updates.sys.frozen',True,create=True), \
             patch('steve_desktop.vault.data_directory',return_value=self.profile), \
             patch('steve_desktop.linux_updates.launch_bundle',side_effect=[None,0]) as launch:
            self.assertEqual(linux.bootstrap(),0)
            self.assertEqual(launch.call_count,2)
        self.assertEqual(linux.state_vault(self.profile).load()['active'],bundle)

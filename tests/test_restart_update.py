"""Restart and update: the local route, LocalUpdates.close() per platform and Linux reopen after activation."""
import os
from pathlib import Path
import queue
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from steve_desktop import linux_updates as linux
from steve_desktop.local_updates import LocalUpdates
from steve_desktop.vault import Vault


def local_app():
    # LocalCadServer answers a refused local request (ValueError) with 422; mirror it here.
    app = FastAPI()
    app.add_exception_handler(ValueError, lambda request, exc: JSONResponse({'detail': str(exc)}, status_code=422))
    return app


class RestartUpdates(unittest.TestCase):
    platform = 'windows-x64'

    def setUp(self):
        self.enterContext(patch('steve_desktop.local_updates.update_platform', return_value=self.platform))
        self.enterContext(patch('steve_desktop.local_updates.supports_portable_updates', return_value=True))
        self.folder = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.actions = queue.Queue()
        self.app = local_app()
        self.updater = LocalUpdates(SimpleNamespace(folder=self.folder / 'cad', app=self.app, desktop_actions=self.actions))
        self.addCleanup(self.updater.closed.set)
        self.http = TestClient(self.app, raise_server_exceptions=False)

    def restart(self):
        return self.http.post('/v1/local/updates/restart')

    def packaged(self, executable='/opt/Steve/Steve.exe'):
        return patch.multiple(sys, frozen=True, executable=executable, create=True)

    def assert_refused(self, response):
        self.assertEqual(response.status_code, 422)
        self.assertFalse(self.updater.restart_requested)
        self.assertFalse(self.updater.apply_requested)
        self.assertTrue(self.actions.empty())


class RestartRoute(RestartUpdates):
    def test_refused_in_unpackaged_steve(self):
        self.updater.pending = self.folder / 'updates/job/Steve'
        self.assertFalse(getattr(sys, 'frozen', False))
        self.assert_refused(self.restart())

    def test_refused_without_a_staged_update(self):
        with self.packaged():
            self.assert_refused(self.restart())

    def test_refused_when_installed_folder_cannot_be_replaced(self):
        self.updater.pending = self.folder / 'updates/job/Steve'
        with self.packaged('/opt/Other/Steve.exe'):
            self.assert_refused(self.restart())

    def test_accepted_requests_restart_and_closes_through_the_window(self):
        self.updater.pending = self.folder / 'updates/job/Steve'
        with self.packaged():
            response = self.restart()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(self.updater.restart_requested)
        self.assertTrue(self.updater.apply_requested)
        self.assertEqual(self.actions.get_nowait(), 'close')
        self.assertTrue(Vault(self.folder / 'updates.dpapi').load()['apply_requested'])
        self.assertTrue(response.json()['ready'])

    def test_requires_the_desktop_window(self):
        app = local_app()
        updater = LocalUpdates(SimpleNamespace(folder=self.folder / 'cli', app=app))
        self.addCleanup(updater.closed.set)
        updater.pending = self.folder / 'updates/job/Steve'
        with self.packaged():
            self.assertEqual(TestClient(app, raise_server_exceptions=False).post('/v1/local/updates/restart').status_code, 422)
        self.assertFalse(updater.restart_requested)

    def test_desktop_action_route_cannot_close_steve(self):
        # Only LocalUpdates asks the window to close; the public desktop-action route keeps its own short list.
        source = (Path(__file__).parents[1] / 'src/steve_desktop/cad_server.py').read_text()
        self.assertIn("if action not in ('steve', 'account', 'mcp', 'agent'):", source)


class WindowsClose(RestartUpdates):
    def close(self):
        candidate = self.folder / 'updates/job/Steve'
        self.updater.pending = candidate
        with self.packaged(), patch('steve_desktop.local_updates.os', SimpleNamespace(name='nt')), \
             patch('steve_desktop.windows_updates.pending', return_value=candidate), \
             patch('steve_desktop.windows_updates.launch') as launch:
            self.updater.close()
        return launch, candidate

    def test_restart_reopens_steve_after_applying(self):
        self.updater.restart_requested = True
        launch, candidate = self.close()
        launch.assert_called_once_with(self.folder, candidate, restart=True)

    def test_normal_close_does_not_reopen(self):
        launch, candidate = self.close()
        launch.assert_called_once_with(self.folder, candidate)


class LinuxClose(RestartUpdates):
    platform = 'linux-x64'

    def close(self):
        self.updater.pending = self.folder / 'updates/bundles/x/package/Steve/usr/lib/steve/Steve'
        self.updater.linux_pending = {'directory': 'x'}
        with self.packaged('/opt/steve/usr/lib/steve/Steve'), \
             patch('steve_desktop.linux_updates.stable_launcher', return_value='/home/me/Steve.AppImage'), \
             patch('steve_desktop.linux_updates.schedule_activation') as schedule:
            self.updater.close()
        return schedule

    def test_restart_passes_the_stable_launcher(self):
        self.updater.restart_requested = True
        self.close().assert_called_once_with(self.folder, {'directory': 'x'}, restart='/home/me/Steve.AppImage')

    def test_normal_close_does_not_reopen(self):
        self.close().assert_called_once_with(self.folder, {'directory': 'x'})

    def test_route_needs_the_linux_bundle(self):
        self.updater.pending = self.folder / 'updates/bundles/x/package/Steve/usr/lib/steve/Steve'
        with self.packaged('/opt/steve/usr/lib/steve/Steve'):
            self.assert_refused(self.restart())
            self.updater.linux_pending = {'directory': 'x'}
            self.assertEqual(self.restart().status_code, 200)
        self.assertEqual(self.actions.get_nowait(), 'close')


@unittest.skipUnless(sys.platform == 'linux', 'Linux bundle updater')
class LinuxReopen(unittest.TestCase):
    def setUp(self):
        self.profile = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.bundle = {'directory': 'b1', 'manifest': {'version': '9.0.0', 'sha256': 'a' * 64}}
        linux.state_vault(self.profile).save({'pending': self.bundle})
        self.enterContext(patch('steve_desktop.linux_updates.prune_bundles'))
        self.popen = self.enterContext(patch('steve_desktop.linux_updates.subprocess.Popen', side_effect=self.started))
        self.lock_free_at_start = None

    def started(self, command, **options):
        from PySide6.QtCore import QLockFile
        lock = QLockFile(str(self.profile / 'instance.lock'))
        self.lock_free_at_start = lock.tryLock(0)
        if self.lock_free_at_start:
            lock.unlock()
        return SimpleNamespace(pid=1)

    def activate(self, restart='/home/me/Steve.AppImage', smoke=None):
        with patch('steve_desktop.linux_updates.smoke_bundle', side_effect=smoke):
            return linux.activate(self.profile, 'b1', None, None, restart)

    def test_reopens_detached_after_success(self):
        environment = {'STEVE_BUNDLE_LAUNCHER': '/home/me/Steve.AppImage', 'APPIMAGE': '/home/me/Steve.AppImage',
                       'APPDIR': '/tmp/.mount_Steve', 'STEVE_BUNDLE_READY_FD': '7', 'STEVE_BUNDLE_CHILD': '/x'}
        with patch.dict(os.environ, environment):
            self.assertEqual(self.activate(), 0)
        self.assertEqual(linux.state_vault(self.profile).load()['active'], self.bundle)
        self.popen.assert_called_once()
        command, options = self.popen.call_args.args[0], self.popen.call_args.kwargs
        self.assertEqual(command, ['/home/me/Steve.AppImage'])
        self.assertTrue(options['start_new_session'])
        self.assertTrue(options['close_fds'])
        for name in environment:
            self.assertNotIn(name, options['env'])
        self.assertEqual(options['env']['PYINSTALLER_RESET_ENVIRONMENT'], '1')
        self.assertTrue(self.lock_free_at_start, 'the profile lock must be released before Steve reopens')

    def test_no_reopen_without_restart(self):
        self.assertEqual(self.activate(restart=None), 0)
        self.popen.assert_not_called()

    def test_no_reopen_after_failed_activation(self):
        self.assertEqual(self.activate(smoke=ValueError('startup verification failed')), 1)
        self.popen.assert_not_called()
        self.assertNotIn('active', linux.state_vault(self.profile).load())

    def test_no_reopen_after_deferred_activation(self):
        self.assertEqual(self.activate(smoke=OSError('disk full')), 1)
        self.popen.assert_not_called()
        with patch('steve_desktop.linux_updates.wait_for_parent', side_effect=TimeoutError('still running')):
            self.assertEqual(linux.activate(self.profile, 'b1', 4242, None, '/home/me/Steve.AppImage'), 1)
        self.popen.assert_not_called()

    def test_schedule_passes_the_launcher_to_the_candidate(self):
        with patch('steve_desktop.linux_updates.verify_bundle', return_value=Path('/b/Steve')):
            (self.profile / 'updates').mkdir()
            linux.schedule_activation(self.profile, self.bundle, restart='/home/me/Steve.AppImage')
            linux.schedule_activation(self.profile, self.bundle)
        with_restart, without = (call.args[0] for call in self.popen.call_args_list)
        self.assertEqual(with_restart[1], '--apply-linux-update')
        self.assertEqual(with_restart[-1], '/home/me/Steve.AppImage')
        self.assertEqual(with_restart[:-1], without)

    def test_stable_launcher(self):
        with patch.dict(os.environ, {'STEVE_BUNDLE_LAUNCHER': '/a/Steve.AppImage', 'APPIMAGE': '/b/Steve.AppImage'}):
            self.assertEqual(linux.stable_launcher(), '/a/Steve.AppImage')
        with patch.dict(os.environ, {'APPIMAGE': '/b/Steve.AppImage'}):
            os.environ.pop('STEVE_BUNDLE_LAUNCHER', None)
            self.assertEqual(linux.stable_launcher(), '/b/Steve.AppImage')
        with patch.dict(os.environ, {}), patch.object(sys, 'executable', '/opt/Steve/usr/lib/steve/Steve'):
            os.environ.pop('STEVE_BUNDLE_LAUNCHER', None);os.environ.pop('APPIMAGE', None)
            self.assertEqual(linux.stable_launcher(), '/opt/Steve/usr/lib/steve/Steve')


if __name__ == '__main__':
    unittest.main()

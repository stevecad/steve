import contextlib
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from steve_desktop import cad_kernel
from steve_desktop.cad_worker import HotCadWorker


def execute_with(run):
    """Execute one job on a worker whose process is replaced by `run(folder, log, stop)`."""
    worker = HotCadWorker()
    def fake(command, log, stop, timeout=None, budget=None):
        return run(Path(command[-1]), log, stop)
    with patch('steve_desktop.cad_worker.run', fake):
        try:
            return worker.execute(['export', 'folder', 'destination', 'STEP'])
        finally:
            worker.close()


class WorkerFailureTests(unittest.TestCase):
    def test_startup_error_reaches_the_failure_report_line(self):
        def run(folder, log, stop):
            return cad_kernel.main(['serve', str(folder)])
        with contextlib.redirect_stderr(io.StringIO()), patch('steve_desktop.cad_kernel.serve', side_effect=ImportError('DLL load failed while importing example')):
            with self.assertRaises(ValueError) as caught:
                execute_with(run)
        message = str(caught.exception)
        self.assertIn('CAD worker exited (1).', message)
        self.assertEqual(message.splitlines()[-1], 'DLL load failed while importing example')

    def test_worker_output_is_used_when_no_error_was_recorded(self):
        def run(folder, log, stop):
            log.write(b'Traceback (most recent call last):\nImportError: no module named example\n')
            return 1
        with self.assertRaises(ValueError) as caught:
            execute_with(run)
        self.assertIn('CAD worker exited (1).', str(caught.exception))
        self.assertEqual(str(caught.exception).splitlines()[-1], 'ImportError: no module named example')

    def test_silent_exit_keeps_the_exit_code(self):
        with self.assertRaisesRegex(ValueError, r'^CAD worker exited \(71\)\.$'):
            execute_with(lambda folder, log, stop: 71)

    def test_response_published_before_the_worker_died_still_counts(self):
        def run(folder, log, stop):
            cad_kernel.publish(folder / 'ready', '1234')
            request = folder / 'request.json'
            while not request.exists():
                if stop.is_set():
                    return 0
                time.sleep(.01)
            identifier = json.loads(request.read_text(encoding='utf-8'))['id']
            cad_kernel.publish(folder / f'{identifier}.json', json.dumps({'code': 0, 'error': '', 'seconds': 0}))
            return 1
        result = execute_with(run)
        self.assertEqual(result['code'], 0)
        self.assertEqual(result['worker_pid'], 1234)

    def test_exit_from_a_job_is_recorded_as_its_error(self):
        with tempfile.TemporaryDirectory() as root, contextlib.redirect_stderr(io.StringIO()):
            for code in (0, 3):
                with patch('steve_desktop.cad_kernel.export', side_effect=SystemExit(code)):
                    self.assertEqual(cad_kernel.main(['export', root, 'destination', 'STEP']), 1)
                self.assertIn(f'sys.exit({code})', (Path(root) / 'worker-error.txt').read_text(encoding='utf-8'))


class PublishTests(unittest.TestCase):
    def test_waits_for_windows_to_release_the_file(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / 'response.json'
            real, calls = Path.replace, []

            def replace(self, destination):
                calls.append(destination)
                if len(calls) < 3:
                    raise PermissionError(32, 'The process cannot access the file because it is being used by another process')
                return real(self, destination)

            with patch.object(Path, 'replace', replace), patch('steve_desktop.cad_kernel.time.sleep'):
                cad_kernel.publish(target, '{}')
            self.assertEqual(len(calls), 3)
            self.assertEqual(target.read_text(encoding='utf-8'), '{}')
            self.assertEqual([path.name for path in Path(root).iterdir()], ['response.json'])

    def test_gives_up_when_the_file_stays_locked(self):
        def locked():
            raise PermissionError(32, 'locked')
        with patch('steve_desktop.cad_kernel.time.sleep'):
            with self.assertRaises(PermissionError):
                cad_kernel.when_released(locked, attempts=3)


if __name__ == '__main__':
    unittest.main()

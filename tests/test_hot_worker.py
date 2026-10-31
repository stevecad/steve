import tempfile
import threading
import time
import unittest
from pathlib import Path
from steve_desktop.cad_document import bracket
from steve_desktop.cad_service import CadProject


class HotWorkerTests(unittest.TestCase):
    def test_cancel_and_process_crash_preserve_model_and_recover(self):
        with tempfile.TemporaryDirectory() as folder:
            project = CadProject.create(Path(folder) / 'project')
            initial = project.build(bracket())
            cancel = threading.Event()
            delayed = {**bracket(), 'code': 'import time\ntime.sleep(30)\n' + bracket()['code']}
            timer = threading.Timer(.6, cancel.set)
            started = time.monotonic()
            timer.start()
            try:
                with self.assertRaisesRegex(ValueError, 'cancelled'):
                    project.build(delayed, initial['revision'], cancel=cancel)
            finally:
                timer.cancel()
            self.assertLess(time.monotonic() - started, 10)
            self.assertEqual(project.read()['revision'], initial['revision'])
            recovered = project.build(bracket(), initial['revision'])
            self.assertEqual(recovered['size'], [80, 50, 40])
            crash = {**bracket(), 'code': 'import os\nos._exit(71)\n'}
            with self.assertRaises(ValueError):
                project.build(crash, recovered['revision'])
            self.assertEqual(project.read()['revision'], recovered['revision'])
            final = project.build(bracket(), recovered['revision'])
            self.assertEqual(final['size'], [80, 50, 40])


if __name__ == '__main__':
    unittest.main()


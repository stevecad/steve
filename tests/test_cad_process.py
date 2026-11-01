import os
import sys
import tempfile
import threading
import time
import unittest
import subprocess
import signal
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from steve_desktop.cad_process import run


class CadProcessTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='linux','Linux process guardian')
    def test_controller_crash_terminates_the_whole_worker_tree(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            child=root/'worker.py'
            child.write_text('import json,os,pathlib,subprocess,sys,time\n'
                'child=subprocess.Popen([sys.executable,"-c","import time; time.sleep(120)"])\n'
                'pathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(),child.pid]))\n'
                'time.sleep(120)\n')
            controller=root/'controller.py'
            controller.write_text('import sys,threading\nfrom pathlib import Path\nfrom steve_desktop.cad_process import run\n'
                'from unittest.mock import patch\nfrom types import SimpleNamespace\nimport os\n'
                'binary=os.environ.get("STEVE_TEST_BINARY")\n'
                'replacement=SimpleNamespace(executable=binary,frozen=True,platform="linux") if binary else sys\n'
                'with patch("steve_desktop.cad_process.sys",replacement),Path(sys.argv[1]).open("wb") as log:\n'
                ' run([sys.executable,sys.argv[2],sys.argv[3]],log,threading.Event())\n')
            process=subprocess.Popen([sys.executable,str(controller),str(root/'log'),str(child),str(root/'pids')])
            pids=[]
            try:
                deadline=time.monotonic()+15
                while not (root/'pids').exists() and time.monotonic()<deadline:time.sleep(.02)
                self.assertTrue((root/'pids').exists(),(root/'log').read_text())
                pids=json.loads((root/'pids').read_text())
                process.kill();process.wait(10)
                def alive(pid):
                    try:
                        return (Path('/proc')/str(pid)/'stat').read_text().rsplit(') ',1)[1].split()[0]!='Z'
                    except (FileNotFoundError,ProcessLookupError):
                        # A process can exit after opening stat, before reading
                        # it; procfs then returns ESRCH instead of ENOENT.
                        return False
                deadline=time.monotonic()+5
                while any(alive(pid) for pid in pids) and time.monotonic()<deadline:time.sleep(.02)
                self.assertFalse(any(alive(pid) for pid in pids),'Workers survived their controller')
            finally:
                if process.poll() is None:process.kill();process.wait()
                for pid in pids:
                    try:os.kill(pid,signal.SIGKILL)
                    except ProcessLookupError:pass

    def test_cancellation_terminates_descendants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / 'child.py'
            child.write_text('import time, pathlib\ntime.sleep(2)\npathlib.Path(__file__).with_suffix(".escaped").write_text("still alive")\n')
            parent = root / 'parent.py'
            parent.write_text('import subprocess, sys, pathlib, time\nsubprocess.Popen([sys.executable, str(pathlib.Path(__file__).with_name("child.py"))])\npathlib.Path(__file__).with_suffix(".ready").write_text("ready")\ntime.sleep(15)\n')
            cancelled = threading.Event()
            errors = []
            def execute():
                try:
                    with (root / 'log').open('wb') as log:
                        run([sys.executable, str(parent)], log, cancelled, timeout=10)
                except ValueError as exc:
                    errors.append(str(exc))
            worker = threading.Thread(target=execute)
            worker.start()
            deadline = time.monotonic() + 5
            while not parent.with_suffix('.ready').exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(parent.with_suffix('.ready').exists())
            cancelled.set()
            worker.join(5)
            self.assertFalse(worker.is_alive())
            time.sleep(2.2)
            self.assertEqual(errors, ['Build cancelled.'])
            self.assertFalse(child.with_suffix('.escaped').exists())

    def test_blender_gets_its_allowlist_and_cad_stays_minimal(self):
        script = ('import json, os\n'
                  'print(json.dumps({key: os.environ.get(key) for key in '
                  '("STEVE_ENV_MARKER", "TMPDIR", "OMP_NUM_THREADS", "LD_LIBRARY_PATH_ORIG")}))\n')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'show.py').write_text(script)
            temp = root / 'tmp'
            temp.mkdir()
            budget = SimpleNamespace(capacity=3, percent=50, attach=lambda process: None)  # Windows: the job-object CPU cap
            overlay = {'STEVE_ENV_MARKER': 'secret', 'TMPDIR': str(temp), 'OMP_NUM_THREADS': '6',
                       'LD_LIBRARY_PATH_ORIG': '/host/lib'}
            with patch.dict(os.environ, overlay):
                def invoke(external):
                    with (root / 'log').open('wb') as log:
                        code = run([sys.executable, str(root / 'show.py')], log, threading.Event(),
                                   external=external, budget=budget)
                    return code, json.loads((root / 'log').read_text().strip().splitlines()[-1])
                external_code, external = invoke(True)
                internal_code, internal = invoke(False)
        self.assertEqual(external_code, 0)
        self.assertIsNone(external['STEVE_ENV_MARKER'])
        self.assertEqual(external['LD_LIBRARY_PATH_ORIG'], '/host/lib')
        self.assertEqual(external['TMPDIR'], str(temp))
        self.assertEqual(external['OMP_NUM_THREADS'], str(max(1, (os.cpu_count() or 1) * 50 // 100)))
        self.assertEqual(internal_code, 0)
        self.assertIsNone(internal['STEVE_ENV_MARKER'])
        self.assertEqual(internal['TMPDIR'], str(temp))
        self.assertEqual(internal['OMP_NUM_THREADS'], '1')


if __name__ == '__main__':
    unittest.main()

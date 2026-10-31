import concurrent.futures
import ctypes
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock
from steve_desktop.cad_resources import CpuBudget
from steve_desktop.cad_worker import CadWorkerPool


class WorkerPoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.pool = CadWorkerPool(100, spares=2)
        self.pool.budget.cpus = 2
        self.pool.warm()
        deadline = time.monotonic() + 30
        while self.pool.status()['ready'] < 2 and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertEqual(self.pool.status()['ready'], 2)

    def tearDown(self):
        self.pool.close()
        self.temp.cleanup()

    def job(self, name, prefix='', cancel=None):
        folder = self.folder / name
        folder.mkdir()
        document = {'kind': 'part', 'name': name, 'code': prefix + '\nfrom steve import Model\nmodel=Model()\nmodel.box("body",10,20,30)\nresult=model.result()\n'}
        (folder / 'document.json').write_text(json.dumps(document), encoding='utf-8')
        report = self.pool.execute(['build', folder], cancel)
        geometry = json.loads((folder / 'geometry.json').read_text())
        self.assertEqual(geometry['size'], [10, 20, 30])
        return report

    def test_reporting_cache_receives_pool_memory_share(self):
        self.job('memory-share')
        metadata=json.loads((self.folder/'memory-share'/'studio-metadata.json').read_text())
        cache=metadata['local_area_cache']
        self.assertEqual(cache['workers'],self.pool.budget.capacity)
        self.assertGreater(cache['hits'],0)
        self.assertLessEqual(cache['bytes'],cache['budget_bytes'])

    def test_parallel_processes_and_no_interpreter_state_leaks(self):
        gate = self.folder / 'gate'
        gate.mkdir()
        def code(name, peer):
            return ("import builtins, cadquery, pathlib, time\n"
                    "assert not hasattr(builtins,'_steve_test_marker')\n"
                    "assert not hasattr(cadquery,'_steve_test_marker')\n"
                    "builtins._steve_test_marker = True\ncadquery._steve_test_marker = True\n"
                    f"gate=pathlib.Path({str(gate)!r})\n(gate/{name!r}).touch()\n"
                    "deadline=time.monotonic()+15\n"
                    f"while not (gate/{peer!r}).exists():\n"
                    "    assert time.monotonic()<deadline, 'Jobs did not run concurrently'\n    time.sleep(.02)\n")
        with concurrent.futures.ThreadPoolExecutor(2) as executor:
            one = executor.submit(self.job, 'one', code('one', 'two'))
            two = executor.submit(self.job, 'two', code('two', 'one'))
            first = one.result(40)
            second = two.result(40)
        third = self.job('three', "import builtins,cadquery\nassert not hasattr(builtins,'_steve_test_marker')\nassert not hasattr(cadquery,'_steve_test_marker')\n")
        self.assertEqual(len({first['worker_pid'], second['worker_pid'], third['worker_pid']}), 3)
        if os.name == 'nt':
            import win32api, win32con
            for pid in (first['worker_pid'], second['worker_pid'], third['worker_pid']):
                try:
                    handle = win32api.OpenProcess(win32con.PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
                except Exception:
                    continue  # Windows has already removed the process object.
                try:
                    import win32process
                    self.assertNotEqual(win32process.GetExitCodeProcess(handle), win32con.STILL_ACTIVE)
                finally:
                    handle.Close()

    def test_queued_cancellation_does_not_kill_running_workers(self):
        hold = threading.Event()
        entered = threading.Barrier(3)
        def active():
            with self.pool.lease():
                entered.wait(10)
                hold.wait(10)
        with concurrent.futures.ThreadPoolExecutor(3) as executor:
            first, second = executor.submit(active), executor.submit(active)
            entered.wait(10)
            cancelled = threading.Event()
            queued = executor.submit(self.job, 'cancelled', '', cancelled)
            deadline = time.monotonic()+5
            while not self.pool.status()['queued'] and time.monotonic()<deadline:
                time.sleep(.02)
            cancelled.set()
            try:
                with self.assertRaisesRegex(ValueError, 'cancelled'):
                    queued.result(3)
                self.assertEqual(self.pool.status()['active'], 2)
                self.assertFalse((self.folder/'cancelled'/'geometry.json').exists())
            finally:
                hold.set()
                first.result(10); second.result(10)


class CpuBudgetTests(unittest.TestCase):
    def test_large_host_capacity_has_no_fixed_worker_ceiling(self):
        budget=CpuBudget(80)
        budget.cpus=512;budget.memory=4*1024**4
        self.assertEqual(budget.capacity,409)

    def test_native_threads_use_allocated_cpu_share_above_sixteen(self):
        pool=CadWorkerPool(80,spares=0)
        try:
            pool.budget.cpus=128
            worker=Mock()
            pool.local.worker=worker
            pool.active.add(worker)
            pool.execute(['build','test'])
            self.assertEqual(worker.execute.call_args.kwargs['native_threads'],102)
            pool.active.add(Mock())
            pool.execute(['build','test'])
            self.assertEqual(worker.execute.call_args.kwargs['native_threads'],51)
        finally:
            pool.active.clear();pool.local.worker=None;pool.close()

    def test_default_and_validation(self):
        budget = CpuBudget()
        self.assertEqual(budget.percent, 80)
        for value in (0, 101, True, '80', 79.5):
            with self.assertRaises(ValueError): budget.configure(value)

    @unittest.skipUnless(os.name == 'nt', 'Windows CPU enforcement')
    def test_windows_shared_cpu_limit(self):
        budget = CpuBudget()
        try:
            budget.configure(80)
            api = ctypes.WinDLL('kernel32', use_last_error=True)
            api.QueryInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
            info = (ctypes.c_ulong * 2)()
            self.assertTrue(api.QueryInformationJobObject(int(budget.job), 15, info, ctypes.sizeof(info), None))
            self.assertEqual(list(info), [5, 8000])
            budget.configure(50)
            self.assertTrue(api.QueryInformationJobObject(int(budget.job), 15, info, ctypes.sizeof(info), None))
            self.assertEqual(list(info), [5, 5000])
        finally:
            budget.close()


if __name__ == '__main__':
    unittest.main()

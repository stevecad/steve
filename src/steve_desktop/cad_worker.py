"""A preloaded CAD process, reused for serial builds and replaced on interruption.
The existing process supervisor owns its process group / Windows Job Object.
"""
import atexit
import json
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from steve_desktop.cad_process import run
from steve_desktop.cad_resources import CpuBudget


class HotCadWorker:
    def __init__(self, budget=None):
        self.budget = budget
        self.lock = threading.Lock()
        self.lifecycle = threading.RLock()
        self.thread = None
        self.stop = None
        self.folder = None
        self.closed = False
        self.failure = ''

    def warm(self):
        with self.lifecycle:
            if self.closed or self.thread and self.thread.is_alive():
                return
            self.temp = tempfile.TemporaryDirectory(prefix='steve-cad-', delete=False)
            self.folder = Path(self.temp.name)
            self.stop = threading.Event()
            self.failure = ''
            command = [sys.executable, '--cad-worker'] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'steve_desktop.cad_kernel']
            folder, stop = self.folder, self.stop
            def supervise():
                try:
                    with (folder/'worker.log').open('wb') as log:
                        code = run(command + ['serve', str(folder)], log, stop, timeout=None, budget=self.budget)
                    if code: self.failure = f'CAD worker exited ({code}).'
                except Exception as exc:
                    self.failure = str(exc)
            self.thread = threading.Thread(target=supervise, name='hot-cad-supervisor', daemon=True)
            self.thread.start()

    def retire(self):
        with self.lifecycle:
            if self.stop: self.stop.set()
            if self.thread: self.thread.join(8)
            if self.thread and self.thread.is_alive():
                raise ValueError('CAD worker did not terminate.')
            self.thread = None
            if self.folder:
                # Job termination signals descendants; Windows can release their
                # inherited handles a little after the main process has exited.
                for attempt in range(50):
                    try:
                        self.temp.cleanup()
                        break
                    except PermissionError:
                        if attempt == 49: raise
                        time.sleep(.05)
                self.folder = None

    def close(self):
        self.closed = True
        self.retire()

    def execute(self, args, cancel=None, timeout=None, native_threads=1):
        # A queued request remains cancellable without killing somebody else's job.
        while not self.lock.acquire(timeout=.05):
            if cancel and cancel.is_set(): raise ValueError('Build cancelled.')
        try:
            if self.closed: raise ValueError('CAD workspace is closed.')
            self.warm()
            started = time.monotonic()
            folder = self.folder
            def check():
                if self.closed: raise ValueError('CAD workspace is closed.')
                if cancel and cancel.is_set(): raise ValueError('Build cancelled.')
                if timeout is not None and time.monotonic()-started > timeout: raise ValueError(f'CAD operation exceeded the {timeout}-second limit.')
                if not self.thread.is_alive():
                    detail = (folder/'worker.log').read_text(encoding='utf-8', errors='replace')[-2000:]
                    raise ValueError(self.failure or detail or 'CAD worker stopped.')
            try:
                while not (folder/'ready').exists():
                    check(); time.sleep(.01)
                check()
                identifier = uuid.uuid4().hex
                request = folder/'request.json'
                temporary = folder/'request.tmp'
                temporary.write_text(json.dumps({'id': identifier, 'args': [str(x) for x in args], 'native_threads': native_threads,
                    'cache_workers': self.budget.capacity if self.budget is not None else 0}), encoding='utf-8')
                temporary.replace(request)
                response = folder/f'{identifier}.json'
                while True:
                    check()
                    try:
                        result = json.loads(response.read_text(encoding='utf-8'))
                        break
                    except (FileNotFoundError, PermissionError):
                        # Windows can briefly retain a sharing lock after the
                        # worker atomically publishes its response.
                        time.sleep(.01)
                try:
                    response.unlink()
                except PermissionError:
                    pass  # Retired with the worker's private temporary directory.
                if result['code']:
                    # Recycle after errors too: arbitrary source may leave state behind.
                    raise ValueError(result.get('error') or 'CAD build failed.')
                return {**result, 'worker_pid': int((folder/'ready').read_text()), 'elapsed_seconds': time.monotonic()-started}
            except BaseException:
                self.retire()
                if self.budget is None: self.warm()
                raise
        finally:
            self.lock.release()


class CadWorkerPool:
    """Fresh preloaded processes: one CAD operation per process, then retire it.

    Spares warm up to the CPU/RAM budget, with no separate fixed worker ceiling.
    Idle workers do not run document source.
    An assigned worker stays attached to a server job through thread-local state,
    so queue time is distinguished from CAD execution and cannot deadlock by
    acquiring a second worker from inside the same build.
    """
    def __init__(self, percent=80, spares=None):
        self.budget = CpuBudget(percent)
        self.spares = spares
        self.condition = threading.Condition(threading.RLock())
        self.idle = []
        self.active = set()
        self.waiters = []
        self.local = threading.local()
        self.closed = False
        self.completed = 0

    def _fill(self):
        target = max(0, self.budget.capacity - len(self.active))
        if self.spares is not None:
            target = min(self.spares, target)
        while not self.closed and len(self.idle) < target:
            worker = HotCadWorker(self.budget)
            worker.warm()
            self.idle.append(worker)

    def warm(self):
        with self.condition:
            if not self.closed:
                self.budget.configure(self.budget.percent)
                self._fill()

    def configure(self, percent):
        with self.condition:
            self.budget.configure(percent)
            surplus = []
            while self.idle and len(self.active) + len(self.idle) > self.budget.capacity:
                surplus.append(self.idle.pop())
            self._fill()
            self.condition.notify_all()
        for worker in surplus:
            worker.close()

    @staticmethod
    def ready(worker):
        return bool(worker.folder and (worker.folder / 'ready').exists() and worker.thread and worker.thread.is_alive())

    @contextmanager
    def lease(self, cancel=None):
        ticket = object()
        worker = None
        with self.condition:
            self.waiters.append(ticket)
            try:
                while worker is None:
                    if self.closed:
                        raise ValueError('CAD workspace is closed.')
                    if cancel and cancel.is_set():
                        raise ValueError('Build cancelled.')
                    self._fill()
                    if self.waiters[0] is ticket and self.idle and len(self.active) < self.budget.capacity:
                        # Prefer a ready spare over one still importing the kernel.
                        worker = next((item for item in self.idle if self.ready(item)), self.idle[0])
                        self.idle.remove(worker)
                        self.active.add(worker)
                        self._fill()
                    else:
                        self.condition.wait(.05)
            finally:
                self.waiters.remove(ticket)
                self.condition.notify_all()
        try:
            self.local.worker = worker
            yield worker
        finally:
            self.local.worker = None
            # Never run a second job in an interpreter touched by document code.
            # Stop descendants too, even after a successful build.
            try:
                worker.close()
            finally:
                with self.condition:
                    self.active.discard(worker)
                    self.completed += 1
                    self._fill()
                    self.condition.notify_all()

    def execute(self, args, cancel=None, timeout=None):
        def execute_assigned(worker):
            with self.condition:
                cores = max(1, self.budget.cpus * self.budget.percent // 100)
                native_threads = max(1, cores // max(1, len(self.active)))
            return worker.execute(args, cancel, timeout, native_threads=native_threads)
        worker = getattr(self.local, 'worker', None)
        if worker is not None:
            return execute_assigned(worker)
        with self.lease(cancel) as worker:
            return execute_assigned(worker)

    def status(self):
        with self.condition:
            ready = sum(self.ready(worker) for worker in self.idle)
            return {**self.budget.status(), 'ready': ready, 'warming': len(self.idle) - ready,
                    'active': len(self.active), 'queued': len(self.waiters), 'completed': self.completed,
                    'isolation': 'fresh_process_per_job'}

    def close(self):
        with self.condition:
            self.closed = True
            workers = list(self.active) + self.idle
            self.idle = []
            self.condition.notify_all()
        for worker in workers:
            worker.close()
        self.budget.close()


WORKER = CadWorkerPool()
atexit.register(WORKER.close)

"""CAD CPU budget; Windows enforces one shared limit across all worker trees."""
import ctypes
import os
import threading
import time

def host_memory():
    if os.name == 'nt':
        class Memory(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
                (key, ctypes.c_ulonglong) for key in ('total', 'available', 'page_total', 'page_available', 'virtual_total', 'virtual_available', 'extended')]
        value = Memory()
        value.length = ctypes.sizeof(value)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):
            return value.total
    else:
        try:
            return os.sysconf('SC_PHYS_PAGES') * os.sysconf('SC_PAGE_SIZE')
        except (ValueError, OSError, AttributeError):
            pass
    return 8 * 1024**3


class CpuBudget:
    def __init__(self, percent=80):
        self.lock = threading.RLock()
        self.percent = percent
        self.cpus = os.cpu_count() or 1
        self.memory = host_memory()
        self.job = None
        self.error = ''
        self.sample = None

    @property
    def capacity(self):
        # Reserve at least half the machine's RAM, allowing 1 GiB per worker.
        # This is a scheduling estimate, not a hard per-model memory limit.
        return max(1, min(self.cpus * self.percent // 100, self.memory // (2 * 1024**3)))

    def configure(self, percent):
        if isinstance(percent, bool) or not isinstance(percent, int) or not 10 <= percent <= 100:
            raise ValueError('CPU budget must be a whole percentage between 10 and 100.')
        with self.lock:
            if os.name == 'nt':
                import win32job
                if self.job is None:
                    self.job = win32job.CreateJobObject(None, '')
                    limits = win32job.QueryInformationJobObject(self.job, win32job.JobObjectExtendedLimitInformation)
                    limits['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    win32job.SetInformationJobObject(self.job, win32job.JobObjectExtendedLimitInformation, limits)
                # pywin32 does not expose JobObjectCpuRateControlInformation (15).
                class Rate(ctypes.Structure):
                    _fields_ = [('flags', ctypes.c_ulong), ('rate', ctypes.c_ulong)]
                api = ctypes.WinDLL('kernel32', use_last_error=True)
                api.SetInformationJobObject.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_ulong]
                api.SetInformationJobObject.restype = ctypes.c_int
                rate = Rate(0x1 | 0x4, percent * 100)  # ENABLE | HARD_CAP
                if not api.SetInformationJobObject(int(self.job), 15, ctypes.byref(rate), ctypes.sizeof(rate)):
                    raise ctypes.WinError(ctypes.get_last_error())
            self.percent = percent

    def attach(self, process):
        with self.lock:
            if self.job is None:
                self.configure(self.percent)
            if self.job is not None:
                import win32job
                win32job.AssignProcessToJobObject(self.job, process)

    def status(self):
        usage = None
        with self.lock:
            if self.job is not None:
                import win32job
                info = win32job.QueryInformationJobObject(self.job, win32job.JobObjectBasicAccountingInformation)
                now = time.monotonic()
                seconds = (info['TotalKernelTime'] + info['TotalUserTime']) / 10_000_000
                if self.sample and now > self.sample[0]:
                    usage = round(max(0, (seconds - self.sample[1]) / (now - self.sample[0]) / self.cpus * 100), 1)
                self.sample = now, seconds
        return {'cpu_percent': self.percent, 'logical_cpus': self.cpus, 'memory_gib': round(self.memory / 1024**3),
                'capacity': self.capacity, 'cpu_usage_percent': usage,
                'enforcement': 'windows_job' if self.job is not None else 'concurrency'}

    def close(self):
        with self.lock:
            if self.job is not None:
                self.job.Close()
                self.job = None

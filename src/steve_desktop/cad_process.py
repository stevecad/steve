"""Bounded CAD worker lifetime, including its sketch-solver child processes.

This is process isolation and cancellation, not an OS security sandbox. CAD Python
runs with the user's permissions.
"""
import os
import signal
import subprocess
import time
import threading
import json
import sys

_spawn_lock = threading.Lock()


def run(command, log, cancel, timeout=None, budget=None, cwd=None, output_limit=4_000_000, external=False):
    allowed = {'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
               'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'COMSPEC',
               'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'}
    inherited = os.environ
    if external:
        from steve_desktop.blender_runtime import environment
        inherited = environment()
    env = {k: v for k, v in inherited.items() if k.upper() in allowed}
    env['PYTHONUTF8'] = '1'
    # Parallelism is scheduled across isolated CAD jobs. Avoid every numerical
    # library spawning another machine-sized thread pool inside each worker.
    if budget is not None:
        env.update(OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1', NUMEXPR_NUM_THREADS='1')
        env['STEVE_AREA_CACHE_WORKERS'] = str(budget.capacity)
    start = time.monotonic()

    def check():
        if cancel and cancel.is_set():
            raise ValueError('Build cancelled.')
        if timeout is not None and time.monotonic() - start > timeout:
            raise ValueError(f'CAD operation exceeded the {timeout}-second limit.')
        if output_limit is not None and os.fstat(log.fileno()).st_size > output_limit:
            raise ValueError('CAD operation exceeded the output limit.')

    if os.name != 'nt':
        watched=command
        if sys.platform=='linux':
            guardian=[sys.executable,'--watch-process'] if getattr(sys,'frozen',False) else [sys.executable,'-m','steve_desktop.process_watch']
            watched=guardian+[json.dumps(command),'external' if external else 'internal']
        process = subprocess.Popen(watched, stdout=log, stderr=log, stdin=subprocess.DEVNULL, env=env, cwd=cwd, start_new_session=True)
        try:
            while process.poll() is None:
                check()
                time.sleep(.05)
            return process.returncode
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()

    import msvcrt
    import win32api
    import win32con
    import win32event
    import win32job
    import win32process
    job = win32job.CreateJobObject(None, '')
    limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    limits['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
    process = thread = None
    try:
        with open(os.devnull, 'rb') as inp:
            handles = [msvcrt.get_osfhandle(f.fileno()) for f in (inp, log)]
            startup = win32process.STARTUPINFO()
            startup.dwFlags = win32con.STARTF_USESTDHANDLES
            startup.hStdInput, startup.hStdOutput = handles
            startup.hStdError = handles[1]
            # Prevent another CAD launch from inheriting this worker's handles.
            with _spawn_lock:
                for handle in handles:
                    os.set_handle_inheritable(handle, True)
                try:
                    process, thread, _, _ = win32process.CreateProcess(command[0], subprocess.list2cmdline(command), None, None, True,
                        win32con.CREATE_SUSPENDED | win32con.CREATE_NO_WINDOW | win32con.CREATE_UNICODE_ENVIRONMENT, env, str(cwd) if cwd else None, startup)
                finally:
                    for handle in handles:
                        os.set_handle_inheritable(handle, False)
            if budget is not None:
                budget.attach(process)
            win32job.AssignProcessToJobObject(job, process)
            win32process.ResumeThread(thread)
            while win32event.WaitForSingleObject(process, 50) == win32con.WAIT_TIMEOUT:
                check()
            return win32process.GetExitCodeProcess(process)
    finally:
        win32job.TerminateJobObject(job, 1)
        if process is not None:
            if win32process.GetExitCodeProcess(process) == win32con.STILL_ACTIVE:
                win32process.TerminateProcess(process, 1)
            win32event.WaitForSingleObject(process, 5000)
            win32api.CloseHandle(process)
        if thread is not None:
            win32api.CloseHandle(thread)
        win32api.CloseHandle(job)

"""Linux process-group guardian; parent death kills CAD/Blender descendants."""
import ctypes
import json
import os
import signal
import subprocess
import sys


def run(command, external=False):
    if sys.platform!='linux' or os.getpgrp()!=os.getpid():
        raise RuntimeError('The Linux process guardian requires its own process group.')
    parent=os.getppid()
    def terminate(*_):
        os.killpg(os.getpgrp(),signal.SIGKILL)
    signal.signal(signal.SIGTERM,terminate)
    libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(1,signal.SIGTERM,0,0,0)!=0:
        error=ctypes.get_errno()
        raise OSError(error,os.strerror(error))
    # Cover death between Popen and PR_SET_PDEATHSIG registration.
    if parent==1 or os.getppid()!=parent:terminate()
    env=None
    if external:
        from steve_desktop.host_environment import host_environment
        env=host_environment()
        env.pop('PYTHONHOME',None);env.pop('PYTHONPATH',None)
    process=subprocess.Popen(command,env=env)
    code=process.wait()
    return code if code>=0 else 128-code


def main(args=None):
    args=sys.argv[1:] if args is None else args
    return run(json.loads(args[0]),external=len(args)>1 and args[1]=='external')


if __name__=='__main__':raise SystemExit(main())

"""Environment for host executables launched outside the frozen Python runtime."""
import os
import sys


def host_environment():
    env = dict(os.environ)
    if getattr(sys, 'frozen', False) and sys.platform == 'linux':
        # PyInstaller prepends its own libraries for Python, Qt and OCP. Host
        # tools such as Git and credential helpers must use the host's ABI.
        original = env.pop('LD_LIBRARY_PATH_ORIG', '')
        if original:
            env['LD_LIBRARY_PATH'] = original
        else:
            env.pop('LD_LIBRARY_PATH', None)
        bundle = getattr(sys, '_MEIPASS', '')
        if bundle:
            for name in ('QT_PLUGIN_PATH', 'QML2_IMPORT_PATH'):
                paths = [path for path in env.get(name, '').split(os.pathsep)
                         if path and path != bundle and not path.startswith(bundle + os.sep)]
                if paths:
                    env[name] = os.pathsep.join(paths)
                else:
                    env.pop(name, None)
    return env

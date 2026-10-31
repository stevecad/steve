"""Local transport to the unmodified upstream WASM solver (same planegcs core).

The CAD runtime only calls solve. No browser, network, or Studio server is involved.
"""
import atexit
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading

_process = None
_lock = threading.Lock()


def close():
    global _process
    if _process is not None:
        _process.terminate()
        _process.wait(timeout=5)
        _process = None


atexit.register(close)


def solve(sketch_json, options_json='{}'):
    global _process
    with _lock:
        if _process is None or _process.poll() is not None:
            frozen_root = getattr(sys, '_MEIPASS', None)
            folder = Path(frozen_root) / 'vendor/solver' if frozen_root else Path(__file__).parent / 'solver'
            bundled = folder / ('node.exe' if os.name == 'nt' else 'node')
            node = str(bundled) if bundled.is_file() else (None if frozen_root else shutil.which('node'))
            if not node:
                raise RuntimeError('The local sketch solver Node runtime is missing.')
            _process = subprocess.Popen([str(node), str(folder / 'bridge.mjs')],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(folder),
                text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        _process.stdin.write(json.dumps({'sketch': sketch_json, 'options': options_json}) + '\n')
        _process.stdin.flush()
        line = _process.stdout.readline()
        if not line:
            raise ValueError('Local sketch solver stopped unexpectedly.')
        reply = json.loads(line)
        if 'error' in reply:
            raise ValueError(reply['error'])
        return reply['result']

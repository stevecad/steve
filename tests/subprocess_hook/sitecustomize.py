"""Loaded only when a unit test's child Python inherits PYTHONPATH.

No effect unless that parent also set STEVE_UNITTEST_VAULT_KEY. The application
and `python -m steve_desktop --smoke-test` do not set either one.
"""
import os
import sys
from pathlib import Path

_key = os.environ.get('STEVE_UNITTEST_VAULT_KEY')
if _key:
    _repo = str(Path(__file__).resolve().parents[2])
    if _repo not in sys.path:
        sys.path.insert(0, _repo)
    import tests.vault_hook as _hook
    _hook.install_inherited(_key)

"""In-memory vault cipher for `python -m unittest` only.

The application does not import this module. `install` runs only when this
process was started as `python -m unittest`. Child Python processes inherit the
same key through `tests/subprocess_hook` so a unit test and the app process it
spawns can read each other's vault files without touching the OS store.
"""
import os
import sys
import threading
from pathlib import Path

KEY_ENV = 'STEVE_UNITTEST_VAULT_KEY'
guard_calls = 0
installed = False
macos_api_guarded = False
original_cipher = None
_lock = threading.RLock()


class RealKeyringForbidden(AssertionError):
    """A unit test called the OS keychain, Secret Service, or DPAPI."""


def _forbid(where):
    def wrapped(*_args, **_kwargs):
        global guard_calls
        guard_calls += 1
        raise RealKeyringForbidden(where)
    return wrapped


crypt_protect = _forbid('DPAPI CryptProtectData')
crypt_unprotect = _forbid('DPAPI CryptUnprotectData')


def _unittest_main():
    # uv's Python sets argv[0] to "python -m unittest"; CPython uses the __main__ path.
    file = (getattr(sys.modules.get('__main__'), '__file__', '') or '').replace('\\', '/')
    argv0 = sys.argv[0].replace('\\', '/')
    return file.endswith('/unittest/__main__.py') or argv0.endswith('/unittest/__main__.py') or argv0.endswith(' -m unittest')


def _patch_make_mcp():
    # make_mcp keeps only a session allowlist, so the MCP child would miss the hook.
    import steve_desktop.runtime as runtime
    if getattr(runtime.make_mcp, '_steve_test_hook', False):
        return
    original = runtime.make_mcp

    def make_mcp(config, oauth_dir=None, notify=None):
        extra = {KEY_ENV: os.environ[KEY_ENV], 'PYTHONPATH': os.environ.get('PYTHONPATH', '')}
        config = config.model_copy(update={'env': {**dict(config.env), **extra}})
        return original(config, oauth_dir, notify)

    make_mcp._steve_test_hook = True
    runtime.make_mcp = make_mcp


def _hook_dir():
    return str(Path(__file__).resolve().parent / 'subprocess_hook')


def _publish_path():
    hook = _hook_dir()
    current = os.environ.get('PYTHONPATH', '')
    parts = [part for part in current.split(os.pathsep) if part]
    if hook not in parts:
        os.environ['PYTHONPATH'] = os.pathsep.join([hook, *parts])


def install():
    """Arm the hook for a `python -m unittest` process. No effect otherwise."""
    if not _unittest_main():
        return
    from cryptography.fernet import Fernet
    key = os.environ.get(KEY_ENV) or Fernet.generate_key().decode('ascii')
    os.environ[KEY_ENV] = key
    _publish_path()
    _apply(key)


def install_inherited(key):
    """Arm the hook in a child started by a unit test. The app does not call this."""
    os.environ[KEY_ENV] = key
    _publish_path()
    _apply(key)


def _apply(key):
    global installed, macos_api_guarded, original_cipher
    if installed:
        return
    installed = True
    from cryptography.fernet import Fernet
    import keyring
    from keyring.backends.SecretService import Keyring as SecretService
    from keyring.backends.macOS import Keyring as MacKeyring
    import steve_desktop.vault as vault

    fernet = Fernet(key.encode('ascii'))
    original_cipher = vault.Vault._cipher
    real_os = vault.os

    class _PosixOs:
        name = 'posix'

        def __getattr__(self, item):
            return getattr(real_os, item)

    posix = _PosixOs()
    orig_load, orig_save = vault.Vault.load, vault.Vault.save

    def cipher(_self):
        return fernet

    def load(self):
        with _lock:
            vault.os = posix
            try:
                return orig_load(self)
            finally:
                vault.os = real_os

    def save(self, value):
        with _lock:
            vault.os = posix
            try:
                return orig_save(self, value)
            finally:
                vault.os = real_os

    vault.Vault._cipher = cipher
    vault.Vault.load = load
    vault.Vault.save = save
    _patch_make_mcp()
    for name in ('get_password', 'set_password', 'delete_password', 'get_keyring'):
        wrapped = _forbid('keyring.' + name)
        setattr(keyring, name, wrapped)
        setattr(keyring.core, name, wrapped)
    for name in ('get_password', 'set_password', 'delete_password'):
        setattr(SecretService, name, _forbid('SecretService.' + name))
        setattr(MacKeyring, name, _forbid('macOS.Keyring.' + name))
    win32crypt = getattr(vault, 'win32crypt', None)
    if win32crypt is not None:
        win32crypt.CryptProtectData = crypt_protect
        win32crypt.CryptUnprotectData = crypt_unprotect
    if sys.platform == 'darwin':
        try:
            from keyring.backends.macOS import api
        except Exception:
            return
        api.find_generic_password = _forbid('SecItemCopyMatching')
        api.set_generic_password = _forbid('SecItemAdd')
        api.delete_generic_password = _forbid('SecItemDelete')
        macos_api_guarded = True

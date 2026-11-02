"""Prove unit tests do not touch the OS keychain, Secret Service, or DPAPI."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import keyring
from cryptography.fernet import Fernet
from keyring.backends.SecretService import Keyring as SecretService
from keyring.backends.macOS import Keyring as MacKeyring

import steve_desktop.vault as vault
import tests.vault_hook as hook
from steve_desktop.vault import Vault

_ROOT = Path(__file__).resolve().parents[1]

_APP = r'''
import sys, keyring, keyring.core
import steve_desktop.vault as vault
import steve_desktop.legacy_profile, steve_desktop.diagnostics, steve_desktop.__main__
assert "tests.vault_hook" not in sys.modules
assert vault.Vault._cipher.__module__ == "steve_desktop.vault"
assert vault.Vault.load.__module__ == vault.Vault.save.__module__ == "steve_desktop.vault"
fns = (keyring.get_keyring, keyring.get_password, keyring.set_password, keyring.delete_password,
       keyring.core.get_keyring, keyring.core.get_password)
assert all(fn.__module__.startswith("keyring") for fn in fns), [fn.__module__ for fn in fns]
from keyring.backends.macOS import Keyring as Mac
from keyring.backends.SecretService import Keyring as Secret
assert Mac.get_password.__module__.startswith("keyring")
assert Secret.get_password.__module__.startswith("keyring")
wc = getattr(vault, "win32crypt", None)
assert wc is None or wc.CryptProtectData.__module__ != "tests.vault_hook"
print("ok")
'''

_CHILD = r'''
import tempfile
from pathlib import Path
import keyring
import steve_desktop.vault as vault
import tests.vault_hook as hook
assert vault.Vault._cipher.__module__ == "tests.vault_hook"
with tempfile.TemporaryDirectory() as folder:
    box = vault.Vault(Path(folder) / "a.dpapi")
    box.save({"t": "secret-token"})
    assert b"secret-token" not in box.path.read_bytes()
    assert box.load()["t"] == "secret-token"
try:
    keyring.get_keyring()
except hook.RealKeyringForbidden:
    print("ok")
else:
    raise SystemExit("keyring")
'''

_OUTSIDE = r'''
import tests.vault_hook as hook
hook.install()
import steve_desktop.vault as vault
assert hook.installed is False
assert vault.Vault.load.__module__ == "steve_desktop.vault"
print("ok")
'''


def _clean_env():
    env = os.environ.copy()
    env.pop(hook.KEY_ENV, None)
    env.pop('DBUS_SESSION_BUS_ADDRESS', None)
    env.pop('GNOME_KEYRING_CONTROL', None)
    hook_dir = hook._hook_dir()
    parts = [part for part in env.get('PYTHONPATH', '').split(os.pathsep) if part and part != hook_dir]
    if parts:
        env['PYTHONPATH'] = os.pathsep.join(parts)
    else:
        env.pop('PYTHONPATH', None)
    return env


class VaultIsolationTests(unittest.TestCase):
    def test_roundtrip_skips_os_stores(self):
        before = hook.guard_calls
        with tempfile.TemporaryDirectory() as folder:
            store = Vault(Path(folder) / 'v.dpapi')
            store.save({'token': 'secret-access'})
            self.assertNotIn(b'secret-access', store.path.read_bytes())
            self.assertEqual(store.load(), {'token': 'secret-access'})
        self.assertEqual(hook.guard_calls, before)

    def test_real_entry_points_raise(self):
        calls = (
            lambda: keyring.get_password('Steve', 'vault-encryption-key'),
            lambda: keyring.set_password('Steve', 'vault-encryption-key', 'x'),
            lambda: keyring.delete_password('Steve', 'vault-encryption-key'),
            lambda: keyring.get_keyring(),
            lambda: SecretService.get_password(None, 'Steve', 'u'),
            lambda: SecretService.set_password(None, 'Steve', 'u', 'p'),
            lambda: SecretService.delete_password(None, 'Steve', 'u'),
            lambda: MacKeyring.get_password(None, 'Steve', 'u'),
            lambda: MacKeyring.set_password(None, 'Steve', 'u', 'p'),
            lambda: MacKeyring.delete_password(None, 'Steve', 'u'),
            lambda: hook.crypt_protect(b'x', 'Steve', None, None, None, 1),
            lambda: hook.crypt_unprotect(b'x', None, None, None, 1),
        )
        for call in calls:
            with self.subTest(call=getattr(call, '__name__', call)):
                with self.assertRaises(hook.RealKeyringForbidden):
                    call()
        win32crypt = getattr(vault, 'win32crypt', None)
        if win32crypt is not None:
            with self.assertRaises(hook.RealKeyringForbidden):
                win32crypt.CryptProtectData(b'x', 'Steve', None, None, None, 1)
            with self.assertRaises(hook.RealKeyringForbidden):
                win32crypt.CryptUnprotectData(b'x', None, None, None, 1)
        if hook.macos_api_guarded:
            from keyring.backends.macOS import api
            with self.assertRaises(hook.RealKeyringForbidden):
                api.find_generic_password(None, 'Steve', 'u')
            with self.assertRaises(hook.RealKeyringForbidden):
                api.set_generic_password(None, 'Steve', 'u', 'p')

    def _shipping_cipher(self):
        saved = (vault.Vault._cipher, keyring.get_keyring, keyring.get_password, keyring.set_password)
        self.addCleanup(lambda: (
            setattr(vault.Vault, '_cipher', saved[0]),
            setattr(keyring, 'get_keyring', saved[1]),
            setattr(keyring, 'get_password', saved[2]),
            setattr(keyring, 'set_password', saved[3]),
        ))
        vault.Vault._cipher = hook.original_cipher

    def test_shipping_cipher_hits_the_guard_for_an_os_backend(self):
        self._shipping_cipher()
        class Backend:
            pass
        Backend.__module__ = 'keyring.backends.macOS'
        keyring.get_keyring = lambda: Backend()
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(hook.RealKeyringForbidden):
                Vault(Path(folder) / 'v.dpapi').save({'a': 1})

    def test_shipping_cipher_rejects_other_backends(self):
        self._shipping_cipher()
        seen = []
        def get_password(*args, **_kwargs):
            seen.append(args)
            raise AssertionError('get_password')
        keyring.get_password = get_password
        for module in ('keyring.backends.fail', 'keyring.backends.null'):
            class Backend:
                pass
            Backend.__module__ = module
            keyring.get_keyring = lambda backend=Backend: backend()
            with self.subTest(module=module):
                with tempfile.TemporaryDirectory() as folder:
                    with self.assertRaisesRegex(RuntimeError, 'Secret Service'):
                        Vault(Path(folder) / 'v.dpapi').save({'a': 1})
        self.assertEqual(seen, [])

    def test_legacy_key_is_copied_under_a_mock(self):
        self._shipping_cipher()
        legacy = Fernet.generate_key().decode('ascii')
        saved = {('SteveLocal', 'vault-encryption-key'): legacy}
        def get_password(service, username):
            return saved.get((service, username))
        def set_password(service, username, password):
            saved[(service, username)] = password
        class Backend:
            pass
        Backend.__module__ = 'keyring.backends.SecretService'
        keyring.get_keyring = lambda: Backend()
        keyring.get_password = get_password
        keyring.set_password = set_password
        before = hook.guard_calls
        with tempfile.TemporaryDirectory() as folder:
            box = Vault(Path(folder) / 'v.dpapi')
            box.save({'n': 1})
            self.assertEqual(box.load()['n'], 1)
        self.assertEqual(saved[('Steve', 'vault-encryption-key')], legacy)
        self.assertEqual(hook.guard_calls, before)

    def test_app_process_has_no_hook(self):
        done = subprocess.run(
            [sys.executable, '-c', _APP], env=_clean_env(), cwd=_ROOT,
            capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('ok', done.stdout)

    def test_unittest_child_is_isolated(self):
        done = subprocess.run(
            [sys.executable, '-c', _CHILD], cwd=_ROOT,
            capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('ok', done.stdout)

    def test_import_outside_unittest_does_not_install(self):
        done = subprocess.run(
            [sys.executable, '-c', _OUTSIDE], env=_clean_env(), cwd=_ROOT,
            capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn('ok', done.stdout)

"""Windows current-user DPAPI storage. Never writes plaintext credentials."""
import json
import os
import tempfile
from pathlib import Path

if os.name == 'nt':
    import win32crypt


def data_directory():
    if os.name == 'nt':
        from steve_desktop.legacy_profile import migrate_profile
        return migrate_profile(Path(os.environ['LOCALAPPDATA']))
    from platformdirs import user_data_dir
    return Path(user_data_dir('Steve', appauthor=False))


class Vault:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict:
        if not self.path.exists():
            return {}
        if os.name == 'nt':
            _, plain = win32crypt.CryptUnprotectData(self.path.read_bytes(), None, None, None, 1)
        else:
            plain = self._cipher().decrypt(self.path.read_bytes())
        return json.loads(plain)

    def save(self, value: dict) -> None:
        plain = json.dumps(value).encode()
        encrypted = (win32crypt.CryptProtectData(plain, 'Steve', None, None, None, 1)
                     if os.name == 'nt' else self._cipher().encrypt(plain))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=self.path.parent, suffix='.tmp')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(encrypted)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def _cipher(self):
        # macOS Keychain / Linux Secret Service. Never fall back to a plaintext key.
        import keyring
        from cryptography.fernet import Fernet
        backend = keyring.get_keyring()
        if not type(backend).__module__.startswith(('keyring.backends.macOS', 'keyring.backends.SecretService')):
            raise RuntimeError('Steve needs macOS Keychain or Linux Secret Service for encrypted storage.')
        key = keyring.get_password('Steve', 'vault-encryption-key')
        if key is None:
            from steve_desktop.legacy_profile import legacy_keyring_key
            key = legacy_keyring_key(keyring) or Fernet.generate_key().decode('ascii')
            keyring.set_password('Steve', 'vault-encryption-key', key)
        return Fernet(key.encode('ascii'))

"""MCP OAuth using the SDK's discovery, PKCE, validation and refresh flow."""
import asyncio
import hashlib
import os
import threading
import webbrowser
from pathlib import Path

from fastmcp.client.auth.oauth import OAuth
from key_value.aio.stores.base import BaseStore
from steve_desktop.vault import Vault, data_directory

_lock = threading.RLock()


def session_path(config, directory=None):
    directory = Path(directory) if directory else data_directory() / 'mcp-sessions'
    identity = config.url.rstrip('/') + '\n' + config.client_id + '\n' + config.scopes
    return directory / (hashlib.sha256(identity.encode()).hexdigest() + '.dpapi')


class EncryptedStore(BaseStore):
    def __init__(self, path):
        super().__init__(stable_api=True)
        self.vault = Vault(Path(path))

    async def _get_managed_entry(self, *, collection, key):
        with _lock:
            value = self.vault.load().get(collection, {}).get(key)
            return self._serialization_adapter.load_json(json_str=value) if value else None

    async def _put_managed_entry(self, *, collection, key, managed_entry):
        with _lock:
            data = self.vault.load()
            data.setdefault(collection, {})[key] = self._serialization_adapter.dump_json(entry=managed_entry)
            self.vault.save(data)

    async def _delete_managed_entry(self, *, collection, key):
        with _lock:
            data = self.vault.load()
            removed = data.get(collection, {}).pop(key, None) is not None
            if removed:
                self.vault.save(data)
            return removed


class DesktopOAuth(OAuth):
    def __init__(self, config, directory=None, notify=None):
        self.notify = notify or (lambda message: None)
        super().__init__(mcp_url=config.url, client_name='Steve',
                         scopes=config.scopes or None, client_id=config.client_id or None,
                         callback_host='127.0.0.1', callback_timeout=300,
                         token_storage=EncryptedStore(session_path(config, directory)))

    async def redirect_handler(self, authorization_url):
        # Do not print authorization URLs or tokens into logs.
        self.authorization_url = authorization_url

    async def callback_handler(self):
        # Start the SDK listener before opening a browser with an existing session.
        callback = asyncio.create_task(super().callback_handler())
        try:
            async with asyncio.timeout(10):
                while not callback.done():
                    try:
                        _, writer = await asyncio.open_connection('127.0.0.1', self.redirect_port)
                        writer.close()
                        await writer.wait_closed()
                        break
                    except OSError:
                        await asyncio.sleep(.05)
                if callback.done():
                    return await callback
            self.notify('Sign in to the MCP service in your browser. Waiting for approval…')
            if not webbrowser.open(self.authorization_url):
                raise RuntimeError('Could not open the sign-in browser.')
            return await callback
        finally:
            callback.cancel()
            await asyncio.gather(callback, return_exceptions=True)


def forget_session(config, directory=None):
    with _lock:
        session_path(config, directory).unlink(missing_ok=True)

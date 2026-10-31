"""Subscription authentication and account model catalog; no agent tools."""
import asyncio
import secrets
import threading
import time
import uuid
import webbrowser
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlsplit

from httpx2 import AsyncClient
from pydantic import BaseModel, Field
from pydantic_ai.providers.openai_chatgpt import (
    OpenAIChatGPTCredentials,
    OpenAIChatGPTCredentialSource,
    OpenAIChatGPTOAuthFlow,
    OpenAIChatGPTProvider,
)
from steve_desktop.vault import Vault


class AppError(Exception):
    """An intentionally safe message for display, without HTTP bodies or secrets."""


class ModelChoice(BaseModel):
    slug: str = Field(min_length=1)
    display_name: str = Field(min_length=1)
    visibility: str
    supported_reasoning_levels: list[dict[str, str]] = Field(default_factory=list)
    default_reasoning_level: str | None = None


class Catalog(BaseModel):
    models: list[ModelChoice]


def visible_models(data: dict) -> list[ModelChoice]:
    return [item for item in Catalog.model_validate(data).models if item.visibility == 'list']


class CredentialSource(OpenAIChatGPTCredentialSource):
    def __init__(self, vault: Vault):
        self.vault = vault

    async def load(self) -> OpenAIChatGPTCredentials:
        data = self.vault.load().get('credentials')
        if not data:
            raise AppError('Sign in with ChatGPT first.')
        return OpenAIChatGPTCredentials(**data)

    async def save(self, credentials: OpenAIChatGPTCredentials) -> None:
        data = self.vault.load()
        data['credentials'] = asdict(credentials)
        data['client_id'] = credentials.client_id
        self.vault.save(data)


class Service:
    def __init__(self, vault: Vault):
        self.vault = vault
        self.source = CredentialSource(vault)

    def signed_in(self) -> bool:
        return bool(self.vault.load().get('credentials'))

    def logout(self) -> None:
        data = self.vault.load()
        # Keep installation identity, but remove account registration and all tokens.
        self.vault.save({'host_id': data.get('host_id', uuid.uuid4().urn)})

    def login(self, cancel: threading.Event) -> None:
        data = self.vault.load()
        data.setdefault('host_id', uuid.uuid4().urn)
        self.vault.save(data)
        callback = {}
        flow = None

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(2)

            def do_GET(self):
                parsed = urlsplit(self.path)
                params = parse_qs(parsed.query)
                valid = (
                    parsed.path == '/auth/callback'
                    and all(len(v) == 1 for v in params.values())
                    and secrets.compare_digest(params.get('state', [''])[0], flow.state)
                )
                if not valid:
                    self.send_error(400, 'Invalid callback')
                    return
                callback.update({k: v[0] for k, v in params.items()})
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(b'Return to Steve to see the sign-in result. You may close this tab.')

            def log_message(self, *_):
                pass

        # Bind an available loopback port before opening the browser.
        with HTTPServer(('127.0.0.1', 0), Handler) as server:
            server.timeout = 0.25
            saved = data.get('credentials', {})
            flow = OpenAIChatGPTOAuthFlow(
                app_name='Steve', host_id=data['host_id'],
                client_id=data.get('client_id'), id_token_hint=saved.get('id_token'),
                redirect_uri=f'http://127.0.0.1:{server.server_port}/auth/callback',
            )
            extra = {'prompt': 'consent'} if saved and not OpenAIChatGPTCredentials(**saved).plan_usage_granted else None
            if not webbrowser.open(flow.authorization_url(extra_params=extra)):
                raise AppError('Could not open your default browser. Configure a default browser and retry.')
            deadline = time.monotonic() + 180
            while not callback:
                if cancel.is_set():
                    raise AppError('Sign-in cancelled.')
                if time.monotonic() >= deadline:
                    raise AppError('Sign-in timed out. Click Sign in to try again.')
                server.handle_request()
        if cancel.is_set():
            raise AppError('Sign-in cancelled.')
        if callback.get('error') or not callback.get('code'):
            raise AppError('Sign-in was declined or incomplete. You can try again.')

        async def exchange():
            try:
                credentials = await flow.exchange_code(callback['code'], client_id=callback.get('client_id'))
            finally:
                if flow.client_id:
                    state = self.vault.load()
                    state['client_id'] = flow.client_id
                    self.vault.save(state)
            await self.source.save(credentials)
            if not credentials.plan_usage_granted:
                raise AppError('Signed in, but plan usage was not granted. Sign in again and allow subscription usage.')
        asyncio.run(exchange())

    async def models(self) -> list[ModelChoice]:
        async with AsyncClient(timeout=30, follow_redirects=False) as client:
            # The provider supplies and refreshes OAuth credentials on this dedicated client.
            provider = OpenAIChatGPTProvider(credential_source=self.source, http_client=client)
            response = await client.get(f'{provider.base_url}/models')
            if response.status_code == 401:
                raise AppError('Your session has expired. Sign in again.')
            if response.status_code == 403:
                raise AppError('This account or workspace does not allow this request. Check plan usage permission.')
            if response.status_code == 429:
                raise AppError('OpenAI returned a usage or rate limit. Try again later.')
            if response.status_code != 200:
                raise AppError(f'OpenAI model listing failed (HTTP {response.status_code}). Try again later.')
            return visible_models(response.json())

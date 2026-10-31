"""Opt-in stdio MCP bridge to the CAD document open in Steve."""
import asyncio
import inspect
import json
import os
import secrets
import sys
from pathlib import Path
from fastapi import HTTPException, Request
from steve_desktop.vault import Vault


class LocalMCP:
    def __init__(self, server):
        from steve_desktop.cad_service import cad_tools
        self.server = server
        self.enabled = False
        self.token = ''
        self.tasks = set()
        self.serial = asyncio.Lock()
        self.vault = Vault(server.folder.parent / 'mcp-bridge.dpapi')
        self.tools = cad_tools(server.folder, None, lambda text: None).tools
        app = server.app

        @app.get('/v1/local/mcp-server')
        async def status(): return self.status()

        @app.post('/v1/local/mcp-server/{action}')
        async def control(action: str):
            if action == 'start':
                self.token = secrets.token_urlsafe(32)
                self.enabled = True
                self.vault.save({'url': server.url, 'token': self.token})
            elif action == 'stop': self.stop()
            else: raise HTTPException(404, 'Unknown server action')
            return self.status()

        @app.get('/v1/mcp-bridge/tools')
        async def tools():
            return [{'name': t.name, 'description': t.description or '', 'inputSchema': t.function_schema.json_schema}
                    for t in self.tools.values()]

        @app.post('/v1/mcp-bridge/call/{name}')
        async def call(name: str, request: Request):
            tool = self.tools.get(name)
            if tool is None: raise HTTPException(404, 'Unknown CAD tool')
            args = tool.function_schema.validator.validate_python(await request.json())
            async def execute():
                async with self.serial:
                    if not self.enabled: raise HTTPException(503, 'Local MCP server stopped')
                    if inspect.iscoroutinefunction(tool.function): return await tool.function(**args)
                    return await asyncio.to_thread(tool.function, **args)
            task = asyncio.create_task(execute())
            self.tasks.add(task)
            try:
                while not task.done():
                    await asyncio.wait({task}, timeout=.1)
                    if await request.is_disconnected():
                        task.cancel()
                        raise HTTPException(499, 'Client disconnected')
                return await task
            except asyncio.CancelledError:
                raise HTTPException(409, 'Local MCP call cancelled')
            finally:
                self.tasks.discard(task)
                if not task.done(): task.cancel()

    def authorized(self, request):
        return (self.enabled and not request.headers.get('origin') and
                secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + self.token))

    def status(self):
        args = ['--mcp'] if getattr(sys, 'frozen', False) else ['-m', 'steve_desktop', '--mcp']
        launch = {'command': sys.executable, 'args': args}
        if getattr(sys, 'frozen', False) and sys.platform == 'linux' and os.environ.get('STEVE_BUNDLE_LAUNCHER'):
            launch['command'] = os.environ['STEVE_BUNDLE_LAUNCHER']
        if getattr(sys, 'frozen', False) and sys.platform == 'linux' and os.environ.get('APPIMAGE'):
            # A mount/extraction path changes on each launch. Export the durable
            # AppImage path so clients can reconnect after the desktop restarts.
            launch['command'] = os.environ['APPIMAGE']
            if os.environ.get('APPIMAGE_EXTRACT_AND_RUN'):
                launch['env'] = {'APPIMAGE_EXTRACT_AND_RUN': '1'}
        return {'running': self.enabled, 'transport': 'stdio', 'tools': len(self.tools),
                'configuration': {'mcpServers': {'steve': launch}}}

    def stop(self):
        self.enabled = False
        self.token = ''
        self.vault.path.unlink(missing_ok=True)
        for task in list(self.tasks): task.get_loop().call_soon_threadsafe(task.cancel)


async def serve_stdio():
    # A windowed Windows executable has no Python stdio wrappers even when an
    # MCP client supplied real pipe handles. Reopen those inherited handles;
    # never allocate a console or send protocol traffic to a log/devnull.
    if sys.platform == 'win32':
        import ctypes
        import msvcrt
        import os
        get_handle = ctypes.windll.kernel32.GetStdHandle
        get_handle.argtypes = [ctypes.c_ulong]
        get_handle.restype = ctypes.c_void_p
        for name, identifier, mode in [('stdin', -10, 'r'), ('stdout', -11, 'w'), ('stderr', -12, 'w')]:
            if getattr(sys, name) is None:
                handle = get_handle(identifier)
                if not handle or handle == ctypes.c_void_p(-1).value:
                    if name == 'stderr':
                        sys.stderr = open(os.devnull, 'w', encoding='utf-8')
                        continue
                    raise RuntimeError('Launch Steve --mcp from an MCP client with stdin/stdout pipes.')
                fd = msvcrt.open_osfhandle(handle, (os.O_RDONLY if mode == 'r' else os.O_WRONLY) | os.O_BINARY)
                setattr(sys, name, os.fdopen(fd, mode, encoding='utf-8', buffering=1))
    import httpx
    import mcp.types as types
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server
    from steve_desktop.vault import data_directory
    vault = Vault(data_directory() / 'mcp-bridge.dpapi')

    async def request(method, path, body=None):
        config = vault.load()
        if not config: raise ValueError('Start the local MCP server in Steve Settings → Tools & MCP.')
        from urllib.parse import urlsplit
        url = urlsplit(config['url'])
        if url.scheme != 'http' or url.hostname != '127.0.0.1': raise ValueError('Invalid local endpoint')
        async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
            response = await client.request(method, config['url']+'/v1/mcp-bridge/'+path,
                                            headers={'Authorization': 'Bearer '+config['token']}, json=body)
            response.raise_for_status()
            return response.json()

    async def listing(ctx, params):
        return types.ListToolsResult(tools=[types.Tool(**t) for t in await request('GET','tools')])

    async def calling(ctx, params):
        try:
            result = await request('POST', 'call/'+params.name, params.arguments or {})
            return types.CallToolResult(content=[types.TextContent(type='text',text=json.dumps(result))],
                                        isError=isinstance(result,dict) and 'error' in result)
        except Exception as exc:
            return types.CallToolResult(content=[types.TextContent(type='text',text=str(exc))],isError=True)

    server = Server('Steve', on_list_tools=listing, on_call_tool=calling)
    async with stdio_server() as (reader, writer):
        if sys.platform=='linux':
            from steve_desktop.linux_updates import notify_ready
            notify_ready()
        await server.run(reader, writer, server.create_initialization_options())

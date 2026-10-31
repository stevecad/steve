import asyncio
import tempfile
import sys
import socket
import subprocess
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

from pydantic import ValidationError
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart, ModelMessagesTypeAdapter
from steve_desktop.runtime import calculate, ServerConfig, make_mcp, ApprovedToolset, chat
from steve_desktop.service import Service
from steve_desktop.vault import Vault


class RuntimeTests(unittest.TestCase):
    def test_calculator_is_not_code_execution(self):
        self.assertEqual(calculate('17 * 19'), '323')
        for text in ['__import__("os").system("whoami")', '2 ** 100000', '[1]*99999', '1/0']:
            with self.assertRaises(ModelRetry):
                calculate(text)

    def test_remote_transport_validation(self):
        for url in ('http://example.com/mcp', 'file:///tmp/server', 'https://user:secret@example.com/mcp'):
            with self.assertRaises(ValidationError):
                ServerConfig(name='test', url=url)
        ServerConfig(name='local', url='http://127.0.0.1:8080/mcp')

    def test_enabled_tool_executes_without_approval(self):
        wrapped = AsyncMock()
        approve = AsyncMock(return_value=False)
        records = []
        toolset = ApprovedToolset(wrapped, approve, records.append, 'test', True)
        result = asyncio.run(toolset.call_tool('danger', {'value': 3}, None, None))
        wrapped.call_tool.assert_awaited_once_with('danger', {'value': 3}, None, None)
        approve.assert_not_awaited()

    def test_chat_with_tools_and_history(self):
        calls = []
        async def model(messages, info):
            calls.append(messages)
            if len(calls) == 1:
                return ModelResponse(parts=[ToolCallPart('calculate', {'expression': '17*19'}, tool_call_id='test')])
            return ModelResponse(parts=[TextPart('323')])
        with tempfile.TemporaryDirectory() as folder:
            service = Service(Vault(Path(folder) / 'auth.dpapi'))
            activity = []
            result, history = asyncio.run(chat(service.source, 'test', 'Calculate 17 * 19', [], {},
                AsyncMock(return_value=True), activity.append, model_override=FunctionModel(model)))
            self.assertEqual(result, '323')
            self.assertTrue(any('Completed' in line for line in activity))
            encoded = ModelMessagesTypeAdapter.dump_python(history, mode='json')
            self.assertEqual(len(ModelMessagesTypeAdapter.validate_python(encoded)), len(history))

    def test_real_stdio_mcp_discovery_and_call(self):
        async def run():
            config = ServerConfig(name='sample', transport='stdio', command=sys.executable,
                                  args=[str(Path(__file__).parent / 'fixtures/sample_mcp_server.py')])
            async with make_mcp(config) as server:
                tools = await server.list_tools()
                self.assertIn('add_numbers', [tool.name for tool in tools])
                result = await server.client.call_tool('add_numbers', {'a': 17, 'b': 19})
                self.assertIn('36', str(result))
        asyncio.run(run())

    def test_agent_calls_mcp_directly(self):
        calls = []
        async def model(messages, info):
            calls.append(messages)
            if len(calls) == 1:
                return ModelResponse(parts=[ToolCallPart('sample_add_numbers', {'a': 17, 'b': 19}, tool_call_id='mcp1')])
            return ModelResponse(parts=[TextPart('36')])
        config = ServerConfig(name='sample', transport='stdio', command=sys.executable,
                              args=[str(Path(__file__).parent / 'fixtures/sample_mcp_server.py')])
        with tempfile.TemporaryDirectory() as folder:
            service = Service(Vault(Path(folder) / 'auth.dpapi'))
            approval = AsyncMock(return_value=True)
            activity = []
            output, history = asyncio.run(chat(service.source, 'test', 'Add numbers', [],
                {'servers': [config.model_dump()]}, approval, activity.append, model_override=FunctionModel(model)))
            self.assertEqual(output, '36')
            approval.assert_not_awaited()
            self.assertTrue(any('Completed' in item for item in activity))

    def test_real_http_mcp(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen([sys.executable, str(Path(__file__).parent / 'fixtures/sample_mcp_server.py'),
                                    '--http', str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            deadline = time.monotonic() + 15
            while True:
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() > deadline or process.poll() is not None:
                        self.fail('Sample HTTP MCP server did not start')
                    time.sleep(0.1)
            async def run():
                async with make_mcp(ServerConfig(name='http_sample', url=f'http://127.0.0.1:{port}/mcp')) as server:
                    self.assertIn('add_numbers', [t.name for t in await server.list_tools()])
                    self.assertIn('36', str(await server.client.call_tool('add_numbers', {'a': 17, 'b': 19})))
            asyncio.run(run())
        finally:
            process.terminate()
            process.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()

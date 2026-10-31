"""Chat runtime and explicitly bounded local tools."""
import ast
import math
import operator
import os
os.environ.setdefault('PYDANTIC_AI_NO_BANNER', '1')
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, model_validator
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelRetry
from pydantic_ai.models.openai import OpenAIResponsesModel
from pydantic_ai.providers.openai_chatgpt import OpenAIChatGPTProvider
from pydantic_ai.toolsets.function import FunctionToolset
from pydantic_ai.toolsets.wrapper import WrapperToolset
from pydantic_ai.usage import UsageLimits
from httpx2 import AsyncClient
from steve_desktop.agent_features import DEFAULT_PROMPT, WindowsCommands, capabilities_for


class ServerConfig(BaseModel):
    name: str = Field(pattern=r'^[A-Za-z][A-Za-z0-9_]{0,31}$')
    transport: Literal['http', 'stdio'] = 'http'
    enabled: bool = True
    url: str = ''
    token: str = ''
    auth_mode: Literal['auto', 'bearer', 'none'] = 'auto'
    scopes: str = ''
    client_id: str = ''
    command: str = ''
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    cwd: str = ''

    @model_validator(mode='after')
    def validate_connection(self):
        if self.transport == 'http':
            parsed = urlsplit(self.url)
            if not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
                raise ValueError('Use a server URL without credentials or fragments.')
            if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
                raise ValueError('Use HTTPS, or HTTP on localhost.')
        elif not self.command.strip():
            raise ValueError('A local executable is required.')
        return self


def make_mcp(config: ServerConfig, oauth_dir=None, notify=None):
    from pydantic_ai.mcp import MCPToolset
    from fastmcp.client.transports import StdioTransport
    if config.transport == 'stdio':
        # The SDK's minimal subprocess environment omits the desktop session.
        # Linux MCP programs need it to reach Secret Service and the same XDG
        # profile as the GUI. Keep credentials out unless explicitly configured.
        env = {name: os.environ[name] for name in (
            'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME',
            'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'
        ) if name in os.environ}
        env.update(config.env)
        transport = StdioTransport(command=config.command, args=config.args,
                                   env=env, cwd=config.cwd or None,
                                   keep_alive=False, log_file=Path(os.devnull))
        return MCPToolset(transport, id=config.name, init_timeout=20, read_timeout=60,
                          include_instructions=False, prefer_tasks=False)
    auth = None
    if config.auth_mode == 'bearer' or (config.auth_mode == 'auto' and config.token):
        auth = config.token or None
    elif config.auth_mode == 'auto':
        from steve_desktop.mcp_auth import DesktopOAuth
        auth = DesktopOAuth(config, oauth_dir, notify)
    return MCPToolset(config.url, id=config.name, auth=auth,
                      init_timeout=330, read_timeout=330 if config.auth_mode == 'auto' else 60, include_instructions=False,
                      prefer_tasks=False)


class SubscriptionModel(OpenAIResponsesModel):
    # Pinned PydanticAI 2.63 emits flat tools; this subscription route requires
    # function tools grouped in namespaces. Its response mapper already preserves
    # returned namespace metadata in history. Tested with captured wire requests.
    def _get_responses_tool_choice(self, *args, **kwargs):
        tools, choice = super()._get_responses_tool_choice(*args, **kwargs)
        if tools:
            tools = [{'type': 'namespace', 'name': 'steve',
                      'description': 'Tools executed locally by Steve.', 'tools': tools}]
        return tools, choice


def calculate(expression: str) -> str:
    """Calculate basic arithmetic: +, -, *, /, //, %, and bounded powers."""
    if len(expression) > 200:
        raise ModelRetry('Expression must be at most 200 characters.')
    operations = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
                  ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
                  ast.Mod: operator.mod, ast.Pow: operator.pow}
    def evaluate(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            value = node.value
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = evaluate(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        elif isinstance(node, ast.BinOp) and type(node.op) in operations:
            left, right = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > 12:
                raise ValueError('Exponent must be between -12 and 12.')
            value = operations[type(node.op)](left, right)
        else:
            raise ValueError('Only arithmetic is supported.')
        if not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e100:
            raise ValueError('Result is outside the supported range.')
        return value
    try:
        return str(evaluate(ast.parse(expression, mode='eval').body))
    except (ValueError, TypeError, SyntaxError, ArithmeticError, RecursionError) as exc:
        raise ModelRetry('Invalid or out-of-range arithmetic expression.') from exc


def current_time() -> str:
    """Get the local machine's current time including its UTC offset."""
    return datetime.now().astimezone().isoformat(timespec='seconds')


@dataclass
class ApprovedToolset(WrapperToolset):
    approve: object = None
    activity: object = None
    source: str = 'Local'
    all_calls: bool = False

    async def call_tool(self, name, tool_args, ctx, tool):
        self.activity(f'Running · {self.source} / {name}')
        try:
            result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
        except Exception:
            self.activity(f'Failed · {self.source} / {name}')
            raise
        self.activity(f'Completed · {self.source} / {name}')
        return result


def toolsets_for(settings, approve, activity):
    functions = [calculate, current_time]
    if settings.get('workspace') and settings.get('scripts_enabled', True) and os.name == 'nt':
        functions.append(WindowsCommands(settings['workspace']).run_command)
    result = [ApprovedToolset(FunctionToolset(functions, sequential=True), approve, activity)]
    if settings.get('_cad_project'):
        from steve_desktop.cad_service import cad_tools
        result.append(cad_tools(settings['_cad_project'], approve, activity))
    for raw in settings.get('servers', []):
        config = ServerConfig.model_validate(raw)
        if config.enabled:
            result.append(ApprovedToolset(make_mcp(config, settings.get('_oauth_dir'), activity).prefixed(config.name), approve,
                                          activity, config.name, True))
    return result


async def chat(source, model_id, prompt, history, settings, approve, activity, delta=None, model_override=None):
    async with AsyncClient(timeout=90) as client:
        provider = OpenAIChatGPTProvider(credential_source=source, http_client=client)
        model = model_override or SubscriptionModel(model_id, provider=provider)
        import platform
        instructions = settings.get('system_prompt', DEFAULT_PROMPT)
        instructions += f'\nHost: {platform.system()}. Selected workspace: {settings.get("workspace") or "none"}. '
        if os.name == 'nt':
            instructions += 'File tools use virtual paths relative to the selected workspace (root /). run_command executes PowerShell scripts using real Windows paths. '
        instructions += 'Scripts run as the current user, not in a sandbox. Enabled tools execute directly.'
        if settings.get('skill_libraries'):
            instructions += '\nConfigured skill library host paths: ' + ', '.join(settings['skill_libraries'])
        if settings.get('_cad_project'):
            instructions += '\nYou are Steve, the local CAD assistant. The active project is available via CAD tools. Read cad_read and cad_api_reference before modeling; use the upstream steve API, inspect actual geometry after every build, and export with cad_export. Never claim a model built or exported without tool evidence. Source files use Studio-compatible Python. All CAD and Blender execution is local. For Blender scenes load the bundled steve-blender skill, use cad_build with kind blender and bpy source, cad_inspect for scene/object details, blender_render for images/video, and cad_export with BLEND/GLB/MP4. Blender is for meshes/rendering; do not claim its meshes are exact CAD solids. A viewport selection refers to its recorded revision. Do not run CAD on remote MCP services. Use configured Studio MCP for document read/save exchange: retrieve its complete source package, cad_import_package it, then cad_build locally. cad_source_package returns local source for an explicitly requested publish through MCP. Preserve main.py, params.py, components/*.py and revision-pinned links. Human viewport selection includes persistent topology references and exact geometry.'
        effort = settings.get('reasoning_effort')
        model_settings = {'openai_reasoning_effort': effort} if effort else None
        agent = Agent(model, toolsets=toolsets_for(settings, approve, activity),
                      capabilities=capabilities_for(settings, approve, activity),
                      instructions=instructions, model_settings=model_settings)
        async def events(ctx, stream):
            from pydantic_ai.messages import PartDeltaEvent, TextPartDelta, PartStartEvent, TextPart
            async for event in stream:
                if delta is not None:
                    if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                        delta(event.part.content)
                    elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        delta(event.delta.content_delta)
        async with agent:
            result = await agent.run(prompt, message_history=history, event_stream_handler=events if delta else None,
                                     usage_limits=UsageLimits(request_limit=16, tool_calls_limit=20),
                                     timeout=600)
        return result.output, result.all_messages()

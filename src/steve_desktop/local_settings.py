"""Local agent preferences exposed to the Studio settings UI, without credentials."""
import copy
from pathlib import Path
from fastapi import HTTPException
from steve_desktop.agent_features import DEFAULT_PROMPT
from steve_desktop.runtime import ServerConfig

class LocalSettings:
    def settings(self):
        agent = self.window.agent_settings
        tools = self.window.tools_panel
        servers = []
        for original in tools.settings.get('servers', []):
            item = copy.deepcopy(original)
            item['has_token'] = bool(item.pop('token', ''))
            item['has_env'] = bool(item.pop('env', {}))
            servers.append(item)
        config = {k: v for k, v in agent.values().items() if k not in ('approval_mode', 'remembered_approvals')}
        return {'agent': {**config, 'system_prompt': config.get('system_prompt', DEFAULT_PROMPT)},
                'default_prompt': DEFAULT_PROMPT, 'workspace': tools.settings.get('workspace', ''),
                'servers': servers, 'mcp_busy': bool(tools.probe and tools.probe.isRunning()),
                'mcp_status': tools.result}

    def save_agent(self, body):
        allowed = {'system_prompt', 'scripts_enabled', 'memory_enabled', 'skill_libraries'}
        if set(body) - allowed: raise HTTPException(422, 'Unknown agent setting')
        if 'system_prompt' in body and (not isinstance(body['system_prompt'], str) or len(body['system_prompt']) > 100000):
            raise HTTPException(422, 'System prompt must be under 100,000 characters.')
        for key in ('scripts_enabled', 'memory_enabled'):
            if key in body and not isinstance(body[key], bool): raise HTTPException(422, 'Expected a switch value')
        if 'skill_libraries' in body:
            libraries = body['skill_libraries']
            if not isinstance(libraries, list) or len(libraries)>30 or any(not isinstance(p,str) or not Path(p).is_dir() for p in libraries):
                raise HTTPException(422, 'Each skill library must be an existing directory.')
        agent = self.window.agent_settings
        updated = {**agent.config, **body}
        agent.vault.save(updated)
        agent.config = updated
        # The retained controller reads config directly; never open its old UI.
        return self.settings()

    def workspace(self, path):
        if not isinstance(path, str) or path and not Path(path).is_dir():
            raise HTTPException(422, 'Choose an existing directory or leave it empty to disable file tools.')
        tools = self.window.tools_panel
        tools.settings.update(workspace=path, workspace_configured=True)
        tools.save()
        return self.settings()

    def save_server(self, body):
        tools = self.window.tools_panel
        if tools.probe and tools.probe.isRunning(): raise HTTPException(409, 'Wait for the connection test to finish.')
        original = body.get('original_name')
        items = copy.deepcopy(tools.settings.get('servers', []))
        existing = next((i for i in items if i['name']==original), {})
        value = {k:v for k,v in body.items() if k in ServerConfig.model_fields}
        if not value.get('token'): value['token'] = existing.get('token','')
        if 'env' not in value: value['env'] = existing.get('env',{})
        if body.get('clear_token'): value['token']=''
        try: config = ServerConfig.model_validate(value).model_dump()
        except Exception: raise HTTPException(422, 'Check server name, HTTPS URL or local executable, arguments and environment.') from None
        if any(i['name']==config['name'] and i['name']!=original for i in items): raise HTTPException(409, 'Server names must be unique.')
        if original and not existing: raise HTTPException(404, 'Server no longer exists.')
        items = [config if i['name']==original else i for i in items]
        if not original: items.append(config)
        tools.settings['servers']=items;tools.save()
        return self.settings()

    def server_action(self, name, action):
        tools=self.window.tools_panel
        if action=='cancel':
            if tools.probe: tools.probe.stop()
            return self.settings()
        if tools.probe and tools.probe.isRunning(): raise HTTPException(409,'Wait for the connection test to finish.')
        items=tools.settings.get('servers',[])
        index=next((i for i,s in enumerate(items) if s['name']==name),None)
        if index is None: raise HTTPException(404,'Server not found')
        if action=='connect': tools.test_server(index)
        elif action=='forget': tools.forget_login(index)
        elif action=='delete': del items[index];tools.save()
        elif action=='toggle': items[index]['enabled']=not items[index].get('enabled',True);tools.save()
        else: raise HTTPException(404,'Unknown server action')
        return self.settings()

import { useEffect, useState } from 'react';
import { Button, Switch, Dialog } from '@/ui';
import { api } from '@/lib/api';
import { Card, Row, SettingsPage, SettingsEditor as Editor } from '../ui';
import { settingsSections } from '../registry';
import LocalMCPServer from './LocalMCPServer';
import styles from './LocalAgentSettings.module.css';

type Server = { name:string; transport:'http'|'stdio'; enabled:boolean; url:string; command:string; args:string[]; cwd:string; auth_mode:string; scopes:string; client_id:string; has_token?:boolean; has_env?:boolean };
type Config = { agent:{system_prompt:string;scripts_enabled?:boolean;memory_enabled?:boolean;skill_libraries?:string[]};default_prompt:string;workspace:string;servers:Server[];mcp_busy:boolean;mcp_status:string };
const blank:Server={name:'',transport:'http',enabled:true,url:'',command:'',args:[],cwd:'',auth_mode:'auto',scopes:'',client_id:''};
const send = <T,>(path:string,body:unknown,method='PUT') => api<T>('/v1/assistant/'+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

function ServerEditor({server,onSave,onClose}:{server:Server;onSave:(value:unknown)=>Promise<void>;onClose:()=>void}) {
  const [draft,setDraft]=useState({...server});const [args,setArgs]=useState(JSON.stringify(server.args));const [env,setEnv]=useState('');const [token,setToken]=useState('');const [error,setError]=useState('');const [saving,setSaving]=useState(false);
  const field=(key:keyof Server,label:string,type='text')=><label className={styles.field}>{label}<input className={styles.input} type={type} value={String(draft[key]??'')} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>;
  const save=async()=>{setSaving(true);setError('');try{const parsed=JSON.parse(args);if(!Array.isArray(parsed)||parsed.some(v=>typeof v!=='string'))throw Error('Arguments must be a JSON array of strings.');await onSave({...draft,original_name:server.name||null,args:parsed,token,clear_token:draft.auth_mode!=='bearer',...(env.trim()?{env:JSON.parse(env)}:{})});onClose();}catch(e){setError((e as Error).message);}finally{setSaving(false);}};
  return <Dialog open onOpenChange={open=>{if(!open&&!saving)onClose();}} width={700} height={720} title={server.name?'Edit MCP server':'Add MCP server'} description="Connect a remote service or a program on this machine." footer={<><Button disabled={saving} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving} onClick={()=>void save()}>Save server</Button></>}>
    <div className={styles.form}>{field('name','Server name')}
      <div className={styles.actions}>{(['http','stdio'] as const).map(value=><Button key={value} variant={draft.transport===value?'primary':'secondary'} onClick={()=>setDraft({...draft,transport:value})}>{value==='http'?'Remote HTTP':'Local stdio'}</Button>)}</div>
      {draft.transport==='http'?<>{field('url','Server URL')}<div className={styles.actions}>{[['auto','Browser sign-in'],['bearer','Bearer token'],['none','No authentication']].map(([value,label])=><Button key={value} variant={draft.auth_mode===value?'primary':'secondary'} onClick={()=>setDraft({...draft,auth_mode:value})}>{label}</Button>)}</div>
        {draft.auth_mode==='bearer'&&<label className={styles.field}>Bearer token<input className={styles.input} type="password" value={token} placeholder={server.has_token?'Saved securely; leave blank to keep':'Enter token'} onChange={e=>setToken(e.target.value)}/></label>}
        {draft.auth_mode==='auto'&&<details><summary>OAuth options</summary><div className={styles.grid}>{field('client_id','Client ID (optional)')}{field('scopes','Scopes (optional)')}</div></details>}</>
        :<>{field('command','Executable')}<label className={styles.field}>Arguments (JSON array)<input className={styles.input} value={args} onChange={e=>setArgs(e.target.value)}/></label>{field('cwd','Working directory (optional)')}<label className={styles.field}>Environment variables (JSON object)<textarea className={styles.input} rows={3} value={env} placeholder={server.has_env?'Saved securely; leave blank to keep':'{"NAME": "value"}'} onChange={e=>setEnv(e.target.value)}/></label></>}
      {error&&<p className={styles.error} role="alert">{error}</p>}
    </div>
  </Dialog>;
}
function SkillCatalog({libraries}:{libraries:string[]}) {
 const [items,setItems]=useState<{path:string;bundled?:boolean;skills:{name:string;description:string}[];warnings:string[]}[]>([]);
 useEffect(()=>{let active=true;void api<typeof items>('/v1/assistant/skills').then(value=>{if(active)setItems(value);});return()=>{active=false;};},[libraries.join('\n')]);
 return <Card title="Available skills">{!items.length?<p className={styles.note}>Add a library to discover skills.</p>:items.map(item=><div key={item.path}><p className={styles.note}>{item.bundled?'Included with Steve · CAD':item.path}</p>{item.skills.map(skill=><Row key={skill.name} label={skill.name} hint={skill.description}>{null}</Row>)}{item.warnings.map((warning,index)=><p key={index} className={styles.error}>{warning}</p>)}</div>)}</Card>;
}
function MemoryEditor(){
 const [note,setNote]=useState<{path:string;paths:string[];content:string;version:string|null}|null>(null);const [error,setError]=useState('');
 const load=async(path='steve/main/MEMORY.md')=>{try{setNote(await api('/v1/assistant/memory?path='+encodeURIComponent(path)));setError('');}catch(e){setError((e as Error).message);}};
 useEffect(()=>{void load();},[]);
 return <Card title="Memory notebook" description="Local notes Steve can use across conversations. Existing chat history can still contain earlier versions.">{error&&<p className={styles.error}>{error}</p>}{note&&<><div className={styles.actions}>{note.paths.map(path=><Button key={path} variant={path===note.path?'primary':'secondary'} onClick={()=>void load(path)}>{path.split('/').pop()}</Button>)}</div><Editor label="Memory note" value={note.content} onSave={async content=>{try{const result=await send<{version:string}>('memory',{path:note.path,content,version:note.version});setNote({...note,content,version:result.version});setError('');}catch(e){setError((e as Error).message);throw e;}}}/></>}</Card>;
}
export default function LocalAgentSettings({section}:{section:string}){
 const [data,setData]=useState<Config|null>(null);const [error,setError]=useState('');const [editing,setEditing]=useState<Server|null>(null);
 const load=async()=>{try{setData(await api('/v1/assistant/settings'));}catch(e){setError((e as Error).message);}};
 useEffect(()=>{void load();},[]);
 useEffect(()=>{if(!data?.mcp_busy)return;const timer=setTimeout(()=>void load(),600);return()=>clearTimeout(timer);},[data]);
 const update=async(path:string,body:unknown,method='PUT',propagate=false)=>{try{setData(await send<Config>(path,body,method));setError('');}catch(e){setError((e as Error).message);if(propagate)throw e;}};
 const action=(name:string,action:string)=>update(`settings/server/${encodeURIComponent(name)}/${action}`,{},'POST');
 return <SettingsPage section={settingsSections().find(item=>item.id===section)!}>{error&&<p className={styles.error} role="alert">{error}</p>}{!data?<p>Loading settings…</p>:<>
 {section==='local-instructions'&&<><Card title="System prompt" description="Applied to the next message, including in existing conversations."><Editor label="System prompt" value={data.agent.system_prompt} onSave={system_prompt=>update('settings/agent',{system_prompt},'PUT',true)}/><Button onClick={()=>void update('settings/agent',{system_prompt:data.default_prompt})}>Restore default prompt</Button></Card><Card title="Script execution"><Row label="Allow scripts" hint="Scripts run as your OS user. The workspace is their starting folder, not a sandbox."><Switch label="Allow scripts" checked={data.agent.scripts_enabled!==false} onCheckedChange={scripts_enabled=>void update('settings/agent',{scripts_enabled})}/></Row></Card></>}
 {section==='local-skills'&&<><Card title="Skill libraries" description="CAD skills are included with Steve. Add optional libraries below, one existing directory per line containing skill-name/SKILL.md."><Editor label="Skill library directories" rows={5} value={(data.agent.skill_libraries??[]).join('\n')} onSave={value=>update('settings/agent',{skill_libraries:value.split('\n').map(v=>v.trim()).filter(Boolean)},'PUT',true)}/></Card><SkillCatalog libraries={data.agent.skill_libraries??[]}/></>}
 {section==='local-memory'&&<><Card title="Memory"><Row label="Remember useful notes" hint="Notes are stored locally in SQLite. Relevant notes are sent with chats when enabled."><Switch label="Enable memory" checked={!!data.agent.memory_enabled} onCheckedChange={memory_enabled=>void update('settings/agent',{memory_enabled})}/></Row></Card><MemoryEditor/></>}
 {section==='local-mcp'&&<><LocalMCPServer/><Card title="File workspace" description="File tools stay within this directory. Leave empty to disable them."><Editor label="Workspace directory" rows={1} value={data.workspace} onSave={path=>update('settings/workspace',{path},'PUT',true)}/></Card><Card title="MCP servers" description="Connect remote services or local programs. Connection tests discover tools without calling them." actions={<Button disabled={data.mcp_busy} onClick={()=>setEditing({...blank})}>Add server</Button>}>
 {!data.servers.length&&<p className={styles.note}>No servers configured.</p>}{data.servers.map(server=><div key={server.name} className={styles.server}><Row label={server.name} hint={server.transport==='http'?server.url:server.command}><Switch label={`Enable ${server.name}`} checked={server.enabled} disabled={data.mcp_busy} onCheckedChange={()=>void action(server.name,'toggle')}/></Row><div className={styles.actions}><Button disabled={data.mcp_busy} onClick={()=>void action(server.name,'connect')}>Connect / sign in</Button><Button disabled={data.mcp_busy} onClick={()=>setEditing(server)}>Edit</Button><Button disabled={data.mcp_busy} onClick={()=>void action(server.name,'forget')}>Forget sign-in</Button><Button disabled={data.mcp_busy} onClick={()=>void action(server.name,'delete')}>Remove</Button></div></div>)}
 {data.mcp_busy&&<Button onClick={()=>void action('_','cancel')}>Cancel connection</Button>}{data.mcp_status&&<pre className={styles.result} role="status">{data.mcp_status}</pre>}</Card>{editing&&<ServerEditor server={editing} onClose={()=>setEditing(null)} onSave={async body=>{const saved=await send<Config>('settings/server',body);setData(saved);}}/>}</>}
 </>}</SettingsPage>;
}

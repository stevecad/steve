import {useEffect,useState,type ReactNode} from 'react';
import {CloudDownload,FolderOpen,RefreshCw} from 'lucide-react';
import {Button} from '@/ui';
import {set} from '@/state/store';
import {openTab} from '@/state/tabs';
import {openStudioAccount,refreshStudio,studioAction,useStudio,useStudioStatus} from './studio';
import styles from './StudioProjects.module.css';

function Section({title,description,children}:{title:string;description:string;children:ReactNode}) {
 return <section className={styles.section}><h3>{title}</h3><p className={styles.note}>{description}</p>{children}</section>;
}
export default function StudioProjects() {
  const state=useStudioStatus();
  const error=useStudio(s=>s.error);
  const sending=useStudio(s=>s.sending);
  const [selected,setSelected]=useState<string[]>([]);
  const [search,setSearch]=useState('');
  const run=studioAction;
  useEffect(()=>{setSelected([]);},[state?.workspace,state?.connected]);
  useEffect(()=>{if(state?.connected&&!state.busy&&!state.workspaces.length&&!state.error)void run('list');},[state?.connected]);
  const busy=!!state?.busy||sending;
  const projects=state?.projects.filter(p=>p.state==='live'&&(p.name+' '+(p.folder?.path||'')).toLowerCase().includes(search.toLowerCase()))||[];
  const copies=state?.copies.filter(c=>c.identity[2]===state.workspace)||[];
  if(!state)return <div className={styles.empty} role="status">{error||'Loading Studio projects…'}<Button onClick={()=>void refreshStudio()}>Retry</Button></div>;
  if(!state.connected)return <div className={styles.empty}>
    <CloudDownload size={36}/><h2>Your Studio projects, on this machine</h2>
    <p>Connect your Steve Studio account to browse and download CAD projects. Downloaded copies stay available offline.</p>
    <Button variant="primary" onClick={openStudioAccount}>Open account menu</Button>
    <p role="status">{error||state.error||state.message}</p>
  </div>;
  return <div className={styles.projects} data-studio-projects>
    <div className={styles.status}>
      <p role="status">{state.message}</p>
      {busy&&<Button onClick={()=>void run('cancel')}>Cancel</Button>}
    </div>
    {(error||state.error)&&<p role="alert" className={styles.error}>{error||state.error}</p>}
      <Section title="Your projects" description="Choose projects to download with their linked parts, materials and imported assets. Downloading never starts a hosted CAD build.">
        <div className={styles.actions}>{state.workspaces.map(w=><Button key={w.id} variant={state.workspace===w.id?'primary':'secondary'} disabled={busy||!w.allowed} title={!w.allowed?'Allow Steve desktop in Studio Settings → Teams':w.name} onClick={()=>{setSelected([]);void run('list',{workspace:w.id});}}>{w.name}{!w.allowed?' · access required':''}</Button>)}</div>
        <label className={styles.field}>Find a project<input className={styles.input} type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search names or folders"/></label>
        <div className={styles.actions}>
          <Button disabled={busy||!selected.length} variant="primary" onClick={()=>void run('download',{workspace:state.workspace,projects:selected})}><CloudDownload size={15}/>Download selected{selected.length?` (${selected.length})`:''}</Button>
          <Button disabled={busy} onClick={()=>void run('list',{workspace:state.workspace})}>Refresh list</Button>
        </div>
        <div className={styles.studioProjects}>{projects.map(p=><label key={p.id} className={styles.studioProject}>
          <input type="checkbox" disabled={busy||(!selected.includes(p.id)&&selected.length>=100)} checked={selected.includes(p.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,p.id]:ids.filter(id=>id!==p.id))}/>
          <span><strong>{p.name}</strong><small>{p.folder?.path||'Top level'} · {p.kind} · revision {p.revision}</small></span>
          {copies.some(c=>c.remote_id===p.id)&&<small>Downloaded</small>}
        </label>)}</div>
        {!projects.length&&<p className={styles.note}>No matching CAD projects in this workspace.</p>}
      </Section>
      <Section title="Available on this machine" description="Refresh checks for changes without rebuilding geometry. A changed Studio snapshot arrives as a new local copy, keeping your existing copy and edits intact.">
        <label className={styles.studioProject}><input type="checkbox" checked={state.automatic} disabled={sending} onChange={e=>void run('automatic',{enabled:e.target.checked})}/><span><strong>Keep downloaded projects up to date</strong><small>Check every five minutes while Steve is open. Sign-in is never opened in the background.</small></span></label>
        <Button disabled={busy||!copies.length} onClick={()=>void run('refresh',{workspace:state.workspace})}><RefreshCw size={15}/>Refresh downloaded projects</Button>
        {copies.map(c=><div className={styles.studioProject} key={c.remote_id}>
          <span><strong>{c.name}</strong><small>Studio revision {c.revision} · {c.status}</small></span>
          <Button disabled={busy} onClick={()=>{set({dialog:null});openTab({id:c.local_id});}}><FolderOpen size={15}/>Open locally</Button>
          <Button disabled={busy} onClick={()=>void run('unlink',{workspace:state.workspace,project:c.remote_id})}>Stop syncing</Button>
        </div>)}
        {!copies.length&&<p className={styles.note}>Downloaded projects will appear here and in your local document browser.</p>}
      </Section>
  </div>;
}

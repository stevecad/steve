import { useEffect,useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/ui';
import { Card,SettingsPage } from '../ui';
import { settingsSections } from '../registry';
import styles from './LocalAgentSettings.module.css';
type State={available:boolean;repositories:{id:string;url:string;branch:string;path:string;message:string}[]};
export default function LocalGitSettings(){
 const [username,setUsername]=useState('oauth2');
 const [state,setState]=useState<State|null>(null),[url,setUrl]=useState(''),[branch,setBranch]=useState('main'),[token,setToken]=useState(''),[message,setMessage]=useState('Update CAD source'),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{void api<State>('/v1/local/git').then(setState).catch(e=>setError(e.message));},[]);
 const run=async(path:string,body:unknown)=>{setBusy(true);setError('');try{setState(await api<State>('/v1/local/git/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));setToken('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 return <SettingsPage section={settingsSections().find(x=>x.id==='local-git')!}>
 {error&&<p role="alert" className={styles.error}>{error}</p>}
 <Card title="Connect a repository" description="GitHub, GitLab, Bitbucket, Azure DevOps or another HTTPS Git host. Uses local Git and its credential manager, or an encrypted access token.">
 {!state?.available&&<p className={styles.error}>Install Git before connecting a repository.</p>}
 <div className={styles.form}><label className={styles.field}>Repository URL<input className={styles.input} value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://github.com/your-team/cad.git"/></label>
 <label className={styles.field}>Branch<input className={styles.input} value={branch} onChange={e=>setBranch(e.target.value)}/></label>
 <label className={styles.field}>Token username<input className={styles.input} value={username} onChange={e=>setUsername(e.target.value)}/></label>
 <label className={styles.field}>Access token (optional)<input className={styles.input} type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>
 <Button disabled={busy||!state?.available||!url} variant="primary" onClick={()=>void run('connect',{url,branch,token,username})}>{busy?'Working…':'Connect'}</Button></div></Card>
 <Card title="Source transfer" description="Saved CAD documents use Studio’s main.py, supporting files and steve.json layout. Pull fetches source; Import creates local copies. STEP assets stay in the project archive.">
 <label className={styles.field}>Commit message<input className={styles.input} value={message} onChange={e=>setMessage(e.target.value)}/></label>
 {!state?.repositories.length&&<p className={styles.note}>No repositories connected.</p>}
 {state?.repositories.map(repo=><div className={styles.server} key={repo.id}><h3>{repo.url}</h3><p className={styles.note}>{repo.branch} · {repo.path}</p>
 <div className={styles.actions}>{[['status','Refresh status'],['pull','Pull source'],['import','Import as copies'],['push','Commit & push saved workspace'],['disconnect','Disconnect']].map(([action,label])=><Button key={action} disabled={busy} onClick={()=>void run(repo.id+'/'+action,{message})}>{label}</Button>)}</div><pre className={styles.result}>{repo.message}</pre></div>)}
 </Card></SettingsPage>;
}

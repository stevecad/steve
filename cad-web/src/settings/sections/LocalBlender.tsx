import {useEffect, useState} from 'react';
import {api} from '@/lib/api';
import {set} from '@/state/store';
import {Button} from '@/ui';
import {Card, SettingsPage} from '../ui';
import {settingsSections} from '../registry';
import styles from './LocalAgentSettings.module.css';

type Status = {installed:boolean;runtime:{path:string;version:string}|null;busy:boolean;message:string;error:string};

export default function LocalBlender() {
  const [state, update] = useState<Status|null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const accept = (value:Status) => {update(value);set({blenderInstalled:value.installed});};
  useEffect(() => {
    let active=true;
    void api<Status>('/v1/local/blender').then(value=>{if(active){accept(value);setPath(value.runtime?.path||'');}}).catch(e=>{if(active)setError(e.message);});
    return()=>{active=false;};
  }, []);
  useEffect(() => {
    if(!state?.busy)return;
    const timer=setInterval(()=>void api<Status>('/v1/local/blender').then(accept).catch(e=>setError(e.message)),1000);
    return()=>clearInterval(timer);
  }, [state?.busy]);
  const run=async(action:string,body:object={})=>{
    setSending(true);setError('');
    try {accept(await api<Status>('/v1/local/blender/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}));}
    catch(e){setError((e as Error).message);}
    finally{setSending(false);}
  };
  return <SettingsPage section={settingsSections().find(section=>section.id==='local-blender')!}>
    <Card title="Local Blender" description="Build scenes, render images and animations, and work with your CAD models on this computer. No Studio server is needed.">
      <p role="status">{state?.installed?`Blender ${state.runtime?.version} is available.`:'Blender is not configured.'}</p>
      <p className={styles.note}>{state?.message}</p>
      {(error||state?.error)&&<p role="alert" className={styles.error}>{error||state?.error}</p>}
      <div className={styles.actions}>
        <Button variant="primary" disabled={sending||state?.busy} onClick={()=>void run('install')}>{state?.installed?'Install managed Blender 4.5 LTS':'Install Blender 4.5 LTS'}</Button>
        {state?.busy&&<Button disabled={sending} onClick={()=>void run('cancel-install')}>Cancel installation</Button>}
      </div>
      <p className={styles.note}>Downloads a verified official Blender package into Steve’s local application data. Your other Blender installations and preferences are unchanged. Windows and Linux are supported.</p>
    </Card>
    <Card title="Use an existing installation" description="Choose a Blender 4.5 LTS executable. Scenes use the same Blender runtime scripts and millimetre units as Studio.">
      <label className={styles.field}>Blender executable<input className={styles.input} value={path} onChange={event=>setPath(event.target.value)} placeholder="Full path to blender.exe or blender"/></label>
      <Button disabled={sending||state?.busy||!path.trim()} onClick={()=>void run('configure',{path:path.trim()})}>Use this Blender</Button>
      <p className={styles.note} style={{overflowWrap:'anywhere'}}>{state?.runtime?.path}</p>
    </Card>
  </SettingsPage>;
}

import {useEffect,useState} from 'react';
import {api} from '@/lib/api';
import {Button,Switch} from '@/ui';
import {Card,Row,SettingsPage} from '../ui';
import {settingsSections} from '../registry';
import styles from './LocalAgentSettings.module.css';
// Updates come only from dl.stevecad.studio, signed by the keys built into Steve. There is no setting to change the
// feed or the keys: a box anyone can paste a feed and key into invites "support" scams that would install their code.
type State={version:string;source:string;automatic:boolean;busy:boolean;message:string;ready:boolean;can_apply:boolean;supports_updates:boolean;download_url:string};
const downloading=(message:string)=>/^(Downloading|Preparing) /.test(message);
export default function LocalUpdateSettings(){
 const [state,setState]=useState<State|null>(null),[automatic,setAutomatic]=useState(true),[busy,setBusy]=useState(false),[restarting,setRestarting]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;void api<State>('/v1/local/updates').then(s=>{if(!active)return;setState(s);setAutomatic(s.automatic);}).catch(e=>setError(e.message));const timer=setInterval(()=>{void api<State>('/v1/local/updates').then(s=>{if(active)setState(s);}).catch(()=>{});},2000);return()=>{active=false;clearInterval(timer);};},[]);
 const check=async()=>{setBusy(true);setError('');try{setState(await api<State>('/v1/local/updates/check',{method:'POST'}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
 // Steve closes through its normal close (a running request finishes first), installs, then opens again. If it
 // stays open (a request is still finishing), the button comes back so the person can ask again.
 const restart=async()=>{setRestarting(true);setError('');try{setState(await api<State>('/v1/local/updates/restart',{method:'POST'}));setTimeout(()=>setRestarting(false),10000);}catch(e){setRestarting(false);setError((e as Error).message);}};
 const working=busy||!!state?.busy;
 return <SettingsPage section={settingsSections().find(x=>x.id==='local-updates')!}>
 {error&&<p role="alert" className={styles.error}>{error}</p>}
 <Card title="Updates" description={`Steve ${state?.version??''}. ${state?.supports_updates?'Signed updates download in the background and install after you close the application.':'Download a new release to update Steve.'}`}>
 {state?.supports_updates&&<>
 <Row label="Keep Steve updated" hint="On by default. Steve downloads verified updates automatically and installs them when you close it."><Switch label="Automatic updates" checked={automatic} onCheckedChange={value=>{setAutomatic(value);void api<State>('/v1/local/updates',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({automatic:value})}).then(setState).catch(e=>{setAutomatic(!value);setError(e.message);});}}/></Row>
 <p className={styles.note} role="status">{state?.message}</p><div className={styles.actions}>{state?.ready&&state.can_apply&&<Button variant="primary" disabled={restarting} onClick={()=>void restart()}>{restarting?'Restarting…':'Restart and update'}</Button>}
 {!state?.ready&&<Button disabled={working||!state?.source} onClick={()=>void check()}>{working?(downloading(state?.message??'')?'Downloading update…':'Checking for updates…'):'Check for updates'}</Button>}
 {state?.ready&&state.can_apply&&!automatic&&<Button onClick={()=>{void api<State>('/v1/local/updates/install',{method:'POST'}).then(setState).catch(e=>setError(e.message));}}>Install on next exit</Button>}</div>
 {!state?.can_apply&&<p className={styles.note}>Automatic installation is available in packaged Steve.</p>}
 </>}
 {state&&!state.supports_updates&&<><p className={styles.note}>{state.message}</p><a href={state.download_url} target="_blank" rel="noreferrer">Download the latest release</a></>}
 </Card></SettingsPage>;
}

import {useEffect,useState} from 'react';
import {Download,TriangleAlert} from 'lucide-react';
import {api} from '@/lib/api';
import {openSettings} from '@/settings/registry';
import styles from './UpdateNotice.module.css';

type Status={ready:boolean;busy:boolean;message:string;update_error:boolean;can_apply:boolean};
export default function UpdateNotice(){
 const [status,setStatus]=useState<Status|null>(null),[restarting,setRestarting]=useState(false),[error,setError]=useState('');
 useEffect(()=>{let active=true;const refresh=()=>void api<Status>('/v1/local/updates').then(value=>{if(active)setStatus(value);}).catch(()=>{});
 refresh();const timer=setInterval(refresh,3000);return()=>{active=false;clearInterval(timer);};},[]);
 if(!status||(!status.ready&&!status.busy&&!status.update_error))return null;
 const Icon=status.update_error?TriangleAlert:Download;
 const restart=()=>{setRestarting(true);setError('');void api<Status>('/v1/local/updates/restart',{method:'POST'}).then(value=>{setStatus(value);setTimeout(()=>setRestarting(false),10000);}).catch(e=>{setRestarting(false);setError((e as Error).message);});};
 return <div className={styles.notice} role="status" data-update-notice>
  <Icon size={16}/><span>{error||(status.busy?'Checking and downloading Steve updates…':status.message)}</span>
  {status.ready&&status.can_apply&&<button className={styles.primary} disabled={restarting} onClick={restart}>{restarting?'Restarting…':'Restart and update'}</button>}
  <button onClick={()=>openSettings('local-updates')}>Update details</button>
 </div>;
}

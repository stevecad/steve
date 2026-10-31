import {Cloud, FolderOpen, LogIn, LogOut, X} from 'lucide-react';
import {MenuItem, MenuLabel, MenuSeparator} from '@/ui';
import {openStudioProjects, studioAction, useStudio} from './studio';
import styles from './StudioProjects.module.css';

export default function StudioAccountItems(){
 const state=useStudio(s=>s.state);const sending=useStudio(s=>s.sending);const error=useStudio(s=>s.error);
 const busy=!!state?.busy||sending;
 return <>
  <MenuSeparator/><MenuLabel>Steve Studio</MenuLabel>
  <p className={styles.accountStatus} role="status">{error||state?.error||(!state?'Checking Studio connection…':busy?state.message:state.connected?'Connected to Steve Studio':'Not connected to Steve Studio')||'Checking Studio connection…'}</p>
  {state?.profile_consent_required&&<p className={styles.accountStatus}>Reconnect once to share your name, verified email and picture with Steve. Your local projects stay here.</p>}
  <MenuItem icon={<FolderOpen size={14}/>} onSelect={openStudioProjects}>Studio projects…</MenuItem>
  <MenuItem icon={state?.connected?<Cloud size={14}/>:<LogIn size={14}/>} disabled={busy||!state} onSelect={()=>void studioAction('connect')}>{state?.connected?'Reconnect to Steve Studio':'Sign in to Steve Studio'}</MenuItem>
  {state?.connected&&<MenuItem icon={<LogOut size={14}/>} disabled={busy} onSelect={()=>void studioAction('disconnect')}>Disconnect from Steve Studio</MenuItem>}
  {busy&&<MenuItem icon={<X size={14}/>} onSelect={()=>void studioAction('cancel')}>Cancel Studio operation</MenuItem>}
  {state?.connected&&<p className={styles.accountStatus}>Disconnecting keeps your downloaded projects on this machine.</p>}
 </>;
}

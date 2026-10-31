import {useEffect} from 'react';
import {create} from 'zustand';
import {api} from '@/lib/api';
import {set, toast} from '@/state/store';

export type StudioState = {
 profile_consent_required?:boolean;
 account?:{id:string;name?:string;email?:string;avatar_url?:string}|null;
 connected:boolean; busy:boolean; automatic:boolean; message:string; error:string; workspace:string;
 workspaces:{id:string;name:string;allowed:boolean;kind:string}[];
 projects:{id:string;name:string;revision:number;kind:string;state:string;folder:{path:string}|null}[];
 copies:{remote_id:string;name:string;local_id:string;revision:number;status:string;identity:string[]}[];
};
export const useStudio = create<{state:StudioState|null;error:string;sending:boolean;accountMenuOpen:boolean;accountAfterBrowser:boolean;source:'local'|'studio'}>(()=>({state:null,error:'',sending:false,accountMenuOpen:false,accountAfterBrowser:false,source:'local'}));
let refresh:Promise<void>|null=null;let generation=0;
export function refreshStudio():Promise<void> {
 if(refresh)return refresh;
 if(useStudio.getState().sending)return Promise.resolve();
 const requestGeneration=generation;
 refresh=api<StudioState>('/v1/local/studio').then(state=>{
  if(requestGeneration!==generation)return;
  const previous=useStudio.getState().state;
  useStudio.setState({state,error:''});
  if(previous?.busy&&!state.busy)toast(state.error?'warning':'success',state.error?'Studio connection needs attention':'Steve Studio',state.error||state.message);
 }).catch((e:Error)=>{if(requestGeneration===generation)useStudio.setState({error:e.message});}).finally(()=>{refresh=null;});
 return refresh;
}
let observers=0;let timer:ReturnType<typeof setInterval>|undefined;
export function useStudioStatus() {
 const state=useStudio(s=>s.state);
 useEffect(()=>{
  void refreshStudio();
  if(observers++===0)timer=setInterval(()=>{if(useStudio.getState().state?.busy)void refreshStudio();},1500);
  return()=>{if(--observers===0){clearInterval(timer);timer=undefined;}};
 },[]);
 return state;
}
export async function studioAction(action:string,body:object={}) {
 if(useStudio.getState().sending)return;
 generation++;
 const previous=useStudio.getState().state;
 const enabled=(body as {enabled?:boolean}).enabled;
 const optimistic=action==='automatic'&&previous&&typeof enabled==='boolean';
 useStudio.setState({sending:true,error:'',...(optimistic?{state:{...previous,automatic:enabled}}:{})});
 try {
  const state=await api<StudioState>('/v1/local/studio/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  useStudio.setState({state});
  if(action==='connect')toast('info','Studio sign-in','Complete sign-in in your browser.');
 } catch(e) {const message=(e as Error).message;useStudio.setState({error:message,...(optimistic?{state:previous}:{})});toast('warning','Steve Studio',message);}
 finally {useStudio.setState({sending:false});}
}
export function openStudioProjects(){useStudio.setState({source:'studio',accountMenuOpen:false});set({dialog:'open'});}
export function openStudioAccount(){useStudio.setState({accountAfterBrowser:true});set({dialog:null});}
export function finishStudioBrowserExit(){if(useStudio.getState().accountAfterBrowser){useStudio.setState({accountAfterBrowser:false});window.requestAnimationFrame(()=>useStudio.setState({accountMenuOpen:true}));}}

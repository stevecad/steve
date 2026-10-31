import {stored} from '@/state/design';
import {useEffect, useRef, useState} from 'react';
import {Camera, Download, Play, Square} from 'lucide-react';
import {api, type Build} from '@/lib/api';
import {get, set} from '@/state/store';
import {Button, Dialog} from '@/ui';
import styles from './BlenderRenders.module.css';

export default function BlenderRenders({open}:{open:boolean}) {
  const [job, setJob] = useState<Build|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('isometric');
  const active = useRef<string|null>(null);
  const cancelled = useRef(false);
  useEffect(()=>{if(open&&!active.current){setJob(null);setError('');}},[open]);
  const stop = () => {cancelled.current=true;if(active.current)void api(`/v1/builds/${active.current}/cancel`,{method:'POST'}).catch(e=>setError(e.message));};
  const render = async(camera:boolean) => {
    const doc=get().doc;
    const source=stored(doc);
    cancelled.current=false;setBusy(true);setError('');setJob(null);setView(camera?'camera':'isometric');
    try {
      let result=await api<Build>('/v1/builds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:doc.name,kind:'blender',code:source.code,files:source.files,links:doc.links,mode:camera?'render':'full',...(camera?{look:{view:'camera',shading:'rendered'}}:{})})});
      active.current=result.id;
      if(cancelled.current)stop();
      setJob(result);
      while(result.status==='queued'||result.status==='running') {
        await new Promise(resolve=>setTimeout(resolve,500));
        result=await api<Build>(`/v1/builds/${result.id}`);
        setJob(result);
      }
      if(result.status!=='succeeded')throw new Error(result.error||'Render failed.');
    } catch(e) {stop();setError((e as Error).message);}
    finally {active.current=null;setBusy(false);}
  };
  const artifacts=(job?.artifacts||{}) as Record<string,string>;
  const image=artifacts['view_'+view];
  return <Dialog open={open} onOpenChange={value=>{if(!value){stop();set({dialog:null});}}} title="Blender renders" description="Render the current scene locally. Camera, lighting, materials and animation come from your scene source. Video is generated when the scene has both a camera and animation." icon={<Camera size={20}/>} width={1000}>
    <div className={styles.panel}>
      <div className={styles.actions}>
        <Button variant="primary" disabled={busy} onClick={()=>void render(true)}><Camera size={15}/>Render camera</Button>
        <Button disabled={busy} onClick={()=>void render(false)}><Play size={15}/>Render inspection views & animation</Button>
        {busy&&<Button onClick={stop}><Square size={14}/>Stop rendering</Button>}
      </div>
      <p role="status">{busy?`Rendering locally · ${job?.metadata?.progress?.stage||'starting'}`:job?.status==='succeeded'?'Render complete.':'Choose a render. The camera view requires a camera in your scene.'}</p>
      {error&&<p role="alert" className={styles.error}>{error}</p>}
      {job?.status==='succeeded'&&<>
        <div className={styles.actions}>{['camera','isometric','top','front','right'].filter(name=>artifacts['view_'+name]).map(name=><Button key={name} variant={name===view?'primary':'secondary'} onClick={()=>setView(name)}>{name}</Button>)}</div>
        {image&&<img className={styles.image} src={image} alt={`Rendered ${view} view`}/>}
        <div className={styles.actions}>
          {image&&<a href={image} download={`scene-${view}.png`}><Download size={14}/>Save PNG</a>}
          {artifacts.blend&&<a href={artifacts.blend} download="scene.blend">Save Blender file</a>}
          {artifacts.animation&&<a href={artifacts.animation} download="animation.mp4">Save animation</a>}
        </div>
        {artifacts.animation&&<video className={styles.image} src={artifacts.animation} controls preload="metadata"/>}
      </>}
    </div>
  </Dialog>;
}

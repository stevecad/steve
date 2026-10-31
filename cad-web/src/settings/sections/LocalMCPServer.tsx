import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/ui';
import { copyText } from '@/lib/clipboard';
import { Card } from '../ui';
import styles from './LocalAgentSettings.module.css';

type Status = {running:boolean;tools:number;configuration:{mcpServers:{steve:{command:string;args:string[]}}}};
export default function LocalMCPServer(){
  const [status,setStatus]=useState<Status|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [copied,setCopied]=useState('');
  const copy=async(label:string,text:string)=>{
    setError('');
    if(await copyText(text)) { setCopied(label); window.setTimeout(()=>setCopied(current=>current===label?'':current),1500); }
    else setError('Could not copy automatically. Select the text and press Ctrl+C.');
  };
  const connection=status?.configuration.mcpServers.steve;
  const valueRow=(label:string,value:string)=><div className={styles.connectionRow} key={label}>
    <label className={styles.field}><span>{label}</span><input className={styles.input} aria-label={label} readOnly value={value} spellCheck={false}/></label>
    <Button aria-label={'Copy '+label.toLowerCase()} onClick={()=>void copy(label,value)}>{copied===label?'Copied':'Copy'}</Button>
  </div>;
  useEffect(()=>{void api<Status>('/v1/local/mcp-server').then(setStatus).catch(e=>setError(e.message));},[]);
  const toggle=async()=>{setBusy(true);setError('');try{setStatus(await api<Status>('/v1/local/mcp-server/'+(status?.running?'stop':'start'),{method:'POST'}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <Card title="Steve MCP server" description="Let another assistant build, inspect and export the CAD document open here.">
    <p className={styles.note}>{status?.running?`Running Â· ${status.tools} CAD tools`:'Stopped'}. The client connects over local stdio. Steve must remain open.</p>
    <div className={styles.actions}><Button disabled={busy||!status} variant={status?.running?'secondary':'primary'} onClick={()=>void toggle()}>{status?.running?'Stop server':'Start server'}</Button>
      <Button disabled={!status} onClick={()=>status&&void copy('configuration',JSON.stringify(status.configuration,null,2))}>{copied==='configuration'?'Copied':'Copy client configuration'}</Button></div>
    {connection&&<div className={styles.connectionDetails}>
      {valueRow('Name','Steve')}
      <p className={styles.note}>Choose STDIO in your client. Paste the command below, then add each argument as a separate entry. No environment variables or working directory are required.</p>
      {valueRow('Command to launch',connection.command)}
      {connection.args.map((argument,index)=>valueRow(`Argument ${index+1}`,argument))}
    </div>}
    {status&&<pre tabIndex={0} aria-label="MCP client configuration" className={`${styles.result} ${styles.selectable}`}>{JSON.stringify(status.configuration,null,2)}</pre>}
    <p className={styles.note}>Start allows connected local clients to modify CAD. Stop revokes access and cancels active MCP jobs. Access is off again when Steve restarts.</p>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
  </Card>;
}

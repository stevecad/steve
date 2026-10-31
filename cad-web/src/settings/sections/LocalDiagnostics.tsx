import { useEffect, useState } from 'react';
import { RefreshCw, Copy } from 'lucide-react';
import { Button } from '@/ui';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { Card } from '../ui';
import styles from './LocalDiagnostics.module.css';

type Entry = { id: string; time: string; operation: string; errors: { type: string; message: string; frames: {file: string; line: number; function: string}[] }[] };
type Log = { path: string; entries: Entry[] };
export default function LocalDiagnostics() {
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = async () => {
    setBusy(true); setError('');
    try { setLog(await api<Log>('/v1/assistant/diagnostics')); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const copy = async () => {
    try { if (!await copyText(JSON.stringify(log?.entries, null, 2))) throw new Error('Copy failed'); setCopied(true); }
    catch { setError('Clipboard access failed. Select the diagnostic text to copy it.'); }
  };
  return <Card id="local-diagnostics" title="Diagnostics" description="Recent assistant, account and MCP failures, saved encrypted on this device. Includes error details and stack locations; excludes request bodies and frame variables. Review before sharing.">
    <div className={styles.actions}>
      <Button icon={<RefreshCw />} disabled={busy} onClick={() => void load()}>Refresh</Button>
      <Button icon={<Copy />} disabled={!log?.entries.length} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy diagnostics'}</Button>
      <span>{log ? `${log.entries.length} recent ${log.entries.length === 1 ? 'failure' : 'failures'}` : 'Loading…'}</span>
    </div>
    {error && <p role="alert">{error}</p>}
    {log && !log.entries.length && <p className={styles.empty}>No failures recorded yet.</p>}
    <div className={styles.entries}>{log?.entries.map(entry => <details key={entry.id}>
      <summary><strong>{entry.operation}</strong><span>{new Date(entry.time).toLocaleString()}</span><code>{entry.id}</code></summary>
      {entry.errors.map((item, i) => <div key={i} className={styles.detail}><strong>{item.type}</strong><pre>{item.message}</pre><pre>{item.frames.map(f => `${f.file}:${f.line} · ${f.function}`).join('\n')}</pre></div>)}
    </details>)}</div>
    {log && <p className={styles.path}>Encrypted log · {log.path}</p>}
  </Card>;
}

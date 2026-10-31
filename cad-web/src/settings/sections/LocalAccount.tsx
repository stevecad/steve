import { useEffect, useState } from 'react';
import { LogIn, LogOut, RefreshCw } from 'lucide-react';
import { Button, Spinner } from '@/ui';
import { Card } from '../ui';
import { api } from '@/lib/api';
import { assistantConfig } from '@/panels/steve';
import styles from './LocalAccount.module.css';

type Account = { connected: boolean; busy: boolean; agent_busy: boolean; action: string | null; message: string;
  models: { id: string; label: string }[] };
export default function LocalAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const value = await api<Account>('/v1/assistant/account');
        if (!closed) { setAccount(value); setError(''); }
      } catch (caught) { if (!closed) setError((caught as Error).message); }
      if (!closed) timer = setTimeout(() => void load(), 800);
    };
    void load();
    return () => { closed = true; clearTimeout(timer); void assistantConfig(true).catch(() => undefined); };
  }, []);
  const act = async (action: string) => {
    setSending(true); setError('');
    try { setAccount(await api<Account>(`/v1/assistant/account/${action}`, { method: 'POST' })); }
    catch (caught) { setError((caught as Error).message); }
    finally { setSending(false); }
  };
  const locked = sending || !!account?.busy || !!account?.agent_busy;
  return <Card title="ChatGPT account" id="local-openai-account" description="Use your ChatGPT subscription with Steve. Sign-in opens the OpenAI authorization page in your browser.">
    <div className={styles.status} role="status">
      <span className={styles.dot} data-connected={account?.connected || undefined} />
      <strong>{account?.busy ? (account.action === 'login' ? 'Waiting for browser sign-in' : 'Updating account') : account?.connected ? 'Connected' : 'Not connected'}</strong>
      {(account?.busy || sending || !account) && !error && <Spinner size={14} />}
    </div>
    {account?.message && <p className={styles.note}>{account.message}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}>
      <Button variant="primary" icon={<LogIn />} disabled={locked || !account} onClick={() => void act('login')}>{account?.connected ? 'Reconnect' : 'Sign in with ChatGPT'}</Button>
      <Button icon={<RefreshCw />} disabled={locked || !account?.connected} onClick={() => void act('models')}>Refresh models</Button>
      {account?.busy && <Button disabled={sending} onClick={() => void act('cancel')}>Cancel</Button>}
      {account?.connected && <Button icon={<LogOut />} disabled={locked} onClick={() => void act('logout')}>Sign out</Button>}
    </div>
    {!!account?.models.length && <details className={styles.models}>
      <summary>{account.models.length} available models</summary>
      <ul>{account.models.map(model => <li key={model.id}><span>{model.label}</span><code>{model.id}</code></li>)}</ul>
    </details>}
    <p className={styles.note}>Credentials stay in this device’s encrypted credential store. Sign-out removes the local session.</p>
  </Card>;
}

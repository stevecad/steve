/** The right pane's History tab: STEVE's past conversations; opening one shows it in the STEVE tab. */
import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { Api } from '@/lib/api';
import { set } from '@/state/store';
import Conversations from './Conversations';
import { CONVERSATION_KEY, drafts, store, stored, useSteve } from './steve';
import styles from './Assistant.module.css';
import own from './Steve.module.css';

export default function SteveHistory() {
  const [current, setCurrent] = useState(() => stored(CONVERSATION_KEY) ?? undefined);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  // Switching away from a conversation STEVE is still answering waits for it, as in the chat.
  useEffect(() => {
    let cancelled = false;
    if (current) Api.conversation(current).then((value) => { if (!cancelled) setBusy(!!value.busy); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [current]);
  const open = async (id?: string) => {
    if (opening) return;
    setOpening(true); setError('');
    try {
      useSteve.setState({ opening: id ? await Api.conversation(id) : 'new' });
      set({ dockTab: 'assistant' });
    } catch (caught) { setError((caught as Error).message); }
    finally { setOpening(false); }
  };
  // A deleted conversation's draft goes too; deleting the open one leaves the STEVE tab on a new chat.
  const deleted = (ids: string[]) => {
    for (const id of ids) drafts.delete(id);
    if (current && ids.includes(current)) {
      store(CONVERSATION_KEY, null);
      setCurrent(undefined);
      setBusy(false);
    }
  };
  return (
    <div className={styles.panel} id="steve-history">
      <div className={own.head}>
        <b>Conversations</b>
        <button type="button" className={styles.textButton} disabled={busy} onClick={() => void open()} id="history-new-chat"><Plus size={14} />New chat</button>
      </div>
      {busy && <p className={own.note} role="status">STEVE is still answering in the open conversation. You can switch when it finishes.</p>}
      {error && <p className={styles.error} id="history-error" role="alert">{error}</p>}
      <Conversations active={current} disabled={busy || opening} onSelect={(id) => void open(id)} onDeleted={deleted} />
    </div>
  );
}

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { CheckSquare, MessageSquare, Trash2 } from 'lucide-react';
import { Api, type ConversationSummary } from '@/lib/api';
import { Button, ContextMenu, ContextItem, Dialog } from '@/ui';
import CopyMessage from '@/shell/CopyMessage';
import styles from './Assistant.module.css';
import own from './Steve.module.css';

const BUSY = 'STEVE is working in this conversation. Stop it first.';
const DAY = 24 * 60 * 60 * 1000;

/** STEVE's past conversations: search, open, delete one, or select several and delete them together. */
export default function Conversations({ active, disabled, onSelect, onDeleted }: {
  active?: string; disabled: boolean; onSelect: (id: string) => void; onDeleted?: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<ConversationSummary[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [bulk, setBulk] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [note, setNote] = useState('');
  const epoch = useRef(0);
  const fetchRows = async (query: string, offset: number, version: number) => {
    setLoading(true); setError('');
    try {
      const result = await Api.conversations(query, offset);
      if (epoch.current !== version) return;
      setRows((old) => offset ? [...old, ...result.conversations.filter((row) => !old.some((item) => item.conversation_id === row.conversation_id))] : result.conversations);
      setMore(result.has_more);
    } catch (caught) { if (epoch.current === version) setError((caught as Error).message); }
    finally { if (epoch.current === version) setLoading(false); }
  };
  useEffect(() => {
    const version = ++epoch.current;
    setRows([]); setMore(false); setLoading(true);
    const timer = setTimeout(() => void fetchRows(search, 0, version), 200);
    return () => { clearTimeout(timer); epoch.current++; };
  }, [search]);

  const deletable = rows.filter((row) => !row.busy);
  const toggle = (id: string, event?: MouseEvent) => {
    setSelected((old) => {
      const next = new Set(old);
      if (event?.shiftKey && anchor) {
        // Shift-click selects the range from the last clicked row.
        const ids = rows.map((row) => row.conversation_id);
        const [from, to] = [ids.indexOf(anchor), ids.indexOf(id)].sort((a, b) => a - b);
        for (const row of rows.slice(from, to + 1)) if (!row.busy) next.add(row.conversation_id);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setAnchor(id);
  };
  const startSelecting = (id?: string) => { setSelecting(true); setConfirming(null); setSelected(new Set(id ? [id] : [])); setAnchor(id ?? null); };
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()); setAnchor(null); };

  /** Removes the rows at once and puts back any the server didn't delete. */
  const remove = async (ids: string[]) => {
    if (!ids.length) return;
    const before = rows;
    setDeleting(true); setError(''); setNote('');
    setRows((old) => old.filter((row) => !ids.includes(row.conversation_id)));
    try {
      const result = ids.length === 1
        ? await Api.deleteConversation(ids[0]).then(() => ({ deleted: ids, skipped: [] as { id: string; reason: string }[] }))
        : await Api.deleteConversations(ids);
      if (result.skipped.length) {
        const kept = new Set(result.skipped.map((item) => item.id));
        setRows(before.filter((row) => !result.deleted.includes(row.conversation_id)));
        setNote(`${result.skipped.length} not deleted: ${[...new Set(result.skipped.map((item) => item.reason))].join(' ')}`);
        setSelected((old) => new Set([...old].filter((id) => kept.has(id))));
      } else setSelected(new Set());
      if (result.deleted.length) onDeleted?.(result.deleted);
    } catch (caught) {
      setRows(before);
      setError((caught as Error).message);
    } finally {
      setDeleting(false);
      setConfirming(null);
      setBulk(false);
    }
  };
  const olderThan30Days = () => {
    const cutoff = Date.now() - 30 * DAY;
    setSelected(new Set(deletable.filter((row) => new Date(row.updated_at).getTime() < cutoff).map((row) => row.conversation_id)));
  };

  return <div className={styles.history}>
    <label className="sr-only" htmlFor="conversation-search">Search conversations</label>
    <input id="conversation-search" className={styles.search} placeholder="Search conversations…" maxLength={100} value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className={own.selectBar} data-selecting={selecting || undefined}>
      {!selecting ? <button type="button" className={styles.textButton} id="history-select" disabled={!deletable.length} onClick={() => startSelecting()}><CheckSquare size={13} />Select</button> : <>
        <span className={own.count} id="history-selected-count">{selected.size} selected</span>
        <button type="button" className={styles.textButton} id="history-select-all" onClick={() => setSelected(new Set(deletable.map((row) => row.conversation_id)))}>All</button>
        <button type="button" className={styles.textButton} id="history-select-none" onClick={() => setSelected(new Set())}>None</button>
        <button type="button" className={styles.textButton} id="history-select-old" title={more ? 'Among the conversations loaded so far: load more to include older ones.' : undefined} onClick={olderThan30Days}>Older than 30 days</button>
        <span className={own.spacer} />
        <Button size="sm" variant="danger" icon={<Trash2 />} id="history-delete-selected" disabled={!selected.size || deleting} onClick={() => setBulk(true)}>Delete {selected.size || ''}</Button>
        <button type="button" className={styles.textButton} id="history-select-done" onClick={stopSelecting}>Done</button>
      </>}
    </div>
    {note && <p className={own.note} role="status" id="history-delete-note">{note}</p>}
    <div className={styles.historyList} aria-busy={loading}>
      {rows.map((row) => {
        const id = row.conversation_id;
        const checked = selected.has(id);
        if (confirming === id) return <div key={id} className={own.confirmRow} data-conversation-id={id} role="alertdialog" aria-label={`Delete ${row.title}?`}>
          <span>Delete <strong>{row.title}</strong>? Its messages, images and usage records go too. This can’t be undone.</span>
          <span className={own.confirmButtons}>
            <Button size="sm" onClick={() => setConfirming(null)}>Cancel</Button>
            <Button size="sm" variant="danger" id="history-confirm-delete" disabled={deleting} onClick={() => void remove([id])}>Delete</Button>
          </span>
        </div>;
        return <ContextMenu key={id} trigger={
          <div className={own.historyItem} data-conversation-id={id} data-busy={row.busy || undefined} data-selected={checked || undefined}>
            {selecting && <input type="checkbox" className={own.check} aria-label={`Select ${row.title}`} checked={checked} disabled={row.busy}
              title={row.busy ? BUSY : undefined} onChange={() => undefined} onClick={(event) => toggle(id, event)} />}
            <button type="button" className={styles.historyRow} disabled={!selecting && disabled}
              aria-current={active === id ? 'true' : undefined}
              onClick={(event) => (selecting ? !row.busy && toggle(id, event) : onSelect(id))}>
              <strong>{row.title}</strong>
              <span>{row.preview || 'No messages yet'}</span>
              <small>{new Date(row.updated_at).toLocaleString()} · {row.turn_count} {row.turn_count === 1 ? 'exchange' : 'exchanges'}{row.busy ? ' · Working' : ''}</small>
            </button>
            {!selecting && !row.busy && <button type="button" className={own.trash} data-delete-conversation={id} aria-label={`Delete ${row.title}`} title="Delete"
              onClick={() => setConfirming(id)}><Trash2 size={14} /></button>}
          </div>
        }>
          <ContextItem icon={<MessageSquare size={15} />} disabled={disabled} onSelect={() => onSelect(id)}>Open</ContextItem>
          <ContextItem icon={<CheckSquare size={15} />} disabled={row.busy} onSelect={() => startSelecting(id)}>Select</ContextItem>
          <ContextItem icon={<Trash2 size={15} />} danger disabled={row.busy} reason={row.busy ? BUSY : undefined} onSelect={() => setConfirming(id)}>Delete…</ContextItem>
        </ContextMenu>;
      })}
      {loading && <p className={styles.historyHint} role="status">Loading conversations…</p>}
      {!loading && !rows.length && !error && <p className={styles.historyHint}>{search ? 'No matching conversations.' : 'Your conversations will appear here.'}</p>}
      {error && <div className={styles.error} role="alert" id="history-delete-error" style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ flex: 1 }}>{error} <button type="button" onClick={() => void fetchRows(search, rows.length, epoch.current)}>Retry</button></span><CopyMessage text={error} />
      </div>}
      {more && !loading && <button type="button" className={styles.textButton} onClick={() => void fetchRows(search, rows.length, epoch.current)}>Load more</button>}
    </div>
    <Dialog open={bulk} onOpenChange={(open) => { if (!open && !deleting) setBulk(false); }} icon={<Trash2 size={18} />}
      title={`Delete ${selected.size} conversation${selected.size === 1 ? '' : 's'}?`}
      description="They’re deleted for good, with their messages, images and the usage recorded for them (Settings → Usage totals go down too). Conversations STEVE is working in are skipped."
      footer={<>
        <span style={{ flex: 1 }} />
        <Button size="sm" disabled={deleting} onClick={() => setBulk(false)}>Cancel</Button>
        <Button size="sm" variant="danger" id="history-confirm-bulk" disabled={deleting} onClick={() => void remove([...selected])}>{deleting ? 'Deleting…' : `Delete ${selected.size}`}</Button>
      </>} />
  </div>;
}

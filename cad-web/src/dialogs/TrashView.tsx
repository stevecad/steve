import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu } from 'radix-ui';
import { AlertTriangle, ArchiveRestore, ArrowLeft, Link2, MoreHorizontal, RefreshCw, Trash2, X } from 'lucide-react';
import {
  Button, ContextContent, ContextItem, ContextRoot, ContextSeparator, ContextTrigger, Dialog, IconButton, MenuItem, MenuSeparator, Spinner, ui,
} from '@/ui';
import { relativeTime } from '@/lib/format';
import { kindLabel } from '@/lib/library';
import { Trash, type Skipped, type TrashedDocument } from '@/lib/trash';
import { deleteForever, onTrashChange, restoreFromTrash } from '@/state/trash';
import { count, ease, exactTime, KindIcon, Message, ScrollRoot, Thumb } from './LibraryParts';
import styles from './OpenDialog.module.css';

/**
 * The Open dialog's Trash: deleted parts, designs, circuits, simulation studies and CAM programs, newest first. Restore brings one back as it was; "Delete
 * permanently" (always confirmed) removes it with its history. What another design, study or CAM program still uses
 * can't be deleted permanently: it stays, and says what uses it.
 */

const DAY = 86_400_000;
function untilPurge(iso: string | null): string {
  if (!iso) return 'Kept';
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / DAY);
  return days <= 0 ? 'Soon' : days === 1 ? 'Tomorrow' : `In ${days} days`;
}

/** Why a Trash item can't be deleted permanently on its own; null when it can. */
function blockedBy(doc: TrashedDocument, together: ReadonlySet<string> = new Set()): string | null {
  if (doc.blocked) return doc.blocked;
  const refs = doc.references;
  const live = refs.designs.filter((design) => !design.trashed);
  const waiting = refs.designs.filter((design) => design.trashed && !together.has(design.id));
  if (!live.length && !refs.studies.length && !refs.programs.length) {
    return waiting.length ? `Linked by ${waiting.length === 1 ? `“${waiting[0].name}”` : `${waiting.length} designs`} in the Trash: delete ${waiting.length === 1 ? 'it' : 'them'} first, or together.` : null;
  }
  return `${doc.used_by}. It stays until ${live.length + refs.studies.length + refs.programs.length === 1 ? 'that one no longer uses it' : 'they no longer use it'}.`;
}

/** What stays after a permanent deletion, with each file's own reason (the server's), for the footer. */
function staysNote(skipped: Skipped[]): string {
  const named = (item: Skipped) => `“${item.name ?? 'One file'}” stays: ${item.reason}`;
  if (skipped.length <= 1) return skipped.length ? named(skipped[0]) : '';
  if (new Set(skipped.map((item) => item.reason)).size === 1) return `${skipped.length} stay in the Trash: ${skipped[0].reason}`;
  return [...skipped.slice(0, 2).map(named), ...(skipped.length > 2 ? [`${skipped.length - 2} more stay`] : [])].join(' · ');
}

type Confirm = { docs: TrashedDocument[] } | { everything: true };

export default function TrashView({ query, onBack, onCount }: { query: string; onBack: () => void; onCount: (n: number) => void }) {
  const [items, setItems] = useState<TrashedDocument[] | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [menuDoc, setMenuDoc] = useState<TrashedDocument | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // What just happened, in the footer: the toasts are under this dialog.
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === 'danger' ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const counted = useRef(onCount);
  counted.current = onCount;

  useEffect(() => {
    let live = true;
    Trash.list()
      .then(({ documents, retention_days }) => { if (!live) return; setItems(documents); setRetention(retention_days); setError(null); counted.current(documents.length); })
      .catch((caught: Error) => { if (live) setError(caught.message || 'The server didn’t answer.'); });
    return () => { live = false; };
  }, [attempt]);
  useEffect(() => onTrashChange(() => setAttempt((n) => n + 1)), []);

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (items ?? []).filter((doc) => words.every((word) => doc.name.toLowerCase().includes(word)));
  }, [items, query]);
  const selected = visible.find((doc) => doc.id === selectedId) ?? null;
  const chosen = useMemo(() => (marked.size ? visible.filter((doc) => marked.has(doc.id)) : selected ? [selected] : []), [marked, visible, selected]);
  const chosenIds = useMemo(() => new Set(chosen.map((doc) => doc.id)), [chosen]);

  const select = (id: string) => { setSelectedId(id); setMarked(new Set()); anchor.current = id; };
  const mark = (ids: Iterable<string>, primary: string) => { const next = new Set(ids); setSelectedId(primary); setMarked(next.size > 1 ? next : new Set()); };
  const toggle = (id: string) => {
    const next = new Set(marked.size ? marked : selected ? [selected.id] : []);
    if (next.has(id)) next.delete(id); else next.add(id);
    anchor.current = id;
    mark(next, next.has(id) ? id : [...next][next.size - 1] ?? id);
  };
  const extend = (id: string) => {
    const from = visible.findIndex((doc) => doc.id === (anchor.current ?? selectedId));
    const to = visible.findIndex((doc) => doc.id === id);
    if (from < 0 || to < 0) { select(id); return; }
    mark(visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((doc) => doc.id), id);
  };
  const working = (ids: string[], on: boolean) => setBusy((current) => {
    const next = new Set(current);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  });

  const restore = async (docs: TrashedDocument[]) => {
    if (!docs.length) return;
    const ids = docs.map((doc) => doc.id);
    working(ids, true);
    const restored = new Set(await restoreFromTrash(docs));
    working(ids, false);
    if (!restored.size) return;
    const names = docs.filter((doc) => restored.has(doc.id));
    setNotice({ tone: 'success', text: names.length === 1 ? `Restored “${names[0].name}”` : `Restored ${count(names.length, 'file')}` });
    setItems((list) => list && list.filter((doc) => !restored.has(doc.id)));
    setMarked(new Set());
  };

  const purge = async (target: Confirm) => {
    setConfirm(null);
    const ids = 'everything' in target ? (items ?? []).map((doc) => doc.id) : target.docs.map((doc) => doc.id);
    working(ids, true);
    try {
      const { purged, skipped } = await deleteForever('everything' in target ? 'all' : ids);
      const gone = new Set(purged.map((doc) => doc.id));
      setItems((list) => list && list.filter((doc) => !gone.has(doc.id)));
      setMarked(new Set());
      const done = purged.length ? (purged.length === 1 ? `Deleted “${purged[0].name}” permanently` : `Deleted ${count(purged.length, 'file')} permanently`) : '';
      const stays = staysNote(skipped);
      setNotice({ tone: stays && !done ? 'danger' : 'success', text: [done, stays].filter(Boolean).join(' · ') });
    } catch (caught) {
      setNotice({ tone: 'danger', text: `Couldn’t delete permanently: ${(caught as Error).message}` });
    } finally {
      working(ids, false);
    }
  };

  const onKeys = (event: KeyboardEvent) => {
    if (event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && visible.length) { mark(visible.map((doc) => doc.id), selectedId ?? visible[0].id); event.preventDefault(); return; }
    if (event.ctrlKey || event.metaKey) return;
    const index = selected ? visible.indexOf(selected) : -1;
    const move = (delta: number) => {
      const next = visible[Math.max(0, Math.min(visible.length - 1, index < 0 ? 0 : index + delta))];
      if (!next) return;
      select(next.id);
      scroller?.querySelector<HTMLElement>(`[data-id="${CSS.escape(next.id)}"]`)?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'Enter': void restore(chosen); break;
      case 'Delete': case 'Backspace': if (chosen.length) setConfirm({ docs: chosen }); break;
      default: return;
    }
    event.preventDefault();
  };

  const entryFor = (target: EventTarget | null) => {
    const id = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-id]')?.dataset.id;
    return id ? visible.find((doc) => doc.id === id) ?? null : null;
  };

  const ready = items !== null;
  const total = items?.length ?? 0;
  const note = retention ? `Deleted files are removed permanently after ${count(retention, 'day')}.` : 'Deleted files stay here until you empty the Trash.';

  const actions = (doc: TrashedDocument, menu: 'context' | 'dropdown') => {
    const Item = menu === 'context' ? ContextItem : MenuItem;
    const targets = chosenIds.has(doc.id) && chosen.length > 1 ? chosen : [doc];
    const reason = targets.length === 1 ? blockedBy(doc) : null;
    return (
      <>
        <Item icon={<ArchiveRestore />} onSelect={() => { void restore(targets); }}>{targets.length > 1 ? `Restore ${targets.length}` : 'Restore'}</Item>
        {menu === 'context' ? <ContextSeparator /> : <MenuSeparator />}
        {menu === 'context'
          ? <ContextItem icon={<Trash2 />} danger disabled={!!reason} reason={reason ?? undefined} onSelect={() => setConfirm({ docs: targets })}>{targets.length > 1 ? `Delete ${targets.length} permanently…` : 'Delete permanently…'}</ContextItem>
          : <MenuItem icon={<Trash2 />} danger disabled={!!reason} onSelect={() => setConfirm({ docs: targets })}>{targets.length > 1 ? `Delete ${targets.length} permanently…` : 'Delete permanently…'}</MenuItem>}
      </>
    );
  };

  let body;
  if (error && !items) {
    body = (
      <Message icon={<AlertTriangle size={30} strokeWidth={1.3} />} tone="danger" title="Couldn’t load the Trash" actions={<Button icon={<RefreshCw />} onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>
        {error}
      </Message>
    );
  } else if (!ready) {
    body = <div className={styles.trashLoading}><Spinner size={16} /></div>;
  } else if (!total) {
    body = <Message icon={<Trash2 size={30} strokeWidth={1.3} />} title="The Trash is empty">{note} Until then, you can restore them as they were.</Message>;
  } else if (!visible.length) {
    body = <Message icon={<Trash2 size={28} strokeWidth={1.3} />} title={`Nothing in the Trash matches “${query.trim()}”`}>Search looks for every word in the name.</Message>;
  } else {
    body = (
      <ContextRoot onOpenChange={(open) => { if (!open) setMenuDoc(null); }}>
        <ContextTrigger asChild>
          <div
            id="trash-list"
            role="listbox"
            aria-label="Trash"
            aria-multiselectable
            className={styles.list}
            onKeyDown={onKeys}
            onMouseDown={(event: MouseEvent) => { if (event.shiftKey) event.preventDefault(); }}
            onContextMenu={(event) => {
              const doc = entryFor(event.target);
              if (!doc) { event.preventDefault(); return; }
              setMenuDoc(doc);
              if (!chosenIds.has(doc.id)) select(doc.id); else setSelectedId(doc.id);
            }}
            onClick={(event) => {
              const doc = entryFor(event.target);
              if (!doc) return;
              if (event.ctrlKey || event.metaKey) toggle(doc.id);
              else if (event.shiftKey) extend(doc.id);
              else select(doc.id);
            }}
          >
            <div className={`${styles.listHead} ${styles.trashGrid}`} role="presentation">
              <span /><span>Name</span><span className={styles.rowKind}>Kind</span><span className={styles.rowNum}>Deleted</span><span className={styles.rowNum}>Removed</span><span />
            </div>
            {visible.map((doc, index) => {
              const chosenHere = chosenIds.has(doc.id);
              const inFlight = busy.has(doc.id);
              return (
                <div key={doc.id} role="option" aria-selected={chosenHere} tabIndex={chosenHere ? 0 : -1} data-id={doc.id} data-kind={doc.kind}
                  className={`${styles.row} ${styles.trashGrid} trash-item`} style={{ animationDelay: `${Math.min(index * 12, 200)}ms` }}>
                  <Thumb doc={doc} size="row" />
                  <div className={styles.rowName}>
                    <span title={doc.name}>{doc.name}</span>
                    {doc.used_by && <span className={styles.usedChip} title={blockedBy(doc) ?? doc.used_by}><Link2 size={11} />{doc.used_by.replace(/^Used by /, '')}</span>}
                    <small className={styles.rowMeta}>{kindLabel(doc.kind)} · deleted {relativeTime(doc.deleted_at)}</small>
                  </div>
                  <span className={styles.rowKind}><KindIcon kind={doc.kind} />{kindLabel(doc.kind)}</span>
                  <time className={styles.rowTime} dateTime={doc.deleted_at} title={`${exactTime(doc.deleted_at)}${doc.deleted_by ? ` by ${doc.deleted_by}` : ''}`}>{relativeTime(doc.deleted_at)}</time>
                  <span className={styles.rowTime} title={doc.purge_at ? `Deleted permanently ${exactTime(doc.purge_at)}${doc.used_by ? ', unless something still uses it' : ''}` : 'Kept until you empty the Trash'}>{untilPurge(doc.purge_at)}</span>
                  <span className={styles.trashActions}>
                    {inFlight ? <Spinner size={13} /> : (
                      <>
                        <Button size="sm" icon={<ArchiveRestore />} data-restore={doc.id} onClick={(event) => { event.stopPropagation(); void restore([doc]); }}>Restore</Button>
                        <DropdownMenu.Root modal={false}>
                          <DropdownMenu.Trigger asChild>
                            <button type="button" className={styles.rowMore} aria-label={`More actions for ${doc.name}`} onClick={(event) => event.stopPropagation()}><MoreHorizontal size={15} /></button>
                          </DropdownMenu.Trigger>
                          <DropdownMenu.Portal>
                            <DropdownMenu.Content className={ui.menu} align="end" sideOffset={6} collisionPadding={10} loop>{actions(doc, 'dropdown')}</DropdownMenu.Content>
                          </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </ContextTrigger>
        {menuDoc && <ContextContent>{actions(menuDoc, 'context')}</ContextContent>}
      </ContextRoot>
    );
  }

  return (
    <>
      <div className={styles.toolbar}>
        <AnimatePresence initial={false} mode="popLayout">
          {chosen.length > 1 ? (
            <motion.div key="selection" className={styles.selectionBar} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease }}>
              <IconButton label="Clear selection" small onClick={() => setMarked(new Set())}><X /></IconButton>
              <b>{chosen.length} selected</b>
              <span className={styles.spacer} />
              <Button size="sm" icon={<ArchiveRestore />} onClick={() => { void restore(chosen); }} id="restore-selected">Restore</Button>
              <Button size="sm" variant="danger" icon={<Trash2 />} onClick={() => setConfirm({ docs: chosen })} id="purge-selected">Delete permanently…</Button>
            </motion.div>
          ) : (
            <motion.div key="trash" className={styles.filters} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.16, ease }}>
              <Button variant="ghost" size="sm" icon={<ArrowLeft />} onClick={onBack} id="trash-back">All files</Button>
              <span className={styles.trashNote}>{note}</span>
              <span className={styles.spacer} />
              <Button size="sm" variant="ghost" className={styles.emptyTrash} icon={<Trash2 />} disabled={!total} onClick={() => setConfirm({ everything: true })} id="empty-trash">Empty Trash…</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className={styles.body}>
        <div className={styles.scroller} ref={setScroller} data-view="list">
          <ScrollRoot.Provider value={scroller}>
            <motion.div className={styles.pane} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2, ease }}>{body}</motion.div>
          </ScrollRoot.Provider>
        </div>
      </div>
      <footer className={styles.footer}>
        <div className={styles.status} aria-live="polite">
          <motion.span key={notice?.text ?? 'status'} data-tone={notice?.tone} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            {notice?.text ?? (ready ? (total ? `${count(total, 'file')} in the Trash` : 'Empty') : 'Loading the Trash…')}
          </motion.span>
        </div>
        <div className={styles.hints}>
          <span><kbd>↑</kbd><kbd>↓</kbd> select</span>
          <span><kbd>Enter</kbd> restore</span>
          <span><kbd>Del</kbd> delete permanently</span>
        </div>
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" icon={<ArchiveRestore />} disabled={!chosen.length} onClick={() => { void restore(chosen); }} id="restore-chosen">
          {chosen.length > 1 ? `Restore ${chosen.length}` : 'Restore'}
        </Button>
      </footer>
      <ConfirmPurge confirm={confirm} items={items ?? []} onCancel={() => setConfirm(null)} onConfirm={(target) => { void purge(target); }} />
    </>
  );
}

function ConfirmPurge({ confirm, items, onCancel, onConfirm }: { confirm: Confirm | null; items: TrashedDocument[]; onCancel: () => void; onConfirm: (target: Confirm) => void }) {
  const targets = !confirm ? [] : 'everything' in confirm ? items : confirm.docs;
  const ids = new Set(targets.map((doc) => doc.id));
  const kept = targets.map((doc) => ({ doc, reason: blockedBy(doc, ids) })).filter((item) => item.reason);
  const going = targets.length - kept.length;
  const one = targets.length === 1;
  return (
    <Dialog open={!!confirm} onOpenChange={(open) => { if (!open) onCancel(); }} width={480} className={styles.confirm}
      icon={<span className={styles.confirmIcon}><Trash2 size={17} /></span>}
      title={confirm && 'everything' in confirm ? 'Empty the Trash?' : one ? `Delete “${targets[0]?.name}” permanently?` : `Delete ${count(targets.length, 'file')} permanently?`}
      description={going ? `${one ? 'Its' : 'Their'} versions, branches and history go too. This can’t be undone.` : 'Nothing can be deleted permanently yet.'}
      footer={<>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="danger" icon={<Trash2 />} disabled={!going} onClick={() => { if (confirm) onConfirm(confirm); }} id="confirm-purge">
          {confirm && 'everything' in confirm ? `Delete ${count(going, 'file')}` : 'Delete permanently'}
        </Button>
      </>}>
      {kept.length > 0 && (
        <ul className={styles.confirmList}>
          {kept.slice(0, 5).map(({ doc, reason }) => (
            <li key={doc.id}><b>{doc.name}</b><p><Link2 size={13} /><span>{reason}</span></p></li>
          ))}
          {kept.length > 5 && <li className={styles.selectionMore}>and {kept.length - 5} more stay</li>}
        </ul>
      )}
    </Dialog>
  );
}

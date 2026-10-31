/**
 * Copy (or move) the open document to another of your workspaces: Personal, or a team where you're a member or above
 * (app/document_copy.py, docs/TEAMS.md "Copy and move"). A copy is the default: the original stays. A move then puts
 * the original in its workspace's Trash. The copy takes along the uploads, own materials and decal images its code
 * names, and starts its own history saying where it came from; a document that links others is refused with the list.
 */
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Copy } from 'lucide-react';
import { Button, Dialog, Switch, ui } from '@/ui';
import { api, ApiError } from '@/lib/api';
import { isDirty, useApp } from '@/state/store';
import { useWorkspace } from './current';
import { copyTargets, WRITES } from './targets';
import { workIn } from './switch';
import styles from './CopyDialog.module.css';

export const useCopyDialog = create<{ open: boolean; move: boolean }>(() => ({ open: false, move: false }));
export const openCopyDialog = (move = false) => useCopyDialog.setState({ open: true, move });


interface Done { workspace: string | null; name: string; document: string; note: string; moved: boolean }

export default function CopyDialog() {
  const { open, move: startMove } = useCopyDialog();
  const saved = useApp((state) => state.doc.saved);
  const kind = useApp((state) => state.doc.kind);
  const dirty = useApp((state) => isDirty(state));
  const team = useWorkspace((state) => state.team);
  const workspaces = useWorkspace((state) => state.workspaces);
  const here = team?.workspace ?? null;
  const targets = copyTargets(workspaces, here, team?.role ?? null);
  const [target, setTarget] = useState<string>('');
  const [name, setName] = useState('');
  const [move, setMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; links?: { name: string }[] } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => {
    if (!open) return;
    setTarget(targets[0]?.id ?? ''); setName(saved?.name ?? ''); setMove(startMove); setError(null); setDone(null); setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const canMove = !team || WRITES.includes(team.role);
  const chosen = targets.find((item) => item.id === target);
  const close = () => useCopyDialog.setState({ open: false });
  const run = async () => {
    if (!saved || !chosen) return;
    setBusy(true); setError(null);
    try {
      const made = await api<{ document: { id: string; name: string }; workspace: string; moved: boolean; note: string }>(
        `/v1/documents/${saved.id}/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: chosen.kind === 'personal' ? 'personal' : chosen.workspace_id, move, ...(name.trim() && name.trim() !== saved.name ? { name: name.trim() } : {}) }) });
      setDone({ workspace: chosen.kind === 'personal' ? null : chosen.workspace_id, name: chosen.name, document: made.document.id, note: made.note, moved: made.moved });
    } catch (caught) {
      const links = caught instanceof ApiError && Array.isArray(caught.data.links) ? (caught.data.links as { name: string }[]) : undefined;
      setError({ message: (caught as Error).message, links });
    } finally { setBusy(false); }
  };
  const supported = kind === 'part' || kind === 'design' || kind === 'circuit';
  const footer = done
    ? <><Button variant="ghost" onClick={close}>Stay here</Button><Button variant="primary" data-open-copy onClick={() => workIn(done.workspace, done.document)}>Open the copy</Button></>
    : <><Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant={move ? 'danger' : 'primary'} disabled={busy || !chosen || !saved || !supported} onClick={() => void run()} data-copy-run>
          {move ? 'Move' : 'Copy'}{chosen ? ` to ${chosen.name}` : ''}</Button></>;
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} title={move ? 'Move to another workspace' : 'Copy to another workspace'}
      icon={<Copy size={18} />} width={480} footer={footer}>
      <div id="copy-dialog" data-done={done ? '' : undefined}>
        {done ? (
          <p role="status">{done.moved ? 'Moved' : 'Copied'} to {done.name}. {done.note}</p>
        ) : !supported ? (
          <p>Shops and CAM programs stay in their workspace: they're tied to its library and jobs.</p>
        ) : !targets.length ? (
          <p>There's nowhere to copy it: you're in no other team where you can add work. Create or join one in Settings → Teams.</p>
        ) : (
          <div className={styles.form}>
            <fieldset className={styles.targets} aria-label="Copy to">
              {targets.map((item) => (
                <label key={item.id} className={styles.target} data-copy-target={item.name}>
                  <input type="radio" name="copy-target" checked={target === item.id} onChange={() => setTarget(item.id)} />
                  <span>{item.name}</span>{item.kind === 'team' && <small>{item.role}</small>}
                </label>
              ))}
            </fieldset>
            <label className={styles.field}>
              <span>Name of the copy</span>
              <input className={ui.input} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} aria-label="Name of the copy" />
            </label>
            <label className={styles.toggle}>
              <Switch checked={move} disabled={!canMove} onCheckedChange={setMove} label="Move instead" /> Move instead
            </label>
            <p className={styles.hint}>
              {move ? 'The original goes to this workspace’s Trash (restorable there); the copy keeps its source and starts its own history.'
                : 'The original stays here. The copy takes the uploads, materials and decal images its code uses, and starts its own history saying where it came from.'}
              {!canMove && ' Moving out of a team needs member or above.'}
              {dirty && ' It copies the saved version: save first to include your edits.'}
            </p>
          </div>
        )}
        {error && (
          <div role="alert" className={styles.error}>
            {error.message}
            {error.links && <ul>{error.links.map((link) => <li key={link.name}>{link.name}</li>)}</ul>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

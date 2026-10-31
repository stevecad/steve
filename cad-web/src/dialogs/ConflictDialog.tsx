/**
 * Saving after someone else saved (STEVE, or this design in another window): never a dead end.
 * Combine both (a three-way merge from the revision these edits started on), keep mine on top of
 * theirs (theirs stays in history), or take the latest and drop mine.
 */
import { useEffect, useState } from 'react';
import { GitMerge } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { Api, type CadDocument } from '@/lib/api';
import { Branches } from '@/lib/branches';
import { relativeTime } from '@/lib/format';
import { get, patchDoc, set, toast, useApp } from '@/state/store';
import { openDocument, saveDocument, saveDraft, updateModel } from '@/state/actions';
import { hasFiles, MAIN, stored } from '@/state/design';
import styles from './Dialogs.module.css';

const latestOf = (id: string, branch: string) => (branch === 'main' ? Api.document(id) : Branches.read(id, branch));

export default function ConflictDialog({ open }: { open: boolean }) {
  const doc = useApp((state) => state.doc);
  const [latest, setLatest] = useState<CadDocument | null>(null);
  const [working, setWorking] = useState<'combine' | 'mine' | 'theirs' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !doc.saved) return;
    setLatest(null); setProblem(null); setWorking(null);
    latestOf(doc.saved.id, doc.branch).then(setLatest).catch((error: Error) => setProblem(error.message));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => set({ dialog: null });
  const base = doc.saved?.revision;

  const combine = async () => {
    const { doc: current } = get();
    if (!current.saved) return;
    setWorking('combine'); setProblem(null);
    try {
      const source = stored(current);
      const result = await Api.combine(current.saved.id, { base_revision: current.saved.revision, branch: current.branch, name: current.name, code: source.code, files: source.files, links: source.links });
      const fresh = await latestOf(current.saved.id, current.branch);
      const files: Record<string, string> = hasFiles(current.kind) ? { ...result.files, [MAIN]: result.code } : current.kind === 'circuit' ? { ...(result.files ?? {}) } : {};
      const active = hasFiles(current.kind) && files[current.activeFile] === undefined ? MAIN : current.activeFile;
      patchDoc({ saved: fresh, name: result.name, links: result.links, files, activeFile: active, code: hasFiles(current.kind) ? files[active] : result.code });
      saveDraft();
      close();
      if (result.status === 'conflict') {
        // Show where: the first file with markers, at its first marker.
        const marked = hasFiles(current.kind) ? Object.keys(files).find((path) => /^<<<<<<< /m.test(files[path])) ?? active : active;
        if (marked !== active) patchDoc({ activeFile: marked, code: files[marked] });
        const code = get().doc.code;
        const from = Math.max(0, code.search(/^<<<<<<< /m));
        set({ sourceReveal: { from, to: from, nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
        toast('warning', `${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'} to resolve`,
          'Both changed the same lines. In Source, keep the latest, yours or both between the <<<<<<< and >>>>>>> markers, delete the markers, then save.', { sticky: true });
        return;
      }
      await updateModel();
      if (await saveDocument()) toast('success', `Combined with revision ${result.revision}`, 'Your edits and the latest changes are both in, saved as a new revision.');
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const keepMine = async () => {
    const { doc: current } = get();
    if (!current.saved) return;
    setWorking('mine'); setProblem(null);
    try {
      patchDoc({ saved: await latestOf(current.saved.id, current.branch) });
      close();
      if (await saveDocument()) toast('success', 'Saved your version', 'The other changes stay in Versions if you need them.');
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const takeTheirs = async () => {
    const { doc: current } = get();
    if (!current.saved) return;
    setWorking('theirs');
    close();
    await openDocument(current.saved.id, current.branch);
    toast('info', 'Showing the latest revision', 'Your unsaved edits were dropped.');
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !working && close()} width={520} title="Saved elsewhere while you were editing"
      description={latest ? `${latest.updated_at ? `${relativeTime(latest.updated_at)}, ` : ''}revision ${latest.revision} was saved (by STEVE or another window). Your edits started from revision ${base}.` : 'Checking the latest revision…'}
      icon={<div className={styles.itemIcon} style={{ color: 'var(--warning)' }}><GitMerge size={17} /></div>}
      footer={<>
        <Button variant="ghost" disabled={!!working} onClick={close}>Not now</Button>
        <Button id="conflict-theirs" disabled={!!working} onClick={() => void takeTheirs()}>{working === 'theirs' ? <Spinner size={13} /> : null}Use the latest</Button>
        <Button id="conflict-mine" disabled={!!working || !latest} onClick={() => void keepMine()}>{working === 'mine' ? <Spinner size={13} /> : null}Keep mine</Button>
        <Button id="conflict-combine" variant="primary" disabled={!!working || !latest} onClick={() => void combine()}>{working === 'combine' ? <Spinner size={13} /> : null}Combine both</Button>
      </>}>
      <ul className={styles.conflictChoices}>
        <li><b>Combine both</b> merges your edits with the latest, line by line, and saves. If you both changed the same lines, they are marked in Source for you to pick.</li>
        <li><b>Keep mine</b> saves your version as the next revision. The latest changes stay in Versions.</li>
        <li><b>Use the latest</b> drops your unsaved edits.</li>
      </ul>
      {problem && <p className={styles.message} role="alert" data-tone="danger">{problem}</p>}
    </Dialog>
  );
}

import { isDocumentKind, type DocumentSummary, type FileSummary } from '@/lib/api';
import { Trash, type References } from '@/lib/trash';
import { dismissToast, get, hasSourceEdits, hasUnsavedWork, toast } from './store';
import { refreshLinks } from './linkWatch';
import { closeDocumentTabs, reinstateTabs } from './tabs';

/**
 * Deleting parts and designs: they go to the Trash (restorable), their open tabs close, and a toast offers Undo.
 * Lists that show documents (the Open dialog) listen for changes made here or by Undo.
 */

const listeners = new Set<() => void>();
/** Called after documents move to or from the Trash (including Undo); returns the unsubscribe. */
export function onTrashChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const changed = () => {
  listeners.forEach((listener) => listener());
  void refreshLinks(false);  // The open design's links say which of their documents are in the Trash.
  // The open design's simulation studies and CAM programs: one may have gone to the Trash or come back.
  const id = get().doc.saved?.id;
  if (id) {
    void import('@/workspaces/simulate/state').then(({ loadLinkedStudies }) => loadLinkedStudies(id)).catch(() => undefined);
    void import('@/workspaces/manufacture/state').then(({ loadPrograms }) => loadPrograms()).catch(() => undefined);
  }
};
/** "designs" when they're all parts, designs or circuits; "files" when studies or programs are among them. */
const noun = (items: object[]) => (items.every((item) => { const kind = (item as { kind?: FileSummary['kind'] }).kind; return !kind || isDocumentKind(kind); }) ? 'designs' : 'files');

export const UNDO_MS = 9000;

/** Whether a document has unsaved edits in any open tab (the live one included). */
export function unsavedIn(id: string): boolean {
  const { tabs, activeTab } = get();
  return tabs.some((tab) => tab.id === id && (tab.key === activeTab ? hasUnsavedWork() && hasSourceEdits() : tab.dirty));
}

/** "Used by 2 designs and 1 CAM program" (the server's wording, for references fetched by the client). */
export function usedBy(refs: References): string {
  const parts = ([['designs', 'design', 'designs'], ['studies', 'simulation study', 'simulation studies'], ['programs', 'CAM program', 'CAM programs']] as const)
    .map(([key, one, many]) => [refs[key].length, one, many] as const).filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  if (!parts.length) return '';
  return `Used by ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}`;
}

/** What to tell someone before deleting: what uses each document and which have unsaved edits. */
export async function deletionCheck<T extends { id: string; name: string } = DocumentSummary>(docs: T[]) {
  const refs = await Promise.all(docs.map((doc) => Trash.references(doc.id).catch(() => null)));
  const deleting = new Set(docs.map((doc) => doc.id));
  return docs.map((doc, index) => {
    const found = refs[index];
    // Designs deleted together don't count: they go to the Trash too.
    const outside = found && { ...found, designs: found.designs.filter((design) => !deleting.has(design.id) && !design.trashed) };
    const references = outside ? { ...outside, count: outside.designs.length + outside.studies.length + outside.programs.length } : null;
    return { doc, references, usedBy: references ? usedBy(references) : '', unsaved: unsavedIn(doc.id) };
  });
}
export type DeletionCheck<T extends { id: string; name: string } = DocumentSummary> = Awaited<ReturnType<typeof deletionCheck<T>>>;

export interface Deleted {
  ids: string[];
  /** "Moved “Bracket” to the Trash" */
  title: string;
  /** Puts them back (once), with their tabs; also offered by the toast. */
  undo: () => void;
}

/** Moves documents to the Trash, closes their tabs and offers Undo in a toast (dialogs over the toasts offer it
 * themselves, with `undo`). `used`: what uses the one document deleted ("Used by 2 designs"). */
export async function moveToTrash(docs: Pick<DocumentSummary, 'id' | 'name'>[], used = ''): Promise<Deleted | null> {
  if (!docs.length) return null;
  let result;
  try {
    result = await Trash.remove(docs.map((doc) => doc.id));
  } catch (error) {
    toast('danger', docs.length === 1 ? `Couldn’t delete ${docs[0].name}` : `Couldn’t delete ${docs.length} ${noun(docs)}`, (error as Error).message);
    return null;
  }
  const moved = result.moved.map((item) => item.document);
  const closed = moved.map((doc) => closeDocumentTabs(doc.id));
  changed();
  if (result.skipped.length) toast('warning', `${result.skipped.length === 1 ? 'One wasn’t' : `${result.skipped.length} weren’t`} deleted`, result.skipped.map((item) => item.reason).join(' · '));
  if (!moved.length) return null;
  const title = moved.length === 1 ? `Moved “${moved[0].name}” to the Trash` : `Moved ${moved.length} ${noun(moved)} to the Trash`;
  const detail = used ? `${used}. Their pinned revisions keep working while it’s in the Trash.` : undefined;
  let done = false;
  const once = () => { if (done) return; done = true; dismissToast(id); void undo(moved, closed); };
  // Sticky, with a longer time of its own than an info toast: Undo shouldn't vanish mid-reach.
  const id = toast('info', title, detail, { sticky: true, action: { label: 'Undo', run: once } });
  setTimeout(() => dismissToast(id), UNDO_MS);
  return { ids: moved.map((doc) => doc.id), title, undo: once };
}

async function undo(docs: FileSummary[], closed: ReturnType<typeof closeDocumentTabs>[]) {
  try {
    await Trash.restore(docs.map((doc) => doc.id));
  } catch (error) {
    toast('danger', 'Couldn’t undo the delete', `${(error as Error).message} Open → Trash has it.`);
    return;
  }
  for (const tabs of closed) reinstateTabs(tabs);
  changed();
  toast('success', docs.length === 1 ? `Restored “${docs[0].name}”` : `Restored ${docs.length} ${noun(docs)}`);
}

/** Brings files back from the Trash (they open from the list as usual). */
export async function restoreFromTrash(docs: Pick<DocumentSummary, 'id' | 'name'>[]): Promise<string[]> {
  try {
    const { restored, skipped } = await Trash.restore(docs.map((doc) => doc.id));
    changed();
    if (skipped.length) toast('warning', 'Some weren’t restored', skipped.map((item) => item.reason).join(' · '));
    if (restored.length) toast('success', restored.length === 1 ? `Restored “${restored[0].name}”` : `Restored ${restored.length} ${noun(restored)}`);
    return restored.map((doc) => doc.id);
  } catch (error) {
    toast('danger', 'Couldn’t restore', (error as Error).message);
    return [];
  }
}

/** Permanent deletion ("Delete permanently", "Empty Trash"); what's still used elsewhere stays and is reported. */
export async function deleteForever(ids: string[] | 'all') {
  const result = ids === 'all' ? await Trash.empty() : await Trash.purge(ids);
  changed();
  return result;
}

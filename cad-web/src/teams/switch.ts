/** Switching workspace from the UI (account menu, Settings → Teams): asks about unsaved edits first, then the app loads
 * again in the other workspace (teams/current.ts switchWorkspace). Apart from current.ts, which the store imports. */
import { leave, openDocument } from '@/state/actions';
import { get, hasUnsavedWork, set, toast } from '@/state/store';
import { selectedWorkspace, switchWorkspace } from './current';

export function workIn(workspace: string | null, document?: string, branch?: string) {
  const go = () => switchWorkspace(workspace, document, branch);
  if (!hasUnsavedWork()) { go(); return; }   // nothing to lose: a build or save under way is the server's to finish
  if (get().busy) { toast('info', 'Saving or opening…', 'Switch workspace once it has finished, so your edits aren’t lost.'); return; }
  leave(go);
}

/** Opens a document of a workspace (null: Personal): here at once when this tab works there, else in that workspace
 * (the app loads again there). */
export function openIn(workspace: string | null, document: string, branch = 'main') {
  if ((workspace ?? null) !== selectedWorkspace()) { workIn(workspace, document, branch); return; }
  set({ dialog: null });
  const go = () => { void openDocument(document, branch); };
  if (!hasUnsavedWork()) { go(); return; }
  leave(go);
}

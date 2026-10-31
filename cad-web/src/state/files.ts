import type { FileSummary } from '@/lib/api';
import { applyLink } from './deepLink';
import { get, toast, useApp } from './store';
import { openHere, openTab } from './tabs';

/**
 * Opening a simulation study or CAM program from the file list: they live with a design, so its design opens (here or
 * in a tab) in Simulate or Manufacture with the study or program selected, the way a link does (state/deepLink.ts).
 */
export function openStudyOrProgram(file: FileSummary, here = false) {
  const design = file.design?.id;
  if (!design) {
    toast('warning', `“${file.name}” has no design to open it with`, 'Its design was deleted. It’s kept as it was; restore the design from the Trash to work on it.');
    return;
  }
  const params = new URLSearchParams({ document: design, workspace: file.kind === 'study' ? 'simulate' : 'manufacture', [file.kind]: file.id });
  (here ? openHere : openTab)({ id: design });
  if (get().doc.saved?.id === design) { void applyLink(params); return; }
  // Applied once the design is the open document; given up if it never opens (in the Trash, no access).
  const stop = useApp.subscribe((state) => state.doc.saved?.id, (id) => {
    if (id !== design) return;
    stop();
    void applyLink(params);
  });
  setTimeout(stop, 30_000);
}

/**
 * Where the person was, kept across any reload (an update, a stale chunk, F5, the browser restoring the tab). The URL
 * only names the document, so the workspace, study, past revision, camera, panel tabs and open file are put back from a
 * snapshot saved as they work (rememberView): in sessionStorage for this tab, and per document in localStorage so
 * opening the document again later comes back to the same place. A deep link's own parameters always win.
 */
import { viewer, type CameraPose } from '@/viewport/viewer';
import { get, set, useApp, type AppState } from './store';
import { accountKey } from './accountStorage';
import { narrow } from './layout';

const KEY = 'steve.reloadView';
const DOCUMENT_KEY = 'steve.lastView.';  // + the document's id

type Panels = Pick<AppState, 'dockTab' | 'leftTab'>;

export interface ReloadView {
  document: string;
  branch: string;
  /** Deep-link parameters (deepLink.ts): workspace, study, revision. */
  link: Record<string, string>;
  pose: CameraPose | null;
  panels: Panels;
  activeFile: string;
}

export function saveView() {
  const state = get();
  const id = state.doc.saved?.id;
  try {
    if (!id) { sessionStorage.removeItem(accountKey(KEY)); return; }
    const link: Record<string, string> = {};
    if (state.workspace !== 'design') link.workspace = state.workspace;
    if (state.workspace === 'simulate' && state.activeStudy) link.study = state.activeStudy;
    if (state.pastVersion && state.pastVersion.branch === state.doc.branch) link.revision = String(state.pastVersion.revision);
    const { dockTab, leftTab } = state;
    const view: ReloadView = { document: id, branch: state.doc.branch, link, pose: viewer.capturePose(),
      panels: { dockTab, leftTab }, activeFile: state.doc.activeFile };
    const text = JSON.stringify(view);
    sessionStorage.setItem(accountKey(KEY), text);
    localStorage.setItem(accountKey(DOCUMENT_KEY + id), text);
  } catch { /* Storage is optional. */ }
}

let remembering = false;

/** Saves where the person is as they work (after start-up has put the last place back: updateWatch.markDraftRestored):
 * on every change to what's open, every few seconds for the camera, and when the page is hidden or unloaded. */
export function rememberView() {
  if (remembering) return;
  remembering = true;
  const key = (state: AppState) => [state.doc.saved?.id, state.doc.branch, state.workspace, state.activeStudy, state.pastVersion?.revision,
    state.dockTab, state.leftTab, state.doc.activeFile].join('|');
  let last = key(get());
  let timer = 0;
  useApp.subscribe((state) => {
    const next = key(state);
    if (next === last) return;
    last = next;
    window.clearTimeout(timer);
    timer = window.setTimeout(saveView, 300);
  });
  window.setInterval(saveView, 5000);  // The camera moves without the store.
  window.addEventListener('pagehide', saveView);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveView(); });
}

/** Where the person last was in this document: this tab's snapshot first, else the last one saved for the document. */
export function takeView(id: string, branch: string): ReloadView | null {
  const read = (storage: Storage, name: string) => {
    const view = JSON.parse(storage.getItem(accountKey(name)) || 'null') as ReloadView | null;
    return view && view.document === id && view.branch === branch ? view : null;
  };
  try {
    return read(sessionStorage, KEY) ?? read(localStorage, DOCUMENT_KEY + id);
  } catch { return null; }
}

/** The panels' tabs as they were; whether they're open, and how wide, follows the person everywhere (panels.ts). On a
 * phone they stay as the app opens them (layout.ts). */
export function restorePanels(view: ReloadView) {
  const { dockTab, leftTab } = view.panels ?? {} as Partial<Panels>;
  const patch: Partial<AppState> = {};
  if (leftTab === 'model' || leftTab === 'versions') patch.leftTab = leftTab;
  if (!narrow() && dockTab && dockTab !== 'tool') patch.dockTab = dockTab;
  set(patch);
}

import { get, hasUnsavedWork, set, toast, useApp } from './store';
import type { Kind } from '@/lib/api';
import { abandonQuietBuild, canLeave, clearWorkspace, isOpening, leave, newDocument, openBuild, openDocument, reopenUnsaved, takeStash, type DocStash } from './actions';
import { viewer, type CameraPose } from '@/viewport/viewer';
import { accountKey, forgetShared } from './accountStorage';

/**
 * Open documents as tabs. Only the active tab is live in the store; the others keep
 * their unsaved edits (stash) and camera pose, so switching never asks to save.
 */
export interface DocTab {
  /** Which document the tab holds; changes when a new design is saved or the branch switches. */
  key: string;
  /** Stable for the tab's lifetime, so a rekey doesn't replay its open animation. */
  uid: string;
  id: string | null;
  buildId: string | null;
  branch: string;
  name: string;
  kind: Kind;
  dirty: boolean;
  stash: DocStash | null;
  pose: CameraPose | null;
  previewBuildId: string | null;
}

const STORAGE_KEY = 'steve-tabs';
let counter = 0;
let switching = false;

const docKey = (id: string, branch: string) => `doc:${id}@${branch}`;
const tabs = () => get().tabs;
const updateTab = (key: string, patch: Partial<DocTab>) => set((state) => ({ tabs: state.tabs.map((tab) => (tab.key === key ? { ...tab, ...patch } : tab)) }));

/** Saves the live document's unsaved edits and view into its tab before leaving it. */
function stashActive() {
  const key = get().activeTab;
  if (!key || !get().doc.open) return;
  updateTab(key, { stash: takeStash(), pose: viewer.capturePose(), previewBuildId: get().displayed?.id ?? null, dirty: hasUnsavedWork() });
}

const uid = () => `${Date.now().toString(36)}-${counter++}`;

function placeholder(key: string, fields: Partial<DocTab>): DocTab {
  return { key, uid: uid(), id: null, buildId: null, branch: 'main', name: 'Opening…', kind: 'part', dirty: false, stash: null, pose: null, previewBuildId: null, ...fields };
}

/** Counts tab loads: one left while still opening (abandonQuietBuild) leaves the tab state to the newer one. */
let loads = 0;

async function load(tab: DocTab) {
  const run = ++loads;
  switching = true;
  try {
    if (tab.id) await openDocument(tab.id, tab.branch, { pose: tab.pose, stash: tab.stash });
    else if (tab.buildId && !tab.stash) await openBuild(tab.buildId);
    else await reopenUnsaved(tab.stash ?? { code: '', name: tab.name, kind: tab.kind }, tab.previewBuildId, tab.pose);
  } finally {
    // Left before it opened: the tab keeps its unsaved edits for next time.
    if (run === loads) {
      switching = false;
      if (get().activeTab === tab.key) updateTab(tab.key, { stash: null });
      syncActiveTab();
    }
  }
}

/** Lets navigation leave what the app is doing (abandonQuietBuild); a tab left while opening keeps its document's name. */
function abandon(): boolean {
  const { doc } = get();
  const tab = tabs().find((item) => item.key === get().activeTab);
  const opening = isOpening();
  if (tab && doc.open && opening) updateTab(tab.key, { name: doc.name.trim() || 'Untitled', kind: doc.kind, dirty: !!tab.stash });
  if (!abandonQuietBuild()) return false;
  // The load left behind no longer finishes the tab switch (load).
  if (opening) { ++loads; switching = false; }
  return true;
}

/** The active tab is still opening and holds unsaved edits that aren't on screen yet: it isn't replaced or closed. */
const openingWithEdits = () => isOpening() && !!tabs().find((tab) => tab.key === get().activeTab)?.stash;

export function activateTab(key: string) {
  if (key === get().activeTab) return;
  const tab = tabs().find((item) => item.key === key);
  if (!tab || !abandon()) return;
  stashActive();
  set({ activeTab: key });
  void load(tab);
}

/** Opens a saved document, a generated model or a new document in a tab (reusing one if open). */
export function openTab(target: { id: string; branch?: string } | { buildId: string } | { kind: Kind; name?: string }) {
  if (!abandon()) return;
  if ('id' in target) {
    const key = docKey(target.id, target.branch ?? 'main');
    if (tabs().some((tab) => tab.key === key)) { activateTab(key); return; }
    stashActive();
    set((state) => ({ tabs: [...state.tabs, placeholder(key, { id: target.id, branch: target.branch ?? 'main' })], activeTab: key }));
    void load(tabs().find((tab) => tab.key === key)!);
    return;
  }
  stashActive();
  if ('buildId' in target) {
    const key = `build:${target.buildId}`;
    if (tabs().some((tab) => tab.key === key)) { set({ activeTab: key }); void load(tabs().find((tab) => tab.key === key)!); return; }
    set((state) => ({ tabs: [...state.tabs, placeholder(key, { buildId: target.buildId })], activeTab: key }));
    const run = ++loads;
    switching = true;
    void openBuild(target.buildId).finally(() => { if (run === loads) { switching = false; syncActiveTab(); } });
    return;
  }
  const key = `new:${Date.now().toString(36)}${counter++}`;
  set((state) => ({ tabs: [...state.tabs, placeholder(key, { kind: target.kind, name: target.name ?? 'Untitled' })], activeTab: key }));
  ++loads;
  switching = true;
  newDocument(target.kind, target.name);
  switching = false;
  syncActiveTab();
}

/** Opens a saved document in the active tab instead of a new one, asking about unsaved work first. */
export function openHere(target: { id: string; branch?: string }) {
  const key = docKey(target.id, target.branch ?? 'main');
  if (!get().activeTab || tabs().some((tab) => tab.key === key) || openingWithEdits()) { openTab(target); return; }
  if (!abandon()) return;
  leave(() => {
    const active = get().activeTab;
    if (!active || !tabs().some((tab) => tab.key === active)) { openTab(target); return; }
    const next = placeholder(key, { id: target.id, branch: target.branch ?? 'main' });
    set((state) => ({ tabs: state.tabs.map((tab) => (tab.key === active ? next : tab)), activeTab: key }));
    void load(next);
  });
}

function removeTab(key: string) {
  const list = tabs();
  const index = list.findIndex((tab) => tab.key === key);
  if (index < 0) return;
  const wasActive = get().activeTab === key;
  const remaining = list.filter((tab) => tab.key !== key);
  set({ tabs: remaining, ...(wasActive ? { activeTab: null } : {}) });
  if (!wasActive) return;
  const next = remaining[Math.min(index, remaining.length - 1)];
  if (next) { set({ activeTab: next.key }); void load(next); }
  else clearWorkspace();
}

/**
 * Closes every tab of a document without asking: it was moved to the Trash (after any unsaved edits there were
 * confirmed away). Returns the tabs, unsaved edits included, so Undo can put them back.
 */
export function closeDocumentTabs(id: string): { tabs: DocTab[]; active: string | null } {
  const active = tabs().some((tab) => tab.id === id && tab.key === get().activeTab) ? get().activeTab : null;
  if (active) { abandon(); stashActive(); }  // The live edits go with the tab, for Undo.
  const closed = tabs().filter((tab) => tab.id === id);
  // The active one last, so the tab that takes over is never another of this document's.
  for (const tab of [...closed].sort((a, b) => Number(a.key === active) - Number(b.key === active))) removeTab(tab.key);
  return { tabs: closed, active };
}

/** Undo for closeDocumentTabs: the tabs come back where they were left, and the one that was active is again. */
export function reinstateTabs({ tabs: list, active }: { tabs: DocTab[]; active: string | null }) {
  const missing = list.filter((tab) => !tabs().some((item) => item.key === tab.key));
  if (!missing.length) return;
  set((state) => ({ tabs: [...state.tabs, ...missing] }));
  if (active && missing.some((tab) => tab.key === active)) activateTab(active);
}

export function closeTab(key: string) {
  const tab = tabs().find((item) => item.key === key);
  if (tab && get().sketching) {
    toast('info', 'Sketch edit in progress', 'Finish or cancel the sketch before closing documents.');
    return;
  }
  if (!tab || !canLeave()) return;
  if (key !== get().activeTab) {
    // Another tab: the live document (even one still opening) carries on.
    if (!tab.dirty) { removeTab(key); return; }
    // Show the unsaved work before asking about it.
    activateTab(key);
    setTimeout(() => set({ dialog: 'unsaved', pendingLeave: () => removeTab(key) }), 400);
    return;
  }
  if (openingWithEdits() || !abandon()) return;
  if (hasUnsavedWork()) set({ dialog: 'unsaved', pendingLeave: () => removeTab(key) });
  else removeTab(key);
}

export function cycleTab(step: number) {
  const list = tabs();
  const index = list.findIndex((tab) => tab.key === get().activeTab);
  if (list.length < 2 || index < 0) return;
  activateTab(list[(index + step + list.length) % list.length].key);
}

/** Keeps the active tab's label and identity in step with the live document. */
export function syncActiveTab() {
  const state = get();
  if (!state.doc.open || switching) return;
  const id = state.doc.saved?.id ?? null;
  const desired = id ? docKey(id, state.doc.branch) : null;
  const fields = { id, branch: state.doc.branch, name: state.doc.name.trim() || 'Untitled', kind: state.doc.kind, dirty: hasUnsavedWork(state), buildId: id ? null : state.displayed?.id ?? null };
  let active = state.tabs.find((tab) => tab.key === state.activeTab);
  // A saved document's tab never turns into an unsaved one: that is a different document.
  if (!id && active?.id) active = undefined;
  if (desired && active?.key !== desired) {
    const existing = state.tabs.find((tab) => tab.key === desired);
    if (existing) { set({ activeTab: desired }); active = existing; }
    else if (active && (!active.id || active.id === id)) {
      // A new document was saved, or the branch changed: this tab now points at it.
      set((current) => ({ tabs: current.tabs.map((tab) => (tab.key === active!.key ? { ...tab, key: desired } : tab)), activeTab: desired }));
      active = { ...active, key: desired };
    } else {
      set((current) => ({ tabs: [...current.tabs, placeholder(desired, {})], activeTab: desired }));
      active = get().tabs.find((tab) => tab.key === desired);
    }
  }
  if (!active && !id && fields.buildId) {
    active = state.tabs.find((tab) => !tab.id && tab.buildId === fields.buildId);
    if (active) set({ activeTab: active.key });
  }
  if (!active) {
    const key = desired ?? `new:${Date.now().toString(36)}${counter++}`;
    set((current) => ({ tabs: [...current.tabs, placeholder(key, {})], activeTab: key }));
    active = get().tabs.find((tab) => tab.key === key);
  }
  const current = get().tabs.find((tab) => tab.key === active!.key)!;
  if (current.name !== fields.name || current.kind !== fields.kind || current.dirty !== fields.dirty || current.id !== fields.id || current.branch !== fields.branch || current.buildId !== fields.buildId) updateTab(current.key, fields);
}

/** Reopens the previously active tab; false when there is nothing to resume. */
export async function resumeActiveTab(): Promise<boolean> {
  const tab = tabs().find((item) => item.key === get().activeTab);
  if (!tab || (!tab.id && !tab.buildId && !tab.stash)) return false;
  await load(tab);
  return true;
}

export function persistTabs() {
  const { tabs: list, activeTab } = get();
  try { localStorage.setItem(accountKey(STORAGE_KEY), JSON.stringify({ tabs: list.map(({ pose: _pose, ...tab }) => tab), activeTab })); } catch { /* Optional. */ }
}

/** Restores the tab strip from the last session; a URL that names a document decides which tab is live. */
export function restoreTabs() {
  forgetShared(STORAGE_KEY);
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey(STORAGE_KEY)) || 'null') as { tabs: Omit<DocTab, 'pose'>[]; activeTab: string | null } | null;
    if (!saved?.tabs?.length) return;
    const params = new URLSearchParams(location.search);
    const previous = saved.tabs.find((tab) => tab.key === saved.activeTab);
    const model = params.get('model') || params.get('build');
    const matches = !!previous && (!params.size
      || (params.has('document') ? previous.id === params.get('document') && previous.branch === (params.get('branch') || 'main')
        : model ? !previous.id && previous.buildId === model
          : params.has('new') && !previous.id));
    set({ tabs: saved.tabs.map((tab) => ({ ...tab, uid: tab.uid ?? uid(), pose: null })), activeTab: matches ? saved.activeTab : null });
  } catch { /* Ignore corrupt storage. */ }
}

let installed = false;
/** Wires tab sync and persistence to store changes; call once at startup. */
export function installTabs() {
  if (installed) return;
  installed = true;
  useApp.subscribe((state) => [state.doc, state.displayed] as const, () => syncActiveTab(), { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] });
  useApp.subscribe((state) => [state.tabs, state.activeTab] as const, persistTabs, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] });
}

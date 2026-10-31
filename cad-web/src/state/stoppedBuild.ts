import type { AppState } from './store';

// Stop pauses this exact source, including across tab switches. A new edit is
// eligible for live generation again; explicit Update always remains available.
const stopped = new Map<string, string>();
const tabId = (state: AppState) => state.tabs.find((tab) => tab.key === state.activeTab)?.uid;
const source = (state: AppState) => JSON.stringify([state.doc.kind, state.doc.code, state.doc.files, state.doc.links, state.rollback?.code]);

export function rememberStoppedBuild(state: AppState) {
  const id = tabId(state);
  if (id) stopped.set(id, source(state));
}

export function isStoppedBuild(state: AppState) {
  for (const id of stopped.keys()) if (!state.tabs.some((tab) => tab.uid === id)) stopped.delete(id);
  const id = tabId(state);
  if (!id || !stopped.has(id)) return false;
  if (stopped.get(id) === source(state)) return true;
  stopped.delete(id);
  return false;
}

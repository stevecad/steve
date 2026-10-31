/**
 * The open document moves on while it is open (STEVE's MCP tools save it, or another window does).
 * This notices newer revisions: an unedited document refreshes in place, keeping the camera; one
 * with unsaved edits gets a notice that offers combining, keeping or taking the latest right away
 * (instead of only at save time). While the tab is visible the server pushes each new revision of the
 * open document and branch as it is saved (GET /v1/documents/{id}/events), and each build attached to
 * it afterwards (an agent's save is built in the background), so a person can watch their agent work;
 * the status bar says while a revision saved elsewhere is still building. Otherwise (an older server,
 * a dropped stream) it checks when the window comes back into focus, when the tab becomes active, and
 * every 20 s.
 */
import { create } from 'zustand';
import { Api, serverCapabilities, type Build, type CadDocument } from '@/lib/api';
import { Branches } from '@/lib/branches';
import { useSketch } from '@/sketch/session';
import { useFeatureDialog } from '@/modeling/dialog';
import { get, hasSourceEdits, isDirty, patchDoc, set, snapshot, toast, useApp, type AppState } from './store';
import { applyDocumentRevision, showFinishedBuild, updateModel } from './actions';
import { builtFrom } from './design';

/** The open revision, saved elsewhere, whose own model is still building (for the status bar). */
export const useDocumentWatch = create<{ building: number | null }>(() => ({ building: null }));

const notified = new Set<string>();
let checking = false;

/** Nothing in flight in this tab: its own saves and builds never look like an outside change. */
const idle = () => {
  const state = get();
  return !state.busy && !state.pastVersion && state.doc.open && !!state.doc.saved;
};

/** Nothing would be lost or interrupted by changing what is open: no unsaved edits, sketch, feature dialog or dialog. */
const quiet = (state: AppState) => !hasSourceEdits(state) && !state.dialog && !useSketch.getState().active && !useFeatureDialog.getState().open;

/** The model on screen isn't of the open revision's code (nor rolled back on the timeline), and a build attached to that revision since may be. */
const awaitsAttached = (state: AppState, preview: string | null | undefined) =>
  !!preview && preview !== state.displayed?.id && !state.rollback && !builtFrom(state.displayed, state.doc);

export async function refreshOpenDocument() {
  if (checking || !idle()) return;
  const { doc } = get();
  const id = doc.saved!.id;
  const branch = doc.branch;
  const revision = doc.saved!.revision;
  checking = true;
  let latest: CadDocument;
  try {
    latest = branch === 'main' ? await Api.document(id) : await Branches.read(id, branch);
  } catch {
    return;
  } finally {
    checking = false;
  }
  const now = get();
  if (!idle() || now.doc.saved?.id !== id || now.doc.branch !== branch || now.doc.saved.revision !== revision || latest.revision < revision) return;
  if (latest.revision === revision) {
    await showAttached(latest, branch);
    return;
  }
  const key = `${id}:${branch}:${latest.revision}`;
  // Refresh quietly only when nothing would be lost or interrupted (unsaved edits, a sketch, a feature dialog, a dialog).
  // A model rebuilt here from the saved source isn't an edit: the new revision brings or builds its own.
  if (quiet(now)) {
    let build: Build | null = null;
    if (latest.preview_build_id) {
      try { build = await Api.build(latest.preview_build_id); } catch { return; }
    }
    const after = get();
    if (!idle() || hasSourceEdits(after) || after.doc.saved?.id !== id || after.doc.branch !== branch || after.doc.saved.revision !== revision) return;
    await applyDocumentRevision(latest, build, branch);
    if (!build) void updateModel({ quiet: true });  // Saved without geometry: build what is now open.
    notified.add(key);
    toast('info', `Updated to revision ${latest.revision}`, 'Saved by STEVE, your agent or another window.');
    return;
  }
  if (!hasSourceEdits(now) || notified.has(key)) return;
  notified.add(key);
  toast('warning', `Revision ${latest.revision} was saved elsewhere`, `Your unsaved edits started from revision ${revision} (STEVE, your agent or another window saved since).`,
    { sticky: true, action: { label: 'Resolve', run: () => set({ dialog: 'conflict' }) } });
}

/**
 * The build attached to the open revision after it arrived: an agent's save keeps the previous model until its own
 * build finishes in the background. Shown (keeping the camera) when the model on screen isn't of the saved code.
 */
async function showAttached(latest: CadDocument, branch: string) {
  const now = get();
  if (!quiet(now) || !awaitsAttached(now, latest.preview_build_id)) return;
  let build: Build;
  try { build = await Api.build(latest.preview_build_id!); } catch { return; }
  const same = () => { const state = get(); return idle() && quiet(state) && state.doc.saved?.id === latest.id && state.doc.branch === branch && state.doc.saved.revision === latest.revision; };
  if (!same()) return;
  const clean = !isDirty();
  if (!(await showFinishedBuild(build)) || !same()) return;
  // The attached build is the saved revision's model now; showing it is no edit.
  patchDoc({ saved: { ...get().doc.saved!, preview_build_id: build.id }, ...(clean ? { savedSnapshot: snapshot() } : {}) });
}

/** The open document and branch's event stream, and the newest revision it announced with its attached build. */
let stream: { key: string; source: EventSource; announced: number; preview: string | null } | null = null;

const stopStream = () => {
  stream?.source.close();
  stream = null;
  useDocumentWatch.setState({ building: null });
};

/** Behind the stream: a newer revision, or a build attached to the open one, that a busy tab skipped; applied once idle. */
const behind = () => {
  if (!stream) return false;
  const state = get();
  const revision = state.doc.saved?.revision ?? Infinity;
  return stream.announced > revision || (stream.announced === revision && awaitsAttached(state, stream.preview));
};

/** Follows the open document's stream while the tab is visible; one at a time, replaced when the document or branch changes. */
async function follow() {
  const { doc } = get();
  const key = doc.saved && document.visibilityState === 'visible' ? `${doc.saved.id}|${doc.branch}` : '';
  if (stream?.key === key) return;
  stopStream();
  if (!key || typeof EventSource === 'undefined' || !(await serverCapabilities()).documentEvents) return;
  const now = get();
  if (stream || !now.doc.saved || `${now.doc.saved.id}|${now.doc.branch}` !== key || document.visibilityState !== 'visible') return;
  const source = new EventSource(`/v1/documents/${now.doc.saved.id}/events?branch=${encodeURIComponent(now.doc.branch)}`);
  const current = { key, source, announced: 0, preview: null as string | null };
  stream = current;
  source.addEventListener('document', (event) => {
    try {
      const { revision, preview_build_id: preview, building } = JSON.parse((event as MessageEvent).data) as { revision: number; preview_build_id: string | null; building?: boolean };
      if (revision < current.announced) return;
      current.announced = revision;
      current.preview = preview;
      if (stream === current) useDocumentWatch.setState({ building: building ? revision : null });
    } catch { return; }
    if (stream === current && behind()) void refreshOpenDocument();
  });
  source.addEventListener('end', () => { source.close(); if (stream === current) useDocumentWatch.setState({ building: null }); });  // Trashed, or the branch was deleted.
}

export function installDocumentWatch(): () => void {
  const onFocus = () => {
    void follow();
    if (document.visibilityState === 'visible') void refreshOpenDocument();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  // The fallback: while no stream is open (1: EventSource.OPEN), or a pushed revision or build is still to be applied.
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible' && (stream?.source.readyState !== 1 || behind())) void refreshOpenDocument();
  }, 20_000);
  const stop = useApp.subscribe((state) => `${state.activeTab}|${state.doc.saved?.id}|${state.doc.branch}`, () => { void follow(); void refreshOpenDocument(); });
  const stopIdle = useApp.subscribe((state) => state.busy, (busy) => { if (!busy && behind()) void refreshOpenDocument(); });
  void follow();
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.clearInterval(timer);
    stop();
    stopIdle();
    stopStream();
  };
}

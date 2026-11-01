import { buildCode } from '@/modeling/rollback';
import { rememberStoppedBuild } from './stoppedBuild';
import { BLENDER_TEMPLATE, builtFrom, CIRCUIT_MAIN, DESIGN_FILES, fileLabel, filesOf, hasFiles, imagePath, isImage, keepsFiles, MAIN, modelBuiltFrom, opened, SHOP_FILES, sourceFiles, stored, tablePath, withComponent, withLink, withoutComponent, latestModelBuild, manufactureBuild, showsModel } from './design';
import { CIRCUIT_TEMPLATE } from '@/workspaces/electronics/template';
import * as THREE from 'three';
import { api, Api, ApiError, json, bodyMeshes, buildProgress, fetchTopology, forgetTopology, reachable, serverCapabilities, shopMetadata, withPrintMeshes, type Build, type CadDocument, type Kind, type LinkRef, type MeshResolution, type PackageDocument } from '@/lib/api';
import { ModelRuntime, loadGltf } from '@/viewport/model';
import { tween, viewer, VIEW_DIRECTIONS, type CameraPose } from '@/viewport/viewer';
import {
  buildFailureReport, get, hasContent, hasSourceEdits, hasUnsavedWork, initialDocState, isDirty, isNodeSeeThrough, isNodeVisible,isPreviewStale, nodeContains, patchDoc, readOnlyReason, readOnlyTitle, set, snapshot, toast, useApp,
  type AppState, type JobPhase, type Pick, type TreeNode,
} from './store';
import { bindWorkspaceData, loadWorkspaceData } from './workspaceData';
import { Branches, type GraphNode } from '@/lib/branches';
import { waitingLabel } from '@/lib/waiting';
import { progressLabel } from '@/lib/buildProgress';
import { clockFor, restartedLabel, runtimeText, type BuildClock } from '@/lib/restart';
import { historicalDocument, restoreRevision } from '@/lib/history';
import { openTab } from './tabs';
import { filedNew, folderForNew } from './newInFolder';
import { withShopLink } from '@/workspaces/manufacture/shop/shopCode';
import { accountKey, forgetShared } from './accountStorage';
import { displayDefaults } from '@/settings/store';
import { isStaleChunk, markDraftRestored, reloadForStaleChunk } from './updateWatch';
import { restorePanels, takeView } from './reloadView';
import { linkParams } from '@/lib/safeUrl';
import { zip } from '@/lib/zip';
import { openXlsx, tableFileKind, XLSX_LIMITS, XlsxProblem } from '@/lib/xlsx';
import { narrow } from './layout';
import { sheetMarkup } from '@/drawing/sheets';
import { printSheets } from '@/drawing/print';
import { showDrawingPreview } from '@/drawing/preview';
import { assemblyOrder, collectPackage, declaredOrder, type ProductPackage } from '@/drawing/package';
import { withWorkspace } from '@/teams/current';
import { stepFileFor, stepLabel, waitForStep } from './stepFile';

const DRAFT_KEY = 'steve-cad-draft';
let generation = 0;
/** A build started by the editor's live rebuild: its failure shows at the line, without a toast. */
let quietGeneration = -1;
/** A document being opened: navigation may leave it before its geometry has loaded (abandonQuietBuild). */
let openingGeneration = -1;
/** Opens that navigation left before they finished (boot then leaves the new document alone). */
let abandonedOpenings = 0;
/** Boot is restoring the last session's unsaved edits: the document they belong to finishes opening first. */
let holdOpening = false;
let examples: Record<string, string> = {};

/* ───────── Drafts: unsaved edits survive reloads (same format as the previous UI). ───────── */

interface Draft { code: string; name: string; kind: Kind; baseId?: string; documentId?: string; documentRevision?: number; branch?: string; files?: Record<string, string>; activeFile?: string; links?: Record<string, LinkRef> }

export function saveDraft() {
  const state = get();
  try {
    // A model rebuilt from the saved source isn't an edit: only changed source is kept (it carries its base revision).
    if (hasSourceEdits(state)) {
      const draft: Draft = { code: state.doc.code, name: state.doc.name, kind: state.doc.kind, baseId: state.doc.saved?.id ?? state.displayed?.id, documentId: state.doc.saved?.id, documentRevision: state.doc.saved?.revision, branch: state.doc.branch,
        ...(hasFiles(state.doc.kind) ? { files: state.doc.files, activeFile: state.doc.activeFile, links: state.doc.links } : {}),
        ...(state.doc.kind === 'part' ? { links: state.doc.links } : {}),
        ...(keepsFiles(state.doc.kind) ? { files: state.doc.files } : {}) };
      localStorage.setItem(accountKey(DRAFT_KEY), JSON.stringify(draft));
    } else forgetDraft();
  } catch { /* Storage is optional. */ }
}

export function forgetDraft() { try { localStorage.removeItem(accountKey(DRAFT_KEY)); } catch { /* Storage is optional. */ } }

function readDraft(): Draft | null {
  forgetShared(DRAFT_KEY);
  try { return JSON.parse(localStorage.getItem(accountKey(DRAFT_KEY)) || 'null') as Draft | null; } catch { return null; }
}

function setUrl(query: string) { history.replaceState(null, '', query ? `?${query}` : location.pathname); }
const documentQuery = (id: string, branch: string) => `document=${id}${branch !== 'main' ? `&branch=${encodeURIComponent(branch)}` : ''}`;

/* ───────── Job status ───────── */

/** `since`: the clock of the work it's a phase of (a followed build's, clockFor), kept whichever phase it moves to. */
function phase(value: JobPhase, label = '', since?: number) {
  set((state) => ({ phase: value, phaseLabel: label, phaseStarted: since ?? (value === state.phase && state.phaseStarted ? state.phaseStarted : Date.now()) }));
}

/** What a build is called while it runs and when it's done: a circuit is a board, a shop library records, not geometry.
 *  `build`: the finished build, for what it made (a shop's item count). */
function buildWords(kind = get().doc.kind, build: Build | null = get().displayed) {
  if (kind === 'shop') {
    const items = shopMetadata(build)?.records.length;
    return { queued: 'Waiting to build', running: 'Building the shop', loading: 'Reading the shop', ready: items === undefined ? 'Ready' : `Ready · ${items} ${items === 1 ? 'item' : 'items'}`, failed: 'Build failed' };
  }
  if (kind === 'blender') return { queued: 'Waiting for Blender', running: 'Building the scene in Blender', loading: 'Loading the scene', ready: 'Scene ready', failed: 'Build failed' };
  return kind === 'circuit'
    ? { queued: 'Waiting to build', running: 'Building the board', loading: 'Loading the board', ready: 'Board ready', failed: 'Build failed' }
    : { queued: 'Waiting for a geometry worker', running: 'Generating geometry', loading: 'Loading geometry', ready: 'Model ready', failed: 'Generation failed' };
}

/** An export's own step in the status bar (e.g. downloading its meshes), busy while it runs; null ends it. */
export function exportStatus(label: string | null, failed = false) {
  if (label !== null) {
    set({ busy: true });
    phase('running', label);
    return;
  }
  set({ busy: false });
  phase(failed ? 'failed' : 'succeeded', failed ? 'Export failed' : buildWords().ready);
}

// The last update failed (its source didn't build). Cleared by a build that shows, or by the source going back to what
// is on screen: then nothing is wrong any more (settleBuildFailure).
let buildFailed = false;

/** The source is back to what's on screen after a failed update (an undo, a revert): what's shown is current again. */
export function settleBuildFailure() {
  const state = get();
  if (!buildFailed || state.busy || state.phase !== 'failed' || !state.displayed || isPreviewStale(state)) return;
  buildFailed = false;
  set({ error: '', budgetFailure: null, runtimeInfo: state.displayed.finished_at ? runtimeText(state.displayed) : '' });
  phase('succeeded', buildWords().ready);
}

function busy(value: boolean, label?: string, kind: JobPhase = 'opening') {
  set({ busy: value });
  if (value) phase(kind, label);
}

/* ───────── Editing ───────── */

export function setCode(code: string) {
  // Every tool that rewrites the code comes through here; a circuit that's read-only on this server isn't changed.
  const locked = readOnlyReason(get());
  if (locked) { toast('info', readOnlyTitle(), locked); return; }
  patchDoc({ code }); saveDraft(); if (get().pastVersion) void leaveRevision();
}
export function setName(name: string) { patchDoc({ name }); saveDraft(); retitle(); if (get().pastVersion) void leaveRevision(); }
function retitle() {
  const { doc } = get();
  document.title = doc.open ? `${doc.name.trim() || 'Untitled'} — STEVE Studio` : 'STEVE Studio';
  const root = get().tree[get().rootId ?? ''];
  if (root && root.name !== doc.name) set((state) => ({ tree: { ...state.tree, [root.id]: { ...root, name: doc.name.trim() || 'Untitled' } } }));
}

/* ───────── Workspace lifecycle ───────── */

/** Drops the geometry on screen (the canvas shows its empty state); the document itself is unchanged. */
function clearModel(extra: Partial<AppState> = {}) {
  const previous = viewer.model;
  viewer.model = null;
  previous?.dispose();
  set({
    displayed: null, tree: {}, rootId: null, modelVersion: get().modelVersion + 1,
    selection: [], hover: null, hoverAlso: [], measurePicks: [], logs: '', error: '', runtimeInfo: '', busy: false, phase: 'idle', phaseLabel: '',
    ...extra,
  });
  viewer.notifyModel();
}

export function clearWorkspace() {
  ++generation;
  clearModel({
    doc: { ...initialDocState },
    activeFeature: null, features: null,
    section: { ...get().section, enabled: false }, tool: 'select', contextMenu: null, pickList: null, explode: 0, branches: null, graph: null, pastVersion: null, rollback: null,
  });
  loadWorkspaceData(null);
  forgetDraft();
  setUrl('empty=1');
  retitle();
}

export function newDocument(kind: Kind = 'part', name?: string) {
  clearWorkspace();
  set(displayDefaults());
  patchDoc({ open: true, kind, name: name ?? `Untitled ${kind}`, savedSnapshot: null,
    ...(kind === 'design' ? { code: DESIGN_FILES[MAIN], files: { ...DESIGN_FILES }, activeFile: MAIN, links: {} }
      : kind === 'shop' ? { code: SHOP_FILES[MAIN], files: { ...SHOP_FILES }, activeFile: MAIN, links: {} }
      // A circuit starts as a small board that builds clean, so every view shows something real at once.
      : kind === 'circuit' ? { code: CIRCUIT_TEMPLATE, files: {}, activeFile: CIRCUIT_MAIN, links: {} }
      // A Blender document starts as one small object, so the viewer shows the scene at once.
      : kind === 'blender' ? { code: BLENDER_TEMPLATE, files: {}, activeFile: MAIN, links: {} }
      : { files: {}, activeFile: MAIN, links: {} }) });
  // The Dock stays open or closed as the person left it (panels.ts); on a phone it would cover the new canvas.
  set({ ...(narrow() ? { dockOpen: false } : {}), dockTab: kind === 'circuit' ? 'properties' : 'source' });
  setUrl('new=1');
  saveDraft();
  retitle();
}

/** Runs an action that replaces the open design, asking first when there are unsaved edits. */
export function leave(action: () => void) {
  if (get().busy) return;
  if (!hasUnsavedWork()) { action(); return; }
  set({ dialog: 'unsaved', pendingLeave: action });
}

/** Saves the open document as its next revision; `message` says what that revision is (the version history shows it). */
export async function saveDocument(message?: string): Promise<boolean> {
  const state = get();
  if (!state.doc.open || state.busy) return false;
  const locked = readOnlyReason(state);
  if (locked) { toast('info', readOnlyTitle(), locked); return false; }
  if (state.doc.saved && !isDirty(state)) { toast('success', 'Already saved', `${state.doc.name} is saved on this device.`); return true; }
  const source = stored(state.doc);
  const marked = Object.entries(source.files).concat([[MAIN, source.code]]).find(([, text]) => /^(<<<<<<<|>>>>>>>) /m.test(text));
  if (marked) { toast('warning', 'Resolve the marked conflicts first', `${fileLabel(marked[0])} still has <<<<<<< / >>>>>>> markers: keep one side (or both) and delete the markers, then save.`); return false; }
  busy(true, 'Saving', 'saving');
  try {
    const { doc, displayed } = get();
    const body = { name: doc.name.trim() || 'Untitled', kind: doc.kind, ...stored(doc), preview_build_id: state.pastVersion ? state.pastVersion.returnBuildId : displayed?.id ?? null };
    const saved = doc.saved && doc.branch !== 'main'
      ? await Branches.update(doc.saved.id, doc.branch, { ...body, revision: doc.saved.revision, ...(message ? { message } : {}) })
      : doc.saved
        ? await Api.updateDocument(doc.saved.id, { ...body, revision: doc.saved.revision, ...(message ? { message } : {}) })
        : await Api.createDocument({ ...body, folder_id: folderForNew(state.activeTab), ...(message ? { message } : {}) });
    if (!doc.saved) filedNew(state.activeTab);
    patchDoc({ saved, name: saved.name });
    patchDoc({ savedSnapshot: snapshot() });
    bindWorkspaceData(saved.id);
    setUrl(documentQuery(saved.id, get().doc.branch));
    saveDraft();
    set({ busy: false });
    phase('succeeded', 'Saved');
    toast('success', 'Saved', `${saved.name}${get().doc.branch !== 'main' ? ` · ${get().doc.branch}` : ''} · revision ${saved.revision}`);
    // A shop's build is already full (nothing to promote): the saved revision's items go into the library.
    if (saved.kind === 'shop') void applyShopBuild();
    else void promoteSaved();
    return true;
  } catch (error) {
    set({ busy: false });
    phase('failed', 'Save failed');
    const conflict = error instanceof ApiError && error.status === 409 && !/keeps its type|kind_change/.test(`${error.code} ${error.message}`);
    // Saved meanwhile by STEVE or another window: offer to combine, keep, or take the latest (never a dead end).
    if (conflict) set({ dialog: 'conflict' });
    else toast('danger', 'Couldn’t save', `${(error as Error).message} Your edits are still here.`);
    return false;
  }
}

/** A rename saved elsewhere (the Open dialog): the open, unedited design takes the new name and revision. */
export function adoptRename(saved: CadDocument) {
  const { doc } = get();
  if (doc.saved?.id !== saved.id || doc.branch !== 'main' || isDirty()) return;
  patchDoc({ saved: { ...doc.saved, ...saved }, name: saved.name });
  patchDoc({ savedSnapshot: snapshot() });
  saveDraft();
  retitle();
  void refreshBranches();
}

export interface OpenOptions { pose?: CameraPose | null; stash?: DocStash | null }

/** How an open ended: `missing` is a design (or branch) that no longer exists here, not one in the Trash or a passing failure. */
export type OpenOutcome = 'opened' | 'missing' | 'failed';

export async function openDocument(id: string, branch = 'main', options: OpenOptions = {}): Promise<OpenOutcome> {
  const keepTab = get().leftTab;
  clearWorkspace();
  // A design opens the way Settings → Display says; back in its tab, it looks as it was left.
  set({ leftTab: keepTab, ...(options.stash ? {} : displayDefaults()) });
  const gen = generation;
  if (!holdOpening) openingGeneration = gen;
  busy(true, branch === 'main' ? 'Opening design' : `Opening ${branch}`);
  let found = false;
  try {
    const doc: CadDocument = branch === 'main' ? await Api.document(id) : await Branches.read(id, branch);
    found = true;
    if (gen !== generation) return 'failed';
    if (doc.kind === 'shop' || doc.kind === 'cam') {
      // Kept as documents, worked in Manufacture: the shop on its page, a CAM program with its part. Never a file here.
      set({ busy: false });
      phase('idle', '');
      setUrl('');
      void import('@/workspaces/manufacture/cam/camDoc').then(({ openStored }) => setTimeout(() => void openStored(doc), 0));
      return 'opened';
    }
    patchDoc({ open: true, branch, saved: doc, name: doc.name, kind: doc.kind, ...opened(doc) });
    loadWorkspaceData(doc.id);
    retitle();
    // A preview whose files were cleared (retired) is no geometry: the document opens without it and builds it again.
    let shown = false;
    if (doc.preview_build_id) {
      const build = await Api.build(doc.preview_build_id);
      if (gen !== generation) return 'failed';
      if (!build.retired_at) {
        await showBuild(build, gen, true, options.pose ?? null);
        shown = true;
      }
    }
    if (gen !== generation) return 'failed';
    patchDoc({ savedSnapshot: snapshot() });
    setUrl(documentQuery(id, branch));
    if (options.stash && await restoreEdits(options.stash, gen) === 'unknown') {
      toast('warning', 'Check your unsaved edits', `They were kept from an earlier session and may be older than revision ${doc.revision}. Save them only if they’re what you want.`, {
        sticky: true, action: { label: 'Use the latest', run: () => leave(() => void openDocument(id, branch)) } });
    }
    if (gen !== generation) return 'failed';
    saveDraft();
    set({ busy: false });
    phase(shown ? 'succeeded' : 'idle', shown ? buildWords(doc.kind).ready : '');
    if (!doc.code.trim()) set({ dockTab: 'source' });
    return 'opened';
  } catch (error) {
    if (gen !== generation) return 'failed';
    set({ busy: false });
    phase('failed', 'Open failed');
    // Deleted (in another window, or before this tab was restored): it can come back from the Trash.
    const trashed = error instanceof ApiError && error.code === 'document_in_trash';
    // Gone for good (deleted permanently, or never in this workspace): callers close what still points at it (tabs.ts).
    // A passing failure (offline, a server error) or another workspace's switch isn't missing.
    const missing = !found && !trashed && error instanceof ApiError && error.status === 404 && error.code !== 'workspace_not_found';
    if (missing) toast('danger', 'This design isn’t here any more', branch === 'main' ? 'It was deleted permanently, or it isn’t in this workspace.' : (error as Error).message);
    else toast('danger', trashed ? 'This design is in the Trash' : 'Couldn’t open this design', (error as Error).message, trashed ? { action: { label: 'Restore it', run: () => {
      void import('./trash').then(({ restoreFromTrash }) => restoreFromTrash([{ id, name: '' }])).then((ids) => { if (ids.length) void openDocument(id, branch, options); });
    } } } : {});
    return missing ? 'missing' : 'failed';
  } finally {
    if (openingGeneration === gen) openingGeneration = -1;
  }
}

/** Replaces the open document with a server-verified revision and its geometry, keeping the camera. */
export async function applyDocumentRevision(doc: CadDocument, build: Build | null, branch = get().doc.branch) {
  const gen = ++generation;
  set({ pastVersion: null });
  // A design stays on the file being edited when that file still exists.
  const keep = hasFiles(doc.kind) && hasFiles(get().doc.kind) && (doc.files?.[get().doc.activeFile] !== undefined || get().doc.activeFile === MAIN) ? get().doc.activeFile : MAIN;
  const fields = opened(doc);
  patchDoc({ open: true, branch, saved: doc, name: doc.name, kind: doc.kind, ...fields, ...(keep !== MAIN ? { activeFile: keep, code: fields.files[keep] } : {}) });
  if (build && build.status !== 'succeeded') {
    // A restored revision is saved even when it doesn't build (any more): its build is followed like any other, so a
    // failure shows in Source and one still running carries on.
    patchDoc({ savedSnapshot: snapshot() });
    setUrl(documentQuery(doc.id, branch));
    saveDraft();
    retitle();
    void watchBuild(build.id, gen, false, `Revision ${doc.revision}`).catch((error) => {
      if (gen !== generation) return;
      set({ busy: false, error: (error as Error).message });
      phase('failed', buildWords(doc.kind).failed);
    });
    return;
  }
  if (build) {
    set({ busy: true });
    phase('loading', buildWords(doc.kind).loading);
    try { await showBuild(build, gen, false); }
    finally { set({ busy: false }); }
  }
  if (gen !== generation) return;
  patchDoc({ savedSnapshot: snapshot() });
  setUrl(documentQuery(doc.id, branch));
  saveDraft();
  retitle();
  phase('succeeded', buildWords(doc.kind).ready);
  if (build) void applyShopBuild();
}

export async function openBuild(id: string) {
  clearWorkspace();
  const gen = generation;
  if (!holdOpening) openingGeneration = gen;
  busy(true, 'Opening model');
  try {
    const build = await Api.build(id);
    if (gen !== generation) return;
    if (manufactureBuild(build)) {
      // A shop's or CAM program's build has no model: it's worked in Manufacture, never opened here.
      set({ busy: false });
      phase('idle', '');
      toast('info', 'This build belongs to Manufacture', 'Open its program or shop from the Manufacture workspace.');
      return;
    }
    patchDoc({ open: true, name: build.name, kind: build.kind, ...opened({ kind: build.kind, code: build.code ?? '', files: build.files, links: build.links }) });
    retitle();
    if (!showsModel(build)) {
      // A sheet build (a link to one, a tab left on one) has no 3D model: open its source and build the model from it.
      if (!get().doc.saved) patchDoc({ savedSnapshot: snapshot() });
      set({ busy: false });
      await updateModel();
      return;
    }
    await watchBuild(build.id, gen, true);
    if (gen === generation && !get().doc.saved) patchDoc({ savedSnapshot: snapshot() });
  } catch (error) {
    if (gen !== generation) return;
    set({ busy: false });
    phase('failed', 'Open failed');
    toast('danger', 'Couldn’t open this model', (error as Error).message);
  } finally {
    if (openingGeneration === gen) openingGeneration = -1;
  }
}

/* ───────── Geometry generation ───────── */

/** `force`: build this exact source again even if it used its whole budget before (the person asked: Rebuild anyway). */
export async function updateModel(options: { quiet?: boolean; force?: boolean } = {}) {
  const state = get();
  if (state.busy || !state.doc.open) return;
  const locked = readOnlyReason(state);
  if (locked) { if (!options.quiet) toast('info', readOnlyTitle(true), locked); return; }
  if (!hasContent(state)) {
    // Starter code only (a new part or design), or everything was deleted: nothing to build, which isn't an error.
    // The canvas shows its empty state; a build would only fail with "no geometry yet".
    ++generation;
    if (state.displayed) clearModel();
    else if (!options.quiet) toast('info', 'Nothing to generate yet', state.doc.kind === 'design' ? 'Add a component, link a saved part, or ask STEVE.' : state.doc.kind === 'shop' ? 'Add a machine, controller or tool to the shop (shop.add), or ask STEVE.' : 'Sketch and extrude, add a primitive, write CadQuery, or ask STEVE.');
    return;
  }
  const gen = ++generation;
  quietGeneration = options.quiet ? gen : -1;
  saveDraft();
  set({ busy: true, error: '', budgetFailure: null, logs: '', runtimeInfo: '', pastVersion: null });
  phase('queued', 'Submitting');
  try {
    const { doc } = get();
    // Interactive updates use the fast preview lane; saving and exporting fetch the full build.
    // Rolled back on the timeline: later features are suppressed in what is built (never in what is saved).
    const code = await buildCode(doc.code);
    if (code === null) { set({ busy: false }); phase('succeeded', 'No solid yet at this step'); return; }
    const body = { kind: doc.kind, name: doc.name.trim() || 'Untitled', ...stored({ ...doc, code }), mode: 'preview' as const };
    const id = await editPreview(body, () => Api.submit(body, options.force).then((build) => build.id), options.force);
    await watchBuild(id, gen, !viewer.model);
  } catch (error) {
    if (gen !== generation) return;
    set({ busy: false, error: (error as Error).message });
    buildFailed = true;
    phase('failed', 'Couldn’t submit');
    toast('danger', 'Couldn’t update the model', (error as Error).message);
  } finally {
    // Done: a later operation (a save) is never mistaken for this rebuild and abandoned.
    if (quietGeneration === gen) quietGeneration = -1;
  }
}

/** Polls a build; transient network or server errors (e.g. a redeploy) are retried for a while. */
async function pollBuild(id: string, gen: number): Promise<Build | null> {
  const deadline = Date.now() + 45_000;
  for (let attempt = 0; ; attempt++) {
    try { return await Api.build(id); }
    catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      if ((status && status < 500) || Date.now() > deadline || gen !== generation) throw error;
      phase(get().phase, 'Reconnecting to the model service');
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 4000)));
    }
  }
}

let streamFailed = false;

/**
 * Waits until the server reports a status other than `status`: pushed over the build's event
 * stream when the server has one, else after a short poll interval.
 */
async function statusChange(id: string, status: string, gen: number, named = (words: string) => words): Promise<void> {
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 650));
  if (streamFailed || typeof EventSource === 'undefined' || !(await serverCapabilities()).buildEvents) return pause();
  return new Promise<void>((resolve) => {
    const source = new EventSource(`/v1/builds/${id}/events`);
    const finish = () => { source.close(); clearTimeout(limit); clearInterval(check); resolve(); };
    const limit = setTimeout(finish, 20_000);
    const check = setInterval(() => { if (gen !== generation) finish(); }, 400);
    source.addEventListener('build', (event) => {
      try {
        const build = JSON.parse((event as MessageEvent).data) as { status: Build['status']; waiting?: Build['waiting']; metadata?: Build['metadata']; restarts?: number; restarted_reason?: string | null };
        if (build.status !== status) finish();
        // Still queued, with a new reason or place in the queue.
        else if (status === 'queued' && build.waiting && gen === generation) phase('queued', named(restartedLabel(build, waitingLabel(build.waiting, buildWords().queued))));
        // Still running: what it is doing now (its stage and count).
        else if (status === 'running' && gen === generation) phase('running', named(restartedLabel(build, progressLabel(buildProgress(build), buildWords().running))));
      } catch { finish(); }
    });
    source.addEventListener('end', finish);
    source.onerror = () => { streamFailed = true; source.close(); clearTimeout(limit); clearInterval(check); void pause().then(resolve); };
  });
}

/** The latest edit's own preview while it's in flight, and the document and source it builds (editPreview). */
let inFlightEdit: { id: string; owner: string; source: string } | null = null;

/** Watches a build until it's shown or fails. Its clock runs once through queued, running, restarts and loading
 *  (clockFor); `what`: which build it is, before its words ("Revision 25"), when it isn't the person's own edit. */
async function watchBuild(id: string, gen: number, reframe: boolean, what = '') {
  if (gen === generation) set({ buildInFlight: id });
  try { await followBuild(id, gen, reframe, what); }
  finally { if (get().buildInFlight === id) set({ buildInFlight: null }); }
}

/** What a build the person stopped says (app/main.py CANCELLED). */
const CANCELLED = 'Stopped: you cancelled it.';

/** Stops the build the status bar follows: the server stops it unless someone else still waits for it, in which
 *  case it carries on for them. The source and the saved revision are untouched; the last good model stays shown. */
export async function stopBuild() {
  const state = get();
  const id = state.buildInFlight;
  if (!id) return;
  try {
    const result = await Api.stopBuild(id);
    rememberStoppedBuild(state);
    if (result.stop === 'kept') toast('info', 'It carries on for someone else', 'Another tab, person or share is waiting for this build, so it keeps running. Your previous model stays shown.');
    else if (result.stop === 'stopping') phase('running', 'Stopping…');
  } catch (error) {
    toast('danger', 'Couldn’t stop the build', (error as Error).message);
  }
}

async function followBuild(id: string, gen: number, reframe: boolean, what: string) {
  // A build abandoned while it was being submitted (abandonQuietBuild, e.g. a tab switch) must not mark the app busy
  // again: nothing would ever clear it.
  if (gen !== generation) return;
  set({ busy: true });
  let clock: BuildClock | null = null;
  const named = (words: string) => (what ? `${what} · ${words}` : words);
  while (gen === generation) {
    const build = await pollBuild(id, gen);
    if (build && (build.status === 'succeeded' || build.status === 'failed') && inFlightEdit?.id === id) inFlightEdit = null;
    if (!build || gen !== generation) return;
    clock = clockFor(clock, build);
    // The engine and its version are credited (and linked) at the right of the status bar.
    set({ runtimeInfo: runtimeText(build) });
    if (build.status === 'succeeded') {
      set({ logs: build.logs ?? '', error: '' });
      phase('loading', named(buildWords().loading), clock.started);
      const previous = get().displayed;
      try {
        await showBuild(build, gen, reframe);
        if (gen !== generation) return;
        settleSavedModel(previous);
        buildFailed = false;
        phase('succeeded', buildWords().ready);
        saveDraft();
        void applyShopBuild();
      } catch (error) {
        if (gen !== generation) return;
        phase('failed', 'Preview failed');
        toast('danger', 'The 3D preview could not open', (error as Error).message);
      }
      set({ busy: false });
      return;
    }
    if (build.status === 'failed' && build.error === CANCELLED) {
      // The person stopped it: not a failure. The previous model stays; nothing rebuilds it until they ask.
      set({ busy: false, error: '' });
      phase('idle', 'Stopped');
      return;
    }
    if (build.status === 'failed') {
      const error = build.error || build.logs || 'No diagnostic details.';
      set({ busy: false, error, logs: build.logs ?? '' });
      if (build.failure) {
        // It used its whole budget: the same source would end the same way, so it isn't built again by itself.
        set({ budgetFailure: build.failure });
        buildFailed = true;
        const { cause, budget_s: budget, stage } = build.failure;
        phase('failed', cause === 'time' ? 'Ran out of time' : 'Ran out of memory');
        toast('warning', cause === 'time' ? `This model needs more than ${budget ?? ''} s to build` : 'This model needs more memory than a build has',
          `${stage ? `It stopped during ${stage}. ` : ''}${viewer.model ? 'Your previous geometry is still shown. ' : ''}It won’t be rebuilt by itself until the source changes: make it lighter, or rebuild it as it is.`, {
            action: { label: 'Rebuild anyway', run: () => void updateModel({ force: true }) },
            sticky: true,  // Stays until read: the next build only happens if someone acts on it.
          });
        return;
      }
      buildFailed = true;
      phase('failed', buildWords().failed);
      const title = viewer.model ? 'Couldn’t update the model' : 'Couldn’t create the model';
      if (gen !== quietGeneration) toast('danger', title, viewer.model ? 'Your previous geometry is still shown. See diagnostics in Source.' : 'See diagnostics in Source.', {
        action: { label: 'Show diagnostics', run: () => set({ dockOpen: true, dockTab: 'source' }) },
        report: `${title}\n${buildFailureReport(error)}`,  // The error itself, so the report says what went wrong.
      });
      return;
    }
    phase(build.status, named(restartedLabel(build, build.status === 'queued' ? waitingLabel(build.waiting, buildWords().queued) : progressLabel(buildProgress(build), buildWords().running))), clock.started);
    await statusChange(id, build.status, gen, named);
  }
}

/**
 * The build for an edit's preview. A newer edit of the same document replaces the one still in flight: it's dropped on
 * the server, so the new preview never queues behind work nobody will see. Leaving it (a tab switch, opening another
 * document) doesn't: the server finishes it, so coming back hits the cache; coming back to the same source waits for it.
 */
async function editPreview(body: object, submit: () => Promise<string>, force = false): Promise<string> {
  const { doc, activeTab } = get();
  const owner = `${activeTab ?? ''}|${doc.saved?.id ?? ''}|${doc.branch}`;
  const source = JSON.stringify({ ...body, name: '' });
  const previous = inFlightEdit?.owner === owner ? inFlightEdit : null;
  if (previous?.source === source && !force) return previous.id;
  if (previous) { inFlightEdit = null; void Api.cancelBuild(previous.id); }
  const id = await submit();
  inFlightEdit = { id, owner, source };
  return id;
}

let previewRun = 0;
/** A candidate preview being built: its build and the source it builds (rolled back as the timeline is). */
type PreviewInFlight = { id: string; code: string };
let previewInFlight: PreviewInFlight | null = null;  // The candidate preview being built, until it finishes.

/** Ends the candidate preview in flight: its result won't be shown, so it's dropped rather than left holding (or
 *  queueing for) a geometry worker ahead of the preview that replaces it. */
function replacePreview() {
  ++previewRun;
  if (previewInFlight) void Api.cancelBuild(previewInFlight.id);
  previewInFlight = null;
}

/**
 * Builds candidate code (a feature being edited) and shows it without touching the design.
 * Resolves to the build, or null when superseded by a newer preview. `show: false` only builds it (checked, not
 * displayed): the extrude dialog keeps its transparent preview over the geometry from before the feature.
 */
export async function previewCode(code: string, { show = true, applyRollback = true }: { show?: boolean; applyRollback?: boolean } = {}): Promise<Build | null> {
  replacePreview();
  const run = previewRun;
  const state = get();
  const rolled = applyRollback ? await buildCode(code) : code;
  if (rolled === null) return null;
  const build = await Api.submit({ kind: state.doc.kind, name: state.doc.name.trim() || 'Untitled', ...stored({ ...state.doc, code: rolled }), mode: 'preview' });
  let current = build;
  if (current.status !== 'succeeded' && current.status !== 'failed') {
    if (run !== previewRun) { void Api.cancelBuild(current.id); return null; }  // Replaced while it was being submitted.
    previewInFlight = { id: current.id, code: rolled };
  }
  while (current.status !== 'succeeded' && current.status !== 'failed') {
    await statusChange(current.id, current.status, generation);
    if (run !== previewRun) return null;
    current = await Api.build(current.id);
  }
  if (previewInFlight?.id === current.id) previewInFlight = null;
  // A cache hit answers the submit with the finished build but without its source; fetch it whole.
  if (current.code === undefined) current = await Api.build(current.id);
  // Superseded, or a real update started meanwhile (it owns the display and the busy state): don't show it.
  if (run !== previewRun || get().busy) return null;
  if (current.status === 'succeeded' && show) {
    const gen = ++generation;
    // Frame the first solid just as a normal first build does. Later previews
    // keep the person's view instead of zooming on every dimension change.
    await showBuild(current, gen, false, viewer.model ? viewer.capturePose() : null);
  }
  return current;
}

/** Shows a preview built with `show: false` (the feature committed as previewed), keeping the camera. False when it wasn't shown. */
export async function showPreview(build: Build): Promise<boolean> {
  if (get().busy) return false;
  const gen = ++generation;
  try { await showBuild(build, gen, false, viewer.capturePose()); } catch { return false; }
  return gen === generation && get().displayed?.id === build.id;
}

/** Stops the candidate preview in flight from being shown but leaves it running: the code about to be committed may be
 *  exactly what it builds. Hand what it returns to releasePreview once that code is known. */
export function holdPreview(): PreviewInFlight | null {
  ++previewRun;
  const held = previewInFlight;
  previewInFlight = null;
  return held;
}

/**
 * Keeps a held preview only if it builds exactly what the update of `code` will (null: no update follows): that
 * update's submit joins it instead of the preview being dropped and the same source built again (dropping it first
 * failed the update as superseded). Any other preview is dropped.
 */
export async function releasePreview(held: PreviewInFlight | null, code: string | null) {
  if (!held) return;
  const rolled = code === null ? null : await buildCode(code);
  if (rolled !== held.code) void Api.cancelBuild(held.id);
}

/** The displayed build again, with the selection data (topology) completed since it was shown; the camera stays. */
export async function refreshSelectionData(buildId: string) {
  if (get().displayed?.id !== buildId) return;
  try {
    const build = await Api.build(buildId);
    forgetTopology(build);
    const gen = ++generation;
    await showBuild(build, gen, false, viewer.capturePose(), true);
  } catch { /* The next update redraws. */ }
}

/** Puts back the geometry that was showing before a preview. */
export async function restoreDisplayed(buildId: string | null) {
  replacePreview();
  if (!buildId) {
    // Cancelling the first feature restores an empty viewport, including when
    // Live rebuild is off. Do not rely on an automatic rebuild to clear it.
    ++generation;
    clearModel();
    setUrl(get().doc.saved ? documentQuery(get().doc.saved!.id, get().doc.branch) : 'new=1');
    return;
  }
  if (get().displayed?.id === buildId) return;
  const gen = ++generation;
  try { await showBuild(await Api.build(buildId), gen, false, viewer.capturePose()); } catch { /* The next update redraws. */ }
}

/**
 * Shows a build of the open document that finished on its own (a circuit's routing build), keeping the camera. Not
 * while an update is in flight (it would be replaced); false when it wasn't shown.
 */
export async function showFinishedBuild(build: Build): Promise<boolean> {
  if (get().busy || !builtFrom(build, get().doc)) return false;
  const gen = ++generation;
  try { await showBuild(build, gen, false, viewer.capturePose()); } catch { return false; }
  if (gen !== generation) return false;
  set({ logs: build.logs ?? '', error: '' });
  buildFailed = false;
  phase('succeeded', buildWords().ready);
  return true;
}

/** A build whose files build retention cleared after a while unused (Build.retired_at): its source builds again. */
class RetiredBuild extends Error {
  constructor() { super('Its geometry was cleared after a while unused. Generate it again to see it.'); }
}

/** Loads a build's geometry and cross-fades it in, keeping the camera unless reframing. */
async function showBuild(build: Build, gen: number, reframe: boolean, pose: CameraPose | null = null, force = false) {
  if (get().displayed?.id === build.id && !force) {
    // Already shown; but a copy shown without its source (a cache hit) takes the whole build, so it matches its document.
    if (get().displayed?.code === undefined && build.code !== undefined) set({ displayed: build });
    return;
  }
  if (build.metadata?.empty || build.kind === 'shop') {
    // Nothing modelled yet: no geometry to show. The build is current (no "not generated" banner) and the canvas
    // shows its empty state; the document's components and sketches come from the source as usual. A shop never has
    // geometry: its build lists library records (its output stays in the logs).
    clearModel({ displayed: build, ...(build.kind === 'shop' ? { logs: build.logs ?? '' } : {}) });
    setUrl(get().doc.saved ? documentQuery(get().doc.saved!.id, get().doc.branch) : `model=${build.id}`);
    retitle();
    return;
  }
  if (build.retired_at) throw new RetiredBuild();
  if (!build.artifacts.preview) throw new Error('This build has no preview geometry.');
  const [gltf, topology] = await Promise.all([loadGltf(build.artifacts.preview), fetchTopology(build)]);
  if (gen !== generation) return;
  const state = get();
  const runtime = new ModelRuntime(gltf, build, topology, state.doc.name.trim() || build.name);
  const previous = viewer.model;
  carryTreeState(state, runtime.tree);
  runtime.setStyle(state.style, state.theme);
  runtime.applyVisibility(runtime.tree);
  runtime.setFade(0);
  viewer.outgoing = previous;
  viewer.model = runtime;
  if (state.explode) runtime.setExplode(state.explode);
  set({ displayed: build, tree: runtime.tree, rootId: runtime.rootId, modelVersion: state.modelVersion + 1, selection: [], hover: null, hoverAlso: [], measurePicks: [] });
  viewer.notifyModel();
  setUrl(state.doc.saved ? documentQuery(state.doc.saved.id, state.doc.branch) : `model=${build.id}`);
  retitle();
  if (pose) viewer.applyPose(pose);
  else if (reframe || !previous) introCamera();
  await tween(reframe ? 620 : 420, (t) => { runtime.setFade(t); previous?.setFade(1 - t); });
  if (viewer.outgoing === previous) {
    previous?.dispose();
    viewer.outgoing = null;
    viewer.notifyModel();
  }
}

/** A short swing-in so a newly opened model settles into view instead of popping. */
function introCamera() {
  const controls = viewer.controls;
  if (!controls) return;
  const iso = new THREE.Vector3(...VIEW_DIRECTIONS.iso).normalize();
  const start = iso.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), -0.42);
  start.z += 0.18;
  viewer.frame(null, start, false);
  if (viewer.camera instanceof THREE.OrthographicCamera) void controls.zoomTo(viewer.camera.zoom * 0.72, false);
  requestAnimationFrame(() => viewer.setView('iso', true));
}

function carryTreeState(state: AppState, next: Record<string, TreeNode>) {
  const path = (tree: Record<string, TreeNode>, node: TreeNode): string => {
    const parts: string[] = [];
    for (let current: TreeNode | undefined = node; current && current.parent; current = tree[current.parent]) parts.unshift(current.name);
    return parts.join('/');
  };
  const previous = new Map(Object.values(state.tree).map((node) => [path(state.tree, node), node]));
  for (const node of Object.values(next)) {
    const old = previous.get(path(next, node));
    if (old && node.type !== 'document') { node.hidden = old.hidden; node.expanded = old.expanded; if (old.seeThrough) node.seeThrough = true; }
  }
}

/* ───────── Examples ───────── */

export function getExamples() { return examples; }

/** Fills the open document with a sample: the mounting plate (a part) or the spacer stack (a design whose main.py builds its own assembly). */
export function loadExample(name: 'plate' | 'design') {
  const source = examples[name];
  if (!source) return;
  const kind: Kind = name === 'design' ? 'design' : 'part';
  const { doc } = get();
  if (doc.saved && doc.saved.kind !== kind) { toast('warning', 'Different document type', 'Create a new document to use this sample.'); return; }
  if (!doc.open) newDocument(kind);
  patchDoc({ open: true, kind, code: source, files: {}, activeFile: MAIN, links: {}, name: doc.saved ? doc.name : kind === 'design' ? 'Spacer stack' : 'Mounting plate' });
  saveDraft();
  retitle();
}

/** Opens a reference design (examples/modeling) in a new tab and generates it. */
export async function openReferenceModel(id: string) {
  const { examples: list } = await Api.exampleCatalog();
  const item = list.find((example) => example.id === id);
  if (!item) return;
  const { openTab: open } = await import('./tabs');
  open({ kind: item.kind, name: item.name });
  // A design sample brings its other files (params.py, components/*.py) with main.py.
  patchDoc(item.kind === 'design' ? { code: item.code, files: item.files ?? {}, activeFile: MAIN } : { code: item.code });
  saveDraft();
  void updateModel();
}

/* ───────── Visibility ───────── */

function updateTree(mutate: (tree: Record<string, TreeNode>) => void) {
  const tree = Object.fromEntries(Object.entries(get().tree).map(([id, node]) => [id, { ...node }]));
  mutate(tree);
  set({ tree });
}

export function toggleHidden(id: string) {
  updateTree((tree) => {
    const node = tree[id];
    if (!node) return;
    const visible = !node.hidden && ancestorsVisible(tree, id);
    if (visible) node.hidden = true;
    else for (let current: TreeNode | undefined = node; current; current = current.parent ? tree[current.parent] : undefined) current.hidden = false;
  });
}

const ancestorsVisible = (tree: Record<string, TreeNode>, id: string) => {
  const parent = tree[id]?.parent;
  return !parent || isNodeVisible(tree, parent);
};

export function hideNodes(ids: string[]) { updateTree((tree) => ids.forEach((id) => { if (tree[id] && tree[id].type !== 'document') tree[id].hidden = true; })); }
/** Hides the nodes when all of them show, otherwise shows the hidden ones (and their hidden ancestors). */
export function toggleNodes(ids: string[]) {
  if (ids.every((id) => isNodeVisible(get().tree, id))) { hideNodes(ids); return; }
  for (const id of ids) if (get().tree[id] && !isNodeVisible(get().tree, id)) toggleHidden(id);
}
export function showAll() { updateTree((tree) => Object.values(tree).forEach((node) => { node.hidden = false; })); set({ hiddenBodies: [] }); }
export function isolate(ids: string[]) {
  if (!ids.length) return;
  updateTree((tree) => {
    for (const node of Object.values(tree)) {
      if (node.type === 'document') continue;
      node.hidden = !ids.some((id) => nodeContains(tree, id, node.id) || nodeContains(tree, node.id, id));
    }
  });
  requestAnimationFrame(() => viewer.fit(true));
}
/** Makes the nodes see-through when any of them is drawn solid, otherwise solid again (their components too). */
export function toggleSeeThrough(ids: string[]) {
  const nodes = ids.filter((id) => get().tree[id] && get().tree[id].type !== 'document');
  if (!nodes.length) return;
  const solid = nodes.some((id) => !isNodeSeeThrough(get().tree, id));
  updateTree((tree) => {
    for (const id of nodes) {
      if (solid) { tree[id].seeThrough = true; continue; }
      for (let current: TreeNode | undefined = tree[id]; current; current = current.parent ? tree[current.parent] : undefined) current.seeThrough = false;
    }
  });
}
export function allOpaque() { updateTree((tree) => Object.values(tree).forEach((node) => { node.seeThrough = false; })); }
export function toggleExpanded(id: string) { updateTree((tree) => { if (tree[id]) tree[id].expanded = !tree[id].expanded; }); }
export function expandNodes(ids: string[]) { if (ids.length) updateTree((tree) => { for (const id of ids) if (tree[id]) tree[id].expanded = true; }); }

export const selectionNodes = (selection: Pick[] = get().selection) => [...new Set(selection.map((pick) => pick.node))].filter((id) => get().tree[id]?.type !== 'document');

export function zoomToSelection() {
  const model = viewer.model;
  if (!model) return;
  const selection = get().selection;
  if (!selection.length) { viewer.fit(true); return; }
  const box = new THREE.Box3();
  for (const pick of selection) {
    if (pick.kind === 'face') box.union(model.pickBox([pick]));
    else box.union(model.bounds(true, pick.node));
  }
  viewer.zoomTo(box);
}

/* ───────── Export ───────── */

/** The full build for what's displayed, generating it when only a preview exists. Its STEP file is made separately, only
 *  when an export asks for it (stepFileFor). */
export async function fullBuildFor(build: Build, fresh = false): Promise<Build> {
  if (build.mode === 'full' && build.status === 'succeeded' && !fresh) return build;
  const state = get();
  return fullBuildOf({ kind: build.kind, name: build.name, code: build.code ?? stored(state.doc).code, files: build.files ?? stored(state.doc).files,
    links: build.links ?? stored(state.doc).links });
}

/** The full build of a source, waited for: an identical one already made is reused (the build cache). */
async function fullBuildOf(source: SheetSource): Promise<Build> {
  let full = await Api.submit({ ...source, mode: source.kind === 'blender' ? 'save' : 'full' });
  // A dropped connection while waiting doesn't end the wait: the build carries on on the server (lib/api reachable).
  while (full.status !== 'succeeded' && full.status !== 'failed') {
    await statusChange(full.id, full.status, generation);
    full = await reachable(() => Api.build(full.id));
  }
  if (full.status === 'failed') throw new Error(full.error?.trim().split('\n').pop() || 'The full build failed.');
  // A cache hit answers the submit with the finished build but without its source. Shown like that (Manufacture's
  // ensureNamedGeometry), it would never match the open document (builtFrom), and the automatic build would ask again
  // forever; fetch it whole.
  if (full.code === undefined) full = await reachable(() => Api.build(full.id));
  return full;
}

/** A source the Drawing tab draws (drawingBuildFor): a part's or design's code, files and links as stored. */
export type SheetSource = { kind: Build['kind']; name: Build['name'] } & ReturnType<typeof stored>;

/** The sheet build of each source asked for (the latest few), and the one in flight for each document. */
const sheetBuilds = new Map<string, Promise<Build>>();
const sheetsInFlight = new Map<string, { id: string; key: string }>();

/**
 * The drawing sheets of `source`: a build of mode "drawing", which runs the code once and draws only its sheets (no
 * model, STEP or meshes), on the interactive lane; the same source again is answered by it (or by the build cache). A
 * drawing edit isn't a model edit, so the Drawing tab asks for this instead of a preview and a full build. Like an
 * edit's preview (editPreview), a newer source of the same document (`owner`) drops the one still in flight on the
 * server: its promise rejects, and the latest code wins.
 */
export function drawingBuildFor(source: SheetSource, owner: string): Promise<Build> {
  const key = JSON.stringify({ ...source, name: '' });
  const known = sheetBuilds.get(key);
  if (known) return known;
  const previous = sheetsInFlight.get(owner);
  if (previous && previous.key !== key) {
    sheetsInFlight.delete(owner);
    sheetBuilds.delete(previous.key);
    void Api.cancelBuild(previous.id);
  }
  const request = (async () => {
    let build = await Api.submit({ ...source, mode: 'drawing' });
    if (build.status !== 'succeeded' && build.status !== 'failed') sheetsInFlight.set(owner, { id: build.id, key });
    while (build.status !== 'succeeded' && build.status !== 'failed') {
      await statusChange(build.id, build.status, generation);
      build = await Api.build(build.id);
    }
    if (sheetsInFlight.get(owner)?.id === build.id) sheetsInFlight.delete(owner);
    if (build.status === 'failed') throw new Error(build.error?.trim().split('\n').pop() || 'The sheets couldn’t be drawn.');
    return build;
  })();
  request.catch(() => { if (sheetBuilds.get(key) === request) sheetBuilds.delete(key); });
  sheetBuilds.set(key, request);
  while (sheetBuilds.size > 8) sheetBuilds.delete(sheetBuilds.keys().next().value!);
  return request;
}

/**
 * The source a full build of the displayed model is made from: the open document's when only its drawing sheets
 * changed since (the model is the same; the sheets are drawn as the document has them now), else the displayed build's.
 */
function withSheets(build: Build): Build {
  const { doc } = get();
  return !builtFrom(build, doc) && modelBuiltFrom(build, doc) ? { ...build, ...stored(doc) } : build;
}

/**
 * The displayed model's full build, generating it when only a preview exists, or anew with `fresh` (a full build from
 * before a runtime update). Its STEP files are made on request (stepFileFor). Null when it failed (toasted).
 */
export async function ensureFullBuild(fresh = false, format = 'STEP'): Promise<Build | null> {
  const displayed = get().displayed;
  if (!displayed) return null;
  if (displayed.mode === 'full' && displayed.status === 'succeeded' && !fresh) return displayed;
  set({ busy: true });
  phase('running', `Preparing ${format}`);
  let build: Build;
  try { build = await fullBuildFor(displayed, fresh); } catch (error) {
    set({ busy: false });
    phase('failed', 'Export failed');
    toast('danger', `Couldn’t export ${format}`, (error as Error).message);
    return null;
  }
  set({ busy: false });
  phase('succeeded', buildWords().ready);
  return build;
}

/**
 * The displayed model's full build with its print meshes (lib/api withPrintMeshes), for the mesh exports: generating the
 * full build first when only a preview exists, or anew with `fresh`. `resolution`: the 3MF/STL export's (lib/api
 * bodyMeshes). Null when either failed (toasted).
 */
export async function ensurePrintMeshes(format: string, fresh = false, resolution: MeshResolution = 'fine'): Promise<Build | null> {
  const build = await ensureFullBuild(fresh, format);
  if (!build || bodyMeshes(build, resolution)) return build;
  set({ busy: true });
  phase('running', `Preparing ${format}`);
  try {
    // The meshes belong to the full build itself, which asking again returns (an identical build is reused, never
    // computed twice).
    const full = build.mode === 'preview' ? await fullBuildFor(build, true) : build;
    const meshed = await withPrintMeshes(full, resolution);
    phase('succeeded', buildWords().ready);
    return meshed;
  } catch (error) {
    phase('failed', 'Export failed');
    toast('danger', `Couldn’t export ${format}`, (error as Error).message);
    return null;
  } finally {
    set({ busy: false });
  }
}

export async function exportStep() {
  const build = await ensureFullBuild();
  if (!build) return;
  // Made now if it isn't yet (the status bar says so); a failure says why, with Retry.
  if (!await stepFileFor(build, exportStatus, () => { void exportStep(); })) return;
  const name = get().doc.name || build.name;
  const link = document.createElement('a');
  // The server names the download (its Content-Disposition filename wins over `download`), after the design's name.
  link.href = withWorkspace(`${build.artifacts.step ?? `/v1/builds/${build.id}/artifacts/step`}?name=${encodeURIComponent(name)}`);
  link.download = `${name.replace(/[^\w.-]+/g, '_')}.step`;
  link.click();
  toast('success', 'Exporting STEP', 'The complete CAD model, including hidden components.');
}

/** A Blender document's scene as a .blend file, from its full build (made now when only a preview exists). */
export async function exportBlend() {
  const build = await ensureFullBuild(false, 'the Blender file');
  if (!build?.artifacts.blend) return;
  const name = get().doc.name || build.name;
  const link = document.createElement('a');
  link.href = withWorkspace(`${build.artifacts.blend}?name=${encodeURIComponent(name)}`);
  link.download = `${name.replace(/[^\w.-]+/g, '_')}.blend`;
  link.click();
  toast('success', 'Exporting the Blender file', 'The scene as the code made it, with its images packed in.');
}

export async function openInBlender() {
  const build = await ensureFullBuild(false, 'the Blender scene');
  if (!build?.artifacts.blend) return;
  try {
    await api('/v1/local/blender/open', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({build_id:build.id})});
    toast('success','Opened in Blender','Edit the exported scene in Blender. Native edits do not rewrite Steve’s Python source.');
  } catch(error) {toast('warning','Could not open Blender',(error as Error).message);}
}

/** Whether the open document's code declares a drawing sheet (steve.drawing's `Drawing(…)`). */
export const declaresDrawing = (doc: { code: string; files?: Record<string, string> }) =>
  [doc.code, ...Object.values(doc.files ?? {})].some((text) => /\bDrawing\s*\(/.test(text));

/**
 * The drawing sheets the code declares, from the full build (made now when only a preview exists): `open` shows the
 * sheets in the desktop preview with page navigation and PDF/SVG/DXF downloads;
 * `zip` downloads every sheet as SVG and DXF with its tables as CSV.
 */
export async function exportDrawing(format: 'open' | 'zip' | 'pdf') {
  const displayed = get().displayed;
  if (!displayed) return;
  const doc = get().doc;
  let build: Build;
  set({ busy: true });
  phase('running', 'Preparing drawing');
  // The sheets as the document has them now: a drawing edit since the model was built doesn't rebuild the model.
  const source = withSheets(displayed);
  try { build = source === displayed && displayed.mode === 'full' ? displayed : await fullBuildFor(source, true); } catch (error) {
    set({ busy: false });
    phase('failed', 'Export failed');
    toast('danger', 'Couldn’t make the drawing', (error as Error).message);
    return;
  }
  set({ busy: false });
  phase('succeeded', buildWords().ready);
  const url = format === 'open' ? build.artifacts.drawing : format === 'pdf' ? build.artifacts.drawings_pdf : build.artifacts.drawings;
  if (!url) {
    const drawings = build.metadata?.drawings;
    if (format === 'pdf' && build.artifacts.drawings) {
      toast('danger', 'The PDF couldn’t be made', drawings?.pdf_error
        ?? 'Try again, or export the sheets as SVG and DXF.');
      return;
    }
    toast('danger', 'No drawing to export', drawings?.error
      ?? 'This model has no drawing yet. Add a sheet in the Drawing tab, or ask STEVE for one (“make an ISO A3 drawing of this with a parts list”).');
    return;
  }
  const overflow = build.metadata?.drawings?.sheets.find((sheet) => sheet.overflow)?.overflow;
  if (overflow) toast('warning', 'The views don’t fit the sheet', overflow);
  if (format === 'open') {
    try { await showDrawingPreview(build, doc.name || build.name); }
    catch (error) { toast('danger', 'The drawing couldn’t open', (error as Error).message); }
    return;
  }
  const name = doc.name || build.name;
  const link = document.createElement('a');
  link.href = `${url}?name=${encodeURIComponent(name)}`;
  link.download = `${name.replace(/[^\w.-]+/g, '_')}-drawings.${format === 'pdf' ? 'pdf' : 'zip'}`;
  link.click();
  toast('success', 'Exporting drawings', format === 'pdf' ? 'Every sheet as a page of one PDF, ready to send or print.'
    : 'Every sheet as SVG and DXF, with its parts list and cut list as CSV.');
}

/** Whether the open document links other documents (a product, for Export → Product drawings). */
export const linksDocuments = (doc: { kind: Kind; links?: Record<string, LinkRef> }) =>
  (doc.kind === 'part' || doc.kind === 'design') && Object.keys(doc.links ?? {}).length > 0;

/**
 * Export → Product drawings: the open document as it is now and every document it links, at their pinned revisions,
 * in assembly order (drawing/package.ts). Each is built in full in turn (a build already made is reused); every sheet
 * then goes to one print (Save as PDF: one multi-page PDF) and every STEP to one zip, named after its document.
 * A document that fails or has no sheets is named, and doesn't stop the rest.
 */
export async function exportProductDrawings() {
  const { doc } = get();
  const name = doc.name.trim() || 'Untitled';
  const source = stored(doc);
  const host: PackageDocument = { document_id: doc.saved?.id ?? null, revision: doc.saved?.revision ?? null, kind: doc.kind, name, ...source };
  set({ busy: true });
  phase('running', 'Gathering the product');
  let result: ProductPackage;
  try {
    // Each link's own walk, in the order the code names them; the server checks cycles, depth and that each is yours.
    const walks: PackageDocument[][] = [];
    for (const alias of declaredOrder(host)) {
      const link = source.links[alias];
      walks.push((await Api.package(link.document_id, link.revision)).documents);
    }
    const documents = assemblyOrder(host, walks);
    result = await collectPackage(documents, {
      build: (item, index) => {
        phase('running', `Building ${item.name} (${index + 1} of ${documents.length})`);
        return fullBuildOf({ kind: item.kind, name: item.name, code: item.code, files: item.files, links: item.links });
      },
      sheets: sheetMarkup,
      step: async (build) => {
        if (build.mode !== 'full') return null;
        // Each document's STEP file is made when the package asks for it: the status bar says so while it's made.
        const made = await waitForStep(build.id, { onProgress: (status) => phase('running', `${stepLabel(status)} · ${build.name}`) });
        if (made.state !== 'ready') throw new Error(`Its STEP file couldn’t be made: ${made.error || made.message || made.state}.`);
        const response = await fetch(build.artifacts.step ?? `/v1/builds/${build.id}/artifacts/step`);
        if (!response.ok) throw new Error(`Its STEP didn’t download (${response.status}).`);
        return new Uint8Array(await response.arrayBuffer());
      },
    });
  } catch (error) {
    set({ busy: false });
    phase('failed', 'Export failed');
    toast('danger', 'Couldn’t gather the product', (error as Error).message);
    return;
  }
  set({ busy: false });
  phase(result.failed.length ? 'failed' : 'succeeded', result.failed.length ? 'Export incomplete' : buildWords().ready);
  if (result.steps.length) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await zip(result.steps));
    link.download = `${name.replace(/[^\w.-]+/g, '_')}-step.zip`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  }
  const notes = [
    result.failed.length && `Didn’t build: ${result.failed.map((item) => `${item.name} (${item.error})`).join('; ')}.`,
    result.withoutSheets.length && `No drawing sheets: ${result.withoutSheets.join(', ')}.`,
  ].filter(Boolean).join(' ');
  const files = `${result.steps.length} STEP file${result.steps.length === 1 ? '' : 's'}`;
  // Every document's sheets as one PDF, merged by the server from the builds just made (app/product_drawings.py); a
  // build from before PDFs has none, and then the sheets print as before.
  if (result.pdfs) {
    try {
      const merged = await api<{ url: string; pages: number }>('/v1/product-drawings', json('POST', { build_ids: result.pdfs }));
      const link = document.createElement('a');
      link.href = `${merged.url}?name=${encodeURIComponent(name)}`;
      link.download = `${name.replace(/[^\w.-]+/g, '_')}-drawings.pdf`;
      link.click();
      toast(notes ? 'warning' : 'success', 'Product drawings ready',
        `${merged.pages} sheet${merged.pages === 1 ? '' : 's'} as one PDF, and ${files} in a zip.${notes ? ` ${notes}` : ''}`);
      return;
    } catch { /* Print them instead, below. */ }
  }
  let printed = false;
  if (result.sheets.length) {
    try { printed = printSheets(result.sheets); } catch { /* Said below. */ }
  }
  if (printed) {
    toast(notes ? 'warning' : 'success', 'Product drawings ready',
      `${result.sheets.length} sheet${result.sheets.length === 1 ? '' : 's'} to print or save as one PDF, and ${files} in a zip.${notes ? ` ${notes}` : ''}`);
  } else {
    toast(result.steps.length ? 'warning' : 'danger', result.sheets.length ? 'The sheets couldn’t be printed' : 'No drawing sheets to print',
      `${result.steps.length ? `Downloaded ${files} in a zip. ` : ''}${notes
        || (result.sheets.length ? 'Try again, or download each document’s sheets (Export → Drawings).' : 'Add a sheet in the Drawing tab of each document, or ask STEVE for one.')}`);
  }
}

/** Shop builds already saved into the library, as build|document|revision|branch: each is applied once. */
const appliedShops = new Set<string>();

/**
 * A shop's succeeded build of exactly its saved revision saves the shop's items into the manufacturing library (each
 * created, revised or left unchanged) and says what changed. A build of unsaved edits never does; nor the same build
 * of the same revision twice.
 */
async function applyShopBuild(build: Build | null = get().displayed) {
  const { doc } = get();
  const saved = doc.saved;
  if (doc.kind !== 'shop' || saved?.kind !== 'shop' || build?.kind !== 'shop' || build.status !== 'succeeded') return;
  if (!builtFrom(build, doc) || !builtFrom(build, { kind: saved.kind, ...opened(saved) })) return;
  const branch = doc.branch;
  const key = `${build.id}|${saved.id}|${saved.revision}|${branch}`;
  if (appliedShops.has(key)) return;
  appliedShops.add(key);
  try {
    const result = await Api.applyShop(saved.id, { revision: saved.revision, ...(branch !== 'main' ? { branch } : {}) });
    const { created, revised, unchanged } = result.counts;
    const changes = [created && `${created} created`, revised && `${revised} revised`, unchanged && `${unchanged} unchanged`].filter(Boolean).join(', ');
    if (created || revised) toast('success', 'Library updated', changes);
    else toast('success', 'Library up to date', unchanged ? `All ${unchanged} ${unchanged === 1 ? 'item is' : 'items are'} unchanged.` : 'This shop has no items yet.');
  } catch (error) {
    toast('danger', 'Couldn’t update the library', (error as Error).message);
  }
}

/**
 * After saving with preview geometry, builds the full model in the background and attaches it
 * to the saved revision (thumbnails, STEP and STEVE's views need it). Nothing changes if the
 * design moved on meanwhile.
 */
async function promoteSaved() {
  const { doc, displayed } = get();
  // Local Blender renders are explicit work, never a side effect of saving Python.
  if (doc.kind === 'blender') return;
  const saved = doc.saved;
  // A model shown from before a drawing edit is still the saved model, but its sheets are the saved code's.
  const source = displayed && withSheets(displayed);
  if (!saved || !displayed || !source || (displayed.mode === 'full' && source === displayed) || !modelBuiltFrom(displayed, doc)) return;
  try {
    const full = await fullBuildFor(source, source !== displayed);
    const now = get();
    if (now.doc.saved?.id !== saved.id || now.doc.saved.revision !== saved.revision) return;
    const updated = await Api.promotePreview(saved.id, { revision: saved.revision, build_id: full.id, ...(now.doc.branch !== 'main' ? { branch: now.doc.branch } : {}) });
    if (get().doc.saved?.id === saved.id && get().doc.saved?.revision === saved.revision) {
      patchDoc({ saved: { ...get().doc.saved!, preview_build_id: updated.preview_build_id } });
      if (get().displayed?.id !== displayed.id) return;
      // A build in flight replaces the preview anyway; otherwise the full build takes its place, with its own logs, so
      // what only the preview reported (inspections that ran out of time) doesn't linger until a reload.
      if (!get().busy) await showSavedModel(full, displayed);
    }
  } catch { /* The preview stays attached; exporting builds the full model on demand. */ }
}

/** Shows the saved revision's own build in place of another model of its source (the camera stays). */
async function showSavedModel(build: Build, previous: Build) {
  const gen = ++generation;
  await showBuild(build, gen, false, viewer.capturePose(), true);
  if (gen !== generation) return;
  set({ logs: build.logs ?? '', error: '' });
  settleSavedModel(previous);
}

/**
 * A model of the saved source shown in place of another model of it (a rebuild, the full build) isn't an edit: the
 * design stays Saved, and no draft or tab copy of unchanged source is kept. Edits made meanwhile still count.
 */
function settleSavedModel(previous: Build | null) {
  const state = get();
  if (!state.doc.saved || state.pastVersion || !isDirty(state) || hasSourceEdits(state)) return;
  if (!modelBuiltFrom(previous, state.doc) || !modelBuiltFrom(state.displayed, state.doc)) return;
  patchDoc({ savedSnapshot: snapshot() });
  saveDraft();
}

/**
 * Geometry whose faces and bodies have names, for workspaces that pick them (Manufacture): a saved part shown from its
 * preview build (one written through the API or by an agent never had its full build attached) gets its full build,
 * attached to the saved revision as saving in the app does, and shown in place (the camera stays). Null when it failed.
 */
export async function ensureNamedGeometry(): Promise<Build | null> {
  const { doc, displayed } = get();
  if (!displayed || displayed.mode === 'full' || !doc.saved || !modelBuiltFrom(displayed, doc)) return displayed;
  const saved = doc.saved;
  phase('running', 'Naming faces for machining');
  let full: Build;
  try { full = await fullBuildFor(withSheets(displayed)); } catch (error) {
    phase('failed', 'Couldn’t prepare the part');
    toast('danger', 'Couldn’t prepare the part for machining', (error as Error).message);
    return null;
  }
  phase('succeeded', buildWords().ready);
  const now = get();
  if (now.doc.saved?.id === saved.id && now.doc.saved.revision === saved.revision) {
    try {
      const updated = await Api.promotePreview(saved.id, { revision: saved.revision, build_id: full.id, ...(now.doc.branch !== 'main' ? { branch: now.doc.branch } : {}) });
      if (get().doc.saved?.id === saved.id && get().doc.saved?.revision === saved.revision) patchDoc({ saved: { ...get().doc.saved!, preview_build_id: updated.preview_build_id } });
    } catch { /* Shown for now; the next save attaches a full build. */ }
  }
  if (get().displayed?.id === displayed.id) await showSavedModel(full, displayed);
  return full;
}

/** The open document's source: its one file as .py/.tsx, or every file of a design or circuit, in folders, as a zip. */
export async function downloadSource() {
  const { doc } = get();
  const circuit = doc.kind === 'circuit';
  const name = (doc.name || 'model').replace(/[^\w.-]+/g, '_');
  const files = sourceFiles(doc);
  const several = files.length > 1;
  let blob: Blob;
  try {
    // Documents store title-block logos as base64. Export actual image bytes
    // beside main.py so other programs can open them after extracting the ZIP.
    const exported: [string, string | Uint8Array][] = files.map(([path, content]) =>
      [path, isImage(path) ? Uint8Array.from(atob(content.trim()), (character) => character.charCodeAt(0)) : content]);
    blob = several ? await zip(exported) : new Blob([files[0]?.[1] ?? doc.code], { type: circuit ? 'text/tsx' : 'text/x-python' });
  } catch (error) {
    toast('danger', 'Couldn’t download the source', (error as Error).message);
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = several ? `${name}-source.zip` : `${name}.${circuit ? 'tsx' : 'py'}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  if (several) toast('success', 'Downloaded the source', `${files.length} files, in their folders, in ${name}-source.zip.`);
}

export function captureImage() {
  const data = viewer.screenshot();
  if (!data) return;
  const link = document.createElement('a');
  link.href = data;
  link.download = `${(get().doc.name || 'view').replace(/[^\w.-]+/g, '_')}.png`;
  link.click();
  toast('success', 'Image captured', 'Saved the current viewport as PNG.');
}

/* ───────── Boot ───────── */

export async function boot(resume?: () => Promise<boolean>) {
  set({ busy: true });
  phase('opening', 'Opening workspace');
  try {
    // The builds list only picks what to open when nothing else does: once retried, a failure doesn't stop the documents loading.
    const recentBuilds = () => Api.builds(100).catch(() => Api.builds(100)).catch(() => ({ builds: [] as Build[] }));
    const [loaded, documents, builds] = await Promise.all([Api.examples(), Api.documents(), recentBuilds()]);
    examples = loaded;
    const draft = readDraft();
    const params = linkParams(location.search);
    // After an update's reload: the workspace, study and revision come back as deep-link parameters (reloadView.ts).
    const view = params.has('document') ? takeView(params.get('document')!, params.get('branch') || 'main') : null;
    for (const [name, value] of Object.entries(view?.link ?? {})) if (!params.has(name)) params.set(name, value);
    set({ busy: false });
    // Without edits to restore, another document can be chosen while this one is still opening.
    holdOpening = !!draft;
    const left = abandonedOpenings;
    const previews = new Set(documents.documents.map((doc) => doc.preview_build_id));
    const latestBuild = latestModelBuild(builds.builds, previews);
    const latestDocument = documents.documents.find((doc) => doc.kind !== 'shop' && doc.kind !== 'cam');
    if (params.has('document')) await openDocument(params.get('document')!, params.get('branch') || 'main', { pose: view?.pose ?? null });
    else if (!params.size && resume && await resume()) { /* The last session's active tab is back. */ }
    else if (params.has('model') || params.has('build')) await openBuild((params.get('model') || params.get('build'))!);
    else if (params.has('new')) newDocument(draft?.kind ?? 'part');
    else if (params.has('empty') || (!latestDocument && !latestBuild)) clearWorkspace();
    else if (latestDocument && (!latestBuild || new Date(latestDocument.updated_at) >= new Date(latestBuild.created_at))) await openDocument(latestDocument.id);
    else await openBuild(latestBuild!.id);
    holdOpening = false;
    if (abandonedOpenings !== left) { markDraftRestored(); return; }  // Another document was opened meanwhile.
    // A deep link's study, program, workspace or revision (state/deepLink.ts).
    if (params.has('document')) await (await import('./deepLink')).applyLink(params);
    if (view && get().doc.saved?.id === view.document) restorePanels(view);
    const state = get();
    const base = state.doc.saved?.id ?? state.displayed?.id;
    if (state.doc.open && draft && typeof draft.code === 'string' && draft.baseId === base && (draft.branch ?? 'main') === state.doc.branch) {
      const kind: Kind = draft.kind === 'design' || draft.kind === 'circuit' || draft.kind === 'shop' || draft.kind === 'blender' ? draft.kind : 'part';
      const { files, activeFile, links } = state.doc;
      const edits: DocStash = { code: draft.code, name: draft.name || state.doc.name, kind, files, activeFile, links,
        ...(hasFiles(kind) && draft.files ? { files: draft.files, activeFile: draft.activeFile ?? MAIN, links: draft.links ?? {} } : {}),
        ...(kind === 'part' && draft.links ? { links: draft.links } : {}),
        ...(kind === 'circuit' ? { files: draft.files ?? {}, activeFile: CIRCUIT_MAIN, links: {} } : {}),
        ...(kind === 'blender' ? { files: draft.files ?? {}, activeFile: MAIN, links: {} } : {}),
        ...(state.doc.saved && draft.documentRevision ? { documentRevision: draft.documentRevision } : {}) };
      // Edits from an older revision open the conflict dialog, which says so; unchanged ones are simply dropped.
      const gen = generation;
      const restored = await restoreEdits(edits, gen);
      if (gen === generation) {
        if (restored === 'restored' || restored === 'unknown') toast('info', 'Unsaved edits restored', 'Your changes from the last session are back.');
        saveDraft();
      }
    }
    if (view && typeof view.activeFile === 'string' && get().doc.saved?.id === view.document) openFile(view.activeFile);
    markDraftRestored();
  } catch (error) {
    set({ busy: false });
    if (isStaleChunk(error)) {
      // This tab's build was replaced by a deploy, not a connection problem.
      if (reloadForStaleChunk()) return;
      phase('failed', 'Update needed');
      toast('warning', 'STEVE Studio has been updated', 'Reload the page to get the latest version.', { sticky: true });
      return;
    }
    phase('failed', 'Offline');
    toast('danger', 'Couldn’t connect to the model service', (error as Error).message, { sticky: true });
  } finally {
    holdOpening = false;
  }
}

/* ───────── Branches ───────── */

/** Reloads the branch list and version graph for the open document. */
export async function refreshBranches() {
  const id = get().doc.saved?.id;
  if (!id || !(await Branches.available())) { set({ branches: null, graph: null }); return; }
  try {
    const [list, graph] = await Promise.all([Branches.list(id), Branches.graph(id).catch(() => null)]);
    if (get().doc.saved?.id === id) set({ branches: list.branches, graph });
  } catch { set({ branches: null, graph: null }); }
}

export function switchBranch(name: string) {
  const id = get().doc.saved?.id;
  if (!id || name === get().doc.branch) return;
  leave(() => { void openDocument(id, name).then(refreshBranches); });
}

/* ───────── Past versions ───────── */

/** Shows a past revision's geometry read-only, keeping the open design and the camera. */
export async function viewRevision(node: GraphNode) {
  if (!node.preview_build_id) { toast('info', 'No geometry for this revision', 'It was saved without a generated model.'); return; }
  const buildId = node.preview_build_id;
  await showRevision(node, `Opening ${node.branch} r${node.revision}`, () => Api.build(buildId));
}

/** viewRevision with the build `load` gives. One whose files were cleared (retired) offers to generate the revision. */
async function showRevision(node: GraphNode, label: string, load: (gen: number) => Promise<Build | null>) {
  const state = get();
  if (state.busy || !state.doc.open) return;
  const returnBuildId = state.pastVersion ? state.pastVersion.returnBuildId : state.displayed?.id ?? null;
  const gen = ++generation;
  busy(true, label);
  try {
    const build = await load(gen);
    if (!build || gen !== generation) return;
    set({ pastVersion: { key: node.key, branch: node.branch, revision: node.revision, commit: node.commit_id, message: node.message, recordedAt: node.recorded_at, returnBuildId } });
    await showBuild(build, gen, false, viewer.capturePose());
    if (gen !== generation) return;
    set({ busy: false });
    phase('succeeded', `Viewing ${node.branch} r${node.revision}`);
  } catch (error) {
    if (gen !== generation) return;
    set({ busy: false });
    phase('failed', 'Couldn’t open that revision');
    set({ pastVersion: state.pastVersion });
    if (error instanceof RetiredBuild && node.commit_id) {
      toast('info', `r${node.revision}’s geometry was cleared`, error.message, { action: { label: 'Generate it',
        run: () => void showRevision(node, `Generating ${node.branch} r${node.revision}`, (current) => buildRevision(node, current)) } });
      return;
    }
    toast('danger', 'Couldn’t show that revision', (error as Error).message);
  }
}

/** A past revision's recorded source built again (a preview, from the cache when it can), once it has finished. */
async function buildRevision(node: GraphNode, gen: number): Promise<Build | null> {
  const id = get().doc.saved?.id;
  if (!id || !node.commit_id) return null;
  const { document: past } = await historicalDocument(id, node.commit_id);
  let build = await Api.submit({ kind: past.kind, name: past.name, code: past.code, files: past.files, links: past.links, mode: 'preview' });
  while (build.status === 'queued' || build.status === 'running') {
    await statusChange(build.id, build.status, gen);
    if (gen !== generation) return null;
    build = await Api.build(build.id);
  }
  if (build.status !== 'succeeded') throw new Error(build.error || 'That revision doesn’t build any more.');
  return build;
}

/** Returns the viewport from a past revision to the open design's geometry. */
export async function leaveRevision() {
  const past = get().pastVersion;
  if (!past) return;
  const gen = ++generation;
  set({ pastVersion: null });
  if (!past.returnBuildId) { phase('idle', ''); return; }
  busy(true, 'Returning to the current version');
  try {
    const build = await Api.build(past.returnBuildId);
    if (gen !== generation) return;
    await showBuild(build, gen, false, viewer.capturePose());
    if (gen !== generation) return;
    set({ busy: false });
    phase('succeeded', buildWords().ready);
  } catch (error) {
    if (gen !== generation) return;
    set({ busy: false });
    toast('danger', 'Couldn’t reload the current geometry', (error as Error).message);
  }
}

/**
 * Makes a past revision (from any branch) the newest revision of `target`. The server regenerates it; code that
 * doesn't build any more is restored all the same, with its error shown. History is kept, so this is itself undoable
 * from the Versions tab.
 */
export async function activateRevision(node: GraphNode, target: string) {
  const state = get();
  const id = state.doc.saved?.id;
  if (!id || state.busy) return;
  if (!node.commit_id) { toast('info', 'Checkpoint pending', 'This revision is still being written to history. Try again in a moment.'); return; }
  if (target === state.doc.branch && hasUnsavedWork(state)) { toast('warning', 'Save or discard your edits first', `Restoring replaces what is open on ${target}.`); return; }
  set({ busy: true, phase: 'running', phaseLabel: `Restoring ${node.branch} r${node.revision} onto ${target}`, phaseStarted: Date.now() });
  try {
    const head = target === state.doc.branch ? state.doc.saved!.revision
      : target === 'main' ? (await Api.document(id)).revision : (await Branches.read(id, target)).revision;
    const result = await restoreRevision(id, head, node.commit_id, target);
    set({ busy: false });
    if (target === get().doc.branch && get().doc.saved?.id === id) await applyDocumentRevision(result.document, result.model, target);
    else await openDocument(id, target);
    void refreshBranches();
    const saved = `Saved as ${target} revision ${result.document.revision}`;
    if (result.model?.status === 'failed') toast('warning', `Restored r${node.revision}, but it doesn’t build any more`, `${saved}. See diagnostics in Source to fix it. Later revisions stay in history.`);
    else if (result.model && result.model.status !== 'succeeded') toast('info', `Restored r${node.revision}`, `${saved}. Its model is still building. Later revisions stay in history.`);
    else toast('success', `Restored r${node.revision}`, `Verified and saved as ${target} revision ${result.document.revision}. Later revisions stay in history.`);
  } catch (error) {
    set({ busy: false });
    phase('failed', 'Restore rejected');
    toast('danger', 'Restore failed', `${(error as Error).message} Nothing was changed.`);
  }
}

export async function createBranch(name: string, fromRevision?: number | null) {
  const id = get().doc.saved?.id;
  if (!id) return false;
  try {
    await Branches.create(id, name, fromRevision ?? undefined);
    toast('success', `Branch ${name} created`, fromRevision ? `From main revision ${fromRevision}.` : 'From the latest main. Edits here leave main untouched.');
    leave(() => { void openDocument(id, name).then(refreshBranches); });
    return true;
  } catch (error) {
    toast('danger', 'Couldn’t create the branch', (error as Error).message);
    return false;
  }
}

export async function deleteBranch(name: string) {
  const id = get().doc.saved?.id;
  if (!id || name === 'main') return;
  try {
    await Branches.remove(id, name);
    if (get().doc.branch === name) await openDocument(id, 'main');
    await refreshBranches();
    toast('success', `Branch ${name} deleted`, 'Its revisions remain in history.');
  } catch (error) { toast('danger', 'Couldn’t delete the branch', (error as Error).message); }
}

/** Opens a linked part or design in its own tab. */
export function openPart(partId: string) {
  openTab({ id: partId });
}

/* ───────── Unsaved edits kept per document tab ───────── */

/** `documentRevision`: the saved revision the edits started from (absent for an unsaved document, and in tabs kept
 *  before it was recorded). */
export interface DocStash { code: string; name: string; kind: Kind; files?: Record<string, string>; activeFile?: string; links?: Record<string, LinkRef>; documentRevision?: number }

export function takeStash(): DocStash | null {
  const state = get();
  // Only changed source is kept: a model rebuilt from the saved source isn't an edit to bring back.
  if (!state.doc.open || !hasSourceEdits(state)) return null;
  const { code, name, kind, activeFile, links } = state.doc;
  return { code, name, kind, files: keepsFiles(kind) ? state.doc.files : filesOf(state.doc), activeFile, links, documentRevision: state.doc.saved?.revision };
}

/** What a document's source is, for comparing kept edits with a revision: its name and every file and link. */
const sourceKey = (doc: Parameters<typeof stored>[0] & { name: string }) => {
  const { code, files, links } = stored(doc);
  const sorted = (record: Record<string, unknown>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([doc.name.trim() || 'Untitled', code, sorted(files), sorted(links)]);
};

const stashSource = (stash: DocStash) => sourceKey({ ...stash, files: stash.files ?? {}, activeFile: stash.activeFile ?? MAIN, links: stash.links ?? {} });

/** A past revision of a document's branch as it was saved, or null when its history can't be read here. */
async function revisionSource(id: string, branch: string, revision: number) {
  try {
    if (!(await Branches.available())) return null;
    const node = (await Branches.graph(id)).nodes.find((item) => item.branch === branch && item.revision === revision && item.commit_id);
    if (!node) return null;
    const { document: past } = await historicalDocument(id, node.commit_id!);
    return sourceKey({ name: past.name, kind: past.kind, ...opened(past) });
  } catch { return null; }
}

/**
 * Puts unsaved edits kept from before (a tab's, or the last session's draft) back on the document just opened. They
 * are never laid silently over a newer revision: edits that started from an older one and change nothing are dropped;
 * real ones keep that revision as their base and the conflict dialog opens (combine, keep mine, or use the latest).
 * 'same': nothing to restore. 'unknown': restored, but kept before their revision was recorded.
 */
async function restoreEdits(edits: DocStash, gen: number): Promise<'same' | 'restored' | 'conflict' | 'unknown'> {
  const { doc } = get();
  if (stashSource(edits) === sourceKey(doc)) return 'same';
  const saved = doc.saved;
  const base = edits.documentRevision;
  if (saved && base !== undefined && base < saved.revision) {
    const past = await revisionSource(saved.id, doc.branch, base);
    if (gen !== generation) return 'same';
    if (past === stashSource(edits)) return 'same';
    restoreStash(edits);
    patchDoc({ saved: { ...saved, revision: base } });
    saveDraft();
    set({ dialog: 'conflict' });
    return 'conflict';
  }
  restoreStash(edits);
  return saved && base === undefined ? 'unknown' : 'restored';
}

function restoreStash(stash: DocStash) {
  patchDoc({ code: stash.code, name: stash.name, kind: stash.kind,
    files: stash.files ?? {}, activeFile: stash.activeFile ?? MAIN, links: stash.links ?? {} });
  saveDraft();
  retitle();
}

/** Recreates an unsaved document (one with no server id) from its tab. */
export async function reopenUnsaved(stash: DocStash, previewBuildId: string | null, pose: CameraPose | null) {
  clearWorkspace();
  const gen = generation;
  patchDoc({ open: true, kind: stash.kind, name: stash.name, code: '', savedSnapshot: null });
  if (previewBuildId) {
    try {
      const build = await Api.build(previewBuildId);
      if (gen !== generation) return;
      await showBuild(build, gen, false, pose);
    } catch { /* The preview is optional. */ }
  }
  restoreStash(stash);
  if (!get().displayed) setUrl('new=1');
}

/* ───────── designs: files and components ───────── */

/** Edits another file of the open design (the sketch and feature tools follow it). */
export function openFile(path: string) {
  const { doc } = get();
  if (!hasFiles(doc.kind) || path === doc.activeFile || isImage(path)) return;  // A logo is data, never edited as text.
  const files = filesOf(doc);
  if (files[path] === undefined) return;
  patchDoc({ files, activeFile: path, code: files[path] });
  saveDraft();
}

/**
 * Navigation (switching, opening or closing tabs) mustn't wait on an automatic rebuild: it stops waiting for one in
 * flight (the server still finishes it; the result is ignored, and the rebuild runs again when it's needed). Nor on a
 * document still opening (a large assembly's geometry can take a while): it's left half-open, closed, and opens again
 * from its tab. A build someone asked for, or another operation, keeps the app busy: returns false then.
 */
export function abandonQuietBuild(): boolean {
  if (get().sketching) {
    toast('info', 'Sketch edit in progress', 'Finish or cancel the sketch before changing documents.');
    return false;
  }
  if (!canLeave()) return false;
  if (!get().busy) return true;
  const opening = openingGeneration === generation;
  ++generation;
  if (opening) {
    ++abandonedOpenings;
    clearModel({ doc: { ...initialDocState } });
    retitle();
  } else set({ busy: false, phase: 'idle', phaseLabel: '' });
  return true;
}

/** Whether navigation can leave what the app is doing now (abandonQuietBuild). */
export function canLeave(state: AppState = get()): boolean {
  return !state.sketching && (!state.busy || quietGeneration === generation || openingGeneration === generation);
}

/** A document is still opening (abandonQuietBuild would close it). */
export const isOpening = () => get().busy && openingGeneration === generation;

/** A new component in its own file, imported and placed in main.py, opened for editing. */
export function addComponent(id: string, name: string): string | true {
  const { doc } = get();
  if (doc.kind !== 'design') return 'Components belong to designs.';
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(id)) return 'Use lowercase letters, digits and underscores, starting with a letter.';
  const files = filesOf(doc);
  if (files[`components/${id}.py`] !== undefined) return `There is already a component named ${id}.`;
  const next = withComponent(files, id, name || id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()));
  patchDoc({ files: next, activeFile: `components/${id}.py`, code: next[`components/${id}.py`] });
  saveDraft();
  void updateModel({ quiet: true });  // An empty component builds as an empty design: no "generate" step for the person.
  return true;
}

/** A design's whole source, tables included, as the server bounds it (app/modeling MAX_SOURCE, characters). */
const MAX_SOURCE = 2_000_000;

/**
 * Imports a table (a .csv file, or one sheet of an Excel .xlsx converted to CSV here in the browser) into the open
 * design beside main.py (holes.csv), opens it and saves the design as a new revision: its code reads it with
 * `table("holes.csv")`, e.g. `design.pattern(hole, points=table("holes.csv"))`. A table of the same name is replaced
 * (the history keeps the old one). Nothing of the file is kept: importing again is how a table updates.
 * Returns why not, or the workbook's sheets when it has several and `sheet` doesn't say which. `stay` keeps the file
 * being edited open (Table pattern imports while main.py is being written).
 */
export async function importTable(file: File, sheet?: string, stay = false): Promise<string | true | { sheets: string[] }> {
  const { doc } = get();
  if (doc.kind !== 'design') return 'Tables belong to designs.';
  const path = tablePath(file.name);
  const kind = tableFileKind(file.name);
  if (typeof kind === 'object') return kind.problem;
  if (!path) return 'Choose a .csv or .xlsx file (a spreadsheet saves one with Save As → CSV or Excel Workbook).';
  const files = filesOf(doc);
  const size = Object.entries(files).reduce((total, [name, text]) => total + (name === path ? 0 : text.length), 0);
  let text: string;
  if (kind === 'xlsx') {
    // Converted here: the server only ever sees the CSV, saved like any imported table.
    if (file.size > XLSX_LIMITS.fileBytes) return `That workbook is larger than ${XLSX_LIMITS.fileBytes / 1024 / 1024} MB: save the table on its own, or as CSV.`;
    try {
      const workbook = await openXlsx(await file.arrayBuffer());
      if (sheet === undefined && workbook.sheets.length > 1) return { sheets: workbook.sheets };
      text = await workbook.csv(sheet ?? workbook.sheets[0], MAX_SOURCE - size);
    } catch (error) {
      if (error instanceof XlsxProblem) return error.message;
      throw error;
    }
  } else {
    if (file.size > MAX_SOURCE - size) return 'That table is too large for this design: a design’s files hold 2,000,000 characters together.';
    text = (await file.text()).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (text.includes('\0')) return 'That file isn’t a text table: save it from the spreadsheet as CSV.';
  }
  if (!text.trim()) return 'That table is empty.';
  if (get().doc.kind !== 'design' || get().doc.saved?.id !== doc.saved?.id) return 'Another document opened while the table was read: import it again.';
  const current = get().doc;
  patchDoc(stay && current.activeFile !== path ? { files: { ...filesOf(current), [path]: text } } : { files: { ...filesOf(current), [path]: text }, activeFile: path, code: text });
  saveDraft();
  void saveDocument();
  return true;
}

/** A logo image's limits (runtime/steve/images.py): its bytes, and its pixels a side. */
const IMAGE_BYTES = 512 * 1024;
const IMAGE_SIDE = 4096;

/** A logo may finish decoding while a live build is running. Keep its draft and
 * save once idle; never let the deferred save act on a different tab or branch. */
async function saveImportedImage(): Promise<void> {
  const tab = get().activeTab;
  const branch = get().doc.branch;
  const current = () => get().activeTab === tab && get().doc.branch === branch;
  while (current() && get().busy) {
    await new Promise<void>((resolve) => {
      const stop = useApp.subscribe((state) => `${state.busy}|${state.activeTab}|${state.doc.branch}`, () => {
        if (!current() || !get().busy) { stop(); resolve(); }
      });
    });
  }
  if (current()) await saveDocument();
}

/**
 * Imports a logo (a PNG or JPEG file) into the open design beside main.py (logo.png) and saves the design as a new
 * revision: a drawing's title block cell draws it with `{"image": "logo.png"}`. Checked here by its bytes first (the
 * PNG or JPEG signature, at most 512 KB, its decoded size at most 4096 px a side); the server checks it again. Kept as
 * base64 text, like any of the design's files; a logo of the same name is replaced (the history keeps the old one).
 */
export async function importImage(file: File): Promise<string | true> {
  const { doc } = get();
  if (doc.kind !== 'design') return 'Logos belong to designs.';
  if (file.size > IMAGE_BYTES) return `That image is larger than ${IMAGE_BYTES / 1024} KB: save a smaller PNG or JPEG of the logo.`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) return 'That file isn’t a PNG or JPEG image: save the logo as PNG or JPEG (SVG and other formats aren’t taken).';
  const path = imagePath(file.name, png ? 'png' : 'jpeg');
  if (!path) return 'Choose a PNG or JPEG file.';
  let size: { width: number; height: number };
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: png ? 'image/png' : 'image/jpeg' }));
    size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
  } catch {
    return 'That image can’t be read (the file looks damaged): save the logo again as PNG or JPEG.';
  }
  if (size.width > IMAGE_SIDE || size.height > IMAGE_SIDE) return `That image is ${size.width} × ${size.height} pixels: a logo is at most ${IMAGE_SIDE} pixels a side.`;
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  const text = btoa(binary);
  const files = filesOf(get().doc);
  const used = Object.entries(files).reduce((total, [name, other]) => total + (name === path ? 0 : other.length), 0);
  if (used + text.length > MAX_SOURCE) return 'That image is too large for this design: a design’s files hold 2,000,000 characters together.';
  if (get().doc.kind !== 'design' || get().doc.saved?.id !== doc.saved?.id) return 'Another document opened while the image was read: import it again.';
  patchDoc({ files: { ...files, [path]: text } });
  saveDraft();
  void saveImportedImage();
  return true;
}

/**
 * Deletes a component: its file, its import and its placements in main.py, saved as a new revision (undo or the
 * history bring it back). Returns why not when something else still uses it.
 */
export function removeComponent(path: string, id?: string): string | true {
  const { doc } = get();
  if (doc.kind !== 'design') return 'Components belong to designs.';
  const files = filesOf(doc);
  if (files[path] === undefined) return 'This component is already gone.';
  const result = withoutComponent(files, path, id);
  if ('users' in result) return `Used in ${result.users.join(', ')}: remove those uses first.`;
  const activeFile = doc.activeFile === path ? MAIN : doc.activeFile;
  patchDoc({ files: result.files, activeFile, code: result.files[activeFile] });
  saveDraft();
  void updateModel({ quiet: true });
  return true;
}

/**
 * Uses another saved design or part in the open design, pinned to `revision`, placed at `position` (main.py). In a
 * shop, links another shop (`from links import <alias>` in main.py; its items are then `<alias>.<item>`).
 */
export async function linkDocument(documentId: string, name: string, revision: number, position: [number, number, number]) {
  const { doc } = get();
  if (doc.kind === 'shop') {
    const { [MAIN]: main = '', ...rest } = filesOf(doc);
    const { source, alias } = withShopLink({ code: main, files: rest, links: doc.links }, documentId, name, revision);
    const files: Record<string, string> = { ...source.files, [MAIN]: source.code };
    patchDoc({ links: source.links, files, code: files[doc.activeFile] ?? doc.code });
    saveDraft();
    toast('success', `Linked ${name}`, `Its items are ${alias}.<item> in this shop's code: shop.add(${alias}.<item>), or clone one to make it yours.`);
    await updateModel();
    return;
  }
  if (doc.kind !== 'design') return;
  const { files, links } = withLink(filesOf(doc), doc.links, documentId, name, revision, position);
  const before = new Set(designInstanceNames());
  patchDoc({ links, files, code: files[doc.activeFile] ?? doc.code });
  saveDraft();
  await updateModel();
  // Step two: place it. The Place tool opens on the new instance.
  const added = designInstanceNames().find((instance) => !before.has(instance));
  if (added) { const { openPlacement } = await import('@/placement/placement'); openPlacement(added); }
}

const designInstanceNames = () => (((get().displayed?.metadata as { modeling?: { design?: { instances?: { name: string }[] } } } | null)?.modeling?.design?.instances) ?? []).map((item) => item.name);

/** Moves a link to its document's latest revision (as reported by the server) and regenerates. */
export async function updateLink(alias: string) {
  const { doc } = get();
  const latest = doc.saved?.link_status?.[alias]?.latest;
  if (!latest || !doc.links[alias]) return;
  patchDoc({ links: { ...doc.links, [alias]: { ...doc.links[alias], revision: latest } } });
  saveDraft();
  await updateModel();
}

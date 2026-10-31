/**
 * A part's CAM programs that are documents (docs/site manufacture/cam.md). Storage isn't what a person sees: a CAM
 * program is kept as a document (kind "cam", its main.py links the part and the workspace's shop), but it is only ever
 * worked here, in the part's Manufacture workspace, beside the part's older programs. Nothing lists or opens it as a file.
 *
 * The CAM editor works on program records (cam/state.ts). Each CAM document shows there as one record (`cam:<id>`)
 * whose pins are its shop items' latest library records. Every change its forms make is written into main.py
 * (cam/camCode.ts), built, and saved as a new revision of the document; a change that doesn't build isn't saved. Run
 * asks the server for one step at a time (POST /v1/documents/{id}/cam/run) until the program has run every operation,
 * posted and been checked.
 */
import { create } from 'zustand';
import { api, Api, ApiError, camMetadata, type Build, type CadDocument, type CamFailure, type CamRunState, type DocumentSummary, type PostedResolution, type LinkRef } from '@/lib/api';
import { get as app, set as setApp, toast } from '@/state/store';
import { jobs, programs, type ProgramRecord } from '../api';
import { loadLibrary, openLibrary, selectProgram, useMfg } from '../state';
import { loadHolders, useShop } from '../shop/state';
import { namedFailure } from './runFailure';
import { builtAsMeant, camProgram, editorProgram, newCamMain, readProgram, ShopItemMissing, writeProgram, type EditorProgram, type Pin } from './camCode';

/** Running one CAM program: the last step (or, before one, the status the server kept), and what Run is doing. */
export interface CamRun {
  state: CamRunState | null;
  last: { run?: CamRunState['run']; post?: { job_id: string; status: string }; posts?: { setup: string | null; job_id: string; status: string; posted_resolution?: PostedResolution }[]; posted_resolution?: PostedResolution } | null;
  running: boolean;
  /** Saving, Building, Starting… while Run gets going. */
  phase: string | null;
  /** Why Run stopped short (the program's own failures are in `state`). */
  error: string | null;
  /** The document revision `state` ran (unknown for `last`, read when the part opened). */
  revision?: number | null;
}

interface CamDocState {
  /** The open part's CAM documents (null until listed), and whose they are. */
  docs: Record<string, CadDocument>;
  part: string | null;
  /** The program revision each one's last run froze (its jobs and playback). */
  frozen: Record<string, ProgramRecord>;
  runs: Record<string, CamRun>;
  /** A form's change being built and saved: which program and what it's doing. */
  saving: { id: string; phase: string } | null;
  /** A CAM program to select once the part's programs are listed (a link that named it). */
  pending: string | null;
}

export const useCamDoc = create<CamDocState>(() => ({ docs: {}, part: null, frozen: {}, runs: {}, saving: null, pending: null }));
const set = useCamDoc.setState;
const get = useCamDoc.getState;

export const CAM_PREFIX = 'cam:';
export const camRecordId = (documentId: string) => `${CAM_PREFIX}${documentId}`;
export const camDocumentId = (record: { id: string; cam?: { document_id: string } } | null | undefined) => record?.cam?.document_id ?? null;
/** A program store program a CAM document's run froze: it belongs to that document, not to the part's own list. */
export const isFrozen = (record: ProgramRecord) => record.source.startsWith('"""Frozen from a CAM document');
const lastLine = (text: string | null | undefined) => (text ?? '').trim().split('\n').filter(Boolean).pop() ?? 'It doesn’t build.';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NO_RUN: CamRun = { state: null, last: null, running: false, phase: null, error: null };
export const runOf = (id: string): CamRun => get().runs[id] ?? NO_RUN;
const patchRun = (id: string, patch: Partial<CamRun>) => set((state) => ({ runs: { ...state.runs, [id]: { ...(state.runs[id] ?? NO_RUN), ...patch } } }));

// ── Shop items ─────────────────────────────────────────────────────────────

/** A CAM document's shop items as library pins (each item's latest record), by key. */
function shopPins(shop: string | null): Record<string, Pin> {
  const records = new Map(useMfg.getState().records.map((record) => [record.id, record]));
  const out: Record<string, Pin> = {};
  for (const holder of Object.values(useShop.getState().holders)) {
    if (holder.document_id !== shop) continue;
    const record = records.get(holder.library_id);
    if (record) out[holder.key] = { id: record.id, revision: record.revision, kind: record.kind, sha256: record.sha256 };
  }
  return out;
}

/** The shop a CAM program record uses (its `shop` link). */
export function shopOf(record: ProgramRecord | null | undefined): string | null {
  const id = camDocumentId(record);
  return id ? get().docs[id]?.links?.shop?.document_id ?? null : null;
}

/** The key a library record has in a shop, or null when that shop doesn't hold it. */
export function shopKey(shop: string | null, id: string): string | null {
  const holder = useShop.getState().holders[id];
  return holder && shop && holder.document_id === shop ? holder.key : null;
}

// ── Listing ────────────────────────────────────────────────────────────────

/** A CAM document as the editor's program record. */
export function camRecord(doc: CadDocument): ProgramRecord {
  const source = readProgram(doc.code);
  const program = source.program ?? { name: doc.name, setups: [], operations: [] };
  const link = doc.links?.part;
  const frozen = get().frozen[doc.id];
  return {
    id: camRecordId(doc.id), branch: 'main', revision: doc.revision, source: doc.code, source_sha256: '',
    compiled: editorProgram(program, shopPins(doc.links?.shop?.document_id ?? null), link ? { document_id: link.document_id, revision: link.revision ?? 1 } : null) as unknown as ProgramRecord['compiled'],
    dependency_sha256: '', revision_sha256: frozen?.revision_sha256 ?? '', created_at: doc.created_at, git_commit: null, geometry_status: '', execution_status: '',
    cam: { document_id: doc.id, revision: doc.revision, code: source.code, problem: source.problem, line: source.line },
  };
}

/** The CAM documents that machine a part (their part link names it). */
async function camDocumentsOf(part: string): Promise<CadDocument[]> {
  const { documents } = await api<{ documents: DocumentSummary[] }>(`/v1/documents?kind=cam&limit=100&links_to=${encodeURIComponent(part)}`);
  const docs = await Promise.all(documents.filter((item) => item.kind === 'cam').map((item) => Api.document(item.id).catch(() => null)));
  return docs.filter((doc): doc is CadDocument => !!doc && doc.links?.part?.document_id === part);
}

/** The open part's CAM programs as records (newest first), with what their pins and last runs need. */
export async function loadCamRecords(part: string): Promise<ProgramRecord[]> {
  const [docs] = await Promise.all([
    camDocumentsOf(part),
    useMfg.getState().recordsLoaded ? null : loadLibrary(),
    Object.keys(useShop.getState().holders).length ? null : loadHolders(),
  ]);
  set((state) => ({ part, docs: Object.fromEntries(docs.map((doc) => [doc.id, doc])), ...(state.part !== part ? { runs: {}, frozen: {} } : {}) }));
  // Where each one's last run got to (read only: nothing starts).
  await Promise.all(docs.filter((doc) => !get().runs[doc.id]?.state && !get().runs[doc.id]?.last).map(async (doc) => {
    try {
      const { cam } = await Api.camStatus(doc.id);
      if (!cam) return;
      patchRun(doc.id, { last: { run: cam.run, post: cam.post, posts: cam.posts, posted_resolution: cam.posted_resolution } });
      const frozen = await programs.get(cam.program_id).catch(() => null);
      if (frozen) set((state) => ({ frozen: { ...state.frozen, [doc.id]: frozen } }));
    } catch { /* The program still shows; Run reads it again. */ }
  }));
  return docs.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(camRecord);
}

/** Puts a CAM document's record (as saved now) into the part's programs. */
function refresh(doc: CadDocument) {
  set((state) => ({ docs: { ...state.docs, [doc.id]: doc } }));
  const record = camRecord(doc);
  useMfg.setState((state) => ({ programs: [record, ...state.programs.filter((item) => item.id !== record.id)] }));
  return record;
}

/** A frozen program revision by its id (playback of a CAM program's run). */
export const frozenRecord = (id: string | null) => Object.values(get().frozen).find((record) => record.id === id) ?? null;

// ── Changing a program through its code ────────────────────────────────────

/** Builds a CAM program's source (a cache hit when it built before) and waits for it. */
async function buildSource(name: string, source: { code: string; files: Record<string, string>; links: Record<string, LinkRef> }): Promise<Build> {
  let build = await Api.submit({ kind: 'cam', name, ...source, mode: 'full' });
  while (build.status !== 'succeeded' && build.status !== 'failed') {
    await sleep(600);
    build = await Api.build(build.id);
  }
  if (build.code === undefined) build = await Api.build(build.id);
  return build;
}

/**
 * Changes a CAM program's main.py: `edit` gets the latest saved document and returns its new main.py (and links), or
 * why not. The new source builds first; only one that builds is saved, as a new revision with its build. Returns the
 * saved document, or null (and says why).
 */
async function changeSource(id: string, what: string, edit: (doc: CadDocument) => { code: string; files?: Record<string, string>; links?: Record<string, LinkRef>; meant?: Record<string, unknown> } | string): Promise<CadDocument | null> {
  if (get().saving) { toast('info', what, 'Wait until the program has finished saving.'); return null; }
  set({ saving: { id, phase: 'Saving' } });
  try {
    const latest = await Api.document(id);
    const next = edit(latest);
    if (typeof next === 'string') { toast('info', what, next); return null; }
    const links = next.links ?? latest.links ?? {};
    const files = next.files ?? latest.files ?? {};
    set({ saving: { id, phase: 'Building' } });
    const build = await buildSource(latest.name, { code: next.code, files, links });
    if (build.status !== 'succeeded') {
      toast('danger', `${what}: not saved`, `The program wouldn’t build with this change: ${lastLine(build.error)}`);
      return null;
    }
    // A form's change must build into exactly the program the form meant; anything else is a misread, never saved.
    if (next.meant && !builtAsMeant(next.meant as never, (camMetadata(build)?.program ?? null) as never)) {
      toast('danger', `${what}: not saved`, 'The program built differently from this change, so it wasn’t saved. Make the change in the program’s Code instead.');
      return null;
    }
    set({ saving: { id, phase: 'Saving' } });
    let saved: CadDocument;
    try {
      saved = await Api.updateDocument(id, { name: latest.name, kind: 'cam', code: next.code, files, links, preview_build_id: build.id, revision: latest.revision });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) { toast('warning', `${what}: not saved`, 'The program was saved somewhere else at the same moment. It’s reloaded: try again.'); void reload(id); return null; }
      throw error;
    }
    refresh(saved);
    return saved;
  } catch (error) {
    toast('danger', `${what}: not saved`, (error as Error).message);
    return null;
  } finally { set({ saving: null }); }
}

async function reload(id: string) {
  try { refresh(await Api.document(id)); } catch { /* The list reloads with the part. */ }
}

/** A CAM program as saved now (after STEVE changed it): the editor, the forms and the tree show that revision. */
export async function reloadCam(id: string): Promise<CadDocument | null> {
  await reload(id);
  return get().docs[id] ?? null;
}

/** The part link moved onto the open part's saved revision: forms pick names from the part as it's shown. */
function followPart(doc: CadDocument): Record<string, LinkRef> {
  const open = app().doc.saved;
  const links = { ...(doc.links ?? {}) };
  if (open && links.part?.document_id === open.id) links.part = { ...links.part, revision: open.revision };
  return links;
}

/**
 * Saves the editor's program (a setup or operation saved, a rename, a move or a removal) into the CAM document's code.
 * Throws ShopItemMissing (with the form field) when it names a library record the program's shop doesn't hold.
 * `expected`: the revision the edit was made on (a newer one saved meanwhile refuses it).
 */
export async function saveCamProgram(record: ProgramRecord, program: EditorProgram, what: string): Promise<ProgramRecord | null> {
  const id = camDocumentId(record)!;
  const shop = shopOf(record);
  // Checked here first, so the form shows which field.
  camProgram(program, (pin) => shopKey(shop, pin), {});
  const saved = await changeSource(id, what, (doc) => {
    if (doc.revision !== record.revision) return 'This program was changed since it was shown (in its code, or by STEVE). It’s reloaded: make the change again.';
    const source = readProgram(doc.code);
    if (!source.program) return `${source.problem ?? 'main.py has no program.'} Edit it in the program’s Code (main.py line ${source.line}).`;
    const meant = camProgram(program, (pin) => shopKey(shop, pin), source.program);
    return { code: writeProgram(doc.code, meant as never), links: followPart(doc), meant };
  });
  if (!saved) { void reload(id); return null; }
  return camRecord(saved);
}

/** Saves main.py as the person wrote it (`revision`: the one it was edited from), e.g. Undo putting a revision back. */
export async function saveCamCode(id: string, code: string, revision: number): Promise<boolean> {
  return !!await changeSource(id, 'Code saved', (doc) => (doc.revision !== revision
    ? `The program was saved meanwhile (revision ${doc.revision}). Copy your edits, reload and apply them again.` : { code }));
}

/** Saves a CAM program's files as edited in the code editor (main.py and the rest), built first. */
export async function saveCamFiles(id: string, files: Record<string, string>, revision: number): Promise<boolean> {
  const { 'main.py': code, ...rest } = files;
  return !!await changeSource(id, 'Code saved', (doc) => (doc.revision !== revision
    ? `The program was saved meanwhile (revision ${doc.revision}). Copy your edits, reload and apply them again.` : { code: code ?? doc.code, files: rest }));
}

/** What ShopItemMissing means, in the person's words. */
export function missingItemMessage(error: ShopItemMissing, record: ProgramRecord | null): string {
  const item = useMfg.getState().records.find((entry) => entry.id === error.pin.id);
  const shop = useShop.getState().shops?.find((entry) => entry.id === shopOf(record))?.name ?? 'your shop';
  return `${item?.definition.name ?? 'This item'} isn’t in ${shop}: a CAM program uses its shop’s machines and tools. Add it on Manufacture → Shop, then choose it here.`;
}

// ── Run ────────────────────────────────────────────────────────────────────

const tokens: Record<string, number> = {};

/**
 * Run: builds the saved revision when it hasn't built, then takes one step every 3 seconds until the program has run
 * every operation, posted and been checked (or failed). Nothing starts twice: asking again continues where it is.
 * `announce`: started from a setup or an operation (Generate), where the run's section isn't on screen: say it started
 * too. How it ends is always said (a failure sticks), wherever the person is by then.
 */
export async function runCam(id: string, { announce = false }: { announce?: boolean } = {}) {
  const doc = get().docs[id];
  if (!doc) return;
  if (runOf(id).running) {
    if (announce) toast('info', 'Already running', `${doc.name} is running; its progress shows in the setup and the program.`);
    return;
  }
  if (announce) toast('info', `Running ${doc.name}`, 'A CAM program runs as a whole: every operation, then the G-code is posted and checked. Its progress shows in the setup and the program.');
  const failed = (message: string) => {
    patchRun(id, { error: message });
    toast('danger', `${doc.name} didn’t run`, message, { sticky: true });
  };
  const token = (tokens[id] = (tokens[id] ?? 0) + 1);
  const alive = () => tokens[id] === token && get().docs[id] !== undefined;
  patchRun(id, { running: true, error: null, phase: 'Starting' });
  try {
    let built = false;
    for (;;) {
      if (!alive()) return;
      const current = get().docs[id];
      let step: CamRunState;
      try {
        step = await Api.camRun(id, current.revision);
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && /not_built|hasn.t built/.test(`${error.code} ${error.message}`) && !built) {
          built = true;
          patchRun(id, { phase: 'Building' });
          const build = await buildSource(current.name, { code: current.code, files: current.files ?? {}, links: current.links ?? {} });
          if (build.status !== 'succeeded') { failed(`The program doesn’t build: ${lastLine(build.error)}`); return; }
          continue;
        }
        if (error instanceof ApiError && error.code === 'reference_review_required') {
          // Issue 944/947: the part changed, and the server holds this revision until a person accepts the review. The
          // review banner works on the held program revision: load it, so the banner shows where Run was pressed.
          const details = error.data.details as { candidate?: { program_id: string; branch: string; revision: number }; review?: unknown } | undefined;
          const candidate = details?.candidate;
          const held = candidate ? await programs.get(candidate.program_id, candidate.branch, candidate.revision).catch(() => null) : null;
          if (held) set((state) => ({ frozen: { ...state.frozen, [id]: held } }));
          // Issue 1008: Steve's own review found changes (its message lists them), or there was none. The toast's Review
          // takes the person to it: the program selected and its review started, its Accept under the changes.
          const message = details?.review ? error.message : 'The part changed since this program was accepted: review the design change and accept it, then run again.';
          patchRun(id, { error: message });
          toast('warning', 'Review the design change first', message, {
            sticky: true,
            action: { label: 'Review', run: () => {
              selectProgram(camRecordId(id));
              if (held) void import('./ReferenceReview').then(({ startReview }) => startReview(held));
            } },
          });
          return;
        }
        throw error;
      }
      if (!alive()) return;
      patchRun(id, { state: step, last: null, phase: null, revision: current.revision });
      if (get().frozen[id]?.id !== step.program.id || get().frozen[id]?.revision !== step.program.revision) {
        const frozen = await programs.get(step.program.id).catch(() => null);
        if (frozen) set((state) => ({ frozen: { ...state.frozen, [id]: frozen } }));
      }
      if (step.done) {
        const { loadJobs } = await import('./state');
        void loadJobs(step.program.id);
        if (step.stage === 'verified') toast('success', 'Program verified', 'Every operation ran, the G-code is posted and Steve’s checks passed.');
        else if (step.stage === 'checked') toast('info', 'Program posted', 'Every operation ran and the G-code is posted; some of Steve’s checks couldn’t be completed: see the run’s checks.');
        else if (step.stage === 'failed') {
          const checks = step.error?.code === 'run_failed_checks' && step.verification ? ' The checks are listed in the program’s Run section, each with where it happened.' : '';
          failed(`${namedFailure(step.error, get().frozen[id], 'An operation failed: see the run in the program.')}${checks}`);
        }
        return;
      }
      await sleep(3000);
    }
  } catch (error) {
    // No machining on this server right now (no workers, or they can't be reached): the program is saved as it is.
    const unavailable = error instanceof ApiError && error.status === 503;
    if (alive()) failed(unavailable ? `Machining isn’t available on this server right now: the program is saved, run it again later. (${(error as Error).message})` : (error as Error).message);
  } finally {
    if (tokens[id] === token) patchRun(id, { running: false, phase: null });
  }
}

/**
 * Whether a CAM program's last run may predate its current revision. Run records the revision it ran; a run read when
 * the part opened is compared by time: the document saved after the run's frozen revision was made counts as changed
 * (a save that left the program as it was too, so it errs towards saying so).
 */
export function runMayBeStale(id: string): boolean {
  const run = runOf(id), doc = get().docs[id], frozen = get().frozen[id];
  if (!doc || (!run.state && !run.last)) return false;
  if (run.state && typeof run.revision === 'number') return run.revision !== doc.revision;
  return !frozen || !(Date.parse(doc.updated_at) <= Date.parse(frozen.created_at));
}

/** A failure's words: what happened, why, and what to do. */
export const failureText = (error: CamFailure) => [error.message, error.why, error.next_step].filter(Boolean).join(' ');

/** A CAM program's last run's posts: one per setup, in setup order (a single setup's from `post` when it has no list). */
export function postsOf(id: string): { setup: string | null; job_id: string; status: string }[] {
  const run = runOf(id), posts = run.state?.posts ?? run.last?.posts;
  if (posts?.length) return posts;
  const post = run.state?.post ?? run.last?.post;
  return post?.job_id ? [{ setup: null, job_id: post.job_id, status: post.status }] : [];
}

/** The posted job of a CAM program's last run: its setup's, with several setups. */
const postOf = (id: string, setup?: string | null) => {
  const posts = postsOf(id);
  // One setup: its post, whichever setup is selected. Several: the named setup's.
  return (posts.length === 1 ? posts[0] : setup ? posts.find((post) => post.setup === setup) : null) ?? null;
};

/** Download G-code: the posted file (with several setups, that setup's), through the authenticated job artifact route. */
export async function downloadGcode(id: string, setup?: string | null) {
  const post = postOf(id, setup);
  if (!post && postsOf(id).length > 1) { toast('info', 'One G-code file per setup', 'Choose the setup: each has its own Download G-code under Run.'); return; }
  if (!post) { toast('info', 'No G-code yet', 'Run the program: once it’s posted and checked, its G-code downloads here.'); return; }
  const { downloadMachineFile } = await import('./state');
  try { await downloadMachineFile(await jobs.get(post.job_id)); } catch (error) { toast('danger', 'Couldn’t download the G-code', (error as Error).message); }
}

/**
 * The posted program (with several setups, that setup's) in the simulation player. A run that stopped before posting
 * (an operation failed, or its checks did) has no program to play: the last operation of the run (of that setup) that
 * generated plays instead, starting on the stock the ones before it left. Its own checks show in the player,
 * failed ones too, and its G-code downloads only as its checks allow.
 */
export async function simulateCam(id: string, setup?: string | null) {
  const post = postOf(id, setup);
  if (!post && postsOf(id).length > 1) { toast('info', 'One G-code file per setup', 'Choose the setup: each has its own Simulate under Run.'); return; }
  if (post?.status === 'succeeded') {
    const { openPlayer } = await import('./state');
    try { await openPlayer(await jobs.get(post.job_id)); } catch (error) { toast('danger', 'Couldn’t open the simulation', (error as Error).message); }
    return;
  }
  const camState = await import('./state');
  const frozen = get().frozen[id] ?? null;
  const name = (operation: string) => `‘${frozen ? camState.operationName(frozen, operation) : operation}’`;
  // The setup an operation of the run belongs to (a pattern instance's, its pattern's).
  const setupOf = (operation: string) => {
    const source = frozen ? camState.sourceOperation(frozen.id, operation) : operation;
    return ((frozen?.compiled.operations ?? []) as { id?: string; setup?: string }[]).find((op) => op.id === source)?.setup ?? null;
  };
  const ran = runOperations(id);
  try {
    for (const op of ran.filter((item) => item.job_id && (!setup || setupOf(item.operation) === setup)).reverse()) {
      const job = await jobs.get(op.job_id!);
      if (job.status !== 'succeeded') continue;
      const stopped = ran.find((item) => item.status === 'failed' || item.status === 'blocked');
      toast('info', 'The program isn’t posted', `${stopped ? `${name(stopped.operation)} didn’t finish, so there’s no G-code for the whole program. ` : ''}`
        + `Playing ${name(op.operation)}, the last operation that generated; each generated operation plays from its row under Run.`);
      await camState.openPlayer(job);
      return;
    }
  } catch (error) { toast('danger', 'Couldn’t open the simulation', (error as Error).message); return; }
  toast('info', 'Nothing to simulate yet', 'Run the program: each operation plays once it’s generated, and the whole program once it’s posted.');
}

/** One operation of the CAM program's last run in the player: its own toolpath, stock and checks. A
 * pattern plays its first instance. */
export async function simulateCamOperation(id: string, operation: string) {
  const { openPlayer, operationName, sourceOperation } = await import('./state');
  const frozen = get().frozen[id] ?? null;
  const op = runOperations(id).find((item) => item.operation === operation || (frozen && sourceOperation(frozen.id, item.operation) === operation));
  const name = `‘${frozen ? operationName(frozen, operation) : operation}’`;
  if (!op?.job_id) { toast('info', 'Not generated yet', `${name} hasn’t been generated in the program’s last run: run the program.`); return; }
  try {
    const job = await jobs.get(op.job_id);
    if (job.status !== 'succeeded') {
      toast('info', 'Not generated', `${name} didn’t generate in the last run, so there’s nothing of it to play: see its row under Run.`);
      return;
    }
    await openPlayer(job);
  } catch (error) { toast('danger', 'Couldn’t open the simulation', (error as Error).message); }
}

/** The operations of a CAM program's last run, in run order. */
const runOperations = (id: string) => runOf(id).state?.run?.operations ?? runOf(id).last?.run?.operations ?? [];

// ── New program ────────────────────────────────────────────────────────────

/** The workspace's shop: the one Manufacture → Shop shows, else the latest changed. */
async function workspaceShop(): Promise<DocumentSummary | null> {
  const { documents } = await Api.documents({ kind: 'shop', limit: 100 });
  const shops = documents.filter((item) => item.kind === 'shop').sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return shops.find((item) => item.id === useShop.getState().doc?.id) ?? shops[0] ?? null;
}

/**
 * New program for the open part or design: a CAM document linking it as `part` and the workspace's shop as `shop`,
 * built and saved, listed with the part's programs and selected. No shop yet: Manufacture → Shop first. Returns its
 * record (the Setup tool then starts on it).
 */
export async function newCamProgram(): Promise<ProgramRecord | null> {
  const { doc } = app();
  if (!doc.open || (doc.kind !== 'part' && doc.kind !== 'design')) { toast('info', 'Open the part to machine', 'A program machines a part or design: open it, then make the program.'); return null; }
  if (!doc.saved) { toast('info', 'Save the part first', 'A program machines a saved revision of the part.'); return null; }
  let shop: DocumentSummary | null;
  try { shop = await workspaceShop(); } catch (error) { toast('danger', 'Couldn’t read your shop', (error as Error).message); return null; }
  if (!shop) {
    toast('info', 'Set up your shop first', 'A program uses your shop’s machine and tools: add them on Manufacture → Shop, then make the program.');
    openLibrary('shop');
    return null;
  }
  const part = doc.saved;
  const count = Object.values(get().docs).filter((item) => item.links?.part?.document_id === part.id).length;
  const name = count ? `${doc.name.trim() || 'Part'} program ${count + 1}` : `${doc.name.trim() || 'Part'} program`;
  const code = newCamMain(name, doc.name.trim() || 'Part');
  const links: Record<string, LinkRef> = { part: { document_id: part.id, revision: part.revision }, shop: { document_id: shop.id, revision: shop.revision } };
  set({ saving: { id: '', phase: 'Creating the program' } });
  try {
    const build = await buildSource(name, { code, files: {}, links }).catch(() => null);
    const created = await Api.createDocument({ name, kind: 'cam', code, files: {}, links, preview_build_id: build?.status === 'succeeded' ? build.id : null });
    const record = refresh(created);
    useMfg.setState({ activeProgram: record.id });
    return record;
  } catch (error) {
    toast('danger', 'Couldn’t create the program', (error as Error).message);
    return null;
  } finally { set({ saving: null }); }
}

/** A copy of a CAM program under a new name: its code (the program renamed in it) and links, its own history. */
export async function duplicateCam(id: string, name: string) {
  const doc = await Api.document(id);
  const source = readProgram(doc.code);
  const code = source.program ? writeProgram(doc.code, { ...source.program, name }) : doc.code;
  const build = await buildSource(name, { code, files: doc.files ?? {}, links: doc.links ?? {} }).catch(() => null);
  await Api.createDocument({ name, kind: 'cam', code, files: doc.files ?? {}, links: doc.links ?? {}, preview_build_id: build?.status === 'succeeded' ? build.id : null });
}

// ── Links that name a shop or a CAM program ────────────────────────────────

/**
 * Where a shop or CAM document goes when something names it (a URL, a toast, a stored tab): never a file of its own.
 * A shop shows on Manufacture → Shop; a CAM program opens its part in Manufacture with the program selected.
 */
export async function openStored(doc: CadDocument) {
  const { closeDocumentTabs, openTab } = await import('@/state/tabs');
  closeDocumentTabs(doc.id);
  if (!app().workspaces.includes('manufacture')) { toast('info', 'Manufacture isn’t available here', `${doc.name} is worked in Manufacture.`); return; }
  setApp({ workspace: 'manufacture' });
  if (doc.kind === 'shop') {
    const { showShop } = await import('../shop/state');
    openLibrary('shop');
    void showShop(doc.id);
    return;
  }
  const part = doc.links?.part?.document_id;
  if (!part) { toast('info', `${doc.name} has no part`, 'A program machines a part: this one doesn’t link one any more.'); return; }
  set({ pending: camRecordId(doc.id) });
  openTab({ id: part });
}

/** The program a link named, selected once the part's programs are listed. */
export function takePending(ids: string[]): string | null {
  const pending = get().pending;
  if (!pending || !ids.includes(pending)) return null;
  set({ pending: null });
  return pending;
}

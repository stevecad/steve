/**
 * CAM milling state: the program editor (setup + one operation draft: pocket, rest, face, contour, drilling or a bore), viewport picking for
 * it, native jobs per operation, program runs (every operation in order, stock carried along) and their combined
 * output, and the simulation player's loaded artifacts. Server records are authoritative; drafts are local until
 * saved as a program revision, and every verdict shown comes from the job's own reports.
 */
import { create } from 'zustand';
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import { setPickGuard } from '@/viewport/pickGuard';
import { get as app, set as setApp, toast, useApp } from '@/state/store';
import { jobs, MfgError, programs, terminal, type JobRecord, type Program, type ProgramRecord } from '../api';
import { loadStatus as loadReferenceStatus, startReview } from './ReferenceReview';
import { loadLibrary, loadPrograms, programProcess, report, selectProgram, useMfg } from '../state';
import { touchCommands } from '@/commandEpoch';
import {
  camJobs, artifactBytes, artifactJson, artifactText, type ExpandedOperation, type BoreCoverage, type BoreGeometry, type ContourGeometry, type ContourResult, type DrillGeometry, type FixtureDisplay, type HoleResult, type OperationCapability, type PostAssessment,
  type EngraveCoverage, type EngravePathOut, type FixtureContact, type RestPlan, type SolidRefinement, type SlotCoverage, type SlotPath, type SurfaceCoverage, type SurfacePathOut, type TabRegion, type TabState,
  type ProgramStateTransition, type ProgramVerificationEvents, type ResolvedMachineSnapshot, type ResolvedSetup, type ResolvedToolSetupSnapshot, type RunRecord,
  type SimulationPreview, type StockInspection, type VerificationEvent,
} from './api';
import { cumulativeTime, decodeChunk, joinChunks, moveForLine, MOTION_FORMATS, PROGRAM_MOTION_FORMAT, type Motion } from './motion';
import {
  autoStock, bodyBounds, bodyHoles, CODE_HINTS, contourEdgeOf, contourFaceOf, cutterOf, displayedBodies, draftOf as savedDraftOf, DraftError, engraveSourcesOf, facedTop, failureField, faceToRefs, fieldOfPath, followsOutline, holeOf, isDrilling, isPocketing, isSurface,
  draftPlacement, editableKind, frameBox, middleOfTravel, frameMatrix4, isIdentityFrame, kindOf, newOperation, newSetup, newSetupId, OP_LABEL, opLabelLower, opsOfSetup, placementOf, programOf, reorderedProgram, setupOfOperation, withoutSetup, stockBoxOf, suggestedOrigin, tabEdgeOf, takesFloor, takesHoles, transferFrame, upwardFloors, type BodyRef, type FloorRef, type Frame, type OpKind, type TransferPreset,
  type EngraveCurveRef, type EngravePathDraft, type OperationDraft, type ProgramDraft, type TabDraft,
} from './program';
import { chamferBottom, engraveWidth, joinPieces } from './engrave';
import { roughProblems } from './rough';
import { curveAt, horizontalSketches, sketchCurve, type SketchCurve } from './sketchCurves';
import type { Pick } from '@/state/store';
import type { AssemblySnapshot } from '../toolGeometry';
import { namedFailure } from './runFailure';
import { CAM_PREFIX, downloadGcode, frozenRecord, missingItemMessage, newCamProgram, runCam, saveCamProgram, simulateCam, simulateCamOperation } from './camDoc';
import { ShopItemMissing, type EditorProgram } from './camCode';
import { deleteOperation, deleteSetup, dependentsOf, duplicateOperation, duplicateSetup, moveOperation, moveOperationToSetup, onlySetup, renameOperation } from './programEdits';
import { Api, type PostedResolution } from '@/lib/api';

/** Which tool the editor is: the Setup tool (a setup on its own) or an operation's tool (the operation, in a setup). */
export type EditorMode = 'setup' | 'op';
export interface Editor {
  /** The program the setup or operation belongs to: null for the document's first setup (saving creates it). */
  programId: string | null;
  /** Revision the draft was opened from (a stale save becomes a conflict). */
  revision: number | null;
  draft: ProgramDraft;
  mode: EditorMode;
  errors: Record<string, string>;
  busy: boolean;
  conflict: ProgramRecord | null;
}

/** `posted`: what the controller rounds in a job posted at six decimals (cam/postedResolution.ts); null when nothing. */
export interface Results { assessment: PostAssessment | null; error: string | null; posted?: PostedResolution | null }

/** A drilling result: each hole's completion (the backend's), where it is (work frame) and how deep the tip went. */
export interface HoleRow extends HoleResult { center: [number, number] | null; radius: number | null; deepestZ: number | null }
export interface HoleResults { holes: HoleRow[]; error: string | null }

/** A hole drawn in the viewport (work frame, mm). */
export interface HoleMark { center: [number, number]; radius: number; top: number; bottom: number; id: string }

/** A contour result: the chain's coverage (the backend's), and where it runs (work frame XY, its plane and floor). */
export interface ContourRow extends ContourResult { points: [number, number][]; closed: boolean; z: number | null; floor: number | null }
export interface ContourResults { contours: ContourRow[]; tabs: TabRow[]; error: string | null }
/** A contour drawn in the viewport (work frame, mm). */
export interface ContourMark { id: string; points: [number, number][]; closed: boolean; z: number; floor: number | null }
/** A retention tab's result (the backend's material and preservation verdicts) and where the bridge is (work frame). */
export interface TabRow extends TabState { corners: [number, number][] | null; bottom: number | null; top: number | null }
/** A tab bridge drawn in the viewport (work frame, mm): its footprint corners and its bottom and top heights. */
export interface TabMark { id: string; corners: [number, number][]; bottom: number; top: number }

/** A bore result: its finishing coverage (the backend's) and where it is (work frame). */
export interface BoreRow extends BoreCoverage { center: [number, number] | null; radius: number | null }
export interface BoreResults { bores: BoreRow[]; floor: number | null; error: string | null }

/** A slot result: its finishing coverage (the backend's) and its centreline and width (work frame), when known. */
export interface SlotRow extends SlotCoverage { points: [number, number][]; width: number | null }
export interface SlotResults { slots: SlotRow[]; floor: number | null; error: string | null }
/** A slot drawn in the viewport (work frame, mm): its centreline at the floor and its width. */
export interface SlotMark { id: string; points: [number, number][]; width: number; z: number }

/** One tool region against one fixture: its verdict and the contacts behind it (the first, for showing it). */
export interface FixtureRegionRow { region: string; status: 'failed' | 'uncertain'; contacts: number; first: FixtureContact }
/** A fixture's clearance: failed (a witnessed collision), uncertain (unresolved contact) or passed (no contact found). */
export interface FixtureRow { fixture: string; name: string; status: 'passed' | 'failed' | 'uncertain'; regions: FixtureRegionRow[] }
export interface FixtureResults { fixtures: FixtureRow[]; refinement: SolidRefinement | null; error: string | null }

/** A 3D finishing path's result: its coverage (the backend's) and its approved tool-tip points (work frame), when known. */
export interface SurfaceRow extends SurfaceCoverage { points: [number, number, number][]; closed: boolean }
export interface SurfaceResults { paths: SurfaceRow[]; error: string | null }
/** A 3D path drawn in the viewport (work frame, mm). */
export interface SurfaceMark { id: string; points: [number, number, number][]; closed: boolean }

/** An engraving path's result: its coverage (the backend's) and where it runs (work frame), when known. */
export interface EngraveRow extends EngraveCoverage { points: [number, number][]; closed: boolean; width: number | null; z: number | null }
export interface EngraveResults { paths: EngraveRow[]; error: string | null }

/** What the editor is picking in the viewport. */
export type Picking = 'floor' | 'fixtures' | 'holes' | 'contour-faces' | 'contour-edges' | 'tabs' | 'engrave-curves' | 'engrave-edges';

interface CamState {
  editor: Editor | null;
  picking: Picking | null;
  machine: ResolvedMachineSnapshot | null;
  tooling: ResolvedToolSetupSnapshot | null;
  /** Native engine families configured on the server (null until asked). */
  engines: string[] | null;
  /** The engine list couldn't be read (machining is unavailable right now), as opposed to a server with no engine. */
  enginesUnavailable: boolean;
  /** What the engines execute (`GET /capabilities`; null until asked, [] when the server has none). */
  capabilities: OperationCapability[] | null;
  /** STEVE's own posts by controller dialect, named as the setup's Post offers them (`GET /capabilities`
   *  controller_dialects builtin_post_label): a milling setup on one of these needs no post from the library. */
  builtInPosts: Record<string, string>;
  /** The selected operation; null with a program selected is the program as a whole. */
  activeOperation: string | null;
  /** The setup selected in the browser (operations are added to it): `${programId}:${setupId}`. */
  activeSetup: string | null;
  /** Operation jobs per program, newest first. */
  jobs: Record<string, JobRecord[]>;
  /** Combined-output (`program_post`) jobs per program, newest first. */
  posts: Record<string, JobRecord[]>;
  /** Program runs per program, newest first. */
  runs: Record<string, RunRecord[]>;
  activeJob: string | null;
  results: Record<string, Results>;
  holes: Record<string, HoleResults>;
  highlight: HoleMark | null;
  contours: Record<string, ContourResults>;
  contourHighlight: ContourMark | null;
  tabHighlight: TabMark | null;
  bores: Record<string, BoreResults>;
  rest: Record<string, { plan: RestPlan | null; error: string | null }>;
  slots: Record<string, SlotResults>;
  slotHighlight: SlotMark | null;
  surfaces: Record<string, SurfaceResults>;
  fixtureChecks: Record<string, FixtureResults>;
  surfaceHighlight: SurfaceMark | null;
  engrave: Record<string, EngraveResults>;
  /** The sketch curve under the pointer while picking engraving curves. */
  engraveHover: SketchCurve | null;
  /** Each saved revision's executable operations (`program:revision`; patterns expanded into their instances). */
  expansions: Record<string, ExpandedOperation[]>;
}

export const useCam = create<CamState>(() => ({
  editor: null, picking: null, machine: null, tooling: null, engines: null, enginesUnavailable: false, capabilities: null, builtInPosts: {}, activeOperation: null, activeSetup: null,
  jobs: {}, posts: {}, runs: {}, activeJob: null, results: {}, holes: {}, highlight: null, contours: {}, contourHighlight: null, tabHighlight: null, bores: {}, rest: {}, slots: {}, slotHighlight: null,
  engrave: {}, engraveHover: null, expansions: {}, surfaces: {}, surfaceHighlight: null, fixtureChecks: {},
}));
const set = useCam.setState;
// Operation commands need a setup, Generate a selection: the ribbon checks again when either changes.
useMfg.subscribe((state, previous) => { if (state.programs !== previous.programs || state.activeProgram !== previous.activeProgram) touchCommands(); });
useCam.subscribe((state, previous) => { if (state.activeSetup !== previous.activeSetup || state.activeOperation !== previous.activeOperation || state.capabilities !== previous.capabilities) touchCommands(); });
const get = useCam.getState;

export const NATIVE_FAMILY = 'native_milling_v1';
const SETUP_FIELDS = ['machine', 'tooling', 'post', 'placement', 'stock', 'fixtures', 'inspection'];

export async function loadEngines() {
  try { set({ engines: (await camJobs.engines()).map((engine) => String(engine.family)), enginesUnavailable: false }); }
  catch { set({ engines: [], enginesUnavailable: true }); }
}

/** What the engines run; the ribbon's operations follow it (re-evaluated once it arrives). */
export async function loadCapabilities() {
  try {
    const value = await camJobs.capabilities();
    const builtInPosts = Object.fromEntries((value.controller_dialects ?? []).flatMap((item) => (item.builtin_post_label ? [[item.id, item.builtin_post_label]] : [])));
    set({ capabilities: value.operations, builtInPosts });
  }
  catch { set({ capabilities: [], builtInPosts: {} }); }
  setApp({});
}

/** Whether an operation kind runs on this server (true), or why not. */
export function capable(kind: OpKind): true | string {
  const list = get().capabilities;
  if (list === null) return 'Checking what the machining engine runs…';
  return list.some((item) => item.operation === kind) ? true : `This server's machining engine doesn't run ${opLabelLower(kind)} yet.`;
}

/** The entries the engine runs for an operation kind (`GET /capabilities` entry_modes), plunge when unknown. */
export function entryModes(kind: OpKind): string[] {
  return get().capabilities?.find((item) => item.operation === kind)?.entry_modes ?? ['plunge'];
}

/** Whether the engine keeps contour retention tabs. */
export const tabsSupported = () => !!get().capabilities?.find((item) => item.operation === 'contour')?.retention_tabs;

/** The pattern layouts the engine repeats an operation kind with (`GET /capabilities` patterns); [] for none. */
export function patternKinds(kind: OpKind): string[] {
  return get().capabilities?.find((item) => item.operation === kind)?.patterns ?? [];
}

// ── Pattern expansion ──────────────────────────────────────────────────────

const expansionKey = (record: ProgramRecord) => `${record.id}:${record.revision}`;

/** A saved revision's executable operations (cached per revision); patterns become their active instances. */
export async function loadExpansion(record: ProgramRecord) {
  if (get().expansions[expansionKey(record)] || isCam(record)) return;
  const authored = record.compiled.operations as { pattern?: unknown }[];
  // Without a pattern the executable operations are the authored ones: no request needed.
  if (!authored.some((op) => op.pattern)) return;
  try {
    const expanded = await camJobs.expansion(record.id, record.branch, record.revision);
    set((state) => ({ expansions: { ...state.expansions, [expansionKey(record)]: expanded.operations } }));
  } catch { /* names fall back to the executed IDs */ }
}

/** The executable operations of a revision when it has a pattern (null: the authored ones, or not loaded yet). */
export function expandedOps(record: ProgramRecord): ExpandedOperation[] | null { return get().expansions[expansionKey(record)] ?? null; }

const instanceOf = (programId: string, id: string): ExpandedOperation | null => {
  for (const [key, ops] of Object.entries(get().expansions)) {
    if (!key.startsWith(`${programId}:`)) continue;
    const op = ops.find((item) => item.id === id && item.pattern_instance);
    if (op) return op;
  }
  return null;
};

/** The authored operation an executed ID belongs to: itself, or the pattern an instance came from. */
export const sourceOperation = (programId: string, id: string) => instanceOf(programId, id)?.pattern_instance?.source_operation ?? id;

/** A pattern instance's key (u1_v0, r2, …), or null for an ordinary operation. */
export const instanceKey = (programId: string, id: string) => instanceOf(programId, id)?.pattern_instance?.placement.key ?? null;

/** What to call an executed operation: its authored name, or the instance's ("Pocket [u1_v0]"). */
export function operationName(record: ProgramRecord, id: string): string {
  const authored = (record.compiled.operations as { id?: string; name?: string }[]).find((op) => op.id === id);
  return String(authored?.name ?? instanceOf(record.id, id)?.name ?? id);
}

// ── Editor ─────────────────────────────────────────────────────────────────

const designPin = () => {
  const doc = app().doc;
  if (!doc.saved) throw new DraftError('form', 'Save the design first: a program pins a saved revision.');
  return { document_id: doc.saved.id, branch: doc.branch || 'main', revision: doc.saved.revision };
};

function program(id: string | null) { return useMfg.getState().programs.find((item) => item.id === id) ?? frozenRecord(id); }
/** A CAM program (a document, cam/camDoc.ts): its changes go into its code, and Run runs it as a whole. */
const isCam = (record: ProgramRecord | null | undefined): record is ProgramRecord & { cam: NonNullable<ProgramRecord['cam']> } => !!record?.cam;

/** Saves a CAM program's changed program into its code; a shop item it doesn't have lands on the field. */
async function saveCam(record: ProgramRecord, next: Program, what: string): Promise<ProgramRecord | null> {
  try { return await saveCamProgram(record, next as unknown as EditorProgram, what); } catch (error) {
    if (error instanceof ShopItemMissing) {
      const message = missingItemMessage(error, record);
      if (get().editor) set((state) => ({ editor: state.editor ? { ...state.editor, busy: false, errors: { [error.field]: message } } : null }));
      else toast('info', what, message);
      return null;
    }
    throw error;
  }
}

/** Opens a tool's editor (the dock switches to it: shell/toolDock), with the libraries its pickers need. */
function openEditor(editor: Editor) {
  set({ editor, picking: null });
  if (editor.programId) useMfg.setState({ activeProgram: editor.programId });
  void loadLibrary();
  if (editor.draft.setup.machine) void loadMachine();
  if (editor.draft.setup.tooling) void loadTooling();
}

/**
 * The Setup tool on a new setup: the machine and its tools, the post, program zero and the stock. A setup is its own
 * record: OK saves it alone, and operations then pick it. The document's first setup creates its program (plumbing the
 * person never has to name); a later one starts from the machine, tools and post of the setup before it.
 */
export async function newSetupTool() {
  if (!app().doc.saved) { toast('warning', 'Save first', 'A setup pins a saved revision of the design.'); return; }
  if (!app().displayed) { toast('warning', 'No geometry yet', 'The part needs a body before its stock can be sized.'); return; }
  // A part without a program gets one: a CAM program (its code is the program).
  const record = setupProgram() ?? await newCamProgram();
  if (!record) return;
  if (!(record.compiled.setups as unknown[]).length) {
    const draft: ProgramDraft = { name: record.compiled.name, setup: newSetup(), op: newOperation('pocket') };
    openEditor({ programId: record.id, revision: record.revision, draft, mode: 'setup', errors: {}, busy: false, conflict: null });
    set({ machine: null, tooling: null });
    autoPick();
    return;
  }
  const last = (record.compiled.setups as { id?: string }[]).at(-1);
  const base = draftOf(record, undefined, String(last?.id ?? 'setup'));
  const id = newSetupId(record.compiled);
  const fresh = newSetup();
  const draft: ProgramDraft = {
    ...base,
    setup: { ...fresh, id, name: `Setup ${(record.compiled.setups as unknown[]).length + 1}`, machine: base.setup.machine, tooling: base.setup.tooling,
      post: base.setup.post, postProperties: base.setup.postProperties, workOffset: base.setup.workOffset, material: base.setup.material, machiningMaterial: base.setup.machiningMaterial },
  };
  placePart(null);
  openEditor({ programId: record.id, revision: record.revision, draft, mode: 'setup', errors: {}, busy: false, conflict: null });
  autoPick();
}

/** The Setup tool on a saved setup. */
/** A saved program's draft with every library pin on that item's latest revision: a setup uses the library as it is
 *  now, and saving freezes exactly that (the server does the same on every save). */
function draftOf(...args: Parameters<typeof savedDraftOf>): ReturnType<typeof savedDraftOf> {
  const draft = savedDraftOf(...args);
  const heads = new Map(useMfg.getState().records.map((record) => [record.id, record]));
  const latest = <T extends object>(fields: T): T => Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    const pin = value as { id?: unknown; revision?: unknown; kind?: unknown; sha256?: unknown } | null;
    const head = pin && typeof pin === 'object' && typeof pin.id === 'string' && typeof pin.revision === 'number' && typeof pin.sha256 === 'string' ? heads.get(pin.id) : undefined;
    return [key, head && head.revision > (pin!.revision as number) ? { id: head.id, revision: head.revision, kind: head.kind, sha256: head.sha256 } : value];
  })) as T;
  return { ...draft, setup: latest(draft.setup), op: latest(draft.op) };
}

export function editSetup(record: ProgramRecord, setupId: string, errors: Record<string, string> = {}) {
  const draft = draftOf(record, undefined, setupId);
  placePart(draftPlacement(draft, record.compiled));
  openEditor({ programId: record.id, revision: record.revision, draft, mode: 'setup', errors, busy: false, conflict: null });
}

/** An operation's tool on a saved operation. */
export function editOperation(record: ProgramRecord, operation: string, errors: Record<string, string> = {}) {
  const saved = (record.compiled.operations as Record<string, unknown>[]).find((item) => String(item.id) === operation);
  if (saved && !editableKind(saved)) {
    const kind = String((saved.strategy as Record<string, unknown> | undefined)?.kind);
    toast('info', `Edit ${opName(record, operation)} in code`, `A ${kind} operation isn’t one the workspace’s tools edit yet: change it in the program’s code.`);
    return;
  }
  const draft = draftOf(record, operation);
  placePart(draftPlacement(draft, record.compiled));
  if (draft.op.kind === 'engrave' && (draft.op.engraveCurves.length || draft.op.engraveEdges.length)) {
    // A saved engraving's sources, named and drawn from the design as it is displayed.
    draft.op.engraveCurves = draft.op.engraveCurves.map((ref) => ({ ...ref, label: sketchCurve(ref.sketch, ref.entity, draft.op.engraveChord)?.label ?? ref.label }));
    draft.op.engravePaths = engravePathsOf(draft.op);
  }
  openEditor({ programId: record.id, revision: record.revision, draft, mode: 'op', errors, busy: false, conflict: null });
  set({ activeOperation: operation });
}

/** An operation's tool on a new operation of `kind` in setup `setupId`, after that setup's last operation. */
export function newOperationTool(record: ProgramRecord, setupId: string, kind: OpKind) {
  const draft = draftOf(record, undefined, setupId);
  placePart(draftPlacement(draft, record.compiled));
  const ops = record.compiled.operations as { id?: string }[];
  const index = ops.filter((op) => kindOf(op as Record<string, unknown>) === kind || (isDrilling(kind) && isDrilling(kindOf(op as Record<string, unknown>)))).length + 1;
  const previous = opsOfSetup(record.compiled, setupId).at(-1);
  const source = previous ? draftOf(record, String(previous.id)).op : null;
  // A new operation starts on the part (and stock-check grid) the setup's operations machine.
  draft.op = { ...newOperation(kind, index), target: source?.target ?? null, cell: source?.cell ?? newOperation(kind).cell };
  while (ops.some((op) => op.id === draft.op.id)) draft.op.id += '_';
  if (kind === 'rest') {
    // Rest machining cleans up after the operation right before it: the same pocket (floor, heights).
    draft.op.restFrom = previous ? String(previous.id) : null;
    if (source && isPocketing(source.kind)) {
      Object.assign(draft.op, { target: source.target, floor: source.floor, top: source.top, bottom: source.bottom, clearance: source.clearance,
        radialAllowance: source.radialAllowance, axialAllowance: source.axialAllowance });
    }
  }
  openEditor({ programId: record.id, revision: record.revision, draft, mode: 'op', errors: {}, busy: false, conflict: null });
  if (draft.op.target && kind !== 'rest') setTarget(draft.op.target, null);
  else autoPick();
  autoAssign();
}

/**
 * The operation's setup (the Setup field at the top of every operation's tool): its machine, tools, stock and program
 * zero come from that setup. An operation already saved moves within its program; a new one can go to any setup.
 */
export function chooseSetup(programId: string, setupId: string) {
  const editor = get().editor;
  const record = program(programId);
  if (!editor || editor.mode !== 'op' || !record) return;
  const into = draftOf(record, undefined, setupId);
  placePart(draftPlacement(into, record.compiled));
  set({ editor: { ...editor, programId, revision: record.revision, draft: { ...into, op: editor.draft.op }, errors: {} } });
  useMfg.setState({ activeProgram: programId });
  if (into.setup.machine) void loadMachine();
  if (into.setup.tooling) void loadTooling();
  autoAssign();
}

/** Every setup an operation can be in: `${programId}:${setupId}` with its name (the program's too when there are several). */
export function setupChoices(): { value: string; label: string; programId: string; setupId: string }[] {
  const records = useMfg.getState().programs.filter((record) => programProcess(record.compiled) === 'milling');
  return records.flatMap((record) => (record.compiled.setups as { id?: string; name?: string }[]).map((setup) => ({
    value: `${record.id}:${String(setup.id)}`, programId: record.id, setupId: String(setup.id),
    label: records.length > 1 ? `${record.compiled.name} › ${setup.name ?? setup.id}` : String(setup.name ?? setup.id),
  })));
}

/** Changes when the displayed geometry or the part's placement in the edited setup does (memos of picks and bounds follow it). */
export function useGeometryVersion() {
  const model = useApp((state) => state.modelVersion);
  const placement = useCam((state) => {
    const transfer = state.editor?.draft.setup.transfer;
    return transfer ? `${transfer.from}:${transfer.frame.origin.join()}:${transfer.frame.x.join()}:${transfer.frame.y.join()}:${transfer.frame.z.join()}` : '';
  });
  return `${model}|${placement}`;
}

/** The part's placement the CAM view needs now: the edited setup's, else the simulated job's setup's (else none). */
export function currentPlacement(): Frame | null {
  const editor = get().editor;
  if (editor) return draftPlacement(editor.draft, program(editor.programId)?.compiled);
  const player = usePlayer.getState().player;
  return player ? jobPlacement(player.job) : null;
}

/** The program a new setup goes in: the selected one, else the document's most recent milling program (none: a new one). */
function setupProgram(): ProgramRecord | null {
  const records = useMfg.getState().programs.filter((record) => programProcess(record.compiled) === 'milling');
  return records.find((record) => record.id === useMfg.getState().activeProgram) ?? records[0] ?? null;
}

/**
 * The Setup tool on a new setup that continues from the last one: the part re-clamped (flipped over X to start with),
 * its stock the actual stock the last operation leaves, moved into this setup's work frame. Machine, tools, post and
 * program zero start as the setup before. Its operations are added afterwards, like any setup's.
 */
export function addSetup(record: ProgramRecord) {
  const program = record.compiled;
  const last = (program.setups as { id?: string }[]).at(-1);
  const sourceSetup = String(last?.id ?? 'setup');
  const from = opsOfSetup(program, sourceSetup).at(-1);
  if (!from) { toast('warning', 'Nothing to continue from', 'Add an operation to this setup first: the next setup takes the stock it leaves.'); return; }
  const box = stockBoxOf(program, sourceSetup);
  if (!box) { toast('warning', 'No stock to continue from', 'The setup before has no stock box.'); return; }
  const base = draftOf(record, String(from.id));
  const preset: TransferPreset = 'flip_x';
  const frame = transferFrame(preset, box.min, box.max);
  const moved = frameBox(frame, box.min, box.max);
  const id = newSetupId(program);
  const draft: ProgramDraft = {
    ...base,
    setup: { ...base.setup, id, name: `Setup ${(program.setups as unknown[]).length + 1}`, transfer: { from: String(from.id), preset, frame }, stockMode: 'manual', stockMin: moved.min, stockMax: moved.max },
  };
  placePart(draftPlacement(draft, program));
  openEditor({ programId: record.id, revision: record.revision, draft, mode: 'setup', errors: {}, busy: false, conflict: null });
}

/** Turns the re-clamped part another way: the transfer, the stock box it brings and the heights that follow it. */
export function setTransfer(preset: TransferPreset) {
  const editor = get().editor;
  const transfer = editor?.draft.setup.transfer;
  if (!editor || !transfer || preset === 'custom') return;
  const record = program(editor.programId);
  const box = record ? stockBoxOf(record.compiled, setupOfOperation(record.compiled, transfer.from)) : null;
  if (!box) return;
  const frame = transferFrame(preset, box.min, box.max);
  const moved = frameBox(frame, box.min, box.max);
  updateDraft((draft) => ({ ...draft, setup: { ...draft.setup, transfer: { ...transfer, preset, frame }, stockMin: moved.min, stockMax: moved.max } }), ['stock']);
  const draft = get().editor!.draft;
  placePart(draftPlacement(draft, record?.compiled));
  if (draft.op.target) setTarget(draft.op.target, draft.op.floor && !isPocketing(draft.op.kind) ? draft.op.floor : null);
}

const PART_BASE = new THREE.Matrix4().makeRotationX(Math.PI / 2);
/**
 * Shows the design as it sits in a setup's work frame (a re-clamped setup turns it over), so picks, heights and
 * previews are in that setup's coordinates; identity (null) restores it. The model root carries glTF's Y-up turn.
 */
export function placePart(frame: Frame | null) {
  const root = viewer.model?.root;
  if (!root) return;
  if (!frame || isIdentityFrame(frame)) {
    if (root.matrixAutoUpdate) return;
    root.matrixAutoUpdate = true;
    root.updateMatrix();
  } else {
    const matrix = frameMatrix4(frame).multiply(PART_BASE);
    if (!root.matrixAutoUpdate && root.matrix.equals(matrix)) return;
    root.matrixAutoUpdate = false;
    root.matrix.copy(matrix);
  }
  root.updateMatrixWorld(true);
  viewer.invalidate();
}

/** The design placement a job's setup uses (an operation's setup, or a combined program's selected setup). */
export function jobPlacement(job: JobRecord): Frame | null {
  const record = program(job.program_id);
  if (!record) return null;
  const source = (job as JobRecord & { program_source?: { setup?: string | null } }).program_source;
  const setupId = source?.setup ?? (job.operation ? setupOfOperation(record.compiled, sourceOperation(record.id, job.operation)) : null);
  return setupId ? placementOf(record.compiled, setupId) : null;
}

export function closeEditor() { set({ editor: null, picking: null }); }


export function updateDraft(change: (draft: ProgramDraft) => ProgramDraft, clear: string[] = []) {
  set((state) => {
    if (!state.editor) return {};
    const errors = { ...state.editor.errors };
    for (const field of clear) delete errors[field];
    delete errors.form;
    return { editor: { ...state.editor, draft: withChamferBottom(change(state.editor.draft), state.tooling), errors } };
  });
}

/** The height of the edges a chamfer selects: the picked edge chain's plane, the picked faces', or the part's top. */
export function chamferEdgeZ(op: OperationDraft): number | null {
  if (op.contourMode === 'edges') return op.contourEdges[0]?.z ?? null;
  if (op.contourMode === 'faces') return op.contourFaces[0]?.z ?? null;
  return op.target ? bodyBounds(op.target)?.max.z ?? null : null;
}

/**
 * A chamfer's bottom height isn't a free choice: it's the lower edge of the bevel, the selected edge's height less the
 * width over the cutter's flank slope (or the picked lower edge itself for a modelled bevel). The engine rejects any
 * other value (chamfer_depth_mismatch), so the editor keeps it derived. Before a tool is chosen, a 90° flank is assumed.
 */
function withChamferBottom(draft: ProgramDraft, tooling: CamState['tooling']): ProgramDraft {
  const op = draft.op;
  if (op.kind !== 'chamfer') return draft;
  const edge = chamferEdgeZ(op);
  if (edge === null) return draft;
  const cutter = cutterOf(tooling, op.assignment);
  const cone = { diameter: cutter?.diameter ?? 6, tipDiameter: cutter?.tipDiameter ?? 0, angle: ((cutter?.pointAngleDeg ?? 90) * Math.PI) / 180 };
  // Rounded to a nanometre, far inside the engine's 1e-6 mm check, so tan(45°) = 0.9999999999999999 still reads Z 9.
  const bottom = Math.round((op.chamferIntent === 'existing_chamfer' ? edge : chamferBottom(edge, op.chamferWidth, cone)) * 1e9) / 1e9;
  return Math.abs(bottom - op.bottom) < 1e-12 ? draft : { ...draft, op: { ...op, bottom } };
}

/** Resolves the chosen machine's snapshot (travel, home, controller) for hints and placement. */
export async function loadMachine() {
  const pin = get().editor?.draft.setup.machine;
  if (!pin) { set({ machine: null }); return; }
  try { set({ machine: await camJobs.machine(pin.id, pin.revision) }); }
  catch (error) { set({ machine: null }); report(error, 'Machine'); return; }
  // A setup the run places: shows where (the middle of this machine's travel), still left out when saved.
  const placed = get().editor?.draft.setup.placedByRun ? middleOfTravel(get().machine) : null;
  if (placed) set((state) => (state.editor ? { editor: { ...state.editor, draft: { ...state.editor.draft, setup: { ...state.editor.draft.setup, origin: placed } } } } : {}));
  // A new setup still at the machine's own zero: its stock centred in this machine's travel (program zero follows).
  if (newSetupAtZero()) placeOnMachine();
}

/** The editor is the Setup tool on a setup not saved yet, its program zero untouched. */
function newSetupAtZero(): boolean {
  const editor = get().editor;
  if (!editor || editor.mode !== 'setup' || !editor.draft.setup.origin.every((value) => value === 0)) return false;
  const record = program(editor.programId);
  return !record || !(record.compiled.setups as { id?: string }[]).some((item) => item.id === editor.draft.setup.id);
}

/** Whether a tool suits an operation kind: drills for drilling, chamfer mills for engraving and chamfers, ball end mills for 3D finishing, centre-cutting flat end mills otherwise (contours, bores and rest too). */
export function suits(kind: OpKind, cutter: ReturnType<typeof cutterOf>): boolean {
  if (!cutter) return false;
  return isDrilling(kind) ? cutter.type === 'drill' : kind === 'engrave' || kind === 'chamfer' ? cutter.type === 'chamfer_mill'
    : isSurface(kind) ? cutter.type === 'ball_end_mill' : cutter.type === 'flat_end_mill';
}

/** Resolves the chosen tool setup's assignments; keeps the operation's tool, or picks the only one that suits it. */
export async function loadTooling() {
  const pin = get().editor?.draft.setup.tooling;
  if (!pin) { set({ tooling: null }); return; }
  try {
    const tooling = await camJobs.toolSetup(pin.id, pin.revision);
    set({ tooling });
    const draft = get().editor?.draft;
    if (!draft) return;
    const current = tooling.setup.definition.assignments.find((item) => draft.op.assembly && item.assembly.id === draft.op.assembly.id && item.assembly.revision === draft.op.assembly.revision);
    if (current) { updateDraft((d) => ({ ...d, op: { ...d.op, assignment: current.id } })); return; }
    autoAssign(true);
  } catch (error) { set({ tooling: null }); report(error, 'Tools'); }
}

/**
 * The operation's tool: the only one that suits it, or the one its kind wants among several. `replace`: the tool setup
 * changed under it (its assignment named another setup's tool); otherwise only an operation without a tool gets one.
 */
function autoAssign(replace = false) {
  const tooling = get().tooling;
  const draft = get().editor?.draft;
  if (!tooling || !draft || (draft.op.assignment && !replace)) return;
  {
    const fitting = tooling.setup.definition.assignments.filter((item) => suits(draft.op.kind, cutterOf(tooling, item.id)));
    if (fitting.length === 1) chooseAssignment(fitting[0].id);
    else if ((draft.op.kind === 'face' || draft.op.kind === 'rough') && fitting.length > 1) {
      // Facing and roughing: the widest flat end mill clears the stock fastest.
      const widest = [...fitting].sort((a, b) => (cutterOf(tooling, b.id)?.diameter ?? 0) - (cutterOf(tooling, a.id)?.diameter ?? 0))[0];
      chooseAssignment(widest.id);
    } else if (draft.op.kind === 'bore' && fitting.length > 1 && draft.op.target) {
      // Bores: the largest flat end mill that fits inside the smallest bore (fewer passes, less deflection).
      const smallest = Math.min(...bodyHoles(draft.op.target).map((hole) => hole.radius));
      const fits = fitting.filter((item) => (cutterOf(tooling, item.id)?.diameter ?? Infinity) / 2 + draft.op.radialAllowance < smallest)
        .sort((a, b) => (cutterOf(tooling, b.id)?.diameter ?? 0) - (cutterOf(tooling, a.id)?.diameter ?? 0));
      if (fits.length) chooseAssignment(fits[0].id);
    } else if ((draft.op.kind === 'contour' || draft.op.kind === 'rest') && fitting.length > 1) {
      // Contours: the smallest flat end mill follows the tightest corners. Rest: a smaller cutter reaches what the one before left.
      const smallest = [...fitting].sort((a, b) => (cutterOf(tooling, a.id)?.diameter ?? 0) - (cutterOf(tooling, b.id)?.diameter ?? 0))[0];
      chooseAssignment(smallest.id);
    } else if (isDrilling(draft.op.kind) && fitting.length > 1 && draft.op.target) {
      // Drilling: the drill whose size the part's holes have.
      const radii = bodyHoles(draft.op.target).map((hole) => hole.radius);
      const match = fitting.find((item) => radii.some((radius) => Math.abs((cutterOf(tooling, item.id)?.diameter ?? 0) / 2 - radius) < 1e-3));
      if (match) chooseAssignment(match.id);
    }
  }
}

/** Selects a tool: its assembly pin, and starting cut values that respect it (stepover ≤ radius, depth ≤ flutes). */
export function chooseAssignment(id: string) {
  const tooling = get().tooling;
  const cutter = cutterOf(tooling, id);
  if (!cutter) return;
  updateDraft((draft) => {
    const op = { ...draft.op, assignment: id, assembly: cutter.assembly };
    const radius = cutter.diameter / 2;
    if (!isDrilling(op.kind)) {
      if (op.stepover > radius) op.stepover = Math.round(radius * 0.8 * 100) / 100;
      if (op.stepdown > cutter.cuttingLength) op.stepdown = cutter.cuttingLength;
      // A helix's cutter-centre radius can't exceed the cutter radius (it would leave a core).
      if (op.helixRadius !== null && op.helixRadius > radius) op.helixRadius = Math.round(radius * 0.8 * 1000) / 1000;
    } else if (op.kind === 'peck_drill' && op.peck > cutter.cuttingLength) op.peck = Math.round(cutter.cuttingLength / 3 * 100) / 100;
    if (cutter.maxRpm && op.rpm > cutter.maxRpm) op.rpm = cutter.maxRpm;
    return { ...draft, op };
  }, ['tool', 'passes', 'drilling']);
}

/** Recomputes auto stock from the target body (and heights that follow it) and re-centres placement if untouched. */
export function refreshStock() {
  const editor = get().editor;
  if (!editor || editor.draft.setup.stockMode !== 'auto') return;
  // The operation's part, or (none chosen yet) every body of the design: the stock is sized from the part either way.
  const target = editor.draft.op.target;
  const bounds = target ? bodyBounds(target) : displayedBodies().reduce<THREE.Box3 | null>((box, body) => {
    const next = bodyBounds(body);
    return next ? (box ? box.union(next) : next) : box;
  }, null);
  if (!bounds) return;
  const stock = autoStock(bounds, editor.draft.setup.margins);
  updateDraft((draft) => ({ ...draft, setup: { ...draft.setup, stockMin: stock.min, stockMax: stock.max } }), ['stock']);
}

export function placeOnMachine() {
  const editor = get().editor;
  if (!editor) return;
  const origin = suggestedOrigin(get().machine, editor.draft.setup.stockMin, editor.draft.setup.stockMax);
  if (origin) updateDraft((draft) => ({ ...draft, setup: { ...draft.setup, origin, placedByRun: false } }), ['placement']);
}

const mm = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The target body, and heights from it, per kind. An operation starts at the stock top, or after a facing earlier in
 * the program at the height that facing leaves (the engine checks that top against the actual stock it left:
 * docs/MANUFACTURING_STOCK_TOP.md). Pocket: bottom at the only floor below the top. Face: bottom at the part's top face.
 * Drilling: bottom at the lowest hole wall (through holes: the part's bottom), the full diameter reaching it. Bore:
 * the lowest bore wall. Contour: the part's outline is cut down to its bottom; picked edges to the plane they lie in.
 */
export function setTarget(body: BodyRef, floor: FloorRef | null) {
  updateDraft((draft) => {
    const bounds = bodyBounds(body);
    const contour = followsOutline(draft.op.kind);
    const op = { ...draft.op, target: body, floor: takesHoles(draft.op.kind) || contour || isSurface(draft.op.kind) ? null : floor };
    const moved = !!draft.op.target && (draft.op.target.instance !== body.instance || draft.op.target.body !== body.body);
    if (takesHoles(op.kind) && moved) op.holes = [];
    if (contour && moved) { op.contourFaces = []; op.contourEdges = []; }
    if (bounds) {
      const stockTop = mm(draft.setup.stockMode === 'auto' ? bounds.max.z + draft.setup.margins.top : draft.setup.stockMax[2]);
      const faced = op.kind === 'face' ? null : facedTop(program(get().editor?.programId ?? null)?.compiled, op.id, draft.setup.id);
      const top = faced !== null && faced < stockTop ? mm(faced) : stockTop;
      op.top = top;
      op.clearance = mm(top + 5);
      if (takesFloor(op.kind)) {
        const floors = upwardFloors(body).filter((item) => item.z < bounds.max.z - 1e-6);
        const levels = [...new Set(floors.map((item) => Math.round(item.z * 1e6) / 1e6))];
        if (floor) op.bottom = Math.round(floor.z * 1e6) / 1e6;
        else if (levels.length === 1) op.bottom = levels[0];
      } else if (op.kind === 'engrave') {
        // The surface engraved is the picked face or the part's top; the groove keeps its depth (0.5 mm to start).
        const surface = mm(floor ? floor.z : bounds.max.z);
        const depth = draft.op.top > draft.op.bottom ? draft.op.top - draft.op.bottom : 0.5;
        op.top = surface;
        op.bottom = mm(surface - depth);
        op.clearance = mm(Math.max(stockTop, surface) + 5);
      } else if (op.kind === 'face') {
        op.bottom = Math.round((floor ? floor.z : bounds.max.z) * 1e6) / 1e6;
      } else if (isSurface(op.kind) || op.kind === 'rough') {
        // 3D finishing: the lowest tool-tip height defaults to the part's bottom; the cutter rises over retained material.
        // Roughing: down to the part's bottom, around it.
        op.bottom = mm(bounds.min.z);
      } else if (op.kind === 'chamfer') {
        // The bottom follows from the selected edge, the width and the cutter (withChamferBottom); the cut starts at the top.
      } else if (contour) {
        op.bottom = mm(op.contourMode === 'edges' && op.contourEdges.length ? op.contourEdges[0].z : bounds.min.z);
      } else {
        const holes = op.holes.length ? op.holes : bodyHoles(body);
        op.bottom = mm(holes.length ? Math.min(...holes.map((hole) => hole.zMin)) : bounds.min.z);
      }
    }
    return { ...draft, op };
  }, ['geometry', 'heights']);
  refreshStock();
  if (newSetupAtZero()) placeOnMachine();
}

/**
 * The displayed geometry changed under an open editor (the part's selection data arrives after it's drawn): a draft
 * without its part yet picks it now, stock sized from the part follows the part, and a new setup's stock is centred in
 * the machine's travel.
 */
export function geometryChanged() {
  const editor = get().editor;
  if (!editor) return;
  if (!editor.draft.op.target) autoPick();
  refreshStock();
  if (newSetupAtZero()) placeOnMachine();
}

/** A new program targets the body of a selected face, or the design's only body. */
function autoPick() {
  const selected = new Map<string, BodyRef>();
  for (const pick of app().selection) {
    const refs = faceToRefs(pick);
    if (refs) selected.set(`${refs.body.instance}:${refs.body.body}`, refs.body);
  }
  const bodies = selected.size ? [...selected.values()] : displayedBodies();
  if (bodies.length === 1) setTarget(bodies[0], null);
}

/** What each picking mode can take: hover lights only those (viewport/pickGuard). */
const GUARDS: Record<Picking, (pick: Pick) => boolean> = {
  floor: (pick) => !!faceToRefs(pick)?.floor,
  holes: (pick) => typeof holeOf(pick) !== 'string',
  fixtures: (pick) => !!faceToRefs(pick),
  'contour-faces': (pick) => typeof contourFaceOf(pick) !== 'string',
  'contour-edges': (pick) => typeof contourEdgeOf(pick) !== 'string',
  tabs: (pick) => typeof tabEdgeOf(pick) !== 'string',
  // Sketch curves are picked by their own hit test (clickEngraveCurve); model faces and edges don't light.
  'engrave-curves': () => false,
  'engrave-edges': (pick) => typeof contourEdgeOf(pick, true) !== 'string',
};

// The viewport's hover follows the picking mode, however it changes (closing the editor, selecting a job…).
useCam.subscribe((state, previous) => { if (state.picking !== previous.picking) setPickGuard(state.picking ? GUARDS[state.picking] : null); });

export function startPicking(kind: Picking) {
  set({ picking: get().picking === kind ? null : kind });
  setApp({ selection: [] });
}
export const stopPicking = () => set({ picking: null });

/** A contour face or edge clicked while picking: toggled in the selection, in the order picked (one body). */
function pickContour(pick: Pick, picking: 'contour-faces' | 'contour-edges') {
  const ref = picking === 'contour-faces' ? contourFaceOf(pick) : contourEdgeOf(pick);
  const op = get().editor?.draft.op;
  const what = op?.kind === 'chamfer' ? 'chamfer' : 'contour';
  if (typeof ref === 'string') { toast('warning', picking === 'contour-faces' ? `Not a ${what} face` : `Not a ${what} edge`, ref.replace(/^Contours follow/, what === 'chamfer' ? 'Chamfers follow' : 'Contours follow').replace(/^A contour edge/, `A ${what} edge`)); return; }
  const picked = picking === 'contour-faces' ? op?.contourFaces.length : op?.contourEdges.length;
  if (op?.target && (op.target.instance !== ref.instance || op.target.body !== ref.body) && picked) {
    toast('warning', 'Another body', `A ${what} follows faces or edges of one body.`);
    return;
  }
  updateDraft((draft) => {
    const body = { instance: ref.instance, body: ref.body };
    if ('edge' in ref) {
      const known = draft.op.contourEdges.find((item) => item.edge === ref.edge && item.instance === ref.instance && item.body === ref.body);
      const contourEdges = known ? draft.op.contourEdges.filter((item) => item !== known) : [...draft.op.contourEdges, ref];
      return { ...draft, op: { ...draft.op, contourEdges, target: body } };
    }
    const known = draft.op.contourFaces.find((item) => item.face === ref.face && item.instance === ref.instance && item.body === ref.body);
    const contourFaces = known ? draft.op.contourFaces.filter((item) => item !== known) : [...draft.op.contourFaces, ref];
    return { ...draft, op: { ...draft.op, contourFaces, target: body } };
  }, ['geometry', 'contour']);
  const after = get().editor?.draft.op;
  // The first pick sets the part (stock and heights follow it); an edge chain is cut down to its plane.
  if (after?.target && (after.contourEdges.length + after.contourFaces.length) === 1) setTarget(after.target, null);
}

/** A straight outline edge clicked while placing tabs: a tab at its middle (a later click on the same spot removes it). */
function pickTab(pick: Pick) {
  const edge = tabEdgeOf(pick);
  if (typeof edge === 'string') { toast('warning', 'Not a tab place', edge); return; }
  updateDraft((draft) => {
    const op = draft.op;
    const here = op.tabs.find((tab) => Math.hypot(tab.center[0] - edge.center[0], tab.center[1] - edge.center[1]) < 1e-3);
    if (here) return { ...draft, op: { ...op, tabs: op.tabs.filter((tab) => tab !== here) } };
    let n = op.tabs.length + 1;
    while (op.tabs.some((tab) => tab.id === `tab_${n}`)) n++;
    // A 3 mm bridge, as tall as half the cut (at most 2 mm): the person sizes it for their part and stock.
    const height = Math.max(0.2, Math.min(2, Math.round(((op.top - op.bottom) / 2) * 10) / 10));
    const width = Math.min(3, Math.round(edge.length * 0.5 * 10) / 10);
    const tab: TabDraft = { id: `tab_${n}`, center: [mm(edge.center[0]), mm(edge.center[1])], width, height, angle: edge.angle };
    return { ...draft, op: { ...op, tabs: [...op.tabs, tab] } };
  }, ['tabs']);
}

/**
 * The paths an engraving draws (and, for a program saved with fixed coordinates, sends): each pinned source as its own
 * path, named as the engine names it; a fixed-coordinate program's saved paths, then its picks joined end to end.
 */
export function engravePathsOf(op: OperationDraft): EngravePathDraft[] {
  const pieces = [
    ...op.engraveCurves.flatMap((ref) => { const curve = sketchCurve(ref.sketch, ref.entity, op.engraveChord); return curve ? [{ name: `${ref.sketch}.${ref.entity}`, points: curve.points }] : []; }),
    ...op.engraveEdges.filter((edge) => edge.points.length >= 2).map((edge) => ({ name: `${edge.instance}:${edge.edge}`, points: edge.points })),
  ];
  if (op.engraveSaved.length) return [...op.engraveSaved, ...joinPieces(pieces)].map((path, index) => ({ ...path, id: `path_${index + 1}` }));
  const ids = engraveSourcesOf(op).map((source) => String(source.id));
  const paths: EngravePathDraft[] = [];
  const curves = op.engraveCurves.length;
  [...op.engraveCurves.map((ref) => sketchCurve(ref.sketch, ref.entity, op.engraveChord)?.points ?? null), ...op.engraveEdges.map((edge) => (edge.points.length >= 2 ? edge.points : null))]
    .forEach((points, index) => {
      if (!points) return;
      const closed = points.length > 3 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) < 1e-6;
      const from = index < curves ? `${op.engraveCurves[index].sketch}.${op.engraveCurves[index].entity}` : `${op.engraveEdges[index - curves].instance}:${op.engraveEdges[index - curves].edge}`;
      paths.push({ id: ids[index], points: closed ? points.slice(0, -1) : points, closed, from: [from] });
    });
  return paths;
}

/**
 * A program saved with fixed engraving coordinates, matched back to the design's sketch curves: each saved path must be
 * covered exactly by curves lying on it (their lengths adding up to its own). Null when any path has no exact match,
 * so nothing is guessed.
 */
export function savedPathCurves(op: OperationDraft): EngraveCurveRef[] | null {
  if (!op.engraveSaved.length) return null;
  const tolerance = Math.max(0.02, 3 * op.engraveChord);
  const curves = horizontalSketches(op.engraveChord).flatMap((sketch) => sketch.curves);
  const length = (points: [number, number][], closed = false) => {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return closed && points.length > 2 ? total + Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) : total;
  };
  const near = (p: [number, number], path: EngravePathDraft) => {
    const pts = path.closed ? [...path.points, path.points[0]] : path.points;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2)) : 0;
      if (Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy) <= tolerance) return true;
    }
    return false;
  };
  const out: EngraveCurveRef[] = [];
  for (const path of op.engraveSaved) {
    const on = curves.filter((curve) => curve.points.every((point) => near(point, path)));
    const total = on.reduce((sum, curve) => sum + length(curve.points), 0), want = length(path.points, path.closed);
    if (!on.length || Math.abs(total - want) > Math.max(0.05, want * 0.005)) return null;
    for (const curve of on) if (!out.some((ref) => ref.sketch === curve.sketch && ref.entity === curve.entity)) out.push({ sketch: curve.sketch, entity: curve.entity, label: curve.label });
  }
  return out;
}

/** Changes an engraving draft's sources (or tolerance) and rebuilds its paths. */
export function updateEngrave(change: (op: OperationDraft) => Partial<OperationDraft>) {
  updateDraft((draft) => {
    const op = { ...draft.op, ...change(draft.op) };
    return { ...draft, op: { ...op, engravePaths: engravePathsOf(op) } };
  }, ['engrave', 'geometry']);
}

/** A sketch curve toggled in an engraving's sources (in the order picked). */
export function toggleEngraveCurve(curve: { sketch: string; entity: string; label: string }) {
  updateEngrave((op) => {
    const known = op.engraveCurves.find((item) => item.sketch === curve.sketch && item.entity === curve.entity);
    const ref: EngraveCurveRef = { sketch: curve.sketch, entity: curve.entity, label: curve.label };
    return { engraveCurves: known ? op.engraveCurves.filter((item) => item !== known) : [...op.engraveCurves, ref] };
  });
}

/** While picking engraving curves: the curve under the pointer (true when there is one). */
export function hoverEngraveCurve(event: { clientX: number; clientY: number }, element: HTMLElement): boolean {
  const state = get();
  const curve = state.picking === 'engrave-curves' && state.editor ? curveAt(event.clientX, event.clientY, element, state.editor.draft.op.engraveChord) : null;
  if (curve?.sketch !== state.engraveHover?.sketch || curve?.entity !== state.engraveHover?.entity) { set({ engraveHover: curve }); viewer.invalidate(); }
  return !!curve;
}

/** A click while picking engraving curves: toggles the curve under it (true), or leaves the click to the model. */
export function clickEngraveCurve(event: { clientX: number; clientY: number }, element: HTMLElement): boolean {
  const state = get();
  if (state.picking !== 'engrave-curves' || !state.editor) return false;
  const curve = curveAt(event.clientX, event.clientY, element, state.editor.draft.op.engraveChord);
  if (!curve) { toast('info', 'No sketch curve there', 'Click a curve of a sketch drawn on a horizontal plane.'); return true; }
  toggleEngraveCurve(curve);
  return true;
}

/** A model edge clicked while picking engraving edges: toggled (one body; any flat curve). */
function pickEngraveEdge(pick: Pick) {
  const ref = contourEdgeOf(pick, true);
  if (typeof ref === 'string') { toast('warning', 'Not an engraving edge', ref); return; }
  const op = get().editor?.draft.op;
  if (op?.target && op.engraveEdges.length && (op.target.instance !== ref.instance || op.target.body !== ref.body)) {
    toast('warning', 'Another body', 'An engraving follows edges of one body.');
    return;
  }
  updateEngrave((current) => {
    const known = current.engraveEdges.find((item) => item.edge === ref.edge && item.instance === ref.instance && item.body === ref.body);
    return { engraveEdges: known ? current.engraveEdges.filter((item) => item !== known) : [...current.engraveEdges, ref], target: current.target ?? { instance: ref.instance, body: ref.body } };
  });
  const after = get().editor?.draft.op;
  if (after?.target && !op?.target) setTarget(after.target, null);
}

/** A face (or edge) clicked while picking: the floor or finished face (and its body), a hole wall or contour face/edge toggled, a tab placed, or a fixture body toggled. */
export function pickFace(pick: Pick) {
  const picking = get().picking;
  if (!picking) return;
  if (picking === 'contour-faces' || picking === 'contour-edges') { pickContour(pick, picking); return; }
  if (picking === 'tabs') { pickTab(pick); return; }
  if (picking === 'engrave-edges') { pickEngraveEdge(pick); return; }
  if (picking === 'engrave-curves') return;
  if (pick.kind !== 'face') return;
  if (picking === 'holes') {
    const hole = holeOf(pick);
    if (typeof hole === 'string') { toast('warning', 'Not a hole wall', hole); return; }
    const op = get().editor?.draft.op;
    if (op?.target && (op.target.instance !== hole.instance || op.target.body !== hole.body) && op.holes.length) {
      toast('warning', 'Another body', 'Holes in one operation belong to one body.');
      return;
    }
    updateDraft((draft) => {
      const known = draft.op.holes.find((item) => item.face === hole.face && item.instance === hole.instance && item.body === hole.body);
      const holes = known ? draft.op.holes.filter((item) => item !== known) : [...draft.op.holes, hole];
      return { ...draft, op: { ...draft.op, holes, target: { instance: hole.instance, body: hole.body } } };
    }, ['geometry']);
    const after = get().editor?.draft.op;
    if (after?.target && after.holes.length === 1) setTarget(after.target, null);
    return;
  }
  const refs = faceToRefs(pick);
  if (!refs) return;
  if (picking === 'floor') {
    const kind = get().editor?.draft.op.kind;
    if (!refs.floor) { toast('warning', kind === 'face' ? 'Not a flat top face' : kind === 'engrave' ? 'Not a flat face' : 'Not a pocket floor', refs.reason ?? 'Pick an upward-facing flat face.'); return; }
    if (kind === 'rest') {
      // Rest keeps its source pocket's heights; picking a floor only names the face.
      updateDraft((draft) => ({ ...draft, op: { ...draft.op, target: refs.body, floor: refs.floor } }), ['geometry']);
      stopPicking();
      return;
    }
    setTarget(refs.body, refs.floor);
    if (kind === 'face') updateDraft((draft) => ({ ...draft, op: { ...draft.op, bottom: Math.round(refs.floor!.z * 1e6) / 1e6 } }), ['heights']);
    stopPicking();
    return;
  }
  updateDraft((draft) => {
    const fixtures = draft.setup.fixtures;
    const known = fixtures.find((item) => item.instance === refs.body.instance && item.body === refs.body.body);
    const target = draft.op.target;
    if (!known && target && target.instance === refs.body.instance && target.body === refs.body.body) {
      toast('warning', 'That body is the part', 'Fixtures are other bodies: a vise, clamps or a plate modelled in this design.');
      return draft;
    }
    const next = known ? fixtures.filter((item) => item !== known) : [...fixtures, { ...refs.body, id: uniqueFixtureId(fixtures.map((item) => item.id), refs.body.body) }];
    return { ...draft, setup: { ...draft.setup, fixtures: next } };
  }, ['fixtures']);
}

const uniqueFixtureId = (taken: string[], body: string) => {
  const base = body.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'fixture';
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
};

/** Field errors from a server or draft error; returns true when it landed on the form. */
function placeErrors(error: unknown): boolean {
  const errors: Record<string, string> = {};
  if (error instanceof DraftError) errors[error.field] = error.message;
  else if (error instanceof MfgError) {
    const editor = get().editor;
    const record = editor ? program(editor.programId) : null;
    const named = error.operation && editor ? (record ? sourceOperation(record.id, error.operation) : error.operation) : null;
    if (named && editor && named !== editor.draft.op.id) {
      // Bound to another operation (a later one the change affects): say which, on the form.
      errors.form = `${record ? operationName(record, error.operation!) : error.operation}: ${error.message}`;
    } else {
      for (const field of error.fields) errors[fieldOfPath(field.path)] ??= field.message.replace(/^Value error, /, '');
      if (!error.fields.length) errors[failureField(error.code, error.field) ?? 'form'] = error.message;
      if (!Object.keys(errors).length) errors.form = error.message;
    }
  } else errors.form = (error as Error).message;
  // A setup's problem found while saving an operation: the operation's tool has no setup fields, so it says so on the
  // form (the setup is edited with its own tool).
  if (get().editor?.mode === 'op') {
    for (const field of SETUP_FIELDS.filter((name) => errors[name])) {
      errors.form ??= `The setup: ${errors[field]} Edit the setup (double-click it in the browser).`;
      delete errors[field];
    }
  }
  set((state) => ({ editor: state.editor ? { ...state.editor, errors, busy: false } : null }));
  return true;
}

/** Saves the draft as a new program or a new revision; returns the saved record. */
export async function saveProgram(): Promise<ProgramRecord | null> {
  const editor = get().editor;
  if (!editor || editor.busy) return null;
  set({ editor: { ...editor, busy: true, errors: {} } });
  try {
    const current = program(editor.programId);
    // A rough the engine would refuse for what the form can tell (cam/rough.ts) isn't saved: the reason lands on its field.
    if (editor.mode === 'op' && editor.draft.op.kind === 'rough') {
      const first = roughProblems(editor.draft.op, cutterOf(get().tooling, editor.draft.op.assignment), roughStart(editor.draft))[0];
      if (first) throw new DraftError(first.field, first.message);
    }
    // A program follows the open design: saving pins the design's current saved revision (picks name its faces).
    const typed = programOf(editor.draft, designPin(), current?.compiled, editor.mode);
    let saved: ProgramRecord;
    if (isCam(current)) {
      const what = editor.mode === 'setup' ? `${editor.draft.setup.name.trim() || 'Setup'} saved` : `${editor.draft.op.name.trim() || OP_LABEL[editor.draft.op.kind]} saved`;
      const done = await saveCam(current, typed, what);
      if (!done) { set((state) => ({ editor: state.editor ? { ...state.editor, busy: false } : null })); return null; }
      useMfg.setState({ activeProgram: done.id });
      if (editor.mode === 'setup') set({ editor: null, picking: null, activeOperation: null, activeSetup: `${done.id}:${editor.draft.setup.id}` });
      else set({ editor: null, picking: null, activeOperation: editor.draft.op.id, activeSetup: null });
      toast('success', what, `${done.compiled.name} · revision ${done.revision}`);
      return done;
    }
    const source = await programs.render(typed);
    if (current) {
      if (current.source === source) { set({ editor: null }); return current; }
      try {
        saved = await programs.edit(editor.revision !== null && editor.revision !== current.revision ? { ...current, revision: editor.revision } : current, source);
      } catch (error) {
        if (error instanceof MfgError && error.status === 409 && error.code !== 'request_key_conflict') {
          const latest = await programs.get(current.id, current.branch);
          set((state) => ({ editor: state.editor ? { ...state.editor, busy: false, conflict: latest } : null }));
          return null;
        }
        throw error;
      }
    } else saved = await programs.create(source);
    useMfg.setState((state) => ({ programs: [saved, ...state.programs.filter((item) => item.id !== saved.id)], activeProgram: saved.id }));
    if (editor.mode === 'setup') set({ editor: null, picking: null, activeOperation: null, activeSetup: `${saved.id}:${editor.draft.setup.id}` });
    else set({ editor: null, picking: null, activeOperation: editor.draft.op.id, activeSetup: null });
    toast('success', editor.mode === 'setup' ? (editor.programId && current?.compiled.setups.some((item) => (item as { id?: string }).id === editor.draft.setup.id) ? 'Setup saved' : 'Setup created') : 'Operation saved',
      `${editor.mode === 'setup' ? editor.draft.setup.name : editor.draft.op.name} · revision ${saved.revision}`);
    return saved;
  } catch (error) { placeErrors(error); return null; }
}

/**
 * Where an edited rough starts in material (work Z): the height a facing before it in its setup leaves, else the stock
 * top. The engine checks the actual stock; this is what the form can know.
 */
export function roughStart(draft: ProgramDraft): number {
  const faced = facedTop(program(get().editor?.programId ?? null)?.compiled, draft.op.id, draft.setup.id);
  const top = draft.setup.stockMax[2];
  return faced !== null && faced < top ? faced : top;
}

/** After a conflict: keep theirs (reopen it) or save mine on top of it. */
export async function resolveConflict(choice: 'theirs' | 'mine') {
  const editor = get().editor;
  if (!editor?.conflict) return;
  const latest = editor.conflict;
  useMfg.setState((state) => ({ programs: [latest, ...state.programs.filter((item) => item.id !== latest.id)] }));
  if (choice === 'theirs') {
    const saved = latest.compiled.operations.some((item) => (item as { id?: string }).id === editor.draft.op.id);
    if (editor.mode === 'setup') editSetup(latest, editor.draft.setup.id);
    else if (saved) editOperation(latest, editor.draft.op.id);
    else newOperationTool(latest, editor.draft.setup.id, editor.draft.op.kind);
    return;
  }
  set({ editor: { ...editor, conflict: null, revision: latest.revision } });
  await saveProgram();
}

/** Renames a program or one of its setups (a new revision). */
export async function rename(record: ProgramRecord, name: string, setupId?: string) {
  const value = name.trim();
  if (!value) return null;
  const compiled = record.compiled;
  const next = setupId
    ? { ...compiled, setups: (compiled.setups as Record<string, unknown>[]).map((item) => (item.id === setupId ? { ...item, name: value } : item)) }
    : { ...compiled, name: value };
  if (isCam(record)) return saveCam(record, next, 'Renamed');
  try {
    const saved = await programs.edit(record, await programs.render(next));
    useMfg.setState((state) => ({ programs: [saved, ...state.programs.filter((item) => item.id !== saved.id)] }));
    return saved;
  } catch (error) { report(error, 'Couldn’t rename'); return null; }
}

/** Deletes a setup with no operations (a new revision). */
export async function removeSetup(record: ProgramRecord, setupId: string) {
  try {
    if (isCam(record)) {
      const saved = await saveCam(record, withoutSetup(record.compiled, setupId), 'Setup deleted');
      if (saved && get().activeSetup === `${record.id}:${setupId}`) set({ activeSetup: null });
      return saved;
    }
    const saved = await programs.edit(record, await programs.render(withoutSetup(record.compiled, setupId)));
    useMfg.setState((state) => ({ programs: [saved, ...state.programs.filter((item) => item.id !== saved.id)], activeProgram: saved.id }));
    if (get().activeSetup === `${record.id}:${setupId}`) set({ activeSetup: null });
    return saved;
  } catch (error) {
    if (error instanceof DraftError) toast('info', 'Can’t delete this setup', error.message);
    else if (error instanceof MfgError && error.status === 409) { toast('warning', 'Saved elsewhere first', 'Another revision of this program was saved. Reload it and try again.'); void reloadProgram(record); }
    else report(error, 'Couldn’t delete the setup');
    return null;
  }
}

/** Moves an operation up or down (or removes it): a new revision whose operations each follow the one before. */
export async function reorderOperations(record: ProgramRecord, order: string[]) {
  try {
    if (isCam(record)) {
      const saved = await saveCam(record, reorderedProgram(record.compiled, order), order.length < record.compiled.operations.length ? 'Operation removed' : 'Operations reordered');
      if (saved && get().activeOperation && !order.includes(get().activeOperation!)) set({ activeOperation: null });
      return saved;
    }
    const source = await programs.render(reorderedProgram(record.compiled, order));
    const saved = await programs.edit(record, source);
    useMfg.setState((state) => ({ programs: [saved, ...state.programs.filter((item) => item.id !== saved.id)], activeProgram: saved.id }));
    if (get().activeOperation && !order.includes(get().activeOperation!)) set({ activeOperation: null });
    return saved;
  } catch (error) {
    if (error instanceof MfgError && error.status === 409) { toast('warning', 'Saved elsewhere first', 'Another revision of this program was saved. Reload it and try again.'); void reloadProgram(record); }
    else report(error, 'Couldn’t reorder');
    return null;
  }
}

/**
 * The program moved onto the open design's latest saved revision (a new program revision; its picks keep their names,
 * engraving curves their sketch and entity), then run again so every path and check follows the edited design.
 */
export async function followDesign(record: ProgramRecord) {
  try {
    if (isCam(record)) {
      // Saving moves the part link to the open revision; then it runs again.
      const saved = await saveCam(record, record.compiled, 'Program follows the part');
      if (saved) void runCam(saved.cam!.document_id);
      return saved;
    }
    const pin = designPin();
    const designs = record.compiled.designs.map((design) => (design.alias === 'part' && design.pin.document_id === pin.document_id
      ? { ...design, pin: { ...design.pin, branch: pin.branch, revision: pin.revision } } : design));
    const saved = await programs.edit(record, await programs.render({ ...record.compiled, designs }));
    useMfg.setState((state) => ({ programs: [saved, ...state.programs.filter((item) => item.id !== saved.id)], activeProgram: saved.id }));
    toast('success', 'Program follows the design', `${saved.compiled.name} · design r${pin.revision} · revision ${saved.revision}`);
    await runProgram(saved);
    return saved;
  } catch (error) {
    if (error instanceof MfgError && error.status === 409) { toast('warning', 'Saved elsewhere first', 'Another revision of this program was saved. Reload it and try again.'); void reloadProgram(record); }
    else report(error, 'Couldn’t update the program');
    return null;
  }
}

async function reloadProgram(record: ProgramRecord) {
  try {
    const latest = await programs.get(record.id, record.branch);
    useMfg.setState((state) => ({ programs: [latest, ...state.programs.filter((item) => item.id !== latest.id)] }));
  } catch { /* the list reloads with the document */ }
}

// ── The tree's menus: one new revision each, through the same save path as the forms ───────────────────────

/** A pending confirmation for a destructive tree action ("Delete Top and its 5 operations?"). */
export interface Confirm { title: string; detail: string; action: string; run: () => void }
export const useTreeConfirm = create<{ confirm: Confirm | null }>(() => ({ confirm: null }));

/** Puts a saved program record (either kind) into the part's list. */
const putProgram = (saved: ProgramRecord) => useMfg.setState((state) => ({ programs: state.programs.map((item) => (item.id === saved.id ? saved : item)) }));

/**
 * One change to a program from the tree: `change` gets its program and returns the new one; saved as one new revision
 * (a CAM program's code, or a program's source). `undo`: a toast offers Undo, which puts the previous revision back
 * as the next one. Returns the saved record.
 */
export async function changeProgram(record: ProgramRecord, what: string, change: (program: Program) => Program, undo = false): Promise<ProgramRecord | null> {
  let next: Program;
  try { next = change(record.compiled); } catch (error) {
    if (error instanceof DraftError) { toast('info', what, error.message); return null; }
    throw error;
  }
  let saved: ProgramRecord | null;
  if (isCam(record)) saved = await saveCam(record, next, what);
  else {
    try {
      saved = await programs.edit(record, await programs.render(next));
      putProgram(saved);
    } catch (error) {
      if (error instanceof MfgError && error.status === 409) { toast('warning', 'Saved elsewhere first', 'Another revision of this program was saved. Reload it and try again.'); void reloadProgram(record); }
      else report(error, what);
      return null;
    }
  }
  if (saved && undo) {
    const previous = record;
    toast('info', what, `${saved.compiled.name} · revision ${saved.revision}`, { sticky: true, action: { label: 'Undo', run: () => void restoreRevision(previous, saved!, what) } });
  }
  return saved;
}

/** Undo: the revision before a change, saved again as the next one (when nothing was saved since). */
async function restoreRevision(previous: ProgramRecord, saved: ProgramRecord, what: string) {
  const current = useMfg.getState().programs.find((item) => item.id === saved.id) ?? saved;
  if (current.revision !== saved.revision) { toast('warning', `Couldn’t undo: ${what.toLowerCase()}`, 'The program was changed again since.'); return; }
  if (isCam(previous)) {
    const { saveCamCode } = await import('./camDoc');
    if (await saveCamCode(previous.cam.document_id, previous.source, current.revision)) toast('success', 'Undone', `${previous.compiled.name}: back as it was.`);
    return;
  }
  try {
    putProgram(await programs.edit(current, previous.source));
    toast('success', 'Undone', `${previous.compiled.name}: back as it was.`);
  } catch (error) { report(error, 'Couldn’t undo'); }
}

const setupName = (record: ProgramRecord, setupId: string) => String((record.compiled.setups as { id?: string; name?: string }[]).find((item) => item.id === setupId)?.name ?? setupId);
const opName = (record: ProgramRecord, opId: string) => String((record.compiled.operations as { id?: string; name?: string }[]).find((item) => item.id === opId)?.name ?? opId);
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Delete setup: it and all its operations, after one short confirm; what came after carries on (programEdits.ts).
 * A CAM program can be left empty; a program's only setup takes the program with it, to the Trash (a stored program
 * has at least one setup).
 */
export function deleteSetupConfirmed(record: ProgramRecord, setupId: string) {
  const ops = opsOfSetup(record.compiled, setupId).length;
  const name = setupName(record, setupId);
  if (!isCam(record) && onlySetup(record.compiled as never, setupId)) {
    const run = () => void deleteProgram(record).then(() => {
      if (get().activeSetup === `${record.id}:${setupId}`) set({ activeSetup: null, activeOperation: null });
    });
    useTreeConfirm.setState({ confirm: { title: ops ? `Delete ${name} and its ${count(ops, 'operation')}?` : `Delete ${name}?`, detail: 'It’s this program’s only setup, so the program goes to the Trash (Open → Trash brings it back).', action: 'Delete', run } });
    return;
  }
  const run = () => void changeProgram(record, `Deleted ${name}`, (program) => deleteSetup(program as never, setupId) as unknown as Program, true).then((saved) => {
    if (saved && get().activeSetup === `${record.id}:${setupId}`) set({ activeSetup: null, activeOperation: null });
  });
  useTreeConfirm.setState({ confirm: { title: ops ? `Delete ${name} and its ${count(ops, 'operation')}?` : `Delete ${name}?`, detail: ops ? 'The setups after it start from the stock this one started from.' : 'It has no operations.', action: 'Delete setup', run } });
}

/** Delete an operation: a confirm only when others work on the stock it leaves; Undo either way. */
export function deleteOperationChecked(record: ProgramRecord, opId: string) {
  const name = opName(record, opId);
  const run = () => void changeProgram(record, `Deleted ${name}`, (program) => deleteOperation(program as never, opId) as unknown as Program, true).then((saved) => {
    if (saved && get().activeOperation === opId) set({ activeOperation: null });
  });
  const after = dependentsOf(record.compiled as never, opId);
  const others = after.operations.length + after.setups.length;
  if (!others) { run(); return; }
  const names = [...after.operations.map((id) => opName(record, id)), ...after.setups.map((id) => setupName(record, id))];
  useTreeConfirm.setState({ confirm: { title: `Delete ${name}?`, detail: `${names.join(', ')} ${others === 1 ? 'works' : 'work'} on the stock it leaves: ${others === 1 ? 'it then works' : 'they then work'} on the stock before it.`, action: 'Delete', run } });
}

export const duplicateSetupOf = (record: ProgramRecord, setupId: string) => void changeProgram(record, `Duplicated ${setupName(record, setupId)}`, (program) => duplicateSetup(program as never, setupId).program as unknown as Program, true);
export const duplicateOperationOf = (record: ProgramRecord, opId: string) => void changeProgram(record, `Duplicated ${opName(record, opId)}`, (program) => duplicateOperation(program as never, opId).program as unknown as Program, true);
export const renameOperationOf = (record: ProgramRecord, opId: string, name: string) => void changeProgram(record, 'Renamed', (program) => renameOperation(program as never, opId, name) as unknown as Program);
export const moveOperationOf = (record: ProgramRecord, opId: string, delta: -1 | 1) => void changeProgram(record, delta < 0 ? 'Moved up' : 'Moved down', (program) => moveOperation(program as never, opId, delta) as unknown as Program);
export const moveOperationTo = (record: ProgramRecord, opId: string, setupId: string) => void changeProgram(record, `Moved to ${setupName(record, setupId)}`, (program) => moveOperationToSetup(program as never, opId, setupId) as unknown as Program, true);

/** Delete program: to the Trash (Undo, or Open → Trash, brings it back). */
export async function deleteProgram(record: ProgramRecord) {
  const { moveToTrash } = await import('@/state/trash');
  const id = isCam(record) ? record.cam.document_id : record.id;
  const done = await moveToTrash([{ id, name: record.compiled.name }]);
  if (done && useMfg.getState().activeProgram === record.id) useMfg.setState({ activeProgram: null });
  if (done) await loadPrograms();
}

/** Duplicate program: a copy named “… copy”, with its own history (a CAM program's code and links; a program's source). */
export async function duplicateProgram(record: ProgramRecord) {
  const name = `${record.compiled.name} copy`;
  try {
    if (isCam(record)) {
      const { duplicateCam } = await import('./camDoc');
      await duplicateCam(record.cam.document_id, name);
    } else await Api.duplicateFile(record.id, name);
    await loadPrograms();
    toast('success', 'Program duplicated', name);
  } catch (error) { report(error, 'Couldn’t duplicate the program'); }
}

// ── Jobs, runs and combined output ─────────────────────────────────────────

const isPost = (job: JobRecord) => (job as JobRecord & { kind?: string }).kind === 'program_post';
const byNewest = (a: { created_at: string }, b: { created_at: string }) => b.created_at.localeCompare(a.created_at);

const putJob = (job: JobRecord) => set((state) => {
  const key = job.program_id;
  if (isPost(job)) return { posts: { ...state.posts, [key]: [job, ...(state.posts[key] ?? []).filter((item) => item.id !== job.id)].sort(byNewest) } };
  return { jobs: { ...state.jobs, [key]: [job, ...(state.jobs[key] ?? []).filter((item) => item.id !== job.id)].sort(byNewest) } };
});

const putRun = (run: RunRecord) => set((state) => ({
  runs: { ...state.runs, [run.program_id]: [run, ...(state.runs[run.program_id] ?? []).filter((item) => item.id !== run.id)].sort(byNewest) },
}));

export async function loadJobs(programId: string) {
  if (programId.startsWith(CAM_PREFIX)) return;   // A CAM program's runs are its frozen program's (loaded when it runs).
  try {
    const [list, runs] = await Promise.all([camJobs.forProgram(programId), camJobs.runs.forProgram(programId).catch(() => [] as RunRecord[])]);
    set((state) => ({
      jobs: { ...state.jobs, [programId]: list.filter((job) => !isPost(job)) },
      posts: { ...state.posts, [programId]: list.filter(isPost) },
      runs: { ...state.runs, [programId]: [...runs].sort(byNewest) },
    }));
    for (const job of list) if (!terminal(job.status)) watchJob(job.id);
    for (const run of runs) if (!terminal(run.status)) watchRun(run.id);
    const record = program(programId);
    if (record) void loadExpansion(record);
    // Each operation's latest finished run, and the latest combined output: their verdicts show beside them.
    const seen = new Set<string>();
    for (const job of list) {
      const key = isPost(job) ? 'post' : job.operation ?? '';  // A pattern's instances each have their own.
      if (seen.has(key)) continue;
      seen.add(key);
      if (job.status === 'succeeded') void loadResults(job);
    }
  } catch (error) { report(error, 'Jobs'); }
}

const watching = new Set<string>();
const afterJob = new Map<string, (job: JobRecord) => void>();

export function watchJob(id: string) {
  if (watching.has(id)) return;
  watching.add(id);
  const tick = async () => {
    try {
      const job = await jobs.get(id);
      putJob(job);
      if (terminal(job.status)) {
        watching.delete(id);
        if (job.status === 'succeeded') {
          void loadResults(job);
          // The selected operation's new toolpath shows as soon as it's generated.
          if (!isPost(job) && job.operation && useMfg.getState().activeProgram === job.program_id && get().activeOperation === sourceOperation(job.program_id, job.operation)) void showToolpath(job);
          const next = afterJob.get(id);
          if (next) { afterJob.delete(id); next(job); }
        }
        if (job.status === 'failed') toast('danger', isPost(job) ? 'Combined output failed' : 'Toolpath generation failed',
          namedFailure({ ...job.error, operation: job.error?.operation ?? job.operation }, program(job.program_id), 'The job failed.'));
        return;
      }
    } catch { /* keep polling; the server may be restarting */ }
    setTimeout(() => void tick(), 1000);
  };
  void tick();
}

const watchingRuns = new Set<string>();
const afterRun = new Map<string, (run: RunRecord) => void>();

/** Follows a run: its operations' child jobs (progress, results) as the scheduler creates them. */
export function watchRun(id: string) {
  if (watchingRuns.has(id)) return;
  watchingRuns.add(id);
  const known = new Map<string, string>();
  const tick = async () => {
    try {
      const run = await camJobs.runs.get(id);
      putRun(run);
      await Promise.all(run.operations.map(async (op) => {
        if (!op.job_id) return;
        const seen = known.get(op.job_id);
        if (seen && terminal(seen as JobRecord['status'])) return;
        const job = await jobs.get(op.job_id);
        known.set(op.job_id, job.status);
        putJob(job);
        if (job.status === 'succeeded') void loadResults(job);
      }));
      if (terminal(run.status)) {
        watchingRuns.delete(id);
        const next = afterRun.get(id);
        if (next) { afterRun.delete(id); next(run); }
        if (run.status === 'failed') {
          const failed = run.operations.find((op) => op.status === 'failed');
          toast('danger', 'The program run stopped', namedFailure(run.error ?? (failed?.error ? { ...failed.error, operation: failed.error.operation ?? failed.operation } : null), program(run.program_id), 'An operation failed.'), { sticky: true });
        }
        return;
      }
    } catch { /* keep polling */ }
    setTimeout(() => void tick(), 1000);
  };
  void tick();
}

const unavailable = (error: unknown) => error instanceof MfgError && (error.code === 'executor_unavailable' || error.code === 'execution_unavailable'
  || error.code === 'executor_family_unavailable' || error.code === 'executor_configuration_invalid');

function reportRunError(record: ProgramRecord, error: unknown, operation?: string) {
  if (error instanceof MfgError && error.code === 'reference_review_required') {
    // The program's banner (ReferenceReview.tsx) carries the review; this says why nothing ran.
    // Issue 1008: the toast takes the person to the review (the program selected, its review started), wherever they are.
    toast('warning', 'Review the design change first', 'A linked design changed. Review and accept its selections on the program, then generate again.',
      { sticky: true, action: { label: 'Review', run: () => { selectProgram(record.id); void startReview(record); } } });
    void loadReferenceStatus(record);
    return;
  }
  if (unavailable(error)) {
    // None at all on this server, or one that can't be reached right now: either way the program is saved.
    if ((error as MfgError).code === 'executor_family_unavailable') toast('warning', 'This server can’t generate these toolpaths', 'Programs save, but this server has no machining for this kind of operation.');
    else toast('warning', 'Machining isn’t available right now', 'Your program is saved. Try generating again in a little while.');
    return;
  }
  const field = error instanceof MfgError ? failureField(error.code, error.field ?? error.fields[0]?.path) : undefined;
  const target = (error instanceof MfgError ? error.operation : undefined) ?? operation ?? String((record.compiled.operations[0] as { id?: string } | undefined)?.id ?? '');
  const setup = error instanceof MfgError ? error.setup : undefined;
  const message = (error as Error).message;
  toast('danger', 'Couldn’t generate', message, field && field !== 'form'
    ? { sticky: true, action: { label: 'Edit', run: () => fixField(record, target, field, message, error instanceof MfgError ? error.code : undefined, setup) } } : { sticky: true });
}

/** Opens the editor on the field a failure names, with the failure (in plain words first) on it. A setup-level failure
 * names its setup; older ones are found through their operation. */
export function fixField(record: ProgramRecord, operation: string | null, field: string, message: string, code?: string, setup?: string | null) {
  const hint = code ? CODE_HINTS[code] : undefined;
  // A failure on a pattern instance opens the pattern's own operation (instances aren't edited separately).
  const errors = { [field]: hint ? `${hint} (${message})` : message };
  const op = operation ? sourceOperation(record.id, operation) : null;
  if (SETUP_FIELDS.includes(field)) editSetup(record, setup ?? (op ? setupOfOperation(record.compiled, op) : String((record.compiled.setups[0] as { id?: string } | undefined)?.id ?? 'setup')), errors);
  else if (op) editOperation(record, op, errors);
}

const opsOf = (record: ProgramRecord) => record.compiled.operations as { id: string; name?: string; depends_on?: string[]; strategy?: Record<string, unknown> }[];

/**
 * Runs a saved revision's operations (all of them when `operations` is empty) in dependency order, stock carried from
 * one to the next. With more than one operation, the run's combined output (one machine program with its tool
 * changes) is posted and checked when it finishes; `then` gets that combined job (or the only operation's job).
 */
export async function runProgram(record: ProgramRecord, operations: string[] = [], then?: (job: JobRecord) => void, setup?: string): Promise<RunRecord | null> {
  if (isCam(record)) { void runCam(record.cam.document_id, { announce: true }); return null; }   // A CAM program runs as a whole.
  try {
    const run = await camJobs.runs.submit(record, operations);
    putRun(run);
    set({ activeOperation: operations.length === 1 ? operations[0] : null });
    afterRun.set(run.id, (done) => {
      if (done.status !== 'succeeded') return;
      const children = done.operations.filter((op) => op.job_id);
      // Setups with operations (a setup can have none yet).
      const setups = (record.compiled.setups as { id?: string }[]).map((item) => String(item.id)).filter((id) => opsOfSetup(record.compiled, id).length);
      // One combined machine program per setup (each is clamped and run on its own).
      if (setup && children.length > 1) void postRun(done, then, setup);
      else if (!operations.length && setups.length > 1) for (const id of setups) void postRun(done, id === setups[0] ? then : undefined, id);
      else if (!operations.length && children.length > 1) void postRun(done, then);
      else if (then) {
        // One operation selected: its job, or for a pattern (run as its instances) the last instance's.
        const wanted = (operations.length === 1 ? done.operations.find((op) => op.operation === operations[0]) : null) ?? children.at(-1);
        if (wanted?.job_id) void jobs.get(wanted.job_id).then((job) => { putJob(job); then(job); });
      }
    });
    watchRun(run.id);
    if (terminal(run.status)) { watchingRuns.delete(run.id); watchRun(run.id); }
    return run;
  } catch (error) { reportRunError(record, error, operations[0]); return null; }
}

/** The run's combined output: a separate job that composes, posts and checks the actual program (tool changes included). */
export async function postRun(run: RunRecord, then?: (job: JobRecord) => void, setup?: string): Promise<JobRecord | null> {
  try {
    const job = await camJobs.runs.post(run, undefined, setup);
    putJob(job);
    if (then) {
      if (job.status === 'succeeded') { void loadResults(job); then(job); }
      else afterJob.set(job.id, then);
    }
    if (!terminal(job.status)) watchJob(job.id);
    else if (job.status === 'succeeded') void loadResults(job);
    return job;
  } catch (error) {
    report(error, 'Couldn’t post the program');
    return null;
  }
}

/**
 * Generates one operation. An independent operation is its own job; one that depends on others runs with its
 * ancestors (a program run selecting it), since it works on the stock they leave.
 */
export async function runOperation(record: ProgramRecord, operation: string, then?: (job: JobRecord) => void): Promise<JobRecord | null> {
  if (isCam(record)) { void runCam(record.cam.document_id, { announce: true }); return null; }
  const op = opsOf(record).find((item) => item.id === operation);
  // A pattern runs as its instances (a program run selecting it); a job is only ever for one executable operation.
  if (op?.depends_on?.length || (op as { pattern?: unknown } | undefined)?.pattern) {
    // When the run is done, its job for this operation shows in the inspector (if the person is still on it).
    await runProgram(record, [operation], (job) => { if (get().activeOperation === operation) selectJob(job); then?.(job); });
    set({ activeOperation: operation });
    return null;
  }
  try {
    const job = await jobs.submit(record, operation);
    putJob(job);
    set({ activeJob: job.id, activeOperation: operation });
    if (then) {
      if (job.status === 'succeeded') { void loadResults(job); then(job); }
      else afterJob.set(job.id, then);
    }
    if (!terminal(job.status)) watchJob(job.id);
    else if (job.status === 'succeeded') void loadResults(job);
    return job;
  } catch (error) { reportRunError(record, error, operation); return null; }
}

export async function cancelJob(job: JobRecord) {
  try { putJob(await jobs.cancel(job.id)); watchJob(job.id); }
  catch (error) { report(error, 'Couldn’t cancel'); }
}

export async function cancelRun(run: RunRecord) {
  try { putRun(await camJobs.runs.cancel(run.id)); watchRun(run.id); }
  catch (error) { report(error, 'Couldn’t cancel'); }
}

export async function loadResults(job: JobRecord) {
  if (get().results[job.id]?.assessment) return;
  try {
    const [assessment, posted] = await Promise.all([camJobs.verification(job.id), camJobs.postedResolution(job.id).catch(() => null)]);
    set((state) => ({ results: { ...state.results, [job.id]: { assessment, error: null, posted } } }));
  } catch (error) {
    set((state) => ({ results: { ...state.results, [job.id]: { assessment: null, error: (error as Error).message } } }));
  }
}

/**
 * Drilling results for a job: each hole's completion and deepest tip (drill-check.json, or a combined output's
 * program-check.json) with where the hole is (drill-geometry.json / pocket-regions.json), in the work frame.
 */
export async function loadHoles(job: JobRecord, origin: number[]) {
  if (get().holes[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  try {
    let results: HoleResult[] = [];
    const where = new Map<string, { center: [number, number]; radius: number }>();
    if (files.has('drill-check.json')) {
      results = (await artifactJson<{ holes: HoleResult[] }>(job.id, 'drill-check.json')).holes ?? [];
      if (files.has('drill-geometry.json')) for (const hole of (await artifactJson<DrillGeometry>(job.id, 'drill-geometry.json')).holes) where.set(`${job.operation}:${hole.id}`, { center: hole.center_mm, radius: hole.radius_mm });
    } else if (files.has('program-check.json')) {
      results = (await artifactJson<{ holes?: HoleResult[] }>(job.id, 'program-check.json')).holes ?? [];
      if (files.has('pocket-regions.json')) {
        for (const region of await artifactJson<{ operation: string; region_kind?: string; holes?: { id: string; center_mm: [number, number]; radius_mm: number }[] }[]>(job.id, 'pocket-regions.json')) {
          for (const hole of region.holes ?? []) where.set(`${region.operation}:${hole.id}`, { center: hole.center_mm, radius: hole.radius_mm });
        }
      }
    }
    const holes: HoleRow[] = results.map((result) => {
      const place = where.get(`${result.operation}:${result.hole}`);
      return {
        ...result, center: place ? [place.center[0] - origin[0], place.center[1] - origin[1]] : null, radius: place?.radius ?? null,
        deepestZ: result.deepest_tip_mm === null || result.deepest_tip_mm === undefined ? null : result.deepest_tip_mm - origin[2],
      };
    });
    set((state) => ({ holes: { ...state.holes, [job.id]: { holes, error: null } } }));
  } catch (error) {
    set((state) => ({ holes: { ...state.holes, [job.id]: { holes: [], error: (error as Error).message } } }));
  }
}

/** Shows a hole in the viewport (or clears it). */
export function highlightHole(mark: HoleMark | null) { set({ highlight: mark }); viewer.invalidate(); }

/**
 * Contour results for a job: each chain's coverage (contour-check.json, or a combined output's program-check.json) with
 * where it runs (contour-geometry.json's chains, or the combined pocket-regions.json finishing passes), in the work frame.
 */
export async function loadContours(job: JobRecord, origin: number[]) {
  if (get().contours[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  try {
    let results: ContourResult[] = [];
    let tabStates: TabState[] = [];
    const where = new Map<string, { points: [number, number][]; closed: boolean; z: number | null; floor: number | null }>();
    const bridges = new Map<string, TabRegion>();
    if (files.has('contour-check.json')) {
      const check = await artifactJson<{ contours?: ContourResult[]; tabs?: TabState[] }>(job.id, 'contour-check.json');
      results = check.contours ?? [];
      tabStates = check.tabs ?? [];
      if (files.has('contour-geometry.json')) {
        const geometry = await artifactJson<ContourGeometry & { tabs?: TabRegion[] }>(job.id, 'contour-geometry.json');
        const plane = geometry.selection_planes_mm?.[0] ?? null;
        for (const chain of geometry.chains ?? []) where.set(`${job.operation}:${chain.id}`, { points: chain.points, closed: chain.closed, z: plane, floor: geometry.floor_mm ?? null });
        for (const tab of geometry.tabs ?? []) bridges.set(`${job.operation}:${tab.id}`, tab);
      }
    } else if (files.has('program-check.json')) {
      const check = await artifactJson<{ contours?: ContourResult[]; tabs?: TabState[] }>(job.id, 'program-check.json');
      results = check.contours ?? [];
      tabStates = check.tabs ?? [];
      if (files.has('pocket-regions.json')) {
        type Region = { operation: string; region_kind?: string; floor_mm?: number; contour_passes?: { chain: string; closed: boolean; points: [number, number][] }[]; tabs?: TabRegion[] };
        for (const region of await artifactJson<Region[]>(job.id, 'pocket-regions.json')) {
          for (const pass of region.contour_passes ?? []) {
            // The finishing pass (cutter centre) stands in for the chain here; the first pass per chain is kept.
            if (!where.has(`${region.operation}:${pass.chain}`)) where.set(`${region.operation}:${pass.chain}`, { points: pass.points, closed: pass.closed, z: region.floor_mm ?? null, floor: region.floor_mm ?? null });
          }
          for (const tab of region.tabs ?? []) bridges.set(`${region.operation}:${tab.id}`, tab);
        }
      }
    }
    const contours: ContourRow[] = results.map((result) => {
      const place = where.get(`${result.operation}:${result.chain}`);
      return {
        ...result, closed: place?.closed ?? false,
        points: (place?.points ?? []).map(([x, y]) => [x - origin[0], y - origin[1]] as [number, number]),
        z: place?.z === null || place?.z === undefined ? null : place.z - origin[2],
        floor: place?.floor === null || place?.floor === undefined ? null : place.floor - origin[2],
      };
    });
    const tabs: TabRow[] = tabStates.map((state) => {
      const bridge = bridges.get(`${state.operation}:${state.tab}`);
      return {
        ...state, corners: bridge ? bridge.corners_mm.map(([x, y]) => [x - origin[0], y - origin[1]] as [number, number]) : null,
        bottom: bridge ? bridge.bottom_mm - origin[2] : null, top: bridge ? bridge.top_mm - origin[2] : null,
      };
    });
    set((state) => ({ contours: { ...state.contours, [job.id]: { contours, tabs, error: null } } }));
  } catch (error) {
    set((state) => ({ contours: { ...state.contours, [job.id]: { contours: [], tabs: [], error: (error as Error).message } } }));
  }
}

/** Shows a tab bridge in the viewport (or clears it). */
export function highlightTab(mark: TabMark | null) { set({ tabHighlight: mark }); viewer.invalidate(); }

/**
 * Bore results for a job: each bore's finishing coverage (bore-check.json, or a combined output's program-check.json
 * `bores`) with where it is (bore-geometry.json, or the combined pocket-regions.json `bore_holes`), in the work frame.
 */
export async function loadBores(job: JobRecord, origin: number[]) {
  if (get().bores[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  try {
    let results: BoreCoverage[] = [];
    let floor: number | null = null;
    const where = new Map<string, { center: [number, number]; radius: number }>();
    if (files.has('bore-check.json')) {
      results = (await artifactJson<{ bores?: BoreCoverage[] }>(job.id, 'bore-check.json')).bores ?? [];
      if (files.has('bore-geometry.json')) {
        const geometry = await artifactJson<BoreGeometry>(job.id, 'bore-geometry.json');
        for (const hole of geometry.holes ?? []) where.set(`${job.operation}:${hole.id}`, { center: hole.center_mm, radius: hole.radius_mm });
        if (typeof geometry.final_floor_mm === 'number') floor = geometry.final_floor_mm - origin[2];
      }
    } else if (files.has('program-check.json')) {
      results = (await artifactJson<{ bores?: BoreCoverage[] }>(job.id, 'program-check.json')).bores ?? [];
      if (files.has('pocket-regions.json')) {
        type Region = { operation: string; region_kind?: string; floor_mm?: number; bores?: { id: string; center_mm: [number, number]; radius_mm: number }[] };
        for (const region of await artifactJson<Region[]>(job.id, 'pocket-regions.json')) {
          for (const hole of region.bores ?? []) where.set(`${region.operation}:${hole.id}`, { center: hole.center_mm, radius: hole.radius_mm });
          if (region.region_kind === 'bore_holes' && typeof region.floor_mm === 'number') floor = region.floor_mm - origin[2];
        }
      }
    }
    const bores: BoreRow[] = results.map((result) => {
      const place = where.get(`${result.operation}:${result.hole}`);
      return { ...result, center: place ? [place.center[0] - origin[0], place.center[1] - origin[1]] : null, radius: place?.radius ?? null };
    });
    set((state) => ({ bores: { ...state.bores, [job.id]: { bores, floor, error: null } } }));
  } catch (error) {
    set((state) => ({ bores: { ...state.bores, [job.id]: { bores: [], floor: null, error: (error as Error).message } } }));
  }
}

/**
 * Slot results for a job: each slot's finishing coverage (slot-check.json, or a combined output's program-check.json
 * `slots`) with its centreline and width (slot-geometry.json `paths`), in the work frame.
 */
export async function loadSlots(job: JobRecord, origin: number[]) {
  if (get().slots[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  try {
    let results: SlotCoverage[] = [];
    let floor: number | null = null;
    const where = new Map<string, { points: [number, number][]; width: number }>();
    if (files.has('slot-check.json')) {
      results = (await artifactJson<{ slots?: SlotCoverage[] }>(job.id, 'slot-check.json')).slots ?? [];
      if (files.has('slot-geometry.json')) {
        const geometry = await artifactJson<{ paths?: SlotPath[]; final_floor_mm?: number }>(job.id, 'slot-geometry.json');
        for (const path of geometry.paths ?? []) where.set(`${job.operation}:${path.id}`, { points: path.points_mm, width: path.width_mm });
        if (typeof geometry.final_floor_mm === 'number') floor = geometry.final_floor_mm - origin[2];
      }
    } else if (files.has('program-check.json')) {
      results = (await artifactJson<{ slots?: SlotCoverage[] }>(job.id, 'program-check.json')).slots ?? [];
      if (files.has('pocket-regions.json')) {
        type Region = { operation: string; region_kind?: string; floor_mm?: number; slots?: SlotPath[] };
        for (const region of await artifactJson<Region[]>(job.id, 'pocket-regions.json')) {
          if (region.region_kind !== 'slot_corridors') continue;
          for (const path of region.slots ?? []) where.set(`${region.operation}:${path.id}`, { points: path.points_mm, width: path.width_mm });
          if (typeof region.floor_mm === 'number') floor = region.floor_mm - origin[2];
        }
      }
    }
    const slots: SlotRow[] = results.map((result) => {
      const place = where.get(`${result.operation}:${result.slot}`);
      return { ...result, points: (place?.points ?? []).map(([x, y]) => [x - origin[0], y - origin[1]] as [number, number]), width: place?.width ?? null };
    });
    set((state) => ({ slots: { ...state.slots, [job.id]: { slots, floor, error: null } } }));
  } catch (error) {
    set((state) => ({ slots: { ...state.slots, [job.id]: { slots: [], floor: null, error: (error as Error).message } } }));
  }
}

/** Shows a slot in the viewport (or clears it). */
export function highlightSlot(mark: SlotMark | null) { set({ slotHighlight: mark }); viewer.invalidate(); }

/**
 * 3D finishing results for a job: each approved path's coverage by the posted moves (surface-check.json, whose rows name
 * the operation "surface", or a combined output's program-check.json `surface_paths`), with its approved tool-tip points
 * (surface-geometry.json, or the combined `surface_corridors` regions), moved from machine space into the work frame.
 */
export async function loadSurfaces(job: JobRecord, origin: number[]) {
  if (get().surfaces[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  try {
    let results: SurfaceCoverage[] = [];
    const where = new Map<string, { points: [number, number, number][]; closed: boolean }>();
    if (files.has('surface-check.json')) {
      results = ((await artifactJson<{ paths?: SurfaceCoverage[] }>(job.id, 'surface-check.json')).paths ?? []).map((row) => ({ ...row, operation: job.operation ?? row.operation }));
      if (files.has('surface-geometry.json')) {
        const geometry = await artifactJson<{ paths?: SurfacePathOut[] }>(job.id, 'surface-geometry.json');
        for (const path of geometry.paths ?? []) where.set(`${job.operation}:${path.id}`, { points: path.points_mm, closed: !!path.closed });
      }
    } else if (files.has('program-check.json')) {
      results = (await artifactJson<{ surface_paths?: SurfaceCoverage[] }>(job.id, 'program-check.json')).surface_paths ?? [];
      if (results.length && files.has('pocket-regions.json')) {
        type Region = { operation: string; region_kind?: string; surface?: { paths?: SurfacePathOut[] } };
        for (const region of await artifactJson<Region[]>(job.id, 'pocket-regions.json')) {
          if (region.region_kind !== 'surface_corridors') continue;
          for (const path of region.surface?.paths ?? []) where.set(`${region.operation}:${path.id}`, { points: path.points_mm, closed: !!path.closed });
        }
      }
    }
    const paths: SurfaceRow[] = results.map((result) => {
      const place = where.get(`${result.operation}:${result.path}`);
      return { ...result, points: (place?.points ?? []).map(([x, y, z]) => [x - origin[0], y - origin[1], z - origin[2]] as [number, number, number]), closed: place?.closed ?? false };
    });
    set((state) => ({ surfaces: { ...state.surfaces, [job.id]: { paths, error: null } } }));
  } catch (error) {
    set((state) => ({ surfaces: { ...state.surfaces, [job.id]: { paths: [], error: (error as Error).message } } }));
  }
}

/**
 * Fixture clearance for a job (docs/MANUFACTURING_FIXTURE_SOLIDS.md): per pinned fixture (fixtures.json) the contacts
 * fixture-check.json (or a combined program-check.json) reports, by tool region, and how the solids were checked.
 */
export async function loadFixtureChecks(job: JobRecord) {
  if (get().fixtureChecks[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  try {
    const fixtures = files.has('fixtures.json') ? await artifactJson<FixtureDisplay[]>(job.id, 'fixtures.json') : [];
    let contacts: FixtureContact[] = [], refinement: SolidRefinement | null = null;
    if (files.has('fixture-check.json')) {
      const check = await artifactJson<{ events?: FixtureContact[]; solid_refinement?: SolidRefinement }>(job.id, 'fixture-check.json');
      contacts = check.events ?? [];
      refinement = check.solid_refinement ?? null;
    } else if (files.has('program-check.json')) {
      const check = await artifactJson<{ fixture_events?: FixtureContact[]; solid_refinement?: SolidRefinement }>(job.id, 'program-check.json');
      contacts = check.fixture_events ?? [];
      refinement = check.solid_refinement ?? null;
    }
    const rows: FixtureRow[] = fixtures.map((fixture) => {
      const regions = new Map<string, FixtureRegionRow>();
      for (const contact of contacts) {
        if (contact.fixture !== fixture.collision.id) continue;
        const row = regions.get(contact.tool_component);
        if (!row) regions.set(contact.tool_component, { region: contact.tool_component, status: contact.status, contacts: 1, first: contact });
        else {
          row.contacts++;
          if (contact.status === 'failed' && row.status !== 'failed') { row.status = 'failed'; row.first = contact; }
        }
      }
      const list = [...regions.values()].sort((a, b) => (a.status === b.status ? b.contacts - a.contacts : a.status === 'failed' ? -1 : 1));
      return { fixture: fixture.collision.id, name: fixture.id, status: list.some((row) => row.status === 'failed') ? 'failed' : list.length ? 'uncertain' : 'passed', regions: list };
    });
    set((state) => ({ fixtureChecks: { ...state.fixtureChecks, [job.id]: { fixtures: rows, refinement, error: null } } }));
  } catch (error) {
    set((state) => ({ fixtureChecks: { ...state.fixtureChecks, [job.id]: { fixtures: [], refinement: null, error: (error as Error).message } } }));
  }
}

/** Opens the simulation at a fixture contact: the first event of that tool region on that fixture (a collision first). */
export async function showFixtureContact(job: JobRecord, fixture: string, region: string) {
  await openPlayer(job);
  const events = usePlayer.getState().player?.events ?? [];
  const match = (failed: boolean) => events.findIndex((event) => event.fixture === fixture && event.region === region && (!failed || event.severity === 'failed'));
  const index = match(true) >= 0 ? match(true) : match(false);
  if (index >= 0) seekEvent(index);
}

/** Shows a 3D finishing path in the viewport (or clears it). */
export function highlightSurface(mark: SurfaceMark | null) { set({ surfaceHighlight: mark }); viewer.invalidate(); }

/**
 * Engraving results for a job: each path's coverage (engrave-check.json, or a combined output's program-check.json
 * `conical_paths`) with its centreline and groove width at the surface (engrave-geometry.json, or the combined
 * `conical_corridors` regions with the operation's top), in the work frame.
 */
export async function loadEngrave(job: JobRecord, origin: number[], program: ProgramRecord) {
  if (get().engrave[job.id]) return;
  const files = new Set(job.output?.files.map((file) => file.name) ?? []);
  const topOf = (operation: string) => {
    // A pattern instance has its pattern's heights (patterns move in XY only).
    const strategy = ((program.compiled.operations as Record<string, unknown>[]).find((item) => item.id === sourceOperation(program.id, operation))?.strategy ?? {}) as Record<string, unknown>;
    return typeof strategy.top_mm === 'number' ? strategy.top_mm : null;
  };
  try {
    let results: EngraveCoverage[] = [];
    const where = new Map<string, { points: [number, number][]; closed: boolean; width: number | null; z: number | null }>();
    // A chamfer job writes the same conical coverage and paths as an engraving (chamfer-check.json, chamfer-geometry.json).
    const single = files.has('engrave-check.json') ? 'engrave' : files.has('chamfer-check.json') ? 'chamfer' : null;
    if (single) {
      results = (await artifactJson<{ paths?: EngraveCoverage[] }>(job.id, `${single}-check.json`)).paths ?? [];
      if (files.has(`${single}-geometry.json`)) {
        const geometry = await artifactJson<{ paths?: EngravePathOut[]; surface_width_mm?: number }>(job.id, `${single}-geometry.json`);
        for (const path of geometry.paths ?? []) where.set(`${job.operation}:${path.id}`, { points: path.points_mm, closed: !!path.closed, width: geometry.surface_width_mm ?? null, z: topOf(job.operation ?? '') });
      }
    } else if (files.has('program-check.json')) {
      results = (await artifactJson<{ conical_paths?: EngraveCoverage[] }>(job.id, 'program-check.json')).conical_paths ?? [];
      if (files.has('pocket-regions.json')) {
        type Corridor = { radius_mm: number; tip_radius_mm: number; tip_height_mm: number };
        type Region = { operation: string; region_kind?: string; floor_mm?: number; conical_paths?: EngravePathOut[]; conical_corridors?: Corridor[] };
        for (const region of await artifactJson<Region[]>(job.id, 'pocket-regions.json')) {
          if (region.region_kind !== 'conical_corridors') continue;
          const top = topOf(region.operation);
          const cone = region.conical_corridors?.[0];
          // The groove's width at the surface: the cone's diameter that far above the tip (the engine's surface width).
          const width = cone && top !== null && typeof region.floor_mm === 'number'
            ? engraveWidth({ diameter: cone.radius_mm * 2, tipDiameter: cone.tip_radius_mm * 2, angle: 2 * Math.atan((cone.radius_mm - cone.tip_radius_mm) / cone.tip_height_mm) }, top - (region.floor_mm - origin[2]))
            : null;
          for (const path of region.conical_paths ?? []) where.set(`${region.operation}:${path.id}`, { points: path.points_mm, closed: !!path.closed, width, z: top });
        }
      }
    }
    // A chamfer's row shows its own width, drawn at its lower edge (the bottom height) rather than a groove at the top.
    const chamferOf = (operation: string) => {
      const op = (program.compiled.operations as Record<string, unknown>[]).find((item) => item.id === sourceOperation(program.id, operation));
      const strategy = (op?.strategy ?? {}) as Record<string, unknown>;
      return strategy.kind === 'chamfer' ? { width: typeof strategy.chamfer_width_mm === 'number' ? strategy.chamfer_width_mm : null, z: typeof strategy.bottom_mm === 'number' ? strategy.bottom_mm : null } : null;
    };
    const paths: EngraveRow[] = results.map((result) => {
      const place = where.get(`${result.operation}:${result.path}`);
      const chamfer = chamferOf(result.operation);
      return { ...result, points: (place?.points ?? []).map(([x, y]) => [x - origin[0], y - origin[1]] as [number, number]), closed: place?.closed ?? false,
        width: chamfer ? chamfer.width : place?.width ?? null, z: chamfer ? chamfer.z : place?.z ?? null };
    });
    set((state) => ({ engrave: { ...state.engrave, [job.id]: { paths, error: null } } }));
  } catch (error) {
    set((state) => ({ engrave: { ...state.engrave, [job.id]: { paths: [], error: (error as Error).message } } }));
  }
}

/** A rest operation's plan (rest-plan.json): whether material remained and how much of the path was proven air. */
export async function loadRest(job: JobRecord) {
  if (get().rest[job.id]) return;
  try {
    const plan = await artifactJson<RestPlan>(job.id, 'rest-plan.json');
    set((state) => ({ rest: { ...state.rest, [job.id]: { plan, error: null } } }));
  } catch (error) {
    set((state) => ({ rest: { ...state.rest, [job.id]: { plan: null, error: (error as Error).message } } }));
  }
}

/** Shows a contour in the viewport (or clears it). */
export function highlightContour(mark: ContourMark | null) { set({ contourHighlight: mark }); viewer.invalidate(); }

/** The machine file, or why it can't be downloaded (failed checks block it). */
export async function downloadMachineFile(job: JobRecord) {
  const file = job.output?.files.find((item) => item.role === 'machine_program');
  if (!file) { toast('warning', 'No machine file', 'This job has no machine program.'); return; }
  const result = await artifactText(job.id, file.name);
  if (result.text === null) {
    toast('danger', result.status === 409 ? 'Download blocked by failed checks' : 'Couldn’t download', result.message ?? `The server answered ${result.status}.`);
    return;
  }
  const record = program(job.program_id);
  const name = `${(record?.compiled.name ?? 'program').replace(/[^\w.-]+/g, '_')}-r${job.revision}-${isPost(job) ? 'program' : job.operation}.nc`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([result.text], { type: 'text/plain' }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** The latest job for an operation (any status), and the latest that succeeded. */
export function latestJobs(programId: string | null, operation: string | null) {
  const list = (programId ? get().jobs[programId] : undefined) ?? [];
  // A pattern's jobs are its instances'.
  const mine = list.filter((job) => !operation || job.operation === operation || (!!programId && !!job.operation && sourceOperation(programId, job.operation) === operation));
  return { latest: mine[0] ?? null, succeeded: mine.find((job) => job.status === 'succeeded') ?? null };
}

/** A program revision's latest run and combined output (any status), and the latest combined output that succeeded. */
export function latestProgram(record: ProgramRecord | null) {
  if (!record) return { run: null, last: null, post: null, posted: null };
  const state = get();
  const mine = (state.runs[record.id] ?? []).filter((item) => item.revision === record.revision);
  // The program's own run: every operation (a run for one operation selects only it and its ancestors).
  const run = mine.find((item) => item.operations.length === (expandedOps(record)?.length ?? opsOf(record).length)) ?? null;
  // The latest run of this revision whatever it selected (generating one operation, or a pattern's instances).
  const last = mine[0] ?? null;
  const posts = (state.posts[record.id] ?? []).filter((job) => job.revision === record.revision);
  return { run, last, post: posts[0] ?? null, posted: posts.find((job) => job.status === 'succeeded') ?? null };
}

/** A combined program's setup (null: posted before setups were selectable, i.e. the only one). */
export const postSetup = (job: JobRecord) => (job as JobRecord & { program_source?: { setup?: string | null } }).program_source?.setup ?? null;

/** Each setup's latest combined output of the program's current revision (and the latest one that succeeded). */
export function setupPosts(record: ProgramRecord): Record<string, { post: JobRecord | null; posted: JobRecord | null }> {
  const posts = (get().posts[record.id] ?? []).filter((job) => job.revision === record.revision);
  const first = String((record.compiled.setups[0] as { id?: string } | undefined)?.id ?? 'setup');
  const out: Record<string, { post: JobRecord | null; posted: JobRecord | null }> = {};
  for (const setup of record.compiled.setups as { id?: string }[]) {
    const id = String(setup.id);
    const mine = posts.filter((job) => (postSetup(job) ?? first) === id);
    out[id] = { post: mine[0] ?? null, posted: mine.find((job) => job.status === 'succeeded') ?? null };
  }
  return out;
}

export function selectOperation(programId: string, operation: string | null) {
  useMfg.setState({ activeProgram: programId });
  set({ activeOperation: operation, activeSetup: null, editor: null, picking: null, activeJob: null });
  setApp({ dockOpen: true, dockTab: 'properties' });
  const record = program(programId);
  const shown = () => { const { succeeded } = operation && record ? latestJobs(programId, operation) : { succeeded: null }; void showToolpath(succeeded && succeeded.revision === record?.revision ? succeeded : null); };
  shown();
  void loadJobs(programId).then(shown);
}

export function selectJob(job: JobRecord) {
  set({ activeJob: job.id, activeOperation: isPost(job) || !job.operation ? null : sourceOperation(job.program_id, job.operation) });
  if (job.status === 'succeeded') void loadResults(job);
  else if (!terminal(job.status)) watchJob(job.id);
}

// ── Commands ───────────────────────────────────────────────────────────────

/** The program the ribbon acts on: the selected one, or the document's only one. */
const activeRecord = () => program(useMfg.getState().activeProgram) ?? (useMfg.getState().programs.length === 1 ? useMfg.getState().programs[0] : null);
const activeOp = (record: ProgramRecord) => get().activeOperation && opsOf(record).some((op) => op.id === get().activeOperation) ? get().activeOperation : null;
/** The setup selected in the browser, if it still exists. */
function selectedSetup(): { record: ProgramRecord; setupId: string } | null {
  const value = get().activeSetup;
  if (!value) return null;
  const [programId, setupId] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
  const record = program(programId);
  return record && (record.compiled.setups as { id?: string }[]).some((item) => String(item.id) === setupId) ? { record, setupId } : null;
}

/** Selects a setup: the Inspector shows it, operations from the ribbon go into it, Generate runs its operations. */
export function selectSetup(programId: string, setupId: string) {
  useMfg.setState({ activeProgram: programId });
  set({ activeSetup: `${programId}:${setupId}`, activeOperation: null, editor: null, picking: null, activeJob: null });
  setApp({ dockOpen: true, dockTab: 'properties' });
  void showToolpath(null);
  void loadJobs(programId);
}

/**
 * The setup a new operation goes into: the selected setup, the selected operation's, the document's only setup, else
 * the last setup of the selected (or most recent) program. The operation's tool shows it at the top to change.
 */
function targetSetup(): { record: ProgramRecord; setupId: string } | null {
  const chosen = selectedSetup();
  if (chosen) return chosen;
  const record = activeRecord();
  const op = record ? activeOp(record) : null;
  if (record && op) return { record, setupId: setupOfOperation(record.compiled, op) };
  const choices = setupChoices();
  if (choices.length === 1) return { record: program(choices[0].programId)!, setupId: choices[0].setupId };
  const fallback = setupProgram();
  const last = fallback ? (fallback.compiled.setups as { id?: string }[]).at(-1) : null;
  return fallback && last ? { record: fallback, setupId: String(last.id) } : null;
}

/** Why an operation's command can't run now (true when it can): the engine runs it, and there's a setup to put it in. */
export function operationReason(kind: OpKind): true | string {
  const engine = capable(kind);
  if (engine !== true) return engine;
  if (!setupChoices().length) return 'Create a setup first (Setup, on the left of the ribbon).';
  return true;
}

/** New program: a CAM program for the open part (a document; its code is the program), opened on its first setup. */
export async function newProgram() {
  const record = await newCamProgram();
  if (record) await newSetupTool();
}

/** Setup: a new setup (the Setup tool). Saved setups are edited from the browser. */
export function commandSetup() { newSetupTool(); }

/** An operation's command: its tool, on a new operation in the target setup. */
export function commandOperation(kind: OpKind) {
  const reason = operationReason(kind);
  if (reason !== true) { toast('info', OP_LABEL[kind], reason); return; }
  const target = targetSetup();
  if (!target) { toast('info', OP_LABEL[kind], 'Create a setup first.'); return; }
  if (kind === 'rest' && !opsOfSetup(target.record.compiled, target.setupId).length) {
    toast('info', OP_LABEL.rest, 'Rest machining cleans up what the operation before it left: add a pocket to this setup first.');
    return;
  }
  newOperationTool(target.record, target.setupId, kind);
}
export const commandPocket = () => commandOperation('pocket');
export const commandFace = () => commandOperation('face');
export const commandRough = () => commandOperation('rough');
export const commandDrill = () => commandOperation('peck_drill');
export const commandContour = () => commandOperation('contour');
export const commandBore = () => commandOperation('bore');
export const commandSlot = () => commandOperation('slot');
export const commandEngrave = () => commandOperation('engrave');
export const commandChamfer = () => commandOperation('chamfer');
export const commandParallel = () => commandOperation('parallel');
export const commandWaterline = () => commandOperation('waterline');
export const commandRest = () => commandOperation('rest');

/**
 * What Generate, Simulate and Post act on: the selected operation, the selected setup's operations, or the whole
 * program; null (and a toast saying what to add) when there's nothing to run.
 */
function runScope(verb: string): { record: ProgramRecord; op: string | null; setup: string | null; ops: string[] } | null {
  const chosen = selectedSetup();
  const record = chosen?.record ?? activeRecord();
  if (!record) { toast('info', `Nothing to ${verb}`, 'Create a setup, then add an operation to it.'); return null; }
  const op = chosen ? null : activeOp(record);
  if (op) return { record, op, setup: null, ops: [op] };
  const ops = chosen ? opsOfSetup(record.compiled, chosen.setupId).map((item) => String(item.id)) : opsOf(record).map((item) => item.id);
  if (!ops.length) {
    toast('info', `Nothing to ${verb}`, chosen ? 'This setup has no operations yet: add one from the ribbon.' : 'Add an operation to a setup first.');
    return null;
  }
  return { record, op: null, setup: chosen?.setupId ?? null, ops };
}

/** Generate: the selected operation, the selected setup's operations, or the whole program. */
export function commandGenerate() {
  const scope = runScope('generate');
  if (!scope) return;
  if (scope.op) void runOperation(scope.record, scope.op);
  else if (scope.setup) void runProgram(scope.record, scope.ops, undefined, scope.setup);
  else void runProgram(scope.record);
}

/** The job a program-level action means: the combined output with several operations, else the only operation's job. */
function programJob(record: ProgramRecord): JobRecord | null {
  const ops = opsOf(record);
  if (ops.length === 1) { const { succeeded } = latestJobs(record.id, ops[0].id); return succeeded && succeeded.revision === record.revision ? succeeded : null; }
  return latestProgram(record).posted;
}

/** Runs what `scope` names and hands the finished job (an operation's, or the combined output) to `then`. */
function withJob(scope: NonNullable<ReturnType<typeof runScope>>, then: (job: JobRecord) => void) {
  const { record } = scope;
  const only = scope.op ?? (scope.ops.length === 1 ? scope.ops[0] : null);
  if (only) {
    const { succeeded } = latestJobs(record.id, only);
    if (succeeded && succeeded.revision === record.revision) { then(succeeded); return; }
    void runOperation(record, only, then);
    return;
  }
  if (scope.setup) {
    // The setup's combined output of this revision, when there is one: nothing changed, so nothing runs again.
    const posted = setupPosts(record)[scope.setup]?.posted;
    if (posted) { then(posted); return; }
    void runProgram(record, scope.ops, then, scope.setup);
    return;
  }
  const job = programJob(record);
  if (job) { then(job); return; }
  void runProgram(record, [], then);
}

export function commandSimulate() {
  const scope = runScope('simulate');
  // A CAM program's selected operation plays its own job of the last run, generated whether or not a later one failed
  // too; the setup or program, its posted G-code.
  if (scope && isCam(scope.record) && scope.op) void simulateCamOperation(scope.record.cam.document_id, scope.op);
  else if (scope && isCam(scope.record)) void simulateCam(scope.record.cam.document_id, useCam.getState().activeSetup);
  else if (scope) withJob(scope, (job) => void openPlayer(job));
}

export function commandPost() {
  const scope = runScope('post');
  if (scope && isCam(scope.record)) void downloadGcode(scope.record.cam.document_id, useCam.getState().activeSetup);
  else if (scope) withJob(scope, (job) => void downloadMachineFile(job));
}

// ── Player ─────────────────────────────────────────────────────────────────

/** A stretch of the program played by one operation (display attribution, not a transferred verdict). */
export interface Band { operation: string; name: string; kind: OpKind | null; first: number; last: number }

export interface Player {
  job: JobRecord;
  /** A combined program (several operations and tools) rather than one operation. */
  program: boolean;
  /** `empty`: a decoded program with no moves (rest machining that found nothing to cut): stock only, no timeline. */
  status: 'loading' | 'ready' | 'unavailable' | 'empty' | 'error';
  message: string | null;
  preview: SimulationPreview | null;
  motion: Motion | null;
  times: Float64Array | null;
  /** Rapid pace used for machine time (the machine's maximum axis rate; the format carries no rapid speed). */
  rapidMmMin: number;
  events: VerificationEvent[];
  fixtures: FixtureDisplay[];
  setup: ResolvedSetup | null;
  /** Program zero on the machine (the setup's work origin). */
  origin: number[] | null;
  /** Frozen assembly snapshots by tool number (tool-assembly.json, or a combined program's tool-assemblies.json). */
  tools: Record<number, AssemblySnapshot>;
  /** The tool in the spindle at the start. */
  initialTool: number | null;
  /** @deprecated The first tool's snapshot (tools[initialTool]). */
  tool: AssemblySnapshot | null;
  /** Spindle, work-offset and tool-change states before each move (combined programs). */
  states: ProgramStateTransition[];
  bands: Band[];
  /** Posted program lines, or why they can't be read (a blocked download). */
  code: string[] | null;
  codeNote: string | null;
  assessment: PostAssessment | null;
  /** The finished stock against the expected design bodies, when the setup asks for it (drawn over the final stock). */
  inspection: StockInspection | null;
}

export interface PlayerView {
  /** Playback position in move units (move i spans [i, i + 1)). */
  position: number;
  playing: boolean;
  /** Machine-time multiplier. */
  speed: number;
  focus: number | null;
  show: { toolpath: boolean; stock: 'solid' | 'translucent' | 'off'; fixtures: boolean; tool: boolean; part: boolean; inspection: boolean };
  /** The finished-stock inspection region picked from a list (an index into `player.inspection.regions`). */
  inspectionFocus: number | null;
  panel: 'checks' | 'program' | null;
  /** Why the continuous stock couldn't be shown (the player then shows the checkpoints). */
  stockError: string | null;
}

export const usePlayer = create<{ player: Player | null } & PlayerView>(() => ({
  player: null, position: 0, playing: false, speed: 10, focus: null,
  show: { toolpath: true, stock: 'solid', fixtures: true, tool: true, part: false, inspection: true }, inspectionFocus: null, panel: 'checks', stockError: null,
}));

/**
 * The selected operation's toolpath over the part (no simulation): its generated job's decoded motion, drawn in full
 * while the operation is selected, as CAM shows a selected operation's path. Cleared on another selection.
 */
export const useToolpath = create<{ jobId: string | null; motion: Motion | null; origin: [number, number, number] | null }>(() => ({ jobId: null, motion: null, origin: null }));
const toolpaths = new Map<string, { motion: Motion; origin: [number, number, number] }>();

export async function showToolpath(job: JobRecord | null) {
  if (!job || job.status !== 'succeeded' || isPost(job)) { useToolpath.setState({ jobId: null, motion: null, origin: null }); return; }
  if (useToolpath.getState().jobId === job.id) return;
  useToolpath.setState({ jobId: job.id, motion: null, origin: null });
  try {
    let loaded = toolpaths.get(job.id);
    if (!loaded) {
      const files = new Set(job.output?.files.map((file) => file.name) ?? []);
      const [preview, setup] = await Promise.all([camJobs.simulation(job.id), files.has('setup.json') ? artifactJson<ResolvedSetup>(job.id, 'setup.json') : Promise.resolve(null)]);
      const controller = setup?.controller;
      const origin = (controller?.work_origin_mm ?? controller?.work_offsets?.find((item) => item.slot === (controller.initial_work_offset ?? 1))?.origin_mm ?? controller?.work_offsets?.[0]?.origin_mm ?? null) as [number, number, number] | null;
      if (preview.status === 'unavailable' || !preview.moves || !origin || !MOTION_FORMATS.includes(preview.format)) { useToolpath.setState((state) => (state.jobId === job.id ? { jobId: null } : {})); return; }
      const chunks = [];
      for (const chunk of preview.chunks) chunks.push(decodeChunk(await artifactBytes(job.id, chunk.file), chunk.first_move, chunk.last_move - chunk.first_move + 1));
      const start = (preview.initial_position_mm ?? preview.chunks[0]?.initial_position_mm ?? controller?.initial_tip_mm ?? [0, 0, 0]) as [number, number, number];
      loaded = { motion: joinChunks(chunks, start, []), origin };
      toolpaths.set(job.id, loaded);
    }
    useToolpath.setState((state) => (state.jobId === job.id ? { motion: loaded!.motion, origin: loaded!.origin } : {}));
    viewer.invalidate();
  } catch { useToolpath.setState((state) => (state.jobId === job.id ? { jobId: null, motion: null, origin: null } : {})); }
}

export function closePlayer() { usePlayer.setState({ player: null, playing: false, focus: null, inspectionFocus: null }); }

/** The tool in the spindle at playback position t (before the first move: the initial tool). */
export function toolAt(player: Player, t: number): number | null {
  const motion = player.motion;
  if (!motion || !motion.count) return player.initialTool;
  if (t < 0.0001) return player.initialTool ?? motion.tool[0];
  return motion.tool[Math.min(motion.count - 1, Math.floor(t))];
}

const COMPONENT_KIND = (component: string): VerificationEvent['kind'] =>
  /holder|adapt/i.test(component) ? 'holder_contact' : /shank|neck/i.test(component) ? 'shank_contact' : /cut|flute|tip/i.test(component) ? 'cutter_contact' : 'uncertain';
const PHASE_TEXT: Record<string, string> = { initial: ' at the start', move: '', exchange_old: ' at the tool change (outgoing tool)', exchange_new: ' at the tool change (incoming tool)' };

/**
 * A combined program's events as the player's event rows, each on the decoded move it happened in, its operation the
 * band it falls in. Newer outputs bind every event to the decoded motion (`move_index`, or `before_move` for a
 * stationary placement such as a tool change); older ones name the posted line (`line_81`) and are placed by it, with
 * exchange phases on the tool change.
 */
export function programEventsOf(raw: ProgramVerificationEvents, motion: Motion | null, bands: Band[], states: ProgramStateTransition[]): VerificationEvent[] {
  const changes = states.filter((item) => item.event.kind === 'tool_change');
  const last = motion ? Math.max(0, motion.count - 1) : Number.MAX_SAFE_INTEGER;
  const moveOf = (event: { move: string; phase?: string | null; tool_number?: number | null; move_index?: number | null; before_move?: number | null }): number | null => {
    if (typeof event.move_index === 'number') return Math.min(last, event.move_index);
    if (typeof event.before_move === 'number') return Math.min(last, event.before_move);
    const phase = event.phase ?? 'move', tool = event.tool_number ?? null;
    const line = /^line_(\d+)$/.exec(event.move)?.[1];
    if (phase === 'exchange_old' || phase === 'exchange_new') {
      const change = changes.find((item) => item.placement && (item.placement.source_line === Number(line) || item.placement[phase === 'exchange_old' ? 'old_tool' : 'new_tool'] === tool));
      if (change) return Math.min(last, change.before_move);
    }
    if (phase === 'initial') return 0;
    if (!line || !motion) return null;
    const index = moveForLine(motion, Number(line));
    return index >= 0 ? index : null;
  };
  const operationOf = (index: number | null) => {
    if (index === null) return 0;
    const band = bands.findIndex((item) => index >= item.first && index <= item.last);
    return Math.max(0, band);
  };
  const frame = (origin: number[]) => ({ origin_mm: origin, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  const at = (index: number | null) => ({ move_range: index === null ? null : [index, index] as [number, number], operation: operationOf(index) });
  const words = (id: string) => id.replace(/_/g, ' ');
  const out: VerificationEvent[] = [];
  for (const event of raw.fixtures ?? []) {
    out.push({
      kind: COMPONENT_KIND(event.tool_component), severity: event.status, region: event.tool_component, fixture: event.fixture, check: 'fixture_collision',
      message: `T${event.tool_number} ${words(event.tool_component)} reaches fixture ${event.fixture}${PHASE_TEXT[event.phase] ?? ''}.`,
      ...at(moveOf(event)), pose: null, pose_basis: 'unavailable',
      segment_fraction: event.interval ?? null, penetration_or_clearance_mm: null, witness_mm: event.witness_mm ?? null, witness_t: event.witness_t ?? null,
    });
  }
  for (const event of raw.pockets ?? []) {
    out.push({
      kind: event.status === 'failed' ? 'gouge' : 'uncertain', severity: event.status, region: null, fixture: null, check: 'program_pocket_clearance',
      message: `T${event.tool_number}: ${event.message}`, ...at(moveOf(event)),
      pose: event.tip_mm ? frame(event.tip_mm) : null, pose_basis: event.tip_mm ? 'interval_start' : 'unavailable',
      segment_fraction: event.parameter_range ?? null, penetration_or_clearance_mm: null,
    });
  }
  const STOCK_KIND: Record<string, VerificationEvent['kind']> = { initial_occupancy: 'initial_occupancy', rapid_in_stock: 'rapid_in_stock', target_gouge: 'gouge' };
  for (const event of raw.stock ?? []) {
    const text = { initial_occupancy: 'starts in material', rapid_in_stock: 'rapids through stock', noncutting_in_stock: 'non-cutting part in stock', target_gouge: 'cuts into the finished part' }[event.kind];
    out.push({
      kind: STOCK_KIND[event.kind] ?? COMPONENT_KIND(event.component), severity: event.status, region: event.component, fixture: null, check: event.kind === 'target_gouge' ? 'target_gouge' : 'noncutting_stock',
      message: `T${event.tool_number} ${words(event.component)} ${text ?? event.kind}${PHASE_TEXT[event.phase] ?? ''}.`,
      ...at(moveOf(event)), pose: null, pose_basis: 'unavailable', segment_fraction: event.interval ?? null, penetration_or_clearance_mm: null,
      witness_mm: event.witness_mm ?? null, witness_t: event.witness_t ?? null,
    });
  }
  for (const event of raw.targets ?? []) {
    const gouge = event.check === 'target_gouge';
    out.push({
      kind: gouge ? 'gouge' : COMPONENT_KIND(event.tool_component), severity: event.status, region: event.tool_component, fixture: null, check: event.check, target: event.target,
      message: `T${event.tool_number} ${words(event.tool_component)} ${gouge ? 'cuts into' : 'touches'} the finished part (${event.target})${event.penetration_mm ? ` by up to ${Number(event.penetration_mm.toFixed(3))} mm` : ''}${PHASE_TEXT[event.phase] ?? ''}.`,
      ...at(moveOf(event)), pose: null, pose_basis: 'unavailable', segment_fraction: event.interval, penetration_or_clearance_mm: event.penetration_mm ?? null,
      witness_mm: event.witness_mm ?? null, witness_t: event.witness_t ?? null,
    });
  }
  for (const event of raw.machines ?? []) {
    out.push({
      kind: 'machine_contact', severity: event.status, region: null, fixture: null, check: 'machine_self_collision', machine_bodies: [event.first, event.second],
      message: `Machine ${words(event.first)} and ${words(event.second)} ${event.status === 'failed' ? 'collide' : 'may touch'}${PHASE_TEXT[event.phase] ?? ''}.`,
      ...at(moveOf(event)), pose: null, pose_basis: 'unavailable', segment_fraction: event.interval, penetration_or_clearance_mm: null, witness_t: event.witness_t ?? null,
    });
  }
  const CONTACT_CHECK = { tool_region: 'machine_tool_collision', fixture: 'machine_fixture_collision', stock: 'machine_stock_collision' } as const;
  for (const event of raw.machine_contacts ?? []) {
    const what = event.target === 'stock' ? 'the stock' : event.target === 'fixture' ? `fixture ${event.fixture ?? ''}`.trim() : `the T${event.tool_number} ${words(event.region ?? 'tool')}`;
    out.push({
      kind: 'machine_contact', severity: event.status, region: event.target === 'tool_region' ? event.region ?? null : null, fixture: event.fixture ?? null,
      check: CONTACT_CHECK[event.target], machine_body: event.machine_body,
      message: `Machine ${words(event.machine_body)} ${event.status === 'failed' ? 'hits' : 'may touch'} ${what}${PHASE_TEXT[event.phase] ?? ''}.`,
      ...at(moveOf(event)), pose: null, pose_basis: 'unavailable', segment_fraction: event.interval, penetration_or_clearance_mm: null,
      witness_mm: event.witness_mm ?? null, witness_t: event.witness_t ?? null,
    });
  }
  for (const event of raw.engagement ?? []) {
    const rate = (value: number) => `${Math.round(value).toLocaleString()} mm³/min`;
    out.push({
      kind: 'engagement_limit', severity: event.status, region: null, fixture: null, check: 'geometric_removal_rate',
      message: event.limit_mm3_min !== null
        ? `T${event.tool_number} removes ${event.upper_mm3_min === null ? `at least ${rate(event.lower_mm3_min)}` : `${rate(event.lower_mm3_min)}–${rate(event.upper_mm3_min)}`}; the limit is ${rate(event.limit_mm3_min)}.`
        : `T${event.tool_number}: material removal rate not assessed (${words(event.code)}).`,
      ...at(moveOf(event)), pose: null, pose_basis: 'unavailable', segment_fraction: event.interval, penetration_or_clearance_mm: null,
    });
  }
  for (const event of raw.tabs ?? []) {
    out.push({
      kind: event.status === 'failed' ? 'gouge' : 'uncertain', severity: event.status, region: null, fixture: null, check: event.check,
      message: `Tab ${event.tab}: ${event.message}`, ...at(moveOf(event)), pose: null, pose_basis: 'unavailable', segment_fraction: event.parameter_range, penetration_or_clearance_mm: null,
    });
  }
  return out;
}

export async function openPlayer(job: JobRecord) {
  const combined = isPost(job);
  usePlayer.setState({
    player: { job, program: combined, status: 'loading', message: null, preview: null, motion: null, times: null, rapidMmMin: 5000, events: [], fixtures: [], setup: null, origin: null,
      tools: {}, initialTool: null, tool: null, states: [], bands: [], code: null, codeNote: null, assessment: null, inspection: null },
    position: 0, playing: false, focus: null, inspectionFocus: null, stockError: null,
  });
  setApp({ workspace: 'manufacture' });
  highlightHole(null);
  const update = (patch: Partial<Player>) => usePlayer.setState((state) => (state.player?.job.id === job.id ? { player: { ...state.player, ...patch } } : {}));
  try {
    const files = new Set(job.output?.files.map((file) => file.name) ?? []);
    const [preview, assessment, rawEvents, fixtures, setup] = await Promise.all([
      camJobs.simulation(job.id), camJobs.verification(job.id), camJobs.programEvents(job.id),
      files.has('fixtures.json') ? artifactJson<FixtureDisplay[]>(job.id, 'fixtures.json') : Promise.resolve([] as FixtureDisplay[]),
      files.has('setup.json') ? artifactJson<ResolvedSetup>(job.id, 'setup.json') : Promise.resolve(null),
    ]);
    const inspection = files.has('stock-inspection.json') ? await artifactJson<StockInspection>(job.id, 'stock-inspection.json').catch(() => null) : null;
    // Tools by number: one operation's assembly, or each tool of a combined program.
    const tools: Record<number, AssemblySnapshot> = {};
    if (files.has('tool-assemblies.json')) for (const [number, snapshot] of Object.entries(await artifactJson<Record<string, AssemblySnapshot>>(job.id, 'tool-assemblies.json'))) tools[Number(number)] = snapshot;
    else if (files.has('tool-assembly.json')) tools[preview.tool_number ?? setup?.controller.tool_number ?? 1] = await artifactJson<AssemblySnapshot>(job.id, 'tool-assembly.json');
    const initialTool = preview.initial_tool ?? preview.tool_number ?? setup?.controller.initial_tool ?? setup?.controller.tool_number ?? null;
    const states = combined ? await camJobs.stateEvents(job.id).catch(() => [] as ProgramStateTransition[]) : [];
    const controller = setup?.controller;
    const origin = controller?.work_origin_mm ?? controller?.work_offsets?.find((item) => item.slot === (controller.initial_work_offset ?? 1))?.origin_mm ?? controller?.work_offsets?.[0]?.origin_mm ?? null;
    // Operation bands, named as the program names its operations.
    const record = program(job.program_id);
    const ops = record ? opsOf(record) : [];
    // A pattern instance's band is named for its instance ("Pocket [u1_v0]") and drawn as its pattern's kind.
    const named = (id: string): { name: string; kind: OpKind | null } => {
      const op = ops.find((item) => item.id === (record ? sourceOperation(record.id, id) : id));
      return { name: record ? operationName(record, id) : op?.name ?? id, kind: op ? kindOf(op as Record<string, unknown>) : null };
    };
    const bands: Band[] = combined
      ? (preview.operations ?? []).map((range) => ({ operation: range.operation, ...named(range.operation), first: range.first_move, last: range.last_move }))
      : preview.operation_ids.length ? [{ operation: preview.operation_ids[0], ...named(preview.operation_ids[0]), first: 0, last: Math.max(0, preview.moves - 1) }] : [];
    const machineFile = job.output?.files.find((file) => file.role === 'machine_program');
    const posted = machineFile ? await artifactText(job.id, machineFile.name) : null;
    const code = posted?.text ? posted.text.replace(/\r?\n$/, '').split(/\r?\n/) : null;
    const codeNote = posted && !posted.text
      ? (posted.status === 409 ? `The machine file is blocked by failed checks${posted.message ? `: ${posted.message}` : '.'}` : posted.message ?? 'The machine file could not be read.') : null;
    const rapidMmMin = controller?.maximum_feed_mm_min ?? 5000;
    const listed = Array.isArray(rawEvents) ? rawEvents : [];
    update({ preview, assessment, events: listed, fixtures, setup, origin, tools, initialTool, tool: initialTool !== null ? tools[initialTool] ?? null : null, states, bands, code, codeNote, rapidMmMin, inspection });
    const anyFailed = (Array.isArray(rawEvents) ? rawEvents.some((event) => event.severity === 'failed')
      : [...rawEvents.fixtures, ...rawEvents.pockets, ...rawEvents.stock, ...rawEvents.machines ?? [], ...rawEvents.machine_contacts ?? [], ...rawEvents.targets ?? [], ...rawEvents.engagement ?? [], ...rawEvents.tabs ?? []].some((event) => event.status === 'failed'))
      || assessment.download_status === 'blocked_failed_checks';
    // The events list opens by itself only when a check failed; otherwise the viewport stays clear.
    usePlayer.setState({ panel: anyFailed ? 'checks' : null });
    if (preview.status === 'unavailable') {
      update({ status: 'unavailable', message: preview.diagnostic ?? 'This output could not be decoded, so there is no simulation of it.' });
      usePlayer.setState({ panel: 'program' });
      return;
    }
    // Frames the stock and the tool above it, in the design (work) frame the player draws in.
    const frame = () => {
      const bounds = setup?.initial_stock_bounds;
      if (!bounds || !origin) return;
      const box = new THREE.Box3(new THREE.Vector3(...bounds.minimum_mm).sub(new THREE.Vector3(...origin)), new THREE.Vector3(...bounds.maximum_mm).sub(new THREE.Vector3(...origin)));
      const gauge = Math.max(controller?.tool_gauge_length_mm ?? 0, ...(controller?.tools ?? []).map((tool) => tool.gauge_length_mm));
      box.max.z += Math.min(gauge || 50, (box.max.x - box.min.x) * 0.8);
      // Clear of the player deck along the bottom of the viewport.
      const insets = viewer.insets;
      viewer.insets = { ...insets, bottom: Math.max(insets.bottom, 230) };
      viewer.frame(box, null, false);
      viewer.insets = insets;
    };
    if (!preview.moves) {
      // A proved-empty rest operation: modal setup and shutdown, no motion, the stock unchanged.
      update({ status: 'empty', message: 'Nothing to cut: the stock the operation before left has no material on this path, so the program moves nothing and the stock is unchanged.' });
      usePlayer.setState({ panel: 'program' });
      frame();
      return;
    }
    if (!MOTION_FORMATS.includes(preview.format)) throw new Error(`This studio reads ${MOTION_FORMATS.join(' and ')} motion; the job published ${preview.format}.`);
    const chunks = [];
    for (const chunk of preview.chunks) chunks.push(decodeChunk(await artifactBytes(job.id, chunk.file), chunk.first_move, chunk.last_move - chunk.first_move + 1));
    const start = (preview.initial_position_mm ?? preview.chunks[0]?.initial_position_mm ?? controller?.initial_tip_mm ?? [0, 0, 0]) as [number, number, number];
    // A combined program's chunks split at each tool change and restart at the new tool's tip.
    const motion = joinChunks(chunks, start, preview.format === PROGRAM_MOTION_FORMAT ? preview.chunks.map((chunk) => ({ first: chunk.first_move, at: chunk.initial_position_mm })) : []);
    const events = Array.isArray(rawEvents) ? await withWitnesses(job, files, rawEvents, motion) : programEventsOf(rawEvents, motion, bands, states);
    update({ motion, times: cumulativeTime(motion, rapidMmMin), events, status: 'ready' });
    frame();
  } catch (error) {
    update({ status: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * One operation's fixture events with the witness points fixture-check.json adds to collisions (matched by posted line,
 * tool region, fixture and interval); the events endpoint doesn't carry them.
 */
async function withWitnesses(job: JobRecord, files: Set<string>, events: VerificationEvent[], motion: Motion): Promise<VerificationEvent[]> {
  if (!files.has('fixture-check.json') || !events.some((event) => event.check === 'fixture_collision' && event.severity === 'failed')) return events;
  const check = await artifactJson<{ events?: FixtureContact[] }>(job.id, 'fixture-check.json').catch(() => null);
  const witnessed = new Map<string, FixtureContact>();
  for (const contact of check?.events ?? []) {
    const line = /^line_(\d+)$/.exec(contact.move)?.[1];
    const move = line ? moveForLine(motion, Number(line)) : -1;
    if (contact.witness_mm && move >= 0) witnessed.set(`${move}|${contact.tool_component}|${contact.fixture}|${contact.interval[0]}`, contact);
  }
  return events.map((event) => {
    const contact = event.move_range && witnessed.get(`${event.move_range[0]}|${event.region}|${event.fixture}|${event.segment_fraction?.[0]}`);
    return contact ? { ...event, witness_mm: contact.witness_mm, witness_t: contact.witness_t } : event;
  });
}

/** Seeks to an event: its first move (at its witness, else the start of its interval, when known), focusing it. */
export function seekEvent(index: number) {
  const event = usePlayer.getState().player?.events[index];
  if (!event) return;
  const position = event.move_range ? event.move_range[0] + (event.witness_t ?? event.segment_fraction?.[0] ?? 0) : usePlayer.getState().position;
  usePlayer.setState({ focus: index, position, playing: false });
}

// The editor and the player belong to the open document's programs: another document closes them.
useApp.subscribe((state) => state.doc.saved?.id ?? null, (id, previous) => {
  if (previous && id !== previous) { closeEditor(); closePlayer(); }
});

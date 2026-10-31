import { recordRecent } from '@/lib/recentErrors';
import type { ModelDoc } from '@/lib/modeling';
import { create } from 'zustand';
import { hasFiles, modelBuiltFrom, stored } from './design';
import { subscribeWithSelector } from 'zustand/middleware';
import type { Build, BuildFailure, CadDocument, Kind, LinkRef } from '@/lib/api';
import type { FeatureFetch } from '@/lib/features';
import type { Branch, VersionGraph } from '@/lib/branches';
import type { DocTab } from './tabs';
import { useWorkspace } from '@/teams/current';

export type Workspace = 'design' | 'simulate' | 'manufacture' | 'electronics';
export type DesignTab = 'solid' | 'sheet' | 'surface' | 'motion' | 'drawing' | 'animation';
/** `panel:<id>`: a connector's panel (connectors/PanelFrame.tsx). */
export type DockTab = 'properties' | 'parts' | 'source' | 'assistant' | 'comments' | 'history' | 'tool' | `panel:${string}`;
export type DisplayStyle = 'shaded-edges' | 'shaded' | 'hidden-line' | 'wireframe' | 'xray';
export type Projection = 'orthographic' | 'perspective';
export type SelectionFilter = 'auto' | 'component' | 'face' | 'edge' | 'vertex';
export type Tool = 'select' | 'measure' | 'section' | 'explode' | 'plane' | 'joint' | 'place' | 'motion' | 'explodeSteps';
export type StandardView = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';
export type Theme = 'dark' | 'light';
export type Axis = 'x' | 'y' | 'z';

export type EntityPick = { kind: 'face' | 'edge' | 'vertex'; node: string; mesh: number; index: number };
export type Pick = { kind: 'component'; node: string } | EntityPick;

export const pickKey = (pick: Pick) => pick.kind === 'component' ? `component:${pick.node}` : `${pick.kind}:${pick.node}:${pick.mesh}:${pick.index}`;

export interface TreeNode {
  id: string;
  name: string;
  type: 'document' | 'assembly' | 'part' | 'body';
  parent: string | null;
  children: string[];
  documentId?: string;
  hidden: boolean;
  /** Drawn faint so what's behind and inside it shows (a view setting, like `hidden`; never saved in the design). */
  seeThrough?: boolean;
  expanded: boolean;
  color?: string;
}

export type JobPhase = 'idle' | 'saving' | 'opening' | 'queued' | 'running' | 'loading' | 'succeeded' | 'failed';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
  /** A second, lesser button next to the action (it doesn't dismiss the toast). */
  link?: { label: string; run: () => void };
  sticky?: boolean;
  /** What "Report this" opens the bug report with, when the title and detail alone wouldn't say what went wrong. */
  report?: string;
}

/** A failed build, for a bug report: the error's last line (the exception), never the source. */
export function buildFailureReport(error: string) {
  const line = error.trim().split('\n').pop()?.trim() ?? '';
  return `Generating the model failed: ${line.length > 300 ? `${line.slice(0, 297).trimEnd()}…` : line}`;
}

export type DialogId = 'blender-renders' | 'help' | 'open' | 'unsaved' | 'insert' | 'new' | 'import' | 'palette' | 'shortcuts' | 'material' | 'tools' | 'branch' | 'merge' | 'conflict' | 'sheetRules' | 'sheetForms' | 'standardParts' | 'mcmaster' | 'settings' | 'bug' | 'reports' | 'share' | 'runAction' | 'carbon' | 'rmfg' | 'video' | null;

export interface DocState {
  open: boolean;
  /** Branch being edited; 'main' is the document itself. */
  branch: string;
  saved: CadDocument | null;
  name: string;
  kind: Kind;
  /** The file being edited (a design's active file; the whole source otherwise). */
  code: string;
  /** Designs: every file (the active one may lag `code`; see state/design.ts). */
  files: Record<string, string>;
  activeFile: string;
  /** Designs: linked designs and parts, pinned. */
  links: Record<string, LinkRef>;
  savedSnapshot: string | null;
}

/** `offset` is 0..1 across the model's bounds (the slider and the draggable plane). A saved section view shown from the
 *  tree (`section_view(...)` in the code) is fixed instead: `saved` is its name and `at` its position in model mm. */
export interface SectionState { enabled: boolean; axis: Axis; offset: number; flip: boolean; saved?: string | null; at?: number | null }
export interface PlaneDraft { mode: 'offset' | 'midplane' | 'points'; reference: 'XY' | 'XZ' | 'YZ' | 'face' | 'existing'; offset: number; flip: boolean; editing?: { name: string; origin: number[]; normal: number[]; xDir: number[] } }

export type PatchType = 'patch' | 'wall' | 'symmetry' | 'symmetryPlane' | 'empty' | 'wedge';
export interface StudyLoad { id: string; type: 'fixed' | 'pin' | 'force' | 'pressure' | 'moment' | 'gravity' | 'temperature' | 'heat_flux' | 'convection' | 'velocity_inlet' | 'pressure_inlet' | 'pressure_outlet' | 'no_slip' | 'slip'
  | 'stagnation_inlet' | 'mass_flow_inlet' | 'ambient_outlet' | 'symmetry' | 'named'; picks: Pick[]; refs?: string[]; axes?: number[]; ambientTemperature?: number;
  /** A model-written case's named face group (its id is the name): the OpenFOAM patch type it becomes. */
  patchType?: PatchType;
  /** Compressible flow: an inlet's total temperature, or an ambient outlet's backflow temperature (K). */
  gasTemperature?: number; magnitude?: number; direction?: [number, number, number] }
export interface Study {
  id: string; name: string; type: 'static' | 'modal' | 'thermal' | 'thermal_stress' | 'buckling' | 'flow' | 'cht' | 'compressible' | 'openfoam_case' | 'calculix_deck'; loads: StudyLoad[]; meshSize: number;
  revision?: number; branch?: string; source?: string;
  definition?: import('@/workspaces/simulate/api').Definition;
}
export interface CamSetup { id: string; name: string; process: 'milling' | 'turning' | 'additive'; stockOffset: [number, number, number]; stockTop: number; origin: 'stock-top-center' | 'stock-top-corner' | 'model-origin'; toolIds: string[] }
export interface CamTool { id: string; name: string; kind: 'flat' | 'ball' | 'bull' | 'drill' | 'chamfer' | 'face'; diameter: number; flutes: number; fluteLength: number; cornerRadius?: number }

const initialDoc: DocState = { open: false, branch: 'main', saved: null, name: 'Untitled', kind: 'part', code: '', files: {}, activeFile: 'main.py', links: {}, savedSnapshot: null };

export interface PastVersion { key: string; branch: string; revision: number; commit: string | null; message: string; recordedAt: string; returnBuildId: string | null }

export type ViewportBackground = 'theme' | 'light' | 'dark';

/** The theme the 3D view draws in: the app's, unless Settings → Display picks a light grey or dark backdrop. */
export const viewportTheme = (state: { theme: Theme; viewportBackground: ViewportBackground }): Theme =>
  state.viewportBackground === 'theme' ? state.theme : state.viewportBackground;

export interface AppState {
  theme: Theme;
  workspace: Workspace;
  /** The workspaces this deployment offers (GET /v1/auth/config; STEVE_DISABLED_WORKSPACES hides unfinished ones). */
  workspaces: Workspace[];
  /** Why each workspace this deployment doesn't offer is off (e.g. "Electronics isn't installed on this server."). */
  unavailable: Partial<Record<Workspace, string>>;
  /** Whether this server builds Blender documents (GET /v1/auth/config blender_installed): New offers them only then. */
  blenderInstalled: boolean;
  /** The Design workspace's ribbon tab: solid modeling, sheet metal, surfaces, motion or the drawing. */
  designTab: DesignTab;
  /** The sheet-metal flat pattern shown over the canvas. */
  flatView: boolean;
  /** Electronics: the view on screen (mirrors workspaces/electronics/state, so the ribbon follows it). */
  circuitView: 'schematic' | 'pcb' | '3d' | 'split';
  /** Electronics: the schematic canvas tool (mirrors workspaces/electronics/schematicEdits). */
  circuitTool: 'select' | 'wire' | 'place';
  /** The link picker opens on this kind of document (Insert circuit board: circuits), else everything linkable. */
  linkFilter: 'circuit' | null;
  /** The link picker opens in this folder (File → Libraries: the library's id), else All documents. */
  linkFolder: string | null;
  browserOpen: boolean;
  browserWidth: number;
  dockOpen: boolean;
  dockWidth: number;
  /** The app fills the screen (Fullscreen API); follows the browser when Esc or F11 leaves it. */
  fullscreen: boolean;
  dockTab: DockTab;
  resizing: boolean;
  leftTab: 'model' | 'versions' | `panel:${string}`;
  tabs: DocTab[];
  activeTab: string | null;
  /** The active tab's name is being edited. */
  renaming: boolean;

  doc: DocState;
  displayed: Build | null;
  modelVersion: number;
  tree: Record<string, TreeNode>;
  rootId: string | null;

  busy: boolean;
  /** The build the status bar follows now (actions.ts watchBuild), which Stop build stops; null when none. */
  buildInFlight: string | null;
  /** Generate automatically after changes (the Source pane's Live switch; on unless turned off). */
  liveBuild: boolean;
  phase: JobPhase;
  phaseLabel: string;
  phaseStarted: number | null;
  logs: string;
  error: string;
  /** The last update used its whole time or memory budget (docs/WORK_BUDGETS.md): it isn't rebuilt by itself. */
  budgetFailure: BuildFailure | null;
  runtimeInfo: string;

  selection: Pick[];
  hover: Pick | null;
  /** More picks lit with `hover`: a tree row that stands for several instances (a component placed twice). */
  hoverAlso: Pick[];
  filter: SelectionFilter;
  tool: Tool;

  style: DisplayStyle;
  projection: Projection;
  showGrid: boolean;
  showOrigin: boolean;
  showShadows: boolean;
  /** Collision and fit overlays (motion/ClashLayer.tsx) shown: display only, never changes a check or its verdict. */
  showCollisions: boolean;
  /** The viewport's backdrop (Settings → Display): 'theme' follows the app's theme, or always light grey or dark. */
  viewportBackground: ViewportBackground;
  view: StandardView | null;
  section: SectionState;
  explode: number;
  planeDraft: PlaneDraft;
  hiddenPlanes: string[];
  /** Bodies of a multi-body part hidden in the view (modeling body ids). */
  hiddenBodies: string[];
  /** Sketches shown or hidden on purpose; others show until a feature uses them. */
  sketchVisibility: Record<string, boolean>;
  /** What each item of a browser group was before its heading's eye hid them all (a sketch: its explicit choice, or null). */
  groupRestore: Partial<Record<'bodies' | 'sketches' | 'planes', Record<string, boolean | null>>>;

  features: FeatureFetch | null;
  branches: Branch[] | null;
  graph: VersionGraph | null;
  mergeBranch: string | null;
  branchFrom: number | null;
  /** A past revision shown read-only in the viewport; the open design is unchanged. */
  pastVersion: PastVersion | null;
  /** The timeline's history marker: builds suppress every feature after `after` (`code` is that for `source`). Null: at the end. */
  rollback: { after: string | null; source: string; code: string; empty?: boolean } | null;
  /** The open code parsed as a modeling document (features, sketches, parameters). */
  modeling: ModelDoc | null;
  /** Mirror of the sketch editor for the ribbon: null when not sketching. */
  sketching: { tool: string; choosing: boolean; selection: number; undo: boolean; redo: boolean } | null;
  activeFeature: string | null;
  parameterFocus: string | null;
  sourceReveal: { from: number; to: number; nonce: number } | null;

  materials: Record<string, string>;
  studies: Study[];
  activeStudy: string | null;
  /** Simulate shows every study's latest result on the whole model at once (clicking Studies), not just the active one. */
  studyOverview: boolean;
  setups: CamSetup[];
  activeSetup: string | null;
  camTools: CamTool[];

  measurePicks: Pick[];
  /** `onModel`: opened on the 3D view at x, y (not the tree or the phone's bar), so "Select other…" can list what's there. */
  contextMenu: { x: number; y: number; pick: Pick | null; onModel?: boolean } | null;
  /** Select other (deep selection): everything under a point of the 3D view, front to back, to choose one from.
   * `additive`: the choice adds to the selection (Shift/Ctrl held when it was opened). */
  pickList: { x: number; y: number; picks: Pick[]; additive: boolean } | null;

  toasts: Toast[];
  dialog: DialogId;
  pendingLeave: (() => void) | null;
  paletteQuery: string;
  /** The connector action the Run an action dialog opens on (the quick button's "Run: …" items); null: the first. */
  runActionId: string | null;
  /** What Order from RMFG opens on: null, the open document's order; 'orders', every open order (the top bar's RMFG
   *  button); otherwise that order's id. */
  rmfgOrder: string | null;
}

export const useApp = create<AppState>()(subscribeWithSelector((): AppState => ({
  theme: 'dark',
  workspace: 'design',
  workspaces: ['design', 'simulate', 'manufacture', 'electronics'],
  blenderInstalled: false,
  unavailable: {},
  designTab: (() => { try { const tab = localStorage.getItem('steve-design-tab'); return tab === 'sheet' || tab === 'surface' || tab === 'motion' ? tab : 'solid'; } catch { return 'solid'; } })(),
  flatView: false,
  circuitView: 'split',
  circuitTool: 'select',
  linkFilter: null,
  linkFolder: null,
  browserOpen: true,
  browserWidth: 264,
  dockOpen: true,
  dockWidth: 384,
  fullscreen: false,
  dockTab: 'properties',
  resizing: false,
  leftTab: 'model',
  tabs: [],
  activeTab: null,
  renaming: false,

  doc: initialDoc,
  displayed: null,
  modelVersion: 0,
  tree: {},
  rootId: null,

  busy: false,
  buildInFlight: null,
  liveBuild: true,  // Settings → Code editor (settings/install.ts).
  phase: 'idle',
  phaseLabel: '',
  phaseStarted: null,
  logs: '',
  error: '',
  budgetFailure: null,
  runtimeInfo: '',

  selection: [],
  hover: null,
  hoverAlso: [],
  filter: 'auto',
  tool: 'select',

  style: 'shaded-edges' as DisplayStyle,
  projection: 'orthographic' as Projection,
  showGrid: true,
  showOrigin: false,
  showShadows: true,
  showCollisions: true,
  viewportBackground: 'theme',
  view: 'iso',
  section: { enabled: false, axis: 'z', offset: 0.5, flip: false },
  explode: 0,
  planeDraft: { mode: 'offset', reference: 'XY', offset: 10, flip: false },
  hiddenPlanes: [],
  hiddenBodies: [],
  sketchVisibility: {},
  groupRestore: {},

  features: null,
  branches: null,
  graph: null,
  mergeBranch: null,
  branchFrom: null,
  pastVersion: null,
  rollback: null,
  modeling: null,
  sketching: null,
  activeFeature: null,
  parameterFocus: null,
  sourceReveal: null,

  materials: {},
  studies: [],
  activeStudy: null,
  studyOverview: false,
  setups: [],
  activeSetup: null,
  camTools: [],

  measurePicks: [],
  contextMenu: null,
  pickList: null,

  toasts: [],
  dialog: null,
  pendingLeave: null,
  paletteQuery: '',
  runActionId: null,
  rmfgOrder: null,
})));

export const get = useApp.getState;
export const set = useApp.setState;
export const initialDocState = initialDoc;

let toastId = 0;
const heldToasts = new Set<number>();
/** A hovered toast waits, so its text can be read, selected and copied. */
export const holdToast = (id: number, held: boolean) => { if (held) heldToasts.add(id); else heldToasts.delete(id); };
const dismissLater = (id: number, ms: number) => setTimeout(() => (heldToasts.has(id) ? dismissLater(id, 1500) : dismissToast(id)), ms);
export function toast(tone: Toast['tone'], title: string, detail?: string, extra: Partial<Toast> = {}) {
  const id = ++toastId;
  if (tone === 'danger' || tone === 'warning') recordRecent(`${tone}: ${title}${detail ? ` — ${detail}` : ''}`);  // For bug reports.
  set((state) => ({ toasts: [...state.toasts.slice(-3), { id, tone, title, detail, ...extra }] }));
  // Errors stay until dismissed: people copy them.
  if (!extra.sticky && tone !== 'danger') dismissLater(id, tone === 'success' ? 2800 : 4200);
  return id;
}
export const dismissToast = (id: number) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));

export function patchDoc(patch: Partial<DocState>) { set((state) => ({ doc: { ...state.doc, ...patch } })); }

const sortedFiles = (files: Record<string, string>) => JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));

let snapshotCache: { doc: DocState; preview: string | null; value: string } | null = null;

/** Serialized save state; cached because dirty checks run on every store update. */
export function snapshot(state: AppState = get()) {
  const { doc, displayed } = state;
  // A past revision on screen is only being looked at; the design keeps its own preview.
  const preview = state.pastVersion ? state.pastVersion.returnBuildId : displayed?.id ?? null;
  if (snapshotCache && snapshotCache.doc === doc && snapshotCache.preview === preview) return snapshotCache.value;
  const source = stored(doc);
  const value = JSON.stringify({ name: doc.name.trim() || 'Untitled', kind: doc.kind, code: source.code, files: sortedFiles(source.files), links: JSON.stringify(Object.entries(source.links).sort()), preview });
  snapshotCache = { doc, preview, value };
  return value;
}

export const isDirty = (state: AppState = get()) => state.doc.open && state.doc.savedSnapshot !== snapshot(state);

/** A snapshot without the model shown: a model generated since opening isn't an edit to lose. */
const withoutPreview = (value: string | null | undefined) => {
  try { const { preview: _preview, ...rest } = JSON.parse(value ?? 'null') ?? {}; return JSON.stringify(rest); } catch { return value ?? ''; }
};

/** Unsaved changes to the source (code, files, links, name), not just a model rebuilt from it. */
export const hasSourceEdits = (state: AppState = get()) => isDirty(state) && withoutPreview(snapshot(state)) !== withoutPreview(state.doc.savedSnapshot);

/** Edits that closing would lose: a saved design's changes, or anything typed into a new one. */
export const hasUnsavedWork = (state: AppState = get()) => isDirty(state)
  && (!!state.doc.saved || !!state.doc.code.trim() || Object.keys(state.doc.links).length > 0);

/** The open document as builds see it: rolled back to the timeline's marker when it is. */
export function rolledDoc(state: AppState = get()): AppState['doc'] {
  const rollback = state.rollback;
  return rollback && state.doc.kind === 'part' && rollback.source === state.doc.code ? { ...state.doc, code: rollback.code } : state.doc;
}

/** A line that builds something: not blank, a comment, an import, or the starter's `model = Model()` / `shop = Shop()` /
 *  `result = …result()`. */
const BOILERPLATE = /^(#|import\s|from\s+\S+\s+import\s|(model|design|component|shop)\s*=\s*(Model|Design|Component|Shop)\(|result\s*=\s*(model|design|component)\.result\(\)$)/;
const builds = (code: string) => code.split('\n').some((line) => line.trim() && !BOILERPLATE.test(line.trim()));

/** Why the open document can't be changed or built here, or null: a viewer in a team's workspace looks and comments
 * (the server refuses their changes, app/teams.py); a saved circuit on a server without Electronics opens read-only
 * (the server refuses its saves and new builds; finished builds are still shown). */
export function readOnlyReason(state: AppState = get()): string | null {
  const team = useWorkspace.getState().team;
  if (team?.role === 'viewer') return `You’re a viewer in ${team.name}: you can look and comment. A team admin can make you a member.`;
  // A saved Blender document on a server without the Blender lane (compose.blender.yaml): likewise read-only.
  if (state.doc.kind === 'blender' && !state.blenderInstalled) return 'Blender isn’t installed on this server: Blender documents open here but can’t be changed or built.';
  if (state.doc.kind !== 'circuit' || state.workspaces.includes('electronics')) return null;
  return state.unavailable.electronics ?? 'Electronics isn’t available on this server.';
}

/** The title of the note readOnlyReason explains: a team viewer's, or a circuit's on a server without Electronics. */
export function readOnlyTitle(building = false): string {
  if (useWorkspace.getState().team?.role === 'viewer') return 'You’re a viewer in this team';
  const what = get().doc.kind === 'blender' ? 'This Blender scene' : 'This circuit';
  return building ? `${what} can’t be built here` : `${what} is read-only here`;
}

/** Whether the open document has anything to generate: a new part or design's starter code doesn't. */
export function hasContent(state: AppState = get()) {
  const { doc } = state;
  // A circuit has something to build once it has any element (a board, a part): `<board …>`.
  if (doc.kind === 'circuit') return /<[a-z]/.test(doc.code);
  const sources = hasFiles(doc.kind) ? [doc.code, ...Object.entries(doc.files).filter(([path]) => path !== doc.activeFile).map(([, code]) => code)] : [doc.code];
  return sources.some(builds);
}

/** Whether the 3D model shown isn't of the open document's model. A change to its drawing sheets alone doesn't count:
 *  the Drawing tab redraws them without rebuilding the model (design.ts modelBuiltFrom). */
export function isPreviewStale(state: AppState = get()) {
  const { doc, displayed } = state;
  if (!doc.open || state.pastVersion || state.rollback?.empty) return false;
  if (!displayed) return hasContent(state);
  return !modelBuiltFrom(displayed, rolledDoc(state)) || doc.kind !== displayed.kind;
}

export function isNodeVisible(tree: Record<string, TreeNode>, id: string): boolean {
  for (let node: TreeNode | undefined = tree[id]; node; node = node.parent ? tree[node.parent] : undefined) if (node.hidden) return false;
  return true;
}

/** Drawn see-through: the node or a component it belongs to was made see-through. */
export function isNodeSeeThrough(tree: Record<string, TreeNode>, id: string): boolean {
  for (let node: TreeNode | undefined = tree[id]; node; node = node.parent ? tree[node.parent] : undefined) if (node.seeThrough) return true;
  return false;
}

export function nodeContains(tree: Record<string, TreeNode>, ancestor: string, id: string): boolean {
  for (let node: TreeNode | undefined = tree[id]; node; node = node.parent ? tree[node.parent] : undefined) if (node.id === ancestor) return true;
  return false;
}

/** High-frequency cursor readout, kept out of the main store to avoid re-rendering panels. */
export const useCursor = create<{ point: [number, number, number] | null; pivot: [number, number, number] | null; screen: [number, number] | null }>(() => ({ point: null, pivot: null, screen: null }));

export const samePick = (a: Pick | null, b: Pick | null) => (a && b ? pickKey(a) === pickKey(b) : a === b);

/** Hover highlight for one pick or several (all instances of a component); null or [] clears it. */
export function setHover(picks: Pick | Pick[] | null) {
  const list = !picks ? [] : Array.isArray(picks) ? picks : [picks];
  const state = get();
  if (samePick(state.hover, list[0] ?? null) && state.hoverAlso.length === Math.max(0, list.length - 1)
    && state.hoverAlso.every((pick, index) => samePick(pick, list[index + 1]))) return;
  set({ hover: list[0] ?? null, hoverAlso: list.slice(1) });
}

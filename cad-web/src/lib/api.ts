import { recordFailedRequest } from './recentErrors';
import { bearer } from '@/auth/auth';
import { workspaceHeaders } from '@/teams/current';
import type { Waiting } from './waiting';
import type { BuildProgress } from './buildProgress';
import type { BalloonPlacement, DimensionPlacement } from '@/drawing/code';

export type Kind = 'part' | 'design' | 'circuit' | 'shop' | 'cam' | 'blender';
/** CAD documents (CadQuery): parts and designs. Circuits are tscircuit TSX (docs/ELECTRONICS.md); shops are a
 *  workspace's machines and tools as Python, building library records, not geometry; CAM programs are a part machined
 *  in a shop, as Python (runtime/steve/cam.py), building the program that runs; Blender documents are Blender Python
 *  (bpy) building a mesh scene in headless Blender (blender/blender_run.py). */
export const isCad = (kind: Kind | null | undefined): kind is 'part' | 'design' => kind === 'part' || kind === 'design';
/** A linked document at a pinned revision; `component` links one component of a design (components/<component>.py). */
export interface LinkRef { document_id: string; revision: number | null; component?: string | null }
/** One document of a product (GET /v1/documents/{id}/package): its source at a pinned revision, to build. */
export interface PackageDocument {
  document_id: string | null; revision: number | null; kind: Kind; name: string;
  code: string; files: Record<string, string>; links: Record<string, LinkRef>;
}
export type BuildStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type Vec3 = [number, number, number];

export interface BuildMetadata {
  /** A running build's only metadata: what it is doing now (buildProgress), until its result replaces it. */
  progress?: BuildProgress | null;
  cadquery_version: string;
  /** The repository and commit the running CadQuery (STEVE's fork) was installed from; absent on older builds. */
  cadquery_source?: { url: string; commit: string } | null;
  /** cadquery-ocp's version, and the OCCT release it wraps; absent on older builds. */
  ocp_version?: string | null;
  occt_version?: string | null;
  /** Nothing modelled yet (no bodies; at most sketches or empty components): a normal result with an empty preview. */
  empty?: boolean;
  units: 'mm';
  components: number;
  solids: number;
  faces: number;
  bounds_mm: Vec3;
  volume_mm3: number;
  surface_area_mm2?: number;
  /** None when the result has only surface bodies (nothing to weigh). */
  center_of_mass_mm?: Vec3 | null;
  /** Surface bodies (model.fill, boundary_surface): left out of the volume, area and centre of mass, with the note why. */
  surface_bodies?: { count: number; area_mm2: number; bodies: { instance: string; body: string; area_mm2: number }[]; note: string };
  /** A design's instances of components that aren't hardware (Component(..., hardware=False): a fluid volume): not in the volume, area or centre of mass. */
  not_hardware?: { count: number; instances: string[]; note: string };
  component_documents?: Record<string, string>;
  /** Full design builds: one STEP per component, linked document or (plain cq.Assembly) top-level instance. */
  component_steps?: ComponentStep[];
  /** Full builds: a print-grade STL per body, as modelled (GET /v1/builds/{id}/body-mesh/{index}). */
  body_meshes?: BodyMesh[];
  /** The same at the 3MF/STL export's coarser resolutions, once asked for (GET …/body-mesh/{index}?resolution=…). */
  body_meshes_medium?: BodyMesh[];
  body_meshes_coarse?: BodyMesh[];
  /** Full builds of code that declares drawing sheets (steve.drawing): what they hold, or why they couldn't be made. */
  drawings?: { version: 1; status: 'ready' | 'invalid'; sheets: DrawingSheet[]; error?: string; pdf?: boolean; pdf_error?: string };
  runtime_image?: string;
  /** Blender documents (blender/blender_run.py): renderable objects and triangles; volume_mm3 and center_of_mass_mm are
   *  null when no mesh is closed; warnings say what the measurements leave out. */
  objects?: number;
  triangles?: number;
  warnings?: string[];
  /** A Blender full build's video of its scene's animation, through its camera (blender/blender_run.py render_animation). */
  animation?: { frames: number; fps: number; seconds: number; size: [number, number] };
}

export interface DrawingSheet {
  name: string; title: string; standard: 'ISO' | 'ANSI'; projection: 'first' | 'third'; sheet: string; scale: string; views: string[];
  /** The sheet's size (mm), and how many rows its parts list, cut list and revision table have. */
  size_mm: [number, number]; parts_list: number; cut_list: number; revisions: number;
  /** Each `Drawing(...)` argument as it evaluated (plain data; references as their names), and those with no plain
   *  value: the Drawing tab writes one written as an expression over with its value when it's edited. */
  args?: Record<string, unknown>; args_unreadable?: string[];
  /** The views don't fit the sheet at the scale the code chose. */
  overflow?: string;
  /** Feature dimensions drawn per orthographic view, when the sheet declares any. */
  feature_dimensions?: Record<string, number>;
  /** Where each drawn feature dimension went on the sheet, for dragging it (drawing/code.ts). */
  placed?: DimensionPlacement[];
  /** Feature dimensions whose geometry is gone from the model (never moved onto other geometry). */
  dangling?: DrawingDimensionIssue[];
  /** Feature dimensions that can't be measured as written (a foreshortened view, the wrong kind of geometry). */
  dimension_problems?: DrawingDimensionIssue[];
  /** Feature dimensions whose text replaces the measured value. */
  overridden?: { dimension: number; view: string; text: string; measured: string }[];
  /** Feature dimensions with an ISO 286 fit: the nominal size it was looked up at and its limit deviations (mm). */
  fits?: { dimension: number; class: string; nominal_mm: number; upper_mm: number; lower_mm: number }[];
  /** GD&T datum feature symbols and feature control frames drawn per orthographic view, when the sheet declares any. */
  datums?: Record<string, number>;
  tolerance_frames?: Record<string, number>;
  /** Weld symbols (AWS A2.4, ISO 2553) drawn per view, when the sheet declares any. */
  welds?: Record<string, number>;
  /** Where each weld symbol drawn went, for dragging it (drawing/code.ts). */
  welds_placed?: WeldPlacement[];
  /** Where each leader note drawn went, for dragging it (drawing/code.ts). */
  notes_placed?: NotePlacement[];
  /** Frames that are drawn but refer to a datum the sheet doesn't show. */
  annotation_notes?: DrawingDimensionIssue[];
  /** Each view drawn: base, section or detail, its parent, scale and box on the sheet (the SVG's frame: mm, y down). */
  views_placed?: PlacedView[];
  /** The title block and each table on the sheet (a hole table's number too), with its box in the same frame. */
  regions?: { kind: 'title-block' | 'revisions' | 'notes' | 'parts-list' | 'cut-list' | 'hole-table'; index?: number; box: [number, number, number, number] }[];
  /** A component's sheet (in a design): its views are in that component's own axes, not the design's. */
  component?: string;
  /** The sheet-metal bodies this sheet draws, as a flat view names them: what its Flat pattern view can show. */
  sheet_metal_bodies?: string[];
  /** Section and detail views whose cutting plane or centre is gone from the model (never moved), and what hangs off them. */
  dangling_views?: DrawingViewIssue[];
  /** Section and detail views that can't be drawn as written (a cutting plane that misses the part). */
  view_problems?: DrawingViewIssue[];
  /** Item balloons drawn per view, when the sheet has any; each one's instance, item number (its parts list row) and side. */
  balloons?: Record<string, number>;
  balloons_placed?: BalloonPlacement[];
  /** Balloons that can't be drawn as written (no parts list, an instance that isn't listed or doesn't show). */
  balloon_problems?: DrawingDimensionIssue[];
  /** Hole tables drawn: their view and their holes' tags. */
  hole_tables?: { index: number; view: string; holes: number; tags: string[] }[];
  /** Holes (or whole tables) that can't be tabulated as written (not round in that view, not a hole). */
  hole_problems?: DrawingDimensionIssue[];
}

/**
 * How a drawn view maps the model onto its sheet (runtime `_projection_report`), for picking its geometry there: paper
 * x, paper y and towards the viewer as model directions; the model point on the paper plane drawn at a sheet point (the
 * SVG's frame: mm, y down); sheet mm per model mm. A section shows what's at most `cut` towards the viewer; a detail
 * only what's inside its circle on the sheet (x, y, radius).
 */
export interface ViewProjection {
  x: Vec3; y: Vec3; towards: Vec3; model: [number, number]; sheet: [number, number]; scale: number;
  cut?: number; clip?: [number, number, number];
}

/**
 * A view as drawn on a sheet. `map` takes model points to the sheet: a model point p is at
 * (origin[0] + scale·(p·x), origin[1] − scale·(p·y)) in the SVG's frame (mm, y down). `at` is the view's offset as written.
 */
export interface PlacedView {
  view: string; kind: 'base' | 'section' | 'detail'; parent?: string; scale: string; box: [number, number, number, number];
  map?: { origin: [number, number]; scale: number; x: [number, number, number]; y: [number, number, number] };
  at?: [number, number];
  /** Its centre as `position` takes it (paper mm from the sheet's lower-left corner, y up); fixed: written so. */
  position?: [number, number]; fixed?: boolean;
  projection?: ViewProjection;
  /** The flat view: the sheet-metal body whose flat pattern it shows, and how many bends it notes. */
  body?: string; bends?: number;
}

/** A weld symbol as drawn (numbered from 1 as written in `welds`): its first arrow's tip and where its reference line
 *  starts, in the SVG's frame (mm, y down). */
export interface WeldPlacement { weld: number; view: string; tip: [number, number]; junction: [number, number] }

/** A leader note as drawn (numbered from 1 as written in `notes`): its leader's tip and knee (where its shoulder
 *  starts), in the SVG's frame (mm, y down). */
export interface NotePlacement { note: number; view: string; tip: [number, number]; knee: [number, number] }

/** A section or detail view that isn't drawn, and why. */
/** A section or detail view, or the flat view (its body's flat pattern; no parent), that isn't drawn, and why. */
export interface DrawingViewIssue { view: string; kind: 'section' | 'detail' | 'flat'; parent: string | null; refs: string[]; problem: string }

/**
 * A feature dimension (numbered from 1 as written) that isn't drawn, and why. Datums', tolerance frames', balloons' and
 * hole tables' entries carry `annotation` and their own `index` (from 1; null for balloons=True's) instead of
 * `dimension`; a balloon's its `instance` (or its parts list `item`); a weld's that names its joint, its `joint` (and the
 * contact `place`, from 0) or `bead`.
 */
export interface DrawingDimensionIssue {
  dimension?: number; annotation?: 'datum' | 'frame' | 'balloon' | 'hole' | 'weld' | 'note'; index?: number | null; label?: string; on_dimension?: string;
  instance?: string; item?: number; joint?: string[]; bead?: string; place?: number;
  view: string | null; refs: string[]; problem: string;
}

/** One manufacturing library record a shop build made, and the source line that made it. */
export interface ShopRecord { key: string; kind: string; definition: Record<string, unknown>; file: string; line: number }
/** A shop build's metadata: the library records it would save (none are saved until applied). */
export interface ShopMetadata { kind: 'shop'; records: ShopRecord[]; counts: Record<string, number>; timings_ms?: Record<string, number> }
/** A build's shop metadata, when it is a shop build. */
export const shopMetadata = (build: Pick<Build, 'kind' | 'metadata'> | null | undefined): ShopMetadata | null => {
  const metadata = build?.metadata as unknown as Partial<ShopMetadata> | null | undefined;
  return build?.kind === 'shop' && metadata && Array.isArray(metadata.records) ? metadata as ShopMetadata : null;
};
/** What applying a shop build to the library did, item by item (POST /v1/documents/{id}/shop/apply). */
export interface ShopApplyItem { key: string; kind: string; name: string; library_id: string; revision: number; change: 'created' | 'revised' | 'unchanged' }
export interface ShopApplyResult { items: ShopApplyItem[]; counts: { created: number; revised: number; unchanged: number } }

/** A CAM program's build: its program as data, shop items {"$shop": key, "kind": kind}, targets by link (runtime/run.py). */
export interface CamMetadata { kind: 'cam'; program: Record<string, unknown> }
export const camMetadata = (build: Pick<Build, 'kind' | 'metadata'> | null | undefined): CamMetadata | null => {
  const metadata = build?.metadata as unknown as Partial<CamMetadata> | null | undefined;
  return build?.kind === 'cam' && metadata && metadata.program && typeof metadata.program === 'object' ? metadata as CamMetadata : null;
};
/** A failure of a CAM run step: what went wrong, why, and what to do (app/manufacturing/mcp_tools.py _run_summary). */
export interface CamFailure { code: string; message: string; why?: string; next_step?: string; field?: string; operation?: string; setup?: string; retryable?: boolean }
/** A program posted at six decimals for a controller that rounds finer words: how far the path the machine runs can lie
 * from the checked one (app/manufacturing/posted_resolution.py). Absent when the control runs the words as written. */
export interface PostedResolution {
  setup: string; controller: string; posted_decimals: number; linear_resolution_mm: number; rounded_words: number; max_deviation_mm: number;
  rounded_spindle_words?: number; rounded_feed_words?: number; states_six_decimals?: boolean; message: string; next_step: string;
}
/** Where running a CAM program got to (POST /v1/documents/{id}/cam/run, app/manufacturing/cam_documents.py step). */
export interface CamRunState {
  stage: 'reviewing' | 'running' | 'posting' | 'verified' | 'checked' | 'failed';
  done: boolean;
  /** While Steve compares the changed design's selections (stage reviewing): its review job. */
  review?: { job_id: string; status: string; progress?: number };
  program: { id: string; revision: number; operations: string[] };
  run?: { id: string; program_id: string; revision: number; status: string; error: CamFailure | null;
    operations: { operation: string; status: string; job_id: string | null; error: CamFailure | null }[] };
  /** The post (one setup: its job; several setups: their overall status, each in `posts`). */
  post?: { job_id?: string; status: string; error?: CamFailure | null; setups?: number };
  /** One post per setup, in the program's setup order (one machine file each). */
  posts?: CamPost[];
  verification?: CamVerification;
  /** Every machine file; with several setups each names its setup. */
  gcode?: { name: string; bytes: number; sha256: string; setup?: string }[];
  posted_resolution?: PostedResolution;
  error?: (CamFailure & { setup?: string }) | null;
}
/** Steve's check of posted G-code; with several setups each check that didn't pass names its setup. */
export interface CamVerification {
  download_status: string; software_verified: boolean; checks: Record<'passed' | 'failed' | 'uncertain' | 'unassessed', number>;
  not_passed: { id: string; status: string; message: string; operation?: string; setup?: string; hint?: string;
    /** A fixture check that didn't pass: each fixture it reached, the body it is, the G-code lines and where. */
    contacts?: { status: string; fixture: string; link?: string; body?: string; lines: number[]; moves: number; contact_mm?: number[]; frame?: 'work' | 'machine' }[] }[];
}
/** A setup's post of a CAM document's run: its own job, check, files and controller rounding. */
export interface CamPost {
  setup: string | null; job_id: string; status: string; error?: CamFailure | null;
  verification?: CamVerification; gcode?: { name: string; bytes: number; sha256: string }[]; posted_resolution?: PostedResolution;
}
/** A circuit build's metadata (docs/ELECTRONICS.md, electronics kernel). */
export interface CircuitMetadata {
  kind: 'circuit';
  tscircuit_version: string;
  empty?: boolean;
  board?: { width_mm: number | null; height_mm: number | null; layers: number | null; thickness_mm?: number | null; center?: { x: number; y: number } | null } | null;
  counts?: { components?: number; nets?: number; traces?: number; routed?: number; unrouted?: number; errors?: number; warnings?: number };
  timings_ms?: Record<string, number>;
  components?: CircuitComponentFacts[];
  nets?: { name: string; ports: string[] }[];
  diagnostics?: CircuitDiagnostic[];
  /** How the board's connections got copper (docs/ELECTRONICS.md, "Routing"); see workspaces/electronics/routing.ts. */
  routing?: CircuitRouting | null;
}
/** A circuit build's routing report: builds don't autoroute; a routing build (`route: true`) does, within a budget. */
export interface CircuitRouting {
  requested?: boolean;
  status?: 'routed' | 'not_routed' | 'incomplete' | 'failed' | 'none' | 'routing';
  phases?: number; from_cache?: number; routed?: number; not_routed?: number;
  connections?: number; connections_routed?: number;
  routing_s?: number; budget_s?: number; used_s?: number;
  stopped?: unknown[]; retryable?: boolean; message?: string; next_steps?: string[];
  /** While a routing build runs (status "routing", live true): the phase being routed, its router step and share done
   * (0–1), finished phases, and seconds since the build started. Its result replaces it. */
  live?: boolean; subcircuit?: string | null; step?: string | null; progress?: number | null; phases_done?: number; elapsed_s?: number;
}
export interface CircuitComponentFacts {
  name: string; ftype: string | null; footprint: string | null; value: string | null;
  pcb?: { x: number; y: number; rotation: number; layer: string } | null;
  sch?: { x: number; y: number } | null;
}
/** A circuit problem; `file` only when it isn't main.tsx, `component` when it's about one part. */
export interface CircuitDiagnostic {
  type: string; message: string; severity?: 'error' | 'warning'; source_line?: number | null; component?: string | null; file?: string | null;
  /** The Circuit JSON ids it's about, keyed by what they are (`{source_component_id: "source_component_0"}`). */
  ids?: Record<string, string | string[]> | string[] | null;
}

/** An entry of a full build's bodies-mesh.zip: the body's binary STL in design coordinates (mm). `placement` is the
 *  instance's [R|t] (3 rows of 4) that put it there; `instance` is "part" for a part, else the design instance path.
 *  `mass_properties` are exact, in the design frame, at unit density (mass = volume × density). */
export interface BodyMesh {
  instance: string; body: string; name: string; file: string; triangles: number; /** min x, y, z, max x, y, z */ extent_mm: number[]; placement?: number[][];
  material?: string | null; density_g_cm3?: number | null;
  mass_properties?: { volume_mm3: number; center_of_mass_mm: number[]; /** About the centre of mass, a tensor (products negated). */ inertia_mm5: number[][] };
}

/** An entry of a design build's components-step.zip (GET /v1/builds/{id}/components/{key}). */
export interface ComponentStep { key: string; kind: 'component' | 'link' | 'instance'; id: string; name: string; file: string }

export interface Build {
  id: string;
  name: string;
  kind: Kind;
  status: BuildStatus;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
  logs?: string;
  metadata?: (BuildMetadata & Partial<CircuitMetadata>) | null;
  code?: string;
  files?: Record<string, string>;
  links?: Record<string, LinkRef>;
  artifacts: {
    step?: string | null; preview?: string; topology?: string; sheet_metal?: string; sheet_metal_export?: string; components_step?: string; bodies_mesh?: string;
    /** Full and drawing builds with drawing sheets: the first sheet (SVG, to view and print) and every sheet as SVG and DXF (ZIP). */
    drawing?: string; drawings?: string; drawings_pdf?: string;
    /** Circuits: the Circuit JSON, the schematic and board SVGs, and (full builds) Gerbers, BOM and pick-and-place. */
    circuit?: string; schematic?: string; pcb?: string; fabrication?: string | null;
    /** Blender documents: the scene as a .blend file, and its rendered inspection views (full builds). */
    blend?: string | null; view_isometric?: string | null;
    /** Blender documents: the scene's animation as H.264 video, when its full build rendered one. */
    animation?: string;
  };
  /** preview: fast geometry for the viewer (no STEP, screenshots or captured history); full: everything; drawing: the
   *  drawing sheets alone (the Drawing tab's edits: no model, STEP or meshes). */
  mode?: 'preview' | 'full' | 'drawing' | 'save';
  /** Circuits: a routing build (asked for with `route: true`), and its time budget while it runs, when the server says. */
  route?: boolean;
  route_budget_s?: number | null;
  /** Why a failed build can't succeed by running the same source again: it used its whole time or memory budget. Such
   *  source isn't built again automatically (answered_by: the build that ran out, when this one was answered by it). */
  failure?: BuildFailure | null;
  /** A queued build: why it waits and when it should start (GET /v1/builds/{id} and its event stream). */
  waiting?: Waiting | null;
  /** How often the platform put it back in the queue (a worker replaced in an update, a kernel stopped…), and why the
   *  last time (app/worker.py RESTARTS, worded by lib/restart.ts). */
  restarts?: number;
  restarted_reason?: string | null;
  /** When build retention cleared this old build's files (app/build_retention.py): no artifacts, and each artifact URL
   *  answers 410 build_retired. Its source builds again (a past revision: viewRevision's "Generate it"). */
  retired_at?: string | null;
  /** A succeeded part, design or circuit build's STEP file, made only when something needs it (an export, a download, a
   *  send): ready, being made, failed, or none (a preview, a drawing build, an empty model). Old builds made theirs. */
  step?: StepFileState | null;
}

export type StepFileState = 'ready' | 'making' | 'failed' | 'none';

/** POST/GET /v1/builds/{id}/step: a full build's STEP file, made on demand (app/step_files.py). */
export interface StepStatus {
  state: StepFileState;
  message?: string;
  eta_s?: number | null;
  retry_after?: number | null;
  progress?: BuildProgress | null;
  job?: 'queued' | 'running' | 'succeeded' | 'failed' | 'none';
  /** Why it couldn't be made (state "failed"). */
  error?: string | null;
  url?: string | null;
  components_url?: string | null;
}

/** A running build's partial metadata: what it is doing now, until its result replaces it (app/build_progress.py). */
export const buildProgress = (build: Pick<Build, 'status' | 'metadata'> | null | undefined): BuildProgress | null =>
  build?.status === 'running' ? build.metadata?.progress ?? null : null;

export interface BuildFailure {
  cause: 'time' | 'memory';
  budget_s?: number;
  used_s?: number;
  stage?: string;
  answered_by?: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  kind: Kind;
  preview_build_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  /** Live branches besides main (list responses from servers that report it). */
  branch_count?: number;
  /** Where it's filed (list responses): its folder and that folder's path ("Fixtures/Brackets"); null at the top level. */
  folder_id?: string | null;
  folder_path?: string | null;
}

/** A folder for documents (app/folders.py); the list is flat, parent_id null at the top level. `library`: the person
 *  marked it as a library of their reusable parts (File → Libraries). */
export interface Folder { id: string; name: string; parent_id: string | null; library: boolean; created_at: string }

/** What the file list (GET /v1/files, app/files.py) holds: documents, simulation studies and CAM programs. */
export type FileKind = Kind | 'study' | 'program';
export interface FileSummary extends Omit<DocumentSummary, 'kind' | 'preview_build_id'> {
  kind: FileKind;
  preview_build_id?: string | null;
  /** A study's design, or a CAM program's first design. */
  design?: { id: string; name: string | null } | null;
  /** Every part or design a study or program belongs to (its main one first): the Open dialog lists it under each. */
  design_ids?: string[];
  /** A study's analysis type ("static", "thermal_steady", …) and how many solves it has. */
  analysis?: string | null;
  runs?: number;
  /** A CAM program's designs and its CAM jobs. */
  designs?: number;
  jobs?: number;
}
export const isDocumentKind = (kind: FileKind): kind is Kind => kind === 'part' || kind === 'design' || kind === 'circuit' || kind === 'shop' || kind === 'cam' || kind === 'blender';

export interface CadDocument extends DocumentSummary {
  code: string;
  /** A design's files besides main.py (`code`). */
  files?: Record<string, string>;
  /** A design's linked designs and parts, pinned: {alias: {document_id, revision}}. */
  links?: Record<string, LinkRef>;
  /** Each link's pinned revision against its document's latest. */
  link_status?: Record<string, { revision: number; latest: number | null; name: string | null; kind: Kind | null }>;
}

export interface AssistantModel { id: string; label: string; default: boolean; price_per_million: { input: number; output: number } | null; efforts?: string[] }
export interface AssistantProvider { id: ProviderId; model: string; configured: boolean; models?: AssistantModel[]; models_source?: 'live' | 'env' | 'fallback' }
export interface AssistantSettings { auto_compact: boolean; planning: boolean; subagents: boolean }
export interface AssistantConfig {
  local?: boolean;
  approval_mode?: string;
  providers: AssistantProvider[]; default: string; defaults: AssistantSettings; preferences?: AssistantPreferences; steering?: boolean; stop?: boolean; key_storage?: KeyStorage;
  /** seconds: the default time budget of one message; time_budgets: the budgets Settings offers; time_budget_max: the server's cap. */
  limits?: { seconds?: number; time_budgets?: number[]; time_budget_max?: number | null };
}
/** Where people's own provider keys are kept (docs/PROVIDER_KEYS.md). */
export type KeyStorage = 'ready' | 'sealed' | 'unavailable' | 'not_configured';
/** The providers people can bring their own key for (app/provider_keys.py). */
export const PROVIDER_IDS = ['anthropic', 'openai', 'xai', 'google', 'openrouter'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];
export const isProviderId = (value: string | null | undefined): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value ?? '');
/** One provider's key, as STEVE reports it: never the key itself, only its last four characters. */
export interface ProviderKey {
  provider: ProviderId; name: string; configured: boolean; source: 'account' | 'development' | null; hint: string | null;
  added_at: string | null; updated_at: string | null; validated_at: string | null; last_used_at: string | null;
}
export interface ProviderKeys { storage: KeyStorage; providers: ProviderKey[] }
export type SelfLimitName = 'steve_usd_day' | 'steve_usd_month' | 'steve_tokens_day' | 'steve_tokens_month';
export type SelfLimits = Record<SelfLimitName, number | null>;
export interface QuotaUsage { quota: string; what: string; unit: string; window: string; used: number; limit: number | null; resets_at: string | null }
export interface Quotas { enforced: boolean; quotas: QuotaUsage[]; self: SelfLimits }
/** The person's default model (server-side; shared until there are accounts). The browser also remembers the last one used. */
export interface AssistantPreferences { default_model: { provider: string; model: string } | null }
/** A message sent while STEVE works: delivered at its next step, or started as the next run. */
export interface QueuedMessage { id: string; message: string; attachments: AttachmentMeta[]; provider: string | null; model: string | null; created_at: string }
/** An image shown to STEVE. Only its ID travels with messages; the server keeps the bytes. */
export interface AttachmentMeta { id: string; name: string; media_type: string; width: number; height: number }
export interface Attachment extends AttachmentMeta { size: number; url: string; thumbnail_url: string }
export const attachmentUrl = (id: string, thumbnail = false) => `/v1/assistant/attachments/${id}${thumbnail ? '/thumbnail' : ''}`;

/** Tokens a STEVE run used; cost_usd when the model is in the price data (decimal string). */
export interface TurnUsage { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; requests: number; tool_calls: number; cost_usd: string | null; effort?: string; effort_note?: string }
export interface DesignUsage { document_id: string; runs: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: string; unpriced_runs: number }

export interface ChatTurn {
  user: string;
  assistant: string;
  usage?: TurnUsage;
  attachments?: AttachmentMeta[];
  provider?: string;
  model?: string;
  tools?: string[];
  /** Skills STEVE loaded for this answer (load_capability). */
  skills?: string[];
  document_id?: string | null;
  created_at?: string;
  /** Sent while STEVE was working and delivered at its next step. */
  steered?: boolean;
  /** The person stopped STEVE; `assistant` is what it had written. */
  stopped?: boolean;
  /** The run failed; `assistant` is what STEVE had written and `error` why it couldn't finish. */
  failed?: boolean;
  error?: string;
}

/** One of STEVE's skills (docs/SKILLS.md): built in, or the person's own (which may replace a built-in). */
export interface SkillSummary {
  name: string; description: string; source: 'builtin' | 'user'; enabled: boolean; overrides_builtin: boolean; builtin: boolean;
  updated_at: string | null; size: number;
}
/** With its whole SKILL.md (frontmatter and instructions). */
export interface SkillDetail extends SkillSummary { markdown: string }

export interface ConversationSummary {
  conversation_id: string;
  title: string;
  provider: string;
  created_at: string;
  updated_at: string;
  turn_count: number;
  preview: string;
  busy: boolean;
  active_run_id: string | null;
}
export interface AssistantRun {
  run_id: string; conversation_id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'stopped';
  stop_requested?: boolean; provider?: string; model?: string;
  message: string; attachments?: AttachmentMeta[]; result: (ChatTurn & { conversation_id: string }) | null; error: string | null;
  created_at: string; events_url: string;
}
export interface Conversation extends ConversationSummary {
  turns: ChatTurn[];
  settings: AssistantSettings;
  settings_revision: number;
  plan: { id: string; content: string; status: string }[];
  queued?: QueuedMessage[];
}

export interface CombineResult {
  revision: number;
  kind: Kind;
  status: 'clean' | 'conflict';
  name: string;
  code: string;
  files: Record<string, string>;
  links: Record<string, LinkRef>;
  conflicts: { kind: string; file?: string; alias?: string; message: string; start_line: number | null }[];
}

export class ApiError extends Error {
  /** Structured errors carry {code, message, ...}; `code` and the extra fields are kept here. */
  constructor(message: string, readonly status: number, readonly code: string | null = null, readonly data: Record<string, unknown> = {}) { super(message); }
}

let termsReload = false;

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options);
  let body: unknown = null;
  let readable = true;
  try { body = await response.json(); } catch { readable = false; /* Non-JSON error bodies fall through to the status message. */ }
  if (response.ok && !readable && response.status !== 204 && response.status !== 205) {
    // A success whose answer was cut off on the way (or never came): an error to retry, never an empty result.
    recordFailedRequest(options.method ?? 'GET', url, response.status, 'unreadable response');
    throw new ApiError('The server’s answer didn’t arrive whole. Please try again.', response.status, 'incomplete_response');
  }
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    const said = detail && typeof detail === 'object' && !Array.isArray(detail) ? String((detail as { message?: unknown }).message ?? '') : typeof detail === 'string' ? detail : '';
    recordFailedRequest(options.method ?? 'GET', url, response.status, said);
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const { code, message, ...data } = detail as { code?: string; message?: string };
      // The terms changed while the app was open (app/terms.py): load again, to the "Before you start" page.
      if (code === 'terms_not_accepted' && response.status === 403 && typeof location !== 'undefined' && !termsReload) {
        termsReload = true;
        location.reload();
      }
      throw new ApiError(message || `Request failed (${response.status}).`, response.status, code ?? null, data);
    }
    const message = Array.isArray(detail) ? detail.map((item: { msg?: string }) => item.msg).join('; ') : typeof detail === 'string' ? detail : '';
    throw new ApiError(message || `Request failed (${response.status}).`, response.status);
  }
  return body as T;
}

export const json = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

// getRandomValues works on LAN HTTP; randomUUID requires a secure context.
export const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

export const Api = {
  examples: () => api<Record<string, string>>('/v1/examples').then((examples) => ({ plate: localPlate, design: localDesign, ...examples })),
  exampleCatalog: () => api<{ examples: { id: string; name: string; description: string; kind: Kind; code: string; files?: Record<string, string> }[] }>('/v1/examples/catalog'),
  builds: (limit = 100) => api<{ builds: Build[] }>(`/v1/builds?limit=${limit}`),
  build: (id: string) => api<Build>(`/v1/builds/${id}`),
  /** A full build's print meshes (metadata.body_meshes), made on demand: starts the job (POST) or reads it (GET). */
  printMesh: (id: string, start = false, resolution: MeshResolution = 'fine') => api<{ status: 'none' | 'queued' | 'running' | 'succeeded' | 'failed'; error: string | null }>(
    `/v1/builds/${id}/print-mesh${resolution === 'fine' ? '' : `?resolution=${resolution}`}`, start ? { method: 'POST' } : {}),
  /** A full build's STEP file: starts making it unless it's made (POST; `retry` runs again even one that used its whole
   *  budget), or reads how far it is (GET). */
  step: (id: string, start = false, retry = false) =>
    api<StepStatus>(`/v1/builds/${id}/step${retry ? '?retry=true' : ''}`, start ? { method: 'POST' } : {}),
  /** Drops a preview nobody waits for any more (a newer edit replaced it). Best effort: never throws or reports. */
  cancelBuild: (id: string) => fetch(`/v1/builds/${id}/cancel`, { method: 'POST' }).then(() => undefined, () => undefined),
  /** The person's Stop (app/main.py stop_build): `stop` says what happened. */
  stopBuild: (id: string) => api<Build & { stop: 'stopped' | 'stopping' | 'kept' | 'finished' }>(`/v1/builds/${id}/cancel?requested=true`, { method: 'POST' }),
  /** `force`: the person asked to build this exact source again, even if it used its whole budget before. */
  submit: (body: { kind: Kind; name: string; code: string; files?: Record<string, string>; links?: Record<string, LinkRef>; mode?: 'preview' | 'full' | 'drawing' | 'save'; route?: boolean }, force = false) =>
    api<Build>('/v1/builds', json('POST', body, { 'Idempotency-Key': requestId(), ...(force ? { 'Cache-Control': 'no-cache' } : {}) })),
  documents: (params: { search?: string; kind?: Kind; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.kind) query.set('kind', params.kind);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    return api<{ documents: DocumentSummary[] }>(`/v1/documents${query.size ? `?${query}` : ''}`);
  },
  files: (params: { search?: string; kind?: FileKind; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.search) query.set('search', params.search);
    if (params.kind) query.set('kind', params.kind);
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    return api<{ files: FileSummary[] }>(`/v1/files${query.size ? `?${query}` : ''}`);
  },
  /** Renames or duplicates a simulation study or CAM program (documents rename through their own save). */
  renameFile: (id: string, name: string) => api<FileSummary>(`/v1/files/${id}/rename`, json('POST', { name })),
  duplicateFile: (id: string, name: string) => api<FileSummary>(`/v1/files/${id}/duplicate`, json('POST', { name })),
  document: (id: string) => api<CadDocument>(`/v1/documents/${id}`),
  /** A saved revision (the latest by default) and every document it links, at their pinned revisions, in assembly order. */
  package: (id: string, revision?: number | null) =>
    api<{ documents: PackageDocument[] }>(`/v1/documents/${id}/package${revision ? `?revision=${revision}` : ''}`),
  /** Swaps a saved revision's geometry for the full build of the same code (no new revision). */
  promotePreview: (id: string, body: { revision: number; build_id: string; branch?: string }) =>
    api<CadDocument>(`/v1/documents/${id}/preview`, json('POST', body)),
  /** `folder_id`: the folder it goes in (one that isn't there leaves it at the top level). */
  createDocument: (body: { name: string; kind: Kind; code: string; files?: Record<string, string>; links?: Record<string, LinkRef>; preview_build_id: string | null; folder_id?: string | null; message?: string }) =>
    api<CadDocument>('/v1/documents', json('POST', body)),
  folders: () => api<{ folders: Folder[]; max_depth: number }>('/v1/folders'),
  createFolder: (name: string, parentId: string | null) => api<Folder>('/v1/folders', json('POST', { name, parent_id: parentId })),
  /** Renames (name), moves (parent_id; null is the top level) or marks as a library (library) a folder; what's left out stays. */
  updateFolder: (id: string, body: { name?: string; parent_id?: string | null; library?: boolean }) => api<Folder>(`/v1/folders/${id}`, json('POST', body)),
  /** An empty folder; `up`: its subfolders and documents move up to its parent first. */
  deleteFolder: (id: string, up = false) => api<{ deleted: string; folders: number; documents: number }>(`/v1/folders/${id}${up ? '?contents=up' : ''}`, { method: 'DELETE' }),
  /** Files a part, design or circuit in a folder (null: the top level). No new version. */
  placeDocument: (id: string, folderId: string | null) =>
    api<{ document_id: string; folder_id: string | null; folder_path: string | null }>(`/v1/documents/${id}/folder`, json('POST', { folder_id: folderId })),
  updateDocument: (id: string, body: { name: string; kind: Kind; code: string; files?: Record<string, string>; links?: Record<string, LinkRef>; preview_build_id: string | null; revision: number; message?: string }) =>
    api<CadDocument>(`/v1/documents/${id}`, json('PUT', body)),
  /** Saves a shop revision's succeeded build into the manufacturing library: each item created, revised or unchanged. */
  /** One step of running a saved revision of a CAM program (it must have built); ask again until `done`. */
  camRun: (id: string, revision: number) => api<CamRunState>(`/v1/documents/${id}/cam/run`, json('POST', { revision })),
  camStatus: (id: string) => api<{ cam: { program_id: string; run?: CamRunState['run']; post?: { job_id: string; status: string }; posts?: { setup: string; job_id: string; status: string; posted_resolution?: PostedResolution }[]; posted_resolution?: PostedResolution; error?: CamFailure } | null }>(`/v1/documents/${id}/cam`),
  applyShop: (id: string, body: { revision: number; branch?: string }) =>
    api<ShopApplyResult>(`/v1/documents/${id}/shop/apply`, json('POST', body)),
  /** Unsaved edits made on `base_revision`, three-way merged with what was saved since. Saves nothing. */
  combine: (id: string, body: { base_revision: number; branch: string; name: string; code: string; files: Record<string, string>; links: Record<string, LinkRef> }) =>
    api<CombineResult>(`/v1/documents/${id}/combine`, json('POST', body)),
  assistantConfig: () => api<AssistantConfig>('/v1/assistant/config'),
  assistantRun: (id: string) => api<AssistantRun>(`/v1/assistant/runs/${id}`),
  assistantUsage: (documentId: string) => api<DesignUsage>(`/v1/assistant/usage?document_id=${documentId}`),
  startAssistantRun: (body: { request_id: string; message: string; attachments: string[]; provider: string; model: string | null; effort?: string; conversation_id: string; document_id: string | null; branch: string | null; selection: string | null; selection_detail: unknown[]; ui_workspace?: string }) =>
    api<AssistantRun>('/v1/assistant/runs', json('POST', body)),
  uploadAttachment: (image: Blob, name: string) =>
    api<Attachment>(`/v1/assistant/attachments?name=${encodeURIComponent(name.slice(0, 200))}`, { method: 'POST', headers: { 'Content-Type': image.type }, body: image }),
  conversation: (id: string) => api<Conversation>(`/v1/assistant/conversations/${id}`),
  conversations: (search = '', offset = 0) => api<{ conversations: ConversationSummary[]; has_more: boolean }>(
    `/v1/assistant/conversations?${new URLSearchParams({ search, offset: String(offset), limit: '30' })}`),
  createConversation: (provider: string) => api<Conversation>('/v1/assistant/conversations', json('POST', { provider })),
  deleteConversation: (id: string) => api<null>(`/v1/assistant/conversations/${id}`, { method: 'DELETE' }),
  deleteConversations: (ids: string[]) =>
    api<{ deleted: string[]; skipped: { id: string; reason: string }[] }>('/v1/assistant/conversations/delete', json('POST', { ids })),
  assistantSettings: (id: string, settings: AssistantSettings, revision: number) =>
    api<{ settings: AssistantSettings; settings_revision: number }>(`/v1/assistant/conversations/${id}/settings`, json('PUT', { settings, revision })),
  /** Talk to STEVE while it works; starts a run instead when the conversation is idle. */
  sendAssistantMessage: (conversationId: string, body: { request_id: string; message: string; attachments: string[]; provider: string; model: string | null; effort?: string; document_id: string | null; branch: string | null; selection: string | null; selection_detail: unknown[]; ui_workspace?: string }) =>
    api<{ status: 'queued' | 'delivered' | 'started'; message: QueuedMessage | null; run: AssistantRun | null }>(`/v1/assistant/conversations/${conversationId}/messages`, json('POST', body)),
  removeQueuedMessage: (conversationId: string, id: string) =>
    api<QueuedMessage>(`/v1/assistant/conversations/${conversationId}/messages/${id}`, { method: 'DELETE' }),
  /** Stop: cancels the run; undelivered queued messages come back in `returned`. */
  stopAssistantRun: (runId: string) => api<AssistantRun & { returned: QueuedMessage[] }>(`/v1/assistant/runs/${runId}/cancel`, { method: 'POST' }),
  assistantPreferences: (preferences: AssistantPreferences) => api<AssistantPreferences>('/v1/assistant/preferences', json('PUT', preferences)),
  providerKeys: () => api<ProviderKeys>('/v1/assistant/keys'),
  /** Checks the key with the provider, then stores it encrypted. The response never contains it. */
  saveProviderKey: (provider: ProviderId, apiKey: string) => api<ProviderKeys>(`/v1/assistant/keys/${provider}`, json('PUT', { api_key: apiKey })),
  deleteProviderKey: (provider: ProviderId) => api<ProviderKeys>(`/v1/assistant/keys/${provider}`, { method: 'DELETE' }),
  quotas: () => api<Quotas>('/v1/quotas'),
  setSelfLimits: (limits: Partial<SelfLimits>) => api<{ self: SelfLimits }>('/v1/quotas/self', json('PUT', { limits })),
  skills: () => api<{ skills: SkillSummary[]; enabled: number }>('/v1/assistant/skills'),
  skill: (name: string) => api<SkillDetail>(`/v1/assistant/skills/${encodeURIComponent(name)}`),
  createSkill: (name: string, markdown: string) => api<SkillDetail>('/v1/assistant/skills', json('POST', { name, markdown })),
  updateSkill: (name: string, markdown: string, enabled: boolean) => api<SkillDetail>(`/v1/assistant/skills/${encodeURIComponent(name)}`, json('PUT', { markdown, enabled })),
  toggleSkill: (name: string, enabled: boolean) => api<SkillSummary>(`/v1/assistant/skills/${encodeURIComponent(name)}`, json('PATCH', { enabled })),
  deleteSkill: (name: string) => api<void>(`/v1/assistant/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  chat: (body: { message: string; provider: string; conversation_id: string | null; document_id: string | null; selection: string | null; selection_detail?: unknown[]; ui_workspace?: string }) =>
    api<ChatTurn & { conversation_id: string }>('/v1/assistant/chat', json('POST', body)),
};

/** An uploaded STEP file. Documents reference it by sha256; a geometry kernel checked it (solids, bounds). */
export interface StepImport {
  id: string;
  sha256: string;
  filename: string;
  /** Display name from the file name; the name the generated feature gets. */
  name: string;
  size: number;
  status: 'validating' | 'ready' | 'failed';
  error: string | null;
  solids: number | null;
  faces: number | null;
  bounds_mm: Vec3 | null;
  volume_mm3: number | null;
  /** Per solid, in file order: component names from the file, null when it has none. */
  solid_names: (string | null)[];
  /** "f3d" for an Autodesk Fusion design (its exact solids; its timeline isn't rebuilt), else "step". */
  format?: 'step' | 'f3d';
  /** A Fusion design's parameters and timeline features, as data from the file. */
  fusion?: { parameters: { name: string; expression?: string; value?: number; unit?: string; comment?: string; kind?: string }[];
    features: { type?: string; name: string; description?: string }[] } | null;
  build_id: string | null;
  /** The part a new document starts from (the checked code: opening it is a cache hit). */
  part_code: string;
  created_at: string;
  url: string;
}

export const importInfo = (id: string) => api<StepImport>(`/v1/imports/${id}`);

/* ───────── Standard parts (step.parts catalog, through the API: app/standard_parts.py) ───────── */

export interface StandardPart {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  family?: string | null;
  tags: string[];
  /** Standard designation, e.g. "ISO 4762". */
  standard?: string | null;
  /** Key dimensions first (nominalSize, thread, lengthMm, boreMm, …). */
  attributes: Record<string, string | number | boolean>;
  thumbnail?: string | null;
  page?: string | null;
  size?: number | null;
  sha256?: string | null;
  license: string;
}
export interface Facet { value: string; count: number }
export interface StandardPartSearch {
  total: number; page: number; page_size: number | null; has_next: boolean; items: StandardPart[];
  facets: { categories: Facet[]; families: Facet[]; standards: Facet[]; tags: Facet[] };
  catalog: { parts?: number | null; sha256?: string | null };
}
export type StandardPartImport = StepImport & { standard_part: StandardPart & { provenance: string } };

export function standardParts(query: { q?: string; category?: string[]; family?: string[]; standard?: string[]; page?: number; pageSize?: number },
  signal?: AbortSignal): Promise<StandardPartSearch> {
  const params = new URLSearchParams();
  if (query.q?.trim()) params.set('q', query.q.trim());
  for (const key of ['category', 'family', 'standard'] as const) for (const value of query[key] ?? []) params.append(key, value);
  params.set('page', String(query.page ?? 1));
  params.set('page_size', String(query.pageSize ?? 24));
  return api<StandardPartSearch>(`/v1/standard-parts?${params}`, { signal });
}

/** Downloads (verified against the catalog's checksum) and checks the part like an upload; 202 while the check runs. */
export const importStandardPart = (id: string) => api<StandardPartImport>(`/v1/standard-parts/${encodeURIComponent(id)}/import`, { method: 'POST' });

/* ───────── McMaster-Carr parts the person downloaded (app/vendor_parts.py; nothing contacts mcmaster.com) ───────── */

export interface McMasterPart {
  part_number: string; title: string; sha256: string; filename: string; url: string;
  first_used: string; last_used: string; status: StepImport['status'] | null;
  solids: number | null; bounds_mm: Vec3 | null;
  /** The comment kept above the part's import. */
  provenance: string;
}
export type McMasterImport = StepImport & { mcmaster: McMasterPart };

export const mcmasterParts = (search = '') => api<{ parts: McMasterPart[]; catalog: string }>(`/v1/vendor-parts/mcmaster${search.trim() ? `?search=${encodeURIComponent(search.trim())}` : ''}`);
/** A cached part, checked, for inserting again (marks it recently used). */
export const reuseMcmasterPart = (partNumber: string) => api<McMasterImport>(`/v1/vendor-parts/mcmaster/${encodeURIComponent(partNumber)}/use`, { method: 'POST' });
/** Uploads the downloaded 3-D STEP (or its ZIP); the part number and title default to the file name's. */
export function uploadMcmaster(file: File, part: { partNumber?: string; title?: string }, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<McMasterImport> {
  const params = new URLSearchParams();
  if (part.partNumber?.trim()) params.set('part_number', part.partNumber.trim());
  if (part.title?.trim()) params.set('title', part.title.trim());
  return uploadImport(file, onProgress, signal, `/v1/vendor-parts/mcmaster${params.toString() ? `?${params}` : ''}`) as Promise<McMasterImport>;
}

/** Uploads a STEP file with progress (fetch has no upload progress). 202 means the kernel check is still running. */
export async function uploadImport(file: File, onProgress: (fraction: number) => void, signal?: AbortSignal, url = '/v1/imports'): Promise<StepImport> {
  const authorization = await bearer();  // XHR doesn't pass through the signed-in fetch (auth/auth.ts).
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.open('POST', url);
    if (authorization) xhr.setRequestHeader('Authorization', authorization);
    for (const [name, value] of Object.entries(workspaceHeaders())) xhr.setRequestHeader(name, value);   // the tab's team (teams/current.ts)
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      const body = xhr.response as { detail?: unknown } | StepImport | null;
      if (xhr.status >= 200 && xhr.status < 300) { resolve(body as StepImport); return; }
      const detail = (body as { detail?: unknown } | null)?.detail;
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const { code, message, ...data } = detail as { code?: string; message?: string };
        reject(new ApiError(message || `Upload failed (${xhr.status}).`, xhr.status, code ?? null, data));
      } else reject(new ApiError(typeof detail === 'string' ? detail : xhr.status >= 500 ? `The model service didn’t answer (${xhr.status}). Try again in a moment.` : `Upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('The upload was interrupted. Check the connection and try again.', 0));
    xhr.onabort = () => reject(new DOMException('Upload cancelled.', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

const topologyCache = new Map<string, Promise<Topology | null>>();

/** The 3MF/STL export's mesh resolutions (runtime/run.py MESH_RESOLUTIONS): fine is the print-grade mesh. */
export type MeshResolution = 'fine' | 'medium' | 'coarse';

/** A build's print meshes at `resolution`, once made. */
export const bodyMeshes = (build: Build, resolution: MeshResolution = 'fine'): BodyMesh[] | undefined =>
  resolution === 'fine' ? build.metadata?.body_meshes : build.metadata?.[`body_meshes_${resolution}` as const];

/** Forgets a build's cached topology (it was completed since: viewport/selectionPrep.ts). */
/**
 * A succeeded full build with its print meshes (metadata.body_meshes: a print-grade STL per body, as modelled), which
 * the 3MF/STL, print set and simulation model exports and Manufacture read. They're made on demand, the first time
 * anything asks; a model whose meshes can't be made fails here, never its build. A coarser `resolution` (the 3MF/STL
 * export's smaller files) is made the same way, once per build, and listed under its own key (bodyMeshes).
 */
export async function withPrintMeshes(build: Build, resolution: MeshResolution = 'fine'): Promise<Build> {
  if (bodyMeshes(build, resolution)) return build;
  let job = await Api.printMesh(build.id, true, resolution);
  while (job.status === 'queued' || job.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = await Api.printMesh(build.id, false, resolution);
  }
  if (job.status !== 'succeeded') throw new Error(job.error?.trim().split('\n').pop() || 'The print meshes couldn’t be made for this model.');
  return Api.build(build.id);
}

export function forgetTopology(build: Build) {
  if (build.artifacts.topology) topologyCache.delete(build.artifacts.topology);
}

export function fetchTopology(build: Build): Promise<Topology | null> {
  const url = build.artifacts.topology;
  if (!url) return Promise.resolve(null);
  let request = topologyCache.get(url);
  if (!request) {
    request = fetch(url).then(async (response) => {
      if (!response.ok) return null;
      const data = await response.json() as Topology;
      return data?.version === 1 ? data : null;
    }).catch(() => null);
    topologyCache.set(url, request);
    while (topologyCache.size > 12) topologyCache.delete(topologyCache.keys().next().value!);
  }
  return request;
}

export interface TopologyFace {
  ref?: string | null;
  /** Exact current body owners; feature provenance in ref is not body identity. */
  bodies?: string[];
  type: string;
  area: number;
  normal?: Vec3;
  origin?: Vec3;
  axis?: Vec3;
  radius?: number;
  minor_radius?: number;
  half_angle?: number;
  edges?: number[];
}

export interface TopologyEdge {
  type: string;
  length: number;
  points: number[];
  faces?: number[];
  smooth?: boolean;
  seam?: boolean;
  center?: Vec3;
  radius?: number;
  normal?: Vec3;
  vertices?: number[];
  /** Exact continuity (runtime/steve/continuity.py): for a smooth edge its two faces, for a surface body's free edge the
   *  other body's face that continues it. Creases have none (the viewer estimates them from the mesh). */
  continuity?: { faces: [number, number]; gap: number; angle: number; change: number; relative: number;
    curvature: [number | null, number | null]; at: [number, number, number]; samples: number }[];
}

export interface TopologyMesh {
  name: string;
  volume?: number;
  area?: number;
  center_of_mass?: Vec3;
  faces: TopologyFace[];
  edges: TopologyEdge[];
  vertices: Vec3[];
  /** Described compactly (runtime COMPACT_FACES: e.g. a mesh imported as STEP): only creases kept as edges. */
  compact?: boolean;
  /** The mesh's surface bodies (model.fill, boundary_surface): drawn two-sided; never machined, weighed or simulated. */
  surface_bodies?: string[];
}

export interface Topology { version: 1; units: 'mm'; meshes: Record<string, TopologyMesh> }

export interface Capabilities { features: boolean; history: boolean; branches: boolean; branchFeatures: boolean; buildEvents: boolean; documentEvents: boolean; routeBuilds: boolean }
let capabilities: Promise<Capabilities> | null = null;

/** Which optional backend APIs this server exposes, read once from its OpenAPI schema. */
export function serverCapabilities(): Promise<Capabilities> {
  capabilities ??= api<{ paths?: Record<string, unknown>; components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } }>('/openapi.json')
    .then((schema) => {
      const paths = Object.keys(schema.paths ?? {});
      const featurePath = (schema.paths ?? {})['/v1/documents/{document_id}/features'] as { get?: { parameters?: { name: string }[] } } | undefined;
      return {
        features: paths.some((path) => path.endsWith('/features')),
        history: paths.some((path) => path.includes('/history')),
        branches: paths.some((path) => path.endsWith('/branches')),
        branchFeatures: !!featurePath?.get?.parameters?.some((parameter) => parameter.name === 'branch'),
        buildEvents: paths.includes('/v1/builds/{build_id}/events'),
        documentEvents: paths.includes('/v1/documents/{document_id}/events'),
        // Circuits route only when asked (docs/ELECTRONICS.md, "Routing"): a server that takes `route` in a build request.
        routeBuilds: !!schema.components?.schemas?.BuildRequest?.properties?.route,
      };
    })
    .catch(() => ({ features: false, history: false, branches: false, branchFeatures: false, buildEvents: false, documentEvents: false, routeBuilds: false }));
  return capabilities;
}
import localPlate from '@/local-examples/plate.py?raw';
import localDesign from '@/local-examples/design.py?raw';

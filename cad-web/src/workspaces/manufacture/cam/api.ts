/**
 * Native milling jobs and their playback artifacts (docs/MANUFACTURING_NATIVE_JOBS.md). Types follow the OpenAPI
 * schemas SimulationPreview, StockCheckpoint, PostAssessment and VerificationEvent; the server is authoritative for
 * every verdict, and these are only read and drawn.
 */
import { jobs, mfg, MfgError, requestKey, type JobRecord, type Pin } from '../api';
import { sha256Hex } from '@/lib/sha256';
import type { StockGrid } from './stock';
import type { PostedResolution } from '@/lib/api';

export interface Frame { origin_mm: number[]; x: number[]; y: number[]; z: number[] }
export interface Bounds { minimum_mm: number[]; maximum_mm: number[] }
export interface PreviewFile { name: string; sha256: string; bytes: number; media_type: string }
export interface DisplayMesh { units: 'm'; scale_to_mm: number; coordinate_axes: string; triangles: number; vertices: number; position_quantization_error_mm: number; verification_geometry: false }

export interface MotionChunkIndex {
  file: PreviewFile; first_move: number; last_move: number; byte_offset: number; record_bytes: number;
  initial_position_mm: [number, number, number]; bounds_mm: Bounds;
  position_quantization_error_mm: number; rpm_quantization_error: number; feed_quantization_error_mm_min: number;
}

export interface StockMeasure {
  guaranteed_material_mm3: number; possible_material_mm3: number; uncertainty_volume_mm3: number;
  occupied_cells: number; uncertain_cells: number; cell_diagonal_mm: number; spatial_error_bound_mm: number | null;
}
export interface StockSnapshot { algorithm: string; grid: StockGrid & { version?: number }; measure: StockMeasure; snapshot_sha256: string; state_bytes: number; state_sha256: string }
/** `state`: the checkpoint's raw occupancy bytes (one per grid cell; 3 definite, 2 uncertain, 0 removed), with the stream. */
export interface StockCheckpoint { after_move: number; operation: number; mesh: PreviewFile; display: DisplayMesh; snapshot: StockSnapshot; state?: PreviewFile }
/**
 * Timed stock transitions (docs/MANUFACTURING_STOCK_DELTAS.md): chunks aligned with the motion chunks, each a
 * `STVSDLT1` file of per-move cell transitions with the fraction of the move at which each happens.
 */
export interface StockDeltaStream {
  version: 1; format: 'steve_stock_delta_le_v1'; grid: StockGrid & { cells?: number }; moves: number;
  initial_snapshot_sha256: string; final_snapshot_sha256: string;
  chunks: { first_move: number; last_move: number; records: number; file: PreviewFile }[];
  header_bytes: 24; record_bytes: 8; time_denominator: 65535; timing_basis: 'continuous_sweep_prefix'; verification_geometry: false;
}

/**
 * `GET /jobs/{id}/simulation`: one operation's `SimulationPreview` (`steve_linear_motion_le_v1`), or, for a combined
 * program post, `ProgramSimulationPreview` (`steve_program_motion_le_v1`: several tools, operation ranges, chunks that
 * restart at each tool change; docs/MANUFACTURING_PROGRAM_POSTS.md "Multi-tool playback"). Same 36-byte moves.
 */
export interface SimulationPreview {
  version: 1; status: 'decoded' | 'unavailable'; diagnostic: string | null; format: string; coordinate_space: 'machine'; units: 'mm';
  moves: number; operation_ids: string[];
  chunks: MotionChunkIndex[]; stock_checkpoints: StockCheckpoint[]; stock_deltas?: StockDeltaStream; events: PreviewFile;
  motion_sha256: string | null; source_sha256: string; input_sha256: string;
  /** One operation. */
  tool_number?: number; rotary_axes?: never[]; move_kinds?: Record<string, number>; tool_assembly_sha256?: string;
  /** A combined program. */
  tools?: { tool_number: number; assembly_sha256: string }[]; initial_tool?: number; initial_position_mm?: [number, number, number];
  operation_mapping?: 'exact_sequence' | 'unavailable'; operations?: { operation: string; first_move: number; last_move: number }[];
  state_events?: PreviewFile; unassigned_operation?: number;
}

/** `/program-state-events`: spindle, work-offset and tool-change states, each before a move. */
export interface ProgramStateTransition {
  before_move: number;
  event: { id: string; kind: 'spindle'; direction: 'cw' | 'ccw' | 'off'; rpm: number } | { id: string; kind: 'tool_change'; tool_number: number } | { id: string; kind: 'work_offset'; slot: number };
  placement?: { event_id: string; source_line: number; old_tool: number; new_tool: number; gauge_mm: number[]; old_tip_mm: number[]; new_tip_mm: number[] } | null;
}

/**
 * A combined program's `/simulation-events`: each event names its posted move (`line_81`), tool and phase, and newer
 * outputs bind it to the decoded motion: `move_index` (zero-based move) or `before_move` (a stationary placement such
 * as a tool change). Groups other than checks/stock/fixtures are omitted when empty.
 */
export type ProgramPhase = 'initial' | 'move' | 'exchange_old' | 'exchange_new';
export interface EventLocation { move_index?: number | null; before_move?: number | null }
export interface MachineCollisionEvent extends EventLocation {
  move: string; phase: ProgramPhase; source_line?: number | null; first: string; second: string; status: 'failed' | 'uncertain';
  interval: [number, number]; witness_t?: number | null; gauge_mm?: number[] | null;
}
export interface MachineContactEvent extends EventLocation {
  move: string; phase: ProgramPhase; source_line?: number | null; tool_number: number; machine_body: string; target: 'tool_region' | 'fixture' | 'stock';
  region?: string | null; fixture?: string | null; cell?: number | null; status: 'failed' | 'uncertain'; interval: [number, number];
  witness_mm?: number[] | null; witness_t?: number | null;
}
export interface RemovalRateEvent extends EventLocation {
  phase: 'move'; operation: string | null; tool_number: number; move: string; source_line?: number | null; status: 'failed' | 'uncertain' | 'unassessed';
  interval: [number, number]; lower_mm3_min: number; upper_mm3_min: number | null; limit_mm3_min: number | null; code: string;
}
export interface TargetEvent extends EventLocation {
  move: string; target: string; tool_component: string; tool_number: number; phase: ProgramPhase; check: 'target_gouge' | 'target_noncutting_clearance';
  status: 'failed' | 'uncertain'; interval: [number, number]; witness_mm?: number[] | null; witness_t?: number | null; penetration_mm?: number | null;
}
export interface TabEvent extends EventLocation {
  move: string; check: 'contour_tab_preservation'; operation: string; tab: string; status: 'failed' | 'uncertain'; parameter_range: [number, number];
  message: string; tool_number?: number | null; phase?: ProgramPhase | null;
}
export interface ProgramVerificationEvents {
  checks: Check[];
  fixtures: (FixtureContact & EventLocation & { tool_number: number; phase: ProgramPhase })[];
  pockets: ({ kind: 'pocket_boundary'; message: string; move: string; parameter_range: [number, number]; phase: ProgramPhase; status: 'failed' | 'uncertain'; tip_mm: number[]; tool_number: number; witness_mm: number[] | null } & EventLocation)[];
  stock: ({ move: string; component: string; kind: 'initial_occupancy' | 'rapid_in_stock' | 'noncutting_in_stock' | 'target_gouge'; status: 'failed' | 'uncertain'; tool_number: number; phase: ProgramPhase; target?: string | null;
    interval?: [number, number] | null; witness_mm?: number[] | null; witness_t?: number | null } & EventLocation)[];
  machines?: MachineCollisionEvent[];
  machine_contacts?: MachineContactEvent[];
  engagement?: RemovalRateEvent[];
  targets?: TargetEvent[];
  tabs?: TabEvent[];
}

/**
 * The finished stock against the expected CAD bodies (stock-inspection.json; docs/MANUFACTURING_STOCK_INSPECTION.md):
 * material left outside the excess band and material missing inside the missing band, as machine-space boxes. A failed
 * region holds a strict witness; uncertain ones are unresolved. `total_regions` can exceed the retained `regions`.
 */
export interface InspectionRegion { kind: 'excess' | 'missing'; status: 'failed' | 'uncertain'; bounds: Bounds; witness_mm?: number[] | null; guaranteed_depth_mm: number }
export interface StockInspection {
  checks: Check[]; excess: { guaranteed_mm3: number; possible_mm3: number }; missing: { guaranteed_mm3: number; possible_mm3: number };
  regions: InspectionRegion[]; total_regions: number; evaluations: number; journal_queries: number; exhausted: boolean; numerical_failures: number;
  minimum_box_mm: number; geometry_guard_mm: number;
}

/** A controller dialect the backend knows (`GET /capabilities` controller_dialects); a built-in post names its label. */
export interface ControllerDialectInfo { id: string; name: string; status: string; builtin_post_label?: string | null }

/** What the engines run (`GET /capabilities`): the operations to offer, their cutters and entries. Not a deployment check. */
export interface OperationCapability {
  operation: 'pocket' | 'rest' | 'bore' | 'face' | 'contour' | 'drill' | 'peck_drill' | string; process: 'milling'; family: string; entry_modes: string[]; cutter_types: string[];
  target_kinds: string[]; stock_kinds: string[]; center_cutting_required: boolean; combined_output: boolean; setup_transform: string;
  /** A later setup can take the stock an earlier one leaves (docs/MANUFACTURING_SETUPS.md); combined output is per setup. */
  manual_stock_transfer?: boolean; combined_output_scope?: string;
  /** Contours: 'rectangular' when the engine retains tabs. */
  retention_tabs?: string | null;
  /** The pattern layouts the engine expands for this operation (docs/MANUFACTURING_PATTERNS.md); empty: none. */
  patterns?: string[];
}

/** Drilling: the holes the geometry stage resolved (machine XY centres) and each hole's completion. */
export interface DrillHole { id: string; center_mm: [number, number]; radius_mm: number; face_bounds_mm?: number[]; names?: string[]; tip_height_mm?: number }
export interface DrillGeometry { holes: DrillHole[]; cutting_profile: { radius_mm: number; tip_height_mm: number; tip_radius_mm: number; cutting_length_mm: number }; final_tip_mm: number; stock_bounds: Bounds }
export interface HoleResult { hole: string; operation: string; status: CheckStatus | string; deepest_tip_mm: number | null }

/** Contours (docs/MANUFACTURING_CONTOURS.md): the resolved chains (machine XY, oriented; side left/right) and passes. */
export interface ContourChainRecord { id: string; points: [number, number][]; closed: boolean; side: 'left' | 'right' }
export interface ContourGeometry { chains: ContourChainRecord[]; selection_planes_mm?: number[]; floor_mm?: number; top_mm?: number; side?: string; boundary?: string; tolerance_mm?: number }
/** A chain's finishing-path coverage from the posted moves (contour-check.json / program-check.json `contours`). */
export interface ContourResult { chain: string; operation: string; status: CheckStatus | string; covered_segments: number; required_segments: number }

/** Contour retention tabs (docs/MANUFACTURING_TABS.md): the frozen bridges (machine XY corners) and their checks. */
export interface TabRegion { id: string; chain: string; corners_mm: [number, number][]; bottom_mm: number; top_mm: number }
export interface TabState { operation: string; tab: string; initial_material: CheckStatus | string; preservation: CheckStatus | string }

/** Circular boring (docs/MANUFACTURING_BORING.md): the resolved bores (machine XY) and each bore's finish coverage. */
export interface BoreHole { id: string; center_mm: [number, number]; radius_mm: number }
export interface BoreGeometry { holes: BoreHole[]; final_floor_mm?: number; top_mm?: number }
export interface BoreCoverage { operation: string; hole: string; status: CheckStatus | string; required_segments: number; covered_segments: number; cut_diameter_mm?: number; modelled_diameter_mm?: number }

/** Slots (docs/MANUFACTURING_SLOTS.md): the resolved centrelines (machine XY) with their widths, and each slot's coverage. */
export interface SlotPath { id: string; points_mm: [number, number][]; width_mm: number }
/** An engraving path's finishing coverage (engrave-check.json `paths`, program-check.json `conical_paths`). */
export interface EngraveCoverage { operation: string; path: string; status: string; required_segments: number; covered_segments: number }
/** A declared engraving centreline (machine XY in job artifacts). */
export interface EngravePathOut { id: string; points_mm: [number, number][]; closed?: boolean }
export interface SlotCoverage { operation: string; slot: string; status: CheckStatus | string; required_segments: number; covered_segments: number }
/** A 3D finishing path's coverage by the posted moves (surface-check.json `paths`, program-check.json `surface_paths`). */
export interface SurfaceCoverage { operation: string; path: string; status: CheckStatus | string; required_segments: number; covered_segments: number }
/** An approved 3D finishing path: tool-tip points in machine space (surface-geometry.json; a combined post's surface regions). */
export interface SurfacePathOut { id: string; points_mm: [number, number, number][]; closed?: boolean }

/** Rest machining (docs/MANUFACTURING_REST.md): what the actual remaining stock left to cut. */
export interface RestPlan {
  status: 'cutting' | 'no_remaining_material'; candidate_cut_length_mm: number; retained_cut_length_mm: number; proven_air_length_mm: number;
  required_spans: { start_mm: number[]; end_mm: number[] }[];
}

/** Automatic program runs (docs/MANUFACTURING_RUNS.md): every selected operation in order, stock carried along. */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface RunOperation {
  operation: string; depends_on: string[]; job_id: string | null;
  status: 'waiting' | 'queued' | 'running' | 'checking' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  result: { job_id: string; input_sha256: string; output_sha256: string } | null; error: { code: string; message: string; field?: string | null; operation?: string | null } | null;
}
export interface RunRecord {
  id: string; program_id: string; branch: string; revision: number; revision_sha256: string; input_sha256: string;
  operations: RunOperation[]; status: RunStatus; error: { code: string; message: string; field?: string | null; operation?: string | null } | null;
  created_at: string; started_at: string | null; finished_at: string | null; completed_operations: number;
}

/**
 * A program's executable operations (docs/MANUFACTURING_PATTERNS.md): authored ones as they are, patterns expanded into
 * their active instances, each with a stable ID the engine derives (never built in the UI) and `pattern_instance`.
 */
export interface PatternInstanceRecord { source_operation: string; placement: { key: string; translation_mm: number[]; center_mm: number[]; angle_rad: number }; resolve_selection: boolean }
export interface ExpandedOperation { id: string; name: string; depends_on: string[]; strategy: Record<string, unknown>; pattern_instance?: PatternInstanceRecord | null }
export interface ExpandedProgram { authored_sha256: string; operations: ExpandedOperation[] }

export type CheckStatus = 'passed' | 'failed' | 'uncertain' | 'unassessed';
export interface Check { id: string; status: CheckStatus | string; message: string; operation?: string | null; error_bound_mm?: number | null }
/** A library value the run used that is an estimate: checks that depend on it are "not assessed" (from the backend). */
export interface InputEstimate {
  library: { id: string; kind: string; revision: number; sha256: string };
  /** The field's path in that record, or `dimension_source` when the whole record is declared estimated. */
  field: string; origin: 'field' | 'dimension_source'; affected_checks: string[]; all_checks: boolean;
}
export interface PostAssessment {
  input_estimates?: InputEstimate[];
  checks: Check[]; download_status: 'software_verified' | 'unverified' | 'blocked_failed_checks'; output_status: 'generated';
  software_verified: boolean; physical_qualification: 'unassessed'; diagnostic: { code?: string; message?: string; line?: number; [key: string]: unknown } | null;
  source_sha256: string; controller_sha256: string;
}

export type EventKind = 'holder_contact' | 'shank_contact' | 'cutter_contact' | 'machine_contact' | 'rapid_in_stock' | 'initial_occupancy' | 'gouge' | 'rpm_limit'
  | 'feed_limit' | 'engagement_limit' | 'travel_limit' | 'uncertain' | 'unassessed';
export interface VerificationEvent {
  kind: EventKind; severity: 'failed' | 'uncertain' | 'unassessed'; message: string;
  move_range: [number, number] | null; operation: number; pose: Frame | null;
  pose_basis: 'initial' | 'segment_start' | 'interval_start' | 'endpoint' | 'unavailable';
  region: string | null; fixture: string | null; check: string | null; segment_fraction: [number, number] | null;
  penetration_or_clearance_mm: number | null;
  /** A fixture collision's witness (machine mm) and where in the move it is: a point inside both the cutter and the fixture. */
  witness_mm?: number[] | null; witness_t?: number | null;
  /** A target (finished-part body) event's target; a machine event's bodies (two for self-collision, one for a contact). */
  target?: string | null; machine_bodies?: [string, string] | null; machine_body?: string | null;
}

/** stock-transfer.json: how a setup's starting stock was carried from the setup before (docs/MANUFACTURING_SETUPS.md). */
export interface StockTransferRecord {
  algorithm: string; frame: { origin_mm: number[]; x: number[]; y: number[]; z: number[] };
  method: 'grid_permutation' | 'inverse_cell_envelopes' | string; numeric_guard_mm: number;
  source: StockSnapshot; result: StockSnapshot;
}

/**
 * A tool region's possible contact with a fixture over part of a move (fixture-check.json `events`, a combined
 * program-check.json's `fixture_events`; docs/MANUFACTURING_FIXTURE_SOLIDS.md). `failed` carries a witness point
 * strictly inside the cutting volume and the pinned fixture solid; `uncertain` is unresolved (no depth inferred).
 */
export interface FixtureContact {
  move: string; tool_component: string; fixture: string; status: 'failed' | 'uncertain'; interval: [number, number];
  witness_mm?: number[] | null; witness_t?: number | null; tool_number?: number; phase?: string;
}
/** How the fixture solids were checked: tool/fixture pairs proved clear, colliding, exhausted, failed numerically. */
export interface SolidRefinement {
  algorithm: string; evaluated_pairs: number; separated_pairs: number; failed_pairs: number; exhausted_pairs: number;
  numerical_failures: number; distance_evaluations: number; displacement_limit_mm: number; maximum_evaluations_per_pair: number;
}

export interface FixtureDisplay {
  id: string; display_name: string; display_sha256: string; display: DisplayMesh; frame: Frame; brep_sha256: string;
  /** `solid`: the pinned fixture's BRep, placed in machine mm, that clearance is proved against (newer jobs). */
  collision: { id: string; role: string; shape: string; bounds: Bounds; solid?: PreviewFile };
  reference: { link: string; body: string; instances: string[]; kind: string; names: string[] };
}

/**
 * setup.json: what the worker resolved and froze (machine, controller profile, assignment, stock). One operation's
 * controller has its work origin and tool; a combined program's has `work_offsets` and `tools` (normalised by the player).
 */
export interface ResolvedSetup {
  controller: { work_origin_mm?: number[]; initial_tip_mm?: number[]; tool_number?: number; length_register?: number | null; length_offset_mm?: number;
    tool_gauge_length_mm?: number; tool_diameter_mm?: number; work_offset?: number; retract_tip_z_mm?: number; gauge_limits: Bounds;
    maximum_feed_mm_min: number; maximum_spindle_rpm?: number; dialect: string;
    work_offsets?: { slot: number; origin_mm: number[] }[]; initial_work_offset?: number; initial_tool?: number;
    tools?: { tool_number: number; assembly_sha256: string; diameter_mm: number; gauge_length_mm: number; length_register: number | null; length_offset_mm: number }[] };
  initial_stock_bounds: Bounds;
  [key: string]: unknown;
}

/** Engine families the server has configured (`GET /execution/engines`). */
export interface EngineIdentity { family: string; [key: string]: unknown }

const itemsOf = <T,>(value: T[] | { items: T[] }) => (Array.isArray(value) ? value : value.items);

export const camJobs = {
  engines: () => mfg<EngineIdentity[] | { items: EngineIdentity[] }>('/execution/engines').then(itemsOf),
  capabilities: () => mfg<{ operations: OperationCapability[]; controller_dialects?: ControllerDialectInfo[] }>('/capabilities'),
  stateEvents: (id: string) => mfg<ProgramStateTransition[] | { items: ProgramStateTransition[] }>(`/jobs/${id}/program-state-events`).then(itemsOf),
  programEvents: (id: string) => mfg<VerificationEvent[] | ProgramVerificationEvents>(`/jobs/${id}/simulation-events`),
  runs: {
    submit: (program: { id: string; branch: string; revision: number; revision_sha256: string }, operations: string[] = [], key = requestKey('run')) => mfg<RunRecord>('/runs', {
      body: { request_key: key, program_id: program.id, branch: program.branch, revision: program.revision, revision_sha256: program.revision_sha256, operations },
    }),
    get: (id: string) => mfg<RunRecord>(`/runs/${id}`),
    forProgram: (programId: string) => mfg<{ items: RunRecord[] } | RunRecord[]>(`/runs?program_id=${programId}&limit=50`).then(itemsOf),
    cancel: (id: string) => mfg<RunRecord>(`/runs/${id}/cancel`, { method: 'POST' }),
    /** The run's combined output: one machine program, tool changes included, checked as emitted (a `program_post` job). */
    /** `setup`: which setup's operations to post (required when the run has several; docs/MANUFACTURING_SETUPS.md). */
    post: (run: RunRecord, key = requestKey('program-post'), setup?: string) => mfg<JobRecord>(`/runs/${run.id}/posts`, { body: { request_key: key, run_input_sha256: run.input_sha256, ...(setup ? { setup } : {}) } }),
    posts: (runId: string) => mfg<{ items: JobRecord[] } | JobRecord[]>(`/runs/${runId}/posts?limit=50`).then(itemsOf),
  },
  /** Jobs for one program, newest first (every page). */
  forProgram: async (programId: string) => {
    const out: JobRecord[] = [];
    let after: string | null = null;
    do {
      const page: { items: JobRecord[]; next_after?: string | null } = await mfg(`/jobs?limit=200&program_id=${programId}${after ? `&after=${after}` : ''}`);
      out.push(...page.items);
      after = page.next_after ?? null;
    } while (after && out.length < 1000);
    return out.filter((job) => job.program_id === programId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  /** A saved revision's executable operations (patterns expanded). */
  expansion: (programId: string, branch: string, revision: number) =>
    mfg<ExpandedProgram>(`/programs/${programId}/expansion?branch=${encodeURIComponent(branch)}&revision=${revision}`),
  simulation: (id: string) => mfg<SimulationPreview>(`/jobs/${id}/simulation`),
  verification: (id: string) => mfg<PostAssessment>(`/jobs/${id}/verification`),
  /** A job posted at six decimals for a controller that rounds finer words: what it rounds; null when nothing. */
  postedResolution: (id: string) => mfg<{ posted_resolution: PostedResolution | null }>(`/jobs/${id}/posted-resolution`).then((value) => value.posted_resolution),
  events: (id: string) => mfg<VerificationEvent[] | { items: VerificationEvent[] }>(`/jobs/${id}/simulation-events`).then((value) => (Array.isArray(value) ? value : value.items)),
  toolSetup: (id: string, revision: number) => mfg<ResolvedToolSetupSnapshot>(`/tool-setups/${id}/snapshot?revision=${revision}`),
  machine: (id: string, revision: number) => mfg<ResolvedMachineSnapshot>(`/machines/${id}/snapshot?revision=${revision}`),
};

/** A tool setup snapshot: the setup record (its definition holds tool numbers and offsets) and each assignment's assembly. */
export interface ResolvedToolSetupSnapshot {
  setup: { id: string; revision: number; kind: 'tool_setup'; sha256: string; definition: { name: string; assignments: ToolAssignmentDefinition[]; [key: string]: unknown } };
  machine: ResolvedMachineSnapshot | null;   // the machine it was made on, if any: any machine can use it
  assignments: { assignment: string; tool: ResolvedToolAssembly; checks?: Check[] }[];
  snapshot_sha256: string;
}
export interface ToolAssignmentDefinition {
  id: string; assembly: Pin; spindle: string; tool_number: number; station?: string | null;
  offsets: { basis?: string; length_register?: number | null; length_mm?: number | null; length_wear_mm?: number; radius_register?: number | null; radius_mm?: number | null; radius_wear_mm?: number };
}
export interface ResolvedToolAssembly {
  assembly: Pin & { definition: Record<string, unknown> };
  components: (Pin & { definition: Record<string, unknown> })[];
  geometry: { gauge_length_mm: number; cutter_diameter_mm: number; stickout_mm: number; max_rpm: number | null; center_cutting: boolean; [key: string]: unknown };
  snapshot_sha256: string;
}
export interface ResolvedMachineSnapshot {
  instance: Pin & { definition: Record<string, unknown> };
  model: Pin & { definition: Record<string, unknown> };
  controller: Pin & { definition: Record<string, unknown> };
}

/**
 * An artifact's bytes, checked against the size and sha256 its manifest pins (the same check the reference client
 * makes; lib/sha256 hashes in JavaScript when the studio is opened over plain HTTP).
 */
export async function artifactBytes(jobId: string, file: { name: string; bytes: number; sha256?: string }): Promise<ArrayBuffer> {
  const response = await fetch(jobs.artifactUrl(jobId, file.name));
  if (!response.ok) {
    const detail = await response.json().catch(() => null) as { detail?: { code?: string; message?: string } } | null;
    throw new MfgError(response.status, detail?.detail?.code ?? 'artifact_unavailable', detail?.detail?.message ?? `${file.name} could not be read (${response.status}).`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== file.bytes) throw new MfgError(0, 'artifact_mismatch', `${file.name} has ${bytes.byteLength} bytes; its manifest says ${file.bytes}.`);
  if (file.sha256 && await sha256Hex(bytes) !== file.sha256) throw new MfgError(0, 'artifact_mismatch', `${file.name} differs from the sha256 its manifest pins.`);
  return bytes;
}

export async function artifactJson<T>(jobId: string, name: string): Promise<T> {
  const response = await fetch(jobs.artifactUrl(jobId, name));
  if (!response.ok) throw new MfgError(response.status, 'artifact_unavailable', `${name} could not be read (${response.status}).`);
  return response.json() as Promise<T>;
}

export async function artifactText(jobId: string, name: string): Promise<{ status: number; text: string | null; code?: string; message?: string }> {
  const response = await fetch(jobs.artifactUrl(jobId, name));
  if (response.ok) return { status: response.status, text: await response.text() };
  const detail = await response.json().catch(() => null) as { detail?: { code?: string; message?: string } } | null;
  return { status: response.status, text: null, code: detail?.detail?.code, message: detail?.detail?.message };
}

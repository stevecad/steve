import type { Waiting } from '@/lib/waiting';

export interface DesignPin {
  document_id: string; revision: number; branch: string;
  overrides: Record<string, number>; instances: string[]; pose?: string | Record<string, number> | null;
}
export type Boundary = { id: string; faces: string[] } & (
  { type: 'fixed'; axes: number[] } | { type: 'force'; force_n: [number, number, number] } |
  { type: 'pressure'; pressure_pa: number } | { type: 'temperature'; temperature_k: number } |
  { type: 'heat_flux'; flux_w_m2: number } | { type: 'convection'; coefficient_w_m2k: number; ambient_temperature_k: number } | { type: 'velocity_inlet'; velocity_m_s: [number, number, number] } |
  { type: 'pressure_inlet' | 'pressure_outlet'; gauge_pressure_pa: number } | { type: 'no_slip' | 'slip' } |
  // Compressible flow: absolute pressures and temperatures.
  { type: 'stagnation_inlet'; total_pressure_pa: number; total_temperature_k: number } |
  { type: 'mass_flow_inlet'; mass_flow_kg_s: number; total_temperature_k: number } |
  { type: 'ambient_outlet'; pressure_pa: number; temperature_k: number } | { type: 'symmetry' } |
  // A model-written case's face group: an OpenFOAM patch, or a CalculiX node set and surface (simulation/raw.py).
  { type: 'named'; patch_type?: import('@/state/store').PatchType }
);
/** analysis.case of an openfoam_case study: the person's (or their AI's) own OpenFOAM case on STEVE's mesh. */
export interface OpenFOAMCase { application: string; files: Record<string, string>; before?: string[][]; after?: string[][]; zones?: Record<string, string>; parallel?: boolean }
/** analysis.deck of a calculix_deck study: their own CalculiX deck, which includes STEVE's mesh.inp. */
export interface CalculixDeck { input: string; files?: Record<string, string>; element_sets?: Record<string, string>; bodies?: 'conformal' | 'separate' }
/** Compressible flow's ideal gas, constant properties (simulation/schema.py Gas); viscosity 0 is inviscid. */
export interface Gas { name: string; molar_mass_kg_mol: number; specific_heat_cp_j_kgk: number; dynamic_viscosity_pa_s: number; prandtl_number?: number; source?: string;
  /** Temperature-dependent properties: NASA polynomials for Cp(T) and Sutherland's viscosity. */
  thermo?: 'constant' | 'nasa_polynomials'; polynomials?: { t_low_k: number; t_common_k: number; t_high_k: number; low: number[]; high: number[] } | null;
  viscosity?: 'constant' | 'sutherland'; sutherland_as?: number | null; sutherland_ts?: number | null }
/** A rotating zone: a fluid body turning at rpm about axis through origin_m, with the no_slip walls that turn with it. */
export interface RotatingZone { id: string; body: string; origin_m: [number, number, number]; axis: [number, number, number]; rpm: number; walls: string[] }
/** The rotating zones time-accurate on a sliding mesh (simulation/schema.py SlidingMesh): revolutions of the first zone in fixed steps. */
export interface SlidingMesh { revolutions: number; steps_per_revolution?: number; average_revolutions?: number; phases?: number; max_outer_iterations?: number }
export type AnalysisType = 'static' | 'thermal_steady' | 'thermal_transient' | 'thermal_stress' | 'modal' | 'buckling' | 'flow_steady' | 'flow_transient' | 'cht_steady'
  | 'flow_compressible_steady' | 'flow_compressible_transient' | 'openfoam_case' | 'calculix_deck';
export const COMPRESSIBLE_ANALYSES: readonly AnalysisType[] = ['flow_compressible_steady', 'flow_compressible_transient'];
export const isCompressible = (analysis: string | undefined) => !!analysis && (COMPRESSIBLE_ANALYSES as readonly string[]).includes(analysis);
export interface Definition {
  schema_version: 1; name: string; design: DesignPin;
  analysis: { type: AnalysisType; modes?: number; gravity_m_s2?: number[]; reference_temperature_k?: number | null; reference_pressure_pa?: number; max_iterations?: number; residual_tolerance?: number; heat_generation_w_m3?: number; solver?: Record<string, string | number | boolean>; flow_time?: { duration_s: number; steps: number; initial_velocity_m_s: [number, number, number]; max_outer_iterations?: number; max_courant?: number } | null; time?: { duration_s: number; steps: number; initial_temperature_k: number } | null;
    /** flow_compressible_transient: simulated time and the frames saved through it. */
    gas_time?: { duration_s: number; steps: number } | null;
    compressible?: { solver?: 'density_based' | 'pressure_based'; flux_scheme?: 'kurganov' | 'tadmor'; max_courant?: number; convergence_tolerance?: number };
    /** flow_steady / flow_transient: laminar (left out) or k-omega SST with the inflow's turbulence. */
    turbulence?: Turbulence;
    case?: OpenFOAMCase | null; deck?: CalculixDeck | null;
    /** flow_steady: frozen-rotor rotating zones (simulation/schema.py RotatingZone). */
    rotation?: RotatingZone[];
    /** The rotating zones on a sliding mesh instead of a frozen rotor. */
    sliding_mesh?: SlidingMesh | null };
  materials: Record<string, Record<string, string | number | null>>;
  fluid?: { name: string; density_kg_m3: number; dynamic_viscosity_pa_s: number } | null;
  gas?: Gas | null;
  boundaries: Boundary[];
  regions?: { id: string; body: string; phase: 'fluid' | 'solid'; initial_temperature_k: number }[];
  interfaces?: { id: string; region_a: string; region_b: string; faces_a: string[]; faces_b: string[] }[];
  /** Thermal studies: temperature histories the solve reports at a face or a point (mm, design coordinates). */
  probes?: StudyProbe[];
  /** Options a study leaves out keep their documented defaults (simulation/schema.py MeshSettings). */
  mesh: { size_m: number; order: 1 | 2; max_nodes?: number; max_elements?: number; tetrahedral_algorithm?: 'delaunay' | 'hxt';
    flow_cells?: 'polyhedral_dual' | 'tetrahedral'; dual_concave_edges?: 'single_cell' | 'split' | 'split_until_valid';
    high_order_optimization?: 'elastic_optimization' | 'optimization' | 'elastic' | 'fast_curving' | 'none';
    boundary_layers?: { layers?: number; first_height_m?: number | null; growth?: number; stack?: boolean } | null };
}
export interface Turbulence { model: 'laminar' | 'k_omega_sst'; inlet_intensity?: number; inlet_length_m?: number | null }
/** A turbulent result's model and each wall's first-cell y+ (checks.turbulence). */
export interface TurbulenceRecord { model: string; inlet_intensity: number; y_plus: Record<string, { min: number; max: number; mean: number }> }
export interface StudyProbe { face?: string | null; point_mm?: [number, number, number] | null }
/** One time step's reading (time_s absent from a steady result): a face's min/mean/max, or a point's temperature (K). */
export interface ProbeStep { time_s?: number; min_temperature_k?: number; mean_temperature_k?: number; max_temperature_k?: number; temperature_k?: number }
export interface StudyRecord {
  study_id?: string; id?: string; branch: string; revision: number; compiled: Definition; source: string; update_available?: boolean;
  /** The study's durable outcome (GET studies): its latest successful solve and mesh, of any revision, and newest attempt. */
  last_solve?: StudyResult | null; last_mesh?: StudyResult | null; latest_attempt?: StudyAttempt | null;
}
/** A successful run: the study revision and design pin it ran against; `current`: it ran the head revision's inputs. */
/** `outdated`: the server's reason this result no longer matches the study or design as saved (null: current), the
 * same rule read_design gives agents. */
export interface StudyResult { id: string; revision: number; created_at?: string | null; finished_at?: string | null; design?: DesignPin; current?: boolean; outdated?: string | null }
export interface StudyAttempt { id: string; revision: number; created_at?: string | null; operation: 'mesh' | 'solve'; status: Run['status']; stage: string }
export interface Run {
  id: string; study_id?: string; revision: number; branch: string; operation: 'mesh' | 'solve'; created_at?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; stage: string; cancel_requested: boolean;
  error?: { code: string; message: string; details?: unknown } | null;
  resource_class?: string; resources?: ResourceLimits; policy_version?: number;
  usage?: { solver_wall_seconds: number; allocated_cpu_seconds: number; allocated_memory_mb_seconds: number } | null;
  /** The engine's fingerprint; whether new runs get the same engine (null: unknown here). */
  engine_key?: string | null; engine_current?: boolean | null;
  /** The run whose result this one carries: the same inputs were already solved. */
  reused_from?: string | null;
  /** Not solving yet: why it waits and when it should start (GET /v1/simulation/runs/{id}, its `waiting` events). */
  waiting?: Waiting | null;
}
export interface ResourceLimits { cpu_millis: number; memory_mb: number; solver_seconds: number; output_mb: number }
export interface ArrayDescriptor {
  file: string; url: string; dtype: '<f4' | '<u4'; components: number; count: number;
  bytes: number; units: string | null; sha256: string; min: number; max: number;
}
export interface ResultManifest {
  version: 1; analysis: string; arrays: Record<string, ArrayDescriptor>;
  mesh: { nodes: number; elements: number; min_scaled_jacobian: number; type?: string; options?: Record<string, string> };
  /** Mostly numbers; compressible results add nested outlets (CompressibleSummary) and a thrust direction. */
  summary?: Record<string, number>; checks: Record<string, number | boolean | string | number[]> & { temperature_bounds_warning?: string; mesh_quality_warning?: string; turbulence?: TurbulenceRecord };
  provenance: { design: DesignPin; study_id: string; study_revision: number; study_branch: string; engine_key?: string; steve_version?: string };
  engine: { calculix?: string; openfoam?: string; gmsh: string };
  frames?: { time_s: number; /** A frame that isn't a moment in time (a sliding mesh's phases and its time average). */ label?: string; phase_deg?: number; fields: Record<string, string>; cell_fields?: Record<string, string>; summary: Record<string, number>; checks: Record<string, number | string> }[];
  /** The study's temperature probes, in its order, each with a reading per time step. */
  probes?: (StudyProbe & { history: ProbeStep[] })[];
  transient?: { time_integrator: string; initial_temperature_k?: number; initial_velocity_m_s?: number[]; duration_s?: number; time_step_s: number; assumptions: string;
    /** Adaptive flow time stepping (absent from results computed with fixed steps). */
    time_stepping?: string; output_interval_s?: number; saved_frames?: number; min_time_step_s?: number; solver_steps?: number; max_courant?: number; courant_limit?: number };
  /** Vibration modes (modal: frequency and effective mass) or buckling modes (buckling: load factor). */
  modes?: { number: number; field: string; frequency_hz?: number; effective_mass_kg_xyz?: number[]; effective_mass_fraction_xyz?: number[]; load_factor?: number }[];
  /** How mode shapes are drawn (modal and buckling results). */
  modal?: { normalization: string; display_amplitude_m: number; assumptions: string; effective_mass_reference?: string };
  regions?: Record<string, {
    body: string; phase: 'fluid' | 'solid'; surface: { positions: string; triangles: string };
    fields: Record<string, string>; cell_fields: Record<string, string>; cell_centers?: string;
    mesh: { elements: number; nodes: number; volume_m3: number }; summary?: Record<string, number>;
  }>;
}

/** A combined region view only exposes fields defined in every selected region. */
export function visibleFields(manifest: ResultManifest, region: string): Record<string, ArrayDescriptor> {
  if (!manifest.regions) return manifest.arrays;
  const selected = region === '' ? Object.values(manifest.regions) : [manifest.regions[region]].filter(Boolean);
  if (!selected.length) return {};
  return Object.fromEntries(Object.entries(selected[0].fields).flatMap(([field, key]) => {
    const descriptor = manifest.arrays[key];
    return descriptor && selected.every((item) => {
      const other = manifest.arrays[item.fields[field]];
      return other && other.units === descriptor.units && other.components === descriptor.components;
    }) ? [[field, descriptor]] : [];
  }));
}

export async function simulationApi<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
  const response = await fetch(`/v1/${path}`, { method, headers: { 'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail?.message ?? (typeof error?.detail === 'string' ? error.detail : `Simulation request failed (${response.status}).`));
  }
  return response.json() as Promise<T>;
}

export const terminal = (run: Run) => ['succeeded', 'failed', 'cancelled'].includes(run.status);

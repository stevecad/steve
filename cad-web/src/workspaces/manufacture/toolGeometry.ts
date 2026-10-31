/**
 * Part-backed tool geometry (docs/MANUFACTURING_TOOL_JOBS.md, docs/MANUFACTURING_PART_ASSEMBLIES.md): a cutter or
 * holder record pins a saved STEVE part and its frames; a durable job resolves that exact revision into a checked
 * radial envelope and a display mesh; an assembly pins the chosen job explicitly. The server picks nothing for us.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { create } from 'zustand';
import { sha256Hex } from '@/lib/sha256';
import { jobs, mfg, MfgError, type JobRecord, type LibraryRecord, type Pin } from './api';

export interface FrameReference { reference: string; axis?: string | null; origin?: string | null; reverse_z?: boolean }
export type FrameSelection = string | FrameReference;
export interface ToolGeometrySource {
  version?: 1; document_id: string; revision: number; branch?: string; overrides?: Record<string, number>; instances?: string[];
  body: string;
  frames: { tip?: FrameSelection | null; machine_side?: FrameSelection | null; tool_side?: FrameSelection | null };
  cutting_length_mm?: number | null; clamp_bore_mm?: number | null; engagement_depth_mm?: number | null; outward_tolerance_mm?: number;
}
export interface GeometryPin { job_id: string; snapshot_sha256: string }
export interface Frame { origin_mm: number[]; x: number[]; y: number[]; z: number[] }
export interface RadialSegment { kind: 'line' | 'arc'; z0_mm: number; z1_mm: number; r0_mm?: number | null; r1_mm?: number | null; center_z_mm?: number | null; center_r_mm?: number | null; radius_mm?: number | null; branch?: 1 | -1 }
export interface RotaryProfile {
  segments: RadialSegment[]; outward_margin_mm: number; approximation_bound_mm: number; error_metric: 'radial' | 'meridional_hausdorff';
  source_volume_mm3: number; envelope_volume_mm3: number; envelope_excess_volume_mm3: number;
}
export interface ToolDisplay { file: 'display.glb'; sha256: string; bytes: number; units: 'm'; scale_to_mm: 1000; vertices: number; triangles: number; position_quantization_error_mm: number }
export interface ResolvedToolPart {
  source: ToolGeometrySource; source_sha256: string; brep_sha256: string; snapshot_sha256: string;
  coordinate_space: 'cutter_tip' | 'holder_gauge'; bounds_mm: number[]; connections: Record<string, Frame>;
  regions: { id: string; role: 'cutter' | 'shank' | 'holder'; z_min_mm: number; z_max_mm: number }[];
  profile: RotaryProfile; display: ToolDisplay; gauge_contribution_mm: number; physical_qualification: string;
}
export interface ToolGeometryResolution { pin: GeometryPin; library: Pin; geometry: ResolvedToolPart; engine: Record<string, unknown> }
export interface JobEventRecord { sequence: number; status: JobRecord['status']; stage: string; generation: number; progress: number; created_at: string }
export interface ToolJob extends Omit<JobRecord, 'program_id' | 'error'> {
  kind?: 'tool_geometry'; library?: Pin; error: { code: string; message: string; field?: string } | null;
}

/** Frustum (parametric) or radial-profile (part-backed) envelope segment, in cutter-tip coordinates. */
export interface FrustumSegment { shape?: 'frustum' | 'round_corner'; z_start_mm: number; z_end_mm: number; radius_start_mm: number; radius_end_mm: number; corner_radius_mm?: number | null }
export interface ProfileSegment { shape: 'radial_profile'; curve: RadialSegment; origin_z_mm: number; outward_margin_mm: number; axial_margin_mm: number; approximation_bound_mm: number }
export interface ToolRegion { id: string; component: string; role: 'cutter' | 'shank' | 'holder'; occupancy: string; segment: FrustumSegment | ProfileSegment }
export interface Placement { id: string; source: Pin; frame: Frame; geometry?: GeometryPin; part?: ResolvedToolPart }
export interface Check { id: string; status: string; message: string }
export interface AssemblyGeometry {
  resolver: 'coaxial_rotary_v1' | 'coaxial_part_v1'; regions: ToolRegion[]; placements: Placement[]; gauge_frame: Frame;
  gauge_length_mm: number; stickout_mm: number; engagement_mm: number; dimensional_uncertainty_mm?: number; interface: string;
  maximum_diameter_mm: number; cutter_diameter_mm: number; center_cutting: boolean; hand: string; max_rpm: number | null; mass_kg: number | null;
  checks: Check[]; physical_qualification: string; bounds: { minimum_mm: number[]; maximum_mm: number[] };
}
export interface AssemblySnapshot { assembly: LibraryRecord; components: LibraryRecord[]; geometry: AssemblyGeometry; snapshot_sha256: string }

const pinOf = (record: Pin): Pin => ({ id: record.id, revision: record.revision, kind: record.kind, sha256: record.sha256 });

/** One idempotency key per library revision: resubmitting returns the same durable job (a retry asks for a new one). */
export const resolveKey = (record: Pin, attempt = 0) => `tool-geometry:${record.id}:r${record.revision}${attempt ? `:${attempt}` : ''}`;

export const toolJobs = {
  submit: (record: Pin, key = resolveKey(record)) => mfg<ToolJob>('/tool-geometry/jobs', { body: { request_key: key, library: pinOf(record) } }),
  /** Every job for a library record, newest first; callers keep only the revision they show. */
  list: async (libraryId: string) => {
    const out: ToolJob[] = [];
    let after: string | null = null;
    do {
      const page: { items: ToolJob[]; next_after?: string | null } = await mfg(`/jobs?limit=200&library_id=${libraryId}${after ? `&after=${after}` : ''}`);
      out.push(...page.items);
      after = page.next_after ?? null;
    } while (after && out.length < 1000);
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  },
  get: (id: string) => mfg<ToolJob>(`/jobs/${id}`),
  cancel: (id: string) => mfg<ToolJob>(`/jobs/${id}/cancel`, { method: 'POST' }),
  events: (id: string, after = 0) => mfg<JobEventRecord[] | { items: JobEventRecord[] }>(`/jobs/${id}/events?after=${after}`).then((value) => (Array.isArray(value) ? value : value.items)),
  resolution: (id: string) => mfg<ToolGeometryResolution>(`/jobs/${id}/tool-geometry`),
  source: (libraryId: string, revision: number) => mfg<{ source: ToolGeometrySource; source_sha256: string; design_sha256: string; resolution_status: string }>(`/library/${libraryId}/geometry-source?revision=${revision}`),
  snapshot: (id: string, revision: number) => mfg<AssemblySnapshot>(`/tools/${id}/snapshot?revision=${revision}`),
};

export const sourceOf = (record: { definition: Record<string, unknown> } | null | undefined) =>
  (record?.definition.geometry_source as ToolGeometrySource | undefined) ?? null;

/**
 * Pins the user chose for a component revision (`id:revision`): the builder offers them, it never picks the newest
 * itself. Remembered in this browser only as a convenience; the assembly's saved definition is the real pin.
 */
const PINS_KEY = 'steve-tool-geometry-pins';
function storedPins(): Record<string, GeometryPin> {
  try { return JSON.parse(localStorage.getItem(PINS_KEY) ?? '{}') as Record<string, GeometryPin>; } catch { return {}; }
}
export const useChosenPins = create<Record<string, GeometryPin>>(() => storedPins());
export function choosePin(record: Pin, pin: GeometryPin) {
  useChosenPins.setState({ [`${record.id}:${record.revision}`]: pin });
  try { localStorage.setItem(PINS_KEY, JSON.stringify(Object.fromEntries(Object.entries(useChosenPins.getState()).slice(-200)))); } catch { /* Optional. */ }
}

// ── Display meshes ───────────────────────────────────────────────────────────

const meshes = new Map<string, Promise<THREE.BufferGeometry>>();

/**
 * A job's display.glb as one geometry in component millimetres (glTF metres × scale_to_mm), after checking its
 * byte count and sha256 against the snapshot that names it. Display only: never verification geometry.
 */
export function displayGeometry(jobId: string, display: ToolDisplay): Promise<THREE.BufferGeometry> {
  const key = `${jobId}:${display.sha256}`;
  let request = meshes.get(key);
  if (!request) {
    request = (async () => {
      const response = await fetch(jobs.artifactUrl(jobId, display.file));
      if (!response.ok) throw new MfgError(response.status, 'artifact_unavailable', 'The display mesh could not be read.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== display.bytes) throw new MfgError(0, 'artifact_mismatch', `The display mesh has ${bytes.byteLength} bytes; its snapshot says ${display.bytes}.`);
      const digest = await sha256Hex(bytes);
      if (digest !== display.sha256) throw new MfgError(0, 'artifact_mismatch', 'The display mesh differs from the sha256 its snapshot pins.');
      const gltf = await new GLTFLoader().parseAsync(bytes, '');
      const parts: THREE.BufferGeometry[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((object) => {
        if (object instanceof THREE.Mesh) parts.push((object.geometry as THREE.BufferGeometry).clone().applyMatrix4(object.matrixWorld));
      });
      if (!parts.length) throw new MfgError(0, 'artifact_mismatch', 'The display mesh has no triangles.');
      const geometry = parts[0];
      geometry.scale(display.scale_to_mm, display.scale_to_mm, display.scale_to_mm);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return geometry;
    })();
    meshes.set(key, request);
    request.catch(() => meshes.delete(key));
    while (meshes.size > 24) meshes.delete(meshes.keys().next().value!);
  }
  return request;
}

// ── Radial profiles ──────────────────────────────────────────────────────────

const ARC_STEPS = 24;

export function radiusAt(segment: RadialSegment, z: number): number {
  if (segment.kind === 'line') {
    const t = (z - segment.z0_mm) / (segment.z1_mm - segment.z0_mm);
    return segment.r0_mm! * (1 - t) + segment.r1_mm! * t;
  }
  const u = z - segment.center_z_mm!;
  return segment.center_r_mm! + (segment.branch ?? 1) * Math.sqrt(Math.max(0, segment.radius_mm! ** 2 - u * u));
}

/** (r, z) points along a profile's outer curve, each radius plus the stated outward margin. */
export function curvePoints(segment: RadialSegment, margin: number, shiftZ = 0): [number, number][] {
  const steps = segment.kind === 'line' ? 1 : ARC_STEPS;
  const out: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const z = segment.z0_mm + ((segment.z1_mm - segment.z0_mm) * i) / steps;
    out.push([Math.max(0, radiusAt(segment, z)) + margin, z + shiftZ]);
  }
  return out;
}

export function profilePoints(profile: RotaryProfile): [number, number][] {
  const out: [number, number][] = [];
  for (const segment of profile.segments) for (const point of curvePoints(segment, profile.outward_margin_mm)) {
    const last = out.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out;
}

/** An assembly region's outer curve in tip coordinates: frustum ends, a round corner, or a placed radial profile. */
export function regionPoints(segment: FrustumSegment | ProfileSegment): [number, number][] {
  if (segment.shape === 'radial_profile') {
    const s = segment as ProfileSegment;
    return curvePoints(s.curve, s.outward_margin_mm, s.origin_z_mm);
  }
  const f = segment as FrustumSegment;
  if (f.shape === 'round_corner' && f.corner_radius_mm) {
    const r = f.corner_radius_mm;
    return Array.from({ length: ARC_STEPS + 1 }, (_, i) => {
      const t = (r * i) / ARC_STEPS;
      return [f.radius_start_mm + Math.sqrt(Math.max(0, t * (2 * r - t))), f.z_start_mm + t] as [number, number];
    });
  }
  return [[f.radius_start_mm, f.z_start_mm], [f.radius_end_mm, f.z_end_mm]];
}

export const frameMatrix = (frame: Frame) => new THREE.Matrix4().set(
  frame.x[0], frame.y[0], frame.z[0], frame.origin_mm[0],
  frame.x[1], frame.y[1], frame.z[1], frame.origin_mm[1],
  frame.x[2], frame.y[2], frame.z[2], frame.origin_mm[2],
  0, 0, 0, 1,
);

export const mm = (value: number | null | undefined, digits = 3) => (value === null || value === undefined ? '—' : `${Number(value.toFixed(digits))} mm`);

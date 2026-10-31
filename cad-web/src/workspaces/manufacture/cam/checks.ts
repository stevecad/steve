/**
 * A run's verdicts gathered for reading: the backend's checks grouped by what they are about (the machine, the
 * finished part, stock contact, fixtures, the tool, feeds and speeds), each with the reports behind it: where its
 * events happened (to jump into the simulation at that move), the finished-stock inspection regions, and the posted
 * feed/speed and removal-rate figures against their pinned limits. Every verdict is the backend's; this only reads.
 */
import { create } from 'zustand';
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import type { JobRecord } from '../api';
import { artifactJson, camJobs, type Check, type ProgramVerificationEvents, type StockInspection, type VerificationEvent } from './api';
import { moveForLine } from './motion';
import { openPlayer, programEventsOf, seekEvent, usePlayer } from './state';

type Status = 'passed' | 'failed' | 'uncertain' | 'unassessed';

/** cutting-check.json (docs/MANUFACTURING_CUTTING_PRESETS.md): posted rates per operation and tool against the pinned preset. */
export type CuttingMetricId = 'spindle_rpm' | 'feed_per_tooth_mm' | 'feed_per_revolution_mm' | 'nominal_surface_speed_m_min';
export interface CuttingMetric {
  operation: string; tool_number: number; metric: CuttingMetricId; maximum_lower: number; maximum_upper: number; limit: number | null;
  status: Status; feed_moves: number;
}
export interface CuttingEvent { operation: string | null; tool_number: number; move: string; source_line?: number | null; metric: CuttingMetricId; status: 'failed' | 'uncertain'; lower: number; upper: number; limit: number }
export interface CuttingReport { mapping: string; checks: Check[]; metrics: CuttingMetric[]; events: CuttingEvent[]; total_events: number }

/** engagement-check.json (docs/MANUFACTURING_ENGAGEMENT.md): the geometric material removal rate per operation and tool. */
export interface RemovalMetric {
  operation: string | null; tool_number: number; maximum_lower_mm3_min: number; maximum_upper_mm3_min: number | null; limit_mm3_min: number | null;
  status: Status; cutting_moves: number; unassessed_moves: number;
}
export interface RemovalReport { mapping: string; checks: Check[]; metrics: RemovalMetric[]; total_events: number }

/** machine-check.json / machine-contacts.json: what the machine-body checks could and couldn't cover. */
export interface MachineReport {
  algorithm: string; total_events: number; events: unknown[]; unsupported_bodies: string[]; budget_exhausted: boolean;
  permitted_contacts: unknown[]; cad_evaluations?: number; numerical_failures?: number;
}
export interface ContactReport { total_events: number; events: unknown[]; exhausted_pairs: number; numerical_failures: number; permitted_contacts: unknown[] }

/** Stock contact refined by when the cutter actually removes the material (docs/MANUFACTURING_STOCK_TIMING.md). */
export interface TimingReport {
  pairs: number; cleared_pairs: number; collision_pairs: number; uncertain_pairs: number; evaluations: number; exhausted_pairs: number; numerical_failures: number;
}

export interface CheckDetails {
  /** The job's events as the player lists them (same order: an index here is the player's event index). */
  events: VerificationEvent[];
  inspection: StockInspection | null;
  cutting: CuttingReport | null;
  removal: RemovalReport | null;
  machine: MachineReport | null;
  contacts: ContactReport | null;
  timing: TimingReport | null;
  error: string | null;
}

export const useChecks = create<{ details: Record<string, CheckDetails> }>(() => ({ details: {} }));

const EMPTY: CheckDetails = { events: [], inspection: null, cutting: null, removal: null, machine: null, contacts: null, timing: null, error: null };
/** program-check.json also carries the stock traces; only a small one is read for its timing summary. */
const SMALL_REPORT = 4 * 1024 * 1024;

/** Reads the reports a job published (each optional: older jobs and unconfigured checks have none). */
export async function loadCheckDetails(job: JobRecord) {
  if (useChecks.getState().details[job.id]) return;
  const files = new Map((job.output?.files ?? []).map((file) => [file.name, file]));
  const read = <T,>(name: string) => (files.has(name) ? artifactJson<T>(job.id, name).catch(() => null) : Promise.resolve(null));
  const put = (details: CheckDetails) => useChecks.setState((state) => ({ details: { ...state.details, [job.id]: details } }));
  try {
    const timingFile = files.has('stock-check.json') ? 'stock-check.json' : (files.get('program-check.json')?.artifact.bytes ?? Infinity) <= SMALL_REPORT ? 'program-check.json' : null;
    const [raw, inspection, cutting, removal, machine, contacts, timing] = await Promise.all([
      camJobs.programEvents(job.id).catch(() => null),
      read<StockInspection>('stock-inspection.json'), read<CuttingReport>('cutting-check.json'), read<RemovalReport>('engagement-check.json'),
      read<MachineReport>('machine-check.json'), read<ContactReport>('machine-contacts.json'),
      timingFile ? read<{ temporal_refinement?: TimingReport }>(timingFile) : Promise.resolve(null),
    ]);
    // The same list the player builds (without motion: events the backend located keep their move; older ones by line don't).
    const events = !raw ? [] : Array.isArray(raw) ? raw
      : 'items' in raw ? (raw as unknown as { items: VerificationEvent[] }).items : programEventsOf(raw as ProgramVerificationEvents, null, [], []);
    put({ events, inspection, cutting, removal, machine, contacts, timing: timing?.temporal_refinement ?? null, error: null });
  } catch (error) {
    put({ ...EMPTY, error: (error as Error).message });
  }
}

/** Opens the simulation at one of the job's events (an index into its event list). */
export async function showCheckEvent(job: JobRecord, index: number) {
  await openPlayer(job);
  usePlayer.setState({ panel: 'checks' });
  seekEvent(index);
}

/** Opens the simulation at the move a posted line made. */
export async function showLine(job: JobRecord, line: number) {
  await openPlayer(job);
  const motion = usePlayer.getState().player?.motion;
  const index = motion ? moveForLine(motion, line) : -1;
  if (index >= 0) usePlayer.setState({ position: index, playing: false, focus: null, panel: 'program' });
}

/** Opens the simulation at the end (the finished stock) with an inspection region picked and framed. */
export async function showInspectionRegion(job: JobRecord, index: number | null) {
  await openPlayer(job);
  const { player, show } = usePlayer.getState();
  if (!player?.inspection) return;
  usePlayer.setState({ position: player.motion?.count ?? 0, playing: false, focus: null, inspectionFocus: index, show: { ...show, inspection: true, stock: show.stock === 'off' ? 'translucent' : show.stock } });
  const region = index !== null ? player.inspection.regions[index] : null;
  const origin = player.origin ?? [0, 0, 0];
  if (region) {
    const box = new THREE.Box3(new THREE.Vector3(...region.bounds.minimum_mm).sub(new THREE.Vector3(...origin)), new THREE.Vector3(...region.bounds.maximum_mm).sub(new THREE.Vector3(...origin)));
    // A tiny region framed alone fills the screen: keep some of the part around it.
    box.expandByScalar(Math.max(5, box.getSize(new THREE.Vector3()).length()));
    viewer.frame(box);
  }
}

// Families, plain words and the summary: cam/checkSummary.ts (no browser needed, so it's tested on its own).
export { CHECK_WORDS, FAMILIES, STATUS_RANK, checkWords, familyOf, plainMessage, summarize, worst, type CheckSummary, type FamilyKey } from './checkSummary';

export const CUTTING_WORDS: Record<CuttingMetricId, { label: string; unit: string; digits: number }> = {
  spindle_rpm: { label: 'Spindle speed', unit: 'rpm', digits: 0 }, feed_per_tooth_mm: { label: 'Feed per tooth', unit: 'mm', digits: 4 },
  feed_per_revolution_mm: { label: 'Feed per revolution', unit: 'mm', digits: 4 }, nominal_surface_speed_m_min: { label: 'Surface speed', unit: 'm/min', digits: 1 },
};

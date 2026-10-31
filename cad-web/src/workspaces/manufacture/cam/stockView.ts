/**
 * How the player shows the stock: the fine display height field (heightfield.ts) when the job is 3-axis milling on a
 * stock the field can hold, else the engine's voxel stock as before. Engineers can always switch to the engine's own
 * stock ("Engine stock (checks)"), the grid every check ran on, and compare the display stock with the part.
 */
import { create } from 'zustand';
import { MOTION_FORMATS } from './motion';
import { assemblyProfile, millProfile, type CutterProfile, type RegionSegment } from './heightfield';
import type { Player } from './state';

/** One colour per operation, on the timeline's bands and on the surfaces each operation cut (never a status colour). */
export const OP_COLORS = ['#38bdf8', '#a78bfa', '#2dd4bf', '#f472b6', '#818cf8', '#c4a484'];

/** Compare-to-part colours: a diverging scale, neutral on size (gouge ← on size → stock left). */
export const DEVIATION_COLORS = { gougeFar: '#b2182b', gougeNear: '#ef8a62', onSize: '#d4d4d4', leftNear: '#67a9cf', leftFar: '#2166ac' } as const;
/** Allowed undercut and excess when the setup sets none (program.ts INSPECTION_DEFAULTS). */
export const COMPARE_DEFAULTS = { missing: 0.02, excess: 0.1 } as const;

export interface FieldStatus {
  /** Cell size (mm) and grid of the display field. */
  cell: number; nx: number; ny: number;
  /** Where the field has got to while it catches up with a seek (null: it shows the playback position). */
  cutting: number | null;
  /** Milliseconds the last worker slice took, and its cells visited. */
  ms: number; work: number;
  initial: 'box' | 'engine cells';
  /** The part's top surface is loaded for comparing (false: there's no part to compare with). */
  part: boolean | null;
}

export const useStockView = create<{
  /** Show the engine's voxel stock (the checks' own grid) instead of the display field. */
  engine: boolean;
  /** Colour the display stock by its height above the part's surface. */
  compare: boolean;
  status: FieldStatus | null;
  /** Why the display field couldn't be shown for a job (the engine's stock shows instead). */
  error: { job: string; message: string } | null;
}>(() => ({ engine: false, compare: false, status: null, error: null }));

export type FieldPlan =
  | { ok: true; min: number[]; max: number[]; cutters: CutterProfile[]; cutterOf: Map<number, number>; initial: 'box' | 'engine cells'; smallest: number; tolerance: { missing: number; excess: number } }
  | { ok: false; reason: string };

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-3);

/**
 * Whether the display field can show this job, and with what: a 3-axis linear milling program on a box stock (or a
 * carried stock the engine's initial cells give, with no undercuts), each tool's cutter from its assembly.
 */
export function fieldPlan(player: Player): FieldPlan {
  const preview = player.preview, motion = player.motion, setup = player.setup;
  if (!preview || !motion || !motion.count) return { ok: false, reason: 'no decoded motion' };
  if (!MOTION_FORMATS.includes(preview.format) || (preview.rotary_axes?.length ?? 0) > 0) return { ok: false, reason: 'not 3-axis linear milling' };
  const bounds = setup?.initial_stock_bounds;
  if (!bounds) return { ok: false, reason: 'no stock bounds' };
  const frozen = (setup as { setup?: { process?: string; stock?: { kind?: string }; stock_inspection?: { excess_tolerance_mm?: number; missing_tolerance_mm?: number } } }).setup;
  if (frozen?.process && frozen.process !== 'milling') return { ok: false, reason: `a ${frozen.process} setup` };
  const min = bounds.minimum_mm, max = bounds.maximum_mm;
  if (!(max[0] > min[0] && max[1] > min[1] && max[2] > min[2])) return { ok: false, reason: 'empty stock bounds' };
  // The initial stock: the whole box, or the cells the engine starts from (a carried stock; loaded by the caller).
  const first = preview.stock_checkpoints.find((checkpoint) => checkpoint.after_move < 0);
  const volume = (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  const measure = first?.snapshot.measure;
  const box = (!frozen?.stock?.kind || frozen.stock.kind === 'box') && (!measure || (near(measure.possible_material_mm3, volume) && measure.uncertain_cells === 0));
  if (!box && !first?.state) return { ok: false, reason: 'the starting stock isn’t a box and this job has no engine cells for it' };
  // Cutters by tool number (the assembly's cutting regions; a bare diameter as a flat end mill if that's all there is).
  const cutters: CutterProfile[] = [], cutterOf = new Map<number, number>();
  const used = new Set<number>();
  for (let i = 0; i < motion.count; i++) used.add(motion.tool[i]);
  for (const number of used) {
    const snapshot = player.tools[number] ?? (used.size === 1 ? player.tool : null);
    let profile = snapshot ? assemblyProfile(snapshot.geometry.regions as { role: string; segment: RegionSegment }[]) : null;
    if (!profile) {
      const diameter = setup?.controller.tools?.find((tool) => tool.tool_number === number)?.diameter_mm ?? (used.size === 1 ? setup?.controller.tool_diameter_mm : undefined);
      if (diameter && diameter > 0) profile = millProfile(diameter);
    }
    if (!profile) return { ok: false, reason: `no cutter geometry for T${number}` };
    cutterOf.set(number, cutters.length);
    cutters.push(profile);
  }
  const inspection = frozen?.stock_inspection;
  return {
    ok: true, min, max, cutters, cutterOf, initial: box ? 'box' : 'engine cells',
    smallest: Math.min(...cutters.map((cutter) => cutter.radius * 2)),
    tolerance: { missing: Number(inspection?.missing_tolerance_mm ?? COMPARE_DEFAULTS.missing), excess: Number(inspection?.excess_tolerance_mm ?? COMPARE_DEFAULTS.excess) },
  };
}

/** Where the compare colours saturate (mm either side): a few times the excess allowance, up to 2 mm or a quarter of the stock. */
export const compareRange = (plan: Extract<FieldPlan, { ok: true }>) => Math.max(4 * plan.tolerance.excess, Math.min(2, (plan.max[2] - plan.min[2]) / 4));

/**
 * The Rough tool's rules (docs/MANUFACTURING_ROUGHING.md, manufacturing/rough.py): the strategy a rough saves, and what
 * the engine refuses that the form can know before a run. Each refusal names the form section it belongs to and says
 * what to change; the form shows them as it is edited and Save refuses them, so the form never saves a rough the engine
 * refuses for these reasons. What depends on the part's geometry at each depth (an opening the part encloses, where a
 * helix fits, a depth above the part) is the engine's to find: its refusal comes back on the field it names.
 * Pure functions (tests/cam_rough_form_test.mjs runs them in Node).
 */

/** The draft fields a rough uses (cam/program.ts OperationDraft). */
export interface RoughDraft {
  top: number; bottom: number; clearance: number;
  stepover: number; stepdown: number; direction: 'climb' | 'conventional';
  radialAllowance: number; axialAllowance: number;
  entry: 'plunge' | 'ramp' | 'helix'; rampDeg: number; helixRadius: number | null;
  roughClearing: 'offset' | 'adaptive'; engagement: number;
  clearingTolerance: number; rpm: number; feed: number; plunge: number;
}

/** The chosen cutter as the form knows it (cam/program.ts cutterOf). */
export interface RoughCutter { diameter: number; cuttingLength: number; type: string; centerCutting: boolean }

/** A refusal: the form section ('passes', 'linking', 'heights', 'tool', 'feeds') and what to change. */
export interface RoughProblem { field: string; message: string }

const num = (value: number, digits = 3) => Number(value.toFixed(digits)).toString();

/**
 * The milling strategy a rough saves (programs.py MillingStrategy): the clearing fields only, defaults left out as the
 * server canonicalises. Entry is a plunge from outside the stock, or a helix (its angle, and its radius unless the
 * engine's half the cutter radius is kept) into openings the part encloses. An adaptive rough saves its
 * clearing and engagement instead of a stepover.
 */
export function roughStrategy(op: RoughDraft, common: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...common, kind: 'rough', plunge_mm_min: op.plunge, stepdown_mm: op.stepdown, stepover_mm: op.stepover,
    direction: op.direction, radial_allowance_mm: op.radialAllowance, axial_allowance_mm: op.axialAllowance,
    entry: op.entry === 'helix' ? 'helix' : 'plunge',
  };
  if (out.entry === 'helix') {
    out.ramp_angle_rad = op.rampDeg * Math.PI / 180;
    if (op.helixRadius !== null) out.helix_radius_mm = op.helixRadius;
  }
  if (op.roughClearing === 'adaptive') {
    delete out.stepover_mm;
    out.clearing = 'adaptive';
    out.max_radial_engagement_mm = op.engagement;
  }
  if (op.clearingTolerance !== 0.001) out.clearing_tolerance_mm = op.clearingTolerance;
  return out;
}

/**
 * What the engine refuses in this rough that the form can tell now, in the order the form shows its sections.
 * `stockTop`: the height the rough starts in material (the stock top, or the height a facing before it leaves).
 */
export function roughProblems(op: RoughDraft, cutter: RoughCutter | null, stockTop: number | null): RoughProblem[] {
  const out: RoughProblem[] = [];
  const add = (field: string, message: string) => out.push({ field, message });
  if (cutter && cutter.type !== 'flat_end_mill') add('tool', 'A rough cuts with a flat end mill: choose one.');
  else if (cutter && !cutter.centerCutting) add('tool', 'This cutter isn’t declared centre-cutting: a rough plunges and enters by helix, so it needs a centre-cutting flat end mill (its record’s Centre cutting).');
  // Heights: bottom < top < clearance, and the floor (bottom plus what's left on it) below the top.
  if (!(op.top < op.clearance)) add('heights', `The clearance (Z ${num(op.clearance)}) must be above the top (Z ${num(op.top)}).`);
  if (!(op.bottom < op.top)) add('heights', `The bottom (Z ${num(op.bottom)}) must be below the top (Z ${num(op.top)}).`);
  else if (!(op.bottom + op.axialAllowance < op.top)) add('heights', `The bottom plus what’s left on the floor (Z ${num(op.bottom + op.axialAllowance)}) must be below the top (Z ${num(op.top)}).`);
  if (stockTop !== null && stockTop > op.top + 1e-9) add('heights', `The stock reaches Z ${num(stockTop)}, above the top (Z ${num(op.top)}): start the rough at or above it.`);
  if (cutter && stockTop !== null && stockTop - op.bottom - op.axialAllowance > cutter.cuttingLength + 1e-9) {
    add('heights', `The deepest pass is ${num(stockTop - op.bottom - op.axialAllowance)} mm below the stock top, past the ${num(cutter.cuttingLength, 2)} mm flutes: the shank would be in the stock. Raise the bottom, or use a longer cutter.`);
  }
  // Passes: every step positive, the stepover at most the cutter radius (each ring reaches the stock between it and the next);
  // an adaptive rough's engagement instead: positive, at most the cutter radius and at least a hundredth of it.
  if (op.roughClearing === 'adaptive') {
    if (!(op.engagement > 0)) add('passes', 'The engagement must be more than zero.');
    else if (cutter && op.engagement > cutter.diameter / 2 + 1e-12) add('passes', `The engagement (${num(op.engagement)} mm) can’t be more than the cutter radius (${num(cutter.diameter / 2)} mm): wider is a slot across the cutter.`);
    else if (cutter && op.engagement < cutter.diameter / 200 - 1e-12) add('passes', `The engagement (${num(op.engagement)} mm) must be at least a hundredth of the cutter radius (${num(cutter.diameter / 200)} mm).`);
  } else if (!(op.stepover > 0)) add('passes', 'The stepover must be more than zero.');
  else if (cutter && op.stepover > cutter.diameter / 2 + 1e-12) add('passes', `The stepover (${num(op.stepover)} mm) can’t be more than the cutter radius (${num(cutter.diameter / 2)} mm): the stock between two passes would stay.`);
  if (!(op.stepdown > 0)) add('passes', 'The stepdown must be more than zero.');
  if (!(op.radialAllowance >= 0) || !(op.axialAllowance >= 0)) add('passes', 'What’s left on the walls and floor can’t be negative.');
  if (!(op.clearingTolerance >= 0.00001 && op.clearingTolerance <= 1)) add('passes', 'The tolerance is between 0.00001 and 1 mm.');
  // Entry: a plunge from outside the stock, or a helix (an angle between 0 and 90°, a radius at most the cutter radius).
  if (op.entry === 'ramp') add('linking', 'A rough enters from outside the stock (plunge) or by a helix: a ramp isn’t one of them.');
  if (op.entry === 'helix') {
    if (!(op.rampDeg > 0 && op.rampDeg < 90)) add('linking', 'The helix angle is between 0° and 90°.');
    if (op.helixRadius !== null && !(op.helixRadius > 0)) add('linking', 'The helix radius must be more than zero.');
    else if (op.helixRadius !== null && cutter && op.helixRadius > cutter.diameter / 2 + 1e-12) add('linking', `The helix radius (${num(op.helixRadius)} mm) can’t be more than the cutter radius (${num(cutter.diameter / 2)} mm): it would leave an uncut core.`);
  }
  if (!(op.rpm > 0) || !(op.feed > 0) || !(op.plunge > 0)) add('feeds', 'Spindle speed, cutting feed and plunge feed must be more than zero.');
  return out;
}

/** The depths a rough cuts at, top down (manufacturing/contour.py contour_depths): every stepdown, the last at the floor. */
export function roughDepths(op: Pick<RoughDraft, 'top' | 'bottom' | 'stepdown' | 'axialAllowance'>): number[] {
  const floor = op.bottom + op.axialAllowance;
  if (!(op.stepdown > 0) || !(floor < op.top)) return [];
  const count = Math.ceil((op.top - floor) / op.stepdown - 1e-9);
  if (count > 10_000) return [];
  return Array.from({ length: count }, (_, i) => Math.max(floor, op.top - (i + 1) * op.stepdown));
}

/**
 * Where the first depth that cuts stock lies above the part's top (`partTop`, from the displayed model): the engine
 * refuses that depth (rough_above_part), so a facing must take the stock down first. Null when it's fine or unknown.
 */
export function aboveThePart(op: Pick<RoughDraft, 'top' | 'bottom' | 'stepdown' | 'axialAllowance'>, stockTop: number | null, partTop: number | null): number | null {
  if (stockTop === null || partTop === null) return null;
  const first = roughDepths(op).find((depth) => depth < stockTop - 1e-9);
  return first !== undefined && first > partTop + 1e-6 ? first : null;
}

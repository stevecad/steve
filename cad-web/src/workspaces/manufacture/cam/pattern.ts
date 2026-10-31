/**
 * Operation patterns (docs/MANUFACTURING_PATTERNS.md): one authored operation repeated at linear-grid, circular or
 * explicit planar placements in setup XY (the design's own frame here), some instances suppressed. The saved source keeps
 * the one operation and its `pattern`; the engine expands it into stable, individually planned and checked instances
 * (each on its pinned target, on the stock the one before leaves). Placement maths here mirrors the engine's for drawing
 * only; instance IDs always come from the expansion endpoints, never from this file.
 */

export type PatternKind = 'linear' | 'circular' | 'placements';
export const PATTERN_LABEL: Record<PatternKind, string> = { linear: 'Linear', circular: 'Circular', placements: 'Placements' };

/** An explicit placement: rotate by `angleDeg` about `center`, then translate (setup XY, mm). */
export interface PlacementDraft { key: string; translation: [number, number]; center: [number, number]; angleDeg: number }

export interface PatternDraft {
  kind: PatternKind;
  /** Linear grid: U varies first; instance keys u<i>_v<j>. */
  countU: number; stepU: [number, number]; countV: number; stepV: [number, number];
  /** Circular: keys r<i>, instance zero is the seed; positive steps turn counterclockwise. */
  count: number; center: [number, number]; angleStepDeg: number;
  placements: PlacementDraft[];
  /** Keys left out (at least one instance stays active). */
  suppress: string[];
  /** Per-instance replacement targets saved by code: kept as they are (this form doesn't edit them). */
  overrides: Record<string, unknown[]>;
}

/** One placement in the engine's order (suppressed ones included): a rotation about `center`, then a translation. */
export interface PatternInstance { key: string; translation: [number, number]; center: [number, number]; angle: number }

const DEG = Math.PI / 180;

/** A new pattern; a circular one turns about `center` (the seed feature's centre makes a bolt circle easy to set). */
export function newPattern(kind: PatternKind, center: [number, number] = [0, 0]): PatternDraft {
  return {
    kind, countU: 2, stepU: [20, 0], countV: 1, stepV: [0, 20], count: 4, center, angleStepDeg: 90,
    placements: [{ key: 'p1', translation: [0, 0], center: [0, 0], angleDeg: 0 }, { key: 'p2', translation: [20, 0], center: [0, 0], angleDeg: 0 }],
    suppress: [], overrides: {},
  };
}

/** Another layout for the same pattern: each layout keeps its own fields; suppression names the old layout's keys. */
export const switchPattern = (previous: PatternDraft, kind: PatternKind): PatternDraft => ({ ...previous, kind, suppress: previous.kind === kind ? previous.suppress : [] });

export function instancesOf(pattern: PatternDraft): PatternInstance[] {
  if (pattern.kind === 'linear') {
    const out: PatternInstance[] = [];
    for (let j = 0; j < Math.max(1, Math.floor(pattern.countV)); j += 1) {
      for (let i = 0; i < Math.max(1, Math.floor(pattern.countU)); i += 1) {
        out.push({ key: `u${i}_v${j}`, translation: [i * pattern.stepU[0] + j * pattern.stepV[0], i * pattern.stepU[1] + j * pattern.stepV[1]], center: [0, 0], angle: 0 });
      }
    }
    return out;
  }
  if (pattern.kind === 'circular') {
    return Array.from({ length: Math.max(1, Math.floor(pattern.count)) }, (_, i) => ({ key: `r${i}`, translation: [0, 0], center: pattern.center, angle: i * pattern.angleStepDeg * DEG }));
  }
  return pattern.placements.map((item) => ({ key: item.key, translation: item.translation, center: item.center, angle: item.angleDeg * DEG }));
}

/** Where a seed point lands for an instance (the engine's `Placement.point`). */
export function placePoint(instance: PatternInstance, [x, y]: [number, number]): [number, number] {
  const c = Math.cos(instance.angle), s = Math.sin(instance.angle);
  const dx = x - instance.center[0], dy = y - instance.center[1];
  return [c * dx - s * dy + instance.center[0] + instance.translation[0], s * dx + c * dy + instance.center[1] + instance.translation[1]];
}

const pair = (value: unknown, fallback: [number, number] = [0, 0]): [number, number] =>
  (Array.isArray(value) && value.length === 2 ? [Number(value[0]), Number(value[1])] : fallback);
const round = (value: number) => Number(value.toFixed(9));

/** The saved `pattern` field (null: no pattern). */
export function patternJson(pattern: PatternDraft | null): Record<string, unknown> | null {
  if (!pattern) return null;
  const layout = pattern.kind === 'linear'
    ? { kind: 'linear', count_u: Math.floor(pattern.countU), step_u_mm: pattern.stepU, count_v: Math.floor(pattern.countV), step_v_mm: pattern.stepV }
    : pattern.kind === 'circular'
      ? { kind: 'circular', count: Math.floor(pattern.count), center_mm: pattern.center, angle_step_rad: round(pattern.angleStepDeg * DEG) }
      : { kind: 'placements', instances: pattern.placements.map((item) => ({ key: item.key, translation_mm: item.translation, center_mm: item.center, angle_rad: round(item.angleDeg * DEG) })) };
  const keys = new Set(instancesOf(pattern).map((item) => item.key));
  const overrides = Object.fromEntries(Object.entries(pattern.overrides).filter(([key]) => keys.has(key) && !pattern.suppress.includes(key)));
  return { layout, suppress: pattern.suppress.filter((key) => keys.has(key)), ...(Object.keys(overrides).length ? { target_overrides: overrides } : {}) };
}

export function patternDraftOf(value: unknown): PatternDraft | null {
  if (!value || typeof value !== 'object') return null;
  const json = value as { layout?: Record<string, unknown>; suppress?: unknown[]; target_overrides?: Record<string, unknown[]> };
  const layout = json.layout ?? {};
  const kind: PatternKind = layout.kind === 'circular' ? 'circular' : layout.kind === 'placements' ? 'placements' : 'linear';
  const draft = newPattern(kind);
  const placements = ((layout.instances as Record<string, unknown>[] | undefined) ?? []).map((item) => ({
    key: String(item.key), translation: pair(item.translation_mm), center: pair(item.center_mm), angleDeg: round(Number(item.angle_rad ?? 0) / DEG),
  }));
  return {
    ...draft,
    ...(kind === 'linear' ? { countU: Number(layout.count_u ?? 1), stepU: pair(layout.step_u_mm), countV: Number(layout.count_v ?? 1), stepV: pair(layout.step_v_mm) } : {}),
    ...(kind === 'circular' ? { count: Number(layout.count ?? 1), center: pair(layout.center_mm), angleStepDeg: round(Number(layout.angle_step_rad ?? 0) / DEG) } : {}),
    ...(kind === 'placements' ? { placements } : {}),
    suppress: (json.suppress ?? []).map(String),
    overrides: json.target_overrides ?? {},
  };
}

/** What the engine would reject, said before saving (hints: its own validation is the answer). */
export function patternProblem(pattern: PatternDraft): string | null {
  const all = instancesOf(pattern);
  if (pattern.kind === 'linear') {
    if (pattern.countU < 1 || pattern.countV < 1) return 'Counts start at 1.';
    if (pattern.countU * pattern.countV > 1000) return 'A pattern has at most 1,000 instances.';
    if (pattern.countU > 1 && Math.hypot(...pattern.stepU) < 1e-6) return 'Repeating along U needs a spacing.';
    if (pattern.countV > 1 && Math.hypot(...pattern.stepV) < 1e-6) return 'Repeating along V needs a spacing.';
  } else if (pattern.kind === 'circular') {
    if (pattern.count < 1 || pattern.count > 1000) return 'Between 1 and 1,000 instances.';
    if (pattern.count > 1 && Math.abs(pattern.angleStepDeg) < 1e-9) return 'Repeating needs an angle step.';
    if (Math.abs(pattern.angleStepDeg * (pattern.count - 1)) > 360 + 1e-9) return 'The instances stay within one turn of the seed: lower the count or the step.';
  } else {
    if (!pattern.placements.length) return 'Add a placement.';
    if (new Set(pattern.placements.map((item) => item.key)).size !== pattern.placements.length) return 'Each placement needs its own name.';
    if (pattern.placements.some((item) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(item.key))) return 'Placement names: a letter, then letters, digits, _ or -.';
    if (pattern.placements.some((item) => Math.abs(item.angleDeg) > 360)) return 'Placement angles stay within one turn.';
  }
  if (all.every((item) => pattern.suppress.includes(item.key))) return 'Leave at least one instance active.';
  // Two active instances in the same place would cut the same thing twice (the engine rejects it).
  const seen = new Set<string>();
  for (const instance of all) {
    if (pattern.suppress.includes(instance.key) || pattern.overrides[instance.key]) continue;
    const signature = [placePoint(instance, [0, 0]), placePoint(instance, [1, 0])].flat().map((v) => v.toFixed(6)).join(',');
    if (seen.has(signature)) return `Instance ${instance.key} lands exactly on another one.`;
    seen.add(signature);
  }
  return null;
}

/** Instances that will run (not suppressed), in order. */
export const activeInstances = (pattern: PatternDraft) => instancesOf(pattern).filter((item) => !pattern.suppress.includes(item.key));

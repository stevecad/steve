/**
 * Sketch tools. Each click turns into statements (geometry plus the constraints the user
 * implied by snapping), so what they draw is exactly what the code says.
 */
import { evaluate, evaluateLength, lengthSource } from '@/lib/modeling';
import { inUnits, lengthDigits, type Units } from '@/lib/format';
import { ANGLE_UNITS, hasLengthUnit, lengthHint } from '@/lib/lengths';
import { setting } from '@/settings/store';
import * as THREE from 'three';
import { get as app, set as setApp, useApp, type Pick } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { axisHits, closestOnSegment, hitCandidates, hitTest, type Hit } from './geometry';
import {
  DIMENSION_OPS, expand, FIXED, GEOMETRY_OPS, lit, points as pointMap, projections, scaleEntities, setProjections, stmt, writeBack,
  type Arg, type Constraint, type Entity, type Stmt, type XY,
} from './model';
import { laterThan, pickCurves, projectCurve, sketchCurves, withIds, type Shape } from './project';
import { sketchPlane } from './actions';
import { trim, trimPreview } from './trim';
import { constraintDown, constraintEscape, constraintMove, constraintOf } from './constraintTool';
import { refSource } from '@/state/designRefs';
import { addStatements, commit, entityOf, nextEntityId, sketch, useSketch, type HeadsField, type Hint, type ToolId } from './session';

export interface Pointer { p: XY; tol: number; shift: boolean; alt: boolean; ctrl: boolean; client?: [number, number] }

interface Snap {
  at: XY; point?: string; on?: string; midpointOf?: string; hints: Hint[];
  /** The new segment's direction, inferred against another curve. (Its own horizontal/vertical are read from its ends.) */
  direction?: { kind: 'parallel' | 'perpendicular' | 'tangent'; ref: string; at?: string };
  /** Existing points the new point lines up with: on the same horizontal (`h`) or vertical (`v`). */
  align?: { h?: string; v?: string };
}

/** What the segment leaving the last click may line up with: the curve it leaves (tangent), and reference lines.
 *  `own`: whether the segment itself can be horizontal/vertical (a line's can; a spline's control polygon can't). */
interface Directions { tangent?: { ref: string; at: string; dir: XY }; refs: string[]; own?: boolean }

const ALIGN = (3 * Math.PI) / 180;
const rnd = (v: number) => Math.round(v * 1e9) / 1e9;
const pt = (p: XY): XY => [rnd(p[0]), rnd(p[1])];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

let clicks: Snap[] = [];
/** A press on geometry: what was grabbed, the statements and exact solved entities at the start, and (once known) the points that pin its shape. */
let dragging: { ref: string; kind: 'point' | 'entity'; from: XY; base: Stmt[]; exact: Entity[] | null; pins?: string[] } | null = null;

/** Lines the pointer passed over lately, newest first: what a new line can be drawn parallel or perpendicular to. */
let recent: string[] = [];

/**
 * Where the cursor lands, in priority order: an existing point, a line's midpoint, a curve, or free space. In free space
 * the segment from `from` holds to a direction within ALIGN (tangent to the curve it leaves, horizontal/vertical, or
 * parallel/perpendicular to a reference line), and the point lines up with other points along dashed guides. Every
 * inference is a hint (a glyph, a guide); what is shown at the click is exactly what becomes constraints.
 */
export function snap(ptr: Pointer, from?: XY, exclude: Set<string> = new Set(), directions?: Directions, guides = true): Snap {
  const entities = [...sketch().expansion.entities];
  if (ptr.alt) return { at: ptr.p, hints: [] };
  const hit = hitTest(ptr.p, ptr.tol, entities, exclude);
  if (hit?.kind === 'point') return { at: hit.at, point: hit.ref, hints: [{ kind: 'snap', at: hit.at, ref: hit.ref }] };
  for (const e of entities) {
    if (e.type !== 'line' || exclude.has(e.id)) continue;
    const mid: XY = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2];
    if (dist(mid, ptr.p) <= ptr.tol) return { at: mid, midpointOf: e.id, hints: [{ kind: 'midpoint', at: mid, ref: e.id }] };
  }
  if (hit?.kind === 'entity') return { at: hit.at, on: hit.ref, hints: [{ kind: 'on_curve', at: hit.at, ref: hit.ref }] };
  let at = ptr.p;
  const hints: Hint[] = [];
  let direction: Snap['direction'];
  let along: XY | null = null;
  if (from && dist(at, from) > ptr.tol * 0.5) {
    const angle = Math.atan2(at[1] - from[1], at[0] - from[0]);
    // Lines have no sense: a direction matches its reverse too.
    const off = (a: number) => { const d = Math.abs(Math.atan2(Math.sin(angle - a), Math.cos(angle - a))); return Math.min(d, Math.PI - d); };
    const lineAngle = (ref: string) => { const e = entities.find((x) => x.id === ref); return e?.type === 'line' ? Math.atan2(e.end[1] - e.start[1], e.end[0] - e.start[0]) : null; };
    type Candidate = { kind: 'tangent' | 'horizontal' | 'vertical' | 'parallel' | 'perpendicular'; angle: number; ref?: string; at?: string };
    // Tangent to the curve the segment leaves comes first (it is the more specific intent), then the segment's own
    // horizontal/vertical, then parallel/perpendicular to the reference lines, newest first.
    const candidates: Candidate[] = [
      ...(directions?.tangent ? [{ kind: 'tangent' as const, angle: Math.atan2(directions.tangent.dir[1], directions.tangent.dir[0]), ref: directions.tangent.ref, at: directions.tangent.at }] : []),
      ...(directions?.own === false ? [] : [{ kind: 'horizontal' as const, angle: 0 }, { kind: 'vertical' as const, angle: Math.PI / 2 }]),
      ...(directions?.refs ?? []).filter((ref) => !exclude.has(ref)).flatMap((ref) => {
        const a = lineAngle(ref);
        return a === null ? [] : [{ kind: 'parallel' as const, angle: a, ref }, { kind: 'perpendicular' as const, angle: a + Math.PI / 2, ref }];
      }),
    ];
    const chosen = candidates.find((c) => off(c.angle) < ALIGN);
    if (chosen) {
      const u: XY = [Math.cos(chosen.angle), Math.sin(chosen.angle)];
      const t = (at[0] - from[0]) * u[0] + (at[1] - from[1]) * u[1];
      at = chosen.kind === 'horizontal' ? [at[0], from[1]] : chosen.kind === 'vertical' ? [from[0], at[1]] : [from[0] + u[0] * t, from[1] + u[1] * t];
      along = chosen.kind === 'horizontal' ? [1, 0] : chosen.kind === 'vertical' ? [0, 1] : u;
      hints.push({ kind: chosen.kind, at, from, ref: chosen.ref });
      if (chosen.ref && chosen.kind !== 'horizontal' && chosen.kind !== 'vertical') direction = { kind: chosen.kind, ref: chosen.ref, at: chosen.at };
    }
  }
  const lined = guides ? alignment(ptr, at, from, along, entities, exclude) : null;
  if (lined) {
    at = lined.at;
    for (const h of hints) h.at = at;
    hints.push(...lined.hints);
  }
  return { at, hints, direction, align: lined?.align };
}

/**
 * Dashed guides to points the cursor lines up with: one on the same vertical, one on the same horizontal (their
 * crossing takes both). With the segment held to a direction, only a guide that crosses it near the cursor counts.
 */
function alignment(ptr: Pointer, at: XY, from: XY | undefined, along: XY | null, entities: Entity[], exclude: Set<string>):
  { at: XY; hints: Hint[]; align: { h?: string; v?: string } } | null {
  const reach = ptr.tol;
  // Spline control poles aren't on the curve; a point at the start of the segment is the segment's own H/V.
  const points = [...pointMap(entities)].filter(([ref, p]) => !/\.pole\d+$/.test(ref) && !exclude.has(entityOf(ref, entities) ?? ref)
    && !(from && dist(p, from) < 1e-9) && dist(p, at) > reach);
  const on = (axis: 0 | 1) => {
    // `axis` 0: the guide is vertical (same x); 1: horizontal (same y). The nearest point wins among equal offsets.
    let best: { ref: string; p: XY; at: XY; off: number } | null = null;
    for (const [ref, p] of points) {
      let target: XY;
      if (along && from) {
        if (Math.abs(along[axis]) < 1e-9) continue;  // The held direction runs along this guide: it can't cross it.
        const t = (p[axis] - from[axis]) / along[axis];
        target = [from[0] + along[0] * t, from[1] + along[1] * t];
      } else target = axis === 0 ? [p[0], at[1]] : [at[0], p[1]];
      const off = dist(target, at);
      if (off >= reach) continue;
      if (!best || off < best.off - 1e-9 || (Math.abs(off - best.off) <= 1e-9 && dist(p, at) < dist(best.p, at))) best = { ref, p, at: target, off };
    }
    return best;
  };
  const v = on(0), h = on(1);
  if (!v && !h) return null;
  if (along) {
    // Held to a direction: only the closer guide (two guides and a direction can't all hold).
    const one = !h || (v && v.off <= h.off) ? v! : h;
    const kind = one === v ? 'align_v' : 'align_h';
    return { at: one.at, hints: [{ kind, at: one.at, from: one.p, ref: one.ref }], align: kind === 'align_v' ? { v: one.ref } : { h: one.ref } };
  }
  const next: XY = [v ? v.p[0] : at[0], h ? h.p[1] : at[1]];
  return {
    at: next,
    hints: [...(v ? [{ kind: 'align_v' as const, at: next, from: v.p, ref: v.ref }] : []), ...(h ? [{ kind: 'align_h' as const, at: next, from: h.p, ref: h.ref }] : [])],
    align: { ...(v ? { v: v.ref } : {}), ...(h ? { h: h.ref } : {}) },
  };
}

/** Constraints that tie a new point to what it snapped to, or line it up with the points it was aligned to. */
function tie(target: string, s: Snap): Stmt[] {
  if (s.point) return [stmt('coincident', [lit(s.point), lit(target)])];
  if (s.midpointOf) return [stmt('midpoint', [lit(target), lit(s.midpointOf)])];
  if (s.on) return [stmt('point_on', [lit(target), lit(s.on)])];
  return [
    ...(s.align?.v ? [stmt('vertical', [lit(s.align.v), lit(target)])] : []),
    ...(s.align?.h ? [stmt('horizontal', [lit(s.align.h), lit(target)])] : []),
  ];
}

/** The constraint a new segment's inferred direction adds (`id` is the new line or spline). */
function directed(id: string, s: Snap): Stmt[] {
  const d = s.direction;
  if (!d) return [];
  if (d.kind === 'tangent') return [stmt('tangent', [lit(d.ref), lit(id)], d.at ? { at: lit(d.at) } : {})];
  return [stmt(d.kind, [lit(d.ref), lit(id)])];
}

/** A circle, arc or polygon centered on another circle's or arc's center: concentric (the curve it shares it with). */
function concentricWith(s: Snap): string | null {
  if (!s.point?.endsWith('.center')) return null;
  const id = entityOf(s.point);
  const e = id ? sketch().expansion.entities.find((x) => x.id === id) : null;
  return e && (e.type === 'circle' || e.type === 'arc') ? e.id : null;
}

/**
 * What the segment leaving `click` can line up with: the curve it leaves at an end (tangent: always to an arc; to a
 * line only for a spline, which can't be "parallel") and, for a line, the reference lines.
 */
function directionsFrom(click: Snap | undefined, chained: string | null, curve = false): Directions {
  const entities = sketch().expansion.entities;
  const refs = [...recent];
  let tangent: Directions['tangent'];
  const end = click?.point && /\.(start|end)$/.test(click.point) ? click.point : null;
  const owner = end ? entities.find((e) => e.id === entityOf(end, entities)) : null;
  if (owner?.type === 'line' && end) {
    if (curve) tangent = { ref: owner.id, at: end, dir: [owner.end[0] - owner.start[0], owner.end[1] - owner.start[1]] };
    else refs.unshift(owner.id);  // The line it starts from: perpendicular to it is the common case.
  }
  if (owner?.type === 'arc' && end) {
    const p = pointMap([owner]).get(end)!;
    tangent = { ref: owner.id, at: end, dir: [-(p[1] - owner.center[1]), p[0] - owner.center[0]] };
  }
  if (chained) refs.unshift(chained);  // A chain's previous segment.
  return curve ? { tangent, refs: [], own: false } : { tangent, refs: [...new Set(refs)] };
}

/**
 * The snap for the tool's next click. A line's segment infers its direction; a spline's first span can leave a curve
 * tangentially, and its later poles place freely (they're control points: only its ends are tied); a circle, arc or
 * polygon centered on another circle's or arc's center is concentric with it.
 */
function snapFor(tool: ToolId, ptr: Pointer): Snap {
  const last = clicks.at(-1);
  const from = last?.at;
  if (tool === 'line') {
    const s = snap(ptr, from, new Set(), from ? directionsFrom(last, clicks.length >= 2 && lastLineEnd ? entityOf(lastLineEnd) : null) : undefined);
    // Ending on a point, a midpoint or a curve exactly level with (or above) the start: horizontal (vertical) too, shown.
    if (from && !ptr.alt && (s.point || s.midpointOf || s.on) && dist(s.at, from) > 1e-9) {
      if (Math.abs(s.at[1] - from[1]) < 1e-9) s.hints.push({ kind: 'horizontal', at: s.at, from });
      else if (Math.abs(s.at[0] - from[0]) < 1e-9) s.hints.push({ kind: 'vertical', at: s.at, from });
    }
    return s;
  }
  if (tool === 'spline') {
    if (!clicks.length) return snap(ptr);
    const directions = clicks.length === 1 ? directionsFrom(last, null, true) : null;
    return snap(ptr, directions?.tangent ? from : undefined, new Set(), directions ?? undefined, false);
  }
  const s = snap(ptr);
  if ((tool === 'circle' || tool === 'arc_center' || tool === 'polygon') && !clicks.length) {
    const other = concentricWith(s);
    if (other) return { ...s, hints: [{ kind: 'concentric', at: s.at, ref: other }] };
  }
  return s;
}

/** The line or arc a 3-point arc starts from at its end, when it leaves it tangentially (within 5°). */
function tangentSource(start: Snap | undefined, arc: { center: XY }): Entity | null {
  const end = start?.point && /\.(start|end)$/.test(start.point) ? start.point : null;
  const prev = end ? sketch().expansion.entities.find((e) => e.id === entityOf(end)) : null;
  if (!prev || !start) return null;
  if (prev.type === 'line') return isTangent(prev, arc, start.at) ? prev : null;
  if (prev.type === 'arc') {
    // Two arcs are tangent at a shared point when their radii there lie on one line.
    const a: XY = [start.at[0] - prev.center[0], start.at[1] - prev.center[1]], b: XY = [start.at[0] - arc.center[0], start.at[1] - arc.center[1]];
    const sin = Math.abs(a[0] * b[1] - a[1] * b[0]) / (Math.hypot(...a) * Math.hypot(...b) || 1);
    return sin < Math.sin((5 * Math.PI) / 180) ? prev : null;
  }
  return null;
}

/** Remembers lines under the pointer as references for parallel/perpendicular (a few, newest first). */
function noteReferences(ptr: Pointer) {
  const entities = sketch().expansion.entities;
  for (const c of hitCandidates(ptr.p, ptr.tol, entities)) {
    const id = c.kind === 'entity' ? c.ref : entityOf(c.ref, entities);
    if (!id || entities.find((e) => e.id === id)?.type !== 'line') continue;
    recent = [id, ...recent.filter((ref) => ref !== id)].slice(0, 3);
    return;
  }
}

/** Where a key of a statement that never carries geometry (a constraint) lives: the same through solves and write-backs. */
const keyOf = (s: Stmt) => `${s.op}(${s.args.map((a) => a.source).join(',')};${Object.entries(s.kwargs).map(([k, a]) => `${k}=${a.source}`).join(',')})`;

/**
 * Adds a click's statements at once (entity ids stay sequential however fast the clicks come), then takes back the
 * inferred constraints the solver finds would over-constrain the sketch (redundant or conflicting), without an undo
 * step of their own. They're tried one by one, in priority order, against the sketch as it was plus the new geometry.
 */
function place(fixed: Stmt[], inferred: Stmt[]): Promise<void> {
  const base = sketch().statements;
  return settle(base, fixed, inferred, addStatements(...fixed, ...inferred));
}

/** Takes back, once `added` is committed, the inferred constraints that over-constrain `base` plus `fixed`. */
function settle(base: Stmt[], fixed: Stmt[], inferred: Stmt[], added: Promise<void>): Promise<void> {
  if (!inferred.length) return added;
  return Promise.all([added, overconstraining(base, fixed, inferred)]).then(async ([, drop]) => {
    if (!drop.length) return;
    const statements = [...sketch().statements];
    for (const s of drop) {
      const key = keyOf(s);
      for (let i = statements.length - 1; i >= 0; i--) if (keyOf(statements[i]) === key) { statements.splice(i, 1); break; }
    }
    if (statements.length !== sketch().statements.length) await commit(statements, { undoable: false, message: sketch().message });
  });
}

/** Inferred constraints that add redundancy or a conflict (as the solver diagnoses them), tried in order. */
async function overconstraining(base: Stmt[], fixed: Stmt[], inferred: Stmt[]): Promise<Stmt[]> {
  const { solveSketch } = await import('./solve');
  const over = async (statements: Stmt[]) => {
    const result = await solveSketch(expand(statements));
    return result.status === 'unsolved' ? null : result.status === 'failed' ? Infinity : result.redundant.length + result.conflicting.length;
  };
  let current = await over([...base, ...fixed]);
  if (current === null) return [];  // No solver: keep what was shown.
  const kept: Stmt[] = [], drop: Stmt[] = [];
  for (const s of inferred) {
    const n = await over([...base, ...fixed, ...kept, s]);
    if (n !== null && n <= current) { kept.push(s); current = n; } else drop.push(s);
  }
  return drop;
}

const construction = (): Record<string, ReturnType<typeof lit>> => (sketch().construction ? { construction: lit(true) } : {});

/** In-progress geometry, with the points already clicked (a center, a first corner) marked. */
function preview(entities: Entity[], hints: Hint[] = []) {
  const anchors: Entity[] = clicks.map((k, i) => ({ id: `~k${i}`, type: 'point', at: k.at }));
  useSketch.setState({ preview: [...entities, ...anchors], hints });
}

export function setTool(tool: ToolId) {
  clicks = [];
  pendingDims = [];
  dragging = null;
  dimensionPick = [];
  placingPicks = [];
  useSketch.setState({ tool, preview: [], hints: [], editing: null, placing: null, fields: [], typed: {}, fieldFocus: null, message: TOOL_HINTS[tool] ?? null });
}

/* ───────── heads-up sizes: type a length while drawing ───────── */

let lastPtr: Pointer | null = null;

interface TypedDim { key: string; source: string; value: number; at: XY }

function typed(key: string): number | null {
  const t = sketch().typed[key];
  return t && t.value !== null && Number.isFinite(t.value) ? t.value : null;
}

const anyTyped = () => Object.values(sketch().typed).some((t) => t.value !== null);

/** A draft must be corrected or cleared, never silently replaced by the cursor's measured size. */
function invalidSize(): string | null {
  const { fields, typed: entries } = sketch();
  const field = fields.find((f) => {
    const entry = entries[f.key];
    return entry && (entry.value === null || !Number.isFinite(entry.value) || (!f.angle && entry.value <= 0));
  });
  if (!field) return null;
  const name = ({ length: 'Length', width: 'Width', height: 'Height', diameter: 'Diameter', radius: 'Radius', angle: 'Angle' } as Record<string, string>)[field.key] ?? field.label;
  return field.angle ? `${name}: enter a valid angle in degrees, or clear the field to use the pointer.`
    : `${name}: enter a positive size or parameter expression, or clear the field to use the pointer.`;
}

function sizesReady(): boolean {
  const message = invalidSize();
  if (!message) return true;
  useSketch.setState({ message });
  return false;
}

/** Where the next click lands once typed sizes are applied (the cursor only sets direction), and the inputs to show. */
function sized(tool: ToolId, cursor: XY, px: number): { at: XY; fields: HeadsField[] } | null {
  const anchor = clicks.at(-1)?.at;
  if (!anchor) return null;
  const stage = clicks.length;
  const off = 26 * px;
  const d: XY = [cursor[0] - anchor[0], cursor[1] - anchor[1]];
  const sx = Math.sign(d[0]) || 1, sy = Math.sign(d[1]) || 1;
  switch (tool) {
    case 'line': case 'slot': {
      if (tool === 'slot' && stage !== 1) return null;
      const angle = typed('angle') !== null ? (typed('angle')! * Math.PI) / 180 : Math.atan2(d[1], d[0]);
      const length = typed('length') ?? Math.hypot(d[0], d[1]);
      const u: XY = [Math.cos(angle), Math.sin(angle)], n: XY = [-u[1], u[0]];
      const at: XY = [anchor[0] + u[0] * length, anchor[1] + u[1] * length];
      return { at, fields: [
        { key: 'length', label: 'L', measured: length, at: [(anchor[0] + at[0]) / 2 + n[0] * off, (anchor[1] + at[1]) / 2 + n[1] * off] },
        { key: 'angle', label: '∠', measured: ((deg(angle) % 360) + 360) % 360, at: [anchor[0] - u[0] * off * 1.5, anchor[1] - u[1] * off * 1.5], angle: true },
      ] };
    }
    case 'rect': case 'center_rect': {
      if (stage !== 1) return null;
      const half = tool === 'center_rect' ? 2 : 1;
      const w = typed('width') ?? Math.abs(d[0]) * half, h = typed('height') ?? Math.abs(d[1]) * half;
      const at: XY = [anchor[0] + (sx * w) / half, anchor[1] + (sy * h) / half];
      const cx = tool === 'center_rect' ? anchor[0] : (anchor[0] + at[0]) / 2, cy = tool === 'center_rect' ? anchor[1] : (anchor[1] + at[1]) / 2;
      return { at, fields: [
        { key: 'width', label: 'W', measured: w, at: [cx, at[1] + sy * off] },
        { key: 'height', label: 'H', measured: h, at: [at[0] + sx * off * 1.7, cy] },
      ] };
    }
    case 'circle': case 'polygon': case 'arc_center': {
      if (stage !== 1) return null;
      const u: XY = Math.hypot(d[0], d[1]) > 1e-12 ? [d[0] / Math.hypot(d[0], d[1]), d[1] / Math.hypot(d[0], d[1])] : [1, 0];
      const diameter = tool === 'circle';
      const r = diameter ? (typed('diameter') !== null ? typed('diameter')! / 2 : Math.hypot(d[0], d[1])) : typed('radius') ?? Math.hypot(d[0], d[1]);
      // Out past the cursor far enough that the field (about 80×24 px, centered there) never covers it: the next click
      // lands where the cursor is, and would focus the field instead of placing the shape if the field were under it.
      const clear = (12 + Math.abs(u[0]) * 44 + Math.abs(u[1]) * 14) * px;
      return { at: [anchor[0] + u[0] * r, anchor[1] + u[1] * r], fields: [{ key: diameter ? 'diameter' : 'radius', label: diameter ? 'Ø' : 'R', measured: diameter ? 2 * r : r, at: [anchor[0] + u[0] * (r + clear), anchor[1] + u[1] * (r + clear)] }] };
    }
    default: return null;
  }
}

/** The typed sizes as dimensions on the shape just created, labelled where their inputs were. */
function typedDimensions(tool: ToolId, id: string, dims: TypedDim[]): Stmt[] {
  const out: Stmt[] = [];
  for (const d of dims) {
    const value = { source: d.source, value: d.value };
    const kw = { label: lit(label(d.at)) };
    switch (`${tool}:${d.key}`) {
      case 'line:length': out.push(stmt('length', [lit(id), value], kw)); break;
      case 'line:angle': out.push(stmt('angle', [lit(id), value], kw)); break;
      case 'rect:width': case 'center_rect:width': out.push(stmt('horizontal_distance', [lit(`${id}.bottom.start`), lit(`${id}.bottom.end`), value], kw)); break;
      case 'rect:height': case 'center_rect:height': out.push(stmt('vertical_distance', [lit(`${id}.right.start`), lit(`${id}.right.end`), value], kw)); break;
      case 'circle:diameter': out.push(stmt('diameter', [lit(id), value], kw)); break;
      case 'polygon:radius': out.push(stmt('radius', [lit(`${id}.circle`), value], kw)); break;
      case 'arc_center:radius': out.push(stmt('radius', [lit(id), value], kw)); break;
      case 'slot:length': out.push(stmt('distance', [lit(`${id}.start_arc.center`), lit(`${id}.end_arc.center`), value], kw)); break;
      case 'slot:angle': out.push(stmt('angle', [lit(`${id}.axis`), value], kw)); break;
      default: break;
    }
  }
  return out;
}

/**
 * A typed size or dimension as the code to write and its value (mm or degrees), or null when it doesn't read. A length
 * is written in millimetres (lib/lengths.ts): `2` typed in inches as `50.8`, `1in` as `25.4`, `width + 1in` as
 * `width + (1 * 25.4)`, so a parameter stays linked; an angle as typed.
 */
function typedCode(text: string, angle: boolean | undefined): { source: string; value: number } | null {
  const doc = app().modeling;
  const source = angle ? text.trim() : lengthSource(text, setting('display.units'), doc);
  const value = evaluate(source, doc);
  return value === null ? null : { source, value };
}

/** Typed sizes to turn into dimensions when the click lands, then cleared for the next shape. */
function takeTyped(): TypedDim[] {
  const { typed: values, fields } = sketch();
  const dims = fields.flatMap((f) => {
    const t = values[f.key];
    const written = t && t.value !== null ? typedCode(t.source, f.angle) : null;
    return written ? [{ key: f.key, ...written, at: f.at }] : [];
  });
  useSketch.setState({ typed: {}, fields: [] });
  return dims;
}

/** A heads-up input changed: re-size the preview right away. */
export function setTyped(key: string, source: string, value: number | null) {
  const next = { ...sketch().typed };
  const angle = sketch().fields.find((f) => f.key === key)?.angle;
  if (value !== null && (!Number.isFinite(value) || (!angle && value <= 0))) value = null;
  if (source.trim() === '') delete next[key]; else next[key] = { source, value };
  useSketch.setState({ typed: next });
  useSketch.setState({ message: invalidSize() ?? TOOL_HINTS[sketch().tool] ?? null });
  if (lastPtr) move(lastPtr);
}

/** A heads-up size typed as text: an angle in degrees, a length in the units the status bar shows (a unit typed after it wins), kept as mm. */
export function typeSize(key: string, text: string) {
  const angle = sketch().fields.find((f) => f.key === key)?.angle;
  const doc = app().modeling;
  setTyped(key, text, !text.trim() ? null : angle ? evaluate(text, doc) : evaluateLength(text, setting('display.units'), doc));
}

/** A heads-up size as its field shows it before anything is typed: degrees, or a length in the units the status bar shows. */
export const measuredText = (field: HeadsField, units: Units) =>
  `${Number(field.angle ? field.measured.toFixed(1) : inUnits(field.measured, units).toFixed(lengthDigits(units)))}`;

/** Redraws the shape in progress after an option changed (polygon sides, fit). */
export function refreshPreview() {
  if (lastPtr) move(lastPtr);
}

/** Enter in a heads-up input: place the point at the typed size, as a click would. */
export function commitTyped() {
  if (lastPtr && sketch().fields.length) down(lastPtr);
}

export const TOOL_HINTS: Partial<Record<ToolId, string>> = {
  line: 'Click to start a line; keep clicking to chain. Type a length (Tab: angle), Enter to place. Esc ends.',
  rect: 'Click a corner, then the opposite one. Or type the width (Tab: height) and press Enter.',
  center_rect: 'Click the center, then a corner. Or type the width (Tab: height) and press Enter.',
  circle: 'Click the center, then a point on the circle, or type the diameter and press Enter.',
  circle_3pt: 'Click three points on the circle.',
  arc_3pt: 'Click the start, the end, then a point the arc passes through.',
  arc_center: 'Click the center, the start, then the end (counter-clockwise).',
  polygon: 'Click the center, then a corner (or the middle of a side when circumscribed). Sides and fit are in the Sketch panel.',
  slot: 'Click the two centers, then the width.',
  ellipse: 'Click the center, the end of the major axis, then a point for the minor radius.',
  spline: 'Click control points. OK (Enter) or a double-click finishes it, Esc keeps what you placed too; click the first point again to close it.',
  point: 'Click to place a point.',
  dimension: 'Click a line, circle or arc (or two points or lines), place the dimension, then type its value. A sketch’s first dimension scales the whole drawing.',
  project: 'Click model edges, faces (their outline), vertices, or another sketch’s curves to project them here.',
  trim: 'Click the piece of a line, arc or circle to cut away, up to where it crosses other curves. A curve with no crossings goes whole.',
};

/* ───────── pointer handling ───────── */

export function move(ptr: Pointer) {
  const state = sketch();
  lastPtr = ptr;
  useSketch.setState({ cursor: ptr.p });
  if (dragging) { void drag(ptr); return; }
  const tool = state.tool;
  if (tool === 'project') { projectHover(ptr); return; }
  if (tool === 'trim') { trimHover(ptr); return; }
  if (constraintOf(tool)) { constraintMove(ptr); return; }
  if (tool === 'select' || tool === 'dimension') {
    const hit = hitTest(ptr.p, ptr.tol, state.expansion.entities) ?? (tool === 'select' ? axisHits(ptr.p, ptr.tol)[0] ?? null : null);
    if ((hit?.ref ?? null) !== state.hover) useSketch.setState({ hover: hit?.ref ?? null });
    if (tool === 'dimension') dimensionPreview(ptr);
    return;
  }
  const from = clicks.at(-1)?.at;
  const locked = anyTyped();
  if (!ptr.alt) noteReferences(ptr);
  const snapped = snapFor(tool, ptr);
  const size = sized(tool, locked ? ptr.p : snapped.at, ptr.tol / 8);
  const s = locked && size ? { at: size.at, hints: [] } : snapped;
  if (size || state.fields.length) useSketch.setState({ fields: size?.fields ?? [] });
  const c = construction().construction ? true : undefined;
  const at = s.at;
  switch (tool) {
    case 'line': preview(from ? [{ id: '~', type: 'line', start: from, end: at, construction: c }] : [], s.hints); break;
    case 'rect': preview(from ? rectLines(from, at, c) : [], s.hints); break;
    case 'center_rect': {
      if (!from) { preview([], s.hints); break; }
      const opposite: XY = [2 * from[0] - at[0], 2 * from[1] - at[1]];
      preview([...rectLines(opposite, at, c), { id: '~d1', type: 'line', start: opposite, end: at, construction: true }, { id: '~d2', type: 'line', start: [opposite[0], at[1]], end: [at[0], opposite[1]], construction: true }], s.hints);
      break;
    }
    case 'circle': preview(from ? [{ id: '~', type: 'circle', center: from, radius: dist(from, at), construction: c }] : [], s.hints); break;
    case 'circle_3pt': {
      const pts = [...clicks.map((k) => k.at), at];
      const circle = pts.length === 3 ? circumcircle(pts[0], pts[1], pts[2]) : null;
      preview(circle ? [{ id: '~', type: 'circle', center: circle.center, radius: circle.radius, construction: c }] : pts.length === 2 ? [{ id: '~', type: 'line', start: pts[0], end: pts[1], construction: true }] : [], s.hints);
      break;
    }
    case 'arc_3pt': {
      const pts = [...clicks.map((k) => k.at), at];
      const arc = pts.length === 3 ? arcThrough(pts[0], pts[1], pts[2]) : null;
      // Starting at a line's or arc's end and leaving along it: tangent there (shown, so it is what the click adds).
      const prev = arc ? tangentSource(clicks[0], arc) : null;
      preview(arc ? [{ id: '~', type: 'arc', ...arc, construction: c }] : pts.length === 2 ? [{ id: '~', type: 'line', start: pts[0], end: pts[1], construction: true }] : [],
        prev ? [...s.hints, { kind: 'tangent', at: pts[0], ref: prev.id }] : s.hints);
      break;
    }
    case 'arc_center': {
      const [center, start] = clicks.map((k) => k.at);
      if (center && start) {
        const r = dist(center, start);
        preview([{ id: '~', type: 'arc', center, radius: r, start_angle: Math.atan2(start[1] - center[1], start[0] - center[0]), end_angle: Math.atan2(at[1] - center[1], at[0] - center[0]), construction: c }], s.hints);
      } else preview(center ? [{ id: '~', type: 'circle', center, radius: dist(center, at), construction: true }] : [], s.hints);
      break;
    }
    case 'polygon': preview(from ? polygonLines(from, at, sketch().polygonSides, c, sketch().polygonInscribed) : [], s.hints); break;
    case 'slot': {
      const [a, b] = clicks.map((k) => k.at);
      if (a && b) preview(slotShape(a, b, Math.max(distanceToLine(at, a, b), 1e-3), c), s.hints);
      else preview(a ? [{ id: '~', type: 'line', start: a, end: at, construction: true }] : [], s.hints);
      break;
    }
    case 'ellipse': {
      const [center, major] = clicks.map((k) => k.at);
      if (center && major) {
        const R = dist(center, major), rot = Math.atan2(major[1] - center[1], major[0] - center[0]);
        preview([{ id: '~', type: 'ellipse', center, major_radius: R, minor_radius: Math.max(distanceToLine(at, center, major), 1e-3), rotation: rot, construction: c }], s.hints);
      } else preview(center ? [{ id: '~', type: 'line', start: center, end: at, construction: true }] : [], s.hints);
      break;
    }
    case 'spline': {
      const poles = [...clicks.map((k) => k.at), at];
      preview(poles.length >= 2 ? [{ id: '~', type: 'bspline', poles, degree: Math.min(3, poles.length - 1), periodic: false, construction: c }] : [], s.hints);
      break;
    }
    case 'point': preview([], s.hints); break;
    default: break;
  }
}

export function down(ptr: Pointer) {
  const state = sketch();
  lastPtr = ptr;
  if (state.tool === 'select') return selectDown(ptr);
  if (state.tool === 'dimension') return dimensionClick(ptr);
  if (state.tool === 'project') return projectClick(ptr);
  if (state.tool === 'trim') { void trimClick(ptr); return; }
  if (constraintOf(state.tool)) return constraintDown(ptr);
  if (!sizesReady()) return;
  const from = clicks.at(-1)?.at;
  // Typed sizes win over the cursor (and over snapping, which would add ties that fight them).
  const size = anyTyped() ? sized(state.tool, ptr.p, ptr.tol / 8) : null;
  const s = size ? { at: size.at, hints: [] } : snapFor(state.tool, ptr);
  // The second press of a double-click lands on the last point: it ends a line chain or a spline (the double-click
  // does), never adds a zero-length segment or a repeated control point.
  if ((state.tool === 'line' || state.tool === 'spline') && from && dist(s.at, from) <= ptr.tol * 0.25) return;
  const dims = clicks.length ? takeTyped() : [];
  clicks.push(s);
  if (state.tool !== 'line' || clicks.length === 1) preview(sketch().preview.filter((e) => e.type !== 'point'), s.hints);
  const need: Partial<Record<ToolId, number>> = { rect: 2, center_rect: 2, circle: 2, circle_3pt: 3, arc_3pt: 3, arc_center: 3, polygon: 2, slot: 3, ellipse: 3, point: 1 };
  if (state.tool === 'line') {
    if (clicks.length >= 2) void finishLine(clicks.length >= 3 && clicks[0].point === undefined && dist(s.at, clicks[0].at) <= ptr.tol, dims);
    return;
  }
  if (state.tool === 'spline') {
    // Clicking the first point again closes it.
    if (clicks.length >= 4 && dist(s.at, clicks[0].at) <= ptr.tol) { clicks.pop(); void finishSpline(true); }
    return;
  }
  const needed = need[state.tool] ?? 99;
  if (clicks.length < needed) { if (dims.length) pendingDims = dims; return; }  // A slot's length is typed at its second click; it's made at the third.
  const all = [...pendingDims, ...dims];
  pendingDims = [];
  void create(state.tool, clicks, all);
  clicks = [];
  preview([]);
  useSketch.setState({ fields: [] });
}
let pendingDims: TypedDim[] = [];

export function up(ptr: Pointer) {
  if (dragging) void endDrag(ptr);
}

export function doubleClick() {
  const tool = sketch().tool;
  if (tool === 'line') { clicks = []; preview([]); useSketch.setState({ fields: [], typed: {} }); }
  if (tool === 'spline') void finishSpline();
}

/** Esc: a spline with two or more points is kept (finished); otherwise first drops the in-progress shape, then leaves the tool. */
export function escape(): boolean {
  if (constraintOf(sketch().tool)) return constraintEscape();
  if (sketch().tool === 'spline' && clicks.length >= 2) { void finishSpline(); return true; }
  if (clicks.length || sketch().preview.length || sketch().editing || sketch().placing) {
    clicks = []; dimensionPick = []; placingPicks = []; pendingDims = [];
    useSketch.setState({ preview: [], hints: [], editing: null, placing: null, fields: [], typed: {}, fieldFocus: null, message: null });
    return true;
  }
  if (sketch().tool !== 'select') { setTool('select'); return true; }
  if (sketch().selection.length) { useSketch.setState({ selection: [] }); return true; }
  return false;
}

/** Enter is the Sketch panel's OK for the active tool. */
export function enter() {
  if (sketch().tool !== 'select') void okTool();
}

/**
 * The Sketch panel's OK for the active tool (not for the sketch: that's Finish sketch on the ribbon). Keeps what the
 * tool has in progress that can be kept (a spline's points, a shape sized in the fields), then goes back to Select.
 */
export async function okTool() {
  const state = sketch();
  if (!sizesReady()) return;
  if (state.tool === 'spline' && clicks.length >= 2) await finishSpline();
  else if (state.fields.length && anyTyped()) commitTyped();
  if (constraintOf(state.tool)) useSketch.setState({ selection: [], message: null });  // A constraint's half-picked set is dropped.
  setTool('select');
}

/** The Sketch panel's Cancel for the active tool: drops what it has in progress (unplaced points, a rubber band), then Select. */
export function cancelTool() {
  pendingDims = [];
  if (constraintOf(sketch().tool)) useSketch.setState({ selection: [], message: null });
  setTool('select');
}

/* ───────── creation ───────── */

async function finishLine(close: boolean, dims: TypedDim[] = []) {
  const [a, b] = clicks.slice(-2);
  const id = nextEntityId('line');
  const statements: Stmt[] = [stmt('line', [id, pt(a.at), pt(b.at)], construction()), ...typedDimensions('line', id, dims)];
  // Inferred, in priority order (the solver takes back any that over-constrain): how it connects, then its direction.
  const inferred: Stmt[] = [];
  // The chain's previous line ends where this one starts.
  if (clicks.length > 2) inferred.push(stmt('coincident', [lit(lastLineEnd!), lit(`${id}.start`)]));
  else inferred.push(...tie(`${id}.start`, a));
  if (close && firstLineStart) inferred.push(stmt('coincident', [lit(`${id}.end`), lit(firstLineStart)]));
  else inferred.push(...tie(`${id}.end`, b));
  const angled = dims.some((d) => d.key === 'angle');  // A typed angle already fixes the direction.
  // Its direction, as shown at the click: tangent/parallel/perpendicular, or its own horizontal/vertical.
  if (!angled) inferred.push(...directed(id, b));
  if (!angled && b.hints.some((h) => h.kind === 'horizontal')) inferred.push(stmt('horizontal', [lit(id)]));
  else if (!angled && b.hints.some((h) => h.kind === 'vertical')) inferred.push(stmt('vertical', [lit(id)]));
  if (clicks.length === 2) firstLineStart = `${id}.start`;
  lastLineEnd = `${id}.end`;
  if (close) { clicks = []; firstLineStart = null; lastLineEnd = null; preview([]); }
  await place(statements, inferred);
}
let firstLineStart: string | null = null;
let lastLineEnd: string | null = null;

/** The control points placed so far while the Spline tool is drawing (for the Sketch panel). */
export const splinePoints = () => (sketch().tool === 'spline' ? clicks.length : 0);

/** Makes the spline from the points placed so far: open, or closed (periodic, through its first point again). */
export async function finishSpline(closed = false) {
  if (clicks.length < 2) { clicks = []; preview([]); return; }
  const id = nextEntityId('spline');
  const poles = clicks.map((k) => pt(k.at));
  const periodic = closed && clicks.length >= 3;
  const statements = [stmt('spline', [id, poles], periodic ? { periodic: lit(true), ...construction() } : construction())];
  const inferred = periodic
    // A closed spline has no ends; its first control point keeps what it snapped to.
    ? tie(`${id}.pole0`, clicks[0])
    // Leaving a line's or arc's end along it (its first span shown tangent): tangent there.
    : [...tie(`${id}.start`, clicks[0]), ...tie(`${id}.end`, clicks[clicks.length - 1]), ...(clicks[1] ? directed(id, clicks[1]) : [])];
  clicks = [];
  preview([]);
  await place(statements, inferred);
}

async function create(tool: ToolId, k: Snap[], dims: TypedDim[] = []) {
  const c = construction();
  const statements: Stmt[] = [];
  // What the clicks snapped or lined up to; the solver takes back any of these that would over-constrain.
  const inferred: Stmt[] = [];
  // A circle, arc or polygon centered on another circle's or arc's center: concentric with it (as shown).
  const centered = (curve: string, center: string, s: Snap) => { const other = concentricWith(s); return other ? [stmt('concentric', [lit(other), lit(curve)])] : tie(center, s); };
  const withSizes = (id: string) => statements.push(...typedDimensions(tool, id, dims));
  switch (tool) {
    case 'point': {
      const id = nextEntityId('point');
      statements.push(stmt('point', [id, pt(k[0].at)], c));
      inferred.push(...tie(id, k[0]));
      break;
    }
    case 'rect': {
      const id = nextEntityId('rect');
      const [a, b] = [k[0].at, k[1].at];
      const lo: XY = [Math.min(a[0], b[0]), Math.min(a[1], b[1])], hi: XY = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      if (hi[0] - lo[0] < 1e-9 || hi[1] - lo[1] < 1e-9) return;
      statements.push(stmt('rect', [id, pt(lo), pt(hi)], c));
      withSizes(id);
      const corner = (p: XY) => (p[0] === lo[0] ? (p[1] === lo[1] ? `${id}.bottom.start` : `${id}.top.end`) : p[1] === lo[1] ? `${id}.bottom.end` : `${id}.top.start`);
      inferred.push(...tie(corner(a), k[0]), ...tie(corner(b), k[1]));
      break;
    }
    case 'center_rect': {
      const id = nextEntityId('center_rect');
      const [center, corner] = [k[0].at, k[1].at];
      const w = Math.abs(corner[0] - center[0]) * 2, h = Math.abs(corner[1] - center[1]) * 2;
      if (w < 1e-9 || h < 1e-9) return;
      statements.push(stmt('center_rect', [id, pt(center), rnd(w), rnd(h)], c));
      inferred.push(...tie(`${id}.center`, k[0]));
      withSizes(id);
      break;
    }
    case 'circle': {
      const id = nextEntityId('circle');
      const r = dist(k[0].at, k[1].at);
      if (r < 1e-9) return;
      statements.push(stmt('circle', [id, pt(k[0].at), rnd(r)], c));
      withSizes(id);
      inferred.push(...centered(id, `${id}.center`, k[0]));
      if (k[1].point) inferred.push(stmt('point_on', [lit(k[1].point), lit(id)]));
      break;
    }
    case 'circle_3pt': {
      const circle = circumcircle(k[0].at, k[1].at, k[2].at);
      if (!circle) return;
      const id = nextEntityId('circle');
      statements.push(stmt('circle', [id, pt(circle.center), rnd(circle.radius)], c));
      for (const s of k) if (s.point) inferred.push(stmt('point_on', [lit(s.point), lit(id)]));
      break;
    }
    case 'arc_3pt': {
      const arc = arcThrough(k[0].at, k[1].at, k[2].at);
      if (!arc) return;
      const id = nextEntityId('arc');
      statements.push(stmt('arc', [id, pt(arc.center), rnd(arc.radius), rnd(deg(arc.start_angle)), rnd(deg(arc.end_angle))], c));
      const [startRef, endRef] = arc.flipped ? [`${id}.end`, `${id}.start`] : [`${id}.start`, `${id}.end`];
      inferred.push(...tie(startRef, k[0]), ...tie(endRef, k[1]));
      // Starting an arc at a line's or arc's end, leaving along it, makes it tangent there, as in other CAD tools.
      const prev = tangentSource(k[0], arc);
      if (prev) inferred.push(stmt('tangent', [lit(prev.id), lit(id)], { at: lit(startRef) }));
      break;
    }
    case 'arc_center': {
      const [center, start, end] = k.map((s) => s.at);
      const r = dist(center, start);
      if (r < 1e-9) return;
      const id = nextEntityId('arc');
      const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]), a1 = Math.atan2(end[1] - center[1], end[0] - center[0]);
      statements.push(stmt('arc', [id, pt(center), rnd(r), rnd(deg(a0)), rnd(deg(a1))], c));
      withSizes(id);
      inferred.push(...centered(id, `${id}.center`, k[0]), ...tie(`${id}.start`, k[1]));
      if (k[2].point) inferred.push(stmt('coincident', [lit(`${id}.end`), lit(k[2].point)]));
      break;
    }
    case 'polygon': {
      const id = nextEntityId('polygon');
      const [center, corner] = [k[0].at, k[1].at];
      const r = dist(center, corner);
      if (r < 1e-9) return;
      const { polygonSides: sides, polygonInscribed: inscribed } = sketch();
      // Inscribed: the click is a corner. Circumscribed: it is the middle of a side, and r is the circle the sides touch.
      const rotation = deg(Math.atan2(corner[1] - center[1], corner[0] - center[0])) - (inscribed ? 0 : 180 / sides);
      statements.push(stmt('polygon', [id, pt(center), rnd(r), sides], { ...(inscribed ? {} : { inscribed: lit(false) }), ...(Math.abs(rotation) > 1e-9 ? { rotation: rnd(rotation) } : {}), ...c }));
      withSizes(id);
      inferred.push(...centered(`${id}.circle`, `${id}.circle.center`, k[0]));
      break;
    }
    case 'slot': {
      const [a, b, w] = k.map((s) => s.at);
      const r = distanceToLine(w, a, b);
      if (dist(a, b) < 1e-9 || r < 1e-9) return;
      const id = nextEntityId('slot');
      statements.push(stmt('slot', [id, pt(a), pt(b), rnd(r)], c));
      inferred.push(...tie(`${id}.start_arc.center`, k[0]), ...tie(`${id}.end_arc.center`, k[1]));
      withSizes(id);
      break;
    }
    case 'ellipse': {
      const [center, major, minor] = k.map((s) => s.at);
      const R = dist(center, major), r = distanceToLine(minor, center, major);
      if (R < 1e-9 || r < 1e-9) return;
      const id = nextEntityId('ellipse');
      const rotation = deg(Math.atan2(major[1] - center[1], major[0] - center[0]));
      statements.push(stmt('ellipse', [id, pt(center), rnd(Math.max(R, r)), rnd(Math.min(R, r)), rnd(R >= r ? rotation : rotation + 90)], c));
      inferred.push(...tie(`${id}.center`, k[0]));
      break;
    }
    default: return;
  }
  await place(statements, inferred);
}

/* ───────── select & drag ───────── */

/** The last plain click, to cycle through overlapping geometry when the same spot is clicked again. */
let lastPick: { at: XY; refs: string[]; index: number } | null = null;

function selectDown(ptr: Pointer) {
  const state = sketch();
  // The sketch's axes come last: anything of the sketch's own under the cursor wins.
  const candidates = [...hitCandidates(ptr.p, ptr.tol, state.expansion.entities), ...axisHits(ptr.p, ptr.tol)];
  if (!candidates.length) { lastPick = null; if (!ptr.shift && !ptr.ctrl) useSketch.setState({ selection: [] }); return; }
  const additive = ptr.shift || ptr.ctrl;
  const refs = candidates.map((c) => c.ref);
  if (additive) {
    // Adding at a spot where things overlap takes the next one not selected yet; when all are, the top one toggles off.
    const next = candidates.find((c) => !state.selection.includes(c.ref));
    const selection = next ? [...state.selection, next.ref] : state.selection.filter((r) => r !== candidates[0].ref);
    useSketch.setState({ selection, message: next && candidates.length > 1 ? overlapHint(candidates.length) : null });
    return;
  }
  // The same spot again: the next of the overlapping candidates.
  const again = lastPick && dist(lastPick.at, ptr.p) < ptr.tol * 0.5 && lastPick.refs.join('|') === refs.join('|')
    && state.selection.length === 1 && state.selection[0] === lastPick.refs[lastPick.index];
  const index = again ? (lastPick!.index + 1) % refs.length : 0;
  lastPick = { at: ptr.p, refs, index };
  const hit = candidates[index];
  useSketch.setState({ selection: again || !state.selection.includes(hit.ref) ? [hit.ref] : state.selection, message: candidates.length > 1 ? overlapHint(candidates.length) : null });
  dragging = { ref: hit.ref, kind: hit.kind, from: ptr.p, base: state.statements, exact: state.result?.status === 'ok' && !state.solving ? state.result.entities : null };
}

const overlapHint = (count: number) => `${count} items overlap here: click again to pick the next, Shift+click to add it.`;

let dragRun = 0;

async function drag(ptr: Pointer) {
  if (!dragging) return;
  const run = ++dragRun;
  const { solveSketch } = await import('./solve');
  const { expand, writeBack } = await import('./model');
  const base = expand(dragging.base);
  const owned = base.entities.find((e) => e.id === (entityOf(dragging!.ref, base.entities) ?? dragging!.ref));
  if (owned?.external) return;  // Projected geometry follows its source, not the pointer.
  const dx = ptr.p[0] - dragging.from[0], dy = ptr.p[1] - dragging.from[1];
  if (dragging.kind === 'entity') {
    // Grabbing a curve moves its whole shape rigidly: the shape is translated, enough of its points are pinned
    // there to hold its size and angle, and the rest of the sketch follows as its constraints allow. Held in
    // place, it slides along x or y if that is free, else stays (a fully defined shape doesn't move).
    const owner = ownerIndex(base, dragging.ref);
    if (owner < 0) return;
    const own = new Set(base.owners[owner].entities);
    const exact = new Map((dragging.exact ?? base.entities).map((e) => [e.id, e]));
    const start = base.entities.map((e) => exact.get(e.id) ?? e);
    dragging.pins ??= await posePins(start.filter((e) => own.has(e.id)), base.constraints.filter((c) => base.owners[owner].constraints.includes(c.id)));
    if (run !== dragRun || !dragging) return;
    for (const [tx, ty] of [[dx, dy], [dx, 0], [0, dy]] as XY[]) {
      if (Math.hypot(tx, ty) < 1e-12) continue;
      const guess = start.map((e) => (own.has(e.id) ? shifted(e, tx, ty) : e));
      const at = pointMap(guess.filter((e) => own.has(e.id)));
      const pins = dragging.pins.map((ref, i) => ({ id: `~drag${i}`, type: 'fix', refs: [ref], at: at.get(ref)! }));
      const result = await solveSketch({ entities: guess, constraints: [...base.constraints, ...pins] });
      if (run !== dragRun || !dragging) return;
      if (result.status === 'unsolved') {
        const moved = translateOwner(dragging.base, base, dragging.ref, tx, ty);
        useSketch.setState({ statements: moved, expansion: expand(moved) });
        return;
      }
      const solved = new Map(result.entities.map((e) => [e.id, e]));
      if (result.status === 'ok' && guess.every((e) => !own.has(e.id) || same(e, solved.get(e.id)))) {
        const moved = writeBack(dragging.base, result.entities);
        useSketch.setState({ statements: moved, expansion: expand(moved), result: { ...result }, message: null });
        return;
      }
    }
    useSketch.setState({ statements: dragging.base, expansion: base, message: 'Held in place by its constraints and dimensions.' });
    return;
  }
  // A point goes to the cursor and the solver moves the rest; a polygon corner resizes about its center.
  const pinned = dragging.ref;
  const owner = ownerIndex(base, pinned);
  const polygon = owner >= 0 && dragging.base[owner]?.op === 'polygon' ? `${dragging.base[owner].args[0]?.value}.circle.center` : null;
  const center = polygon && polygon !== pinned ? pointMap(base.entities).get(polygon) : undefined;
  const others = base.constraints.filter((c) => !(c.type === 'fix' && c.refs[0] === pinned));
  const attempts = [
    ...(center ? [[...others, { id: '~drag', type: 'fix', refs: [pinned], at: ptr.p }, { id: '~center', type: 'fix', refs: [polygon!], at: center }]] : []),
    [...others, { id: '~drag', type: 'fix', refs: [pinned], at: ptr.p }],
  ];
  // A shape's own center (a polygon's, a circle's, an arc's, an ellipse's) carries the shape: the solve starts from the
  // whole shape translated to the cursor, so with nothing else holding it, it moves without turning or resizing, and
  // constraints are met from that pose. Pinning only the center left the rest where it was: a polygon's corners stayed
  // put (it resized and spun about them) and an ellipse swung about its far end.
  const ownCenter = owner >= 0 && CARRIED_BY_CENTER.has(dragging.base[owner]?.op) && pinned === centerRef(dragging.base[owner]);
  const exact = new Map((dragging.exact ?? base.entities).map((e) => [e.id, e]));
  const startAt = base.entities.map((e) => exact.get(e.id) ?? e);
  const from = ownCenter ? pointMap(startAt).get(pinned) : undefined;
  const own = owner >= 0 ? new Set(base.owners[owner].entities) : new Set<string>();
  const seed = from ? startAt.map((e) => (own.has(e.id) ? shifted(e, ptr.p[0] - from[0], ptr.p[1] - from[1]) : e)) : base.entities;
  for (const constraints of attempts) {
    const result = await solveSketch({ entities: seed, constraints: constraints as typeof base.constraints });
    if (run !== dragRun || !dragging) return;
    if (result.status === 'ok') {
      const moved = writeBack(dragging.base, result.entities);
      useSketch.setState({ statements: moved, expansion: expand(moved), result: { ...result } });
      return;
    }
    if (result.status === 'unsolved') {
      // No solver: move the whole declaring statement.
      const moved = translateOwner(dragging.base, base, dragging.ref, dx, dy);
      useSketch.setState({ statements: moved, expansion: expand(moved) });
      return;
    }
  }
}

/** Points that pin a shape's own freedom (its pose and size) without over-constraining it: a line's two ends,
 *  a rectangle's opposite corners, a polygon's first side. Found on the shape alone, with its own constraints. */
async function posePins(shape: Entity[], internal: Constraint[]): Promise<string[]> {
  const { solveSketch } = await import('./solve');
  const pins: [string, XY][] = [];
  let dof = Infinity, extra = Infinity;
  for (const [ref, at] of pointMap(shape)) {
    const trial = [...pins, [ref, at] as [string, XY]];
    const result = await solveSketch({ entities: shape, constraints: [...internal, ...trial.map(([p, a], i) => ({ id: `~pin${i}`, type: 'fix', refs: [p], at: a }))] });
    if (result.status !== 'ok' || result.dof === null) continue;
    const redundant = result.redundant.length + result.partially_redundant.length;
    if (result.dof >= dof || redundant > extra) continue;
    pins.push([ref, at]);
    dof = result.dof;
    extra = redundant;
    if (dof === 0) break;
  }
  return pins.map(([ref]) => ref);
}

/** Shapes whose center point carries the whole shape when dragged (a slot's arc centers are its ends, so they reshape it). */
const CARRIED_BY_CENTER = new Set(['polygon', 'circle', 'arc', 'ellipse', 'elliptical_arc']);
const centerRef = (s: Stmt) => (s.op === 'polygon' ? `${s.args[0]?.value}.circle.center` : `${s.args[0]?.value}.center`);

const move2 = (p: XY, tx: number, ty: number): XY => [p[0] + tx, p[1] + ty];

/** An entity translated by (tx, ty). */
function shifted(e: Entity, tx: number, ty: number): Entity {
  const out = { ...e } as Record<string, unknown>;
  for (const key of ['start', 'end', 'center', 'at']) if (Array.isArray(out[key])) out[key] = move2(out[key] as XY, tx, ty);
  if (Array.isArray(out.poles)) out.poles = (out.poles as XY[]).map((p) => move2(p, tx, ty));
  return out as unknown as Entity;
}

/** Same geometry (positions, radii, angles) within 1e-6: the shape moved rigidly to where it was put. */
function same(a: Entity, b: Entity | undefined): boolean {
  if (!b) return false;
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  for (const key of ['start', 'end', 'center', 'at', 'radius', 'major_radius', 'minor_radius', 'rotation', 'start_angle', 'end_angle', 'poles']) {
    const u = [x[key]].flat(2), v = [y[key]].flat(2);
    if (u.length !== v.length || u.some((n, i) => typeof n === 'number' && Math.abs(n - (v[i] as number)) > 1e-6)) return false;
  }
  return true;
}

const ownerIndex = (expansion: ReturnType<typeof import('./model').expand>, ref: string) =>
  expansion.owners.findIndex((o) => o.entities.includes(entityOf(ref, expansion.entities) ?? ref));

async function endDrag(ptr: Pointer) {
  const d = dragging;
  dragging = null;
  if (!d) return;
  if (dist(ptr.p, d.from) < ptr.tol * 0.3) { useSketch.setState({ statements: d.base, expansion: (await import('./model')).expand(d.base) }); return; }
  const moved = sketch().statements;
  if (moved === d.base) return;  // Held in place: nothing to undo.
  useSketch.setState({ statements: d.base });
  await commit(moved);
}

function translateOwner(statements: Stmt[], expansion: ReturnType<typeof import('./model').expand>, ref: string, dx: number, dy: number): Stmt[] {
  const owner = expansion.owners.findIndex((o) => o.entities.includes(entityOf(ref, expansion.entities) ?? ref));
  if (owner < 0) return statements;
  const shift = (v: unknown): unknown => (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' ? [rnd(v[0] + dx), rnd((v[1] as number) + dy)] : Array.isArray(v) ? v.map(shift) : v);
  return statements.map((s, index) => {
    if (index !== owner) return s;
    const moveArg = (a: { source: string; value: unknown }) => {
      const v = shift(a.value);
      return v === a.value ? a : lit(v as XY);
    };
    return { ...s, args: s.args.map((a, i) => (i === 0 ? a : moveArg(a))), kwargs: Object.fromEntries(Object.entries(s.kwargs).map(([k, a]) => [k, moveArg(a)])) };
  });
}

/* ───────── dimensions ───────── */

let dimensionPick: Hit[] = [];
/** What the dimension being placed measures; its type follows the cursor (above/beside a pair of points). */
let placingPicks: Hit[] = [];

function dimensionPreview(ptr: Pointer) {
  if (sketch().placing) {
    const spec = dimensionFor(placingPicks[0], placingPicks[1], ptr.p);
    if (spec) useSketch.setState({ placing: { ...spec, at: ptr.p } });
    return;
  }
  if (!dimensionPick.length) return;
  useSketch.setState({ hints: [{ kind: 'snap', at: ptr.p }] });
}

function dimensionClick(ptr: Pointer) {
  const state = sketch();
  if (state.placing) {
    const spec = dimensionFor(placingPicks[0], placingPicks[1], ptr.p) ?? state.placing;
    placingPicks = [];
    useSketch.setState({ placing: null, message: null });
    void placeDimension(spec, ptr.p);
    return;
  }
  const hit = hitTest(ptr.p, ptr.tol, state.expansion.entities);
  if (hit) {
    dimensionPick.push(hit);
    const entity = (ref: string) => state.expansion.entities.find((e) => e.id === ref);
    const [a, b] = dimensionPick;
    const single = dimensionPick.length === 1 && a.kind === 'entity' ? entity(a.ref) : null;
    // One circle/arc/line is a complete dimension; two picks are always complete.
    if (single && (single.type === 'circle' || single.type === 'arc' || single.type === 'line') || dimensionPick.length === 2) {
      const spec = dimensionFor(a, b, ptr.p);
      dimensionPick = [];
      if (!spec) { useSketch.setState({ message: 'Those can’t be dimensioned together. Pick points, lines, circles or arcs.' }); return; }
      placingPicks = b ? [a, b] : [a];
      useSketch.setState({ placing: { ...spec, at: ptr.p }, hints: [], message: 'Move the dimension where you want it and click to place it.' });
    }
    return;
  }
  dimensionPick = [];
}

interface DimensionSpec { op: string; refs: string[]; measured: number; angle?: boolean }

function dimensionFor(a: Hit, b: Hit | undefined, cursor: XY): DimensionSpec | null {
  const entities = sketch().expansion.entities;
  const e = (ref: string) => entities.find((x) => x.id === ref);
  const pts = pointMap(entities);
  if (!b) {
    const x = e(a.ref);
    if (x?.type === 'circle') return { op: 'diameter', refs: [x.id], measured: x.radius * 2 };
    if (x?.type === 'arc') return { op: 'radius', refs: [x.id], measured: x.radius };
    if (x?.type === 'line') {
      const dx = x.end[0] - x.start[0], dy = x.end[1] - x.start[1];
      // Signed distances read left→right / bottom→top, so the value starts positive whichever way the line runs.
      const ends = (flip: boolean) => (flip ? [`${x.id}.end`, `${x.id}.start`] : [`${x.id}.start`, `${x.id}.end`]);
      if (Math.abs(dy) < 1e-9) return { op: 'horizontal_distance', refs: ends(dx < 0), measured: Math.abs(dx) };
      if (Math.abs(dx) < 1e-9) return { op: 'vertical_distance', refs: ends(dy < 0), measured: Math.abs(dy) };
      return { op: 'distance', refs: [`${x.id}.start`, `${x.id}.end`], measured: Math.hypot(dx, dy) };
    }
    return null;
  }
  const la = e(a.ref), lb = e(b.ref);
  if (a.kind === 'point' && b.kind === 'point') {
    const p = pts.get(a.ref)!, q = pts.get(b.ref)!;
    // Placement decides the type: above/below the pair → horizontal, beside it → vertical, else aligned.
    const minX = Math.min(p[0], q[0]), maxX = Math.max(p[0], q[0]), minY = Math.min(p[1], q[1]), maxY = Math.max(p[1], q[1]);
    if (cursor[0] >= minX && cursor[0] <= maxX && (cursor[1] > maxY || cursor[1] < minY)) return { op: 'horizontal_distance', refs: q[0] < p[0] ? [b.ref, a.ref] : [a.ref, b.ref], measured: Math.abs(q[0] - p[0]) };
    if (cursor[1] >= minY && cursor[1] <= maxY && (cursor[0] > maxX || cursor[0] < minX)) return { op: 'vertical_distance', refs: q[1] < p[1] ? [b.ref, a.ref] : [a.ref, b.ref], measured: Math.abs(q[1] - p[1]) };
    return { op: 'distance', refs: [a.ref, b.ref], measured: dist(p, q) };
  }
  if (la?.type === 'line' && lb?.type === 'line') {
    const d1: XY = [la.end[0] - la.start[0], la.end[1] - la.start[1]], d2: XY = [lb.end[0] - lb.start[0], lb.end[1] - lb.start[1]];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-9 * Math.hypot(...d1) * Math.hypot(...d2)) {
      const foot = closestOnSegment(lb.start, la.start, la.end);
      return { op: 'distance', refs: [`${lb.id}.start`, la.id], measured: dist(foot, lb.start) };
    }
    const angle = Math.atan2(cross, d1[0] * d2[0] + d1[1] * d2[1]);
    // Counter-clockwise from the first line; order the pair so it starts positive.
    return { op: 'angle', refs: angle < 0 ? [lb.id, la.id] : [la.id, lb.id], measured: Math.abs((angle * 180) / Math.PI), angle: true };
  }
  const point = a.kind === 'point' ? a : b.kind === 'point' ? b : null;
  const curve = a.kind === 'entity' ? la : b.kind === 'entity' ? lb : null;
  if (point && curve?.type === 'line') {
    const p = pts.get(point.ref)!;
    return { op: 'distance', refs: [point.ref, curve.id], measured: dist(p, closestOnSegment(p, curve.start, curve.end)) };
  }
  if (la && lb && (la.type === 'circle' || la.type === 'arc') && (lb.type === 'circle' || lb.type === 'arc')) {
    return { op: 'distance', refs: [`${la.id}.center`, `${lb.id}.center`], measured: dist(la.center, lb.center) };
  }
  return null;
}

const label = (at: XY): XY => [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100];

/** The dimension just placed and opened for typing; its first value may scale the sketch (see firstDimensionScale). */
let justPlaced: number | null = null;
useSketch.subscribe((state) => { if (!state.editing) justPlaced = null; });  // Escaped: later edits are plain edits.

async function placeDimension(spec: DimensionSpec, at: XY) {
  const value = Math.abs(spec.measured) < 1e-12 ? 0 : spec.measured;
  const shown = Math.round(value * 1e6) / 1e6;
  await addStatements(stmt(spec.op, [...spec.refs.map((ref) => lit(ref)), { source: String(shown), value: shown }], { label: lit(label(at)) }));
  // Open the value for typing right away, as dimension tools do.
  justPlaced = sketch().statements.length - 1;
  useSketch.setState({ editing: { statement: justPlaced, at } });
}

const literal = (a: Arg) => typeof a.value === 'string' || typeof a.value === 'boolean' || /^[-+\d.eE\s(),[\]]*$/.test(a.source);

/**
 * Scale on first dimension, as other CAD sketchers do: the first size typed into a sketch with no other
 * dimensions scales all of its geometry about the origin, so the drawn proportions stay. Not for angles,
 * reference dimensions, or sketches anchored by projected geometry, fixes or expressions.
 */
function firstDimensionScale(statement: number, from: unknown, to: number): number | null {
  const { statements, expansion } = sketch();
  const s = statements[statement];
  const old = Number(from);
  if (statement !== justPlaced || s.op === 'angle' || !(old > 1e-9) || !(to > 1e-9) || Math.abs(to - old) <= 1e-9 * old) return null;
  if ((s.kwargs.driving ?? s.args[s.op === 'length' || s.op === 'radius' || s.op === 'diameter' ? 2 : 3])?.value === false) return null;
  if (statements.some((item, i) => i !== statement && DIMENSION_OPS.has(item.op))) return null;
  if (expansion.errors.length || expansion.entities.some((e) => e.external) || statements.some((item) => item.op === 'fix')) return null;
  if (statements.some((item) => GEOMETRY_OPS.has(item.op) && ![...item.args, ...Object.values(item.kwargs)].every(literal))) return null;
  return to / old;
}

/**
 * Applies a typed dimension value: a number, a length with a unit, or an expression over parameters. A length's plain
 * number is in the units the status bar shows and a unit after a number is that number's; the code keeps mm, so `2` in
 * inches is written as 50.8 and `width + 1in` as `width + (1 * 25.4)`.
 */
/** Edit the existing Studio ellipse declaration; constraints remain authoritative. */
export async function setEllipseGeometry(statement: number, major: string, minor: string, rotation: string): Promise<string | true> {
  const state = sketch(), original = state.statements[statement];
  if (!state.active || state.solving || original?.op !== 'ellipse') return 'Select an editable ellipse after the sketch finishes solving.';
  const a = typedCode(major, false), b = typedCode(minor, false), angle = typedCode(rotation, true);
  if (!a || !b || !Number.isFinite(a.value) || !Number.isFinite(b.value)) return lengthHint(setting('display.units'));
  if (!(a.value > b.value && b.value > 0)) return 'Major radius must be greater than minor radius, and both must be positive. For equal radii, use Circle.';
  if (hasLengthUnit(rotation) || !angle || !Number.isFinite(angle.value)) return 'Enter a valid rotation in degrees.';
  const args = [...original.args], kwargs = { ...original.kwargs };
  for (const [index, name, value] of [[2, 'major_radius', a], [3, 'minor_radius', b], [4, 'rotation', angle]] as const) {
    if (name in kwargs || index >= args.length) kwargs[name] = value; else args[index] = value;
  }
  const next = state.statements.map((s, i) => i === statement ? { ...s, args, kwargs } : s);
  const expanded = expand(next);
  if (expanded.errors.length) return expanded.errors[0].message;
  const { solveSketch } = await import('./solve');
  const result = await solveSketch(expanded);
  if (!sketch().active || sketch().featureId !== state.featureId || sketch().statements !== state.statements) return 'The sketch changed while checking this edit. Apply again.';
  if (result.status !== 'ok') return result.status === 'unsolved' ? 'The sketch solver is not ready. Try again.' : 'These sizes conflict with existing constraints. The ellipse was not changed.';
  const id = String(original.args[0]?.value ?? original.kwargs.id?.value ?? '');
  const solved = result.entities.find(e => e.id === id);
  const close = (x: number, y: number) => Math.abs(x - y) <= 1e-7 * Math.max(1, Math.abs(x), Math.abs(y));
  const radians = angle.value * Math.PI / 180;
  if (solved?.type !== 'ellipse' || !close(solved.major_radius, a.value) || !close(solved.minor_radius, b.value)
    || Math.abs(Math.sin(solved.rotation - radians)) > 1e-7 || result.conflicting.length || result.redundant.length) {
    return 'Existing constraints prevent those sizes or rotation. Change the constraints first; the ellipse was not changed.';
  }
  await commit(next);
  return true;
}

export async function setDimension(statement: number, source: string): Promise<string | true> {
  const state = sketch();
  const s = state.statements[statement];
  if (!s) return 'That dimension no longer exists.';
  const index = ({ distance: 2, horizontal_distance: 2, vertical_distance: 2, angle: 2, length: 1, radius: 1, diameter: 1 } as Record<string, number>)[s.op];
  if (index === undefined) return 'That isn’t a dimension.';
  const angle = s.op === 'angle';
  if (angle && hasLengthUnit(source)) return ANGLE_UNITS;
  const written = typedCode(source, angle);
  if (!written) return angle ? 'Type a number of degrees or an expression of parameters, like angle / 2.' : lengthHint(setting('display.units'));
  const value = written.value;
  const factor = firstDimensionScale(statement, s.args[index]?.value, value);
  justPlaced = null;
  let base = state.statements;
  if (factor !== null) {
    base = writeBack(base, scaleEntities(state.expansion.entities, factor)).map((item, i) => {
      const at = item.kwargs.label?.value;
      if (i !== statement || !Array.isArray(at)) return item;
      return { ...item, kwargs: { ...item.kwargs, label: lit(label([Number(at[0]) * factor, Number(at[1]) * factor])) } };
    });
  }
  const args = [...base[statement].args];
  args[index] = written;
  const next = base.map((item, i) => (i === statement ? { ...item, args } : item));
  useSketch.setState({ editing: null });
  await commit(next, { message: factor !== null ? 'Scaled the sketch to its first dimension.' : null });
  const result = sketch().result;
  if (result?.status === 'failed') return 'That value conflicts with other constraints.';
  return true;
}

/** Moves a dimension's label (display only; the geometry doesn't change). */
export function moveLabel(statement: number, at: XY) {
  const { statements } = sketch();
  const s = statements[statement];
  if (!s) return;
  void commit(statements.map((item, i) => (i === statement ? { ...item, kwargs: { ...item.kwargs, label: lit(label(at)) } } : item)));
}

/* ───────── projection ───────── */

type Target = { ref: string; source?: string; shapes: Shape[] } | { error: string } | null;

/** A ray through a screen point (for other sketches' planes). */
function rayAt(clientX: number, clientY: number): THREE.Ray | null {
  const camera = viewer.camera, element = viewer.gl?.domElement;
  if (!camera || !element) return null;
  const rect = element.getBoundingClientRect();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
  return raycaster.ray;
}

/** What the Project tool would take under the pointer: another sketch's curve, or the hovered model edge/face/vertex. */
function projectTarget(ptr: Pointer): Target {
  const doc = app().modeling;
  const { featureId, plane } = sketch();
  if (!doc || !ptr.client) return null;
  const order = doc.features.map((f) => f.id);
  const before = (id: string | null) => !order.includes(featureId) || order.indexOf(id) < order.indexOf(featureId);
  // A model edge or vertex under the pointer wins (a sketch's curves often lie right on the edges built
  // from them); otherwise another sketch's curve beats the face behind it.
  const hovered = app().hover as Pick | null;
  const onModelEdge = hovered?.kind === 'edge' || hovered?.kind === 'vertex';
  const ray = onModelEdge ? null : rayAt(...ptr.client), nudged = onModelEdge ? null : rayAt(ptr.client[0] + 8, ptr.client[1]);
  for (const feature of doc.features) {
    if (feature.kind !== 'sketch' || !feature.id || feature.id === featureId || !feature.document || !ray || !nudged) continue;
    const other = sketchPlane(feature, doc);
    if (!other) continue;
    const surface = new THREE.Plane().setFromNormalAndCoplanarPoint(other.normal, other.origin);
    const hitAt = ray.intersectPlane(surface, new THREE.Vector3()), near = nudged.intersectPlane(surface, new THREE.Vector3());
    if (!hitAt || !near) continue;
    const toLocal = (v: THREE.Vector3): XY => { const d = v.clone().sub(other.origin); return [d.dot(other.x), d.dot(other.y)]; };
    const entities = (feature.document.entities as unknown as Entity[]).filter((e) => e.type !== 'projection');
    const hit = hitTest(toLocal(hitAt), toLocal(hitAt).map((v, i) => v - toLocal(near)[i]).reduce((a, b) => Math.hypot(a, b), 0), entities);
    const entity = hit && entities.find((e) => e.id === (entityOf(hit.ref, entities) ?? hit.ref));
    if (!entity) continue;
    if (!before(feature.id)) return { error: `${feature.name} comes after this sketch; projections can only use earlier geometry.` };
    useSketch.setState({ projectHover: { sketch: feature.id, entity: entity.id } });
    return { ref: `${feature.id}.${entity.id}`, shapes: sketchCurves([entity], other).flatMap((c) => projectCurve(c, plane)) };
  }
  if (sketch().projectHover) useSketch.setState({ projectHover: null });
  const pick = app().hover as Pick | null;
  if (!pick || pick.kind === 'component') return null;
  const topology = viewer.model?.topologyFor(pick.mesh) as unknown as { faces?: { ref?: string }[]; edges?: { ref?: string }[]; vertex_refs?: string[] } | undefined;
  const ref = pick.kind === 'face' ? topology?.faces?.[pick.index]?.ref : pick.kind === 'edge' ? topology?.edges?.[pick.index]?.ref : topology?.vertex_refs?.[pick.index];
  if (!ref) return { error: 'This geometry has no reference name yet. Regenerate the model, then project it.' };
  const written = refSource(pick, ref);  // Another component's geometry in a design: `<component>.edge("…")`.
  const later = written.component ? null : laterThan(ref, featureId, doc);
  if (later) return { error: `${doc.features.find((f) => f.id === later)?.name ?? later} comes after this sketch; projections can only use earlier geometry.` };
  return { ref, source: written.component ? written.source : undefined, shapes: pickCurves(pick).flatMap((c) => projectCurve(c, plane)) };
}

// The model's hover pick lands a frame after the pointer moves; refresh the preview when it does.
useApp.subscribe((state, previous) => {
  if (state.hover !== previous.hover && sketch().active && sketch().tool === 'project' && lastPtr) projectHover(lastPtr);
});

function projectHover(ptr: Pointer) {
  const target = projectTarget(ptr);
  if (target && 'shapes' in target) useSketch.setState({ preview: withIds('~', target.shapes, false), hints: [], message: `Project ${target.ref}` });
  else useSketch.setState({ preview: [], hints: [], message: target && 'error' in target ? target.error : TOOL_HINTS.project ?? null });
}

function projectClick(ptr: Pointer) {
  const target = projectTarget(ptr);
  if (!target) return;
  if ('error' in target) { useSketch.setState({ message: target.error }); return; }
  if (!target.shapes.length) { useSketch.setState({ message: 'That has nothing to project onto this plane.' }); return; }
  const id = nextEntityId('project');
  const on = sketch().construction;
  setProjections({ ...projections(), [id]: withIds(id, target.shapes, on) });
  useSketch.setState({ preview: [] });
  setApp({ hover: null });
  void addStatements(stmt('project', [id, target.source ? { source: target.source, value: target.ref } : target.ref], on ? { construction: lit(true) } : {}));
}

/* ───────── trim ───────── */

/** The curve Trim would cut under the pointer (points don't count: an end is where a piece stops, not a target). */
function trimTarget(ptr: Pointer): string | null {
  return hitCandidates(ptr.p, ptr.tol, sketch().expansion.entities).find((h) => h.kind === 'entity')?.ref ?? null;
}

function trimHover(ptr: Pointer) {
  const ref = trimTarget(ptr);
  const piece = ref ? trimPreview(sketch().expansion.entities, ref, ptr.p) : null;
  useSketch.setState({ hover: null, hints: [], preview: piece ? [piece] : [] });
}

async function trimClick(ptr: Pointer) {
  const ref = trimTarget(ptr);
  if (!ref) return;
  const result = trim(sketch().statements, ref, ptr.p);
  if ('error' in result) { useSketch.setState({ message: result.error }); return; }
  useSketch.setState({ preview: [], selection: [] });
  const fixed = result.statements;
  await settle(fixed, [], result.ties, commit([...fixed, ...result.ties], { message: result.message ?? TOOL_HINTS.trim }));
  if (lastPtr && sketch().tool === 'trim') trimHover(lastPtr);
}

/* ───────── constraints from the selection ───────── */

/** What a constraint adds for a selection, or why it doesn't apply (shown on disabled buttons). */
export function planConstraint(kind: string, selection = sketch().selection, entities = sketch().expansion.entities): Stmt[] | string {
  const e = (ref: string) => entities.find((x) => x.id === ref);
  const isPoint = (ref: string) => pointMap(entities).has(ref) && !e(ref)?.type?.match(/line|circle|arc|ellipse|bspline/);
  // The sketch's X/Y axes (the solver's fixed refs) act as lines: a point on an axis, a line along or square to one,
  // points mirrored about one, a circle tangent to one. They can't themselves be made horizontal, equal or a midpoint.
  const isAxis = (ref: string) => ref === 'x_axis' || ref === 'y_axis';
  const lines = selection.filter((r) => e(r)?.type === 'line' || isAxis(r));
  const ownLines = lines.filter((r) => !isAxis(r));
  const curves = selection.filter((r) => ['circle', 'arc', 'ellipse'].includes(e(r)?.type ?? ''));
  const points = selection.filter(isPoint);
  const one = (op: string, refs: string[]) => [stmt(op, refs.map((ref) => lit(ref)))];
  const external = (refs: string[]) => refs.length > 0 && refs.every((ref) => FIXED.has(ref) || e(entityOf(ref, entities) ?? ref)?.external);
  if (!selection.length) return 'Select geometry in the view first.';
  if (kind !== 'fix' && external(selection)) return 'Projected geometry is fixed; pick at least one of this sketch’s own curves or points.';
  switch (kind) {
    case 'coincident':
      if (points.length === 2 && selection.length === 2) return one('coincident', points);
      if (points.length === 1 && selection.length === 2) return one('point_on', [points[0], selection.find((r) => r !== points[0])!]);
      // A line onto a line means "on the same line".
      if (lines.length === 2 && selection.length === 2) return one('collinear', lines);
      return 'Select two points, a point and a curve, or two lines.';
    case 'horizontal': case 'vertical':
      if (ownLines.length && ownLines.length === selection.length) return ownLines.map((l) => stmt(kind, [lit(l)]));
      if (points.length === 2 && selection.length === 2) return one(kind, points);
      return 'Select lines, or two points.';
    case 'parallel': case 'perpendicular': case 'collinear':
      if (lines.length === 2 && selection.length === 2) return one(kind, lines);
      return 'Select two lines.';
    case 'equal':
      if (ownLines.length === 2 && selection.length === 2) return one('equal', ownLines);
      if (curves.length === 2 && selection.length === 2) return one('equal', curves);
      return 'Select two lines, or two circles/arcs.';
    case 'tangent': {
      const pair = selection.filter((r) => !isPoint(r));
      if (pair.length === 2 && selection.length === 2) return one('tangent', pair);
      return 'Select two curves (a line and an arc, or two arcs/circles).';
    }
    case 'concentric':
      if (curves.length === 2 && selection.length === 2) return one('concentric', curves);
      return 'Select two circles or arcs.';
    case 'midpoint':
      if (points.length === 1 && ownLines.length === 1 && selection.length === 2) return one('midpoint', [points[0], ownLines[0]]);
      return 'Select a point and a line.';
    case 'symmetric':
      if (points.length === 2 && lines.length === 1 && selection.length === 3) return one('symmetric', [points[0], points[1], lines[0]]);
      if (points.length === 3 && selection.length === 3) return one('symmetric', points);
      return 'Select two points and the line (or point) they mirror about.';
    case 'fix':
      if (external(points)) return 'Projected geometry is already fixed.';
      if (points.length && points.length === selection.length) return points.map((p) => stmt('fix', [lit(p)]));
      return 'Select points to fix in place.';
    default: return 'Unknown constraint.';
  }
}

export function applyConstraint(kind: string): string | true {
  const plan = planConstraint(kind);
  if (typeof plan === 'string') return plan;
  void addStatements(...plan);
  return true;
}

/* ───────── shape math ───────── */

const deg = (r: number) => (r * 180) / Math.PI;

function rectLines(a: XY, b: XY, construction?: boolean): Entity[] {
  const lo: XY = [Math.min(a[0], b[0]), Math.min(a[1], b[1])], hi: XY = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  const c: XY[] = [lo, [hi[0], lo[1]], hi, [lo[0], hi[1]]];
  return c.map((p, i) => ({ id: `~${i}`, type: 'line' as const, start: p, end: c[(i + 1) % 4], construction }));
}

function polygonLines(center: XY, at: XY, sides: number, construction?: boolean, inscribed = true): Entity[] {
  const r0 = dist(center, at), r = inscribed ? r0 : r0 / Math.cos(Math.PI / sides);
  const a0 = Math.atan2(at[1] - center[1], at[0] - center[0]) - (inscribed ? 0 : Math.PI / sides);
  const pts: XY[] = Array.from({ length: sides }, (_, i) => [center[0] + r * Math.cos(a0 + (2 * Math.PI * i) / sides), center[1] + r * Math.sin(a0 + (2 * Math.PI * i) / sides)]);
  return [{ id: '~c', type: 'circle', center, radius: r0, construction: true }, ...pts.map((p, i) => ({ id: `~${i}`, type: 'line' as const, start: p, end: pts[(i + 1) % sides], construction }))];
}

function slotShape(a: XY, b: XY, r: number, construction?: boolean): Entity[] {
  const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const nx = -Math.sin(angle) * r, ny = Math.cos(angle) * r;
  return [
    { id: '~a', type: 'arc', center: b, radius: r, start_angle: angle - Math.PI / 2, end_angle: angle + Math.PI / 2, construction },
    { id: '~u', type: 'line', start: [b[0] + nx, b[1] + ny], end: [a[0] + nx, a[1] + ny], construction },
    { id: '~b', type: 'arc', center: a, radius: r, start_angle: angle + Math.PI / 2, end_angle: angle + (3 * Math.PI) / 2, construction },
    { id: '~l', type: 'line', start: [a[0] - nx, a[1] - ny], end: [b[0] - nx, b[1] - ny], construction },
  ];
}

function distanceToLine(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  return len ? Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len : dist(p, a);
}

function circumcircle(a: XY, b: XY, c: XY): { center: XY; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const center: XY = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  return { center, radius: dist(center, a) };
}

/** Arc from `start` to `end` through `via`; flipped when the CCW arc runs end → start. */
function arcThrough(start: XY, end: XY, via: XY): { center: XY; radius: number; start_angle: number; end_angle: number; flipped: boolean } | null {
  const circle = circumcircle(start, end, via);
  if (!circle) return null;
  const angle = (p: XY) => Math.atan2(p[1] - circle.center[1], p[0] - circle.center[0]);
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const s = angle(start), e = angle(end), v = angle(via);
  const ccw = norm(v - s) < norm(e - s);
  return ccw
    ? { center: circle.center, radius: circle.radius, start_angle: s, end_angle: e, flipped: false }
    : { center: circle.center, radius: circle.radius, start_angle: e, end_angle: s, flipped: true };
}

function isTangent(line: Extract<Entity, { type: 'line' }>, arc: { center: XY }, at: XY): boolean {
  const d: XY = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
  const r: XY = [at[0] - arc.center[0], at[1] - arc.center[1]];
  const cos = Math.abs(d[0] * r[0] + d[1] * r[1]) / (Math.hypot(...d) * Math.hypot(...r) || 1);
  return cos < Math.sin((5 * Math.PI) / 180);
}

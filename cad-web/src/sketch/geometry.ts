/** 2D sketch geometry: sampling curves, hit testing, and closed profiles for shading. */
import * as THREE from 'three';
import { points as pointMap, type Entity, type XY } from './model';

const TAU = Math.PI * 2;

function arcSweep(a0: number, a1: number) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += TAU;
  return sweep;
}

/** Polyline through a curve, fine enough to look smooth at any zoom a sketch is edited at. */
export function sample(e: Entity, detail = 64): XY[] {
  switch (e.type) {
    case 'line': return [e.start, e.end];
    case 'circle': return Array.from({ length: detail + 1 }, (_, i) => [e.center[0] + e.radius * Math.cos((TAU * i) / detail), e.center[1] + e.radius * Math.sin((TAU * i) / detail)] as XY);
    case 'arc': {
      const sweep = arcSweep(e.start_angle, e.end_angle);
      const n = Math.max(4, Math.ceil((detail * sweep) / TAU));
      return Array.from({ length: n + 1 }, (_, i) => {
        const a = e.start_angle + (sweep * i) / n;
        return [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)] as XY;
      });
    }
    case 'ellipse': case 'elliptical_arc': {
      const a0 = e.type === 'ellipse' ? 0 : e.start_angle;
      const sweep = e.type === 'ellipse' ? TAU : arcSweep(e.start_angle, e.end_angle);
      const n = Math.max(8, Math.ceil((detail * sweep) / TAU));
      const c = Math.cos(e.rotation), s = Math.sin(e.rotation);
      return Array.from({ length: n + 1 }, (_, i) => {
        const t = a0 + (sweep * i) / n;
        const x = e.major_radius * Math.cos(t), y = e.minor_radius * Math.sin(t);
        return [e.center[0] + x * c - y * s, e.center[1] + x * s + y * c] as XY;
      });
    }
    case 'bspline': return e.bezier ? bezier(e.poles, detail) : bspline(e.poles, e.degree, e.periodic, detail);
    case 'point': return [e.at];
    default: return [];
  }
}

function bezier(poles: XY[], detail: number): XY[] {
  return Array.from({ length: detail + 1 }, (_, i) => {
    const t = i / detail;
    let pts = poles.map((p) => [...p] as XY);
    while (pts.length > 1) pts = pts.slice(1).map((p, k) => [pts[k][0] + (p[0] - pts[k][0]) * t, pts[k][1] + (p[1] - pts[k][1]) * t] as XY);
    return pts[0];
  });
}

/** Clamped uniform B-spline (matches runtime/steve/sketch.py `_bspline`). */
function bspline(poles: XY[], degree: number, periodic: boolean, detail: number): XY[] {
  const n = poles.length;
  const p = Math.max(1, Math.min(degree, n - 1));
  if (periodic) {
    const ctrl = [...poles, ...poles.slice(0, p)];
    const knots = Array.from({ length: ctrl.length + p + 1 }, (_, i) => i);
    return deBoorCurve(ctrl, knots, p, knots[p], knots[ctrl.length], detail);
  }
  const inner = n - p - 1;
  const knots = [...Array(p + 1).fill(0), ...Array.from({ length: inner }, (_, i) => (i + 1) / (inner + 1)), ...Array(p + 1).fill(1)];
  return deBoorCurve(poles, knots, p, 0, 1, detail);
}

function deBoorCurve(ctrl: XY[], knots: number[], p: number, t0: number, t1: number, detail: number): XY[] {
  const out: XY[] = [];
  for (let i = 0; i <= detail; i++) {
    const t = Math.min(t0 + ((t1 - t0) * i) / detail, t1 - 1e-12);
    let k = p;
    while (k < ctrl.length - 1 && t >= knots[k + 1]) k++;
    const d = Array.from({ length: p + 1 }, (_, j) => [...ctrl[j + k - p]] as XY);
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const denom = knots[j + 1 + k - r] - knots[j + k - p];
        const alpha = denom === 0 ? 0 : (t - knots[j + k - p]) / denom;
        d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
      }
    }
    out.push(d[p]);
  }
  return out;
}

export function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function closestOnSegment(p: XY, a: XY, b: XY): XY {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}

export function distanceToEntity(p: XY, e: Entity): number {
  if (e.type === 'circle') return Math.abs(Math.hypot(p[0] - e.center[0], p[1] - e.center[1]) - e.radius);
  const pts = sample(e, 96);
  if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distanceToSegment(p, pts[i - 1], pts[i]));
  return best;
}

export function closestOnEntity(p: XY, e: Entity): XY {
  if (e.type === 'circle') {
    const a = Math.atan2(p[1] - e.center[1], p[0] - e.center[0]);
    return [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)];
  }
  const pts = sample(e, 96);
  let best = pts[0], bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const q = closestOnSegment(p, pts[i - 1], pts[i]);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bestD) { best = q; bestD = d; }
  }
  return best;
}

export interface Hit { ref: string; kind: 'point' | 'entity'; at: XY; distance: number }

/** Points win over curves within the tolerance; hidden projection placeholders never hit. */
export function hitTest(p: XY, tolerance: number, entities: Entity[], exclude: Set<string> = new Set()): Hit | null {
  return hitCandidates(p, tolerance, entities, exclude)[0] ?? null;
}

/**
 * Everything under the cursor, best first: points before curves; among things about as close
 * (overlapping lines, a polygon side lying on a projected edge), the sketch's own geometry
 * before projected or external geometry, then the nearer. Clicking again cycles through these.
 */
export function hitCandidates(p: XY, tolerance: number, entities: Entity[], exclude: Set<string> = new Set()): Hit[] {
  const external = new Set(entities.filter((e) => e.external).map((e) => e.id));
  const owner = (ref: string) => (external.has(ref) || [...external].some((id) => ref.startsWith(`${id}.`)) ? 1 : 0);
  const near = tolerance * 0.35;
  const order = (a: Hit, b: Hit) => (Math.abs(a.distance - b.distance) <= near ? owner(a.ref) - owner(b.ref) || a.distance - b.distance : a.distance - b.distance);
  const points: Hit[] = [];
  for (const [ref, at] of pointMap(entities)) {
    if (exclude.has(ref)) continue;
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d <= tolerance) points.push({ ref, kind: 'point', at, distance: d });
  }
  const curves: Hit[] = [];
  for (const e of entities) {
    if (e.type === 'projection' || e.type === 'point' || exclude.has(e.id)) continue;
    const d = distanceToEntity(p, e);
    if (d <= tolerance) curves.push({ ref: e.id, kind: 'entity', at: closestOnEntity(p, e), distance: d });
  }
  return [...points.sort(order), ...curves.sort(order)];
}

/**
 * The sketch's own X and Y axes under the cursor, for Select only (constraints such as a point on an axis, or points
 * mirrored about one). They are the solver's fixed `x_axis`/`y_axis` refs; drawing tools never snap to them.
 */
export function axisHits(p: XY, tolerance: number): Hit[] {
  const hits: Hit[] = [];
  if (Math.abs(p[1]) <= tolerance) hits.push({ ref: 'x_axis', kind: 'entity', at: [p[0], 0], distance: Math.abs(p[1]) });
  if (Math.abs(p[0]) <= tolerance) hits.push({ ref: 'y_axis', kind: 'entity', at: [0, p[1]], distance: Math.abs(p[0]) });
  return hits.sort((a, b) => a.distance - b.distance);
}

/* ───────── profiles ───────── */

const key = (p: XY, eps: number) => `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;

/**
 * Closed loops of non-construction curves, for shading. Handles closed curves and chains
 * joined end to end (what sketches are made of); intersecting curves are left to the
 * runtime's full arrangement, which names the real profiles.
 */
export function loops(entities: Entity[], eps = 1e-6): XY[][] {
  const out: XY[][] = [];
  const open: { id: string; pts: XY[] }[] = [];
  for (const e of entities) {
    if (e.type === 'point' || e.type === 'projection' || e.construction) continue;
    const pts = sample(e);
    if (e.type === 'circle' || e.type === 'ellipse' || (e.type === 'bspline' && e.periodic)) out.push(pts);
    else if (pts.length > 1) open.push({ id: e.id, pts });
  }
  const scale = Math.max(eps, 1e-4);
  const ends = new Map<string, number[]>();
  open.forEach((edge, index) => {
    for (const end of [edge.pts[0], edge.pts[edge.pts.length - 1]]) {
      const k = key(end, scale);
      ends.set(k, [...(ends.get(k) ?? []), index]);
    }
  });
  const used = new Set<number>();
  open.forEach((_, start) => {
    if (used.has(start)) return;
    const chain: XY[] = [...open[start].pts];
    const members = [start];
    let cursor = chain[chain.length - 1];
    const first = key(chain[0], scale);
    for (let guard = 0; guard < open.length; guard++) {
      if (key(cursor, scale) === first && members.length > 1) {
        members.forEach((m) => used.add(m));
        out.push(chain);
        return;
      }
      const next = (ends.get(key(cursor, scale)) ?? []).find((i) => !members.includes(i) && !used.has(i));
      if (next === undefined) return;
      const pts = open[next].pts;
      const forward = key(pts[0], scale) === key(cursor, scale);
      const ordered = forward ? pts : [...pts].reverse();
      chain.push(...ordered.slice(1));
      members.push(next);
      cursor = chain[chain.length - 1];
    }
  });
  return out;
}

const area = (loop: XY[]) => loop.reduce((sum, p, i) => { const q = loop[(i + 1) % loop.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

function inside(p: XY, loop: XY[]) {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Loops as filled shapes with holes (even-odd nesting, like the runtime's default profile). */
export function profileShapes(entities: Entity[]): THREE.Shape[] {
  const found = loops(entities).filter((loop) => Math.abs(area(loop)) > 1e-9).sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
  const depth = found.map((loop, i) => found.slice(0, i).filter((outer) => inside(loop[0], outer)).length);
  const shapes: { shape: THREE.Shape; loop: XY[] }[] = [];
  found.forEach((loop, i) => {
    const pts = (area(loop) < 0 ? [...loop].reverse() : loop).map(([x, y]) => new THREE.Vector2(x, y));
    if (depth[i] % 2 === 0) shapes.push({ shape: new THREE.Shape(pts), loop });
    else {
      const parent = [...shapes].reverse().find((s) => inside(loop[0], s.loop));
      parent?.shape.holes.push(new THREE.Path(pts.reverse()));
    }
  });
  return shapes.map((s) => s.shape);
}

/** Bounds of all geometry (for framing the camera on the sketch). */
export function bounds(entities: Entity[]): { min: XY; max: XY } | null {
  let min: XY = [Infinity, Infinity], max: XY = [-Infinity, -Infinity];
  for (const e of entities) for (const p of sample(e, 24)) {
    min = [Math.min(min[0], p[0]), Math.min(min[1], p[1])];
    max = [Math.max(max[0], p[0]), Math.max(max[1], p[1])];
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

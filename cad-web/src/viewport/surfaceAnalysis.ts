/**
 * The Surface tab's analysis maths, without three.js (tests/surface_analysis_test.mjs): curvature estimated on a face's
 * displayed mesh, draft angles against a pull direction, and how two faces meet along an edge (G0 / G1 / G2).
 *
 * Positions and normals come from the build's tessellation of each face: its nodes lie on the exact surface and its
 * normals are the surface's at those nodes, so a gap or an angle read at an edge's points is the geometry's own there.
 * Curvature is estimated from a node's neighbours on the mesh: close on a fine mesh, never exact (shown with ≈).
 */
export type Vec = [number, number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec): Vec => { const l = length(a); return l > 1e-300 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const at = (array: ArrayLike<number>, index: number): Vec => [array[3 * index], array[3 * index + 1], array[3 * index + 2]];

/** A face's mesh: positions and normals (3 per node) and triangles (3 node indices each). */
export interface FaceMesh { positions: ArrayLike<number>; normals: ArrayLike<number>; index: ArrayLike<number> }

/** Each node's neighbours along the mesh's triangle edges. */
export function neighbours(mesh: FaceMesh): number[][] {
  const count = mesh.positions.length / 3;
  const out: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
  for (let t = 0; t + 2 < mesh.index.length; t += 3) {
    const a = mesh.index[t], b = mesh.index[t + 1], c = mesh.index[t + 2];
    out[a].add(b).add(c); out[b].add(a).add(c); out[c].add(a).add(b);
  }
  return out.map((set) => [...set]);
}

/**
 * The normal curvature from node `p` (normal `n`) towards a neighbour `q`: the circle through both that is tangent at
 * p, 2 n·(p − q) / |p − q|². Positive where the surface bends away from its normal (the outside of a ball), negative
 * where it bends towards it (a bowl seen from inside), 0 on a flat.
 */
export function chordCurvature(p: Vec, n: Vec, q: Vec): number {
  const d = sub(p, q);
  const squared = dot(d, d);
  return squared > 1e-24 ? (2 * dot(n, d)) / squared : 0;
}

/**
 * Mean (H) and Gaussian (K) curvature at every node, as pairs [H0, K0, H1, K1, …], in 1/mm and 1/mm². The principal
 * curvatures are taken as the largest and smallest normal curvature towards the node's neighbours; on a sphere of radius
 * R both are 1/R (H = 1/R, K = 1/R²), on a cylinder 1/R and 0 (H = 1/2R, K = 0).
 */
export function curvatures(mesh: FaceMesh, around: number[][] = neighbours(mesh)): Float32Array {
  const count = mesh.positions.length / 3;
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const p = at(mesh.positions, i), n = unit(at(mesh.normals, i));
    let high = -Infinity, low = Infinity;
    for (const j of around[i]) {
      const q = at(mesh.positions, j), d = sub(p, q);
      // Tessellated pole seams can connect separate nodes at the same point.
      // A zero-length chord supplies no curvature direction, not a flat one.
      if (dot(d, d) <= 1e-24) continue;
      const k = chordCurvature(p, n, q);
      if (k > high) high = k;
      if (k < low) low = k;
    }
    if (!Number.isFinite(high)) continue;
    out[2 * i] = (high + low) / 2;
    out[2 * i + 1] = high * low;
  }
  return out;
}

/**
 * The draft of a surface with normal `n` against the pull direction `pull` (both unit), in degrees: 90° minus the angle
 * between them. Positive faces release towards the pull, 0 is a vertical wall, negative faces face away from it.
 */
export function draftAngle(n: Vec, pull: Vec): number {
  return (Math.asin(Math.max(-1, Math.min(1, dot(unit(n), unit(pull))))) * 180) / Math.PI;
}

export type DraftBand = 'positive' | 'shallow' | 'negative';

/** Which band of the draft legend an angle falls in, for a minimum draft (degrees). */
export function draftBand(angle: number, minimum: number): DraftBand {
  return angle >= minimum ? 'positive' : angle <= -minimum ? 'negative' : 'shallow';
}

/** One face along an edge: at each of the edge's points, the face's point, its normal and its curvature across the
 *  edge (null where the mesh can't say). `exactCurvature` when it comes from the face's exact shape (plane, cylinder,
 *  sphere) rather than its mesh. */
export interface EdgeSide { points: Vec[]; normals: Vec[]; across: (number | null)[]; exactCurvature: boolean }

export interface Continuity {
  /** Largest distance between the two faces at the edge's points (mm). */
  gap: number;
  /** Largest angle between their normals (degrees). */
  angle: number;
  /** Largest difference of their curvature across the edge (1/mm), and relative to the larger of the two (0–1+). */
  curvature: number | null;
  relative: number | null;
  /** The worst point: where the angle is largest (or the gap, when the faces don't touch). */
  worst: Vec;
  /** The highest continuity the faces meet with, within TOLERANCE. */
  grade: Grade;
  exactCurvature: boolean;
  /** Gap and angle measured on the exact B-rep (the build's own continuity entry), not read from the mesh. */
  exact: boolean;
}

export type Grade = 'G2' | 'G1' | 'G0' | 'none';

/** The highest continuity met within TOLERANCE, from the largest gap, angle and curvature change (null: unknown). */
export function gradeOf(gap: number, angle: number, curvature: number | null, relative: number | null): Grade {
  const g0 = gap <= TOLERANCE.gap;
  const g1 = g0 && angle <= TOLERANCE.angle;
  const g2 = g1 && curvature !== null && (curvature <= TOLERANCE.flat || (relative ?? 1) <= TOLERANCE.relative);
  return g2 ? 'G2' : g1 ? 'G1' : g0 ? 'G0' : 'none';
}

/** One face pair along an edge as the build measured it on the exact B-rep (runtime/steve/continuity.py). */
export interface MeasuredContinuity {
  faces: [number, number]; gap: number; angle: number; change: number; relative: number;
  curvature: [number | null, number | null]; at: Vec; samples: number;
}

/** A build's exact measurement as a result: every value exact, graded like the mesh's. */
export function fromMeasured(measured: MeasuredContinuity): Continuity {
  const known = measured.curvature[0] !== null && measured.curvature[1] !== null;
  const curvature = known ? measured.change : null, relative = known ? measured.relative : null;
  return { gap: measured.gap, angle: measured.angle, curvature, relative, worst: measured.at,
    grade: gradeOf(measured.gap, measured.angle, curvature, relative), exactCurvature: known, exact: true };
}

/** What "meets with" means: within 0.01 mm, 0.1° and 5 % of the curvature (or 0.0001/mm where both are nearly flat). */
export const TOLERANCE = { gap: 0.01, angle: 0.1, relative: 0.05, flat: 1e-4 };

/**
 * How two faces meet along their shared edge, from each face's points, normals and curvature across the edge at the
 * same edge points. Normals of both faces point out of the body, so tangent faces have parallel normals.
 */
export function continuity(a: EdgeSide, b: EdgeSide): Continuity | null {
  const count = Math.min(a.points.length, b.points.length);
  if (!count) return null;
  let gap = -1, angle = -1, curvature: number | null = null, relative: number | null = null;
  let widest = a.points[0], steepest = a.points[0];
  for (let i = 0; i < count; i++) {
    const distance = length(sub(a.points[i], b.points[i]));
    const between = (Math.acos(Math.max(-1, Math.min(1, dot(unit(a.normals[i]), unit(b.normals[i]))))) * 180) / Math.PI;
    if (distance > gap) { gap = distance; widest = a.points[i]; }
    if (between > angle) { angle = between; steepest = a.points[i]; }
    const ka = a.across[i], kb = b.across[i];
    if (ka === null || kb === null) continue;
    const difference = Math.abs(ka - kb);
    const scale = Math.max(Math.abs(ka), Math.abs(kb));
    const share = scale > TOLERANCE.flat ? difference / scale : 0;
    if (curvature === null || difference > curvature) curvature = difference;
    if (relative === null || share > relative) relative = share;
  }
  return { gap, angle, curvature, relative, worst: gap <= TOLERANCE.gap ? steepest : widest, grade: gradeOf(gap, angle, curvature, relative),
    exactCurvature: a.exactCurvature && b.exactCurvature, exact: false };
}

/**
 * A face's curvature at node `i` in the direction `toward` (a unit vector in its tangent plane): the normal curvature
 * towards the neighbour best lined up with it, or null when no neighbour is within 45° of it.
 */
export function curvatureToward(mesh: FaceMesh, around: number[][], i: number, toward: Vec): number | null {
  const p = at(mesh.positions, i), n = unit(at(mesh.normals, i));
  let best = Math.SQRT1_2, value: number | null = null;
  for (const j of around[i]) {
    const q = at(mesh.positions, j);
    const d = sub(q, p);
    const flat = unit(sub(d, [n[0] * dot(d, n), n[1] * dot(d, n), n[2] * dot(d, n)]));
    const cos = dot(flat, toward);
    if (cos > best) { best = cos; value = chordCurvature(p, n, q); }
  }
  return value;
}

/** The direction across an edge into a face at a point: in the face's tangent plane, square to the edge's tangent, on
 *  the side where the face's other nodes are. */
export function acrossEdge(normal: Vec, tangent: Vec, inside: Vec): Vec {
  const across = unit(cross(normal, tangent));
  return dot(across, inside) < 0 ? [-across[0], -across[1], -across[2]] : across;
}

/**
 * Exact normal curvature of an analytic face in direction `d` (unit, tangent) at `p`, with the outward normal `n`:
 * a plane is flat; a sphere bends by 1/R every way; a cylinder by (d across the axis)² / R. Signed as chordCurvature:
 * positive where the face bends away from its normal (outside a ball or a shaft), negative inside a bore.
 */
export function exactCurvature(surface: { kind: 'plane' } | { kind: 'sphere'; center: Vec; radius: number } | { kind: 'cylinder'; point: Vec; axis: Vec; radius: number },
  p: Vec, n: Vec, d: Vec): number {
  if (surface.kind === 'plane') return 0;
  if (surface.kind === 'sphere') return (dot(n, sub(p, surface.center)) >= 0 ? 1 : -1) / surface.radius;
  const axis = unit(surface.axis);
  const offset = sub(p, surface.point);
  const radial = sub(offset, [axis[0] * dot(offset, axis), axis[1] * dot(offset, axis), axis[2] * dot(offset, axis)]);
  const along = dot(d, axis);
  return ((dot(n, radial) >= 0 ? 1 : -1) * (1 - along * along)) / surface.radius;
}

/**
 * The Measure tool's geometry, without three.js (tests/measure_math_test.mjs): what one or two picks measure.
 *
 * Exact values come from the build's B-rep description of each face and edge (topology.json, runtime/run.py
 * `describe`): a plane's normal, a cylinder's, cone's or torus's axis and radii, a sphere's centre, a circle's centre.
 * Relations between those (axis to axis, axis to plane, centre to plane, angles) are computed from them and are exact.
 * A minimum distance is found on the displayed mesh: exact where the mesh is the geometry itself (flat faces bounded by
 * straight edges, straight edges, vertices), approximate (and shown so) wherever a curved face or edge is involved.
 */
export type Vec = [number, number, number];

export type Surface =
  | { kind: 'plane'; point: Vec; normal: Vec }
  | { kind: 'cylinder'; point: Vec; axis: Vec; radius: number }
  | { kind: 'cone'; point: Vec; axis: Vec; radius: number; halfAngle: number }
  | { kind: 'sphere'; center: Vec; radius: number }
  | { kind: 'torus'; center: Vec; axis: Vec; radius: number; minorRadius: number }
  | { kind: 'circle'; center: Vec; axis: Vec; radius: number }
  | { kind: 'line'; point: Vec; axis: Vec }
  | { kind: 'point'; point: Vec }
  | { kind: 'other'; curved: boolean };

/** A pick's displayed geometry: points, with straight segments and triangles between them (indices into points). */
export interface Shape { points: Vec[]; segments?: [number, number][]; triangles?: [number, number, number][]; exact: boolean }

export interface Relation { label: string; value: number; unit: 'mm' | 'deg'; note?: string; from?: Vec; to?: Vec }

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec) => Math.sqrt(dot(a, a));
const unit = (a: Vec): Vec => { const n = norm(a); return n > 0 ? scale(a, 1 / n) : a; };
const dist = (a: Vec, b: Vec) => norm(sub(a, b));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const degrees = (radians: number) => (radians * 180) / Math.PI;

/** Directions within this angle (radians) count as parallel. */
export const PARALLEL = 1e-6;
/** Lengths below this (mm) count as zero: coaxial, coplanar, touching. */
export const ZERO = 1e-6;

/** The apex of a cone (OCC gp_Cone::Apex): `point` is where its radius is `radius`. */
export function coneApex(surface: { point: Vec; axis: Vec; radius: number; halfAngle: number }): Vec {
  return add(surface.point, scale(surface.axis, -surface.radius / Math.tan(surface.halfAngle)));
}

/** Angle between two lines (0–90°): directions are unsigned. */
export function lineAngle(a: Vec, b: Vec) {
  return degrees(Math.acos(clamp(Math.abs(dot(unit(a), unit(b))), 0, 1)));
}

/** The point on a line nearest p. */
export function footOnLine(p: Vec, point: Vec, axis: Vec): Vec {
  const d = unit(axis);
  return add(point, scale(d, dot(sub(p, point), d)));
}

/** Distance from a point to an infinite line. */
export const pointLineDistance = (p: Vec, point: Vec, axis: Vec) => dist(p, footOnLine(p, point, axis));

/** Signed distance from a point to a plane (along its normal). */
export const pointPlaneDistance = (p: Vec, point: Vec, normal: Vec) => dot(sub(p, point), unit(normal));

/** Closest points of two infinite lines; parallel lines take the foot of a's point on b. */
export function lineLine(pa: Vec, da: Vec, pb: Vec, db: Vec): { a: Vec; b: Vec; distance: number; parallel: boolean } {
  const u = unit(da), v = unit(db);
  const w = sub(pa, pb);
  const b = dot(u, v), d = dot(u, w), e = dot(v, w);
  const denominator = 1 - b * b;
  if (denominator < PARALLEL) {
    const foot = footOnLine(pa, pb, v);
    return { a: pa, b: foot, distance: dist(pa, foot), parallel: true };
  }
  const s = (b * e - d) / denominator, t = (e - b * d) / denominator;
  const a = add(pa, scale(u, s)), q = add(pb, scale(v, t));
  return { a, b: q, distance: dist(a, q), parallel: false };
}

type Axial = { point: Vec; axis: Vec };
/** A pick's axis, if it has one: cylinders, cones, tori, circles (their normal) and straight edges. */
export function axisOf(s: Surface): Axial | null {
  if (s.kind === 'cylinder' || s.kind === 'cone' || s.kind === 'line') return { point: s.point, axis: s.axis };
  if (s.kind === 'torus' || s.kind === 'circle') return { point: s.center, axis: s.axis };
  return null;
}

/** A pick's centre point, if it has one: spheres, tori, circles, vertices, and a cone's apex. */
export function centerOf(s: Surface): Vec | null {
  if (s.kind === 'sphere' || s.kind === 'torus' || s.kind === 'circle') return s.center;
  if (s.kind === 'point') return s.point;
  if (s.kind === 'cone') return coneApex(s);
  return null;
}

const isLine = (s: Surface) => s.kind === 'line';
// Row labels are written out whole (not composed), so the docs can name them and its check can find them in web/src.
const axisToAxis = (A: Surface, B: Surface) => (isLine(A) ? (isLine(B) ? 'Line to line' : 'Line to axis') : isLine(B) ? 'Axis to line' : 'Axis to axis');
const centerToAxis = (center: Surface, axial: Surface) => (center.kind === 'point' ? (isLine(axial) ? 'Point to line' : 'Point to axis') : isLine(axial) ? 'Center to line' : 'Center to axis');

/**
 * The exact relations between two picks, as professional CAD measures them: axis to axis (distance when parallel,
 * angle and closest approach when not), axis to plane, centre to centre, centre to axis, centre to plane, and the
 * angles between planes and axes. A plane with a plane gives its distance only when they're parallel.
 */
export function relations(A: Surface, B: Surface): Relation[] {
  const out: Relation[] = [];
  // Order a plane after an axial or central pick, so each pair is handled once.
  const rank = (s: Surface) => (s.kind === 'plane' ? 2 : axisOf(s) ? 0 : 1);
  if (rank(A) > rank(B)) [A, B] = [B, A];

  if (A.kind === 'plane' && B.kind === 'plane') {
    const angle = lineAngle(A.normal, B.normal);
    if (angle * Math.PI / 180 < 1e-4) {
      const distance = Math.abs(pointPlaneDistance(A.point, B.point, B.normal));
      out.push({ label: 'Distance', value: distance, unit: 'mm', note: 'parallel', from: A.point, to: add(A.point, scale(unit(B.normal), -pointPlaneDistance(A.point, B.point, B.normal))) });
      out.push({ label: 'Angle', value: 0, unit: 'deg', note: 'parallel' });
    } else {
      out.push({ label: 'Angle', value: degrees(Math.acos(clamp(dot(unit(A.normal), unit(B.normal)), -1, 1))), unit: 'deg' });
    }
    return out;
  }

  const axisA = axisOf(A), axisB = axisOf(B);
  const centerA = centerOf(A), centerB = centerOf(B);
  // Axis with axis: a torus or circle has an axis and a centre; the axes come first.
  if (axisA && axisB) {
    const closest = lineLine(axisA.point, axisA.axis, axisB.point, axisB.axis);
    const angle = lineAngle(axisA.axis, axisB.axis);
    const label = axisToAxis(A, B);
    if (closest.parallel) {
      out.push({ label, value: closest.distance, unit: 'mm', note: closest.distance < ZERO ? 'coaxial' : 'parallel', from: closest.a, to: closest.b });
    } else {
      out.push({ label: 'Angle', value: angle, unit: 'deg', note: `between ${isLine(A) !== isLine(B) ? 'axis and line' : isLine(A) ? 'lines' : 'axes'}` });
      // Two straight edges at an angle: the angle and the minimum distance say it all (their lines' closest approach
      // lies off the edges, as often as not).
      if (A.kind !== 'line' || B.kind !== 'line') out.push({ label, value: closest.distance, unit: 'mm', note: closest.distance < ZERO ? 'they cross' : 'closest approach', from: closest.a, to: closest.b });
    }
    if (centerA && centerB && (A.kind === 'circle' || A.kind === 'torus') && (B.kind === 'circle' || B.kind === 'torus')) {
      out.push({ label: 'Center distance', value: dist(centerA, centerB), unit: 'mm', from: centerA, to: centerB });
    }
    return out;
  }
  // Axis with a centre (a sphere, a vertex): the distance from the centre to the axis.
  if (axisA && centerB) {
    const foot = footOnLine(centerB, axisA.point, axisA.axis);
    out.push({ label: centerToAxis(B, A), value: dist(centerB, foot), unit: 'mm', from: foot, to: centerB });
    if (centerA && (A.kind === 'circle' || A.kind === 'torus' || A.kind === 'cone')) {
      const label = A.kind === 'cone' ? (B.kind === 'point' ? 'Point to apex' : 'Center to apex') : B.kind === 'point' ? 'Point to center' : 'Center distance';
      out.push({ label, value: dist(centerA, centerB), unit: 'mm' });
    }
    return out;
  }
  // Axis with a plane: the angle between them, and the distance when the axis runs parallel to the plane.
  if (axisA && B.kind === 'plane') {
    const n = unit(B.normal);
    const angle = 90 - lineAngle(axisA.axis, n);
    const along = Math.abs(dot(unit(axisA.axis), n)) < PARALLEL;
    if (along) {
      const d = pointPlaneDistance(axisA.point, B.point, n);
      out.push({ label: isLine(A) ? 'Line to plane' : 'Axis to plane', value: Math.abs(d), unit: 'mm', note: 'parallel', from: axisA.point, to: sub(axisA.point, scale(n, d)) });
    } else if (centerA) {
      const d = pointPlaneDistance(centerA, B.point, n);
      out.push({ label: A.kind === 'cone' ? 'Apex to plane' : 'Center to plane', value: Math.abs(d), unit: 'mm', from: centerA, to: sub(centerA, scale(n, d)) });
    }
    out.push({ label: 'Angle', value: angle, unit: 'deg', note: along ? 'parallel to the plane' : angle > 90 - 1e-6 ? 'perpendicular to the plane' : 'between axis and plane' });
    return out;
  }
  // Centre with centre, or with a plane.
  if (centerA && centerB) {
    // Two vertices: the minimum distance (and its ΔX, ΔY, ΔZ) is the distance.
    if (A.kind === 'point' && B.kind === 'point') return out;
    const label = A.kind === 'point' || B.kind === 'point' ? 'Point to center' : 'Center distance';
    out.push({ label, value: dist(centerA, centerB), unit: 'mm', from: centerA, to: centerB });
    return out;
  }
  if (centerA && B.kind === 'plane') {
    const d = pointPlaneDistance(centerA, B.point, B.normal);
    out.push({ label: A.kind === 'point' ? 'Point to plane' : 'Center to plane', value: Math.abs(d), unit: 'mm', from: centerA, to: sub(centerA, scale(unit(B.normal), d)) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Minimum distance on the displayed geometry.

function pointSegment(p: Vec, a: Vec, b: Vec): Vec {
  const ab = sub(b, a);
  const length = dot(ab, ab);
  const t = length > 0 ? clamp(dot(sub(p, a), ab) / length, 0, 1) : 0;
  return add(a, scale(ab, t));
}

/** The point of triangle abc nearest p (Ericson, Real-Time Collision Detection 5.1.5). */
export function pointTriangle(p: Vec, a: Vec, b: Vec, c: Vec): Vec {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
  const denominator = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denominator), scale(ac, vc * denominator)));
}

/** Closest points of segments p1q1 and p2q2 (Ericson 5.1.9). */
export function segmentSegment(p1: Vec, q1: Vec, p2: Vec, q2: Vec): [Vec, Vec] {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a <= 1e-18 && e <= 1e-18) return [p1, p2];
  if (a <= 1e-18) { s = 0; t = clamp(f / e, 0, 1); } else {
    const c = dot(d1, r);
    if (e <= 1e-18) { t = 0; s = clamp(-c / a, 0, 1); } else {
      const b = dot(d1, d2), denominator = a * e - b * b;
      s = denominator > 1e-18 ? clamp((b * f - c * e) / denominator, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

interface Box { min: Vec; max: Vec }
const boxOf = (points: Vec[]): Box => {
  const min: Vec = [Infinity, Infinity, Infinity], max: Vec = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  return { min, max };
};
const boxDistance = (a: Box, b: Box) => {
  let s = 0;
  for (let i = 0; i < 3; i++) { const gap = Math.max(0, a.min[i] - b.max[i], b.min[i] - a.max[i]); s += gap * gap; }
  return Math.sqrt(s);
};
const pointBox = (p: Vec, b: Box) => boxDistance({ min: p, max: p }, b);

/** Most primitive pairs one minimum distance tests before it settles for the vertices' estimate. */
export const MAX_TESTS = 4_000_000;

/**
 * The minimum distance between two picks' displayed geometry: between their triangles, segments and points (not just
 * their vertices), so a vertex above the middle of a flat face measures to the face. `exact` when both shapes are the
 * geometry itself (flat faces, straight edges, vertices) and the search was complete.
 */
export function minimumDistance(A: Shape, B: Shape): { distance: number; a: Vec; b: Vec; exact: boolean } | null {
  if (!A.points.length || !B.points.length) return null;
  // An upper bound from a sample of vertex pairs, then only primitives that could beat it.
  let best = Infinity, pa = A.points[0], pb = B.points[0];
  const stepA = Math.max(1, Math.floor(A.points.length / 1500)), stepB = Math.max(1, Math.floor(B.points.length / 1500));
  for (let i = 0; i < A.points.length; i += stepA) for (let j = 0; j < B.points.length; j += stepB) {
    const d = dist(A.points[i], B.points[j]);
    if (d < best) { best = d; pa = A.points[i]; pb = B.points[j]; }
  }
  const consider = (a: Vec, b: Vec) => { const d = dist(a, b); if (d < best) { best = d; pa = a; pb = b; } };
  const prims = (shape: Shape) => {
    const tris = (shape.triangles ?? []).map(([i, j, k]) => [shape.points[i], shape.points[j], shape.points[k]] as [Vec, Vec, Vec]);
    const segs: [Vec, Vec][] = (shape.segments ?? []).map(([i, j]) => [shape.points[i], shape.points[j]]);
    for (const [a, b, c] of tris) segs.push([a, b], [b, c], [c, a]);
    return { tris, segs, box: boxOf(shape.points) };
  };
  const PA = prims(A), PB = prims(B);
  const near = <T extends Vec[]>(items: T[], other: Box) => items.filter((item) => boxDistance(boxOf(item), other) <= best);
  const trisA = near(PA.tris, PB.box), trisB = near(PB.tris, PA.box);
  const segsA = near(PA.segs, PB.box), segsB = near(PB.segs, PA.box);
  const ptsA = A.points.filter((p) => pointBox(p, PB.box) <= best), ptsB = B.points.filter((p) => pointBox(p, PA.box) <= best);
  const tests = ptsA.length * (trisB.length + segsB.length) + ptsB.length * (trisA.length + segsA.length) + segsA.length * segsB.length + ptsA.length * ptsB.length;
  let complete = tests <= MAX_TESTS;
  if (complete) {
    for (const p of ptsA) { for (const [a, b, c] of trisB) consider(p, pointTriangle(p, a, b, c)); for (const [a, b] of segsB) consider(p, pointSegment(p, a, b)); for (const q of ptsB) consider(p, q); }
    for (const p of ptsB) { for (const [a, b, c] of trisA) { const q = pointTriangle(p, a, b, c); const d = dist(p, q); if (d < best) { best = d; pa = q; pb = p; } } for (const [a, b] of segsA) { const q = pointSegment(p, a, b); const d = dist(p, q); if (d < best) { best = d; pa = q; pb = p; } } }
    for (const [a1, b1] of segsA) for (const [a2, b2] of segsB) { const [x, y] = segmentSegment(a1, b1, a2, b2); consider(x, y); }
  } else {
    // Too many to test them all: every vertex pair instead (still an estimate).
    for (const p of ptsA) for (const q of ptsB) consider(p, q);
    complete = false;
  }
  return { distance: best, a: pa, b: pb, exact: complete && A.exact && B.exact };
}

/** Whether a surface or curve is exactly its displayed mesh (flat faces, straight edges, vertices). */
export const meshIsExact = (s: Surface) => s.kind === 'plane' || s.kind === 'line' || s.kind === 'point';


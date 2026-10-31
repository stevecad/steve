/**
 * Wrapped decals (`model.decal(..., wrap=True)`): the image laid along the surface like a vinyl sticker,
 * keeping its lengths on the skin, instead of projected along one direction. The target faces' triangles are unfolded
 * into the decal's plane from its centre by a discrete exponential map (Schmidt, Grimm & Wyvill, "Interactive Decal
 * Compositing with Discrete Exponential Maps", SIGGRAPH 2006): geodesic polar coordinates grown outward over the mesh in
 * Dijkstra order, each vertex placed from its nearest settled neighbour through that neighbour's tangent frame (the
 * edge projected onto it, at its full length), the frame carried along by the rotation between their normals. On a
 * plane that is the projection; on a cylinder or a cone it unrolls the surface; on a doubly curved patch it stretches
 * toward the edges (the runtime's warning says when). The front stops past `limit`, so the work is bounded by the
 * decal's own patch. Pure (no three.js) so it can be tested without WebGL.
 */

export type Vec3 = [number, number, number];

/** Triangles sharing their corners: points and unit normals (3 numbers each), 3 point indices per triangle. */
export interface Welded { points: Float64Array; normals: Float64Array; triangles: Uint32Array }

/**
 * Triangles given corner by corner (3 numbers a corner, 3 corners a triangle; normals alike) joined where corners meet
 * within `tolerance` mm: across the faces' borders and a closed face's seam, so the unfolding crosses them. A shared
 * point's normal is the mean of its corners'.
 */
export function weld(corners: ArrayLike<number>, normals: ArrayLike<number>, tolerance: number): Welded {
  const keys = new Map<string, number>();
  const points: number[] = [], sums: number[] = [];
  const triangles = new Uint32Array(Math.floor(corners.length / 9) * 3);
  for (let c = 0; c < triangles.length; c++) {
    const x = corners[3 * c], y = corners[3 * c + 1], z = corners[3 * c + 2];
    const key = `${Math.round(x / tolerance)},${Math.round(y / tolerance)},${Math.round(z / tolerance)}`;
    let i = keys.get(key);
    if (i === undefined) {
      i = points.length / 3;
      keys.set(key, i);
      points.push(x, y, z);
      sums.push(0, 0, 0);
    }
    sums[3 * i] += normals[3 * c]; sums[3 * i + 1] += normals[3 * c + 1]; sums[3 * i + 2] += normals[3 * c + 2];
    triangles[c] = i;
  }
  for (let i = 0; i < sums.length; i += 3) {
    const length = Math.hypot(sums[i], sums[i + 1], sums[i + 2]) || 1;
    sums[i] /= length; sums[i + 1] /= length; sums[i + 2] /= length;
  }
  return { points: Float64Array.from(points), normals: Float64Array.from(sums), triangles };
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: ArrayLike<number>, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const unit = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
const at = (array: Float64Array, i: number): Vec3 => [array[3 * i], array[3 * i + 1], array[3 * i + 2]];

/** The closest point to `p` on triangle abc (Ericson, Real-Time Collision Detection §5.1.5). */
function closest(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** `v` turned by the smallest rotation taking unit normal `from` to unit normal `to` (unchanged if they're opposite). */
function turn(v: Vec3, from: Vec3, to: Vec3): Vec3 {
  const c = dot(from, to);
  if (c <= -0.999) return v;
  const w = cross(from, to), wv = cross(w, v), k = dot(w, v) / (1 + c);
  return [v[0] * c + wv[0] + w[0] * k, v[1] * c + wv[1] + w[1] * k, v[2] * c + wv[2] + w[2] * k];
}

/** A tangent frame at unit normal `n`: `toward` made tangent (any tangent if it's along `n`), and n × that. */
function frame(n: Vec3, toward: Vec3): [Vec3, Vec3] {
  let e1 = sub(toward, scale(n, dot(toward, n)));
  if (Math.hypot(...e1) < 1e-9) e1 = sub(Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], scale(n, Math.abs(n[0]) < 0.9 ? n[0] : n[1]));
  e1 = unit(e1);
  return [e1, cross(n, e1)];
}

/** `offset` as seen in a tangent frame at normal `n`, at its own full length: one step of the exponential map. */
function step(offset: Vec3, n: Vec3, e1: Vec3, e2: Vec3): [number, number] {
  const tangent = sub(offset, scale(n, dot(offset, n)));
  const length = Math.hypot(...tangent);
  if (length < 1e-12) return [0, 0];
  const s = Math.hypot(...offset) / length;
  return [dot(tangent, e1) * s, dot(tangent, e2) * s];
}

/** A binary min-heap of (key, value). */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() { return this.keys.length; }
  push(key: number, value: number) {
    const keys = this.keys, values = this.values;
    let i = keys.length;
    keys.push(key); values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent]; values[i] = values[parent];
      i = parent;
    }
    keys[i] = key; values[i] = value;
  }
  pop(): [number, number] {
    const keys = this.keys, values = this.values;
    const top: [number, number] = [keys[0], values[0]];
    const key = keys.pop()!, value = values.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= keys.length) break;
        if (child + 1 < keys.length && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[i] = keys[child]; values[i] = values[child];
        i = child;
      }
      keys[i] = key; values[i] = value;
    }
    return top;
  }
}

/**
 * Each point's place in the decal's plane (u along `xDir` made tangent at the anchor, v across it, in mm along the
 * surface), grown from the point of `mesh` nearest `origin`: 2 numbers a point, NaN where the front didn't reach (past
 * `limit` mm along the mesh's edges, or cut off from the anchor). Null when the mesh has no triangle.
 */
export function unfold(mesh: Welded, origin: Vec3, xDir: Vec3, limit: number): Float64Array | null {
  const { points, normals, triangles } = mesh;
  const n = points.length / 3;
  let best = -1, bestDistance = Infinity, anchor: Vec3 = origin;
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const p = closest(origin, at(points, triangles[t]), at(points, triangles[t + 1]), at(points, triangles[t + 2]));
    const d = Math.hypot(...sub(p, origin));
    if (d < bestDistance) { best = t; bestDistance = d; anchor = p; }
  }
  if (best < 0) return null;
  const seeds = [triangles[best], triangles[best + 1], triangles[best + 2]];
  const n0 = unit(seeds.reduce<Vec3>((sum, i) => [sum[0] + normals[3 * i], sum[1] + normals[3 * i + 1], sum[2] + normals[3 * i + 2]], [0, 0, 0]));
  const [x0, y0] = frame(n0, xDir);

  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k], b = triangles[t + (k + 1) % 3];
      if (a !== b) { neighbours[a].push(b); neighbours[b].push(a); }
    }
  }
  const uv = new Float64Array(2 * n).fill(NaN);
  const distance = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-2);  // -2 not reached, -1 placed from the anchor itself.
  const e1 = new Float64Array(3 * n), e2 = new Float64Array(3 * n);
  const settled = new Uint8Array(n);
  const heap = new Heap();
  for (const i of seeds) {
    const d = Math.hypot(...sub(at(points, i), anchor));
    if (d < distance[i]) { distance[i] = d; parent[i] = -1; heap.push(d, i); }
  }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (settled[i]) continue;
    if (d > limit) break;
    settled[i] = 1;
    const p = at(points, i), np = at(normals, i);
    // Placed from its parent's tangent frame, and the frame carried over to its own normal.
    let from: Vec3, fn: Vec3, f1: Vec3, f2: Vec3, base: [number, number];
    if (parent[i] === -1) { from = anchor; fn = n0; f1 = x0; f2 = y0; base = [0, 0]; } else {
      const q = parent[i];
      from = at(points, q); fn = at(normals, q); f1 = at(e1, q); f2 = at(e2, q); base = [uv[2 * q], uv[2 * q + 1]];
    }
    const [du, dv] = step(sub(p, from), fn, f1, f2);
    uv[2 * i] = base[0] + du; uv[2 * i + 1] = base[1] + dv;
    const [g1] = frame(np, turn(f1, fn, np));
    const g2 = cross(np, g1);
    e1.set(g1, 3 * i); e2.set(g2, 3 * i);
    for (const j of neighbours[i]) {
      if (settled[j]) continue;
      const nd = d + Math.hypot(...sub(at(points, j), p));
      if (nd < distance[j]) { distance[j] = nd; parent[j] = i; heap.push(nd, j); }
    }
  }
  return uv;
}

/**
 * Contour chains from picked edges, oriented as the engine orients them (docs/MANUFACTURING_CONTOURS.md): a named
 * open chain runs from its lexicographically smaller endpoint in machine XY, a closed chain runs counterclockwise.
 * "Left"/"right" are the cutter's side walking along that direction, so the editor shows it before asking. Pure
 * (no app imports): tests/cam_player_test.mjs runs it under node. Display hints only; the engine resolves the chain.
 */
export type XY = [number, number];

/** One picked edge: its name and its polyline in the work frame (XY; Z is the plane it lies in). */
export interface ChainEdge { name: string; points: XY[]; z: number }

export interface Chain {
  /** The edge names in walking order. */
  order: string[];
  points: XY[];
  closed: boolean;
  z: number;
}

export type ChainProblem = 'empty' | 'planes' | 'disconnected' | 'branched';

const EPS = 1e-4;
const same = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS;
const less = (a: XY, b: XY) => a[0] < b[0] - 1e-9 || (Math.abs(a[0] - b[0]) <= 1e-9 && a[1] < b[1] - 1e-9);

/** Twice the signed area of a closed polyline (positive: counterclockwise). */
export function signedArea(points: XY[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i], [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return area;
}

/**
 * Joins picked edges end to end into one chain and orients it like the engine. An open chain's direction is decided in
 * machine XY; the setup only translates the work frame, which keeps the same endpoint the smaller one. Returns why not
 * when the edges don't make one simple chain.
 */
export function orderChain(edges: ChainEdge[]): Chain | ChainProblem {
  if (!edges.length) return 'empty';
  if (edges.some((edge) => Math.abs(edge.z - edges[0].z) > 1e-4)) return 'planes';
  const ends = edges.map((edge) => [edge.points[0], edge.points[edge.points.length - 1]] as [XY, XY]);
  // Every endpoint meets at most one other edge's endpoint (a branch would meet two).
  for (let i = 0; i < edges.length; i++) {
    for (const end of ends[i]) {
      const meets = ends.reduce((count, other, j) => count + (j !== i && (same(other[0], end) || same(other[1], end)) ? 1 : 0), 0);
      if (meets > 1) return 'branched';
    }
  }
  const free = (i: number, end: XY) => !ends.some((other, j) => j !== i && (same(other[0], end) || same(other[1], end)));
  // Start at a free end (open chain), else anywhere (closed).
  let start = 0, reversed = false;
  for (let i = 0; i < edges.length; i++) {
    if (free(i, ends[i][0])) { start = i; reversed = false; break; }
    if (free(i, ends[i][1])) { start = i; reversed = true; break; }
  }
  const used = new Set<number>([start]);
  const order = [edges[start].name];
  let points = reversed ? [...edges[start].points].reverse() : [...edges[start].points];
  while (used.size < edges.length) {
    const tail = points[points.length - 1];
    const next = edges.findIndex((_, j) => !used.has(j) && (same(ends[j][0], tail) || same(ends[j][1], tail)));
    if (next < 0) return 'disconnected';
    used.add(next);
    order.push(edges[next].name);
    const run = same(ends[next][0], tail) ? edges[next].points : [...edges[next].points].reverse();
    points = [...points, ...run.slice(1)];
  }
  const closed = points.length > 2 && same(points[0], points[points.length - 1]);
  if (closed) {
    points = points.slice(0, -1);
    if (signedArea(points) < 0) { points = [points[0], ...points.slice(1).reverse()]; order.reverse(); }
  } else if (less(points[points.length - 1], points[0])) {
    points = [...points].reverse();
    order.reverse();
  }
  return { order, points, closed, z: edges[0].z };
}

/**
 * The cutter centre's path for a side at a radius, as a display approximation (vertex normals averaged, no arc joins):
 * the engine computes the real offset with Clipper2/OCCT. Left is +90° from the walking direction.
 */
export function offsetPath(points: XY[], closed: boolean, side: 'left' | 'right', radius: number): XY[] {
  const n = points.length;
  if (n < 2) return points;
  const sign = side === 'left' ? 1 : -1;
  const normal = (a: XY, b: XY): XY => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
    return [-dy / length * sign, dx / length * sign];
  };
  return points.map((point, i) => {
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const a = i > 0 || closed ? normal(prev, point) : normal(point, next);
    const b = i < n - 1 || closed ? normal(point, next) : normal(prev, point);
    const mx = a[0] + b[0], my = a[1] + b[1], length = Math.hypot(mx, my);
    if (length < 1e-9) return [point[0] + a[0] * radius, point[1] + a[1] * radius];
    // Keep the offset distance on sharp corners (miter, capped).
    const cos = Math.max(0.25, (a[0] * mx + a[1] * my) / length);
    return [point[0] + (mx / length) * (radius / cos), point[1] + (my / length) * (radius / cos)];
  });
}

/** Length of a polyline. */
export const pathLength = (points: XY[], closed = false) => points.reduce((sum, point, i) => {
  const next = points[i + 1] ?? (closed ? points[0] : null);
  return next ? sum + Math.hypot(next[0] - point[0], next[1] - point[1]) : sum;
}, 0);

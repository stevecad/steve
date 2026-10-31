/**
 * Trace engraving paths (docs/MANUFACTURING_ENGRAVING.md): the engine engraves explicit centrelines in setup XY at a
 * constant depth with a conical cutter. The editor builds them from picked sketch curves and model edges: each curve
 * becomes straight segments within a stated tolerance, pieces that meet end to end join into one path (as the contour
 * chain picker joins edges), and a loop is declared closed without its repeated first point. Pure (no imports):
 * tests/cam_player_test.mjs runs it under node.
 */
export type XY = [number, number];

/** One picked piece (a sketch curve or a model edge) as a polyline in work XY. */
export interface EngravePiece { name: string; points: XY[] }

/** A path as the engine takes it, with the pieces it came from (in walking order). */
export interface EngravePath { id: string; points: XY[]; closed: boolean; from: string[] }

const EPS = 1e-4;
const same = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= EPS;

/** Rounded to a micrometre, as the engine compares points (and saved JSON stays short). */
const round = ([x, y]: XY): XY => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6];

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Fewer points, every dropped one within `tolerance` of the kept segments (Douglas–Peucker). A densely sampled curve
 * simplified this way stays within the tolerance of the curve. A loop (first point = last) keeps its far point too.
 */
export function simplify(points: XY[], tolerance: number): XY[] {
  if (points.length <= 2) return points;
  if (same(points[0], points[points.length - 1])) {
    let far = 1, distance = -1;
    points.forEach((point, i) => { const d = Math.hypot(point[0] - points[0][0], point[1] - points[0][1]); if (d > distance) { distance = d; far = i; } });
    if (far > 0 && far < points.length - 1) return [...simplify(points.slice(0, far + 1), tolerance).slice(0, -1), ...simplify(points.slice(far), tolerance)];
  }
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let index = -1, distance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = segmentDistance(points[i], points[first], points[last]);
      if (d > distance) { distance = d; index = i; }
    }
    if (index >= 0) { keep[index] = 1; stack.push([first, index], [index, last]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Consecutive repeated points removed (the engine needs every segment to have length). */
function distinct(points: XY[]): XY[] {
  const out: XY[] = [];
  for (const point of points.map(round)) if (!out.length || !same(out[out.length - 1], point)) out.push(point);
  return out;
}

/** Pieces whose ends meet, grouped (each group joins into one path when it doesn't branch). */
function groups(pieces: EngravePiece[]): EngravePiece[][] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ends = pieces.map((piece) => [piece.points[0], piece.points[piece.points.length - 1]]);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (ends[i].some((a) => ends[j].some((b) => same(a, b)))) parent[find(i)] = find(j);
    }
  }
  const out = new Map<number, EngravePiece[]>();
  pieces.forEach((piece, i) => { const root = find(i); out.set(root, [...(out.get(root) ?? []), piece]); });
  return [...out.values()];
}

/** One group walked end to end from a free end (or anywhere, for a loop); null when it branches. */
function walk(group: EngravePiece[]): { points: XY[]; order: string[] } | null {
  const ends = group.map((piece) => [piece.points[0], piece.points[piece.points.length - 1]] as [XY, XY]);
  const meets = (i: number, end: XY) => ends.reduce((count, other, j) => count + (j !== i && (same(other[0], end) || same(other[1], end)) ? 1 : 0), 0);
  if (ends.some((pair, i) => pair.some((end) => meets(i, end) > 1))) return null;
  let start = 0, reversed = false;
  for (let i = 0; i < group.length; i++) {
    if (!meets(i, ends[i][0])) { start = i; reversed = false; break; }
    if (!meets(i, ends[i][1])) { start = i; reversed = true; break; }
  }
  const used = new Set([start]);
  const order = [group[start].name];
  let points = reversed ? [...group[start].points].reverse() : [...group[start].points];
  while (used.size < group.length) {
    const tail = points[points.length - 1];
    const next = group.findIndex((_, j) => !used.has(j) && (same(ends[j][0], tail) || same(ends[j][1], tail)));
    if (next < 0) return null;
    used.add(next);
    order.push(group[next].name);
    const run = same(ends[next][0], tail) ? group[next].points : [...group[next].points].reverse();
    points = [...points, ...run.slice(1)];
  }
  return { points, order };
}

/**
 * Engraving paths from picked pieces: pieces meeting end to end join (a loop closes), a branching group keeps its
 * pieces apart. Ids are path_1, path_2… in the order of each group's first piece.
 */
export function joinPieces(pieces: EngravePiece[]): EngravePath[] {
  const usable = pieces.map((piece) => ({ ...piece, points: distinct(piece.points) })).filter((piece) => piece.points.length >= 2);
  const paths: Omit<EngravePath, 'id'>[] = [];
  const add = (points: XY[], closed: boolean, from: string[]) => {
    let run = distinct(points);
    if (run.length > 2 && same(run[0], run[run.length - 1])) { run = run.slice(0, -1); closed = true; }
    if (closed && run.length < 3) closed = false;
    if (run.length >= 2) paths.push({ points: run, closed, from });
  };
  for (const group of groups(usable)) {
    const chain = walk(group);
    if (!chain) group.forEach((piece) => add(piece.points, false, [piece.name]));
    else add(chain.points, false, chain.order);
  }
  return paths.map((path, i) => ({ id: `path_${i + 1}`, ...path }));
}

/** A conical cutter as the editor knows it (mm, radians). */
export interface ConicalCutter { diameter: number; tipDiameter: number; angle: number }

/**
 * The groove's width at the surface for a depth: the cone's diameter that high above the tip, at most the cutter's
 * diameter (the engine's `surface_width_mm`).
 */
export function engraveWidth(cutter: ConicalCutter, depth: number): number {
  const radius = cutter.diameter / 2, tip = cutter.tipDiameter / 2;
  return 2 * Math.min(radius, tip + Math.max(0, depth) * Math.tan(cutter.angle / 2));
}

/** The depth at which the cone reaches its full diameter (deeper cuts the cylindrical flutes too). */
export const coneHeight = (cutter: ConicalCutter) => (cutter.diameter - cutter.tipDiameter) / 2 / Math.tan(cutter.angle / 2);

/** Total length of the paths, in mm. */
export const pathsLength = (paths: { points: XY[]; closed: boolean }[]) => paths.reduce((sum, path) => sum + path.points.reduce((length, point, i) => {
  const next = path.points[i + 1] ?? (path.closed ? path.points[0] : null);
  return next ? length + Math.hypot(next[0] - point[0], next[1] - point[1]) : length;
}, 0), 0);

/**
 * Chamfering with the same conical cutter (docs/MANUFACTURING_CHAMFER.md). The flank's slope is k = (R − r)/h, the
 * tangent of half the included angle. A new chamfer `width` wide (measured horizontally across the top face) on a sharp
 * edge at height `edgeZ` has its lower edge at `edgeZ − width/k` — the operation's bottom height, which the engine
 * checks against the selected edge (`chamfer_depth_mismatch`). The tip runs `tipOffset` below that; the centreline is
 * `r + k·tipOffset` outside the lower edge. Width, tip offset and the bevel must fit the cone: r + width + k·tipOffset ≤ R.
 */
export const chamferSlope = (cutter: ConicalCutter) => Math.tan(cutter.angle / 2);

/** The lower chamfer edge (the operation's bottom height) for a new chamfer on a sharp edge at `edgeZ`. */
export const chamferBottom = (edgeZ: number, width: number, cutter: ConicalCutter) => edgeZ - width / chamferSlope(cutter);

/** How far the tip's centreline runs outside the lower chamfer edge (before the engine's small geometry guard). */
export const chamferOffset = (tipOffset: number, cutter: ConicalCutter) => cutter.tipDiameter / 2 + chamferSlope(cutter) * tipOffset;

/** Whether the bevel (plus the tip offset) lies on the cone, below the cutter's full diameter. */
export const chamferFits = (width: number, tipOffset: number, cutter: ConicalCutter) =>
  chamferOffset(tipOffset, cutter) + width <= cutter.diameter / 2 + 1e-9;

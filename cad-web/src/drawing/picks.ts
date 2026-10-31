/**
 * What can be picked on a sheet: the build traces each visible line of a view to the model edge it lies on and writes
 * it into the sheet's SVG as an unstroked layer (runtime/steve/drawing.py `_picks`: `<g data-picks>`, each path with
 * its view, kind, persistent name and the face it shows edge-on). The Drawing tab's tools read that layer here and
 * find what's under the pointer, in the sheet's frame (paper mm, y down).
 */
export type Point = [number, number];

export interface SheetPick {
  view: string;
  /** edge, circle (seen face-on), silhouette (a cylinder seen side-on), seam, vertex, or a design's instance. */
  kind: string;
  /** The persistent name of what it is on the model (`edge(a|b)`, `vertex(a|b|c)`, an instance), or null when the
   *  model has none (plain CadQuery). */
  ref: string | null;
  /** The face it shows edge-on, or a circle's or silhouette's wall (`hole_1.wall(0)`). */
  face: string | null;
  points: Point[];
  /** A circle's centre and radius on the sheet. */
  centre?: Point;
  radius?: number;
}

function pathPoints(d: string): Point[] {
  const numbers = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) ?? [];
  const out: Point[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) out.push([numbers[i], numbers[i + 1]]);
  return out;
}

/** Every pickable thing on a sheet, read from its pick layer (none on sheets built before it existed). */
export function readPicks(svg: SVGSVGElement | null): SheetPick[] {
  const out: SheetPick[] = [];
  if (!svg) return out;
  for (const element of svg.querySelectorAll('[data-picks] [data-pick]')) {
    const base = { view: element.getAttribute('data-view') ?? '', kind: element.getAttribute('data-pick') ?? 'edge',
      ref: element.getAttribute('data-ref'), face: element.getAttribute('data-face') };
    if (element.tagName.toLowerCase() === 'circle') {
      const point: Point = [Number(element.getAttribute('cx')), Number(element.getAttribute('cy'))];
      out.push({ ...base, points: [point], centre: point });
      continue;
    }
    const points = pathPoints(element.getAttribute('d') ?? '');
    if (points.length < 2) continue;
    const pick: SheetPick = { ...base, points };
    if (base.kind === 'circle') {
      const ring = points.length > 2 && Math.hypot(points[0][0] - points.at(-1)![0], points[0][1] - points.at(-1)![1]) < 1e-6 ? points.slice(1) : points;
      const centre: Point = [ring.reduce((sum, p) => sum + p[0], 0) / ring.length, ring.reduce((sum, p) => sum + p[1], 0) / ring.length];
      pick.centre = centre;
      pick.radius = ring.reduce((sum, p) => sum + Math.hypot(p[0] - centre[0], p[1] - centre[1]), 0) / ring.length;
    }
    out.push(pick);
  }
  // A circle's seam is a vertex of the model but no corner on the sheet: a click there means the circle.
  const circles = out.filter((pick) => pick.kind === 'circle' && pick.centre && pick.radius);
  const ends = out.filter((pick) => pick.points.length > 1 && pick.kind !== 'circle').flatMap((pick) => [pick.points[0], pick.points[pick.points.length - 1]]);
  const near = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;
  return out.filter((pick) => pick.kind !== 'vertex' || ends.some((end) => near(end, pick.points[0]))
    || !circles.some((circle) => Math.abs(Math.hypot(pick.points[0][0] - circle.centre![0], pick.points[0][1] - circle.centre![1]) - circle.radius!) < 0.05));
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** How far a pick is from a point on the sheet (a circle: from its rim or, nearer still, its centre). */
export function distance(pick: SheetPick, p: Point): number {
  if (pick.points.length === 1) return Math.hypot(p[0] - pick.points[0][0], p[1] - pick.points[0][1]);
  let best = Infinity;
  for (let i = 1; i < pick.points.length; i++) best = Math.min(best, segmentDistance(p, pick.points[i - 1], pick.points[i]));
  if (pick.centre) best = Math.min(best, Math.hypot(p[0] - pick.centre[0], p[1] - pick.centre[1]));
  return best;
}

/** What's under `p` within `reach` (paper mm): a vertex before the line it ends, else the nearest line. */
export function pickAt(picks: SheetPick[], p: Point, reach: number, accept: (pick: SheetPick) => boolean = () => true): SheetPick | null {
  let best: SheetPick | null = null, bestDistance = Infinity;
  for (const pick of picks) {
    if (!accept(pick)) continue;
    const d = distance(pick, p) - (pick.kind === 'vertex' ? reach * 0.4 : 0);  // Corners win near their lines' ends.
    if (d < bestDistance && distance(pick, p) <= reach) { best = pick; bestDistance = d; }
  }
  return best;
}

/** The point a pick stands for: a vertex, a circle's centre, a line's middle. */
export function anchorOf(pick: SheetPick): Point {
  if (pick.centre) return pick.centre;
  const [a, b] = [pick.points[0], pick.points[pick.points.length - 1]];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** What a pick names for a feature dimension or GD&T: a circle's or cylinder's wall, a face seen edge-on when two
 *  lines are measured between, else the edge or vertex itself. */
export function refFor(pick: SheetPick, between = false): string | null {
  if ((pick.kind === 'circle' || pick.kind === 'silhouette') && pick.face) return pick.face;
  if (between && pick.face) return pick.face;
  return pick.ref;
}

/** The SVG path of a pick, for highlighting it. */
export function pathOf(pick: SheetPick): string {
  return pick.points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(3)} ${p[1].toFixed(3)}`).join(' ');
}

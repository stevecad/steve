/**
 * A feature dimension as the Dimension tool previews it while it's picked and placed (drawing/Paper.tsx, and its
 * value in the tool's Dock panel): what it measures and its value, from the picks on the sheet (paper mm, y down) and
 * the view's scale, the way the build measures it (runtime/steve/drawing.py `_measure`) and writes its text (`_figure`,
 * `_label`), and its lines drawn toward the pointer. Measured on the sheet, a value is exact for geometry lying flat in
 * the view; the build measures the model itself, and its sheet replaces the preview.
 */
import type { Point, SheetPick } from './picks';

export type DimensionKind = 'length' | 'distance' | 'diameter' | 'radius' | 'angle';

export const KIND_TITLES: Record<DimensionKind, string> = { length: 'Length', distance: 'Distance', diameter: 'Diameter', radius: 'Radius', angle: 'Angle' };

/** Where a dimension sits, on the sheet (paper mm, y down), as the build's measuring describes it. */
export type DimensionShape =
  | { type: 'linear'; axis: 'x' | 'y'; at: [Point, Point]; spans: [[number, number], [number, number]] }
  | { type: 'aligned'; at: [Point, Point] }
  | { type: 'round'; centre: Point; radius: number }
  | { type: 'angle'; corner: Point; legs: [Point, Point]; reach: [number, number] };

/** What a dimension measures: its kind, its value (model mm, or degrees; null when the sheet can't tell) and where. */
export interface Measured { kind: DimensionKind; value: number | null; symbol: string; shape: DimensionShape | null }

type Pickish = Pick<SheetPick, 'kind' | 'points' | 'face'> & { centre?: Point; radius?: number };

const EPS = 0.01;  // Paper mm: the pick layer's coordinates are written to 3 places.
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const add = (a: Point, b: Point, k = 1): Point => [a[0] + k * b[0], a[1] + k * b[1]];
const len = (v: Point) => Math.hypot(v[0], v[1]);
const unit = (v: Point): Point => { const l = len(v) || 1; return [v[0] / l, v[1] / l]; };
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const ends = (pick: Pickish): [Point, Point] => [pick.points[0], pick.points[pick.points.length - 1]];
const isPoint = (pick: Pickish) => pick.kind === 'vertex' || pick.kind === 'circle';
const closed = (pick: Pickish) => pick.points.length > 2 && len(sub(pick.points[0], pick.points[pick.points.length - 1])) < EPS;

/** A circle's (or arc's) centre and radius on the sheet: a whole circle's from the pick layer, an arc's through its
 *  ends and middle. */
function circleOf(pick: Pickish): { centre: Point; radius: number } | null {
  if (closed(pick) || pick.points.length < 3) return pick.centre && pick.radius !== undefined ? { centre: pick.centre, radius: pick.radius } : null;
  const [a, b, c] = [pick.points[0], pick.points[Math.floor(pick.points.length / 2)], pick.points[pick.points.length - 1]];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: Point) => p[0] * p[0] + p[1] * p[1];
  const centre: Point = [(sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d, (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d];
  return { centre, radius: len(sub(a, centre)) };
}

const pointOf = (pick: Pickish): Point | null => (pick.kind === 'circle' ? circleOf(pick)?.centre ?? null : pick.points[0]);

/** Whether a line on the sheet is straight. */
function straight(pick: Pickish): boolean {
  const [a, b] = ends(pick);
  const l = len(sub(b, a));
  return l > EPS && pick.points.every((p) => Math.abs(cross(sub(b, a), sub(p, a))) / l < 0.05);
}

/** Where a feature is along a paper axis (0: x, 1: y): a point's, or a line's that runs across it; else null. */
function coordinate(pick: Pickish, axis: 0 | 1): number | null {
  if (isPoint(pick)) return pointOf(pick)?.[axis] ?? null;
  const first = pick.points[0][axis];
  return pick.points.every((p) => Math.abs(p[axis] - first) < EPS) ? first : null;
}

/** How far a feature reaches across a paper axis (the extension line starts at its end nearest the dimension line). */
function span(pick: Pickish, axis: 0 | 1): [number, number] {
  const point = isPoint(pick) ? pointOf(pick) : null;
  const values = point ? [point[axis]] : pick.points.map((p) => p[axis]);
  return [Math.min(...values), Math.max(...values)];
}

/** A distance between two features (`_measure`'s last case): along the paper's x or y, or aligned between two points
 *  when neither (or both) differ and both are points; `direction` as written by the placement. */
function distance(picks: Pickish[], direction?: 'horizontal' | 'vertical'): Pick<Measured, 'value' | 'shape'> {
  const options = ([['horizontal', 0], ['vertical', 1]] as const)
    .filter(([name]) => !direction || direction === name)
    .map(([name, axis]) => ({ name, axis, values: picks.map((pick) => coordinate(pick, axis)) }))
    .filter((option) => option.values.every((value) => value !== null)) as { name: string; axis: 0 | 1; values: number[] }[];
  const nonzero = options.filter((option) => Math.abs(option.values[1] - option.values[0]) > EPS);
  if (!direction && nonzero.length !== 1 && picks.every(isPoint)) {
    const [a, b] = picks.map(pointOf);
    if (!a || !b || len(sub(b, a)) <= EPS) return { value: null, shape: null };
    return { value: len(sub(b, a)), shape: { type: 'aligned', at: [a, b] } };
  }
  const chosen = nonzero.length === 1 ? nonzero[0] : options[0];
  if (!chosen || Math.abs(chosen.values[1] - chosen.values[0]) <= EPS) return { value: null, shape: null };
  const across = chosen.axis === 0 ? 1 : 0;
  const spans = picks.map((pick) => span(pick, across)) as [[number, number], [number, number]];
  const at = chosen.values.map((value, i) => (chosen.axis === 0 ? [value, spans[i][0]] : [spans[i][0], value])) as [Point, Point];
  return { value: Math.abs(chosen.values[1] - chosen.values[0]), shape: { type: 'linear', axis: chosen.axis === 0 ? 'x' : 'y', at, spans } };
}

/** The angle between two straight lines (`_measure`'s angle): between the legs from where they meet to each one's
 *  middle. */
function angle(lines: Pickish[]): Pick<Measured, 'value' | 'shape'> {
  if (!lines.every(straight)) return { value: null, shape: null };
  const [[a1, b1], [a2, b2]] = lines.map(ends);
  const [d1, d2] = [sub(b1, a1), sub(b2, a2)];
  const turn = cross(d1, d2);
  if (Math.abs(turn) <= 1e-9 * len(d1) * len(d2)) return { value: null, shape: null };
  const t = cross(sub(a2, a1), d2) / turn;
  const corner = add(a1, d1, t);
  const legs: Point[] = [], reach: number[] = [];
  for (const [[a, b], d] of [[[a1, b1], d1], [[a2, b2], d2]] as [[Point, Point], Point][]) {
    const leg = sub([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], corner);
    const l = len(leg);
    legs.push(unit(l <= EPS ? d : leg));
    reach.push(l <= EPS ? 0 : l);
  }
  const degrees = (Math.acos(Math.max(-1, Math.min(1, legs[0][0] * legs[1][0] + legs[0][1] * legs[1][1]))) * 180) / Math.PI;
  return { value: degrees, shape: { type: 'angle', corner, legs: legs as [Point, Point], reach: reach as [number, number] } };
}

/**
 * What the picks measure, as the build infers it with no kind written (a circle's diameter, or radius when `radius`
 * is chosen or it's an arc; a straight edge's length; two lines' angle, unless they're parallel; else the distance
 * between two), its value at the view's `scale` and where it is on the sheet. `direction`: a distance between points
 * placed above or below them is horizontal, beside them vertical (code.ts dimensionPlacement). Null when nothing
 * measurable is picked yet (one corner).
 */
export function measure(picks: Pickish[], scale: number, options: { radius?: boolean; direction?: 'horizontal' | 'vertical' } = {}): Measured | null {
  if (!picks.length || !(scale > 0)) return null;
  const mm = (found: Pick<Measured, 'value' | 'shape'>, kind: DimensionKind): Measured =>
    ({ kind, symbol: '', shape: found.shape, value: found.value === null ? null : found.value / scale });
  if (picks.length === 1) {
    const [pick] = picks;
    if (pick.kind === 'vertex') return null;
    if (pick.kind === 'circle') {
      const radius = options.radius || (!closed(pick) && pick.points.length > 2 && !pick.face);
      const circle = circleOf(pick);
      const kind = radius ? 'radius' : 'diameter';
      if (!circle) return { kind, value: null, symbol: radius ? 'R' : '⌀', shape: null };
      return { kind, symbol: radius ? 'R' : '⌀', shape: { type: 'round', ...circle }, value: (radius ? circle.radius : 2 * circle.radius) / scale };
    }
    // A cylinder seen side-on is its diameter, across to its other side: the build finds that one.
    if (pick.kind === 'silhouette') return { kind: 'diameter', value: null, symbol: '⌀', shape: null };
    if (!straight(pick)) return { kind: 'length', value: null, symbol: '', shape: null };
    return mm(distance(ends(pick).map((p) => ({ kind: 'vertex', points: [p], face: null }))), 'length');
  }
  const lines = picks.filter((pick) => !isPoint(pick));
  if (lines.length === 2) {
    const [d1, d2] = lines.map((line) => { const [a, b] = ends(line); return unit(sub(b, a)); });
    if (Math.abs(cross(d1, d2)) > 0.02) { const found = angle(lines); return { kind: 'angle', symbol: '', ...found }; }
  }
  return mm(distance(picks.slice(0, 2), picks.every(isPoint) ? options.direction : undefined), 'distance');
}

/** `value` to `places` places, a half rounded away from zero (.8125 → .813, whatever `toFixed`'s tie does), after
 *  float noise past the 9th place is snapped off (`_fixed`). */
function fixed(value: number, places: number): string {
  if (!Number.isFinite(value)) return value.toFixed(places);
  const [whole, fraction] = Math.abs(value).toFixed(9).split('.');
  const kept = Number(whole + fraction.slice(0, places)) + (fraction[places] >= '5' ? 1 : 0);
  const digits = String(kept).padStart(places + 1, '0');
  const text = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return value < 0 ? `-${text}` : text;
}

/** Places an inch value is written to by default (`_inch_places`): 3, or 4 when it is exactly a four-place size
 *  such as a sixteenth (.8125, .4375, .0625). */
function inchPlaces(value: number): number {
  if (!Number.isFinite(value)) return 3;
  const fraction = Math.abs(value).toFixed(7).split('.')[1];
  return fraction[3] !== '0' && /^0*$/.test(fraction.slice(4)) ? 4 : 3;
}

/** A number as dimension text (`_figure`): millimetres to 2 places with trailing zeros dropped, inches to 3 (4 for
 *  an exact four-place size) with no leading zero (ASME Y14.5), or exactly `places` places; halves round up. */
export function figure(value: number, units: 'mm' | 'in', places?: number): string {
  let text = places === undefined ? (units === 'in' ? fixed(value, inchPlaces(value)) : fixed(value, 2).replace(/0+$/, '').replace(/\.$/, '')) : fixed(value, places);
  if (Number(text) === 0) text = text.replace(/^-/, '');
  if (units === 'in') text = text.replace(/^(-?)0\./, '$1.');
  return text;
}

/** A measured value as the sheet writes it (`_label`, with no tolerance or override): ⌀ or R, in the sheet's units;
 *  angles in whole degrees, or to one place. `dual`: the second unit in brackets after a length (`dual_units`), to
 *  `dualPlaces` places or that unit's usual ones. */
export function dimensionText(measured: Measured, units: 'mm' | 'in', dual?: 'mm' | 'in' | null, dualPlaces?: number): string | null {
  const { value } = measured;
  if (value === null) return null;
  if (measured.kind === 'angle') return `${figure(value, 'mm', Math.abs(value - Math.round(value)) < 1e-6 ? 0 : 1)}°`;
  const text = measured.symbol + figure(units === 'in' ? value / 25.4 : value, units);
  return dual && dual !== units ? `${text} [${figure(dual === 'in' ? value / 25.4 : value, dual, dualPlaces)}]` : text;
}

/** A dimension's lines, arrowheads and text on the sheet (paper mm, y down), toward point `p`. */
export interface DimensionDrawing {
  lines: [Point, Point][];
  arc?: string;
  arrows: Point[][];
  text: { at: Point; rotate: number; anchor: 'start' | 'middle' | 'end' };
}

const ARROW = 3, OVER = 1.5;  // The build's arrowheads (3 mm × 1 mm) and how far extension lines go past.

/** An arrowhead at `tip`, its back toward `toward` (`Sheet.arrow`). */
function arrow(tip: Point, toward: Point): Point[] {
  const u = unit(toward);
  const back = add(tip, u, ARROW);
  return [tip, [back[0] - 0.5 * u[1], back[1] + 0.5 * u[0]], [back[0] + 0.5 * u[1], back[1] - 0.5 * u[0]]];
}

/** Text along a line reads from the bottom or the right. */
const readable = (degrees: number) => (degrees >= 90 ? degrees - 180 : degrees < -90 ? degrees + 180 : degrees);

export function drawDimension(shape: DimensionShape, p: Point): DimensionDrawing {
  const lines: [Point, Point][] = [];
  if (shape.type === 'linear' || shape.type === 'aligned') {
    let a: Point, b: Point, feet: [Point, Point];
    if (shape.type === 'linear') {
      const along = shape.axis === 'x' ? 0 : 1, across = 1 - along;
      const level = p[across];
      const point = (at: number, level: number): Point => (along === 0 ? [at, level] : [level, at]);
      a = point(shape.at[0][along], level);
      b = point(shape.at[1][along], level);
      feet = shape.spans.map(([min, max], i) => point(shape.at[i][along], Math.min(max, Math.max(min, level)))) as [Point, Point];
    } else {
      const u = unit(sub(shape.at[1], shape.at[0]));
      const n: Point = [-u[1], u[0]];
      const out = (p[0] - shape.at[0][0]) * n[0] + (p[1] - shape.at[0][1]) * n[1];
      [a, b] = [add(shape.at[0], n, out), add(shape.at[1], n, out)];
      feet = shape.at;
    }
    [[feet[0], a], [feet[1], b]].forEach(([foot, end]) => {
      const out = sub(end, foot);
      if (len(out) > EPS) lines.push([foot, add(end, unit(out), OVER)]);
    });
    lines.push([a, b]);
    const middle: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const direction = sub(b, a);
    const rotate = readable((Math.atan2(direction[1], direction[0]) * 180) / Math.PI);
    const up: Point = [Math.sin((rotate * Math.PI) / 180), -Math.cos((rotate * Math.PI) / 180)];  // Above the line, as read.
    return { lines, arrows: [arrow(a, direction), arrow(b, [-direction[0], -direction[1]])], text: { at: add(middle, up, 1), rotate, anchor: 'middle' } };
  }
  if (shape.type === 'round') {
    const toward = unit(len(sub(p, shape.centre)) > EPS ? sub(p, shape.centre) : [1, -1]);
    const rim = add(shape.centre, toward, shape.radius);
    const end = len(sub(p, shape.centre)) > shape.radius + ARROW ? p : add(shape.centre, toward, shape.radius + ARROW + 2);
    const shoulder: Point = [end[0] + (toward[0] >= 0 ? 3 : -3), end[1]];
    lines.push([rim, end], [end, shoulder]);
    const right = toward[0] >= 0;
    return { lines, arrows: [arrow(rim, toward)], text: { at: [shoulder[0] + (right ? 1 : -1), shoulder[1] - 1], rotate: 0, anchor: right ? 'start' : 'end' } };
  }
  const { corner, legs, reach } = shape;
  const radius = Math.max(len(sub(p, corner)), ARROW * 2);
  const [s, e] = legs.map((leg) => add(corner, leg, radius));
  const sweep = cross(legs[0], legs[1]) > 0 ? 1 : 0;
  legs.forEach((leg, i) => { if (radius > reach[i]) lines.push([add(corner, leg, reach[i]), add(corner, leg, radius + OVER)]); });
  const sign = sweep ? 1 : -1;
  const tangent = (leg: Point, k: number): Point => [-leg[1] * k, leg[0] * k];
  const bisector = unit(add(legs[0], legs[1]));
  return {
    lines, arc: `M${s[0]} ${s[1]} A${radius} ${radius} 0 0 ${sweep} ${e[0]} ${e[1]}`,
    arrows: [arrow(s, tangent(legs[0], sign)), arrow(e, tangent(legs[1], -sign))],
    text: { at: add(corner, len(bisector) > EPS ? bisector : legs[0], radius + 2), rotate: 0, anchor: 'middle' },
  };
}

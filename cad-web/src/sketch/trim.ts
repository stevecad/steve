/**
 * Trim: removes the piece of a line, arc or circle between the crossings on either side of the cursor (or up to the
 * curve's own end). Pure statement rewriting, so undo, the solve and the write-back to code work as for any edit:
 * a trimmed end moves to the crossing and is tied to the curve it crosses (point on it, or coincident with the end
 * it meets), a middle piece splits the curve in two that stay on one line (collinear) or circle (concentric, equal),
 * a circle becomes an arc, and a curve with no crossings goes whole. A trimmed side of a shape (a rectangle, polygon,
 * slot…) first turns the shape into its own lines and arcs, with the constraints that held it together.
 */
import { distanceToSegment, sample } from './geometry';
import { expand, GEOMETRY_OPS, lit, points as pointMap, stmt, type Arg, type Entity, type Expansion, type Stmt, type XY } from './model';

const TAU = Math.PI * 2;
const EPS = 1e-6;
const rnd = (v: number) => Math.round(v * 1e9) / 1e9;
const pt = (p: XY): XY => [rnd(p[0]), rnd(p[1])];
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

type Trimmable = Extract<Entity, { type: 'line' | 'arc' | 'circle' }>;
const trimmable = (e: Entity | undefined): e is Trimmable => e?.type === 'line' || e?.type === 'arc' || e?.type === 'circle';

/** A crossing on the trimmed curve: where, at which parameter, and what the new end is tied to there. */
export interface Cut { at: XY; t: number; tie: { op: 'coincident' | 'point_on'; ref: string } | null }
/** The piece to remove, along the curve's direction (`null`: up to the curve's own end), or all of it. */
export type Piece = { whole: true } | { whole: false; from: Cut | null; to: Cut | null };

/* ───────── parameters along the trimmed curve ───────── */

const sweepOf = (e: Extract<Entity, { type: 'arc' }>) => { const s = wrap(e.end_angle - e.start_angle); return s < 1e-12 ? TAU : s; };

/** Line: 0..1 from start to end. Arc: angle from its start, 0..sweep. Circle: angle, 0..2π. */
function param(e: Trimmable, p: XY): number {
  if (e.type === 'line') {
    const d: XY = [e.end[0] - e.start[0], e.end[1] - e.start[1]];
    const len = d[0] * d[0] + d[1] * d[1];
    return len ? ((p[0] - e.start[0]) * d[0] + (p[1] - e.start[1]) * d[1]) / len : 0;
  }
  const a = Math.atan2(p[1] - e.center[1], p[0] - e.center[0]);
  return e.type === 'circle' ? wrap(a) : wrap(a - e.start_angle);
}

function onCurve(e: Entity, p: XY, eps: number): boolean {
  switch (e.type) {
    case 'line': return distanceToSegment(p, e.start, e.end) <= eps;
    case 'circle': return Math.abs(dist(p, e.center) - e.radius) <= eps;
    case 'arc': {
      if (Math.abs(dist(p, e.center) - e.radius) > eps) return false;
      const ends = pointMap([e]);
      return param(e, p) <= sweepOf(e) + eps / e.radius || dist(p, ends.get(`${e.id}.start`)!) <= eps || dist(p, ends.get(`${e.id}.end`)!) <= eps;
    }
    default: return false;
  }
}

/* ───────── crossings ───────── */

type Carrier = { kind: 'line'; a: XY; b: XY } | { kind: 'circle'; c: XY; r: number };

const carrierOf = (e: Trimmable): Carrier => (e.type === 'line' ? { kind: 'line', a: e.start, b: e.end } : { kind: 'circle', c: e.center, r: e.radius });

/** Where two infinite lines / full circles meet (a tangency counts once). */
function meet(p: Carrier, q: Carrier, eps: number): XY[] {
  if (p.kind === 'circle' && q.kind === 'line') return meet(q, p, eps);
  if (p.kind === 'line' && q.kind === 'line') {
    const d1: XY = [p.b[0] - p.a[0], p.b[1] - p.a[1]], d2: XY = [q.b[0] - q.a[0], q.b[1] - q.a[1]];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) <= 1e-12 * Math.hypot(...d1) * Math.hypot(...d2)) return [];  // Parallel; overlaps are cut at the other's ends.
    const s = ((q.a[0] - p.a[0]) * d2[1] - (q.a[1] - p.a[1]) * d2[0]) / cross;
    return [[p.a[0] + d1[0] * s, p.a[1] + d1[1] * s]];
  }
  if (p.kind === 'line' && q.kind === 'circle') {
    const d: XY = [p.b[0] - p.a[0], p.b[1] - p.a[1]];
    const len = Math.hypot(...d);
    if (len < 1e-12) return [];
    const u: XY = [d[0] / len, d[1] / len];
    const s = (q.c[0] - p.a[0]) * u[0] + (q.c[1] - p.a[1]) * u[1];
    const foot: XY = [p.a[0] + u[0] * s, p.a[1] + u[1] * s];
    const h = dist(foot, q.c);
    if (h > q.r + eps) return [];
    if (Math.abs(h - q.r) <= eps) return [foot];
    const k = Math.sqrt(q.r * q.r - h * h);
    return [[foot[0] - u[0] * k, foot[1] - u[1] * k], [foot[0] + u[0] * k, foot[1] + u[1] * k]];
  }
  const a = p as Extract<Carrier, { kind: 'circle' }>, b = q as Extract<Carrier, { kind: 'circle' }>;
  const d = dist(a.c, b.c);
  if (d < 1e-12 || d > a.r + b.r + eps || d < Math.abs(a.r - b.r) - eps) return [];
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const u: XY = [(b.c[0] - a.c[0]) / d, (b.c[1] - a.c[1]) / d];
  const m: XY = [a.c[0] + u[0] * along, a.c[1] + u[1] * along];
  if (h <= eps) return [m];
  return [[m[0] - u[1] * h, m[1] + u[0] * h], [m[0] + u[1] * h, m[1] - u[0] * h]];
}

/** Every place another curve or point crosses or touches `e`, best tie first at each place. */
function crossings(e: Trimmable, others: Entity[], eps: number): Cut[] {
  const found: Cut[] = [];
  const add = (at: XY, tie: Cut['tie']) => { if (onCurve(e, at, eps)) found.push({ at, t: param(e, at), tie }); };
  const carrier = carrierOf(e);
  for (const o of others) {
    if (o.id === e.id || o.type === 'projection') continue;
    if (o.type === 'point') { add(o.at, { op: 'coincident', ref: o.id }); continue; }
    // An end of the other curve on this one (a T, or lines overlapping): coincident with that end.
    const ends = pointMap([o]);
    for (const end of ['start', 'end']) {
      const at = ends.get(`${o.id}.${end}`);
      if (at && !(o.type === 'bspline' && o.periodic)) add(at, { op: 'coincident', ref: `${o.id}.${end}` });
    }
    if (trimmable(o)) {
      for (const at of meet(carrier, carrierOf(o), eps)) if (onCurve(o, at, eps)) add(at, { op: 'point_on', ref: o.id });
    } else {
      // Ellipses and splines: crossings with a fine polyline of them; the tie (point on the curve) makes them exact.
      const pts = sample(o, 256);
      for (let i = 1; i < pts.length; i++) {
        const seg: Carrier = { kind: 'line', a: pts[i - 1], b: pts[i] };
        for (const at of meet(carrier, seg, eps)) if (distanceToSegment(at, seg.a, seg.b) <= eps) add(at, { op: 'point_on', ref: o.id });
      }
    }
  }
  // One cut per place: coincident with an end beats a point on a curve.
  const cuts: Cut[] = [];
  for (const c of [...found].sort((a, b) => (a.tie?.op === 'coincident' ? 0 : 1) - (b.tie?.op === 'coincident' ? 0 : 1))) {
    if (!cuts.some((k) => dist(k.at, c.at) <= eps * 10)) cuts.push(c);
  }
  // Not at the curve's own ends: those are already where it stops.
  const own = e.type === 'circle' ? [] : [...pointMap([e])].filter(([ref]) => /\.(start|end)$/.test(ref)).map(([, p]) => p);
  return cuts.filter((c) => own.every((p) => dist(p, c.at) > eps * 10)).sort((a, b) => a.t - b.t);
}

/** The piece of `e` around `cursor` between its nearest crossings with `others` (or its ends), or the whole curve. */
export function trimPiece(e: Trimmable, cursor: XY, others: Entity[], eps = EPS): Piece {
  const cuts = crossings(e, others, eps);
  if (e.type === 'circle') {
    if (cuts.length < 2) return { whole: true };
    const t = param(e, cursor);
    const from = [...cuts].reverse().find((c) => c.t <= t) ?? cuts[cuts.length - 1];
    const to = cuts.find((c) => c.t > t) ?? cuts[0];
    return { whole: false, from, to };
  }
  if (!cuts.length) return { whole: true };
  const end = e.type === 'line' ? 1 : sweepOf(e);
  let t = param(e, cursor);
  // Past an end (within the pick tolerance): the nearer end. An arc's angle past its end wraps round to its start.
  if (e.type === 'line') t = Math.max(0, Math.min(1, t));
  else if (t > end) t = t - end < TAU - t ? end : 0;
  return { whole: false, from: [...cuts].reverse().find((c) => c.t < t) ?? null, to: cuts.find((c) => c.t > t) ?? null };
}

/** The piece Trim would remove at `cursor` on curve `ref`, as geometry to highlight (null: it can't be trimmed). */
export function trimPreview(entities: Entity[], ref: string, cursor: XY): Entity | null {
  const e = entities.find((x) => x.id === ref);
  if (!trimmable(e) || e.external) return null;
  const piece = trimPiece(e, cursor, entities);
  if (piece.whole) return { ...e, id: '~trim', construction: false };
  if (e.type === 'line') return { id: '~trim', type: 'line', start: piece.from?.at ?? e.start, end: piece.to?.at ?? e.end };
  const a0 = e.type === 'arc' ? e.start_angle : 0;
  const start = piece.from ? a0 + piece.from.t : a0, stop = piece.to ? a0 + piece.to.t : a0 + sweepOf(e as Extract<Entity, { type: 'arc' }>);
  return { id: '~trim', type: 'arc', center: e.center, radius: e.radius, start_angle: start, end_angle: stop };
}

/* ───────── statements ───────── */

const idOf = (s: Stmt) => String(s.args[0]?.value ?? s.kwargs.id?.value ?? '');
/** The string values of a statement (refs, for a constraint). */
const refsOf = (s: Stmt) => [...s.args, ...Object.values(s.kwargs)].map((a) => a.value).filter((v): v is string => typeof v === 'string');
const mapRefs = (s: Stmt, f: (ref: string) => string): Stmt => {
  const map = (a: Arg) => (typeof a.value === 'string' && f(a.value) !== a.value ? lit(f(a.value)) : a);
  return { op: s.op, args: s.args.map(map), kwargs: Object.fromEntries(Object.entries(s.kwargs).map(([k, a]) => [k, map(a)])) };
};

/** A copy of `s` with its argument `name` (positional `index`) set. */
function withArg(s: Stmt, index: number, name: string, value: Arg): Stmt {
  const out: Stmt = { op: s.op, args: [...s.args], kwargs: { ...s.kwargs } };
  if (name in out.kwargs || index >= out.args.length) out.kwargs[name] = value; else out.args[index] = value;
  return out;
}
const argOf = (s: Stmt, index: number, name: string): Arg | undefined => s.kwargs[name] ?? s.args[index];

/** An unused identifier near `base`. */
function freshId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

/** One entity as its own statement (exploding a shape). */
function entityStatement(e: Entity, id: string): Stmt | null {
  const c: Record<string, Arg> = e.construction ? { construction: lit(true) } : {};
  switch (e.type) {
    case 'line': return stmt('line', [id, pt(e.start), pt(e.end)], c);
    case 'circle': return stmt('circle', [id, pt(e.center), rnd(e.radius)], c);
    case 'arc': return stmt('arc', [id, pt(e.center), rnd(e.radius), rnd(deg(e.start_angle)), rnd(deg(e.start_angle + sweepOf(e)))], c);
    case 'point': return stmt('point', [id, pt(e.at)], c);
    default: return null;
  }
}

/**
 * A shape (a rectangle, polygon, slot, polyline…) as its own lines, arcs and points, with the constraints that held it
 * together written out. Members are renamed `r1.bottom` → `r1_bottom`, and every ref to them follows.
 */
function explode(statements: Stmt[], index: number, expansion: Expansion): { statements: Stmt[]; names: Map<string, string> } | null {
  const owner = expansion.owners[index];
  const used = new Set([...statements.map(idOf), ...expansion.entities.map((e) => e.id)]);
  const names = new Map<string, string>();
  for (const member of owner.entities) {
    const name = freshId(member.replace(/\./g, '_'), used);
    used.add(name);
    names.set(member, name);
  }
  const rename = (ref: string) => {
    if (names.has(ref)) return names.get(ref)!;
    const cut = ref.lastIndexOf('.');
    return cut > 0 && names.has(ref.slice(0, cut)) ? `${names.get(ref.slice(0, cut))}${ref.slice(cut)}` : ref;
  };
  const members: Stmt[] = [];
  for (const member of owner.entities) {
    const s = entityStatement(expansion.entities.find((e) => e.id === member)!, names.get(member)!);
    if (!s) return null;
    members.push(s);
  }
  for (const cid of owner.constraints) {
    const c = expansion.constraints.find((k) => k.id === cid)!;
    members.push(mapRefs(stmt(c.type, c.refs.map((r) => lit(r)), typeof c.at === 'string' ? { at: lit(c.at) } : {}), rename));
  }
  return { statements: statements.flatMap((s, i) => (i === index ? members : s.op === 'project' ? [s] : [mapRefs(s, rename)])), names };
}

export type TrimResult = { statements: Stmt[]; ties: Stmt[]; message: string | null } | { error: string };

/**
 * Trims curve `ref` at `cursor`. Returns the rewritten statements, the ties for the new ends (added last, so the
 * caller can take back any that over-constrain the sketch), and what to tell the person.
 */
export function trim(statements: Stmt[], ref: string, cursor: XY): TrimResult {
  let expansion = expand(statements);
  const target = expansion.entities.find((x) => x.id === ref);
  if (!target) return { error: 'Click a line, arc or circle to trim.' };
  if (target.external) return { error: 'Projected geometry follows its source, so it can’t be trimmed.' };
  if (!trimmable(target)) return { error: 'Trim works on lines, arcs and circles. Delete this curve, or edit its points, instead.' };
  let index = expansion.owners.findIndex((o) => o.entities.includes(ref));
  if (index < 0) return { error: 'Click a line, arc or circle to trim.' };
  let id = ref;
  const notes: string[] = [];
  if (expansion.owners[index].entities.length > 1) {
    const exploded = explode(statements, index, expansion);
    if (!exploded) return { error: 'This shape can’t be split into lines and arcs to trim.' };
    const op = statements[index].op;
    notes.push(`The ${SHAPES[op] ?? op} is now separate lines${op === 'slot' ? ' and arcs' : ''}.`);
    statements = exploded.statements;
    expansion = expand(statements);
    id = exploded.names.get(ref)!;
    index = expansion.owners.findIndex((o) => o.entities.includes(id));
  }
  const e = expansion.entities.find((x) => x.id === id) as Trimmable;
  const piece = trimPiece(e, cursor, expansion.entities);
  const s = statements[index];
  const isConstraint = (k: Stmt) => !GEOMETRY_OPS.has(k.op);
  const mentions = (k: Stmt, refs: string[]) => refsOf(k).some((r) => refs.includes(r));
  let dropped = 0;
  const finish = (next: Stmt[], ties: Stmt[]): TrimResult => {
    // Trimming a crossing to its endpoint strengthens point-on-curve into
    // endpoint coincidence. Keeping both makes the solver reject the new tie
    // as redundant, leaving the profile free to open on a later dimension edit.
    const joined = ties.filter((k) => k.op === 'coincident').map((k) => refsOf(k));
    const retained = next.filter((k) => {
      if (k.op !== 'point_on') return true;
      const [point, curve] = refsOf(k);
      if (!point || !curve) return true;
      return !joined.some(([a, b]) =>
        (a === point && (b === `${curve}.start` || b === `${curve}.end`)) ||
        (b === point && (a === `${curve}.start` || a === `${curve}.end`)));
    });
    if (dropped) notes.push(`Removed ${dropped} constraint${dropped === 1 ? '' : 's'} on the part that was cut away.`);
    return { statements: retained, ties, message: notes.length ? notes.join(' ') : null };
  };

  if (piece.whole) {
    const own = [id, `${id}.start`, `${id}.end`, `${id}.center`];
    const next = statements.filter((k, i) => {
      if (i === index) return false;
      if (isConstraint(k) && mentions(k, own)) { dropped++; return false; }
      return true;
    });
    return finish(next, []);
  }

  const tie = (point: string, cut: Cut | null): Stmt[] => {
    if (!cut?.tie) return [];
    return cut.tie.op === 'coincident' ? [stmt('coincident', [lit(cut.tie.ref), lit(point)])] : [stmt('point_on', [lit(point), lit(cut.tie.ref)])];
  };
  // Sizes of the curve as a whole no longer hold once it's shorter (a line's length, a midpoint, equal lengths).
  const sized = e.type === 'line' ? ['length', 'equal', 'midpoint'] : e.type === 'arc' ? ['length'] : [];
  const { from, to } = piece;

  if (e.type === 'circle') {
    // The circle becomes the arc that's left: from the far crossing round to the near one.
    const radius = argOf(s, 2, 'radius')!, center = argOf(s, 1, 'center')!;
    const kwargs = Object.fromEntries(Object.entries(s.kwargs).filter(([k]) => !['id', 'center', 'radius'].includes(k)));
    if (s.args[3]) kwargs.construction = s.args[3];
    const arc: Stmt = { op: 'arc', args: [s.args[0] ?? s.kwargs.id ?? lit(id), center, radius, lit(rnd(deg(to!.t))), lit(rnd(deg(from!.t)))], kwargs };
    const next = statements.map((k, i) => (i === index ? arc : k));
    return finish(next, [...tie(`${id}.start`, to), ...tie(`${id}.end`, from)]);
  }

  const startAt = (cut: Cut) => (e.type === 'line' ? lit(pt(cut.at)) : lit(rnd(deg(e.start_angle + cut.t))));
  const [startIndex, startName, endIndex, endName]: [number, string, number, string] = e.type === 'line' ? [1, 'start', 2, 'end'] : [3, 'start_angle', 4, 'end_angle'];
  const constraintsAfter = (gone: string[], rewrite: (k: Stmt) => Stmt = (k) => k) => (k: Stmt, i: number): Stmt[] => {
    if (i === index || !isConstraint(k)) return [k];
    if (mentions(k, gone) || (sized.includes(k.op) && mentions(k, [id]))) { dropped++; return []; }
    return [rewrite(k)];
  };

  if (!from || !to) {
    // One end goes: it moves to the crossing; what held that end there no longer applies.
    const cut = (from ?? to)!;
    const end = from ? 'end' : 'start';
    const moved = from ? withArg(s, endIndex, endName, startAt(cut)) : withArg(s, startIndex, startName, startAt(cut));
    const next = statements.flatMap((k, i) => (i === index ? [moved] : constraintsAfter([`${id}.${end}`])(k, i)));
    return finish(next, tie(`${id}.${end}`, cut));
  }

  // A middle piece: the curve keeps its start up to the first crossing; a new one runs from the second to its end.
  const used = new Set([...statements.map(idOf), ...expansion.entities.map((x) => x.id)]);
  const other = freshId(nextId(e.type === 'line' ? 'l' : 'a', used), used);
  const first = withArg(s, endIndex, endName, startAt(from));
  const second = withArg(withArg(s, startIndex, startName, startAt(to)), 0, 'id', lit(other));
  const together = e.type === 'line' ? [stmt('collinear', [lit(id), lit(other)])] : [stmt('concentric', [lit(id), lit(other)]), stmt('equal', [lit(id), lit(other)])];
  // What held the far end (a coincidence, a tangency there) now holds the new curve's end, and is about that curve.
  const farEnd = (k: Stmt) => (mentions(k, [`${id}.end`]) ? mapRefs(k, (r) => (r === `${id}.end` ? `${other}.end` : r === id ? other : r)) : k);
  const next = statements.flatMap((k, i) => (i === index ? [first, second] : constraintsAfter([], farEnd)(k, i)));
  return finish([...next, ...together], [...tie(`${id}.end`, from), ...tie(`${other}.start`, to)]);
}

function nextId(prefix: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const SHAPES: Record<string, string> = { rect: 'rectangle', center_rect: 'rectangle', polygon: 'polygon', polyline: 'outline', trapezoid: 'trapezoid', slot: 'slot' };

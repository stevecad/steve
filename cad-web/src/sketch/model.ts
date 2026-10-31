/**
 * The sketch editor's document: the statements of a `with model.sketch(...)` block.
 *
 * `expand` replays statements into solver entities and constraints exactly like
 * runtime/steve/sketch.py (same ids, same auto-numbering), `writeBack` moves solved
 * geometry into the statements' coordinates, and `emitSketch` prints the block.
 * Units: mm; angles degrees in statements and radians in solver JSON.
 */
import type { ArgValue, ModelFeature } from '@/lib/modeling';
import { formatNumber, pyString } from '@/lib/pyText';

export type XY = [number, number];

export interface Arg { source: string; value: unknown }
export interface Stmt { op: string; args: Arg[]; kwargs: Record<string, Arg> }

export type Entity =
  | { id: string; type: 'point'; at: XY; construction?: boolean; external?: boolean }
  | { id: string; type: 'line'; start: XY; end: XY; construction?: boolean; external?: boolean }
  | { id: string; type: 'circle'; center: XY; radius: number; construction?: boolean; external?: boolean }
  | { id: string; type: 'arc'; center: XY; radius: number; start_angle: number; end_angle: number; construction?: boolean; external?: boolean }
  | { id: string; type: 'ellipse'; center: XY; major_radius: number; minor_radius: number; rotation: number; construction?: boolean; external?: boolean }
  | { id: string; type: 'elliptical_arc'; center: XY; major_radius: number; minor_radius: number; rotation: number; start_angle: number; end_angle: number; construction?: boolean; external?: boolean }
  | { id: string; type: 'bspline'; poles: XY[]; degree: number; periodic: boolean; bezier?: boolean; construction?: boolean; external?: boolean }
  | { id: string; type: 'projection'; ref: string | string[]; construction: boolean; external: true };

export interface Constraint { id: string; type: string; refs: string[]; value?: number; driving?: boolean; at?: string | XY }
export interface SolverDoc { entities: Entity[]; constraints: Constraint[] }

export interface Expansion extends SolverDoc {
  /** Statement index → entity ids / constraint ids it produced. */
  owners: { entities: string[]; constraints: string[] }[];
  errors: { statement: number; message: string }[];
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const xy = (value: unknown): XY => {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Expected a point (x, y).');
  return [Number(value[0]), Number(value[1])];
};
const num = (value: unknown, label = 'value'): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number for ${label}.`);
  return n;
};
export const FIXED = new Set(['origin', 'x_axis', 'y_axis']);

/** Mirror of runtime/steve/sketch.py `Sketch` (declarations only). */
class Builder {
  entities = new Map<string, Entity>();
  constraints: Constraint[] = [];
  private counter = 0;

  add<E extends Entity>(entity: E): string {
    if (!entity.id || this.entities.has(entity.id) || FIXED.has(entity.id)) throw new Error(`Entity id ${entity.id} is missing or already used.`);
    this.entities.set(entity.id, entity);
    return entity.id;
  }

  constrain(type: string, refs: string[], value?: number, id?: string, driving = true, extra: Partial<Constraint> = {}): string {
    this.counter += 1;
    const cid = id ?? `k${this.counter}`;
    const item: Constraint = { id: cid, type, refs, ...extra };
    if (value !== undefined) { item.value = value; item.driving = driving; }
    this.constraints.push(item);
    return cid;
  }

  private flags(construction?: unknown) { return construction ? { construction: true } : { construction: false }; }

  point(id: string, at: unknown, construction?: unknown) { return this.add({ id, type: 'point', at: xy(at), ...this.flags(construction) }); }
  line(id: string, start: unknown, end: unknown, construction?: unknown) { return this.add({ id, type: 'line', start: xy(start), end: xy(end), ...this.flags(construction) }); }
  circle(id: string, center: unknown, radius: unknown, construction?: unknown) { return this.add({ id, type: 'circle', center: xy(center), radius: num(radius, 'radius'), ...this.flags(construction) }); }
  arc(id: string, center: unknown, radius: unknown, a0: unknown, a1: unknown, construction?: unknown) {
    return this.add({ id, type: 'arc', center: xy(center), radius: num(radius, 'radius'), start_angle: rad(num(a0)), end_angle: rad(num(a1)), ...this.flags(construction) });
  }
  ellipse(id: string, center: unknown, major: unknown, minor: unknown, rotation: unknown = 0, construction?: unknown) {
    return this.add({ id, type: 'ellipse', center: xy(center), major_radius: num(major), minor_radius: num(minor), rotation: rad(num(rotation)), ...this.flags(construction) });
  }
  elliptical_arc(id: string, center: unknown, major: unknown, minor: unknown, rotation: unknown, a0: unknown, a1: unknown, construction?: unknown) {
    return this.add({ id, type: 'elliptical_arc', center: xy(center), major_radius: num(major), minor_radius: num(minor), rotation: rad(num(rotation)),
      start_angle: rad(num(a0)), end_angle: rad(num(a1)), ...this.flags(construction) });
  }
  spline(id: string, poles: unknown, degree: unknown = 3, periodic: unknown = false, construction?: unknown) {
    const pts = (poles as unknown[]).map(xy);
    if (pts.length < 2) throw new Error(`Spline ${id} needs at least two control points.`);
    return this.add({ id, type: 'bspline', poles: pts, degree: Math.min(num(degree), pts.length - 1), periodic: !!periodic, ...this.flags(construction) });
  }
  bezier(id: string, poles: unknown, construction?: unknown) {
    const pts = (poles as unknown[]).map(xy);
    return this.add({ id, type: 'bspline', poles: pts, degree: pts.length - 1, periodic: false, bezier: true, ...this.flags(construction) });
  }

  rect(id: string, c1: unknown, c2: unknown, construction?: unknown) {
    const [x1, y1] = xy(c1), [x2, y2] = xy(c2);
    const sides: Record<string, [XY, XY]> = { bottom: [[x1, y1], [x2, y1]], right: [[x2, y1], [x2, y2]], top: [[x2, y2], [x1, y2]], left: [[x1, y2], [x1, y1]] };
    for (const [side, [a, b]] of Object.entries(sides)) this.line(`${id}.${side}`, a, b, construction);
    const order = ['bottom', 'right', 'top', 'left'];
    order.forEach((a, i) => { const b = order[(i + 1) % 4]; this.constrain('coincident', [`${id}.${a}.end`, `${id}.${b}.start`], undefined, `${id}.c_${a}_${b}`); });
    this.constrain('horizontal', [`${id}.bottom`], undefined, `${id}.h_bottom`);
    this.constrain('horizontal', [`${id}.top`], undefined, `${id}.h_top`);
    this.constrain('vertical', [`${id}.left`], undefined, `${id}.v_left`);
    this.constrain('vertical', [`${id}.right`], undefined, `${id}.v_right`);
    return id;
  }

  center_rect(id: string, center: unknown, width: unknown, height: unknown, construction?: unknown) {
    const [cx, cy] = xy(center), w = num(width) / 2, h = num(height) / 2;
    this.rect(id, [cx - w, cy - h], [cx + w, cy + h], construction);
    this.point(`${id}.center`, [cx, cy], true);
    this.constrain('symmetric', [`${id}.bottom.start`, `${id}.top.start`, `${id}.center`], undefined, `${id}.s_center`);
    return id;
  }

  slot(id: string, start: unknown, end: unknown, radius: unknown, construction?: unknown) {
    const [x1, y1] = xy(start), [x2, y2] = xy(end), r = num(radius, 'radius');
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const nx = -Math.sin(angle) * r, ny = Math.cos(angle) * r;
    const d = deg(angle);
    this.arc(`${id}.end_arc`, [x2, y2], r, d - 90, d + 90, construction);
    this.line(`${id}.upper`, [x2 + nx, y2 + ny], [x1 + nx, y1 + ny], construction);
    this.arc(`${id}.start_arc`, [x1, y1], r, d + 90, d + 270, construction);
    this.line(`${id}.lower`, [x1 - nx, y1 - ny], [x2 - nx, y2 - ny], construction);
    this.line(`${id}.axis`, [x1, y1], [x2, y2], true);
    this.constrain('coincident', [`${id}.end_arc.end`, `${id}.upper.start`], undefined, `${id}.c1`);
    this.constrain('coincident', [`${id}.upper.end`, `${id}.start_arc.start`], undefined, `${id}.c2`);
    this.constrain('coincident', [`${id}.start_arc.end`, `${id}.lower.start`], undefined, `${id}.c3`);
    this.constrain('coincident', [`${id}.lower.end`, `${id}.end_arc.start`], undefined, `${id}.c4`);
    this.constrain('tangent', [`${id}.upper`, `${id}.end_arc`], undefined, `${id}.t1`, true, { at: `${id}.upper.start` });
    this.constrain('tangent', [`${id}.upper`, `${id}.start_arc`], undefined, `${id}.t2`, true, { at: `${id}.upper.end` });
    this.constrain('tangent', [`${id}.lower`, `${id}.start_arc`], undefined, `${id}.t3`, true, { at: `${id}.lower.start` });
    this.constrain('tangent', [`${id}.lower`, `${id}.end_arc`], undefined, `${id}.t4`, true, { at: `${id}.lower.end` });
    this.constrain('equal', [`${id}.start_arc`, `${id}.end_arc`], undefined, `${id}.eq`);
    this.constrain('coincident', [`${id}.axis.start`, `${id}.start_arc.center`], undefined, `${id}.a1`);
    this.constrain('coincident', [`${id}.axis.end`, `${id}.end_arc.center`], undefined, `${id}.a2`);
    return id;
  }

  polygon(id: string, center: unknown, radius: unknown, sides: unknown, inscribed: unknown = true, rotation: unknown = 0, construction?: unknown) {
    const [cx, cy] = xy(center), n = Math.trunc(num(sides, 'sides'));
    if (n < 3) throw new Error(`Polygon ${id} needs at least 3 sides.`);
    const r0 = num(radius, 'radius');
    const r = inscribed ? r0 : r0 / Math.cos(Math.PI / n);
    const start = rad(num(rotation));
    const pts: XY[] = Array.from({ length: n }, (_, i) => [cx + r * Math.cos(start + (2 * Math.PI * i) / n), cy + r * Math.sin(start + (2 * Math.PI * i) / n)]);
    this.circle(`${id}.circle`, [cx, cy], r0, true);
    for (let i = 0; i < n; i++) this.line(`${id}.side${i}`, pts[i], pts[(i + 1) % n], construction);
    for (let i = 0; i < n; i++) {
      this.constrain('coincident', [`${id}.side${i}.end`, `${id}.side${(i + 1) % n}.start`], undefined, `${id}.c${i}`);
      if (inscribed) this.constrain('point_on', [`${id}.side${i}.start`, `${id}.circle`], undefined, `${id}.on${i}`);
      else this.constrain('tangent', [`${id}.side${i}`, `${id}.circle`], undefined, `${id}.tan${i}`);
      if (i) this.constrain('equal', [`${id}.side0`, `${id}.side${i}`], undefined, `${id}.eq${i}`);
    }
    return id;
  }

  polyline(id: string, points: unknown, closed: unknown = true, construction?: unknown) {
    const pts = (points as unknown[]).map(xy);
    const ring = !!closed;
    if (ring && pts.length > 1 && pts[pts.length - 1][0] === pts[0][0] && pts[pts.length - 1][1] === pts[0][1]) pts.pop();
    const n = pts.length;
    if (n < (ring ? 3 : 2)) throw new Error(`Polyline ${id} needs at least ${ring ? 3 : 2} points.`);
    const sides = ring ? n : n - 1;
    for (let i = 0; i < sides; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a[0] === b[0] && a[1] === b[1]) throw new Error(`Polyline ${id} repeats point ${i + 1}, which leaves side${i} with no length.`);
    }
    for (let i = 0; i < sides; i++) this.line(`${id}.side${i}`, pts[i], pts[(i + 1) % n], construction);
    for (let i = 0; i < (ring ? sides : sides - 1); i++) this.constrain('coincident', [`${id}.side${i}.end`, `${id}.side${(i + 1) % sides}.start`], undefined, `${id}.c${i}`);
    return id;
  }

  trapezoid(id: string, center: unknown, width: unknown, height: unknown, angle1: unknown, angle2?: unknown, construction?: unknown) {
    const [cx, cy] = xy(center), w = num(width), h = num(height);
    const a1 = rad(num(angle1)), a2 = rad(num(angle2 ?? angle1));
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    const tl: XY = [x0 + h / Math.tan(a1), y1], tr: XY = [x1 - h / Math.tan(a2), y1];
    this.line(`${id}.bottom`, [x0, y0], [x1, y0], construction);
    this.line(`${id}.right`, [x1, y0], tr, construction);
    this.line(`${id}.top`, tr, tl, construction);
    this.line(`${id}.left`, tl, [x0, y0], construction);
    const order = ['bottom', 'right', 'top', 'left'];
    order.forEach((a, i) => { const b = order[(i + 1) % 4]; this.constrain('coincident', [`${id}.${a}.end`, `${id}.${b}.start`], undefined, `${id}.c_${a}_${b}`); });
    this.constrain('horizontal', [`${id}.bottom`], undefined, `${id}.h_bottom`);
    this.constrain('horizontal', [`${id}.top`], undefined, `${id}.h_top`);
    return id;
  }

  external_line(id: string, start: unknown, end: unknown) {
    return this.add({ id, type: 'line', start: xy(start), end: xy(end), construction: true, external: true });
  }

  /** Fixed geometry from the model or another sketch. Its shape comes from the build (or the browser's own
   *  projection of the picked geometry, see ./project.ts); without it, a placeholder like the runtime's. */
  project(id: string, ref: unknown, construction?: unknown) {
    const resolved = projectionCache[id];
    if (!resolved?.length) return this.add({ id, type: 'projection', ref: ref as string, construction: !!construction, external: true });
    for (const entity of resolved) this.add({ ...entity, construction: !!construction || entity.type === 'point', external: true } as Entity);
    return id;
  }

  // Constraints (same signatures as Python).
  coincident(a: string, b: string, id?: string) { return this.constrain('coincident', [a, b], undefined, id); }
  point_on(p: string, c: string, id?: string) { return this.constrain('point_on', [p, c], undefined, id); }
  horizontal(a: string, b?: string, id?: string) { return this.constrain('horizontal', b == null ? [a] : [a, b], undefined, id); }
  vertical(a: string, b?: string, id?: string) { return this.constrain('vertical', b == null ? [a] : [a, b], undefined, id); }
  parallel(a: string, b: string, id?: string) { return this.constrain('parallel', [a, b], undefined, id); }
  perpendicular(a: string, b: string, id?: string) { return this.constrain('perpendicular', [a, b], undefined, id); }
  collinear(a: string, b: string, id?: string) { return this.constrain('collinear', [a, b], undefined, id); }
  tangent(a: string, b: string, at?: string, id?: string) { return this.constrain('tangent', [a, b], undefined, id, true, at ? { at } : {}); }
  equal(a: string, b: string, id?: string) { return this.constrain('equal', [a, b], undefined, id); }
  symmetric(p: string, q: string, about: string, id?: string) { return this.constrain('symmetric', [p, q, about], undefined, id); }
  midpoint(p: string, line: string, id?: string) { return this.constrain('midpoint', [p, line], undefined, id); }
  concentric(a: string, b: string, id?: string) { return this.constrain('concentric', [a, b], undefined, id); }
  fix(ref: string, at?: unknown, id?: string) { return this.constrain('fix', [ref], undefined, id, true, at != null ? { at: xy(at) } : {}); }
  distance(a: string, b: string, value: unknown, driving: unknown = true, id?: string) { return this.constrain('distance', [a, b], num(value), id, !!driving); }
  length(c: string, value: unknown, driving: unknown = true, id?: string) { return this.constrain('length', [c], num(value), id, !!driving); }
  horizontal_distance(p: string, q: string, value: unknown, driving: unknown = true, id?: string) { return this.constrain('horizontal_distance', [p, q], num(value), id, !!driving); }
  vertical_distance(p: string, q: string, value: unknown, driving: unknown = true, id?: string) { return this.constrain('vertical_distance', [p, q], num(value), id, !!driving); }
  angle(a: string, b?: unknown, value?: unknown, driving: unknown = true, id?: string) {
    let second: string | undefined = typeof b === 'string' ? b : undefined;
    let v = value;
    if (typeof b !== 'string' && b !== undefined && b !== null) { v = b; second = undefined; }
    return this.constrain('angle', second ? [a, second] : [a], rad(num(v)), id, !!driving);
  }
  radius(c: string, value: unknown, driving: unknown = true, id?: string) { return this.constrain('radius', [c], num(value), id, !!driving); }
  diameter(c: string, value: unknown, driving: unknown = true, id?: string) { return this.constrain('diameter', [c], num(value), id, !!driving); }
}

/** Positional parameter names per op (for kwargs), matching the Python signatures. */
export const SIGNATURES: Record<string, string[]> = {
  point: ['id', 'at', 'construction'], line: ['id', 'start', 'end', 'construction'], circle: ['id', 'center', 'radius', 'construction'],
  arc: ['id', 'center', 'radius', 'start_angle', 'end_angle', 'construction'],
  ellipse: ['id', 'center', 'major_radius', 'minor_radius', 'rotation', 'construction'],
  elliptical_arc: ['id', 'center', 'major_radius', 'minor_radius', 'rotation', 'start_angle', 'end_angle', 'construction'],
  spline: ['id', 'poles', 'degree', 'periodic', 'construction'], bezier: ['id', 'poles', 'construction'],
  rect: ['id', 'corner1', 'corner2', 'construction'], center_rect: ['id', 'center', 'width', 'height', 'construction'],
  slot: ['id', 'start', 'end', 'radius', 'construction'], polygon: ['id', 'center', 'radius', 'sides', 'inscribed', 'rotation', 'construction'],
  polyline: ['id', 'points', 'closed', 'construction'],
  trapezoid: ['id', 'center', 'width', 'height', 'angle1', 'angle2', 'construction'], external_line: ['id', 'start', 'end'], project: ['id', 'ref', 'construction'],
  coincident: ['a', 'b', 'id'], point_on: ['point', 'curve', 'id'], horizontal: ['a', 'b', 'id'], vertical: ['a', 'b', 'id'],
  parallel: ['a', 'b', 'id'], perpendicular: ['a', 'b', 'id'], collinear: ['a', 'b', 'id'], tangent: ['a', 'b', 'at', 'id'],
  equal: ['a', 'b', 'id'], symmetric: ['p', 'q', 'about', 'id'], midpoint: ['point', 'line', 'id'], concentric: ['a', 'b', 'id'],
  fix: ['ref', 'at', 'id'], distance: ['a', 'b', 'value', 'driving', 'id', 'label'], length: ['curve', 'value', 'driving', 'id', 'label'],
  horizontal_distance: ['p', 'q', 'value', 'driving', 'id', 'label'], vertical_distance: ['p', 'q', 'value', 'driving', 'id', 'label'],
  angle: ['a', 'b', 'value', 'driving', 'id', 'label'], radius: ['curve', 'value', 'driving', 'id', 'label'], diameter: ['curve', 'value', 'driving', 'id', 'label'],
};
export const GEOMETRY_OPS = new Set(['point', 'line', 'circle', 'arc', 'ellipse', 'elliptical_arc', 'spline', 'bezier', 'rect', 'center_rect', 'slot', 'polygon', 'polyline', 'trapezoid', 'external_line', 'project']);
export const DIMENSION_OPS = new Set(['distance', 'length', 'horizontal_distance', 'vertical_distance', 'angle', 'radius', 'diameter']);

/** Resolved projections of the open sketch: projection id → its fixed entities (ids included). */
let projectionCache: Record<string, Entity[]> = {};
export function setProjections(map: Record<string, Entity[]>) { projectionCache = map; }
export const projections = () => projectionCache;

/** Replays statements into solver entities/constraints, recording who made what. */
export function expand(statements: Stmt[]): Expansion {
  const builder = new Builder();
  const owners: Expansion['owners'] = [];
  const errors: Expansion['errors'] = [];
  statements.forEach((stmt, index) => {
    const beforeEntities = new Set(builder.entities.keys());
    const beforeConstraints = builder.constraints.length;
    const names = SIGNATURES[stmt.op];
    const fn = (builder as unknown as Record<string, (...a: unknown[]) => unknown>)[stmt.op];
    if (!names || typeof fn !== 'function') errors.push({ statement: index, message: `Unknown sketch operation ${stmt.op}.` });
    else {
      const values: unknown[] = stmt.args.map((arg) => arg.value);
      for (const [key, arg] of Object.entries(stmt.kwargs)) {
        const position = names.indexOf(key);
        if (position >= 0) { while (values.length < position) values.push(undefined); values[position] = arg.value; }
      }
      try { fn.apply(builder, values); } catch (error) { errors.push({ statement: index, message: (error as Error).message }); }
    }
    owners.push({ entities: [...builder.entities.keys()].filter((id) => !beforeEntities.has(id)), constraints: builder.constraints.slice(beforeConstraints).map((c) => c.id) });
  });
  return { entities: [...builder.entities.values()], constraints: builder.constraints, owners, errors };
}

/* ───────── statements from the parser, and back to code ───────── */

const toArg = (value: ArgValue): Arg => ({ source: value.source, value: value.value });

export function statementsFrom(feature: ModelFeature): Stmt[] {
  return (feature.statements ?? []).filter((s) => s.op !== 'code').map((s) => ({
    op: s.op, args: (s.args ?? []).map(toArg), kwargs: Object.fromEntries(Object.entries(s.kwargs ?? {}).map(([k, v]) => [k, toArg(v)])),
  }));
}

export const lit = (value: number | string | boolean | XY | XY[]): Arg => ({ source: pySource(value), value });

function pySource(value: unknown): string {
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return pyString(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'number') return `(${formatNumber(value[0] as number)}, ${formatNumber(value[1] as number)})`;
    return `[${value.map(pySource).join(', ')}]`;
  }
  throw new Error('Unsupported sketch value.');
}

export function stmt(op: string, args: (Arg | number | string | boolean | XY | XY[])[], kwargs: Record<string, Arg | number | string | boolean | XY> = {}): Stmt {
  const wrap = (v: Arg | number | string | boolean | XY | XY[]): Arg => (typeof v === 'object' && v !== null && !Array.isArray(v) && 'source' in v ? v : lit(v as number));
  return { op, args: args.map(wrap), kwargs: Object.fromEntries(Object.entries(kwargs).map(([k, v]) => [k, wrap(v)])) };
}

export function emitStatement(s: Stmt, alias = 's'): string {
  const parts = [...s.args.map((a) => a.source), ...Object.entries(s.kwargs).map(([k, a]) => `${k}=${a.source}`)];
  return `${alias}.${s.op}(${parts.join(', ')})`;
}

export interface SketchHeader { id: string; on: string; name?: string | null; extra?: Record<string, string>; model?: string }

export function emitSketch(header: SketchHeader, statements: Stmt[], indent = '    ', alias = 's'): string {
  const kw = [`on=${header.on}`, ...(header.name ? [`name=${pyString(header.name)}`] : []), ...Object.entries(header.extra ?? {}).map(([k, v]) => `${k}=${v}`)];
  const lines = [`with ${header.model ?? 'model'}.sketch(${pyString(header.id)}, ${kw.join(', ')}) as ${alias}:`];
  for (const s of statements) lines.push(indent + emitStatement(s, alias));
  if (!statements.length) lines.push(`${indent}pass`);
  return `${lines.join('\n')}\n`;
}

/* ───────── solved geometry → statement coordinates ───────── */

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return close(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return false;
};

/**
 * Replaces an argument only when its value really changed, so expressions survive a solve.
 * An omitted argument stays omitted while the value equals its default; otherwise it's added by name.
 */
function setArg(s: Stmt, index: number, name: string, value: number | XY | XY[], fallback?: number): void {
  const current = name in s.kwargs ? s.kwargs[name] : s.args[index];
  if (current ? same(current.value, value) : fallback !== undefined && same(fallback, value)) return;
  const arg = lit(value as number);
  if (name in s.kwargs || (!current && index >= s.args.length)) s.kwargs[name] = arg; else s.args[index] = arg;
}

const byId = (entities: Entity[]) => new Map(entities.map((e) => [e.id, e]));
const angleDeg = (r: number) => deg(r);

/** Copies solved entity geometry into the statements that declared it (mutates copies). */
export function writeBack(statements: Stmt[], solved: Entity[]): Stmt[] {
  const map = byId(solved);
  return statements.map((original) => {
    const s: Stmt = { op: original.op, args: [...original.args], kwargs: { ...original.kwargs } };
    const id = String(s.args[0]?.value ?? s.kwargs.id?.value ?? '');
    const get = (key: string) => map.get(key) as Entity | undefined;
    switch (s.op) {
      case 'point': { const e = get(id); if (e?.type === 'point') setArg(s, 1, 'at', e.at); break; }
      case 'line': { const e = get(id); if (e?.type === 'line') { setArg(s, 1, 'start', e.start); setArg(s, 2, 'end', e.end); } break; }
      case 'circle': { const e = get(id); if (e?.type === 'circle') { setArg(s, 1, 'center', e.center); setArg(s, 2, 'radius', e.radius); } break; }
      case 'arc': {
        const e = get(id);
        if (e?.type === 'arc') { setArg(s, 1, 'center', e.center); setArg(s, 2, 'radius', e.radius); setArg(s, 3, 'start_angle', angleDeg(e.start_angle)); setArg(s, 4, 'end_angle', angleDeg(e.end_angle)); }
        break;
      }
      case 'ellipse': {
        const e = get(id);
        if (e?.type === 'ellipse') { setArg(s, 1, 'center', e.center); setArg(s, 2, 'major_radius', e.major_radius); setArg(s, 3, 'minor_radius', e.minor_radius); setArg(s, 4, 'rotation', angleDeg(e.rotation)); }
        break;
      }
      case 'elliptical_arc': {
        const e = get(id);
        if (e?.type === 'elliptical_arc') {
          setArg(s, 1, 'center', e.center); setArg(s, 2, 'major_radius', e.major_radius); setArg(s, 3, 'minor_radius', e.minor_radius);
          setArg(s, 4, 'rotation', angleDeg(e.rotation)); setArg(s, 5, 'start_angle', angleDeg(e.start_angle)); setArg(s, 6, 'end_angle', angleDeg(e.end_angle));
        }
        break;
      }
      case 'spline': case 'bezier': { const e = get(id); if (e?.type === 'bspline') setArg(s, 1, 'poles', e.poles); break; }
      case 'rect': {
        const bottom = get(`${id}.bottom`), top = get(`${id}.top`);
        if (bottom?.type === 'line' && top?.type === 'line') { setArg(s, 1, 'corner1', bottom.start); setArg(s, 2, 'corner2', top.start); }
        break;
      }
      case 'center_rect': {
        const center = get(`${id}.center`), bottom = get(`${id}.bottom`), left = get(`${id}.left`);
        if (center?.type === 'point' && bottom?.type === 'line' && left?.type === 'line') {
          // Signed, so a rectangle the solver flipped is written exactly as solved; the runtime then solves from the same shape.
          setArg(s, 1, 'center', center.at);
          setArg(s, 2, 'width', bottom.end[0] - bottom.start[0]);
          setArg(s, 3, 'height', left.start[1] - left.end[1]);
        }
        break;
      }
      case 'slot': {
        const a = get(`${id}.start_arc`), b = get(`${id}.end_arc`);
        if (a?.type === 'arc' && b?.type === 'arc') { setArg(s, 1, 'start', a.center); setArg(s, 2, 'end', b.center); setArg(s, 3, 'radius', a.radius); }
        break;
      }
      case 'polygon': {
        const circle = get(`${id}.circle`), side = get(`${id}.side0`);
        if (circle?.type === 'circle' && side?.type === 'line') {
          setArg(s, 1, 'center', circle.center); setArg(s, 2, 'radius', circle.radius);
          const vertex = deg(Math.atan2(side.start[1] - circle.center[1], side.start[0] - circle.center[0]));
          const current = Number((s.kwargs.rotation ?? s.args[5])?.value ?? 0);
          // Same orientation modulo 360°: keep what's written.
          const turn = Math.round((current - vertex) / 360) * 360;
          setArg(s, 5, 'rotation', vertex + turn, 0);
        }
        break;
      }
      case 'polyline': {
        const sides: Extract<Entity, { type: 'line' }>[] = [];
        for (let e = get(`${id}.side0`); e?.type === 'line'; e = get(`${id}.side${sides.length}`)) sides.push(e);
        if (!sides.length) break;
        const ring = !!((s.kwargs.closed ?? s.args[2])?.value ?? true);
        const pts: XY[] = sides.map((e) => e.start);
        // An open chain ends at its last side's end; a closed one that was written with its first point repeated keeps it.
        const written = (s.kwargs.points ?? s.args[1])?.value;
        if (!ring) pts.push(sides[sides.length - 1].end);
        else if (Array.isArray(written) && written.length === sides.length + 1) pts.push(pts[0]);
        setArg(s, 1, 'points', pts);
        break;
      }
      case 'trapezoid': {
        const bottom = get(`${id}.bottom`), top = get(`${id}.top`), left = get(`${id}.left`), right = get(`${id}.right`);
        if (bottom?.type === 'line' && top?.type === 'line' && left?.type === 'line' && right?.type === 'line') {
          const height = top.start[1] - bottom.start[1];
          const a1 = deg(Math.atan2(height, left.start[0] - left.end[0]));
          const a2 = deg(Math.atan2(height, right.start[0] - right.end[0]));
          setArg(s, 1, 'center', [(bottom.start[0] + bottom.end[0]) / 2, (bottom.start[1] + top.start[1]) / 2]);
          setArg(s, 2, 'width', bottom.end[0] - bottom.start[0]);
          setArg(s, 3, 'height', height);
          setArg(s, 4, 'angle1', a1);
          setArg(s, 5, 'angle2', a2, a1);
        }
        break;
      }
      default: break;
    }
    return s;
  });
}

/** Every entity scaled about the sketch origin (angles and rotations unchanged). External geometry stays put. */
export function scaleEntities(entities: Entity[], factor: number): Entity[] {
  const p = ([x, y]: XY): XY => [x * factor, y * factor];
  return entities.map((e): Entity => {
    if (e.external) return e;
    switch (e.type) {
      case 'point': return { ...e, at: p(e.at) };
      case 'line': return { ...e, start: p(e.start), end: p(e.end) };
      case 'circle': case 'arc': return { ...e, center: p(e.center), radius: e.radius * factor };
      case 'ellipse': case 'elliptical_arc': return { ...e, center: p(e.center), major_radius: e.major_radius * factor, minor_radius: e.minor_radius * factor };
      case 'bspline': return { ...e, poles: e.poles.map(p) };
      default: return e;
    }
  });
}

/* ───────── point access ───────── */

/** Every addressable point: `<entity>.start|end|center`, point entities, spline poles, the origin. */
export function points(entities: Entity[]): Map<string, XY> {
  const out = new Map<string, XY>([['origin', [0, 0]]]);
  for (const e of entities) {
    switch (e.type) {
      case 'point': out.set(e.id, e.at); break;
      case 'line': out.set(`${e.id}.start`, e.start); out.set(`${e.id}.end`, e.end); break;
      case 'circle': case 'ellipse': out.set(`${e.id}.center`, e.center); break;
      case 'arc': {
        out.set(`${e.id}.center`, e.center);
        out.set(`${e.id}.start`, [e.center[0] + e.radius * Math.cos(e.start_angle), e.center[1] + e.radius * Math.sin(e.start_angle)]);
        out.set(`${e.id}.end`, [e.center[0] + e.radius * Math.cos(e.end_angle), e.center[1] + e.radius * Math.sin(e.end_angle)]);
        break;
      }
      case 'elliptical_arc': out.set(`${e.id}.center`, e.center); break;
      case 'bspline': e.poles.forEach((p, i) => out.set(`${e.id}.pole${i}`, p)); out.set(`${e.id}.start`, e.poles[0]); out.set(`${e.id}.end`, e.poles[e.poles.length - 1]); break;
      default: break;
    }
  }
  return out;
}

/** Which statement declared an entity (composite members map to their composite). */
export function ownerOf(expansion: Expansion, entityId: string): number {
  return expansion.owners.findIndex((o) => o.entities.includes(entityId));
}

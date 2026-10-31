import { create } from 'zustand';
import { set as setApp } from '@/state/store';
import * as THREE from 'three';
import { expand, lit, stmt, writeBack, type Constraint, type Entity, type Expansion, type Stmt, type XY } from './model';
import { solveSketch, type SolveResult } from './solve';

/**
 * The open sketch: its statements (the code being edited), their expansion, the solver's
 * verdict and the editing tool. Kept apart from the app store because the cursor and
 * drags update it at pointer rate.
 */

export type ToolId =
  | 'select' | 'line' | 'rect' | 'center_rect' | 'circle' | 'circle_3pt' | 'arc_3pt' | 'arc_center' | 'polygon' | 'slot'
  | 'ellipse' | 'spline' | 'point' | 'dimension' | 'trim' | 'project'
  /** A constraint tool (constraintTool.ts): `c.coincident`, `c.parallel`… */
  | `c.${string}`;

export interface SketchPlane { origin: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3; normal: THREE.Vector3 }

/** One size of the shape being drawn, shown as an input on the geometry. */
export interface HeadsField { key: string; label: string; measured: number; at: XY; angle?: boolean }

/** Inference shown while drawing: snaps, alignment guides and the constraints they will add. */
/** What the tool infers at the cursor; each becomes a constraint when clicked (snap = coincident). `align_*` and
 *  `parallel`/`perpendicular`/`tangent` draw guides: from the aligned point, and along the reference curve `ref`. */
export interface Hint {
  kind: 'snap' | 'horizontal' | 'vertical' | 'on_curve' | 'midpoint' | 'tangent' | 'grid' | 'parallel' | 'perpendicular' | 'concentric' | 'align_h' | 'align_v';
  at: XY; from?: XY; ref?: string;
}

export interface SketchState {
  active: boolean;
  /** Waiting for the user to choose a plane or planar face for a new sketch. */
  choosing: boolean;
  /** The origin plane under the pointer while choosing. */
  planeHover: string | null;
  featureId: string;
  isNew: boolean;
  name: string;
  /** Python source of the `on=` argument, kept verbatim. */
  on: string;
  planeLabel: string;
  extra: Record<string, string>;
  plane: SketchPlane;
  statements: Stmt[];
  expansion: Expansion;
  result: SolveResult | null;
  solving: boolean;
  tool: ToolId;
  selection: string[];
  hover: string | null;
  construction: boolean;
  /** In-progress geometry of the active tool, in sketch coordinates. */
  preview: Entity[];
  hints: Hint[];
  cursor: XY | null;
  /** The dimension being typed, if any. */
  editing: { statement: number; at: XY } | null;
  /** A picked dimension following the cursor until a click places its label. */
  placing: { op: string; refs: string[]; measured: number; at: XY } | null;
  /** Project tool: the other sketch's entity under the pointer (model picks use the app's hover). */
  projectHover: { sketch: string; entity: string } | null;
  /** A dimension label being dragged to a new spot. */
  labelDrag: { statement: number; at: XY } | null;
  /** Sizes of the shape being drawn, typed or measured (heads-up inputs). */
  fields: HeadsField[];
  typed: Record<string, { source: string; value: number | null }>;
  fieldFocus: string | null;
  polygonSides: number;
  /** Polygon tool: the click is a corner (inscribed) or the middle of a side (circumscribed). */
  polygonInscribed: boolean;
  /** Refs lit up from the Sketch panel (a row under the pointer). */
  highlight: string[];
  undo: Stmt[][];
  redo: Stmt[][];
  message: string | null;
}

const EMPTY: Expansion = { entities: [], constraints: [], owners: [], errors: [] };

export const useSketch = create<SketchState>(() => ({
  active: false, choosing: false, planeHover: null, featureId: '', isNew: true, name: '', on: '"XY"', planeLabel: 'XY plane', extra: {},
  plane: planeBasis([0, 0, 0], [1, 0, 0], [0, 0, 1]),
  statements: [], expansion: EMPTY, result: null, solving: false, tool: 'select', selection: [], hover: null, construction: false,
  preview: [], hints: [], cursor: null, editing: null, placing: null, labelDrag: null, projectHover: null, fields: [], typed: {}, fieldFocus: null, polygonSides: 6, polygonInscribed: true, highlight: [], undo: [], redo: [], message: null,
}));

export const sketch = () => useSketch.getState();

export function planeBasis(origin: ArrayLike<number>, x: ArrayLike<number>, normal: ArrayLike<number>): SketchPlane {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const xd = new THREE.Vector3(x[0], x[1], x[2]).normalize();
  return { origin: new THREE.Vector3(origin[0], origin[1], origin[2]), x: xd, y: n.clone().cross(xd).normalize(), normal: n };
}

/** The runtime's datum planes (steve.model.DATUM_PLANES, via cq.Plane.named): x direction and normal. */
export const NAMED_PLANES: Record<string, [number[], number[]]> = {
  XY: [[1, 0, 0], [0, 0, 1]], XZ: [[1, 0, 0], [0, -1, 0]], YZ: [[0, 1, 0], [1, 0, 0]],
  ZX: [[0, 0, 1], [0, 1, 0]], YX: [[0, 1, 0], [0, 0, -1]], ZY: [[0, 0, 1], [-1, 0, 0]],
  top: [[1, 0, 0], [0, 0, 1]], front: [[1, 0, 0], [0, -1, 0]], right: [[0, 1, 0], [1, 0, 0]],
};

/** Screen position → sketch coordinates on the open sketch's plane (set by the sketch input layer). */
export const screen: { toSketch: (clientX: number, clientY: number) => XY | null } = { toSketch: () => null };

export const toWorld = (plane: SketchPlane, [u, v]: XY) => plane.origin.clone().addScaledVector(plane.x, u).addScaledVector(plane.y, v);
export const toLocal = (plane: SketchPlane, p: THREE.Vector3): XY => {
  const d = p.clone().sub(plane.origin);
  return [d.dot(plane.x), d.dot(plane.y)];
};

/** The solver's verdict in words, with a tone for the status chip. */
export function solveStatus(result: SolveResult | null, solving: boolean): { tone: 'free' | 'defined' | 'conflict'; text: string } {
  if (solving) return { tone: 'free', text: 'Solving…' };
  if (!result) return { tone: 'free', text: 'Draw to start' };
  if (result.status === 'failed') {
    const ids = [...result.conflicting, ...result.redundant];
    return { tone: 'conflict', text: ids.length ? `Over-defined: ${ids.length} conflicting constraint${ids.length === 1 ? '' : 's'}` : 'Can’t be solved as constrained' };
  }
  if (result.status === 'unsolved') return { tone: 'free', text: 'As drawn (solver loading)' };
  if (result.dof === 0) return { tone: 'defined', text: 'Fully defined' };
  if (result.dof === null) return { tone: 'free', text: 'Add dimensions and constraints' };
  return { tone: 'free', text: `${result.dof} degree${result.dof === 1 ? '' : 's'} of freedom` };
}

/* ───────── ids ───────── */

const PREFIX: Record<string, string> = { project: 'pr', line: 'l', circle: 'c', arc: 'a', rect: 'r', center_rect: 'r', slot: 'sl', polygon: 'pg', polyline: 'pl', ellipse: 'e', spline: 'sp', point: 'p', bezier: 'bz', elliptical_arc: 'ea', trapezoid: 'tz' };

export function nextEntityId(op: string, statements = sketch().statements): string {
  const prefix = PREFIX[op] ?? op.slice(0, 2);
  const used = new Set(statements.map((s) => String(s.args[0]?.value ?? '')));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/* ───────── editing ───────── */

let solveRun = 0;

/** Replaces the statements (with undo), re-expands and re-solves from the new geometry. */
export async function commit(statements: Stmt[], options: { undoable?: boolean; message?: string | null } = {}): Promise<void> {
  const previous = sketch().statements;
  const expansion = expand(statements);
  useSketch.setState((state) => ({
    statements, expansion, message: options.message ?? null,
    ...(options.undoable === false ? {} : { undo: [...state.undo.slice(-99), previous], redo: [] }),
  }));
  await resolve();
}

/** Solves the current statements and writes the solution back into them. */
export async function resolve(): Promise<void> {
  const run = ++solveRun;
  const { expansion, statements } = sketch();
  useSketch.setState({ solving: true });
  const result = await solveSketch(expansion);
  if (run !== solveRun) return;
  if (result.status === 'ok') {
    const solvedStatements = writeBack(statements, result.entities);
    useSketch.setState({ statements: solvedStatements, expansion: expand(solvedStatements), result, solving: false });
  } else useSketch.setState({ result, solving: false });
}

export function undo() {
  const { undo: stack, statements } = sketch();
  const previous = stack.at(-1);
  if (!previous) return;
  useSketch.setState((state) => ({ undo: state.undo.slice(0, -1), redo: [...state.redo, statements] }));
  void commit(previous, { undoable: false });
}

export function redo() {
  const { redo: stack, statements } = sketch();
  const next = stack.at(-1);
  if (!next) return;
  useSketch.setState((state) => ({ redo: state.redo.slice(0, -1), undo: [...state.undo, statements] }));
  void commit(next, { undoable: false });
}

export function addStatements(...items: Stmt[]) {
  return commit([...sketch().statements, ...items]);
}

/** Entity or point ref → the entity id (`r1.bottom.start` → `r1.bottom`). */
export function entityOf(ref: string, entities = sketch().expansion.entities): string | null {
  if (entities.some((e) => e.id === ref)) return ref;
  const cut = ref.lastIndexOf('.');
  if (cut > 0) {
    const base = ref.slice(0, cut);
    if (entities.some((e) => e.id === base)) return base;
  }
  return null;
}

/** Deletes selected geometry (whole declaring statements) and every constraint that mentions it. */
export function deleteSelection() {
  const { selection, statements, expansion } = sketch();
  if (!selection.length) return;
  const doomedStatements = new Set<number>();
  const doomedEntities = new Set<string>();
  const doomedConstraints = new Set<string>();
  for (const ref of selection) {
    const constraintOwner = expansion.owners.findIndex((o) => o.constraints.includes(ref));
    const owner = expansion.owners.findIndex((o) => o.entities.includes(entityOf(ref) ?? ref));
    if (owner >= 0) {
      doomedStatements.add(owner);
      expansion.owners[owner].entities.forEach((id) => doomedEntities.add(id));
    } else if (constraintOwner >= 0 && expansion.owners[constraintOwner].entities.length === 0) {
      doomedStatements.add(constraintOwner);
    } else if (constraintOwner >= 0) doomedConstraints.add(ref);
  }
  const mentions = (c: Constraint) => c.refs.some((r) => doomedEntities.has(entityOf(r) ?? r)) || (typeof c.at === 'string' && doomedEntities.has(entityOf(c.at) ?? c.at));
  expansion.constraints.forEach((c) => {
    if (mentions(c)) {
      const owner = expansion.owners.findIndex((o) => o.constraints.includes(c.id));
      if (owner >= 0 && expansion.owners[owner].entities.length === 0) doomedStatements.add(owner);
    }
  });
  const kept = statements.filter((_, index) => !doomedStatements.has(index));
  useSketch.setState({ selection: [] });
  void commit(kept, { message: doomedConstraints.size ? 'Constraints inside a shape (like a rectangle’s corners) go with the shape.' : null });
}

/** Removes one constraint or dimension statement (geometry goes through deleteSelection). */
export function removeStatement(index: number) {
  const { statements, expansion, selection } = sketch();
  const gone = new Set(expansion.owners[index]?.constraints ?? []);
  useSketch.setState({ selection: selection.filter((ref) => !gone.has(ref)), highlight: [] });
  return commit(statements.filter((_, i) => i !== index));
}

/** Rewrites a polygon's side count; constraints on sides that no longer exist go with them. */
export function setPolygonSides(index: number, sides: number) {
  const { statements } = sketch();
  const s = statements[index];
  if (s?.op !== 'polygon') return;
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  const id = String(s.args[0]?.value ?? '');
  const args = [...s.args];
  const kwargs = { ...s.kwargs };
  if (args.length > 3) args[3] = lit(n); else kwargs.sides = lit(n);
  const gone = new RegExp(`^${id}\\.(side|c|on|tan|eq)(\\d+)(\\.|$)`);  // Ids are identifiers.
  const stale = (value: unknown) => typeof value === 'string' && Number(gone.exec(value)?.[2] ?? -1) >= n;
  let dropped = 0;
  const next = statements.flatMap((item, i) => {
    if (i === index) return [{ ...item, args, kwargs }];
    if ([...item.args, ...Object.values(item.kwargs)].some((a) => stale(a.value))) { dropped++; return []; }
    return [item];
  });
  useSketch.setState((state) => ({ selection: state.selection.filter((ref) => !stale(ref)) }));
  return commit(next, { message: dropped ? `Removed ${dropped} constraint${dropped === 1 ? '' : 's'} on sides that no longer exist.` : null });
}

/** Toggles construction on the statements that declare the selected geometry. */
export function toggleConstruction() {
  const { selection, statements, expansion } = sketch();
  const owners = new Set(selection.map((ref) => expansion.owners.findIndex((o) => o.entities.includes(entityOf(ref) ?? ref))).filter((i) => i >= 0));
  if (!owners.size) { useSketch.setState((state) => ({ construction: !state.construction })); return; }
  const next = statements.map((s, index) => {
    if (!owners.has(index)) return s;
    const on = s.kwargs.construction?.value === true;
    const kwargs = { ...s.kwargs };
    if (on) delete kwargs.construction; else kwargs.construction = lit(true);
    return { ...s, kwargs };
  });
  void commit(next);
}

/** Adds a constraint statement (and solves). Values are numbers or expressions. */
export function constrain(op: string, refs: string[], value?: { source: string; value: number } | null, extra: Record<string, string> = {}) {
  const args = refs.map((ref) => lit(ref));
  if (value) args.push({ source: value.source, value: value.value });
  const kwargs = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, lit(v)]));
  return addStatements({ op, args, kwargs });
}

export { stmt, lit };

// The ribbon and command availability read the app store; mirror what they need.
useSketch.subscribe((state, previous) => {
  if (state.active === previous.active && state.choosing === previous.choosing && state.tool === previous.tool
    && state.selection.length === previous.selection.length && !!state.undo.length === !!previous.undo.length && !!state.redo.length === !!previous.redo.length) return;
  setApp({ sketching: state.active || state.choosing
    ? { tool: state.tool, choosing: state.choosing, selection: state.selection.length, undo: state.undo.length > 0, redo: state.redo.length > 0 } : null });
});

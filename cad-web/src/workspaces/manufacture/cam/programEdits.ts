/**
 * What the Manufacture tree's menus do to a program, as pure functions on its data (both kinds of program: the program
 * store's and a CAM document's, cam/camCode.ts): delete a setup with everything in it, delete, duplicate, rename or
 * move an operation, duplicate a setup. Whatever is removed, the rest stays runnable: an operation that worked on the
 * stock a removed one left now works on the stock of the nearest operation before it (or the setup's own stock), and a
 * setup that took the stock a removed setup left starts from the stock that setup started from. No imports
 * (tests/program_edits_test.mjs runs them in Node).
 */

type Rec = Record<string, unknown>;
export interface ProgramData { setups: Rec[]; operations: Rec[]; libraries?: { alias: string; pin: unknown }[]; [key: string]: unknown }
type Vec3 = [number, number, number];
interface Frame { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }

const DEFAULT_SETUP = 'setup';
const setupOf = (op: Rec) => String(op.setup ?? DEFAULT_SETUP);
const idOf = (item: Rec) => String(item.id);
const opsIn = (program: ProgramData, setupId: string) => program.operations.filter((op) => setupOf(op) === setupId);
const stockSource = (setup: Rec | undefined) => {
  const stock = setup?.stock as Rec | undefined;
  return stock?.kind === 'previous_operation' ? String(stock.operation) : null;
};

// ── Frames (a transfer: a point p maps to origin + p.x·x + p.y·y + p.z·z) ───────────────────────────────

const round6 = (value: number) => Math.round(value * 1e6) / 1e6 + 0;
const frameOf = (value: unknown): Frame => {
  const f = (value ?? {}) as Rec;
  const v = (item: unknown, fallback: Vec3) => (Array.isArray(item) && item.length === 3 ? item.map(Number) as Vec3 : fallback);
  return { origin: v(f.origin_mm, [0, 0, 0]), x: v(f.x, [1, 0, 0]), y: v(f.y, [0, 1, 0]), z: v(f.z, [0, 0, 1]) };
};
const frameJson = (f: Frame) => ({ origin_mm: f.origin, x: f.x, y: f.y, z: f.z });
const vector = (f: Frame, v: number[]): Vec3 => [0, 1, 2].map((i) => round6(f.x[i] * v[0] + f.y[i] * v[1] + f.z[i] * v[2])) as Vec3;
const point = (f: Frame, p: number[]): Vec3 => vector(f, p).map((value, i) => round6(value + f.origin[i])) as Vec3;
/** a after b: a point in b's source frame, moved by b, then by a. */
const compose = (a: Frame, b: Frame): Frame => ({ origin: point(a, b.origin), x: vector(a, b.x), y: vector(a, b.y), z: vector(a, b.z) });
/** A box moved by a frame, as the box it fills. */
function movedBox(f: Frame, min: number[], max: number[]): { minimum_mm: Vec3; maximum_mm: Vec3 } {
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => point(f, [n & 1 ? max[0] : min[0], n & 2 ? max[1] : min[1], n & 4 ? max[2] : min[2]]));
  return { minimum_mm: [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i]))) as Vec3, maximum_mm: [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i]))) as Vec3 };
}

// ── Re-chaining ────────────────────────────────────────────────────────────

/**
 * After operations are removed (`removed`) or moved: each operation's references to a removed one (depends_on,
 * rest_from) point at the nearest remaining operation before it in its setup instead, else at the operation the setup
 * takes its stock from, else nothing. References to operations still there are kept as they are.
 */
function rechain(program: ProgramData, removed: Set<string>): ProgramData {
  const operations = program.operations.map((op, index) => {
    const before = program.operations.slice(0, index).filter((other) => setupOf(other) === setupOf(op)).at(-1);
    const setup = program.setups.find((item) => idOf(item) === setupOf(op));
    const fallback = before ? idOf(before) : stockSource(setup);
    const out: Rec = { ...op };
    if (Array.isArray(op.depends_on)) {
      const kept = [...new Set((op.depends_on as string[]).map((dep) => (removed.has(dep) ? fallback : dep)).filter((dep): dep is string => !!dep && dep !== idOf(op)))];
      if (kept.length) out.depends_on = kept; else delete out.depends_on;
    }
    const strategy = op.strategy as Rec | undefined;
    if (strategy && typeof strategy.rest_from === 'string' && removed.has(strategy.rest_from)) out.strategy = { ...strategy, rest_from: before ? idOf(before) : null };
    return out;
  });
  return { ...program, operations };
}

/** Library aliases nothing names any more are dropped (a program store program's pins). */
function pruneLibraries(program: ProgramData): ProgramData {
  if (!program.libraries) return program;
  const used = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === 'string') used.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(program.setups);
  walk(program.operations);
  return { ...program, libraries: program.libraries.filter((item) => used.has(item.alias)) };
}

// ── What depends on what ───────────────────────────────────────────────────

/** What would change if an operation went: the operations working on its stock and the setups taking it. */
export function dependentsOf(program: ProgramData, opId: string): { operations: string[]; setups: string[] } {
  return {
    operations: program.operations.filter((op) => ((op.depends_on as string[] | undefined) ?? []).includes(opId) || (op.strategy as Rec | undefined)?.rest_from === opId).map(idOf),
    setups: program.setups.filter((setup) => stockSource(setup) === opId).map(idOf),
  };
}

// ── Setups ─────────────────────────────────────────────────────────────────

/** Whether a setup is the program's only one (deleting it leaves the program empty). */
export const onlySetup = (program: ProgramData, setupId: string) => program.setups.length === 1 && idOf(program.setups[0]) === setupId;

/**
 * The program without a setup and its operations. A later setup that took the stock this setup left starts from the
 * stock this one started from (the operation it continued from, the turns composed; or its box, turned). The only
 * setup can go too: the program is then empty, ready for a new one.
 */
export function deleteSetup(program: ProgramData, setupId: string): ProgramData {
  const setup = program.setups.find((item) => idOf(item) === setupId);
  if (!setup) return program;
  const gone = new Set(opsIn(program, setupId).map(idOf));
  const ownStock = setup.stock as Rec | undefined;
  const setups = program.setups.filter((item) => item !== setup).map((item) => {
    const from = stockSource(item);
    if (!from || !gone.has(from)) return item;
    const stock = item.stock as Rec;
    const turn = frameOf(stock.transfer);
    if (ownStock?.kind === 'previous_operation') {
      return { ...item, stock: { ...stock, operation: String(ownStock.operation), transfer: frameJson(compose(turn, frameOf(ownStock.transfer))) } };
    }
    const bounds = (ownStock?.bounds ?? {}) as Rec;
    const min = (bounds.minimum_mm as number[] | undefined) ?? [0, 0, 0];
    const max = (bounds.maximum_mm as number[] | undefined) ?? [0, 0, 0];
    return { ...item, stock: { kind: 'box', bounds: movedBox(turn, min, max) } };
  });
  const operations = program.operations.filter((op) => !gone.has(idOf(op)));
  return pruneLibraries(rechain({ ...program, setups, operations }, gone));
}

/** A free id from a base: `base`, `base_2`, … */
function freeId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

/** A copy of a setup and its operations ("… copy"), placed right after it; the copy's operations follow one another. */
export function duplicateSetup(program: ProgramData, setupId: string): { program: ProgramData; setup: string } {
  const setup = program.setups.find((item) => idOf(item) === setupId);
  if (!setup) return { program, setup: setupId };
  const setupIds = new Set(program.setups.map(idOf));
  const opIds = new Set(program.operations.map(idOf));
  const copyId = freeId(`${setupId}_copy`, setupIds);
  const mine = opsIn(program, setupId);
  const renamed = new Map(mine.map((op) => [idOf(op), freeId(`${idOf(op)}_copy`, opIds)]));
  const copies = mine.map((op) => {
    const out: Rec = { ...structuredClone(op), id: renamed.get(idOf(op)), setup: copyId };
    if (Array.isArray(op.depends_on)) out.depends_on = (op.depends_on as string[]).map((dep) => renamed.get(dep) ?? dep);
    const strategy = out.strategy as Rec | undefined;
    if (strategy && typeof strategy.rest_from === 'string') out.strategy = { ...strategy, rest_from: renamed.get(strategy.rest_from) ?? strategy.rest_from };
    return out;
  });
  const copy: Rec = { ...structuredClone(setup), id: copyId, name: `${String(setup.name ?? setupId)} copy` };
  const setups = [...program.setups];
  setups.splice(setups.indexOf(setup) + 1, 0, copy);
  const last = mine.at(-1);
  const operations = [...program.operations];
  operations.splice(last ? operations.indexOf(last) + 1 : operations.length, 0, ...copies);
  return { program: { ...program, setups, operations }, setup: copyId };
}

export function renameSetup(program: ProgramData, setupId: string, name: string): ProgramData {
  return { ...program, setups: program.setups.map((item) => (idOf(item) === setupId ? { ...item, name } : item)) };
}

// ── Operations ─────────────────────────────────────────────────────────────

/** The program without an operation: what worked on its stock now works on the stock before it. */
export function deleteOperation(program: ProgramData, opId: string): ProgramData {
  const index = program.operations.findIndex((op) => idOf(op) === opId);
  if (index < 0) return program;
  const op = program.operations[index];
  const before = program.operations.slice(0, index).filter((other) => setupOf(other) === setupOf(op)).at(-1);
  // A setup that took its stock from it takes the stock before it (the nearest operation before it in its setup).
  const fallback = before ? idOf(before) : stockSource(program.setups.find((item) => idOf(item) === setupOf(op)));
  const setups = program.setups.map((setup) => (stockSource(setup) === opId && fallback ? { ...setup, stock: { ...(setup.stock as Rec), operation: fallback } } : setup));
  const operations = program.operations.filter((item) => item !== op);
  return pruneLibraries(rechain({ ...program, setups, operations }, new Set([opId])));
}

/** A copy of an operation ("… copy") right after it, working on the stock it leaves; what followed it follows the copy. */
export function duplicateOperation(program: ProgramData, opId: string): { program: ProgramData; operation: string } {
  const index = program.operations.findIndex((op) => idOf(op) === opId);
  if (index < 0) return { program, operation: opId };
  const op = program.operations[index];
  const id = freeId(`${opId}_copy`, new Set(program.operations.map(idOf)));
  const copy: Rec = { ...structuredClone(op), id, name: `${String(op.name ?? opId)} copy`, depends_on: [opId] };
  const strategy = copy.strategy as Rec | undefined;
  if (strategy && typeof strategy.rest_from === 'string') copy.strategy = { ...strategy, rest_from: opId };
  const operations = program.operations.map((item) => {
    if (item === op || setupOf(item) !== setupOf(op)) return item;
    const deps = item.depends_on as string[] | undefined;
    return deps?.includes(opId) ? { ...item, depends_on: deps.map((dep) => (dep === opId ? id : dep)) } : item;
  });
  operations.splice(index + 1, 0, copy);
  return { program: { ...program, operations }, operation: id };
}

export function renameOperation(program: ProgramData, opId: string, name: string): ProgramData {
  return { ...program, operations: program.operations.map((op) => (idOf(op) === opId ? { ...op, name } : op)) };
}

/** Each operation of a setup depends on the one before it there (its first on the operation the setup's stock comes from). */
function chainSetup(program: ProgramData, setupId: string): ProgramData {
  const setup = program.setups.find((item) => idOf(item) === setupId);
  let previous: string | null = stockSource(setup);
  const operations = program.operations.map((op) => {
    if (setupOf(op) !== setupId) return op;
    const out: Rec = { ...op };
    if (previous) out.depends_on = [previous]; else delete out.depends_on;
    previous = idOf(op);
    return out;
  });
  return { ...program, operations };
}

/** An operation moved to the end of another setup: both setups' operations follow one another again. */
export function moveOperationToSetup(program: ProgramData, opId: string, setupId: string): ProgramData {
  const op = program.operations.find((item) => idOf(item) === opId);
  if (!op || setupOf(op) === setupId || !program.setups.some((item) => idOf(item) === setupId)) return program;
  const from = setupOf(op);
  const rest = program.operations.filter((item) => item !== op);
  const last = rest.filter((item) => setupOf(item) === setupId).at(-1);
  const at = last ? rest.indexOf(last) + 1 : rest.length;
  const moved: Rec = { ...op, setup: setupId };
  rest.splice(at, 0, moved);
  // A setup that took its stock from it takes the stock before it.
  const fallback = rest.filter((item) => setupOf(item) === from && program.operations.indexOf(item) < program.operations.indexOf(op)).at(-1);
  const setups = program.setups.map((setup) => (stockSource(setup) === opId && fallback ? { ...setup, stock: { ...(setup.stock as Rec), operation: idOf(fallback) } } : setup));
  return chainSetup(chainSetup({ ...program, setups, operations: rest }, from), setupId);
}

/** An operation one place up or down within its setup; the setup's operations follow one another again. */
export function moveOperation(program: ProgramData, opId: string, delta: -1 | 1): ProgramData {
  const op = program.operations.find((item) => idOf(item) === opId);
  if (!op) return program;
  const mine = opsIn(program, setupOf(op));
  const at = mine.indexOf(op);
  const other = mine[at + delta];
  if (!other) return program;
  const operations = program.operations.map((item) => (item === op ? other : item === other ? op : item));
  return chainSetup({ ...program, operations }, setupOf(op));
}

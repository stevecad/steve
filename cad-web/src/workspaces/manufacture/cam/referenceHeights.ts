/**
 * Heights after a design change (docs/MANUFACTURING_REFERENCES.md). An operation's heights are numbers in the work
 * frame (the design's own frame), filled in from the geometry when it was picked; a reference review only re-resolves
 * the selections. This compares each changed operation's heights with the geometry the review captured before and
 * after: a height that sat exactly on the old geometry (its floor face, the part's top or bottom, the selected edges or
 * hole walls, a floor of the part) is proposed at the same place on the new one, and a top at a facing's height
 * follows that facing (tops otherwise stay at the stock's, which a design change doesn't move); a height that matched nothing, or
 * matched places that moved differently, is flagged for the person to check. Nothing is guessed beyond an exact match,
 * and the machining checks still run on the next run.
 *
 * No imports: this module is unit-tested under plain Node (tests/cam_reference_heights_test.mjs).
 */

type Rec = Record<string, unknown>;
type Bounds = [number, number, number, number, number, number];

/** A catalog entity as the review report carries it (the fields used here). */
export interface CatalogEntity {
  id: string; link: string; instances?: string[]; body: string; kind: 'body' | 'face' | 'edge' | 'vertex';
  names?: string[]; geometry_resolution?: 'unique' | 'ambiguous'; bounds_mm: Bounds;
}
export interface Catalogs { [link: string]: { entities: CatalogEntity[] } }
interface Resolution { status: string; entities: string[] }
export interface TargetChange { path: string; owner: string; owner_id: string; status: string; before: Resolution | null; after: Resolution | null }

export type HeightField = 'top' | 'bottom' | 'clearance';
/** A height to move: operation `operation`'s `field` from `before` to `after`, and why. */
export interface HeightChange { operation: string; name: string; field: HeightField; before: number; after: number; reason: string }
/** An operation whose geometry changed but whose bottom follows nothing the review can place: the person checks it. */
export interface HeightCheck { operation: string; name: string }

const STRATEGY: Record<HeightField, string> = { top: 'top_mm', bottom: 'bottom_mm', clearance: 'clearance_mm' };
/** Heights are saved to the micrometre (floors) or the thousandth (stock and part heights); within half of that is the same place. */
const SAME = 5e-4;
const same = (a: number, b: number) => Math.abs(a - b) < SAME;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const INDEXED = /\.(?:face|edge|vertex|solid)\(\d+\)/;
/** Statuses where the selected geometry may sit elsewhere now. */
const MOVED = new Set(['geometry_changed', 'revision_local_review', 'explicit_reselection', 'new_selection']);
const DRILLING = new Set(['drill', 'peck_drill', 'bore']);

const bodyKey = (entity: CatalogEntity) => `${entity.link}|${(entity.instances ?? []).join('/') || 'part'}|${entity.body}`;
const flat = (entity: CatalogEntity) => entity.kind === 'face' && Math.abs(entity.bounds_mm[5] - entity.bounds_mm[2]) < 1e-6;

/** One pass over a side's catalogs: entities by ID, bodies by identity, and named horizontal faces of each body. */
function indexOf(catalogs: Catalogs) {
  const byId = new Map<string, CatalogEntity>();
  const bodies = new Map<string, CatalogEntity>();
  const floors = new Map<string, CatalogEntity[]>();
  const named = new Map<string, CatalogEntity[]>();
  const add = (map: Map<string, CatalogEntity[]>, key: string, entity: CatalogEntity) => {
    const list = map.get(key);
    if (list) list.push(entity); else map.set(key, [entity]);
  };
  for (const catalog of Object.values(catalogs)) {
    for (const entity of catalog.entities) {
      byId.set(entity.id, entity);
      const key = bodyKey(entity);
      if (entity.kind === 'body') { bodies.set(key, entity); continue; }
      if (!flat(entity)) continue;
      add(floors, key, entity);
      if (entity.geometry_resolution === 'ambiguous') continue;
      for (const name of entity.names ?? []) if (!INDEXED.test(name)) add(named, `${key}|${name}`, entity);
    }
  }
  return { byId, bodies, floors, named };
}
type Index = ReturnType<typeof indexOf>;

interface Place { z: number; reason: string }
/** What a height follows: one place on the new design, `ambiguous` (it sat on places that moved differently), or null (none). */
type Follow = Place | 'ambiguous' | null;

/**
 * Where height `h` sits now: the first tier whose old geometry it matched decides — the selected entities (each one's
 * bottom and top, and for hole walls their lowest bottom), then their body's bottom and top, then a named floor of
 * that body (pockets choosing their only floor level). A tier whose matches disagree is ambiguous.
 */
function follow(h: number, pairs: [CatalogEntity, CatalogEntity][], old: Index, now: Index, drilling: boolean): Follow {
  const decide = (places: (Place | null)[]): Follow => {
    if (!places.length) return null;
    if (places.some((place) => place === null)) return 'ambiguous';
    const first = places[0]!;
    return places.every((place) => same(place!.z, first.z)) ? first : 'ambiguous';
  };
  const selected: Place[] = [];
  for (const [a, b] of pairs) {
    if (a.kind === 'body') continue;
    const what = a.kind === 'edge' ? 'its edges' : drilling ? 'its holes' : 'its selected face';
    if (same(a.bounds_mm[2], h)) selected.push({ z: b.bounds_mm[2], reason: `follows ${what}` });
    else if (same(a.bounds_mm[5], h)) selected.push({ z: b.bounds_mm[5], reason: `follows ${what}` });
  }
  if (drilling && pairs.length > 1) {
    // The bottom of several holes is the lowest hole wall.
    const low = (side: 0 | 1) => Math.min(...pairs.map((pair) => pair[side].bounds_mm[2]));
    if (same(low(0), h)) selected.splice(0, selected.length, { z: low(1), reason: 'follows its deepest hole' });
  }
  const tier1 = decide(selected);
  if (tier1) return tier1;
  const bodies: Place[] = [];
  for (const key of new Set(pairs.map(([a]) => bodyKey(a)))) {
    const [a, b] = [old.bodies.get(key), now.bodies.get(key)];
    if (!a || !b) continue;
    if (same(a.bounds_mm[2], h)) bodies.push({ z: b.bounds_mm[2], reason: 'follows the part’s bottom' });
    else if (same(a.bounds_mm[5], h)) bodies.push({ z: b.bounds_mm[5], reason: 'follows the part’s top' });
  }
  const tier2 = decide(bodies);
  if (tier2) return tier2;
  const floors: (Place | null)[] = [];
  for (const key of new Set(pairs.map(([a]) => bodyKey(a)))) {
    for (const face of old.floors.get(key) ?? []) {
      if (!same(face.bounds_mm[2], h)) continue;
      const names = (face.names ?? []).filter((name) => !INDEXED.test(name));
      const found = new Set(names.flatMap((name) => now.named.get(`${key}|${name}`) ?? []));
      // A floor without a lasting name, or whose name now names several faces, can't be followed.
      floors.push(found.size === 1 ? { z: [...found][0].bounds_mm[2], reason: 'follows its floor' } : null);
    }
  }
  const tier3 = decide(floors);
  if (tier3 && tier3 !== 'ambiguous') return tier3;
  // As a pocket on the whole part picks its bottom: the part's only floor level, before and after.
  for (const key of new Set(pairs.map(([a]) => bodyKey(a)))) {
    const [a, b] = [levels(old, key), levels(now, key)];
    if (a.length === 1 && same(a[0], h) && b.length === 1) return { z: b[0], reason: 'follows the part’s floor' };
  }
  return tier3;
}

/** The heights of a body's horizontal faces strictly between its bottom and top (its floor levels). */
function levels(index: Index, key: string): number[] {
  const body = index.bodies.get(key);
  if (!body) return [];
  const out: number[] = [];
  for (const face of index.floors.get(key) ?? []) {
    const z = face.bounds_mm[2];
    if (z > body.bounds_mm[2] + 1e-6 && z < body.bounds_mm[5] - 1e-6 && !out.some((item) => same(item, z))) out.push(z);
  }
  return out;
}

/** Whether `h` sits on the new design's geometry of these selections already (picked again on the new design). */
function onNew(h: number, present: CatalogEntity[], now: Index): boolean {
  return present.some((b) => {
    const body = now.bodies.get(bodyKey(b));
    return same(b.bounds_mm[2], h) || same(b.bounds_mm[5], h) || (!!body && (same(body.bounds_mm[2], h) || same(body.bounds_mm[5], h)))
      || (now.floors.get(bodyKey(b)) ?? []).some((face) => same(face.bounds_mm[2], h));
  });
}

/**
 * The heights to update and the operations to check, for program `operations` reviewed with `changes` between the
 * `before` and `after` catalogs. Only operations whose target selections changed are looked at.
 */
export function heightChanges(operations: Rec[], changes: TargetChange[], before: Catalogs, after: Catalogs): { changes: HeightChange[]; checks: HeightCheck[] } {
  const old = indexOf(before);
  const now = indexOf(after);
  const out: HeightChange[] = [];
  const checks: HeightCheck[] = [];
  // Facings whose finished height moves: later operations of their setup starting at that height start at the new one.
  const facings: { setup: string; before: number; after: number }[] = [];
  for (const op of operations) {
    const id = String(op.id);
    const name = String(op.name ?? id);
    const strategy = (op.strategy ?? {}) as Rec;
    const kind = String(strategy.kind ?? 'pocket');
    const setup = String(op.setup ?? 'setup');
    const value = (field: HeightField) => Number(strategy[STRATEGY[field]]);
    const propose = (field: HeightField, place: Place) => {
      const z = round(place.z);
      if (!same(z, value(field))) out.push({ operation: id, name, field, before: value(field), after: z, reason: place.reason });
    };
    const withTop = (place: Place) => {
      propose('top', place);
      // A clearance left at the top plus 5 mm stays 5 mm above it.
      if (same(value('clearance'), value('top') + 5)) propose('clearance', { z: place.z + 5, reason: 'stays 5 mm above the top' });
    };
    const faced = kind === 'face' || kind === 'engrave' ? undefined : facings.find((item) => item.setup === setup && same(item.before, value('top')));
    if (faced) withTop({ z: faced.after, reason: 'follows the facing before it' });
    const mine = changes.filter((change) => change.owner === 'operation' && change.owner_id === id && /\/targets\/\d+$/.test(change.path));
    if (!mine.some((change) => MOVED.has(change.status))) continue;
    // Old and new entities side by side for each selection that resolved on both designs (same selection, moved);
    // `present`: every entity selected on the new design.
    const pairs: [CatalogEntity, CatalogEntity][] = [];
    const present: CatalogEntity[] = [];
    for (const change of mine) {
      const a = change.before?.status === 'resolved' ? change.before.entities.map((entity) => old.byId.get(entity)) : [];
      const b = change.after?.status === 'resolved' ? change.after.entities.map((entity) => now.byId.get(entity)) : [];
      present.push(...b.filter((item): item is CatalogEntity => !!item));
      if (change.status === 'explicit_reselection' || !a.length || a.length !== b.length || a.some((item) => !item) || b.some((item) => !item)) continue;
      a.forEach((item, index) => pairs.push([item!, b[index]!]));
    }
    // The top is the stock's (or a facing's) except for an engraving, cut into the surface it follows.
    const top = pairs.length && kind === 'engrave' ? follow(value('top'), pairs, old, now, false) : null;
    let bottom: Follow = null;
    if (!pairs.length) {
      // A new or reselected selection: its heights were set against it (or not); nothing old to follow.
    } else if (kind === 'engrave') {
      // An engraving keeps its depth below the surface it's cut into.
      if (top && top !== 'ambiguous') bottom = { z: top.z - (value('top') - value('bottom')), reason: 'keeps the engraving depth' };
    } else if (kind === 'chamfer') {
      // A chamfer's bottom is its edge less the bevel: it moves with the edge (the selected edges or faces, or the part's top).
      const [a, b] = pairs.find(([item]) => item.kind !== 'body') ?? pairs[0];
      bottom = { z: value('bottom') + (b.bounds_mm[5] - a.bounds_mm[5]), reason: 'follows its chamfered edge' };
    } else {
      bottom = follow(value('bottom'), pairs, old, now, DRILLING.has(kind));
    }
    if (top && top !== 'ambiguous') withTop(top);
    if (bottom && bottom !== 'ambiguous') {
      propose('bottom', bottom);
      if (kind === 'face' && !same(bottom.z, value('bottom'))) {
        const allowance = Number(strategy.axial_allowance_mm ?? 0);
        facings.push({ setup, before: value('bottom') + allowance, after: bottom.z + allowance });
      }
    }
    if (top === 'ambiguous' || ((!bottom || bottom === 'ambiguous') && !onNew(value('bottom'), present, now))) checks.push({ operation: id, name });
  }
  return { changes: out, checks };
}

/**
 * The program with these heights moved. A height already changed since the review (it no longer reads `before`) is
 * left as it is.
 */
export function withHeights<P extends { operations: Rec[] }>(program: P, changes: HeightChange[]): P {
  return {
    ...program,
    operations: program.operations.map((op) => {
      const mine = changes.filter((change) => change.operation === String(op.id));
      if (!mine.length) return op;
      const strategy = { ...(op.strategy as Rec) };
      for (const change of mine) {
        const key = STRATEGY[change.field];
        if (same(Number(strategy[key]), change.before)) strategy[key] = change.after;
      }
      return { ...op, strategy };
    }),
  };
}

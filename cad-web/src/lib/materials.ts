import { useEffect } from 'react';
import { create } from 'zustand';
import libraryUrl from '@/materials/data/library.json?url';
import { ensureModel, insertFeature, pyString, replaceSpan, type Look, type MaterialStatement, type ModelDoc, type ModelingResult, type Span } from './modeling';

/**
 * The material library (web/src/materials/data, built by scripts/materials/build.py from open datasets;
 * sources and licenses in its NOTICE.md) and material assignments, which live in the code as
 * `model.material(...)` statements (docs/MODELING.md section 4).
 */

export interface Quantity { value: number; unit: string; source: string; note?: string }

export const PROPERTIES = ['density', 'youngs_modulus', 'shear_modulus', 'poisson_ratio', 'yield_strength', 'ultimate_strength', 'elongation', 'hardness',
  'flexural_strength', 'compressive_strength', 'thermal_conductivity', 'specific_heat', 'thermal_expansion', 'melting_point', 'electrical_conductivity'] as const;
export type PropertyKey = typeof PROPERTIES[number];

export const PROPERTY_LABELS: Record<PropertyKey, string> = {
  density: 'Density', youngs_modulus: "Young's modulus", shear_modulus: 'Shear modulus', poisson_ratio: "Poisson's ratio",
  yield_strength: 'Yield strength', ultimate_strength: 'Tensile strength', elongation: 'Elongation at break', hardness: 'Hardness',
  flexural_strength: 'Flexural strength', compressive_strength: 'Compressive strength', thermal_conductivity: 'Thermal conductivity',
  specific_heat: 'Specific heat', thermal_expansion: 'Thermal expansion', melting_point: 'Melting point', electrical_conductivity: 'Electrical conductivity',
};

export interface Color { linear: [number, number, number]; srgb: string }

export interface Appearance {
  class: 'metal' | 'dielectric' | 'transparent' | 'wood';
  base_color: Color;
  metalness: number;
  roughness: number;
  ior: number | null;
  transmission: number | null;
  thickness_mm: number | null;
  attenuation_color: Color | null;
  attenuation_distance_mm: number | null;
  clearcoat: number | null;
  clearcoat_roughness: number | null;
  sheen: number | null;
  finish: string;
  source: string;
  preset: string;
}

export interface SourceRecord { record: string; url: string; license: string; author?: string; reference?: string }

export interface Material {
  id: string;
  name: string;
  category: string;
  designations: string[];
  description: string;
  tags: string[];
  sources: Record<string, SourceRecord>;
  properties: Record<PropertyKey, Quantity | null>;
  appearance: Appearance;
  /** One of the person's own materials ("my:" ids): the library material it was copied from, if any, and its version. */
  own?: { based_on: string | null; updated_at: string };
}

export interface Finish {
  id: string;
  name: string;
  classes: Appearance['class'][];
  categories: string[] | null;
  roughness: number | null;
  metalness: number | null;
  clearcoat: number | null;
  clearcoat_roughness: number | null;
  transmission: number | null;
  texture: 'brushed' | 'grain' | 'wood' | null;
  texture_scale_mm: number | null;
  normal_scale: number | null;
  use_color: boolean;
}

export interface Library {
  version: 1;
  sources: Record<string, { name: string; url: string; license: string; revision: string | null; note?: string }>;
  categories: { id: string; name: string; group: string }[];
  finishes: Finish[];
  materials: Material[];
  legacy: Record<string, string>;
  byId: Map<string, Material>;
  finishById: Map<string, Finish>;
}

export const useMaterialLibrary = create<{ library: Library | null; failed: boolean }>(() => ({ library: null, failed: false }));

type LibraryData = Omit<Library, 'byId' | 'finishById'>;

let loading: Promise<Library> | null = null;
let shared: LibraryData | null = null;

/**
 * Fetched once, on first use: the dataset is a separate asset, not part of the app bundle. In the app (not a share
 * page), the person's own materials join it (`includeOwnMaterials`).
 */
export function loadLibrary(): Promise<Library> {
  loading ??= Promise.all([
    fetch(libraryUrl).then(async (response) => {
      if (!response.ok) throw new Error(`Material library download failed (${response.status}).`);
      return await response.json() as LibraryData;
    }),
    fetchOwn(),
  ]).then(([data]) => {
    shared = { ...data, legacy: data.legacy ?? {} };
    return publish();
  }).catch((error: unknown) => {
    loading = null;
    useMaterialLibrary.setState({ failed: true });
    throw error;
  });
  return loading;
}

/* ───────── The person's own materials (app/user_materials.py) ───────── */

/** One of the person's own materials as the server keeps it: values in the library's units (OWN_UNITS). */
export interface OwnMaterial {
  id: string;
  name: string;
  category: string;
  based_on: string | null;
  description: string;
  color: string | null;
  properties: Partial<Record<PropertyKey, number>>;
  updated_at: string;
}
export type OwnMaterialInput = Omit<OwnMaterial, 'id' | 'updated_at'>;

/** What a person can set on their own materials, in the library's units (app/user_materials.py UNITS). */
export const OWN_UNITS: Partial<Record<PropertyKey, string>> = {
  density: 'g/cm³', youngs_modulus: 'GPa', shear_modulus: 'GPa', poisson_ratio: '', yield_strength: 'MPa', ultimate_strength: 'MPa',
  elongation: '%', flexural_strength: 'MPa', compressive_strength: 'MPa', thermal_conductivity: 'W/(m·K)', specific_heat: 'J/(kg·K)',
  thermal_expansion: 'µm/(m·K)', melting_point: '°C', electrical_conductivity: 'MS/m',
};
export const OWN_PROPERTIES = PROPERTIES.filter((key) => key in OWN_UNITS);
/** The category filter that shows only the person's own materials. */
export const MINE = 'mine';
const OWN_SOURCE = 'own';

let ownEnabled = false;
let ownFailed = false;
let own: OwnMaterial[] = [];

/** The app (signed in) shows the person's own materials beside the library; share pages never ask for them. */
export function includeOwnMaterials() {
  ownEnabled = true;
}

/** Whether the person's own materials couldn't be read (the library opens without them). */
export const ownMaterialsFailed = () => ownFailed;

/** A /v1/materials request (signed in by the app's fetch; not lib/api, which share pages don't load). */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null) as { detail?: unknown } | null;
  if (!response.ok) {
    const detail = body?.detail;
    const message = typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.map((item: { msg?: string }) => item.msg).join('; ')
        : detail && typeof detail === 'object' ? String((detail as { message?: unknown }).message ?? '') : '';
    throw new Error(message || `Request failed (${response.status}).`);
  }
  return body as T;
}

async function fetchOwn(): Promise<void> {
  if (!ownEnabled) return;
  await request<{ materials: OwnMaterial[] }>('/v1/materials').then((data) => { own = data.materials; ownFailed = false; }, () => { ownFailed = true; });
}

const toLinear = (hex: string): [number, number, number] => [1, 3, 5].map((at) => {
  const value = parseInt(hex.slice(at, at + 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}) as [number, number, number];

/** An own material as a library record: its values, and the look of the material it copies (or its category's), tinted. */
function ownRecord(data: LibraryData, item: OwnMaterial): Material {
  const base = (item.based_on && data.materials.find((m) => m.id === item.based_on)) || data.materials.find((m) => m.category === item.category) || data.materials[0];
  const appearance = { ...base.appearance, ...(item.color ? { base_color: { srgb: item.color, linear: toLinear(item.color) } } : {}) };
  const properties = Object.fromEntries(PROPERTIES.map((key) => {
    const value = item.properties[key];
    return [key, typeof value === 'number' ? { value, unit: OWN_UNITS[key] ?? '', source: OWN_SOURCE } : null];
  })) as Material['properties'];
  return {
    id: item.id, name: item.name, category: item.category, designations: [], description: item.description, tags: ['mine', 'my', 'own'],
    sources: { [OWN_SOURCE]: { record: 'Your own values', url: '', license: '' } }, properties, appearance,
    own: { based_on: item.based_on, updated_at: item.updated_at },
  };
}

function publish(): Library {
  const data = shared!;
  const materials = [...own.map((item) => ownRecord(data, item)), ...data.materials];
  const library: Library = {
    ...data, materials, sources: { ...data.sources, [OWN_SOURCE]: { name: 'Your own values', url: '', license: '', revision: null } },
    byId: new Map(materials.map((m) => [m.id, m])), finishById: new Map(data.finishes.map((f) => [f.id, f])),
  };
  legacyShapes.clear();
  useMaterialLibrary.setState({ library, failed: false });
  return library;
}

/** Reads the person's own materials again (the Materials dialog opening): another tab or device may have changed them. */
export async function refreshOwnMaterials(): Promise<void> {
  if (!ownEnabled || !shared) return;
  await fetchOwn();
  publish();
}

/** Adds (id null) or changes one of the person's own materials; the library shows it at once. */
export async function saveOwnMaterial(id: string | null, input: OwnMaterialInput): Promise<OwnMaterial> {
  const saved = await request<OwnMaterial>(id ? `/v1/materials/${encodeURIComponent(id)}` : '/v1/materials',
    { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  own = [...own.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (shared) publish();
  return saved;
}

export async function deleteOwnMaterial(id: string): Promise<void> {
  await request<null>(`/v1/materials/${encodeURIComponent(id)}`, { method: 'DELETE' });
  own = own.filter((item) => item.id !== id);
  if (shared) publish();
}

/**
 * The editor's starting fields: an own material's as saved (editing it), a library material's values for a modified
 * copy of it, or empty for a new material in `category`.
 */
export function ownDraft(material: Material | null, category: string): OwnMaterialInput {
  const saved = material?.own && own.find((item) => item.id === material.id);
  if (saved) return { name: saved.name, category: saved.category, based_on: saved.based_on, description: saved.description, color: saved.color, properties: { ...saved.properties } };
  if (!material || material.own) return { name: '', category, based_on: null, description: '', color: null, properties: {} };
  const properties: Partial<Record<PropertyKey, number>> = {};
  for (const key of OWN_PROPERTIES) {
    const quantity = material.properties[key];
    if (quantity && quantity.unit === OWN_UNITS[key]) properties[key] = quantity.value;
  }
  return { name: `${material.name.slice(0, 89)} (modified)`, category: material.category, based_on: material.id, description: material.description.slice(0, 1000), color: null, properties };
}

export function useLibrary(): Library | null {
  const library = useMaterialLibrary((state) => state.library);
  useEffect(() => { if (!library) loadLibrary().catch(() => undefined); }, [library]);
  return library;
}

/** A library record by id, or by an id the app used before the library (`library.legacy`); undefined until loaded. */
export function materialRecord(id: string | null | undefined): Material | undefined {
  const library = useMaterialLibrary.getState().library;
  return id && library ? library.byId.get(id) ?? library.byId.get(library.legacy[id] ?? '') : undefined;
}

/**
 * The shape of the old hard-coded list, for code not yet moved to `Material` (the Simulate workspace):
 * numbers in GPa, MPa, W/(m·K), µm/(m·K), g/cm³; null where the library has no value. Objects are
 * stable per id, so they work as store selectors. New code: `materialRecord` and `useStudyMaterial`.
 */
export interface LegacyMaterial {
  id: string; name: string; family: string; density: number | null; youngs: number | null; poisson: number | null; yield: number | null;
  ultimate: number | null; thermal: number | null; expansion: number | null; color: string; roughness: number; metalness: number;
}

const legacyShapes = new Map<string, LegacyMaterial>();

export function materialById(id: string | null | undefined): LegacyMaterial | undefined {
  const material = materialRecord(id);
  if (!material) return undefined;
  let shape = legacyShapes.get(material.id);
  if (!shape) {
    const value = (key: PropertyKey) => material.properties[key]?.value ?? null;
    const group = useMaterialLibrary.getState().library?.categories.find((c) => c.id === material.category)?.group;
    shape = {
      id: material.id, name: material.name, family: material.category === 'wood' ? 'Wood' : material.category === 'composite' ? 'Composite' : group === 'Metals' ? 'Metal' : group === 'Polymers' ? 'Polymer' : group ?? 'Other',
      density: value('density'), youngs: value('youngs_modulus'), poisson: value('poisson_ratio'), yield: value('yield_strength'), ultimate: value('ultimate_strength'),
      thermal: value('thermal_conductivity'), expansion: value('thermal_expansion'), color: material.appearance.base_color.srgb,
      roughness: material.appearance.roughness, metalness: material.appearance.metalness,
    };
    legacyShapes.set(material.id, shape);
  }
  return shape;
}

/** Finishes that suit a material, its default first. */
export function finishesFor(library: Library, material: Material): Finish[] {
  const fits = library.finishes.filter((f) => f.classes.includes(material.appearance.class) && (!f.categories || f.categories.includes(material.category)));
  return [...fits.filter((f) => f.id === material.appearance.finish), ...fits.filter((f) => f.id !== material.appearance.finish)];
}

export function finishOf(library: Library, material: Material, finish: string | null | undefined): Finish | null {
  const chosen = finish ? library.finishById.get(finish) : undefined;
  const fits = chosen && chosen.classes.includes(material.appearance.class) && (!chosen.categories || chosen.categories.includes(material.category));
  return (fits ? chosen : library.finishById.get(material.appearance.finish)) ?? null;
}

export function formatQuantity(quantity: Quantity | null | undefined, digits = 3): string {
  if (!quantity) return '—';
  const value = Math.abs(quantity.value) >= 1000 ? Math.round(quantity.value).toLocaleString('en-US') : Number(quantity.value.toPrecision(digits)).toString();
  return quantity.unit ? `${value} ${quantity.unit}` : value;
}

export const density = (material: Material | null | undefined) => material?.properties.density?.value ?? null;

/** Grams from mm³ and g/cm³. */
export const massOf = (volume: number, material: Material | null | undefined) => {
  const rho = density(material);
  return rho === null ? null : (volume / 1000) * rho;
};

export function searchMaterials(library: Library, query: string, category: string | null): Material[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return library.materials.filter((material) => {
    if (category === MINE ? !material.own : category && material.category !== category) return false;
    if (!words.length) return true;
    const text = `${material.name} ${material.id} ${material.designations.join(' ')} ${material.tags.join(' ')} ${material.category}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/* ───────── Assignments in the code ───────── */

export interface Assignment { material: string; finish?: string | null; color?: string | null }
export interface Assignments { part: Assignment | null; bodies: Record<string, Assignment> }

const EMPTY: Assignments = { part: null, bodies: {} };
const assignment = (statement: MaterialStatement): Assignment => ({ material: statement.material!, finish: statement.finish, color: statement.color });

/** What the code says: the part default, and per-body overrides whatever their order (the runtime's rule). */
export function assignmentsFromDoc(doc: ModelDoc | null): Assignments | null {
  if (!doc?.materials) return null;
  // Named constants/computed arguments are resolved by the local CAD build.
  // Treating an unresolved statement as an empty assignment hid valid mass
  // and appearance even after a successful build.
  if (doc.materials.some((statement) => !statement.editable)) return null;
  const out: Assignments = { part: null, bodies: {} };
  for (const statement of doc.materials) {
    if (!statement.material) continue;
    if (statement.bodies) for (const body of statement.bodies) out.bodies[body] = assignment(statement);
    else if (!statement.bodies_span) out.part = assignment(statement);
  }
  return out;
}

/** Resolved assignments reported by the build, including computed arguments. */
export function assignmentsFromReport(report: ModelingResult | null | undefined): Assignments | null {
  if (!report?.materials) return null;
  const part = report.materials.default ? { material: report.materials.default } : null;
  const bodies: Record<string, Assignment> = {};
  for (const [id, body] of Object.entries(report.bodies)) if (body.material) bodies[id] = { material: body.material, finish: body.finish, color: body.color };
  return { part, bodies };
}

export const currentAssignments = (doc: ModelDoc | null, report: ModelingResult | null | undefined): Assignments =>
  assignmentsFromDoc(doc) ?? assignmentsFromReport(report) ?? EMPTY;

export const assignmentOf = (assignments: Assignments, body: string | null): Assignment | null => (body && assignments.bodies[body]) || assignments.part;

const same = (a: Assignment | null | undefined, b: Assignment | null | undefined) =>
  !!a && !!b && a.material === b.material && (a.finish ?? null) === (b.finish ?? null) && (a.color?.toLowerCase() ?? null) === (b.color?.toLowerCase() ?? null);

function statement(variable: string, value: Assignment, bodies?: string[]): string {
  const args = [pyString(value.material)];
  if (bodies) args.push(`bodies=[${bodies.map(pyString).join(', ')}]`);
  if (value.finish) args.push(`finish=${pyString(value.finish)}`);
  if (value.color) args.push(`color=${pyString(value.color.toLowerCase())}`);
  return `${variable}.material(${args.join(', ')})`;
}

/**
 * Sets the material of the whole part (clearing body overrides) or of some bodies (null: back to the part's).
 * The GUI keeps one part statement and one statement per distinct body assignment, where the first one was.
 */
export function writeMaterial(code: string, doc: ModelDoc, target: 'part' | string[], value: Assignment | null): string {
  if (!doc.canonical || !doc.model) throw new Error('Materials are set in the modeling format.');
  const statements = doc.materials ?? [];
  if (statements.some((s) => !s.editable)) throw new Error('A material here is computed in code; change it in Source.');
  const current = assignmentsFromDoc(doc) ?? { part: null, bodies: {} };
  const next: Assignments = { part: current.part, bodies: { ...current.bodies } };
  if (target === 'part') { next.part = value; next.bodies = {}; }
  else for (const body of target) {
    if (!value || same(value, next.part)) delete next.bodies[body];
    else next.bodies[body] = value;
  }
  const groups: { value: Assignment; bodies: string[] }[] = [];
  for (const [body, value] of Object.entries(next.bodies)) {
    const group = groups.find((g) => same(g.value, value));
    if (group) group.bodies.push(body); else groups.push({ value, bodies: [body] });
  }
  const variable = doc.model.variable;
  const lines = [...(next.part ? [statement(variable, next.part)] : []), ...groups.map((g) => statement(variable, g.value, g.bodies))];
  const block = lines.map((line) => `${line}\n`).join('');
  if (!statements.length) return block ? insertFeature(code, doc, block) : code;
  let out = code;
  const ordered = [...statements].sort((a, b) => b.span[0] - a.span[0]);
  for (const s of ordered) out = replaceSpan(out, s.span, s === ordered.at(-1) ? block : '');
  return out;
}

/* ───────── Appearances in the code (`model.appearance`: the look only, never a mass) ───────── */

export interface Looks { part: Look | null; bodies: Record<string, Look> }

const LOOK_KEYS = ['color', 'finish', 'opacity', 'roughness', 'metalness'] as const;
const EMPTY_LOOKS: Looks = { part: null, bodies: {} };

/** The fields a look sets (none: null). */
export function cleanLook(look: Look | null | undefined): Look | null {
  if (!look) return null;
  const out: Look = {};
  for (const key of LOOK_KEYS) if (look[key] !== null && look[key] !== undefined) (out as Record<string, unknown>)[key] = look[key];
  return Object.keys(out).length ? out : null;
}

/** What the code says: the part's look, and per-body overrides whatever their order (the runtime's rule). */
export function looksFromDoc(doc: ModelDoc | null): Looks | null {
  if (!doc?.appearances) return null;
  const out: Looks = { part: null, bodies: {} };
  for (const statement of doc.appearances) {
    const look = cleanLook(statement);
    if (!look || statement.faces_span) continue;  // Face looks need the geometry: the build reports them (faceLooks).
    if (statement.bodies) for (const body of statement.bodies) out.bodies[body] = look;
    else if (!statement.bodies_span) out.part = look;
  }
  return out;
}

/** What a build reported (a design's components, servers whose parser predates appearances). */
export function looksFromReport(report: ModelingResult | null | undefined): Looks | null {
  if (!report?.appearances) return null;
  const bodies: Record<string, Look> = {};
  for (const [id, body] of Object.entries(report.bodies)) if (body.appearance) bodies[id] = body.appearance;
  return { part: report.appearances.default, bodies };
}

export const currentLooks = (doc: ModelDoc | null, report: ModelingResult | null | undefined): Looks =>
  looksFromDoc(doc) ?? looksFromReport(report) ?? EMPTY_LOOKS;

export const lookOf = (looks: Looks, body: string | null): Look | null => (body && looks.bodies[body]) || looks.part;

const sameLook = (a: Look | null | undefined, b: Look | null | undefined) =>
  !!a && !!b && LOOK_KEYS.every((key) => (key === 'color' ? (a.color?.toLowerCase() ?? null) === (b.color?.toLowerCase() ?? null) : (a[key] ?? null) === (b[key] ?? null)));

const pyNumber = (value: number) => String(Number(value.toFixed(3)));

function lookStatement(variable: string, value: Look, bodies?: string[], faces?: string[]): string {
  const args: string[] = [];
  if (value.color) args.push(`color=${pyString(value.color.toLowerCase())}`);
  if (value.finish) args.push(`finish=${pyString(value.finish)}`);
  for (const key of ['opacity', 'roughness', 'metalness'] as const) if (typeof value[key] === 'number') args.push(`${key}=${pyNumber(value[key]!)}`);
  if (bodies) args.push(`bodies=[${bodies.map(pyString).join(', ')}]`);
  if (faces) args.push(`faces=[${faces.map(pyString).join(', ')}]`);
  return `${variable}.appearance(${args.join(', ')})`;
}

/**
 * Sets the look of the whole part (clearing body overrides) or of some bodies (null: back to the part's), as
 * `model.appearance(...)` statements, kept like materials' (writeMaterial): one for the part, one per distinct body look.
 * Face looks (`faces=`, writeFaceAppearance) stay as they are.
 */
export function writeAppearance(code: string, doc: ModelDoc, target: 'part' | string[], look: Look | null): string {
  if (!doc.canonical || !doc.model) throw new Error('Appearances are set in the modeling format.');
  const all = doc.appearances ?? [];
  const statements = all.filter((s) => !s.faces_span);
  if (statements.some((s) => !s.editable)) throw new Error('An appearance here is computed in code; change it in Source.');
  const value = cleanLook(look);
  const current = looksFromDoc(doc) ?? { part: null, bodies: {} };
  const next: Looks = { part: current.part, bodies: { ...current.bodies } };
  if (target === 'part') { next.part = value; next.bodies = {}; }
  else for (const body of target) {
    if (!value || sameLook(value, next.part)) delete next.bodies[body];
    else next.bodies[body] = value;
  }
  const groups: { value: Look; bodies: string[] }[] = [];
  for (const [body, item] of Object.entries(next.bodies)) {
    const group = groups.find((g) => sameLook(g.value, item));
    if (group) group.bodies.push(body); else groups.push({ value: item, bodies: [body] });
  }
  const variable = doc.model.variable;
  const lines = [...(next.part ? [lookStatement(variable, next.part)] : []), ...groups.map((g) => lookStatement(variable, g.value, g.bodies))];
  const block = lines.map((line) => `${line}\n`).join('');
  if (!statements.length) {
    if (!block) return code;
    // Before the face looks, if there are some: they read as overrides of what comes first.
    return all.length ? `${code.slice(0, all[0].span[0])}${block}${code.slice(all[0].span[0])}` : insertFeature(code, doc, block);
  }
  let out = code;
  const ordered = [...statements].sort((a, b) => b.span[0] - a.span[0]);
  for (const s of ordered) out = replaceSpan(out, s.span, s === ordered.at(-1) ? block : '');
  return out;
}

/**
 * Sets the look of some faces by their references (null clears it), as `model.appearance(..., faces=[...])`: the refs
 * leave the face statements that list them, then one statement for them is added after the other appearances. A face
 * whose look comes from a reference naming more faces (`"door.side_faces"`, a select(...), a list in a variable) can't
 * be cleared on its own: that's said, to change in Source.
 */
export function writeFaceAppearance(code: string, doc: ModelDoc, refs: string[], look: Look | null): string {
  if (!doc.canonical || !doc.model) throw new Error('Appearances are set in the modeling format.');
  const value = cleanLook(look);
  const wanted = new Set(refs);
  const statements = doc.appearances ?? [];
  const edits: { span: Span; text: string }[] = [];
  let cleared = 0;
  for (const s of statements) {
    if (!s.faces_span || !s.faces || !s.editable) continue;
    const kept = s.faces.filter((ref) => !wanted.has(ref));
    if (kept.length === s.faces.length) continue;
    cleared += s.faces.length - kept.length;
    edits.push(kept.length ? { span: s.faces_span, text: `[${kept.map(pyString).join(', ')}]` } : { span: s.span, text: '' });
  }
  if (!value && !cleared) throw new Error('These faces get their look from a reference that names more faces; change it in Source.');
  let out = code;
  const last = statements.at(-1);
  // Inserted first (it comes after every statement), so the other spans still hold.
  if (value) {
    const statement = `${lookStatement(doc.model.variable, value, undefined, refs)}\n`;
    out = last ? `${out.slice(0, last.span[1])}${statement}${out.slice(last.span[1])}` : insertFeature(out, doc, statement);
  }
  for (const edit of edits.sort((a, b) => b.span[0] - a.span[0])) out = replaceSpan(out, edit.span, edit.text);
  return out;
}

/** Plain CadQuery gets the modeling scaffold first (like any GUI feature); a design's components each take theirs in their own file. */
export function prepareForMaterials(code: string, doc: ModelDoc | null): string {
  return doc?.canonical ? code : ensureModel(code, doc);
}

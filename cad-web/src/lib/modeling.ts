import { api } from './api';
import { parsePlanes, removePlane } from './construction';
import { arithmetic } from './arithmetic';
import type { Units } from './format';
import { lengthCode } from './lengths';
import { formatNumber, pyString } from './pyText';

/**
 * Modeling documents (docs/MODELING.md): the code is the design. The server parses it into
 * parameters, features and sketches with UTF-16 spans; the browser edits by emitting
 * statements and replacing spans, never by parsing Python itself.
 */

export type Span = [number, number];

export interface ArgValue {
  source: string;
  span: Span;
  kind: 'literal' | 'expression' | 'reference' | 'code' | 'sheet_rule' | 'bend_table' | 'gauge_table' | 'sheet_form_tool';
  value?: unknown;
  parameters?: string[];
  error?: string;
}

export interface ModelParameter {
  name: string;
  expression: string;
  value: number;
  unit: string | null;
  description: string;
  span: Span;
  value_span: Span;
  uses: string[];
  literal: boolean;
  line: number;
}

export interface SketchStatement {
  op: string;
  span: Span;
  line: number;
  args?: ArgValue[];
  kwargs?: Record<string, ArgValue>;
  entities?: string[];
  constraints?: string[];
  error?: string;
  source?: string;
}

export interface ModelFeature {
  kind: string;
  id: string | null;
  name: string;
  editable: boolean;
  span: Span;
  /** The call itself (`model.extrude(...)`, a sketch's `model.sketch(...)`). */
  call_span?: Span;
  line: number;
  args?: ArgValue[];
  kwargs?: Record<string, ArgValue>;
  suppressed?: boolean;
  source?: string;
  /* Sketches */
  alias?: string | null;
  body_indent?: string;
  statements?: SketchStatement[];
  document?: { entities: Record<string, unknown>[]; constraints: Record<string, unknown>[] };
  errors?: { line: number; message: string }[];
}

export interface ModelDoc {
  version: 1;
  canonical: boolean;
  parameters: ModelParameter[];
  /** A design component file: shared parameters it can use from params.py. */
  imported?: { name: string; value: number }[];
  features: ModelFeature[];
  model: { variable: string; span: Span; line: number; result_span: Span | null } | null;
  /** `model.body_name("<body>", "<name>")` statements: display names of bodies (not features). */
  body_names?: BodyName[];
  /** `model.material(...)` statements (not features); absent from servers that predate materials. */
  materials?: MaterialStatement[];
  /** `model.appearance(...)` statements: the look apart from the material (no mass); absent from older servers. */
  appearances?: AppearanceStatement[];
  /** Named sheet-metal rules and tables (`rule = SheetMetalRule(...)`, `GaugeTable(...)`, `BendTable(...)`). */
  sheet_rules?: SheetRuleDecl[];
  /** Reusable sheet-metal form tools (`louver = SheetMetalForm("louver", ...)`), placed by `sheet_form`. */
  sheet_forms?: SheetRuleDecl[];
  diagnostics: { severity: 'error' | 'warning'; message: string; line: number }[];
}

export interface SheetRuleDecl {
  variable: string;
  kind: 'sheet_rule' | 'bend_table' | 'gauge_table' | 'sheet_form_tool';
  /** `SheetMetalRule`, `BendTable`, `GaugeTable`, `GaugeTable.rule` (a rule taken from a gauge table) or `SheetMetalForm`. */
  constructor: string;
  args: ArgValue[];
  kwargs: Record<string, ArgValue>;
  editable: boolean;
  span: Span;
  call_span: Span;
  line: number;
}

export interface BodyName { body: string | null; name: string | null; span: Span; name_span: Span | null; line: number }

export interface MaterialStatement {
  material: string | null; bodies: string[] | null; finish: string | null; color: string | null; editable: boolean;
  span: Span; call_span: Span; material_span: Span | null; bodies_span: Span | null; line: number;
}

/** A look: what `model.appearance(...)` sets (each field optional), and what a build reports per body. */
export interface Look { color?: string | null; finish?: string | null; opacity?: number | null; roughness?: number | null; metalness?: number | null }

/** `faces`: the face references (`faces=`) when all literal; `faces_span` is set whenever the call has `faces=`. */
export interface AppearanceStatement extends Look {
  bodies: string[] | null; faces?: string[] | null; editable: boolean; span: Span; call_span: Span; bodies_span: Span | null; faces_span?: Span | null; line: number;
}

/** A body's `model.appearance(faces=...)` looks as a build reports them: face indices in the body's export order. */
export interface FaceLook extends Look { faces: number[] }

/** What a build reports about each feature (runtime `metadata.modeling`). */
export interface FeatureResult { id: string; kind: string; name: string; status: 'ok' | 'error' | 'suppressed'; error?: string; warning?: string; ms: number; body?: string; detail?: Record<string, unknown> }
/** `kind` "surface" (model.fill, model.boundary_surface): no volume or mass, its area instead. */
export interface ModelingResult { version: 1; features: FeatureResult[]; bodies: Record<string, { faces: number; kind?: 'solid' | 'surface'; volume?: number; area_mm2?: number; name?: string | null; index?: number; material?: string | null; finish?: string; color?: string; mass?: number | null; appearance?: Look; face_appearances?: FaceLook[] }>;
  materials?: { default: string | null; mass: number | null; unassigned: string[]; problems: string[] };
  appearances?: { default: Look | null; problems: string[] }; sketches: Record<string, { solver: string; dof: number | null; regions: { name: string; area: number; depth: number }[] }> }

/** A design build's per-component reports (runtime `metadata.modeling.design`). */
export interface DesignResult { name: string; components: Record<string, ModelingResult & { name: string; file: string | null; cache: string }>; instances: { name: string; component: string; at: unknown; link?: boolean }[]; errors: string[] }

/** The modeling report for the code being edited: a part's, or the open file's component in a design. */
export function modelingReport(metadata: unknown, activeFile?: string): ModelingResult | null {
  const modeling = (metadata as { modeling?: ModelingResult & { design?: DesignResult } } | null | undefined)?.modeling;
  if (!modeling) return null;
  if (!modeling.design) return modeling;
  return Object.values(modeling.design.components).find((c) => c.file === activeFile) ?? null;
}

const cache = new Map<string, Promise<ModelDoc>>();

/** Parses modeling code on the server (fast, nothing executes). Cached by exact text. */
/** In a design, the shared parameters file (params.py) of the open document; set by the app. */
let sharedSource: () => string | null = () => null;
export function setSharedParameters(source: () => string | null) { sharedSource = source; }

function request(code: string, imported?: Record<string, number>): Promise<ModelDoc> {
  const key = imported ? `${JSON.stringify(imported)}\u0000${code}` : code;
  let pending = cache.get(key);
  if (!pending) {
    pending = api<ModelDoc>('/v1/modeling/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(imported ? { code, imported } : { code }) });
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return pending;
}

/** The outline of `code`; a design's component file is parsed with the shared parameters it imports. */
export async function parseModel(code: string): Promise<ModelDoc> {
  const shared = sharedSource();
  if (shared === null || shared === code || !/^\s*from\s+params\s+import\b/m.test(code)) return request(code);
  const values = Object.fromEntries((await request(shared)).parameters.map((p) => [p.name, p.value]));
  return request(code, values);
}

/* ───────── Emitting Python ───────── */

/** A value to write: numbers, reference strings, raw expressions, tuples (points) and lists. */
export type Py = number | string | boolean | null | { expr: string } | { tuple: Py[] } | Py[];

export const expr = (source: string): Py => ({ expr: source });
export const tuple = (...items: Py[]): Py => ({ tuple: items });

export { formatNumber, pyString };

export function py(value: Py): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return pyString(value);
  if (Array.isArray(value)) return `[${value.map(py).join(', ')}]`;
  if ('expr' in value) return value.expr;
  return value.tuple.length === 1 ? `(${py(value.tuple[0])},)` : `(${value.tuple.map(py).join(', ')})`;
}

export function call(target: string, method: string, args: Py[], kwargs: Record<string, Py | undefined> = {}): string {
  const parts = args.map(py);
  for (const [key, value] of Object.entries(kwargs)) if (value !== undefined) parts.push(`${key}=${py(value)}`);
  return `${target}.${method}(${parts.join(', ')})`;
}

/** Keeps a parsed argument's source (an expression stays an expression) unless replaced. */
export const keep = (arg: ArgValue | undefined): Py | undefined => (arg ? { expr: arg.source } : undefined);

/* ───────── Editing code ───────── */

export const replaceSpan = (code: string, span: Span, text: string) => code.slice(0, span[0]) + text + code.slice(span[1]);

export const SCAFFOLD = 'import cadquery as cq\nfrom steve import Model\n\nmodel = Model()\n\nresult = model.result()\n';

/**
 * Makes code a modeling document. Empty code gets the scaffold; plain CadQuery keeps running
 * and its result becomes the model's first body, so GUI features can build on it.
 */
export function ensureModel(code: string, doc: ModelDoc | null): string {
  if (doc?.canonical) return code;
  if (!code.trim()) return SCAFFOLD;
  // Only imports, comments and parameters so far: add the model after them.
  let rest = code;
  for (const parameter of [...(doc?.parameters ?? [])].sort((a, b) => b.span[0] - a.span[0])) rest = replaceSpan(rest, parameter.span, '');
  // Datum definitions do not produce a solid called `result`.
  for (const plane of parsePlanes(rest).reverse()) rest = removePlane(rest, plane);
  if (!rest.split('\n').some((line) => line.trim() && !line.trim().startsWith('#') && !/^(import|from)\s/.test(line.trim()))) {
    const header = /^\s*from steve import /m.test(code) ? '' : `${/^\s*import cadquery/m.test(code) ? '' : 'import cadquery as cq\n'}from steve import Model\n\n`;
    return `${header}${code.replace(/\s+$/, '')}\n\nmodel = Model()\n\nresult = model.result()\n`;
  }
  const body = code.replace(/\s+$/, '');
  const importLine = /^\s*from steve import /m.test(body) ? '' : 'from steve import Model\n';
  return `${importLine}${body}\n\nmodel = Model()\nmodel.add("code_1", result, name="Imported code")\n\nresult = model.result()\n`;
}

/** Inserts a feature statement before `result = model.result()` (or after a given feature). */
export function insertFeature(code: string, doc: ModelDoc, text: string, after?: string | null): string {
  const block = text.endsWith('\n') ? text : `${text}\n`;
  if (after) {
    const feature = doc.features.find((item) => item.id === after);
    if (feature) return `${code.slice(0, feature.span[1])}${block}${code.slice(feature.span[1])}`;
  }
  const at = (after === null ? doc.features[0]?.span[0] : undefined) ?? doc.model?.result_span?.[0] ?? code.length;
  const before = code.slice(0, at);
  const spacer = before.endsWith('\n\n') || before.length === 0 ? '' : before.endsWith('\n') ? '' : '\n';
  return `${before}${spacer}${block}\n${code.slice(at).replace(/^\n+/, '')}`;
}

/** Replaces one feature's statement(s) in place. */
export const replaceFeature = (code: string, feature: ModelFeature, text: string) =>
  replaceSpan(code, feature.span, text.endsWith('\n') ? text : `${text}\n`);

export function removeFeature(code: string, feature: ModelFeature): string {
  return replaceSpan(code, feature.span, '');
}

/** A feature's display name: replaces its `name=` or adds one after its last argument. The id never changes. */
export function writeName(code: string, feature: ModelFeature, name: string): string {
  const current = feature.kwargs?.name;
  if (current) return replaceSpan(code, current.span, pyString(name));
  const end = Math.max(-1, ...[...(feature.args ?? []), ...Object.values(feature.kwargs ?? {})].map((arg) => arg.span[1]));
  const at = end >= 0 ? end : feature.call_span && code[feature.call_span[1] - 1] === ')' ? feature.call_span[1] - 1 : -1;
  if (at < 0) throw new Error(`Couldn’t find where to write ${feature.id}’s name.`);
  return `${code.slice(0, at)}, name=${pyString(name)}${code.slice(at)}`;
}

/** A body's display name: its `model.body_name(...)` statement, added next to the others (or before the result). */
export function writeBodyName(code: string, doc: ModelDoc, body: string, name: string): string {
  const names = doc.body_names ?? [];
  const existing = [...names].reverse().find((entry) => entry.body === body && entry.name_span);
  if (existing?.name_span) return replaceSpan(code, existing.name_span, pyString(name));
  const statement = `${doc.model?.variable ?? 'model'}.body_name(${pyString(body)}, ${pyString(name)})\n`;
  const last = names.at(-1);
  return last ? `${code.slice(0, last.span[1])}${statement}${code.slice(last.span[1])}` : insertFeature(code, doc, statement);
}

/** `extrude_3` for the third extrude, skipping ids already used anywhere in the document. */
export function nextId(doc: ModelDoc | null, prefix: string): string {
  const used = new Set((doc?.features ?? []).map((feature) => feature.id).filter(Boolean) as string[]);
  let n = 1;
  for (const id of used) {
    const match = new RegExp(`^${prefix}_(\\d+)$`).exec(id);
    if (match) n = Math.max(n, Number(match[1]) + 1);
  }
  while (used.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

/* ───────── Parameters ───────── */

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['model', 'result', 'cq', 'Model', 'pi', 'tau', 'e', 'sqrt', 'sin', 'cos', 'tan', 'min', 'max', 'abs', 'round']);
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else',
  'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield', 'match', 'case', 'type', '_']);

export function validParameterName(name: string, doc: ModelDoc | null, except?: string): string | true {
  if (!NAME.test(name)) return 'Use letters, digits and underscores, starting with a letter.';
  if (KEYWORDS.has(name)) return `${name} is a Python keyword.`;
  if (RESERVED.has(name)) return `${name} is reserved.`;
  if (doc?.parameters.some((p) => p.name === name && p.name !== except)) return `${name} already exists.`;
  return true;
}

export function setParameter(code: string, parameter: ModelParameter, expression: string): string {
  return replaceSpan(code, parameter.value_span, expression.trim());
}

export function parameterLine(name: string, expression: string, unit?: string | null, description?: string): string {
  const comment = [unit, description].filter(Boolean).join(' ');
  const statement = `${name} = ${expression.trim()}`;
  return comment ? `${statement.padEnd(Math.max(20, statement.length + 2))}# ${comment}` : statement;
}

/** Adds a parameter after the last one (or before `model = Model()`). */
export function addParameter(code: string, doc: ModelDoc, line: string): string {
  const last = doc.parameters.at(-1);
  const at = last ? last.span[1] : doc.model?.span[0] ?? 0;
  const prefix = last ? '' : '# Parameters\n';
  const suffix = last ? '' : '\n';
  return `${code.slice(0, at)}${prefix}${line}\n${suffix}${code.slice(at)}`;
}

export function removeParameter(code: string, parameter: ModelParameter): string {
  return replaceSpan(code, parameter.span, '');
}

/** Renames a parameter everywhere it is used (server-side, scope-aware). Rejects with the reason when it can't. */
export async function renameParameterCode(code: string, old: string, name: string): Promise<string> {
  const result = await api<{ code: string }>('/v1/modeling/rename-parameter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, old, new: name }) });
  return result.code;
}

/**
 * Evaluates arithmetic over the document's parameters (the same subset the server accepts):
 * numbers, names, + - * / // % **, parentheses and math functions. Null when it isn't that.
 */
export function evaluate(expression: string, doc: ModelDoc | null): number | null {
  return arithmetic(expression, named(doc));
}

const named = (doc: ModelDoc | null) => Object.fromEntries([...(doc?.imported ?? []), ...(doc?.parameters ?? [])].map((p) => [p.name, p.value]));

/**
 * A typed length in mm over the document's parameters (lib/lengths.ts): plain arithmetic in `units`, the units the
 * field shows; a unit typed after a number (`1in`, `width + 3cm`) is that number's.
 */
export const evaluateLength = (text: string, units: Units, doc: ModelDoc | null) => evaluate(lengthCode(text, units), doc);

/**
 * A typed length as the code to write, in millimetres: `1in` → `25.4`, `2` in inches → `50.8`, `width + 1in` →
 * `width + (1 * 25.4)`. What doesn't read (or needs no rewriting) is kept as typed.
 */
export function lengthSource(text: string, units: Units, doc: ModelDoc | null): string {
  const code = lengthCode(text, units);
  return code !== text.trim() && evaluate(code, doc) !== null ? code : text.trim();
}

/** Whether a parameter holds a length (its unit is mm, or none is given): units typed into it are converted. */
export const lengthParameter = (unit: string | null | undefined) => !unit || unit === 'mm';

/** Said wherever surface bodies are left out of what's made or analysed (the runtime's SURFACE_NOTE). */
export const surfaceNote = (surfaces: { count: number }) =>
  `${surfaces.count} surface ${surfaces.count === 1 ? 'body is' : 'bodies are'} left out: surface bodies aren’t solids; thicken or solidify them first.`;

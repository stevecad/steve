/**
 * Property forms from tscircuit's own prop schemas: `@tscircuit/props` (zod) → JSON Schema (zod-to-json-schema) →
 * grouped fields. Both libraries load on first use (`loadSchemas()`); conversion is per element and cached.
 */
import { withDerived, type PartSpec } from './catalog';
import { footprintsFor } from './footprints';

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  [key: string]: unknown;
}

export const FIELD_GROUPS = ['General', 'Electrical', 'Footprint and part', 'PCB placement', 'Schematic', 'Advanced'] as const;
export type FieldGroup = (typeof FIELD_GROUPS)[number];

/**
 * How a field is edited:
 * - `unit`: text that takes numbers or unit strings ("10k", "100nF", "5mm"), kept as written;
 * - `code`: anything structured, edited as a JavaScript literal.
 */
export type FieldKind = 'text' | 'unit' | 'number' | 'integer' | 'boolean' | 'enum' | 'code';

export interface Field {
  key: string;
  label: string;
  group: FieldGroup;
  kind: FieldKind;
  required: boolean;
  options?: (string | number | boolean)[];
  /** Display unit (Ω, F, mm, °…) for unit and number fields. */
  unit?: string;
  description?: string;
  /** Values to offer (footprint strings). */
  suggestions?: string[];
  schema: JsonSchema;
}

export interface ElementSchema {
  tag: string;
  json: JsonSchema;
  fields: Field[];
  /** Fields by group, in FIELD_GROUPS order, empty groups left out. */
  groups: { group: FieldGroup; fields: Field[] }[];
}

type Zod = { _def?: { typeName?: string; schema?: Zod; innerType?: Zod; getter?: () => Zod }; shape?: Record<string, unknown> };
type ZodToJson = (schema: unknown, options: Record<string, unknown>) => JsonSchema;

let props: Record<string, unknown> | null = null;
let toJson: ZodToJson | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, ElementSchema | null>();

/** Loads `@tscircuit/props` and zod-to-json-schema (once). */
export function loadSchemas(): Promise<void> {
  if (props) return Promise.resolve();
  loading ??= Promise.all([import('@tscircuit/props'), import('zod-to-json-schema')]).then(([propsModule, converter]) => {
    props = propsModule as unknown as Record<string, unknown>;
    const module = converter as unknown as { zodToJsonSchema?: ZodToJson; default?: ZodToJson | { zodToJsonSchema: ZodToJson } };
    toJson = module.zodToJsonSchema ?? (typeof module.default === 'function' ? module.default : module.default!.zodToJsonSchema);
  });
  return loading;
}

export const schemasReady = () => props !== null;

/** Elements whose props schema has a different name than the tag. */
const SCHEMA_NAME: Record<string, string> = { keepout: 'pcbKeepoutProps', pcbtrace: 'pcbTraceProps' };
/** `*Props` schemas that aren't elements of their own. */
const NOT_ELEMENTS = new Set(['basegroup', 'commoncomponent', 'commonlayout', 'component', 'subcircuitgroup', 'stampboard', 'port', 'board', 'panel', 'subpanel', 'breakout']);

function zodFor(tag: string): Zod | null {
  if (!props) throw new Error('Prop schemas are still loading: await loadSchemas() first.');
  const name = SCHEMA_NAME[tag] ?? Object.keys(props).find((key) => key.endsWith('Props') && key.slice(0, -5).toLowerCase() === tag);
  return name ? (props[name] as Zod) : null;
}

function objectShape(schema: Zod | null): Record<string, unknown> | null {
  let current = schema;
  for (let depth = 0; current && depth < 8; depth++) {
    const type = current._def?.typeName;
    if (type === 'ZodObject') return current.shape ?? null;
    if (type === 'ZodEffects') current = current._def!.schema ?? null;
    else if (type === 'ZodOptional' || type === 'ZodDefault' || type === 'ZodNullable') current = current._def!.innerType ?? null;
    else if (type === 'ZodLazy') current = current._def!.getter!();
    else return null;
  }
  return null;
}

/** Every element tag `@tscircuit/props` describes as a placeable component (its props take a footprint and pcbX). */
function componentTags(): string[] {
  if (!props) throw new Error('Prop schemas are still loading: await loadSchemas() first.');
  const tags: string[] = [];
  for (const key of Object.keys(props)) {
    if (!key.endsWith('Props')) continue;
    const tag = key.slice(0, -5).toLowerCase();
    const shape = objectShape(props[key] as Zod);
    if (!NOT_ELEMENTS.has(tag) && shape && 'footprint' in shape && 'pcbX' in shape) tags.push(tag);
  }
  return tags;
}

/** The palette: the curated parts plus new component elements tscircuit has added. Needs `loadSchemas()`. */
export function allParts(): PartSpec[] {
  return withDerived(Object.fromEntries(componentTags().map((tag) => [tag, { properties: { footprint: {}, pcbX: {} } }])));
}

const UNITS: Record<string, string> = {
  resistance: 'Ω', maxResistance: 'Ω', capacitance: 'F', loadCapacitance: 'F', inductance: 'H', frequency: 'Hz',
  voltage: 'V', maxVoltageRating: 'V', current: 'A', currentRating: 'A', power: 'W',
  pcbRotation: '°', schRotation: '°',
};
const LENGTH = /^(pcb[XY]|sch[XY]|pcb(Left|Right)EdgeX|pcb(Top|Bottom)EdgeY|width|height|thickness|diameter|holeDiameter|outerDiameter|padDiameter|fontSize|radius|pitch|.*Margin.*|.*Spacing.*)$/;

const GENERAL = new Set(['name', 'displayName', 'text', 'net', 'connectsTo', 'from', 'to']);
const PART = new Set(['footprint', 'supplierPartNumbers', 'mpn', 'mfn', 'manufacturerPartNumber', 'cadModel', 'datasheetUrl', 'kicadFootprintMetadata', 'kicadSymbolMetadata', 'standard']);
const PCB_PLACEMENT = new Set(['layer', 'shouldBeOnEdgeOfBoard', 'allowOffBoard', 'doNotPlace']);
const HIDDEN = new Set(['children', 'key']);

let commonKeys: Set<string> | null = null;
function common(): Set<string> {
  commonKeys ??= new Set([...Object.keys(objectShape(props!.commonComponentProps as Zod) ?? {}), ...Object.keys(objectShape(props!.commonLayoutProps as Zod) ?? {})]);
  return commonKeys;
}

function groupOf(key: string, specific: boolean): FieldGroup {
  if (GENERAL.has(key)) return 'General';
  if (PART.has(key)) return 'Footprint and part';
  if (PCB_PLACEMENT.has(key) || (/^pcb/.test(key) && !/Style|Sx$/.test(key))) return 'PCB placement';
  if (/^sch/.test(key) && !/Style$/.test(key) || key === 'symbol' || key === 'symbolName') return 'Schematic';
  return specific ? 'Electrical' : 'Advanced';
}

const label = (key: string) => key.replace(/^pcb(?=[A-Z])/, 'PCB ').replace(/^sch(?=[A-Z])/, 'Schematic ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
  .replace(/\bX\b/, 'X').replace(/\bMpn\b/, 'MPN').replace(/\bMfn\b/, 'Manufacturer').replace(/\bUrl\b/, 'URL');

const typesOf = (schema: JsonSchema): string[] => (Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []);

/** The branches of a union, flattened. */
function branches(schema: JsonSchema): JsonSchema[] {
  if (schema.anyOf) return schema.anyOf.flatMap(branches);
  if (schema.oneOf) return schema.oneOf.flatMap(branches);
  return [schema];
}

function kindOf(key: string, schema: JsonSchema): { kind: FieldKind; options?: (string | number | boolean)[] } {
  if (key === 'footprint') return { kind: 'text' };
  const all = branches(schema).filter((branch) => typesOf(branch).join() !== 'null');
  const enums = all.flatMap((branch) => (branch.enum as (string | number | boolean)[] | undefined) ?? (branch.const !== undefined ? [branch.const as string] : []));
  if (enums.length && all.every((branch) => branch.enum || branch.const !== undefined || typesOf(branch).includes('object'))) return { kind: 'enum', options: [...new Set(enums)] };
  const types = new Set(all.flatMap(typesOf));
  if (schema.allOf) for (const part of schema.allOf) for (const type of typesOf(part)) types.add(type);
  if (types.size === 1 && types.has('boolean')) return { kind: 'boolean' };
  if (types.size === 1 && types.has('integer')) return { kind: 'integer' };
  if (types.size === 1 && types.has('number')) return { kind: 'number' };
  if (types.has('string') && types.has('number') && !types.has('object') && !types.has('array')) return { kind: 'unit' };
  if (types.size === 1 && types.has('string')) return { kind: 'text' };
  return { kind: 'code' };
}

/** A union of objects (holes by shape, groups by layout) as one object: every branch's properties. */
function merged(json: JsonSchema): JsonSchema {
  if (json.properties) return json;
  const parts = [...(json.anyOf ?? []), ...(json.oneOf ?? []), ...(json.allOf ?? [])].map(merged);
  const properties: Record<string, JsonSchema> = {};
  let required: string[] | null = null;
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.properties ?? {})) {
      const existing = properties[key];
      if (!existing) properties[key] = value;
      else if (existing.const !== undefined || value.const !== undefined || existing.enum || value.enum) {
        // A discriminator (shape: "circle" | "rect" …): offer every branch's value.
        properties[key] = { enum: [...new Set([...(existing.enum ?? [existing.const]), ...(value.enum ?? [value.const])])] };
      }
    }
    required = required === null ? [...(part.required ?? [])] : required.filter((key) => part.required?.includes(key));
  }
  return { type: 'object', properties, required: required ?? [] };
}

/** The form for an element (null for an element tscircuit has no props schema for). Needs `loadSchemas()`. */
export function schemaFor(tag: string): ElementSchema | null {
  if (cache.has(tag)) return cache.get(tag)!;
  const zod = zodFor(tag);
  if (!zod || !toJson) { cache.set(tag, null); return null; }
  const json = merged(toJson(zod, { effectStrategy: 'input', $refStrategy: 'none', errorMessages: false }));
  const required = new Set(json.required ?? []);
  const shared = common();
  const fields: Field[] = [];
  for (const [key, property] of Object.entries(json.properties ?? {})) {
    if (HIDDEN.has(key)) continue;
    const { kind, options } = kindOf(key, property);
    const unit = UNITS[key] ?? (LENGTH.test(key) && (kind === 'unit' || kind === 'number') ? 'mm' : undefined);
    const suggestions = key === 'footprint' ? footprintsFor(tag) : undefined;
    fields.push({
      key, label: label(key), group: groupOf(key, !shared.has(key)), kind, required: required.has(key), options, unit,
      description: typeof property.description === 'string' ? property.description : undefined, suggestions, schema: property,
    });
  }
  const order = (field: Field) => (field.key === 'name' ? -2 : field.required ? -1 : 0);
  fields.sort((a, b) => order(a) - order(b));
  const groups = FIELD_GROUPS.map((group) => ({ group, fields: fields.filter((field) => field.group === group) })).filter((entry) => entry.fields.length);
  const schema: ElementSchema = { tag, json, fields, groups };
  cache.set(tag, schema);
  return schema;
}

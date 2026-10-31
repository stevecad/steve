/**
 * The manufacturing library's JSON schemas, read from the live OpenAPI document: forms are generated from
 * them (fields, types, limits, enums, required), so the UI never hard-codes what the backend defines.
 */
import type { Kind } from './api';

export interface Schema {
  $ref?: string; type?: string | string[]; title?: string; description?: string; default?: unknown; const?: unknown;
  enum?: unknown[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; prefixItems?: Schema[];
  anyOf?: Schema[]; oneOf?: Schema[]; discriminator?: { propertyName: string; mapping?: Record<string, string> };
  additionalProperties?: boolean | Schema; patternProperties?: Record<string, Schema>; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; exclusiveMaximum?: number; ge?: number; gt?: number; le?: number; lt?: number;
  minLength?: number; maxLength?: number; pattern?: string; format?: string;
}

interface OpenApi { components: { schemas: Record<string, Schema> } }

let loading: Promise<OpenApi> | null = null;
export function openApi(): Promise<OpenApi> {
  loading ??= fetch('/openapi.json').then((response) => {
    if (!response.ok) throw new Error('The API description could not be loaded.');
    return response.json() as Promise<OpenApi>;
  }).catch((error) => { loading = null; throw error; });
  return loading;
}

export function resolve(api: OpenApi, schema: Schema | undefined): Schema {
  let current = schema ?? {};
  for (let depth = 0; current.$ref && depth < 20; depth++) current = api.components.schemas[current.$ref.split('/').pop()!] ?? {};
  return current;
}

/** The definition schema for one library kind (from the create endpoint's discriminated union). */
export function definitionSchema(api: OpenApi, kind: Kind): Schema | null {
  const create = api.components.schemas.CreateRecord;
  const ref = create?.properties?.definition?.discriminator?.mapping?.[kind];
  return ref ? resolve(api, { $ref: ref }) : null;
}

/** A nullable `anyOf: [X, null]` field's non-null branch, and whether null is allowed. */
export function unwrapNullable(api: OpenApi, schema: Schema): { schema: Schema; nullable: boolean } {
  const options = schema.anyOf ?? schema.oneOf;
  if (options && !schema.discriminator) {
    const real = options.filter((option) => option.type !== 'null');
    if (real.length === 1) return { schema: { ...resolve(api, real[0]), title: schema.title ?? real[0].title, default: schema.default }, nullable: real.length < options.length };
  }
  return { schema: resolve(api, schema), nullable: false };
}

export const typeOf = (schema: Schema): string | undefined => {
  if (schema.const !== undefined) return 'const';
  if (schema.enum) return 'enum';
  if (Array.isArray(schema.type)) return schema.type.find((type) => type !== 'null');
  if (schema.type) return schema.type;
  if (schema.properties) return 'object';
  return undefined;
};

/** Field units come from the backend's naming convention (`_mm`, `_mm_s`, `_c`, …). */
const UNITS: [RegExp, string][] = [
  [/_mm3_min$/, 'mm³/min'], [/_m_min$/, 'm/min'], [/_mm_min$/, 'mm/min'], [/_mm_s$/, 'mm/s'], [/_mm3$/, 'mm³'], [/_mm2$/, 'mm²'], [/_mm$/, 'mm'], [/_g_cm3$/, 'g/cm³'],
  [/_c$/, '°C'], [/_deg$/, '°'], [/_rad$/, 'rad'], [/_rpm$/, 'rpm'], [/_per_minute$/, '/min'], [/_per_second2$/, '/s²'],
  [/_s$/, 's'], [/_kg$/, 'kg'], [/_g$/, 'g'], [/_kw$/, 'kW'], [/_nm$/, 'N·m'], [/_n$/, 'N'], [/_w$/, 'W'],
];
export function unitOf(name: string): string {
  return UNITS.find(([pattern]) => pattern.test(name))?.[1] ?? '';
}
const ACRONYMS: Record<string, string> = { fff: 'FFF', id: 'ID', rpm: 'RPM', wcs: 'WCS', bt30: 'BT30', xyz: 'XYZ', nc: 'NC', url: 'URL' };
const UNIT_TOKENS = 'mm3_min|m_min|mm_min|mm_s|mm3|mm2|mm|g_cm3|c|deg|rad|rpm|per_minute|per_second2|s|kg|g|kw|nm|n|w';
const UNIT_SUFFIX = new RegExp(`_(${UNIT_TOKENS})$`);
// Values only match multi-letter units, so a one-letter enum value ("c", "s") is still a word.
const UNIT_VALUE = new RegExp(`^(${UNIT_TOKENS.split('|').filter((unit) => unit.length > 1).join('|')}|in|inch)$`);

/** Field names whose words alone read wrong once the unit is dropped ("Maximum spindle rpm" → "Maximum spindle"). */
const LABELS: Record<string, string> = {
  maximum_spindle_rpm: 'Maximum spindle speed', maximum_nominal_surface_speed_m_min: 'Maximum surface speed', maximum_stickout_mm: 'Maximum stick-out',
  design_material_id: 'Design material', max_rpm: 'Max speed',
};

export function labelOf(name: string): string {
  if (LABELS[name]) return LABELS[name];
  const base = name.replace(UNIT_SUFFIX, '');
  const words = base.split('_').filter(Boolean).map((word) => ACRONYMS[word] ?? word);
  const text = words.join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : name;
}

/** An enum value as shown: like a field name, except a unit stays as written ("mm", not "Mm"). */
export const valueLabel = (value: string) => (UNIT_VALUE.test(value) ? value : labelOf(value));

/** Numeric limits in either JSON-schema or pydantic spelling. */
export function limitsOf(schema: Schema): { min?: number; max?: number; exclusiveMin?: boolean; integer: boolean } {
  const min = schema.minimum ?? schema.ge ?? schema.exclusiveMinimum ?? schema.gt;
  const max = schema.maximum ?? schema.le ?? schema.exclusiveMaximum ?? schema.lt;
  return { min, max, exclusiveMin: schema.exclusiveMinimum !== undefined || schema.gt !== undefined, integer: typeOf(schema) === 'integer' };
}

/** A minimal valid-looking value for a schema: defaults, consts, required fields only. */
export function defaultFor(api: OpenApi, raw: Schema, depth = 0): unknown {
  const { schema, nullable } = unwrapNullable(api, raw);
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (raw.default !== undefined) return structuredClone(raw.default);
  if (schema.const !== undefined) return schema.const;
  if (nullable) return null;
  if (depth > 8) return null;
  if (schema.oneOf && schema.discriminator?.mapping) {
    const [first] = Object.values(schema.discriminator.mapping);
    return defaultFor(api, { $ref: first }, depth + 1);
  }
  switch (typeOf(schema)) {
    case 'enum': return schema.enum?.[0];
    case 'boolean': return false;
    case 'integer':
    case 'number': {
      const { min, exclusiveMin } = limitsOf(schema);
      if (min === undefined) return 0;
      return exclusiveMin ? min + 1 : min;
    }
    case 'string': return '';
    case 'array':
      if (schema.prefixItems) return schema.prefixItems.map((item) => defaultFor(api, item, depth + 1));
      return Array.from({ length: schema.minItems ?? 0 }, () => defaultFor(api, schema.items ?? {}, depth + 1));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        const resolved = unwrapNullable(api, property).schema;
        if (schema.required?.includes(key) || resolved.const !== undefined || property.default !== undefined) out[key] = defaultFor(api, property, depth + 1);
      }
      return out;
    }
    default: return null;
  }
}

/**
 * Which library kinds a pin-valued field can refer to, from its name and the kind of record holding it (pins don't
 * carry the target kind in the schema). Empty: any record.
 */
export function pinKindsFor(field: string, within?: Kind | null): Kind[] {
  // Lathe records (docs/MANUFACTURING_TURNING_TOOLS.md, MANUFACTURING_TURNING_ASSIGNMENTS.md): an insert in a turning
  // holder; a lathe tool setup loads turning tools, or a stationary drill (a milling tool assembly).
  if (within?.startsWith('turning_')) {
    const turning: Record<string, Kind[]> = {
      insert: ['turning_insert'], holder: ['turning_holder'], assembly: ['turning_assembly', 'tool_assembly'],
      setup: ['turning_tool_setup'], tooling: ['turning_tool_setup'],
    };
    if (turning[field]) return turning[field];
  }
  const kind = pinKindFor(field);
  return kind ? [kind] : [];
}

/** Which library kind a pin-valued field refers to, from its name alone (milling and machine records). */
export function pinKindFor(field: string): Kind | null {
  const map: Record<string, Kind> = {
    model: 'machine_model', controller: 'controller', machine: 'machine_instance', instance: 'machine_instance',
    cutter: 'rotary_cutter', holder: 'tool_holder', assembly: 'tool_assembly', setup: 'tool_setup', tooling: 'tool_setup',
    profile: 'fff_profile', post: 'post_processor', material: 'machining_material', preset: 'cutting_preset', cutting_preset: 'cutting_preset',
    machining_material: 'machining_material',
  };
  return map[field] ?? null;
}

export const isPinSchema = (schema: Schema) => !!schema.properties && ['id', 'revision', 'kind', 'sha256'].every((key) => key in schema.properties!);

export type { OpenApi };

/** 3D printing is backend-only for now (docs/MANUFACTURING_STATUS.md): the UI offers no FFF choices or printer sections. */
const BACKEND_ONLY_VALUES = new Set<unknown>(['fff']);
const BACKEND_ONLY_FIELDS = new Set(['printer']);
/** The choices a form offers (a value already saved stays visible so it can be read and changed). */
export const shownOptions = <T,>(options: T[], current?: unknown): T[] => options.filter((option) => !BACKEND_ONLY_VALUES.has(option) || option === current);
export const shownField = (name: string, value: unknown) => !BACKEND_ONLY_FIELDS.has(name) || (value !== undefined && value !== null);

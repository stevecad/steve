/**
 * The library table's columns, per kind: what a CAM programmer compares at a glance (Fusion's tool and machine
 * libraries). Every cell is read from the record's own definition, or from the records it pins; a value the record
 * doesn't have stays blank, and a column no listed record fills is left out. Labels and units come from the
 * backend's field names, like the forms.
 */
import type { Kind, LibraryRecord } from './api';
import { definitionSchema, labelOf, shownOptions, unitOf, unwrapNullable, type OpenApi } from './schema';
import { KIND_LABELS } from './kinds';

export interface Lookup {
  byId: Map<string, LibraryRecord>;
  /** Tool numbers each tool assembly is loaded as, across the (unarchived) tool setups. */
  toolNumbers: Map<string, number[]>;
  /** Unarchived cutting presets per cutter and per machining material (by record ID). */
  presets: Map<string, number>;
}

export function lookupOf(records: LibraryRecord[]): Lookup {
  const byId = new Map(records.map((record) => [record.id, record]));
  const presets = new Map<string, number>();
  for (const preset of records) {
    if (preset.kind !== 'cutting_preset' || preset.archived) continue;
    for (const id of [pinId(preset.definition.cutter), pinId(preset.definition.material)]) if (id) presets.set(id, (presets.get(id) ?? 0) + 1);
  }
  const toolNumbers = new Map<string, number[]>();
  for (const setup of records) {
    if (setup.kind !== 'tool_setup' || setup.archived) continue;
    for (const assignment of list<{ assembly?: { id?: string }; tool_number?: number }>(setup.definition.assignments)) {
      const id = assignment.assembly?.id;
      if (!id || typeof assignment.tool_number !== 'number') continue;
      const numbers = toolNumbers.get(id) ?? [];
      if (!numbers.includes(assignment.tool_number)) numbers.push(assignment.tool_number);
      toolNumbers.set(id, numbers.sort((a, b) => a - b));
    }
  }
  return { byId, toolNumbers, presets };
}

type Value = string | number | null;
export interface Column {
  id: string;
  label: string;
  unit?: string;
  /** Sort and filter value; null when the record doesn't have it. */
  value: (record: LibraryRecord, lookup: Lookup) => Value;
  /** What the cell shows, when it isn't the formatted value. */
  text?: (record: LibraryRecord, lookup: Lookup) => string | null;
  /** Identifiers (dialects, capabilities) shown as code. */
  code?: boolean;
  /** 0: always shown; higher numbers give way first in a narrow table. */
  priority: number;
  /** Filter chips from the field's enum (in the schema's order). */
  chips?: string;
  /** A min–max filter. */
  range?: boolean;
}

const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const pinId = (value: unknown) => (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : null);
const pinned = (value: unknown, lookup: Lookup) => { const id = pinId(value); return id ? lookup.byId.get(id) ?? null : null; };

/** Enum values and interface codes as people write them: `flat_end_mill` → Flat end mill, `cat40` → CAT40. */
export function prettyValue(value: string): string {
  if (/^[a-z]{1,4}\d+[a-z]?$/i.test(value)) return value.toUpperCase();
  const text = value.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: Math.abs(value) >= 100 ? 1 : 3 });
}

export function cellText(column: Column, record: LibraryRecord, lookup: Lookup): string {
  if (column.text) return column.text(record, lookup) ?? '';
  const value = column.value(record, lookup);
  if (value === null) return '';
  return typeof value === 'number' ? formatNumber(value) : value;
}

/** A definition field: its label and unit from the name, enum values made readable. */
function field(name: string, priority: number, options: Partial<Pick<Column, 'label' | 'code' | 'chips' | 'range'>> = {}): Column {
  const degrees = name.endsWith('_rad');
  return {
    id: name, priority, label: options.label ?? labelOf(name), unit: degrees ? '°' : unitOf(name) || undefined, code: options.code, chips: options.chips, range: options.range,
    value: (record) => {
      const raw = record.definition[name];
      if (typeof raw === 'number') return degrees ? (raw * 180) / Math.PI : num(raw);
      if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
      if (Array.isArray(raw)) return raw.length ? raw.map((item) => (options.code ? String(item) : prettyValue(String(item)))).join(', ') : null;
      const text = str(raw);
      return text === null ? null : options.code ? text : prettyValue(text);
    },
  };
}

const derived = (id: string, label: string, priority: number, value: Column['value'], extra: Partial<Column> = {}): Column => ({ id, label, priority, value, ...extra });

const geometry = derived('geometry', 'Geometry', 3, (record) => (record.definition.geometry_source ? 'From part' : 'Parametric'));
const vendor = field('manufacturer', 3, { label: 'Vendor' });
const product = field('product_code', 3, { label: 'Product ID' });

/** A machine model's linear travel along X, Y or Z: its node of that name, else the node moving along that axis. */
function travel(model: LibraryRecord | null, axis: 'X' | 'Y' | 'Z'): number | null {
  if (!model) return null;
  const index = { X: 0, Y: 1, Z: 2 }[axis];
  const nodes = list<{ id: string; kind: string; axis?: number[] | null; limits?: { unit: string; minimum: number; maximum: number } | null }>(model.definition.nodes)
    .filter((node) => node.kind === 'linear' && node.limits?.unit === 'mm');
  const node = nodes.find((item) => item.id.toUpperCase() === axis)
    ?? nodes.find((item) => item.axis && Math.abs(item.axis[index]) > 0.99);
  return node?.limits ? node.limits.maximum - node.limits.minimum : null;
}
const spindles = (model: LibraryRecord | null) => list<{ interface?: string; max_rpm?: number; max_power_kw?: number }>(model?.definition.spindles);
const maxOf = (values: (number | null | undefined)[]) => { const real = values.filter((value): value is number => typeof value === 'number'); return real.length ? Math.max(...real) : null; };
const spindleInterface = (model: LibraryRecord) => str(spindles(model)[0]?.interface)
  ?? str(list<{ role?: string; interface?: string | null }>(model.definition.attachments).find((item) => item.role === 'tool')?.interface);
const travelText = (model: LibraryRecord | null) => {
  const values = (['X', 'Y', 'Z'] as const).map((axis) => travel(model, axis));
  return values.every((value) => value === null) ? null : values.map((value) => (value === null ? '–' : formatNumber(value))).join(' × ');
};
const names = (records: (LibraryRecord | null)[]) => { const out = records.filter((record): record is LibraryRecord => !!record).map((record) => record.definition.name); return out.length ? out.join(' › ') : null; };

const PRESETS = derived('presets', 'Presets', 3, (record, lookup) => lookup.presets.get(record.id) ?? null);

const TRAVELS = (['X', 'Y', 'Z'] as const).map((axis) => derived(`travel_${axis}`, `${axis} travel`, axis === 'Z' ? 2 : 1, (record) => travel(record, axis), { unit: 'mm' }));

const COLUMNS: Partial<Record<Kind, Column[]>> = {
  rotary_cutter: [
    field('cutter_type', 1, { label: 'Type', chips: 'cutter_type' }), field('diameter_mm', 0, { label: 'Ø', range: true }), field('flute_count', 1, { label: 'Flutes' }),
    field('cutting_length_mm', 1, { label: 'Flute length' }), field('overall_length_mm', 2, { label: 'Overall length' }), field('shank_diameter_mm', 2, { label: 'Shank Ø' }),
    field('corner_radius_mm', 2, { label: 'Corner R' }), field('included_angle_rad', 3, { label: 'Angle' }), field('material', 3), field('body_material', 4, { label: 'Body material' }), field('coating', 4),
    // An indexable cutter's inserts: designation as entered, with their lead angle.
    derived('inserts', 'Inserts', 3, (record) => str((record.definition.inserts as { designation?: unknown } | null | undefined)?.designation), {
      text: (record) => { const inserts = record.definition.inserts as { designation?: unknown; lead_angle_deg?: unknown } | null | undefined; const name = str(inserts?.designation); const lead = num(inserts?.lead_angle_deg); return name ? (lead === null ? name : `${name}, ${formatNumber(lead)}°`) : null; },
    }),
    vendor, product, field('max_rpm', 4, { label: 'Max speed' }), geometry, PRESETS,
  ],
  tool_holder: [
    field('component_type', 1, { label: 'Type', chips: 'component_type' }), field('input_interface', 1, { label: 'Input' }), field('output_interface', 2, { label: 'Output' }),
    derived('clamp', 'Clamp Ø', 1, (record) => num((record.definition.clamp as { max_diameter_mm?: number } | null)?.max_diameter_mm), {
      unit: 'mm', text: (record) => { const clamp = record.definition.clamp as { min_diameter_mm?: number; max_diameter_mm?: number } | null; return clamp && num(clamp.max_diameter_mm) !== null ? `${formatNumber(clamp.min_diameter_mm ?? 0)}–${formatNumber(clamp.max_diameter_mm!)}` : null; },
    }),
    derived('engagement', 'Engagement', 2, (record) => num((record.definition.clamp as { max_engagement_mm?: number } | null)?.max_engagement_mm), {
      unit: 'mm', text: (record) => { const clamp = record.definition.clamp as { min_engagement_mm?: number; max_engagement_mm?: number } | null; return clamp && num(clamp.max_engagement_mm) !== null ? `${formatNumber(clamp.min_engagement_mm ?? 0)}–${formatNumber(clamp.max_engagement_mm!)}` : null; },
    }),
    vendor, product, field('max_rpm', 3, { label: 'Max speed' }), geometry,
  ],
  tool_assembly: [
    derived('tool_number', 'Tool', 1, (record, lookup) => lookup.toolNumbers.get(record.id)?.[0] ?? null, { text: (record, lookup) => lookup.toolNumbers.get(record.id)?.map((n) => `T${n}`).join(', ') ?? null }),
    derived('cutter', 'Cutter', 1, (record, lookup) => pinned(record.definition.cutter, lookup)?.definition.name ?? null),
    derived('cutter_diameter', 'Ø', 0, (record, lookup) => num(pinned(record.definition.cutter, lookup)?.definition.diameter_mm), { unit: 'mm' }),
    derived('cutter_type', 'Type', 3, (record, lookup) => { const type = str(pinned(record.definition.cutter, lookup)?.definition.cutter_type); return type ? prettyValue(type) : null; }),
    derived('holder', 'Holder', 1, (record, lookup) => names(list<{ holder?: unknown }>(record.definition.holders).map((use) => pinned(use.holder, lookup)))),
    derived('interface', 'Interface', 2, (record, lookup) => { const first = pinned(list<{ holder?: unknown }>(record.definition.holders)[0]?.holder, lookup); const code = str(first?.definition.input_interface); return code ? prettyValue(code) : null; }),
    field('stickout_mm', 1, { label: 'Stick-out' }), field('dimension_source', 3, { label: 'Dimensions' }),
  ],
  tool_setup: [
    derived('machine', 'Machine', 1, (record, lookup) => pinned(record.definition.machine, lookup)?.definition.name ?? null),
    derived('tools', 'Tools', 1, (record) => list(record.definition.assignments).length || null),
    derived('numbers', 'Numbers', 2, (record) => { const numbers = list<{ tool_number?: number }>(record.definition.assignments).map((item) => item.tool_number).filter((n): n is number => typeof n === 'number'); return numbers.length ? numbers.map((n) => `T${n}`).join(' ') : null; }),
    derived('assemblies', 'Assemblies', 3, (record, lookup) => { const out = list<{ assembly?: unknown }>(record.definition.assignments).map((item) => pinned(item.assembly, lookup)?.definition.name).filter(Boolean); return out.length ? out.join(', ') : null; }),
  ],
  machine_model: [
    field('machine_type', 1, { label: 'Type', chips: 'machine_type' }), ...TRAVELS,
    derived('rotary', 'Rotary axes', 3, (record) => { const ids = list<{ id: string; kind: string }>(record.definition.nodes).filter((node) => node.kind !== 'fixed' && node.kind !== 'linear').map((node) => node.id); return ids.length ? ids.join(', ') : null; }),
    derived('max_rpm', 'Max speed', 1, (record) => maxOf(spindles(record).map((spindle) => spindle.max_rpm)), { unit: 'rpm' }),
    derived('spindle', 'Spindle', 2, (record) => { const code = spindleInterface(record); return code ? prettyValue(code) : null; }),
    derived('power', 'Power', 3, (record) => maxOf(spindles(record).map((spindle) => spindle.max_power_kw)), { unit: 'kW' }),
    derived('tool_change', 'Tool changer', 2, (record) => list((record.definition.tool_change as { stations?: unknown } | null)?.stations).length || null, {
      text: (record) => { const change = record.definition.tool_change as { mode?: string; stations?: unknown } | null; if (!change) return null; const count = list(change.stations).length; return [str(change.mode) ? prettyValue(change.mode!) : null, count ? `${count}` : null].filter(Boolean).join(' · ') || null; },
    }),
    field('processes', 3),
  ],
  machine_instance: [
    derived('model', 'Model', 1, (record, lookup) => pinned(record.definition.model, lookup)?.definition.name ?? null),
    derived('controller', 'Controller', 1, (record, lookup) => pinned(record.definition.controller, lookup)?.definition.name ?? null),
    derived('travel', 'Travel X × Y × Z', 2, (record, lookup) => travelText(pinned(record.definition.model, lookup)), { unit: 'mm' }),
    field('serial_number', 3, { label: 'Serial' }),
  ],
  controller: [
    field('dialect', 1, { code: true }), field('output_units', 2, { label: 'Units' }), field('processes', 2),
    field('tool_length_compensation', 3, { label: 'Length offsets' }), field('cutter_compensation', 4, { label: 'Radius offsets' }),
    derived('work_offsets', 'Work offsets', 3, (record) => list(record.definition.work_offsets).length || null),
    field('firmware_version', 4, { label: 'Firmware' }),
  ],
  post_processor: [
    field('controller_dialects', 1, { label: 'Dialects', code: true }), field('processes', 2), field('capabilities', 3, { code: true }), field('license', 4),
  ],
  machining_material: [
    field('condition', 1), field('design_material_id', 2, { label: 'Design material', code: true }), PRESETS,
  ],
  // A preset's limits (docs/MANUFACTURING_CUTTING_PRESETS.md): what the cutter may run at in the material.
  cutting_preset: [
    derived('cutter', 'Cutter', 1, (record, lookup) => pinned(record.definition.cutter, lookup)?.definition.name ?? null),
    derived('cutter_diameter', 'Ø', 0, (record, lookup) => num(pinned(record.definition.cutter, lookup)?.definition.diameter_mm), { unit: 'mm' }),
    derived('material', 'Material', 1, (record, lookup) => {
      const material = pinned(record.definition.material, lookup);
      return material ? [material.definition.name, str(material.definition.condition)].filter(Boolean).join(' · ') : null;
    }),
    field('maximum_spindle_rpm', 1, { label: 'Max speed' }), field('maximum_nominal_surface_speed_m_min', 2, { label: 'Surface speed' }),
    field('maximum_feed_per_tooth_mm', 1, { label: 'Feed/tooth' }), field('maximum_feed_per_revolution_mm', 3, { label: 'Feed/rev' }),
    field('maximum_material_removal_rate_mm3_min', 3, { label: 'Removal rate' }), field('maximum_stickout_mm', 2, { label: 'Max stick-out' }),
    field('operations', 2),
  ],
};

export const NAME: Column = { id: 'name', label: 'Name', priority: 0, value: (record) => record.definition.name };
const KIND: Column = { id: 'kind', label: 'Kind', priority: 1, value: (record) => KIND_LABELS[record.kind]?.one ?? record.kind };
const REVISION: Column = { id: 'revision', label: 'Rev', priority: 2, value: (record) => record.revision };
const UPDATED: Column = {
  id: 'updated', label: 'Updated', priority: 3, value: (record) => record.created_at,
  text: (record) => new Date(record.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
};

/** The table's columns for a kind ("all": name, kind, revision, updated). */
export function columnsFor(kind: Kind | 'all'): Column[] {
  if (kind === 'all') return [NAME, KIND, REVISION, UPDATED];
  return [NAME, ...(COLUMNS[kind] ?? []), REVISION, UPDATED];
}

/** The kind's own columns (no name, revision or date): a record's key facts. */
export const factColumns = (kind: Kind): Column[] => COLUMNS[kind] ?? [];

/** A chip column's choices, in the schema's enum order. */
export function enumOf(api: OpenApi | null, kind: Kind | 'all', name: string): string[] {
  if (!api || kind === 'all') return [];
  const property = definitionSchema(api, kind)?.properties?.[name];
  if (!property) return [];
  const values = unwrapNullable(api, property).schema.enum;
  return Array.isArray(values) ? shownOptions(values.map(String)) : [];
}

/**
 * Reading a CSV for the import's column mapping: its header and a few sample rows, and a first guess at what each
 * column is (the server parses and converts the actual content; nothing here changes a value).
 *
 * Guesses: a STEVE export's columns are field names with JSON cells (plus `@provenance` and `@archived`); a vendor
 * sheet's headers are matched to fields by name or label, with units read from the header ("Diameter (in)").
 */
import type { Kind } from '../api';
import { labelOf, typeOf, unitOf, unwrapNullable, type OpenApi, type Schema } from '../schema';
import type { Blank, CsvColumn, Encoding, SourceUnits } from './api';

export type Delimiter = ',' | ';' | '\t';

/** Columns only a STEVE export has: the record kind and format version, its sources and archive state. */
export const STEVE_COLUMNS = ['kind', 'version', '@provenance', '@archived'];

/** RFC 4180 fields: quoted fields may hold the delimiter, doubled quotes and line breaks. */
export function parseCsv(text: string, delimiter: Delimiter, limit = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, at = 0;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (at < body.length && rows.length < limit) {
    const char = body[at];
    if (quoted) {
      if (char === '"' && body[at + 1] === '"') { field += '"'; at += 2; continue; }
      if (char === '"') { quoted = false; at += 1; continue; }
      field += char; at += 1; continue;
    }
    if (char === '"' && field === '') { quoted = true; at += 1; continue; }
    if (char === delimiter) { row.push(field); field = ''; at += 1; continue; }
    if (char === '\r' || char === '\n') {
      row.push(field); field = '';
      if (row.some((cell) => cell !== '') || row.length > 1) rows.push(row);
      row = [];
      at += char === '\r' && body[at + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += char; at += 1;
  }
  if ((field !== '' || row.length) && rows.length < limit) { row.push(field); rows.push(row); }
  return rows;
}

/** The delimiter that splits the header line into the most columns. */
export function guessDelimiter(text: string): Delimiter {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (delimiter: Delimiter) => parseCsv(header, delimiter, 1)[0]?.length ?? 0;
  return ([',', ';', '\t'] as Delimiter[]).reduce((best, delimiter) => (count(delimiter) > count(best) ? delimiter : best), ',');
}

/** The unit choices for a destination field, from its name's unit suffix (the server checks they agree). */
export function unitChoices(field: string): SourceUnits[] {
  const name = field.split('.').pop() ?? field;
  if (/_mm3_min$/.test(name)) return ['native', 'mm3/min', 'inch3/min'];
  if (/_m_min$/.test(name)) return ['native', 'm/min', 'ft/min'];
  if (/_mm_min$/.test(name)) return ['native', 'mm/min', 'inch/min'];
  if (/_mm$/.test(name)) return ['native', 'mm', 'inch'];
  if (/_rad$/.test(name)) return ['native', 'radian', 'degree'];
  if (/_kg$/.test(name)) return ['native', 'kg', 'g', 'lb'];
  if (/_rpm$/.test(name)) return ['native', 'rpm'];
  return ['native'];
}

/** A unit written in a header: "Diameter (in)", "Speed [SFM]", "Length mm". */
const HEADER_UNITS: [RegExp, SourceUnits][] = [
  [/\b(in3\/min|inch3\/min|cu\.? ?in\/min)\b/i, 'inch3/min'], [/\b(mm3\/min|mm³\/min)/i, 'mm3/min'],
  [/\b(ipm|in\/min|inch\/min|inches\/min)\b/i, 'inch/min'], [/\bmm\/min\b/i, 'mm/min'],
  [/\b(sfm|ft\/min|sfpm)\b/i, 'ft/min'], [/\bm\/min\b/i, 'm/min'], [/\brpm\b/i, 'rpm'],
  [/(\bdeg\b|\bdegrees?\b|°)/i, 'degree'], [/\brad(ians?)?\b/i, 'radian'],
  [/[([]\s*in\s*[)\]]|\binch(es)?\b|"/i, 'inch'], [/\bmm\b/i, 'mm'], [/\b(lb|lbs)\b/i, 'lb'], [/\bkg\b/i, 'kg'], [/\bg\b/i, 'g'],
];
const norm = (text: string) => text.toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
/** What vendor sheets commonly call a field (normalized header → field). A guess the person reviews. */
const ALIASES: Record<string, string> = {
  dia: 'diameter_mm', diameter: 'diameter_mm', cuttingdiameter: 'diameter_mm', flutes: 'flute_count', numberofflutes: 'flute_count', teeth: 'flute_count',
  flutelength: 'cutting_length_mm', loc: 'cutting_length_mm', lengthofcut: 'cutting_length_mm', oal: 'overall_length_mm', length: 'overall_length_mm',
  shank: 'shank_diameter_mm', shankdia: 'shank_diameter_mm', cornerradius: 'corner_radius_mm', radius: 'corner_radius_mm', type: 'cutter_type',
  vendor: 'manufacturer', brand: 'manufacturer', partnumber: 'product_code', edp: 'product_code', sku: 'product_code', maxrpm: 'max_rpm',
};

/** The units a header names, when the field takes them; else the field's own unit (or "as saved"). */
export function headerUnits(header: string, field: string): SourceUnits {
  const choices = unitChoices(field);
  const written = HEADER_UNITS.find(([pattern]) => pattern.test(header))?.[1];
  return written && choices.includes(written) ? written : choices[1] ?? 'native';
}

export interface FieldOption { path: string; label: string; schema: Schema; required: boolean }

/** The fields a column can fill: the kind's top-level fields and those of its plain nested objects (one level). */
export function fieldOptions(api: OpenApi, definition: Schema): FieldOption[] {
  const out: FieldOption[] = [];
  for (const [name, raw] of Object.entries(definition.properties ?? {})) {
    if (name === 'kind' || name === 'version') continue;
    const { schema } = unwrapNullable(api, raw);
    const required = !!definition.required?.includes(name);
    out.push({ path: name, label: labelOf(name), schema, required });
    if (typeOf(schema) === 'object' && schema.properties && !('sha256' in schema.properties)) {
      for (const [child, rawChild] of Object.entries(schema.properties)) {
        out.push({ path: `${name}.${child}`, label: `${labelOf(name)} › ${labelOf(child)}`, schema: unwrapNullable(api, rawChild).schema, required: false });
      }
    }
  }
  return out;
}

export function encodingFor(schema: Schema): Encoding {
  const type = typeOf(schema);
  if (type === 'number') return 'number';
  if (type === 'integer') return 'integer';
  if (type === 'boolean') return 'boolean';
  if (type === 'string' || type === 'enum') return 'text';
  return 'json';
}

/** A first mapping for each header (the person reviews it). `steve`: the file is a STEVE export (JSON cells). */
export function guessColumns(headers: string[], options: FieldOption[]): { columns: (CsvColumn | null)[]; steve: boolean } {
  const steve = headers.includes('@archived') || headers.includes('@provenance');
  const used = new Set<string>();
  const columns = headers.map((header): CsvColumn | null => {
    if (header === '@provenance' || header === '@archived') return { column: header, field: header, encoding: 'json', units: 'native', blank: 'omit' };
    const exact = options.find((option) => option.path === header);
    // A STEVE export also carries the record's kind and format version.
    if (steve) return exact || STEVE_COLUMNS.includes(header) ? { column: header, field: header, encoding: 'json', units: 'native', blank: 'omit' } : null;
    const key = norm(header);
    const match = exact ?? options.find((option) => !used.has(option.path) && (norm(option.path.replace(/_(mm3_min|m_min|mm_min|mm|rad|kg|rpm)$/, '')) === key || norm(option.label) === key))
      ?? options.find((option) => !used.has(option.path) && ALIASES[key] === option.path);
    if (!match || used.has(match.path)) return null;
    used.add(match.path);
    const blank: Blank = 'omit';
    return { column: header, field: match.path, encoding: encodingFor(match.schema), units: headerUnits(header, match.path), blank };
  });
  return { columns, steve };
}

/** Kinds a CSV can hold (3D printing stays backend-only, posts are code). */
export const CSV_KINDS: Kind[] = ['rotary_cutter', 'tool_holder', 'tool_assembly', 'tool_setup', 'machining_material', 'cutting_preset', 'machine_model', 'machine_instance', 'controller'];

export const unitLabel = (units: SourceUnits) => (units === 'native' ? 'As saved' : units.replace('3/', '³/'));
export const fieldUnit = (path: string) => unitOf(path.split('.').pop() ?? path);

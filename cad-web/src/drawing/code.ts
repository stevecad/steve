/**
 * Drawing sheets are code: `Drawing(result, standard="ISO", sheet="A3", …)` (runtime/steve/drawing.py). The Drawing tab
 * reads those calls and writes them back, the way STEVE does, so a sheet keeps the design's history, branches and
 * revisions. Arguments the tab doesn't change keep their text. One that isn't a plain literal (a variable, an
 * expression) shows what the last drawing build evaluated it to (the sheet report's `args`, withValues), and an edit of
 * it writes that value as a literal in its place; only arguments made by a loop stay as written. No imports: tests run
 * this file without a browser.
 */

export interface DrawingCall {
  /** The statement's first character (its indentation included) and the end of the call. */
  from: number;
  to: number;
  indent: string;
  /** What comes before `Drawing(` on its line: the indentation, and `sheet = ` when it's assigned. */
  head: string;
  /** What it draws, as written (`result`, `housing`). */
  source: string;
  /** Keyword arguments as written, in order. */
  args: [string, string][];
  /** The statement is inside a `for` or `while` block or a function: one statement drawing any number of sheets. */
  loop?: boolean;
  /** What the last drawing build evaluated arguments written as expressions to, while their text is unchanged. */
  values?: Record<string, PyValue>;
}

export type PyValue = string | number | boolean | null | PyValue[] | { [key: string]: PyValue };

const CALL = /^([ \t]*)(?:[A-Za-z_]\w*\s*=\s*)?Drawing\s*\(/gm;

/** Where the bracket opened at `open` closes (one past it), skipping strings and comments; -1 when it never does. */
function closing(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '#') { const end = code.indexOf('\n', i); if (end < 0) return -1; i = end; continue; }
    if (c === '"' || c === "'") { i = stringEnd(code, i) - 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && --depth === 0) return i + 1;
  }
  return -1;
}

/** One past the end of the string literal starting at `start` (triple quotes too). */
function stringEnd(code: string, start: number): number {
  const quote = code[start];
  const triple = code.startsWith(quote.repeat(3), start);
  const close = triple ? quote.repeat(3) : quote;
  for (let i = start + close.length; i < code.length; i++) {
    if (code[i] === '\\') { i++; continue; }
    if (!triple && code[i] === '\n') return i;
    if (code.startsWith(close, i)) return i + close.length;
  }
  return code.length;
}

/** A call's arguments split at top-level commas, comments dropped. */
function splitArgs(inner: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0, text = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '#') {
      text += inner.slice(start, i);
      const end = inner.indexOf('\n', i);
      i = end < 0 ? inner.length : end;
      start = i;
      continue;
    }
    if (c === '"' || c === "'") { i = stringEnd(inner, i) - 1; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push((text + inner.slice(start, i)).trim());
      text = '';
      start = i + 1;
    }
  }
  const last = (text + inner.slice(start)).trim();
  if (last) out.push(last);
  return out.filter(Boolean);
}

/** Every top-level `Drawing(...)` statement in the code, in order (the order the sheets are numbered in). */
export function drawingCalls(code: string): DrawingCall[] {
  const out: DrawingCall[] = [];
  for (const match of code.matchAll(CALL)) {
    const open = match.index! + match[0].length - 1;
    const end = closing(code, open);
    if (end < 0) continue;
    const parts = splitArgs(code.slice(open + 1, end - 1));
    let source = '';
    const args: [string, string][] = [];
    for (const part of parts) {
      const keyword = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
      if (keyword && keyword[1] === 'source') source = keyword[2];
      else if (keyword) args.push([keyword[1], keyword[2]]);
      else if (!source) source = part;
    }
    const head = match[0].replace(/Drawing\s*\($/, '');
    const call: DrawingCall = { from: match.index!, to: end, indent: match[1], head, source: source || 'result', args };
    if (inLoop(code, match.index!, match[1])) call.loop = true;
    out.push(call);
  }
  return out;
}

/** Whether the statement starting at `from` (indented by `indent`) is inside a `for` or `while` block, or a function's
 *  body (`def`): either may draw any number of sheets, in any order. */
function inLoop(code: string, from: number, indent: string): boolean {
  const width = (text: string) => text.replace(/\t/g, '    ').length;
  let depth = width(indent);
  const lines = code.slice(0, from).split('\n');
  for (let i = lines.length - 1; i >= 0 && depth > 0; i--) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const own = width(/^[ \t]*/.exec(line)![0]);
    if (own >= depth) continue;
    if (/^\s*(?:async\s+)?(?:for|while|def)\b/.test(line)) return true;
    depth = own;
  }
  return false;
}

/** Text with its string literals emptied (what's in them never reads as code). */
function withoutStrings(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"' || text[i] === "'") { out += '""'; i = stringEnd(text, i) - 1; continue; }
    out += text[i];
  }
  return out;
}

/** Whether an argument as written makes its items by a loop: a comprehension or generator, a `*` or `**` splat, or a map. */
function loopMade(raw: string): boolean {
  const code = withoutStrings(raw);
  return /\bfor\b[\s\S]*\bin\b/.test(code) || /(?:^|[[({,]\s*)\*{1,2}\s*[A-Za-z_([{]/.test(code) || /\bmap\s*\(/.test(code);
}

/**
 * The calls in `code` with what the drawing build of `built` (that code, as it was drawn) evaluated each sheet's
 * arguments to (`args`: the sheet reports' `args`, in order). An argument gets its value while its text is as it was
 * built and the code outside the sheets is too (a variable it reads may have changed); else it has none. Reports match
 * calls by position, so only while each call drew exactly one sheet: as many sheets as calls, none in a loop or function
 * (sheets drawn from other files, or several by one statement, would put another sheet's value in the code).
 */
export function withValues(code: string, built: string | undefined, args: (Record<string, PyValue> | undefined)[]): DrawingCall[] {
  const calls = drawingCalls(code);
  if (built === undefined || !args.some(Boolean) || withoutDrawings(built) !== withoutDrawings(code)) return calls;
  const before = drawingCalls(built);
  if (before.length !== args.length || before.some((call) => call.loop)) return calls;
  return calls.map((call, index) => {
    const reported = args[index], was = before[index];
    if (!reported || !was || was.source !== call.source) return call;
    const values: Record<string, PyValue> = {};
    for (const [key, raw] of call.args) {
      if (Object.prototype.hasOwnProperty.call(reported, key) && was.args.some(([name, text]) => name === key && text === raw)) values[key] = reported[key];
    }
    return { ...call, values };
  });
}

/** The code without its `Drawing(...)` statements: what the model is built from. Two sources that differ only in their
 *  sheets build the same model (state/design.ts modelBuiltFrom). */
export function withoutDrawings(code: string): string {
  let out = '', at = 0;
  for (const call of drawingCalls(code)) {
    out += code.slice(at, call.from);
    at = code[call.to] === '\n' ? call.to + 1 : call.to;  // With its line, as withoutCall removes it.
  }
  // Whitespace at the end (a sheet added at the end: withNewDrawing) doesn't change the model either.
  return (out + code.slice(at)).replace(/\s*$/, '\n');
}

/* ───────── Python literals ───────── */

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

class Reader {
  i = 0;
  text: string;
  constructor(text: string) { this.text = text; }
  space() { while (this.i < this.text.length && /\s/.test(this.text[this.i])) this.i++; }
  peek() { this.space(); return this.text[this.i]; }
  value(): PyValue {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    if (c === '(' || c === '[') return this.sequence(c === '(' ? ')' : ']');
    if (c === '{') return this.dict();
    const word = /^(True|False|None|[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(this.text.slice(this.i));
    if (!word) throw new Error('not a literal');
    this.i += word[0].length;
    if (/^\w/.test(this.text[this.i] ?? '')) throw new Error('not a literal');
    return word[0] === 'True' ? true : word[0] === 'False' ? false : word[0] === 'None' ? null : Number(word[0].replace(/_/g, ''));
  }
  string(): string {
    let out = '';
    // Adjacent literals join, as in Python ("a" "b").
    while (this.peek() === '"' || this.peek() === "'") {
      const start = this.i;
      const end = stringEnd(this.text, start);
      const quote = this.text.startsWith(this.text[start].repeat(3), start) ? 3 : 1;
      const body = this.text.slice(start + quote, end - quote);
      out += body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (_, e: string) =>
        (e.length > 1 ? String.fromCharCode(parseInt(e.slice(1), 16)) : ESCAPES[e] ?? (e === '\n' ? '' : `\\${e}`)));
      this.i = end;
    }
    return out;
  }
  sequence(close: string): PyValue[] {
    this.i++;
    const out: PyValue[] = [];
    while (this.peek() !== close) {
      out.push(this.value());
      if (this.peek() === ',') this.i++;
      else if (this.peek() !== close) throw new Error('not a literal');
    }
    this.i++;
    return out;
  }
  dict(): { [key: string]: PyValue } {
    this.i++;
    const out: { [key: string]: PyValue } = {};
    while (this.peek() !== '}') {
      const key = this.value();
      if (typeof key !== 'string' || this.peek() !== ':') throw new Error('not a literal');
      this.i++;
      out[key] = this.value();
      if (this.peek() === ',') this.i++;
      else if (this.peek() !== '}') throw new Error('not a literal');
    }
    this.i++;
    return out;
  }
}

/** A Python literal's value (strings, numbers, booleans, None, tuples, lists, dicts), or undefined for anything else. */
export function literal(text: string): PyValue | undefined {
  try {
    const reader = new Reader(text);
    const value = reader.value();
    reader.space();
    return reader.i === text.length ? value : undefined;
  } catch { return undefined; }
}

/** Python source for a value; arrays are lists, or tuples with `tuple`. */
export function py(value: PyValue, tuple = false): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(Number(value.toPrecision(10)));
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => py(item));
    return tuple ? `(${items.join(', ')}${items.length === 1 ? ',' : ''})` : `[${items.join(', ')}]`;
  }
  return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${py(item)}`).join(', ')}}`;
}

/**
 * An argument as written: its text; its value (the literal's, or what the build evaluated an expression to); whether
 * the tab may edit it (an edit of an expression writes a literal in its place); whether it's an expression; and
 * whether it's made by a loop (a comprehension, a splat, or a sheet drawn in a loop), which the tab leaves as written.
 */
export function arg(call: DrawingCall, key: string): { raw: string | undefined; value: PyValue | undefined; editable: boolean; expression: boolean; loop: boolean } {
  const raw = call.args.find(([name]) => name === key)?.[1];
  const written = raw === undefined ? undefined : literal(raw);
  const expression = raw !== undefined && written === undefined;
  const loop = expression && (!!call.loop || loopMade(raw!));
  const evaluated = expression && !loop && call.values && Object.prototype.hasOwnProperty.call(call.values, key);
  const value = evaluated ? call.values![key] : written;
  return { raw, value, editable: !expression || !!evaluated, expression, loop };
}

/** Why the tab leaves a sheet's arguments as written (they're made by a loop, or have no value it can write out). */
export function fixedNote(call: DrawingCall | undefined): string {
  return call && call.args.some(([key]) => arg(call, key).loop) ? 'Made by a loop in the code: change it there, or ask STEVE.'
    : 'Its value can’t be written out here: change it in the code, or ask STEVE.';
}

/** The arguments `changes` writes over that were expressions: each one's key and its text as it was. */
export function replacedBy(call: DrawingCall, changes: Record<string, string | undefined>): { key: string; was: string }[] {
  return Object.keys(changes).flatMap((key) => {
    const { raw, expression } = arg(call, key);
    return expression && raw !== undefined && changes[key] !== raw ? [{ key, was: raw }] : [];
  });
}

/** Whether a call's argument `key` is still what the tab wrote (`text`, laid out again or not; undefined: left out). */
export function stillWritten(call: DrawingCall, key: string, text: string | undefined): boolean {
  const raw = arg(call, key).raw;
  if (raw === undefined || text === undefined) return raw === text;
  if (raw === text) return true;
  const [now, wrote] = [literal(raw), literal(text)];
  return now !== undefined && wrote !== undefined && JSON.stringify(now) === JSON.stringify(wrote);
}

/** The call's text with arguments changed (Python text) or removed (undefined); new ones go last. */
export function callText(call: DrawingCall, changes: Record<string, string | undefined>): string {
  const args: [string, string][] = call.args.filter(([key]) => !(key in changes) || changes[key] !== undefined)
    .map(([key, raw]) => [key, key in changes ? changes[key]! : raw]);
  for (const [key, raw] of Object.entries(changes)) if (raw !== undefined && !args.some(([name]) => name === key)) args.push([key, raw]);
  const parts = [call.source, ...args.map(([key, raw]) => `${key}=${raw}`)];
  const flat = `Drawing(${parts.join(', ')})`;
  if (call.head.length + flat.length <= 110 && !parts.some((part) => part.includes('\n'))) return `${call.head}${flat}`;
  const inner = `${call.indent}    `;
  return `${call.head}Drawing(\n${parts.map((part) => `${inner}${reindent(part, inner)},`).join('\n')}\n${call.indent})`;
}

/** A multi-line argument's later lines moved to `indent`, keeping their indentation relative to each other. */
function reindent(part: string, indent: string): string {
  const [first, ...rest] = part.split('\n');
  if (!rest.length) return part;
  const common = Math.min(...rest.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length));
  return [first, ...rest.map((line) => (line.trim() ? indent + line.slice(Number.isFinite(common) ? common : 0) : ''))].join('\n');
}

/** A list as Python, one item a line when it's long (revision rows, notes). */
export function pyList(items: PyValue[]): string {
  const flat = py(items);
  return flat.length <= 80 ? flat : `[\n${items.map((item) => `    ${py(item)},`).join('\n')}\n]`;
}

/** The code with one call's arguments changed. */
export function withChanges(code: string, call: DrawingCall, changes: Record<string, string | undefined>): string {
  return code.slice(0, call.from) + callText(call, changes) + code.slice(call.to);
}

/** The code without a call (and its line). */
export function withoutCall(code: string, call: DrawingCall): string {
  const end = code[call.to] === '\n' ? call.to + 1 : call.to;
  return code.slice(0, call.from) + code.slice(end);
}

const IMPORTED = /^\s*from\s+steve\.drawing\s+import\s+[^\n]*\bDrawing\b/m;

/** The code with a new sheet at its end (after `result = …`), importing Drawing when it doesn't yet. */
export function withNewDrawing(code: string, options: { standard: 'ISO' | 'ANSI'; title?: string; source?: string; args?: Record<string, string | undefined> }): string {
  let next = code.replace(/\s*$/, '\n');
  if (!IMPORTED.test(next)) {
    const lines = next.replace(/\n$/, '').split('\n');
    const imports = lines.reduce((last, line, index) => (/^(from|import) /.test(line) ? index : last), -1);
    lines.splice(imports + 1, 0, 'from steve.drawing import Drawing');
    next = `${lines.join('\n')}\n`;
  }
  const args: [string, string][] = [['standard', options.args?.standard ?? py(options.standard)], ...(options.title ? [['title', py(options.title)] as [string, string]] : [])];
  for (const [key, raw] of Object.entries(options.args ?? {})) if (raw !== undefined && key !== 'standard') args.push([key, raw]);
  const call: DrawingCall = { from: 0, to: 0, indent: '', head: '', source: options.source ?? 'result', args };
  return `${next}${callText(call, {})}\n`;
}

/* ───────── What the runtime accepts (runtime/steve/drawing.py) ───────── */

export const SHEET_SIZES = { ISO: ['A4', 'A3', 'A2', 'A1', 'A0'], ANSI: ['A', 'B', 'C', 'D', 'E'] } as const;
export const VIEWS = ['front', 'top', 'right', 'left', 'bottom', 'back', 'iso'] as const;
export const DEFAULT_VIEWS = ['front', 'top', 'right', 'iso'];
/** A sheet-metal body's flat pattern ({"view": "flat", "body": …}): the blank its DXF cuts, offered when the sheet draws sheet metal. */
export const FLAT = 'flat';
/** Base views that aren't orthographic projections of the master: no dimensions, GD&T, sections or details go on them. */
export const OWN_VIEWS: string[] = ['iso', FLAT];
export const SCALES: [number, number][] = [[50, 1], [20, 1], [10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100], [1, 200], [1, 500], [1, 1000]];
/** Title block fields with their own cells, in the order the form lists them. */
export const FIELDS: [string, string][] = [['number', 'Drawing no.'], ['owner', 'Owner'], ['drawn_by', 'Drawn'], ['checked_by', 'Checked'],
  ['approved_by', 'Approved'], ['date', 'Date'], ['material', 'Material'], ['finish', 'Finish'], ['tolerances', 'General tolerances']];
export const TEXT_LIMIT = 200;

/* ───────── The sheet's own title block (`title_block=[{"height": 12, "cells": [{"width": 120, "field": "title"}, …]}, …]`) ───────── */

/** One cell of a title block layout: its width (mm), and a label, a field (filled in from `fields`, or by the sheet) or
 *  fixed text (a line, or a list of up to 12), the text's and label's heights (mm), how many rows it spans upward, and
 *  where its value and label sit (align left/centre/right, valign top/middle/bottom). */
export interface TitleCell {
  width: number; label?: string; field?: string; text?: string | string[]; text_height?: number; label_height?: number; rows?: number;
  align?: string; valign?: string; label_align?: string; label_valign?: string;
  /** Its value or text, and its label, in bold. */
  bold?: boolean; label_bold?: boolean;
  /** A logo instead of a value: one of the design's .png or .jpg files, scaled to fit inside `padding` (mm). */
  image?: string; padding?: number;
}
/** A row of the layout (bottom row first): its height (mm) and cells. */
export interface TitleRow { height: number; cells: TitleCell[] }

/** Fields the sheet fills in itself (runtime/steve/drawing.py TITLE_VALUES), with their labels; title and revision are
 *  typed in the Title block tool like the others. */
export const SHEET_VALUES: Record<string, string> = { title: 'Title', revision: 'Revision', scale: 'Scale', sheet: 'Sheet', size: 'Size', units: 'Units', projection: 'Projection' };
const TITLE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const TITLE_LIMIT = 12;
const TITLE_LINES = 12;
const TITLE_CELL_KEYS = ['width', 'label', 'field', 'text', 'text_height', 'label_height', 'rows', 'align', 'valign', 'label_align', 'label_valign', 'image', 'padding', 'bold', 'label_bold'];
const TITLE_IMAGE = /^[a-z][a-z0-9_]{0,63}\.(?:png|jpe?g)$/;
const ALIGNS: string[] = ['left', 'centre', 'center', 'right'];
const VALIGNS: string[] = ['top', 'middle', 'bottom'];

/** `title_block` as written, when it's a layout the runtime takes the shape of (up to 12 rows of 12 cells, each key the
 *  right type); null when there's none, or it's something else (an expression, a mistake the build reports). */
export function titleLayout(value: PyValue | undefined): TitleRow[] | null {
  if (!Array.isArray(value) || !value.length || value.length > TITLE_LIMIT) return null;
  const rows: TitleRow[] = [];
  for (const item of value) {
    const row = dictOf(item);
    const cells = row.cells;
    if (typeof row.height !== 'number' || !Array.isArray(cells) || !cells.length || cells.length > TITLE_LIMIT
      || Object.keys(row).some((key) => key !== 'height' && key !== 'cells')) return null;
    const out: TitleCell[] = [];
    for (const entry of cells) {
      const cell = dictOf(entry);
      if (typeof cell.width !== 'number' || Object.keys(cell).some((key) => !TITLE_CELL_KEYS.includes(key))) return null;
      const next: TitleCell = { width: cell.width };
      if (cell.label !== undefined) { const label = line(cell.label); if (label === null) return null; next.label = label; }
      if (cell.field !== undefined) { if (typeof cell.field !== 'string' || !TITLE_FIELD.test(cell.field)) return null; next.field = cell.field; }
      if (cell.text !== undefined) {
        if (next.field) return null;
        if (Array.isArray(cell.text)) {
          const lines = cell.text.map(line);
          if (!lines.length || lines.length > TITLE_LINES || lines.some((fixed) => fixed === null)) return null;
          next.text = lines as string[];
        } else {
          const fixed = line(cell.text);
          if (fixed === null) return null;
          next.text = fixed;
        }
      }
      if (cell.image !== undefined) {
        if (typeof cell.image !== 'string' || !TITLE_IMAGE.test(cell.image) || next.field || next.text !== undefined) return null;
        next.image = cell.image;
      }
      for (const key of ['text_height', 'label_height', 'rows', 'padding'] as const) {
        if (cell[key] !== undefined) { const size = cell[key]; if (typeof size !== 'number') return null; next[key] = size; }
      }
      for (const [key, allowed] of [['align', ALIGNS], ['valign', VALIGNS], ['label_align', ALIGNS], ['label_valign', VALIGNS]] as const) {
        if (cell[key] !== undefined) { const where = cell[key]; if (typeof where !== 'string' || !allowed.includes(where)) return null; next[key] = where; }
      }
      for (const key of ['bold', 'label_bold'] as const) {
        if (cell[key] !== undefined) { const weight = cell[key]; if (typeof weight !== 'boolean') return null; next[key] = weight; }
      }
      out.push(next);
    }
    rows.push({ height: row.height, cells: out });
  }
  return rows;
}

/** The fields a layout's cells show that are typed in (not the sheet's scale, size…): [key, label], each once, bottom row
 *  first. The title is left out: the Title block tool always has its own box. */
export function layoutFields(rows: TitleRow[]): [string, string][] {
  const out: [string, string][] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const key = cell.field;
      if (!key || key === 'title' || (key in SHEET_VALUES && key !== 'revision') || out.some(([known]) => known === key)) continue;
      const label = cell.label || FIELDS.find(([known]) => known === key)?.[1] || SHEET_VALUES[key] || key.replace(/_/g, ' ');
      out.push([key, label]);
    }
  }
  return out;
}

/** `title_block` as Python: a row a line, a cell a line. */
export function layoutText(rows: TitleRow[]): string {
  const cell = (item: TitleCell) => py(Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) as PyValue);
  return `[\n${rows.map((row) => `    {"height": ${py(row.height)}, "cells": [\n${row.cells.map((item) => `        ${cell(item)},`).join('\n')}\n    ]},`).join('\n')}\n]`;
}

/* ───────── The view tree (`views`, `section_views`, `detail_views`) ───────── */

const dictOf = (value: PyValue | undefined): Record<string, PyValue> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** A base view's name as written in `views`: "front", or a dict's `view` ({"view": "front", "scale": (1, 2)}). */
export function viewName(item: PyValue): string {
  return typeof item === 'string' ? item : typeof dictOf(item).view === 'string' ? dictOf(item).view as string : '';
}

/** The sheet's base views as written, each a name or a dict with its own settings (the runtime's default when left out). */
export function viewItems(call: DrawingCall): PyValue[] {
  const { raw, value } = arg(call, 'views');
  if (raw === undefined) return [...DEFAULT_VIEWS];
  return Array.isArray(value) ? value : value !== undefined && value !== null ? [value] : [];
}

/** `views` as Python: a tuple of names, or a list when a view has its own settings; undefined for the default; `[]`
 *  for none (a blank sheet). */
export function viewsText(items: PyValue[]): string | undefined {
  if (!items.length) return '[]';
  if (items.every((item) => typeof item === 'string')) {
    return items.join() === DEFAULT_VIEWS.join() ? undefined : py(items, true);
  }
  return pyList(items);
}

/** A base view with its own settings changed (undefined removes one): its bare name when none are left. */
export function withViewSettings(item: PyValue, patch: Record<string, PyValue | undefined>): PyValue {
  const row = withKeys(typeof item === 'string' ? { view: item } : dictOf(item), patch);
  return Object.keys(row).length === 1 && typeof row.view === 'string' ? row.view : row;
}

/* ───────── The master view (`front=(facing, up)`) ───────── */

/** The model sides the master (front) view can show, and the side up on the paper when only one is given: as that
 *  side's own view has it (runtime/steve/drawing.py MODEL_SIDES, SIDE_UP). */
export const SIDES = ['front', 'back', 'top', 'bottom', 'left', 'right'] as const;
export const SIDE_UP: Record<string, string> = { front: 'top', back: 'top', top: 'back', bottom: 'front', left: 'top', right: 'top' };
const OPPOSITE: Record<string, string> = { front: 'back', back: 'front', top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

/** The sides that can be up when the master shows `facing`: the four next to it. */
export const sidesNextTo = (facing: string): string[] => SIDES.filter((side) => side !== facing && side !== OPPOSITE[facing]);

/** The master's orientation as the runtime reads `front`: [facing, up]; null when it isn't a literal the tab reads. */
export function frontOf(call: DrawingCall): [string, string] | null {
  const { raw, value } = arg(call, 'front');
  if (raw === undefined) return ['front', 'top'];
  if (typeof value === 'string' && value in SIDE_UP) return [value, SIDE_UP[value]];
  if (Array.isArray(value) && value.length === 2 && value.every((side) => typeof side === 'string' && side in SIDE_UP)
    && sidesNextTo(value[0] as string).includes(value[1] as string)) return [value[0] as string, value[1] as string];
  return null;
}

/** `front` as Python: undefined for the default (the model's own front, top up). */
export function frontText(facing: string, up: string): string | undefined {
  return facing === 'front' && up === 'top' ? undefined : py([facing, up], true);
}

/** A scale as written ((1, 2), 0.5) as the sheet shows it (1:2), or undefined when it isn't one. */
export function scaleLabel(value: PyValue | undefined): string | undefined {
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && n > 0)) return `${value[0]}:${value[1]}`;
  if (typeof value === 'number' && value > 0) return value >= 1 ? `${value}:1` : `1:${Number((1 / value).toPrecision(4))}`;
  return undefined;
}

/** A section or detail view as written (`section_views=[{"name": "A", "parent": "front", …}]`), with its kind. */
export interface ChildView { kind: 'section' | 'detail'; index: number; row: Record<string, PyValue> }

/** The sheet's section views, then its detail views, as written (the runtime takes one dict as well as a list). */
export function childViews(call: DrawingCall): ChildView[] {
  const out: ChildView[] = [];
  for (const kind of ['section', 'detail'] as const) {
    const { value } = arg(call, `${kind}_views`);
    const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
    rows.forEach((row, index) => out.push({ kind, index, row: dictOf(row) }));
  }
  return out;
}

/* ───────── Item balloons (`balloons=True` or `[{"instance": …}]`) and hole tables (`hole_tables=[…]`) ───────── */

/** Where a balloon goes from its view (runtime/steve/drawing.py BALLOON_SIDES); left out: straight out from its middle. */
export const BALLOON_SIDES = ['above', 'below', 'left', 'right', 'up-right', 'up-left', 'down-right', 'down-left'] as const;

/** `balloons` as written (or evaluated): 'all' (True: one per parts list item), its rows (a bare instance name is a row
 *  too), or null when the tab leaves it as written (made by a loop). */
export function balloonRows(call: DrawingCall): 'all' | Record<string, PyValue>[] | null {
  const { raw, value, editable } = arg(call, 'balloons');
  if (!editable) return null;
  if (value === true) return 'all';
  if (raw === undefined || value === false || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => (typeof item === 'string' ? { instance: item } : dictOf(item)));
}

/** `balloons` as Python: True, the rows, or undefined when there are none. */
export function balloonsText(rows: 'all' | Record<string, PyValue>[]): string | undefined {
  return rows === 'all' ? 'True' : rows.length ? pyList(rows) : undefined;
}

/**
 * Where the build drew a balloon (the sheet report's `balloons_placed`), in the SVG's frame: paper mm, y down. `at` is
 * where its leader starts on the part, `box` the view's outline it goes out past (x0, y0, x1, y1), `offset` its
 * distance past that outline. `index` is its row in `balloons` as written (from 1; null for `balloons=True`'s).
 */
export interface BalloonPlacement {
  balloon: number; index: number | null; instance: string; item: number; view: string; side: string | null;
  offset: number; centre: [number, number]; radius: number; at: [number, number]; box: [number, number, number, number];
}

/** A balloon's distance past its view when none is written (runtime/steve/drawing.py BALLOON_OFFSET). */
export const BALLOON_OFFSET = 10;

/** Each balloon side's direction on the paper, y up as the runtime measures it. */
const BALLOON_DIRECTIONS: Record<(typeof BALLOON_SIDES)[number], [number, number]> = {
  above: [0, 1], below: [0, -1], left: [-1, 0], right: [1, 0],
  'up-right': [Math.SQRT1_2, Math.SQRT1_2], 'up-left': [-Math.SQRT1_2, Math.SQRT1_2],
  'down-right': [Math.SQRT1_2, -Math.SQRT1_2], 'down-left': [-Math.SQRT1_2, -Math.SQRT1_2],
};

/**
 * The `side` and `offset` a drag of balloon `placed` by (dx, dy) paper mm (y down) writes, as the runtime places them
 * (drawing.py _balloon_at): the side nearest the drag's direction from the leader's start (left out when that's close
 * to straight out from the view's middle, the default), and the distance past the view's outline along it. Snaps to
 * the default distance unless `snap` is off.
 */
export function draggedBalloon(placed: BalloonPlacement, drag: { dx: number; dy: number; snap: boolean }): PlacementPatch {
  const [ax, ay] = [placed.at[0], -placed.at[1]];  // y up from here on
  const [x0, y0, x1, y1] = [placed.box[0], -placed.box[3], placed.box[2], -placed.box[1]];
  const [vx, vy] = [placed.centre[0] + drag.dx - ax, -(placed.centre[1] + drag.dy) - ay];
  if (Math.hypot(vx, vy) < 1e-6) return {};
  const angle = Math.atan2(vy, vx);
  const apart = (d: [number, number]) => Math.abs(Math.atan2(Math.sin(angle - Math.atan2(d[1], d[0])), Math.cos(angle - Math.atan2(d[1], d[0]))));
  const out: [number, number] = [ax - (x0 + x1) / 2, ay - (y0 + y1) / 2];
  let side: string | undefined, d: [number, number];
  if (drag.snap && Math.hypot(...out) > 1e-6 && apart(out) < Math.PI / 16) {
    const length = Math.hypot(...out);
    d = [out[0] / length, out[1] / length];
  } else {
    [side, d] = Object.entries(BALLOON_DIRECTIONS).reduce((best, entry) => (apart(entry[1]) < apart(best[1]) ? entry : best));
  }
  const exits = ([[x0, x1], [y0, y1]] as const).flatMap(([low, high], k) => {
    const [a, n] = k ? [ay, d[1]] : [ax, d[0]];
    return Math.abs(n) > 1e-9 ? [((n > 0 ? high : low) - a) / n] : [];
  });
  const reach = vx * d[0] + vy * d[1] - Math.max(0, Math.min(...exits)) - placed.radius;
  const offset = clamp(half(snapped(reach, [BALLOON_OFFSET], drag.snap)), 1, 200);
  return { side, offset: offset === BALLOON_OFFSET ? undefined : offset };
}

/** The sheet's hole tables as written (the runtime takes one dict, or a view's name, as well as a list). */
export function holeTableRows(call: DrawingCall): Record<string, PyValue>[] {
  const { value } = arg(call, 'hole_tables');
  const items = Array.isArray(value) ? value : value !== undefined && value !== null && value !== false ? [value] : [];
  return items.map((item) => (typeof item === 'string' ? { view: item } : dictOf(item)));
}

/* ───────── Weld symbols (`welds=[{"view": …, "type": "fillet", "refs": [...]}, …]`) ───────── */

/** Weld types and the sides each takes, the first its default (runtime/steve/drawing.py WELD_TYPES, WELD_SIDES). */
export const WELD_GROOVES = ['square', 'v', 'bevel', 'u', 'j', 'flare_v', 'flare_bevel'] as const;
export const WELD_TYPES = ['fillet', 'plug', 'slot', 'spot', ...WELD_GROOVES] as const;
export const weldSides = (type: string): string[] =>
  type === 'spot' ? ['centre', 'arrow', 'other'] : type === 'plug' || type === 'slot' ? ['arrow', 'other'] : ['arrow', 'other', 'both'];
/** The most arrows one weld symbol has (WELD_LEADERS), and the furthest `at` puts its reference line (paper mm). */
export const WELD_LEADERS = 8;
const WELD_REACH = 300;

/** `welds` as written or evaluated (the runtime takes one dict as well as a list), or null when the tab leaves it as
 *  written (made by a loop). */
export function weldRows(call: DrawingCall): Record<string, PyValue>[] | null {
  const { raw, value, editable } = arg(call, 'welds');
  if (!editable) return null;
  if (raw === undefined || value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(dictOf);
}

/** `welds` as Python (undefined when there are none). */
export const weldsText = (rows: Record<string, PyValue>[]): string | undefined => (rows.length ? pyList(rows) : undefined);

/** A weld's refs as written (one name or a list); empty for a weld that names its joint or bead. */
export function weldRefs(row: Record<string, PyValue>): string[] {
  const refs: PyValue[] = Array.isArray(row.refs) ? row.refs : typeof row.refs === 'string' ? [row.refs] : [];
  return refs.filter((ref): ref is string => typeof ref === 'string');
}

/** Whether a weld points at refs (the tab adds and removes its arrows), rather than naming its joint or bead. */
export const hasLeaders = (row: Record<string, PyValue>): boolean => row.joint === undefined && row.bead === undefined;

/** The keys a weld of `type` can't take (runtime _weld): a side it doesn't have, a groove's values on another kind, a
 *  fillet's leg, a contour on a plug, slot or spot weld. */
function foreignKeys(row: Record<string, PyValue>, type: string): string[] {
  const groove = (WELD_GROOVES as readonly string[]).includes(type);
  const out: string[] = [];
  if (row.side !== undefined && !weldSides(type).includes(row.side === 'center' ? 'centre' : String(row.side))) out.push('side');
  if (!groove) out.push('throat', 'root_opening');
  if (!['v', 'bevel', 'u', 'j'].includes(type)) out.push('angle');
  if (type !== 'fillet') out.push('leg');
  if (type !== 'fillet' && !groove) out.push('contour', 'finish');
  return out.filter((key) => row[key] !== undefined);
}

/** A weld's keys changed (undefined removes one), the others as written: a new type drops the keys it can't take, and
 *  a side set to the type's default is left out. */
export function withWeld(row: Record<string, PyValue>, patch: Record<string, PyValue | undefined>): Record<string, PyValue> {
  const next = withKeys(row, patch);
  if ('type' in patch && typeof next.type === 'string') for (const key of foreignKeys(next, next.type)) delete next[key];
  if ('side' in patch && next.side === weldSides(String(next.type))[0]) delete next.side;
  return next;
}

/** A new weld row, its keys in the order people read them: the view, what it is and its values, its arrows, where it goes. */
export function newWeld(options: Record<string, PyValue>, view: string, refs: string[], at?: PyValue): Record<string, PyValue> {
  const row: Record<string, PyValue> = { view, type: typeof options.type === 'string' ? options.type : 'fillet' };
  for (const key of ['side', 'size', 'length', 'pitch', 'all_around', 'field', 'tail']) {
    const value = options[key];
    if (value !== undefined && value !== null && value !== false && value !== '') row[key] = value;
  }
  row.refs = refs;
  if (at !== undefined) row.at = at;
  return withWeld(row, { type: row.type, side: row.side });
}

/** A weld with one more arrow (up to WELD_LEADERS, each ref once). */
export function withLeader(row: Record<string, PyValue>, ref: string): Record<string, PyValue> {
  const refs = weldRefs(row);
  return refs.includes(ref) || refs.length >= WELD_LEADERS ? row : withKeys(row, { refs: [...refs, ref] });
}

/** A weld without arrow `index` (from 0); its last arrow stays. */
export function withoutLeader(row: Record<string, PyValue>, index: number): Record<string, PyValue> {
  const refs = weldRefs(row);
  return refs.length <= 1 || !refs[index] ? row : withKeys(row, { refs: refs.filter((_, i) => i !== index) });
}

/** `at` for a reference line starting at `junction` from its first arrow's tip at `tip` (both paper mm, y down):
 *  (dx, dy) paper mm, y up, half millimetres within the runtime's reach. */
export function weldAt(tip: [number, number], junction: [number, number]): [number, number] {
  const keep = (n: number) => clean(clamp(half(n), -WELD_REACH, WELD_REACH));
  return [keep(junction[0] - tip[0]), keep(tip[1] - junction[1])];
}

/** What a drag of a drawn weld symbol by (dx, dy) paper mm (y down) writes: its exact place, `at`, in place of the
 *  runtime's `place` and `offset`. */
export function draggedWeld(placed: { tip: [number, number]; junction: [number, number] }, drag: { dx: number; dy: number }): Record<string, PyValue | undefined> {
  return { at: weldAt(placed.tip, [placed.junction[0] + drag.dx, placed.junction[1] + drag.dy]), place: undefined, offset: undefined };
}

/** A weld's size, length or pitch as typed: a number more than 0 (null when it's empty), undefined when it isn't one. */
export function parseWeldValue(text: string): number | null | undefined {
  const typed = text.trim();
  if (!typed) return null;
  const value = Number(typed);
  return Number.isFinite(value) && value > 0 && value <= 100000 ? value : undefined;
}

/** Why a weld's length and pitch can't be written together, or null (runtime _weld: an intermittent weld's pitch, centre
 *  to centre, is more than its length, and a fillet, slot or groove gives the length with it). */
export function weldSpacingProblem(row: Record<string, PyValue>): string | null {
  const { length, pitch } = row;
  if (typeof pitch !== 'number') return null;
  if (typeof length !== 'number') return row.type === 'plug' || row.type === 'spot' ? null : 'Give each segment’s length with the pitch.';
  return pitch > length ? null : 'The pitch (centre to centre) must be more than each segment’s length.';
}

/** Feature dimensions (`feature_dimensions=[{"view": "front", "refs": [...]}, …]`): how they show their value. */
export const DIMENSION_DISPLAYS = ['value', 'basic', 'reference', 'limits'] as const;

/**
 * A feature dimension's tolerance as typed in the tab: `0.1` or `±0.1` for ±0.1, `+0.1 -0.05` or `+0.1/-0.05` for
 * (upper, lower). null when it's empty (no tolerance), undefined when it doesn't read as one.
 */
export function parseTolerance(text: string): number | [number, number] | null | undefined {
  const typed = text.trim().replace(/[−–]/g, '-').replace(/^(±|\+\/-|\+-)\s*/, '');
  if (!typed) return null;
  const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)';
  if (new RegExp(`^${number}$`).test(typed)) {
    const value = Number(typed);
    return value > 0 ? value : undefined;
  }
  const pair = new RegExp(`^(${number})\\s*[/,\\s]\\s*(${number})$`).exec(typed);
  if (!pair) return undefined;
  const [upper, lower] = [Number(pair[1]), Number(pair[2])].sort((a, b) => b - a);
  if (upper === lower) return undefined;
  return upper === -lower ? upper : [upper, lower];
}

/** ISO 286 tolerance classes (runtime/steve/iso286.py FIT): a hole's in capitals (H7), a shaft's in lower case (g6). */
const FIT = /^(?:A|B|C|CD|D|E|EF|F|FG|G|H|JS|J|K|M|N|P|R|S|T|U|V|X|Y|Z|ZA|ZB|ZC|a|b|c|cd|d|e|ef|f|fg|g|h|js|j|k|m|n|p|r|s|t|u|v|x|y|z|za|zb|zc)(?:01|0|1[0-8]|[1-9])$/;
/** How a fit is shown (`fit_shows`): its class, the class with its deviations, or its limits with the class. */
export const FIT_SHOWS = ['class', 'deviations', 'limits'] as const;

/** An ISO 286 class as typed in the tolerance box (`H7`, `g6`), or undefined when it isn't one. */
export function parseFit(text: string): string | undefined {
  const typed = text.trim();
  return FIT.test(typed) ? typed : undefined;
}

/* ───────── GD&T (`datums=[…]`, `tolerance_frames=[…]`; ASME Y14.5-2018, ISO 1101) ───────── */

/** Geometric characteristics, as the runtime names them, with their type. */
export const CHARACTERISTICS: [string, string, 'form' | 'profile' | 'orientation' | 'location' | 'runout'][] = [
  ['straightness', 'Straightness', 'form'], ['flatness', 'Flatness', 'form'], ['circularity', 'Circularity', 'form'],
  ['cylindricity', 'Cylindricity', 'form'], ['profile_line', 'Profile of a line', 'profile'], ['profile_surface', 'Profile of a surface', 'profile'],
  ['angularity', 'Angularity', 'orientation'], ['perpendicularity', 'Perpendicularity', 'orientation'], ['parallelism', 'Parallelism', 'orientation'],
  ['position', 'Position', 'location'], ['concentricity', 'Concentricity (ISO)', 'location'], ['coaxiality', 'Coaxiality (ISO)', 'location'],
  ['symmetry', 'Symmetry (ISO)', 'location'], ['circular_runout', 'Circular runout', 'runout'], ['total_runout', 'Total runout', 'runout'],
];
/** ASME Y14.5-2018 dropped these; ISO sheets only. */
export const ISO_ONLY = ['concentricity', 'coaxiality', 'symmetry'];
/** Characteristics whose zone may be cylindrical (⌀). */
export const DIAMETER_ZONE = ['straightness', 'angularity', 'perpendicularity', 'parallelism', 'position', 'concentricity', 'coaxiality'];
/** Characteristics that take no MMC or LMC. */
export const NO_MATERIAL = ['circularity', 'cylindricity', 'profile_line', 'profile_surface', 'circular_runout', 'total_runout'];

const typeOf = (characteristic: string) => CHARACTERISTICS.find(([name]) => name === characteristic)?.[2];
/** Form tolerances have no datums. */
export const takesDatums = (characteristic: string) => typeOf(characteristic) !== 'form';
/** Orientation, runout, concentricity, coaxiality and symmetry are measured from at least one datum. */
export const needsDatum = (characteristic: string) => ['orientation', 'runout'].includes(typeOf(characteristic) ?? '') || ISO_ONLY.includes(characteristic);

/** A frame's datum reference as written: "A", or ("A", "MMC"). */
export function datumOf(value: PyValue): { letter: string; condition: string | null } {
  if (Array.isArray(value)) return { letter: String(value[0] ?? ''), condition: typeof value[1] === 'string' ? value[1] : null };
  return { letter: String(value ?? ''), condition: null };
}

/** The first datum letter not used yet (ASME Y14.5 skips I, O and Q, which read as numbers). */
export function nextDatumLabel(used: string[], standard: 'ISO' | 'ANSI'): string {
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    if (!used.includes(letter) && !(standard === 'ANSI' && 'IOQ'.includes(letter))) return letter;
  }
  return 'AA';
}

/** A datum letter as typed, or undefined when it can't be one (one or two capitals; not I, O or Q on ANSI). */
export function parseDatumLabel(text: string, standard: 'ISO' | 'ANSI'): string | undefined {
  const typed = text.trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(typed) || (standard === 'ANSI' && /[IOQ]/.test(typed))) return undefined;
  return typed;
}

/** An id for a feature dimension that frames and datums attach to: d1, d2, … (the first unused). */
export function dimensionId(rows: Record<string, PyValue>[]): string {
  const used = new Set(rows.map((row) => row.id));
  let n = 1;
  while (used.has(`d${n}`)) n++;
  return `d${n}`;
}

/** A frame's tolerance as typed (`0.1`, `⌀0.1`), or undefined when it isn't a number more than 0. */
export function parseZone(text: string): number | undefined {
  const typed = text.trim().replace(/^[⌀Øø]\s*/, '');
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(typed)) return undefined;
  const value = Number(typed);
  return value > 0 ? value : undefined;
}

/** A frame with its characteristic changed, and what no longer fits it (datums, ⌀ zone, MMC/LMC, modifiers) left out. */
export function withCharacteristic(row: Record<string, PyValue>, characteristic: string, labels: string[]): Record<string, PyValue> {
  const type = typeOf(characteristic);
  const datums = Array.isArray(row.datums) ? row.datums : typeof row.datums === 'string' ? [row.datums] : [];
  const kept = !takesDatums(characteristic) ? [] : NO_MATERIAL.includes(characteristic) ? datums.map((datum) => datumOf(datum).letter) : datums;
  const modifiers = (Array.isArray(row.modifiers) ? row.modifiers : []).filter((name) => name !== 'tangent_plane' || type === 'orientation');
  return withKeys(row, {
    characteristic,
    datums: kept.length ? kept : needsDatum(characteristic) && labels.length ? [labels[0]] : undefined,
    zone: DIAMETER_ZONE.includes(characteristic) ? row.zone : undefined,
    modifier: NO_MATERIAL.includes(characteristic) ? undefined : row.modifier,
    projected: type === 'orientation' || type === 'location' ? row.projected : undefined,
    modifiers: modifiers.length ? modifiers : undefined,
  });
}

/** A tolerance (or a fit's class) as the tab shows it: `±0.1`, `+0.1 -0.05`, `H7`, or empty. */
export function toleranceText(value: PyValue | undefined, fit?: PyValue): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  if (typeof fit === 'string' && fit) return fit;
  if (typeof value === 'number') return `±${value}`;
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number')) return `${signed(value[0] as number)} ${signed(value[1] as number)}`;
  return '';
}

/**
 * Where the build drew a feature dimension (the sheet report's `placed`), in the SVG's frame: paper mm, y down.
 * Linear and aligned ones: `handle` is the text's point on the dimension line, `origin` + `normal` the view's edge
 * (or the geometry, aligned) its offset grows from, `across` the view's depth to the other side, `along` the line's
 * direction, `text_at` the text's shift from the line's middle. Leaders: `centre`, `radius` and `handle` (the elbow).
 * Angles: `centre`, `handle` (on the arc under the text), `middle` (the arc's middle direction) and `sense`.
 */
export interface DimensionPlacement {
  dimension: number; view: string; type: 'linear' | 'aligned' | 'round' | 'angle';
  side: string | null; sides: string[]; offset: number; handle: [number, number];
  origin?: [number, number]; normal?: [number, number]; across?: number; along?: [number, number];
  text_at?: number; text_snaps?: { start: number; end: number };
  centre?: [number, number]; radius?: number; middle?: [number, number]; sense?: number;
  /** A distance's ends that are round wire or tube (or a sharp of two of its straights): they can be at its inside or outside. */
  round_ends?: boolean[];
}

/** Where stacked dimension lines go by default (runtime/steve/drawing.py FIRST_SLOT, SLOT): drags snap to them. */
export const FIRST_SLOT = 10, SLOT = 8, LEADER = 8;
/** How near (paper mm) a dragged dimension snaps to a slot, another dimension's line, or the text's centre or ends. */
export const SNAP = 1.5;

/** A dimension's placement keys as they change: a value to write, or undefined to remove it (its default). */
export type PlacementPatch = { offset?: number; side?: string; text_at?: number | string };

const half = (n: number) => Math.round(n * 2) / 2;
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

function snapped(value: number, targets: number[], on: boolean): number {
  if (!on) return value;
  let best = value, distance = SNAP;
  for (const target of targets) if (Math.abs(target - value) <= distance) { best = target; distance = Math.abs(target - value); }
  return best;
}

/**
 * The placement a drag of `placed` by (dx, dy) paper mm (y down) writes as literals. Dragging the line moves it out
 * from the view (and across it, to the other side); dragging the text also slides it along the line. Snaps to the
 * stacking slots, `others` (the other dimensions' offsets on that side of the view) and the text's centre and ends,
 * unless `snap` is off. Leaders follow the elbow: its quadrant is `side`, its reach `offset`.
 */
export function dragged(placed: DimensionPlacement, drag: { dx: number; dy: number; text: boolean; snap: boolean; others?: number[] }): PlacementPatch {
  const [hx, hy] = [placed.handle[0] + drag.dx, placed.handle[1] + drag.dy];
  const slots = Array.from({ length: 24 }, (_, i) => FIRST_SLOT + SLOT * i);
  const offsetOf = (value: number, targets: number[]) => clamp(half(snapped(value, targets, drag.snap)), 1, 200);
  const sideOf = (side: string) => (side === placed.sides[0] ? undefined : side);
  if (placed.type === 'round' && placed.centre) {
    const [vx, vy] = [hx - placed.centre[0], hy - placed.centre[1]];
    // Written as dragged: a leader with no side may go to another quadrant to stay on the sheet.
    const side = `${vy <= 0 ? 'up' : 'down'}-${vx >= 0 ? 'right' : 'left'}`;
    return { side, offset: offsetOf(Math.hypot(vx, vy) - (placed.radius ?? 0), [LEADER]) };
  }
  if (placed.type === 'angle' && placed.centre) {
    const [vx, vy] = [hx - placed.centre[0], hy - placed.centre[1]];
    const offset = offsetOf(Math.hypot(vx, vy), [...slots, ...(drag.others ?? [])]);
    if (!drag.text || !placed.middle) return { offset };
    let turn = Math.atan2(vy, vx) - Math.atan2(placed.middle[1], placed.middle[0]);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    return { offset, text_at: textAt((placed.sense ?? 1) * turn * offset, placed, drag.snap) };
  }
  if (!placed.origin || !placed.normal) return {};
  let distance = (hx - placed.origin[0]) * placed.normal[0] + (hy - placed.origin[1]) * placed.normal[1];
  let side = placed.side ?? placed.sides[0];
  const across = placed.across ?? 0;
  if (distance < -across / 2 && placed.sides.length === 2) {  // Dragged across the view (or the geometry): the other side.
    side = placed.sides.find((name) => name !== side) ?? side;
    distance = -distance - across;
  }
  const patch: PlacementPatch = { side: sideOf(side), offset: offsetOf(distance, [...slots, ...(drag.others ?? [])]) };
  if (drag.text && placed.along) patch.text_at = textAt((placed.text_at ?? 0) + drag.dx * placed.along[0] + drag.dy * placed.along[1], placed, drag.snap);
  return patch;
}

/** A text shift as the literal it writes: undefined at the centre, "start" or "end" past an arrow, or mm. */
function textAt(shift: number, placed: DimensionPlacement, snap: boolean): number | string | undefined {
  const ends = placed.text_snaps;
  if (snap && Math.abs(shift) <= SNAP) return undefined;
  if (snap && ends && Math.abs(shift - ends.start) <= SNAP) return 'start';
  if (snap && ends && Math.abs(shift - ends.end) <= SNAP) return 'end';
  const value = clamp(half(shift), -200, 200);
  return value === 0 ? undefined : value;
}

/** A feature dimension's row with keys changed (undefined removes one). */
export function withKeys(row: Record<string, PyValue>, patch: Record<string, PyValue | undefined>): Record<string, PyValue> {
  const next: Record<string, PyValue> = { ...row };
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key]; else next[key] = value;
  return next;
}

/** `standard` as the runtime reads it: ISO, or ANSI (ASME too). */
export function standardOf(call: DrawingCall): 'ISO' | 'ANSI' {
  const value = arg(call, 'standard').value;
  return typeof value === 'string' && ['ANSI', 'ASME'].includes(value.toUpperCase()) ? 'ANSI' : 'ISO';
}

/** The sheet's units, as the runtime resolves them: `units` when it's "mm" or "in", else the standard's (ISO mm, ANSI in). */
export function unitsOf(call: DrawingCall): 'mm' | 'in' {
  const value = arg(call, 'units').value;
  if (value === 'mm' || value === 'in') return value;
  return standardOf(call) === 'ANSI' ? 'in' : 'mm';
}

/** The second unit written in brackets after each length (`dual_units`), as the runtime accepts it: the unit the
 *  sheet doesn't use, else none. */
export function dualOf(call: DrawingCall): 'mm' | 'in' | null {
  const value = arg(call, 'dual_units').value;
  return (value === 'mm' || value === 'in') && value !== unitsOf(call) ? value : null;
}

/** The sheet's name as the build reports it: `name`, else `title`, else what it draws. */
export function labelOf(call: DrawingCall, index: number): string {
  for (const key of ['name', 'title']) {
    const value = arg(call, key).value;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return index === 0 && call.source === 'result' ? 'Sheet 1' : `${call.source} (sheet ${index + 1})`;
}

/* ───────── Sheet templates ───────── */

/**
 * A sheet setup a person saved (account setting `drawing.templates`, app/account_settings.py checks the same limits).
 * It's a starting point copied into a call as literals, never a reference the build resolves: the code stays the
 * source of truth, and changing a template never changes a drawing already written.
 */
export interface DrawingTemplate {
  name: string;
  standard: 'ISO' | 'ANSI';
  sheet?: string;
  orientation?: 'landscape' | 'portrait';
  projection?: 'first' | 'third';
  units?: 'mm' | 'in';
  fields?: Record<string, string>;
  notes?: string[];
  /** The sheet's own title block layout. */
  title_block?: TitleRow[];
}

export const TEMPLATE_LIMIT = 20;
/** What a template holds, as the arguments it writes. */
export const TEMPLATE_KEYS = ['standard', 'sheet', 'orientation', 'projection', 'units', 'fields', 'notes', 'title_block'] as const;
const TEMPLATE_LISTS = 30;
const CHOICES: Record<string, readonly string[]> = {
  sheet: [...SHEET_SIZES.ISO, ...SHEET_SIZES.ANSI], orientation: ['landscape', 'portrait'], projection: ['first', 'third'], units: ['mm', 'in'],
};

const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();

/** Text as the runtime draws it (runtime/steve/drawing.py _text): one line, at most TEXT_LIMIT characters; else null. */
function line(value: PyValue | undefined): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const text = oneLine(value);
  return text.length <= TEXT_LIMIT ? text : null;
}

/** The shown sheet's setup as a template named `name` (an expression's value as the build evaluated it), and the
 *  arguments left out because they're made by a loop or aren't what a template takes. */
export function templateOf(call: DrawingCall, name: string): { template: DrawingTemplate; skipped: string[] } {
  const skipped: string[] = [];
  const template: DrawingTemplate = { name: oneLine(name).slice(0, 60), standard: standardOf(call) };
  if (!arg(call, 'standard').editable) skipped.push('standard');
  for (const key of ['sheet', 'orientation', 'projection', 'units'] as const) {
    const { raw, value } = arg(call, key);
    if (raw === undefined) continue;
    const choice = typeof value === 'string' ? (key === 'sheet' ? value.toUpperCase() : value) : undefined;
    if (choice && CHOICES[key].includes(choice)) (template as unknown as Record<string, string>)[key] = choice;
    else if (value !== null) skipped.push(key);
  }
  const fields = arg(call, 'fields');
  if (fields.raw !== undefined) {
    const entries = fields.value && typeof fields.value === 'object' && !Array.isArray(fields.value) ? Object.entries(fields.value) : null;
    const kept = (entries ?? []).map(([key, value]) => [oneLine(key).slice(0, 40), line(value)] as const).filter(([key, value]) => key && value !== null);
    if (!entries || kept.length < entries.length || kept.length > TEMPLATE_LISTS) skipped.push('fields');
    if (kept.length) template.fields = Object.fromEntries(kept.slice(0, TEMPLATE_LISTS)) as Record<string, string>;
  }
  const notes = arg(call, 'notes');
  if (notes.raw !== undefined) {
    const items = Array.isArray(notes.value) ? notes.value : typeof notes.value === 'string' ? [notes.value] : null;
    const kept = (items ?? []).map(line).filter((note): note is string => !!note);
    if (!items || kept.length < items.length || kept.length > TEMPLATE_LISTS) skipped.push('notes');
    if (kept.length) template.notes = kept.slice(0, TEMPLATE_LISTS);
  }
  const layout = arg(call, 'title_block');
  if (layout.raw !== undefined && layout.value !== null) {
    const rows = titleLayout(layout.value);
    if (rows) template.title_block = rows; else skipped.push('title_block');
  }
  return { template, skipped };
}

/**
 * The argument changes that put a template on a sheet (Python text; undefined removes one, back to its default).
 * With `call`, it's applied to that sheet: an expression is written over with the template's literal (it's an edit),
 * arguments made by a loop are left alone (listed in `skipped`), the sheet's
 * own title block fields stay unless the template sets them, its notes stay with the template's added after, and its
 * own title block layout stays unless the template has one. Views, scale, title, revisions and dimensions are never
 * touched.
 */
export function templateChanges(template: DrawingTemplate, call?: DrawingCall): { changes: Record<string, string | undefined>; skipped: string[] } {
  const asDict = (value: PyValue | undefined) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  const asNotes = (value: PyValue | undefined) => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []);
  const fields: Record<string, PyValue> = { ...(call ? asDict(arg(call, 'fields').value) : {}), ...(template.fields ?? {}) };
  const own = call ? asNotes(arg(call, 'notes').value) : [];
  const notes: PyValue[] = [...own, ...(template.notes ?? []).filter((note) => !own.includes(note))];
  const wanted: Record<string, string | undefined> = {
    standard: py(template.standard),
    sheet: template.sheet ? py(template.sheet) : undefined,
    orientation: template.orientation && template.orientation !== 'landscape' ? py(template.orientation) : undefined,
    projection: template.projection ? py(template.projection) : undefined,
    units: template.units ? py(template.units) : undefined,
    fields: Object.keys(fields).length ? py(fields) : undefined,
    notes: notes.length ? pyList(notes) : undefined,
    title_block: template.title_block?.length ? layoutText(template.title_block) : undefined,
  };
  const changes: Record<string, string | undefined> = {};
  const skipped: string[] = [];
  for (const key of TEMPLATE_KEYS) {
    if (key === 'title_block' && wanted[key] === undefined) continue;  // The sheet's own layout, or the ISO one, stays.
    if (call && !arg(call, key).editable) { skipped.push(key); continue; }
    if (wanted[key] !== undefined || (call && arg(call, key).raw !== undefined)) changes[key] = wanted[key];
  }
  // The sheet's second unit goes when the template's units become it (the runtime refuses the same unit twice).
  const current = call && !('units' in changes) ? arg(call, 'units').value : undefined;
  const units = current === 'mm' || current === 'in' ? current : template.units ?? (template.standard === 'ANSI' ? 'in' : 'mm');
  if (call && arg(call, 'dual_units').value === units && arg(call, 'dual_units').editable) Object.assign(changes, { dual_units: undefined, dual_precision: undefined });
  return { changes, skipped };
}

/* ───────── The sheet's tools: where things are on it, and the edits they write ───────── */

type Point = [number, number];

/** A view as drawn (the sheet report's `views_placed`): its box, and how model points map to the sheet (SVG frame:
 *  mm, y down; a model point p is at origin + scale·(p·x, −p·y)). */
export interface ViewOnSheet {
  view: string; kind: 'base' | 'section' | 'detail'; parent?: string; box: [number, number, number, number];
  map?: { origin: [number, number]; scale: number; x: [number, number, number]; y: [number, number, number] };
  at?: [number, number];
  /** Its centre as `position` takes it (paper mm from the lower-left corner, y up); fixed: written so. */
  position?: [number, number]; fixed?: boolean;
}

const round = (n: number, step: number) => Math.round(n / step) * step;
const clean = (n: number) => Number(n.toFixed(6));

/** The model point under sheet point `p` in a view, on the plane through the model's origin (depth along the view
 *  doesn't change a section's cutting plane or a detail's centre). */
export function toModel(view: ViewOnSheet, p: Point): [number, number, number] | null {
  const map = view.map;
  if (!map) return null;
  const u = (p[0] - map.origin[0]) / map.scale, v = -(p[1] - map.origin[1]) / map.scale;
  return [0, 1, 2].map((i) => clean(round(u * map.x[i] + v * map.y[i], 0.001))) as [number, number, number];
}

/** Where a model point is on the sheet in a view. */
export function toSheet(view: ViewOnSheet, model: [number, number, number]): Point | null {
  const map = view.map;
  if (!map) return null;
  const dot = (axis: number[]) => axis[0] * model[0] + axis[1] * model[1] + axis[2] * model[2];
  return [map.origin[0] + map.scale * dot(map.x), map.origin[1] - map.scale * dot(map.y)];
}

/** The base view next to `parent` in `direction` by the projection method (runtime/steve/drawing.py GRID: right and
 *  up are +), or undefined where the method puts none. */
const GRID: Record<'first' | 'third', Record<string, Point>> = {
  third: { front: [0, 0], top: [0, 1], bottom: [0, -1], right: [1, 0], left: [-1, 0], back: [2, 0] },
  first: { front: [0, 0], top: [0, -1], bottom: [0, 1], right: [-1, 0], left: [1, 0], back: [2, 0] },
};
export function projectedFrom(projection: 'first' | 'third', parent: string, direction: Point): string | undefined {
  const cell = GRID[projection][parent];
  if (!cell) return undefined;
  const target = [cell[0] + direction[0], cell[1] + direction[1]];
  return Object.entries(GRID[projection]).find(([, at]) => at[0] === target[0] && at[1] === target[1])?.[0];
}

/** `projection` as the runtime resolves it: as written, else first angle on ISO sheets and third on ANSI ones. */
export function projectionOf(call: DrawingCall): 'first' | 'third' {
  const value = arg(call, 'projection').value;
  return value === 'first' || value === 'third' ? value : standardOf(call) === 'ANSI' ? 'third' : 'first';
}

/** A section's `flip` for it to go on `side` of its cutting line (runtime/steve/drawing.py _section_frame: a
 *  horizontal line's section goes up, a vertical one's right, unless flipped; first angle the other way). */
export function sectionFlip(side: 'up' | 'down' | 'left' | 'right', projection: 'first' | 'third'): boolean {
  const positive = side === 'up' || side === 'right';
  return positive === (projection === 'first');
}

/** The side of a view's box a point is past, as dimensions and balloons name it (and how far past it), or null inside. */
export function sideOf(box: [number, number, number, number], p: Point): { side: 'above' | 'below' | 'left' | 'right'; past: number; corner?: string } | null {
  const [x0, y0, x1, y1] = box;
  const out = { above: y0 - p[1], below: p[1] - y1, left: x0 - p[0], right: p[0] - x1 };
  const best = (Object.entries(out) as [keyof typeof out, number][]).sort((a, b) => b[1] - a[1])[0];
  if (best[1] <= 0) return null;
  const vertical = out.above > 0 ? 'up' : out.below > 0 ? 'down' : null, horizontal = out.right > 0 ? 'right' : out.left > 0 ? 'left' : null;
  return { side: best[0], past: best[1], corner: vertical && horizontal ? `${vertical}-${horizontal}` : undefined };
}

/** A paper offset as written: half millimetres, 1 to 200 (the runtime's range). */
export const offsetMm = (value: number) => Math.min(200, Math.max(1, round(value, 0.5)));

/**
 * Where a new feature dimension goes, from where it's clicked on the sheet: `direction` for two points (horizontal
 * when it's placed above or below them, vertical beside them), `side` and `offset` for a linear one past the view's
 * box, a leader's quadrant and reach past a circle. Inside the view's box it goes where the runtime stacks it.
 */
export function dimensionPlacement(picks: { kind: string; points: Point[]; centre?: Point; radius?: number }[], box: [number, number, number, number], p: Point):
  Record<string, PyValue> {
  if (picks.length === 1 && picks[0].centre && picks[0].radius !== undefined && (picks[0].kind === 'circle')) {
    const [cx, cy] = picks[0].centre;
    const side = `${p[1] <= cy ? 'up' : 'down'}-${p[0] >= cx ? 'right' : 'left'}`;
    return { side, offset: offsetMm(Math.hypot(p[0] - cx, p[1] - cy) - picks[0].radius) };
  }
  const past = sideOf(box, p);
  const points = picks.flatMap((pick) => (pick.kind === 'vertex' || pick.kind === 'circle' ? [pick.centre ?? pick.points[0]] : []));
  const lines = picks.filter((pick) => pick.kind !== 'vertex' && pick.kind !== 'circle');
  const out: Record<string, PyValue> = {};
  if (lines.length === picks.length && lines.length === 2) {
    // Two lines: an angle unless they're parallel; parallel ones measure across, on the side they're stacked on.
    const angle = (pick: typeof lines[number]) => { const [a, b] = [pick.points[0], pick.points[pick.points.length - 1]]; return Math.atan2(b[1] - a[1], b[0] - a[0]); };
    const turn = Math.abs(Math.sin(angle(lines[0]) - angle(lines[1])));
    if (turn > 0.02) return {};
    // Horizontal lines are measured up the view (beside it), vertical ones across it (above or below).
    const sides = Math.abs(Math.cos(angle(lines[0]))) > 0.7 ? ['left', 'right'] : ['above', 'below'];
    if (past && sides.includes(past.side)) Object.assign(out, { side: past.side, offset: offsetMm(past.past) });
    return out;
  }
  if (lines.length === 1 && picks.length === 1) {
    const [a, b] = [lines[0].points[0], lines[0].points[lines[0].points.length - 1]];
    const horizontal = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    const sides = horizontal ? ['above', 'below'] : ['left', 'right'];
    if (past && sides.includes(past.side)) Object.assign(out, { side: past.side, offset: offsetMm(past.past) });
    return out;
  }
  if (points.length === picks.length && past) {
    out.direction = past.side === 'above' || past.side === 'below' ? 'horizontal' : 'vertical';
    Object.assign(out, { side: past.side, offset: offsetMm(past.past) });
  }
  return out;
}

/** Where a new balloon goes from where it's clicked: past which side (or corner) of its view, and how far. */
export function balloonPlacement(box: [number, number, number, number], p: Point): Record<string, PyValue> {
  const past = sideOf(box, p);
  if (!past) return {};
  return { side: past.corner ?? past.side, offset: offsetMm(past.past) };
}

/** A note as written: a placed one's `at` (paper mm from the sheet's lower-left corner); a leader note's view and ref
 *  (the edge, face or vertex its leader points at), its side and offset, or its `at` ((dx, dy) paper mm from the
 *  leader's tip to its shoulder). */
export interface NoteRow { text: string; at?: Point; view?: string; ref?: string; side?: string; offset?: number }

/** Whether a note is on a leader to the model (it names its view and ref). */
export const isLeaderNote = (row: string | NoteRow): row is NoteRow & { view: string; ref: string } =>
  typeof row !== 'string' && typeof row.view === 'string' && typeof row.ref === 'string';

/** Whether a note is listed (numbered in the sheet's notes): neither placed nor on a leader. */
export const isListedNote = (row: string | NoteRow): boolean => typeof row === 'string' || (!row.at && !isLeaderNote(row));

/** The sheet's notes as written: listed ones are text, placed ones `{"text": …, "at": (x, y)}`, leader notes
 *  `{"text": …, "view": …, "ref": …}` with their side, offset or at. Numbered from 1 as written, every kind. */
export function noteRows(call: DrawingCall): (string | NoteRow)[] {
  const value = arg(call, 'notes').value;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return items.map((item) => {
    if (typeof item === 'string' || typeof item === 'number') return String(item);
    const row = dictOf(item);
    const at = Array.isArray(row.at) && row.at.length === 2 && row.at.every((n) => typeof n === 'number') ? row.at as Point : undefined;
    return {
      text: typeof row.text === 'string' ? row.text : '', ...(at ? { at } : {}),
      ...(typeof row.view === 'string' ? { view: row.view } : {}), ...(typeof row.ref === 'string' ? { ref: row.ref } : {}),
      ...(typeof row.side === 'string' ? { side: row.side } : {}), ...(typeof row.offset === 'number' ? { offset: row.offset } : {}),
    };
  });
}

/** `notes` as Python (undefined when there are none), each note's keys in the order people read them. */
export function notesText(rows: (string | NoteRow)[]): string | undefined {
  const written = rows.map((row) => {
    if (typeof row === 'string') return row;
    const out: Record<string, PyValue> = { text: row.text };
    for (const key of ['view', 'ref', 'side', 'offset', 'at'] as const) if (row[key] !== undefined) out[key] = row[key] as PyValue;
    return out;
  });
  return rows.length ? pyList(written as PyValue[]) : undefined;
}

/** What a drag of a drawn leader note by (dx, dy) paper mm (y down) writes: its exact place, `at` from its leader's
 *  tip, in place of the runtime's `side` and `offset`. */
export function draggedNote(row: NoteRow, placed: { tip: [number, number]; knee: [number, number] }, drag: { dx: number; dy: number }): NoteRow {
  const next: NoteRow = { ...row, at: weldAt(placed.tip, [placed.knee[0] + drag.dx, placed.knee[1] + drag.dy]) };
  delete next.side;
  delete next.offset;
  return next;
}

/* ───────── Reordering sheets: the sheet order is the order their statements are written in ───────── */

/** A top-level statement (a block's body and its `else`/`except` parts with it, a decorated `def` with its decorators),
 *  a comment line, or a blank line, from its first character to the end of its last line (the newline left out). */
interface Unit { from: number; to: number; kind: 'code' | 'comment' | 'blank' }

/** The code's logical lines (a bracket left open, or a `\` at the end, carries one on), each to before its newline. */
function logicalLines(code: string): { from: number; to: number }[] {
  const lines: { from: number; to: number }[] = [];
  for (let i = 0; i <= code.length;) {
    let j = i, depth = 0;
    while (j < code.length) {
      const c = code[j];
      if (c === '#') { const end = code.indexOf('\n', j); j = end < 0 ? code.length : end; continue; }
      if (c === '"' || c === "'") { j = stringEnd(code, j); continue; }
      if (c === '\\' && code[j + 1] === '\n') { j += 2; continue; }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      else if (c === '\n' && depth === 0) break;
      j++;
    }
    lines.push({ from: i, to: j });
    if (j >= code.length) break;
    i = j + 1;
  }
  return lines;
}

/** The code's top-level statements, comment lines and blank lines, in order. */
function units(code: string): Unit[] {
  const lines = logicalLines(code).map(({ from, to }) => {
    const text = code.slice(from, to), trimmed = text.trim();
    return { from, to, kind: (!trimmed ? 'blank' : trimmed.startsWith('#') ? 'comment' : 'code') as Unit['kind'], indent: /^[ \t]/.test(text) };
  });
  const out: Unit[] = [];
  let pending: Unit[] = [];
  let last: Unit | null = null;
  for (const line of lines) {
    if (line.kind !== 'code') { pending.push({ from: line.from, to: line.to, kind: line.kind }); continue; }
    const text = code.slice(line.from, line.to);
    const continues = last && (line.indent || /^(?:else|elif|except|finally)\b/.test(text)
      || (/^(?:def|class|async)\b/.test(text) && code.slice(last.from, last.to).split('\n').every((part) => /^\s*(?:@|$)/.test(part))));
    if (continues) { last!.to = line.to; pending = []; continue; }
    out.push(...pending);
    pending = [];
    last = { from: line.from, to: line.to, kind: 'code' };
    out.push(last);
  }
  return [...out, ...pending];
}

const KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else except finally for from global if '
  + 'import in is lambda nonlocal not or pass raise return try while with yield').split(' '));
const IDENTIFIER = /[A-Za-z_]\w*/y;
const KEYWORD_ARGUMENT = /\s*=(?!=)/y;

/** Every name the code reads or writes, with where it is: not what's in strings (but what's in an f-string's braces) or
 *  comments, not an attribute (`part.width`), not a keyword argument's name (`notes=`). */
function mentions(code: string, offset = 0): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '#') { const end = code.indexOf('\n', i); if (end < 0) break; i = end; continue; }
    if (c === '"' || c === "'") { i = stringEnd(code, i) - 1; continue; }
    if ('([{'.includes(c)) { depth++; continue; }
    if (')]}'.includes(c)) { depth = Math.max(0, depth - 1); continue; }
    if (!/[A-Za-z_]/.test(c) || /[\w.]/.test(code[i - 1] ?? '')) continue;
    IDENTIFIER.lastIndex = i;
    const name = IDENTIFIER.exec(code)![0];
    const after = i + name.length;
    KEYWORD_ARGUMENT.lastIndex = after;
    if ((code[after] === '"' || code[after] === "'") && /^[rRbBuUfF]{1,2}$/.test(name)) {
      // A string with a prefix: an f-string's expressions are code.
      const end = stringEnd(code, after);
      if (/f/i.test(name)) {
        for (const part of code.slice(after, end).matchAll(/\{([^{}]*)\}/g)) out.push(...mentions(part[1], offset + after + part.index! + 1));
      }
      i = end - 1;
      continue;
    }
    if (!KEYWORDS.has(name) && !(depth > 0 && KEYWORD_ARGUMENT.test(code))) out.push({ name, at: offset + i });
    i = after - 1;
  }
  return out;
}

/** The names a statement assigns, imports or defines (`*` for `from … import *`), in its body too. */
function definedBy(text: string): Set<string> {
  const out = new Set<string>();
  const add = (part: string) => { for (const { name } of mentions(part)) out.add(name); };
  const bare = withoutStrings(text);
  for (const { from, to } of logicalLines(bare)) {
    const line = bare.slice(from, to).replace(/#.*/g, '').replace(/\\\n/g, ' ').replace(/\s+/g, ' ').trim();
    const named = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
    if (named) out.add(named[1]);
    const imported = /^import\s+(.+)/.exec(line)?.[1].split(',') ?? /^from\s+\S+\s+import\s+(.+)/.exec(line)?.[1].replace(/[()]/g, '').split(',') ?? [];
    for (const item of imported) if (item.trim()) out.add(/\bas\s+(\w+)/.exec(item)?.[1] ?? item.trim().split('.')[0]);
    add(/^(?:async\s+)?for\s+(.+?)\s+in\b/.exec(line)?.[1] ?? '');
    add(/^del\s+(.+)/.exec(line)?.[1] ?? '');
    for (const as of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) out.add(as[1]);
    for (const walrus of line.matchAll(/([A-Za-z_]\w*)\s*:=/g)) out.add(walrus[1]);
    // Assignments: everything before the last bare `=` at the top level (`a = b = 1`, `x += 1`, `x: int = 1`).
    let depth = 0, start = 0;
    const targets: string[] = [];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === '=' && depth === 0 && line[i + 1] !== '=' && !'=!<>:'.includes(line[i - 1] ?? '')) { targets.push(line.slice(start, i)); start = i + 1; }
    }
    for (const target of targets) add(target);
  }
  return out;
}

const MOVE_IN_CODE = 'These sheets are made in a loop, a function or an if block: reorder them in the code.';

/**
 * Each sheet's block of code, or why the sheets can't be moved: its statement, the comment lines directly above it, and
 * the statements directly above that only build it (a `dims = [...]` no other code reads). The text they read and
 * define is kept with each.
 */
function sheetBlocks(code: string): { blocks: { from: number; to: number }[]; problem?: undefined } | { problem: string } {
  const calls = drawingCalls(code);
  if (calls.some((call) => call.indent || call.loop)) return { problem: MOVE_IN_CODE };
  const all = units(code);
  const named = mentions(code);
  const blocks: { from: number; to: number }[] = [];
  for (const call of calls) {
    let index = all.findIndex((unit) => unit.kind === 'code' && unit.from === call.from);
    if (index < 0) return { problem: 'This sheet’s code can’t be moved safely: reorder it in the code.' };
    const end = all[index].to;
    let from = all[index].from;
    for (index--; index >= 0; index--) {
      const unit = all[index];
      if (unit.kind === 'blank' || (unit.kind === 'code' && calls.some((other) => other.from === unit.from))) break;
      if (unit.kind === 'code') {
        const names = definedBy(code.slice(unit.from, unit.to));
        const only = names.size > 0 && !names.has('*')
          && named.every((item) => !names.has(item.name) || (item.at >= unit.from && item.at < end));
        if (!only) break;
      }
      from = unit.from;
    }
    blocks.push({ from, to: end });
  }
  return { blocks };
}

/** Why sheet `from` can't be moved to place `to` (null when it can): sheets made in a loop or a function, code other
 *  than sheets in between, or a name one of them defines that another reads. */
export function moveProblem(code: string, from: number, to: number): string | null {
  const found = sheetBlocks(code);
  if (found.problem !== undefined) return found.problem;
  const { blocks } = found;
  if (!blocks[from] || !blocks[to]) return 'There’s no sheet there.';
  if (from === to) return null;
  const moved = blocks[from];
  const passed = from < to ? blocks.slice(from + 1, to + 1) : blocks.slice(to, from);
  const between = { from: Math.min(moved.to, passed[0].from), to: Math.max(moved.from, passed[passed.length - 1].to) };
  const inPassed = (unit: Unit) => passed.some((block) => unit.from >= block.from && unit.to <= block.to);
  if (units(code).some((unit) => unit.kind === 'code' && unit.from >= between.from && unit.to <= between.to && !inPassed(unit))) {
    return 'Other code runs between these sheets: reorder them in the code.';
  }
  const named = mentions(code);
  const read = (block: { from: number; to: number }) => new Set(named.filter((item) => item.at >= block.from && item.at < block.to).map((item) => item.name));
  const mine = read(moved), myNames = definedBy(code.slice(moved.from, moved.to));
  for (const block of passed) {
    const theirs = read(block), theirNames = definedBy(code.slice(block.from, block.to));
    if (myNames.has('*') || theirNames.has('*')) return 'These sheets import names with *: reorder them in the code.';
    const shared = [...myNames].find((name) => theirs.has(name)) ?? [...theirNames].find((name) => mine.has(name));
    if (shared) return `Another sheet uses “${shared}” from this one (or the other way round): reorder them in the code.`;
  }
  return null;
}

/** The code with sheet `from`'s block (its comments and the statements that only build it too) moved to place `to`:
 *  before the sheet there when it moves earlier, after it when later. Moving it back gives the code as it was. Unchanged
 *  when it can't be moved (moveProblem). */
export function withSheetMoved(code: string, from: number, to: number): string {
  if (from === to || moveProblem(code, from, to) !== null) return code;
  const { blocks } = sheetBlocks(code) as { blocks: { from: number; to: number }[] };
  const moved = blocks[from], target = blocks[to];
  const text = code.slice(moved.from, moved.to);
  if (from < to) {
    // It takes the line break and blank lines after it along, and puts them before itself at the end.
    const gap = /^\n(?:[ \t]*\n)*/.exec(code.slice(moved.to))![0];
    const after = moved.to + gap.length;
    return code.slice(0, moved.from) + code.slice(after, target.to) + gap + text + code.slice(target.to);
  }
  // Earlier: the line break and blank lines before it go after it.
  const gap = /\n(?:[ \t]*\n)*$/.exec(code.slice(0, moved.from))![0];
  const before = moved.from - gap.length;
  return code.slice(0, target.from) + text + gap + code.slice(target.from, before) + code.slice(moved.to);
}

/** The code with a copy of a sheet written after it, its arguments changed (Python text; undefined removes one). The
 *  copy is a statement of its own even when the original assigns the sheet to a name. */
export function withCopiedCall(code: string, call: DrawingCall, changes: Record<string, string | undefined>): string {
  const copy = callText({ ...call, head: call.indent }, changes);
  return `${code.slice(0, call.to)}\n${copy}${code.slice(call.to)}`;
}

/** A section or detail view's or base view's annotations and child views on a sheet as written, for deleting or
 *  renaming the view: every argument row that names it as its `view` or `parent`. */
const VIEW_LISTS = ['section_views', 'detail_views', 'feature_dimensions', 'datums', 'tolerance_frames', 'balloons', 'hole_tables', 'welds', 'notes'] as const;

const rowsOf = (call: DrawingCall, key: string): PyValue[] | null => {
  if (key === 'balloons') {  // A bare instance name is a row too; True (every part) names no view.
    const rows = balloonRows(call);
    return rows === null ? null : rows === 'all' ? [] : rows;
  }
  const { raw, value, editable } = arg(call, key);
  if (!editable) return null;
  if (raw === undefined || value === undefined || value === null || value === false || value === true) return [];
  return Array.isArray(value) ? value : [value];
};

/** What hangs off view `name`: its child views (and theirs), and every annotation on any of them. */
export function dependantsOf(call: DrawingCall, name: string): { views: string[]; annotations: number; readable: boolean } {
  const children = childViews(call);
  const views = [name];
  for (let grew = true; grew;) {
    grew = false;
    for (const child of children) {
      const childName = typeof child.row.name === 'string' ? child.row.name : '';
      if (childName && !views.includes(childName) && views.includes(String(child.row.parent ?? ''))) { views.push(childName); grew = true; }
    }
  }
  let annotations = 0, readable = true;
  for (const key of ['feature_dimensions', 'datums', 'tolerance_frames', 'balloons', 'hole_tables', 'welds', 'notes']) {
    const rows = rowsOf(call, key);
    if (rows === null) { readable = false; continue; }
    annotations += rows.filter((row) => views.includes(String(dictOf(row).view ?? ''))).length;
  }
  return { views: views.slice(1), annotations, readable };
}

/** The argument changes that delete view `name` from a sheet, with the views hanging off it and what's on them; null
 *  when one of those arguments is an expression the tab can't rewrite, or it's the sheet's last base view. */
export function withoutView(call: DrawingCall, name: string): Record<string, string | undefined> | null {
  const { views: gone, readable } = dependantsOf(call, name);
  if (!readable || !arg(call, 'views').editable || !arg(call, 'section_views').editable || !arg(call, 'detail_views').editable) return null;
  const all = [name, ...gone];
  const changes: Record<string, string | undefined> = {};
  const items = viewItems(call);
  if (items.some((item) => viewName(item) === name)) {
    changes.views = viewsText(items.filter((item) => viewName(item) !== name));  // The last one leaves a blank sheet.
  }
  for (const key of ['section_views', 'detail_views']) {
    const rows = rowsOf(call, key)!;
    const kept = rows.filter((row) => !all.includes(String(dictOf(row).name ?? '')));
    if (kept.length !== rows.length) changes[key] = kept.length ? pyList(kept) : undefined;
  }
  // Annotations on those views go too, and frames and datums attached to dimensions that go.
  const dims = rowsOf(call, 'feature_dimensions')!;
  const goneIds = dims.filter((row) => all.includes(String(dictOf(row).view ?? ''))).map((row) => dictOf(row).id).filter((id) => typeof id === 'string');
  for (const key of ['feature_dimensions', 'datums', 'tolerance_frames', 'balloons', 'hole_tables', 'welds', 'notes']) {  // Leader notes name their view.
    const rows = rowsOf(call, key)!;
    const kept = rows.filter((row) => !all.includes(String(dictOf(row).view ?? '')) && !goneIds.includes(dictOf(row).dimension as string));
    if (kept.length !== rows.length) changes[key] = kept.length ? (key === 'balloons' ? balloonsText(kept.map(dictOf)) : pyList(kept)) : undefined;
  }
  return changes;
}

/** The argument changes that rename section or detail view `from` to `to` everywhere the sheet names it; null when
 *  one of those arguments can't be rewritten. */
export function withViewRenamed(call: DrawingCall, from: string, to: string): Record<string, string | undefined> | null {
  const changes: Record<string, string | undefined> = {};
  for (const key of VIEW_LISTS) {
    const rows = rowsOf(call, key);
    if (rows === null) return null;
    let touched = false;
    const next = rows.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const patch: Record<string, PyValue> = {};
      for (const field of ['name', 'parent', 'view']) if (row[field] === from) patch[field] = to;
      if (!Object.keys(patch).length) return row;
      touched = true;
      return withKeys(row, patch);
    });
    if (touched) changes[key] = key === 'balloons' ? balloonsText(next.map(dictOf)) : pyList(next);
  }
  return changes;
}

/** A section or detail view's or base view's paper offset as written (`at`), or [0, 0]. */
export function atOf(value: PyValue | undefined): Point {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number') ? [value[0] as number, value[1] as number] : [0, 0];
}

/** An offset as written: half millimetres, within the runtime's ±1000; undefined at none. */
export function atValue(at: Point): PyValue | undefined {
  const [x, y] = at.map((n) => clean(Math.min(1000, Math.max(-1000, round(n, 0.5))))) as Point;
  return x === 0 && y === 0 ? undefined : [x, y];
}

/** View `name`'s paper offset as the code has it now (base, section or detail), which a drag moves on from even before
 *  the sheet is drawn again; null when it isn't written on this sheet. */
export function writtenViewAt(call: DrawingCall, name: string): Point | null {
  const item = viewItems(call).find((entry) => viewName(entry) === name);
  if (item !== undefined) return atOf(dictOf(item).at);
  const child = childViews(call).find((entry) => entry.row.name === name);
  return child ? atOf(child.row.at) : null;
}

/** A view's `position` as written: its centre on the sheet, paper mm from the lower-left corner (y up); null for none. */
export function positionOf(value: PyValue | undefined): Point | null {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number') ? [value[0] as number, value[1] as number] : null;
}

/** A position as written: half millimetres, on the paper. */
export function positionValue(position: Point): PyValue {
  return position.map((n) => clean(Math.min(10000, Math.max(0, round(n, 0.5))))) as Point;
}

/** View `name`'s position as the code has it now (base, section or detail); null when it has none. */
export function writtenViewPosition(call: DrawingCall, name: string): Point | null {
  const item = viewItems(call).find((entry) => viewName(entry) === name);
  if (item !== undefined) return positionOf(dictOf(item).position);
  const child = childViews(call).find((entry) => entry.row.name === name);
  return child ? positionOf(child.row.position) : null;
}

/** The argument changes that write each named view's (base, section or detail) settings `patches` at once; null when
 *  one can't be written (an expression), or a view isn't written on this sheet. */
export function withViewPatches(call: DrawingCall, patches: Map<string, Record<string, PyValue | undefined>>): Record<string, string | undefined> | null {
  const changes: Record<string, string | undefined> = {};
  const left = new Set(patches.keys());
  const items = viewItems(call);
  if (items.some((item) => patches.has(viewName(item)))) {
    if (!arg(call, 'views').editable) return null;
    changes.views = viewsText(items.map((item) => (patches.has(viewName(item)) ? withViewSettings(item, patches.get(viewName(item))!) : item)));
    for (const item of items) left.delete(viewName(item));
  }
  for (const key of ['section_views', 'detail_views']) {
    if (!left.size) break;
    const rows = rowsOf(call, key);
    if (rows === null) return null;
    const named = (row: PyValue) => String(dictOf(row).name ?? '');
    if (!rows.some((row) => left.has(named(row)))) continue;
    changes[key] = pyList(rows.map((row) => (left.has(named(row)) ? withKeys(dictOf(row), patches.get(named(row))!) : row)));
    for (const row of rows) left.delete(named(row));
  }
  return left.size ? null : changes;
}

/** The argument change that moves view `name` (base, section or detail) to paper offset `at` from where the sheet puts
 *  it (no longer at a fixed position); null when it can't be written (an expression), or the view isn't written on
 *  this sheet. */
export function withViewAt(call: DrawingCall, name: string, at: Point): Record<string, string | undefined> | null {
  return withViewPatches(call, new Map([[name, { at: atValue(at), position: undefined }]]));
}

/** The argument changes that fix every view drawn where it is now (`position`, which annotations and other views
 *  don't move), and the sheet's scale when it's fitted (a fixed layout keeps its scale); null when the sheet can't be
 *  written so, or every view is fixed already. */
export function withViewsFixed(call: DrawingCall, report: { scale?: string; views_placed?: ViewOnSheet[] }): Record<string, string | undefined> | null {
  const loose = (report.views_placed ?? []).filter((view) => view.position && !view.fixed);
  if (!loose.length) return null;
  const changes = withViewPatches(call, new Map(loose.map((view) => [view.view, { position: positionValue(view.position!), at: undefined }])));
  if (!changes) return null;
  const scale = arg(call, 'scale');
  if (scale.editable && scaleLabel(scale.value) === undefined) {
    const [a, b] = (report.scale ?? '').split(':').map(Number);
    if (!(a > 0 && b > 0)) return null;
    changes.scale = `(${a}, ${b})`;
  }
  return changes;
}

/**
 * A CAM document's main.py as the CAM editor reads and writes it, without the network (docs/site manufacture/cam.md).
 * Its `program = {...}` is plain Python data with shop items as names (`shop.x7`) and part targets as calls
 * (`body(part, "extrude_1")`, `faces(part, "hole.wall(0)", body="extrude_1")`), runtime/steve/cam.py. This reads that
 * literal (with where each value is in the source) and writes a changed program back by replacing only what changed:
 * every value, comment and line the edit didn't touch stays exactly as written. What isn't plain data (a variable, an
 * expression, a loop) is kept as code; the forms send the person to that line instead of guessing. Pure functions
 * (tests/cam_code_test.mjs runs them in Node).
 */

export type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
type Obj = { [key: string]: Data };

/** A value of the literal and where it is: [start, end) offsets into main.py. */
export type Node =
  | { t: 'dict'; start: number; end: number; entries: Entry[] }
  | { t: 'list'; start: number; end: number; items: Node[]; tuple: boolean }
  | { t: 'value'; start: number; end: number; value: Data }
  | { t: 'code'; start: number; end: number };
export interface Entry { start: number; key: string; keyNode: Node; value: Node }

/** A part of the program that is code rather than data: the forms leave it to the Code tab. */
export interface CodeSpot { path: string; line: number; text: string }

export interface ProgramSource {
  /** The `program = ...` value, or null when main.py doesn't make one as a literal. */
  node: Node | null;
  /** The program as data: shop items {"$shop": key}, targets as runtime/steve/cam.py makes them, code as {"$code": text}. */
  program: Obj | null;
  /** Values the forms can't edit (code), and why the program can't be read at all (`problem`). */
  code: CodeSpot[];
  problem: string | null;
  line: number;
  /** The aliases main.py imports its part and shop as (`from links import part, shop`). */
  part: string;
  shop: string;
}

const MAIN_LINE = /^program[ \t]*=[ \t]*/m;
const IDENT = /^[A-Za-z_]\w*$/;

export const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

// ── Reading ────────────────────────────────────────────────────────────────

class Reader {
  src: string;
  pos: number;
  constructor(src: string, start: number) { this.src = src; this.pos = start; }

  /** Skips spaces, newlines, comments and backslash continuations (inside brackets newlines don't matter). */
  space() {
    const src = this.src;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') this.pos++;
      else if (c === '\\' && src[this.pos + 1] === '\n') this.pos += 2;
      else if (c === '#') { while (this.pos < src.length && src[this.pos] !== '\n') this.pos++; }
      else break;
    }
  }

  peek() { this.space(); return this.src[this.pos] ?? ''; }

  /** A string literal at pos (single, double or triple quoted; r and u prefixes), or null. */
  string(): string | null {
    const src = this.src;
    const at = this.pos;
    let i = at;
    let raw = false;
    while (i < src.length && /[rRuU]/.test(src[i]) && i - at < 2) { if (/[rR]/.test(src[i])) raw = true; i++; }
    const q = src[i];
    if (q !== '"' && q !== '\'') return null;
    if (i > at && /[bBfF]/.test(src.slice(at, i))) return null;
    const triple = src.startsWith(q.repeat(3), i);
    const close = triple ? q.repeat(3) : q;
    i += close.length;
    let out = '';
    while (i < src.length) {
      if (src.startsWith(close, i)) { this.pos = i + close.length; return out; }
      const c = src[i];
      if (c === '\n' && !triple) return null;
      if (c === '\\' && !raw) {
        const n = src[i + 1];
        const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '\'': '\'', '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v', '\n': '' };
        if (n in simple) { out += simple[n]; i += 2; continue; }
        const hex = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
        if (hex && /^[0-9a-fA-F]+$/.test(src.slice(i + 2, i + 2 + hex)) && src.slice(i + 2, i + 2 + hex).length === hex) {
          out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 2 + hex), 16)); i += 2 + hex; continue;
        }
        return null;
      }
      out += c; i++;
    }
    return null;
  }

  /** Skips one expression we don't read (to the next comma or closing bracket at this depth). */
  skipExpression() {
    const src = this.src;
    let depth = 0;
    while (this.pos < src.length) {
      this.space();
      const c = src[this.pos];
      if (c === undefined) return;
      if (depth === 0 && (c === ',' || c === ')' || c === ']' || c === '}' || c === ':')) return;
      if (c === '(' || c === '[' || c === '{') { depth++; this.pos++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; this.pos++; continue; }
      if (c === '"' || c === '\'' || (/[rRuUbBfF]/.test(c) && /["']/.test(src[this.pos + 1] ?? '') )) {
        const before = this.pos;
        if (this.string() === null) { this.pos = before + 1; while (this.pos < src.length && !/["']/.test(src[this.pos])) this.pos++; this.pos++; }
        continue;
      }
      this.pos++;
    }
  }
}

const NUMBER = /-?[ \t]*(?:0[xX][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)(?![\w.])/y;
const WORD = /[A-Za-z_][\w.]*/y;
const isDelimiter = (c: string) => c === ',' || c === ')' || c === ']' || c === '}' || c === ':' || c === '';

/** Reads one value; anything that isn't plain data becomes a code node spanning the whole expression. */
function readValue(r: Reader, aliases: { part: string; shop: string }): Node {
  r.space();
  const start = r.pos;
  const node = readSimple(r, aliases);
  // A value followed by more than a delimiter (`1 + 2`, `shop.x7.name`, `x if y else z`) is an expression.
  if (node && isDelimiter(r.peek())) return node;
  r.pos = start;
  r.skipExpression();
  let end = r.pos;
  while (end > start && /\s/.test(r.src[end - 1])) end--;
  return { t: 'code', start, end };
}

function readSimple(r: Reader, aliases: { part: string; shop: string }): Node | null {
  const src = r.src;
  const start = r.pos;
  const c = src[start];
  if (c === '{') {
    r.pos++;
    const entries: Entry[] = [];
    while (true) {
      if (r.peek() === '}') { r.pos++; return { t: 'dict', start, end: r.pos, entries }; }
      const entryStart = r.pos;
      const keyNode = readValue(r, aliases);
      if (r.peek() !== ':') return null;
      r.pos++;
      const value = readValue(r, aliases);
      if (keyNode.t !== 'value' || typeof keyNode.value !== 'string') return null;   // Keys are text in a program.
      entries.push({ start: entryStart, key: keyNode.value, keyNode, value });
      const next = r.peek();
      if (next === ',') { r.pos++; continue; }
      if (next === '}') continue;
      return null;
    }
  }
  if (c === '[' || c === '(') {
    const close = c === '[' ? ']' : ')';
    r.pos++;
    const items: Node[] = [];
    let commas = 0;
    while (true) {
      if (r.peek() === close) { r.pos++; break; }
      items.push(readValue(r, aliases));
      const next = r.peek();
      if (next === ',') { r.pos++; commas++; continue; }
      if (next === close) continue;
      return null;
    }
    // `(x)` is x in brackets, not a tuple.
    if (c === '(' && items.length === 1 && commas === 0) return null;
    return { t: 'list', start, end: r.pos, items, tuple: c === '(' };
  }
  const text = r.string();
  if (text !== null) {
    let value = text;
    // Adjacent literals join ("a" "b").
    while (true) {
      const save = r.pos;
      r.space();
      const more = r.string();
      if (more === null) { r.pos = save; break; }
      value += more;
    }
    return { t: 'value', start, end: r.pos, value };
  }
  NUMBER.lastIndex = start;
  const number = NUMBER.exec(src);
  if (number) {
    r.pos = start + number[0].length;
    const value = Number(number[0].replace(/[\s_]/g, ''));
    return Number.isFinite(value) ? { t: 'value', start, end: r.pos, value } : null;
  }
  WORD.lastIndex = start;
  const word = WORD.exec(src);
  if (!word) return null;
  r.pos = start + word[0].length;
  if (word[0] === 'True' || word[0] === 'False' || word[0] === 'None') {
    return { t: 'value', start, end: r.pos, value: word[0] === 'None' ? null : word[0] === 'True' };
  }
  const parts = word[0].split('.');
  // A shop item: shop.<key>, or shop.shop["key"] for a key that isn't a name.
  if (parts[0] === aliases.shop && parts.length === 2 && parts[1] !== 'shop' && r.peek() !== '(') {
    return { t: 'value', start, end: r.pos, value: { $shop: parts[1] } };
  }
  if (parts[0] === aliases.shop && parts.length === 2 && parts[1] === 'shop' && r.peek() === '[') {
    r.pos++;
    r.space();
    const key = r.string();
    if (key === null || r.peek() !== ']') return null;
    r.pos++;
    return { t: 'value', start, end: r.pos, value: { $shop: key } };
  }
  if (parts.length === 1 && (word[0] === 'body' || word[0] === 'faces') && r.peek() === '(') return readTarget(r, word[0], start, aliases);
  return null;
}

/** body(part, "name", instances=(...)) or faces(part, "a", "b", body="name", instances=(...)), as runtime/steve/cam.py. */
function readTarget(r: Reader, fn: 'body' | 'faces', start: number, aliases: { part: string; shop: string }): Node | null {
  r.pos++;   // (
  const args: Node[] = [];
  const kwargs: Record<string, Node> = {};
  let link: string | null = null;
  while (true) {
    if (r.peek() === ')') { r.pos++; break; }
    const save = r.pos;
    const name = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(r.src.slice(r.pos));
    if (name) {
      r.pos += name[0].length;
      kwargs[name[1]] = readValue(r, aliases);
    } else if (link === null && args.length === 0) {
      const alias = /^[A-Za-z_]\w*/.exec(r.src.slice(r.pos));
      if (!alias) return null;
      r.pos += alias[0].length;
      if (!isDelimiter(r.peek())) { r.pos = save; return null; }
      link = alias[0];
    } else args.push(readValue(r, aliases));
    const next = r.peek();
    if (next === ',') { r.pos++; continue; }
    if (next === ')') continue;
    return null;
  }
  const text = (node: Node | undefined) => (node && node.t === 'value' && typeof node.value === 'string' ? node.value : null);
  const names = args.map(text);
  if (!link || names.some((item) => item === null)) return null;
  const instancesNode = kwargs.instances;
  let instances: string[] = [];
  if (instancesNode) {
    if (instancesNode.t !== 'list' || instancesNode.items.some((item) => text(item) === null)) return null;
    instances = instancesNode.items.map((item) => text(item)!);
  }
  if (Object.keys(kwargs).some((key) => key !== 'instances' && !(fn === 'faces' && key === 'body'))) return null;
  const where: Obj = instances.length ? { instances } : {};
  if (fn === 'body') {
    if (names.length !== 1) return null;
    return { t: 'value', start, end: r.pos, value: { link, ...where, body: names[0]!, kind: 'body' } };
  }
  const bodyName = text(kwargs.body);
  if (!bodyName || !names.length) return null;
  const instance = instances.join('/') || 'part';
  const named = names.map((item) => (item!.includes(':') ? item! : `${instance}:${item}`));
  return { t: 'value', start, end: r.pos, value: { link, ...where, body: bodyName, kind: 'face', names: named } };
}

/** The aliases main.py imports from links (`from links import part, shop`): `part` and `shop` unless renamed. */
function linkAliases(source: string): { part: string; shop: string } {
  const out = { part: 'part', shop: 'shop' };
  for (const match of source.matchAll(/^from\s+links\s+import\s+\(?([^)\n]+)\)?/gm)) {
    for (const item of match[1].split(',')) {
      const [name, alias] = item.trim().split(/\s+as\s+/);
      if (name === 'part' || name === 'shop') out[name] = (alias ?? name).trim();
    }
  }
  return out;
}

function dataOf(node: Node, path: string, source: string, code: CodeSpot[]): Data {
  if (node.t === 'value') return node.value;
  if (node.t === 'code') {
    const text = source.slice(node.start, node.end);
    code.push({ path, line: lineAt(source, node.start), text });
    return { $code: text };
  }
  if (node.t === 'list') return node.items.map((item, index) => dataOf(item, `${path}[${index}]`, source, code));
  const out: Obj = {};
  for (const entry of node.entries) out[entry.key] = dataOf(entry.value, `${path}.${entry.key}`, source, code);
  return out;
}

/** main.py's program as data, with where it is. */
export function readProgram(source: string): ProgramSource {
  const aliases = linkAliases(source);
  const empty = { node: null, program: null, code: [], ...aliases };
  const match = MAIN_LINE.exec(source);
  if (!match) return { ...empty, problem: 'main.py doesn’t make `program = {...}`.', line: 1 };
  const at = match.index + match[0].length;
  const line = lineAt(source, match.index);
  const r = new Reader(source, at);
  // At the top level a line ends the statement: the literal, then nothing but a comment on its last line.
  const node = source[at] === '{' ? readSimple(r, aliases) : null;
  const tail = node ? /^[ \t]*(#.*)?(\n|$)/.test(source.slice(node.end)) : false;
  if (!node || node.t !== 'dict' || !tail) return { ...empty, problem: 'The program isn’t written as one `{...}` literal here.', line };
  // Anything after the literal that changes `program` would make what the forms show wrong.
  const rest = source.slice(node.end).replace(/#.*$/gm, (comment) => ' '.repeat(comment.length));
  const later = /\bprogram\b/.exec(rest);
  if (later) return { ...empty, node, problem: 'main.py changes `program` after writing it.', line: lineAt(source, node.end + later.index) };
  const code: CodeSpot[] = [];
  const program = dataOf(node, 'program', source, code) as Obj;
  return { node, program, code, problem: null, line, ...aliases };
}

/** The code spots inside one part of the program (`program.operations[2]`, …). */
export const codeIn = (spots: CodeSpot[], path: string) => spots.filter((spot) => spot.path === path || spot.path.startsWith(`${path}.`) || spot.path.startsWith(`${path}[`));

// ── Comparing ──────────────────────────────────────────────────────────────

const isObj = (value: Data | undefined): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
/** A target or fixture body without its instances (`[]` and absent mean the same: the part itself). */
function normal(value: Data): Data {
  if (Array.isArray(value)) return value.map(normal);
  if (!isObj(value)) return value;
  if ('$shop' in value) return { $shop: value.$shop };
  const out: Obj = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'instances' && Array.isArray(item) && !item.length && 'link' in value) continue;
    out[key] = normal(item);
  }
  return out;
}
export function same(a: Data | undefined, b: Data | undefined): boolean {
  return JSON.stringify(sortKeys(normal(a ?? null))) === JSON.stringify(sortKeys(normal(b ?? null)));
}
/**
 * Whether a build's program is the one the forms meant: `built` (the CAM build's metadata.program) equals `meant`,
 * except where `meant` is code ({"$code": text}), which the forms never change and can't evaluate, and numbers within
 * the precision main.py is written with. A misread of main.py
 * shows up here instead of being saved.
 */
export function builtAsMeant(meant: Data, built: Data): boolean {
  if (isObj(meant) && '$code' in meant) return true;
  if (Array.isArray(meant)) return Array.isArray(built) && built.length === meant.length && meant.every((item, i) => builtAsMeant(item, built[i]));
  if (isObj(meant) && !('$shop' in meant)) {
    if (!isObj(built)) return false;
    const a = normal(meant) as Obj;
    const b = normal(built) as Obj;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => key in a && key in b && builtAsMeant(meant[key] ?? a[key], built[key] ?? b[key]));
  }
  // Numbers are written with 12 significant digits (pyNumber): 3° as 0.0523598775598 is the angle the form meant.
  if (typeof meant === 'number' && typeof built === 'number') return Math.abs(meant - built) <= 1e-10 * Math.max(1, Math.abs(meant));
  return same(meant, built);
}
function sortKeys(value: Data): Data {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObj(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

// ── Writing ────────────────────────────────────────────────────────────────

const pyString = (value: string) => JSON.stringify(value);
const pyNumber = (value: number) => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12))));

/** A value as Python, at `indent` (the column its line starts at). */
export function printValue(value: Data, indent = '', aliases = { part: 'part', shop: 'shop' }): string {
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return pyNumber(value);
  if (typeof value === 'string') return pyString(value);
  const inner = `${indent}    `;
  if (Array.isArray(value)) {
    const items = value.map((item) => printValue(item, inner, aliases));
    const flat = `[${items.join(', ')}]`;
    if (flat.length + indent.length <= 110 && !flat.includes('\n')) return flat;
    return `[\n${items.map((item) => `${inner}${item},`).join('\n')}\n${indent}]`;
  }
  if (typeof value.$code === 'string' && Object.keys(value).length === 1) return value.$code;
  if (typeof value.$shop === 'string') return IDENT.test(value.$shop) && value.$shop !== 'shop' ? `${aliases.shop}.${value.$shop}` : `${aliases.shop}.shop[${pyString(value.$shop)}]`;
  const target = printTarget(value, aliases);
  if (target) return target;
  const entries = Object.entries(value).map(([key, item]) => `${pyString(key)}: ${printValue(item, inner, aliases)}`);
  const flat = `{${entries.join(', ')}}`;
  if (flat.length + indent.length <= 110 && !flat.includes('\n')) return flat;
  return `{\n${entries.map((item) => `${inner}${item},`).join('\n')}\n${indent}}`;
}

/** body(part, …) / faces(part, …) for a target the runtime's helpers make; null for anything else (written as a dict). */
function printTarget(value: Obj, aliases: { part: string; shop: string }): string | null {
  const keys = Object.keys(value).filter((key) => !(key === 'instances' && Array.isArray(value.instances) && !value.instances.length));
  if (value.link !== 'part' && value.link !== aliases.part) return null;
  if (typeof value.body !== 'string') return null;
  const instances = Array.isArray(value.instances) ? value.instances as Data[] : [];
  if (instances.some((item) => typeof item !== 'string')) return null;
  const where = instances.length ? `, instances=(${instances.map((item) => pyString(item as string)).join(', ')}${instances.length === 1 ? ',' : ''})` : '';
  const link = aliases.part;
  if (value.kind === 'body' && keys.every((key) => ['link', 'instances', 'body', 'kind'].includes(key))) return `body(${link}, ${pyString(value.body)}${where})`;
  if (value.kind === 'face' && Array.isArray(value.names) && value.names.length && value.names.every((name) => typeof name === 'string')
    && keys.every((key) => ['link', 'instances', 'body', 'kind', 'names'].includes(key))) {
    const instance = (instances as string[]).join('/') || 'part';
    const names = (value.names as string[]).map((name) => (name.startsWith(`${instance}:`) ? name.slice(instance.length + 1) : name));
    // A name qualified by another instance can't go through faces(): that stays a dict.
    if (names.some((name) => name.includes(':'))) return null;
    return `faces(${link}, ${names.map(pyString).join(', ')}, body=${pyString(value.body)}${where})`;
  }
  return null;
}

interface Edit { start: number; end: number; text: string }

const indentOf = (source: string, offset: number) => {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
};
const multiline = (source: string, node: Node) => source.slice(node.start, node.end).includes('\n');
/** The offset just after a node and the comma that follows it, if one does. */
function afterComma(source: string, end: number): { end: number; comma: boolean } {
  const r = new Reader(source, end);
  if (r.peek() === ',') return { end: r.pos + 1, comma: true };
  return { end, comma: false };
}
/**
 * Removing every element after the last kept one (which ends at `keptEnd`, a comma after it) through the last element
 * (ending at `lastEnd`) and its comma: one edit, however many go. The kept one keeps its comma when the last had one,
 * or when new elements are written after it (at the end of its comma).
 */
function removeTail(source: string, keptEnd: number, lastEnd: number, insertAfter: boolean): Edit {
  const kept = afterComma(source, keptEnd);
  const tail = afterComma(source, lastEnd);
  return { start: tail.comma || insertAfter ? kept.end : keptEnd, end: tail.end, text: '' };
}

/** The edits that turn `node` (as written) into `value`, keeping everything that didn't change as it is. */
function editsFor(source: string, node: Node, value: Data, aliases: { part: string; shop: string }): Edit[] {
  if (node.t !== 'code' && same(dataOf(node, '', source, []), value)) return [];
  if (node.t === 'code' && isObj(value) && value.$code === source.slice(node.start, node.end)) return [];
  const replace = (): Edit[] => [{ start: node.start, end: node.end, text: printValue(value, indentOf(source, node.start), aliases) }];
  if (node.t === 'dict' && isObj(value) && !('$shop' in value) && !(typeof value.link === 'string' && typeof value.kind === 'string') && node.entries.length) {
    const edits: Edit[] = [];
    const keys = Object.keys(value);
    const kept = node.entries.filter((entry) => keys.includes(entry.key));
    if (!kept.length) return replace();
    const last = kept[kept.length - 1];
    const lastIndex = node.entries.indexOf(last);
    const added = keys.filter((key) => !node.entries.some((entry) => entry.key === key));
    const lines = multiline(source, node);
    node.entries.forEach((entry, index) => {
      if (keys.includes(entry.key)) { edits.push(...editsFor(source, entry.value, value[entry.key], aliases)); return; }
      // Removed before a kept one: the entry and its comma, up to the next entry.
      if (index < lastIndex) edits.push({ start: entry.start, end: node.entries[index + 1].start, text: '' });
    });
    // Removed after the last kept one: all of them in one edit, so the kept one becomes the last.
    if (lastIndex < node.entries.length - 1) {
      edits.push(removeTail(source, last.value.end, node.entries[node.entries.length - 1].value.end, lines && added.length > 0));
    }
    if (added.length) {
      const tail = afterComma(source, last.value.end);
      const indent = lines ? indentOf(source, last.start) : indentOf(source, node.start);
      const text = added.map((key) => `${pyString(key)}: ${printValue(value[key], lines ? indent : `${indent}    `, aliases)}`);
      edits.push(lines
        ? { start: tail.end, end: tail.end, text: `${tail.comma ? '' : ','}${text.map((item) => `\n${indent}${item}${tail.comma ? ',' : ''}`).join(tail.comma ? '' : ',')}` }
        : { start: last.value.end, end: last.value.end, text: `, ${text.join(', ')}` });
    }
    return edits;
  }
  if (node.t === 'list' && Array.isArray(value)) {
    const ids = (items: Data[]) => items.map((item) => (isObj(item) && typeof item.id === 'string' ? item.id : null));
    const before = node.items.map((item) => (item.t === 'dict' ? item.entries.find((entry) => entry.key === 'id') : undefined))
      .map((entry) => (entry && entry.value.t === 'value' && typeof entry.value.value === 'string' ? entry.value.value : null));
    const after = ids(value);
    const keyed = before.length > 0 && before.every((id) => id !== null) && after.every((id) => id !== null) && new Set(after).size === after.length;
    if (!keyed) {
      // Positions: same length, edit in place; otherwise the list is written anew.
      if (node.items.length === value.length && node.items.length) return node.items.flatMap((item, index) => editsFor(source, item, value[index], aliases));
      return replace();
    }
    const order = after.filter((id) => before.includes(id));
    const keptOrder = before.filter((id) => after.includes(id));
    if (order.join('\u0000') !== keptOrder.join('\u0000')) return rewriteList(source, node, value, before as string[], aliases);
    // Nothing kept (or nothing there yet): the list is written anew.
    if (!order.length) return replace();
    const edits: Edit[] = [];
    const lines = multiline(source, node);
    const lastId = order[order.length - 1];
    const lastIndex = before.indexOf(lastId);
    // Removed elements first (with their comma), then changed ones in place, then new ones where they go.
    node.items.forEach((item, index) => {
      const id = before[index]!;
      const at = after.indexOf(id);
      if (at >= 0) { edits.push(...editsFor(source, item, value[at], aliases)); return; }
      // Removed before a kept one: the element and its comma, up to the next element.
      if (index < lastIndex) edits.push({ start: item.start, end: node.items[index + 1].start, text: '' });
    });
    // Removed after the last kept one: all of them in one edit, so the kept one becomes the last.
    if (lastIndex < node.items.length - 1) {
      const insertAfter = lines && after.slice(after.indexOf(lastId) + 1).length > 0;
      edits.push(removeTail(source, node.items[lastIndex].end, node.items[node.items.length - 1].end, insertAfter));
    }
    const itemIndent = indentOf(source, node.items[0].start);
    // Each new element goes after the element before it in the new order (or first).
    after.forEach((id, index) => {
      if (before.includes(id)) return;
      const text = printValue(value[index], itemIndent, aliases);
      const previousId = after.slice(0, index).reverse().find((other) => before.includes(other));
      if (previousId === undefined) {
        const first = node.items[0];
        edits.push({ start: first.start, end: first.start, text: lines ? `${text},\n${itemIndent}` : `${text}, ` });
        return;
      }
      const anchor = node.items[before.indexOf(previousId)];
      const tail = afterComma(source, anchor.end);
      edits.push(lines
        ? { start: tail.end, end: tail.end, text: `${tail.comma ? '' : ','}\n${itemIndent}${text}${tail.comma ? ',' : ''}` }
        : { start: anchor.end, end: anchor.end, text: `, ${text}` });
    });
    return edits;
  }
  return replace();
}

/** A list of id'd elements in a new order: each kept element's own text (with its edits), the new ones printed. */
function rewriteList(source: string, node: Extract<Node, { t: 'list' }>, value: Data[], before: string[], aliases: { part: string; shop: string }): Edit[] {
  const lines = multiline(source, node);
  const indent = node.items.length ? indentOf(source, node.items[0].start) : `${indentOf(source, node.start)}    `;
  const texts = value.map((item) => {
    const id = isObj(item) ? item.id : null;
    const at = typeof id === 'string' ? before.indexOf(id) : -1;
    if (at < 0) return printValue(item, indent, aliases);
    return patched(source, node.items[at], item, aliases);
  });
  const open = node.tuple ? '(' : '[';
  const close = node.tuple ? ')' : ']';
  const text = lines ? `${open}\n${texts.map((item) => `${indent}${item},`).join('\n')}\n${indentOf(source, node.start)}${close}` : `${open}${texts.join(', ')}${close}`;
  return [{ start: node.start, end: node.end, text }];
}
/** A node's own text with its edits applied (they all fall inside it). */
function patched(source: string, node: Node, value: Data, aliases: { part: string; shop: string }): string {
  const edits = editsFor(source, node, value, aliases);
  const grow = edits.reduce((total, edit) => total + edit.text.length - (edit.end - edit.start), 0);
  return applyEdits(source, edits).slice(node.start, node.end + grow);
}

/** The edits applied from the end back, on the original offsets; edits that overlap are refused, never applied. */
function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  let limit = source.length;
  for (const edit of sorted) {
    if (edit.end > limit) throw new Error('This change couldn’t be written into main.py. Make it in the program’s Code instead.');
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    limit = edit.start;
  }
  return out;
}

/**
 * main.py with its program changed to `program` (as data, the way readProgram gives it): only the values that differ
 * are rewritten. Throws when main.py has no program literal to change.
 */
export function writeProgram(source: string, program: Obj): string {
  const read = readProgram(source);
  if (!read.node || read.node.t !== 'dict') throw new Error(read.problem ?? 'main.py has no program to change.');
  return applyEdits(source, editsFor(source, read.node, program, { part: read.part, shop: read.shop }));
}

// ── A new CAM document ─────────────────────────────────────────────────────

/** The main.py a new CAM program starts as: its part and shop linked, nothing to cut yet (the Setup tool adds it). */
export function newCamMain(name: string, partName: string): string {
  const doc = `${partName.replace(/"""/g, '')} machined in your shop.`;
  return `"""${doc}"""
from links import part, shop
from steve.cam import body, faces

program = {
    "name": ${pyString(name)},
    "setups": [],
    "operations": [],
}
`;
}

// ── The CAM editor's programs ──────────────────────────────────────────────

/** A library record pin, as the program store's programs pin them. */
export interface Pin { id: string; revision: number; kind: string; sha256: string }
/** The program as the existing CAM editor works on it (the program store's format: aliases and pins). */
export interface EditorProgram {
  version: 1; units?: 'mm'; name: string;
  designs: { alias: string; pin: { document_id: string; branch?: string; revision: number; overrides?: Record<string, number> } }[];
  libraries: { alias: string; pin: Pin }[];
  setups: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}

/** Where a program names library items: a setup's machine, tooling, post and material; an operation's tool and preset. */
const SETUP_REFS = ['machine', 'tooling', 'machining_material'];
const STRATEGY_REFS = ['tool', 'cutting_preset'];

/**
 * The CAM document's program in the editor's format: each shop item named by its key as the alias, pinned to the
 * latest library record the shop saved it as (`pins`; one the shop hasn't saved stays named, without a pin), and the
 * part link as the design.
 */
export function editorProgram(program: Obj, pins: Record<string, Pin>, part: { document_id: string; revision: number } | null): EditorProgram {
  const libraries: EditorProgram['libraries'] = [];
  const alias = (value: Data | undefined): Data | undefined => {
    if (!isObj(value) || typeof value.$shop !== 'string') return value;
    const key = value.$shop;
    if (pins[key] && !libraries.some((item) => item.alias === key)) libraries.push({ alias: key, pin: pins[key] });
    return key;
  };
  const setups = (Array.isArray(program.setups) ? program.setups : []).map((setup) => {
    if (!isObj(setup)) return setup as unknown as Record<string, unknown>;
    const out: Obj = { ...setup };
    for (const key of SETUP_REFS) if (key in out) out[key] = alias(out[key]) as Data;
    if (isObj(out.post)) out.post = { ...out.post, library: alias(out.post.library) as Data };
    return out as Record<string, unknown>;
  });
  const operations = (Array.isArray(program.operations) ? program.operations : []).map((op) => {
    if (!isObj(op) || !isObj(op.strategy)) return op as unknown as Record<string, unknown>;
    const strategy: Obj = { ...op.strategy };
    for (const key of STRATEGY_REFS) if (key in strategy) strategy[key] = alias(strategy[key]) as Data;
    return { ...op, strategy } as Record<string, unknown>;
  });
  return {
    version: 1, units: 'mm', name: typeof program.name === 'string' ? program.name : 'CAM program',
    designs: part ? [{ alias: 'part', pin: { document_id: part.document_id, branch: 'main', revision: part.revision, overrides: {} } }] : [],
    libraries, setups, operations,
  };
}

/** Why a program can't be written back: an item it names isn't one of the shop's. */
export class ShopItemMissing extends Error {
  field: string;
  pin: Pin;
  constructor(field: string, pin: Pin) { super('not in the shop'); this.field = field; this.pin = pin; }
}

/**
 * The editor's program as the CAM document's: aliases back to shop item names (`keyOf` gives a library record's key in
 * the linked shop), the part link's targets as body()/faces(), and the designs and pins left to the run (it resolves
 * them). Everything else of `original` the editor doesn't know stays.
 */
export function camProgram(program: EditorProgram, keyOf: (id: string) => string | null, original: Obj = {}): Obj {
  const pins = new Map(program.libraries.map((item) => [item.alias, item.pin]));
  const ref = (value: unknown, field: string): Data => {
    if (typeof value !== 'string') return value as Data;
    const pin = pins.get(value);
    if (!pin) return { $shop: value };   // Named in the code already (the editor kept it as it was).
    const key = keyOf(pin.id);
    if (!key) throw new ShopItemMissing(field, pin);
    return { $shop: key };
  };
  const target = (value: unknown): Data => {
    if (!isObj(value as Data)) return value as Data;
    const out: Obj = { ...(value as Obj) };
    if (Array.isArray(out.instances) && !out.instances.length) delete out.instances;
    return out;
  };
  const setups = program.setups.map((setup) => {
    const out: Obj = { ...(setup as Obj) };
    for (const key of SETUP_REFS) if (key in out) out[key] = ref(out[key], key === 'machining_material' ? 'material' : key);
    if (isObj(out.post)) out.post = { ...out.post, library: ref(out.post.library, 'post') };
    if (Array.isArray(out.fixtures)) out.fixtures = out.fixtures.map((fixture) => (isObj(fixture) ? { ...fixture, geometry: target(fixture.geometry) } : fixture));
    if (isObj(out.stock_inspection) && Array.isArray(out.stock_inspection.expected)) out.stock_inspection = { ...out.stock_inspection, expected: out.stock_inspection.expected.map(target) };
    return out;
  });
  const operations = program.operations.map((op) => {
    const out: Obj = { ...(op as Obj) };
    if (isObj(out.strategy)) {
      const strategy: Obj = { ...out.strategy };
      for (const key of STRATEGY_REFS) if (key in strategy) strategy[key] = ref(strategy[key], key === 'cutting_preset' ? 'feeds' : key);
      out.strategy = strategy;
    }
    if (Array.isArray(out.targets)) out.targets = out.targets.map(target);
    return out;
  });
  const { designs: _designs, libraries: _libraries, version: _version, units: _units, ...rest } = program;
  const kept: Obj = {};
  for (const [key, value] of Object.entries(original)) if (!['name', 'setups', 'operations'].includes(key)) kept[key] = value;
  return { ...kept, ...(rest as unknown as Obj), name: program.name, setups, operations };
}

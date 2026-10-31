/**
 * The shop as the Manufacture workspace shows and edits it, without the network: what a shop build's records say
 * (machine cards, tool tables) and the code edits its forms make. Every form writes the shop document's Python (a
 * file, an argument of an item's call, an import); building the saved shop then updates the library. Nothing here
 * writes library records. Pure functions (tests/shop_ui_test.mjs runs them in Node).
 */

/** One item of a shop build (runtime/steve/shop.py records): references to other items are {"$ref": key}. */
export interface ShopItem { key: string; kind: string; definition: Record<string, unknown>; file: string; line: number }
export interface LinkPin { document_id: string; revision: number | null }
export interface ShopSource { code: string; files: Record<string, string>; links: Record<string, LinkPin> }

export interface ItemRef { key: string; name: string; file: string; line: number }
export interface ControllerInfo extends ItemRef { dialect: string; executable: boolean }
export interface MachineCard extends ItemRef {
  model: (ItemRef & { description: string }) | null;
  controller: ControllerInfo | null;
  spindle: { interface: string; maxRpm: number } | null;
  changer: { mode: string; pockets: number };
  travel: [number, number, number] | null;
}
export interface ToolRow {
  number: number; tool: (ItemRef & { stickout: number | null }) | null; holder: string; cutter: string; diameter: number | null;
}
export interface ToolTable extends ItemRef { rows: ToolRow[] }
export interface ShopView { machines: MachineCard[]; controllers: ControllerInfo[]; toolSetups: ToolTable[]; counts: Record<string, number> }

const MAIN = 'main.py';
const refOf = (value: unknown): string | null => {
  const ref = value && typeof value === 'object' ? (value as { $ref?: unknown }).$ref : undefined;
  return typeof ref === 'string' ? ref : null;
};
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const itemRef = (item: ShopItem): ItemRef => ({ key: item.key, name: text(item.definition.name, item.key), file: item.file, line: item.line });

/** X, Y and Z travel of a machine model's linear axes (mm), when it has all three. */
function travelOf(definition: Record<string, unknown>): [number, number, number] | null {
  const nodes = Array.isArray(definition.nodes) ? definition.nodes as { id?: string; kind?: string; limits?: { minimum?: number; maximum?: number } | null }[] : [];
  const span = (id: string) => {
    const node = nodes.find((item) => item.id === id && item.kind === 'linear' && item.limits);
    return node ? (num(node.limits!.maximum) ?? 0) - (num(node.limits!.minimum) ?? 0) : null;
  };
  const [x, y, z] = [span('X'), span('Y'), span('Z')];
  return x !== null && y !== null && z !== null ? [x, y, z] : null;
}

/** Machine cards, controllers and tool tables from a shop build's records. `executable`: dialects Steve posts. */
export function shopView(records: ShopItem[], executable: ReadonlySet<string> | string[]): ShopView {
  const posts = executable instanceof Set ? executable : new Set(executable as string[]);
  const byKey = new Map(records.map((item) => [item.key, item]));
  const get = (value: unknown) => { const key = refOf(value); return key ? byKey.get(key) ?? null : null; };
  const controllerInfo = (item: ShopItem): ControllerInfo => {
    const dialect = text(item.definition.dialect);
    return { ...itemRef(item), dialect, executable: posts.has(dialect) };
  };
  const machines = records.filter((item) => item.kind === 'machine_instance').map((item): MachineCard => {
    const model = get(item.definition.model);
    const controller = get(item.definition.controller);
    const definition = model?.definition ?? {};
    const spindle = Array.isArray(definition.spindles) ? (definition.spindles as Record<string, unknown>[])[0] : undefined;
    const change = (definition.tool_change ?? {}) as { mode?: unknown; stations?: unknown };
    return {
      ...itemRef(item),
      model: model ? { ...itemRef(model), description: text(model.definition.description) } : null,
      controller: controller ? controllerInfo(controller) : null,
      spindle: spindle ? { interface: text(spindle.interface), maxRpm: num(spindle.max_rpm) ?? 0 } : null,
      changer: { mode: text(change.mode, 'manual'), pockets: Array.isArray(change.stations) ? change.stations.length : 0 },
      travel: travelOf(definition),
    };
  });
  const controllers = records.filter((item) => item.kind === 'controller').map(controllerInfo);
  const toolSetups = records.filter((item) => item.kind === 'tool_setup').map((item): ToolTable => {
    const assignments = Array.isArray(item.definition.assignments) ? item.definition.assignments as Record<string, unknown>[] : [];
    const rows = assignments.map((assignment): ToolRow => {
      const tool = get(assignment.assembly);
      const cutter = tool ? get(tool.definition.cutter) : null;
      const holders = tool && Array.isArray(tool.definition.holders) ? tool.definition.holders as { holder?: unknown }[] : [];
      return {
        number: num(assignment.tool_number) ?? 0,
        tool: tool ? { ...itemRef(tool), stickout: num(tool.definition.stickout_mm) } : null,
        holder: holders.map((use) => { const holder = get(use.holder); return holder ? text(holder.definition.name, holder.key) : ''; }).filter(Boolean).join(' + '),
        cutter: cutter ? text(cutter.definition.name, cutter.key) : '',
        diameter: cutter ? num(cutter.definition.diameter_mm) : null,
      };
    }).sort((a, b) => a.number - b.number);
    return { ...itemRef(item), rows };
  });
  const counts: Record<string, number> = {};
  for (const item of records) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return { machines, controllers, toolSetups, counts };
}

// ── Code edits ─────────────────────────────────────────────────────────────

/** A Python string literal for any text. */
export const pyString = (value: string) => JSON.stringify(value);
/** An item of a linked shop as Python: `catalogue.haas_vf2`, or `catalogue.shop["key"]` for a key that isn't a name. */
const linkedItem = (alias: string, key: string) => (/^[A-Za-z_]\w*$/.test(key) ? `${alias}.${key}` : `${alias}.shop[${pyString(key)}]`);
/** One line of text for a comment. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

/** A key nothing in the shop uses yet: lowercase letters, digits and _, from a name ("Haas VF-2" → haas_vf_2). */
export function freeKey(name: string, taken: Iterable<string>, suffixes: string[] = [], prefix = 'm'): string {
  const used = new Set(taken);
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
  if (!/^[a-z]/.test(base)) base = `${prefix}_${base}`;
  const free = (key: string) => key !== 'shop' && !used.has(key) && suffixes.every((suffix) => !used.has(`${key}_${suffix}`));
  let key = base;
  for (let n = 2; !free(key); n++) key = `${base}_${n}`;
  return key;
}

/** Inserts `line` after main.py's last top-level import (or at the top). Nothing when it's already there. */
export function withImport(source: string, line: string): string {
  const lines = source.replace(/\n$/, '').split('\n');
  if (lines.some((item) => item.trim() === line)) return source;
  let last = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/^(from|import) /.test(lines[index])) {
      last = index;
      // A parenthesised import continues to its closing parenthesis.
      if (lines[index].includes('(') && !lines[index].includes(')')) while (last + 1 < lines.length && !lines[last].includes(')')) last++;
    }
  }
  lines.splice(last + 1, 0, line);
  return `${lines.join('\n')}\n`;
}

/** main.py with `shop.add(name)` (and its import), as create_shop_item writes it. */
export function withShopAdd(main: string, module: string, name: string): string {
  let next = withImport(main.trim() ? main : 'from steve.shop import *  # noqa: F403\n\nshop = Shop()\n', `from ${module} import ${name}`);
  if (!/^\s*shop\s*=\s*Shop\(/m.test(next)) next = `${next.replace(/\n*$/, '\n')}shop = Shop()\n`;
  if (!new RegExp(String.raw`^shop\.add\(\s*${name}\s*\)`, 'm').test(next)) next = `${next.replace(/\n*$/, '\n')}shop.add(${name})\n`;
  return next;
}

const RESERVED_ALIASES = new Set(['shop', 'steve', 'params', 'links', 'machines', 'controllers', 'tools', 'tool_setups']);

/**
 * Links another shop (pinned to `revision`) from this shop: the link and `from links import <alias>` in main.py, as
 * MCP link_design does for a shop. A shop already linked keeps its alias and moves to `revision`. Returns the alias.
 */
export function withShopLink(source: ShopSource, documentId: string, name: string, revision: number, preferred?: string): { source: ShopSource; alias: string } {
  const links = { ...source.links };
  let alias = Object.keys(links).find((key) => links[key].document_id === documentId);
  if (!alias) {
    const base = (preferred ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'l_$1').slice(0, 40) || 'linked';
    alias = base;
    for (let n = 2; links[alias] || RESERVED_ALIASES.has(alias); n++) alias = `${base}_${n}`;
  }
  links[alias] = { document_id: documentId, revision };
  const code = new RegExp(String.raw`^\s*from\s+links\s+import\b.*\b${alias}\b`, 'm').test(source.code) ? source.code : withImport(source.code, `from links import ${alias}`);
  return { source: { ...source, code, links }, alias };
}

/** A catalogue item to clone: its key in the catalogue and its name. */
export interface CatalogueItem { key: string; name: string }

/**
 * "Use this machine": the catalogue machine model cloned into machines/<key>.py with the machine itself, fitted with a
 * controller: one of the shop's own (`{key, file, variable}`) or a catalogue controller, cloned once into
 * controllers/<its key>.py (reused when the shop already has that file). main.py imports and adds the machine. `alias`
 * is the catalogue's link alias (withShopLink). Returns the machine's key too.
 */
export function withCatalogueMachine(source: ShopSource, options: {
  alias: string; model: CatalogueItem; name: string; taken: Iterable<string>;
  controller: { catalogue: CatalogueItem } | { shop: { variable: string; module: string | null } };
}): { source: ShopSource; key: string } {
  const files = { ...source.files };
  const taken = new Set(options.taken);
  for (const path of Object.keys(files)) { const match = /^(?:machines|controllers)\/([a-z][a-z0-9_]*)\.py$/.exec(path); if (match) taken.add(match[1]); }
  const key = freeKey(options.name, taken, ['model']);
  taken.add(key).add(`${key}_model`);
  let fitted = 'catalogue' in options.controller ? null : options.controller.shop;
  if ('catalogue' in options.controller) {
    const cloned = withCatalogueController({ ...source, files }, options.alias, options.controller.catalogue, taken);
    Object.assign(files, cloned.source.files);
    fitted = cloned.controller;
  }
  const control = fitted!.variable;
  const controlImport = fitted!.module ? `from ${fitted!.module} import ${control}\n` : '';
  files[`machines/${key}.py`] = `# ${oneLine(options.name)}: ${oneLine(options.model.name)} from Steve's catalogue. Change what yours has in the clone,\n`
    + `# e.g. spindle={"max_rpm": 10_000} or tool_change=Changer.magazine(pockets=10, interface="bt30").\n`
    + `from links import ${options.alias}\nfrom steve.shop import *  # noqa: F403\n${controlImport}\n`
    + `${key}_model = ${linkedItem(options.alias, options.model.key)}.clone(${pyString(`${key}_model`)}, ${pyString(options.model.name)})\n`
    + `${key} = Machine(${pyString(key)}, ${pyString(options.name)}, model=${key}_model, controller=${control})\n`;
  return { source: { ...source, files, code: withShopAdd(source.code, `machines.${key}`, key) }, key };
}

/**
 * A catalogue controller cloned into controllers/<its key>.py, once: a shop that has that file already reuses it; a
 * shop item already keyed like it (written by hand elsewhere) keeps its key and the clone gets another. Returns how to
 * import it.
 */
export function withCatalogueController(source: ShopSource, alias: string, item: CatalogueItem, taken: Iterable<string>):
  { source: ShopSource; controller: { module: string; variable: string } } {
  const cloned = withCatalogueClone(source, alias, item, taken, 'controllers', "set what your control's configuration says (work offsets, options)");
  return { source: cloned.source, controller: cloned.item };
}

/** A catalogue holder cloned into tools/<its key>.py, once (as withCatalogueController). Returns how to import it. */
export function withCatalogueHolder(source: ShopSource, alias: string, item: CatalogueItem, taken: Iterable<string>):
  { source: ShopSource; holder: { module: string; variable: string } } {
  const cloned = withCatalogueClone(source, alias, item, taken, 'tools', "enter your holder's drawing values for collision checks you rely on");
  return { source: cloned.source, holder: cloned.item };
}

function withCatalogueClone(source: ShopSource, alias: string, item: CatalogueItem, taken: Iterable<string>, folder: string, note: string):
  { source: ShopSource; item: { module: string; variable: string } } {
  const used = new Set(taken);
  let key = /^[a-z][a-z0-9_]{0,55}$/.test(item.key) ? item.key : freeKey(item.key, used);
  if (source.files[`${folder}/${key}.py`] === undefined && used.has(key)) key = freeKey(key, used);
  const path = `${folder}/${key}.py`;
  const files = { ...source.files };
  if (files[path] === undefined) {
    files[path] = `# ${oneLine(item.name)}, from Steve's catalogue: ${note}.\n`
      + `from links import ${alias}\n\n${key} = ${linkedItem(alias, item.key)}.clone(${pyString(key)}, ${pyString(item.name)})\n`;
  }
  return { source: { ...source, files }, item: { module: `${folder}.${key}`, variable: key } };
}

/**
 * Fits a machine with another controller: `controller=<variable>` in the machine's call, importing it into the
 * machine's file when it lives in another. A string says why not (then it's changed in the code).
 */
export function withMachineController(source: ShopSource, machine: { key: string; file: string; line: number },
  controller: { module: string | null; variable: string }): ShopSource | string {
  const content = allFiles(source)[machine.file];
  if (content === undefined || machine.file.startsWith('links/')) return 'This machine comes from a linked shop: use it from the catalogue to make it yours.';
  const here = machine.file.replace(/\.py$/, '').replace(/\//g, '.');
  if (!controller.module && machine.file !== MAIN) return 'That controller is written in main.py, which other files can’t import: move it into controllers/.';
  const imported = controller.module && controller.module !== here ? withImport(content, `from ${controller.module} import ${controller.variable}`) : content;
  // The import went in above the call: its line moved by one.
  const line = machine.line + (imported === content ? 0 : 1);
  const next = setCallArgument(imported, machine.key, line, { keyword: 'controller' }, controller.variable);
  return next === null ? `Change it in the code: ${machine.file}, line ${machine.line}.` : withFile(source, machine.file, next);
}

/** The shop's files, main.py included, by path. */
export const allFiles = (source: ShopSource): Record<string, string> => ({ ...source.files, [MAIN]: source.code });
/** Puts one file back: main.py into `code`, any other into `files`. */
export const withFile = (source: ShopSource, path: string, content: string): ShopSource =>
  (path === MAIN ? { ...source, code: content } : { ...source, files: { ...source.files, [path]: content } });

/** How an item's variable is imported from another file of the shop: `from <module> import <variable>`, or null when
 *  its file can't be imported (main.py, a linked shop's file) or the item isn't assigned to a variable on its line. */
export function importOf(source: ShopSource, item: { file: string; line: number }): { module: string | null; variable: string } | null {
  const content = allFiles(source)[item.file];
  if (content === undefined) return null;
  const match = /^([A-Za-z_]\w*)\s*=/.exec(content.split('\n')[item.line - 1] ?? '');
  if (!match) return null;
  if (item.file === MAIN) return { module: null, variable: match[1] };
  if (!/^[a-z][a-z0-9_/]*\.py$/.test(item.file) || item.file.startsWith('links/')) return null;
  return { module: item.file.replace(/\.py$/, '').replace(/\//g, '.'), variable: match[1] };
}

interface Arg { start: number; end: number; keyword: string | null; valueStart: number }

/** The top-level arguments of the call whose `(` is at `open`, and where it closes; null when unbalanced. */
function callArgs(source: string, open: number): { args: Arg[]; close: number } | null {
  const args: Arg[] = [];
  let depth = 0;
  // The argument being read: its first and last characters that aren't blank or a comment.
  let first = -1;
  let last = -1;
  const mark = (from: number, to: number) => { if (first < 0) first = from; last = to; };
  const push = () => {
    if (first < 0) return;
    const keyword = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(source.slice(first, last + 1));
    args.push({ start: first, end: last + 1, keyword: keyword ? keyword[1] : null, valueStart: keyword ? first + keyword[0].length : first });
    first = -1; last = -1;
  };
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if (char === '#') { while (index < source.length && source[index] !== '\n') index++; continue; }
    if (/\s/.test(char)) continue;
    if (char === '"' || char === "'") {
      const from = index;
      const triple = source.startsWith(char.repeat(3), index);
      const quote = triple ? char.repeat(3) : char;
      index += quote.length;
      while (index < source.length && !source.startsWith(quote, index)) index += source[index] === '\\' ? 2 : 1;
      index += quote.length - 1;
      mark(from, index);
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth--;
      if (depth === 0) { push(); return { args, close: index }; }
      mark(index, index);
      continue;
    }
    if (char === ',' && depth === 1) { push(); continue; }
    if (index === open) { depth++; continue; }
    if (char === '(' || char === '[' || char === '{') depth++;
    mark(index, index);
  }
  return null;
}

/** The `(` of the call that makes the item keyed `key` (its first argument is that string): on `line` when it is there,
 *  else the only such call in the file. */
function callOf(source: string, key: string, line: number): number | null {
  const pattern = new RegExp(String.raw`\(\s*(["'])${key.replace(/[-]/g, '\\-')}\1\s*[,)]`, 'g');
  const hits = [...source.matchAll(pattern)].map((match) => match.index!);
  if (!hits.length) return null;
  const lineStart = source.split('\n').slice(0, Math.max(0, line - 1)).join('\n').length + (line > 1 ? 1 : 0);
  const lineEnd = source.indexOf('\n', lineStart);
  const onLine = hits.filter((index) => index >= lineStart && (lineEnd < 0 || index < lineEnd));
  if (onLine.length === 1) return onLine[0];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Sets one argument of the call that makes item `key` (at `line` of `source`): a keyword (`stickout=25`, added when
 * missing) or the positional argument at `position` (1: the name). `value` is Python source. Null when the call can't
 * be found or the argument isn't there to replace: the form then says to change it in the code.
 */
export function setCallArgument(source: string, key: string, line: number, argument: { keyword: string } | { position: number }, value: string): string | null {
  const open = callOf(source, key, line);
  return open === null ? null : setArgumentAt(source, open, argument, value);
}

/** setCallArgument on the call whose `(` is at `open`. */
function setArgumentAt(source: string, open: number, argument: { keyword: string } | { position: number }, value: string): string | null {
  const parsed = callArgs(source, open);
  if (!parsed) return null;
  const { args, close } = parsed;
  if ('position' in argument) {
    const positional = args.filter((arg) => arg.keyword === null);
    const target = positional[argument.position];
    if (!target || args.indexOf(target) !== argument.position) return null;
    return source.slice(0, target.start) + value + source.slice(target.end);
  }
  const target = args.find((arg) => arg.keyword === argument.keyword);
  if (target) return source.slice(0, target.valueStart) + value + source.slice(target.end);
  if (args.some((arg) => source.slice(arg.start, arg.end).startsWith('**'))) return null;   // **options may set it already
  const last = args.at(-1);
  if (!last) return source.slice(0, close) + `${argument.keyword}=${value}` + source.slice(close);
  return source.slice(0, last.end) + `, ${argument.keyword}=${value}` + source.slice(last.end);
}

/** The value source of an item call's keyword argument (`stickout=params.x` → "params.x"), or null. */
export function callArgument(source: string, key: string, line: number, keyword: string): string | null {
  const open = callOf(source, key, line);
  const parsed = open === null ? null : callArgs(source, open);
  const target = parsed?.args.find((arg) => arg.keyword === keyword);
  return target ? source.slice(target.valueStart, target.end).trim() : null;
}

/** A positive number as Python source (no exponent, no trailing zeros; thousands as 10_000). */
export const pyNumber = (value: number) => (Number.isInteger(value)
  ? (Math.abs(value) >= 10_000 ? String(value).replace(/\B(?=(\d{3})+$)/g, '_') : String(value))
  : String(Number(value.toFixed(6))));

// ── Dict literals (a clone's spindle={...}, a tool setup's tools={...}) ─────

interface Entry { start: number; end: number; key: string | null; valueStart: number }

/** The entries of the dict literal whose `{` is at `open`: each key as text (a string's content or a number). */
function dictEntries(source: string, open: number): { entries: Entry[]; close: number } | null {
  if (source[open] !== '{') return null;
  const parsed = callArgs(source, open);
  if (!parsed) return null;
  const entries = parsed.args.map((arg): Entry => {
    const match = /^(?:(["'])([^"'\\]*)\1|(-?\d+))\s*:\s*/.exec(source.slice(arg.start, arg.end));
    return { start: arg.start, end: arg.end, key: match ? (match[2] ?? match[3]) : null, valueStart: match ? arg.start + match[0].length : arg.start };
  });
  return { entries, close: parsed.close };
}

/** Sets `key: value` in the dict literal at `open` (a string key, or a number for an int key); added when missing. */
function setDictEntry(source: string, open: number, key: string | number, value: string): string | null {
  const parsed = dictEntries(source, open);
  if (!parsed || parsed.entries.some((entry) => entry.key === null)) return null;   // **spread or a computed key: leave it
  const found = parsed.entries.find((entry) => entry.key === String(key));
  if (found) return source.slice(0, found.valueStart) + value + source.slice(found.end);
  const literal = `${typeof key === 'number' ? key : pyString(key)}: ${value}`;
  const last = parsed.entries.at(-1);
  if (!last) return source.slice(0, open + 1) + literal + source.slice(open + 1);
  if (!source.slice(open, parsed.close).includes('\n')) return source.slice(0, last.end) + `, ${literal}` + source.slice(last.end);
  const lineStart = source.lastIndexOf('\n', last.start) + 1;
  const indent = /^\s*/.exec(source.slice(lineStart, last.start))![0];
  // On its own line after the last entry; a trailing comma stays after the new one.
  return source.slice(0, last.end) + `,\n${indent}${literal}` + source.slice(last.end);
}

/** Removes `key: …` from the dict literal at `open`; null when it isn't there. */
function removeDictEntry(source: string, open: number, key: string | number): string | null {
  const parsed = dictEntries(source, open);
  if (!parsed) return null;
  const index = parsed.entries.findIndex((entry) => entry.key === String(key));
  if (index < 0) return null;
  const entry = parsed.entries[index];
  const next = parsed.entries[index + 1];
  const previous = parsed.entries[index - 1];
  if (next) return source.slice(0, entry.start) + source.slice(next.start);
  if (previous) return source.slice(0, previous.end) + source.slice(entry.end);
  const after = /^\s*,/.exec(source.slice(entry.end));
  return source.slice(0, entry.start) + source.slice(entry.end + (after ? after[0].length : 0));
}

/** Where a keyword argument's value starts in the call at `open`, or null. */
function argumentValue(source: string, open: number, keyword: string): number | null {
  const parsed = callArgs(source, open);
  const target = parsed?.args.find((arg) => arg.keyword === keyword);
  return target ? target.valueStart : null;
}

/** The `(` of a call value starting at `at` (`Spindle(…)`, `Changer.magazine(…)`), or null when it isn't a call. */
function callValue(source: string, at: number): number | null {
  const match = /^[A-Za-z_][\w.]*\s*\(/.exec(source.slice(at));
  return match ? at + match[0].length - 1 : null;
}

const fileOf = (source: ShopSource, item: { file: string }) => (item.file.startsWith('links/') ? undefined : allFiles(source)[item.file]);
const inCode = (item: { file: string; line: number }) => `Change it in the code: ${item.file}, line ${item.line}.`;

// ── Customize a machine: spindle and changer ─────────────────────────────

export type ChangerSpec = { mode: 'manual' } | { mode: 'magazine'; pockets: number };
export interface MachineSpec { maxRpm?: number; interface?: string; changer?: ChangerSpec }

/** `Changer.manual()` or `Changer.magazine(pockets=…, interface=…)` as Python. */
export const changerSource = (changer: ChangerSpec, spindleInterface: string) => (changer.mode === 'manual'
  ? 'Changer.manual()' : `Changer.magazine(pockets=${Math.max(1, Math.round(changer.pockets))}, interface=${pyString(spindleInterface.toLowerCase())})`);

/**
 * A machine model's spindle speed and taper and its tool changer, in its call: a catalogue clone takes
 * `spindle={"max_rpm": …, "interface": …}` (merged into a spindle dict it has) and `tool_change=Changer…`;
 * `MachineModel.mill(…)` takes `Spindle(max_rpm=…, interface=…)` and `changer=Changer…`. A magazine's pockets take the
 * spindle's taper, so a new taper rewrites a magazine too. `current`: the model's interface and changer now.
 */
export function withMachineSpec(source: ShopSource, model: { key: string; file: string; line: number }, change: MachineSpec,
  current: { interface: string; changer: ChangerSpec }): ShopSource | string {
  const original = fileOf(source, model);
  if (original === undefined) return 'This machine’s model comes from a linked shop: use the machine from the catalogue to make it yours.';
  let content: string = original;
  const find = () => callOf(content, model.key, model.line);
  let open = find();
  if (open === null) return inCode(model);
  const head = content.slice(0, open).trimEnd();
  const clone = head.endsWith('.clone');
  const mill = /\.mill$/.test(head);
  if (!clone && !mill) return inCode(model);
  const taper = (change.interface ?? current.interface).toLowerCase();
  const changer = change.changer ?? (change.interface && current.changer.mode === 'magazine' ? current.changer : undefined);
  const spindle: [string, string][] = [];
  if (change.maxRpm !== undefined) spindle.push(['max_rpm', pyNumber(change.maxRpm)]);
  if (change.interface !== undefined) spindle.push(['interface', pyString(taper)]);
  if (spindle.length) {
    const at = argumentValue(content, open, 'spindle');
    if (at === null) {
      if (!clone) return inCode(model);
      const next = setArgumentAt(content, open, { keyword: 'spindle' }, `{${spindle.map(([k, v]) => `${pyString(k)}: ${v}`).join(', ')}}`);
      if (next === null) return inCode(model);
      content = next;
    } else {
      for (const [name, value] of spindle) {
        const spot = argumentValue(content, find()!, 'spindle')!;
        const nested = content[spot] === '{' ? null : callValue(content, spot);
        const next: string | null = content[spot] === '{' ? setDictEntry(content, spot, name, value) : nested !== null ? setArgumentAt(content, nested, { keyword: name }, value) : null;
        if (next === null) return inCode(model);
        content = next;
      }
    }
  }
  if (changer) {
    open = find();
    const next = open === null ? null : setArgumentAt(content, open, { keyword: clone ? 'tool_change' : 'changer' }, changerSource(changer, taper));
    if (next === null) return inCode(model);
    content = next;
    if (!/^from\s+steve\.shop\s+import\s+(\*|.*\bChanger\b)/m.test(content)) content = withImport(content, 'from steve.shop import Changer');
  }
  return withFile(source, model.file, content);
}

// ── Tools and tool setups ──────────────────────────────────────────────────

export type CutterSpec =
  | { catalogue: CatalogueItem; diameter?: number }
  | { type: 'end_mill' | 'drill'; name: string; diameter: number; flutes: number; fluteLength: number; overallLength: number };

/**
 * A tool: its cutter (a catalogue cutter cloned, with another diameter if given, or a new end mill or drill) in its
 * holder stack at a stick-out, in tools/<key>.py. `alias`: the catalogue's link alias (needed for a catalogue cutter).
 * Returns how to import it.
 */
export function withTool(source: ShopSource, options: {
  alias: string | null; name: string; taken: Iterable<string>; cutter: CutterSpec; holder: { module: string | null; variable: string }; stickout: number;
}): { source: ShopSource; tool: { module: string; variable: string }; key: string } {
  const taken = new Set(options.taken);
  for (const path of Object.keys(source.files)) { const match = /^tools\/([a-z][a-z0-9_]*)\.py$/.exec(path); if (match) taken.add(match[1]); }
  const key = freeKey(options.name, taken, ['cutter'], 't');
  const cutter = `${key}_cutter`;
  let make: string;
  if ('catalogue' in options.cutter) {
    if (!options.alias) throw new Error('A catalogue cutter needs the catalogue linked.');
    const extra = options.cutter.diameter !== undefined ? `, diameter_mm=${pyNumber(options.cutter.diameter)}` : '';
    make = `${cutter} = ${linkedItem(options.alias, options.cutter.catalogue.key)}.clone(${pyString(cutter)}, ${pyString(options.cutter.catalogue.name)}${extra})`;
  } else {
    const spec = options.cutter;
    make = `${cutter} = ${spec.type === 'drill' ? 'Drill' : 'EndMill'}(${pyString(cutter)}, ${pyString(spec.name)}, diameter=${pyNumber(spec.diameter)}, `
      + `flutes=${Math.max(1, Math.round(spec.flutes))}, flute_length=${pyNumber(spec.fluteLength)}, overall_length=${pyNumber(spec.overallLength)})`;
  }
  const imports = [
    ...('catalogue' in options.cutter ? [`from links import ${options.alias}`] : []),
    'from steve.shop import *  # noqa: F403',
    ...(options.holder.module ? [`from ${options.holder.module} import ${options.holder.variable}`] : []),
  ];
  const text = `# ${oneLine(options.name)}: the cutter in its holder at its stick-out (mm).\n${imports.join('\n')}\n\n${make}\n`
    + `${key} = Tool(${pyString(key)}, ${pyString(options.name)}, cutter=${cutter}, holders=[${options.holder.variable}], stickout=${pyNumber(options.stickout)})\n`;
  return { source: { ...source, files: { ...source.files, [`tools/${key}.py`]: text } }, tool: { module: `tools.${key}`, variable: key }, key };
}

/** A new tool setup in tool_setups/<key>.py loading `tool` as T`number`, added in main.py. */
export function withNewToolSetup(source: ShopSource, options: { name: string; taken: Iterable<string>; number: number; tool: { module: string; variable: string } }):
  { source: ShopSource; key: string } {
  const taken = new Set(options.taken);
  for (const path of Object.keys(source.files)) { const match = /^tool_setups\/([a-z][a-z0-9_]*)\.py$/.exec(path); if (match) taken.add(match[1]); }
  const key = freeKey(options.name, taken);
  const text = `# ${oneLine(options.name)}: the tools loaded, by T number.\nfrom steve.shop import *  # noqa: F403\n`
    + `from ${options.tool.module} import ${options.tool.variable}\n\n`
    + `${key} = ToolSetup(${pyString(key)}, ${pyString(options.name)}, tools={\n    ${options.number}: ${options.tool.variable},\n})\n`;
  const files = { ...source.files, [`tool_setups/${key}.py`]: text };
  return { source: { ...source, files, code: withShopAdd(source.code, `tool_setups.${key}`, key) }, key };
}

/** `tools={…}` of a tool setup's call, edited by `edit` (the dict's `{` index); a string says why not. */
function editToolsDict(source: ShopSource, setup: { key: string; file: string; line: number }, edit: (content: string, open: number) => string | null | string[]): ShopSource | string {
  const content = fileOf(source, setup);
  if (content === undefined) return 'This tool setup comes from a linked shop: change it there.';
  const open = callOf(content, setup.key, setup.line);
  const at = open === null ? null : argumentValue(content, open, 'tools');
  if (at === null || content[at] !== '{') return inCode(setup);
  const next = edit(content, at);
  if (Array.isArray(next)) return next[0];
  return next === null ? inCode(setup) : withFile(source, setup.file, next);
}

/** Loads `tool` as T`number` in an existing tool setup (`tools={…}` in its call), importing it into the setup's file. */
export function withToolInSetup(source: ShopSource, setup: { key: string; file: string; line: number }, number: number, tool: { module: string | null; variable: string }): ShopSource | string {
  return editToolsDict(source, setup, (content, open) => {
    if (dictEntries(content, open)?.entries.some((entry) => entry.key === String(number))) return [`T${number} is already loaded in this tool setup: pick another number.`];
    const here = setup.file.replace(/\.py$/, '').replace(/\//g, '.');
    if (!tool.module && setup.file !== MAIN) return ['That tool is written in main.py, which other files can’t import.'];
    const next = setDictEntry(content, open, number, tool.variable);
    return next === null ? null : tool.module && tool.module !== here ? withImport(next, `from ${tool.module} import ${tool.variable}`) : next;
  });
}

/** Unloads T`number` from a tool setup (the tool stays in the shop). A tool setup keeps at least one tool. */
export function withoutToolInSetup(source: ShopSource, setup: { key: string; file: string; line: number }, number: number): ShopSource | string {
  return editToolsDict(source, setup, (content, open) => {
    const entries = dictEntries(content, open)?.entries ?? [];
    if (!entries.some((entry) => entry.key === String(number))) return null;
    if (entries.length === 1) return ['A tool setup keeps at least one tool: load another first.'];
    return removeDictEntry(content, open, number);
  });
}

/** The lowest T number a tool setup doesn't use. */
export const freeToolNumber = (used: number[]) => { let n = 1; while (used.includes(n)) n++; return n; };

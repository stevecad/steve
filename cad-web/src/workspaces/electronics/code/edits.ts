/**
 * Edits a circuit's TSX the way a person would: each one changes as little text as it can, keeps formatting and
 * comments, and refuses (EditError) rather than overwrite a value the code computes.
 */
import { prefixFor, nextName } from './naming';
import { parse } from './source';
import { isValidName, parseSelector, referencesName, renameReferences } from './selectors';
import { angleDeg, formatAttr, formatAttrValue, formatNumber, lengthInStyle, lengthMm, supplierPartsArrayForm } from './values';
import { EditError, type Attr, type EditResult, type Element, type SourceIndex, type Span, type Target } from './types';

interface Splice { start: number; end: number; text: string }

/** The index, refusing code that doesn't parse: an edit would splice spans that no longer mean what they did. */
export function indexFor(code: string): SourceIndex {
  const index = parse(code);
  if (index.errors.length) {
    const error = index.errors[0];
    throw new EditError('parse', `Fix the code first: ${error.message} (line ${error.line}, column ${error.column}).`);
  }
  return index;
}

const where = (element: Element) => `<${element.tag}${element.name ? ` name="${element.name}"` : ''}> on line ${element.line}`;

/** The element a target names. */
export function resolveTarget(index: SourceIndex, target: Target): Element {
  if (typeof target === 'string') {
    const matches = index.elements.filter((element) => element.name === target);
    if (!matches.length) throw new EditError('not_found', `There's no part named ${target}.`);
    if (matches.length > 1) throw new EditError('ambiguous', `${target} names ${matches.length} elements (lines ${matches.map((element) => element.line).join(', ')}); pick one in the source.`);
    return matches[0];
  }
  if ('start' in target) {
    const element = index.elements.find((item) => item.span.start === target.start);
    if (!element) throw new EditError('not_found', 'That element is no longer in the code.');
    return element;
  }
  const matches = index.elements.filter((element) => element.tag === target.tag);
  const element = matches[target.nth ?? 0];
  if (!element) throw new EditError('not_found', `There's no <${target.tag}> in the code.`);
  return element;
}

/** Finds an element without throwing. */
export function findElement(index: SourceIndex, target: Target): Element | null {
  try { return resolveTarget(index, target); } catch { return null; }
}

const lastAttr = (element: Element, name: string): Attr | undefined => [...element.attrs].reverse().find((attr) => attr.name === name);

function applySplices(code: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = code;
  let floor = Infinity;
  for (const splice of sorted) {
    if (splice.end > floor) throw new Error('Overlapping edits.');
    out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
    floor = splice.start;
  }
  return out;
}

const lineStartOf = (code: string, offset: number) => code.lastIndexOf('\n', offset - 1) + 1;

/** The range that removes a span cleanly: its whole lines when nothing else is on them, else the span and the space before it. */
function removalRange(code: string, span: Span): Span {
  const lineStart = lineStartOf(code, span.start);
  const before = code.slice(lineStart, span.start);
  let after = span.end;
  while (after < code.length && (code[after] === ' ' || code[after] === '\t')) after++;
  const endsLine = after >= code.length || code[after] === '\n' || code[after] === '\r';
  if (/^[ \t]*$/.test(before) && endsLine) {
    let end = after;
    if (code[end] === '\r') end++;
    if (code[end] === '\n') end++;
    return { start: lineStart, end };
  }
  let start = span.start;
  while (start > lineStart && (code[start - 1] === ' ' || code[start - 1] === '\t')) start--;
  return { start, end: span.end };
}

/** Where a new attribute goes and how it's introduced: on its own line when the tag already lists one per line. */
function attrInsertion(index: SourceIndex, element: Element, text: string): Splice {
  const at = element.attrsEnd;
  const last = element.attrs[element.attrs.length - 1];
  if (last) {
    const lastLineStart = lineStartOf(index.code, last.span.start);
    const tagLineStart = lineStartOf(index.code, element.tagNameSpan.start);
    if (lastLineStart !== tagLineStart) {
      const lead = index.code.slice(lastLineStart, last.span.start);
      const indent = /^[ \t]*$/.test(lead) ? lead : element.indent + index.indentUnit;
      return { start: at, end: at, text: `\n${indent}${text}` };
    }
  }
  return { start: at, end: at, text: ` ${text}` };
}

function result(code: string, original: string, selection?: Span, notes: string[] = []): EditResult {
  return { code, changed: code !== original, selection, notes };
}

/** A position or length value an edit can rewrite, or an EditError. */
function editableLength(element: Element, attr: Attr): number {
  const mm = attr.static ? lengthMm(attr.value) : null;
  if (mm === null) throw new EditError('computed', `${attr.name} on ${where(element)} is computed (${attr.raw}); change it in the source.`);
  return mm;
}

export interface SetPropOptions {
  /** Overwrite a computed value. Only for an explicit "replace this expression" action. */
  force?: boolean;
}

/** Sets one prop (adds it if missing). `undefined` removes it; `true` writes a bare flag. */
const ARRAY_FORM_NOTE = 'Supplier part numbers are written as lists ({ jlcpcb: ["C…"] }): tscircuit drops a part whose number is plain text.';

export function setProp(code: string, target: Target, prop: string, value: unknown, options: SetPropOptions = {}): EditResult {
  if (value === undefined) return removeProp(code, target, prop, options);
  if (prop === 'supplierPartNumbers') {
    const form = supplierPartsArrayForm(value);
    if (form.repaired) {
      const written = setProp(code, target, prop, form.value, options);
      return { ...written, notes: [ARRAY_FORM_NOTE, ...written.notes] };
    }
  }
  const index = indexFor(code);
  const element = resolveTarget(index, target);
  if (prop === 'name' && typeof value === 'string' && element.name && element.name !== value) return renameElement(code, target, value);
  const attr = lastAttr(element, prop);
  let splice: Splice;
  if (attr) {
    if (!attr.static && !options.force) throw new EditError('computed', `${prop} on ${where(element)} is computed (${attr.raw}); change it in the source.`);
    if (attr.static && attr.value === value && typeof value !== 'object') return result(code, code);
    const written = formatAttrValue(value);
    if (written === null) splice = attr.kind === 'flag' ? { start: attr.span.end, end: attr.span.end, text: '' } : { start: attr.span.start, end: attr.span.end, text: prop };
    else splice = attr.valueSpan ? { start: attr.valueSpan.start, end: attr.valueSpan.end, text: written } : { start: attr.span.start, end: attr.span.end, text: `${prop}=${written}` };
  } else {
    splice = attrInsertion(index, element, formatAttr(prop, value));
  }
  const next = applySplices(code, [splice]);
  const updated = parse(next).elements.find((item) => item.span.start === element.span.start);
  const span = updated && lastAttr(updated, prop)?.span;
  return result(next, code, span);
}

/** Sets several props, in order. */
export function setProps(code: string, target: Target, values: Record<string, unknown>, options: SetPropOptions = {}): EditResult {
  let current = code;
  let selection: Span | undefined;
  const notes: string[] = [];
  let element = resolveTarget(indexFor(code), target);
  for (const [prop, value] of Object.entries(values)) {
    const step = setProp(current, { start: element.span.start }, prop, value, options);
    current = step.code;
    selection = step.selection ?? selection;
    notes.push(...step.notes);
    element = resolveTarget(indexFor(current), { start: element.span.start });
  }
  return result(current, code, selection, notes);
}

/** Removes a prop. */
export function removeProp(code: string, target: Target, prop: string, options: SetPropOptions = {}): EditResult {
  const index = indexFor(code);
  const element = resolveTarget(index, target);
  const attrs = element.attrs.filter((attr) => attr.name === prop);
  if (!attrs.length) return result(code, code);
  if (prop === 'name') throw new EditError('invalid', `A part needs its name; rename it instead.`);
  const computed = attrs.find((attr) => !attr.static);
  if (computed && !options.force) throw new EditError('computed', `${prop} on ${where(element)} is computed (${computed.raw}); remove it in the source.`);
  return result(applySplices(code, attrs.map((attr) => ({ ...removalRange(code, attr.span), text: '' }))), code);
}

export interface InsertSpec {
  tag: string;
  /** Props after the name, in this order. */
  props?: Record<string, unknown>;
  /** A name; null for none; omitted for the next free reference designator (R3, C2, …). */
  name?: string | null;
  /** The board (default), or a named group or subcircuit. */
  parent?: Target;
}

const LINE_WIDTH = 100;

/** Where the children of an element are indented. */
function childIndent(index: SourceIndex, parent: Element): string {
  const child = parent.children.map((id) => index.elements[id]).find((item) => item.direct && item.startsLine);
  return child ? child.indent : parent.indent + index.indentUnit;
}

function elementText(tag: string, attrs: string[], indent: string, unit: string): string {
  const single = `<${tag}${attrs.map((attr) => ` ${attr}`).join('')} />`;
  if (indent.length + single.length <= LINE_WIDTH || attrs.length < 2) return single;
  return `<${tag}\n${attrs.map((attr) => `${indent}${unit}${attr}`).join('\n')}\n${indent}/>`;
}

/** Inserts an element into the board (or a group): parts before the traces, traces last. */
export function insertElement(code: string, spec: InsertSpec): EditResult & { name: string | null } {
  const index = indexFor(code);
  const parent = spec.parent !== undefined ? resolveTarget(index, spec.parent) : index.board !== null ? index.elements[index.board] : index.root !== null ? index.elements[index.root] : null;
  if (!parent) throw new EditError('invalid', `There's no <board> to add parts to. Add one first: export default () => <board width="20mm" height="20mm" />.`);
  let name: string | null;
  if (spec.name === null) name = null;
  else if (typeof spec.name === 'string') {
    if (!isValidName(spec.name, spec.tag)) throw new EditError('invalid', `${spec.name} isn't a valid name: use letters, digits and underscores, starting with a letter.`);
    if (index.elements.some((element) => element.name === spec.name)) throw new EditError('invalid', `${spec.name} is already used.`);
    name = spec.name;
  } else {
    const prefix = prefixFor(spec.tag);
    name = prefix ? nextName(index, prefix) : null;
  }
  const attrs = [...(name ? [formatAttr('name', name)] : []), ...Object.entries(spec.props ?? {}).filter(([key, value]) => value !== undefined && key !== 'name')
    .map(([key, value]) => formatAttr(key, key === 'supplierPartNumbers' ? supplierPartsArrayForm(value).value : value))];
  const indent = childIndent(index, parent);
  const text = elementText(spec.tag, attrs, indent, index.indentUnit);
  let splice: Splice;
  let offset: number;  // Where `text` starts in the new code.
  if (parent.selfClosing) {
    const lead = `>\n${indent}`;
    splice = { start: parent.attrsEnd, end: parent.openingSpan.end, text: `${lead}${text}\n${parent.indent}</${parent.tag}>` };
    offset = parent.attrsEnd + lead.length;
  } else {
    const siblings = parent.children.map((id) => index.elements[id]).filter((item) => item.direct && item.inAttr === null);
    const firstTrace = spec.tag === 'trace' ? undefined : siblings.find((item) => item.tag === 'trace' && item.startsLine);
    const closing = parent.closingSpan!;
    const closingLineStart = lineStartOf(code, closing.start);
    if (firstTrace) {
      const at = lineStartOf(code, firstTrace.span.start);
      splice = { start: at, end: at, text: `${indent}${text}\n` };
      offset = at + indent.length;
    } else if (/^[ \t]*$/.test(code.slice(closingLineStart, closing.start)) && closingLineStart > parent.openingSpan.end) {
      splice = { start: closingLineStart, end: closingLineStart, text: `${indent}${text}\n` };
      offset = closingLineStart + indent.length;
    } else {
      splice = { start: closing.start, end: closing.start, text: `\n${indent}${text}\n${parent.indent}` };
      offset = closing.start + 1 + indent.length;
    }
  }
  const next = applySplices(code, [splice]);
  return { ...result(next, code, { start: offset, end: offset + text.length }), name };
}

/** Props that hold selectors: where a removed or renamed part may still be named. */
const REFERENCE_PROPS = new Set(['from', 'to', 'path', 'connections', 'connectsTo', 'pullupFor', 'pullupTo', 'decouplingFor', 'decouplingTo', 'positiveConnection', 'negativeConnection', 'connection', 'net']);

/** Removes an element; with `withTraces` (default) also the traces that connect to it. */
export function removeElement(code: string, target: Target, options: { withTraces?: boolean } = {}): EditResult & { removed: string[] } {
  const index = indexFor(code);
  const element = resolveTarget(index, target);
  if (element.id === index.board || element.id === index.root) throw new EditError('invalid', 'That’s the board itself; remove its parts instead.');
  if (!element.direct) throw new EditError('invalid', `${where(element)} is written inside an expression; remove it in the source.`);
  const ranges: Span[] = [removalRange(code, element.span)];
  const removed = [where(element)];
  const notes: string[] = [];
  const inside = (other: Element) => other.span.start >= element.span.start && other.span.end <= element.span.end;
  if (element.name) {
    for (const other of index.elements) {
      if (other === element || inside(other)) continue;
      const mentions = other.attrs.filter((attr) => attr.name !== 'name' && attr.strings.some((piece) => referencesName(piece.raw, element.name!)));
      if (!mentions.length) continue;
      if (other.tag === 'trace' && options.withTraces !== false && other.direct) {
        ranges.push(removalRange(code, other.span));
        removed.push(where(other));
      } else {
        notes.push(`${element.name} is still named in ${mentions.map((attr) => attr.name).join(', ')} of ${where(other)}.`);
      }
    }
  }
  if (removed.length > 1) notes.unshift(`Also removed ${removed.length - 1} trace${removed.length === 2 ? '' : 's'} connected to ${element.name}.`);
  // Overlapping ranges (adjacent lines, a trace inside a removed group) become one.
  const merged: Span[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return { ...result(applySplices(code, merged.map((range) => ({ ...range, text: '' }))), code, undefined, notes), removed };
}

/** Renames a part and every selector or placement expression that names it. */
export function renameElement(code: string, target: Target, newName: string): EditResult & { references: number } {
  const index = indexFor(code);
  const element = resolveTarget(index, target);
  const old = element.name;
  if (!old) throw new EditError('invalid', `${where(element)} has no written name to change.`);
  if (newName === old) return { ...result(code, code), references: 0 };
  if (!isValidName(newName)) throw new EditError('invalid', `${newName} isn't a valid name: use letters, digits and underscores, starting with a letter.`);
  const clash = index.elements.find((item) => item.name === newName);
  if (clash) throw new EditError('invalid', `${newName} is already used by ${where(clash)}.`);
  const nameAttr = lastAttr(element, 'name')!;
  const splices: Splice[] = [{ start: nameAttr.valueSpan!.start, end: nameAttr.valueSpan!.end, text: formatAttrValue(newName)! }];
  let references = 0;
  const notes: string[] = [];
  for (const other of index.elements) {
    for (const attr of other.attrs) {
      if (attr.name === 'name') continue;
      let found = 0;
      for (const piece of attr.strings) {
        const renamed = renameReferences(piece.raw, old, newName);
        if (renamed.count) { splices.push({ start: piece.span.start, end: piece.span.end, text: renamed.text }); found += renamed.count; }
      }
      references += found;
      if (!found && !attr.static && REFERENCE_PROPS.has(attr.name) && attr.kind === 'computed') notes.push(`Check ${attr.name}={${attr.raw.replace(/^\{|\}$/g, '')}} on ${where(other)} by hand: it's computed.`);
    }
  }
  if (references) notes.unshift(`Updated ${references} reference${references === 1 ? '' : 's'} to ${old}.`);
  const next = applySplices(code, splices);
  const updated = parse(next).elements.find((item) => item.span.start === element.span.start);
  return { ...result(next, code, updated?.span, notes), references };
}

/** Adds `<trace from=… to=… />` (after the other children of the board, or of `parent`). */
export function addTrace(code: string, from: string, to: string, options: { name?: string; parent?: Target; props?: Record<string, unknown> } = {}): EditResult {
  for (const selector of [from, to]) {
    if (!parseSelector(selector)) throw new EditError('invalid', `${selector} isn't a port or net selector (like .R1 > .pin1 or net.GND).`);
  }
  if (from === to) throw new EditError('invalid', 'A trace needs two different ends.');
  return insertElement(code, { tag: 'trace', name: options.name ?? null, parent: options.parent, props: { from, to, ...options.props } });
}

export type View = 'pcb' | 'sch';

const AXIS_PROPS: Record<View, { x: string[]; y: string[] }> = {
  pcb: { x: ['pcbX', 'pcbLeftEdgeX', 'pcbRightEdgeX'], y: ['pcbY', 'pcbTopEdgeY', 'pcbBottomEdgeY'] },
  sch: { x: ['schX'], y: ['schY'] },
};

/**
 * Sets a position relative to the parent (board centre or group anchor), rounded to 0.01 mm, in the code's own
 * style (`pcbX="5mm"` stays a string). A computed position (`calc(R1.maxX + 2mm)`, an expression) is refused.
 */
export function setPosition(code: string, target: Target, position: { pcbX?: number; pcbY?: number } | { schX?: number; schY?: number }, options: SetPropOptions = {}): EditResult {
  const element = resolveTarget(indexFor(code), target);
  const values: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(position) as [string, number | undefined][]) {
    if (value === undefined) continue;
    const attr = lastAttr(element, prop);
    if (attr && !options.force) editableLength(element, attr);
    values[prop] = lengthInStyle(value, attr?.static ? attr.value : undefined);
  }
  return setProps(code, { start: element.span.start }, values, options);
}

/**
 * Moves a part by a delta (mm) in one view, changing whichever position props it uses (pcbX or edge anchors).
 * Axes it has no position for are listed in `unplaced`: the caller sets them from an absolute position.
 */
export function moveBy(code: string, target: Target, view: View, dx: number, dy: number): EditResult & { unplaced: ('x' | 'y')[] } {
  const element = resolveTarget(indexFor(code), target);
  const values: Record<string, unknown> = {};
  const unplaced: ('x' | 'y')[] = [];
  for (const [axis, delta] of [['x', dx], ['y', dy]] as const) {
    if (!delta) continue;
    const present = AXIS_PROPS[view][axis].map((prop) => lastAttr(element, prop)).filter((attr): attr is Attr => !!attr);
    if (!present.length) { unplaced.push(axis); continue; }
    for (const attr of present) values[attr.name] = lengthInStyle(editableLength(element, attr) + delta, attr.value);
  }
  const edited = Object.keys(values).length ? setProps(code, { start: element.span.start }, values) : result(code, code);
  return { ...edited, unplaced };
}

/** Rotates by `delta` degrees (90 by default) in one view; a rotation of 0 removes the prop. */
export function rotate(code: string, target: Target, view: View, delta = 90): EditResult {
  const element = resolveTarget(indexFor(code), target);
  const prop = view === 'pcb' ? 'pcbRotation' : 'schRotation';
  const attr = lastAttr(element, prop);
  let current = 0;
  if (attr) {
    const angle = attr.static ? angleDeg(attr.value) : null;
    if (angle === null) throw new EditError('computed', `${prop} on ${where(element)} is computed (${attr.raw}); change it in the source.`);
    current = angle;
  }
  const next = Number(formatNumber((((current + delta) % 360) + 360) % 360));
  if (next === 0) return attr ? removeProp(code, { start: element.span.start }, prop) : result(code, code);
  const value = typeof attr?.value === 'string' ? `${next}deg` : next;
  return setProp(code, { start: element.span.start }, prop, value);
}

/** Puts a part on the top (default, so the prop goes) or bottom side. */
export function setLayer(code: string, target: Target, layer: 'top' | 'bottom'): EditResult {
  const element = resolveTarget(indexFor(code), target);
  const attr = lastAttr(element, 'layer');
  if (attr && !attr.static) throw new EditError('computed', `layer on ${where(element)} is computed (${attr.raw}); change it in the source.`);
  return layer === 'top' ? removeProp(code, { start: element.span.start }, 'layer') : setProp(code, { start: element.span.start }, 'layer', 'bottom');
}

/** Board props. Lengths given as numbers (mm) keep the code's style; new ones are written `"20mm"`. */
export function setBoard(code: string, values: Record<string, unknown>): EditResult {
  const index = indexFor(code);
  if (index.board === null) throw new EditError('not_found', 'There’s no <board> in the code.');
  const board = index.elements[index.board];
  const written: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(values)) {
    const attr = lastAttr(board, prop);
    if (typeof value === 'number' && (prop === 'width' || prop === 'height' || prop === 'thickness')) {
      if (attr && !attr.static) throw new EditError('computed', `${prop} on the board is computed (${attr.raw}); change it in the source.`);
      written[prop] = lengthInStyle(value, attr ? attr.value : undefined, 'mm');
    } else written[prop] = value;
  }
  return setProps(code, { start: board.span.start }, written);
}

/** Elements whose `supplierPartNumbers` is written with plain-text numbers (tscircuit drops those parts). */
export function supplierStringForms(index: SourceIndex): Element[] {
  return index.elements.filter((element) => {
    const attr = lastAttr(element, 'supplierPartNumbers');
    return !!attr && attr.static && supplierPartsArrayForm(attr.value).repaired;
  });
}

/** Rewrites every plain-text supplier part number as a list, so tscircuit keeps the parts. */
export function repairSupplierPartNumbers(code: string): EditResult {
  const index = indexFor(code);
  const broken = supplierStringForms(index);
  if (!broken.length) return result(code, code);
  const splices = broken.map((element) => {
    const attr = lastAttr(element, 'supplierPartNumbers')!;
    return { start: attr.valueSpan!.start, end: attr.valueSpan!.end, text: formatAttrValue(supplierPartsArrayForm(attr.value).value)! };
  });
  const names = broken.map((element) => element.name ?? `line ${element.line}`);
  return result(applySplices(code, splices), code, undefined, [`Wrote the supplier part numbers of ${names.join(', ')} as lists, so tscircuit keeps ${broken.length === 1 ? 'it' : 'them'}.`]);
}

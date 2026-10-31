/**
 * `parse(code)`: the index of every JSX element in a circuit file, with the spans edits splice. It never runs the
 * code; values written as literals are read, everything else is marked computed.
 */
import { babelParse, type BabelFile, type BabelNode } from './parser';
import { staticValue } from './values';
import type { Attr, AttrKind, Element, ElementScope, ParseError, SourceIndex, Span, StringPiece } from './types';

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'errors', 'tokens']);
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod']);

const isNode = (value: unknown): value is BabelNode => !!value && typeof value === 'object' && typeof (value as BabelNode).type === 'string';

export function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let index = 0; index < code.length; index++) if (code.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

/** 1-based line and column of an offset. */
export function lineColumn(lineStarts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid; else high = mid - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

const PLAIN: [RegExp, string][] = [
  [/^Unterminated JSX contents/, 'A tag is never closed.'],
  [/^Expected corresponding JSX closing tag for <(.+)>/, 'The closing tag doesn’t match <$1>.'],
  [/^Unterminated string constant/, 'A quoted string is never closed.'],
  [/^Unterminated template/, 'A template string is never closed.'],
  [/^Unexpected token, expected "(.+)"/, 'Expected “$1” here.'],
  [/^Unexpected token/, 'Something unexpected is here.'],
];

function plainError(message: string, offset: number, lineStarts: number[]): ParseError {
  let text = message.replace(/\s*\(\d+:\d+\)\s*$/, '');
  for (const [pattern, words] of PLAIN) if (pattern.test(text)) { text = text.replace(pattern, words); break; }
  return { message: text, offset, ...lineColumn(lineStarts, offset) };
}

function tagName(node: BabelNode): string {
  if (node.type === 'JSXIdentifier') return node.name as string;
  if (node.type === 'JSXMemberExpression') return `${tagName(node.object as BabelNode)}.${tagName(node.property as BabelNode)}`;
  if (node.type === 'JSXNamespacedName') return `${tagName(node.namespace as BabelNode)}:${tagName(node.name as BabelNode)}`;
  return '?';
}

/** Every string literal and static template text inside a node (attribute values, also computed ones). */
function stringPieces(node: BabelNode, code: string, out: StringPiece[]): void {
  if (node.type === 'StringLiteral') {
    out.push({ span: { start: node.start + 1, end: node.end - 1 }, raw: code.slice(node.start + 1, node.end - 1) });
    return;
  }
  if (node.type === 'TemplateElement') {
    out.push({ span: { start: node.start, end: node.end }, raw: code.slice(node.start, node.end) });
    return;
  }
  if (node.type === 'JSXElement' || node.type === 'JSXFragment') return;  // Indexed as elements of their own.
  for (const [key, value] of Object.entries(node)) {
    if (SKIP_KEYS.has(key)) continue;
    if (Array.isArray(value)) { for (const item of value) if (isNode(item)) stringPieces(item, code, out); } else if (isNode(value)) stringPieces(value, code, out);
  }
}

function readAttr(node: BabelNode, code: string): Attr {
  const nameNode = node.name as BabelNode;
  const name = tagName(nameNode);
  const valueNode = node.value as BabelNode | null;
  const base = { name, span: { start: node.start, end: node.end }, nameSpan: { start: nameNode.start, end: nameNode.end } };
  if (!valueNode) return { ...base, valueSpan: null, kind: 'flag', static: true, value: true, raw: '', strings: [] };
  const valueSpan = { start: valueNode.start, end: valueNode.end };
  const raw = code.slice(valueNode.start, valueNode.end);
  const strings: StringPiece[] = [];
  stringPieces(valueNode, code, strings);
  if (valueNode.type === 'StringLiteral') {
    // JSX attribute strings have no escapes: the text between the quotes is the value.
    return { ...base, valueSpan, kind: 'string', static: true, value: code.slice(valueNode.start + 1, valueNode.end - 1), raw, strings };
  }
  if (valueNode.type === 'JSXElement' || valueNode.type === 'JSXFragment') return { ...base, valueSpan, kind: 'element', static: false, raw, strings };
  const expression = valueNode.type === 'JSXExpressionContainer' ? (valueNode.expression as BabelNode) : valueNode;
  if (expression.type === 'JSXEmptyExpression') return { ...base, valueSpan, kind: 'computed', static: false, raw, strings };
  const literal = staticValue(expression);
  if (!literal.static) {
    const kind: AttrKind = expression.type === 'JSXElement' || expression.type === 'JSXFragment' ? 'element' : 'computed';
    return { ...base, valueSpan, kind, static: false, raw, strings };
  }
  const value = literal.value;
  const kind: AttrKind = expression.type === 'TemplateLiteral' ? 'template'
    : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object'
      : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
  return { ...base, valueSpan, kind, static: true, value, raw, strings };
}

/** The function the default export renders (`export default () => …`, `export default function X()`, `export default X`). */
function defaultExportFunction(program: BabelNode & { body: BabelNode[] }): BabelNode | null {
  const exported = program.body.find((node) => node.type === 'ExportDefaultDeclaration');
  if (!exported) return null;
  let declaration = exported.declaration as BabelNode | null;
  if (declaration && declaration.type === 'Identifier') {
    const name = declaration.name as string;
    declaration = null;
    for (const statement of program.body) {
      const target = statement.type === 'ExportNamedDeclaration' ? (statement.declaration as BabelNode | null) : statement;
      if (!target) continue;
      if (target.type === 'FunctionDeclaration' && (target.id as BabelNode | null)?.name === name) declaration = target;
      if (target.type === 'VariableDeclaration') {
        for (const declarator of target.declarations as BabelNode[]) {
          if ((declarator.id as BabelNode).name === name) declaration = declarator.init as BabelNode;
        }
      }
    }
  }
  if (declaration && (declaration.type === 'TSAsExpression' || declaration.type === 'TSSatisfiesExpression')) declaration = declaration.expression as BabelNode;
  return declaration && FUNCTIONS.has(declaration.type) ? declaration : null;
}

function functionName(node: BabelNode, parent: BabelNode | null): string | null {
  const id = node.id as BabelNode | null | undefined;
  if (id && id.type === 'Identifier') return id.name as string;
  if (parent && parent.type === 'VariableDeclarator') return ((parent.id as BabelNode).name as string) ?? null;
  return null;
}

function detectIndentUnit(elements: Element[], code: string): string {
  const steps = new Map<string, number>();
  for (const element of elements) {
    if (element.parent === null || !element.startsLine) continue;
    const parent = elements[element.parent];
    if (!parent.startsLine || !element.indent.startsWith(parent.indent)) continue;
    const step = element.indent.slice(parent.indent.length);
    if (step && /^( +|\t+)$/.test(step)) steps.set(step, (steps.get(step) ?? 0) + 1);
  }
  if (steps.size) return [...steps.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return /^\t/m.test(code) ? '\t' : '  ';
}

/** The index of a circuit file. Throws only if the parser isn't loaded; syntax problems come back in `errors`. */
export function parse(code: string): SourceIndex {
  const lineStarts = lineStartsOf(code);
  let file: BabelFile;
  try {
    file = babelParse(code);
  } catch (error) {
    if (error instanceof Error && /still loading/.test(error.message)) throw error;
    const failure = error as Error & { pos?: number; loc?: { line: number; column: number } };
    const offset = typeof failure.pos === 'number' ? failure.pos : 0;
    return { code, elements: [], board: null, root: null, errors: [plainError(failure.message, offset, lineStarts)], indentUnit: '  ', lineStarts };
  }
  const errors = (file.errors ?? []).map((error) => plainError(error.message, error.pos ?? 0, lineStarts));
  const main = defaultExportFunction(file.program);
  const elements: Element[] = [];

  // `jsxParent`: the closest enclosing element; `fn`: the enclosing function context.
  type Context = { jsxParent: number | null; inAttr: string | null; scope: ElementScope | 'top'; owner: string | null; depth: number };

  const visit = (node: BabelNode, parent: BabelNode | null, context: Context): void => {
    if (FUNCTIONS.has(node.type)) {
      const scope: ElementScope | 'top' = node === main ? 'main'
        : context.scope === 'main' || context.scope === 'callback' ? 'callback' : 'component';
      const owner = scope === 'component' ? functionName(node, parent) ?? context.owner : context.owner;
      const inner: Context = { ...context, scope, owner };
      for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue;
        if (Array.isArray(value)) { for (const item of value) if (isNode(item)) visit(item, node, inner); } else if (isNode(value)) visit(value, node, inner);
      }
      return;
    }
    if (node.type === 'JSXElement') {
      const opening = node.openingElement as BabelNode & { attributes: BabelNode[]; selfClosing: boolean; name: BabelNode };
      const closing = node.closingElement as BabelNode | null;
      const tag = tagName(opening.name);
      const attrs: Attr[] = [];
      let spread = false;
      const attrsEnd = opening.attributes.length ? opening.attributes[opening.attributes.length - 1].end : opening.name.end;
      for (const attribute of opening.attributes) {
        if (attribute.type === 'JSXSpreadAttribute') { spread = true; continue; }
        attrs.push(readAttr(attribute, code));
      }
      const nameAttr = [...attrs].reverse().find((attr) => attr.name === 'name');
      const { line, column } = lineColumn(lineStarts, node.start);
      const lineStart = lineStarts[line - 1];
      const before = code.slice(lineStart, node.start);
      const startsLine = /^[ \t]*$/.test(before);
      const scope: ElementScope = context.scope === 'top' ? 'component' : context.scope;
      const element: Element = {
        id: elements.length, tag, intrinsic: /^[a-z]/.test(tag) && !tag.includes('.'),
        name: nameAttr && nameAttr.static && typeof nameAttr.value === 'string' ? nameAttr.value : null,
        nameComputed: !!nameAttr && !(nameAttr.static && typeof nameAttr.value === 'string'),
        parent: context.jsxParent, children: [], inAttr: context.inAttr,
        span: { start: node.start, end: node.end }, openingSpan: { start: opening.start, end: opening.end },
        tagNameSpan: { start: opening.name.start, end: opening.name.end },
        closingSpan: closing ? { start: closing.start, end: closing.end } : null, selfClosing: opening.selfClosing,
        attrs, spread, attrsEnd, direct: !!parent && (parent.type === 'JSXElement' || parent.type === 'JSXFragment'), line, column, indent: /^[ \t]*/.exec(before)![0], startsLine, scope,
        owner: scope === 'component' ? context.owner : null, depth: context.depth,
      };
      elements.push(element);
      if (context.jsxParent !== null) elements[context.jsxParent].children.push(element.id);
      // Elements written inside attribute values (`footprint={<footprint>…</footprint>}`) belong to this element.
      for (const attribute of opening.attributes) {
        const value = attribute.value as BabelNode | null | undefined;
        if (value) visit(value, attribute, { ...context, jsxParent: element.id, inAttr: tagName(attribute.name as BabelNode), depth: context.depth + 1 });
        else if (attribute.type === 'JSXSpreadAttribute') visit(attribute.argument as BabelNode, attribute, { ...context, jsxParent: element.id, depth: context.depth + 1 });
      }
      for (const child of node.children as BabelNode[]) visit(child, node, { ...context, jsxParent: element.id, inAttr: null, depth: context.depth + 1 });
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (Array.isArray(value)) { for (const item of value) if (isNode(item)) visit(item, node, context); } else if (isNode(value)) visit(value, node, context);
    }
  };
  visit(file.program, null, { jsxParent: null, inAttr: null, scope: 'top', owner: null, depth: 0 });

  const inMain = elements.filter((element) => element.scope === 'main');
  const root = inMain.find((element) => element.parent === null)?.id ?? null;
  const boards = elements.filter((element) => element.tag === 'board');
  const board = (boards.find((element) => element.scope === 'main') ?? boards[0])?.id ?? null;
  return { code, elements, board, root, errors, indentUnit: detectIndentUnit(elements, code), lineStarts };
}

/** The text of a span. */
export const slice = (index: SourceIndex, span: Span) => index.code.slice(span.start, span.end);

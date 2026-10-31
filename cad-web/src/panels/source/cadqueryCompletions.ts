import {
  insertBracket, insertCompletionText, pickedCompletion, snippet, snippetCompletion,
  type Completion, type CompletionContext, type CompletionResult, type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  COLOR_NAMES, CONSTRAINT_KINDS, PLANE_NAMES, SELECTOR_OPERATORS, membersOf, selectorDocs,
  type MemberDoc, type Param, type SelectorDoc, type SelectorEntity,
} from './cadqueryDocs';
import { linkAliasesFacet, resolverFor, type Resolver } from './cadqueryResolve';
import { paramPreview, renderMemberDoc } from './docRender';
import { cursorContext, isOp, tokenizeDoc, type CallSite, type CursorContext, type Tokenized } from './pythonContext';

const WORD = /^\w*$/;

const COMPLETION_TYPE: Record<MemberDoc['kind'], string> = {
  method: 'method',
  function: 'function',
  property: 'property',
  class: 'class',
  module: 'namespace',
  constant: 'constant',
};

/** Methods that are almost always called without arguments: complete as `name()`. */
const PREFER_EMPTY = new Set([
  'workplane', 'end', 'combine', 'clean', 'first', 'last', 'loft', 'cutThruAll', 'close', 'toPending', 'sketch',
  'finalize', 'reset', 'solve', 'toCompound', 'traverse', 'Volume', 'Area', 'BoundingBox', 'Center',
  'CenterOfBoundBox', 'copy', 'isValid',
]);

const SELECTOR_METHODS: Record<string, SelectorEntity> = {
  faces: 'faces', edges: 'edges', vertices: 'vertices', solids: 'solids', wires: 'wires', shells: 'shells',
  face: 'faces', edge: 'edges', vertex: 'vertices', solid: 'solids', wire: 'wires', shell: 'shells',
};

const KEYWORDS = [
  'return', 'lambda', 'and', 'or', 'not', 'in', 'is', 'with', 'as', 'pass', 'break', 'continue', 'elif', 'else',
  'except', 'finally', 'yield', 'assert', 'del', 'raise', 'global', 'nonlocal',
];

const KEYWORD_OPTIONS: readonly Completion[] = KEYWORDS.map((label) => ({ label, type: 'keyword', boost: -2 }));

/** Completions that should immediately reopen the list when picked (e.g. `faces(` → selectors). */
const reactivating = new WeakSet<Completion>();

export function shouldReactivate(completion: Completion): boolean {
  return reactivating.has(completion);
}

let memo: { doc: Text; pos: number; ctx: CursorContext } | null = null;

export function contextAt(state: EditorState, pos: number): CursorContext {
  if (memo && memo.doc === state.doc && memo.pos === pos) return memo.ctx;
  const ctx = cursorContext(tokenizeDoc(state.doc), pos);
  memo = { doc: state.doc, pos, ctx };
  return ctx;
}

/** Python globals worth offering in CAD scripts (lang-python lists every builtin and exception). */
const USEFUL_GLOBALS = new Set([
  'True', 'False', 'None', 'bool', 'dict', 'float', 'int', 'list', 'set', 'str', 'tuple', 'range', 'object', 'type',
  'super', 'abs', 'all', 'any', 'callable', 'divmod', 'enumerate', 'filter', 'format', 'getattr', 'hasattr',
  'isinstance', 'iter', 'len', 'map', 'max', 'min', 'next', 'pow', 'print', 'repr', 'reversed', 'round', 'setattr',
  'slice', 'sorted', 'sum', 'zip', 'Exception', 'ValueError', 'TypeError', 'RuntimeError', 'KeyError', 'IndexError',
  'AttributeError', 'NotImplementedError', 'ZeroDivisionError', 'AssertionError',
]);

/** Drops rarely useful builtins (`locals`, `BlockingIOError`, …) from lang-python's global completions. */
export function curatedGlobals(source: CompletionSource): CompletionSource {
  const keep = (result: CompletionResult | null): CompletionResult | null => result && {
    ...result,
    options: result.options.filter((o) => o.type === 'keyword' || USEFUL_GLOBALS.has(o.label)),
  };
  return (context) => {
    const result = source(context);
    return result instanceof Promise ? result.then(keep) : keep(result);
  };
}

/** Runs a generic Python source only where plain identifiers are expected. */
export function inCodeOnly(source: CompletionSource): CompletionSource {
  return (context) => (contextAt(context.state, context.pos).kind === 'word' ? source(context) : null);
}

export const cadqueryCompletionSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const { state, pos, explicit } = context;
  const ctx = contextAt(state, pos);
  const resolver = resolverFor(state);
  switch (ctx.kind) {
    case 'member': return memberResult(ctx, resolver);
    case 'string': return stringResult(ctx, resolver);
    case 'import': return importResult(ctx, state);
    case 'word': return wordResult(ctx, resolver, state, explicit);
    default: return null;
  }
};

// ---------------------------------------------------------------------------
// Members

function memberResult(ctx: Extract<CursorContext, { kind: 'member' }>, r: Resolver): CompletionResult | null {
  const type = r.typeOf(ctx.receiver);
  const members = membersOf(type);
  if (!members.length) return null;
  const options = members.map(memberCompletion);
  if (type === 'module:cq') options.push(...cqSnippets(r, false));
  return { from: ctx.from, options, validFor: WORD };
}

function memberCompletion(member: MemberDoc): Completion {
  const option: Completion = {
    label: member.name,
    type: COMPLETION_TYPE[member.kind],
    detail: paramPreview(member),
    info: () => renderMemberDoc(member),
    boost: member.rank,
    apply: callApply(member),
  };
  if (firstParamHasValues(member)) reactivating.add(option);
  return option;
}

function firstParamHasValues(member: MemberDoc): boolean {
  if (member.kind === 'class') return member.name === 'Workplane' || member.name === 'Color';
  return member.name in SELECTOR_METHODS && member.signatures[0]?.[0]?.default !== undefined;
}

function isCallable(member: MemberDoc): boolean {
  return member.kind === 'method' || member.kind === 'function' || (member.kind === 'class' && member.signatures.length > 0);
}

type ApplyFn = (view: EditorView, completion: Completion, from: number, to: number) => void;

/**
 * Methods with required parameters expand to a snippet with tab stops,
 * optional-only ones place the cursor inside auto-closed parentheses, and
 * argument-less ones complete to `name()`.
 */
function callApply(member: MemberDoc): ApplyFn | undefined {
  if (!isCallable(member)) return undefined;
  const sigs = member.signatures;
  const required = sigs.length === 1 ? sigs[0].filter((p) => p.default === undefined && !p.star && p.name) : [];
  const noParams = sigs.every((s) => s.length === 0);
  return (view, completion, from, to) => {
    const { state } = view;
    const insert = (text: string): void => view.dispatch({
      ...insertCompletionText(state, text, from, to),
      annotations: pickedCompletion.of(completion),
    });
    if (state.sliceDoc(to, to + 1) === '(') return insert(member.name);
    if (noParams || PREFER_EMPTY.has(member.name)) return insert(`${member.name}()`);
    if (required.length) {
      const fields = required.map((p) => `\${${p.name}}`).join(', ');
      return snippet(`${member.name}(${fields})\${}`)(view, completion, from, to);
    }
    insert(member.name);
    const head = view.state.selection.main.head;
    view.dispatch(insertBracket(view.state, '(') ?? { changes: { from: head, insert: '()' }, selection: { anchor: head + 1 } });
  };
}

// ---------------------------------------------------------------------------
// Argument values (selectors, plane names, literals…)

type ValueSpec =
  | { readonly kind: 'selector'; readonly entity: SelectorEntity }
  | { readonly kind: 'plane' }
  | { readonly kind: 'color' }
  | { readonly kind: 'constraint' }
  /** `exclusive`: the parameter accepts nothing but these literals. */
  | { readonly kind: 'literal'; readonly values: readonly string[]; readonly exclusive: boolean };

function paramAt(member: MemberDoc, call: CallSite): Param | undefined {
  for (const sig of member.signatures) {
    const p = call.keyword ? sig.find((q) => q.name === call.keyword) : sig[call.argIndex];
    if (p && !p.star) return p;
  }
  return undefined;
}

function valueSpec(member: MemberDoc, owner: string | null, call: CallSite): ValueSpec | null {
  if (member.name === 'constrain' && owner === 'Assembly') return { kind: 'constraint' };
  const p = paramAt(member, call);
  if (!p) return null;
  const entity = SELECTOR_METHODS[member.name];
  if (entity && (p.name === 'selector' || p.name === 's')) return { kind: 'selector', entity };
  if (p.name === 'inPlane' || p.name === 'stdName') return { kind: 'plane' };
  if (member.kind === 'class' && member.name === 'Color' && call.argIndex === 0 && !call.keyword) return { kind: 'color' };
  const type = p.type ?? '';
  const values = [...type.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const exclusive = type.split('|').every((t) => /^\s*"[^"]*"\s*$/.test(t));
  return values.length ? { kind: 'literal', values, exclusive } : null;
}

function docOptions(docs: readonly SelectorDoc[], type: string, quote: string | null): Completion[] {
  return docs.map((d, i) => ({
    label: quote ? `${quote}${d.value}${quote}` : d.value,
    detail: d.doc,
    type,
    boost: 50 - i,
  }));
}

function plainOptions(values: readonly string[], type: string, detail: string, quote: string | null): Completion[] {
  return values.map((value, i) => ({ label: quote ? `${quote}${value}${quote}` : value, type, detail, boost: 50 - i }));
}

function valueOptions(spec: ValueSpec, quote: string | null, r: Resolver): Completion[] {
  switch (spec.kind) {
    case 'selector': return docOptions(selectorDocs(spec.entity), 'selector', quote);
    case 'plane': return docOptions(PLANE_NAMES, 'value', quote);
    case 'color': return plainOptions(COLOR_NAMES, 'color', 'named color', quote);
    case 'literal': return spec.values.map((value, i) => {
      const plane = PLANE_NAMES.find((d) => d.value === value);
      return { label: quote ? `${quote}${value}${quote}` : value, type: 'value', detail: plane?.doc, boost: 50 - i };
    });
    case 'constraint': return [
      ...plainOptions(instanceNames(r.tz), 'part', 'assembly part', quote),
      ...docOptions(CONSTRAINT_KINDS, 'value', quote),
    ];
  }
}

/** Names given to assembly children: `name="…"` keyword arguments. */
function instanceNames(tz: Tokenized): string[] {
  const names = new Set<string>();
  const { tokens } = tz;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const s = tokens[i + 2];
    if (tokens[i].text === 'name' && isOp(tokens[i + 1], '=') && s.type === 'string' && s.closed) {
      const value = tz.source.slice(s.contentFrom, s.contentTo);
      if (/^[\w-]+$/.test(value)) names.add(value);
    }
  }
  return [...names];
}

function stringResult(ctx: Extract<CursorContext, { kind: 'string' }>, r: Resolver): CompletionResult | null {
  if (!ctx.call || !ctx.argument) return null;
  const callee = r.callee(ctx.call.callee);
  if (!callee) return null;
  const spec = valueSpec(callee.member, callee.owner, ctx.call);
  if (!spec) return null;

  if (spec.kind === 'constraint' && ctx.text.includes('@')) {
    const parts = ctx.text.split('@');
    const at = ctx.from + ctx.text.lastIndexOf('@') + 1;
    if (parts.length === 2) {
      const kinds = ['faces', 'edges', 'vertices', 'solids'].map((k) => ({ label: `${k}@`, type: 'value', detail: `select ${k}` }));
      return { from: at, options: kinds, validFor: /^\w*@?$/ };
    }
    const entity = SELECTOR_METHODS[parts[1]];
    return entity ? { from: at, options: docOptions(selectorDocs(entity), 'selector', null), validFor: /^[^@"']*$/ } : null;
  }

  if (spec.kind === 'selector') {
    const term = Math.max(ctx.text.lastIndexOf(' '), ctx.text.lastIndexOf('(')) + 1;
    const before = ctx.text.slice(0, term).trim();
    const lastWord = before.split(/[\s(]+/).pop() ?? '';
    const expectOperator = before !== '' && !/[(]$/.test(before) && !SELECTOR_OPERATORS.some((o) => o.value === lastWord);
    const options = expectOperator
      ? docOptions(SELECTOR_OPERATORS.slice(0, 3), 'keyword', null)
      : [...docOptions(selectorDocs(spec.entity), 'selector', null), ...(before ? docOptions(SELECTOR_OPERATORS.slice(3), 'keyword', null) : [])];
    return { from: ctx.from + term, options, validFor: /^[^\s()"']*$/ };
  }
  return { from: ctx.from, options: valueOptions(spec, null, r), validFor: /^[^"']*$/ };
}

// ---------------------------------------------------------------------------
// Imports

function importResult(ctx: Extract<CursorContext, { kind: 'import' }>, state: EditorState): CompletionResult | null {
  let options: Completion[] = [];
  if (ctx.module === null) {
    options = ctx.statement === 'from'
      ? [
          { label: 'links', type: 'namespace', detail: 'linked parts and designs', boost: 3 },
          { label: 'cadquery', type: 'namespace', detail: 'CadQuery', boost: 2 },
          { label: 'math', type: 'namespace', detail: 'standard library' },
        ]
      : [
          { label: 'cadquery', type: 'namespace', detail: 'as cq', apply: 'cadquery as cq', boost: 2 },
          { label: 'math', type: 'namespace', detail: 'standard library' },
        ];
  } else if (ctx.module === 'links') {
    options = state.facet(linkAliasesFacet)
      .filter((alias) => !ctx.imported.includes(alias))
      .map((alias) => ({ label: alias, type: 'part', detail: 'linked document', info: partInfo(alias) }));
  } else if (ctx.module === 'cadquery' || ctx.module === 'math') {
    options = membersOf(`module:${ctx.module === 'cadquery' ? 'cq' : 'math'}`)
      .filter((m) => !ctx.imported.includes(m.name))
      .map((m) => ({ ...memberCompletion(m), apply: undefined }));
  }
  return options.length ? { from: ctx.from, options, validFor: WORD } : null;
}

function partInfo(alias: string): string {
  return `Linked document. Place it with design.add(${alias}(), at=(x, y, z)), with parameter overrides as keyword arguments; ${alias}.result is its default geometry.`;
}

// ---------------------------------------------------------------------------
// Identifiers, keyword arguments and snippets

function wordResult(
  ctx: Extract<CursorContext, { kind: 'word' }>,
  r: Resolver,
  state: EditorState,
  explicit: boolean,
): CompletionResult | null {
  const options: Completion[] = [];
  const typed = ctx.word.length > 0 || explicit;
  const callee = ctx.call && !ctx.call.nested ? r.callee(ctx.call.callee) : null;

  if (callee && ctx.call && ctx.valueStart) {
    const spec = valueSpec(callee.member, callee.owner, ctx.call);
    // Unprompted lists only where a literal is (almost) certainly what comes next.
    const unprompted = spec?.kind !== 'literal' || spec.exclusive;
    if (spec && spec.kind !== 'constraint' && (typed || unprompted)) options.push(...valueOptions(spec, preferredQuote(r.tz), r));
  }
  if (callee && ctx.call && ctx.argStart && typed) options.push(...keywordArguments(callee.member, ctx.call));
  if (typed) {
    if (ctx.statementStart) options.push(...statementSnippets(r, state, ctx.indent));
    else options.push(...cqSnippets(r, true));
    options.push(...autoImports(r, state));
    options.push(...KEYWORD_OPTIONS);
  }
  return options.length ? { from: ctx.from, options, validFor: WORD } : null;
}

function keywordArguments(member: MemberDoc, call: CallSite): Completion[] {
  const seen = new Set<string>();
  const out: Completion[] = [];
  for (const sig of member.signatures) {
    sig.forEach((p, i) => {
      if (!p.name || p.star || i < call.positional || call.used.has(p.name) || seen.has(p.name)) return;
      seen.add(p.name);
      out.push({
        label: `${p.name}=`,
        type: 'kwarg',
        detail: p.type ?? '',
        boost: 10 - Math.min(i, 9),
        info: p.default !== undefined ? `Default: ${p.default}` : undefined,
      });
    });
  }
  return out;
}

function statementSnippets(r: Resolver, state: EditorState, indent: number): Completion[] {
  const out: Completion[] = [];
  if (!r.isAssigned('result')) {
    out.push(snippetCompletion('result = ${}', {
      label: 'result',
      detail: '= final model',
      type: 'snippet',
      boost: 4,
      info: 'Assign the final Workplane or Shape (part) or cq.Assembly (assembly) to result.',
    }));
  }
  out.push(...cqSnippets(r, true));
  if (indent > 0) return out;
  const A = r.cqAlias;
  const head = r.hasCadqueryImport() ? '' : 'import cadquery as cq\n\n';
  out.push(snippetCompletion(
    `${head}# Dimensions in millimeters.\nlength = \${1:40}\nwidth = \${2:30}\nheight = \${3:10}\n\nresult = (\n    ${A}.Workplane("XY")\n    .box(length, width, height)\n    .edges("|Z").fillet(\${4:2})\n)\n\${}`,
    { label: 'part', detail: 'template', type: 'snippet', info: 'A parametric part: dimensions plus a Workplane chain assigned to result.' },
  ));
  const alias = state.facet(linkAliasesFacet)[0];
  const importLine = alias && !r.linkNames.has(alias) ? `from links import ${alias}\n` : '';
  const imports = head || importLine ? `${head.trimEnd()}${head ? '\n' : ''}${importLine}\n` : '';
  const partExpr = alias ? `${alias}.result` : '${2:part}';
  out.push(snippetCompletion(
    `${imports}result = ${A}.Assembly(name="\${1:assembly}")\nresult.add(\n    ${partExpr},\n    name="\${3:${alias ?? 'part'}}",\n    loc=${A}.Location(${A}.Vector(\${4:0}, \${5:0}, \${6:0})),\n    color=${A}.Color(\${7:0.39}, \${8:0.72}, \${9:0.65}),\n)\n\${}`,
    { label: 'assembly', detail: 'template', type: 'snippet', info: 'An assembly: result = cq.Assembly(…) with a placed, colored part.' },
  ));
  if (!r.hasCadqueryImport()) {
    out.push({ label: 'import cadquery as cq', type: 'snippet', detail: 'import', boost: 3 });
  }
  for (const a of state.facet(linkAliasesFacet)) {
    if (!r.linkNames.has(a)) out.push({ label: `from links import ${a}`, type: 'snippet', detail: 'linked document', info: partInfo(a), boost: 2 });
  }
  return out;
}

/** CadQuery constructor snippets; `qualified` prefixes them with the cadquery alias. */
function cqSnippets(r: Resolver, qualified: boolean): Completion[] {
  const A = qualified ? `${r.cqAlias}.` : '';
  const make = (label: string, template: string, info: string): Completion =>
    snippetCompletion(template, { label, detail: 'snippet', type: 'snippet', info });
  return [
    make('Location(Vector(x, y, z))', `${A}Location(${qualified ? A : r.cqAlias + '.'}Vector(\${1:0}, \${2:0}, \${3:0}))`, 'Placement by translation: cq.Location(cq.Vector(x, y, z)).'),
    make('Color(r, g, b)', `${A}Color(\${1:0.8}, \${2:0.8}, \${3:0.8})`, 'RGB color with components from 0 to 1.'),
    ...(qualified
      ? [
          make('Vector(x, y, z)', `${A}Vector(\${1:0}, \${2:0}, \${3:0})`, 'A 3D point or direction.'),
          make('Workplane("XY")', `${A}Workplane("\${1:XY}")`, 'A new Workplane on a named plane.'),
        ]
      : []),
  ];
}

/** Link aliases (and `cq`) that are not imported yet: completing them adds the import. */
function autoImports(r: Resolver, state: EditorState): Completion[] {
  const out: Completion[] = [];
  for (const alias of state.facet(linkAliasesFacet)) {
    if (r.linkNames.has(alias)) continue;
    out.push({
      label: alias,
      type: 'part',
      detail: 'linked document · auto-import',
      info: partInfo(alias),
      apply: withImport(alias, `from links import ${alias}`),
    });
  }
  if (!r.hasCadqueryImport()) {
    out.push({ label: 'cq', type: 'namespace', detail: 'import cadquery as cq', apply: withImport('cq', 'import cadquery as cq') });
  }
  return out;
}

function withImport(text: string, importLine: string): ApplyFn {
  return (view, completion, from, to) => {
    const { pos: at, insert } = importInsertion(view.state, importLine);
    const importFirst = at <= from;
    view.dispatch({
      changes: importFirst
        ? [{ from: at, insert }, { from, to, insert: text }]
        : [{ from, to, insert: text }, { from: at, insert }],
      selection: { anchor: from + text.length + (importFirst ? insert.length : 0) },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
  };
}

/** Insert after the last top-level import, or at the top of the document. */
function importInsertion(state: EditorState, line: string): { pos: number; insert: string } {
  let last: { to: number } | null = null;
  for (let n = 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (/^(import|from)\s/.test(l.text)) last = l;
    else if (last && l.text.trim() && !l.text.startsWith('#')) break;
  }
  if (!last) return { pos: 0, insert: `${line}\n` };
  return last.to < state.doc.length ? { pos: last.to + 1, insert: `${line}\n` } : { pos: last.to, insert: `\n${line}` };
}

function preferredQuote(tz: Tokenized): string {
  let single = 0;
  let double = 0;
  for (const t of tz.tokens) {
    if (t.type !== 'string') continue;
    const q = tz.source[t.contentFrom! - 1];
    if (q === "'") single++;
    else if (q === '"') double++;
  }
  return single > double ? "'" : '"';
}

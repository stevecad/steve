import { Facet, type EditorState } from '@codemirror/state';
import {
  cadqueryClass, guessMember, instanceKey, memberOf, parseParams, typeKey, type MemberDoc,
} from './cadqueryDocs';
import {
  chainBefore, isOp, lineIndent, matchClose, startsStatement, statementEnd, tokenizeDoc,
  type Segment, type Token, type Tokenized,
} from './pythonContext';

/** A design's linked documents, importable with `from links import <alias>`. */
export const linkAliasesFacet = Facet.define<readonly string[], readonly string[]>({
  combine: (values) => values.flat(),
});

export type Resolved =
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'callable'; readonly member: MemberDoc; readonly owner: string | null };

interface Assignment {
  /** Token range of the right-hand side. */
  readonly from: number;
  readonly to: number;
  /** Document position where the statement ends. */
  readonly end: number;
}

interface LocalDef {
  readonly nameIndex: number;
  readonly params: string;
}

const MAX_DEPTH = 8;

/**
 * Best-effort static types for a Python document: follows imports,
 * assignments, local function returns and CadQuery method chains.
 */
export class Resolver {
  readonly cqNames = new Set<string>();
  readonly mathNames = new Set<string>();
  readonly linkNames = new Set<string>();
  /** `from cadquery import X as Y` → Y → X (same for math). */
  readonly cqImports = new Map<string, string>();
  readonly mathImports = new Map<string, string>();
  private readonly assignments = new Map<string, Assignment[]>();
  private readonly defs = new Map<string, LocalDef>();
  private readonly defDocs = new Map<string, MemberDoc>();
  private readonly tokens: readonly Token[];

  constructor(readonly tz: Tokenized, readonly aliases: readonly string[]) {
    this.tokens = tz.tokens;
    this.scan();
    if (!this.cqNames.size) this.cqNames.add('cq');
  }

  private scan(): void {
    const { tokens } = this;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'name' || !startsStatement(tokens, i)) continue;
      const end = statementEnd(tokens, i);
      if (t.text === 'import') this.scanImport(i + 1, end);
      else if (t.text === 'from') this.scanFromImport(i + 1, end);
      else if (t.text === 'def' && tokens[i + 1]?.type === 'name' && isOp(tokens[i + 2], '(')) {
        const close = matchClose(tokens, i + 2);
        if (close > 0) {
          this.defs.set(tokens[i + 1].text, {
            nameIndex: i + 1,
            params: this.tz.source.slice(tokens[i + 2].to, tokens[close].from),
          });
        }
      } else if (isOp(tokens[i + 1], '=') && end >= i + 2) {
        const list = this.assignments.get(t.text) ?? [];
        list.push({ from: i + 2, to: end, end: tokens[end].to });
        this.assignments.set(t.text, list);
      }
    }
  }

  private scanImport(from: number, to: number): void {
    // import cadquery as cq, math
    for (const [module, alias] of this.importList(from, to)) {
      if (module === 'cadquery') this.cqNames.add(alias);
      else if (module === 'math') this.mathNames.add(alias);
    }
  }

  private scanFromImport(from: number, to: number): void {
    const { tokens } = this;
    let i = from;
    let module = '';
    while (i <= to && !(tokens[i].type === 'name' && tokens[i].text === 'import')) module += tokens[i++].text;
    for (const [name, alias] of this.importList(i + 1, to)) {
      if (module === 'links') this.linkNames.add(alias);
      else if (module === 'cadquery') this.cqImports.set(alias, name);
      else if (module === 'math') this.mathImports.set(alias, name);
    }
  }

  private importList(from: number, to: number): [string, string][] {
    const out: [string, string][] = [];
    const { tokens } = this;
    let i = from;
    while (i <= to) {
      let name = '';
      while (i <= to && (tokens[i].type === 'name' || isOp(tokens[i], '.')) && tokens[i].text !== 'as') name += tokens[i++].text;
      let alias = name;
      if (i <= to && tokens[i].text === 'as' && tokens[i + 1]?.type === 'name') {
        alias = tokens[i + 1].text;
        i += 2;
      }
      if (name) out.push([name, alias]);
      i++;
    }
    return out;
  }

  isImported(name: string): boolean {
    return this.cqNames.has(name) || this.mathNames.has(name) || this.linkNames.has(name)
      || this.cqImports.has(name) || this.mathImports.has(name);
  }

  hasCadqueryImport(): boolean {
    return this.tokens.some((t, i) => t.text === 'cadquery' && i > 0 && (this.tokens[i - 1].text === 'import' || this.tokens[i - 1].text === 'from'));
  }

  isAssigned(name: string): boolean {
    return this.assignments.has(name);
  }

  get cqAlias(): string {
    return this.cqNames.values().next().value ?? 'cq';
  }

  resolveChain(segs: readonly Segment[] | null, depth = 0): Resolved | null {
    if (!segs || depth > MAX_DEPTH) return null;
    return segs.reduce<Resolved | null>((cur, seg) => this.step(cur, seg, depth), null);
  }

  private step(cur: Resolved | null, seg: Segment, depth: number): Resolved | null {
    switch (seg.kind) {
      case 'name': return this.resolveName(seg.name, seg.pos, depth);
      case 'group': return this.resolveChain(seg.inner, depth + 1);
      case 'literal': return { kind: 'type', type: `literal:${seg.literal}` };
      case 'attr': return this.attribute(cur, seg.name);
      case 'call': return this.call(cur);
      case 'index': return cur?.kind === 'type' && cur.type.startsWith('list:') ? { kind: 'type', type: cur.type.slice(5) } : null;
    }
  }

  /** Type key of an expression (null for callables and unknowns). */
  typeOf(segs: readonly Segment[] | null): string | null {
    const r = this.resolveChain(segs);
    return r?.kind === 'type' ? r.type : null;
  }

  /** The documented callable (method, function or class constructor) an expression refers to. */
  callee(segs: readonly Segment[] | null): { member: MemberDoc; owner: string | null } | null {
    const r = this.resolveChain(segs);
    if (!r) return null;
    if (r.kind === 'callable') return { member: r.member, owner: r.owner };
    if (r.type.startsWith('class:')) {
      const member = cadqueryClass(r.type.slice(6));
      return member ? { member, owner: 'cq' } : null;
    }
    return null;
  }

  attribute(cur: Resolved | null, name: string): Resolved | null {
    if (cur?.kind === 'type') {
      const member = memberOf(cur.type, name);
      return member ? fromMember(member, cur.type) : null;
    }
    if (cur) return null;
    const guess = guessMember(name);
    return guess ? { kind: 'callable', member: guess.member, owner: guess.owner } : null;
  }

  private call(cur: Resolved | null): Resolved | null {
    if (!cur) return null;
    if (cur.kind === 'callable') {
      const key = typeKey(cur.member.returns);
      return key ? { kind: 'type', type: key } : null;
    }
    if (cur.type.startsWith('class:')) {
      const key = instanceKey(cur.type.slice(6));
      return key ? { kind: 'type', type: key } : null;
    }
    return null;
  }

  resolveName(name: string, pos: number, depth = 0): Resolved | null {
    if (this.cqNames.has(name)) return { kind: 'type', type: 'module:cq' };
    if (this.mathNames.has(name)) return { kind: 'type', type: 'module:math' };
    const cqName = this.cqImports.get(name);
    if (cqName) return this.attribute({ kind: 'type', type: 'module:cq' }, cqName);
    const mathName = this.mathImports.get(name);
    if (mathName) return this.attribute({ kind: 'type', type: 'module:math' }, mathName);
    if (this.linkNames.has(name) || this.aliases.includes(name)) return { kind: 'type', type: 'part' };

    const assigned = this.assignments.get(name)?.filter((a) => a.end <= pos).pop();
    if (assigned) {
      return this.resolveChain(chainBefore(this.tokens, assigned.to, assigned.from), depth + 1);
    }
    const def = this.localFunction(name, depth);
    return def ? { kind: 'callable', member: def, owner: null } : null;
  }

  /** Documentation for a function defined in the document, with its inferred return type. */
  localFunction(name: string, depth = 0): MemberDoc | null {
    const cached = this.defDocs.get(name);
    if (cached) return cached;
    const def = this.defs.get(name);
    if (!def || depth > MAX_DEPTH) return null;
    const member: MemberDoc = {
      name,
      kind: 'function',
      owner: 'local',
      signatures: [parseParams(def.params)],
      returns: this.returnType(def, depth) ?? undefined,
      doc: 'Function defined in this file.',
      group: 'Local',
      rank: 1,
    };
    this.defDocs.set(name, member);
    return member;
  }

  private returnType(def: LocalDef, depth: number): string | null {
    const { tokens, tz } = this;
    const defToken = tokens[def.nameIndex - 1];
    const indent = lineIndent(tz.source, defToken.from);
    for (let i = def.nameIndex + 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (!startsStatement(tokens, i) || t.type === 'newline') continue;
      if (lineIndent(tz.source, t.from) <= indent) break;
      if (t.type === 'name' && t.text === 'return') {
        const end = statementEnd(tokens, i + 1);
        const r = this.resolveChain(chainBefore(tokens, end, i + 1), depth + 1);
        return r?.kind === 'type' ? r.type : null;
      }
    }
    return null;
  }
}

function fromMember(member: MemberDoc, owner: string): Resolved | null {
  switch (member.kind) {
    case 'method':
    case 'function':
      return { kind: 'callable', member, owner };
    case 'class':
      return { kind: 'type', type: `class:${member.name}` };
    case 'module':
      return member.returns ? { kind: 'type', type: member.returns } : null;
    default: {
      const key = typeKey(member.returns);
      return key ? { kind: 'type', type: key } : null;
    }
  }
}

const resolvers = new WeakMap<Tokenized, Resolver>();

export function resolverFor(state: EditorState): Resolver {
  const tz = tokenizeDoc(state.doc);
  const aliases = state.facet(linkAliasesFacet);
  let r = resolvers.get(tz);
  if (!r || r.aliases !== aliases) {
    r = new Resolver(tz, aliases);
    resolvers.set(tz, r);
  }
  return r;
}

/** Human-readable form of a type key. */
export function displayType(type: string): string {
  if (type === 'module:cq') return 'module cadquery';
  if (type.startsWith('module:')) return `module ${type.slice(7)}`;
  if (type.startsWith('class:')) return `class ${type.slice(6)}`;
  if (type.startsWith('list:')) return `list[${type.slice(5)}]`;
  if (type.startsWith('literal:')) return { str: 'str', number: 'number', list: 'list', tuple: 'tuple', dict: 'dict' }[type.slice(8)] ?? type;
  if (type === 'part') return 'linked document';
  return type;
}

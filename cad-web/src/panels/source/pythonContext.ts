import type { Text } from '@codemirror/state';

/*
 * A small, error-tolerant Python tokenizer plus the backward "chain" analysis
 * used by completion, hover and signature help. It deliberately knows nothing
 * about CadQuery; see cadqueryResolve.ts for types.
 */

export type TokenType = 'name' | 'number' | 'string' | 'op' | 'newline';

export interface Token {
  readonly type: TokenType;
  readonly from: number;
  readonly to: number;
  readonly text: string;
  /** Newlines inside brackets do not end a statement. */
  readonly soft?: boolean;
  /** Strings: the content range between the quotes, and whether it was terminated. */
  readonly contentFrom?: number;
  readonly contentTo?: number;
  readonly closed?: boolean;
}

export interface Tokenized {
  readonly source: string;
  readonly tokens: readonly Token[];
  readonly comments: readonly (readonly [number, number])[];
}

export const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

const NAME = /[A-Za-z_ -￿][\w -￿]*/y;
const NUMBER = /(?:0[xXoObB][\da-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?)/y;
const STRING_START = /([rRbBuUfF]{0,2})('''|"""|'|")/y;
const OPS3 = new Set(['**=', '//=', '>>=', '<<=', '...']);
const OPS2 = new Set(['**', '//', '==', '!=', '<=', '>=', '->', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '<<', '>>']);
const OPEN = '([{';
const CLOSE = ')]}';

export function tokenize(source: string): Tokenized {
  const tokens: Token[] = [];
  const comments: [number, number][] = [];
  const n = source.length;
  let i = 0;
  let depth = 0;
  let lineStart = true;

  while (i < n) {
    if (lineStart) {
      lineStart = false;
      let j = i;
      while (j < n && (source[j] === ' ' || source[j] === '\t')) j++;
      // Resync after an unclosed bracket: an unindented identifier starts a new statement.
      if (depth > 0 && j === i && j < n && /[A-Za-z_]/.test(source[j])) depth = 0;
      i = j;
      continue;
    }
    const c = source[i];
    if (c === '\n') {
      tokens.push({ type: 'newline', from: i, to: i + 1, text: '\n', soft: depth > 0 });
      i++;
      lineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }
    if (c === '\\' && source[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') {
      const end = source.indexOf('\n', i);
      const to = end < 0 ? n : end;
      comments.push([i, to]);
      i = to;
      continue;
    }

    STRING_START.lastIndex = i;
    const str = STRING_START.exec(source);
    if (str && (str[1] === '' || !/[\w]/.test(source[i - 1] ?? ''))) {
      const quote = str[2];
      const triple = quote.length === 3;
      const contentFrom = i + str[0].length;
      let j = contentFrom;
      let closed = false;
      while (j < n) {
        const ch = source[j];
        if (ch === '\\') { j += 2; continue; }
        if (!triple && ch === '\n') break;
        if (source.startsWith(quote, j)) { closed = true; break; }
        j++;
      }
      const contentTo = Math.min(j, n);
      const to = closed ? j + quote.length : contentTo;
      tokens.push({ type: 'string', from: i, to, text: source.slice(i, to), contentFrom, contentTo, closed });
      i = to;
      continue;
    }

    if (c === '.' && !/\d/.test(source[i + 1] ?? '')) {
      tokens.push({ type: 'op', from: i, to: i + 1, text: '.' });
      i++;
      continue;
    }
    NUMBER.lastIndex = i;
    const num = /[\d.]/.test(c) ? NUMBER.exec(source) : null;
    if (num && num[0]) {
      tokens.push({ type: 'number', from: i, to: i + num[0].length, text: num[0] });
      i += num[0].length;
      continue;
    }
    NAME.lastIndex = i;
    const name = NAME.exec(source);
    if (name) {
      tokens.push({ type: 'name', from: i, to: i + name[0].length, text: name[0] });
      i += name[0].length;
      continue;
    }

    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    const op = OPS3.has(three) ? three : OPS2.has(two) ? two : c;
    if (OPEN.includes(op)) depth++;
    else if (CLOSE.includes(op)) depth = Math.max(0, depth - 1);
    tokens.push({ type: 'op', from: i, to: i + op.length, text: op });
    i += op.length;
  }
  return { source, tokens, comments };
}

const cache = new WeakMap<Text, Tokenized>();

export function tokenizeDoc(doc: Text): Tokenized {
  let result = cache.get(doc);
  if (!result) {
    result = tokenize(doc.toString());
    cache.set(doc, result);
  }
  return result;
}

/** Index of the last token starting before `pos`, or -1. */
export function lastTokenBefore(tokens: readonly Token[], pos: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].from < pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

export function isOp(token: Token | undefined, text: string): boolean {
  return !!token && token.type === 'op' && token.text === text;
}

function isHardNewline(token: Token | undefined): boolean {
  return !!token && token.type === 'newline' && !token.soft;
}

/** Step backwards over soft newlines. */
export function skipSoft(tokens: readonly Token[], i: number, lower = 0): number {
  while (i >= lower && tokens[i].type === 'newline' && tokens[i].soft) i--;
  return i;
}

function inComment(comments: Tokenized['comments'], pos: number): boolean {
  for (const [from, to] of comments) if (pos > from && pos <= to) return true;
  return false;
}

/** Matching opener for the closing bracket at `close`, or -1. */
export function matchOpen(tokens: readonly Token[], close: number, lower = 0): number {
  let depth = 0;
  for (let i = close; i >= lower; i--) {
    const t = tokens[i];
    if (isHardNewline(t)) return -1;
    if (t.type !== 'op') continue;
    if (CLOSE.includes(t.text)) depth++;
    else if (OPEN.includes(t.text) && --depth === 0) return i;
  }
  return -1;
}

/** Matching closer for the opening bracket at `open`, or -1. */
export function matchClose(tokens: readonly Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (isHardNewline(t)) return -1;
    if (t.type !== 'op') continue;
    if (OPEN.includes(t.text)) depth++;
    else if (CLOSE.includes(t.text) && --depth === 0) return i;
  }
  return -1;
}

export type Segment =
  | { readonly kind: 'name'; readonly name: string; readonly pos: number }
  | { readonly kind: 'attr'; readonly name: string; readonly pos: number }
  | { readonly kind: 'call'; readonly open: number; readonly close: number }
  | { readonly kind: 'index' }
  | { readonly kind: 'group'; readonly inner: readonly Segment[] | null }
  | { readonly kind: 'literal'; readonly literal: 'str' | 'number' | 'list' | 'tuple' | 'dict' };

function callableBefore(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.type === 'name') return !PY_KEYWORDS.has(token.text);
  return token.type === 'string' || isOp(token, ')') || isOp(token, ']');
}

function hasTopLevelComma(tokens: readonly Token[], from: number, to: number): boolean {
  let depth = 0;
  for (let i = from; i <= to; i++) {
    const t = tokens[i];
    if (t.type !== 'op') continue;
    if (OPEN.includes(t.text)) depth++;
    else if (CLOSE.includes(t.text)) depth--;
    else if (t.text === ',' && depth === 0) return true;
  }
  return false;
}

/**
 * Parse the postfix expression ending at token `end` (inclusive) backwards,
 * e.g. `cq.Workplane("XY").box(1, 2, 3)` → name, attr, call, attr, call.
 */
export function chainBefore(tokens: readonly Token[], end: number, lower = 0): Segment[] | null {
  const segs: Segment[] = [];
  let i = skipSoft(tokens, end, lower);
  while (i >= lower) {
    const t = tokens[i];
    if (t.type === 'op' && CLOSE.includes(t.text)) {
      const open = matchOpen(tokens, i, lower);
      if (open < 0) return null;
      const before = skipSoft(tokens, open - 1, lower);
      if (t.text === '}') {
        segs.push({ kind: 'literal', literal: 'dict' });
        break;
      }
      if (before < lower || !callableBefore(tokens[before])) {
        if (t.text === ']') segs.push({ kind: 'literal', literal: 'list' });
        else if (hasTopLevelComma(tokens, open + 1, i - 1)) segs.push({ kind: 'literal', literal: 'tuple' });
        else segs.push({ kind: 'group', inner: chainBefore(tokens, i - 1, open + 1) });
        break;
      }
      segs.push(t.text === ')' ? { kind: 'call', open, close: i } : { kind: 'index' });
      i = before;
      continue;
    }
    if (t.type === 'name') {
      if (PY_KEYWORDS.has(t.text) && t.text !== 'None' && t.text !== 'True' && t.text !== 'False') return null;
      const p = skipSoft(tokens, i - 1, lower);
      if (p >= lower && isOp(tokens[p], '.')) {
        segs.push({ kind: 'attr', name: t.text, pos: t.from });
        i = skipSoft(tokens, p - 1, lower);
        continue;
      }
      segs.push({ kind: 'name', name: t.text, pos: t.from });
      break;
    }
    if (t.type === 'string') { segs.push({ kind: 'literal', literal: 'str' }); break; }
    if (t.type === 'number') { segs.push({ kind: 'literal', literal: 'number' }); break; }
    return null;
  }
  const root = segs[segs.length - 1];
  if (!root || root.kind === 'attr' || root.kind === 'call' || root.kind === 'index') return null;
  return segs.reverse();
}

export interface CallSite {
  /** Token index of the call's `(`. */
  readonly open: number;
  readonly callee: readonly Segment[] | null;
  /** Zero-based index of the argument containing the cursor. */
  readonly argIndex: number;
  /** `name` when the current argument is written as `name=…`. */
  readonly keyword: string | null;
  /** Number of positional arguments before the current one. */
  readonly positional: number;
  /** The cursor sits inside a bracketed literal within the argument. */
  readonly nested: boolean;
  /** Keyword arguments used anywhere in the call. */
  readonly used: ReadonlySet<string>;
}

/** The innermost call whose argument list contains the token `last` (or the gap after it). */
export function callSiteBefore(tokens: readonly Token[], last: number): CallSite | null {
  let depth = 0;
  let nested = false;
  for (let i = last; i >= 0; i--) {
    const t = tokens[i];
    if (isHardNewline(t)) return null;
    if (t.type !== 'op') continue;
    if (CLOSE.includes(t.text)) depth++;
    else if (OPEN.includes(t.text)) {
      if (depth > 0) { depth--; continue; }
      const before = skipSoft(tokens, i - 1);
      if (t.text !== '(' || !callableBefore(tokens[before])) {
        nested = true;
        continue;
      }
      return describeCall(tokens, i, last, nested, before);
    }
  }
  return null;
}

function describeCall(tokens: readonly Token[], open: number, last: number, nested: boolean, calleeEnd: number): CallSite {
  const close = matchClose(tokens, open);
  const end = close < 0 ? tokens.length - 1 : close - 1;
  const used = new Set<string>();
  let depth = 0;
  let argIndex = 0;
  let positional = 0;
  let first = skipSoftForward(tokens, open + 1);
  let current = first;
  let currentIsKeyword = false;
  for (let i = open + 1; i <= end; i++) {
    const t = tokens[i];
    if (isHardNewline(t)) break;
    if (i === first && t.type === 'name' && isOp(tokens[i + 1], '=')) {
      used.add(t.text);
      if (i <= last) currentIsKeyword = true;
    }
    if (t.type !== 'op') continue;
    if (OPEN.includes(t.text)) depth++;
    else if (CLOSE.includes(t.text)) depth--;
    else if (depth === 0 && t.text === ',') {
      first = skipSoftForward(tokens, i + 1);
      if (i <= last) {
        if (!currentIsKeyword) positional++;
        argIndex++;
        current = first;
        currentIsKeyword = false;
      }
    }
  }
  const keyword = tokens[current]?.type === 'name' && isOp(tokens[current + 1], '=') && current + 1 <= last
    ? tokens[current].text
    : null;
  return { open, callee: chainBefore(tokens, calleeEnd), argIndex, keyword, positional, nested, used };
}

function skipSoftForward(tokens: readonly Token[], i: number): number {
  while (i < tokens.length && tokens[i].type === 'newline' && tokens[i].soft) i++;
  return i;
}

export type CursorContext =
  | { readonly kind: 'none' }
  | { readonly kind: 'member'; readonly from: number; readonly word: string; readonly receiver: readonly Segment[] | null }
  | {
      readonly kind: 'string';
      readonly from: number;
      readonly to: number;
      readonly text: string;
      readonly call: CallSite | null;
      /** The string is the whole current argument (not nested in a literal). */
      readonly argument: boolean;
    }
  | {
      readonly kind: 'word';
      readonly from: number;
      readonly word: string;
      readonly call: CallSite | null;
      /** The cursor starts a new argument of `call`. */
      readonly argStart: boolean;
      /** The cursor starts an argument value (a new argument, or right after `name=`). */
      readonly valueStart: boolean;
      /** The word starts a statement. */
      readonly statementStart: boolean;
      readonly indent: number;
    }
  | {
      readonly kind: 'import';
      readonly from: number;
      readonly word: string;
      readonly statement: 'import' | 'from';
      /** Module being imported from (`from X import …`), or null when completing module names. */
      readonly module: string | null;
      readonly imported: readonly string[];
    };

const NONE: CursorContext = { kind: 'none' };

export function cursorContext(tz: Tokenized, pos: number): CursorContext {
  const { tokens, source } = tz;
  if (inComment(tz.comments, pos)) return NONE;
  const i = lastTokenBefore(tokens, pos);
  const t = i >= 0 ? tokens[i] : undefined;

  if (t?.type === 'string') {
    const cFrom = t.contentFrom ?? t.to;
    const cTo = t.contentTo ?? t.to;
    if (pos >= cFrom && pos <= cTo && (!t.closed || pos < t.to)) {
      const call = callSiteBefore(tokens, i - 1);
      const prev = tokens[skipSoft(tokens, i - 1)];
      const argument = !!call && !call.nested && (isOp(prev, '(') || isOp(prev, ',') || isOp(prev, '='));
      return { kind: 'string', from: cFrom, to: pos, text: source.slice(cFrom, pos), call, argument };
    }
  }

  let from = pos;
  let word = '';
  let prevIndex = i;
  if (t && t.type === 'name' && t.to >= pos) {
    from = t.from;
    word = source.slice(t.from, pos);
    prevIndex = i - 1;
  } else if (t && (t.to > pos || (t.type === 'number' && t.to === pos))) {
    return NONE;
  }

  const p = skipSoft(tokens, prevIndex);
  const prev = p >= 0 ? tokens[p] : undefined;
  if (isOp(prev, '.')) {
    let r = skipSoft(tokens, p - 1);
    // A dot leading a line outside brackets: pragmatically treat it as a continuation.
    while (r >= 0 && isHardNewline(tokens[r])) r--;
    return { kind: 'member', from, word, receiver: r >= 0 ? chainBefore(tokens, r) : null };
  }

  let s = p;
  while (s >= 0 && !isHardNewline(tokens[s]) && !isOp(tokens[s], ';')) s--;
  const stmt = tokens.slice(s + 1, p + 1).filter((tok) => tok.type !== 'newline');
  const head = stmt[0];
  if (head?.type === 'name' && (head.text === 'import' || head.text === 'from')) {
    const importAt = stmt.findIndex((tok) => tok.type === 'name' && tok.text === 'import');
    if (head.text === 'from' && importAt > 0) {
      const module = stmt.slice(1, importAt).map((tok) => tok.text).join('');
      const imported = stmt.slice(importAt + 1).filter((tok) => tok.type === 'name').map((tok) => tok.text);
      return { kind: 'import', from, word, statement: 'from', module, imported };
    }
    const tail = stmt[stmt.length - 1];
    if (stmt.length === 1 || (head.text === 'import' && isOp(tail, ','))) {
      return { kind: 'import', from, word, statement: head.text, module: null, imported: [] };
    }
    if (head.text === 'from' && stmt.length > 1) return NONE;
  }

  const call = callSiteBefore(tokens, p);
  const argStart = !!call && !call.nested && (isOp(prev, '(') || isOp(prev, ','));
  const valueStart = argStart || (!!call && !call.nested && call.keyword !== null && isOp(prev, '='));
  const statementStart = !prev || isHardNewline(prev) || isOp(prev, ';');
  return { kind: 'word', from, word, call, argStart, valueStart, statementStart, indent: lineIndent(source, from) };
}

/** Index of the last token of the statement containing token `start`. */
export function statementEnd(tokens: readonly Token[], start: number): number {
  let i = start;
  while (i < tokens.length && !isHardNewline(tokens[i]) && !isOp(tokens[i], ';')) i++;
  return i - 1;
}

/** True when token `i` is the first token of a statement. */
export function startsStatement(tokens: readonly Token[], i: number): boolean {
  const prev = tokens[i - 1];
  return !prev || isHardNewline(prev) || isOp(prev, ';');
}

/** Width of the leading whitespace on the line of `pos`, for `pos` at the line's first token. */
export function lineIndent(source: string, pos: number): number {
  const line = source.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(source.slice(line, pos))?.[0].length ?? 0;
}

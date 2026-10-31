/**
 * The TSX source index: every JSX element of a circuit file with the spans the human tools splice.
 *
 * Offsets are UTF-16 code units (JavaScript string indices), as the editor and `@babel/parser` use them.
 */

export interface Span { start: number; end: number }

/** How an attribute's value is written. Everything but `computed` has a literal value an edit may rewrite. */
export type AttrKind = 'flag' | 'string' | 'number' | 'boolean' | 'null' | 'template' | 'object' | 'array' | 'element' | 'computed';

/** A string literal (or the text of a static template) inside an attribute value: where selectors are renamed. */
export interface StringPiece {
  /** The characters between the quotes (or backticks) as written. */
  span: Span;
  /** The written text, escapes included. */
  raw: string;
}

export interface Attr {
  name: string;
  /** The whole attribute, `name="value"`. */
  span: Span;
  nameSpan: Span;
  /** The value as written, quotes or braces included; null for a bare flag (`<led showAsTranslucentModel />`). */
  valueSpan: Span | null;
  kind: AttrKind;
  /** True when `value` holds the literal value (flags, strings, numbers, booleans, null, static templates/objects/arrays). */
  static: boolean;
  /** The literal value when `static`. A flag is `true`. */
  value?: unknown;
  /** The value's source text (empty for a flag). */
  raw: string;
  /** Every string literal inside the value, also inside computed expressions (`{"U1." + pin}`). */
  strings: StringPiece[];
}

/**
 * Where an element sits in the program:
 * - `main`: the default export's own JSX, rendered once;
 * - `callback`: inside a function in it (`{pins.map((p) => <trace … />)}`), so it may render many times or not at all;
 * - `component`: inside another function (a user component used as `<MyPart />`), rendered once per use.
 */
export type ElementScope = 'main' | 'callback' | 'component';

export interface Element {
  /** Index in `SourceIndex.elements` (document order). */
  id: number;
  /** `resistor`, `board`, or a user component like `MyModule` or `Lib.Part`. */
  tag: string;
  /** Lowercase tags are tscircuit elements; capitalized ones are user components. */
  intrinsic: boolean;
  /** The literal `name`, or null when it's absent or computed (see `nameComputed`). */
  name: string | null;
  nameComputed: boolean;
  parent: number | null;
  children: number[];
  /** The attribute the element is written in (`footprint={<footprint>…</footprint>}`), else null. */
  inAttr: string | null;
  span: Span;
  /** `<tag … >` or `<tag … />`. */
  openingSpan: Span;
  tagNameSpan: Span;
  closingSpan: Span | null;
  selfClosing: boolean;
  attrs: Attr[];
  /** Has a `{...spread}` attribute: its props aren't all visible. */
  spread: boolean;
  /** Where the attribute list ends (after the last attribute or spread, else after the tag name): new props go here. */
  attrsEnd: number;
  /** Written directly among its parent's JSX children (not inside an expression or attribute), so it can be removed alone. */
  direct: boolean;
  /** 1-based line and column of the element start. */
  line: number;
  column: number;
  /** The whitespace that begins the element's line. */
  indent: string;
  /** Nothing but whitespace precedes the element on its line. */
  startsLine: boolean;
  scope: ElementScope;
  /** The enclosing function's name for `component` scope. */
  owner: string | null;
  depth: number;
}

export interface ParseError {
  /** Plain words, without Babel's "(line:column)" suffix. */
  message: string;
  line: number;
  column: number;
  offset: number;
}

export interface SourceIndex {
  code: string;
  elements: Element[];
  /** The `<board>` the default export renders (else the first `<board>`), or null. */
  board: number | null;
  /** The outermost element the default export returns, or null. */
  root: number | null;
  /** Syntax problems. With errors the index may be partial, and edits refuse to run (they would splice stale spans). */
  errors: ParseError[];
  /** The indentation step the file uses (two spaces by default). */
  indentUnit: string;
  /** Offsets where each line starts. */
  lineStarts: number[];
}

/** What every edit returns. `selection` is the span of what was added or changed, in the new code. */
export interface EditResult {
  code: string;
  changed: boolean;
  selection?: Span;
  /** Plain-language notes for the person: what else changed, what couldn't be checked. */
  notes: string[];
}

/** Which element an edit applies to: its literal name, its start offset, or the nth element with a tag. */
export type Target = string | { start: number } | { tag: string; nth?: number };

export type EditErrorCode = 'parse' | 'not_found' | 'ambiguous' | 'computed' | 'invalid';

/** An edit that can't be made as asked. Its message is meant for the person. */
export class EditError extends Error {
  code: EditErrorCode;
  constructor(code: EditErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'EditError';
  }
}

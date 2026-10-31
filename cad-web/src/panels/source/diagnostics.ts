import { RangeSet, StateEffect, StateField, type EditorState, type Extension, type Range, type Text, type TransactionSpec } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutterLineClass, type DecorationSet } from '@codemirror/view';
import { lintGutter, linter, setDiagnosticsEffect, type Diagnostic } from '@codemirror/lint';

export interface SourceDiagnostic {
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first character; the whole line is marked when omitted. */
  column?: number;
  /** 1-based column just past the last character (optional). */
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** One action offered with the message (e.g. Fix with STEVE): a button inline and in the lint tooltip. */
  action?: { label: string; run: () => void };
}

type Severity = SourceDiagnostic['severity'];

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 };
const LABEL: Record<Severity, string> = { error: 'Error', warning: 'Warning', info: 'Info' };

function rangeFor(doc: Text, d: SourceDiagnostic): { from: number; to: number; line: number } {
  const line = doc.line(Math.min(Math.max(1, Math.floor(d.line) || 1), doc.lines));
  const text = line.text;
  const indent = text.length - text.trimStart().length;
  const end = text.trimEnd().length;
  if (d.column && d.column >= 1) {
    let from = Math.min(d.column - 1, text.length);
    let to = d.endColumn && d.endColumn > d.column ? Math.min(d.endColumn - 1, text.length) : from;
    if (from >= end && end > indent) {
      // Points past the code (e.g. "expected ':'"): mark the last token instead.
      from = end - (/\S+$/.exec(text.slice(0, end))?.[0].length ?? 1);
      to = end;
    } else if (to <= from) {
      to = from + (/^[\w.]+|^\S/.exec(text.slice(from))?.[0].length ?? 0);
    }
    if (to > from) return { from: line.from + from, to: line.from + to, line: line.number };
  }
  if (end > indent) return { from: line.from + indent, to: line.from + end, line: line.number };
  return { from: line.from, to: line.from, line: line.number };
}

/** Split `pkg.module.ValueError: message` into a short exception name and the message. */
export function splitException(message: string): { type: string | null; text: string } {
  const m = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit|Interrupt|NotDone|Failure|Fail)):\s*([\s\S]*)$/.exec(message.trim());
  if (!m) return { type: null, text: message.trim() };
  return { type: m[1].split('.').pop() ?? m[1], text: m[2] };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMessage(d: SourceDiagnostic): HTMLElement {
  const { type, text } = splitException(d.message);
  const dom = el('div', `cm-cq-diag cm-cq-diag-${d.severity}`);
  const head = el('div', 'cm-cq-diag-head');
  head.append(el('span', 'cm-cq-diag-dot'), el('span', 'cm-cq-diag-type', type ?? LABEL[d.severity]));
  dom.append(head, el('div', 'cm-cq-diag-text', text || d.message));
  return dom;
}

class InlineMessage extends WidgetType {
  constructor(readonly severity: Severity, readonly message: string, readonly action?: SourceDiagnostic['action']) { super(); }

  eq(other: InlineMessage): boolean {
    return other.severity === this.severity && other.message === this.message && other.action?.label === this.action?.label;
  }

  toDOM(): HTMLElement {
    const { type, text } = splitException(this.message);
    const first = (text.split('\n').find((l) => l.trim()) ?? '').trim();
    const dom = el('span', `cm-cq-inlineDiag cm-cq-inlineDiag-${this.severity}`);
    dom.setAttribute('aria-hidden', 'true');
    if (type) dom.append(el('span', 'cm-cq-inlineDiag-type', type));
    dom.append(el('span', 'cm-cq-inlineDiag-text', first.length > 140 ? `${first.slice(0, 139)}…` : first));
    dom.title = this.message;
    if (this.action) {
      const { label, run } = this.action;
      const button = el('button', 'cm-cq-inlineDiag-fix', label) as HTMLButtonElement;
      button.type = 'button';
      button.dataset.diagAction = '';
      button.onmousedown = (event) => { event.preventDefault(); event.stopPropagation(); run(); };
      dom.removeAttribute('aria-hidden');
      dom.append(button);
    }
    // Under its line (not at the end of it): visible however far the code scrolls sideways.
    const row = el('div', 'cm-cq-inlineDiagRow');
    row.append(dom);
    return row;
  }

  ignoreEvent(event: Event): boolean {
    return !!(event.target as HTMLElement | null)?.closest?.('[data-diag-action]');
  }
}

class LineMarker extends GutterMarker {
  constructor(readonly severity: Severity) {
    super();
    this.elementClass = `cm-cq-diagGutter cm-cq-diagGutter-${severity}`;
  }

  eq(other: LineMarker): boolean {
    return other.severity === this.severity;
  }
}

interface InlineState {
  readonly decorations: DecorationSet;
  readonly gutter: RangeSet<GutterMarker>;
}

const setInline = StateEffect.define<readonly SourceDiagnostic[]>();

function buildInline(state: EditorState, diagnostics: readonly SourceDiagnostic[]): InlineState {
  const worst = new Map<number, SourceDiagnostic>();
  for (const d of diagnostics) {
    const { line } = rangeFor(state.doc, d);
    const prev = worst.get(line);
    if (!prev || RANK[d.severity] > RANK[prev.severity]) worst.set(line, d);
  }
  const decorations: Range<Decoration>[] = [];
  const gutter: Range<GutterMarker>[] = [];
  for (const [n, d] of [...worst].sort((a, b) => a[0] - b[0])) {
    const line = state.doc.line(n);
    decorations.push(Decoration.line({ class: `cm-cq-diagLine cm-cq-diagLine-${d.severity}` }).range(line.from));
    decorations.push(Decoration.widget({ widget: new InlineMessage(d.severity, d.message, d.action), side: 1, block: true }).range(line.to));
    gutter.push(new LineMarker(d.severity).range(line.from));
  }
  return { decorations: Decoration.set(decorations, true), gutter: RangeSet.of(gutter, true) };
}

const inlineField = StateField.define<InlineState>({
  create: () => ({ decorations: Decoration.none, gutter: RangeSet.empty }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInline)) return buildInline(tr.state, e.value);
    if (!tr.docChanged) return value;
    return { decorations: value.decorations.map(tr.changes), gutter: value.gutter.map(tr.changes) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (v) => v.decorations),
    gutterLineClass.from(field, (v) => v.gutter),
  ],
});

/** Lint state, gutter markers and inline messages for externally supplied diagnostics. */
export function sourceDiagnostics(): Extension {
  return [linter(null), lintGutter({ hoverTime: 120 }), inlineField];
}

/** Transaction that replaces the editor's diagnostics. */
export function setSourceDiagnostics(state: EditorState, diagnostics: readonly SourceDiagnostic[]): TransactionSpec {
  const lint: Diagnostic[] = diagnostics.map((d) => {
    const { from, to } = rangeFor(state.doc, d);
    return { from, to, severity: d.severity, message: d.message, renderMessage: () => renderMessage(d),
      ...(d.action ? { actions: [{ name: d.action.label, apply: () => d.action!.run() }] } : {}) };
  });
  return { effects: [setDiagnosticsEffect.of(lint), setInline.of(diagnostics)] };
}

/** Stable identity for a diagnostics list, so re-renders with equal content are no-ops. */
export function diagnosticsKey(diagnostics: readonly SourceDiagnostic[] | undefined): string {
  return JSON.stringify((diagnostics ?? []).map((d) => [d.line, d.column, d.endColumn, d.severity, d.message, d.action?.label ?? null]));
}

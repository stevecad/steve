/**
 * Inline review of a change (STEVE's): the editor shows its text against a baseline (the code before the change).
 * Added lines are tinted; removed lines appear as a struck-through block; each change has Keep and Undo. Keep
 * moves the baseline forward; Undo puts the old lines back as an ordinary edit (so it can itself be undone).
 * When baseline and text agree, the review is over.
 */
import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface Hunk { aFrom: number; aTo: number; bFrom: number; bTo: number }

/** Line hunks turning `a` into `b` (longest common subsequence after trimming the shared ends). */
export function diffLines(a: string[], b: string[]): Hunk[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (!n && !m) return [];
  if (n * m > 4_000_000) return [{ aFrom: start, aTo: endA, bFrom: start, bTo: endB }];
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[start + i] === b[start + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const hunks: Hunk[] = [];
  let i = 0, j = 0, open: Hunk | null = null;
  const close = () => { if (open) { hunks.push(open); open = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { close(); i++; j++; continue; }
    open ??= { aFrom: start + i, aTo: start + i, bFrom: start + j, bTo: start + j };
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { j++; open.bTo = start + j; }
    else { i++; open.aTo = start + i; }
  }
  close();
  return hunks;
}

export const setBaseline = StateEffect.define<string | null>();

interface DiffState { baseline: string | null; hunks: Hunk[]; decorations: DecorationSet }

const split = (text: string) => text.split('\n');

class Removed extends WidgetType {
  constructor(readonly lines: string[], readonly index: number, readonly added: boolean) { super(); }
  eq(other: Removed) { return other.index === this.index && other.added === this.added && other.lines.join('\n') === this.lines.join('\n'); }
  toDOM(view: EditorView) {
    const box = document.createElement('div');
    box.className = this.lines.length ? 'cm-diff-block' : 'cm-diff-block cm-diff-block-add';
    for (const text of this.lines) {
      const row = document.createElement('div');
      row.className = 'cm-diff-removed';
      row.textContent = text || ' ';
      box.append(row);
    }
    const bar = document.createElement('div');
    bar.className = 'cm-diff-actions';
    const button = (label: string, act: () => void, kind: string) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.dataset.diffAction = kind;
      el.dataset.hunk = String(this.index);
      el.onmousedown = (event) => { event.preventDefault(); act(); };
      bar.append(el);
    };
    button('Keep', () => keepHunk(view, this.index), 'keep');
    button('Undo', () => undoHunk(view, this.index), 'undo');
    box.append(bar);
    return box;
  }
  ignoreEvent() { return true; }
}

function compute(state: EditorState, baseline: string | null): DiffState {
  if (baseline === null) return { baseline, hunks: [], decorations: Decoration.none };
  const a = split(baseline), b = split(state.doc.toString());
  const hunks = diffLines(a, b);
  if (!hunks.length) return { baseline: null, hunks, decorations: Decoration.none };
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  hunks.forEach((hunk, index) => {
    const at = hunk.bFrom < doc.lines ? doc.line(hunk.bFrom + 1).from : doc.length;
    out.push(Decoration.widget({ widget: new Removed(a.slice(hunk.aFrom, hunk.aTo), index, hunk.bTo > hunk.bFrom), block: true, side: -1 }).range(at));
    for (let line = hunk.bFrom; line < hunk.bTo; line++) out.push(Decoration.line({ class: 'cm-diff-added' }).range(doc.line(line + 1).from));
  });
  return { baseline, hunks, decorations: Decoration.set(out, true) };
}

export const diffField = StateField.define<DiffState>({
  create: () => ({ baseline: null, hunks: [], decorations: Decoration.none }),
  update(value, tr) {
    let baseline = value.baseline;
    let changed = false;
    for (const effect of tr.effects) if (effect.is(setBaseline)) { baseline = effect.value; changed = true; }
    if (!changed && !tr.docChanged) return value;
    return compute(tr.state, baseline);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function keepHunk(view: EditorView, index: number) {
  const { baseline, hunks } = view.state.field(diffField);
  const hunk = hunks[index];
  if (baseline === null || !hunk) return;
  const a = split(baseline), b = split(view.state.doc.toString());
  const next = [...a.slice(0, hunk.aFrom), ...b.slice(hunk.bFrom, hunk.bTo), ...a.slice(hunk.aTo)];
  view.dispatch({ effects: setBaseline.of(next.join('\n')) });
}

function undoHunk(view: EditorView, index: number) {
  const { baseline, hunks } = view.state.field(diffField);
  const hunk = hunks[index];
  if (baseline === null || !hunk) return;
  const old = split(baseline).slice(hunk.aFrom, hunk.aTo);
  const doc = view.state.doc;
  // Replace whole lines bFrom..bTo with the old lines (or remove them, newline included, when nothing was there).
  if (hunk.bTo > hunk.bFrom && !old.length) {
    const last = hunk.bTo >= doc.lines;
    const from = last && hunk.bFrom > 0 ? doc.line(hunk.bFrom).to : doc.line(hunk.bFrom + 1).from;
    const to = last ? doc.length : doc.line(hunk.bTo + 1).from;
    view.dispatch({ changes: { from, to }, userEvent: 'input.undo-change' });
  } else if (hunk.bTo > hunk.bFrom) {
    const from = doc.line(hunk.bFrom + 1).from;
    const to = doc.line(hunk.bTo).to;
    view.dispatch({ changes: { from, to, insert: old.join('\n') }, userEvent: 'input.undo-change' });
  } else {
    const at = hunk.bFrom < doc.lines ? doc.line(hunk.bFrom + 1).from : doc.length;
    const text = hunk.bFrom < doc.lines ? `${old.join('\n')}\n` : `\n${old.join('\n')}`;
    view.dispatch({ changes: { from: at, insert: text }, userEvent: 'input.undo-change' });
  }
}

/** Keep everything, or undo everything (as one edit). */
export function resolveAll(view: EditorView, keep: boolean) {
  const { baseline } = view.state.field(diffField);
  if (baseline === null) return;
  if (keep) view.dispatch({ effects: setBaseline.of(null) });
  else view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: baseline }, effects: setBaseline.of(null), userEvent: 'input.undo-change' });
}

export function inlineDiff(): Extension {
  return [diffField];
}

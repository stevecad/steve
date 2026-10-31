/**
 * The code ↔ model link inside the editor: the feature the model points at is tinted (and scrolled to), and
 * Ctrl/Cmd+click on a name asks the panel to go to its definition (a parameter, a component file, a feature).
 */
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';

export const setLinked = StateEffect.define<{ from: number; to: number } | null>();

function lines(view: { state: EditorView['state'] }, from: number, to: number): DecorationSet {
  const doc = view.state.doc;
  const first = doc.lineAt(Math.min(from, doc.length));
  const last = doc.lineAt(Math.min(Math.max(from, to - 1), doc.length));
  const out: Range<Decoration>[] = [];
  for (let n = first.number; n <= last.number; n++) {
    const cls = ['cm-linked', n === first.number ? 'cm-linked-first' : '', n === last.number ? 'cm-linked-last' : ''].filter(Boolean).join(' ');
    out.push(Decoration.line({ class: cls }).range(doc.line(n).from));
  }
  return Decoration.set(out);
}

const linkedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setLinked)) return effect.value ? lines(tr, effect.value.from, effect.value.to) : Decoration.none;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Tint a span's lines and bring them into view without moving the cursor or stealing focus. */
export function showLinked(view: EditorView, span: { from: number; to: number } | null, scroll = true) {
  const length = view.state.doc.length;
  const value = span ? { from: Math.min(span.from, length), to: Math.min(span.to, length) } : null;
  view.dispatch({ effects: [setLinked.of(value), ...(value && scroll ? [EditorView.scrollIntoView(value.from, { y: 'nearest', yMargin: 48 })] : [])] });
}

/** The identifier (or the text of a string literal) under `pos`. */
export function wordAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const column = pos - line.from;
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
    if (column >= m.index && column <= m.index + m[0].length) return m[0];
  }
  return null;
}

/** Ctrl/Cmd+click: go to a name's definition (the panel decides what the name is). */
export function definitionClick(onDefinition: (word: string) => boolean): Extension {
  return [
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.altKey) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        const word = pos === null ? null : wordAt(view, pos);
        if (!word || !onDefinition(word)) return false;
        event.preventDefault();
        return true;
      },
    }),
  ];
}

export function linkedFeature(): Extension {
  return [linkedField];
}

/**
 * Scrubbable numbers: Alt+drag a number literal sideways to change it, with live preview (the panel rebuilds
 * when the drag ends). Steps follow the literal's own precision; Shift is ×10, Ctrl ÷10. Anywhere that isn't
 * a number, Alt+drag keeps CodeMirror's rectangular selection.
 */
import { type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { decimals, format, numberAt } from '@/lib/numberText';

export { decimals, format, numberAt };

export interface ScrubHandlers { begin(): void; end(changed: boolean): void }

export function scrubNumbers(handlers: () => ScrubHandlers | undefined): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !event.altKey || view.state.readOnly) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const line = view.state.doc.lineAt(pos);
      const found = numberAt(line.text, pos - line.from);
      if (!found) return false;
      event.preventDefault();
      const start = Number(found.value);
      const places = decimals(found.value);
      const base = places ? 10 ** -places : 1;
      const from = line.from + found.from;
      let to = line.from + found.to;
      const startX = event.clientX;
      let changed = false;
      handlers()?.begin();
      document.body.classList.add('cm-scrubbing');
      const move = (e: MouseEvent) => {
        const step = base * (e.shiftKey ? 10 : 1) / (e.ctrlKey ? 10 : 1);
        const shown = Math.max(places, e.ctrlKey ? places + 1 : places);
        const next = format(start + Math.round((e.clientX - startX) / 5) * step, shown);
        const current = view.state.sliceDoc(from, to);
        if (next === current) return;
        changed = true;
        view.dispatch({ changes: { from, to, insert: next }, selection: { anchor: from, head: from + next.length }, userEvent: 'input.scrub' });
        to = from + next.length;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('cm-scrubbing');
        handlers()?.end(changed);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return true;
    },
  });
}

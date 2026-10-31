/**
 * STEVE in the editor: a small action bar over a selection (Explain · Change… · Fix), an inline prompt
 * (Ctrl/Cmd+K) at the cursor, and Explain's one-shot popover. The panel does the work; these only collect what and
 * where, and show the answer.
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view';
import { forEachDiagnostic } from '@codemirror/lint';
import SteveMarkdown from '@/steve/markdown.js';
import { copyText } from '@/lib/clipboard';
import type { ExplainSink } from './explain';

export interface Range { from: number; to: number }
export interface SteveHandlers {
  /** Streams an explanation of `range` into `sink`, outside the conversation; returns a function that stops it. */
  explain(range: Range, code: string, sink: ExplainSink): () => void;
  /** Hands the question and STEVE's explanation to the chat composer, to carry on there. */
  continueInChat(range: Range, code: string, explanation: string): void;
  change(instruction: string, range: Range): void;
  fix(range: Range, message: string): void;
}

/** An open explanation: what it explains, where its popover sits, and an id that keeps the popover (and its stream). */
interface Explaining { range: Range; pos: number; above: boolean; id: number }
const openExplain = StateEffect.define<Explaining | null>();
let explanations = 0;

const explainField = StateField.define<Explaining | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(openExplain)) return effect.value;
    // Typing makes the explanation stale: it closes (and its request stops).
    return tr.docChanged ? null : value;
  },
});

const openPrompt = StateEffect.define<Range | null>();

/** The first error message that touches `range` (whole lines), or null. */
export function errorIn(state: EditorState, range: Range): string | null {
  const first = state.doc.lineAt(range.from).from, last = state.doc.lineAt(range.to).to;
  let found: string | null = null;
  forEachDiagnostic(state, (d, from, to) => { if (!found && d.severity === 'error' && to >= first && from <= last) found = d.message; });
  return found;
}

const promptField = StateField.define<Range | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(openPrompt)) return effect.value;
    return value && tr.docChanged ? { from: tr.changes.mapPos(value.from), to: tr.changes.mapPos(value.to) } : value;
  },
});

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function steveInline(handlers: () => SteveHandlers | undefined): Extension {
  const promptTooltip = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      const range = tr.state.field(promptField);
      if (!range) return [];
      // Opened at the cursor (always on screen) and kept there until it closes.
      if (value.length) return value;
      const head = tr.state.selection.main.head;
      return [{
        pos: head, above: true, strictSide: false, arrow: false,
        create: (view) => {
          const dom = el('div', 'cm-steve-prompt');
          dom.dataset.stevePrompt = '';
          const mark = el('span', 'cm-steve-mark', 'S');
          const input = el('input', 'cm-steve-input');
          input.placeholder = range.to > range.from ? 'Ask STEVE to change the selected code…' : 'Ask STEVE to change the code here…';
          input.setAttribute('aria-label', 'Ask STEVE to change the code');
          const hint = el('span', 'cm-steve-hint', '↵ send · Esc');
          input.onkeydown = (event) => {
            if (event.key === 'Enter' && input.value.trim()) {
              event.preventDefault();
              const text = input.value.trim();
              const current = view.state.field(promptField) ?? range;
              view.dispatch({ effects: openPrompt.of(null) });
              handlers()?.change(text, current);
              view.focus();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              view.dispatch({ effects: openPrompt.of(null) });
              view.focus();
            }
            event.stopPropagation();
          };
          dom.append(mark, input, hint);
          return { dom, mount: () => input.focus() };
        },
      }];
    },
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
  });

  const selectionBar = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      const main = tr.state.selection.main;
      if (!handlers() || main.empty || tr.state.field(promptField) || tr.state.field(explainField) || main.to - main.from < 2) return [];
      const range = { from: main.from, to: main.to };
      const error = errorIn(tr.state, range);
      const key = `${range.from}:${range.to}:${error ?? ''}`;
      if (value.length && (value[0] as Tooltip & { key?: string }).key === key) return value;
      // Anchored where the cursor is (the selection's head): always on screen, even after a long Shift+End.
      return [{ key,
        pos: main.head, above: main.head === main.from, strictSide: false, arrow: false,
        create: (view) => {
          const dom = el('div', 'cm-steve-bar');
          dom.dataset.steveBar = '';
          const add = (label: string, action: string, run: () => void) => {
            const button = el('button', 'cm-steve-action', label);
            button.type = 'button';
            button.dataset.steveAction = action;
            button.onmousedown = (event) => { event.preventDefault(); run(); };
            dom.append(button);
          };
          dom.append(el('span', 'cm-steve-mark', 'S'));
          add('Explain', 'explain', () => view.dispatch({ effects: openExplain.of({ range, pos: main.head, above: main.head === main.from, id: ++explanations }) }));
          add('Change…', 'change', () => view.dispatch({ effects: openPrompt.of(range) }));
          if (error) add('Fix', 'fix', () => handlers()?.fix(range, error));
          return { dom };
        },
      }];
    },
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
  });

  const explainTooltip = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      const open = tr.state.field(explainField);
      if (!open) return [];
      // The same tooltip while the same explanation is open: recreating it would restart the request.
      if (value.length && (value[0] as Tooltip & { id?: number }).id === open.id) return value;
      return [{ id: open.id, pos: open.pos, above: open.above, strictSide: false, arrow: false,
        create: (view) => explainPopover(view, open, handlers) }];
    },
    provide: (field) => showTooltip.computeN([field], (state) => state.field(field)),
  });

  return [
    promptField,
    promptTooltip,
    explainField,
    explainTooltip,
    selectionBar,
    keymap.of([{
      key: 'Mod-k',
      preventDefault: true,
      run: (view) => {
        if (!handlers()) return false;
        const main = view.state.selection.main;
        view.dispatch({ effects: openPrompt.of({ from: main.from, to: main.to }) });
        return true;
      },
    }]),
  ];
}

/** Opens the prompt programmatically (e.g. from the selection bar's Change… or a test). */
export function promptAt(view: EditorView, range: Range) {
  view.dispatch({ effects: openPrompt.of(range) });
}

/** Explain's popover: STEVE's answer streams in; Stop, Copy, Continue in chat; Esc, × or a click outside closes. */
function explainPopover(view: EditorView, open: Explaining, handlers: () => SteveHandlers | undefined) {
  const code = view.state.doc.toString();
  const first = view.state.doc.lineAt(open.range.from).number, last = view.state.doc.lineAt(Math.max(open.range.from, open.range.to - 1)).number;
  const dom = el('div', 'cm-steve-explain');
  dom.dataset.steveExplain = 'streaming';
  dom.setAttribute('role', 'dialog');
  dom.setAttribute('aria-label', 'STEVE’s explanation');
  const close = () => { view.dispatch({ effects: openExplain.of(null) }); view.focus(); };
  const button = (label: string, action: string, onClick: () => void) => {
    const node = el('button', 'cm-steve-explain-button', label);
    node.type = 'button';
    node.dataset.explainAction = action;
    node.onmousedown = (event) => event.preventDefault();  // Keep the editor's focus and selection.
    node.onclick = onClick;
    return node;
  };

  const head = el('div', 'cm-steve-explain-head');
  const closeButton = button('×', 'close', close);
  closeButton.setAttribute('aria-label', 'Close (Esc)');
  closeButton.title = 'Close (Esc)';
  head.append(el('span', 'cm-steve-mark', 'S'), el('span', 'cm-steve-explain-title', 'Explain'),
    el('span', 'cm-steve-explain-where', first === last ? `line ${first}` : `lines ${first}–${last}`), closeButton);
  const body = el('div', 'cm-steve-explain-body');
  body.setAttribute('aria-live', 'polite');
  body.append(el('p', 'cm-steve-explain-wait', 'STEVE is reading the code…'));
  const status = el('span', 'cm-steve-explain-status', 'Explaining…');
  let text = '';
  let stopStream: () => void = () => {};
  const stop = button('Stop', 'stop', () => { stopStream(); finish(text ? 'Stopped' : 'Stopped before an answer'); });
  const copy = button('Copy', 'copy', () => {
    void copyText(text).then((ok) => { if (ok) { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); } });
  });
  const chat = button('Continue in chat', 'chat', () => { handlers()?.continueInChat(open.range, code, text); close(); });
  copy.disabled = chat.disabled = true;
  const foot = el('div', 'cm-steve-explain-foot');
  foot.append(status, el('span', 'cm-steve-explain-note', 'Not added to your chat'), stop, copy, chat);
  dom.append(head, body, foot);

  const finish = (label: string) => {
    dom.dataset.steveExplain = 'done';
    status.textContent = label;
    stop.hidden = true;
  };
  const sink: ExplainSink = {
    text(markdown) {
      text = markdown;
      body.innerHTML = SteveMarkdown.render(markdown);
      body.querySelectorAll('a').forEach((link) => { link.target = '_blank'; link.rel = 'noopener noreferrer'; });
      copy.disabled = chat.disabled = false;
    },
    done() { finish('STEVE'); },
    error(message) {
      text = message;
      body.replaceChildren(el('p', 'cm-steve-explain-error', message));
      copy.disabled = false;
      chat.disabled = true;
      finish('Couldn’t explain');
      dom.dataset.steveExplain = 'error';
    },
  };
  const handler = handlers();
  if (handler) stopStream = handler.explain(open.range, code, sink);
  else sink.error('STEVE isn’t available in this editor.');

  const outside = (event: MouseEvent) => { if (!dom.contains(event.target as Node)) close(); };
  // Esc closes the explanation wherever focus is (the editor, a button, the page), and only the explanation: caught
  // first, so the wide editor's own Esc doesn't also fire.
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  window.addEventListener('keydown', escape, true);
  // After the click that opened it has finished.
  const listen = setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  return {
    dom,
    destroy() {
      clearTimeout(listen);
      window.removeEventListener('keydown', escape, true);
      document.removeEventListener('mousedown', outside, true);
      stopStream();
    },
  };
}


/** Styles for the editor's model link, inline review and STEVE tools (tokens only, so both themes work). */
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** The line-number gutter's width as --cm-gutter-w, so things that stay in view while the code scrolls sideways
 *  (errors under their line, a change's Keep / Undo) sit just right of it. */
export const gutterWidth = ViewPlugin.fromClass(class {
  private readonly onScroll = () => this.view.dom.style.setProperty('--cm-scroll-x', `${this.view.scrollDOM.scrollLeft}px`);
  constructor(readonly view: EditorView) {
    this.measure();
    // CodeMirror's content box is only as wide as the view; long lines overflow it. Messages that must stay in
    // sight follow the horizontal scroll (--cm-scroll-x) rather than relying on position: sticky.
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
  }
  update(update: ViewUpdate) { if (update.geometryChanged || update.docChanged) this.measure(); }
  measure() {
    this.view.requestMeasure({
      read: (view) => [(view.dom.querySelector('.cm-gutters') as HTMLElement | null)?.offsetWidth ?? 0, view.scrollDOM.clientWidth] as const,
      write: ([gutter, visible], view) => {
        view.dom.style.setProperty('--cm-gutter-w', `${gutter}px`);
        view.dom.style.setProperty('--cm-view-w', `${visible}px`);
      },
    });
  }
  destroy() { this.view.scrollDOM.removeEventListener('scroll', this.onScroll); }
});

const pill = {
  height: '22px', padding: '0 9px', borderRadius: '6px', fontSize: '11.5px', fontWeight: '500',
  fontFamily: 'var(--font-sans)', color: 'var(--text-1)', background: 'var(--bg-4)', border: '1px solid var(--line-2)', cursor: 'pointer',
};

export const workbenchTheme = EditorView.theme({
  '.cm-linked': { backgroundColor: 'color-mix(in srgb, var(--ws) 8%, transparent)', boxShadow: 'inset 2px 0 0 var(--ws)' },
  '.cm-diff-added': { backgroundColor: 'color-mix(in srgb, var(--success) 14%, transparent)', boxShadow: 'inset 2px 0 0 var(--success)' },
  '.cm-diff-block': {
    margin: '2px 0', padding: '2px 0 0', backgroundColor: 'color-mix(in srgb, var(--danger) 9%, transparent)',
    boxShadow: 'inset 2px 0 0 var(--danger)', fontFamily: 'var(--font-mono)',
  },
  // A change that only adds lines: just its Keep / Undo, no removed block.
  '.cm-diff-block-add': { backgroundColor: 'transparent', boxShadow: 'inset 2px 0 0 var(--success)', padding: '0' },
  '.cm-diff-removed': { padding: '0 24px 0 12px', whiteSpace: 'pre', color: 'var(--text-3)', textDecoration: 'line-through', textDecorationColor: 'color-mix(in srgb, var(--danger) 55%, transparent)' },
  '.cm-diff-actions': { transform: 'translateX(var(--cm-scroll-x, 0px))', width: 'fit-content', display: 'flex', gap: '6px', padding: '4px 12px 5px' },
  '.cm-diff-actions button': pill,
  '.cm-diff-actions button[data-diff-action="keep"]': { color: 'var(--success)', borderColor: 'color-mix(in srgb, var(--success) 40%, transparent)' },
  '.cm-diff-actions button:hover': { background: 'var(--bg-5)' },
  '.cm-steve-bar': { display: 'flex', alignItems: 'center', gap: '2px', padding: '3px' },
  '.cm-steve-action': { ...pill, background: 'transparent', border: '0' },
  '.cm-steve-action:hover': { background: 'var(--bg-5)' },
  '.cm-steve-action[data-steve-action="fix"]': { color: 'var(--danger)' },
  '.cm-steve-mark': {
    display: 'inline-grid', placeItems: 'center', width: '18px', height: '18px', margin: '0 4px 0 2px', borderRadius: '5px',
    background: 'var(--ws)', color: 'var(--bg-0)', fontSize: '11px', fontWeight: '700', fontFamily: 'var(--font-sans)',
  },
  '.cm-steve-prompt': { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', width: 'min(420px, 80vw)' },
  '.cm-steve-input': {
    flex: '1', minWidth: '0', height: '26px', padding: '0 8px', borderRadius: '6px', border: '1px solid var(--line-3)',
    background: 'var(--bg-2)', color: 'var(--text-1)', fontFamily: 'var(--font-sans)', fontSize: '12.5px', outline: 'none',
  },
  '.cm-steve-input:focus': { borderColor: 'var(--ws)' },
  '.cm-steve-hint': { color: 'var(--text-3)', fontSize: '11px', whiteSpace: 'nowrap', fontFamily: 'var(--font-sans)' },
  '.cm-cq-inlineDiag-fix': { ...pill, height: '18px', padding: '0 7px', marginLeft: '8px', fontSize: '11px', color: 'var(--ws)' },
  // Explain: a one-shot answer next to the code. Readable prose, not a chat bubble; the editor keeps its focus.
  '.cm-tooltip.cm-tooltip-above:has(.cm-steve-explain), .cm-tooltip.cm-tooltip-below:has(.cm-steve-explain)': { borderRadius: '10px', overflow: 'hidden' },
  '.cm-steve-explain': {
    display: 'flex', flexDirection: 'column', width: 'min(460px, calc(var(--cm-view-w, 600px) - 24px), 86vw)', maxHeight: '320px',
    fontFamily: 'var(--font-sans)', color: 'var(--text-1)', background: 'var(--bg-2)', boxShadow: '0 12px 32px rgb(0 0 0 / 0.28)',
    animation: 'cm-steve-explain-in 140ms var(--ease-out, ease-out)',
  },
  '@keyframes cm-steve-explain-in': { from: { opacity: '0', transform: 'translateY(3px)' }, to: { opacity: '1', transform: 'none' } },
  '.cm-steve-explain-head': { display: 'flex', alignItems: 'center', gap: '4px', padding: '7px 6px 6px 8px', borderBottom: '1px solid var(--line-1)' },
  '.cm-steve-explain-title': { fontSize: '12.5px', fontWeight: '600' },
  '.cm-steve-explain-where': { flex: '1', marginLeft: '6px', fontSize: '11.5px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)' },
  '.cm-steve-explain-body': {
    flex: '1', minHeight: '0', overflow: 'auto', padding: '9px 12px 10px', fontSize: '12.5px', lineHeight: '1.55',
    userSelect: 'text', whiteSpace: 'normal', overflowWrap: 'anywhere',
  },
  '.cm-steve-explain-body p': { margin: '0 0 7px' },
  '.cm-steve-explain-body p:last-child': { marginBottom: '0' },
  '.cm-steve-explain-body ul, .cm-steve-explain-body ol': { margin: '0 0 7px', paddingLeft: '18px' },
  '.cm-steve-explain-body li': { margin: '2px 0' },
  '.cm-steve-explain-body code': { fontFamily: 'var(--font-mono)', fontSize: '11.5px', padding: '0 4px', borderRadius: '4px', background: 'var(--bg-4)' },
  '.cm-steve-explain-body .code-block': { margin: '6px 0', borderRadius: '6px', background: 'var(--bg-1)', overflow: 'auto' },
  '.cm-steve-explain-body .code-block pre': { margin: '0', padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: '11.5px' },
  '.cm-steve-explain-body .code-tools': { display: 'none' },
  '.cm-steve-explain-body a': { color: 'var(--ws)' },
  '.cm-steve-explain-wait': { margin: '0', color: 'var(--text-3)' },
  '.cm-steve-explain-error': { margin: '0', color: 'var(--danger)' },
  '.cm-steve-explain-foot': {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderTop: '1px solid var(--line-1)', background: 'var(--bg-1)',
  },
  '.cm-steve-explain-status': { fontSize: '11px', fontWeight: '600', color: 'var(--text-2)', whiteSpace: 'nowrap' },
  '.cm-steve-explain[data-steve-explain="streaming"] .cm-steve-explain-status': { color: 'var(--ws)' },
  '.cm-steve-explain-note': { flex: '1', fontSize: '11px', color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  '.cm-steve-explain-button': { ...pill, flexShrink: '0' },
  '.cm-steve-explain-button:hover:not(:disabled)': { background: 'var(--bg-5)' },
  '.cm-steve-explain-button:disabled': { opacity: '0.45', cursor: 'default' },
  '.cm-steve-explain-button:focus-visible': { outline: '2px solid var(--ws)', outlineOffset: '1px' },
  '.cm-steve-explain-button[data-explain-action="chat"]': { color: 'var(--ws)', borderColor: 'color-mix(in srgb, var(--ws) 40%, transparent)' },
  '.cm-steve-explain-head .cm-steve-explain-button[data-explain-action="close"]': {
    width: '22px', padding: '0', background: 'transparent', border: '0', fontSize: '15px', lineHeight: '1', color: 'var(--text-3)',
  },
});

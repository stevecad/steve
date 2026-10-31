import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/*
 * Every color comes from a CSS custom property (src/styles/tokens.css), so the
 * editor follows [data-theme] and [data-workspace] switches without reconfiguring.
 */

const mono = 'var(--font-mono)';
const sans = 'var(--font-sans)';
const mix = (color: string, percent: number): string => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const ICONS: Record<string, readonly [glyph: string, color: string]> = {
  method: ['m', 'var(--tok-fn)'],
  function: ['ƒ', 'var(--tok-fn)'],
  class: ['C', 'var(--tok-bi)'],
  type: ['T', 'var(--tok-bi)'],
  namespace: ['{}', 'var(--tok-bi)'],
  property: ['p', 'var(--tok-prop)'],
  variable: ['x', 'var(--tok-prop)'],
  constant: ['c', 'var(--tok-num)'],
  keyword: ['k', 'var(--tok-kw)'],
  snippet: ['⌘', 'var(--tok-dec)'],
  selector: ['>', 'var(--tok-str)'],
  value: ['"', 'var(--tok-str)'],
  kwarg: ['=', 'var(--tok-op)'],
  part: ['◆', 'var(--ws)'],
  text: ['ab', 'var(--text-3)'],
  enum: ['e', 'var(--tok-num)'],
  interface: ['i', 'var(--tok-bi)'],
};

const iconStyles = Object.fromEntries(Object.entries(ICONS).map(([type, [glyph, color]]) => [
  `.cm-completionIcon-${type}`,
  { color, '&:after': { content: JSON.stringify(glyph) } },
]));

const tooltipSurface = {
  backgroundColor: 'var(--bg-3)',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-md)',
  boxShadow: 'var(--shadow-3)',
  color: 'var(--text-1)',
};

export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--text-1)',
    backgroundColor: 'var(--code-bg)',
    fontSize: 'var(--editor-font-size, 12.5px)',  // Settings → Code editor
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: mono,
    lineHeight: '1.65',
    fontVariantLigatures: 'contextual',
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--bg-5) transparent',
  },
  '.cm-scroller::-webkit-scrollbar': { width: '10px', height: '10px' },
  '.cm-scroller::-webkit-scrollbar-thumb': {
    backgroundColor: 'var(--bg-5)',
    borderRadius: '10px',
    border: '3px solid transparent',
    backgroundClip: 'content-box',
  },
  '.cm-scroller::-webkit-scrollbar-track, .cm-scroller::-webkit-scrollbar-corner': { background: 'transparent' },
  '.cm-content': { caretColor: 'var(--ws)', padding: '10px 0' },
  '.cm-line': { padding: '0 24px 0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeft: '2px solid var(--ws)', marginLeft: '-1px' },
  '.cm-fat-cursor': { background: 'var(--ws-glow)', outline: 'none' },
  '.cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--ws-soft)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--ws-glow)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--code-line)' },
  '.cm-selectionMatch': { backgroundColor: mix('var(--ws)', 16), borderRadius: '2px' },
  '.cm-selectionMatch-main': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-matchingBracket, .cm-matchingBracket': {
    backgroundColor: 'transparent',
    color: 'inherit',
    outline: '1px solid var(--line-4)',
    borderRadius: '2px',
  },
  '&.cm-focused .cm-nonmatchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'var(--danger-soft)',
    color: 'var(--danger)',
    outline: 'none',
  },
  '.cm-searchMatch': {
    backgroundColor: mix('var(--warning)', 20),
    outline: `1px solid ${mix('var(--warning)', 45)}`,
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: mix('var(--warning)', 42),
    outline: '1px solid var(--warning)',
  },
  '.cm-specialChar': { color: 'var(--danger)' },
  '.cm-placeholder': { color: 'var(--text-4)', fontStyle: 'italic' },
  '.cm-snippetField': { backgroundColor: mix('var(--ws)', 14), borderRadius: '2px', outline: `1px solid ${mix('var(--ws)', 35)}` },
  '.cm-snippetFieldPosition': { borderLeft: '1.5px solid var(--ws)' },

  // Gutters
  '.cm-gutters': {
    backgroundColor: 'var(--code-gutter)',
    color: 'var(--text-4)',
    border: 'none',
    borderRight: '1px solid var(--line-1)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 14px', minWidth: '38px', fontSize: 'calc(var(--editor-font-size, 12.5px) - 1px)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-line)', color: 'var(--text-2)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px 0 2px', cursor: 'pointer' },
  '.cm-cq-fold': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '14px',
    height: '100%',
    color: 'var(--text-3)',
    opacity: '0',
    transition: 'opacity var(--t-base) var(--ease-out), color var(--t-fast) linear',
  },
  '.cm-cq-fold svg': { width: '12px', height: '12px', transition: 'transform var(--t-base) var(--ease-out)' },
  '.cm-cq-fold[data-open="true"] svg': { transform: 'rotate(90deg)' },
  '.cm-cq-fold[data-open="false"]': { opacity: '1', color: 'var(--ws)' },
  '.cm-gutters:hover .cm-cq-fold': { opacity: '1' },
  '.cm-cq-fold:hover': { color: 'var(--text-1)' },
  '.cm-foldPlaceholder': {
    display: 'inline-flex',
    alignItems: 'center',
    height: '1.3em',
    margin: '0 4px',
    padding: '0 7px',
    verticalAlign: 'middle',
    backgroundColor: 'var(--bg-4)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--r-pill)',
    color: 'var(--text-3)',
    fontSize: '11px',
    lineHeight: '1',
    cursor: 'pointer',
  },
  '.cm-foldPlaceholder:hover': { color: 'var(--text-1)', borderColor: 'var(--line-4)' },
  '.cm-cq-indent': {
    backgroundImage: 'linear-gradient(var(--line-2), var(--line-2))',
    backgroundRepeat: 'no-repeat',
  },

  // Tooltips
  '.cm-tooltip': { ...tooltipSurface, fontFamily: sans, fontSize: '12px', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-hover, .cm-tooltip.cm-tooltip-lint': { padding: '0', maxWidth: '520px' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'var(--line-2)', borderBottomColor: 'var(--line-2)' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--bg-3)', borderBottomColor: 'var(--bg-3)' },
  '.cm-tooltip-section:not(:first-child)': { borderTop: '1px solid var(--line-1)' },

  // Autocomplete
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '4px', overflow: 'visible' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: mono,
    fontSize: '12px',
    maxHeight: '19.5em',
    minWidth: '300px',
    maxWidth: 'min(560px, 92vw)',
    scrollbarWidth: 'thin',
    scrollbarColor: 'var(--bg-5) transparent',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '26px',
    padding: '0 10px 0 4px',
    borderRadius: 'var(--r-sm)',
    color: 'var(--text-2)',
    lineHeight: '26px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--ws-soft)',
    color: 'var(--text-1)',
    boxShadow: `inset 0 0 0 1px ${mix('var(--ws)', 22)}`,
  },
  '.cm-tooltip.cm-tooltip-autocomplete-disabled > ul > li[aria-selected]': { backgroundColor: 'var(--bg-4)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section': {
    padding: '6px 8px 2px',
    border: 'none',
    color: 'var(--text-3)',
    fontFamily: sans,
    fontSize: 'var(--fs-2xs)',
    fontWeight: '600',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    opacity: '1',
  },
  '.cm-completionIcon': {
    flex: 'none',
    width: '18px',
    height: '18px',
    padding: '0',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--r-xs)',
    backgroundColor: mix('currentColor', 13),
    fontFamily: mono,
    fontSize: '10px',
    fontWeight: '700',
    lineHeight: '1',
    opacity: '1',
    boxSizing: 'border-box',
  },
  ...iconStyles,
  '.cm-completionIcon-color': { display: 'none' },
  '.cm-cq-swatch': {
    flex: 'none',
    width: '14px',
    height: '14px',
    margin: '0 2px',
    borderRadius: '4px',
    boxShadow: 'inset 0 0 0 1px var(--line-3)',
  },
  '.cm-completionLabel': { flex: 'none', color: 'inherit' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--ws)', fontWeight: '600' },
  '.cm-completionDetail': {
    flex: '1 1 auto',
    minWidth: '0',
    marginLeft: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textAlign: 'right',
    fontStyle: 'normal',
    fontFamily: sans,
    fontSize: '11px',
    color: 'var(--text-3)',
  },
  'li[aria-selected] .cm-completionDetail': { color: 'var(--text-2)' },
  '.cm-completionListIncompleteTop:before, .cm-completionListIncompleteBottom:after': { color: 'var(--text-4)' },
  '.cm-tooltip.cm-completionInfo': {
    ...tooltipSurface,
    padding: '8px 12px',
    maxWidth: '440px',
    whiteSpace: 'normal',
    color: 'var(--text-2)',
    fontSize: '12px',
    lineHeight: '1.5',
  },
  '.cm-tooltip.cm-completionInfo:has(> .cm-cq-doc)': { padding: '0' },
  '.cm-completionInfo.cm-completionInfo-right': { marginLeft: '6px' },
  '.cm-completionInfo.cm-completionInfo-left': { marginRight: '6px' },
  '.cm-completionInfo.cm-completionInfo-right-narrow, .cm-completionInfo.cm-completionInfo-left-narrow': { marginTop: '6px' },

  // Documentation cards (completion info, hover, signature help)
  '.cm-cq-doc': { minWidth: '240px', maxWidth: '440px', fontFamily: sans },
  '.cm-cq-doc-sigs': {
    padding: '9px 12px',
    backgroundColor: mix('var(--bg-0)', 22),
    borderBottom: '1px solid var(--line-1)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    maxHeight: '260px',
    overflowY: 'auto',
  },
  '.cm-cq-doc-compact .cm-cq-doc-sigs': { padding: '7px 12px' },
  '.cm-cq-sig': {
    fontFamily: mono,
    fontSize: '11.5px',
    lineHeight: '1.6',
    color: 'var(--text-3)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-cq-sig-owner': { color: 'var(--text-3)' },
  '.cm-cq-sig-name': { color: 'var(--tok-fn)', fontWeight: '600' },
  '.cm-cq-sig-class': { color: 'var(--tok-bi)', fontWeight: '600' },
  '.cm-cq-sig-pname': { color: 'var(--text-1)' },
  '.cm-cq-sig-type': { color: 'var(--tok-bi)' },
  '.cm-cq-sig-default': { color: 'var(--tok-num)' },
  '.cm-cq-sig-punct': { color: 'var(--text-4)' },
  '.cm-cq-sig-arrow': { color: 'var(--text-4)' },
  '.cm-cq-sig-active': {
    borderRadius: '3px',
    backgroundColor: 'var(--ws-soft)',
    boxShadow: `0 0 0 2px var(--ws-soft)`,
  },
  '.cm-cq-sig-active .cm-cq-sig-pname': { color: 'var(--ws)', fontWeight: '600' },
  '.cm-cq-doc-body': { padding: '9px 12px 10px' },
  '.cm-cq-doc-text': { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5' },
  '.cm-cq-doc-meta': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', marginTop: '8px' },
  '.cm-cq-doc-kind': {
    color: 'var(--text-3)',
    fontSize: 'var(--fs-2xs)',
    fontWeight: '600',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  '.cm-cq-doc-chip': {
    padding: '1px 7px',
    borderRadius: 'var(--r-pill)',
    backgroundColor: 'var(--bg-5)',
    color: 'var(--text-2)',
    fontSize: 'var(--fs-xs)',
    lineHeight: '1.6',
  },
  '.cm-tooltip:has(.cm-cq-sighelp)': { boxShadow: 'var(--shadow-2)' },
  '.cm-cq-sighelp': { maxWidth: '560px', padding: '7px 12px 8px' },
  '.cm-cq-sighelp-head': { display: 'flex', alignItems: 'flex-start', gap: '12px' },
  '.cm-cq-sighelp-head .cm-cq-sig': { flex: '1 1 auto' },
  '.cm-cq-sighelp-count': { flex: 'none', color: 'var(--text-4)', fontSize: 'var(--fs-xs)', lineHeight: '1.8' },
  '.cm-cq-sighelp-doc': { marginTop: '3px', color: 'var(--text-3)', fontSize: '11.5px', lineHeight: '1.45' },

  // Diagnostics
  '.cm-lintRange': { backgroundImage: 'none', paddingBottom: '0' },
  '.cm-lintRange-error': { textDecoration: 'underline wavy var(--danger)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--warning)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px', textDecorationThickness: '1px' },
  '.cm-lintRange-info, .cm-lintRange-hint': { textDecoration: 'underline dotted var(--info)', textDecorationSkipInk: 'none', textUnderlineOffset: '3px' },
  '.cm-lintRange-active': { backgroundColor: 'var(--danger-soft)' },
  '.cm-lintPoint:after': { borderBottomColor: 'var(--danger)' },
  '.cm-lintPoint-warning:after': { borderBottomColor: 'var(--warning)' },
  '.cm-lintPoint-info:after': { borderBottomColor: 'var(--info)' },
  '.cm-gutter-lint': { width: '14px' },
  '.cm-gutter-lint .cm-gutterElement': { padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  '.cm-lint-marker': {
    content: 'normal',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: 'var(--info)',
    boxShadow: `0 0 0 3px ${mix('var(--info)', 18)}`,
  },
  '.cm-lint-marker-error': { content: 'normal', backgroundColor: 'var(--danger)', boxShadow: '0 0 0 3px var(--danger-soft)' },
  '.cm-lint-marker-warning': { content: 'normal', backgroundColor: 'var(--warning)', boxShadow: '0 0 0 3px var(--warning-soft)' },
  '.cm-lint-marker-info': { content: 'normal' },
  '.cm-tooltip-lint ul': { margin: '0', padding: '0' },
  '.cm-diagnostic': { padding: '0', marginLeft: '0', border: 'none', whiteSpace: 'normal' },
  '.cm-diagnostic:not(:first-child)': { borderTop: '1px solid var(--line-1)' },
  '.cm-cq-diag': { padding: '9px 12px 10px', maxWidth: '520px' },
  '.cm-cq-diag-head': { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '4px' },
  '.cm-cq-diag-dot': { width: '7px', height: '7px', borderRadius: '50%', backgroundColor: 'var(--danger)', flex: 'none' },
  '.cm-cq-diag-warning .cm-cq-diag-dot': { backgroundColor: 'var(--warning)' },
  '.cm-cq-diag-info .cm-cq-diag-dot': { backgroundColor: 'var(--info)' },
  '.cm-cq-diag-type': { fontFamily: mono, fontSize: '11.5px', fontWeight: '600', color: 'var(--danger)' },
  '.cm-cq-diag-warning .cm-cq-diag-type': { color: 'var(--warning)' },
  '.cm-cq-diag-info .cm-cq-diag-type': { color: 'var(--info)' },
  '.cm-cq-diag-text': {
    fontFamily: mono,
    fontSize: '11.5px',
    lineHeight: '1.55',
    color: 'var(--text-1)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '220px',
    overflowY: 'auto',
  },
  '.cm-cq-diagLine-error': { backgroundColor: mix('var(--danger)', 6) },
  '.cm-cq-diagLine-warning': { backgroundColor: mix('var(--warning)', 6) },
  '.cm-cq-diagLine-error.cm-activeLine': { backgroundColor: mix('var(--danger)', 9) },
  '.cm-cq-diagGutter-error.cm-gutterElement': { color: 'var(--danger)' },
  '.cm-cq-diagGutter-warning.cm-gutterElement': { color: 'var(--warning)' },
  '.cm-cq-inlineDiagRow': { padding: '1px 0 4px' },
  '.cm-cq-inlineDiag': {
    position: 'relative',
    transform: 'translateX(var(--cm-scroll-x, 0px))',
    display: 'flex',
    width: 'fit-content',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '2px 6px',
    maxWidth: 'min(640px, calc(var(--cm-view-w, 100%) - var(--cm-gutter-w, 0px) - 28px))',
    marginLeft: '12px',
    padding: '2px 8px',
    borderRadius: 'var(--r-xs)',
    fontFamily: sans,
    fontSize: '11.5px',
    color: 'var(--danger)',
    backgroundColor: mix('var(--danger)', 9),
    whiteSpace: 'normal',
    lineHeight: '1.45',
    cursor: 'default',
    userSelect: 'text',
  },
  '.cm-cq-inlineDiag-warning': { color: 'var(--warning)', backgroundColor: mix('var(--warning)', 9) },
  '.cm-cq-inlineDiag-info': { color: 'var(--info)', backgroundColor: mix('var(--info)', 9) },
  '.cm-cq-inlineDiag-type': { fontFamily: mono, fontSize: '11px', fontWeight: '600' },
  '.cm-cq-inlineDiag-text': { opacity: '0.9' },

  // Panels & search
  '.cm-panels': { backgroundColor: 'transparent', color: 'var(--text-1)', border: 'none' },
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    top: '8px',
    right: '16px',
    left: 'auto',
    zIndex: '20',
    border: 'none',
    borderBottom: 'none',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line-1)', backgroundColor: 'var(--bg-2)' },
  '.cm-cq-search': {
    ...tooltipSurface,
    boxShadow: 'var(--shadow-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    padding: '4px',
    fontFamily: sans,
    fontSize: '12px',
    width: '400px',
    maxWidth: 'calc(100vw - 48px)',
  },
  '.cm-cq-search-row': { display: 'flex', alignItems: 'center', gap: '2px' },
  '.cm-cq-search-toggle': { width: '20px', alignSelf: 'stretch', height: 'auto' },
  '.cm-cq-search-toggle svg': { transition: 'transform var(--t-base) var(--ease-out)' },
  '.cm-cq-search[data-replace="true"] .cm-cq-search-toggle svg': { transform: 'rotate(90deg)' },
  '.cm-cq-search-replace': { paddingLeft: '22px' },
  '.cm-cq-search[data-replace="false"] .cm-cq-search-replace': { display: 'none' },
  '.cm-cq-search-field': {
    flex: '1 1 auto',
    minWidth: '0',
    display: 'flex',
    alignItems: 'center',
    height: '26px',
    padding: '0 3px 0 8px',
    borderRadius: 'var(--r-sm)',
    backgroundColor: 'var(--bg-1)',
    border: '1px solid var(--line-2)',
    transition: 'border-color var(--t-fast) linear, box-shadow var(--t-fast) linear',
  },
  '.cm-cq-search-field:focus-within': { borderColor: mix('var(--ws)', 60), boxShadow: '0 0 0 3px var(--ws-soft)' },
  '.cm-cq-search-field[data-invalid="true"]': { borderColor: mix('var(--danger)', 60) },
  '.cm-cq-search-field input': {
    flex: '1 1 auto',
    minWidth: '0',
    height: '100%',
    padding: '0',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text-1)',
    fontFamily: mono,
    fontSize: '12px',
  },
  '.cm-cq-search-field input::placeholder': { color: 'var(--text-4)', fontFamily: sans },
  '.cm-cq-search-opt': {
    flex: 'none',
    height: '20px',
    minWidth: '22px',
    padding: '0 4px',
    border: '1px solid transparent',
    borderRadius: 'var(--r-xs)',
    background: 'transparent',
    color: 'var(--text-3)',
    fontFamily: mono,
    fontSize: '11px',
    cursor: 'pointer',
  },
  '.cm-cq-search-opt:hover': { color: 'var(--text-1)', backgroundColor: 'var(--bg-4)' },
  '.cm-cq-search-opt[aria-pressed="true"]': {
    color: 'var(--ws)',
    backgroundColor: 'var(--ws-soft)',
    borderColor: mix('var(--ws)', 40),
  },
  '.cm-cq-search-opt u': { textDecorationThickness: '1px', textUnderlineOffset: '2px' },
  '.cm-cq-search-count': {
    flex: 'none',
    minWidth: '64px',
    padding: '0 6px',
    color: 'var(--text-3)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  },
  '.cm-cq-search-count[data-empty="true"]': { color: 'var(--danger)' },
  '.cm-cq-search-btn': {
    flex: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    height: '26px',
    minWidth: '26px',
    padding: '0 6px',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    background: 'transparent',
    color: 'var(--text-2)',
    fontFamily: sans,
    fontSize: '11.5px',
    cursor: 'pointer',
  },
  '.cm-cq-search-btn:hover:not(:disabled)': { backgroundColor: 'var(--bg-4)', color: 'var(--text-1)' },
  '.cm-cq-search-btn:disabled': { opacity: '0.4', cursor: 'default' },
  '.cm-cq-search-btn:focus-visible, .cm-cq-search-opt:focus-visible': { outline: '2px solid var(--ws)', outlineOffset: '-1px' },
  '.cm-cq-search-btn svg': { width: '14px', height: '14px' },

  // Misc chrome
  '.cm-textfield': {
    backgroundColor: 'var(--bg-1)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--r-sm)',
    color: 'var(--text-1)',
    fontFamily: mono,
    fontSize: '12px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--bg-4)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--r-sm)',
    color: 'var(--text-1)',
  },
  '.cm-panel.cm-gotoLine': { padding: '6px 8px', ...tooltipSurface, boxShadow: 'var(--shadow-2)' },
  '.cm-dialog': { ...tooltipSurface, padding: '8px 10px', fontFamily: sans },
});

export const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: 'var(--tok-kw)' },
  { tag: [t.self], color: 'var(--tok-kw)', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string), t.docString, t.character], color: 'var(--tok-str)' },
  { tag: [t.escape, t.regexp], color: 'var(--tok-num)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--tok-num)' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.function(t.propertyName)], color: 'var(--tok-fn)' },
  { tag: [t.definition(t.className), t.className, t.typeName, t.namespace], color: 'var(--tok-bi)' },
  { tag: [t.standard(t.variableName), t.standard(t.name)], color: 'var(--tok-bi)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-cm)', fontStyle: 'italic' },
  { tag: [t.meta, t.annotation], color: 'var(--tok-dec)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--tok-prop)' },
  { tag: [t.operator, t.arithmeticOperator, t.compareOperator, t.logicOperator, t.bitwiseOperator, t.updateOperator, t.definitionOperator, t.derefOperator], color: 'var(--tok-op)' },
  { tag: [t.punctuation, t.separator, t.paren, t.squareBracket, t.brace], color: 'var(--tok-op)' },
  { tag: t.invalid, color: 'var(--danger)' },
  { tag: t.link, textDecoration: 'underline' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
]);

// ---------------------------------------------------------------------------
// Python builtins (Lezer does not tag them) and common module names.

const BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'callable', 'dict', 'dir', 'divmod', 'enumerate', 'filter', 'float', 'format',
  'getattr', 'hasattr', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max', 'min', 'next',
  'object', 'print', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'str', 'sum',
  'super', 'tuple', 'type', 'zip', 'Exception', 'ValueError', 'TypeError', 'RuntimeError', 'KeyError',
  'IndexError', 'AttributeError', 'NotImplementedError', 'cq', 'cadquery', 'math', 'self', '__name__',
]);

const builtinMark = Decoration.mark({ class: 'cm-cq-builtin' });

function builtinDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'VariableName') return;
        const parent = node.node.parent?.name;
        if (parent === 'FunctionDefinition' || parent === 'ClassDefinition') return;
        if (BUILTINS.has(view.state.sliceDoc(node.from, node.to))) builder.add(node.from, node.to, builtinMark);
      },
    });
  }
  return builder.finish();
}

const builtinHighlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = builtinDecorations(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = builtinDecorations(u.view);
    }
  }
}, { decorations: (v) => v.decorations });

const builtinTheme = EditorView.theme({
  '.cm-cq-builtin, .cm-cq-builtin *': { color: 'var(--tok-bi)' },
});

// ---------------------------------------------------------------------------
// Indent guides: one 1px line per indentation level, drawn as backgrounds on
// line decorations so they span the full line height. Blank lines inherit the
// indentation of the next non-blank line.

function indentGuides(view: EditorView): DecorationSet {
  const { state } = view;
  const unit = 4;
  const builder = new RangeSetBuilder<Decoration>();
  const cache = new Map<number, Decoration>();
  const guideFor = (levels: number): Decoration => {
    let deco = cache.get(levels);
    if (!deco) {
      const positions = Array.from({ length: levels }, (_, i) => `calc(12px + ${i * unit}ch) 0`).join(', ');
      const sizes = Array.from({ length: levels }, () => '1px 100%').join(', ');
      const images = Array.from({ length: levels }, () => 'linear-gradient(var(--line-2), var(--line-2))').join(', ');
      deco = Decoration.line({
        class: 'cm-cq-indent',
        attributes: { style: `background-image: ${images}; background-position: ${positions}; background-size: ${sizes}` },
      });
      cache.set(levels, deco);
    }
    return deco;
  };
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      let text = line.text;
      if (!text.trim()) {
        for (let n = line.number + 1; n <= Math.min(state.doc.lines, line.number + 200); n++) {
          const next = state.doc.line(n).text;
          if (next.trim()) { text = next; break; }
        }
      }
      const indent = /^ */.exec(text)?.[0].length ?? 0;
      const levels = Math.floor(indent / unit);
      if (levels > 0) builder.add(line.from, line.from, guideFor(levels));
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const indentGuidePlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = indentGuides(view); }
  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged) this.decorations = indentGuides(u.view);
  }
}, { decorations: (v) => v.decorations });

/** Chevron for the fold gutter; rotated when the range is open. */
export function foldMarker(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-cq-fold';
  span.dataset.open = String(open);
  span.title = open ? 'Fold' : 'Unfold';
  span.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
  return span;
}

export function sourceTheme(): Extension {
  return [editorTheme, syntaxHighlighting(highlightStyle), builtinHighlighter, builtinTheme, indentGuidePlugin];
}

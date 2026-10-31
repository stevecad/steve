import { useLayoutEffect, useRef, type JSX } from 'react';
import clsx from 'clsx';
import {
  acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, type Completion,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory } from '@codemirror/commands';
import { globalCompletion, localCompletionSource, pythonLanguage } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { tscircuitCompletions } from './tscircuitCompletions';
import {
  LanguageSupport, bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, indentUnit,
} from '@codemirror/language';
import { lintKeymap } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import {
  EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, scrollPastEnd,
} from '@codemirror/view';
import { styleTags, tags } from '@lezer/highlight';
import { cadqueryCompletionSource, curatedGlobals, inCodeOnly, shouldReactivate } from './cadqueryCompletions';
import { linkAliasesFacet } from './cadqueryResolve';
import { cadqueryHover, signatureHelp } from './cadqueryTooltips';
import { diagnosticsKey, setSourceDiagnostics, sourceDiagnostics, type SourceDiagnostic } from './diagnostics';
import { createSearchPanel } from './searchPanel';
import { foldMarker, sourceTheme } from './theme';
import { gutterWidth, workbenchTheme } from './workbenchTheme';
import { definitionClick, linkedFeature } from './link';
import { scrubNumbers, type ScrubHandlers } from './scrub';
import { diffField, inlineDiff } from './inlineDiff';
import { steveInline, type SteveHandlers } from './steveInline';
import styles from './SourceEditor.module.css';

export type { SourceDiagnostic } from './diagnostics';
export { diagnosticsFromTraceback } from './traceback';

export interface SourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+Enter. */
  onRun?: () => void;
  /** Ctrl/Cmd+S; the browser's save dialog is always suppressed inside the editor. */
  onSave?: () => void;
  diagnostics?: SourceDiagnostic[];
  readOnly?: boolean;
  /** A design's link aliases, importable via `from links import <alias>`. */
  linkAliases?: string[];
  /** Selects and scrolls to a character range; a new nonce re-applies the same range. */
  reveal?: { from: number; to: number; nonce: number } | null;
  className?: string;
  /** The cursor's offset while the editor has focus; null when it loses it (the code → model link). */
  onCursor?: (offset: number | null) => void;
  /** Alt+drag on a number literal (scrubbing) starts and ends. */
  onScrub?: ScrubHandlers;
  /** STEVE in the editor: the selection bar and the Ctrl/Cmd+K prompt. */
  steve?: SteveHandlers;
  /** Ctrl/Cmd+click on a name; true when it was handled. */
  onDefinition?: (word: string) => boolean;
  /** Ctrl/Cmd+P. */
  onQuickOpen?: () => void;
  /** Changes left to review in the inline diff (0: none). */
  onDiff?: (changes: number) => void;
  /** The view, for panels that drive it (links, reviews); null when it goes away. */
  onView?: (view: EditorView | null) => void;
  /** Escape when nothing in the editor wanted it (e.g. leave the wide editor); true when handled. */
  onEscape?: () => boolean;
  /** CadQuery Python (parts and designs), a circuit's TSX (tscircuit), or plain text (a design's .csv table). Fixed for
   *  the editor's life: key on it. */
  language?: 'python' | 'tsx' | 'text';
}

interface Handlers {
  onChange: (value: string) => void;
  onRun?: () => void;
  onSave?: () => void;
  onCursor?: (offset: number | null) => void;
  onScrub?: ScrubHandlers;
  steve?: SteveHandlers;
  onDefinition?: (word: string) => boolean;
  onQuickOpen?: () => void;
  onDiff?: (changes: number) => void;
  onEscape?: () => boolean;
}

/** Marks transactions that mirror the `value` prop, so they are not echoed through onChange. */
const External = Annotation.define<boolean>();

const NO_ALIASES: readonly string[] = [];

const pythonSupport = new LanguageSupport(pythonLanguage.configure({
  props: [styleTags({ 'Decorator/VariableName Decorator/PropertyName': tags.meta })],
}));

function colorSwatch(completion: Completion): Node | null {
  if (completion.type !== 'color') return null;
  const swatch = document.createElement('span');
  swatch.className = 'cm-cq-swatch';
  swatch.style.backgroundColor = completion.label.replace(/["']/g, '');
  return swatch;
}

/** Smallest single replacement turning `a` into `b`, so selections and history map naturally. */
function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function SourceEditor({
  value,
  onChange,
  onRun,
  onSave,
  diagnostics,
  readOnly = false,
  linkAliases,
  reveal,
  className,
  onCursor,
  onScrub,
  steve,
  onDefinition,
  onQuickOpen,
  onDiff,
  onView,
  onEscape,
  language = 'python',
}: SourceEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlers = useRef<Handlers>({ onChange, onRun, onSave, onCursor, onScrub, steve, onDefinition, onQuickOpen, onDiff, onEscape });
  const viewHandler = useRef(onView);
  /** Recent values sent through onChange that the parent has not echoed back yet. */
  const pending = useRef<string[]>([]);
  const compartments = useRef({ readOnly: new Compartment(), aliases: new Compartment() });
  const aliases = linkAliases ?? NO_ALIASES;

  useLayoutEffect(() => {
    handlers.current = { onChange, onRun, onSave, onCursor, onScrub, steve, onDefinition, onQuickOpen, onDiff, onEscape };
    viewHandler.current = onView;
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { readOnly: readOnlyCompartment, aliases: aliasCompartment } = compartments.current;
    const commands = Prec.highest(keymap.of([
      {
        key: 'Mod-Enter',
        scope: 'editor search-panel',
        preventDefault: true,
        run: () => {
          const run = handlers.current.onRun;
          if (!run) return false;
          run();
          return true;
        },
      },
      {
        key: 'Mod-s',
        scope: 'editor search-panel',
        preventDefault: true,
        run: () => {
          handlers.current.onSave?.();
          return true;
        },
      },
      { key: 'Tab', run: acceptCompletion },
      {
        key: 'Mod-p',
        scope: 'editor search-panel',
        preventDefault: true,
        run: () => {
          const open = handlers.current.onQuickOpen;
          if (!open) return false;
          open();
          return true;
        },
      },
    ]));
    const extensions: Extension[] = [
      commands,
      lineNumbers(),
      foldGutter({ markerDOM: foldMarker }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(language === 'tsx' ? 2 : 4),
      indentUnit.of(language === 'tsx' ? '  ' : '    '),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      codeFolding({ placeholderText: '⋯' }),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 2 }),
      search({ top: true, createPanel: createSearchPanel }),
      scrollPastEnd(),
      ...(language === 'text' ? [] : language === 'tsx' ? [
        // A circuit (docs/ELECTRONICS.md): TSX, with tscircuit's elements and their props.
        javascript({ jsx: true, typescript: true }),
        autocompletion({ override: [tscircuitCompletions], maxRenderedOptions: 100 }),
      ] : [
        pythonSupport,
        autocompletion({
          override: [cadqueryCompletionSource, inCodeOnly(localCompletionSource), inCodeOnly(curatedGlobals(globalCompletion))],
          activateOnCompletion: shouldReactivate,
          addToOptions: [{ render: colorSwatch, position: 25 }],
          maxRenderedOptions: 100,
        }),
        cadqueryHover,
        signatureHelp(),
      ]),
      sourceDiagnostics(),
      sourceTheme(),
      workbenchTheme,
      gutterWidth,
      readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
      aliasCompartment.of(linkAliasesFacet.of(aliases)),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...lintKeymap, indentWithTab]),
      EditorView.contentAttributes.of({
        'aria-label': 'Model source',
        spellcheck: 'false',
        autocorrect: 'off',
        autocapitalize: 'off',
        translate: 'no',
      }),
      Prec.low(keymap.of([{ key: 'Escape', run: () => handlers.current.onEscape?.() ?? false }])),
      linkedFeature(),
      inlineDiff(),
      scrubNumbers(() => handlers.current.onScrub),
      steveInline(() => handlers.current.steve),
      definitionClick((word) => handlers.current.onDefinition?.(word) ?? false),
      EditorView.domEventHandlers({
        blur: () => { handlers.current.onCursor?.(null); },
      }),
      EditorView.updateListener.of((update) => {
        const diff = update.state.field(diffField);
        if (diff !== update.startState.field(diffField)) handlers.current.onDiff?.(diff.hunks.length);
        if ((update.selectionSet || update.focusChanged) && update.view.hasFocus) handlers.current.onCursor?.(update.state.selection.main.head);
        if (!update.docChanged || update.transactions.every((tr) => tr.annotation(External))) return;
        const text = update.state.doc.toString();
        pending.current = [...pending.current.slice(-7), text];
        handlers.current.onChange(text);
      }),
    ];
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: value, extensions }) });
    viewRef.current = view;
    viewHandler.current?.(view);
    return () => {
      viewHandler.current?.(null);
      view.destroy();
      viewRef.current = null;
    };
    // The view is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) {
      pending.current = [];
      return;
    }
    // A late echo of something we emitted while the user kept typing.
    if (pending.current.includes(value)) return;
    pending.current = [];
    view.dispatch({
      changes: minimalChange(current, value),
      annotations: [External.of(true), isolateHistory.of('full')],
    });
  }, [value]);

  const diagnosticsId = diagnosticsKey(diagnostics);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view) view.dispatch(setSourceDiagnostics(view.state, diagnostics ?? []));
    // Keyed by content so a new-but-equal array on every render is a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagnosticsId]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.readOnly === readOnly) return;
    view.dispatch({ effects: compartments.current.readOnly.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly]);

  const aliasesId = aliases.join('\n');
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || sameList(view.state.facet(linkAliasesFacet), aliases)) return;
    view.dispatch({ effects: compartments.current.aliases.reconfigure(linkAliasesFacet.of(aliases)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aliasesId]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal) return;
    const length = view.state.doc.length;
    const from = Math.min(reveal.from, length), to = Math.min(reveal.to, length);
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  }, [reveal?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={hostRef} className={clsx(styles.root, className)} data-readonly={readOnly || undefined} />;
}

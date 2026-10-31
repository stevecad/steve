/**
 * The code, as one surface with the model: where you are (breadcrumb, outline), what drives it (parameters),
 * what you're looking at (the feature selected in the model is tinted here; the feature at the cursor lights up
 * in the model), errors at their line, live rebuilds, and STEVE working inline with a review of what it changed.
 * Expand turns the side pane into a wide editor beside the model.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, Check, ChevronDown, ChevronUp, Download, FileCode, ListTree, Maximize2, Minimize2, RefreshCw, Square, TerminalSquare, X } from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Shortcut, Spinner, Switch } from '@/ui';
import { buildFailureReport, get, isPreviewStale, readOnlyReason, set, useApp } from '@/state/store';
import { downloadSource, loadExample, openFile, openReferenceModel, saveDocument, setCode, updateModel } from '@/state/actions';
import { fileLabel, filesOf, hasFiles, isTable, MAIN, PARAMS, sourceFiles } from '@/state/design';
import { Api, type Kind } from '@/lib/api';
import { modKey } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import { featureFacePicks, featureOfPick, modelingOf } from '@/modeling/bodies';
import { diagnosticsFromTraceback } from './source/traceback';
import { circuitError } from './source/circuitError';
import type { SourceDiagnostic } from './source/diagnostics';
import { showLinked } from './source/link';
import { resolveAll, setBaseline } from './source/inlineDiff';
import { describeSelection, runInline } from './source/steveRun';
import type { SteveHandlers } from './source/steveInline';
import FileSwitcher from './source/FileSwitcher';
import Outline, { circuitOutline, itemAt, outlineOf, type OutlineItem } from './source/Outline';
import ParamsBar from './source/ParamsBar';
import { useSteve } from './steve';
import { selectedLines, streamExplain } from './source/explain';
import styles from './SourcePanel.module.css';
import { useCodeTarget } from '@/state/codeTargets';
import TargetEditor, { EmptyCode } from './source/TargetEditor';
import { fileOfPick } from '@/state/sourceOf';
import { openBugReport, useFeedback } from '@/feedback/feedback';
import { setLiveBuild } from '@/state/autobuild';
import { hoverPart, selectParts, useCircuit } from '@/workspaces/electronics/state';
import { lineOf, plainMessage } from '@/workspaces/electronics/circuit';
import { mergeProblems, useReadinessView } from '@/workspaces/electronics/readiness';
import { DIVIDER_EXAMPLE } from '@/workspaces/electronics/template';

const SourceEditor = lazy(() => import('./source/SourceEditor'));

/**
 * The one code editor, following the workspace (state/codeTargets.ts): Manufacture shows the active program's code
 * (or the shop's, on its page), Simulate the active study's; Design and Electronics the open document's own.
 */
export default function SourcePanel() {
  const target = useCodeTarget();
  if (!target) return <DocumentSource />;
  if ('empty' in target) return <EmptyCode target={target} />;
  return <TargetEditor target={target} />;
}

const WIDTH_KEY = 'steve-source-narrow-width';
const WIDE = 620;
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Optional. */ } };
const recall = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };

function Diagnostics() {
  const error = useApp((state) => state.error);
  const reporting = useFeedback((state) => state.enabled);
  const logs = useApp((state) => state.logs);
  const runtime = useApp((state) => state.runtimeInfo);
  const phase = useApp((state) => state.phase);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (error) setOpen(true); }, [error]);
  const text = error || logs;
  const tone = error ? 'error' : phase === 'succeeded' ? 'ok' : 'idle';
  return (
    <div className={styles.diagnostics} data-open={open || undefined} id="diagnostics">
      <button type="button" className={styles.diagHeader} onClick={() => setOpen(!open)} aria-expanded={open}>
        <TerminalSquare size={13} />
        <span>Output</span>
        <span className={styles.diagDot} data-tone={tone} />
        <span className={styles.diagSummary}>{error ? error.trim().split('\n').pop() : phase === 'succeeded' ? 'Model generated without errors' : 'No messages'}</span>
        {runtime && <span className={styles.diagRuntime} id="runtime">{runtime}</span>}
        <motion.span animate={{ rotate: open ? 180 : 0 }} style={{ display: 'grid' }}><ChevronUp size={13} /></motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }} style={{ overflow: 'hidden' }}>
            <pre className={styles.output} data-error={!!error || undefined} id="output">{text || 'No output yet. Update the model to run the source.'}</pre>
            {error && reporting && (
              <button type="button" className={styles.diagReport} data-report-diagnostics
                onClick={() => openBugReport(buildFailureReport(error))}>Report this</button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The outline as a menu, for the narrow pane: `▸ current feature ▾`. */
function SymbolMenu({ items, current, onJump }: { items: OutlineItem[]; current: OutlineItem | null; onJump: (item: OutlineItem) => void }) {
  if (!items.length) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={styles.crumbSymbol} id="source-symbol" title="Outline: go to a feature">
          <ListTree size={12} /><span>{current?.label ?? 'Outline'}</span><ChevronDown size={12} />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        {items.map((item) => {
          const ItemIcon = item.icon;
          return <MenuItem key={item.key} icon={<ItemIcon size={14} />} checked={item.key === current?.key} hint={item.error ? 'error' : item.detail} onSelect={() => onJump(item)}>{item.label}</MenuItem>;
        })}
      </MenuContent>
    </Menu>
  );
}

/** What the editor shows of errors: Python tracebacks, the parser's findings, and features that failed in the build. */
/** A circuit's errors: the build's (it names the line: `"main.tsx" at 12:5`), then the problems in the circuit. */
function useCircuitDiagnostics(fix: (line: number, message: string) => void): SourceDiagnostic[] {
  const error = useApp((state) => state.error);
  const code = useApp((state) => state.doc.code);
  const model = useCircuit((state) => state.model);
  const readiness = useReadinessView();
  const problems = useMemo(() => mergeProblems(model, readiness), [model, readiness.blocking, readiness.advisories, readiness.available]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const out: SourceDiagnostic[] = [];
    const lines = code.split('\n').length;
    const add = (d: SourceDiagnostic) => {
      if (d.line < 1 || d.line > lines || out.some((other) => other.line === d.line && other.severity === d.severity)) return;
      out.push(d.severity === 'error' ? { ...d, action: { label: 'Fix with STEVE', run: () => fix(d.line, d.message) } } : d);
    };
    if (error) add({ ...circuitError(error), severity: 'error' });
    for (const problem of problems) {
      const line = lineOf(problem, code);
      if (line) add({ line, message: plainMessage(problem.message) + (problem.fix ? ` Fix: ${problem.fix}` : ''), severity: problem.severity });
    }
    return out;
  }, [error, code, problems]); // eslint-disable-line react-hooks/exhaustive-deps
}

function useDiagnostics(fix: (line: number, message: string, feature?: string) => void): SourceDiagnostic[] {
  const error = useApp((state) => state.error);
  const code = useApp((state) => state.doc.code);
  const design = useApp((state) => hasFiles(state.doc.kind));
  // A Blender document's traceback names its main.py as it ran it (blender/blender_run.py).
  const blender = useApp((state) => state.doc.kind === 'blender');
  const activeFile = useApp((state) => state.doc.activeFile);
  const modeling = useApp((state) => state.modeling);
  const displayed = useApp((state) => state.displayed);
  return useMemo(() => {
    const out: SourceDiagnostic[] = [];
    const add = (d: SourceDiagnostic, feature?: string) => {
      if (out.some((other) => other.line === d.line && other.severity === d.severity)) return;
      out.push(d.severity === 'error' ? { ...d, action: { label: 'Fix with STEVE', run: () => fix(d.line, d.message, feature) } } : d);
    };
    if (error) for (const d of diagnosticsFromTraceback(error, blender ? 'main.py' : design ? `/work/${activeFile}` : '/work/model.py', code)) add(d);
    for (const d of modeling?.diagnostics ?? []) add({ line: d.line, message: d.message, severity: d.severity });
    const report = modelingOf(displayed);
    const results = new Map((report?.features ?? []).map((f) => [f.id, f]));
    for (const feature of modeling?.features ?? []) {
      const result = feature.id ? results.get(feature.id) : undefined;
      if (result?.status === 'error') add({ line: feature.line, message: `${feature.name || feature.id}: ${result.error ?? 'failed'}`, severity: 'error' }, feature.id ?? undefined);
      else if (result?.status === 'ok' && result.warning) add({ line: feature.line, message: `${feature.name || feature.id}: ${result.warning}`, severity: 'warning' });
      for (const problem of feature.errors ?? []) add({ line: problem.line, message: problem.message, severity: 'error' }, feature.id ?? undefined);
    }
    return out;
  }, [error, code, design, blender, activeFile, modeling, displayed]); // eslint-disable-line react-hooks/exhaustive-deps
}

function DocumentSource() {
  const doc = useApp((state) => state.doc);
  const busy = useApp((state) => state.busy);
  const locked = useApp((state) => readOnlyReason(state) !== null);
  const phase = useApp((state) => state.phase);
  const stale = useApp((state) => isPreviewStale(state));
  const reveal = useApp((state) => state.sourceReveal);
  const modeling = useApp((state) => state.modeling);
  const displayed = useApp((state) => state.displayed);
  const dockWidth = useApp((state) => state.dockWidth);
  const [references, setReferences] = useState<{ id: string; name: string; description: string; kind: Kind }[]>([]);
  const [view, setView] = useState<EditorView | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const [cursor, setCursor] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const live = useApp((state) => state.liveBuild);
  const [review, setReview] = useState(0);
  const [task, setTask] = useState<{ label: string; signal: { stopped: boolean; runId?: string } } | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scrubbing = useRef<ReturnType<typeof setInterval> | null>(null);
  const ownHover = useRef(false);
  const pendingBaseline = useRef<{ file: string; text: string } | null>(null);
  const pendingDefinition = useRef<string | null>(null);
  useEffect(() => { Api.exampleCatalog().then((value) => setReferences(value.examples)).catch(() => undefined); }, []);

  const design = doc.kind === 'design';
  const multiFile = hasFiles(doc.kind);
  const circuit = doc.kind === 'circuit';
  /** Only the reference designs of this document's kind: circuits beside a circuit, CadQuery beside a part or design. */
  const shownReferences = references.filter((item) => (item.kind === 'circuit') === circuit);
  const report = useMemo(() => modelingOf(displayed), [displayed, doc.activeFile]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => (circuit ? circuitOutline(doc.code) : isTable(doc.activeFile) ? [] : outlineOf(doc.code, modeling, report, design && doc.activeFile === MAIN)),
    [doc.code, modeling, report, design, circuit, doc.activeFile]);
  const current = itemAt(items, cursor);
  const wide = width >= WIDE;

  // The pane's width decides the layout (wide: outline column).
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(node);
    return () => observer.disconnect();
  }, [doc.open]);

  // A finished review (every change kept or undone) also clears what STEVE said about it.
  const reviewing = useRef(0);
  useEffect(() => {
    if (reviewing.current > 0 && review === 0) setNote(null);
    reviewing.current = review;
  }, [review]);

  const onView = useCallback((next: EditorView | null) => {
    viewRef.current = next;
    setView(next);
    const pending = pendingBaseline.current;
    if (next && pending && pending.file === get().doc.activeFile) {
      pendingBaseline.current = null;
      next.dispatch({ effects: setBaseline.of(pending.text) });
    }
  }, []);

  /* ───── live rebuild: what you change here (typing, a parameter, a number you drag) builds after a pause.
     Code other tools write (sketches, feature dialogs) builds as those tools decide. ───── */
  const editedHere = useRef(false);
  const onEdit = useCallback((code: string) => { editedHere.current = true; setCode(code); }, []);
  useEffect(() => {
    if (!live || !doc.open) return;
    const timer = setTimeout(() => {
      const state = get();
      if (!editedHere.current || state.busy || scrubbing.current || !state.doc.code.trim()) return;
      if (!isPreviewStale(state)) { editedHere.current = false; return; }
      // Half-typed code: say where the syntax breaks (inline) instead of building it.
      if (state.modeling?.diagnostics.some((d) => d.severity === 'error' && /syntax/i.test(d.message))) return;
      editedHere.current = false;
      void updateModel({ quiet: true });
    }, 900);
    return () => clearTimeout(timer);
  }, [doc.code, doc.files, live, busy, doc.open, modeling]);

  /* ───── model → code: what is selected in the model is tinted (and shown) in the code ───── */
  const activeFeature = useApp((state) => state.activeFeature);
  const selection = useApp((state) => state.selection);
  // A pick made by another file doesn't switch files: like an active component in Fusion, the open file stays while
  // you pick other components' geometry (sketching in context on their faces). It's offered instead; right-click →
  // Show in source opens it directly.
  const lastPick = selection.at(-1);
  const pickedFile = doc.kind === 'design' && lastPick && lastPick.kind !== 'component' ? fileOfPick(lastPick) : null;
  const elsewhere = pickedFile && pickedFile !== doc.activeFile ? pickedFile : null;
  useEffect(() => {
    if (!view || circuit) return;
    const last = selection.at(-1);
    const feature = (activeFeature && items.some((item) => item.feature === activeFeature) ? activeFeature : null)
      ?? (last ? featureOfPick(last) : null);
    const item = feature ? items.find((entry) => entry.feature === feature) : null;
    // While typing, the tint follows but the code doesn't jump.
    if (item || !view.hasFocus) showLinked(view, item ? { from: item.from, to: item.to } : null, !!item && !view.hasFocus);
  }, [activeFeature, selection, view, items, circuit]);

  /* ───── circuits: the selected part is tinted in the code; the part at the cursor lights up in the views ───── */
  const circuitSelection = useCircuit((state) => state.selection);
  useEffect(() => {
    if (!view || !circuit) return;
    const item = items.find((entry) => entry.feature && entry.feature === circuitSelection.at(-1));
    if (item || !view.hasFocus) showLinked(view, item ? { from: item.from, to: item.to } : null, !!item && !view.hasFocus);
  }, [circuitSelection, view, items, circuit]);
  useEffect(() => {
    if (!circuit) return;
    const timer = setTimeout(() => {
      const item = cursor === null ? null : itemAt(items, cursor);
      if (view && item) showLinked(view, { from: item.from, to: item.to }, false);
      hoverPart(item?.feature ?? null);
    }, 120);
    return () => clearTimeout(timer);
  }, [cursor, items, view, circuit]);

  /* ───── code → model: the feature at the cursor lights up in the model ───── */
  useEffect(() => {
    if (circuit) return undefined;
    const timer = setTimeout(() => {
      const model = viewer.model;
      if (cursor === null) {
        // Leaving the editor: only the highlight the cursor made goes (a tint from the model stays).
        if (ownHover.current) { ownHover.current = false; set({ hover: null, hoverAlso: [] }); }
        return;
      }
      const item = itemAt(items, cursor);
      if (view) showLinked(view, item && item.key !== 'parameters' ? { from: item.from, to: item.to } : null, false);
      const picks = model && item?.feature ? featureFacePicks(model, item.feature) : [];
      if (picks.length) { ownHover.current = true; set({ hover: picks[0], hoverAlso: picks.slice(1) }); }
      else if (ownHover.current) { ownHover.current = false; set({ hover: null, hoverAlso: [] }); }
    }, 120);
    return () => clearTimeout(timer);
  }, [cursor, items, view, circuit]);
  useEffect(() => () => { if (ownHover.current) set({ hover: null, hoverAlso: [] }); }, []);

  const jump = useCallback((item: OutlineItem) => {
    const v = viewRef.current;
    if (get().doc.kind === 'circuit' && item.feature) selectParts([item.feature]);
    if (!v) return;
    v.dispatch({ selection: { anchor: item.from }, scrollIntoView: true });
    showLinked(v, { from: item.from, to: item.to });
    v.focus();
  }, []);

  /* ───── go to definition (Ctrl/Cmd+click) ───── */
  const onDefinition = useCallback((word: string) => {
    const state = get();
    const parsed = state.modeling;
    const local = parsed?.parameters.find((p) => p.name === word);
    if (local) { set({ sourceReveal: { from: local.span[0], to: local.span[0] + local.name.length, nonce: Date.now() } }); return true; }
    const feature = parsed?.features.find((f) => f.id === word);
    if (feature) { set({ sourceReveal: { from: feature.span[0], to: feature.span[0], nonce: Date.now() } }); return true; }
    if (!hasFiles(state.doc.kind)) return false;
    const files = filesOf(state.doc);
    const fromImport = new RegExp(`^from\\s+components\\.(\\w+)\\s+import\\s+[^\\n]*\\b${word}\\b`, 'm').exec(state.doc.code)?.[1];
    const path = files[`components/${word}.py`] !== undefined ? `components/${word}.py` : fromImport ? `components/${fromImport}.py` : files[`${word}.py`] !== undefined ? `${word}.py` : null;
    if (path) { openFile(path); return true; }
    if (parsed?.imported?.some((p) => p.name === word) && files[PARAMS] !== undefined) {
      pendingDefinition.current = word;
      openFile(PARAMS);
      return true;
    }
    return false;
  }, []);
  useEffect(() => {
    const word = pendingDefinition.current;
    if (!word || doc.activeFile !== PARAMS || !modeling) return;
    const parameter = modeling.parameters.find((p) => p.name === word);
    if (!parameter) return;
    pendingDefinition.current = null;
    set({ sourceReveal: { from: parameter.span[0], to: parameter.span[0] + parameter.name.length, nonce: Date.now() } });
  }, [modeling, doc.activeFile]);

  /* ───── expand: a wide editor beside the model ───── */
  const expand = useCallback(() => {
    const state = get();
    if (state.dockWidth >= WIDE + 20) {
      set({ dockWidth: Number(recall(WIDTH_KEY)) || 384 });
    } else {
      remember(WIDTH_KEY, String(state.dockWidth));
      set({ dockWidth: Math.round(Math.max(WIDE + 40, Math.min(window.innerWidth - 420, window.innerWidth * 0.56))), dockOpen: true });
    }
  }, []);
  const expanded = dockWidth >= WIDE + 20;
  const onEscape = useCallback(() => {
    if (get().dockWidth < WIDE + 20) return false;
    set({ dockWidth: Number(recall(WIDTH_KEY)) || 384 });
    return true;
  }, []);

  /* ───── Ctrl/Cmd+P anywhere while the code is open ───── */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'p' || !hasFiles(get().doc.kind)) return;
      event.preventDefault();
      setFileOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ───── STEVE ───── */
  const fix = useCallback((line: number, message: string, feature?: string) => {
    const file = get().doc.kind === 'part' ? 'model.py' : get().doc.activeFile;
    useSteve.setState({ prefill: `Fix this error in ${file}, line ${line}${feature ? ` (feature ${feature})` : ''}: ${message.trim()}` });
    set({ dockOpen: true, dockTab: 'assistant' });
  }, []);
  const cadDiagnostics = useDiagnostics(fix);
  const circuitDiagnostics = useCircuitDiagnostics(fix);
  const diagnostics = circuit ? circuitDiagnostics : cadDiagnostics;

  const startInline = useCallback(async (instruction: string, range: { from: number; to: number }) => {
    if (task) return;
    const state = get();
    const circuit = state.doc.kind === 'circuit';
    const file = hasFiles(state.doc.kind) || circuit ? state.doc.activeFile : MAIN;
    const shownFile = hasFiles(state.doc.kind) || circuit ? file : 'the part';
    const where = describeSelection(state.doc.code, range.from, range.to, shownFile);
    const fence = circuit ? 'tsx' : 'python';
    const message = `${instruction}\n\nThis is about ${where.lines}${state.doc.kind === 'part' ? ' (its only file)' : ''}:\n\`\`\`${fence}\n${where.text}\n\`\`\`\n`
      + `Change only what this needs${hasFiles(state.doc.kind) ? `, in ${file} (edit_design with path="${file}")` : ' (edit_design)'}, keep the rest of the ${circuit ? 'circuit' : state.doc.kind === 'shop' ? 'shop' : 'design'} as it is, and regenerate it.`;
    const signal = { stopped: false };
    setNote(null);
    setTask({ label: instruction, signal });
    try {
      const outcome = await runInline(message, file, signal);
      if (outcome.status === 'changed' && outcome.before !== undefined) {
        const v = viewRef.current;
        if (v && (!hasFiles(get().doc.kind) || get().doc.activeFile === file)) v.dispatch({ effects: setBaseline.of(outcome.before) });
        else pendingBaseline.current = { file, text: outcome.before };
        if (outcome.reply) setNote({ tone: 'info', text: outcome.reply });
      } else if (outcome.status === 'unchanged') setNote({ tone: 'info', text: outcome.reply ? `STEVE didn’t change ${shownFile}: ${outcome.reply}` : `STEVE didn’t change ${shownFile}.` });
      else if (outcome.status === 'moved-on') setNote({ tone: 'info', text: 'STEVE finished, but the design changed meanwhile: its edit is in the design’s history (and STEVE’s chat).' });
      else if (outcome.status === 'stopped') setNote({ tone: 'info', text: 'Stopped. Anything STEVE had already saved stays in the design’s history.' });
      else setNote({ tone: 'error', text: outcome.error ?? 'STEVE could not finish.' });
    } catch (error) {
      setNote({ tone: 'error', text: (error as Error).message });
    } finally {
      setTask(null);
    }
  }, [task]);

  const steve = useMemo<SteveHandlers>(() => ({
    // A one-shot popover in the editor, outside the conversation (it reaches the chat only via Continue in chat).
    explain: (range, code, sink) => {
      const state = get();
      const lines = selectedLines(code, range.from, range.to);
      const controller = new AbortController();
      void streamExplain({ file: state.doc.kind === 'part' ? 'the part' : state.doc.activeFile, document_name: state.doc.name || undefined,
        selection_text: lines.text, start_line: lines.start, end_line: lines.end, context_code: code }, controller.signal, sink);
      return () => controller.abort();
    },
    continueInChat: (range, code, explanation) => {
      const state = get();
      const where = describeSelection(code, range.from, range.to, state.doc.kind === 'part' ? 'the part' : state.doc.activeFile);
      useSteve.setState({ prefill: `About ${where.lines} of “${state.doc.name || 'this design'}”:\n\`\`\`${state.doc.kind === 'circuit' ? 'tsx' : 'python'}\n${where.text}\n\`\`\`\nYou explained:\n${explanation}\n\n` });
      set({ dockOpen: true, dockTab: 'assistant' });
    },
    change: (instruction, range) => { void startInline(instruction, range); },
    fix: (range, message) => { void startInline(`Fix this error: ${message.trim()}`, range); },
  }), [startInline]);

  const onScrub = useMemo(() => ({
    begin: () => {
      if (scrubbing.current) clearInterval(scrubbing.current);
      // Live preview while dragging: rebuild whenever the last build is done and the number moved on.
      scrubbing.current = setInterval(() => { const state = get(); if (!state.busy && isPreviewStale(state)) void updateModel({ quiet: true }); }, 500);
    },
    end: (changed: boolean) => {
      if (scrubbing.current) { clearInterval(scrubbing.current); scrubbing.current = null; }
      if (changed && !get().busy) { editedHere.current = false; void updateModel({ quiet: true }); }
    },
  }), []);

  if (!doc.open) return <div className={styles.empty}><FileCode size={26} /><p>Open or create a design to edit its source.</p></div>;

  const status = busy ? 'Building…' : phase === 'failed' ? 'Build failed' : stale ? (live ? 'Waiting to build…' : 'Changes not built yet') : 'Up to date';
  const tone = busy ? 'busy' : phase === 'failed' ? 'error' : stale ? 'stale' : 'ok';
  return (
    <div className={styles.panel} id="source-panel" ref={root} data-wide={wide || undefined}>
      <div className={styles.toolbar}>
        <FileSwitcher open={fileOpen} onOpenChange={setFileOpen} showName={wide} />
        {!wide && <SymbolMenu items={items} current={current} onJump={jump} />}
        {elsewhere && (
          <button type="button" className={styles.elsewhere} id="source-picked-file" data-file={elsewhere} onClick={() => openFile(elsewhere)}
            title={`The selected geometry is made in ${elsewhere}. Open it.`}>
            from <b>{fileLabel(elsewhere)}</b> · Open
          </button>
        )}
        <div className={styles.toolbarRight}>
          <Menu>
            <MenuTrigger asChild>{wide
              ? <Button size="sm" variant="ghost" icon={<BookOpen />} id="example">Samples</Button>
              : <IconButton small label="Samples" description="Example parts and reference designs" id="example"><BookOpen /></IconButton>}</MenuTrigger>
            <MenuContent align="end">
              {circuit ? <MenuItem onSelect={() => onEdit(DIVIDER_EXAMPLE)}>Voltage divider (example)</MenuItem> : <>
                <MenuItem onSelect={() => loadExample('plate')} disabled={doc.kind !== 'part' && !!doc.saved}>Mounting plate (part)</MenuItem>
                <MenuItem onSelect={() => loadExample('design')} disabled={doc.kind !== 'design' && !!doc.saved}>Spacer stack (design)</MenuItem>
              </>}
              {shownReferences.length > 0 && <MenuSeparator />}
              {shownReferences.length > 0 && <MenuLabel>Reference designs · open in a new tab</MenuLabel>}
              {shownReferences.map((item) => <MenuItem key={item.id} onSelect={() => { void openReferenceModel(item.id); }}>{item.name}</MenuItem>)}
            </MenuContent>
          </Menu>
          <IconButton small label={sourceFiles(doc).length > 1 ? 'Download source (.zip)' : circuit ? 'Download .tsx' : 'Download .py'} onClick={() => void downloadSource()} disabled={!doc.code}><Download /></IconButton>
          <IconButton small label={expanded ? 'Back to the side pane' : 'Expand the editor'} description={expanded ? 'Esc' : 'A wide editor beside the model, with the outline.'}
            onClick={expand} id="source-expand" data-expanded={expanded || undefined}>{expanded ? <Minimize2 /> : <Maximize2 />}</IconButton>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {(task || review > 0 || note) && (
          <motion.div className={styles.steveBar} data-tone={note?.tone} id="source-steve" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <span className={styles.steveMark}>S</span>
            {task ? <>
              <Spinner size={12} />
              <span className={styles.steveText}>STEVE is working on “{task.label}”…</span>
              <Button size="sm" variant="ghost" icon={<Square />} onClick={() => { task.signal.stopped = true; }} id="source-steve-stop">Stop</Button>
            </> : review > 0 ? <>
              <span className={styles.steveText}>Review STEVE’s change · {review} {review === 1 ? 'place' : 'places'}{note ? ` — ${note.text.split('\n')[0]}` : ''}</span>
              <Button size="sm" variant="ghost" icon={<Check />} onClick={() => { if (viewRef.current) resolveAll(viewRef.current, true); setNote(null); }} id="source-keep-all">Keep all</Button>
              <Button size="sm" variant="ghost" icon={<X />} onClick={() => { if (viewRef.current) resolveAll(viewRef.current, false); setNote(null); }} id="source-undo-all">Undo all</Button>
            </> : note && <>
              <span className={styles.steveText}>{note.text.split('\n')[0]}</span>
              <IconButton small label="Dismiss" onClick={() => setNote(null)}><X /></IconButton>
            </>}
          </motion.div>
        )}
      </AnimatePresence>
      <ParamsBar onEdit={onEdit} />
      <div className={styles.body}>
        {wide && <Outline items={items} current={current?.key ?? null} onJump={jump} />}
        <div className={styles.editor}>
          <Suspense fallback={<div className={styles.loading}><Spinner /></div>}>
            <SourceEditor
              key={`${doc.saved?.id ?? 'unsaved'}:${doc.activeFile}:${doc.kind}`}
              language={circuit ? 'tsx' : isTable(doc.activeFile) ? 'text' : 'python'}
              reveal={reveal}
              value={doc.code}
              onChange={onEdit}
              onRun={() => { void updateModel(); }}
              onSave={() => { void saveDocument(); }}
              diagnostics={diagnostics}
              readOnly={(busy && !live) || locked}
              linkAliases={Object.keys(doc.links)}
              onView={onView}
              onCursor={setCursor}
              onScrub={onScrub}
              steve={steve}
              onDefinition={onDefinition}
              onQuickOpen={multiFile ? () => setFileOpen(true) : undefined}
              onDiff={setReview}
              onEscape={onEscape}
            />
          </Suspense>
        </div>
      </div>
      <Diagnostics />
      <div className={styles.footer}>
        <span className={styles.status} data-tone={tone} id="source-status"><span className={styles.statusDot} />{status}</span>
        <span className={styles.liveToggle} title="Rebuild the model a moment after you stop typing" id="source-live">
          <Switch checked={live} onCheckedChange={setLiveBuild} label="Live rebuild" />
          <span>Live</span>
        </span>
        <span className={styles.spacer} />
        <Button id="build" size="sm" variant={live ? 'ghost' : 'primary'} icon={busy ? <Spinner size={13} /> : <RefreshCw />} disabled={busy || !doc.code.trim()} onClick={() => { void updateModel(); }} data-stale={stale || undefined}>
          {busy ? 'Working…' : 'Update model'}<Shortcut keys={`${modKey}+↵`} />
        </Button>
      </div>
    </div>
  );
}

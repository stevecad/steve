/**
 * The Electronics workspace over the viewport (docs/ELECTRONICS.md): the schematic, the board, the 3D board (the
 * viewport itself, showing the build's preview.glb) or schematic and board side by side, with a switcher on top and
 * the board's facts below. With no circuit open, a start screen: your circuits, or a new one.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CircuitBoard, FolderOpen, MessageSquare, Plus, Shapes, Sparkles } from 'lucide-react';
import { Button, Spinner, Tip } from '@/ui';
import { set, useApp } from '@/state/store';
import { openTab } from '@/state/tabs';
import { openReferenceModel } from '@/state/actions';
import vp from '@/viewport/Viewport.module.css';
import { Api, type DocumentSummary } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { toggleDock } from '@/commands';
import { setView, useCircuit, VIEWS, type CircuitView } from './state';
import { useSchematicTool } from './schematicEdits';
import { CircuitIcon } from '@/icons/cad';
import ReadinessPanel, { ExportGuard, VerdictChip } from './ReadinessPanel';
import { useReadinessView } from './readiness';
import styles from './Electronics.module.css';

const SchematicView = lazy(() => import('./SchematicView'));
const PcbView = lazy(() => import('./PcbView'));

const SHORTCUTS: Record<CircuitView, string> = { schematic: 'S', pcb: 'B', '3d': 'D', split: 'Shift+S' };
const HINTS: Record<CircuitView, string> = {
  schematic: 'How it’s wired: symbols, pins and nets.',
  pcb: 'The board: parts on copper, routed traces, design-rule errors. Edit mode moves parts.',
  '3d': 'The assembled board in 3D: measure it, section it, place it in an enclosure.',
  split: 'Schematic and board side by side; selecting a part selects it in both.',
};

export function ViewSwitcher() {
  const view = useCircuit((state) => state.view);
  return (
    <div className={styles.switcher} role="tablist" aria-label="Circuit view" id="circuit-views">
      {VIEWS.map((item) => (
        <Tip key={item.id} label={item.label} shortcut={SHORTCUTS[item.id]} description={HINTS[item.id]}>
          <button type="button" role="tab" aria-selected={view === item.id} data-active={view === item.id || undefined} data-view={item.id}
            className={styles.switch} onClick={() => setView(item.id)}>
            {view === item.id && <motion.span layoutId="circuit-view-thumb" className={styles.switchThumb} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            <span className={styles.switchLabel}>{item.label}</span>
          </button>
        </Tip>
      ))}
    </div>
  );
}

/** Board size, layers and counts, bottom left, and whether it can be ordered (the readiness verdict). */
function BoardFacts() {
  const model = useCircuit((state) => state.model);
  const view = useCircuit((state) => state.view);
  const readiness = useReadinessView().available;
  if (!model) return null;
  const { board, parts, nets, problems } = model;
  const errors = problems.filter((problem) => problem.severity === 'error').length;
  const warnings = problems.length - errors;
  const mm = (value: number | null) => (value === null ? '–' : Number(value.toFixed(2)).toString());
  return (
    <div className={styles.factsRow} data-view={view}>
    <div className={styles.facts} id="circuit-facts">
      {board && <span><b>{mm(board.width)} × {mm(board.height)}</b> mm</span>}
      {board?.layers && <span>{board.layers} layers</span>}
      <span>{parts.length} {parts.length === 1 ? 'part' : 'parts'}</span>
      <span>{nets.length} {nets.length === 1 ? 'net' : 'nets'}</span>
      {/* With a readiness verdict, the chip beside says what matters; tscircuit's own counts are in the browser. */}
      {!readiness && (errors > 0 || warnings > 0) && (
        <button type="button" className={styles.factsProblems} data-tone={errors ? 'error' : 'warning'} onClick={() => set({ browserOpen: true })}
          title="Listed under Problems in the browser">
          <AlertTriangle size={11} />{errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : ''}{errors && warnings ? ' · ' : ''}{warnings ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : ''}
        </button>
      )}
    </div>
    <VerdictChip />
    </div>
  );
}

/** Your circuits, newest first, and New circuit: Electronics with no circuit open. */
function StartScreen() {
  const open = useApp((state) => state.doc.open);
  const [circuits, setCircuits] = useState<DocumentSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    Api.documents({ kind: 'circuit', limit: 8 }).then((result) => { if (live) setCircuits(result.documents.filter((doc) => doc.kind === 'circuit')); })
      .catch(() => { if (live) setCircuits([]); });
    return () => { live = false; };
  }, []);
  return (
    <motion.div className={styles.start} id="electronics-start" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className={styles.startCard} initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 28, delay: 0.04 }}>
        <div className={styles.startGlyph}><CircuitIcon size={30} /></div>
        <h2>{open ? 'Circuits live here' : 'Design a circuit board'}</h2>
        <p>{open ? 'The open document is a CAD model. Open one of your circuits, or start a new board: code first, with STEVE and every tool rewriting the same TSX.'
          : 'Schematic, board and 3D from one TSX file. Write it, ask STEVE, or place parts and wire them by hand.'}</p>
        {/* Design's start tiles, for a board: new, open, a sample to learn from, or STEVE. */}
        <div className={`${vp.emptyGrid} ${styles.startGrid}`}>
          <button type="button" className={vp.startTile} id="new-circuit" onClick={() => openTab({ kind: 'circuit' })}><Plus size={20} /><span>New circuit</span><small>An empty board</small></button>
          <button type="button" className={vp.startTile} onClick={() => set({ dialog: 'open' })}><FolderOpen size={20} /><span>Open…</span><small>Saved circuits</small></button>
          <button type="button" className={vp.startTile} id="sample-circuit" data-accent onClick={() => { void openReferenceModel('electronics-led_indicator'); }}>
            <Sparkles size={20} /><span>Sample circuit</span><small>LED indicator</small>
          </button>
          <button type="button" className={vp.startTile} id="start-steve" onClick={() => toggleDock('assistant')}><MessageSquare size={20} /><span>Ask STEVE</span><small>Describe a board</small></button>
        </div>
        {circuits === null ? <div className={styles.startLoading}><Spinner size={14} /></div> : circuits.length > 0 && (
          <div className={styles.recent}>
            <span className={styles.recentTitle}>Your circuits</span>
            {circuits.map((doc) => (
              <button key={doc.id} type="button" className={styles.recentRow} data-circuit={doc.id} onClick={() => openTab({ id: doc.id })}>
                <CircuitBoard size={14} /><span>{doc.name}</span><small>{relativeTime(doc.updated_at)}</small>
              </button>
            ))}
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/** A board with no parts yet: what to do next, over the (empty) views. */
function EmptyBoard() {
  const board = useCircuit((state) => state.model?.board ?? null);
  const size = board?.width && board?.height ? `${Number(board.width.toFixed(2))} × ${Number(board.height.toFixed(2))} mm` : null;
  const place = () => { void import('./palette/partsTab').then((module) => module.openParts('library')); };
  return (
    <motion.div className={styles.emptyBoard} id="circuit-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div className={styles.startCard} initial={{ opacity: 0, y: 10, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 28 }}>
        <div className={styles.startGlyph}><CircuitIcon size={30} /></div>
        <h2>An empty board</h2>
        <p>{size ? `${size}, 1.6 mm, set up for the board house. ` : ''}Place parts and wire them, or tell STEVE what the board should do: it asks what it needs to know, picks real in-stock parts and lays it out.</p>
        <div className={styles.startActions}>
          <Button variant="primary" icon={<Shapes />} id="empty-place" onClick={place}>Place a part</Button>
          <Button icon={<MessageSquare />} id="empty-steve" onClick={() => toggleDock('assistant')}>Ask STEVE</Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The first build of a circuit, or one that failed with nothing to show yet. */
function Waiting() {
  const busy = useApp((state) => state.busy);
  const failed = useApp((state) => state.phase === 'failed' && !!state.error);
  const error = useCircuit((state) => state.error);
  if (failed || error) {
    return (
      <div className={styles.waiting} data-tone="error" id="circuit-failed">
        <AlertTriangle size={22} />
        <h3>{error ? 'The circuit was built, but couldn’t be read' : 'The circuit didn’t build'}</h3>
        <p>{error ?? 'The code has an error. Source shows where; STEVE can fix it.'}</p>
        <div className={styles.startActions}>
          <Button variant="primary" onClick={() => set({ dockOpen: true, dockTab: 'source' })}>Show the error</Button>
          <Button variant="ghost" icon={<MessageSquare />} onClick={() => toggleDock('assistant')}>Ask STEVE</Button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.waiting} id="circuit-building">
      <Spinner size={20} />
      <h3>{busy ? 'Building the circuit' : 'Waiting for the first build'}</h3>
      <p>tscircuit lays out the schematic and places the parts on the board.</p>
    </div>
  );
}

/**
 * Split puts the schematic and the board side by side when the canvas is wide, one above the other when it isn't:
 * both drawings are wider than tall, so two tall, narrow panes would show each at a fraction of the size.
 */
function useSplitDirection(): [(element: HTMLDivElement | null) => void, 'row' | 'column'] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [direction, setDirection] = useState<'row' | 'column'>('row');
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (width < 8 || height < 8) return;
      setDirection(width >= SIDE_BY_SIDE_ASPECT * height ? 'row' : 'column');
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, direction];
}
/** Side by side from this canvas aspect: two panes then fit a typical 1.6 : 1 drawing as well as stacked ones do. */
const SIDE_BY_SIDE_ASPECT = 1.6;

export default function ElectronicsViews() {
  const workspace = useApp((state) => state.workspace);
  const circuitOpen = useApp((state) => state.doc.open && state.doc.kind === 'circuit');
  const view = useCircuit((state) => state.view);
  const hasCircuit = useCircuit((state) => !!state.json);
  const placing = useSchematicTool((state) => state.tool === 'place');
  // The empty board's card steps aside while a part is on the pointer: it would be in the way of the click.
  const emptyBoard = useCircuit((state) => !!state.json && !!state.model && state.model.parts.length === 0) && !placing;
  const [canvas, split] = useSplitDirection();
  if (workspace !== 'electronics') return null;
  if (!circuitOpen) return <AnimatePresence><StartScreen key="start" /></AnimatePresence>;
  const flat = view !== '3d';
  return (
    <>
      {flat && (
        <div className={styles.views} data-view={view} data-split={split} id="circuit-canvas" ref={canvas}>
          {!hasCircuit ? <Waiting /> : (
            <Suspense fallback={<div className={styles.viewLoading}><Spinner /></div>}>
              {/* An empty board's next step sits where parts are placed: the schematic (the board when that's all that's shown). */}
              {(view === 'schematic' || view === 'split') && <div className={styles.pane} data-pane="schematic"><SchematicView compact={view === 'split'} />
                <AnimatePresence>{emptyBoard && <EmptyBoard key="empty" />}</AnimatePresence></div>}
              {view === 'split' && <div className={styles.paneDivider} />}
              {(view === 'pcb' || view === 'split') && <div className={styles.pane} data-pane="pcb"><PcbView compact={view === 'split'} />
                {view === 'pcb' && <AnimatePresence>{emptyBoard && <EmptyBoard key="empty" />}</AnimatePresence>}</div>}
            </Suspense>
          )}
        </div>
      )}
      <ViewSwitcher />
      {hasCircuit && <BoardFacts />}
      {hasCircuit && <ReadinessPanel />}
      <ExportGuard />
    </>
  );
}

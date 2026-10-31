import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Box, Code2, FolderOpen, GitBranch, Layers3, History, Lock, MessageSquare, Plus, RefreshCw, RotateCcw, Sparkles } from 'lucide-react';
import { Button, Shortcut, Spinner } from '@/ui';
import { get, hasContent, hasUnsavedWork, isPreviewStale, readOnlyReason, set, useApp } from '@/state/store';
import { relativeTime } from '@/lib/format';
import { serverCapabilities, shopMetadata } from '@/lib/api';
import { branchColor, branchOrder } from '@/lib/branches';
import { useFeatureDialog } from '@/modeling/dialog';
import { activateRevision, addComponent, leaveRevision, loadExample, updateModel } from '@/state/actions';
import { openTab } from '@/state/tabs';
import { toggleDock } from '@/commands';
import { retrySelectionPrep, useSelectionPrep } from './selectionPrep';
import { newSketch } from '@/sketch/actions';
import { SketchIcon } from '@/icons/cad';
import { modKey } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { VIEW_LABELS } from './viewer';
import styles from './Viewport.module.css';
import { useWorkspace } from '@/teams/current';

export function ViewLabel() {
  const view = useApp((state) => state.view);
  const projection = useApp((state) => state.projection);
  const hasModel = useApp((state) => !!state.displayed && !state.displayed.metadata?.empty);
  // The branch being edited, as in the top bar's pill (whose name narrow windows hide). A past revision's banner
  // already names its branch.
  const saved = useApp((state) => !!state.doc.saved && !state.pastVersion);
  const branch = useApp((state) => state.doc.branch);
  const branches = useApp((state) => state.branches);
  const graph = useApp((state) => state.graph);
  const units = useSetting('display.units');
  const [branching, setBranching] = useState(false);
  useEffect(() => { void serverCapabilities().then((caps) => setBranching(caps.branches)); }, []);
  if (!hasModel) return null;
  return (
    <div className={styles.viewLabel}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={view ?? 'custom'} id="view-orientation" className={styles.viewName} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} transition={{ duration: 0.18 }}>
          {view ? VIEW_LABELS[view] : 'Custom view'}
        </motion.span>
      </AnimatePresence>
      <span className={styles.viewMeta}>{projection === 'orthographic' ? 'Orthographic' : 'Perspective'} · {units}</span>
      {saved && branching && (
        <span id="view-branch" className={styles.viewBranch} style={{ ['--branch' as string]: branchColor(branch, branchOrder(branches, graph)) }}>
          <GitBranch size={11} strokeWidth={2} /><span>{branch}</span>
        </span>
      )}
    </div>
  );
}

export function Progress() {
  const busy = useApp((state) => state.busy);
  const label = useApp((state) => state.phaseLabel);
  return (
    <AnimatePresence>
      {busy && (
        <>
          <motion.div className={styles.progress} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <span className={styles.progressBar} />
          </motion.div>
          <motion.div id="viewer-loading" className={styles.busyChip} initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
            <Spinner size={13} />
            <span>{label || 'Working'}…</span>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/** Face & edge selection being completed for this model once it was first needed (viewport/selectionPrep.ts), or why
 * it couldn't be. */
export function SelectionPrepPill() {
  const { phase, error, held } = useSelectionPrep();
  const stale = useApp((state) => !state.busy && isPreviewStale(state));
  const show = phase !== 'idle' && !stale;
  return (
    <AnimatePresence>
      {show && (
        <motion.div className={styles.stale} id="selection-prep" data-failed={phase === 'failed' || undefined}
          title={phase === 'failed' ? error : phase === 'partial' ? 'Face and edge selection ran out of time partway: the parts it reached can be picked.' : undefined}
          initial={{ opacity: 0, y: -10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
          <span className={styles.staleDot} />
          {phase === 'preparing'
            ? <span>{held ? 'Preparing face & edge selection: your click completes when it’s ready…' : 'Preparing face & edge selection…'}</span>
            // A failure says why in the pill itself, cut to its width; the whole reason is its title.
            : <><span className={phase === 'failed' ? styles.prepReason : undefined}>{phase === 'partial' ? 'Some parts’ faces & edges can’t be picked' : error || 'Couldn’t prepare face & edge selection'}</span>
                <button type="button" className={styles.staleAction} onClick={retrySelectionPrep}><RefreshCw size={12} />Try again</button></>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function StalePill() {
  const previewing = useFeatureDialog((state) => state.open);  // A tool's preview shows code that isn't written yet.
  const stale = useApp((state) => !state.busy && !state.pastVersion && !state.sketching && isPreviewStale(state)) && !previewing;
  const hasModel = useApp((state) => !!state.displayed && !state.displayed.metadata?.empty);
  const failed = useApp((state) => state.phase === 'failed' && !!state.error);
  const outOfBudget = useApp((state) => state.budgetFailure);
  const live = useApp((state) => state.liveBuild);
  const circuit = useApp((state) => state.doc.kind === 'circuit');
  // Generation is automatic (state/autobuild.ts): this only appears when someone has to act, i.e. an update failed, or
  // Live rebuild is switched off.
  const show = stale && (failed || !live);
  return (
    <AnimatePresence>
      {show && (
        <motion.div className={styles.stale} data-failed={failed || undefined} initial={{ opacity: 0, y: -10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
          <span className={styles.staleDot} />
          <span>{failed && outOfBudget ? (outOfBudget.cause === 'time' ? 'Last update ran out of time' : 'Last update ran out of memory')
            : failed ? 'Last update failed' : circuit ? (hasModel ? 'Code changed since this build' : 'Circuit not built') : hasModel ? 'Source changed since this geometry' : 'Geometry not generated'}</span>
          {failed && outOfBudget ? (
            <button type="button" id="preview-stale" className={styles.staleAction} onClick={() => { void updateModel({ force: true }); }}><RefreshCw size={12} />Rebuild anyway</button>
          ) : failed ? (
            <button type="button" id="preview-stale" className={styles.staleAction} onClick={() => set({ dockOpen: true, dockTab: 'source' })}>Show diagnostics</button>
          ) : (
            <button type="button" id="preview-stale" className={styles.staleAction} onClick={() => { void updateModel(); }}>
              <RefreshCw size={12} />{circuit ? 'Build' : hasModel ? 'Update model' : 'Generate'}<Shortcut keys={`${modKey}+↵`} />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** "Create component" on an empty design: name it, and it gets its own file, placed in main.py and opened. */
function CreateComponent() {
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    const id = (name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!id) { setName(null); setProblem(null); return; }
    const outcome = addComponent(id, '');
    if (outcome === true) { setName(null); setProblem(null); } else setProblem(outcome);
  };
  if (name === null) return <Button variant="primary" icon={<Plus />} id="empty-component" onClick={() => setName('')}>Create component</Button>;
  return (
    <span className={styles.emptyName} data-invalid={problem ? true : undefined}>
      <input autoFocus value={name} placeholder="component_name" aria-label="New component name" spellCheck={false}
        onChange={(event) => { setName(event.target.value); setProblem(null); }}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') { setName(null); setProblem(null); } }} />
      <Button variant="primary" size="sm" onClick={commit} disabled={!name.trim()}>Create</Button>
      {problem && <small role="alert">{problem}</small>}
    </span>
  );
}

const componentTitle = (path: string) => path.replace(/^components\//, '').replace(/\.py$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function EmptyState() {
  const open = useApp((state) => state.doc.open);
  const kind = useApp((state) => state.doc.kind);
  // Built, with nothing modelled yet (a new design's empty components, a part with only sketches): not an error.
  const builtEmpty = useApp((state) => !!state.displayed?.metadata?.empty);
  const component = useApp((state) => (state.doc.kind === 'design' && state.doc.activeFile.startsWith('components/') ? state.doc.activeFile : null));
  const hasModel = useApp((state) => !!state.displayed && !state.displayed.metadata?.empty);
  const busy = useApp((state) => state.busy);
  const outOfBudget = useApp((state) => state.budgetFailure);
  // A new part or design's starter code (imports, `design = Design(…)`) has nothing to generate yet.
  const hasCode = useApp((state) => hasContent(state));
  const sketching = useApp((state) => !!state.sketching);
  const modeled = useApp((state) => !!state.modeling?.canonical && state.modeling.features.length > 0);
  const live = useApp((state) => state.liveBuild);
  const failed = useApp((state) => state.phase === 'failed' && !!state.error);
  // With Live rebuild on, source that hasn't been built yet is about to be: no "Ready to generate" card in between.
  const pending = hasCode && !builtEmpty && live && !failed;
  // A shop never has geometry: the canvas says what its build made (library items), or what to do next.
  const shopItems = useApp((state) => (state.doc.kind === 'shop' ? shopMetadata(state.displayed)?.records.length ?? null : null));
  const shop = kind === 'shop';
  const show = shop ? !busy && !(pending && shopItems === null) : !hasModel && !busy && !sketching && !modeled && !pending;
  return (
    <AnimatePresence>
      {show && (
        <motion.div id="empty-state" className={styles.empty} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }}>
          <motion.div className={styles.emptyCard} initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 28, delay: 0.05 }}>
            <div className={styles.emptyGlyph}>
              <svg viewBox="0 0 120 120" fill="none" aria-hidden="true">
                <g className={styles.emptySpin}>
                  <path d="M60 18 96 39v42L60 102 24 81V39Z" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M24 39 60 60l36-21M60 60v42" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
                  <path d="M60 18v42M24 81l36-21 36 21" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 3" opacity="0.35" />
                </g>
              </svg>
            </div>
            {open ? (
              <>
                {hasCode && !builtEmpty && failed && outOfBudget ? (
                  <>
                    <h2 id="empty-title">{outOfBudget.cause === 'time' ? `This model needs more than ${outOfBudget.budget_s ?? ''} s to build` : 'This model needs more memory than a build has'}</h2>
                    <p id="empty-description">{outOfBudget.stage ? `It stopped during ${outOfBudget.stage}. ` : ''}It won’t be rebuilt by itself until the source changes. Make it lighter (fewer faces, fillets or patterns), or rebuild it as it is.</p>
                  </>
                ) : hasCode && !builtEmpty && failed ? (
                  <>
                    <h2 id="empty-title">Couldn’t generate the model</h2>
                    <p id="empty-description">The source has an error; Source shows where.</p>
                  </>
                ) : shop ? (
                  <>
                    <h2 id="empty-title">{shopItems !== null ? `${shopItems} library ${shopItems === 1 ? 'item' : 'items'}` : hasCode ? 'Ready to build' : 'An empty shop'}</h2>
                    <p id="empty-description">{shopItems !== null
                      ? 'Built from the code. Each build of the saved shop updates the manufacturing library with them.'
                      : 'Add machines, controllers and tools in the code (shop.add), or ask STEVE. Building the saved shop updates the manufacturing library.'}</p>
                  </>
                ) : hasCode && !builtEmpty ? (
                  <>
                    <h2 id="empty-title">Ready to generate</h2>
                    <p id="empty-description">Live rebuild is off. Generate geometry from the source to see it here.</p>
                  </>
                ) : kind === 'design' && component ? (
                  <>
                    <h2 id="empty-title">{componentTitle(component)} is empty</h2>
                    <p id="empty-description">Sketch on a plane and extrude it, add a primitive, or describe it to STEVE.</p>
                  </>
                ) : kind === 'design' ? (
                  <>
                    <h2 id="empty-title">{hasCode ? 'Nothing modelled yet' : 'An empty design'}</h2>
                    <p id="empty-description">{hasCode ? 'Open a component to sketch in it, add another, or ask STEVE.' : 'Create a component, link a saved part, or ask STEVE.'}</p>
                  </>
                ) : (
                  <>
                    <h2 id="empty-title">An empty part</h2>
                    <p id="empty-description">Sketch on a plane and extrude it, add a primitive, write CadQuery, or describe it to STEVE.</p>
                  </>
                )}
                <div className={styles.emptyActions}>
                  {hasCode && !builtEmpty && failed && outOfBudget
                    ? <Button variant="primary" icon={<RefreshCw />} onClick={() => { void updateModel({ force: true }); }} id="empty-rebuild">Rebuild anyway</Button>
                    : hasCode && !builtEmpty && failed
                    ? <Button variant="primary" onClick={() => set({ dockOpen: true, dockTab: 'source' })}>Show diagnostics</Button>
                    : shop
                    ? (hasCode && shopItems === null
                      ? <Button variant="primary" icon={<RefreshCw />} onClick={() => { void updateModel(); }}>Build shop</Button>
                      : <Button variant="primary" icon={<Code2 />} onClick={() => set({ dockOpen: true, dockTab: 'source' })}>Edit code</Button>)
                    : hasCode && !builtEmpty
                    ? <Button variant="primary" icon={<RefreshCw />} onClick={() => { void updateModel(); }}>Generate model</Button>
                    : kind === 'part' || component
                      ? <Button variant="primary" icon={<SketchIcon size={16} />} onClick={() => newSketch()} id="empty-sketch">New sketch</Button>
                      : <CreateComponent />}
                  <Button icon={<MessageSquare />} onClick={() => toggleDock('assistant')}>Ask STEVE</Button>
                  {!hasCode && kind === 'part' && <Button variant="ghost" icon={<Sparkles />} onClick={() => { loadExample('plate'); void updateModel(); }}>Use a sample</Button>}
                </div>
              </>
            ) : (
              <>
                <h2 id="empty-title">A place for your next part.</h2>
                <p id="empty-description">Create a design, open one you’ve saved, or start from a sample.</p>
                <div className={styles.emptyGrid}>
                  <button type="button" className={styles.startTile} onClick={() => openTab({ kind: 'part' })}><Box size={20} /><span>New part</span><small>Single solid</small></button>
                  <button type="button" className={styles.startTile} onClick={() => openTab({ kind: 'design' })}><Layers3 size={20} /><span>New design</span><small>Components and links</small></button>
                  <button type="button" className={styles.startTile} onClick={() => set({ dialog: 'open' })}><FolderOpen size={20} /><span>Open…</span><small>Saved designs</small></button>
                  <button type="button" id="first-build" className={styles.startTile} data-accent onClick={() => { openTab({ kind: 'part', name: 'Mounting plate' }); loadExample('plate'); void updateModel(); }}><Sparkles size={20} /><span>Sample part</span><small>Mounting plate</small></button>
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Shown while a past revision is on screen: the design itself is unchanged until you restore. */
export function PastVersionBanner() {
  const past = useApp((state) => state.pastVersion);
  const busy = useApp((state) => state.busy);
  const unsaved = useApp((state) => hasUnsavedWork(state));
  const graph = useApp((state) => state.graph);
  const node = past && graph?.nodes.find((item) => item.key === past.key);
  const target = past ? (past.branch.includes('~') ? get().doc.branch : past.branch) : 'main';
  return (
    <AnimatePresence>
      {past && (
        <motion.div id="past-version" className={styles.pastVersion} role="status" initial={{ opacity: 0, y: -10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
          <History size={14} />
          <span className={styles.pastText}><b>{past.branch} · r{past.revision}</b><span>{past.message} · {relativeTime(past.recordedAt)} · read-only</span></span>
          <button type="button" className={styles.pastAction} disabled={busy || !node || (unsaved && target === get().doc.branch)} onClick={() => { if (node) void activateRevision(node, target); }}><RotateCcw size={12} />Make current</button>
          <button type="button" className={styles.pastAction} data-quiet disabled={busy} onClick={() => { void leaveRevision(); }}>Back to latest</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** A document this person can't change here: a team viewer's (they look and comment), or a saved circuit on a server
 * without Electronics (shown as it was last built). */
export function ReadOnlyBanner() {
  const reason = useApp((state) => (state.doc.open ? readOnlyReason(state) : null));
  const viewer = useWorkspace((state) => state.team?.role === 'viewer');
  return (
    <AnimatePresence>
      {reason && (
        <motion.div id="read-only-banner" className={styles.pastVersion} data-kind="read-only" role="status" initial={{ opacity: 0, y: -10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ type: 'spring', stiffness: 420, damping: 30 }}>
          <Lock size={14} />
          <span className={styles.pastText}><b>{reason}</b><span>{viewer ? 'Read-only for you: comments still work.' : 'Read-only here, as it was last built.'}</span></span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

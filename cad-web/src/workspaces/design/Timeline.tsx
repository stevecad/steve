import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Popover } from 'radix-ui';
import { History } from 'lucide-react';
import { ContextContent, ContextRoot, ContextTrigger, Tip } from '@/ui';
import { set, useApp } from '@/state/store';
import { summarize, type Feature } from '@/lib/features';
import { featureIcon } from './featureIcons';
import { revealSource } from './FeatureTree';
import { modelingIcon, openRow, useFeatureRows, type FeatureRow } from '@/modeling/features';
import { ItemMenu, RenameField, itemKeyDown, stopRename, useRenaming, type ItemTarget } from './ItemMenu';
import menu from './ItemMenu.module.css';
import { rollTo } from '@/modeling/rollback';
import styles from './Timeline.module.css';

/** One step: its tooltip, the same menu as its browser row (right click, Menu key, Shift+F10), F2 to rename. */
function Step({ target, name, description, children }: { target: ItemTarget; name: string; description: string; children: ReactElement }) {
  return (
    <ContextRoot>
      <Tip label={name} description={description} side="top">
        <ContextTrigger asChild>{children}</ContextTrigger>
      </Tip>
      <ContextContent><ItemMenu target={target} place="timeline" title={name} /></ContextContent>
    </ContextRoot>
  );
}

/** Horizontal feature history under the viewport, in the order operations ran. */
/** Modeling documents: one step per feature in code order; double-click edits it. The history marker sits after `marker` steps. */
function ModelingSteps({ rows, marker, preview }: { rows: FeatureRow[]; marker: number; preview: number | null }) {
  const active = useApp((state) => state.activeFeature);
  const shown = preview ?? marker;
  return (
    <>
      {rows.map((row, index) => {
        const Icon = modelingIcon(row.kind);
        const target: ItemTarget = { kind: 'feature', row };
        return (
          <Step key={row.key} target={target} name={row.name} description={row.error ?? (row.kind === 'code' ? 'Custom code: double-click to see it in Source.' : `${row.kind.replace('_', ' ')} · double-click to edit · right-click for more`)}>
            <motion.button type="button" className={styles.step} data-category={row.kind === 'sketch' ? 'sketch' : row.kind === 'code' ? 'opaque' : 'solid'}
              data-active={active === row.id || undefined} data-error={row.status === 'error' || undefined} data-unexecuted={row.status === 'suppressed' && index < shown ? true : undefined}
              data-rolled={index >= shown || undefined}
              aria-label={row.name} aria-haspopup="menu" data-feature={row.id ?? undefined} data-step style={{ order: index * 2 }}
              initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: Math.min(index * 0.012, 0.4), type: 'spring', stiffness: 500, damping: 30 }}
              onClick={() => set({ activeFeature: row.id, selection: [], dockOpen: true, dockTab: 'properties' })} onDoubleClick={() => openRow(row)} onKeyDown={(event) => itemKeyDown(event, target, 'timeline')}>
              <Icon size={14} strokeWidth={1.7} />
            </motion.button>
          </Step>
        );
      })}
    </>
  );
}

/** Renaming a step: a small field anchored above it. */
function RenamePopover() {
  const key = useRenaming((state) => (state.place === 'timeline' ? state.key : null));
  const id = key?.startsWith('feature:') ? key.slice(8) : null;
  const anchor = useMemo(() => ({ current: id ? document.querySelector(`[data-feature="${CSS.escape(id)}"]`) ?? document.body : document.body }), [id]);
  return (
    <Popover.Root open={!!id} onOpenChange={(open) => { if (!open) stopRename(); }}>
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content className={menu.popover} side="top" sideOffset={8} collisionPadding={10}
          onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()} onFocusOutside={(event) => event.preventDefault()}>
          <span className={`${menu.popoverLabel} caps`}>Rename</span>
          {key && <RenameField key={key} editKey={key} place="timeline" />}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The history marker: drag it between steps (or use ←/→, Home/End) to see the model as of that step;
 * new features go in at the marker. Double-click it to roll to the end.
 */
function Marker({ rows, position, preview, onPreview, track }: { rows: FeatureRow[]; position: number; preview: number | null; onPreview: (index: number | null) => void; track: React.RefObject<HTMLDivElement | null> }) {
  const busy = useApp((state) => state.busy);
  const commit = (index: number) => {
    onPreview(null);
    const clamped = Math.max(0, Math.min(rows.length, index));
    if (clamped === position) return;
    // The marker sits after the nearest step with an id at or before it (custom code can't be rolled back).
    const after = clamped >= rows.length ? undefined : [...rows.slice(0, clamped)].reverse().find((row) => row.id)?.id ?? null;
    void rollTo(after);
  };
  const gapAt = (clientX: number) => {
    const steps = [...(track.current?.querySelectorAll<HTMLElement>('[data-step]') ?? [])];
    return steps.filter((step) => { const box = step.getBoundingClientRect(); return box.left + box.width / 2 < clientX; }).length;
  };
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || busy) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    let current = position;
    const move = (e: PointerEvent) => { current = gapAt(e.clientX); onPreview(current); };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      commit(current);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
  };
  const end = position >= rows.length;
  return (
    <Tip label={end ? 'History marker' : `Rolled back after ${rows[position - 1]?.name ?? 'the start'}`}
      description="Drag it back to see the model as of that step; new features go in here. Double-click to roll to the end." side="top">
      <button type="button" className={styles.marker} id="history-marker" role="slider" aria-label="History marker" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={position}
        aria-valuetext={end ? 'At the end' : `After ${rows[position - 1]?.name ?? 'nothing'}`} data-rolled={(preview ?? position) < rows.length || undefined} disabled={busy}
        style={{ order: (preview ?? position) * 2 - 1 }} data-dragging={preview !== null || undefined}
        onPointerDown={onPointerDown} onDoubleClick={() => commit(rows.length)}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
          if (step) { event.preventDefault(); commit(position + step); }
          else if (event.key === 'Home') { event.preventDefault(); commit(0); }
          else if (event.key === 'End') { event.preventDefault(); commit(rows.length); }
        }} />
    </Tip>
  );
}

export default function Timeline() {
  const workspace = useApp((state) => state.workspace);
  const rollback = useApp((state) => state.rollback);
  const [preview, setPreview] = useState<number | null>(null);
  const features = useApp((state) => state.features);
  const rows = useFeatureRows();
  const active = useApp((state) => state.activeFeature);
  const kind = useApp((state) => state.doc.kind);
  const scroller = useRef<HTMLDivElement>(null);
  const tree = features?.state === 'ready' ? features.tree : null;
  const steps = tree?.features.filter((feature) => feature.category !== 'reference') ?? [];
  const show = workspace === 'design' && kind === 'part' && (rows ? rows.length > 0 : steps.length > 0);

  useEffect(() => {
    const element = scroller.current?.querySelector('[data-active]');
    element?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const failed = rows?.filter((row) => row.status === 'error' && !(row.id && rolledPast(rows, row.id, rollback?.after))).length ?? 0;
  // Only what needs attention: failures, or (older captured histories) that they can't be edited.
  const status = rows ? (failed ? `${failed} failed` : '') : !tree ? '' : tree.editable && tree.execution_verified ? '' : tree.status === 'captured' ? 'Captured' : tree.status === 'partial' ? 'Partial' : 'Read-only';
  const marker = !rows ? 0 : rollback ? (rollback.after === null ? 0 : Math.max(0, rows.findIndex((row) => row.id === rollback.after) + 1)) : rows.length;
  const legacy = (feature: Feature): ItemTarget => ({ kind: 'legacy-feature', feature });
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div className={styles.timeline} id="timeline" initial={{ height: 0, opacity: 0 }} animate={{ height: 42, opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 40 }}>
          <div className={styles.label}>
            <History size={13} /><span className="caps">Timeline</span>
            {status && <span className={styles.status} data-tone={failed ? 'error' : 'info'}>{status}</span>}
            {rows && rollback && (
              <button type="button" className={styles.rolled} id="roll-to-end" onClick={() => { void rollTo(undefined); }} title="Show every step again">
                Rolled back · {rows.length - marker} hidden <span>Roll to end</span>
              </button>
            )}
          </div>
          <div className={styles.track} ref={scroller}>
            {rows ? <>
              <ModelingSteps rows={rows} marker={marker} preview={preview} />
              <Marker rows={rows} position={marker} preview={preview} onPreview={setPreview} track={scroller} />
            </> : steps.map((feature, index) => {
              const Icon = featureIcon(feature.operation, feature.category);
              const summary = summarize(feature);
              return (
                <Step key={feature.id} target={legacy(feature)} name={feature.label} description={[feature.operation, summary].filter(Boolean).join(' · ')}>
                  <motion.button
                    type="button"
                    className={styles.step}
                    data-category={feature.category}
                    data-active={active === feature.id || undefined}
                    data-unexecuted={feature.executed === false || undefined}
                    aria-label={feature.label}
                    aria-haspopup="menu"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: Math.min(index * 0.012, 0.4), type: 'spring', stiffness: 500, damping: 30 }}
                    onClick={() => set({ activeFeature: feature.id, selection: [], dockOpen: true, dockTab: 'properties' })}
                    onDoubleClick={() => revealSource(feature)}
                    onKeyDown={(event) => itemKeyDown(event, legacy(feature), 'timeline')}
                  >
                    <Icon size={14} strokeWidth={1.7} />
                  </motion.button>
                </Step>
              );
            })}
          </div>
          <RenamePopover />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Whether a step is past the history marker (rolled back). */
function rolledPast(rows: FeatureRow[], id: string, after: string | null | undefined): boolean {
  if (after === undefined) return false;
  const marker = after === null ? 0 : rows.findIndex((row) => row.id === after) + 1;
  return rows.findIndex((row) => row.id === id) >= marker;
}

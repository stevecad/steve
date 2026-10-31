import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as THREE from 'three';
import { ArrowLeftRight, Bookmark, Expand, X } from 'lucide-react';
import { MeasureIcon, OriginIcon, SectionIcon } from '@/icons/cad';
import { Button, IconButton, NumberField, Segmented, Select, Slider, Switch, Tip } from '@/ui';
import { set, useApp, type Axis } from '@/state/store';
import { inUnits, MM_PER_INCH, num } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { viewer } from './viewer';
import { toggleExplode } from '@/commands';
import ExplodeToolPanel from '@/motion/ExplodeToolPanel';
import { createPlane, draftPlane } from '@/workspaces/design/planeTool';
import { nextPlaneName } from '@/lib/construction';
import { measure, pickLabel } from './measure';
import { sectionPlane } from './SectionLayer';
import { holdsSections, nextSectionName, saveSectionView, sectionNameProblem, sectionViews, useSectionEdit } from './sectionViews';
import motionStyles from '@/motion/Motion.module.css';
import JointPanel from '@/motion/JointPanel';
import MotionToolPanel from '@/motion/MotionToolPanel';
import PlacementPanel from '@/placement/PlacementPanel';
import FromPartPanel from '@/workspaces/manufacture/FromPartPanel';
import ProgramEditor from '@/workspaces/manufacture/cam/ProgramEditor';
import { useCam } from '@/workspaces/manufacture/cam/state';
import ToolFooter from '@/shell/ToolFooter';
import { useFromPart } from '@/workspaces/manufacture/fromPart';
import AnalysisPanel from '@/workspaces/surface/AnalysisPanel';
import { useSurfaceAnalysis } from '@/workspaces/surface/state';
import AppearancePanel from '@/materials/AppearancePanel';
import { useAppearanceTool } from '@/materials/actions';
import styles from './Viewport.module.css';

const AXIS_COLORS: Record<Axis, string> = { x: 'var(--axis-x)', y: 'var(--axis-y)', z: 'var(--axis-z)' };

export function Panel({ icon, title, onClose, children, footer, id }: { icon: React.ReactNode; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; id: string }) {
  return (
    <motion.div
      className={styles.commandPanel}
      data-panel={id}
      initial={{ opacity: 0, x: 10 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
    >
      <div className={styles.panelHeader}>
        <span className={styles.panelIcon}>{icon}</span>
        <span className={styles.panelTitle}>{title}</span>
        <IconButton small label="Close" onClick={onClose}><X /></IconButton>
      </div>
      <div className={styles.panelBody}>{children}</div>
      {footer /* A ToolFooter: the operation's OK/Cancel (or Close), the same in every tool. */}
    </motion.div>
  );
}

function SectionPanel() {
  const section = useApp((state) => state.section);
  const version = useApp((state) => state.modelVersion);
  const code = useApp((state) => state.doc.code);
  const editing = useSectionEdit((state) => state.editing);
  const views = useMemo(() => (holdsSections() ? sectionViews() : []), [code]); // eslint-disable-line react-hooks/exhaustive-deps
  const [name, setName] = useState(() => editing ?? nextSectionName(views));
  // The edited view's name stays with it until this tool closes; a new cut starts from the next free name.
  useEffect(() => { if (editing) setName(editing); }, [editing]);
  useEffect(() => () => useSectionEdit.setState({ editing: null }), []);
  const box = useMemo(() => viewer.model?.bounds(false) ?? new THREE.Box3(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (patch: Partial<typeof section>) => set({ section: { ...section, ...patch } });
  if (box.isEmpty()) return null;
  const { position } = sectionPlane(section, box);
  const axisIndex = { x: 0, y: 1, z: 2 }[section.axis];
  const min = box.min.getComponent(axisIndex), max = box.max.getComponent(axisIndex);
  const saving = holdsSections();
  const problem = saving ? sectionNameProblem(name.trim(), editing, views) : null;
  const save = () => { if (!problem) saveSectionView(name.trim(), position); };
  return (
    <Panel id="section" icon={<SectionIcon size={16} />} title={editing ? `Edit ${editing}` : 'Section analysis'} onClose={() => update({ enabled: false })}
      footer={<ToolFooter onCancel={() => update({ enabled: false })} cancelLabel="Close" cancelId="section-close"
        extra={<>
          <Button size="sm" variant="ghost" icon={<ArrowLeftRight />} onClick={() => update({ flip: !section.flip })}>Flip side</Button>
          {saving && (
            <Tip label={editing ? 'Update section view' : 'Save section view'} reason={problem ?? undefined} side="top"
              description={`Keeps this cut in the code as ${name.trim() || 'a section view'}: it’s listed under Sections in the Browser, and clicking it shows the cut again.`}>
              <span><Button size="sm" variant="ghost" icon={<Bookmark />} id="section-save" disabled={!!problem} onClick={save}>{editing ? 'Update' : 'Save'}</Button></span>
            </Tip>
          )}
        </>} />}>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>Plane normal</span>
        <Segmented value={section.axis} onChange={(axis) => update({ axis })} options={(['x', 'y', 'z'] as Axis[]).map((axis) => ({ value: axis, label: <span style={{ color: AXIS_COLORS[axis], fontWeight: 700 }}>{axis.toUpperCase()}</span> }))} />
      </div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>Offset</span>
        <div style={{ width: 118 }}>
          <NumberField value={Number(position.toFixed(3))} prefix={section.axis.toUpperCase()} prefixColor={AXIS_COLORS[section.axis]} step={0.5} live ariaLabel="Section offset" onChange={(value) => update({ offset: THREE.MathUtils.clamp((value - min) / Math.max(max - min, 1e-9), 0, 1) })} />
        </div>
      </div>
      <Slider label="Section offset" value={section.offset} onChange={(offset) => update({ offset })} />
      <div className={styles.panelHint}>{num(min)} to {num(max)} mm · hatched caps show solid material</div>
      {saving && (
        <div className={styles.panelRow}>
          <span className={styles.panelLabel}>Save as</span>
          <input className={motionStyles.nameInput} aria-label="Section view name" value={name} spellCheck={false} data-invalid={problem ? true : undefined}
            title={problem ?? undefined} onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); save(); } }} />
        </div>
      )}
      {saving && problem && name.trim() && <div className={styles.panelHint} data-tone="warning">{problem}</div>}
    </Panel>
  );
}

function MeasurePanel() {
  const picks = useApp((state) => state.measurePicks);
  const version = useApp((state) => state.modelVersion);
  const units = useSetting('display.units');
  const result = useMemo(() => (viewer.model ? measure(viewer.model, picks) : null), [picks, version, units]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasTopology = viewer.model?.hasTopology;
  return (
    <Panel id="measure" icon={<MeasureIcon size={16} />} title="Measure" onClose={() => set({ tool: 'select', measurePicks: [] })}
      footer={<ToolFooter onCancel={() => set({ tool: 'select', measurePicks: [] })} cancelLabel="Close" cancelId="measure-close"
        extra={<Button size="sm" variant="ghost" onClick={() => set({ measurePicks: [] })} disabled={!picks.length}>Clear</Button>} />}>
      <div className={styles.measureSlots}>
        {[0, 1].map((index) => (
          <div key={index} className={styles.measureSlot} data-filled={!!picks[index] || undefined}>
            <span className={styles.slotIndex}>{index + 1}</span>
            <span>{picks[index] ? pickLabel(viewer.model, picks[index]) : index === picks.length ? 'Pick an entity' : '—'}</span>
          </div>
        ))}
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {result ? (
          <motion.div key={result.title} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
            <div className={styles.measureTitle}>{result.title}</div>
            <dl className={styles.measureRows}>
              {result.rows.map((row) => (
                <div key={row.label} data-emphasis={row.emphasis || undefined} title={row.title}><dt>{row.label}</dt><dd className="tnum">{row.value}</dd></div>
              ))}
            </dl>
          </motion.div>
        ) : (
          <motion.p key="hint" className={styles.panelHint} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            {hasTopology ? 'Click faces, edges or vertices. Two picks give distances and angles. For a narrow face, zoom in or set the filter to Faces.' : 'Click faces to measure. Edge and vertex picking needs topology from a newer build — regenerate to enable it.'}
          </motion.p>
        )}
      </AnimatePresence>
    </Panel>
  );
}

function ExplodePanel() {
  const explode = useApp((state) => state.explode);
  return (
    <Panel id="explode" icon={<Expand size={16} />} title="Quick explode" onClose={toggleExplode}
      footer={<ToolFooter onCancel={toggleExplode} cancelLabel="Close" cancelId="explode-close"
        extra={<Button size="sm" variant="ghost" onClick={() => set({ explode: 0 })}>Collapse</Button>} />}>
      <div className={styles.panelRow}><span className={styles.panelLabel}>Distance</span><span className="tnum" style={{ fontSize: 12 }}>{Math.round(explode * 100)}%</span></div>
      <Slider label="Explode distance" value={explode} min={0} max={1.5} step={0.001} onChange={(value) => set({ explode: value })} />
      <div className={styles.panelHint}>Display only — placements in the design and STEP export are unchanged. To keep an exploded view in the design and play it step by step, use Motion → Explode steps.</div>
    </Panel>
  );
}

function PlanePanel() {
  const units = useSetting('display.units');
  const scale = units === 'in' ? MM_PER_INCH : 1;
  const draft = useApp((state) => state.planeDraft);
  const selection = useApp((state) => state.selection);
  const code = useApp((state) => state.doc.code);
  const version = useApp((state) => state.modelVersion);
  const update = (patch: Partial<typeof draft>) => set({ planeDraft: { ...draft, ...patch } });
  const result = useMemo(() => draftPlane(viewer.model, useApp.getState(), draft), [draft, selection, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const range = Math.max(Math.round(viewer.modelRadius() * 2), 20);
  const close = () => set({ tool: 'select' });
  return (
    <Panel id="plane" icon={<OriginIcon size={16} />} title={draft.editing ? `Edit ${draft.editing.name}` : 'Construction plane'} onClose={close}
      footer={<ToolFooter onCancel={close} onOk={() => createPlane(viewer.model)} okId="plane-ok" okTitle={draft.editing ? `Update ${draft.editing.name}` : `Create ${nextPlaneName(code)}`}
        okDisabled={'error' in result ? result.error : null} />}>
      <Segmented value={draft.mode} onChange={(mode) => update({ mode })} options={[{ value: 'offset', label: 'Offset' }, { value: 'midplane', label: 'Midplane' }, { value: 'points', label: '3 points' }]} />
      {draft.mode === 'offset' && (
        <>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>From</span>
            <div style={{ width: 150 }}>
              <Select ariaLabel="Reference" value={draft.reference} onChange={(reference) => update({ reference })} options={[
                ...(draft.editing ? [{ value: 'existing' as const, label: 'Current position' }] : []),
                { value: 'XY', label: 'Origin XY plane' }, { value: 'XZ', label: 'Origin XZ plane' }, { value: 'YZ', label: 'Origin YZ plane' }, { value: 'face', label: 'Selected face' },
              ]} />
            </div>
          </div>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>Distance ({units})</span>
            <div style={{ width: 118 }}><NumberField value={inUnits(draft.offset, units)} unit={units} step={units === 'in' ? 0.1 : 1} live ariaLabel="Offset distance" onChange={(offset) => update({ offset: offset * scale })} /></div>
          </div>
          <Slider label={`Offset distance (${units})`} value={inUnits(draft.offset, units)} min={-range / scale} max={range / scale} step={units === 'in' ? 0.01 : 0.5} onChange={(offset) => update({ offset: offset * scale })} />
        </>
      )}
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>Reverse normal</span>
        <Switch label="Reverse normal" checked={draft.flip} onCheckedChange={(flip) => update({ flip })} />
      </div>
      <div className={styles.panelHint} data-tone={'error' in result ? 'warning' : undefined}>
        {'error' in result ? result.error : draft.mode === 'offset' && draft.reference === 'face' ? 'Offset from the selected planar face.' : draft.mode === 'midplane' ? 'Centered between the two selected faces.' : draft.mode === 'points' ? 'Through the three selected vertices.' : draft.reference === 'existing' ? 'Offset along the current plane normal.' : 'Parallel to an origin plane.'}
        {' '}{draft.editing ? 'Changes update sketches referencing this plane. Distance from the current position is a relative offset.' : 'After creating it, right-click the plane in the Model tree and choose New sketch on this plane.'}
      </div>
    </Panel>
  );
}

export default function CommandPanels() {
  const section = useApp((state) => state.section.enabled && !state.section.saved);
  const measuring = useApp((state) => state.tool === 'measure');
  const exploding = useApp((state) => state.tool === 'explode');
  const planing = useApp((state) => state.tool === 'plane');
  const jointing = useApp((state) => state.tool === 'joint');
  const motionTool = useApp((state) => state.tool === 'motion');
  const explodeSteps = useApp((state) => state.tool === 'explodeSteps');
  const placing = useApp((state) => state.tool === 'place');
  const docOpen = useApp((state) => state.doc.open);
  const workspace = useApp((state) => state.workspace);
  const hasModel = useApp((state) => !!state.displayed);
  const toolPart = useFromPart((state) => state.open);
  const camEditor = useCam((state) => !!state.editor);
  const analysing = useSurfaceAnalysis((state) => !!state.mode) && workspace === 'design';
  const appearance = useAppearanceTool((state) => state.open);
  return (
    <div className={styles.commandStack}>
      <AnimatePresence>
        {docOpen && planing && <PlanePanel key="plane" />}
        {docOpen && jointing && <JointPanel key="joint" />}
        {docOpen && motionTool && <MotionToolPanel key="motion" />}
        {hasModel && placing && <PlacementPanel key="place" />}
        {hasModel && exploding && <ExplodePanel key="explode" />}
        {hasModel && explodeSteps && <ExplodeToolPanel key="explode-steps" />}
        {docOpen && hasModel && appearance && <AppearancePanel key="appearance" />}
        {hasModel && measuring && <MeasurePanel key="measure" />}
        {hasModel && section && <SectionPanel key="section" />}
        {hasModel && analysing && <AnalysisPanel key="surface-analysis" />}
        {toolPart && <FromPartPanel key="toolpart" />}
        {camEditor && <ProgramEditor key="cam" />}
      </AnimatePresence>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Info, Loader2, Minus, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { Button, IconButton, Segmented, Switch } from '@/ui';
import { useScrub } from '@/ui/useScrub';
import { inUnits, lengthDigits } from '@/lib/format';
import { ANGLE_UNITS, hasLengthUnit } from '@/lib/lengths';
import { useSetting } from '@/settings/store';
import type { IconType } from '@/commands';
import {
  CoincidentIcon, CollinearIcon, ConcentricIcon, ConstructionIcon, DimensionIcon, EqualIcon, FixConstraintIcon, HorizontalIcon, MidpointIcon,
  ParallelIcon, PerpendicularIcon, SketchIcon, SymmetricIcon, TangentIcon, VerticalIcon,
} from '@/icons/cad';
import { choosePlane } from './actions';
import { sketchCommands } from './commands';
import { DIMENSION_OPS, emitStatement, FIXED, GEOMETRY_OPS, points as pointMap, type Entity, type Stmt } from './model';
import { deleteSelection, entityOf, removeStatement, setPolygonSides, solveStatus, toggleConstruction, useSketch, type HeadsField, type ToolId } from './session';
import { cancelTool, commitTyped, okTool, planConstraint, refreshPreview, measuredText, setDimension, setEllipseGeometry, setTool, setTyped, splinePoints, TOOL_HINTS, typeSize } from './tools';
import ToolFooter from '@/shell/ToolFooter';
import { addConstraint, CONSTRAINT_LABELS, constraintOf, constraintPrompt, constraintSteps, type ConstraintKind } from './constraintTool';
import styles from './SketchPanel.module.css';

const spring = { type: 'spring', stiffness: 460, damping: 36 } as const;

/** A draw tool's variants, offered as its Mode (the tools themselves are on the ribbon's Sketch tab). */
const FAMILIES: { id: string; label: string; modes: { tool: ToolId; label: string }[] }[] = [
  { id: 'select', label: 'Select', modes: [{ tool: 'select', label: 'Select' }] },
  { id: 'line', label: 'Line', modes: [{ tool: 'line', label: 'Line' }] },
  { id: 'rect', label: 'Rectangle', modes: [{ tool: 'rect', label: 'Two corners' }, { tool: 'center_rect', label: 'Center' }] },
  { id: 'circle', label: 'Circle', modes: [{ tool: 'circle', label: 'Center' }, { tool: 'circle_3pt', label: '3 points' }] },
  { id: 'arc', label: 'Arc', modes: [{ tool: 'arc_3pt', label: '3 points' }, { tool: 'arc_center', label: 'Center' }] },
  { id: 'polygon', label: 'Polygon', modes: [{ tool: 'polygon', label: 'Polygon' }] },
  { id: 'slot', label: 'Slot', modes: [{ tool: 'slot', label: 'Slot' }] },
  { id: 'ellipse', label: 'Ellipse', modes: [{ tool: 'ellipse', label: 'Ellipse' }] },
  { id: 'spline', label: 'Spline', modes: [{ tool: 'spline', label: 'Spline' }] },
  { id: 'point', label: 'Point', modes: [{ tool: 'point', label: 'Point' }] },
  { id: 'project', label: 'Project', modes: [{ tool: 'project', label: 'Project' }] },
  { id: 'dimension', label: 'Dimension', modes: [{ tool: 'dimension', label: 'Dimension' }] },
  { id: 'trim', label: 'Trim', modes: [{ tool: 'trim', label: 'Trim' }] },
];
const familyOf = (tool: ToolId) => FAMILIES.find((f) => f.modes.some((m) => m.tool === tool)) ?? FAMILIES[0];
const SELECT_HINT = 'Click to select, Shift+click to add. Where items overlap, click again for the next one. Drag a curve to move its shape, a point to reshape. Draw tools are on the Sketch ribbon.';

const CONSTRAINTS: { kind: string; label: string; icon: IconType }[] = [
  { kind: 'coincident', label: 'Coincident', icon: CoincidentIcon },
  { kind: 'collinear', label: 'Collinear', icon: CollinearIcon },
  { kind: 'horizontal', label: 'Horizontal', icon: HorizontalIcon },
  { kind: 'vertical', label: 'Vertical', icon: VerticalIcon },
  { kind: 'parallel', label: 'Parallel', icon: ParallelIcon },
  { kind: 'perpendicular', label: 'Perpendicular', icon: PerpendicularIcon },
  { kind: 'tangent', label: 'Tangent', icon: TangentIcon },
  { kind: 'equal', label: 'Equal', icon: EqualIcon },
  { kind: 'concentric', label: 'Concentric', icon: ConcentricIcon },
  { kind: 'midpoint', label: 'Midpoint', icon: MidpointIcon },
  { kind: 'symmetric', label: 'Symmetric', icon: SymmetricIcon },
  { kind: 'fix', label: 'Fix', icon: FixConstraintIcon },
];

const OPS: Record<string, { label: string; icon: IconType }> = {
  coincident: { label: 'Coincident', icon: CoincidentIcon }, point_on: { label: 'Point on curve', icon: CoincidentIcon },
  horizontal: { label: 'Horizontal', icon: HorizontalIcon }, vertical: { label: 'Vertical', icon: VerticalIcon },
  parallel: { label: 'Parallel', icon: ParallelIcon }, perpendicular: { label: 'Perpendicular', icon: PerpendicularIcon },
  collinear: { label: 'Collinear', icon: CollinearIcon }, tangent: { label: 'Tangent', icon: TangentIcon }, equal: { label: 'Equal', icon: EqualIcon },
  symmetric: { label: 'Symmetric', icon: SymmetricIcon }, midpoint: { label: 'Midpoint', icon: MidpointIcon }, concentric: { label: 'Concentric', icon: ConcentricIcon },
  fix: { label: 'Fixed', icon: FixConstraintIcon }, distance: { label: 'Distance', icon: DimensionIcon }, length: { label: 'Length', icon: DimensionIcon },
  horizontal_distance: { label: 'Horizontal', icon: DimensionIcon }, vertical_distance: { label: 'Vertical', icon: DimensionIcon },
  angle: { label: 'Angle', icon: DimensionIcon }, radius: { label: 'Radius', icon: DimensionIcon }, diameter: { label: 'Diameter', icon: DimensionIcon },
};

/** Where a dimension statement keeps its value (as setDimension writes it). */
const VALUE_AT: Record<string, number> = { distance: 2, horizontal_distance: 2, vertical_distance: 2, angle: 2, length: 1, radius: 1, diameter: 1 };

const commandOf = (id: string) => sketchCommands.find((c) => c.id === id);
const shortcut = (id: string) => commandOf(id)?.shortcut;
const description = (id: string) => commandOf(id)?.description;

/** What a selected ref is, in words: `line`, `projected line`, `point`, `constraint`. */
function kindOf(ref: string, entities: Entity[], constraintIds: Set<string>): string {
  if (constraintIds.has(ref)) return 'constraint';
  if (ref === 'x_axis' || ref === 'y_axis') return 'axis';
  if (ref === 'origin') return 'origin';
  const entity = entities.find((e) => e.id === ref);
  const owner = entities.find((e) => e.id === (entityOf(ref, entities) ?? ref));
  const base = entity ? (entity.type === 'bspline' ? 'spline' : entity.type) : pointMap(entities).has(ref) ? 'point' : 'item';
  return owner?.external ? `projected ${base}` : owner?.construction ? `construction ${base}` : base;
}

/**
 * The right-hand Sketch panel, like a 3D feature's: where to sketch while choosing a plane; then the active tool's
 * options, what is selected (and the constraints that apply to it), the sketch's dimensions and constraints, what to do
 * next and the solve status. Its OK/Cancel belong to the active tool (as every tool's footer does); the sketch itself is
 * finished or cancelled from the ribbon's Sketch tab (Finish sketch, Mod+Enter). Nothing floats over the view.
 */
export default function SketchPanel() {
  const active = useSketch((s) => s.active);
  const choosing = useSketch((s) => s.choosing);
  return (
    <AnimatePresence mode="wait">
      {active ? <OpenSketch key="sketch" /> : choosing ? <ChoosePlane key="choose" /> : null}
    </AnimatePresence>
  );
}

const enter = { initial: { opacity: 0, x: 10 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, transition: { duration: 0.12 } }, transition: { type: 'spring', stiffness: 420, damping: 34 } } as const;

function ChoosePlane() {
  const hovered = useSketch((s) => s.planeHover);
  const leave = () => useSketch.setState({ choosing: false, planeHover: null });
  return (
    <motion.div id="sketch-panel" data-choosing className={styles.panel} {...enter} onPointerDown={(event) => event.stopPropagation()}>
      <div className={styles.head}>
        <span className={styles.icon}><SketchIcon size={17} /></span>
        <div className={styles.title}><b>New sketch</b><span>Choose where to draw</span></div>
        <IconButton small label="Cancel" onClick={leave}><X /></IconButton>
      </div>
      <div className={styles.body}>
        <section className={styles.section} aria-label="Plane">
          <Row label="Origin plane">
            <span className={styles.planes}>
              {(['XY', 'XZ', 'YZ'] as const).map((plane) => (
                <button key={plane} type="button" data-plane={plane} data-hot={hovered === plane || undefined} onClick={() => choosePlane(plane)}
                  onPointerEnter={() => useSketch.setState({ planeHover: plane })} onPointerLeave={() => useSketch.setState({ planeHover: null })}>{plane}</button>
              ))}
            </span>
          </Row>
          <p className={styles.empty}>Or click a flat face of the model.</p>
        </section>
      </div>
      <div className={styles.footer}>
        <p className={styles.next} id="sketch-hint"><Info size={13} />{hovered ? `Sketch on the ${hovered} plane.` : 'Click an origin plane or a flat face in the view.'}</p>
        <ToolFooter inline keys={false} onCancel={leave} cancelId="sketch-cancel" />
      </div>
    </motion.div>
  );
}

function OpenSketch() {
  const name = useSketch((s) => s.name);
  const planeLabel = useSketch((s) => s.planeLabel);
  const result = useSketch((s) => s.result);
  const solving = useSketch((s) => s.solving);
  const tool = useSketch((s) => s.tool);
  const construction = useSketch((s) => s.construction);
  const selection = useSketch((s) => s.selection.length);
  const verdict = solveStatus(result, solving);
  return (
    <motion.div id="sketch-panel" className={styles.panel} {...enter} onPointerDown={(event) => event.stopPropagation()}>
      <div className={styles.head}>
        <span className={styles.icon}><SketchIcon size={17} /></span>
        <div className={styles.title}><b>{name}</b><span title={planeLabel}>on {planeLabel}</span></div>
        {construction && <span className={styles.tag} title="New geometry is construction (Q)">Construction</span>}
        <span className={styles.chip} data-tone={verdict.tone} id="sketch-panel-status" title={verdict.text}>
          {solving ? <Loader2 size={11} className={styles.spin} /> : <i />}
          {result?.status === 'ok' && result.dof !== null ? (result.dof === 0 ? 'Defined' : `${result.dof} DOF`) : verdict.tone === 'conflict' ? 'Conflict' : '—'}
        </span>
      </div>
      <div className={styles.body}>
        <AnimatePresence initial={false}>{tool !== 'select' && (constraintOf(tool) ? <ConstraintSection key="constraint" /> : <ToolSection key="tool" />)}</AnimatePresence>
        {/* While a constraint tool is active the selection is its picks, listed in its section. */}
        <AnimatePresence initial={false}>{selection > 0 && !constraintOf(tool) && <SelectionSection key="selection" />}</AnimatePresence>
        <ListSection />
      </div>
      <StatusFooter />
    </motion.div>
  );
}

/** The active tool and its options, as a 3D tool's dialog shows its parameters. */
function ToolSection() {
  const tool = useSketch((s) => s.tool);
  const family = familyOf(tool);
  const cmd = commandOf(`sketch.${tool}`);
  const Icon = cmd?.icon;
  return (
    <motion.section className={styles.section} aria-label="Tool" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div key={family.id} className={styles.options} data-options={family.id} id="sketch-tool"
          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4, transition: { duration: 0.1 } }} transition={spring}>
          <div className={styles.toolHead}>
            {Icon && <Icon size={15} strokeWidth={1.6} />}
            <b>{family.label}</b>
            {shortcut(`sketch.${family.modes[0].tool}`) && <kbd>{shortcut(`sketch.${family.modes[0].tool}`)}</kbd>}
          </div>
          <ToolOptions tool={tool} family={family} />
        </motion.div>
      </AnimatePresence>
    </motion.section>
  );
}

/** A constraint tool: its picks so far and the next one asked for (picked items also draw as picked). */
function ConstraintSection() {
  const tool = useSketch((s) => s.tool);
  const selection = useSketch((s) => s.selection);
  const entities = useSketch((s) => s.expansion.entities);
  // While it animates out the tool is already Select: keep showing the constraint it was.
  const last = useRef<ConstraintKind>(constraintOf(tool) ?? 'coincident');
  last.current = constraintOf(tool) ?? last.current;
  const kind = last.current;
  const cmd = commandOf(`sketch.c.${kind}`);
  const Icon = cmd?.icon;
  const steps = constraintSteps(kind, selection, entities);
  return (
    <motion.section className={styles.section} aria-label="Tool" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
      <div className={styles.options} data-options="constraint" data-constraint-tool={kind} id="sketch-tool">
        <div className={styles.toolHead}>
          {Icon && <Icon size={15} strokeWidth={1.6} />}
          <b>{CONSTRAINT_LABELS[kind]}</b>
          {shortcut(`sketch.c.${kind}`) && <kbd>{shortcut(`sketch.c.${kind}`)}</kbd>}
        </div>
        <ol className={styles.steps} id="sketch-constraint-steps">
          {steps.map((step, i) => (
            <li key={i} data-done={step.ref ? true : undefined}>
              <span className={styles.stepIndex}>{i + 1}</span>
              <span>{step.ref ? <code>{step.ref}</code> : step.prompt}</span>
            </li>
          ))}
        </ol>
      </div>
    </motion.section>
  );
}

function ToolOptions({ tool, family }: { tool: ToolId; family: (typeof FAMILIES)[number] }) {
  const construction = useSketch((s) => s.construction);
  const sides = useSketch((s) => s.polygonSides);
  const inscribed = useSketch((s) => s.polygonInscribed);
  const drawing = !['select', 'dimension', 'trim'].includes(tool);
  return (
    <>
      {family.modes.length > 1 && (
        <Row label="Mode">
          <Segmented size="sm" value={tool} onChange={(mode) => setTool(mode)}
            options={family.modes.map((m) => ({ value: m.tool, label: m.label }))} />
        </Row>
      )}
      {tool === 'polygon' && (
        <>
          <Row label="Sides"><Stepper value={sides} min={3} max={64} label="Polygon sides" onChange={(n) => { useSketch.setState({ polygonSides: n }); refreshPreview(); }} /></Row>
          <Row label="Fit">
            <Segmented size="sm" value={inscribed ? 'inscribed' : 'circumscribed'} onChange={(fit) => { useSketch.setState({ polygonInscribed: fit === 'inscribed' }); refreshPreview(); }}
              options={[{ value: 'inscribed', label: 'Inscribed' }, { value: 'circumscribed', label: 'Circumscribed' }]} />
          </Row>
        </>
      )}
      {drawing && (
        <Row label="Construction">
          <span className={styles.switchRow}>
            <Switch checked={construction} onCheckedChange={(next) => useSketch.setState({ construction: next })} label="Construction" />
            <small>{construction ? 'Reference only, no profile' : 'Forms profiles'}</small>
          </span>
        </Row>
      )}
      {tool === 'spline' && <SplinePoints />}
      <SizeFields />
    </>
  );
}

/** A spline's control points so far; OK below makes it (Enter, a double-click or Esc do too). */
function SplinePoints() {
  useSketch((s) => s.preview);  // Redrawn as points are placed.
  const placed = splinePoints();
  return (
    <Row label="Points">
      <small id="sketch-spline-points">{placed ? `${placed} placed${placed < 2 ? ' · one more makes a spline' : ''}` : 'None yet'}</small>
    </Row>
  );
}

/** The heads-up sizes of the shape being drawn, mirrored here: type to lock, Enter to place. */
function SizeFields() {
  const fields = useSketch((s) => s.fields);
  const typed = useSketch((s) => s.typed);
  if (!fields.length) return null;
  return (
    <Row label="Size">
      <span className={styles.sizes}>
        {fields.map((f) => <SizeField key={f.key} field={f} entry={typed[f.key]} />)}
      </span>
    </Row>
  );
}

function SizeField({ field: f, entry }: { field: HeadsField; entry: { source: string; value: number | null } | undefined }) {
  const units = useSetting('display.units');
  const shown = entry ? entry.source : measuredText(f, units);
  // Dragging a plain number sideways locks the size as typing does (Enter or a click still places the shape); Esc puts back what was there.
  const scrub = useScrub({ text: shown, positive: !f.angle, onScrub: (text) => typeSize(f.key, text), onCommit: () => {},
    onCancel: () => (entry ? setTyped(f.key, entry.source, entry.value) : setTyped(f.key, '', null)) });
  return (
    <label className={styles.size} data-locked={entry && entry.value !== null ? true : undefined} data-invalid={entry && entry.value === null ? true : undefined}
      title={f.angle && entry && entry.value === null && hasLengthUnit(entry.source) ? ANGLE_UNITS : f.angle ? undefined : units === 'in' ? 'Inches, or a length like 10mm' : 'Millimetres, or a length like 1in or 3cm'}>
      <b>{f.label}</b>
      <input {...scrub.props} value={shown} spellCheck={false} data-size-field={f.key} aria-label={`Size ${f.label}`} aria-invalid={!!entry && entry.value === null}
        onFocus={(event) => event.target.select()}
        onInput={(event) => { if (!useSketch.getState().typed[f.key]) typeSize(f.key, event.currentTarget.value); }}
        onChange={(event) => typeSize(f.key, event.target.value)}
        onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); commitTyped(); } }} />
      <em>{f.angle ? '°' : units}</em>
    </label>
  );
}

/** What is selected: its refs, polygon sides, Construction/Delete, and the constraints that apply to it. */
function SelectionSection() {
  const selection = useSketch((s) => s.selection);
  const expansion = useSketch((s) => s.expansion);
  const statements = useSketch((s) => s.statements);
  const constraintIds = useMemo(() => new Set(expansion.constraints.map((c) => c.id)), [expansion]);
  const geometry = selection.filter((ref) => !constraintIds.has(ref) && !FIXED.has(ref) && !expansion.entities.find((e) => e.id === (entityOf(ref, expansion.entities) ?? ref))?.external);
  // A selected polygon (any of its sides or corners) can change its side count.
  const polygons = useMemo(() => {
    const owners = new Set(selection.map((ref) => expansion.owners.findIndex((o) => o.entities.includes(entityOf(ref, expansion.entities) ?? ref))));
    return [...owners].filter((i) => i >= 0 && statements[i]?.op === 'polygon');
  }, [selection, expansion, statements]);
  const ellipseIndex = selection.length === 1 ? expansion.owners.findIndex(o => o.entities.includes(entityOf(selection[0], expansion.entities) ?? selection[0])) : -1;
  const ellipse = ellipseIndex >= 0 && statements[ellipseIndex]?.op === 'ellipse' ? statements[ellipseIndex] : null;
  return (
    <motion.section className={styles.section} aria-label="Selection" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
      <h3 className="caps">Selection<span className={styles.count}>{selection.length || ''}</span>
        <button type="button" className={styles.link} onClick={() => useSketch.setState({ selection: [] })}>Clear</button>
      </h3>
      <div className={styles.chips} id="sketch-selection">
        <AnimatePresence initial={false}>
          {selection.map((ref) => (
            <motion.span key={ref} layout className={styles.ref} data-ref={ref} initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }} transition={spring}
              onPointerEnter={() => useSketch.setState({ highlight: [ref] })} onPointerLeave={() => useSketch.setState({ highlight: [] })}>
              <code>{ref}</code><small>{kindOf(ref, expansion.entities, constraintIds)}</small>
              <X size={11} onClick={() => useSketch.setState((state) => ({ selection: state.selection.filter((r) => r !== ref), highlight: [] }))} aria-label={`Deselect ${ref}`} />
            </motion.span>
          ))}
        </AnimatePresence>
      </div>
      {polygons.map((index) => (
        <Row key={index} label={`${statements[index].args[0]?.value} sides`}>
          <Stepper value={Number(statements[index].args[3]?.value ?? statements[index].kwargs.sides?.value ?? 6)} min={3} max={64} label="Selected polygon sides"
            onChange={(n) => { void setPolygonSides(index, n); }} />
        </Row>
      ))}
      {ellipse && <EllipseGeometry key={String(ellipse.args[0]?.value ?? ellipse.kwargs.id?.value)} statement={ellipse} index={ellipseIndex} />}
      <div className={styles.actions}>
        {geometry.length > 0 && <Button size="sm" variant="ghost" icon={<ConstructionIcon />} onClick={toggleConstruction}>Construction</Button>}
        {selection.some((ref) => !FIXED.has(ref)) && <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={deleteSelection}>Delete</Button>}
      </div>
      <Applicable />
    </motion.section>
  );
}

/** Exact geometry values use the same ellipse declaration as Studio; no extra constraint dialect. */
function EllipseGeometry({ statement, index }: { statement: Stmt; index: number }) {
  const units = useSetting('display.units');
  const solving = useSketch(s => s.solving);
  const text = useMemo(() => ([['major_radius', 2], ['minor_radius', 3], ['rotation', 4]] as const).map(([name, at]) => {
    const arg = statement.kwargs[name] ?? statement.args[at];
    const source = arg?.source ?? '0';
    return at !== 4 && units === 'in' && /^-?[\d.]+(e[+-]?\d+)?$/i.test(source.trim())
      ? String(Number(inUnits(Number(arg?.value), units).toPrecision(12))) : source;
  }), [statement, units]);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDraft(text); setError(null); }, [text]);
  const changed = draft.some((v, i) => v.trim() !== text[i].trim());
  const reset = () => { setDraft(text); setError(null); };
  const apply = async () => {
    if (!changed || saving || solving) return;
    setSaving(true);
    try {
      const result = await setEllipseGeometry(index, draft[0], draft[1], draft[2]);
      if (mounted.current) setError(result === true ? null : result);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not change the ellipse.');
    } finally { if (mounted.current) setSaving(false); }
  };
  return <div className={styles.options} id="ellipse-geometry">
    <div className={styles.toolHead}><b>Ellipse geometry</b></div>
    {['Major radius', 'Minor radius', 'Rotation'].map((name, i) => <Row key={name} label={name}>
      <span className={styles.size} data-invalid={error ? true : undefined}>
        <input aria-label={`Ellipse ${name.toLowerCase()}`} aria-invalid={!!error} value={draft[i]} spellCheck={false} disabled={saving || solving}
          onFocus={e => e.target.select()}
          onChange={e => { const value = e.target.value; setDraft(values => values.map((v, n) => n === i ? value : v)); setError(null); }}
          onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); void apply(); } if (e.key === 'Escape') { e.preventDefault(); reset(); } }} />
        <em>{i === 2 ? '°' : units}</em>
      </span>
    </Row>)}
    <p className={styles.empty}>Sets the shape’s current geometry. Existing constraints still apply.</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.actions}>
      <Button size="sm" variant="ghost" disabled={!changed || saving} onClick={reset}>Reset</Button>
      <Button size="sm" disabled={!changed || saving || solving} onClick={() => { void apply(); }} id="ellipse-apply">{saving ? 'Checking…' : 'Apply'}</Button>
    </div>
  </div>;
}

/** Only the constraints this selection can take (all of them are on the ribbon); pointing at one shows the code it adds. */
function Applicable() {
  const selection = useSketch((s) => s.selection);
  const entities = useSketch((s) => s.expansion.entities);
  const [focus, setFocus] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const plans = useMemo(() => Object.fromEntries(CONSTRAINTS.map((c) => [c.kind, planConstraint(c.kind, selection, entities)])) as Record<string, Stmt[] | string>, [selection, entities]);
  useEffect(() => { setFlash(null); setFocus(null); }, [selection]);
  const applicable = CONSTRAINTS.filter((c) => typeof plans[c.kind] !== 'string');
  const plan = focus ? plans[focus] : undefined;
  return (
    <div className={styles.apply} aria-label="Constrain">
      <span className={styles.applyLabel}>Constrain</span>
      {applicable.length === 0 ? <p className={styles.empty}>No constraint applies to this selection.</p> : (
        <div className={styles.constraints}>
          {applicable.map((c) => {
            const Icon = c.icon;
            return (
              <button key={c.kind} type="button" className={styles.constraint} data-constraint={c.kind} aria-disabled={false} title={`${c.label}: ${description(`sketch.c.${c.kind}`) ?? ''}`}
                onPointerEnter={() => setFocus(c.kind)} onPointerLeave={() => setFocus(null)} onFocus={() => setFocus(c.kind)} onBlur={() => setFocus(null)}
                onClick={() => {
                  const planned = plans[c.kind];
                  if (typeof planned === 'string') { setFlash(planned); return; }
                  // Kept only if the solver accepts it (not conflicting or redundant).
                  void addConstraint(planned).then((outcome) => { if (outcome !== true) setFlash(outcome); });
                }}>
                <Icon size={15} strokeWidth={1.6} />
                <span>{c.label}</span>
                {shortcut(`sketch.c.${c.kind}`) && <kbd>{shortcut(`sketch.c.${c.kind}`)}</kbd>}
              </button>
            );
          })}
        </div>
      )}
      {applicable.length > 0 && (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={flash ?? focus ?? 'idle'} className={styles.note} data-state={flash ? 'blocked' : plan ? 'ready' : 'idle'} id="sketch-constraint-note"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            {flash ? <><TriangleAlert size={12} />{flash}</>
              : plan && typeof plan !== 'string' ? <code>{plan.map((s) => emitStatement(s)).join('\n')}</code>
              : 'Point at a constraint to see what it adds.'}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

interface ListItem { index: number; op: string; cid: string; refs: string[]; conflict: boolean; source?: string; value?: number; driven?: boolean }

function ListSection() {
  const statements = useSketch((s) => s.statements);
  const expansion = useSketch((s) => s.expansion);
  const result = useSketch((s) => s.result);
  const selection = useSketch((s) => s.selection);
  const rows = useMemo(() => {
    const bad = new Set([...(result?.conflicting ?? []), ...(result?.redundant ?? [])]);
    const out: ListItem[] = [];
    statements.forEach((s, index) => {
      const owner = expansion.owners[index];
      if (!owner || owner.entities.length || GEOMETRY_OPS.has(s.op) || !owner.constraints.length) return;
      const cid = owner.constraints[0];
      const constraint = expansion.constraints.find((c) => c.id === cid);
      const row: ListItem = { index, op: s.op, cid, refs: constraint?.refs ?? [], conflict: owner.constraints.some((id) => bad.has(id)) };
      if (DIMENSION_OPS.has(s.op)) {
        const arg = s.args[VALUE_AT[s.op]] ?? s.kwargs.value;
        row.driven = (s.kwargs.driving ?? s.args[VALUE_AT[s.op] + 1])?.value === false;
        row.source = arg?.source ?? '';
        row.value = row.driven ? result?.values?.[cid] ?? Number(arg?.value ?? 0) : Number(arg?.value ?? 0);
      }
      out.push(row);
    });
    return out;
  }, [statements, expansion, result]);
  const dimensions = rows.filter((r) => DIMENSION_OPS.has(r.op));
  const constraints = rows.filter((r) => !DIMENSION_OPS.has(r.op));
  return (
    <>
      <section className={styles.section} aria-label="Dimensions">
        <h3 className="caps">Dimensions<span className={styles.count}>{dimensions.length || ''}</span></h3>
        {dimensions.length === 0 ? <p className={styles.empty}>None yet. Use Dimension (D), or type sizes while drawing.</p> : (
          <ul className={styles.list} id="sketch-dimensions">
            <AnimatePresence initial={false}>{dimensions.map((row) => <ListRow key={`${row.cid}:${row.index}`} row={row} selected={selection.includes(row.cid)} />)}</AnimatePresence>
          </ul>
        )}
      </section>
      <section className={styles.section} aria-label="Constraints">
        <h3 className="caps">Constraints<span className={styles.count}>{constraints.length || ''}</span></h3>
        {constraints.length === 0 ? <p className={styles.empty}>None yet. Snaps add some while you draw.</p> : (
          <ul className={styles.list} id="sketch-constraints">
            <AnimatePresence initial={false}>{constraints.map((row) => <ListRow key={`${row.cid}:${row.index}`} row={row} selected={selection.includes(row.cid)} />)}</AnimatePresence>
          </ul>
        )}
      </section>
    </>
  );
}

function ListRow({ row, selected }: { row: ListItem; selected: boolean }) {
  const meta = OPS[row.op] ?? { label: row.op, icon: DimensionIcon };
  const Icon = meta.icon;
  const select = (additive: boolean) => useSketch.setState((state) => ({ selection: additive ? [...state.selection.filter((r) => r !== row.cid), row.cid] : [row.cid] }));
  return (
    <motion.li layout className={styles.row} data-statement={row.index} data-op={row.op} data-selected={selected || undefined} data-conflict={row.conflict || undefined}
      initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 6, transition: { duration: 0.1 } }} transition={spring}
      onPointerEnter={() => useSketch.setState({ highlight: row.refs })} onPointerLeave={() => useSketch.setState({ highlight: [] })}
      onClick={(event) => select(event.shiftKey || event.ctrlKey || event.metaKey)}>
      <span className={styles.rowIcon}>{row.conflict ? <TriangleAlert size={13} /> : <Icon size={14} strokeWidth={1.6} />}</span>
      <span className={styles.rowText}><b>{meta.label}</b><small title={row.refs.join(', ')}>{row.refs.join(' · ')}</small></span>
      {row.source !== undefined && <DimensionValue index={row.index} op={row.op} source={row.source} value={row.value ?? 0} driven={!!row.driven} />}
      <IconButton small label={`Delete ${meta.label.toLowerCase()}`} className={styles.rowDelete} onClick={(event) => { event.stopPropagation(); void removeStatement(row.index); }}><Trash2 /></IconButton>
    </motion.li>
  );
}

function DimensionValue({ index, op, source, value, driven }: { index: number; op: string; source: string; value: number; driven: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const units = useSetting('display.units');
  const plain = /^-?[\d.]+(e-?\d+)?$/i.test(source.trim());
  const length = op !== 'angle';
  const unit = length ? units : '°';
  // A length reads in the units the status bar shows (the code keeps mm); a parameter expression keeps its own text.
  const readout = (mm: number) => Number((length ? inUnits(mm, units) : mm).toFixed(length ? lengthDigits(units, 3) : 3));
  const text = plain && length && units === 'in' ? String(readout(Number(source))) : source;
  // Leaving the field applies it (Enter leaves it, handing the keyboard back to the sketch); Esc leaves it unchanged.
  // Its text is selected a frame after focus, only if it still has focus: select() focuses an input in Chrome, so a field
  // left with Enter before that frame (a slow frame under load) would take the keyboard back.
  const commit = async (typed: string) => {
    if (cancelled.current || typed.trim() === text.trim()) { cancelled.current = false; setDraft(null); setError(null); return; }
    const outcome = await setDimension(index, typed);
    if (outcome === true) { setDraft(null); setError(null); } else setError(outcome);
  };
  // Dragging a plain number sideways changes it; it's applied once, on release (Esc puts it back).
  const scrub = useScrub({ text: draft ?? text, disabled: driven, positive: op !== 'angle', onScrub: (next) => { setDraft(next); setError(null); },
    onCommit: (next) => { void commit(next); }, onCancel: () => setDraft(null) });
  if (driven) return <span className={styles.value} data-driven title="Reference dimension (measured)"><span>({readout(value)})</span><em>{unit}</em></span>;
  return (
    <span className={styles.value} data-invalid={error ? true : undefined}
      title={error ?? (plain ? `Type a number${length ? `, a length like ${units === 'in' ? '10mm' : '1in'},` : ''} or a parameter expression${scrub.scrubbable ? ', or drag sideways to change it' : ''}` : `${source} = ${Number((length ? inUnits(value, units) : value).toFixed(4))}`)}
      onClick={(event) => event.stopPropagation()}>
      <input {...scrub.props} value={draft ?? text} spellCheck={false} data-dimension-input={index} aria-label={`${OPS[op]?.label ?? op} value`} aria-invalid={!!error}
        onFocus={(event) => { setDraft(draft ?? text); const input = event.target; requestAnimationFrame(() => { if (document.activeElement === input) input.select(); }); }}
        onChange={(event) => { setDraft(event.target.value); setError(null); }}
        onBlur={(event) => { void commit(event.target.value); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); }
          if (event.key === 'Escape') { cancelled.current = true; (event.target as HTMLInputElement).blur(); }
        }} />
      {!plain && draft === null && <small>= {readout(value)}</small>}
      <em>{unit}</em>
    </span>
  );
}

/** What OK does for the active sketch tool, for its tooltip. */
const toolOkTitle = (tool: ToolId) => constraintOf(tool) ? `Stop adding ${CONSTRAINT_LABELS[constraintOf(tool)!].toLowerCase()} constraints`
  : tool === 'spline' ? 'Make the spline from the points placed'
  : tool === 'line' ? 'End the line chain'
  : tool === 'dimension' ? 'Stop dimensioning'
  : tool === 'project' ? 'Stop projecting'
  : tool === 'trim' ? 'Stop trimming'
  : 'Place a shape sized in the fields, if any';

/** What to do next (the active tool's prompt, or how selecting works), the solve status, and the active tool's OK/Cancel. */
function StatusFooter() {
  const result = useSketch((s) => s.result);
  const solving = useSketch((s) => s.solving);
  const errors = useSketch((s) => s.expansion.errors);
  const tool = useSketch((s) => s.tool);
  const message = useSketch((s) => s.message);
  const constraintKind = constraintOf(tool);
  const selected = useSketch((s) => s.selection);
  const next = message ?? (tool === 'select' ? SELECT_HINT : constraintKind ? constraintPrompt(constraintKind, selected) : TOOL_HINTS[tool]) ?? null;
  const verdict = solveStatus(result, solving);
  const bad = [...(result?.conflicting ?? []), ...(result?.redundant ?? [])];
  const detail = verdict.tone === 'conflict'
    ? 'Remove or change a highlighted constraint.'
    : result?.status === 'ok' && result.dof === 0 ? 'Every curve is pinned down by dimensions and constraints.'
    : result?.status === 'ok' && result.dof ? 'Blue geometry can still move. Add dimensions or constraints to pin it.' : '';
  return (
    <div className={styles.footer}>
      <AnimatePresence mode="wait" initial={false}>
        {next && (
          <motion.p key={next} className={styles.next} id="sketch-hint" initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            <Info size={13} />{next}
          </motion.p>
        )}
      </AnimatePresence>
      <div className={styles.status} data-tone={verdict.tone} id="sketch-solve">
        <i />
        <span><b>{verdict.text}</b>{detail && <small>{detail}</small>}</span>
        {bad.length > 0 && <button type="button" className={styles.link} onClick={() => useSketch.setState({ selection: bad })}>Select</button>}
      </div>
      {errors.length > 0 && <p className={styles.error}><TriangleAlert size={12} />{errors[0].message}</p>}
      {/* The active tool's OK/Cancel (none while selecting). Enter/Esc are the sketch's own (App → tools.enter/escape). */}
      {tool !== 'select' && <ToolFooter inline keys={false} hintKeys onOk={() => { void okTool(); }} onCancel={cancelTool} okId="sketch-tool-ok" cancelId="sketch-tool-cancel"
        okTitle={toolOkTitle(tool)} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <span className={styles.control}>{children}</span>
    </div>
  );
}

function Stepper({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const set = (next: number) => { if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, Math.round(next)))); };
  // Dragging sideways steps it by whole numbers; the count is set once, on release.
  const scrub = useScrub({ text: draft ?? String(value), integer: true, min, max, onScrub: setDraft, onCommit: (text) => { setDraft(null); set(Number(text)); }, onCancel: () => setDraft(null) });
  return (
    <span className={styles.stepper}>
      <button type="button" aria-label={`Fewer (${label})`} disabled={value <= min} onClick={() => set(value - 1)}><Minus size={12} /></button>
      <input {...scrub.props} value={draft ?? String(value)} aria-label={label} inputMode="numeric" title="Type a number, or drag sideways to change it"
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => { setDraft(null); set(Number(event.target.value)); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') { setDraft(null); set(Number((event.target as HTMLInputElement).value)); (event.target as HTMLInputElement).blur(); }
          if (event.key === 'Escape') { setDraft(null); (event.target as HTMLInputElement).blur(); }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setDraft(null); set(value + (event.key === 'ArrowUp' ? 1 : -1)); }
        }} />
      <button type="button" aria-label={`More (${label})`} disabled={value >= max} onClick={() => set(value + 1)}><Plus size={12} /></button>
    </span>
  );
}

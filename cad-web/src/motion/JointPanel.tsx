/**
 * The Joint tool's options, in the right-hand panel like every tool: type, parent and child
 * (pick them or choose), the axis (pick a face or edge, or a datum axis), limits and a drive.
 */
import { useEffect, useRef } from 'react';
import { Crosshair } from 'lucide-react';
import { NumberField, Segmented, Select, Switch } from '@/ui';
import { JointIcon } from '@/icons/cad';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import styles from '@/viewport/Viewport.module.css';
import { defaultDriveSpeed, effectivePose, turns, type JointType } from './kinematics';
import { setJoint, useMotion } from './state';
import { JOINT_ICONS, JOINT_LABELS } from './MotionPanel';
import { DATUM_AXES, closeJointTool, commitJoint, designInstances, draftProblem, setJointType, useJointTool, type Slot } from './jointTool';
import motionStyles from './Motion.module.css';

const TYPES: JointType[] = ['revolute', 'slider', 'cylindrical', 'rigid'];
const HINT: Record<JointType, string> = {
  revolute: 'Turns about the axis, like a hinge or a wheel.',
  slider: 'Slides along the axis, like a drawer or a piston.',
  cylindrical: 'Turns about and slides along the axis, like a shaft in a bushing.',
  rigid: 'Fastens the child to the parent: it moves with it.',
};

function PickSlot({ slot, label, children }: { slot: Slot; label: string; children: React.ReactNode }) {
  const active = useJointTool((state) => state.slot === slot);
  return (
    <div className={styles.panelRow} data-slot={slot} data-picking={active || undefined}>
      <span className={styles.panelLabel}>{label}</span>
      <div className={motionStyles.slot}>
        {children}
        <button type="button" className={motionStyles.pickButton} data-active={active || undefined} aria-pressed={active}
          title={active ? 'Click in the viewport' : `Pick the ${label.toLowerCase()} in the viewport`} aria-label={`Pick ${label.toLowerCase()}`}
          onClick={() => useJointTool.setState({ slot: active ? null : slot, error: null })}>
          <Crosshair size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * While a limit field of an existing joint has focus, the part shows at that limit (and follows the typed
 * value); leaving the field puts it back where it was.
 */
let held: { own: ReturnType<typeof useMotion.getState>['own']; coupled: Record<string, number> } | null = null;

function previewLimit(which: 'limits' | 'slideLimits', end: 0 | 1 | null, value?: number) {
  if (end === null) {
    if (held) { useMotion.setState({ own: held.own, coupled: held.coupled }); resetTo(held); held = null; }
    return;
  }
  const draft = useJointTool.getState();
  const joint = draft.editing ? useMotion.getState().kinematics?.joints.find((item) => item.name === draft.editing) : undefined;
  if (!joint) return;
  if (!held) held = { own: useMotion.getState().own, coupled: useMotion.getState().coupled };
  const limits = draft[which];
  const target = value ?? limits?.[end];
  if (target === undefined) return;
  // Preview past the build's limits too: the draft's are the ones being set.
  const wide = { ...joint, limits: null, slide_limits: null };
  const kinematics = useMotion.getState().kinematics!;
  useMotion.setState({ kinematics: { ...kinematics, joints: kinematics.joints.map((item) => (item.name === joint.name ? wide : item)) } });
  setJoint(joint.name, which === 'limits' ? { value: target } : { slide: target });
  useMotion.setState({ kinematics });
}

function resetTo(saved: NonNullable<typeof held>) {
  const { kinematics } = useMotion.getState();
  if (!kinematics) return;
  useMotion.setState({ own: saved.own, coupled: saved.coupled, pose: effectivePose(kinematics, saved.own, saved.coupled) });
}

function Limits({ which, unit }: { which: 'limits' | 'slideLimits'; unit: string }) {
  const limits = useJointTool((state) => state[which]);
  const focused = useRef<0 | 1 | null>(null);
  useEffect(() => () => previewLimit(which, null), [which]);
  const label = which === 'limits' ? 'Limits' : 'Travel limits';
  const fallback: [number, number] = unit === '°' ? [-90, 90] : [0, 50];
  const endOf = (target: EventTarget) => ((target as HTMLElement).getAttribute?.('aria-label')?.endsWith(' max') ? 1 : 0);
  return (
    <>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>{label}</span>
        <Switch label={label} checked={!!limits} onCheckedChange={(on) => useJointTool.setState({ [which]: on ? fallback : null })} />
      </div>
      {limits && (
        <div className={styles.panelRow}>
          <span className={styles.panelLabel} />
          <div className={motionStyles.limitFields}
            onFocusCapture={(event) => { focused.current = endOf(event.target); previewLimit(which, focused.current); }}
            onBlurCapture={() => { focused.current = null; previewLimit(which, null); }}>
            {/* NumberField can commit on blur, after the captured blur restored the pose.
                Keep that value in the draft without starting a fresh preview. */}
            <NumberField value={limits[0]} unit={unit} ariaLabel={`${label} min`} onChange={(value) => { useJointTool.setState({ [which]: [value, limits[1]] }); if (focused.current === 0) previewLimit(which, 0, value); }} />
            <NumberField value={limits[1]} unit={unit} ariaLabel={`${label} max`} onChange={(value) => { useJointTool.setState({ [which]: [limits[0], value] }); if (focused.current === 1) previewLimit(which, 1, value); }} />
          </div>
        </div>
      )}
    </>
  );
}

export default function JointPanel() {
  const draft = useJointTool();
  const instances = designInstances();
  const options = instances.map((item) => ({ value: item.name, label: item.name, hint: item.link ? 'linked' : item.component }));
  const problem = draft.error ?? (draft.slot ? null : draftProblem(draft));
  const unit = turns(draft) ? '°' : 'mm';
  const axisOptions = [
    ...(draft.axis && !DATUM_AXES.some((axis) => axis.source === draft.axis!.source) ? [{ value: draft.axis.source, label: draft.axis.label }] : []),
    ...DATUM_AXES.map((axis) => ({ value: axis.source, label: axis.label })),
  ];
  return (
    <Panel id="joint" icon={<JointIcon size={16} />} title={draft.editing ? `Edit ${draft.editing}` : 'Joint'} onClose={closeJointTool}
      footer={<ToolFooter onCancel={closeJointTool} onOk={() => { void commitJoint(); }} okId="joint-ok" okTitle={draft.editing ? `Update ${draft.editing}` : 'Add the joint'}
        okDisabled={draftProblem(draft)} />}>
      <Segmented value={draft.type} onChange={setJointType} options={TYPES.map((type) => {
        const Icon = JOINT_ICONS[type];
        return { value: type, title: JOINT_LABELS[type], label: <span className={motionStyles.typeOption} data-joint-type={type}><Icon size={13} />{JOINT_LABELS[type]}</span> };
      })} />
      <div className={styles.panelHint}>{HINT[draft.type]}</div>
      <div className={styles.panelRow}>
        <span className={styles.panelLabel}>Name</span>
        <input className={motionStyles.nameInput} aria-label="Joint name" value={draft.name} spellCheck={false}
          onChange={(event) => useJointTool.setState({ name: event.target.value.trim(), error: null })} />
      </div>
      <PickSlot slot="parent" label="Parent">
        <Select ariaLabel="Parent" value={draft.parent} onChange={(parent) => useJointTool.setState({ parent, slot: draft.slot === 'parent' ? null : draft.slot, error: null })} options={options} />
      </PickSlot>
      <PickSlot slot="child" label="Child">
        <Select ariaLabel="Child" value={draft.child} onChange={(child) => useJointTool.setState({ child, slot: draft.slot === 'child' ? null : draft.slot, error: null })} options={options} />
      </PickSlot>
      {draft.type !== 'rigid' && (
        <PickSlot slot="axis" label="Axis">
          <Select ariaLabel="Axis" value={draft.axis?.source ?? ''} options={draft.axis ? axisOptions : [{ value: '', label: 'Pick a face or edge…' }, ...axisOptions]}
            onChange={(source) => useJointTool.setState({ axis: [...DATUM_AXES, ...(draft.axis ? [draft.axis] : [])].find((axis) => axis.source === source) ?? null, slot: source ? null : 'axis', error: null })} />
        </PickSlot>
      )}
      {draft.type !== 'rigid' && <Limits which="limits" unit={unit} />}
      {draft.type === 'cylindrical' && <Limits which="slideLimits" unit="mm" />}
      {draft.type !== 'rigid' && (
        <>
          <div className={styles.panelRow}>
            <span className={styles.panelLabel}>Drive</span>
            <Switch label="Drive" checked={!!draft.drive} onCheckedChange={(on) => useJointTool.setState({ drive: on ? { speed: defaultDriveSpeed(draft) } : null })} />
          </div>
          {draft.drive && (
            <div className={styles.panelRow}>
              <span className={styles.panelLabel}>Speed</span>
              <div style={{ width: 118 }}><NumberField value={draft.drive.speed ?? defaultDriveSpeed(draft)} unit={`${unit}/s`} ariaLabel="Drive speed" onChange={(speed) => useJointTool.setState({ drive: { ...draft.drive!, speed } })} /></div>
            </div>
          )}
          {draft.drive && (
            <div className={styles.panelRow} title="Sweeps the range at each build with exact solids and reports what collides, and where.">
              <span className={styles.panelLabel}>Check collisions</span>
              <Switch label="Check collisions" checked={!!draft.drive.check} onCheckedChange={(check) => useJointTool.setState({ drive: { ...draft.drive!, check } })} />
            </div>
          )}
        </>
      )}
      <div className={styles.panelHint} data-tone={problem ? 'warning' : undefined} data-joint-hint>
        {draft.slot === 'axis' ? 'Click a pin, a bore, a flat face or an edge for the axis.'
          : draft.slot === 'parent' ? 'Click the instance that stays put (the parent).'
            : draft.slot === 'child' ? 'Click the instance that moves (the child).'
              : problem ?? `Writes design.${draft.type}("${draft.name}", …) into main.py.`}
      </div>
    </Panel>
  );
}

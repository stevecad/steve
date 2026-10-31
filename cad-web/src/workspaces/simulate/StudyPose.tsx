/**
 * The pose a study of a moving design is simulated in (docs/MOTION.md): as modelled (every joint at 0, the
 * geometry as written), a pose the design names (`design.pose`), or the mechanism as it stands in the viewer
 * now. Writes the study's `design.pose`; the CAD kernel checks names and joint limits when it prepares the
 * geometry, and the run reports which pose it solved (`pose_note`).
 */
import { useMemo } from 'react';
import { Move3d } from 'lucide-react';
import { Button, Section } from '@/ui';
import { useApp } from '@/state/store';
import { couplingUnit, initialCoupled, initialPose, kinematicsOf, type Kinematics, type Pose } from '@/motion/kinematics';
import { useMotion } from '@/motion/state';
import styles from '@/panels/Panels.module.css';
import sim from './Simulate.module.css';

/** A study's `design.pose`: null (as modelled), a pose name, or joint/coupling values from the code's pose. */
export type StudyPoseValue = string | Record<string, number> | null;

const AS_MODELLED = '__as_modelled__';
const CHOSEN = '__chosen__';
const CURRENT = '__current__';

function unitOf(kinematics: Kinematics, key: string): string {
  const [name, part] = key.split('.');
  const joint = kinematics.joints.find((item) => item.name === name);
  if (joint) return part === 'travel' || joint.type === 'slider' ? ' mm' : '°';
  const coupling = kinematics.couplings?.find((item) => item.name === name);
  const unit = coupling ? couplingUnit(kinematics, coupling) : '';
  return unit === 'mm' ? ' mm' : unit;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** "hinge 35°, lift 20 mm": the values that move something, in the order the design declares its joints. */
export function poseValuesText(values: Record<string, number>, kinematics: Kinematics | null): string {
  const order = kinematics ? [...kinematics.joints.map((joint) => joint.name), ...(kinematics.couplings ?? []).map((coupling) => coupling.name)] : [];
  const keys = Object.keys(values).sort((a, b) => (order.indexOf(a.split('.')[0]) - order.indexOf(b.split('.')[0])) || a.localeCompare(b));
  const moved = keys.filter((key) => Math.abs(values[key]) > 1e-9);
  return moved.length ? moved.map((key) => `${key} ${round(values[key])}${kinematics ? unitOf(kinematics, key) : ''}`).join(', ') : 'every joint at 0';
}

/** The mechanism as the viewer shows it: every joint's own position (and a cylindrical joint's travel) and every
 * coupling's value, which the kernel applies from the code's pose exactly as the viewer does. */
export function currentPoseValues(kinematics: Kinematics, own: Pose, coupled: Record<string, number>): Record<string, number> {
  const start = initialPose(kinematics), couplings = initialCoupled(kinematics), out: Record<string, number> = {};
  for (const joint of kinematics.joints) {
    if (joint.type === 'rigid') continue;
    const state = own[joint.name] ?? start[joint.name];
    out[joint.name] = round(state.value);
    if (joint.type === 'cylindrical') out[`${joint.name}.travel`] = round(state.slide);
  }
  for (const [name, value] of Object.entries(couplings)) out[name] = round(coupled[name] ?? value);
  return out;
}

export default function StudyPose({ pose, onChange, editable }: { pose: StudyPoseValue | undefined; onChange: (next: StudyPoseValue) => void; editable: boolean }) {
  const displayed = useApp((state) => state.displayed);
  const kinematics = useMemo(() => kinematicsOf(displayed?.metadata), [displayed]);
  const motion = useMotion();
  if (!kinematics) return null;
  // Live slider values only when the motion store shows this build; otherwise the code's pose.
  const live = motion.kinematics === kinematics || motion.build === displayed?.id;
  const current = currentPoseValues(kinematics, live ? motion.own : {}, live ? motion.coupled : {});
  const named = Object.keys(kinematics.poses ?? {});
  const values = typeof pose === 'object' && pose !== null ? pose : null;
  const sameAsCurrent = !!values && JSON.stringify(values) === JSON.stringify(current);
  const selected = pose == null || pose === 'as_modelled' ? AS_MODELLED : values ? (sameAsCurrent ? CURRENT : CHOSEN) : (pose as string);
  const unknown = typeof pose === 'string' && pose !== 'as_modelled' && !named.includes(pose);
  const choose = (option: string) => onChange(option === AS_MODELLED ? null : option === CURRENT ? current : option === CHOSEN ? (values ?? current) : option);
  const describe = selected === AS_MODELLED ? 'Every joint at 0: the geometry as the code writes it, whatever the viewer shows.'
    : values ? `Joint values: ${poseValuesText(values, kinematics)}.`
      : `Pose “${pose}”: ${poseValuesText(kinematics.poses?.[pose as string] ?? {}, kinematics)}.`;
  const label = selected === AS_MODELLED ? 'As modelled' : values ? (sameAsCurrent ? 'Current view' : 'Chosen values') : `Pose “${pose}”`;
  const moving = Object.values(current).some((value) => Math.abs(value) > 1e-9);
  return <Section title="Pose"><div className={styles.stack} id="study-pose" data-pose={selected === AS_MODELLED ? 'as_modelled' : values ? 'values' : String(pose)}>
    {editable ? <label className={sim.row}>Simulate at <select aria-label="Simulated pose" value={selected} onChange={(event) => choose(event.target.value)}>
      <option value={AS_MODELLED}>As modelled</option>
      {named.map((name) => <option key={name} value={name}>Pose “{name}”</option>)}
      {unknown && <option value={pose as string}>Pose “{pose as string}” (missing)</option>}
      {values && !sameAsCurrent && <option value={CHOSEN}>Chosen values</option>}
      <option value={CURRENT}>Current view</option>
    </select></label> : <span>{label}</span>}
    <small className={styles.muted}>{describe}</small>
    {editable && values && !sameAsCurrent && <Button size="sm" icon={<Move3d />} onClick={() => onChange(current)}>Use the current view ({poseValuesText(current, kinematics)})</Button>}
    {unknown && <p className={sim.warn}>This design has no pose named “{pose as string}” any more. Choose another pose.</p>}
    {selected === AS_MODELLED && moving && <small className={styles.muted}>The viewer shows {poseValuesText(current, kinematics)}; choose Current view to simulate that.</small>}
  </div></Section>;
}

/** The run's own account of the pose it solved (GET /v1/simulation/runs/{id} → pose_note). */
export function PoseNote({ note }: { note?: string | null }) {
  if (!note) return null;
  return <small className={styles.muted} data-pose-note>{note}</small>;
}

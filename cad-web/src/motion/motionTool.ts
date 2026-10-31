/**
 * The Motion tab's tools other than joints, in one right-hand panel: Gears & links (gear mesh, rack and
 * pinion, belt, any coupling), Motor (a drive), Pose and Animation. Each writes the same Python STEVE writes
 * (`design.couple`, `design.drive`, `design.pose`, `design.animation`) into main.py and rebuilds.
 */
import { create } from 'zustand';
import { get, set, toast, type Pick as ViewPick } from '@/state/store';
import { updateModel } from '@/state/actions';
import { num } from '@/lib/format';
import {
  animationNamesInCode, freeName, poseNames, removeAnimation, removeDrive, removePose, setJointsFollow, writeAnimation, writeCoupling, writeDrive, writePose,
  driveCall, jointNameProblem, type AnimationSpec,
} from './code';
import { defaultDriveSpeed, dofKey, gearsOf, jointOfInstance, turns, type Kinematics, type MotionCoupling } from './kinematics';
import { instanceOfNode } from './jointTool';
import { selectClip, selectJoint, useMotion } from './state';

export type MotionMode = 'gear' | 'rack' | 'belt' | 'couple' | 'motor' | 'pose' | 'animation';
export type LinkMode = 'gear' | 'rack' | 'belt' | 'couple';
export interface GearRow { key: string; ratio: number }
export interface KeyRow { pose: string | Record<string, number>; time: number }

export interface MotionTool {
  mode: MotionMode;
  /** The coupling, drive target, pose or animation being edited (null: a new one). */
  editing: string | null;
  name: string;
  /** Gears & links: the driving and driven joints, and which one a viewport click fills. */
  driver: string;
  driven: string;
  slot: 'driver' | 'driven' | null;
  teeth: [number, number];
  internal: boolean;
  byRatio: boolean;
  ratio: number;
  pitchRadius: number;
  diameters: [number, number];
  reverse: boolean;
  /** A coupling the new link joins (a gear train), or null for a coupling of its own. */
  extend: string | null;
  rows: GearRow[];
  /** Custom coupling: its joints only follow couplings (`follow=True`), never set on their own; `followWas` as opened. */
  follow: boolean;
  followWas: boolean;
  /** Motor. */
  target: string;
  speed: number;
  direction: 1 | -1;
  continuous: boolean;
  range: [number, number];
  check: boolean;
  /** Pose: the values to save, and which of them. */
  values: Record<string, number>;
  include: Record<string, boolean>;
  /** Animation. */
  keys: KeyRow[];
  loop: boolean;
  easing: 'linear' | 'ease';
  error: string | null;
}

const BLANK: MotionTool = {
  mode: 'gear', editing: null, name: '', driver: '', driven: '', slot: null, teeth: [20, 40], internal: false, byRatio: false, ratio: -0.5,
  pitchRadius: 10, diameters: [30, 60], reverse: false, extend: null, rows: [], follow: false, followWas: false, target: '', speed: 90, direction: 1, continuous: true,
  range: [0, 90], check: false, values: {}, include: {}, keys: [], loop: true, easing: 'ease', error: null,
};

export const useMotionTool = create<MotionTool>(() => BLANK);
const tool = useMotionTool.getState;
const patch = (next: Partial<MotionTool>) => useMotionTool.setState({ error: null, ...next });
export const updateTool = patch;

/** The build's kinematics with the code's own limits (not the selected mode's): what the tools write from. */
const kinematicsNow = () => useMotion.getState().built ?? useMotion.getState().kinematics;
const movable = (kinematics: Kinematics | null) => (kinematics?.joints ?? []).filter((joint) => joint.type !== 'rigid');
const jointOf = (kinematics: Kinematics | null, name: string) => kinematics?.joints.find((joint) => joint.name === name);

export { jointOfInstance };

const LINK_NAMES: Record<LinkMode, string> = { gear: 'mesh', rack: 'rack', belt: 'belt', couple: 'coupling' };

export function openMotionTool(mode: MotionMode, editing?: string) {
  const state = get();
  if (state.doc.kind !== 'design') { toast('warning', 'Motion belongs to designs', 'Open or create a design, place components and connect them with joints.'); return; }
  const kinematics = kinematicsNow();
  const joints = movable(kinematics);
  const active = useMotion.getState().active;
  const base: MotionTool = { ...BLANK, mode, editing: editing ?? null };
  if (mode === 'gear' || mode === 'rack' || mode === 'belt' || mode === 'couple') {
    if (!editing && joints.length < (mode === 'couple' ? 1 : 2)) {
      toast('warning', 'Add joints first', mode === 'couple' ? 'A coupling gears joints: add a revolute or slider joint.' : 'Gears and links connect two moving joints: add them with Revolute or Slider.');
      return;
    }
    const coupling = editing ? kinematics?.couplings?.find((item) => item.name === editing) : undefined;
    if (coupling) {
      const follow = Object.keys(coupling.gears).every((key) => !!jointOf(kinematics, key.split('.')[0])?.follows);
      Object.assign(base, { mode: 'couple', name: coupling.name, rows: Object.entries(coupling.gears).map(([key, ratio]) => ({ key, ratio })), follow, followWas: follow });
    } else {
      // Start from what is selected: a joint in Properties, or two picked parts.
      const picked = state.selection.map((pick) => instanceOfNode(pick.node)).filter((name): name is string => !!name)
        .map((instance) => jointOfInstance(kinematics, instance)?.name).filter((name): name is string => !!name);
      const turning = joints.filter((joint) => turns(joint));
      const sliding = joints.filter((joint) => joint.type === 'slider' || joint.type === 'cylindrical');
      const first = picked[0] ?? (active && jointOf(kinematics, active) ? active : undefined);
      const driver = mode === 'rack' ? (turning.find((j) => j.name === first) ?? turning[0])?.name ?? '' : first ?? turning[0]?.name ?? joints[0]?.name ?? '';
      const pool = mode === 'rack' ? sliding : turning.length > 1 ? turning : joints;
      const driven = picked.find((name) => name !== driver) ?? pool.find((joint) => joint.name !== driver)?.name ?? '';
      Object.assign(base, { name: freeName('couple', LINK_NAMES[mode]), driver, driven, slot: mode === 'couple' || picked.length >= 2 ? null : 'driver',
        rows: mode === 'couple' ? [{ key: keyFor(kinematics, driver, 'turn'), ratio: 1 }, ...(driven ? [{ key: keyFor(kinematics, driven, 'turn'), ratio: -1 }] : [])] : [] });
      base.extend = trainFor(kinematics, base);
    }
  } else if (mode === 'motor') {
    // A follower is moved by its couplings, never driven itself.
    const target = editing ?? (active && !jointOf(kinematics, active)?.follows ? active : null) ?? kinematics?.couplings?.[0]?.name
      ?? joints.find((joint) => !joint.follows)?.name ?? '';
    if (!target) { toast('warning', 'Add a joint first', 'A motor drives a revolute or slider joint, or a coupling.'); return; }
    Object.assign(base, motorDefaults(kinematics, target));
  } else if (mode === 'pose') {
    const values = currentValues(kinematics);
    const posed = editing ? kinematics?.poses[editing] : undefined;
    Object.assign(base, { name: editing ?? freeName('pose', 'pose'), values: posed ? { ...values, ...posed } : values,
      include: Object.fromEntries(Object.keys(values).map((key) => [key, posed ? key in posed : true])) });
  } else if (mode === 'animation') {
    const poses = poseNames();
    const animation = editing ? kinematics?.animations?.find((item) => item.name === editing) : undefined;
    if (!animation && poses.length < 2) { toast('warning', 'Save two poses first', 'An animation moves between poses: set the mechanism and save a pose (Motion → Pose), then another.'); return; }
    Object.assign(base, animation
      ? { name: animation.name, loop: animation.loop, easing: animation.easing, check: !!animation.check,
        keys: animation.keys.map((key) => ({ pose: key.pose ?? key.values, time: key.time })) }
      : { name: freeName('animation', 'animation'), loop: true, easing: 'ease', check: false,
        keys: [{ pose: poses[0], time: 0 }, { pose: poses[1], time: 2 }, { pose: poses[0], time: 4 }] });
  }
  useMotionTool.setState(base);
  set({ tool: 'motion' });  // Its options open in the Dock (shell/toolDock.ts).
}

export function closeMotionTool() {
  if (get().tool === 'motion') set({ tool: 'select' });
  useMotionTool.setState({ slot: null });
}

/* ───────── Picking ───────── */

export function motionToolPicking(): 'component' | 'geometry' | null {
  return tool().slot ? 'component' : null;
}

/** A click on a part fills the active slot with the joint that moves it. */
export function motionToolPick(pick: ViewPick | null): boolean {
  const draft = tool();
  if (!draft.slot || !pick) return false;
  const instance = instanceOfNode(pick.node);
  const joint = instance ? jointOfInstance(kinematicsNow(), instance) : undefined;
  if (!joint) { patch({ error: 'That part doesn’t move: pick a part on a revolute or slider joint.' }); return true; }
  const next = { ...draft, [draft.slot]: joint.name };
  useMotionTool.setState({ [draft.slot]: joint.name, slot: draft.slot === 'driver' && !next.driven ? 'driven' : null, error: null,
    extend: trainFor(kinematicsNow(), next) });
  set({ selection: [{ kind: 'component', node: pick.node }] });
  return true;
}

/* ───────── Gears & links ───────── */

/** The driven joint's ratio to the driver: gears by teeth (external meshes turn opposite ways), racks by pitch radius, belts by diameters. */
export function linkRatio(draft: MotionTool): number | null {
  if (draft.mode === 'gear') {
    if (draft.byRatio) return Number.isFinite(draft.ratio) && draft.ratio !== 0 ? draft.ratio : null;
    const [a, b] = draft.teeth;
    if (!(a > 0 && b > 0)) return null;
    return (draft.internal ? 1 : -1) * (a / b);
  }
  if (draft.mode === 'rack') return draft.pitchRadius > 0 ? (draft.reverse ? -1 : 1) * (Math.PI * draft.pitchRadius) / 180 : null;
  if (draft.mode === 'belt') {
    const [a, b] = draft.diameters;
    return a > 0 && b > 0 ? (draft.reverse ? -1 : 1) * (a / b) : null;
  }
  return null;
}

const keyFor = (kinematics: Kinematics | null, name: string, part: 'turn' | 'travel') => {
  const joint = jointOf(kinematics, name);
  return joint ? dofKey(joint, part) : name;
};
const drivenPart = (mode: MotionMode): 'turn' | 'travel' => (mode === 'rack' ? 'travel' : 'turn');

/** The coupling a new link should join: one that already gears exactly one of its two joints (a gear train). */
export function trainFor(kinematics: Kinematics | null, draft: Pick2): string | null {
  if (!kinematics || draft.mode === 'couple' || !draft.driver || !draft.driven) return null;
  const a = jointOf(kinematics, draft.driver), b = jointOf(kinematics, draft.driven);
  if (!a || !b) return null;
  const onA = gearsOf(kinematics, a, 'turn'), onB = gearsOf(kinematics, b, drivenPart(draft.mode));
  if (onA.length === 1 && !onB.some((g) => g.coupling.name === onA[0].coupling.name)) return onA[0].coupling.name;
  if (onB.length === 1 && !onA.length) return onB[0].coupling.name;
  return null;
}
type Pick2 = Pick<MotionTool, 'mode' | 'driver' | 'driven'>;

/** What the link writes: a new coupling, or an existing one with the new joint added at the right ratio. */
export function linkPlan(draft: MotionTool, kinematics: Kinematics | null): { name: string; gears: Record<string, number>; comment?: string; replacing?: string; summary: string } | string {
  if (draft.mode === 'couple') {
    if (!/^[a-z][a-z0-9_]*$/.test(draft.name)) return 'Coupling names are lowercase letters, digits and underscores, starting with a letter.';
    const nameProblem = jointNameProblem(draft.name, draft.editing);
    if (nameProblem) return nameProblem;
    const rows = draft.rows.filter((row) => row.key);
    if (!rows.length) return 'Add a joint to the coupling.';
    if (new Set(rows.map((row) => row.key)).size !== rows.length) return 'Each joint appears once in a coupling.';
    if (rows.some((row) => !Number.isFinite(row.ratio) || row.ratio === 0)) return 'Ratios are nonzero numbers.';
    return { name: draft.name, gears: Object.fromEntries(rows.map((row) => [row.key, row.ratio])), replacing: draft.editing ?? undefined,
      summary: rows.map((row) => `${row.key} ×${num(row.ratio, 4)}`).join(' · ') };
  }
  const a = jointOf(kinematics, draft.driver), b = jointOf(kinematics, draft.driven);
  if (!a || !b) return 'Pick the driving and the driven joints (click their parts, or choose them).';
  if (a.name === b.name) return 'The driving and driven joints must differ.';
  if (!turns(a)) return `${a.name} slides; the driving joint of a ${draft.mode === 'rack' ? 'pinion' : draft.mode} turns (revolute or cylindrical).`;
  if (draft.mode === 'rack' ? !(b.type === 'slider' || b.type === 'cylindrical') : !turns(b)) {
    return draft.mode === 'rack' ? `${b.name} doesn’t slide; a rack is a slider (or cylindrical) joint.` : `${b.name} slides; it needs a turning joint.`;
  }
  const ratio = linkRatio(draft);
  if (ratio === null) return draft.mode === 'gear' ? 'Tooth counts are positive (or give a nonzero ratio).' : draft.mode === 'rack' ? 'The pitch radius is positive.' : 'Pulley diameters are positive.';
  if (!/^[a-z][a-z0-9_]*$/.test(draft.name) && !draft.extend) return 'Coupling names are lowercase letters, digits and underscores, starting with a letter.';
  if (!draft.extend) {
    const nameProblem = jointNameProblem(draft.name, draft.editing);
    if (nameProblem) return nameProblem;
  }
  const keyA = keyFor(kinematics, a.name, 'turn'), keyB = keyFor(kinematics, b.name, drivenPart(draft.mode));
  const comment = draft.mode === 'gear' ? (draft.byRatio ? `gear ratio ${num(ratio, 4)}` : `${draft.teeth[0]} : ${draft.teeth[1]} teeth, ${draft.internal ? 'internal' : 'external'}`)
    : draft.mode === 'rack' ? `pinion pitch radius ${num(draft.pitchRadius)} mm` : `pulleys ${num(draft.diameters[0])} : ${num(draft.diameters[1])} mm${draft.reverse ? ', crossed' : ''}`;
  const coupling = draft.extend ? kinematics?.couplings?.find((item) => item.name === draft.extend) : undefined;
  if (coupling) {
    const gears = { ...coupling.gears };
    if (keyA in gears && !(keyB in gears)) gears[keyB] = gears[keyA] * ratio;
    else if (keyB in gears && !(keyA in gears)) gears[keyA] = gears[keyB] / ratio;
    else return `${coupling.name} already gears both joints.`;
    return { name: coupling.name, gears, replacing: coupling.name, summary: `Joins ${coupling.name}: ${describe(draft.mode, a.name, b.name, ratio)}` };
  }
  return { name: draft.name, gears: { [keyA]: 1, [keyB]: ratio }, comment, summary: describe(draft.mode, a.name, b.name, ratio) };
}

/** "hinge_b turns 0.5× hinge, the other way (2 : 1 reduction)", "rack slides 0.1745 mm per degree of pinion". */
function describe(mode: MotionMode, driver: string, driven: string, ratio: number): string {
  if (mode === 'rack') return `${driven} slides ${num(Math.abs(ratio), 4)} mm per degree of ${driver} (${num(Math.abs(ratio) * 360, 3)} mm a turn)${ratio < 0 ? ', reversed' : ''}`;
  const size = Math.abs(ratio);
  const way = ratio < 0 ? 'the other way' : 'the same way';
  const kind = Math.abs(size - 1) < 1e-9 ? '1 : 1' : size < 1 ? `${num(1 / size, 3)} : 1 reduction` : `1 : ${num(size, 3)} speed-up`;
  return `${driven} turns ${num(size, 4)}× ${driver}, ${way} (${kind})`;
}

const jointsIn = (gears: Record<string, number>) => [...new Set(Object.keys(gears).map((key) => key.split('.')[0]))];

/**
 * The joints "Joints only follow" marks `follow=True`: every joint the coupling gears, except a cylindrical one whose
 * turn and travel aren't both geared by some coupling (a follower moves only through couplings, in both).
 */
export function followingJoints(gears: Record<string, number>, kinematics: Kinematics | null, replacing?: string, candidates = jointsIn(gears)): string[] {
  const geared = new Set([...Object.keys(gears), ...(kinematics?.couplings ?? []).filter((c) => c.name !== replacing).flatMap((c) => Object.keys(c.gears))]);
  return candidates.filter((name) => {
    const joint = jointOf(kinematics, name);
    if (!joint || joint.type === 'rigid') return false;
    return joint.type !== 'cylindrical' ? geared.has(name) : ((geared.has(`${name}.turn`) || geared.has(name)) && geared.has(`${name}.travel`));
  });
}

/* ───────── Motor ───────── */

function motorDefaults(kinematics: Kinematics | null, target: string): Partial<MotionTool> {
  const written = driveCall(target);
  const joint = jointOf(kinematics, target);
  const coupling = kinematics?.couplings?.find((item) => item.name === target);
  const bounds: [number, number] | null = joint ? joint.limits : coupling?.bounds ?? null;
  const canSpin = joint ? turns(joint) && !joint.limits : !!coupling && !coupling.bounds && couplingOnlyTurns(kinematics!, coupling);
  const speed = written?.speed ?? (joint ? defaultDriveSpeed(joint) : 90);
  const range = written?.range ?? bounds ?? [0, joint && !turns(joint) ? 40 : 90];
  return { target, editing: written ? target : null, speed: Math.abs(speed), direction: speed < 0 ? -1 : 1, continuous: canSpin && !written?.range,
    range, check: !!written?.check };
}

const couplingOnlyTurns = (kinematics: Kinematics, coupling: MotionCoupling) =>
  Object.keys(coupling.gears).every((key) => !key.endsWith('.travel') && jointOf(kinematics, key.split('.')[0])?.type !== 'slider');

export function setMotorTarget(target: string) {
  useMotionTool.setState({ ...motorDefaults(kinematicsNow(), target), error: null });
}

/** Whether the target can turn on and on (a turning joint or coupling with no limits). */
export function motorCanSpin(draft: MotionTool): boolean {
  const kinematics = kinematicsNow();
  const joint = jointOf(kinematics, draft.target);
  const coupling = kinematics?.couplings?.find((item) => item.name === draft.target);
  return joint ? turns(joint) && !joint.limits : !!coupling && !coupling.bounds && couplingOnlyTurns(kinematics!, coupling);
}

/* ───────── Poses ───────── */

/**
 * Where everything is now: each moving joint's own position (a geared one's only when it is off its gearing; a follower's
 * never: its couplings place it) and each coupling.
 */
export function currentValues(kinematics: Kinematics | null): Record<string, number> {
  const { own, coupled } = useMotion.getState();
  const out: Record<string, number> = {};
  for (const coupling of kinematics?.couplings ?? []) out[coupling.name] = coupled[coupling.name] ?? coupling.value;
  for (const joint of movable(kinematics)) {
    if (joint.follows) continue;
    const value = own[joint.name]?.value ?? joint.value;
    if (joint.driven_by?.length && Math.abs(value) < 1e-9) continue;
    out[joint.name] = value;
  }
  return out;
}

/* ───────── Commit ───────── */

export function toolProblem(draft: MotionTool = tool()): string | null {
  const kinematics = kinematicsNow();
  switch (draft.mode) {
    case 'gear': case 'rack': case 'belt': case 'couple': {
      const plan = linkPlan(draft, kinematics);
      return typeof plan === 'string' ? plan : null;
    }
    case 'motor': {
      if (!draft.target) return 'Choose the joint or coupling the motor turns.';
      if (!(draft.speed > 0)) return 'The speed is a positive number.';
      if (!draft.continuous && !(draft.range[0] < draft.range[1])) return 'The range needs min < max.';
      return null;
    }
    case 'pose': {
      if (!/^[A-Za-z0-9_][\w -]*$/.test(draft.name)) return 'Pose names are letters, digits, spaces, hyphens and underscores.';
      if (!Object.values(draft.include).some(Boolean)) return 'Include at least one joint or coupling.';
      if (draft.name !== draft.editing && poseNames().includes(draft.name)) return `There is already a pose named ${draft.name}.`;
      return null;
    }
    case 'animation': {
      if (!/^[a-z][a-z0-9_]*$/.test(draft.name)) return 'Animation names are lowercase letters, digits and underscores, starting with a letter.';
      if (draft.name !== draft.editing && animationNamesInCode().includes(draft.name)) return `There is already an animation named ${draft.name}.`;
      if (draft.keys.length < 2) return 'An animation needs at least two keys.';
      const poses = poseNames();
      for (const [index, key] of draft.keys.entries()) {
        if (typeof key.pose === 'string' && !poses.includes(key.pose)) return `Key ${index + 1}: choose a pose.`;
        if (!(key.time >= 0)) return `Key ${index + 1}: times are zero or more seconds.`;
        if (index && key.time < draft.keys[index - 1].time) return `Key ${index + 1} comes before the key above it; keep keys in time order.`;
      }
      if (draft.keys[draft.keys.length - 1].time <= draft.keys[0].time) return 'Give the last key a later time than the first.';
      return null;
    }
    default: return null;
  }
}

export async function commitMotionTool() {
  const draft = tool();
  const problem = toolProblem(draft);
  if (problem) { patch({ error: problem }); return; }
  const kinematics = kinematicsNow();
  let focus: string | null = null;
  if (draft.mode === 'motor') {
    writeDrive({ target: draft.target, speed: draft.speed * draft.direction, range: draft.continuous ? null : draft.range, check: draft.check });
    focus = draft.target;
  } else if (draft.mode === 'pose') {
    // New poses use the selected mode; editing a pose retains its own mode.
    writePose(draft.name, Object.fromEntries(Object.entries(draft.values).filter(([key]) => draft.include[key])), draft.editing ?? undefined,
      draft.editing ? undefined : useMotion.getState().mode);
  } else if (draft.mode === 'animation') {
    const spec: AnimationSpec = { name: draft.name, keys: draft.keys, loop: draft.loop, easing: draft.easing, check: draft.check };
    writeAnimation(spec, draft.editing ?? undefined);
    if (draft.editing && draft.editing !== draft.name) removeAnimation(draft.editing);
  } else {
    const plan = linkPlan(draft, kinematics);
    if (typeof plan === 'string') return;
    writeCoupling(plan.name, plan.gears, { comment: plan.comment, replacing: plan.replacing });
    if (draft.mode === 'couple') {
      // A removed row must not leave its joint locked as a follower with no
      // coupling to move it. Other couplings may still drive that joint.
      const previous = kinematics?.couplings?.find(coupling => coupling.name === plan.replacing);
      if (previous) {
        const followers = jointsIn(previous.gears).filter(name => jointOf(kinematics, name)?.follows);
        const retained = new Set(followingJoints(plan.gears, kinematics, plan.replacing, followers));
        setJointsFollow(followers.filter(name => !retained.has(name)), false);
      }
      if (draft.follow || draft.followWas) {
        setJointsFollow(draft.follow ? followingJoints(plan.gears, kinematics, plan.replacing) : jointsIn(plan.gears), draft.follow);
      }
    }
    focus = plan.name;
  }
  closeMotionTool();
  await updateModel();
  if (focus) selectJoint(focus);
  if (draft.mode === 'animation') selectClip(draft.name);
}

/** Removes what the panel edits: a drive, pose or animation. */
export async function removeEdited() {
  const draft = tool();
  if (!draft.editing) return;
  if (draft.mode === 'motor') removeDrive(draft.editing);
  else if (draft.mode === 'pose') {
    const problem = removePose(draft.editing);
    if (problem) { patch({ error: problem }); return; }
  }
  else if (draft.mode === 'animation') removeAnimation(draft.editing);
  else return;
  closeMotionTool();
  await updateModel();
}

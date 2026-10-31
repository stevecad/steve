/**
 * A take: one motion to show or export over time, an animation (design.animation), an explode (design.explode) or one
 * cycle of a motor (design.drive): its length and the pose at any time in it. The animated GLB, the video export and presentation view
 * all sample takes.
 */
import {
  animationValues, driveValue, effectivePose, explodeKey, initialCoupled, initialPose, type Kinematics, type MotionAnimation, type MotionDrive, type MotionExplode,
  type MotionJoint, type Pose,
} from './kinematics';
import { clipOf, explodeOf, useMotion } from './state';

/** Joints' own positions and couplings' values: what a take moves from (the code's pose, or the live one). */
export interface Base { own: Pose; coupled: Record<string, number> }

export interface Take {
  /** `animation:<name>`, `explode:<name>` or `motor:<joint or coupling>`. */
  key: string;
  name: string;
  kind: 'animation' | 'explode' | 'motor';
  /** Seconds: the animation's or explode's length, or one motor cycle (a sweep there and back, or one turn). */
  duration: number;
  /** Plays over and over by default: a looping animation, or a motor. */
  loop: boolean;
  /** Joint and coupling values at `t`, on top of `base` (default: the code's pose). */
  values: (t: number, base?: Base) => Base;
  /** Where every joint is at `t`. */
  pose: (t: number, base?: Base) => Pose;
}

const codeBase = (kinematics: Kinematics): Base => ({ own: initialPose(kinematics), coupled: initialCoupled(kinematics) });
const copy = (base: Base): Base => ({ own: { ...base.own }, coupled: { ...base.coupled } });

/** The live pose the viewer shows now, as a base. */
export function liveBase(): Base {
  const { own, coupled } = useMotion.getState();
  return copy({ own, coupled });
}

function withPose(kinematics: Kinematics, take: Omit<Take, 'pose'>): Take {
  return { ...take, pose: (t, base) => { const { own, coupled } = take.values(t, base); return effectivePose(kinematics, own, coupled); } };
}

export function clipTake(kinematics: Kinematics, clip: MotionAnimation): Take {
  return withPose(kinematics, {
    key: `animation:${clip.name}`, name: clip.name, kind: 'animation', duration: clip.duration, loop: clip.loop,
    values: (t, base = codeBase(kinematics)) => {
      const next = copy(base);
      for (const [target, value] of Object.entries(animationValues(clip, t))) {
        const joint = kinematics.joints.find((item) => item.name === target);
        if (joint) next.own[target] = { ...(next.own[target] ?? { slide: joint.slide ?? 0 }), value };
        else next.coupled[target] = value;
      }
      return next;
    },
  });
}

/**
 * An explode plays from the code's pose, as the build works it out; its moment rides in the pose (kinematics.ts
 * EXPLODE_KEY), so whatever places parts from the pose moves the exploded ones.
 */
export function explodeTake(kinematics: Kinematics, explode: MotionExplode): Take {
  return withPose(kinematics, {
    key: `explode:${explode.name}`, name: explode.name, kind: 'explode', duration: explode.duration, loop: explode.loop,
    values: (t) => {
      const next = codeBase(kinematics);
      next.own[explodeKey(explode.name)] = { value: t, slide: 0 };
      return next;
    },
  });
}

export function driveTake(kinematics: Kinematics, drive: MotionDrive): Take {
  const coupling = kinematics.couplings?.find((item) => item.name === drive.joint);
  const joint = kinematics.joints.find((item) => item.name === drive.joint);
  const speed = Math.abs(drive.speed) || 1;
  // As the viewer plays it (state.ts tick): a sweep over the drive's range (else the joint's limits or the coupling's
  // bounds) there and back, or one turn when nothing bounds it.
  const range = drive.range ?? (coupling ? coupling.bounds : joint?.limits) ?? null;
  const duration = range && range[1] > range[0] ? (2 * (range[1] - range[0])) / speed : 360 / speed;
  return withPose(kinematics, {
    key: `motor:${drive.joint}`, name: drive.joint, kind: 'motor', duration, loop: true,
    values: (t, base = codeBase(kinematics)) => {
      const next = copy(base);
      if (coupling) {
        const start = coupling.value;
        next.coupled[coupling.name] = range ? driveValue({ ...drive, range }, { type: 'slider', limits: range } as MotionJoint, start, t) : start + drive.speed * t;
      } else if (joint) {
        next.own[joint.name] = { ...(next.own[joint.name] ?? { slide: joint.slide ?? 0 }), value: driveValue(drive, joint, joint.value, t) };
      }
      return next;
    },
  });
}

/** Every take of the design: its animations, its explodes, then its motors. */
export function allTakes(kinematics: Kinematics | null): Take[] {
  if (!kinematics) return [];
  return [...(kinematics.animations ?? []).map((clip) => clipTake(kinematics, clip)), ...(kinematics.explodes ?? []).map((explode) => explodeTake(kinematics, explode)),
    ...kinematics.drives.map((drive) => driveTake(kinematics, drive))];
}

/** The motion the Motion tab shows: the timeline's animation or explode, else the active (or first) motor. */
export function currentTake(kinematics: Kinematics | null): Take | null {
  if (!kinematics) return null;
  const clip = clipOf();
  if (clip) return clipTake(kinematics, clip);
  const explode = explodeOf();
  if (explode) return explodeTake(kinematics, explode);
  const active = useMotion.getState().active ?? useMotion.getState().playing;
  const drive = kinematics.drives.find((item) => item.joint === active) ?? kinematics.drives[0];
  return drive ? driveTake(kinematics, drive) : null;
}

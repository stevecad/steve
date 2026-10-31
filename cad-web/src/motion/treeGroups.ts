/**
 * How the model tree groups a design's motion (motion/JointsGroup.tsx): couplings, joints and animations under Joints;
 * explodes in a group of their own, shown only when the design has some (they move parts for display, joints don't).
 * Plain functions over the build's kinematics, so tests run them outside a browser.
 */
import type { Kinematics } from './kinematics';

export interface MotionTreeGroups {
  /** What the Joints group counts: couplings, joints and animations. */
  joints: number;
  /** Whether the Joints group shows its "connect two instances" hint: the design has no joints yet. */
  jointsHint: boolean;
  /** The Explodes group's rows, by name; null when the design has none (no group at all). */
  explodes: string[] | null;
}

export function motionTreeGroups(kinematics: Kinematics | null): MotionTreeGroups {
  const joints = kinematics?.joints ?? [];
  const explodes = (kinematics?.explodes ?? []).map((explode) => explode.name);
  return {
    joints: joints.length + (kinematics?.couplings?.length ?? 0) + (kinematics?.animations?.length ?? 0),
    jointsHint: !joints.length,
    explodes: explodes.length ? explodes : null,
  };
}

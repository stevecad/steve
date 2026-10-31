/**
 * Joints and motion (docs/MOTION.md). The build resolves every joint to the design frame (mm,
 * Z-up, the viewer's world space); the viewer only does arithmetic: forward kinematics down the
 * joint tree, never topology. Joints never change geometry; they move instances.
 */
import * as THREE from 'three';

export type JointType = 'rigid' | 'revolute' | 'slider' | 'cylindrical';

export interface MotionJoint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  origin: [number, number, number];
  axis: [number, number, number];
  /** Degrees for revolute/cylindrical rotation, mm for sliders. */
  limits: [number, number] | null;
  value: number;
  slide_limits?: [number, number] | null;
  slide?: number;
  /** The couplings that gear this joint. */
  driven_by?: string[];
  /** `follow=True`: it moves only through its couplings; its own value stays as written. */
  follows?: boolean;
}

/**
 * One input that moves several joints in fixed ratios (`design.couple`): at value x each geared
 * motion moves by x·ratio on top of its own value. Keys are joint names, or `<joint>.turn` /
 * `<joint>.travel` for a cylindrical joint. `bounds` combine its limits with its joints' limits.
 */
export interface MotionCoupling { name: string; gears: Record<string, number>; limits: [number, number] | null; value: number; bounds: [number, number] | null }

export interface Collision { a: string; b: string; spans: [number, number][]; max_volume_mm3: number }
/**
 * `design.drive(..., check=True)`: exact solids swept across the range at the build. `complete` is false when it
 * stopped (its time limit) before every requested pose: never clear then. `reused` (on any check, study or fit
 * check): an earlier build's result, since nothing it depends on changed (an appearance edit, say).
 */
export interface CollisionCheck { samples: number; of: number; complete?: boolean; clear: boolean; collisions: Collision[]; at_rest: { a: string; b: string }[]; note?: string; reused?: boolean }

/** Whether a motion check or study stopped before every requested pose (builds from before `complete`: fewer samples than requested). */
export function cutShort(check: { samples: number; of: number; complete?: boolean }): boolean {
  return check.complete === undefined ? check.samples < check.of : !check.complete;
}
/** `joint` names a joint, or a coupling when `coupling` is set. */
/** A driven joint held at a limit over a drive: where it stops and the first and last drive value it is held at. */
export interface DriveSaturation { joint: string; part: 'turn' | 'travel'; limit: 'min' | 'max'; held: number; values: [number, number] }
/** `mode`: the design.mode it sweeps in (its limits and bounds). */
export interface MotionDrive { joint: string; speed: number; range: [number, number] | null; check?: CollisionCheck; coupling?: boolean; saturated?: DriveSaturation[]; mode?: string }

/**
 * `design.mode(...)`: a named set of tighter limits. While it is selected each joint it names has these limits (and
 * slide limits), and every coupling these limits and bounds; the code's own limits are the default mode (null).
 */
export interface LimitMode {
  name: string;
  joints: Record<string, { limits?: [number, number]; slide_limits?: [number, number] }>;
  couplings: Record<string, { limits: [number, number] | null; bounds: [number, number] | null }>;
}

/** One key of an animation: its time, the pose it names (if any) and every target's value there (carried forward). */
export interface AnimationKey { time: number; pose?: string; values: Record<string, number> }
/** `design.animation(...)`: keyframes between poses; `check` sweeps it in time (spans in seconds). */
export interface MotionAnimation {
  name: string; keys: AnimationKey[]; targets: string[]; loop: boolean; easing: 'linear' | 'ease'; duration: number; check?: CollisionCheck;
  /** The driven joints held at a limit, at each key time. */
  saturated?: (Saturation & { joint: string; time: number })[];
  /** The design.mode it plays in: the timeline switches to it. */
  mode?: string;
}

type Point = [number, number, number];

/** One step of an explode: when it starts, how long it moves and then holds (seconds), and each instance's move (mm, design frame). */
export interface ExplodeStep { name?: string; start: number; duration: number; hold: number; moves: Record<string, Point>; out?: boolean }
/**
 * `design.explode(...)`: a named exploded view the timeline plays like an animation. Display only. Moves add up from
 * step to step; an instance is named as main.py names it, or a linked design's instance by path ("gearbox/housing").
 */
export interface MotionExplode {
  name: string; steps: ExplodeStep[]; duration: number; easing: 'linear' | 'ease'; loop: boolean; auto?: boolean; instances?: string[];
}
/** Median, 95th percentile and maximum over a study's colliding poses. */
export interface StudySpread { median: number; p95: number; max: number }
/**
 * A colliding pair (overlap volume and depth over the poses where it collides, the deepest pose and the overlap's
 * centre there) or a near miss (`min_distance_mm` at pose `closest`, with the closest points on a and b).
 */
export interface StudyPair {
  a: string; b: string; samples: number; fraction: number; first: number; max_volume_mm3?: number; min_distance_mm?: number;
  volume_mm3?: StudySpread; depth_mm?: StudySpread; deepest?: number; at?: Point; closest?: number; points?: [Point, Point] | null;
  /** The animation time (s) of its deepest or closest pose, for a study that follows an animation. */
  time?: number;
}
/** A listed pair's closest approach over a study that follows an animation (0 where it collides; null where not measured in time). */
export interface StudyGap { a: string; b: string; min_distance_mm: number | null; colliding: number; closest?: number; time?: number; points?: [Point, Point] | null }
/**
 * One colliding pose of a collision study: its index among the study's poses, the values it sets, the pairs that
 * collide, and each pair's overlap depth and centre (the witness point), in the same order.
 */
export interface StudyPose { index: number; time?: number; values: Record<string, number>; pairs: [string, string][]; depth_mm?: number[]; at?: Point[] }
/** How well a pair's declared collision shapes stand in for the exact solids over a study's poses. */
export interface StudyShapeScore {
  a: string; b: string; colliding: number; detected: number; detection_rate: number | null; free: number; false_positives: number;
  false_positive_rate: number | null; missed_depth_mm: number; missed?: number;
}
/** Which pair collides over two joints: `cells[row of y][column of x]` is [poses, colliding poses, index into `pairs` or -1]. */
export interface StudyMap { x: string; y: string; xs: number[]; ys: number[]; binned: boolean; cells: [number, number, number][][] }
/** `design.collision_shape(...)`: a simple collision shape, as modelled, in the design frame (mm); `quat` is w, x, y, z. */
export interface CollisionShape {
  instance: string; type: 'box' | 'sphere' | 'capsule'; size?: Point; at?: Point; quat?: [number, number, number, number]; radius?: number; start?: Point; end?: Point;
}
/**
 * `design.collision_study(...)`: self-collision across combinations of joint values (grid, random or listed poses) or
 * through an animation as it plays, checked at the build with exact solids. `hold` is every other joint's and coupling's value during the study.
 */
export interface CollisionStudy {
  name: string; sampling: 'grid' | 'random' | 'poses' | 'animation'; joints: string[];
  /** The animation it follows (sampling "animation"), checked at its keys (`at`) or across `between` [start, end] s. */
  animation?: string; at?: 'keys'; between?: [number, number]; clearances?: StudyGap[]; ranges: Record<string, [number, number]>; hold: Record<string, number>;
  seed?: number; grid?: Record<string, number>; samples: number; of: number; complete?: boolean; clear: boolean; colliding: number; fraction: number;
  /** 95 % confidence interval of the fraction (random sampling). */
  interval?: [number, number];
  pairs: StudyPair[]; pairs_checked: number; ignored: [string, string][]; at_rest: { a: string; b: string }[];
  clearance_mm?: number; near?: StudyPair[]; volume_mm3?: StudySpread; depth_mm?: StudySpread;
  poses: StudyPose[]; map?: StudyMap; shapes?: StudyShapeScore[];
  /** Per joint: [value, collision-free fraction, samples] across its range. */
  marginals?: Record<string, [number, number, number][]>;
  /** `moving`'s first contact (above and below its held value) at values of `joint`; null is clear to the limit. */
  boundary?: { joint: string; moving: string; from: number; tolerance: number; rows: { at: number; start?: 'colliding'; above?: number | null; below?: number | null }[] };
  note?: string; reused?: boolean;
}

/**
 * A pair a fit check flags (or a declared contact it found touching): exact common volume (null when the boolean
 * failed: `unverified`), the smallest gap, witness points (one: the overlap's centre) and the pose where it's worst.
 */
export interface FitPair {
  a: string; b: string; overlap_mm3: number | null; min_distance_mm: number; clearance_mm: number; contact?: string; allowance_mm3?: number | null;
  points: [number, number, number][] | null; when: { pose: string } | { values: Record<string, number> }; unverified?: boolean; approximate?: boolean;
}
/**
 * `design.fit_check(...)`: interference and clearance as modelled, at named poses and through the joints' ranges.
 * `complete` is false when it stopped (its time limit) before every requested pose and sweep, those named in `unchecked`: never clear then.
 */
export interface FitCheck {
  name: string; instances: string[] | null; poses: string[];
  sweeps: { target: string; range: [number, number]; samples: number; of?: number; refined: number; complete?: boolean }[];
  clearance_mm: number; pairs_checked: number; complete?: boolean; unchecked?: { poses: string[]; sweeps: string[] }; clear: boolean;
  issues: FitPair[]; intended: FitPair[]; contacts?: FitContact[]; approximate?: string[]; note?: string; reused?: boolean;
  /** Undeclared pairs that touch (distance 0, no overlap) where no clearance is kept, first where they touch; never a failure. Absent in older builds. */
  touching?: Omit<FitPair, 'clearance_mm'>[]; touching_count?: number;
}
/**
 * A `design.contact` as a fit check found it: `touching` when any pair it applies to touched (absent: not known, as in
 * older builds), else the `closest` of them with its gap (`at_least` when only bounded): a seat that isn't seated.
 */
export interface FitContact {
  a: string; b: string; kind: string; max_overlap_mm3: number | null; touching?: boolean;
  closest?: { a: string; b: string; min_distance_mm: number; at_least?: boolean; points: [number, number, number][] | null; when: FitPair['when'] };
}

/** Whether a fit check stopped before every requested pose and sweep (builds from before `complete` say so only in their note). */
export function fitCutShort(fit: FitCheck): boolean {
  if (fit.complete !== undefined) return !fit.complete;
  const note = fit.note ?? '';
  return note.includes('Stopped before') || note.includes("' stopped (");
}

/** A pose a cable was checked at: the code's (`pose: 'rest'`), a named pose, a drive value, an animation time or a study pose; `values` is what differs from the code's pose. */
export interface CableWhen { pose?: string; drive?: string; animation?: string; time?: number; study?: string; index?: number; values: Record<string, number> }
/** The worst a cable gets for one check (and part, other cable or connector end), and where. */
export interface CableFinding {
  check: 'path' | 'contact' | 'clearance' | 'cable' | 'connector' | 'bend' | 'stretch' | 'slack' | 'declaration'; status: 'fail'; message: string;
  part?: string; other?: string; end?: string; measured?: number; limit?: number; at_mm?: number | null; when?: CableWhen;
}
/**
 * `design.cable(...)`: a cable whose path points are fastened to instances, redrawn at every pose the build checks.
 * `points` are where they are as modelled (every joint at 0); each moves with its instance.
 */
export interface Cable {
  name: string; diameter_mm: number; clearance_mm: number; min_bend_radius_mm: number | null; slack_mm: number; status: 'pass' | 'fail' | 'unchecked';
  harness?: string; poses?: number; findings: CableFinding[];
  points?: { instance: string | null; at: [number, number, number] }[];
  tangents?: { start: [number, number, number] | null; end: [number, number, number] | null };
  path_length_mm?: number; length_mm?: number; cut_length_mm?: number;
  lengths?: { min_mm: number; max_mm: number; stretch_mm: number; spare_mm: number };
  bend?: { min_radius_mm: number | null; at_mm: number; when: CableWhen };
  closest?: { part: string; gap_mm: number; at_mm: number | null; when: CableWhen };
  failing_poses?: number; failing?: { when: CableWhen; checks: string[] }[];
  studies?: { name: string; poses: number; failing: number; fraction: number }[];
}
export interface CableReport { version: number; pass: boolean; cables: Cable[]; poses: number; of: number; note?: string }

export interface Kinematics {
  version: number;
  joints: MotionJoint[];
  couplings?: MotionCoupling[];
  drives: MotionDrive[];
  poses: Record<string, Record<string, number>>;
  /** The selectable limit sets (design.mode), and the mode each named pose is in. */
  modes?: LimitMode[];
  pose_modes?: Record<string, string>;
  /** Each named pose's driven joints held at a limit there. */
  saturated?: { poses: Record<string, (Saturation & { joint: string })[]> };
  animations?: MotionAnimation[];
  explodes?: MotionExplode[];
  studies?: CollisionStudy[];
  fits?: FitCheck[];
  cables?: CableReport;
  collision_shapes?: CollisionShape[];
  simulation?: SimulationSettings;
  ground: string[];
}

/**
 * What the simulation model export applies beyond geometry and joints (runtime/steve/physics.py), as modelled in the
 * design frame (mm): mass overrides, lumped masses, sites (origin, then X, Y, Z axes) and contact filtering.
 */
export interface SimulationSettings {
  masses?: { kind: 'fill' | 'mass' | 'measured'; instances: string[]; fraction?: number; grams?: number; center?: Point }[];
  lumped?: { name: string; instance: string; grams: number; at: Point; axes: [Point, Point, Point]; box: Point | null }[];
  sites?: { name: string; instance: string; at: Point; axes: [Point, Point, Point] }[];
  filters?: { instances: string[]; contype: number; conaffinity: number; group?: number; condim?: number; friction?: number[] }[];
  pairs?: { a: string; b: string; condim?: number; friction?: number[] }[];
  excludes?: { a: string; b: string }[];
}

/** Where a cable was checked, as every joint's and coupling's value: the code's pose with the pose's own values on top. */
export function cableValues(kinematics: Kinematics, when: CableWhen): Record<string, number> {
  return { ...Object.fromEntries(kinematics.joints.map((joint) => [joint.name, joint.value])), ...initialCoupled(kinematics), ...when.values };
}

/**
 * A cable's centreline at a pose, for drawing: its points moved with their instances, plus a lead-in along a planar
 * end face's direction so it leaves the face as the build's spline does.
 */
export function cablePath(kinematics: Kinematics, cable: Cable, pose: Pose): THREE.Vector3[] | null {
  if (!cable.points || cable.points.length < 2) return null;
  const motions = instanceMotions(kinematics, pose);
  const at = (point: [number, number, number], instance: string | null) => {
    const vector = new THREE.Vector3().fromArray(point);
    const motion = instance ? motions.get(instance) : undefined;
    return motion ? vector.applyMatrix4(motion) : vector;
  };
  const points = cable.points.map((point) => at(point.at, point.instance));
  const lead = (index: number, direction: [number, number, number] | null | undefined, sign: number) => {
    if (!direction) return null;
    const instance = cable.points![index].instance;
    const motion = instance ? motions.get(instance) : undefined;
    const turned = new THREE.Vector3().fromArray(direction);
    if (motion) turned.transformDirection(motion);
    const step = Math.min(points[index].distanceTo(points[index + sign]) * 0.25, Math.max(cable.diameter_mm * 3, 2));
    return points[index].clone().addScaledVector(turned.normalize(), step * sign);
  };
  const first = lead(0, cable.tangents?.start, 1);
  const last = lead(points.length - 1, cable.tangents?.end, -1);
  return [points[0], ...(first ? [first] : []), ...points.slice(1, -1), ...(last ? [last] : []), points[points.length - 1]];
}

/** A study pose's values with everything it holds: what the viewer moves to when showing it. */
export const studyValues = (study: CollisionStudy, pose: StudyPose) => ({ ...study.hold, ...pose.values });

/** Where a fit pair is worst, as every joint's and coupling's value: the code's pose with the named pose or values on top. */
export function fitValues(kinematics: Kinematics, pair: Pick<FitPair, 'when'>): Record<string, number> {
  const rest = { ...Object.fromEntries(kinematics.joints.map((joint) => [joint.name, joint.value])), ...initialCoupled(kinematics) };
  if ('values' in pair.when) return { ...rest, ...pair.when.values };
  return { ...rest, ...(pair.when.pose === 'rest' ? {} : kinematics.poses[pair.when.pose]) };
}

/** Whether the joints and couplings are at `values` now. */
function isAt(kinematics: Kinematics | null, own: Pose, coupled: Record<string, number>, values: Record<string, number>) {
  return Object.entries(values).every(([target, value]) => {
    const current = target in coupled ? coupled[target] : own[target]?.value ?? kinematics?.joints.find((j) => j.name === target)?.value;
    return current !== undefined && Math.abs(current - value) < 1e-5;
  });
}

/** The collisions a study found at the viewer's pose: the pairs of a colliding pose the joints and couplings are at now. */
export function studyCollisionsAt(kinematics: Kinematics | null, own: Pose, coupled: Record<string, number>): Collision[] {
  return studyPoseAt(kinematics, own, coupled)?.pairs.map(([a, b]) => ({ a, b, spans: [], max_volume_mm3: 0 })) ?? [];
}

/** The colliding study pose the joints and couplings are at now, if any. */
export function studyPoseAt(kinematics: Kinematics | null, own: Pose, coupled: Record<string, number>): StudyPose | null {
  for (const study of kinematics?.studies ?? []) {
    const pose = study.poses.find((item) => isAt(kinematics, own, coupled, studyValues(study, item)));
    if (pose) return pose;
  }
  return null;
}

/** The pairs fit checks flag at the viewer's pose: those whose worst pose the joints and couplings are at now. */
export function fitCollisionsAt(kinematics: Kinematics | null, own: Pose, coupled: Record<string, number>): Collision[] {
  if (!kinematics) return [];
  return (kinematics.fits ?? []).flatMap((fit) => fit.issues.filter((pair) => isAt(kinematics, own, coupled, fitValues(kinematics, pair))))
    .map((pair) => ({ a: pair.a, b: pair.b, spans: [], max_volume_mm3: pair.overlap_mm3 ?? 0 }));
}

/** Every target's value at `t` seconds, between the two keys around it: linear, or eased (smoothstep) like the build checks it. */
export function animationValues(animation: MotionAnimation, t: number): Record<string, number> {
  const { keys } = animation;
  if (t <= keys[0].time) return { ...keys[0].values };
  if (t >= keys[keys.length - 1].time) return { ...keys[keys.length - 1].values };
  const after = keys.findIndex((key, index) => index > 0 && key.time >= t);
  const a = keys[after - 1], b = keys[after];
  const span = b.time - a.time;
  let u = span > 0 ? (t - a.time) / span : 1;
  if (animation.easing === 'ease') u = u * u * (3 - 2 * u);
  return Object.fromEntries(Object.keys(a.values).map((target) => [target, a.values[target] + (b.values[target] - a.values[target]) * u]));
}

/** An animation's collisions at `t` seconds (its samples are evenly spread, so within half a step of a span counts). */
export function animationCollisionsAt(animation: MotionAnimation | undefined, t: number): Collision[] {
  const check = animation?.check;
  if (!animation || !check || check.clear) return [];
  const half = animation.duration / Math.max(check.of - 1, 1) / 2;
  return check.collisions.filter((hit) => hit.spans.some(([low, high]) => t >= low - half && t <= high + half));
}

/** A joint's position: rotation (degrees) or travel (mm), plus a cylindrical joint's travel. */
export interface JointState { value: number; slide: number }
export type Pose = Record<string, JointState>;

/**
 * An animation whose every key has every target's value. A build whose summary was too large to return lists only what
 * each key changes (runtime/kernel.py success_payload), so values are carried forward from the key before.
 */
function carriedForward(animation: MotionAnimation): MotionAnimation {
  let full: Record<string, number> = {};
  return { ...animation, keys: animation.keys.map((key) => ({ ...key, values: (full = { ...full, ...key.values }) })) };
}

export function kinematicsOf(metadata: unknown): Kinematics | null {
  const design = (metadata as { modeling?: { design?: { kinematics?: Kinematics; instances?: { name: string }[] } } } | null | undefined)?.modeling?.design;
  const kinematics = design?.kinematics;
  // The first explode can be previewed before the design has any joint or
  // saved motion. Its placed instances still form a valid stationary assembly.
  if (!kinematics?.joints?.length && !kinematics?.explodes?.length) {
    return design?.instances?.length ? { version: 1, joints: [], drives: [], poses: {}, ground: design.instances.map((item) => item.name) } : null;
  }
  const complete = { ...kinematics, joints: kinematics.joints ?? [], drives: kinematics.drives ?? [], poses: kinematics.poses ?? {} };
  return complete.animations?.length ? { ...complete, animations: complete.animations.map(carriedForward) } : complete;
}

/**
 * The kinematics as mode `mode` has it: its joints' limits and its couplings' limits and bounds in place of the code's
 * (runtime/steve/design.py `_in_mode`), so every clamp, slider and saturation follows. The code's own for null or a
 * mode the build doesn't have.
 */
export function withMode(kinematics: Kinematics, mode: string | null): Kinematics {
  const found = mode ? kinematics.modes?.find((item) => item.name === mode) : undefined;
  if (!found) return kinematics;
  return {
    ...kinematics,
    joints: kinematics.joints.map((joint) => (found.joints[joint.name] ? { ...joint, ...found.joints[joint.name] } : joint)),
    couplings: kinematics.couplings?.map((coupling) => (found.couplings[coupling.name] ? { ...coupling, ...found.couplings[coupling.name] } : coupling)),
  };
}

/* ───────── Explodes: a pose may carry an explode moment ───────── */

/**
 * A pose shows an explode at a moment as one more entry, `@explode:<name>` → { value: seconds }: joint names never
 * hold "@" or ":", so it never meets a joint, and everything that places parts from a pose (the viewport, the
 * animated GLB, cables, a video) moves the exploded parts too, through instanceMotions.
 */
export const EXPLODE_KEY = '@explode:';
export const explodeKey = (name: string) => `${EXPLODE_KEY}${name}`;

/** An explode being edited (the Explode steps tool's draft), played before it's built: found by name like the build's. */
let preview: MotionExplode | null = null;
export function setPreviewExplode(explode: MotionExplode | null) {
  preview = explode;
}

/** The explode a pose shows and its moment, if any. */
export function explodeMoment(kinematics: Kinematics | null, pose: Pose): { explode: MotionExplode; t: number } | null {
  for (const [key, state] of Object.entries(pose)) {
    if (!key.startsWith(EXPLODE_KEY)) continue;
    const name = key.slice(EXPLODE_KEY.length);
    const explode = preview?.name === name ? preview : kinematics?.explodes?.find((item) => item.name === name);
    if (explode) return { explode, t: state.value };
  }
  return null;
}

/** Each moved instance's offset (mm, design frame) at `t` seconds: every step's move so far, eased like the build checks it. */
export function explodeOffsets(explode: MotionExplode, t: number): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  for (const step of explode.steps) {
    if (t <= step.start) break;
    let u = step.duration > 0 ? Math.min(1, (t - step.start) / step.duration) : 1;
    if (explode.easing === 'ease') u = u * u * (3 - 2 * u);
    for (const [path, [x, y, z]] of Object.entries(step.moves)) {
      const offset = out.get(path) ?? new THREE.Vector3();
      out.set(path, offset.add(new THREE.Vector3(x, y, z).multiplyScalar(u)));
    }
  }
  return out;
}

/** An instance's whole offset: its own and every enclosing linked design's ("kit" then "kit/tray"). */
export function totalOffset(offsets: Map<string, THREE.Vector3>, path: string): THREE.Vector3 {
  const parts = path.split('/');
  const total = new THREE.Vector3();
  for (let i = 1; i <= parts.length; i++) {
    const own = offsets.get(parts.slice(0, i).join('/'));
    if (own) total.add(own);
  }
  return total;
}

/** The moment step `index` (0-based) has finished moving. */
export const stepEnd = (explode: MotionExplode, index: number) => explode.steps[index].start + explode.steps[index].duration;

/** The step playing (or holding) at `t`, 0-based; -1 before the first. */
export function stepAt(explode: MotionExplode, t: number): number {
  let found = -1;
  explode.steps.forEach((step, index) => { if (t >= step.start - 1e-9) found = index; });
  return found;
}

/** The pose the code describes (each joint's `value=`). */
export function initialPose(kinematics: Kinematics): Pose {
  return Object.fromEntries(kinematics.joints.map((joint) => [joint.name, { value: joint.value, slide: joint.slide ?? 0 }]));
}

/** Each coupling's value as the code writes it. */
export function initialCoupled(kinematics: Kinematics): Record<string, number> {
  return Object.fromEntries((kinematics.couplings ?? []).map((coupling) => [coupling.name, coupling.value]));
}

/** The coupling key of a joint's main motion (`turn`) or a cylindrical joint's sliding (`travel`). */
export const dofKey = (joint: Pick<MotionJoint, 'name' | 'type'>, part: 'turn' | 'travel') => (joint.type === 'cylindrical' ? `${joint.name}.${part}` : joint.name);

/** The couplings that gear one motion of a joint, with their ratios. */
export function gearsOf(kinematics: Kinematics, joint: MotionJoint, part: 'turn' | 'travel' = 'turn'): { coupling: MotionCoupling; ratio: number }[] {
  const key = dofKey(joint, part);
  return (kinematics.couplings ?? []).flatMap((coupling) => (key in coupling.gears ? [{ coupling, ratio: coupling.gears[key] }] : []));
}

/**
 * The couplings to move instead, when a follower's motion can't be moved by hand: it follows two or more couplings
 * (or none). Null when it can: a joint that isn't a follower, or one geared by exactly one coupling (back-driven).
 */
export function followerHeld(kinematics: Kinematics, joint: MotionJoint, part: 'turn' | 'travel' = 'turn'): string[] | null {
  if (!joint.follows) return null;
  const gears = gearsOf(kinematics, joint, part);
  return gears.length === 1 ? null : gears.map((gear) => gear.coupling.name);
}

/** Within the coupling's bounds (an unbounded coupling turns freely). */
export const clampCoupling = (coupling: MotionCoupling, value: number) =>
  (coupling.bounds ? Math.min(coupling.bounds[1], Math.max(coupling.bounds[0], value)) : value);

/** Whether a coupling only turns joints (its value reads in degrees) or also slides one. */
export const couplingTurns = (kinematics: Kinematics, coupling: MotionCoupling) => Object.keys(coupling.gears).every((key) => {
  const [name, part] = key.split('.');
  const joint = kinematics.joints.find((item) => item.name === name);
  return part !== 'travel' && joint?.type !== 'slider';
});

/**
 * The unit of a coupling's value: '°' when it only turns joints; otherwise the unit of a key it gears at ×1 (a rack
 * and pinion's value is the pinion's angle); 'mm' when it only slides joints; '' for a mix with no ×1 key.
 */
export function couplingUnit(kinematics: Kinematics, coupling: MotionCoupling): '°' | 'mm' | '' {
  if (couplingTurns(kinematics, coupling)) return '°';
  const slides = (key: string) => {
    const [name, part] = key.split('.');
    return part === 'travel' || kinematics.joints.find((item) => item.name === name)?.type === 'slider';
  };
  const unit = Object.entries(coupling.gears).find(([, ratio]) => Math.abs(Math.abs(ratio) - 1) < 1e-9);
  if (unit) return slides(unit[0]) ? 'mm' : '°';
  return Object.keys(coupling.gears).every(slides) ? 'mm' : '';
}

/** A joint's own position plus, for every coupling that gears it, coupling value × ratio (before any limit). */
function summed(kinematics: Kinematics, joint: MotionJoint, own: Pose, coupled: Record<string, number>): JointState {
  let { value, slide } = own[joint.name] ?? { value: joint.value, slide: joint.slide ?? 0 };
  for (const { coupling, ratio } of gearsOf(kinematics, joint, 'turn')) value += (coupled[coupling.name] ?? coupling.value) * ratio;
  if (joint.type === 'cylindrical') for (const { coupling, ratio } of gearsOf(kinematics, joint, 'travel')) slide += (coupled[coupling.name] ?? coupling.value) * ratio;
  return { value, slide };
}

/**
 * The live pose: each joint's own position plus, for every coupling that gears it, coupling value × ratio; a joint
 * couplings drive stops at its limits (runtime/steve/design.py `_effective` places it the same way).
 */
export function effectivePose(kinematics: Kinematics, own: Pose, coupled: Record<string, number>): Pose {
  const out: Pose = {};
  for (const [key, state] of Object.entries(own)) if (key.startsWith(EXPLODE_KEY)) out[key] = state;   // An explode moment rides along.
  for (const joint of kinematics.joints) {
    const { value, slide } = summed(kinematics, joint, own, coupled);
    out[joint.name] = joint.driven_by?.length ? { value: clampValue(joint, value), slide: clampSlide(joint, slide) } : { value, slide };
  }
  return out;
}

/** A driven joint's motion held at a limit: its sum (`value`) and where it stops (`held`), as the build reports it. */
export interface Saturation { part: 'turn' | 'travel'; value: number; held: number; limit: 'min' | 'max' }

/** Where a joint couplings drive is held at a limit in the live pose (none for a joint without couplings). */
export function saturations(kinematics: Kinematics, joint: MotionJoint, own: Pose, coupled: Record<string, number>): Saturation[] {
  if (!joint.driven_by?.length) return [];
  const { value, slide } = summed(kinematics, joint, own, coupled);
  const out: Saturation[] = [];
  const motions: ['turn' | 'travel', number, number, [number, number] | null | undefined][] = [
    [joint.type === 'slider' ? 'travel' : 'turn', value, clampValue(joint, value), joint.limits],
    ['travel', slide, clampSlide(joint, slide), joint.type === 'cylindrical' ? joint.slide_limits : null],
  ];
  for (const [part, sum, held, limits] of motions) {
    if (limits && Math.abs(sum - held) > 1e-9) out.push({ part, value: sum, held, limit: sum > held ? 'max' : 'min' });
  }
  return out;
}

/** Whether a joint turns (degrees) or slides (mm) for its main value. */
export const turns = (joint: Pick<MotionJoint, 'type'>) => joint.type === 'revolute' || joint.type === 'cylindrical';

/** The speed a new drive or motor starts at: 90 °/s turning, 20 mm/s sliding (the Joint and Motor tools share it). */
export const defaultDriveSpeed = (joint: Pick<MotionJoint, 'type'>) => (turns(joint) ? 90 : 20);

/** Clamped to the joint's limits; an unlimited revolute joint wraps to [-180, 180). */
export function clampValue(joint: MotionJoint, value: number): number {
  if (joint.limits) return Math.min(joint.limits[1], Math.max(joint.limits[0], value));
  if (turns(joint)) return ((((value + 180) % 360) + 360) % 360) - 180;
  return value;
}

export function clampSlide(joint: MotionJoint, slide: number): number {
  const limits = joint.slide_limits;
  return limits ? Math.min(limits[1], Math.max(limits[0], slide)) : slide;
}

const scratch = { axis: new THREE.Vector3(), origin: new THREE.Vector3(), rotate: new THREE.Matrix4(), move: new THREE.Matrix4() };

/** How the child moves with its parent held still, in world space: about/along the joint axis. */
export function jointMotion(joint: MotionJoint, state: JointState, target = new THREE.Matrix4()): THREE.Matrix4 {
  target.identity();
  if (joint.type === 'rigid') return target;
  const axis = scratch.axis.fromArray(joint.axis).normalize();
  const origin = scratch.origin.fromArray(joint.origin);
  const angle = turns(joint) ? THREE.MathUtils.degToRad(state.value) : 0;
  const travel = joint.type === 'slider' ? state.value : joint.type === 'cylindrical' ? state.slide : 0;
  if (angle) {
    // T(origin) · R(axis, angle) · T(-origin)
    scratch.rotate.makeRotationAxis(axis, angle);
    target.makeTranslation(origin.x, origin.y, origin.z).multiply(scratch.rotate);
    target.multiply(scratch.move.makeTranslation(-origin.x, -origin.y, -origin.z));
  }
  if (travel) target.premultiply(scratch.move.makeTranslation(axis.x * travel, axis.y * travel, axis.z * travel));
  return target;
}

/**
 * Each moved instance's world-space motion from its zero pose: a child moves with its parent's
 * motion, then by its own joint (forward kinematics down the tree). Grounded instances are absent.
 * With an explode moment in the pose (EXPLODE_KEY), each instance it moves is shifted on top, and a linked design's
 * instance it moves is keyed by its path ("kit/tray") with its parents' shifts and joint motion included.
 */
export function instanceMotions(kinematics: Kinematics, pose: Pose): Map<string, THREE.Matrix4> {
  const joints = jointMotions(kinematics, pose);
  const moment = explodeMoment(kinematics, pose);
  if (!moment) return joints;
  const out = new Map(joints);
  const offsets = explodeOffsets(moment.explode, moment.t);
  for (const path of offsets.keys()) {
    const shift = totalOffset(offsets, path);
    const base = joints.get(path.split('/')[0]);   // A linked design's instance rides on its top-level instance's joint.
    const motion = new THREE.Matrix4().makeTranslation(shift.x, shift.y, shift.z);
    out.set(path, base ? motion.multiply(base) : motion);
  }
  return out;
}

function jointMotions(kinematics: Kinematics, pose: Pose): Map<string, THREE.Matrix4> {
  const byChild = new Map(kinematics.joints.map((joint) => [joint.child, joint]));
  const out = new Map<string, THREE.Matrix4>();
  const resolve = (instance: string, depth = 0): THREE.Matrix4 | null => {
    if (out.has(instance)) return out.get(instance)!;
    const joint = byChild.get(instance);
    if (!joint || depth > 64) return null;
    const parent = resolve(joint.parent, depth + 1);
    const own = jointMotion(joint, pose[joint.name] ?? { value: joint.value, slide: joint.slide ?? 0 });
    const motion = parent ? parent.clone().multiply(own) : own;
    out.set(instance, motion);
    return motion;
  };
  for (const joint of kinematics.joints) resolve(joint.child);
  return out;
}

/**
 * A drive's joint value at time `t` seconds: a triangle sweep across its range at `speed` per
 * second, or continuous rotation for an unlimited revolute joint.
 */
export function driveValue(drive: MotionDrive, joint: MotionJoint, start: number, t: number, speedScale = 1): number {
  const speed = drive.speed * speedScale;
  const range = drive.range ?? joint.limits;
  if (!range) return clampValue(joint, start + speed * t);
  const [low, high] = range;
  const span = high - low;
  if (span <= 0) return low;
  // Start from the current value, heading toward `high` for a positive speed.
  const phase0 = Math.min(Math.max(start, low), high) - low;
  const travelled = phase0 + Math.abs(speed) * t;
  const cycle = travelled % (2 * span);
  const forward = cycle <= span ? low + cycle : high - (cycle - span);
  return speed >= 0 ? forward : high + low - forward;
}

/** The joint that moves an instance: its own, or (fastened rigidly) the one its parent moves on. */
export function jointOfInstance(kinematics: Kinematics | null, instance: string): MotionJoint | undefined {
  let current: string | undefined = instance;
  for (let depth = 0; current && depth < 64; depth++) {
    const joint = kinematics?.joints.find((item) => item.child === current);
    if (!joint) return undefined;
    if (joint.type !== 'rigid') return joint;
    current = joint.parent;
  }
  return undefined;
}

/** Every instance a joint moves, directly or through the joints below it. */
export function movedBy(kinematics: Kinematics, jointName: string): string[] {
  const joint = kinematics.joints.find((item) => item.name === jointName);
  if (!joint) return [];
  const out = [joint.child];
  for (let i = 0; i < out.length; i++) for (const below of kinematics.joints) if (below.parent === out[i] && !out.includes(below.child)) out.push(below.child);
  return out;
}

/** The value's unit for display. */
export const unitOf = (joint: Pick<MotionJoint, 'type'>) => (turns(joint) ? '°' : 'mm');

/** The checked collisions at a drive value: spans are sampled, so a value within half a step of one counts. */
export function collisionsAt(drive: MotionDrive | undefined, value: number): Collision[] {
  const check = drive?.check;
  const range = drive?.range;
  if (!check || !range || check.clear) return [];
  const half = (range[1] - range[0]) / Math.max(check.of - 1, 1) / 2;
  return check.collisions.filter((hit) => hit.spans.some(([low, high]) => value >= low - half && value <= high + half));
}

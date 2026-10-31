/**
 * The mechanism's live pose in the viewer: joint and coupling values, the playing drive and the
 * selected joint. Kept apart from the document store: moving a joint is viewing, not editing (the
 * code's `value=` is the pose a build starts from).
 */
import { create } from 'zustand';
import {
  animationValues, clampCoupling, clampSlide, clampValue, driveValue, effectivePose, EXPLODE_KEY, explodeKey, gearsOf, initialCoupled, initialPose, setPreviewExplode, turns,
  withMode, type Kinematics, type MotionAnimation, type MotionExplode, type MotionJoint, type Pose,
} from './kinematics';

interface MotionState {
  /** The build this pose belongs to; a new build starts from its own code's pose. */
  build: string | null;
  /** The build's kinematics as written, every limit the code's own. */
  built: Kinematics | null;
  /** The selected design.mode (null: the code's own limits). */
  mode: string | null;
  /** The build's kinematics in the selected mode: what every slider, clamp and saturation uses. */
  kinematics: Kinematics | null;
  /** Each joint's own position, before its couplings. */
  own: Pose;
  /** Each coupling's value. */
  coupled: Record<string, number>;
  /** Where every joint is: its own position plus its couplings. What the viewer shows. */
  pose: Pose;
  /** The driven joint or coupling while a drive plays. */
  playing: string | null;
  playStart: { at: number; value: number } | null;
  speedScale: number;
  /** The joint (or coupling) shown in Properties and drawn in the viewport. */
  active: string | null;
  /**
   * The animation or explode in the timeline strip (they share one set of names), its playhead (seconds) and, while it
   * plays, when and where it started.
   */
  clip: string | null;
  clipTime: number;
  clipStart: { at: number; from: number } | null;
  /** The explode the Explode steps tool is editing, played as it stands before it's written to main.py. */
  draft: MotionExplode | null;
  /** Dashed lines from where each exploded part sits to where it is now. */
  trails: boolean;
}

export const useMotion = create<MotionState>(() => ({
  build: null, built: null, mode: null, kinematics: null, own: {}, coupled: {}, pose: {}, playing: null, playStart: null, speedScale: 1, active: null,
  clip: null, clipTime: 0, clipStart: null, draft: null, trails: false,
}));

const set = useMotion.setState;
const get = useMotion.getState;

/** A new own pose and coupling values, with the live pose they make. */
function moved(own: Pose, coupled: Record<string, number>, extra: Partial<MotionState> = {}) {
  const { kinematics } = get();
  set({ own, coupled, pose: kinematics ? effectivePose(kinematics, own, coupled) : {}, ...extra });
}

const signature = (kinematics: Kinematics) => JSON.stringify([kinematics.joints.map((j) => [j.name, j.type, j.parent, j.child]),
  (kinematics.couplings ?? []).map((c) => [c.name, c.gears])]);

/** Called when the displayed build changes. Keeps the pose when the joints and couplings are the same ones. */
export function loadKinematics(build: string | null, built: Kinematics | null) {
  const state = get();
  if (state.build === build) return;
  // The selected mode stays while the new build still has it.
  const mode = state.mode && built?.modes?.some((item) => item.name === state.mode) ? state.mode : null;
  const kinematics = built && withMode(built, mode);
  const same = !!kinematics && !!state.kinematics && signature(kinematics) === signature(state.kinematics);
  const own = kinematics ? (same ? keep(state.own, kinematics) : initialPose(kinematics)) : {};
  const coupled = kinematics ? (same ? keepCoupled(state.coupled, kinematics) : initialCoupled(kinematics)) : {};
  const names = [...(kinematics?.animations ?? []), ...(kinematics?.explodes ?? []), ...(state.draft ? [state.draft] : [])].map((item) => item.name);
  const clip = state.clip && names.includes(state.clip) ? state.clip : names[0] ?? null;
  set({ build, built, mode, kinematics, own, coupled, pose: kinematics ? effectivePose(kinematics, own, coupled) : {},
    playing: same ? state.playing : null, playStart: same ? state.playStart : null,
    active: kinematics && isTarget(kinematics, state.active) ? state.active : null,
    clip, clipTime: clip === state.clip ? state.clipTime : 0, clipStart: same && clip === state.clip ? state.clipStart : null });
  // A kept clip shows its playhead's pose with the new build's values.
  if (clip && clip === state.clip && !(same && state.clipStart)) seek(get().clipTime);
  if (get().playing || get().clipStart) run();
}

const isTarget = (kinematics: Kinematics, name: string | null) =>
  !!name && (kinematics.joints.some((j) => j.name === name) || !!kinematics.couplings?.some((c) => c.name === name));

function keep(pose: Pose, kinematics: Kinematics): Pose {
  const fresh = initialPose(kinematics);
  for (const joint of kinematics.joints) {
    const old = pose[joint.name];
    if (old) fresh[joint.name] = { value: clampValue(joint, old.value), slide: clampSlide(joint, old.slide) };
  }
  return fresh;
}

function keepCoupled(coupled: Record<string, number>, kinematics: Kinematics): Record<string, number> {
  const fresh = initialCoupled(kinematics);
  for (const coupling of kinematics.couplings ?? []) if (coupling.name in coupled) fresh[coupling.name] = clampCoupling(coupling, coupled[coupling.name]);
  return fresh;
}

/**
 * Selects a design.mode (null: the code's own limits) without a rebuild: every joint and coupling takes that mode's
 * limits and bounds, and the live pose is held within them. Drives and animations switch to their own mode as they play.
 */
export function setMode(mode: string | null) {
  const { built, own, coupled } = get();
  if (!built) return;
  const next = mode && built.modes?.some((item) => item.name === mode) ? mode : null;
  if (next === get().mode) return;
  const kinematics = withMode(built, next);
  const exploded = Object.fromEntries(Object.entries(own).filter(([key]) => key.startsWith(EXPLODE_KEY)));
  set({ mode: next, kinematics });
  moved({ ...keep(own, kinematics), ...exploded }, keepCoupled(coupled, kinematics));
}

/** The change from `current` to `target`, the short way round for a joint that turns freely. */
function delta(joint: MotionJoint, current: number, target: number) {
  const change = target - current;
  return turns(joint) && !joint.limits ? ((((change + 180) % 360) + 360) % 360) - 180 : change;
}

/**
 * Moves a joint to `change` (its live position). A motion geared by exactly one coupling back-drives
 * it: the coupling moves by the difference over the ratio (within its bounds), so every joint it
 * gears follows. A motion geared by two or more couplings moves on its own, unless its joint is a follower
 * (`follow=True`): that moves only through its couplings, so then nothing changes.
 */
export function setJoint(name: string, change: { value?: number; slide?: number }) {
  const { kinematics, own, coupled, pose, playing } = get();
  const joint = kinematics?.joints.find((item) => item.name === name);
  if (!kinematics || !joint) return;
  const mine = own[name] ?? { value: joint.value, slide: joint.slide ?? 0 };
  const live = pose[name] ?? mine;
  const nextOwn = { ...mine };
  const nextCoupled = { ...coupled };
  let stopped = playing === name;
  // `turn` is a joint's main motion (a slider's travel too); `travel` is a cylindrical joint's sliding.
  for (const [part, target, current] of [['turn', change.value, live.value], ['travel', change.slide, live.slide]] as const) {
    if (target === undefined || (part === 'travel' && joint.type !== 'cylindrical')) continue;
    const clamped = part === 'turn' ? clampValue(joint, target) : clampSlide(joint, target);
    const gears = gearsOf(kinematics, joint, part);
    if (gears.length === 1) {
      const { coupling, ratio } = gears[0];
      const now = coupled[coupling.name] ?? coupling.value;
      nextCoupled[coupling.name] = clampCoupling(coupling, now + delta(joint, current, clamped) / ratio);
      if (playing === coupling.name) stopped = true;
    } else if (joint.follows) continue;
    else if (part === 'turn') nextOwn.value = gears.length ? mine.value + delta(joint, current, clamped) : clamped;
    else nextOwn.slide = gears.length ? mine.slide + (clamped - current) : clamped;
  }
  // Dragging what a drive moves takes it over from the drive; any hand movement pauses an animation.
  moved({ ...own, [name]: nextOwn }, nextCoupled, { clipStart: null, ...(stopped ? { playing: null, playStart: null } : {}) });
}

/** Sets a coupling's value (within its bounds); every joint it gears follows. */
export function setCoupling(name: string, value: number) {
  const { kinematics, own, coupled, playing } = get();
  const coupling = kinematics?.couplings?.find((item) => item.name === name);
  if (!coupling) return;
  moved(own, { ...coupled, [name]: clampCoupling(coupling, value) }, { clipStart: null, ...(playing === name ? { playing: null, playStart: null } : {}) });
}

/**
 * Shows joints' own positions and couplings' values as they are, stopping whatever plays: presentation view's player.
 * `clip` and `clipTime` keep the timeline's playhead with it.
 */
export function showValues(own: Pose, coupled: Record<string, number>, extra: { clip?: string; clipTime?: number } = {}) {
  moved(own, coupled, { playing: null, playStart: null, clipStart: null, ...extra });
}

export function applyPose(name: string) {
  const values = get().kinematics?.poses[name];
  if (!values) return;
  setMode(get().kinematics?.pose_modes?.[name] ?? null);   // A pose is in its own mode.
  applyValues(values);
}

/** The joints' own positions without an explode moment: moving the mechanism by hand or to a pose collapses an explode. */
const unexploded = (own: Pose): Pose => Object.fromEntries(Object.entries(own).filter(([key]) => !key.startsWith(EXPLODE_KEY)));

/** Moves joints and couplings to `values` (a pose's, or a collision study's pose), stopping whatever plays. */
export function applyValues(values: Record<string, number>) {
  const { kinematics, own, coupled } = get();
  if (!kinematics) return;
  const nextOwn = unexploded(own);
  const nextCoupled = { ...coupled };
  for (const [target, value] of Object.entries(values)) {
    const joint = kinematics.joints.find((j) => j.name === target);
    const coupling = kinematics.couplings?.find((c) => c.name === target);
    if (joint?.follows) continue;  // It moves only through its couplings.
    if (joint) nextOwn[target] = { ...(nextOwn[target] ?? { slide: joint.slide ?? 0 }), value: clampValue(joint, value) };
    else if (coupling) nextCoupled[target] = clampCoupling(coupling, value);
  }
  moved(nextOwn, nextCoupled, { playing: null, playStart: null, clipStart: null });
}

/** The code's pose (every joint and coupling at its `value=`). */
export function resetPose() {
  const { kinematics } = get();
  moved(kinematics ? initialPose(kinematics) : {}, kinematics ? initialCoupled(kinematics) : {}, { playing: null, playStart: null, clipStart: null, clipTime: 0 });
}

/** Where a drive's target is now: a coupling's value or a joint's own value. */
function startOf(target: string): number | null {
  const { kinematics, own, coupled } = get();
  const coupling = kinematics?.couplings?.find((c) => c.name === target);
  if (coupling) return coupled[target] ?? coupling.value;
  const joint = kinematics?.joints.find((j) => j.name === target);
  return joint ? own[target]?.value ?? joint.value : null;
}

/**
 * Playback runs on its own animation-frame loop while a motor or animation plays: each tick moves the pose
 * and the viewport renders because the pose changed. (Ticking from the render loop itself could stall:
 * a frame that didn't render never asked for the next.)
 */
let frame = 0;
function run() {
  if (frame || typeof requestAnimationFrame === 'undefined') return;
  const step = (now: number) => {
    frame = 0;
    const { playing, clipStart } = get();
    if (!playing && !clipStart) return;
    tick(now);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

export function play(target: string) {
  const drive = get().kinematics?.drives.find((d) => d.joint === target);
  if (!drive) return;
  setMode(drive.mode ?? null);   // A drive sweeps in its own mode.
  const start = startOf(target);
  if (start === null) return;
  set({ playing: target, playStart: { at: performance.now(), value: start }, clipStart: null });
  run();
}

export function stop() {
  set({ playing: null, playStart: null, clipStart: null });
}

/* ───────── Animations (design.animation) and explodes (design.explode): a playhead over the timeline ───────── */

/** The timeline's animation (or the one named), if it is an animation. */
export const clipOf = (name: string | null = get().clip): MotionAnimation | undefined =>
  (name ? get().kinematics?.animations?.find((a) => a.name === name) : undefined);

/** The timeline's explode (or the one named), if it is an explode: the Explode steps tool's draft first. */
export function explodeOf(name: string | null = get().clip): MotionExplode | undefined {
  if (!name) return undefined;
  const { draft, kinematics } = get();
  return draft?.name === name ? draft : kinematics?.explodes?.find((item) => item.name === name);
}

/** What the timeline plays under a name: an animation or an explode, with its length and whether it loops. */
const entryOf = (name: string | null): MotionAnimation | MotionExplode | undefined => clipOf(name) ?? explodeOf(name);

/** Puts every target where the animation has it at `t`: joints' own values and couplings' values. */
function show(animation: MotionAnimation, t: number, extra: Partial<MotionState> = {}) {
  setMode(animation.mode ?? null);   // The timeline plays an animation in its own mode.
  const { kinematics, own, coupled } = get();
  if (!kinematics) return;
  const values = animationValues(animation, t);
  const nextOwn = unexploded(own);
  const nextCoupled = { ...coupled };
  for (const [target, value] of Object.entries(values)) {
    const joint = kinematics.joints.find((j) => j.name === target);
    if (joint) nextOwn[target] = { ...(nextOwn[target] ?? { slide: joint.slide ?? 0 }), value };
    else nextCoupled[target] = value;
  }
  moved(nextOwn, nextCoupled, { clipTime: t, ...extra });
}

/** Puts the parts where the explode has them at `t`: the code's pose, with the explode's moment in it. */
function showExplode(explode: MotionExplode, t: number, extra: Partial<MotionState> = {}) {
  const { kinematics } = get();
  if (!kinematics) return;
  moved({ ...initialPose(kinematics), [explodeKey(explode.name)]: { value: t, slide: 0 } }, initialCoupled(kinematics), { clipTime: t, ...extra });
}

/** Shows the animation or explode `name` at `t` seconds. */
function showEntry(name: string | null, t: number, extra: Partial<MotionState> = {}) {
  const animation = clipOf(name);
  if (animation) { show(animation, t, extra); return; }
  const explode = explodeOf(name);
  if (explode) showExplode(explode, t, extra);
}

/** Chooses the animation or explode in the timeline and shows its start (or `t`). */
export function selectClip(name: string | null, t = 0) {
  set({ clip: name, clipStart: null, playing: null, playStart: null });
  const entry = entryOf(name);
  if (entry) showEntry(name, Math.min(Math.max(t, 0), entry.duration));
  else set({ clipTime: 0 });
}

/** Moves the playhead (and pauses). */
export function seek(t: number) {
  const name = get().clip;
  const entry = entryOf(name);
  if (!entry) return;
  showEntry(name, Math.min(Math.max(t, 0), entry.duration), { clipStart: null, playing: null, playStart: null });
}

export function playClip(name?: string) {
  const target = name ?? get().clip;
  const entry = entryOf(target);
  if (!entry) return;
  const { clip, clipTime } = get();
  // Play from the playhead, or from the start when it sits at the end.
  const from = target === clip && clipTime < entry.duration - 1e-6 ? clipTime : 0;
  set({ clip: target, clipStart: { at: performance.now(), from }, playing: null, playStart: null });
  showEntry(target, from);
  run();
}

/** Shows the explode the Explode steps tool is editing (null: back to what main.py has), keeping the playhead. */
export function setDraft(draft: MotionExplode | null) {
  const { clip, clipTime, kinematics } = get();
  setPreviewExplode(draft);
  if (draft) {
    set({ draft, clip: draft.name, clipStart: null, playing: null, playStart: null });
    showExplode(draft, Math.min(clipTime, draft.duration));
    return;
  }
  set({ draft: null });
  const names = [...(kinematics?.animations ?? []), ...(kinematics?.explodes ?? [])].map((item) => item.name);
  selectClip(clip && names.includes(clip) ? clip : names[0] ?? null, clipTime);
  if (!get().clip && kinematics) moved(initialPose(kinematics), initialCoupled(kinematics));
}

export function setTrails(trails: boolean) {
  set({ trails });
}

export function pauseClip() {
  set({ clipStart: null });
}

export function toggleClip() {
  if (get().clipStart) pauseClip();
  else playClip();
}

export function togglePlay(target?: string) {
  const { playing, kinematics } = get();
  if (playing) { stop(); return; }
  const next = target ?? kinematics?.drives[0]?.joint;
  if (next) play(next);
}

export function setSpeedScale(speedScale: number) {
  const { playing, clipStart, clipTime } = get();
  // Restart the sweep (or the animation) from where it is, so nothing jumps.
  const start = playing ? startOf(playing) : null;
  set({ speedScale, ...(playing && start !== null ? { playStart: { at: performance.now(), value: start } } : {}),
    ...(clipStart ? { clipStart: { at: performance.now(), from: clipTime } } : {}) });
}

export function selectJoint(active: string | null) {
  set({ active });
}

/** Advances the playing animation or explode to `now` (ms): looping, or stopping at its end. */
function tickClip(now: number): boolean {
  const { clipStart, speedScale, clip } = get();
  const entry = entryOf(clip);
  if (!clipStart || !entry) return false;
  // A frame can carry a timestamp from just before playback started.
  let t = clipStart.from + (Math.max(0, now - clipStart.at) / 1000) * speedScale;
  if (t >= entry.duration) {
    if (entry.loop) t %= entry.duration;
    else { showEntry(clip, entry.duration, { clipStart: null }); return true; }
  }
  showEntry(clip, t);
  return true;
}

/** Advances the playing drive or animation to `now` (ms). Returns whether anything moved. */
export function tick(now: number): boolean {
  if (get().clipStart) return tickClip(now);
  const { playing, playStart, kinematics, own, coupled, speedScale } = get();
  if (!playing || !playStart || !kinematics) return false;
  const drive = kinematics.drives.find((d) => d.joint === playing);
  const coupling = kinematics.couplings?.find((c) => c.name === playing);
  const joint = kinematics.joints.find((j) => j.name === playing);
  if (!drive || (!coupling && !joint)) { stop(); return false; }
  const t = (now - playStart.at) / 1000;
  if (coupling) {
    // A coupling sweeps its range back and forth, or turns on without one (no wrap: its ratios needn't be whole turns).
    const range = drive.range ?? coupling.bounds;
    const value = range ? driveValue({ ...drive, range }, { type: 'slider', limits: range } as MotionJoint, playStart.value, t, speedScale)
      : playStart.value + drive.speed * speedScale * t;
    moved(own, { ...coupled, [playing]: value });
    return true;
  }
  const value = driveValue(drive, joint!, playStart.value, t, speedScale);
  moved({ ...own, [playing]: { ...(own[playing] ?? { slide: joint!.slide ?? 0 }), value } }, coupled);
  return true;
}

/**
 * Presentation view (docs/UI_LAYOUT.md): the 3D view alone, full window and full screen, with a small player for the
 * design's motion that fades when the pointer rests. Entering it clears the selection and hover (they come back on
 * exit), closes the open tool and takes over playback; Esc, Exit or the command leave it, and so does the browser
 * leaving full screen on its own.
 */
import { create } from 'zustand';
import { get as getApp, set as setApp, type Pick } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { closeSheet } from '@/phone/state';
import { showValues, stop, useMotion } from '@/motion/state';
import { allTakes, currentTake, liveBase, type Base, type Take } from '@/motion/takes';

interface PresentState {
  active: boolean;
  /** The pointer moved lately: the bar and cursor show. */
  awake: boolean;
  /** The take on the player (`Take.key`), its time and whether it plays. */
  take: string | null;
  t: number;
  playing: boolean;
  loop: boolean;
  /** Shown on the canvas (and in videos). */
  cube: boolean;
  triad: boolean;
  /** A video is being recorded: leaving full screen waits for it. */
  recording: boolean;
}

export const usePresent = create<PresentState>(() => ({
  active: false, awake: true, take: null, t: 0, playing: false, loop: true, cube: false, triad: false, recording: false,
}));

const set = usePresent.setState;
const get = usePresent.getState;

export const presenting = () => get().active;

/** What the person had selected, given back on exit (same build only). */
let stash: { selection: Pick[]; build: string | null } | null = null;
/** Full screen came with presentation view (or was already on): leaving it leaves presentation view. */
let fullscreenTied = false;
let ownFullscreen = false;
/** Joint positions the player moves from: the live pose when the take was chosen. */
let base: Base | null = null;

/** The design's takes; the player's one. */
export const presentTakes = (): Take[] => allTakes(useMotion.getState().kinematics);
export const presentTake = (): Take | null => {
  const key = get().take;
  const takes = presentTakes();
  return takes.find((take) => take.key === key) ?? takes[0] ?? null;
};

export function enterPresentation() {
  if (get().active) return;
  const app = getApp();
  stash = { selection: app.selection, build: app.displayed?.id ?? null };
  setApp({ selection: [], hover: null, hoverAlso: [], contextMenu: null, pickList: null, measurePicks: [], ...(app.tool === 'explode' ? {} : { tool: 'select' }) });
  closeSheet();
  // Take over what the Motion tab was playing, from where it is.
  const motion = useMotion.getState();
  const takes = allTakes(motion.kinematics);
  const shown = motion.playing ? takes.find((take) => take.key === `motor:${motion.playing}`)
    : motion.clip ? takes.find((take) => take.key === `animation:${motion.clip}` || take.key === `explode:${motion.clip}`) : null;
  const take = shown ?? currentTake(motion.kinematics);
  const wasPlaying = !!(motion.clipStart || motion.playing);
  stop();
  base = liveBase();
  set({ active: true, awake: true, take: take?.key ?? null, t: take && take.kind !== 'motor' ? motion.clipTime : 0, playing: false, loop: take?.loop ?? true });
  if (wasPlaying && take) play();
  document.documentElement.dataset.presenting = '';
  viewer.presenting = true;
  fullscreenTied = !!document.fullscreenElement;
  ownFullscreen = false;
  if (!document.fullscreenElement && document.fullscreenEnabled) {
    fullscreenTied = true;
    ownFullscreen = true;
    document.documentElement.requestFullscreen().catch(() => { fullscreenTied = false; ownFullscreen = false; });
  }
  viewer.invalidate();
}

export function exitPresentation() {
  if (!get().active) return;
  pause();
  set({ active: false, awake: true });
  delete document.documentElement.dataset.presenting;
  viewer.presenting = false;
  if (stash && stash.build === (getApp().displayed?.id ?? null)) setApp({ selection: stash.selection });
  stash = null;
  if (ownFullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  fullscreenTied = false;
  ownFullscreen = false;
  viewer.invalidate();
}

export const togglePresentation = () => (get().active ? exitPresentation() : enterPresentation());

/** Leaving full screen (Esc, F11, the browser's own controls) leaves presentation view too. */
export function installPresentationSync(): () => void {
  const sync = () => {
    if (document.fullscreenElement || !fullscreenTied || !get().active) return;
    if (get().recording) exitAfterRecording = true;
    else exitPresentation();
  };
  document.addEventListener('fullscreenchange', sync);
  return () => document.removeEventListener('fullscreenchange', sync);
}

let exitAfterRecording = false;

/** While a video records the view stays as it is (its size is the video's framing); a full-screen exit meanwhile waits. */
export function setRecording(recording: boolean) {
  // Frames set the pose themselves: nothing else may move it meanwhile.
  if (recording) { pause(); stop(); }
  set({ recording });
  if (!recording && exitAfterRecording) { exitAfterRecording = false; exitPresentation(); }
}

/* ───────── The player ───────── */

function show(take: Take, t: number) {
  base ??= liveBase();
  const { own, coupled } = take.values(t, base);
  showValues(own, coupled, take.kind !== 'motor' ? { clip: take.name, clipTime: t } : {});
}

let frame = 0;
let last = 0;

function tick(now: number) {
  frame = 0;
  const state = get();
  const take = presentTake();
  if (!state.active || !state.playing || !take) return;
  const step = last ? Math.min(0.25, (now - last) / 1000) : 0;
  last = now;
  let t = state.t + step * useMotion.getState().speedScale;
  if (t >= take.duration) {
    if (!state.loop) { show(take, take.duration); set({ t: take.duration, playing: false }); return; }
    t %= take.duration;
  }
  show(take, t);
  set({ t });
  frame = requestAnimationFrame(tick);
}

export function play() {
  const take = presentTake();
  if (!take) return;
  // From the start once it has played to its end.
  if (get().t >= take.duration - 1e-6) set({ t: 0 });
  set({ playing: true });
  last = 0;
  if (!frame) frame = requestAnimationFrame(tick);
}

export function pause() {
  set({ playing: false });
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

export const togglePlaying = () => (get().playing ? pause() : play());

/** Moves the player to `t` seconds (it keeps playing from there if it was). */
export function seekTo(t: number) {
  const take = presentTake();
  if (!take) return;
  const at = Math.min(Math.max(t, 0), take.duration);
  set({ t: at });
  show(take, at);
  last = 0;
}

/** Puts another take on the player, at its start, from the pose shown now. */
export function chooseTake(key: string) {
  const playing = get().playing;
  pause();
  base = liveBase();
  const take = presentTakes().find((item) => item.key === key);
  set({ take: key, t: 0, loop: take?.loop ?? true });
  if (take) show(take, 0);
  if (playing) play();
}

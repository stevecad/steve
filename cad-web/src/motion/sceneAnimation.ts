/**
 * A Blender scene's animation in the Animation tab: the preview's own motion (ModelRuntime.mixer) played, scrubbed,
 * stepped and looped in the view at a chosen speed, the shot seen through the scene's camera (an inset, or the whole
 * view), and the full build's rendered video (Render video starts it without holding the app; Rendered plays it). The
 * preview is made seconds after a save; the video takes the full build's render.
 */
import { create } from 'zustand';
import { Api, buildProgress } from '@/lib/api';
import type { BuildProgress } from '@/lib/buildProgress';
import { get as app, toast } from '@/state/store';
import { stored } from '@/state/design';
import { withWorkspace } from '@/teams/current';
import { viewer } from '@/viewport/viewer';

interface Render {
  id: string;
  status: string;
  progress?: BuildProgress | null;
  /** The finished video (the full build's animation artifact). */
  video?: string | null;
}

interface SceneAnimationState {
  time: number;
  /** Playing since `at` (performance.now()) from `from` seconds; null when paused. */
  playing: { at: number; from: number } | null;
  loop: boolean;
  /** Playback speed: 1 is real time. */
  speed: number;
  /** The shot through the scene's camera, as an inset over the view. */
  shot: boolean;
  /** The whole view through the scene's camera, instead of the inset. */
  through: boolean;
  /** The rendered video instead of the live view. */
  rendered: boolean;
  /** The full build rendering (or rendered) from this tab. */
  render: Render | null;
}

export const useSceneAnimation = create<SceneAnimationState>(() => ({
  time: 0, playing: null, loop: true, speed: 1, shot: true, through: false, rendered: false, render: null }));
const { getState: get, setState: set } = useSceneAnimation;

export const sceneDuration = () => viewer.model?.animationDuration ?? 0;
export const sceneFps = () => (app().displayed?.metadata as { scene?: { fps?: number } } | null | undefined)?.scene?.fps || 24;

/** Shows the model at the strip's time: called when time moves and when a new build's model replaces the last. */
export function applySceneTime() {
  viewer.model?.setAnimationTime(get().time);
  viewer.invalidate();
}

export function seekScene(seconds: number) {
  const time = Math.min(Math.max(seconds, 0), sceneDuration());
  set({ time, playing: get().playing ? { at: performance.now(), from: time } : null });
  applySceneTime();
}

/** One frame back or forward (pauses). */
export function stepScene(frames: number) {
  pauseScene();
  const fps = sceneFps();
  seekScene((Math.round(get().time * fps) + frames) / fps);
}

let frame = 0;

function tick() {
  frame = 0;
  const { playing, loop, speed } = get();
  const duration = sceneDuration();
  if (!playing || duration <= 0) return;
  let time = playing.from + (performance.now() - playing.at) / 1000 * speed;
  if (time >= duration) {
    if (loop) time %= duration;
    else {
      set({ time: duration, playing: null });
      applySceneTime();
      return;
    }
  }
  set({ time });
  applySceneTime();
  frame = requestAnimationFrame(tick);
}

export function playScene() {
  const duration = sceneDuration();
  if (duration <= 0) return;
  const from = get().time >= duration - 1e-3 ? 0 : get().time;   // played to the end: from the start again
  set({ playing: { at: performance.now(), from }, rendered: false });
  if (!frame) frame = requestAnimationFrame(tick);
}

export function pauseScene() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  set({ playing: null });
}

export const toggleScene = () => (get().playing ? pauseScene() : playScene());
export const setSceneLoop = (loop: boolean) => set({ loop });
export function setSceneSpeed(speed: number) {
  const { playing, time } = get();
  set({ speed, playing: playing ? { at: performance.now(), from: time } : null });
}
export const setSceneShot = (shot: boolean) => { set({ shot, ...(shot ? { through: false } : {}) }); viewer.invalidate(); };
export const setSceneThrough = (through: boolean) => { set({ through, ...(through ? { rendered: false } : {}) }); viewer.invalidate(); };
export function setSceneRendered(rendered: boolean) {
  if (rendered) pauseScene();
  set({ rendered });
}

/** The scene's rendered video: the displayed full build's, or the one Render video made. */
export function sceneVideo(): string | null {
  const build = app().displayed;
  return (build?.mode === 'full' ? build.artifacts?.animation : null) ?? get().render?.video ?? null;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renders the scene's video: its full build (Cycles, every frame through the scene's camera), started and followed
 *  here without holding the app; an identical render already made is answered at once (the build cache). */
export async function renderVideo() {
  const { doc, displayed } = app();
  if (!displayed || get().render?.status === 'queued' || get().render?.status === 'running') return;
  // The displayed build's own source (a Blender scene's links included), as its preview was built.
  const source = stored(doc as Parameters<typeof stored>[0]);
  let build;
  try {
    build = await Api.submit({ kind: displayed.kind, name: doc.name || displayed.name, code: displayed.code ?? source.code,
      files: displayed.files ?? source.files, links: displayed.links ?? doc.links ?? {}, mode: 'full' });
  } catch (error) {
    toast('danger', 'Couldn’t start the render', (error as Error).message);
    return;
  }
  set({ render: { id: build.id, status: build.status } });
  if (build.status !== 'succeeded' && build.status !== 'failed') {
    toast('info', 'Rendering the animation', 'It renders every frame through the scene’s camera; keep working, the strip shows how far it is.');
  }
  while (build.status !== 'succeeded' && build.status !== 'failed') {
    await pause(500);
    if (get().render?.id !== build.id) return;   // another render replaced it
    try { build = await Api.build(build.id); } catch { continue; }
    set({ render: { id: build.id, status: build.status, progress: buildProgress(build) } });
  }
  if (build.status === 'failed') {
    set({ render: { id: build.id, status: 'failed' } });
    toast('danger', 'The render failed', (build.error ?? '').trim().split('\n').pop() || 'The full build failed.');
    return;
  }
  const video = build.artifacts?.animation ?? null;
  set({ render: { id: build.id, status: 'succeeded', video } });
  if (video) {
    toast('success', 'The animation is rendered', 'Rendered plays it; Download video saves it.');
  } else {
    toast('warning', 'No video', 'The scene rendered, but it has no animation through a camera (scene.camera) to make a video of.');
  }
}

export async function stopSceneRender() {
  const render=get().render;
  if(!render||!['queued','running'].includes(render.status))return;
  try {await Api.stopBuild(render.id);} catch(error) {toast('warning','Could not stop render',(error as Error).message);}
}

/** Saves the rendered video (MP4). */
export function downloadVideo() {
  const video = sceneVideo();
  if (!video) return;
  const name = app().doc.name || 'animation';
  const link = document.createElement('a');
  link.href = withWorkspace(`${video}?name=${encodeURIComponent(name)}`);
  link.download = `${name.replace(/[^\w.-]+/g, '_')}.mp4`;
  link.click();
}

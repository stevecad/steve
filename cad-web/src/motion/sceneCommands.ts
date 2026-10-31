/**
 * The Animation tab's ribbon (an animated Blender scene): playback (play, the first and last frame, a frame back or
 * forward, loop, speed), the view (through the scene's camera, its inset, the rendered video), Render video, and the
 * exports. The scene's motion itself is its code's (main.py's key frames); these watch, check and render it.
 */
import { Square, Camera, Clapperboard, Download, Film, Gauge, PictureInPicture2, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID } from '@/ribbonPriority';
import { animationShown } from '@/state/designTab';
import type { AppState } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { downloadVideo, stopSceneRender, renderVideo, sceneDuration, sceneVideo, seekScene, setSceneLoop, setSceneRendered, setSceneShot, setSceneSpeed,
  setSceneThrough, stepScene, toggleScene, useSceneAnimation } from './sceneAnimation';

const scene = () => useSceneAnimation.getState();
const onTab = (state: AppState) => animationShown(state) || 'Open an animated Blender scene’s Animation tab.';
const moves = () => (sceneDuration() > 0 ? true : 'This build’s preview carries no motion: save the scene again.');
const camera = () => (viewer.model?.shotCamera ? true : 'The scene has no camera (scene.camera) to look through.');
const video = () => (sceneVideo() ? true : 'No rendered video yet: Render video makes it.');
const rendering = () => ['queued', 'running'].includes(scene().render?.status ?? '');
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

const speed = (value: number): Command => ({
  id: `scene.speed.${value}`, label: `${value}× speed`, icon: Gauge, category: 'Animation',
  description: value === 1 ? 'Play in real time.' : `Play at ${value} times real time.`,
  run: () => setSceneSpeed(value), enabled: onTab, active: () => scene().speed === value,
});

export const sceneCommands: Command[] = [
  { id: 'scene.play', label: 'Play', short: 'Play', icon: Play, category: 'Animation',
    description: 'Play the scene’s animation in the view, from its preview; click again to pause.',
    run: toggleScene, enabled: all(onTab, moves), active: () => !!scene().playing },
  { id: 'scene.start', label: 'First frame', short: 'Start', icon: SkipBack, category: 'Animation', description: 'Go to the first frame.',
    run: () => seekScene(0), enabled: all(onTab, moves) },
  { id: 'scene.back', label: 'Previous frame', short: 'Back', icon: StepBack, category: 'Animation', description: 'One frame back.',
    run: () => stepScene(-1), enabled: all(onTab, moves) },
  { id: 'scene.forward', label: 'Next frame', short: 'Forward', icon: StepForward, category: 'Animation', description: 'One frame forward.',
    run: () => stepScene(1), enabled: all(onTab, moves) },
  { id: 'scene.end', label: 'Last frame', short: 'End', icon: SkipForward, category: 'Animation', description: 'Go to the last frame.',
    run: () => seekScene(sceneDuration()), enabled: all(onTab, moves) },
  { id: 'scene.loop', label: 'Loop', short: 'Loop', icon: Repeat, category: 'Animation', description: 'Play it again from the start when it ends.',
    run: () => setSceneLoop(!scene().loop), enabled: onTab, active: () => scene().loop },
  speed(0.25), speed(0.5), speed(1), speed(2),
  { id: 'scene.camera', label: 'Camera view', short: 'Camera', icon: Camera, category: 'Animation',
    description: 'The whole view through the scene’s camera, as the render frames the shot; click again to orbit freely.',
    run: () => setSceneThrough(!scene().through), enabled: all(onTab, camera), active: () => scene().through },
  { id: 'scene.shot', label: 'Shot inset', short: 'Shot', icon: PictureInPicture2, category: 'Animation',
    description: 'The scene’s camera view in a corner of the view while you orbit.',
    run: () => setSceneShot(!scene().shot), enabled: all(onTab, camera), active: () => scene().shot && !scene().through },
  { id: 'scene.rendered', label: 'Rendered video', short: 'Rendered', icon: Film, category: 'Animation',
    description: 'Play the rendered video in place of the live view.',
    run: () => setSceneRendered(!scene().rendered), enabled: all(onTab, video), active: () => scene().rendered },
  { id: 'scene.render', label: 'Render video', short: 'Render', icon: Clapperboard, category: 'Animation',
    description: 'Render every frame through the scene’s camera with Cycles: a video of the animation. It can take a while; keep '
      + 'working, the strip shows how far it is. An identical render already made comes back at once.',
    run: () => { void renderVideo(); }, enabled: all(onTab, camera, () => (rendering() ? 'Rendering: the strip shows how far it is.' : true)),
    active: () => rendering() },
  { id: 'scene.cancelRender', label: 'Stop rendering', short: 'Stop', icon: Square, category: 'Animation', run: () => {void stopSceneRender();}, enabled: () => rendering() || 'No render is running.' },
  { id: 'scene.downloadVideo', label: 'Download video', short: 'Video', icon: Download, category: 'Animation',
    description: 'Save the rendered video (MP4).', run: downloadVideo, enabled: all(onTab, video) },
];

export const sceneRibbon: RibbonGroup[] = [
  { title: 'Playback', priority: KEEP, items: ['scene.play', 'scene.start', 'scene.back', 'scene.forward', 'scene.end', 'scene.loop',
    { menu: 'scene-speed', label: 'Speed', icon: Gauge, items: ['scene.speed.0.25', 'scene.speed.0.5', 'scene.speed.1', 'scene.speed.2'] }] },
  { title: 'View', priority: HIGH, items: ['scene.camera', 'scene.shot', 'scene.rendered'] },
  { title: 'Render', priority: HIGH, items: ['scene.render', 'scene.cancelRender'] },
  { title: 'Export', priority: MID, items: ['scene.downloadVideo', 'export.blend'] },
];

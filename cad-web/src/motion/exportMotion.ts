/**
 * Sharing motion: an animated GLB (the shown animation or explode, or one cycle of a motor, sampled into glTF node
 * animation channels on the moving parts), and a live WebM recording of the viewport while it plays, for browsers
 * that can't encode video frame by frame (the video export, present/video, does that everywhere else).
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { get, toast } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { instanceMotions } from './kinematics';
import { nodeOfPath, posedLocals, restMatrix } from './PoseLayer';
import { playClip, play, stop, useMotion } from './state';
import { currentTake, type Take } from './takes';
import { MAX_SECONDS as MAX_VIDEO_SECONDS } from '@/present/video/plan';

const FPS = 30;
/** A backstop against a runaway export (a very slow motor's one turn), far past any sane clip. */
const MAX_SECONDS = MAX_VIDEO_SECONDS;

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const fileBase = () => (get().doc.name || 'design').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').toLowerCase() || 'design';

/** The design as glTF with the motion baked in: one position and rotation channel per moving part, at 30 frames a second. */
export async function exportAnimatedGlb(): Promise<Blob | null> {
  const model = viewer.model;
  const { kinematics } = useMotion.getState();
  if (!model || !kinematics) { toast('warning', 'Nothing to export', 'The design has no geometry yet.'); return null; }
  // The timeline's animation or explode, else the active (or first) motor over one cycle.
  const shot = currentTake(kinematics);
  if (!shot) { toast('warning', 'Nothing moves yet', 'Add a motor or an animation first.'); return null; }
  // Mark the moving instances on the live model so they can be found in the copy (an explode's by path, too).
  const movers = [...new Set([...kinematics.joints.map((joint) => joint.child), ...instanceMotions(kinematics, shot.pose(shot.duration)).keys()])];
  const originals = new Map<string, THREE.Object3D>();
  for (const instance of movers) {
    const id = nodeOfPath(model, instance);
    const object = id ? model.objects.get(id) : undefined;
    if (object && id) { object.userData.motionInstance = instance; originals.set(instance, object); }
  }
  const copy = model.content.clone(true);
  for (const object of originals.values()) delete object.userData.motionInstance;
  // Only the shaded faces travel: selection overlays, edge lines and points stay behind.
  const drop: THREE.Object3D[] = [];
  copy.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if ((mesh.isMesh && (!object.userData.face || object.userData.lazyFace)) || (object as THREE.Line).isLine || (object as THREE.Points).isPoints || object.type === 'LineSegments2') drop.push(object);
  });
  for (const object of drop) object.removeFromParent();
  const targets = new Map<string, THREE.Object3D>();
  copy.traverse((object) => { if (object.userData.motionInstance) targets.set(object.userData.motionInstance, object); });

  if (shot.duration > MAX_SECONDS) { toast('warning', 'This motion is too long to export', `${shot.name} runs ${Math.round(shot.duration)} s; the limit is ${MAX_SECONDS / 60} min.`); return null; }
  const frames = Math.max(2, Math.round(shot.duration * FPS) + 1);
  const times = new Float32Array(frames);
  const tracks = new Map<string, { position: number[]; quaternion: number[] }>();
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  for (let frame = 0; frame < frames; frame++) {
    const t = (frame / (frames - 1)) * shot.duration;
    times[frame] = t;
    // Each moved node's local matrix, as the viewport places it (a node inside a moved instance relative to it).
    const locals = new Map(posedLocals(model, kinematics, shot.pose(t)).map((item) => [item.path, item.local]));
    for (const [instance, original] of originals) {
      const local = locals.get(instance) ?? restMatrix(model, original);
      local.decompose(position, quaternion, scale);
      const track = tracks.get(instance) ?? { position: [], quaternion: [] };
      track.position.push(position.x, position.y, position.z);
      track.quaternion.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      tracks.set(instance, track);
    }
  }
  const keyframes: THREE.KeyframeTrack[] = [];
  for (const [instance, track] of tracks) {
    const target = targets.get(instance);
    if (!target) continue;
    // The static file shows the start of the motion.
    target.position.fromArray(track.position, 0);
    target.quaternion.fromArray(track.quaternion, 0);
    keyframes.push(new THREE.VectorKeyframeTrack(`${target.uuid}.position`, times, track.position));
    keyframes.push(new THREE.QuaternionKeyframeTrack(`${target.uuid}.quaternion`, times, track.quaternion));
  }
  if (!keyframes.length) { toast('warning', 'Nothing moves in this motion', 'Its joints don’t move any part.'); return null; }
  const clip = new THREE.AnimationClip(shot.name, shot.duration, keyframes);
  const scene = new THREE.Scene();
  scene.name = get().doc.name || 'design';
  // Preview meshes and motion channels use CAD millimetres. glTF uses metres;
  // convert at the copied root so both geometry and animated translations scale
  // together. The preview content is already in glTF's Y-up coordinate frame.
  copy.scale.multiplyScalar(0.001);
  scene.add(copy);
  const result = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [clip] });
  const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
  download(blob, `${fileBase()}-${shot.name}.glb`);
  toast('success', 'Exported an animated GLB', `${shot.name}: ${shot.duration.toFixed(1)} s, ${keyframes.length / 2} moving part${keyframes.length === 2 ? '' : 's'}. glTF viewers, PowerPoint and the web play it.`);
  return blob;
}

let recording: MediaRecorder | null = null;

/**
 * Records the viewport while `shot` plays once through, as WebM, in real time: for browsers without WebCodecs. Frames
 * the browser doesn't get to are lost, and the tab must stay in front.
 */
export async function recordLive(shot: Take): Promise<Blob | null> {
  if (recording) { recording.stop(); return null; }
  const canvas = document.querySelector<HTMLCanvasElement>('#viewport canvas');
  if (!canvas) { toast('warning', 'Nothing to record', 'Add a motor or an animation first.'); return null; }
  if (shot.duration > MAX_SECONDS) { toast('warning', 'This motion is too long to record', `${shot.name} runs ${Math.round(shot.duration)} s; the limit is ${MAX_SECONDS / 60} min.`); return null; }
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) { toast('warning', 'This browser can’t record', 'Use a current Chrome, Edge or Firefox.'); return null; }
  const type = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm';
  // The viewport renders on demand and may not keep its drawing buffer: copy each frame into a 2D canvas
  // right after it renders and record that (which also works without a GPU compositor).
  const scaleDown = Math.min(1, 1920 / Math.max(canvas.width, canvas.height));
  const copy = document.createElement('canvas');
  copy.width = Math.round(canvas.width * scaleDown);
  copy.height = Math.round(canvas.height * scaleDown);
  copy.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;opacity:0;pointer-events:none';
  document.body.appendChild(copy);
  const context = copy.getContext('2d')!;
  const paint = () => { context.fillStyle = getComputedStyle(document.body).backgroundColor || '#0d1114'; context.fillRect(0, 0, copy.width, copy.height); context.drawImage(canvas, 0, 0, copy.width, copy.height); };
  paint();
  const stream = copy.captureStream(FPS);
  let scene: THREE.Object3D | null = viewer.model?.root ?? null;
  while (scene?.parent) scene = scene.parent;
  const previous = scene?.onAfterRender;
  if (scene) scene.onAfterRender = (...args: Parameters<THREE.Object3D['onAfterRender']>) => { previous?.apply(scene, args); paint(); };
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const done = new Promise<Blob>((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
  recording = recorder;
  toast('info', 'Recording the viewport', `${shot.name}, ${shot.duration.toFixed(1)} s. Keep this tab in front.`);
  recorder.start(250);
  // The encoder can take a moment to start (much longer without a GPU): keep the view rendering until it
  // delivers frames, then play, so the motion isn't lost to a slow start.
  await new Promise<void>((resolve) => {
    const started = performance.now();
    const check = () => {
      if (chunks.some((chunk) => chunk.size > 64) || performance.now() - started > 6000) resolve();
      else { viewer.invalidate(); setTimeout(check, 50); }
    };
    check();
  });
  if (shot.kind !== 'motor') playClip(shot.name); else play(shot.name);
  const timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, (shot.duration + 0.3) * 1000);
  const blob = await done;
  clearTimeout(timer);
  recording = null;
  if (scene && previous) scene.onAfterRender = previous;
  stream.getTracks().forEach((item) => item.stop());
  copy.remove();
  stop();
  download(blob, `${fileBase()}-${shot.name}.webm`);
  toast('success', 'Saved a video', `${shot.name} as WebM, recorded live (${(blob.size / 1e6).toFixed(1)} MB). This browser can’t encode video frame by frame.`);
  return blob;
}

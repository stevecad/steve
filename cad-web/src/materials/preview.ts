import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createSurface, finishReady, studioEnvironment, surfaceKey, type Surface } from './render';

/**
 * Material swatches: one small offscreen renderer draws a 40 mm sphere in the studio environment in
 * front of a checker backdrop (so glass reads as glass), one image at a time, cached by look and size.
 * Pixels come back through a fence (readRenderTargetPixelsAsync), so a slow GPU — software GL in
 * CI — never blocks the page while a list of swatches renders.
 */

interface Job { key: string; surface: Surface; theme: 'dark' | 'light'; pixels: number; urgent: boolean; resolve: (url: string | null) => void }

interface Stage {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; sphere: THREE.Mesh; backdrop: THREE.MeshBasicMaterial;
  environment: Promise<THREE.Texture>; hdr: THREE.WebGLRenderTarget; ldr: THREE.WebGLRenderTarget; output: OutputPass; pixels: Uint8Array; out: HTMLCanvasElement;
}

/** Largest swatch in device pixels; each render uses a corner of fixed-size targets. */
const SIZE = 288;
const cache = new Map<string, string | null>();
const waiting = new Map<string, Promise<string | null>>();
/** Kept alive: disposing would free the shader program, and recompiling it costs seconds on software GL. */
const materials = new Map<string, THREE.MeshPhysicalMaterial>();
const queue: Job[] = [];
let stage: Stage | null | false = null;
let running = false;

function checker(theme: 'dark' | 'light') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const [a, b] = theme === 'dark' ? ['#2c3339', '#20262b'] : ['#e3e8eb', '#cfd6db'];
  context.fillStyle = a;
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = b;
  context.fillRect(0, 0, 32, 32);
  context.fillRect(32, 32, 32, 32);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  texture.magFilter = THREE.NearestFilter;
  texture.userData.theme = theme;
  return texture;
}

function createStage(): Stage | false {
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'low-power' });
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.02;
    // Program checks read the info log, which waits for the compile: a stall on software GL.
    renderer.debug.checkShaderErrors = false;
    renderer.setPixelRatio(1);
    renderer.setSize(1, 1, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 1, 1, 2000);
    camera.position.set(0, -190, 70);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(40, 72, 48));
    const backdrop = new THREE.MeshBasicMaterial({ map: checker('dark') });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), backdrop);
    wall.position.set(0, 160, 0);
    wall.lookAt(camera.position);
    const key = new THREE.DirectionalLight('#ffffff', 1.2);
    key.position.set(-120, -160, 200);
    scene.add(sphere, wall, key, new THREE.HemisphereLight('#f2f6ff', '#1c2126', 0.25));
    const environment = new Promise<THREE.Texture>((resolve) => {
      const ready = studioEnvironment(renderer, resolve, 256);
      if (ready) resolve(ready);
    });
    const hdr = new THREE.WebGLRenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, samples: 4 });
    const ldr = new THREE.WebGLRenderTarget(SIZE, SIZE);
    return { renderer, scene, camera, sphere, backdrop, environment, hdr, ldr, output: new OutputPass(), pixels: new Uint8Array(SIZE * SIZE * 4), out: document.createElement('canvas') };
  } catch {
    return false;
  }
}

async function render(stage: Stage, job: Job): Promise<string> {
  const environment = await stage.environment;
  await finishReady(job.surface.finish);
  const id = `${surfaceKey(job.surface)}|${job.theme}`;
  let material = materials.get(id);
  if (!material) materials.set(id, material = createSurface(job.surface, environment, job.theme, true));
  if (stage.backdrop.map!.userData.theme !== job.theme) {
    stage.backdrop.map!.dispose();
    stage.backdrop.map = checker(job.theme);
  }
  stage.sphere.material = material;
  // Compiles off the main thread where the GPU allows (KHR_parallel_shader_compile).
  await stage.renderer.compileAsync(stage.scene, stage.camera);
  const { renderer, hdr, ldr, pixels: buffer, out } = stage;
  const pixels = Math.min(job.pixels, SIZE);
  hdr.viewport.set(0, 0, pixels, pixels);
  hdr.scissor.set(0, 0, pixels, pixels);
  hdr.scissorTest = true;
  renderer.setRenderTarget(hdr);
  renderer.render(stage.scene, stage.camera);
  stage.output.render(renderer, ldr, hdr, 0, false);
  renderer.setRenderTarget(null);
  await renderer.readRenderTargetPixelsAsync(ldr, 0, 0, pixels, pixels, buffer);
  out.width = out.height = pixels;
  // A CPU canvas: encoding a GPU-backed one would wait on the GPU queue again.
  const context = out.getContext('2d', { willReadFrequently: true })!;
  const image = context.createImageData(pixels, pixels);
  // GL rows run bottom-up.
  for (let y = 0; y < pixels; y++) image.data.set(buffer.subarray((pixels - 1 - y) * pixels * 4, (pixels - y) * pixels * 4), y * pixels * 4);
  context.putImageData(image, 0, 0);
  return out.toDataURL('image/webp', 0.9);
}

/**
 * Swatches are handed over in batches (when the queue empties, at most every 1.5 s): each page update
 * re-composites what's under a dialog's blurred backdrop, and on software GL that stalls the GPU for seconds.
 */
async function drain() {
  if (running) return;
  running = true;
  let done: [Job, string | null][] = [];
  let flushed = performance.now();
  const flush = () => { done.forEach(([job, url]) => job.resolve(url)); done = []; flushed = performance.now(); };
  while (queue.length) {
    const job = queue.shift()!;
    stage ??= createStage();
    let url: string | null = null;
    if (stage) try { url = await render(stage, job); } catch { url = null; }
    cache.set(job.key, url);
    done.push([job, url]);
    if (job.urgent || performance.now() - flushed > 1500) flush();
    // Yield so scrolling and typing stay smooth while a page of swatches renders.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flush();
  running = false;
}

export const previewKey = (surface: Surface, theme: string, pixels: number) => `${surfaceKey(surface)}|${theme}|${pixels}`;
export const cachedPreview = (key: string) => cache.get(key);

/** A rendered swatch as a data URL; null when this browser can't render one. */
export function renderPreview(surface: Surface, theme: 'dark' | 'light', pixels: number, urgent = false): Promise<string | null> {
  const key = previewKey(surface, theme, pixels);
  if (cache.has(key)) return Promise.resolve(cache.get(key)!);
  let pending = waiting.get(key);
  if (!pending) {
    pending = new Promise<string | null>((resolve) => {
      const job = { key, surface, theme, pixels, urgent, resolve };
      if (urgent) queue.unshift(job); else queue.push(job);
    }).finally(() => waiting.delete(key));
    waiting.set(key, pending);
    void drain();
  }
  return pending;
}

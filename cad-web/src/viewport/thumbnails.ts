import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Build, Kind } from '@/lib/api';
import type { Theme } from '@/state/store';
import { ModelRuntime } from './model';
import { VIEW_DIRECTIONS } from './viewer';
import { withWorkspace } from '@/teams/current';

/**
 * Design thumbnails, rendered in the browser from the preview GLB that every successful build
 * has, with the viewport's studio look (Scene.tsx lighting, ModelRuntime materials and edges,
 * the ground shadow), on a transparent background. One offscreen renderer draws them one at a
 * time; the PNG/WebP is kept in IndexedDB by build ID. Builds never change, so nothing goes stale,
 * and a thumbnail never costs a kernel run.
 */

export type Thumbnail =
  | { status: 'ready'; url: string; flat?: boolean }
  | { status: 'broken' }   // the geometry is gone or unreadable: regenerating fixes it
  | { status: 'empty' }    // a build without solids
  | { status: 'failed' };  // offline or the server erred; tried again next time

const LOOK = 2;            // Bump when the rendering changes: old images are then ignored.
const WIDTH = 320;
const HEIGHT = 240;
const RATIO = 2;
const SHADOW = 128;
const FETCHES = 3;
const KEEP = 800;

/* ───────── IndexedDB ───────── */

const STORE = 'images';
let database: Promise<IDBDatabase | null> | null = null;

function openDatabase() {
  database ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open('steve-thumbnails', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' }).createIndex('at', 'at');
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return database;
}

async function readImage(key: string): Promise<Blob | null> {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as { blob?: Blob } | undefined)?.blob ?? null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

let writes = 0;
async function storeImage(key: string, blob: Blob) {
  const db = await openDatabase();
  if (!db) return;
  try {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    store.put({ key, blob, at: Date.now() });
    if (++writes % 40) return;
    const count = store.count();
    count.onsuccess = () => {
      let extra = count.result - KEEP;
      if (extra <= 0) return;
      const cursor = store.index('at').openCursor();
      cursor.onsuccess = () => { if (cursor.result && extra-- > 0) { cursor.result.delete(); cursor.result.continue(); } };
    };
  } catch { /* The cache is optional. */ }
}

/* ───────── Studio ───────── */

interface Studio {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  environment: THREE.Texture;
  silhouette: THREE.MeshBasicMaterial;
  shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadowCanvas: HTMLCanvasElement;
  blurCanvas: HTMLCanvasElement;
}

let studio: Studio | null | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;

function openStudio(): Studio | null {
  clearTimeout(idle);
  if (studio?.renderer.getContext().isContextLost()) studio = undefined;  // the GPU was reset: start over
  if (studio !== undefined) return studio;
  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.setClearColor(0x000000, 0);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.035).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = environment;
    scene.environmentRotation.set(Math.PI / 2, 0, 0);
    const sky = new THREE.HemisphereLight('#f2f6ff', '#1c2126', 0.3);
    sky.position.set(0, 0, 1);
    const camera = new THREE.OrthographicCamera();
    camera.up.set(0, 0, 1);
    // The viewport's head light: upper left of the viewer, following the camera.
    const key = new THREE.DirectionalLight('#ffffff', 1.7);
    key.position.set(-0.45, 0.85, 0.55);
    const target = new THREE.Object3D();
    target.position.set(0, 0, -1);
    camera.add(key, target);
    key.target = target;
    const shadowCanvas = Object.assign(document.createElement('canvas'), { width: SHADOW, height: SHADOW });
    const blurCanvas = Object.assign(document.createElement('canvas'), { width: 24, height: 24 });
    const map = new THREE.CanvasTexture(shadowCanvas);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, color: 0x000000 }));
    shadow.renderOrder = -1;
    scene.add(sky, camera, shadow);
    studio = { renderer, scene, camera, environment, silhouette: new THREE.MeshBasicMaterial({ color: 0x000000 }), shadow, shadowCanvas, blurCanvas };
  } catch {
    studio = null;
  }
  return studio;
}

/** Gives the GPU context back once the browser has been idle for a while. */
function releaseStudio() {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (!studio) return;
    studio.environment.dispose();
    studio.silhouette.dispose();
    studio.shadow.geometry.dispose();
    studio.shadow.material.map?.dispose();
    studio.shadow.material.dispose();
    studio.renderer.dispose();
    studio.renderer.forceContextLoss();
    studio = undefined;
  }, 20_000);
}

/** The model's footprint seen from above, blurred: the viewport's contact shadow, cheaply. */
function groundShadow(s: Studio, model: ModelRuntime, box: THREE.Box3, theme: Theme) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const extent = Math.max(size.x, size.y) * 1.9 + size.z * 0.6;
  const half = extent / 2;
  const top = new THREE.OrthographicCamera(-half, half, half, -half, 0, size.z + extent);
  top.up.set(0, 1, 0);
  top.position.set(center.x, center.y, box.max.z + extent * 0.5);
  top.lookAt(center.x, center.y, box.min.z);
  for (const set of model.edgeSets) set.visible.visible = set.hidden.visible = false;
  s.shadow.visible = false;
  s.scene.overrideMaterial = s.silhouette;
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(SHADOW, SHADOW, false);
  s.renderer.render(s.scene, top);
  s.scene.overrideMaterial = null;
  model.setStyle('shaded-edges', theme);
  // Down- then up-sampling is a soft blur that works in every browser.
  const blur = s.blurCanvas.getContext('2d')!;
  const out = s.shadowCanvas.getContext('2d')!;
  blur.clearRect(0, 0, s.blurCanvas.width, s.blurCanvas.height);
  blur.drawImage(s.renderer.domElement, 0, 0, s.blurCanvas.width, s.blurCanvas.height);
  out.clearRect(0, 0, SHADOW, SHADOW);
  out.imageSmoothingQuality = 'high';
  out.drawImage(s.blurCanvas, 0, 0, SHADOW, SHADOW);
  out.globalAlpha = 0.45;
  out.drawImage(s.renderer.domElement, 0, 0, SHADOW, SHADOW);
  out.globalAlpha = 1;
  s.shadow.material.map!.needsUpdate = true;
  s.shadow.material.opacity = theme === 'dark' ? 0.55 : 0.32;
  s.shadow.scale.set(extent, extent, 1);
  s.shadow.position.set(center.x, center.y, box.min.z - extent * 0.002);
  s.shadow.visible = true;
}

/** Isometric, like the viewport's Home view, framed on the actual silhouette rather than the box. */
function frame(camera: THREE.OrthographicCamera, model: ModelRuntime, box: THREE.Box3) {
  const direction = new THREE.Vector3(...VIEW_DIRECTIONS.iso).normalize();
  const basis = new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  const xAxis = new THREE.Vector3().setFromMatrixColumn(basis, 0);
  const yAxis = new THREE.Vector3().setFromMatrixColumn(basis, 1);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const point = new THREE.Vector3();
  for (const mesh of model.faces) {
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      const x = point.dot(xAxis), y = point.dot(yAxis);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const aspect = WIDTH / HEIGHT;
  const fill = 0.76;
  let halfWidth = Math.max((maxX - minX) / 2, 1e-3) / fill;
  let halfHeight = Math.max((maxY - minY) / 2, 1e-3) / fill;
  if (halfWidth / halfHeight > aspect) halfHeight = halfWidth / aspect; else halfWidth = halfHeight * aspect;
  const center = box.getCenter(new THREE.Vector3());
  const look = center.clone()
    .addScaledVector(xAxis, (minX + maxX) / 2 - center.dot(xAxis))
    .addScaledVector(yAxis, (minY + maxY) / 2 - center.dot(yAxis));
  // A little low in the frame: card labels sit over the top edge.
  look.addScaledVector(yAxis, halfHeight * 0.05);
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
  camera.position.copy(look).addScaledVector(direction, radius * 4);
  camera.lookAt(look);
  Object.assign(camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight, near: 0, far: radius * 8 });
  camera.updateProjectionMatrix();
}

async function render(buffer: ArrayBuffer, buildId: string, kind: Kind, theme: Theme): Promise<Blob | 'empty' | 'unreadable' | null> {
  const s = openStudio();
  if (!s) return null;
  let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>>;
  try { gltf = await new GLTFLoader().parseAsync(buffer, ''); } catch { return 'unreadable'; }
  const model = new ModelRuntime(gltf, { id: buildId, kind, metadata: null } as Build, null, '');
  try {
    s.scene.add(model.root);
    s.scene.environmentIntensity = theme === 'dark' ? 0.55 : 0.7;
    model.setStyle('shaded-edges', theme);
    const box = model.bounds(false);
    if (box.isEmpty()) return 'empty';
    groundShadow(s, model, box, theme);
    s.renderer.setPixelRatio(RATIO);
    s.renderer.setSize(WIDTH, HEIGHT, false);
    frame(s.camera, model, box);
    s.renderer.render(s.scene, s.camera);
    return await new Promise((resolve) => s.renderer.domElement.toBlob(resolve, 'image/webp', 0.9));
  } finally {
    model.dispose();
    s.shadow.visible = false;
  }
}

/* ───────── Queue ───────── */

interface Job { key: string; buildId: string; kind: Kind; theme: Theme; waiters: Set<(result: Thumbnail) => void> }

const results = new Map<string, Thumbnail>();
const jobs = new Map<string, Job>();
let chain: Promise<unknown> = Promise.resolve();
let downloads = 0;
const queued: (() => void)[] = [];

/** At most FETCHES downloads at once, in the order thumbnails were asked for. */
const acquire = () => new Promise<void>((resolve) => {
  const start = () => { downloads++; resolve(); };
  if (downloads < FETCHES) start(); else queued.push(start);
});
const release = () => { downloads--; queued.shift()?.(); };

/** Waits until the browser has a quiet moment, so renders never hold up scrolling, typing or transitions. */
const idleMoment = () => new Promise<void>((resolve) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 250 });
  else setTimeout(resolve, 16);
});

/** One render at a time, each in an idle moment; downloads overlap with it. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(idleMoment).then(task);
  chain = next.catch(() => undefined);
  return next;
}

/** null: nobody wants it any more (scrolled away, dialog closed) before its download started. */
async function produce(job: Job): Promise<Thumbnail | null> {
  // Images made before come straight from the cache, without waiting behind renders.
  const cached = await readImage(job.key);
  if (cached) return { status: 'ready', url: URL.createObjectURL(cached) };
  await acquire();
  try {
    if (!job.waiters.size) return null;
    let response: Response;
    try { response = await fetch(`/v1/builds/${job.buildId}/artifacts/preview`); } catch { return { status: 'failed' }; }
    if (response.status === 404 || response.status === 409) return { status: 'broken' };
    if (!response.ok) return { status: 'failed' };
    const buffer = await response.arrayBuffer();
    const image = await serial(() => render(buffer, job.buildId, job.kind, job.theme));
    // No WebGL here: the server's picture of the build, drawn from its meshes (never asks for a STEP file).
    if (!image) return { status: 'ready', url: withWorkspace(`/v1/builds/${job.buildId}/artifacts/picture`), flat: true };
    if (image === 'empty') return { status: 'empty' };
    if (image === 'unreadable') return { status: 'broken' };
    void storeImage(job.key, image);
    return { status: 'ready', url: URL.createObjectURL(image) };
  } finally {
    release();
  }
}

function start(job: Job) {
  void produce(job).catch((): Thumbnail => ({ status: 'failed' })).then((result) => {
    jobs.delete(job.key);
    if (!jobs.size) releaseStudio();
    if (!result) return;
    if (result.status !== 'failed') results.set(job.key, result);
    for (const waiter of job.waiters) waiter(result);
  });
}

const keyOf = (buildId: string, theme: Theme) => `${LOOK}:${theme}:${buildId}`;

/** Asks for a build's thumbnail; the returned function withdraws the request (dropped if its download hasn't started). */
export function requestThumbnail(buildId: string, kind: Kind, theme: Theme, done: (result: Thumbnail) => void): () => void {
  const key = keyOf(buildId, theme);
  const known = results.get(key);
  if (known) { done(known); return () => undefined; }
  let job = jobs.get(key);
  const fresh = !job;
  if (!job) { job = { key, buildId, kind, theme, waiters: new Set() }; jobs.set(key, job); }
  const current = job;
  current.waiters.add(done);
  if (fresh) start(current);
  return () => { current.waiters.delete(done); };
}

/** A build's thumbnail; requested only while `wanted` (say, once its card scrolls into view). */
export function useThumbnail(buildId: string | null, kind: Kind, theme: Theme, wanted: boolean): Thumbnail | null {
  const key = buildId ? keyOf(buildId, theme) : null;
  const [state, setState] = useState<{ key: string | null; result: Thumbnail | null; tries: number }>({ key: null, result: null, tries: 0 });
  const result = state.key === key && state.result ? state.result : key ? results.get(key) ?? null : null;
  useEffect(() => {
    if (!buildId || !wanted) return;
    // A server hiccup (say, a restart) gets a couple more tries.
    if (result?.status === 'failed' && state.tries < 3) {
      const timer = setTimeout(() => setState((current) => ({ key, result: null, tries: current.tries })), 4000 * state.tries);
      return () => clearTimeout(timer);
    }
    if (result) return;
    return requestThumbnail(buildId, kind, theme, (value) => setState((current) => ({ key, result: value, tries: current.tries + 1 })));
  }, [buildId, kind, theme, wanted, result, key, state.tries]);
  return result;
}

/** True when the thumbnail was already made earlier in this session (no need to animate it in). */
export const hasThumbnail = (buildId: string | null, theme: Theme) => !!buildId && results.has(keyOf(buildId, theme));

/**
 * A shared design, read-only, in the app's own viewer: the same canvas, camera and navigation, lighting, materials,
 * decals, edges, display styles, view cube and triad as the STEVE web app (viewport/SceneCore and its parts), driven by
 * the app store's view state, in the app's own chrome (ShareShell: its layout on desktops and tablets, the phone shell's
 * on phones). Around it: the parts (show, hide, isolate), explode, inspecting a part (its name, component, material and
 * size) and the downloads the link allows; when the owner let visitors move the mechanism, its parts drag along their
 * joints as in the Motion tab (motion/PoseLayer), never saved, and (on shares whose owner also agreed to it) its motors
 * and animations play as there (motion/state). Everything comes from the share's own routes (/share/<token>/info,
 * /model.glb, /topology.json, /decal/…, /download/…); this page holds no account and never calls the app's /v1 API.
 */
import { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { Grid3x3 } from 'lucide-react';
import { IconButton, Spinner, TooltipProvider } from '@/ui';
import { get, set, useApp, type Pick, type StandardView, type TreeNode } from '@/state/store';
import { displayDefaults } from '@/settings/store';
import { loadGltf, ModelRuntime } from '@/viewport/model';
import { viewer, VIEW_DIRECTIONS } from '@/viewport/viewer';
import SceneCore, { CANVAS_PROPS } from '@/viewport/SceneCore';
import ViewCube from '@/viewport/ViewCube';
import Triad from '@/viewport/Triad';
import ViewTools from '@/viewport/ViewTools';
import { setDecalImageUrl } from '@/viewport/DecalLayer';
import { useLibrary } from '@/lib/materials';
import { SharedMotionLayer } from '@/motion/PoseLayer';
import TrailLayer from '@/motion/TrailLayer';
import { selectJoint, useMotion } from '@/motion/state';
import { isPhone } from '@/phone/detect';
import type { Build, Topology } from '@/lib/api';
import viewportStyles from '@/viewport/Viewport.module.css';
import { hide, isolate, showAll, toggleHidden, useJointOf, useSelectedPart, type Download, type Info } from './model';
import { DesktopShell, PhoneShell } from './ShareShell';

const KEYS: Record<string, StandardView> = { 0: 'iso', 1: 'front', 2: 'back', 3: 'left', 4: 'right', 5: 'top', 6: 'bottom' };

/** The placed part a node belongs to: its ancestor directly under the document (a part's body nodes, a design's instances). */
function topLevel(tree: Record<string, TreeNode>, node: string): string | null {
  let current = tree[node];
  while (current?.parent && current.parent !== 'root') current = tree[current.parent];
  return current && current.parent ? current.id : null;
}

/** Clicks (and taps) pick a placed part (as the app's component selection), hovering highlights it; drags stay navigation. */
function usePicking(element: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const raycaster = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    let frame = 0;
    const pickAt = (event: PointerEvent): Pick | null => {
      const model = viewer.model, camera = viewer.camera;
      const canvas = target.querySelector('canvas');
      if (!model || !camera || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const hit = model.pick(raycaster, camera, ndc, { width: rect.width, height: rect.height }, 'component');
      const node = hit ? topLevel(model.tree, hit.pick.node) : null;
      return node ? { kind: 'component', node } : null;
    };
    const onDown = (event: PointerEvent) => { down = event.button === 0 ? { x: event.clientX, y: event.clientY } : null; };
    const onUp = (event: PointerEvent) => {
      // A press that moved a part never reaches onDown (the drag takes it), so `down` is cleared on every release.
      const start = down;
      down = null;
      // A finger wobbles more than a mouse: a tap may move a little and still be a tap.
      const slop = event.pointerType === 'touch' ? 10 : 4;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > slop || !(event.target instanceof HTMLCanvasElement)) return;
      const pick = pickAt(event);
      set({ selection: pick ? [pick] : [] });
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.buttons || viewer.interacting || !(event.target instanceof HTMLCanvasElement)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const pick = pickAt(event);
        const hover = get().hover;
        if ((pick?.node ?? null) !== (hover && hover.kind === 'component' ? hover.node : null)) set({ hover: pick });
      });
    };
    const onLeave = () => { cancelAnimationFrame(frame); if (get().hover) set({ hover: null }); };
    target.addEventListener('pointerdown', onDown);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener('pointerdown', onDown);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerleave', onLeave);
    };
  }, [element]);
}

/** The part the visibility keys act on: a focused part row's own button (as the app's eye rows), else the selected part. */
function hideableTarget(event: KeyboardEvent): string | null {
  const target = event.target as HTMLElement | null;
  // Space presses a focused button (Downloads, a part's eye, a panel tab); only a part row's own button gives it up.
  const pressable = event.key === ' ' ? target?.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"]') : null;
  if (pressable) {
    const row = pressable.parentElement?.getAttribute('data-item');
    return !pressable.hasAttribute('aria-expanded') && row?.startsWith('part:') ? row.slice(5) : null;
  }
  const pick = get().selection[0];
  return pick?.kind === 'component' && get().tree[pick.node] ? pick.node : null;
}

/** The app's view keys (fit, standard views, projection, grid), its visibility keys and its panel keys, without the editing ones. */
function useViewKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || (event.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      const key = event.key.toLowerCase();
      if (!event.ctrlKey && !event.metaKey && (key === ' ' || key === 'h' || key === 'i')) {
        // As the app: Space hides or shows the part, H hides it, I isolates it, Shift+H shows everything.
        if (key === 'h' && event.shiftKey) showAll();
        else if (event.shiftKey) return;
        else {
          const part = hideableTarget(event);
          if (!part) return;
          if (key === ' ') toggleHidden(part);
          else if (key === 'h') hide(part);
          else isolate(part);
        }
        event.preventDefault();
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (key === 'b') set((state) => ({ browserOpen: !state.browserOpen }));
        else if (key === '.') set((state) => ({ dockOpen: !state.dockOpen }));
        else return;
      } else if (key === 'f') viewer.fit();
      else if (key in KEYS) viewer.setView(KEYS[key]);
      else if (key === 'p') set((state) => ({ projection: state.projection === 'orthographic' ? 'perspective' : 'orthographic' }));
      else if (key === 'g') set((state) => ({ showGrid: !state.showGrid }));
      else if (key === 'escape') set({ selection: [] });
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Opens the shared build in the viewer, as the app opens a build (state/actions.ts showBuild), read-only. */
async function show(token: string, info: Info, onProgress: (fraction: number) => void) {
  const build = { id: `share:${token.slice(0, 8)}`, name: info.name, kind: info.kind, status: 'succeeded', created_at: info.shared_at,
    metadata: info.viewer, artifacts: { preview: info.model, topology: info.topology } } as Build;
  const topology = fetch(info.topology).then(async (response) => {
    if (!response.ok) return null;
    const data = await response.json() as Topology;
    return data?.version === 1 ? data : null;
  }).catch(() => null);
  const [gltf, edges] = await Promise.all([loadGltf(info.model, onProgress), topology]);
  const runtime = new ModelRuntime(gltf, build, edges, info.name);
  const state = get();
  runtime.setStyle(state.style, state.theme);
  runtime.applyVisibility(runtime.tree);
  viewer.model = runtime;
  set({ displayed: build, tree: runtime.tree, rootId: runtime.rootId, modelVersion: state.modelVersion + 1, selection: [], hover: null, hoverAlso: [], measurePicks: [] });
  viewer.notifyModel();
  // As the app opens a model: a short swing into the isometric view.
  const controls = viewer.controls;
  if (controls) {
    const start = new THREE.Vector3(...VIEW_DIRECTIONS.iso).normalize().applyAxisAngle(new THREE.Vector3(0, 0, 1), -0.42);
    start.z += 0.18;
    viewer.frame(null, start, false);
    if (viewer.camera instanceof THREE.OrthographicCamera) void controls.zoomTo(viewer.camera.zoom * 0.72, false);
    requestAnimationFrame(() => viewer.setView('iso', true));
  }
}

export default function ShareViewer({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<'loading' | 'gone' | 'error' | 'ready'>('loading');
  /** The model's download so far (0–1, or null while its size is unknown), until it is on screen. */
  const [progress, setProgress] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  const grid = useApp((s) => s.showGrid);
  const view = useRef<HTMLDivElement>(null);
  useLibrary();   // Material names for the inspector (the viewer loads the library itself for the surfaces).
  usePicking(view);
  useViewKeys();

  useEffect(() => {
    let cancelled = false;
    // The side panels start open where there's room for them beside the model, as the app's do.
    const wide = !isPhone() && window.innerWidth > 900;
    set({ ...displayDefaults(), theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', browserOpen: wide, dockOpen: wide, dockWidth: 320 });
    (async () => {
      const response = await fetch(`/share/${encodeURIComponent(token)}/info`);
      if (response.status === 404) { setState('gone'); return; }
      if (!response.ok) throw new Error(String(response.status));
      const data = (await response.json()) as Info;
      if (cancelled) return;
      setInfo(data);
      document.title = `${data.name} · STEVE Studio`;
      setDecalImageUrl((id) => `${data.decals}${encodeURIComponent(id)}`);
      setState('ready');
      // The canvas mounts with 'ready'; open the model once its camera controls exist.
      for (let i = 0; i < 100 && !viewer.controls; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      if (cancelled) return;
      await show(token, data, (fraction) => { if (!cancelled) setProgress(Math.floor(fraction * 100) / 100); });   // Whole percents: a render per step, not per chunk.
      if (!cancelled) setShown(true);
    })().catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [token]);

  // While a download is being prepared, check again now and then (not a view; the server answers from its own state).
  const preparing = !!info?.downloads.some((item) => item.status === 'preparing');
  useEffect(() => {
    if (!preparing) return;
    let tries = 0;
    const timer = setInterval(() => {
      if (++tries > 80) { clearInterval(timer); return; }   // About 20 minutes; reloading the page checks again.
      fetch(`/share/${encodeURIComponent(token)}/downloads`).then((response) => (response.ok ? response.json() : null)).then((data: { downloads: Download[] } | null) => {
        if (data) setInfo((current) => (current ? { ...current, downloads: data.downloads } : current));
      }).catch(() => { /* Next time. */ });
    }, 15000);
    return () => clearInterval(timer);
  }, [preparing, token]);

  const selected = useSelectedPart();
  const movable = useMotion((s) => !!s.kinematics);
  const joint = useJointOf(selected?.id);
  useEffect(() => { if (movable) selectJoint(joint?.name ?? null); }, [movable, joint]);   // The selected part's joint is drawn.

  if (state === 'gone') return <div className="message"><div><h1>This share is no longer available</h1><p className="muted">The link was revoked or has expired.</p></div></div>;
  if (state === 'error') return <div className="message"><div><h1>Couldn’t load this share</h1><p className="muted">Try again in a moment.</p></div></div>;
  const loading = !shown;
  const loadingLabel = progress === null ? 'Loading the model…'
    : progress < 1 ? `Downloading the model… ${Math.round(progress * 100)}%` : 'Preparing the model…';
  const viewport = (
    <div className={viewportStyles.viewport} ref={view} id="viewport" data-tool="select">
      <div className={viewportStyles.backdrop} />
      {state === 'ready' && (
        <Canvas className={viewportStyles.canvas} {...CANVAS_PROPS}>
          <SceneCore />
          <SharedMotionLayer />
          <TrailLayer />
        </Canvas>
      )}
      <div className={viewportStyles.vignette} />
      {loading && (
        <>
          <div className={viewportStyles.progress}><span className={viewportStyles.progressBar} /></div>
          <div className="message">
            <div id="share-loading" className="loading" role="status"><Spinner size={16} /><span>{loadingLabel}</span></div>
          </div>
        </>
      )}
      <ViewCube />
      <Triad />
      <div className={viewportStyles.navbar} role="toolbar" aria-label="View tools">
        <ViewTools />
        <span className={viewportStyles.navSep} />
        <IconButton label="Ground grid" shortcut="G" active={grid} onClick={() => set({ showGrid: !grid })}><Grid3x3 /></IconButton>
      </div>
    </div>
  );
  const Shell = isPhone() ? PhoneShell : DesktopShell;
  return <TooltipProvider><Shell info={info} loading={loading} viewport={viewport} /></TooltipProvider>;
}

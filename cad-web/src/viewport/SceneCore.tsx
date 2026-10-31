import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type CanvasProps } from '@react-three/fiber';
import { CameraControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import CameraControlsImpl from 'camera-controls';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { get, samePick, set, useApp, viewportTheme, type Projection } from '@/state/store';
import { setting, useSettings } from '@/settings/store';
import MaterialAppearance from '@/materials/MaterialAppearance';
import { viewer } from './viewer';
import { applyMouseStyle } from './mouseStyle';
import AdaptiveResolution from './AdaptiveResolution';
import CadGrid from './CadGrid';
import OriginGizmo from './OriginGizmo';
import DecalLayer from './DecalLayer';
import GroundContactShadow from './GroundContactShadow';

/**
 * The viewer itself: camera and navigation, lighting and environment, the displayed model with its materials and
 * decals, ground shadow, grid and origin. The app's viewport (Scene) adds its editing layers on top; the share page
 * (web/src/share) shows exactly this, read-only. Everything here is driven by the app store's view state (style,
 * projection, theme, tree visibility, explode, selection highlights) and the viewer singleton.
 */

/** The canvas the viewer draws into (the app's viewport and the share page). */
export const CANVAS_PROPS: Pick<CanvasProps, 'frameloop' | 'dpr' | 'gl' | 'camera'> = {
  frameloop: 'demand',
  dpr: [1, 2],
  gl: { antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' },
  camera: { position: [240, -240, 200], up: [0, 0, 1], near: 0.1, far: 100000 },
};

interface Pose { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; visibleHeight: number }
let lastPose: Pose | null = null;

function visibleHeight(camera: THREE.Camera, target: THREE.Vector3, height: number) {
  if (camera instanceof THREE.OrthographicCamera) return height / camera.zoom;
  const perspective = camera as THREE.PerspectiveCamera;
  return 2 * camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2);
}

// Natural-log change in camera distance (or 1/zoom) per wheel event: about 15% per mouse-wheel notch,
// whatever pixels the browser reports for it (Chrome on macOS sends ~4 px a notch, Windows 100 px).
const WHEEL_NOTCH = Math.log(1.15);
const WHEEL_PIXEL = 0.003; // smooth trackpad / Magic Mouse scrolling, per pixel
const WHEEL_PINCH = 0.025; // trackpad pinch (ctrl+wheel), per unit
const WHEEL_MAX_STEP = Math.log(2);

function wheelZoomStep(event: WheelEvent, pageHeight: number) {
  const { deltaY } = event;
  // Chrome and Safari report a notched wheel as multiples of 120 here, and a trackpad as -3 × deltaY.
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  let step: number;
  if (event.ctrlKey) step = deltaY * WHEEL_PINCH;
  else if (event.deltaMode === 1) step = deltaY / 3 * WHEEL_NOTCH;
  else if (event.deltaMode === 2) step = deltaY * pageHeight / 100 * WHEEL_NOTCH;
  else if (legacy && legacy % 120 === 0 && Math.abs(legacy + 3 * deltaY) > 1) step = -legacy / 120 * WHEEL_NOTCH;
  else step = deltaY * WHEEL_PIXEL;
  return THREE.MathUtils.clamp(step, -WHEEL_MAX_STEP, WHEEL_MAX_STEP);
}

/** Settings → Navigation that camera-controls holds: zoom toward the pointer, and orbit speed. */
function tune(controls: CameraControlsImpl) {
  controls.dollyToCursor = setting('viewport.zoomToCursor');
  controls.azimuthRotateSpeed = 0.85 * setting('viewport.orbitSpeed');
  controls.polarRotateSpeed = 0.85 * setting('viewport.orbitSpeed');
}

function CameraRig() {
  const projection = useApp((state) => state.projection);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  const activeCamera = useThree((state) => state.camera);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  // The wheel event camera-controls is handling right now, so its dolly/zoom step can be replaced.
  const wheelRef = useRef<WheelEvent | null>(null);
  useEffect(() => {
    const begin = (event: WheelEvent) => { wheelRef.current = event; };
    const end = () => { wheelRef.current = null; };
    window.addEventListener('wheel', begin, { capture: true, passive: true });
    window.addEventListener('wheel', end, { passive: true });
    return () => {
      window.removeEventListener('wheel', begin, { capture: true });
      window.removeEventListener('wheel', end);
    };
  }, []);

  // A change in Settings → Navigation applies to the view at once.
  useEffect(() => useSettings.subscribe((state, previous) => {
    const keys = ['viewport.zoomToCursor', 'viewport.orbitSpeed'] as const;
    if (viewer.controls && keys.some((key) => state.values[key] !== previous.values[key])) tune(viewer.controls);
    if (viewer.controls && state.values['viewport.mouseStyle'] !== previous.values['viewport.mouseStyle']) applyMouseStyle(viewer.controls);
  }), []);

  // camera-controls maps a drag per button only: for the styles that use Ctrl or Shift with a button (SOLIDWORKS'
  // Ctrl+middle pan, Fusion's Shift+middle orbit, Onshape's Ctrl+right pan), set its buttons from the keys held as the
  // press starts, before it reads them (capture, on the window), and put back the plain mapping when the press ends.
  const element = useThree((state) => state.gl.domElement);
  useEffect(() => {
    let held = false;
    const down = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !viewer.controls || !(event.target instanceof Node) || !element.contains(event.target)) return;
      held = true;
      applyMouseStyle(viewer.controls, event);
    };
    const up = () => {
      if (!held) return;
      held = false;
      if (viewer.controls) applyMouseStyle(viewer.controls);
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
    };
  }, [element]);

  const register = useCallback((controls: CameraControlsImpl | null) => {
    if (!controls) return;
    const camera = controls.camera as THREE.OrthographicCamera | THREE.PerspectiveCamera;
    // Z up, unless the view had been orbited over the top before a projection switch.
    if (lastPose) camera.up.copy(lastPose.up);
    else camera.up.set(0, 0, 1);
    controls.updateCameraUp();
    const A = CameraControlsImpl.ACTION;
    const ortho = camera instanceof THREE.OrthographicCamera;
    applyMouseStyle(controls);  // Settings → Navigation › Mouse style: which buttons orbit, pan and zoom.
    controls.touches.one = A.TOUCH_ROTATE;
    controls.touches.two = ortho ? A.TOUCH_ZOOM_TRUCK : A.TOUCH_DOLLY_TRUCK;
    controls.touches.three = A.TOUCH_TRUCK;
    controls.smoothTime = 0.26;
    controls.draggingSmoothTime = 0.07;
    controls.dollySpeed = 0.6;
    tune(controls);
    controls.minZoom = 1e-4;
    controls.maxZoom = 1e6;
    controls.minDistance = 1e-3;
    controls.maxDistance = 1e7;
    controls.restThreshold = 0.002;
    // camera-controls' own rotate stops dead at the top and bottom views, and as a turntable a
    // sideways drag from above only spins the model flat. Its drag-to-rotate (mouse, touch,
    // sketching's right button) goes through viewer.trackball: Open Inventor's virtual trackball, at its own speed
    // times Settings → Navigation's orbit speed.
    const drag = controls as unknown as {
      _rotateInternal?: (deltaX: number, deltaY: number) => void;
      _truckInternal?: (deltaX: number, deltaY: number, dragToOffset: boolean, ...rest: unknown[]) => void;
    };
    if (typeof drag._rotateInternal === 'function') {
      // camera-controls passes deltaX/deltaY = last pointer position - current (pixels); the current one is the mean of
      // its active pointers. Both go, in the canvas's -1..1 coordinates, to the Open Inventor trackball (viewer.trackball).
      const pointers = controls as unknown as { _activePointers?: { clientX: number; clientY: number }[] };
      drag._rotateInternal = (deltaX, deltaY) => {
        const active = pointers._activePointers ?? [];
        const rect = (controls as unknown as { _domElement?: HTMLElement })._domElement?.getBoundingClientRect();
        if (!active.length || !rect || !rect.width || !rect.height) return;
        const x = active.reduce((sum, p) => sum + p.clientX, 0) / active.length;
        const y = active.reduce((sum, p) => sum + p.clientY, 0) / active.length;
        const ndc = (cx: number, cy: number) => ({ x: (cx - rect.left) / rect.width * 2 - 1, y: 1 - (cy - rect.top) / rect.height * 2 });
        viewer.trackball(ndc(x + deltaX, y + deltaY), ndc(x, y), setting('viewport.orbitSpeed'));
      };
    }
    // camera-controls' drag-to-pan moves orthographic views twice as fast as the pointer, and perspective
    // views at the orbit target's depth. Pan by exactly one screen pixel per pointer pixel at the grabbed
    // point's depth (Interaction's panDepth), without trailing, so the model stays under the cursor.
    const truck = drag._truckInternal;
    if (typeof truck === 'function') {
      drag._truckInternal = (deltaX, deltaY, dragToOffset, ...rest) => {
        if (dragToOffset) { truck.call(controls, deltaX, deltaY, dragToOffset, ...rest); return; }
        const height = Math.max(sizeRef.current.height, 1);
        let unit: number;
        if (camera instanceof THREE.OrthographicCamera) unit = (camera.top - camera.bottom) / camera.zoom / height;
        else {
          const depth = viewer.panDepth ?? camera.position.distanceTo(controls.getTarget(new THREE.Vector3(), false));
          unit = 2 * Math.max(depth, 0) * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / height;
        }
        void controls.truck(deltaX * unit, deltaY * unit, false);
      };
    }
    // camera-controls scales its wheel step by the platform (a notch on macOS barely moves) and by pixel
    // vs line mode. Give each wheel event the same proportional step everywhere (wheelZoomStep); both
    // internals scale by 0.95^(delta × dollySpeed), so convert the log step into their delta.
    const zoom = controls as unknown as {
      _dollyInternal?: (delta: number, x: number, y: number) => void;
      _zoomInternal?: (delta: number, x: number, y: number) => void;
    };
    for (const key of ['_dollyInternal', '_zoomInternal'] as const) {
      const internal = zoom[key];
      if (typeof internal !== 'function') continue;
      zoom[key] = (delta, x, y) => {
        const event = wheelRef.current;
        if (event) {
          wheelRef.current = null;
          // Settings → Navigation: zoom speed, and which way the wheel zooms (a pinch always zooms the way it looks).
          const sign = setting('viewport.invertWheel') && !event.ctrlKey ? -1 : 1;
          delta = sign * setting('viewport.zoomSpeed') * wheelZoomStep(event, sizeRef.current.height) / (controls.dollySpeed * -Math.log(0.95));
        }
        internal.call(controls, delta, x, y);
      };
    }
    viewer.controls = controls;
    viewer.camera = camera;

    if (lastPose) {
      // Preserve framing across projection switches.
      const { position, target } = lastPose;
      const direction = position.clone().sub(target).normalize();
      if (ortho) {
        camera.zoom = sizeRef.current.height / lastPose.visibleHeight;
        const distance = Math.max(viewer.modelRadius() * 8, 50);
        const eye = target.clone().addScaledVector(direction, distance);
        camera.near = -viewer.modelRadius() * 40;
        camera.far = distance + viewer.modelRadius() * 60 + 1e4;
        camera.updateProjectionMatrix();
        void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
        void controls.zoomTo(camera.zoom, false);
      } else {
        const distance = lastPose.visibleHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
        const eye = target.clone().addScaledVector(direction, distance);
        camera.near = Math.max(distance / 2000, 0.01);
        camera.far = distance * 50 + viewer.modelRadius() * 20;
        camera.updateProjectionMatrix();
        void controls.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
      }
    }

    controls.addEventListener('controlstart', () => { viewer.interacting = true; viewer.autoFramed = false; });
    controls.addEventListener('control', () => {
      // Only an actual orbit leaves the named view; clicks and pans keep it.
      if ((controls.currentAction === A.ROTATE || controls.currentAction === A.TOUCH_ROTATE) && get().view) set({ view: null });
    });
    controls.addEventListener('controlend', () => { viewer.interacting = false; });
    viewer.moving = false;
    controls.addEventListener('wake', () => { viewer.moving = true; });
    controls.addEventListener('rest', () => { viewer.moving = false; });
    controls.addEventListener('sleep', () => { viewer.moving = false; });
    invalidate();
  }, [invalidate]);

  // Camera refs run while React is still committing the replacement camera's
  // initial props. Restore afterwards, once controls belong to the active camera.
  useEffect(() => {
    if (viewer.controls?.camera === activeCamera) viewer.restorePendingPose();
  }, [activeCamera]);

  useFrame(({ camera }) => {
    const controls = viewer.controls;
    if (!controls || controls.camera !== camera) return;
    // The rendered eye includes a click-to-pivot focal offset; getTarget does
    // not. Fold the same translation into the target so a projection switch
    // preserves the view direction instead of tilting toward the picked part.
    const eye = controls.getPosition(new THREE.Vector3(), false);
    const target = controls.getTarget(new THREE.Vector3(), false)
      .add(camera.position.clone().sub(eye));
    lastPose = { position: camera.position.clone(), target, up: camera.up.clone(), visibleHeight: visibleHeight(camera, target, sizeRef.current.height) };
    viewer.emitCamera();
  });

  return (
    <>
      {projection === 'orthographic'
        ? <OrthographicCamera key="ortho" makeDefault up={[0, 0, 1]} position={[240, -240, 200]} zoom={2.2} near={-10000} far={100000} />
        : <PerspectiveCamera key="persp" makeDefault up={[0, 0, 1]} position={[240, -240, 200]} fov={30} near={0.1} far={100000} />}
      <CameraControls key={projection as Projection} ref={register} makeDefault />
      <HeadLight />
    </>
  );
}

/** A key light that follows the camera so faces toward the viewer always read clearly. */
function HeadLight() {
  const camera = useThree((state) => state.camera);
  const scene = useThree((state) => state.scene);
  useEffect(() => {
    const light = new THREE.DirectionalLight('#ffffff', 1.7);
    // Upper left of the viewer, so top, front and side faces read at distinct brightness.
    light.position.set(-0.45, 0.85, 0.55);
    const target = new THREE.Object3D();
    target.position.set(0, 0, -1);
    camera.add(light, target);
    light.target = target;
    if (!camera.parent) scene.add(camera);
    return () => { camera.remove(light, target); light.dispose(); };
  }, [camera, scene]);
  return null;
}

function Environment() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const theme = useApp(viewportTheme);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const texture = pmrem.fromScene(room, 0.035).texture;
    scene.environment = texture;
    // RoomEnvironment is Y-up; the studio's ceiling lights belong above the Z-up world.
    scene.environmentRotation.set(Math.PI / 2, 0, 0);
    room.dispose();
    pmrem.dispose();
    return () => { texture.dispose(); scene.environment = null; };
  }, [gl, scene]);
  useEffect(() => {
    scene.environmentIntensity = theme === 'dark' ? 0.55 : 0.7;
  }, [scene, theme]);
  return <hemisphereLight args={['#f2f6ff', '#1c2126', 0.3]} position={[0, 0, 1]} />;
}

/** Adds the displayed model (and a fading predecessor) to the scene graph. */
function ModelLayer() {
  const [, force] = useState(0);
  useEffect(() => viewer.onModelChange(() => force((n) => n + 1)), []);
  const { model, outgoing } = viewer;
  return (
    <>
      {outgoing && <primitive key={outgoing.build.id + ':out'} object={outgoing.root} />}
      {model && <primitive key={model.build.id} object={model.root} />}
    </>
  );
}

function ModelSync() {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const apply = () => {
      const state = get();
      const model = viewer.model;
      if (!model) return;
      model.setStyle(state.style, viewportTheme(state));
      model.applyVisibility(state.tree);
      model.setHighlights(state.selection, state.hover, state.tool === 'measure' ? state.measurePicks : [], state.hoverAlso);
      invalidate();
    };
    apply();
    const unsubscribers = [
      useApp.subscribe((state) => [state.style, viewportTheme(state), state.modelVersion] as const, apply, { equalityFn: shallowArray }),
      useApp.subscribe((state) => state.tree, () => { viewer.model?.applyVisibility(get().tree); invalidate(); }),
      useApp.subscribe((state) => state.explode, (explode) => { viewer.model?.setExplode(explode); invalidate(); }),
      useApp.subscribe((state) => [state.selection, state.hover, state.measurePicks, state.tool, state.hoverAlso] as const, ([selection, hover, measured, tool, hoverAlso], [previous]) => {
        viewer.model?.setHighlights(selection, hover, tool === 'measure' ? measured : [], hoverAlso);
        if (selection.some((pick) => !previous.some((old) => samePick(old, pick)))) viewer.model?.flashSelection(invalidate);
        invalidate();
      }, { equalityFn: shallowArray }),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [invalidate]);
  return null;
}

const shallowArray = <T extends readonly unknown[]>(a: T, b: T) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

function GroundShadow() {
  const version = useApp((state) => state.modelVersion);
  const tree = useApp((state) => state.tree);
  const style = useApp((state) => state.style);
  const enabled = useApp((state) => state.showShadows);
  const theme = useApp(viewportTheme);
  const frame = useMemo(() => {
    const box = viewer.model?.bounds(true);
    if (!box || box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const extent = Math.max(size.x, size.y) * 1.9 + size.z * 0.6;
    return { center, min: Math.min(box.min.z, 0), extent, height: Math.max(size.z, extent * 0.2) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tree]);
  if (!frame || !enabled || style === 'wireframe' || style === 'hidden-line') return null;
  return (
    <GroundContactShadow
      key={`${version}:${Object.values(tree).filter((n) => n.hidden).length}`}
      position={[frame.center.x, frame.center.y, frame.min - frame.extent * 0.002]}
      extent={frame.extent}
      height={frame.height}
      opacity={theme === 'dark' ? 0.55 : 0.32}
    />
  );
}


export default function SceneCore() {
  const showGrid = useApp((state) => state.showGrid);
  const showOrigin = useApp((state) => state.showOrigin);
  const showShadows = useApp((state) => state.showShadows);
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);
  const size = useThree((state) => state.size);

  // Removing a scene child can leave the demand-rendered canvas on its previous
  // frame. Request a frame after these visibility changes commit, including the
  // off state, so overlays disappear without waiting for the next camera move.
  useEffect(() => { invalidate(); }, [showGrid, showOrigin, showShadows, invalidate]);

  useEffect(() => {
    viewer.gl = gl;
    viewer.scene = scene;
    viewer.invalidate = invalidate;
    gl.localClippingEnabled = true;
    gl.toneMapping = THREE.NeutralToneMapping;
    gl.toneMappingExposure = 1.02;
  }, [gl, scene, invalidate]);

  useEffect(() => {
    viewer.size = { width: size.width, height: size.height };
    // Keep framed models clear of the view cube and nav bar, which take proportionally more room on small screens.
    viewer.insets = viewer.presenting ? { top: 24, right: 24, bottom: 72, left: 24 }
      : size.width < 720 ? { top: 70, right: 16, bottom: 80, left: 16 } : { top: 24, right: 150, bottom: 84, left: 24 };
    // Panels opening or the window resizing shouldn't leave an automatic framing off-center.
    if (viewer.autoFramed && viewer.model) viewer.frame(null, null, false);
    invalidate();
  }, [size, invalidate]);

  return (
    <>
      <CameraRig />
      <AdaptiveResolution />
      <Environment />
      <ModelLayer />
      <ModelSync />
      <MaterialAppearance />
      <DecalLayer />
      <GroundShadow />
      {showGrid && <CadGrid />}
      <OriginGizmo />
    </>
  );
}

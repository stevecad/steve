import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { get, set, useApp, viewportTheme, type SectionState } from '@/state/store';
import { viewer } from './viewer';
import { perFrame } from './dragStep';

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

export function sectionPlane(section: SectionState, box: THREE.Box3): { plane: THREE.Plane; position: number } {
  const axis = AXES[section.axis];
  const min = box.min.dot(axis), max = box.max.dot(axis);
  // Stay a hair inside the extremes so the cap never z-fights with an end face. A saved section is at its own
  // millimetres, so it stays put when the geometry changes; one outside the model still cuts where it was saved.
  const inset = (max - min) * 0.0005;
  const position = section.at != null
    ? (section.at >= min && section.at <= max ? THREE.MathUtils.clamp(section.at, min + inset, max - inset) : section.at)
    : THREE.MathUtils.lerp(min, max, THREE.MathUtils.clamp(section.offset, 0.0005, 0.9995));
  // Clipping keeps the side where the signed distance is positive.
  const normal = axis.clone().multiplyScalar(section.flip ? 1 : -1);
  return { plane: new THREE.Plane(normal, section.flip ? -position : position), position };
}

const capVertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const capFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHatch;
  uniform float uSpacing;
  uniform vec3 uU;
  uniform vec3 uV;
  varying vec3 vWorld;
  void main() {
    float s = dot(vWorld, uU) + dot(vWorld, uV);
    float coord = s / uSpacing;
    float line = abs(fract(coord) - 0.5) / fwidth(coord);
    float hatch = 1.0 - min(line / 0.75, 1.0);
    gl_FragColor = vec4(mix(uColor, uHatch, hatch * 0.7), 1.0);
    #include <colorspace_fragment>
  }
`;

/** Section view: clips the model and fills solid interiors with hatched caps using the stencil buffer.
 *  The plane can be dragged along its axis; the clip updates live without rebuilding anything. A saved section view
 *  (`section.saved`) is fixed: just the cut and its caps, no plane to drag. */
export default function SectionLayer() {
  const section = useApp((state) => state.section);
  const version = useApp((state) => state.modelVersion);
  const theme = useApp(viewportTheme);
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [hot, setHot] = useState(false);
  const [dragging, setDragging] = useState(false);

  const box = useMemo(() => viewer.model?.bounds(false) ?? new THREE.Box3(), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const cut = useMemo(() => (box.isEmpty() ? null : sectionPlane(section, box)), [section, box]);
  const plane = viewer.sectionPlane;

  // Keep the shared plane in sync; materials hold a reference, so this is all a drag needs.
  if (cut) plane.copy(cut.plane);
  useEffect(() => { invalidate(); }, [cut, invalidate]);

  useEffect(() => {
    const model = viewer.model;
    if (!model || !section.enabled) return;
    model.setClipping([plane]);
    invalidate();
    return () => { model.setClipping([]); invalidate(); };
  }, [section.enabled, version, plane, invalidate]);

  const capMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: capVertex,
    fragmentShader: capFragment,
    uniforms: { uColor: { value: new THREE.Color() }, uHatch: { value: new THREE.Color() }, uSpacing: { value: 2 }, uU: { value: new THREE.Vector3() }, uV: { value: new THREE.Vector3() } },
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
    side: THREE.DoubleSide,
  }), []);

  const stencil = useMemo(() => {
    const base = { depthWrite: false, depthTest: false, colorWrite: false, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc };
    return {
      back: new THREE.MeshBasicMaterial({ ...base, side: THREE.BackSide, stencilFail: THREE.IncrementWrapStencilOp, stencilZFail: THREE.IncrementWrapStencilOp, stencilZPass: THREE.IncrementWrapStencilOp }),
      front: new THREE.MeshBasicMaterial({ ...base, side: THREE.FrontSide, stencilFail: THREE.DecrementWrapStencilOp, stencilZFail: THREE.DecrementWrapStencilOp, stencilZPass: THREE.DecrementWrapStencilOp }),
    };
  }, []);

  // Stencil writers mirror every face mesh; built once per model, not per drag step.
  useEffect(() => {
    const model = viewer.model;
    if (!model || !section.enabled) return;
    stencil.back.clippingPlanes = stencil.front.clippingPlanes = [plane];
    const added: THREE.Mesh[] = [];
    for (const face of model.faces) {
      for (const material of [stencil.back, stencil.front]) {
        const writer = new THREE.Mesh(face.geometry, material);
        writer.renderOrder = 20;
        writer.raycast = () => {};
        face.add(writer);
        added.push(writer);
      }
    }
    invalidate();
    return () => { added.forEach((mesh) => mesh.removeFromParent()); invalidate(); };
  }, [section.enabled, version, stencil, plane, invalidate]);

  useEffect(() => {
    const dark = theme === 'dark';
    // Cut faces: orange hatching, so the section reads apart from the model's own faces.
    capMaterial.uniforms.uColor.value.set(dark ? '#e0782a' : '#f0a45c');
    capMaterial.uniforms.uHatch.value.set(dark ? '#7a3510' : '#b4500f');
    capMaterial.uniforms.uSpacing.value = Math.max(box.getSize(new THREE.Vector3()).length() / 26, 0.05);
  }, [theme, box, capMaterial]);

  const frame = useMemo(() => {
    if (!cut || box.isEmpty()) return null;
    const axis = AXES[section.axis];
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    center.addScaledVector(axis, cut.position - center.dot(axis));
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const u = new THREE.Vector3(1, 0, 0).applyQuaternion(quaternion);
    const v = axis.clone().cross(u);
    const margin = size.length() * 0.08;
    const w = Math.abs(size.dot(u)) + margin * 2, h = Math.abs(size.dot(v)) + margin * 2;
    return { axis, center, quaternion, u, v, w, h, span: Math.max(w, h) * 2, min: box.min.dot(axis), max: box.max.dot(axis), handle: size.length() * 0.09 };
  }, [cut, box, section.axis]);

  // Drag the plane along its axis. Capture-phase listeners run before camera-controls,
  // so a press on the plane never orbits; a press without movement still selects.
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const fixed = !!section.saved;
  useEffect(() => {
    const canvas = gl.domElement;
    const container = canvas.parentElement;
    if (!container || !section.enabled || fixed) return;
    const raycaster = new THREE.Raycaster();
    const rayAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), viewer.camera!);
      return raycaster.ray;
    };
    const onPlane = (event: PointerEvent) => {
      const f = frameRef.current;
      if (!f || !viewer.camera) return false;
      const hit = rayAt(event).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(f.axis, f.center), new THREE.Vector3());
      if (!hit) return false;
      const local = hit.sub(f.center);
      return Math.abs(local.dot(f.u)) <= f.w / 2 && Math.abs(local.dot(f.v)) <= f.h / 2;
    };
    // Parameter along the section axis closest to the pointer ray, measured from a fixed origin.
    // The origin must not move with the plane during a drag, or each step undoes the last one.
    const axisParameter = (event: PointerEvent, origin: THREE.Vector3, axis: THREE.Vector3) => {
      const ray = rayAt(event);
      const w0 = ray.origin.clone().sub(origin);
      const b = ray.direction.dot(axis);
      const denominator = 1 - b * b;
      if (denominator < 1e-4) return null;
      return (w0.dot(axis) - b * w0.dot(ray.direction)) / denominator;
    };
    let drag: { id: number; x: number; y: number; origin: THREE.Vector3; axis: THREE.Vector3; t0: number | null; start: number; moved: boolean; button: number } | null = null;
    const frames = perFrame((offset: number) => { const current = get().section; if (current.offset !== offset) set({ section: { ...current, offset } }); });

    const onDown = (event: PointerEvent) => {
      const f = frameRef.current;
      if (event.button !== 0 || !f || !onPlane(event)) return;
      event.stopPropagation();
      event.preventDefault();
      const state = get();
      const origin = f.center.clone(), axis = f.axis.clone();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, origin, axis, t0: axisParameter(event, origin, axis), start: THREE.MathUtils.lerp(f.min, f.max, state.section.offset), moved: false, button: event.button };
      window.addEventListener('pointermove', onDrag);
      window.addEventListener('pointerup', onUp);
    };
    const onDrag = (event: PointerEvent) => {
      const f = frameRef.current;
      if (!drag || event.pointerId !== drag.id || !f) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
      if (!drag.moved) { drag.moved = true; setDragging(true); }
      let position: number;
      const t = axisParameter(event, drag.origin, drag.axis);
      if (t !== null && drag.t0 !== null) position = drag.start + (t - drag.t0);
      else {
        // Looking straight down the axis: fall back to vertical mouse travel.
        const camera = viewer.camera!;
        const perPixel = camera instanceof THREE.OrthographicCamera ? 1 / camera.zoom : (f.max - f.min) / 300;
        position = drag.start + (drag.y - event.clientY) * perPixel;
      }
      const offset = THREE.MathUtils.clamp((position - f.min) / Math.max(f.max - f.min, 1e-9), 0, 1);
      frames.push(offset);
    };
    const onUp = (event: PointerEvent) => {
      frames.flush();
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', onUp);
      const finished = drag;
      drag = null;
      setDragging(false);
      if (finished && !finished.moved) viewer.clickAt(event, finished.button);
    };
    const onHover = (event: PointerEvent) => {
      if (drag || event.buttons) return;
      const over = onPlane(event);
      viewer.sectionHot = over;
      setHot((current) => (current === over ? current : over));
      canvas.style.cursor = over ? 'grab' : canvas.style.cursor === 'grab' ? '' : canvas.style.cursor;
    };
    container.addEventListener('pointerdown', onDown, { capture: true });
    container.addEventListener('pointermove', onHover);
    return () => {
      container.removeEventListener('pointerdown', onDown, { capture: true });
      container.removeEventListener('pointermove', onHover);
      window.removeEventListener('pointermove', onDrag);
      window.removeEventListener('pointerup', onUp);
      if (canvas.style.cursor === 'grab') canvas.style.cursor = '';
      viewer.sectionHot = false;
    };
  }, [gl, section.enabled, fixed]);

  useEffect(() => {
    const canvas = gl.domElement;
    if (dragging) canvas.style.cursor = 'grabbing';
    else if (canvas.style.cursor === 'grabbing') canvas.style.cursor = hot ? 'grab' : '';
  }, [dragging, hot, gl]);

  if (!section.enabled || !frame) return null;
  capMaterial.uniforms.uU.value.copy(frame.u);
  capMaterial.uniforms.uV.value.copy(frame.v);
  const { w, h } = frame;
  const outline: [number, number, number][] = [[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0], [-w / 2, -h / 2, 0]];
  const accent = theme === 'dark' ? '#8fdcc0' : '#1f9a73';
  const active = hot || dragging;
  // The handle points into the removed half, the side the viewer is looking from.
  const toward = section.flip ? -1 : 1;
  const cap = (
    <mesh material={capMaterial} renderOrder={21} onUpdate={(mesh) => { mesh.raycast = () => {}; }}>
      <planeGeometry args={[frame.span, frame.span]} />
    </mesh>
  );
  if (fixed) return <group position={frame.center} quaternion={frame.quaternion}>{cap}</group>;
  return (
    <group position={frame.center} quaternion={frame.quaternion}>
      {cap}
      <mesh renderOrder={22}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color={accent} transparent opacity={active ? 0.13 : 0.05} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={outline} color={accent} lineWidth={active ? 2.4 : 1.4} transparent opacity={active ? 1 : 0.8} />
      <group rotation={[toward > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0]}>
        <mesh position={[0, frame.handle * 0.45, 0]} renderOrder={23}>
          <cylinderGeometry args={[frame.handle * 0.035, frame.handle * 0.035, frame.handle * 0.9, 12]} />
          <meshBasicMaterial color={accent} depthTest={false} transparent opacity={active ? 1 : 0.85} />
        </mesh>
        <mesh position={[0, frame.handle * 1.05, 0]} renderOrder={23}>
          <coneGeometry args={[frame.handle * 0.11, frame.handle * 0.3, 20]} />
          <meshBasicMaterial color={accent} depthTest={false} transparent opacity={active ? 1 : 0.85} />
        </mesh>
      </group>
    </group>
  );
}

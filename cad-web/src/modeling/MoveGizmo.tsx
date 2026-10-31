import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { get as app, set as setApp, useApp } from '@/state/store';
import { evaluate, formatNumber, type ModelDoc } from '@/lib/modeling';
import type { ModelRuntime } from '@/viewport/model';
import { viewer } from '@/viewport/viewer';
import { schedulePreview, useFeatureDialog, type DialogState } from './dialog';
import { dragStep, perFrame } from '@/viewport/dragStep';
import { bodyFaces, bodyList, moveDetail, splitTuple, type MoveDetail } from './bodies';

/**
 * Move/Copy handles: arrows, plane squares and rotation rings at the moved bodies' center.
 * Dragging writes the dialog's values (snapped: 1 mm and 5°, Shift for 0.1 mm and 1°) and moves
 * the displayed meshes right away; the preview build runs when the drag ends and replaces them.
 * Pointer handling mirrors the section plane: capture-phase listeners, so camera controls,
 * selection and pre-highlighting never see a press on or a drag of a handle.
 */

const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)] as const;
const COLORS = ['#ff6b6b', '#7ed47c', '#5aa9ff'];
const KEYS = ['tx', 'ty', 'tz'] as const;
const SIZE = 118; // px from the center to an arrow tip
const HALO = '#0b0f12';
const RING = 0.68;
const ORDER = ['free', 'axis', 'plane', 'ring'];
const IDENTITY = new THREE.Matrix4();

type Handle = { kind: 'axis' | 'plane' | 'ring'; axis: 0 | 1 | 2 } | { kind: 'free'; axis?: undefined };
interface Axis { point: THREE.Vector3; dir: THREE.Vector3 }
interface Move { bodies: string[]; offset: THREE.Vector3; axis: Axis | null; angle: number; copy: boolean; literal: boolean }
interface Drag {
  handle: Handle; pointer: number; x: number; y: number; moved: boolean; origin: THREE.Vector3; offset: THREE.Vector3;
  angle: number; sign: number; axisSource: string; t0: number | null; hit0: THREE.Vector3 | null; a0: number; prev: number; turned: number;
}

const same = (a: Handle | null, b: Handle | null) => !!a && !!b && a.kind === b.kind && a.axis === b.axis;
const snap = (value: number, step: number) => formatNumber(Number((Math.round(value / step) * step).toFixed(4)));
const round = (value: number) => formatNumber(Number(value.toFixed(4)));
const basis = (i: number) => [AXES[(i + 1) % 3], AXES[(i + 2) % 3], AXES[i]] as const;

function number(source: string | undefined, doc: ModelDoc | null) {
  return evaluate(source?.trim() || '0', doc);
}

/** The rotation axis a dialog value names, when the browser can tell: X/Y/Z, a literal, or what the build resolved. */
function axisOf(source: string, doc: ModelDoc | null, shown: MoveDetail | null): { axis: Axis | null; literal: boolean } {
  const named = /^["'](X|Y|Z)["']$/.exec(source.trim());
  if (named) return { axis: { point: new THREE.Vector3(), dir: AXES['XYZ'.indexOf(named[1])].clone() }, literal: false };
  const parts = splitTuple(source)?.map((part) => splitTuple(part)?.map((v) => evaluate(v, doc)));
  if (parts?.length === 2 && parts.every((p) => p?.length === 3 && p.every((v) => v !== null))) {
    const [p, d] = parts as number[][];
    return { axis: { point: new THREE.Vector3(...p), dir: new THREE.Vector3(...d).normalize() }, literal: true };
  }
  const a = shown?.axis;
  return { axis: a ? { point: new THREE.Vector3(a[0], a[1], a[2]), dir: new THREE.Vector3(a[3], a[4], a[5]) } : null, literal: false };
}

function readMove(state: DialogState, doc: ModelDoc | null, shown: MoveDetail | null): Move | null {
  const offset = KEYS.map((key) => number(state.values[key], doc));
  const angle = state.values.axis ? number(state.values.angle, doc) : 0;
  if (offset.some((v) => v === null) || angle === null) return null;
  const { axis, literal } = state.values.axis ? axisOf(state.values.axis, doc, shown) : { axis: null, literal: false };
  return { bodies: bodyList(state.values.bodies), offset: new THREE.Vector3(...(offset as number[])), axis, angle, copy: state.values.copy === 'True', literal };
}

/** Rotation about the axis first, then the translation (the runtime's order). */
function matrixOf(offset: THREE.Vector3, axis: Axis | null, angle: number) {
  const m = new THREE.Matrix4().makeTranslation(offset);
  if (!axis || !angle) return m;
  return m.multiply(new THREE.Matrix4().makeTranslation(axis.point))
    .multiply(new THREE.Matrix4().makeRotationAxis(axis.dir.clone().normalize(), THREE.MathUtils.degToRad(angle)))
    .multiply(new THREE.Matrix4().makeTranslation(axis.point.clone().negate()));
}

const shownMatrix = (d: MoveDetail | null) => (d ? matrixOf(new THREE.Vector3(...d.translate), axisOf('', null, d).axis, d.angle) : IDENTITY);
const isIdentity = (m: THREE.Matrix4) => m.elements.every((v, i) => Math.abs(v - IDENTITY.elements[i]) < 1e-9);

/* ───────── Temporary transforms on the displayed meshes ───────── */

let undo: (() => void)[] = [];
let undoModel: ModelRuntime | null = null;

function clearVisual() {
  // Meshes of a model that is fading out go with it; only the shown model is put back.
  if (undoModel && undoModel === viewer.model) for (const step of undo.reverse()) step();
  undo = [];
  undoModel = null;
}

function place(object: THREE.Object3D, d: THREE.Matrix4) {
  const saved = [object.position.clone(), object.quaternion.clone(), object.scale.clone()] as const;
  object.updateWorldMatrix(true, false);
  const parent = object.parent ? object.parent.matrixWorld.clone().invert() : new THREE.Matrix4();
  parent.multiply(d).multiply(object.matrixWorld).decompose(object.position, object.quaternion, object.scale);
  undo.push(() => { object.position.copy(saved[0]); object.quaternion.copy(saved[1]); object.scale.copy(saved[2]); });
}

function hide(object: THREE.Object3D) {
  const was = object.visible;
  object.visible = false;
  undo.push(() => { object.visible = was; });
}

/** Shows `move` on a model that currently shows `shown`: originals, preview copies and ghost copies. */
function showMove(model: ModelRuntime, move: Move, shown: MoveDetail | null, ghosts: THREE.Group, material: THREE.Material) {
  undoModel = model;
  const faces = bodyFaces(model);
  const target = matrixOf(move.offset, move.axis, move.angle);
  const at = shownMatrix(shown);
  const movedShown = new Set(shown && !shown.copies ? shown.bodies : []);
  const copyOf = new Map((shown?.copies ?? []).map((copy, i) => [shown!.bodies[i], copy]));
  const deltas = new Map<THREE.Mesh, THREE.Matrix4>();
  const put = (body: string | undefined, d: THREE.Matrix4) => { if (body && !isIdentity(d)) for (const mesh of faces.get(body) ?? []) deltas.set(mesh, d); };
  for (const body of new Set([...move.bodies, ...movedShown, ...copyOf.keys()])) {
    const wanted = move.bodies.includes(body);
    const now = movedShown.has(body) ? at : IDENTITY;
    put(body, (wanted && !move.copy ? target : IDENTITY).clone().multiply(now.clone().invert()));
    const copy = copyOf.get(body);
    if (copy && wanted && move.copy) put(copy, target.clone().multiply(at.clone().invert()));
    else if (copy) for (const mesh of faces.get(copy) ?? []) hide(mesh);
    else if (wanted && move.copy) {
      const d = target.clone().multiply(now.clone().invert());
      for (const mesh of faces.get(body) ?? []) {
        mesh.updateWorldMatrix(true, false);
        const ghost = new THREE.Mesh(mesh.geometry, material);
        ghost.matrixAutoUpdate = false;
        ghost.matrix.multiplyMatrices(d, mesh.matrixWorld);
        ghost.renderOrder = 4;
        ghost.raycast = () => {};
        ghosts.add(ghost);
        undo.push(() => ghost.removeFromParent());
      }
    }
  }
  // A whole mesh moving as one carries its edges and highlights; part of a mesh moves face by face without edges.
  const byMesh = new Map<number, THREE.Mesh[]>();
  for (const mesh of model.faces) {
    const index = (mesh.userData.face as { meshIndex: number }).meshIndex;
    byMesh.set(index, [...(byMesh.get(index) ?? []), mesh]);
  }
  for (const [index, meshes] of byMesh) {
    const moved = meshes.filter((mesh) => deltas.has(mesh));
    if (!moved.length) continue;
    const first = deltas.get(moved[0])!;
    const frame = model.edgeSets.find((set) => set.meshIndex === index)?.visible.parent;
    if (frame && moved.length === meshes.length && moved.every((mesh) => deltas.get(mesh)!.equals(first)) && meshes.every((mesh) => mesh === frame || mesh.parent === frame)) {
      place(frame, first);
      continue;
    }
    for (const mesh of moved) place(mesh, deltas.get(mesh)!);
    for (const set of model.edgeSets) if (set.meshIndex === index) { hide(set.visible); hide(set.hidden); }
  }
}

/** Center of the bodies' faces as they were before this move (the display may already show it). */
function pivotOf(model: ModelRuntime, bodies: string[], shown: MoveDetail | null): THREE.Vector3 | null {
  const faces = bodyFaces(model);
  const box = new THREE.Box3();
  model.root.updateWorldMatrix(true, true);
  for (const body of bodies) {
    for (const mesh of faces.get(body) ?? []) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
    }
  }
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const moved = shown && !shown.copies && bodies.some((body) => shown.bodies.includes(body));
  return moved ? center.applyMatrix4(shownMatrix(shown).clone().invert()) : center;
}

/* ───────── The handles ───────── */

export default function MoveGizmo() {
  const active = useFeatureDialog((s) => s.open && s.kind === 'move');
  return active ? <Gizmo /> : null;
}

function Gizmo() {
  const state = useFeatureDialog();
  const doc = useApp((s) => s.modeling);
  const theme = useApp((s) => s.theme);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const [model, setModel] = useState(viewer.model);
  const [hover, setHover] = useState<Handle | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pivots, setPivots] = useState<Record<string, THREE.Vector3>>({});
  const gizmo = useRef<THREE.Group>(null);
  const ghosts = useRef<THREE.Group>(null);
  const hits = useRef<THREE.Mesh[]>([]);
  const green = theme === 'light' ? '#1f9a73' : '#8fdcc0';
  const ghostMaterial = useMemo(() => new THREE.MeshStandardMaterial({ color: green, transparent: true, opacity: 0.42, roughness: 0.5, metalness: 0.1, depthWrite: false }), [green]);
  useEffect(() => () => ghostMaterial.dispose(), [ghostMaterial]);
  useEffect(() => viewer.onModelChange(() => setModel(viewer.model)), []);

  const shown = moveDetail(model?.build, state.id);
  const move = useMemo(() => readMove(state, doc, shown), [state, doc, shown]);
  const lastMove = useRef<Move | null>(null);
  if (move) lastMove.current = move;
  const current = move ?? lastMove.current;
  const key = current?.bodies.join('|') ?? '';

  // The pivot is found once per set of bodies, so previews arriving never make the handles jump.
  useEffect(() => {
    if (!model || !key || pivots[key]) return;
    clearVisual();
    const point = pivotOf(model, key.split('|'), shown);
    if (point) setPivots((all) => ({ ...all, [key]: point }));
  }, [model, key, pivots, shown]);

  let pivot = pivots[key] ?? null;
  // An axis through the pivot (what dragging a ring writes) keeps the rings centered on it.
  if (pivot && current?.axis && current.literal) {
    const { point, dir } = current.axis;
    pivot = point.clone().addScaledVector(dir, pivot.clone().sub(point).dot(dir));
  }
  const matrix = current ? matrixOf(current.offset, current.axis, current.angle) : IDENTITY;
  const center = pivot ? pivot.clone().applyMatrix4(matrix) : null;

  useEffect(() => {
    clearVisual();
    if (model && current && ghosts.current) showMove(model, current, shown, ghosts.current, ghostMaterial);
    invalidate();
  }, [model, current, shown, ghostMaterial, invalidate]);
  useEffect(() => () => { clearVisual(); invalidate(); }, [invalidate]);

  useFrame(({ camera, size }) => {
    const group = gizmo.current;
    if (!group) return;
    const perPixel = camera instanceof THREE.OrthographicCamera ? 1 / camera.zoom
      : (2 * group.position.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2)) / size.height;
    group.scale.setScalar(perPixel * SIZE);
  });

  // Live refs for the pointer handlers.
  const live = useRef({ center, pivot, current, drag, hover });
  live.current = { center, pivot, current, drag, hover };

  useEffect(() => {
    const canvas = gl.domElement;
    const container = canvas.parentElement;
    if (!container) return;
    const raycaster = new THREE.Raycaster();
    const rayAt = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), viewer.camera!);
      return raycaster.ray.clone();
    };
    const handleAt = (event: PointerEvent): Handle | null => {
      if (!gizmo.current || !viewer.camera) return null;
      rayAt(event);
      gizmo.current.updateWorldMatrix(true, true);
      const found = raycaster.intersectObjects(hits.current, false)
        .map((hit) => hit.object.userData.handle as Handle)
        .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
      return found[0] ?? null;
    };
    const perPixel = () => (gizmo.current ? gizmo.current.scale.x / SIZE : 1);
    const axisParameter = (ray: THREE.Ray, origin: THREE.Vector3, dir: THREE.Vector3) => {
      const w0 = ray.origin.clone().sub(origin);
      const b = ray.direction.dot(dir);
      const denominator = 1 - b * b;
      return denominator < 1e-3 ? null : (w0.dot(dir) - b * w0.dot(ray.direction)) / denominator;
    };
    const planeHit = (ray: THREE.Ray, origin: THREE.Vector3, normal: THREE.Vector3) =>
      Math.abs(ray.direction.dot(normal)) < 0.02 ? null : ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), new THREE.Vector3());
    const ringAngle = (ray: THREE.Ray, origin: THREE.Vector3, i: number) => {
      const [u, w, n] = basis(i);
      if (Math.abs(ray.direction.dot(n)) < 0.12) return null;  // Edge-on ring: use sideways travel instead.
      const hit = planeHit(ray, origin, n);
      if (!hit) return null;
      hit.sub(origin);
      return Math.atan2(hit.dot(w), hit.dot(u));
    };
    let drag: Drag | null = null;

    const write = (patch: Record<string, string>) => {
      useFeatureDialog.setState((s) => ({ values: { ...s.values, ...patch }, status: 'idle', message: null }));
    };

    // Pointer moves come faster than frames: the dialog (and the previewed placement) updates once per frame.
    const frames = perFrame(({ patch, drag: next }: { patch: Record<string, string>; drag: NonNullable<typeof drag> }) => { write(patch); setDrag(next); });

    const onDown = (event: PointerEvent) => {
      const { center: at, current: move, pivot: p } = live.current;
      if (event.button !== 0 || !at || !move || !p || !container.contains(event.target as Node)) return;
      const handle = handleAt(event);
      if (!handle) return;
      event.stopPropagation();
      event.preventDefault();
      const ray = rayAt(event);
      const values = useFeatureDialog.getState().values;
      let angle = move.angle, sign = 1, axisSource = values.axis ?? '';
      if (handle.kind === 'ring') {
        // One rotation per move: the ring's axis through the pivot, unless the current axis already is that line.
        const dir = AXES[handle.axis];
        const through = move.axis && Math.abs(Math.abs(move.axis.dir.dot(dir)) - 1) < 1e-9
          && p.clone().sub(move.axis.point).cross(move.axis.dir).length() < 1e-3;
        if (through) sign = Math.sign(move.axis!.dir.dot(dir));
        else {
          angle = 0;
          const onWorld = [0, 1, 2].every((k) => k === handle.axis || Math.abs(p.getComponent(k)) < 1e-6);
          axisSource = onWorld ? `"${'XYZ'[handle.axis]}"` : `((${round(p.x)}, ${round(p.y)}, ${round(p.z)}), (${dir.toArray().join(', ')}))`;
        }
      }
      const a0 = handle.kind === 'ring' ? ringAngle(ray, at, handle.axis) : null;
      drag = {
        handle, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, origin: at.clone(), offset: move.offset.clone(),
        angle, sign, axisSource, t0: handle.kind === 'axis' ? axisParameter(ray, at, AXES[handle.axis]) : null,
        hit0: handle.kind === 'plane' ? planeHit(ray, at, AXES[handle.axis]) : handle.kind === 'free' ? planeHit(ray, at, viewer.cameraDirection()) : null,
        a0: a0 ?? 0, prev: a0 ?? 0, turned: 0,
      };
      if (app().hover) setApp({ hover: null, hoverAlso: [] });
      // Window capture runs before the container's, which swallows moves during a drag.
      window.addEventListener('pointermove', onDrag, { capture: true });
      window.addEventListener('pointerup', onUp, { capture: true });
    };

    const onDrag = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        schedulePreview(1e9);  // Hold previews back until the drag ends.
      }
      const fine = event.shiftKey;
      const step = dragStep(perPixel(), fine);
      const ray = rayAt(event);
      const { handle, origin, offset } = drag;
      const patch: Record<string, string> = {};
      if (handle.kind === 'axis') {
        const t = axisParameter(ray, origin, AXES[handle.axis]);
        const delta = t !== null && drag.t0 !== null ? t - drag.t0 : (drag.y - event.clientY) * perPixel();
        patch[KEYS[handle.axis]] = snap(offset.getComponent(handle.axis) + delta, step);
      } else if (handle.kind === 'plane' || handle.kind === 'free') {
        const hit = planeHit(ray, origin, handle.kind === 'plane' ? AXES[handle.axis] : viewer.cameraDirection());
        if (!hit || !drag.hit0) return;
        const delta = hit.sub(drag.hit0);
        for (let k = 0; k < 3; k++) if (handle.kind === 'free' || k !== handle.axis) patch[KEYS[k]] = snap(offset.getComponent(k) + delta.getComponent(k), step);
      } else {
        const a = ringAngle(ray, origin, handle.axis);
        if (a === null) drag.turned = THREE.MathUtils.degToRad((event.clientX - drag.x) * 0.6);
        else {
          drag.turned += Math.atan2(Math.sin(a - drag.prev), Math.cos(a - drag.prev));
          drag.prev = a;
        }
        patch.axis = drag.axisSource;
        patch.angle = snap(drag.angle + drag.sign * THREE.MathUtils.radToDeg(drag.turned), fine ? 1 : 5);
      }
      frames.push({ patch, drag: { ...drag } });
    };

    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      frames.flush();
      window.removeEventListener('pointermove', onDrag, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      if (drag.moved) schedulePreview(0);
      drag = null;
      setDrag(null);
    };

    const onHover = (event: PointerEvent) => {
      if (drag) { event.stopPropagation(); return; }  // No pre-highlight under a drag.
      if (event.buttons) return;
      const handle = handleAt(event);
      if (handle) {
        event.stopPropagation();  // The model under the handle doesn't pre-highlight.
        if (app().hover) setApp({ hover: null, hoverAlso: [] });
      }
      if (!same(handle, live.current.hover) && (handle || live.current.hover)) setHover(handle);
      canvas.style.cursor = handle ? 'grab' : canvas.style.cursor === 'grab' ? '' : canvas.style.cursor;
    };

    // Presses go through window capture so a handle wins over the section plane underneath.
    window.addEventListener('pointerdown', onDown, { capture: true });
    container.addEventListener('pointermove', onHover, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true });
      container.removeEventListener('pointermove', onHover, { capture: true });
      window.removeEventListener('pointermove', onDrag, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      if (drag?.moved) schedulePreview(0);
      if (canvas.style.cursor === 'grab' || canvas.style.cursor === 'grabbing') canvas.style.cursor = '';
    };
  }, [gl]);

  useEffect(() => {
    if (drag) gl.domElement.style.cursor = 'grabbing';
    else if (gl.domElement.style.cursor === 'grabbing') gl.domElement.style.cursor = hover ? 'grab' : '';
    invalidate();
  }, [drag, hover, gl, invalidate]);

  const register = (handle: Handle) => (mesh: THREE.Mesh | null) => {
    hits.current = hits.current.filter((m) => m.parent && m !== mesh && !same(m.userData.handle, handle));
    if (mesh) { mesh.userData.handle = handle; hits.current.push(mesh); }
  };
  const look = (handle: Handle, base: string, rest = 0.9) => {
    const hot = same(handle, hover) || same(handle, drag?.handle ?? null);
    return { color: hot ? green : base, opacity: drag && !hot ? 0.16 : hot ? 1 : rest, hot };
  };
  const overlay = { transparent: true, depthTest: false, depthWrite: false, toneMapped: false } as const;

  return (
    <>
      <group ref={ghosts} />
      {center && drag?.moved && drag.handle.kind !== 'ring' && (
        <Line points={[drag.origin, center]} color={green} lineWidth={1.6} dashed dashSize={2} gapSize={1.4} depthTest={false} transparent opacity={0.9} renderOrder={79} />
      )}
      {center && (
        <group ref={gizmo} position={center}>
          {[0, 1, 2].map((i) => {
            const handle: Handle = { kind: 'axis', axis: i as 0 | 1 | 2 };
            const { color, opacity, hot } = look(handle, COLORS[i]);
            const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), AXES[i]);
            return (
              <group key={`axis${i}`} quaternion={turn} scale={hot ? 1.12 : 1}>
                <mesh position={[0, 0.52, 0]} renderOrder={80}><cylinderGeometry args={[0.03, 0.03, 0.66, 10]} /><meshBasicMaterial color={HALO} opacity={opacity * 0.4} {...overlay} /></mesh>
                <mesh position={[0, 0.91, 0]} renderOrder={80}><coneGeometry args={[0.07, 0.22, 20]} /><meshBasicMaterial color={HALO} opacity={opacity * 0.4} {...overlay} /></mesh>
                <mesh position={[0, 0.52, 0]} renderOrder={81}><cylinderGeometry args={[0.015, 0.015, 0.64, 10]} /><meshBasicMaterial color={color} opacity={opacity} {...overlay} /></mesh>
                <mesh position={[0, 0.91, 0]} renderOrder={81}><coneGeometry args={[0.052, 0.18, 20]} /><meshBasicMaterial color={color} opacity={opacity} {...overlay} /></mesh>
                <mesh ref={register(handle)} position={[0, 0.6, 0]} visible={false}><cylinderGeometry args={[0.065, 0.065, 0.84, 8]} /></mesh>
              </group>
            );
          })}
          {[0, 1, 2].map((i) => {
            const handle: Handle = { kind: 'plane', axis: i as 0 | 1 | 2 };
            const { color, opacity, hot } = look(handle, COLORS[i], 0.75);
            const [u, w, n] = basis(i);
            const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, w, n));
            const edge: [number, number, number][] = [[-0.08, -0.08, 0], [0.08, -0.08, 0], [0.08, 0.08, 0], [-0.08, 0.08, 0], [-0.08, -0.08, 0]];
            return (
              <group key={`plane${i}`} position={u.clone().add(w).multiplyScalar(0.34)} quaternion={turn}>
                <mesh ref={register(handle)} renderOrder={80}><planeGeometry args={[0.16, 0.16]} /><meshBasicMaterial color={color} opacity={opacity * (hot ? 0.45 : 0.28)} side={THREE.DoubleSide} {...overlay} /></mesh>
                <Line points={edge} color={color} lineWidth={hot ? 2 : 1.3} transparent opacity={opacity} depthTest={false} renderOrder={81} />
              </group>
            );
          })}
          {[0, 1, 2].map((i) => {
            const handle: Handle = { kind: 'ring', axis: i as 0 | 1 | 2 };
            const { color, opacity, hot } = look(handle, COLORS[i]);
            const [u, w, n] = basis(i);
            const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, w, n));
            const active = same(handle, drag?.handle ?? null) && drag?.moved;
            const swept = active ? drag!.sign * THREE.MathUtils.degToRad(Number(state.values.angle) - drag!.angle) : 0;
            return (
              <group key={`ring${i}`} quaternion={turn}>
                <mesh rotation={[0, 0, Math.PI / 18]} renderOrder={80}><torusGeometry args={[RING, 0.026, 6, 40, (Math.PI * 7) / 18]} /><meshBasicMaterial color={HALO} opacity={opacity * 0.4} {...overlay} /></mesh>
                <mesh rotation={[0, 0, Math.PI / 18]} renderOrder={81}><torusGeometry args={[RING, hot ? 0.016 : 0.011, 6, 40, (Math.PI * 7) / 18]} /><meshBasicMaterial color={color} opacity={opacity} {...overlay} /></mesh>
                <mesh ref={register(handle)} rotation={[0, 0, Math.PI / 18]} visible={false}><torusGeometry args={[RING, 0.055, 4, 20, (Math.PI * 7) / 18]} /></mesh>
                {hot && <mesh renderOrder={79}><torusGeometry args={[RING, 0.004, 4, 96]} /><meshBasicMaterial color={color} opacity={0.45} {...overlay} /></mesh>}
                {active && Math.abs(swept) > 1e-6 && (
                  <mesh renderOrder={78}>
                    <circleGeometry args={[RING, 48, swept > 0 ? drag!.a0 : drag!.a0 + swept, Math.abs(swept)]} />
                    <meshBasicMaterial color={green} opacity={0.2} side={THREE.DoubleSide} {...overlay} />
                  </mesh>
                )}
              </group>
            );
          })}
          <mesh renderOrder={82} scale={same(hover, { kind: 'free' }) || drag?.handle.kind === 'free' ? 1.25 : 1}>
            <sphereGeometry args={[0.05, 20, 14]} />
            <meshBasicMaterial color={same(hover, { kind: 'free' }) || drag?.handle.kind === 'free' ? green : '#e9eef1'} opacity={drag && drag.handle.kind !== 'free' ? 0.2 : 1} {...overlay} />
          </mesh>
          <mesh ref={register({ kind: 'free' })} visible={false}><sphereGeometry args={[0.1, 10, 8]} /></mesh>
          {drag?.moved && <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}><Readout drag={drag} values={state.values} /></Html>}
        </group>
      )}
    </>
  );
}

function Readout({ drag, values }: { drag: Drag; values: DialogState['values'] }) {
  const { handle } = drag;
  const text = handle.kind === 'ring' ? `${values.angle}°`
    : handle.kind === 'axis' ? `${'XYZ'[handle.axis]} ${values[KEYS[handle.axis]]} mm`
      : handle.kind === 'plane' ? `${[0, 1, 2].filter((k) => k !== handle.axis).map((k) => `${'XYZ'[k]} ${values[KEYS[k]]}`).join('  ')} mm`
        : `${KEYS.map((k) => values[k]).join(', ')} mm`;
  return (
    <span style={{
      display: 'inline-block', transform: 'translate(18px, -34px)', padding: '3px 8px', borderRadius: 6, whiteSpace: 'nowrap',
      font: '600 var(--fs-xs) var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: 'var(--text-1)',
      background: 'var(--bg-overlay)', border: '1px solid color-mix(in srgb, var(--ws) 55%, transparent)', boxShadow: 'var(--shadow-2)',
    }}>{text}</span>
  );
}

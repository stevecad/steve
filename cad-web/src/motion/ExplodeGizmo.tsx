/**
 * The Explode steps tool's arrows on the canvas: at the active step's parts, one per axis. Drag one to move the step's
 * parts along it (1 mm steps; Shift 10 mm, Alt 0.1 mm); the panel shows the move as typed numbers.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { activeParts, dragStep, useExplodeTool } from './explodeTool';
import { nodeOfPath } from './PoseLayer';
import { useMotion } from './state';

const AXES = [
  { axis: new THREE.Vector3(1, 0, 0), color: 0xe5484d, name: 'x' },
  { axis: new THREE.Vector3(0, 1, 0), color: 0x30a46c, name: 'y' },
  { axis: new THREE.Vector3(0, 0, 1), color: 0x3e63dd, name: 'z' },
] as const;

type Vec = [number, number, number];

export default function ExplodeGizmo() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const open = useApp((state) => state.tool === 'explodeSteps');
  const active = useExplodeTool((state) => state.active);
  const steps = useExplodeTool((state) => state.steps);
  const auto = useExplodeTool((state) => state.auto);
  const pose = useMotion((state) => state.pose);
  const handles = useRef<THREE.Object3D[]>([]);
  const frame = useMemo(() => {
    const model = viewer.model;
    const parts = open ? activeParts() : [];
    if (!model || !parts.length) return null;
    const box = new THREE.Box3();
    for (const part of parts) {
      const node = nodeOfPath(model, part);
      if (node) box.union(model.bounds(false, node));
    }
    if (box.isEmpty()) return null;
    const size = Math.max(10, Math.min(box.getSize(new THREE.Vector3()).length() * 0.6, viewer.modelRadius() * 0.5));
    return { centre: box.getCenter(new THREE.Vector3()), size };
  }, [open, active, steps, auto, pose]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { invalidate(); }, [frame, invalidate]);

  useEffect(() => {
    if (!frame) return;
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    let drag: { pointer: number; axis: THREE.Vector3; origin: THREE.Vector3; anchor: number; start: Record<string, Vec>; index: number } | null = null;
    const rayAt = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, viewer.camera!);
      return raycaster.ray.clone();
    };
    /** Where along the axis line the pointer's ray passes closest (null looking straight down it). */
    const along = (ray: THREE.Ray, axis: THREE.Vector3, origin: THREE.Vector3) => {
      const w0 = origin.clone().sub(ray.origin);
      const b = axis.dot(ray.direction);
      const denominator = 1 - b * b;
      return denominator < 1e-3 ? null : (b * ray.direction.dot(w0) - axis.dot(w0)) / denominator;
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.target !== element || !viewer.camera) return;
      const ray = rayAt(event);
      raycaster.ray.copy(ray);
      const hit = raycaster.intersectObjects(handles.current, true)[0];
      const axisName = hit?.object.userData.explodeAxis as string | undefined;
      const { active: index, steps: current } = useExplodeTool.getState();
      if (!axisName || index === null || !current[index]) return;
      const axis = AXES.find((item) => item.name === axisName)!.axis.clone();
      const anchor = along(ray, axis, frame.centre);
      if (anchor === null) return;
      event.stopPropagation();
      event.preventDefault();
      drag = { pointer: event.pointerId, axis, origin: frame.centre.clone(), anchor, index,
        start: Object.fromEntries(Object.entries(current[index].moves).map(([part, v]) => [part, [...v] as Vec])) };
      element.style.cursor = 'grabbing';
      window.addEventListener('pointermove', onMove, { capture: true });
      window.addEventListener('pointerup', onUp, { capture: true });
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      event.stopPropagation();
      const t = along(rayAt(event), drag.axis, drag.origin);
      if (t === null) return;
      const snap = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
      const distance = Math.round((t - drag.anchor) / snap) * snap;
      dragStep(drag.index, drag.start, drag.axis.toArray().map((v) => v * distance) as Vec);
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      event.stopPropagation();
      drag = null;
      element.style.cursor = '';
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
    };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
    };
  }, [gl, frame]);

  if (!frame) return null;
  const { centre, size } = frame;
  const shaft = size * 0.75, head = size * 0.22, radius = size * 0.025;
  handles.current = [];
  return (
    <group name="explode-gizmo" position={centre} renderOrder={20}>
      {AXES.map(({ axis, color, name }) => {
        const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        return (
          <group key={name} quaternion={turn} ref={(group) => { if (group) handles.current.push(group); }}>
            <mesh position={[0, shaft / 2, 0]} userData={{ explodeAxis: name }} renderOrder={20}>
              <cylinderGeometry args={[radius * 2.5, radius * 2.5, shaft, 8]} />
              <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.9} />
            </mesh>
            <mesh position={[0, shaft + head / 2, 0]} userData={{ explodeAxis: name }} renderOrder={20}>
              <coneGeometry args={[head * 0.38, head, 16]} />
              <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
            </mesh>
          </group>
        );
      })}
      <mesh renderOrder={20}>
        <sphereGeometry args={[radius * 4, 12, 12]} />
        <meshBasicMaterial color={0xffffff} depthTest={false} transparent opacity={0.8} />
      </mesh>
    </group>
  );
}

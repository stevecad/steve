/**
 * A machine model's frames, for drawing it: the same rigid transforms as the backend's forward kinematics
 * (manufacturing/machines.py `forward_kinematics`): each node is its parent's frame, composed with its own frame, composed
 * with its joint motion (a translation along a linear axis, a rotation about a rotary one). Display only — the backend
 * computes the poses and collisions it checks.
 *
 * A Frame maps local to parent coordinates: p_parent = origin + [x y z] · p_local (axes are columns).
 */
import * as THREE from 'three';

export type Vec3 = [number, number, number];
export interface Frame { origin_mm: Vec3; x: Vec3; y: Vec3; z: Vec3 }
export interface Limits { unit: string; minimum: number; maximum: number }
export interface MachineNode { id: string; parent?: string | null; kind: 'fixed' | 'linear' | 'rotary'; frame?: Partial<Frame> | null; axis?: Vec3 | null; limits?: Limits | null }
export interface Pose { id: string; positions: { joint: string; value: number }[] }

export const IDENTITY: Frame = { origin_mm: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export const frameOf = (raw?: Partial<Frame> | null): Frame => ({
  origin_mm: (raw?.origin_mm ?? IDENTITY.origin_mm) as Vec3, x: (raw?.x ?? IDENTITY.x) as Vec3, y: (raw?.y ?? IDENTITY.y) as Vec3, z: (raw?.z ?? IDENTITY.z) as Vec3,
});

/** R · v with R's columns x, y, z. */
const rotate = (frame: Frame, v: Vec3): Vec3 => [0, 1, 2].map((row) => frame.x[row] * v[0] + frame.y[row] * v[1] + frame.z[row] * v[2]) as Vec3;

/** a ∘ b: b's local coordinates into a's parent. */
export function compose(a: Frame, b: Frame): Frame {
  const origin = rotate(a, b.origin_mm);
  return {
    origin_mm: [a.origin_mm[0] + origin[0], a.origin_mm[1] + origin[1], a.origin_mm[2] + origin[2]],
    x: rotate(a, b.x), y: rotate(a, b.y), z: rotate(a, b.z),
  };
}

function motion(node: MachineNode, value: number): Frame {
  const axis = node.axis ?? [0, 0, 1];
  if (node.kind === 'linear') return { ...IDENTITY, origin_mm: [axis[0] * value, axis[1] * value, axis[2] * value] };
  if (node.kind === 'rotary') {
    const [x, y, z] = axis;
    const c = Math.cos(value), s = Math.sin(value), d = 1 - c;
    return {
      origin_mm: [0, 0, 0],
      x: [c + x * x * d, y * x * d + z * s, z * x * d - y * s],
      y: [x * y * d - z * s, c + y * y * d, z * y * d + x * s],
      z: [x * z * d + y * s, y * z * d - x * s, c + z * z * d],
    };
  }
  return IDENTITY;
}

/** Every node's frame in machine coordinates at these joint values (missing joints at 0, clamped into their limits). */
export function forwardKinematics(nodes: MachineNode[], values: Record<string, number>, mounting: Frame = IDENTITY): Record<string, Frame> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const out: Record<string, Frame> = {};
  const visiting = new Set<string>();
  const resolve = (id: string): Frame => {
    if (out[id]) return out[id];
    const node = byId.get(id);
    if (!node || visiting.has(id)) return mounting;
    visiting.add(id);
    const parent = node.parent ? resolve(node.parent) : mounting;
    out[id] = compose(compose(parent, frameOf(node.frame)), motion(node, node.kind === 'fixed' ? 0 : restValue(node, values[id])));
    return out[id];
  };
  for (const node of nodes) resolve(node.id);
  return out;
}

/** A joint's value: the given one inside its limits, else 0 (or the nearest limit when 0 is outside them). */
export function restValue(node: MachineNode, value?: number): number {
  const wanted = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (!node.limits) return wanted;
  return Math.min(Math.max(wanted, node.limits.minimum), node.limits.maximum);
}

export function toMatrix4(frame: Frame): THREE.Matrix4 {
  return new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.x), new THREE.Vector3(...frame.y), new THREE.Vector3(...frame.z))
    .setPosition(new THREE.Vector3(...frame.origin_mm));
}

/** Moving joints with limits: the pose sliders. */
export const joints = (nodes: MachineNode[]) => nodes.filter((node) => node.kind !== 'fixed' && node.limits);

/** The chain from the root to a node, for listing bodies in machine order. */
export function depthOf(nodes: MachineNode[], id: string): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let depth = 0;
  for (let node = byId.get(id); node?.parent && depth < 128; node = byId.get(node.parent)) depth += 1;
  return depth;
}

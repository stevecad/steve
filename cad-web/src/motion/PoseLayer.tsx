/**
 * Moves the design's instances to the live joint pose (forward kinematics) and draws the selected
 * joint: its axis, and a ring for turning joints or an arrow for sliding ones. Lives inside the
 * Canvas; the motion store says where everything is. Imports nothing of the editor's, so the share
 * page (web/src/share) uses it as is: SharedMotionLayer. The editor's MotionLayer adds its own parts.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { get, useApp } from '@/state/store';
import { pretty } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import type { ModelRuntime } from '@/viewport/model';
import { instanceMotions, kinematicsOf, movedBy, turns, type Kinematics, type Pose } from './kinematics';
import { loadKinematics, useMotion } from './state';
import { useMotionDrag } from './drag';

/** Each moved node's local matrix at rest (as built), per loaded model (a new build starts over). */
const bases = new WeakMap<ModelRuntime, Map<string, THREE.Matrix4>>();
/** The nodes inside instances (a linked design's, by an explode's path) the last pose moved, per model. */
const nestedMoved = new WeakMap<ModelRuntime, Set<string>>();

/** The viewer node of each design instance (instances are the document's children, named by `pretty`). */
export function instanceNodes(model: ModelRuntime): Map<string, string> {
  const out = new Map<string, string>();
  const root = model.tree[model.rootId];
  for (const id of root?.children ?? []) out.set(model.tree[id].name, id);
  return out;
}

export function nodeOfInstance(model: ModelRuntime, instance: string): string | undefined {
  return instanceNodes(model).get(pretty(instance));
}

/** The viewer node of an instance, or of a linked design's instance by path ("kit/tray": Tray under Kit). */
export function nodeOfPath(model: ModelRuntime, path: string): string | undefined {
  const [top, ...rest] = path.split('/');
  let node = nodeOfInstance(model, top);
  for (const name of rest) {
    if (!node) return undefined;
    node = model.tree[node]?.children.find((child) => model.tree[child]?.name === pretty(name));
  }
  return node;
}

const localOf = (object: THREE.Object3D) => new THREE.Matrix4().compose(object.position, object.quaternion, object.scale);

function baseOf(model: ModelRuntime): Map<string, THREE.Matrix4> {
  let base = bases.get(model);
  if (!base) { base = new Map(); bases.set(model, base); }
  return base;
}

/** An instance node's local matrix at rest (as built), whatever pose it shows now. */
export function restMatrix(model: ModelRuntime, object: THREE.Object3D): THREE.Matrix4 {
  const base = bases.get(model);
  const id = object.userData.treeId as string | undefined ?? [...model.objects].find(([, item]) => item === object)?.[0];
  return (id && base?.get(id)?.clone()) || localOf(object);
}

/** An object's world matrix with every node at rest. */
function restWorld(model: ModelRuntime, object: THREE.Object3D | null): THREE.Matrix4 {
  if (!object) return new THREE.Matrix4();
  if (object === model.root || !object.parent) {
    object.parent?.updateWorldMatrix(true, false);
    return (object.parent?.matrixWorld.clone() ?? new THREE.Matrix4()).multiply(restMatrix(model, object));
  }
  return restWorld(model, object.parent).multiply(restMatrix(model, object));
}

/**
 * Where each node a pose moves goes, as its local matrix: each motion is a world motion from rest, and a node inside
 * a moved instance (a linked design's, by path) gets the part of its motion its parent doesn't already give it.
 * Parents come before their children.
 */
export function posedLocals(model: ModelRuntime, kinematics: Kinematics | null, pose: Pose): { id: string; path: string; object: THREE.Object3D; local: THREE.Matrix4 }[] {
  const base = baseOf(model);
  const motions = kinematics ? instanceMotions(kinematics, pose) : new Map<string, THREE.Matrix4>();
  const byNode = new Map<string, { path: string; motion: THREE.Matrix4 }>();
  for (const [path, motion] of motions) {
    const id = nodeOfPath(model, path);
    if (id) byNode.set(id, { path, motion });
  }
  const depth = (id: string) => { let d = 0; for (let n = model.tree[id]; n?.parent; n = model.tree[n.parent]) d++; return d; };
  const out = [];
  for (const [id, { path, motion }] of [...byNode].sort(([a], [b]) => depth(a) - depth(b))) {
    const object = model.objects.get(id);
    if (!object) continue;
    if (!base.has(id)) base.set(id, localOf(object));
    // The nearest moved ancestor carries this node part of the way: local = Pr⁻¹ · Δa⁻¹ · Δ · Pr · rest.
    let ancestor = new THREE.Matrix4();
    for (let up = model.tree[id]?.parent; up; up = model.tree[up]?.parent) {
      const moved = byNode.get(up);
      if (moved) { ancestor = moved.motion; break; }
    }
    const parentRest = restWorld(model, object.parent);
    const local = parentRest.clone().invert().multiply(ancestor.clone().invert()).multiply(motion).multiply(parentRest).multiply(base.get(id)!);
    out.push({ id, path, object, local });
  }
  return out;
}

/** Puts every moved instance where the pose says (and the others back at rest). */
export function applyPose(model: ModelRuntime, kinematics: Kinematics | null, pose: Pose) {
  const base = baseOf(model);
  const nested = nestedMoved.get(model) ?? new Set<string>();
  // Everything back at rest first: the instances, and whatever inside them the last pose moved.
  for (const id of [...instanceNodes(model).values(), ...nested]) {
    const object = model.objects.get(id);
    if (!object) continue;
    if (!base.has(id)) base.set(id, localOf(object));
    base.get(id)!.decompose(object.position, object.quaternion, object.scale);
  }
  const top = new Set(instanceNodes(model).values());
  const now = new Set<string>();
  model.root.updateMatrixWorld(true);
  for (const { id, object, local } of posedLocals(model, kinematics, pose)) {
    local.decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld(true);
    if (!top.has(id)) now.add(id);
  }
  nestedMoved.set(model, now);
  model.root.updateMatrixWorld(true);
}

/**
 * Loads the displayed build's joints into the motion store and keeps the model at the live pose. `shared`: the share
 * page, whose build carries joints only when its owner let visitors move the mechanism (the editor: designs only).
 */
export function usePose(shared: boolean) {
  const invalidate = useThree((state) => state.invalidate);
  const displayed = useApp((state) => state.displayed);
  const kinematics = useMemo(() => (shared || get().doc.kind === 'design' ? kinematicsOf(displayed?.metadata) : null), [displayed, shared]);

  useEffect(() => { loadKinematics(displayed?.id ?? null, kinematics); }, [displayed?.id, kinematics]);

  // Re-apply on every pose change and whenever a new model loads.
  useEffect(() => {
    const apply = () => {
      const model = viewer.model;
      const state = useMotion.getState();
      if (model && model.build.id === state.build) applyPose(model, state.kinematics, state.pose);
      invalidate();
    };
    apply();
    const unsubscribe = useMotion.subscribe((state, previous) => {
      if (state.pose !== previous.pose || state.kinematics !== previous.kinematics) apply();
      // The canvas renders on demand: a drive that starts needs its first frame asked for.
      else if (state.playing && state.playing !== previous.playing) invalidate();
    });
    const unwatch = viewer.onModelChange(apply);
    return () => { unsubscribe(); unwatch(); };
  }, [invalidate]);
}

const always = () => true;

/** The share page's mechanism: drag a moving part along its joint, and see the selected joint. */
export function SharedMotionLayer() {
  usePose(true);
  useMotionDrag(always, true);
  return <JointGlyph />;
}

/** The selected (or playing) joint: its axis through the mechanism, a ring or an arrow. */
const GREEN = { dark: 0x5fcfa5, light: 0x1f9a73 };

/** `draftLimits`: the limits as typed while the Joint tool edits this joint (the editor). */
export function JointGlyph({ draftLimits = null }: { draftLimits?: [number, number] | null }) {
  const theme = useApp((state) => state.theme);
  const color = GREEN[theme === 'light' ? 'light' : 'dark'];
  const active = useMotion((state) => state.active ?? state.playing);
  const kinematics = useMotion((state) => state.kinematics);
  const pose = useMotion((state) => state.pose);
  const joint = kinematics?.joints.find((item) => item.name === active);
  const geometry = useMemo(() => {
    if (!joint || joint.type === 'rigid' || !kinematics) return null;
    // The axis rides with the joint's parent.
    const parentMotion = instanceMotions(kinematics, pose).get(joint.parent) ?? new THREE.Matrix4();
    const origin = new THREE.Vector3().fromArray(joint.origin).applyMatrix4(parentMotion);
    const axis = new THREE.Vector3().fromArray(joint.axis).transformDirection(parentMotion).normalize();
    const model = viewer.model;
    let size = 30;
    if (model) {
      const box = new THREE.Box3();
      for (const instance of movedBy(kinematics, joint.name)) {
        const node = nodeOfInstance(model, instance);
        if (node) box.union(model.bounds(false, node));
      }
      if (!box.isEmpty()) size = Math.max(12, box.getSize(new THREE.Vector3()).length() * 0.5);
    }
    const half = axis.clone().multiplyScalar(size);
    const line: [THREE.Vector3, THREE.Vector3] = [origin.clone().sub(half), origin.clone().add(half)];
    const ring: THREE.Vector3[] = [];
    if (turns(joint)) {
      const u = new THREE.Vector3().crossVectors(axis, Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
      const v = new THREE.Vector3().crossVectors(axis, u);
      const radius = size * 0.35;
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 1.75;
        ring.push(origin.clone().addScaledVector(u, Math.cos(t) * radius).addScaledVector(v, Math.sin(t) * radius));
      }
    }
    // A turning joint with limits: the arc it may sweep, measured from where its part is at 0°.
    const range: THREE.Vector3[] = [];
    const limits = draftLimits ?? joint.limits;
    if (turns(joint) && limits && model) {
      const node = nodeOfInstance(model, joint.child);
      const centre = node ? model.bounds(false, node).getCenter(new THREE.Vector3()) : null;
      const offset = centre?.sub(origin);
      const value = pose[joint.name]?.value ?? joint.value;
      if (offset) {
        // Back to 0°, then onto the plane of the turn.
        offset.applyAxisAngle(axis, -THREE.MathUtils.degToRad(value)).addScaledVector(axis, -offset.dot(axis));
        if (offset.lengthSq() > 1e-6) {
          const radius = size * 0.42;
          const start = offset.normalize();
          const steps = Math.max(8, Math.ceil(Math.abs(limits[1] - limits[0]) / 4));
          for (let i = 0; i <= steps; i++) {
            const angle = THREE.MathUtils.degToRad(limits[0] + ((limits[1] - limits[0]) * i) / steps);
            range.push(origin.clone().addScaledVector(start.clone().applyAxisAngle(axis, angle), radius));
          }
          range.unshift(origin.clone());
          range.push(origin.clone());
        }
      }
    }
    return { line, ring, origin, axis, size, range };
  }, [joint, kinematics, pose, draftLimits]);
  if (!geometry || !joint) return null;
  return (
    <group renderOrder={10}>
      <Line points={geometry.line} color={color} lineWidth={2} dashed dashSize={3} gapSize={2} depthTest={false} transparent opacity={0.9} />
      {geometry.ring.length > 0 && !geometry.range.length && <Line points={geometry.ring} color={color} lineWidth={2.5} depthTest={false} transparent opacity={0.95} />}
      {geometry.range.length > 0 && <Line points={geometry.range} color={color} lineWidth={2} depthTest={false} transparent opacity={0.85} />}
      {!turns(joint) && <arrowHelper args={[geometry.axis, geometry.origin, geometry.size * 0.9, color, geometry.size * 0.18, geometry.size * 0.1]} />}
    </group>
  );
}

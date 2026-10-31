/**
 * Parts in collision turn red: while a checked motor or animation is at a value (or time) where the
 * build's sweep found two instances overlapping, both are tinted, playing or scrubbed; so are the
 * pairs of a collision study's colliding pose while the mechanism is at it (with a marker at each overlap's centre,
 * its witness point), and the pairs a fit check flags at the pose where they're worst. The view menu's Collision
 * highlights hides them all (showCollisions): display only, the checks and their verdicts stay as they are.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import { useApp } from '@/state/store';
import { animationCollisionsAt, collisionsAt, fitCollisionsAt, studyCollisionsAt, studyPoseAt, type Collision } from './kinematics';
import { nodeOfInstance } from './PoseLayer';
import { clipOf, useMotion } from './state';

const CLASH = new THREE.MeshBasicMaterial({ color: 0xff4d4f, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const WITNESS = new THREE.MeshBasicMaterial({ color: 0xffd60a, depthTest: false });

/** The collisions where the mechanism is now: a collision study's pose, the shown animation at its playhead, else the playing or chosen motor. */
export function currentCollisions(): Collision[] {
  const state = useMotion.getState();
  if (!state.playing && !state.clipStart) {
    const studied = studyCollisionsAt(state.kinematics, state.own, state.coupled);
    if (studied.length) return studied;
    const fitted = fitCollisionsAt(state.kinematics, state.own, state.coupled);
    if (fitted.length) return fitted;
  }
  const clip = clipOf();
  if (clip && (state.clipStart || !state.playing)) {
    const hits = animationCollisionsAt(clip, state.clipTime);
    if (hits.length || state.clipStart) return hits;
  }
  const target = state.playing ?? state.active;
  const drive = state.kinematics?.drives.find((item) => item.joint === target);
  if (!drive?.check) return [];
  const value = drive.coupling ? state.coupled[drive.joint] : state.pose[drive.joint]?.value;
  return value === undefined ? [] : collisionsAt(drive, value);
}

export default function ClashLayer() {
  const invalidate = useThree((state) => state.invalidate);
  // Re-read on every pose change, but only change the tint when the colliding set does.
  const key = useMotion(() => currentCollisions().flatMap((hit) => [hit.a, hit.b]).sort().join('\u0000'));
  const names = useMemo(() => (key ? [...new Set(key.split('\u0000'))] : []), [key]);
  const version = useApp((state) => state.modelVersion);
  const shown = useApp((state) => state.showCollisions);
  useEffect(() => {
    const model = viewer.model;
    if (!model || !names.length || !shown) return;
    const overlays: THREE.Mesh[] = [];
    for (const name of names) {
      const id = nodeOfInstance(model, name);
      model.objects.get(id ?? '')?.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.userData.face || child.userData.lazyFace) return;
        const overlay = new THREE.Mesh(child.geometry, CLASH);
        overlay.renderOrder = 4;
        overlay.raycast = () => {};
        overlay.userData.clash = true;
        child.add(overlay);
        overlays.push(overlay);
      });
    }
    invalidate();
    return () => { for (const overlay of overlays) overlay.removeFromParent(); invalidate(); };
  }, [names, version, invalidate, shown]);
  // The study pose's witness points: where each colliding pair overlaps (already where the mechanism is now).
  const witnesses = useMotion((state) => (state.playing || state.clipStart ? '' : JSON.stringify(studyPoseAt(state.kinematics, state.own, state.coupled)?.at ?? [])));
  const points = useMemo(() => (witnesses && shown ? JSON.parse(witnesses) as [number, number, number][] : []), [witnesses, shown]);
  const radius = useMemo(() => {
    const box = viewer.model?.bounds(false);
    return box && !box.isEmpty() ? Math.max(box.getSize(new THREE.Vector3()).length() / 150, 0.3) : 1;
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { invalidate(); }, [points, invalidate]);
  return (
    <group name="clash-witnesses">
      {points.map((at, index) => (
        <mesh key={index} position={at} material={WITNESS} renderOrder={6} userData={{ witness: true }} raycast={() => {}}>
          <sphereGeometry args={[radius, 12, 8]} />
        </mesh>
      ))}
    </group>
  );
}

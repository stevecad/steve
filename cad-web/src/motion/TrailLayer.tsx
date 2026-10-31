/**
 * An explode's trails (the timeline's Trails toggle): a dashed line from where each exploded part sits in the design to
 * where the explode has it now, so the way each part came off stays readable in a still or a video. Drawn from the
 * explode's offsets; the editor and the share page both mount it.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import type { ModelRuntime } from '@/viewport/model';
import { explodeMoment, explodeOffsets, totalOffset } from './kinematics';
import { nodeOfPath } from './PoseLayer';
import { useMotion } from './state';

const COLOR = { dark: 0x9aa4b2, light: 0x5b6472 };
/** Each part's centre where it sits in the design, per loaded model (measured once: the explode only moves it). */
const centres = new WeakMap<ModelRuntime, Map<string, THREE.Vector3 | null>>();

function restCentre(model: ModelRuntime, path: string, offset: THREE.Vector3): THREE.Vector3 | null {
  let known = centres.get(model);
  if (!known) { known = new Map(); centres.set(model, known); }
  if (!known.has(path)) {
    const node = nodeOfPath(model, path);
    const box = node ? model.bounds(false, node) : null;
    known.set(path, box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()).sub(offset) : null);
  }
  return known.get(path) ?? null;
}

export default function TrailLayer() {
  const invalidate = useThree((state) => state.invalidate);
  const theme = useApp((state) => state.theme);
  const trails = useMotion((state) => state.trails);
  const kinematics = useMotion((state) => state.kinematics);
  const pose = useMotion((state) => state.pose);
  const lines = useMemo(() => {
    const model = viewer.model;
    const moment = trails && model ? explodeMoment(kinematics, pose) : null;
    if (!moment || !model) return [];
    const offsets = explodeOffsets(moment.explode, moment.t);
    return [...offsets.keys()].flatMap((path) => {
      const offset = totalOffset(offsets, path);
      if (offset.lengthSq() < 1e-6) return [];
      const from = restCentre(model, path, offset);
      return from ? [{ path, points: [from, from.clone().add(offset)] as [THREE.Vector3, THREE.Vector3] }] : [];
    });
  }, [trails, kinematics, pose]);
  useEffect(() => { invalidate(); }, [lines, invalidate]);
  const color = COLOR[theme === 'light' ? 'light' : 'dark'];
  return (
    <group name="explode-trails" renderOrder={9}>
      {lines.map((line) => (
        <Line key={line.path} points={line.points} color={color} lineWidth={1.5} dashed dashSize={2.5} gapSize={2} depthTest={false} transparent opacity={0.85}
          userData={{ trail: line.path }} />
      ))}
    </group>
  );
}

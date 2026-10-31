import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useApp, type StudyLoad } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { faceFrame } from '@/viewport/faceFrame';
import { LOAD_TYPES } from './commands';
import { useSimulation } from './state';

const CONSTRAINT = '#4fb4ff';
const LOAD = '#ff9d45';

function Arrow({ from, direction, length, color }: { from: THREE.Vector3; direction: THREE.Vector3; length: number; color: string }) {
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()), [direction]);
  const head = length * 0.28;
  return (
    <group position={from} quaternion={quaternion} renderOrder={40}>
      <mesh position={[0, (length - head) / 2, 0]} renderOrder={40}>
        <cylinderGeometry args={[length * 0.025, length * 0.025, length - head, 10]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
      <mesh position={[0, length - head / 2, 0]} renderOrder={40}>
        <coneGeometry args={[length * 0.08, head, 18]} />
        <meshBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
      </mesh>
    </group>
  );
}

function Fixed({ center, normal, size }: { center: THREE.Vector3; normal: THREE.Vector3; size: number }) {
  const quaternion = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal), [normal]);
  const s = size * 0.06;
  return (
    <group position={center} quaternion={quaternion} renderOrder={40}>
      {[-1, 0, 1].map((i) => (
        <mesh key={i} position={[i * s * 1.3, 0, s * 0.55]} rotation={[Math.PI / 2, 0, 0]} renderOrder={40}>
          <coneGeometry args={[s * 0.5, s * 1.1, 3]} />
          <meshBasicMaterial color={CONSTRAINT} depthTest={false} transparent opacity={0.95} />
        </mesh>
      ))}
    </group>
  );
}

/** Constraint and load glyphs for the active study, plus tinted faces. */
export default function LoadsLayer() {
  const study = useApp((state) => state.studies.find((item) => item.id === state.activeStudy));
  const version = useApp((state) => state.modelVersion);
  // Results replace the glyphs, and so does the all-studies view.
  const result = useSimulation((state) => state.result);
  const overview = useApp((state) => state.studyOverview);
  const results = result ?? (overview || null);
  const invalidate = useThree((state) => state.invalidate);
  const model = viewer.model;

  // Tint constrained and loaded faces.
  useEffect(() => {
    if (!model || !study || results) return;
    const overlays: THREE.Mesh[] = [];
    const materials = {
      Constraint: new THREE.MeshBasicMaterial({ color: CONSTRAINT, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      Load: new THREE.MeshBasicMaterial({ color: LOAD, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    };
    for (const load of study.loads) {
      for (const pick of load.picks) {
        if (pick.kind !== 'face') continue;
        const mesh = model.faceMesh(pick.node, pick.mesh, pick.index);
        if (!mesh) continue;
        const overlay = new THREE.Mesh(mesh.geometry, materials[LOAD_TYPES[load.type].group]);
        overlay.renderOrder = 4;
        overlay.raycast = () => {};
        mesh.add(overlay);
        overlays.push(overlay);
      }
    }
    invalidate();
    return () => { overlays.forEach((overlay) => overlay.removeFromParent()); materials.Constraint.dispose(); materials.Load.dispose(); invalidate(); };
  }, [model, study, version, invalidate, results]);

  if (!model || !study || results) return null;
  const radius = viewer.modelRadius();
  const glyphs: React.ReactNode[] = [];
  const direction = (load: StudyLoad, fallback: THREE.Vector3) => (load.direction ? new THREE.Vector3(...load.direction) : fallback);
  for (const load of study.loads) {
    if (load.type === 'gravity') {
      const box = model.bounds(false);
      const top = box.getCenter(new THREE.Vector3());
      top.z = box.max.z + radius * 0.55;
      glyphs.push(<Arrow key={load.id} from={top} direction={direction(load, new THREE.Vector3(0, 0, -1))} length={radius * 0.45} color={LOAD} />);
      continue;
    }
    load.picks.forEach((pick, index) => {
      const frame = faceFrame(model, pick);
      if (!frame) return;
      const key = `${load.id}:${index}`;
      const length = Math.min(Math.max(frame.size * 0.5, radius * 0.18), radius * 0.4);
      if (load.type === 'fixed' || load.type === 'pin' || load.type === 'no_slip' || load.type === 'slip' || load.type === 'symmetry') glyphs.push(<Fixed key={key} center={frame.center} normal={frame.normal} size={Math.max(frame.size, radius * 0.4)} />);
      else if (load.type === 'force' || load.type === 'moment' || load.type === 'velocity_inlet') {
        const dir = direction(load, frame.normal.clone().negate());
        glyphs.push(<Arrow key={key} from={frame.center.clone().addScaledVector(dir, -length)} direction={dir} length={length} color={LOAD} />);
      } else if (load.type === 'pressure' || load.type === 'stagnation_inlet' || load.type === 'mass_flow_inlet') {
        const dir = frame.normal.clone().negate();
        glyphs.push(<Arrow key={key} from={frame.center.clone().addScaledVector(dir, -length * 0.8)} direction={dir} length={length * 0.8} color={LOAD} />);
      }
    });
  }
  return <group>{glyphs}</group>;
}

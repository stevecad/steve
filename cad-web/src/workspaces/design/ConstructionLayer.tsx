import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { parsePlanes, defaultXDir } from '@/lib/construction';
import { viewer } from '@/viewport/viewer';
import { draftPlane } from './planeTool';
import { planeTarget } from './modelPlanes';
import styles from '@/viewport/Viewport.module.css';

const COLOR = '#f0a95c';

function PlaneGlyph({ name, origin, normal, xDir, size, draft }: { name: string; origin: THREE.Vector3; normal: THREE.Vector3; xDir: THREE.Vector3; size: number; draft?: boolean }) {
  const quaternion = useMemo(() => {
    const z = normal.clone().normalize();
    const x = xDir.clone().normalize();
    const y = z.clone().cross(x);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }, [normal, xDir]);
  const h = size / 2;
  const outline: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]];
  return (
    <group position={origin} quaternion={quaternion}>
      <mesh renderOrder={6} raycast={() => {}}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial color={COLOR} transparent opacity={draft ? 0.14 : 0.08} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <Line points={outline} color={COLOR} lineWidth={draft ? 2 : 1.3} dashed={draft} dashSize={size * 0.04} gapSize={size * 0.025} transparent opacity={0.9} />
      <Line points={[[0, 0, 0], [0, 0, size * 0.18]]} color={COLOR} lineWidth={2} />
      <Html position={[-h, h, 0]} zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
        <div className={styles.planeLabel} data-draft={draft || undefined}>{name}</div>
      </Html>
    </group>
  );
}

/** Construction planes defined in the source, plus the live preview of the plane tool. */
export default function ConstructionLayer() {
  const code = useApp((state) => state.doc.code);
  const hidden = useApp((state) => state.hiddenPlanes);
  const tool = useApp((state) => state.tool);
  const draftState = useApp((state) => state.planeDraft);
  const selection = useApp((state) => state.selection);
  const version = useApp((state) => state.modelVersion);
  const workspace = useApp((state) => state.workspace);
  const planes = useMemo(() => parsePlanes(code), [code]);
  const doc = useApp((state) => state.modeling);
  const rollback = useApp((state) => state.rollback?.after);
  // Construction planes of modeling documents (`model.plane`), placed as the runtime places them;
  // planes past the timeline's history marker are rolled back, so they aren't drawn.
  const modelPlanes = useMemo(() => {
    if (!doc?.canonical) return [];
    const marker = rollback === undefined ? doc.features.length : rollback === null ? 0 : doc.features.findIndex((f) => f.id === rollback) + 1;
    return doc.features.filter((f, index) => f.kind === 'plane' && f.id && !f.suppressed && index < marker).flatMap((f) => {
      const target = planeTarget(f, doc);
      return target ? [{ id: f.id!, name: f.name, plane: target.plane }] : [];
    });
  }, [doc, version, rollback]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = useMemo(() => Math.max(viewer.modelRadius() * 1.3, 20), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const draft = useMemo(() => (tool === 'plane' ? draftPlane(viewer.model, useApp.getState(), draftState) : null), [tool, draftState, selection, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // The view draws on demand: a plane shown or hidden from the browser redraws now, not at the next orbit.
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => { invalidate(); }, [invalidate, hidden, planes, modelPlanes, draft, size, workspace]);
  if (workspace !== 'design') return null;
  return (
    <group>
      {planes.filter((plane) => !hidden.includes(plane.name)).map((plane) => (
        <PlaneGlyph key={plane.name} name={plane.name} origin={plane.origin} normal={plane.normal} xDir={plane.xDir} size={size} />
      ))}
      {modelPlanes.filter((plane) => !hidden.includes(plane.id)).map(({ id, name, plane }) => (
        <PlaneGlyph key={`model:${id}`} name={name} origin={plane.origin} normal={plane.normal} xDir={plane.x} size={size} />
      ))}
      {draft && !('error' in draft) && <PlaneGlyph name={draftState.editing?.name ?? 'New plane'} origin={draft.origin} normal={draft.normal} xDir={draft.xDir ?? defaultXDir(draft.normal)} size={size} draft />}
    </group>
  );
}

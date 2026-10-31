import { useEffect, useMemo, useRef } from 'react';
import { Html, Line } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { useSketch } from './session';
import styles from './Sketch.module.css';

const PLANES: { name: string; color: string; rotation: [number, number, number] }[] = [
  { name: 'XY', color: '#5aa9ff', rotation: [0, 0, 0] },
  { name: 'XZ', color: '#7ed47c', rotation: [Math.PI / 2, 0, 0] },
  { name: 'YZ', color: '#ff6b6b', rotation: [0, Math.PI / 2, 0] },
];

const meshes = new Map<string, THREE.Mesh>();

/** The origin plane a ray meets first, while choosing where to sketch. */
export function pickPlane(ray: THREE.Raycaster): { name: string; point: THREE.Vector3 } | null {
  const hits = ray.intersectObjects([...meshes.values()], false);
  const hit = hits[0];
  return hit ? { name: hit.object.userData.plane as string, point: hit.point } : null;
}

/** Origin planes to click while a new sketch waits for its plane. */
export default function PlaneChooser() {
  const choosing = useSketch((s) => s.choosing);
  return choosing ? <Planes /> : null;
}

function Planes() {
  const hovered = useSketch((s) => s.planeHover);
  const version = useApp((s) => s.modelVersion);
  const theme = useApp((s) => s.theme);
  const invalidate = useThree((s) => s.invalidate);
  const size = useMemo(() => Math.max(viewer.model ? viewer.modelRadius() * 1.3 : 0, 60), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const green = theme === 'light' ? '#14805e' : '#5fcfa5';
  const h = size / 2;
  const square: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]];
  const refs = useRef<Record<string, THREE.Mesh | null>>({});
  useEffect(() => {
    for (const [name, mesh] of Object.entries(refs.current)) if (mesh) meshes.set(name, mesh);
    invalidate();
    return () => { meshes.clear(); invalidate(); };
  }, [size, invalidate]);
  useEffect(() => { invalidate(); }, [hovered, invalidate]);
  return (
    <group>
      {PLANES.map((plane) => {
        const hot = hovered === plane.name;
        const color = hot ? green : plane.color;
        return (
          <group key={plane.name} rotation={plane.rotation}>
            <mesh ref={(mesh) => { refs.current[plane.name] = mesh; if (mesh) mesh.userData.plane = plane.name; }} renderOrder={30}>
              <planeGeometry args={[size, size]} />
              <meshBasicMaterial color={color} transparent opacity={hot ? 0.3 : 0.1} side={THREE.DoubleSide} depthWrite={false} depthTest={false} />
            </mesh>
            <Line points={square} color={color} lineWidth={hot ? 2.4 : 1.3} transparent opacity={hot ? 1 : 0.7} depthTest={false} renderOrder={31} />
            <Html position={[h * 0.82, h * 0.82, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <span className={styles.planeTag} data-hot={hot || undefined} style={{ '--plane': color } as React.CSSProperties}>{plane.name}</span>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

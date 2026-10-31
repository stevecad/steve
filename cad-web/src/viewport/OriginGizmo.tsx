import { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { useApp } from '@/state/store';
import { viewer } from './viewer';

const PLANES: { key: string; color: string; rotation: [number, number, number] }[] = [
  { key: 'XY', color: '#5aa9ff', rotation: [0, 0, 0] },
  { key: 'XZ', color: '#7ed47c', rotation: [Math.PI / 2, 0, 0] },
  { key: 'YZ', color: '#ff6b6b', rotation: [0, Math.PI / 2, 0] },
];

/** Construction planes and axes at the document origin. */
export default function OriginGizmo() {
  const show = useApp((state) => state.showOrigin);
  const version = useApp((state) => state.modelVersion);
  const size = useMemo(() => Math.max(viewer.modelRadius() * 0.9, 10), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show) return null;
  const h = size / 2;
  const square: [number, number, number][] = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, 0]];
  return (
    <group renderOrder={5}>
      {PLANES.map((plane) => (
        <group key={plane.key} rotation={plane.rotation}>
          <mesh renderOrder={5}>
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial color={plane.color} transparent opacity={0.07} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <Line points={square} color={plane.color} lineWidth={1.2} transparent opacity={0.55} depthWrite={false} />
        </group>
      ))}
      <Line points={[[0, 0, 0], [size * 0.75, 0, 0]]} color="#ff6b6b" lineWidth={2} depthTest={false} />
      <Line points={[[0, 0, 0], [0, size * 0.75, 0]]} color="#7ed47c" lineWidth={2} depthTest={false} />
      <Line points={[[0, 0, 0], [0, 0, size * 0.75]]} color="#5aa9ff" lineWidth={2} depthTest={false} />
      <mesh renderOrder={6}>
        <sphereGeometry args={[size * 0.018, 16, 12]} />
        <meshBasicMaterial color="#f5d58a" depthTest={false} />
      </mesh>
    </group>
  );
}

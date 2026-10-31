import { useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import { useApp } from '@/state/store';
import { useSetting } from '@/settings/store';
import { viewer } from './viewer';
import { measure } from './measure';
import styles from './Viewport.module.css';

/** Dimension lines and labels for the active measurement. */
export default function MeasureLayer() {
  const picks = useApp((state) => state.measurePicks);
  const tool = useApp((state) => state.tool);
  const version = useApp((state) => state.modelVersion);
  const units = useSetting('display.units');
  const result = useMemo(() => (viewer.model && tool === 'measure' ? measure(viewer.model, picks) : null), [picks, tool, version, units]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!result) return null;
  return (
    <group>
      {result.lines.map((line, index) => (
        <group key={index}>
          <Line points={[line.a, line.b]} color="#f5d58a" lineWidth={2} depthTest={false} renderOrder={30} />
          {[line.a, line.b].map((point, i) => (
            <mesh key={i} position={point} renderOrder={31}>
              <sphereGeometry args={[viewer.modelRadius() * 0.012, 16, 12]} />
              <meshBasicMaterial color="#f5d58a" depthTest={false} />
            </mesh>
          ))}
          <Html position={line.a.clone().lerp(line.b, 0.5)} center zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
            <div className={styles.dimension}>{line.label}</div>
          </Html>
        </group>
      ))}
      {result.points.map((point, i) => (
        <mesh key={`p${i}`} position={point} renderOrder={31}>
          <sphereGeometry args={[viewer.modelRadius() * 0.012, 16, 12]} />
          <meshBasicMaterial color="#f5d58a" depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

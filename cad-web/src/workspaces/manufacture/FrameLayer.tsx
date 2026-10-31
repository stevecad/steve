/**
 * The From-part tool's frames in the viewport: each picked frame's origin, its spindle axis through the part and a
 * +Z arrow (toward the spindle), so a wrong direction or an off-axis origin is visible before any job runs.
 */
import { useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { entityFor, FRAME_KEYS, FRAME_LABELS, openPart, previewSlot, smoothTip, useFromPart, type FrameKey } from './fromPart';

const COLORS: Record<FrameKey, string> = { tip: '#38bdf8', machine_side: '#38bdf8', tool_side: '#f59e0b' };

export default function FrameLayer() {
  const open = useFromPart((state) => state.open);
  const kind = useFromPart((state) => state.kind);
  const frames = useFromPart((state) => state.frames);
  const documentId = useFromPart((state) => state.documentId);
  const revision = useFromPart((state) => state.revision);
  const version = useApp((state) => state.modelVersion);
  useApp((state) => state.doc.saved?.revision);
  const part = openPart();
  const live = typeof part !== 'string' && part.id === documentId && part.revision === revision;
  const items = useMemo(() => {
    if (!open || !live || !viewer.model) return [];
    const size = viewer.model.bounds(false).getSize(new THREE.Vector3()).length() || 50;
    return FRAME_KEYS[kind].flatMap((key) => {
      const preview = previewSlot(frames[key]);
      if (!preview) return [];
      const origin = preview.origin.clone().applyMatrix4(preview.matrix);
      const z = preview.z.clone().transformDirection(preview.matrix);
      const reach = size * 0.75, arrow = size * 0.18;
      const head = origin.clone().addScaledVector(z, arrow);
      const cone = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), z);
      return [{ key, origin, head, cone, arrow, axis: [origin.clone().addScaledVector(z, -reach), origin.clone().addScaledVector(z, reach)] as [THREE.Vector3, THREE.Vector3] }];
    });
  }, [open, live, kind, frames, version]);
  // A ball or bull-nose tip before its construction point exists: where "Add tip point" would put it.
  const pending = useMemo(() => {
    if (!open || !live || kind !== 'rotary_cutter') return null;
    const tip = smoothTip(frames.tip);
    const entity = frames.tip?.reference ? entityFor(frames.tip.reference) : null;
    if (!tip || typeof tip === 'string' || !entity) return null;
    const size = viewer.model ? viewer.model.bounds(false).getSize(new THREE.Vector3()).length() || 50 : 50;
    return { point: tip.point.clone().applyMatrix4(entity.matrix), size: size * 0.012 };
  }, [open, live, kind, frames, version]);
  if (!items.length && !pending) return null;
  return (
    <group renderOrder={20}>
      {pending && (
        <group userData={{ toolFrame: 'pending-tip' }}>
          <mesh position={pending.point} renderOrder={22}>
            <octahedronGeometry args={[pending.size, 0]} />
            <meshBasicMaterial color={COLORS.tip} depthTest={false} transparent opacity={0.9} />
          </mesh>
          <Html position={pending.point} center style={{ pointerEvents: 'none' }}>
            <span style={{ whiteSpace: 'nowrap', fontSize: 11, padding: '1px 6px', borderRadius: 99, background: 'rgb(0 0 0 / 0.55)', color: COLORS.tip, transform: 'translate(16px, 10px)', display: 'inline-block' }}>Tip point to add</span>
          </Html>
        </group>
      )}
      {items.map((item) => (
        <group key={item.key} userData={{ toolFrame: item.key }}>
          <Line points={item.axis} color={COLORS[item.key]} lineWidth={1} dashed dashSize={item.arrow * 0.12} gapSize={item.arrow * 0.08} transparent opacity={0.7} depthTest={false} />
          <Line points={[item.origin, item.head]} color={COLORS[item.key]} lineWidth={2.5} depthTest={false} />
          <mesh position={item.head} quaternion={item.cone} renderOrder={21}>
            <coneGeometry args={[item.arrow * 0.08, item.arrow * 0.24, 20]} />
            <meshBasicMaterial color={COLORS[item.key]} depthTest={false} transparent />
          </mesh>
          <mesh position={item.origin} renderOrder={21}>
            <sphereGeometry args={[item.arrow * 0.05, 16, 12]} />
            <meshBasicMaterial color="#ffffff" depthTest={false} transparent />
          </mesh>
          <Html position={item.head} center style={{ pointerEvents: 'none' }}>
            <span style={{ whiteSpace: 'nowrap', fontSize: 11, padding: '1px 6px', borderRadius: 99, background: 'rgb(0 0 0 / 0.55)', color: COLORS[item.key], transform: 'translate(14px, -10px)', display: 'inline-block' }}>
              {FRAME_LABELS[item.key].title} +Z
            </span>
          </Html>
        </group>
      ))}
    </group>
  );
}

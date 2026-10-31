/** The Place tool's handle on the canvas: arrows, plane squares and rings at the instance's centre. */
import { useMemo, useRef } from 'react';
import { PivotControls } from '@react-three/drei';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { snapTo, dragStep } from '@/viewport/dragStep';
import { composePlacement, decompose, instanceNode, previewPlacement, usePlacement } from './placement';

const AXIS_COLORS: [string, string, string] = ['#ff5b5b', '#5fcf6a', '#4f9dff'];

export default function PlacementGizmo() {
  const active = useApp((state) => state.tool === 'place');
  const instance = usePlacement((state) => state.instance);
  const nonce = usePlacement((state) => state.nonce);
  const start = useRef<THREE.Matrix4 | null>(null);
  // Re-centred on the instance whenever the placement changes other than by this handle.
  const center = useMemo(() => {
    const node = instance ? instanceNode(instance) : null;
    const box = node && viewer.model ? viewer.model.bounds(false, node) : null;
    return box && !box.isEmpty() ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  }, [instance, nonce]);
  if (!active || !instance) return null;
  return (
    <group position={center} key={`${instance}|${nonce}`}>
      <PivotControls fixed scale={110} lineWidth={2.5} depthTest={false} axisColors={AXIS_COLORS} hoveredColor="#ffb347" disableScaling annotations
        onDragStart={() => { start.current = composePlacement(usePlacement.getState()); if (viewer.controls) viewer.controls.enabled = false; }}
        onDrag={(_local, _deltaLocal, _world, deltaWorld) => {
          if (!start.current) return;
          const next = decompose(deltaWorld.clone().multiply(start.current));
          // Snap the position to a step a few pixels long at this zoom (like every canvas drag).
          const step = dragStep(viewer.camera instanceof THREE.OrthographicCamera ? 1 / viewer.camera.zoom : 0.1);
          next.position = next.position.map((v) => snapTo(v, step)) as [number, number, number];
          next.angle = snapTo(next.angle, 1);
          usePlacement.setState(next);
          previewPlacement();
        }}
        onDragEnd={() => { start.current = null; if (viewer.controls) viewer.controls.enabled = true; usePlacement.setState((state) => ({ nonce: state.nonce + 1 })); }} />
    </group>
  );
}

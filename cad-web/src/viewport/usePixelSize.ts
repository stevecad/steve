import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { viewer } from './viewer';

/** World units per screen pixel at `point`; follows zoom and orbit, for handles and annotations drawn at a constant screen size. */
export function usePixelSize(point: THREE.Vector3): number {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controls = viewer.controls;
    if (!controls) return;
    let frame = 0;
    const on = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick((t) => t + 1); }); };
    controls.addEventListener('update', on);
    return () => { controls.removeEventListener('update', on); cancelAnimationFrame(frame); };
  }, []);
  const { x, y, z } = point;
  return useMemo(() => {
    if (camera instanceof THREE.OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / Math.max(size.height, 1);
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = perspective.position.distanceTo(new THREE.Vector3(x, y, z));
    return (2 * distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2)) / Math.max(size.height, 1);
  }, [camera, size, x, y, z, tick]); // eslint-disable-line react-hooks/exhaustive-deps
}

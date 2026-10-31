/**
 * Cables (`design.cable`): each drawn as a tube through its path points, which move with the instances they're
 * fastened to, so the cable follows the mechanism as it's dragged, driven or animated. A cable the build's checks
 * failed is red. Drawn here from the build's points; the checks themselves run at the build.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { cablePath } from './kinematics';
import { useMotion } from './state';

const COLORS = { pass: 0x3d4450, fail: 0xff4d4f, unchecked: 0x8a8f98 } as const;

export default function CableLayer() {
  const invalidate = useThree((state) => state.invalidate);
  const kinematics = useMotion((state) => state.kinematics);
  const pose = useMotion((state) => state.pose);
  const meshes = useMemo(() => {
    if (!kinematics?.cables) return [];
    return kinematics.cables.cables.flatMap((cable) => {
      const points = cablePath(kinematics, cable, pose);
      if (!points) return [];
      const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
      const geometry = new THREE.TubeGeometry(curve, Math.min(48 * (points.length - 1), 256), cable.diameter_mm / 2, 10, false);
      return [{ name: cable.name, geometry, color: COLORS[cable.status] ?? COLORS.pass }];
    });
  }, [kinematics, pose]);
  useEffect(() => { invalidate(); return () => { for (const mesh of meshes) mesh.geometry.dispose(); }; }, [meshes, invalidate]);
  return (
    <group name="cables">
      {meshes.map((mesh) => (
        <mesh key={mesh.name} geometry={mesh.geometry} userData={{ cable: mesh.name }} raycast={() => {}}>
          <meshStandardMaterial color={mesh.color} roughness={0.6} metalness={0} />
        </mesh>
      ))}
    </group>
  );
}

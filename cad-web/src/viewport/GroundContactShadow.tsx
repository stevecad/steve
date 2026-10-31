// Contact-depth/blur technique adapted from @react-three/drei ContactShadows (MIT).
// Copyright (c) 2020 react-spring. See public/licenses/react-three-drei.txt.
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { HorizontalBlurShader, VerticalBlurShader } from 'three-stdlib';

/** Z-up contact shadow: blur in texture space, independently of the world-space capture camera. */
export default function GroundContactShadow({ position, extent, height, opacity }: {
  position: [number, number, number]; extent: number; height: number; opacity: number;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const count = useRef(0);
  const invalidate = useThree((state) => state.invalidate);
  const r = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(768, 768);
    const temporary = new THREE.WebGLRenderTarget(768, 768);
    target.texture.generateMipmaps = temporary.texture.generateMipmaps = false;
    const depth = new THREE.MeshDepthMaterial();
    depth.depthTest = depth.depthWrite = false;
    depth.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4( vec3( 1.0 - fragCoordZ ), opacity )', 'vec4( vec3( 0.0 ), 1.0 - fragCoordZ )');
    };
    const horizontal = new THREE.ShaderMaterial(HorizontalBlurShader);
    const vertical = new THREE.ShaderMaterial(VerticalBlurShader);
    horizontal.depthTest = horizontal.depthWrite = vertical.depthTest = vertical.depthWrite = false;
    const blurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    blurCamera.position.z = 1;
    blurCamera.updateMatrixWorld();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), horizontal);
    const capture = new THREE.OrthographicCamera(-extent / 2, extent / 2, extent / 2, -extent / 2, 0, height);
    capture.rotation.x = Math.PI;
    return { target, temporary, depth, horizontal, vertical, blurCamera, quad, capture };
  }, [extent, height]);
  useEffect(() => { count.current = 0; invalidate(); }, [r, position[0], position[1], position[2], invalidate]);
  useEffect(() => () => {
    r.target.dispose(); r.temporary.dispose(); r.depth.dispose();
    r.horizontal.dispose(); r.vertical.dispose(); r.quad.geometry.dispose();
  }, [r]);
  useFrame(({ gl, scene }) => {
    if (!mesh.current || count.current >= 2) return;
    r.capture.position.set(...position); r.capture.updateMatrixWorld();
    const previousTarget = gl.getRenderTarget(), background = scene.background, override = scene.overrideMaterial;
    const visible = mesh.current.visible;
    const blur = (amount: number) => {
      r.quad.material = r.horizontal;
      r.horizontal.uniforms.tDiffuse.value = r.target.texture;
      r.horizontal.uniforms.h.value = amount / 256;
      gl.setRenderTarget(r.temporary); gl.render(r.quad, r.blurCamera);
      r.quad.material = r.vertical;
      r.vertical.uniforms.tDiffuse.value = r.temporary.texture;
      r.vertical.uniforms.v.value = amount / 256;
      gl.setRenderTarget(r.target); gl.render(r.quad, r.blurCamera);
    };
    try {
      mesh.current.visible = false; scene.background = null; scene.overrideMaterial = r.depth;
      gl.setRenderTarget(r.target); gl.render(scene, r.capture);
      blur(2.6); blur(1.04); count.current++;
    } finally {
      gl.setRenderTarget(previousTarget); scene.background = background; scene.overrideMaterial = override;
      mesh.current.visible = visible;
    }
    // A second settling frame catches model effects; ordinary camera motion reuses the cached texture.
    if (count.current < 2) invalidate();
  });
  return <mesh ref={mesh} position={position} scale={[1, -1, 1]}>
    <planeGeometry args={[extent, extent]} />
    <meshBasicMaterial map={r.target.texture} transparent opacity={opacity} depthWrite={false} />
  </mesh>;
}

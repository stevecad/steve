import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { viewer } from './viewer';
import { useApp, viewportTheme } from '@/state/store';

const vertex = /* glsl */ `
  varying vec3 vWorld;
  #include <clipping_planes_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const fragment = /* glsl */ `
  uniform float uCell;
  uniform float uMinorAlpha;
  uniform vec3 uMinorColor;
  uniform vec3 uMajorColor;
  uniform vec3 uAxisX;
  uniform vec3 uAxisY;
  uniform vec2 uCenter;
  uniform float uFade;
  uniform float uOpacity;
  varying vec3 vWorld;

  float gridLine(vec2 coord, float width) {
    vec2 derivative = fwidth(coord);
    vec2 g = abs(fract(coord - 0.5) - 0.5) / (derivative * width);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  float axisLine(float value, float width) {
    float d = fwidth(value);
    return 1.0 - min(abs(value) / (d * width), 1.0);
  }

  void main() {
    vec2 p = vWorld.xy;
    float minor = gridLine(p / uCell, 1.0) * uMinorAlpha;
    float major = gridLine(p / (uCell * 10.0), 1.25);
    float ax = axisLine(p.y, 1.6);
    float ay = axisLine(p.x, 1.6);
    float fade = 1.0 - smoothstep(uFade * 0.35, uFade, length(p - uCenter));

    vec3 color = uMinorColor;
    float alpha = minor * 0.55;
    color = mix(color, uMajorColor, major);
    alpha = max(alpha, major * 0.9);
    color = mix(color, uAxisX, ax);
    alpha = max(alpha, ax);
    color = mix(color, uAxisY, ay);
    alpha = max(alpha, ay);
    alpha *= fade * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

/** Ground grid below the visible model, with world-aligned XY lines and spacing that follows the zoom level. */
export default function CadGrid() {
  const theme = useApp(viewportTheme);
  const version = useApp((state) => state.modelVersion);
  const tree = useApp((state) => state.tree);
  const groundZ = useMemo(() => {
    const box = viewer.model?.bounds(true);
    return box && !box.isEmpty() ? Math.min(box.min.z, 0) : 0;
    // Recompute with model/visibility changes, not on every camera frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tree]);
  const size = useThree((state) => state.size);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    // Push the grid back in depth so coplanar bottom faces cover it without z-fighting.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
    side: THREE.DoubleSide,
    clipping: false,
    uniforms: {
      uCell: { value: 10 },
      uMinorAlpha: { value: 1 },
      uMinorColor: { value: new THREE.Color() },
      uMajorColor: { value: new THREE.Color() },
      uAxisX: { value: new THREE.Color('#e5605e') },
      uAxisY: { value: new THREE.Color('#6cc46c') },
      uCenter: { value: new THREE.Vector2() },
      uFade: { value: 500 },
      uOpacity: { value: 1 },
    },
  }), []);

  useMemo(() => {
    const dark = theme === 'dark';
    material.uniforms.uMinorColor.value.set(dark ? '#56636b' : '#a3adb3');
    material.uniforms.uMajorColor.value.set(dark ? '#76858e' : '#8b979e');
    material.uniforms.uAxisX.value.set(dark ? '#d8605c' : '#e0625d');
    material.uniforms.uAxisY.value.set(dark ? '#63b56a' : '#58ab60');
    material.uniforms.uOpacity.value = dark ? 0.8 : 0.55;
  }, [theme, material]);

  const plane = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  const gridRef = useRef<THREE.Mesh>(null);

  useFrame(({ camera }) => {
    const controls = viewer.controls;
    if (!controls) return;
    const target = controls.getTarget(new THREE.Vector3());
    let worldPerPixel: number;
    if (camera instanceof THREE.OrthographicCamera) worldPerPixel = 1 / camera.zoom;
    else {
      const distance = camera.position.distanceTo(target);
      worldPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov) / 2)) / size.height;
    }
    // Minor cells at least ~14px apart; fade them in as they approach 40px.
    const minPixels = 14;
    const cell = 10 ** Math.ceil(Math.log10(worldPerPixel * minPixels));
    const pixels = cell / worldPerPixel;
    material.uniforms.uCell.value = cell;
    material.uniforms.uMinorAlpha.value = THREE.MathUtils.smoothstep(pixels, minPixels, minPixels * 3);
    const extent = Math.max(size.width, size.height) * worldPerPixel;
    const fade = Math.max(extent * 0.75, viewer.modelRadius() * 4);
    material.uniforms.uFade.value = fade;
    material.uniforms.uCenter.value.set(target.x, target.y);
    // Keep XY references world-aligned; the ground follows models extending below the origin.
    // Sketch grids and origin planes remain at their actual construction planes.
    gridRef.current?.position.set(target.x, target.y, groundZ);
    gridRef.current?.scale.setScalar(fade * 2.2);
  });

  return <mesh ref={gridRef} geometry={plane} material={material} renderOrder={-1} frustumCulled={false} />;
}


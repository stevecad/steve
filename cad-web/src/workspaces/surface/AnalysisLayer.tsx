/**
 * The Surface tab's analysis on the model (display only): zebra stripes reflected in the faces, the curvature map, and
 * draft against a pull direction draw on every face instead of its look while one is on (ModelRuntime.setAnalysis);
 * the continuity check marks the picked edge's worst point. Options are the Dock's Surface analysis panel.
 *
 * Zebra and draft read each face's normals from the build's tessellation (the surface's own normals at its nodes), so
 * stripes break exactly where faces meet at an angle. Curvature is estimated on the mesh (surfaceAnalysis.ts) once per
 * face geometry, the first time the map is shown, and kept with the geometry.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useApp } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import type { ModelRuntime } from '@/viewport/model';
import { curvatures } from '@/viewport/surfaceAnalysis';
import { pullVector, useSurfaceAnalysis, type AnalysisState } from './state';

/** Draft legend colours (AnalysisPanel.tsx shows the same). */
export const DRAFT_COLORS = { positive: '#4fae6a', shallow: '#e3b341', negative: '#d9534f' } as const;
/** Curvature legend: concave, flat, convex. */
export const CURVATURE_COLORS = { concave: '#2f6fdb', flat: '#d9dde1', convex: '#d64541' } as const;

const vertexShader = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  attribute vec2 steveCurvature;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec2 vCurvature;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vCurvature = steveCurvature;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  uniform int uMode;          // 0 zebra, 1 curvature, 2 draft
  uniform float uStripes;
  uniform bool uVertical;
  uniform bool uGaussian;
  uniform float uRadius;
  uniform vec3 uPull;
  uniform float uMinimum;     // sin of the minimum draft
  uniform vec3 uPositive;
  uniform vec3 uShallow;
  uniform vec3 uNegative;
  uniform vec3 uConcave;
  uniform vec3 uFlat;
  uniform vec3 uConvex;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec2 vCurvature;
  void main() {
    #include <clipping_planes_fragment>
    vec3 n = normalize(vWorldNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec3 view = isOrthographic ? forward : normalize(vWorldPosition - cameraPosition);
    float facing = abs(dot(n, view));
    vec3 color;
    if (uMode == 0) {
      // Stripes of a long striped light around the viewer, seen reflected in the surface.
      vec3 r = (viewMatrix * vec4(reflect(view, n), 0.0)).xyz;
      float t = asin(clamp(uVertical ? r.x : r.y, -1.0, 1.0)) / PI * uStripes;
      float w = max(fwidth(t), 1e-4);
      float band = smoothstep(0.25 - w, 0.25 + w, fract(t)) - smoothstep(0.75 - w, 0.75 + w, fract(t));
      color = mix(vec3(0.06), vec3(0.95), band);
    } else if (uMode == 1) {
      float k = uGaussian ? sign(vCurvature.y) * sqrt(abs(vCurvature.y)) : vCurvature.x;
      float s = clamp(k * uRadius, -1.0, 1.0);
      // The mesh's normals point out of the part: positive bends away from them (convex), negative towards them.
      color = s >= 0.0 ? mix(uFlat, uConvex, s) : mix(uFlat, uConcave, -s);
      color *= 0.72 + 0.28 * facing;
    } else {
      float d = dot(n, uPull);
      color = d >= uMinimum ? uPositive : (d <= -uMinimum ? uNegative : uShallow);
      color *= 0.62 + 0.38 * facing;
    }
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const linear = (hex: string) => new THREE.Color(hex);

function analysisMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader, fragmentShader, clipping: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    uniforms: {
      uMode: { value: 0 }, uStripes: { value: 12 }, uVertical: { value: true }, uGaussian: { value: false }, uRadius: { value: 10 },
      uPull: { value: new THREE.Vector3(0, 0, 1) }, uMinimum: { value: Math.sin(THREE.MathUtils.degToRad(1)) },
      uPositive: { value: linear(DRAFT_COLORS.positive) }, uShallow: { value: linear(DRAFT_COLORS.shallow) }, uNegative: { value: linear(DRAFT_COLORS.negative) },
      uConcave: { value: linear(CURVATURE_COLORS.concave) }, uFlat: { value: linear(CURVATURE_COLORS.flat) }, uConvex: { value: linear(CURVATURE_COLORS.convex) },
    },
  });
}

/** The radius shown at full colour when none is set: a twentieth of the model's size, rounded to a plain number. */
export function autoRadius(model: ModelRuntime | null | undefined): number {
  const box = model?.bounds(false);
  if (!box || box.isEmpty()) return 10;
  const raw = box.getSize(new THREE.Vector3()).length() / 20;
  const step = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-3)));
  return Math.max(Math.round(raw / step) * step, 0.1);
}

/** Every face geometry of the model gets its estimated curvature (mean, Gaussian per node), once. */
function ensureCurvature(model: ModelRuntime) {
  const done = new Set<THREE.BufferGeometry>();
  for (const mesh of model.faces) {
    const geometry = mesh.geometry;
    if (done.has(geometry) || geometry.getAttribute('steveCurvature')) continue;
    done.add(geometry);
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    if (!position || !normal) continue;
    const positions = new Float32Array(position.count * 3), normals = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      positions[3 * i] = position.getX(i); positions[3 * i + 1] = position.getY(i); positions[3 * i + 2] = position.getZ(i);
      normals[3 * i] = normal.getX(i); normals[3 * i + 1] = normal.getY(i); normals[3 * i + 2] = normal.getZ(i);
    }
    const index = geometry.index ? geometry.index.array : Array.from({ length: position.count }, (_, i) => i);
    geometry.setAttribute('steveCurvature', new THREE.BufferAttribute(curvatures({ positions, normals, index }), 2));
  }
}

function configure(material: THREE.ShaderMaterial, state: AnalysisState, model: ModelRuntime) {
  const u = material.uniforms;
  u.uMode.value = state.mode === 'zebra' ? 0 : state.mode === 'curvature' ? 1 : 2;
  u.uStripes.value = state.stripes;
  u.uVertical.value = state.vertical;
  u.uGaussian.value = state.measure === 'gaussian';
  u.uRadius.value = state.radius ?? autoRadius(model);
  u.uPull.value.set(...pullVector(state));
  u.uMinimum.value = Math.sin(THREE.MathUtils.degToRad(Math.max(state.minimum, 0)));
}

export default function AnalysisLayer() {
  const invalidate = useThree((state) => state.invalidate);
  const version = useApp((state) => state.modelVersion);
  const design = useApp((state) => state.workspace === 'design');
  const analysis = useSurfaceAnalysis();
  const material = useMemo(analysisMaterial, []);
  useEffect(() => () => material.dispose(), [material]);
  const shading = design && (analysis.mode === 'zebra' || analysis.mode === 'curvature' || analysis.mode === 'draft');

  useEffect(() => {
    const model = viewer.model;
    if (!model || !shading) return;
    if (analysis.mode === 'curvature') ensureCurvature(model);
    configure(material, analysis, model);
    model.setAnalysis(material);
    invalidate();
  }, [shading, analysis, version, material, invalidate]);
  // Off again (or another model shown): the faces get their own look back.
  useEffect(() => {
    if (!shading) return;
    const model = viewer.model;
    return () => { model?.setAnalysis(null); invalidate(); };
  }, [shading, version, invalidate]);

  const worst = design && analysis.mode === 'continuity' ? analysis.worst : null;
  const radius = useMemo(() => {
    const box = viewer.model?.bounds(false);
    return box && !box.isEmpty() ? Math.max(box.getSize(new THREE.Vector3()).length() / 160, 0.2) : 1;
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { invalidate(); }, [worst, invalidate]);
  if (!worst) return null;
  return (
    <mesh name="continuity-worst" position={worst} renderOrder={6} raycast={() => {}}>
      <sphereGeometry args={[radius, 14, 10]} />
      <meshBasicMaterial color="#ff8a3d" depthTest={false} transparent opacity={0.9} />
    </mesh>
  );
}

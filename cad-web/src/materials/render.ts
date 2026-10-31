import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { Assignment, Finish, Library, Material } from '@/lib/materials';
import { finishOf } from '@/lib/materials';
import type { Look } from '@/lib/modeling';
import studioUrl from './assets/studio.hdr?url';
import brushedNormalUrl from './assets/brushed_normal.jpg?url';
import brushedRoughnessUrl from './assets/brushed_roughness.jpg?url';
import grainNormalUrl from './assets/grain_normal.jpg?url';
import grainRoughnessUrl from './assets/grain_roughness.jpg?url';
import woodNormalUrl from './assets/wood_normal.jpg?url';
import woodRoughnessUrl from './assets/wood_roughness.jpg?url';
import woodColorUrl from './assets/wood_color.jpg?url';

/**
 * Physically based surfaces for library materials: MeshPhysicalMaterial from the material's appearance
 * and finish, lit by a studio HDRI (Poly Haven, CC0) and, for textured finishes, triplanar-mapped
 * ambientCG (CC0) detail maps in the part's own millimetre space (CAD meshes have no UVs).
 */

/**
 * `material`: the body's library material (null: only an appearance, `model.appearance`). `look`: the appearance's
 * opacity, roughness and metalness, over the material's and the finish's; its colour and finish are in `color`/`finish`.
 */
export interface Surface { material: Material | null; finish: Finish | null; color: string | null; look?: Look | null }

// An own material's version too: editing it (its color) changes its look under the same id.
export const surfaceKey = (surface: Surface) => `${surface.material?.id ?? ''}|${surface.material?.own?.updated_at ?? ''}|${surface.finish?.id ?? ''}|${surface.color ?? ''}`
  + `|${surface.look?.opacity ?? ''}|${surface.look?.roughness ?? ''}|${surface.look?.metalness ?? ''}`;

/**
 * A body's surface from its material (model.material) and its appearance (model.appearance): the appearance wins for
 * every field it sets; without either, null (the studio look).
 */
export function bodySurface(library: Library, assignment: Assignment | null, look: Look | null): Surface | null {
  const material = (assignment && library.byId.get(assignment.material)) || null;
  if (!material && !look) return null;
  const finish = (look?.finish && library.finishById.get(look.finish)) || (material ? finishOf(library, material, assignment?.finish) : null);
  return { material, finish, color: look?.color ?? assignment?.color ?? null, look };
}

/* ───────── Studio environment ───────── */

let hdr: Promise<THREE.DataTexture> | null = null;
const reduced = new Map<number, THREE.DataTexture>();
const environments = new WeakMap<THREE.WebGLRenderer, THREE.Texture | Promise<THREE.Texture>>();

/** Software GL (SwiftShader in CI) takes many seconds to prefilter a 1k HDRI; small images take a 256 px one. */
export function softwareRenderer(gl: THREE.WebGLRenderer) {
  const context = gl.getContext();
  const info = context.getExtension('WEBGL_debug_renderer_info');
  const name = String(context.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : context.RENDERER));
  return /swiftshader|llvmpipe|software/i.test(name);
}

/** Box-filtered copy of the equirectangular HDRI, `width` texels wide. */
function downsample(source: THREE.DataTexture, width: number): THREE.DataTexture {
  let out = reduced.get(width);
  if (out) return out;
  const { width: w, height: h, data } = source.image as { width: number; height: number; data: Uint16Array };
  const k = Math.max(1, Math.round(w / width)), ow = Math.floor(w / k), oh = Math.floor(h / k);
  const pixels = new Uint16Array(ow * oh * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) sum += THREE.DataUtils.fromHalfFloat(data[((y * k + j) * w + x * k + i) * 4 + c]);
      pixels[(y * ow + x) * 4 + c] = THREE.DataUtils.toHalfFloat(sum / (k * k));
    }
    pixels[(y * ow + x) * 4 + 3] = one;
  }
  out = new THREE.DataTexture(pixels, ow, oh, THREE.RGBAFormat, THREE.HalfFloatType, THREE.EquirectangularReflectionMapping);
  out.colorSpace = THREE.LinearSRGBColorSpace;
  out.minFilter = out.magFilter = THREE.LinearFilter;
  out.flipY = source.flipY;
  out.needsUpdate = true;
  reduced.set(width, out);
  return out;
}

/**
 * The studio HDRI prefiltered for a renderer (PMREM); null until it has loaded, then `onReady` runs once.
 * `width` limits the source resolution (swatches; software GL always uses 256).
 */
export function studioEnvironment(gl: THREE.WebGLRenderer, onReady?: (texture: THREE.Texture) => void, width?: number): THREE.Texture | null {
  const known = environments.get(gl);
  if (known instanceof THREE.Texture) return known;
  if (known) { if (onReady) void known.then(onReady); return null; }
  hdr ??= new HDRLoader().loadAsync(studioUrl).then((texture) => { texture.mapping = THREE.EquirectangularReflectionMapping; return texture; });
  const limit = softwareRenderer(gl) ? Math.min(width ?? 256, 256) : width;
  const pending = hdr.then((source) => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const texture = pmrem.fromEquirectangular(limit && limit < source.image.width ? downsample(source, limit) : source).texture;
    pmrem.dispose();
    environments.set(gl, texture);
    return texture;
  });
  environments.set(gl, pending);
  if (onReady) void pending.then(onReady);
  return null;
}

/** HDRIs are Y-up; the CAD world is Z-up. The half turn faces the studio's even wall toward the default iso views. */
export const ENVIRONMENT_ROTATION = new THREE.Euler(Math.PI / 2, Math.PI, 0);
export const environmentIntensity = (theme: 'dark' | 'light') => (theme === 'dark' ? 0.9 : 1.05);

/* ───────── Finish textures ───────── */

interface TextureSet { normal: THREE.Texture; roughness: THREE.Texture; color: THREE.Texture | null; roughnessMean: { value: number }; ready: Promise<unknown> }

const SETS: Record<NonNullable<Finish['texture']>, [string, string, string | null]> = {
  brushed: [brushedNormalUrl, brushedRoughnessUrl, null],
  grain: [grainNormalUrl, grainRoughnessUrl, null],
  wood: [woodNormalUrl, woodRoughnessUrl, woodColorUrl],
};
const textureSets = new Map<string, TextureSet>();
const textureListeners = new Set<() => void>();

/** Called when a finish texture finishes loading, so the viewport can redraw. */
export function onTexturesLoaded(listener: () => void) {
  textureListeners.add(listener);
  return () => { textureListeners.delete(listener); };
}

function texture(url: string, loads: Promise<unknown>[], onLoad?: (image: HTMLImageElement) => void) {
  let done = () => {};
  loads.push(new Promise<void>((resolve) => { done = resolve; }));
  const map = new THREE.TextureLoader().load(url, (loaded) => { onLoad?.(loaded.image as HTMLImageElement); done(); textureListeners.forEach((listener) => listener()); }, undefined, () => done());
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.NoColorSpace;
  map.anisotropy = 8;
  return map;
}

/** Mean of the green channel: roughness maps modulate the finish's roughness around 1. */
function meanGreen(image: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return 0.5;
  context.drawImage(image, 0, 0, 32, 32);
  const data = context.getImageData(0, 0, 32, 32).data;
  let sum = 0;
  for (let i = 1; i < data.length; i += 4) sum += data[i];
  return Math.max(sum / (data.length / 4) / 255, 0.05);
}

function textureSet(kind: NonNullable<Finish['texture']>): TextureSet {
  let set = textureSets.get(kind);
  if (!set) {
    const [normal, roughness, color] = SETS[kind];
    const roughnessMean = { value: 0.5 };
    const loads: Promise<unknown>[] = [];
    set = { normal: texture(normal, loads), roughness: texture(roughness, loads, (image) => { roughnessMean.value = meanGreen(image); }), color: color ? texture(color, loads) : null, roughnessMean, ready: Promise.all(loads) };
    textureSets.set(kind, set);
  }
  return set;
}

/** Resolves when a finish's detail maps have loaded (previews wait; the viewport redraws instead). */
export const finishReady = (finish: Finish | null) => (finish?.texture ? textureSet(finish.texture).ready : Promise.resolve());

const TRIPLANAR_HEAD = /* glsl */ `
uniform sampler2D triNormal;
uniform sampler2D triRough;
uniform sampler2D triColor;
uniform float triScale;
uniform float triNormalScale;
uniform float triRoughMean;
uniform mat3 normalMatrix;
varying vec3 vTriPos;
varying vec3 vTriNormal;
vec3 triWeights() {
  vec3 w = pow(abs(normalize(vTriNormal)), vec3(4.0));
  return w / (w.x + w.y + w.z);
}
vec4 triSample(sampler2D map) {
  vec3 w = triWeights();
  vec3 p = vTriPos * triScale;
  return texture2D(map, p.yz) * w.x + texture2D(map, p.xz) * w.y + texture2D(map, p.xy) * w.z;
}
vec3 triNormalView() {
  vec3 w = triWeights();
  vec3 p = vTriPos * triScale;
  vec2 tx = (texture2D(triNormal, p.yz).xy * 2.0 - 1.0) * triNormalScale;
  vec2 ty = (texture2D(triNormal, p.xz).xy * 2.0 - 1.0) * triNormalScale;
  vec2 tz = (texture2D(triNormal, p.xy).xy * 2.0 - 1.0) * triNormalScale;
  vec3 n = normalize(vTriNormal) + vec3(0.0, tx) * w.x + vec3(ty.x, 0.0, ty.y) * w.y + vec3(tz, 0.0) * w.z;
  return normalize(normalMatrix * n);
}
`;

interface Patch { key: string; apply: (shader: THREE.WebGLProgramParametersWithUniforms) => void }

/** Detail maps projected along the three object axes and blended by the surface normal. */
function triplanar(finish: Finish): Patch {
  const set = textureSet(finish.texture!);
  const colored = !!set.color;
  // Gentler than the scanned roughness: its low-frequency smudges read as dirt on a clean part.
  const uniforms = {
    triNormal: { value: set.normal }, triRough: { value: set.roughness }, triColor: { value: set.color ?? set.roughness },
    triScale: { value: 1 / (finish.texture_scale_mm ?? 20) }, triNormalScale: { value: finish.normal_scale ?? 0.4 }, triRoughMean: set.roughnessMean,
  };
  return {
    key: colored ? 'tri-color' : 'tri',
    apply: (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTriPos = position;\nvTriNormal = normal;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${TRIPLANAR_HEAD}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${colored ? 'diffuseColor.rgb *= clamp(triSample(triColor).r * 2.0, 0.0, 2.0);' : ''}`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * mix(1.0, triSample(triRough).g / triRoughMean, 0.6), 0.02, 1.0);')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = triNormalView();');
    },
  };
}

/**
 * Glass and clear plastics on the CAD canvas: alpha-blended, with alpha raised where the surface reflects,
 * so Fresnel highlights stay bright while the grid, edges and other bodies show through. (A transmission
 * pass only sees opaque objects, and over the canvas's transparent background three fills it with
 * half-transparent white, which reads as milky plastic.) Swatches keep real transmission and refraction.
 */
const seeThrough: Patch = {
  key: 'clear',
  apply: (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
      '#include <opaque_fragment>\ngl_FragColor.a = clamp(gl_FragColor.a + dot(totalSpecular, vec3(0.5)), 0.0, 1.0);');
  },
};

/* ───────── Materials ───────── */

const linear = (rgb: [number, number, number]) => new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace);

/** An appearance without a material: a plain painted surface in the studio's part colour (viewport/model.ts). */
export const PLAIN = { color: '#c3cbd1', metalness: 0, roughness: 0.45 };

/**
 * One shared material per (material, finish, color, look): never one per face. `preview` renders transmission
 * for real (swatches have an opaque backdrop); the viewport draws clear materials see-through. An appearance's
 * opacity replaces the material's own transmission: glazing without a glass material.
 */
export function createSurface({ material, finish, color, look }: Surface, environment: THREE.Texture | null, theme: 'dark' | 'light', preview = false): THREE.MeshPhysicalMaterial {
  const base = material?.appearance;
  const paint = !!finish?.use_color;
  const out = new THREE.MeshPhysicalMaterial({ name: `${material?.id ?? 'appearance'}${finish ? `:${finish.id}` : ''}` });
  out.color.copy(color ? new THREE.Color(color) : base ? linear(base.base_color.linear) : new THREE.Color(PLAIN.color));
  out.metalness = look?.metalness ?? finish?.metalness ?? base?.metalness ?? PLAIN.metalness;
  out.roughness = look?.roughness ?? finish?.roughness ?? base?.roughness ?? PLAIN.roughness;
  out.clearcoat = finish?.clearcoat ?? base?.clearcoat ?? 0;
  out.clearcoatRoughness = finish?.clearcoat_roughness ?? base?.clearcoat_roughness ?? 0.08;
  out.sheen = base?.sheen ?? 0;
  out.ior = base?.ior ?? 1.5;
  const opacity = look?.opacity ?? null;
  const transmission = paint || opacity !== null ? 0 : finish?.transmission ?? base?.transmission ?? 0;
  const patches: Patch[] = [];
  if (transmission > 0 && preview) {
    out.transmission = transmission;
    out.thickness = base?.thickness_mm ?? 4;
    if (base?.attenuation_color) out.attenuationColor.copy(linear(base.attenuation_color.linear));
    out.attenuationDistance = base?.attenuation_distance_mm ?? Infinity;
  } else if (transmission > 0) {
    // Clear bodies scatter little light of their own: a faint tint; frosted ones more.
    out.color.multiplyScalar(0.32);
    out.userData.opacity = THREE.MathUtils.lerp(0.24, 0.6, Math.min(out.roughness / 0.5, 1)) * transmission + (1 - transmission);
    patches.push(seeThrough);
  } else if (opacity !== null && opacity < 1) {
    out.userData.opacity = opacity;
    patches.push(seeThrough);
  }
  out.envMap = environment;
  out.envMapRotation.copy(ENVIRONMENT_ROTATION);
  out.envMapIntensity = environmentIntensity(theme);
  // Same depth offset as the studio material, so B-rep edges stay on top.
  out.polygonOffset = true;
  out.polygonOffsetFactor = 1;
  out.polygonOffsetUnits = 1;
  out.side = THREE.FrontSide;
  if (finish?.texture) patches.push(triplanar(finish));
  if (patches.length) {
    out.onBeforeCompile = (shader) => patches.forEach((patch) => patch.apply(shader));
    const key = `steve-${patches.map((patch) => patch.key).join('-')}`;
    out.customProgramCacheKey = () => key;
  }
  if (out.userData.opacity !== undefined) { out.transparent = true; out.opacity = out.userData.opacity as number; out.depthWrite = false; }
  out.userData.surface = true;
  return out;
}

export function updateSurfaceLighting(material: THREE.MeshPhysicalMaterial, environment: THREE.Texture | null, theme: 'dark' | 'light') {
  if (material.envMap !== environment) { material.envMap = environment; material.needsUpdate = true; }
  material.envMapIntensity = environmentIntensity(theme);
}

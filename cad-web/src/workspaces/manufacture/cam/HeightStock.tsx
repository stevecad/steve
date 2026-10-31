/**
 * The display height field drawn as a lit solid: the top is a grid displaced on the GPU from a float height texture
 * (normals from the neighbouring heights, so floors are flat and scallops visible), closed by side walls down to the
 * stock's bottom and a bottom face; columns cut through are discarded. Walls come from the cutter that made them, not
 * from the grid: the vertices along a wall move sideways onto the rim the cut cells recorded (heightfield.ts
 * `wallShift`, the same sum as `hfShift` here) and wall pixels take that rim's normal, so a curved wall is one smooth
 * surface instead of steps across the 0.05–0.1 mm grid. Surfaces an operation cut are tinted
 * in its colour; "Compare to part" colours them by their height above the part's top surface instead. Only the rows a
 * worker slice changed are uploaded. Machine millimetres, like every other player artifact.
 */
import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import { moveStart } from './motion';
import { cellSizeFor, HeightField, RIM_DEEP, RIM_SCALE, topsFromOccupancy, WALL_SHIFT, WALL_STEP, type SimMoves } from './heightfield';
import { artifactBytes } from './api';
import { usePlayer, type Player } from './state';
import { compareRange, DEVIATION_COLORS, OP_COLORS, useStockView, type FieldPlan } from './stockView';
import type { SimReply, SimRequest } from './stockSim.worker';

const STOCK_COLOR = '#c3ccd5';
/** Grid quads per instanced tile side, and the most vertices the top grid draws (finer fields draw every other texel or so). */
const TILE = 128;
const MAX_VERTICES = 2_400_000;
/** A fresh cut's tint strength. */
const TINT = 0.32;
/** Tag on moves no operation band holds (tool changes): cut, but not tinted. */
export const UNASSIGNED_TAG = 255;

type Part = 'grid' | 'skirt' | 'bottom';

/** Rim records (heightfield.ts rimCode) in GLSL: vec3(direction from the cutter's axis, cells inside its rim); z < 0 none. */
const RIM_GLSL = /* glsl */ `
uniform highp usampler2D uRim;
// x: a wall's least height step, y: the cell (mm), z: the most a vertex moves (mm).
uniform vec3 uWall;
vec3 hfRim(ivec2 c) {
  uint v = texelFetch(uRim, clamp(c, ivec2(0), uSize - 1), 0).r;
  if (v == 0u || v >= ${RIM_DEEP}u) return vec3(0.0, 0.0, -1.0);
  float d = float(v & 16383u) / 4096.0;
  vec2 p = d <= 2.0 ? vec2(1.0 - d, 1.0 - abs(1.0 - d)) : vec2(d - 3.0, -(1.0 - abs(d - 3.0)));
  return vec3(normalize(p), float(v >> 14u) / ${RIM_SCALE.toFixed(1)});
}
`;

const VERTEX_HEAD = /* glsl */ `
uniform sampler2D uHeight;
uniform ivec2 uSize;
uniform vec2 uOrigin;
uniform vec2 uCell;
uniform float uBottom;
uniform float uStep;
varying vec2 vCell;
varying float vZ;
#ifdef HF_GRID
attribute vec2 aTile;
#endif
float hfAt(ivec2 c) { return texelFetch(uHeight, clamp(c, ivec2(0), uSize - 1), 0).r; }
// A texel's vertex position: cell centres inside, the stock's own edges on the border.
vec2 hfXY(ivec2 c) {
  vec2 p = uOrigin + (vec2(c) + 0.5) * uCell;
  if (c.x <= 0) p.x = uOrigin.x;
  if (c.y <= 0) p.y = uOrigin.y;
  if (c.x >= uSize.x - 1) p.x = uOrigin.x + float(uSize.x) * uCell.x;
  if (c.y >= uSize.y - 1) p.y = uOrigin.y + float(uSize.y) * uCell.y;
  return p;
}
${RIM_GLSL}
// heightfield.ts wallShift: a vertex on top of a wall moves onto the rim its lower neighbours recorded, one at the foot
// of a wall onto its own, at most uWall.z (so no triangle turns over); border vertices stay.
vec2 hfShift(ivec2 c, float h) {
  if (c.x <= 0 || c.y <= 0 || c.x >= uSize.x - 1 || c.y >= uSize.y - 1) return vec2(0.0);
  vec2 s = vec2(0.0);
  float n = 0.0;
  bool foot = false;
  for (int b = -1; b <= 1; b++) for (int a = -1; a <= 1; a++) {
    if (a == 0 && b == 0) continue;
    ivec2 k = c + ivec2(a, b);
    float hk = hfAt(k);
    if (hk > h + uWall.x) { foot = true; continue; }
    if (!(hk < h - uWall.x)) continue;
    vec3 r = hfRim(k);
    if (r.z < 0.0) continue;
    float d = r.z * uWall.y + (float(a) * uCell.x * r.x + float(b) * uCell.y * r.y);
    if (d < 0.0) { s += d * r.xy; n += 1.0; }
  }
  if (foot) {
    vec3 r = hfRim(c);
    if (r.z >= 0.0) { s += r.z * uWall.y * r.xy; n += 1.0; }
  }
  if (n == 0.0) return vec2(0.0);
  s /= n;
  float len = length(s);
  return len > uWall.z ? s * (uWall.z / len) : s;
}
`;

const NORMAL_CODE: Record<Part, string> = {
  grid: /* glsl */ `
    ivec2 hfC = clamp(ivec2((aTile + position.xy) * uStep), ivec2(0), uSize - 1);
    float hfH = hfAt(hfC);
    // The top's shading normal is worked out per pixel (FRAGMENT_NORMAL); this one only feeds the varyings.
    vec3 objectNormal = vec3(0.0, 0.0, 1.0);
    vec2 hfP = hfXY(hfC) + hfShift(hfC, hfH);
    vec3 hfPos = vec3(hfP, max(hfH, uBottom));
  `,
  skirt: /* glsl */ `
    ivec2 hfC = clamp(ivec2(position.xy), ivec2(0), uSize - 1);
    vec3 objectNormal = normal;
    vec2 hfP = hfXY(hfC);
    vec3 hfPos = vec3(hfP, position.z > 0.5 ? max(hfAt(hfC), uBottom) : uBottom);
  `,
  bottom: /* glsl */ `
    vec3 objectNormal = vec3(0.0, 0.0, -1.0);
    vec2 hfP = uOrigin + position.xy * uCell * vec2(uSize);
    vec3 hfPos = vec3(hfP, uBottom);
  `,
};

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uOps;
uniform sampler2D uPart;
uniform ivec2 uSize;
uniform float uBottom;
uniform vec3 uPalette[6];
uniform float uTint;
uniform float uCompare;
uniform vec2 uTolerance;
uniform float uRange;
uniform vec3 uDev[5];
uniform vec2 uCell;
varying vec2 vCell;
varying float vZ;
${RIM_GLSL}
float hfTop(ivec2 c) { return max(texelFetch(uHeight, clamp(c, ivec2(0), uSize - 1), 0).r, uBottom); }
// The top's normal from a cubic B-spline through the 4 × 4 columns around the point: smooth across texels, so floors
// and scallops shade as continuous surfaces. With clip, columns across a wall from this point (a step of more than
// uWall.x) count at this point's height, so a wall doesn't bend the floor or top next to it. (The stock is only ever translated, so
// object and world directions agree.)
vec3 hfSmoothNormal(bool clip) {
  vec2 p = vCell - 0.5, f = fract(p);
  ivec2 i = ivec2(floor(p));
  vec4 wx = vec4(pow(1.0 - f.x, 3.0), 3.0 * f.x * f.x * f.x - 6.0 * f.x * f.x + 4.0, -3.0 * f.x * f.x * f.x + 3.0 * f.x * f.x + 3.0 * f.x + 1.0, f.x * f.x * f.x) / 6.0;
  vec4 wy = vec4(pow(1.0 - f.y, 3.0), 3.0 * f.y * f.y * f.y - 6.0 * f.y * f.y + 4.0, -3.0 * f.y * f.y * f.y + 3.0 * f.y * f.y + 3.0 * f.y + 1.0, f.y * f.y * f.y) / 6.0;
  vec4 dx = vec4(-(1.0 - f.x) * (1.0 - f.x), 3.0 * f.x * f.x - 4.0 * f.x, -3.0 * f.x * f.x + 2.0 * f.x + 1.0, f.x * f.x) / 2.0;
  vec4 dy = vec4(-(1.0 - f.y) * (1.0 - f.y), 3.0 * f.y * f.y - 4.0 * f.y, -3.0 * f.y * f.y + 2.0 * f.y + 1.0, f.y * f.y) / 2.0;
  float gx = 0.0, gy = 0.0;
  for (int b = 0; b < 4; b++) for (int a = 0; a < 4; a++) {
    float h = hfTop(i + ivec2(a - 1, b - 1));
    if (clip && abs(h - vZ) > uWall.x) h = vZ;
    gx += h * dx[a] * wy[b];
    gy += h * wx[a] * dy[b];
  }
  return normalize((viewMatrix * vec4(normalize(vec3(-gx / uCell.x, -gy / uCell.y, 1.0)), 0.0)).xyz);
}
// On a wall (this point's height inside a step of more than uWall.x between two neighbouring columns near it): the
// cutter's own side, horizontal, facing back towards the axis the low columns of those steps recorded. Else the smooth
// normal (and on a step no cut recorded, such as a carried stock's, the smooth normal across it).
vec3 hfNormal() {
  ivec2 c0 = ivec2(floor(vCell));
  float eps = 0.02 * uWall.x;
  vec2 n = vec2(0.0);
  bool wall = false;
  for (int b = -1; b <= 1; b++) for (int a = -1; a <= 1; a++) {
    ivec2 c = c0 + ivec2(a, b);
    float hc = hfTop(c);
    for (int k = 0; k < 2; k++) {
      ivec2 d = c + (k == 0 ? ivec2(1, 0) : ivec2(0, 1));
      float hd = hfTop(d);
      float lo = min(hc, hd), hi = max(hc, hd);
      if (hi - lo <= uWall.x || vZ <= lo + eps || vZ >= hi - eps) continue;
      wall = true;
      ivec2 low = hc < hd ? c : d;
      vec3 r = hfRim(low);
      if (r.z < 0.0) continue;
      vec2 off = vCell - (vec2(low) + 0.5);
      n -= r.xy / (0.25 + dot(off, off));
    }
  }
  if (wall && dot(n, n) > 0.0) return normalize((viewMatrix * vec4(normalize(n), 0.0, 0.0)).xyz);
  return hfSmoothNormal(!wall);
}
`;

const FRAGMENT_NORMAL = /* glsl */ `
float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
vec3 normal = hfNormal();
vec3 nonPerturbedNormal = normal;
`;

const FRAGMENT_COLOR = /* glsl */ `
  ivec2 hfF = clamp(ivec2(floor(vCell)), ivec2(0), uSize - 1);
  // A column cut through has no material to draw.
  if (texelFetch(uHeight, hfF, 0).r <= uBottom + 1e-4) discard;
  // The four columns around this point: a wall between two of them takes the lower one's operation, and in a
  // comparison the larger deviation of the two sides, so walls read as one surface rather than stripes.
  ivec2 hfB = ivec2(floor(vCell - 0.5));
  float hfLow = 1e30, hfTag = 0.0, hfDev = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 c = clamp(hfB + ivec2(k & 1, k >> 1), ivec2(0), uSize - 1);
    float top = texelFetch(uHeight, c, 0).r;
    if (top <= uBottom + 1e-4) continue;
    if (top < hfLow) { hfLow = top; hfTag = floor(texelFetch(uOps, c, 0).r * 255.0 + 0.5); }
    if (uCompare > 0.5) {
      // Height above the part's top (no part under this column: everything left is stock).
      float part = texelFetch(uPart, c, 0).r;
      float d = part < -1e20 ? uRange : top - part;
      float beyond = d < -uTolerance.x ? d + uTolerance.x : d > uTolerance.y ? d - uTolerance.y : 0.0;
      float best = hfDev < -uTolerance.x ? hfDev + uTolerance.x : hfDev > uTolerance.y ? hfDev - uTolerance.y : 0.0;
      if (abs(beyond) > abs(best)) hfDev = d;
    }
  }
  if (uCompare > 0.5) {
    vec3 c = uDev[2];
    if (hfDev < -uTolerance.x) c = mix(uDev[1], uDev[0], clamp((-hfDev - uTolerance.x) / max(1e-6, uRange - uTolerance.x), 0.0, 1.0));
    else if (hfDev > uTolerance.y) c = mix(uDev[3], uDev[4], clamp((hfDev - uTolerance.y) / max(1e-6, uRange - uTolerance.y), 0.0, 1.0));
    diffuseColor.rgb = c;
  } else if (hfTag > 0.5 && hfTag < 254.5) {
    diffuseColor.rgb = mix(diffuseColor.rgb, uPalette[int(mod(hfTag - 1.0, 6.0))], uTint);
  }
`;

/** The shared uniforms of the three parts (one texture set, one look). */
function makeUniforms(field: HeightField, step: number, height: THREE.DataTexture, ops: THREE.DataTexture, part: THREE.DataTexture, rim: THREE.DataTexture) {
  return {
    uHeight: { value: height }, uOps: { value: ops }, uPart: { value: part }, uRim: { value: rim },
    uWall: { value: new THREE.Vector3(WALL_STEP * field.cell, field.cell, WALL_SHIFT * field.cell) },
    uSize: { value: new THREE.Vector2(field.nx, field.ny) }, uOrigin: { value: new THREE.Vector2(field.x0, field.y0) },
    uCell: { value: new THREE.Vector2(field.dx, field.dy) }, uBottom: { value: field.bottom }, uStep: { value: step },
    uPalette: { value: OP_COLORS.map((color) => new THREE.Color(color)) }, uTint: { value: TINT },
    uCompare: { value: 0 }, uTolerance: { value: new THREE.Vector2(0.02, 0.1) }, uRange: { value: 1 },
    uDev: { value: [DEVIATION_COLORS.gougeFar, DEVIATION_COLORS.gougeNear, DEVIATION_COLORS.onSize, DEVIATION_COLORS.leftNear, DEVIATION_COLORS.leftFar].map((color) => new THREE.Color(color)) },
  };
}
type Uniforms = ReturnType<typeof makeUniforms>;

/**
 * One-sided: the top grid is a graph over XY, so every triangle faces up or out; where a wall steps across the grid,
 * the triangles facing away sit behind the ones facing the camera (drawn two-sided they'd show as dark hairlines).
 */
function makeMaterial(part: Part, uniforms: Uniforms) {
  const material = new THREE.MeshStandardMaterial({ color: STOCK_COLOR, metalness: 0.55, roughness: 0.42, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = { ...shader.defines, [`HF_${part.toUpperCase()}`]: '' };
    shader.vertexShader = VERTEX_HEAD + shader.vertexShader
      .replace('#include <beginnormal_vertex>', NORMAL_CODE[part])
      .replace('#include <begin_vertex>', 'vec3 transformed = hfPos;\n  vCell = (hfPos.xy - uOrigin) / uCell;\n  vZ = hfPos.z;');
    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${FRAGMENT_COLOR}`);
    if (part === 'grid') shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', FRAGMENT_NORMAL);
  };
  material.customProgramCacheKey = () => `steve-heightfield-${part}`;
  return material;
}

/** The top grid: one tile of TILE × TILE quads (vertex coordinates in texel steps), instanced over the field. */
function gridGeometry(field: HeightField, step: number) {
  const tile = new THREE.PlaneGeometry(TILE, TILE, TILE, TILE);
  tile.translate(TILE / 2, TILE / 2, 0);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = tile.index;
  geometry.setAttribute('position', tile.getAttribute('position'));
  const vx = Math.ceil((field.nx - 1) / step) + 1, vy = Math.ceil((field.ny - 1) / step) + 1;
  const tx = Math.ceil((vx - 1) / TILE), ty = Math.ceil((vy - 1) / TILE);
  const offsets = new Float32Array(Math.max(1, tx * ty) * 2);
  for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) offsets.set([i * TILE, j * TILE], (j * tx + i) * 2);
  geometry.setAttribute('aTile', new THREE.InstancedBufferAttribute(offsets, 2));
  geometry.instanceCount = Math.max(1, tx * ty);
  tile.dispose();
  return geometry;
}

/** The four side walls: a top and bottom vertex per border texel (z flags which), outward normals. */
function skirtGeometry(field: HeightField) {
  const positions: number[] = [], normals: number[] = [], index: number[] = [];
  const wall = (cells: [number, number][], normal: [number, number, number], flip: boolean) => {
    const base = positions.length / 3;
    for (const [i, j] of cells) { positions.push(i, j, 0, i, j, 1); normals.push(...normal, ...normal); }
    for (let k = 0; k + 1 < cells.length; k++) {
      const a = base + k * 2, b = a + 2;
      if (flip) index.push(a, a + 1, b, b, a + 1, b + 1); else index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  };
  const { nx, ny } = field;
  const xs = Array.from({ length: nx }, (_, i) => i), ys = Array.from({ length: ny }, (_, j) => j);
  wall(xs.map((i) => [i, 0]), [0, -1, 0], false);
  wall(xs.map((i) => [i, ny - 1]), [0, 1, 0], true);
  wall(ys.map((j) => [0, j]), [-1, 0, 0], true);
  wall(ys.map((j) => [nx - 1, j]), [1, 0, 0], false);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(index);
  return geometry;
}

function bottomGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0.5, 0.5, 0);
  geometry.rotateX(Math.PI);  // Facing down.
  geometry.translate(0, 1, 0);
  return geometry;
}

/** The field on the GPU: textures, the three meshes and their look. */
export class HeightStockView {
  readonly group = new THREE.Group();
  readonly field: HeightField;
  private readonly height: THREE.DataTexture;
  private readonly ops: THREE.DataTexture;
  private readonly part: THREE.DataTexture;
  private readonly rim: THREE.DataTexture;
  private readonly uniforms: Uniforms;
  private readonly materials: THREE.MeshStandardMaterial[];
  private readonly geometries: THREE.BufferGeometry[];

  private readonly renderer: THREE.WebGLRenderer;

  constructor(field: HeightField, renderer: THREE.WebGLRenderer) {
    this.field = field;
    this.renderer = renderer;
    const { nx, ny } = field;
    this.height = new THREE.DataTexture(field.h, nx, ny, THREE.RedFormat, THREE.FloatType);
    this.ops = new THREE.DataTexture(field.op, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    this.part = new THREE.DataTexture(new Float32Array(nx * ny).fill(-1e30), nx, ny, THREE.RedFormat, THREE.FloatType);
    this.rim = new THREE.DataTexture(field.rim, nx, ny, THREE.RedIntegerFormat, THREE.UnsignedIntType);
    this.rim.internalFormat = 'R32UI';
    for (const texture of [this.height, this.ops, this.part, this.rim]) {
      texture.minFilter = texture.magFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      renderer.initTexture(texture);
    }
    const step = Math.max(1, Math.ceil(Math.sqrt((nx * ny) / MAX_VERTICES)));
    this.uniforms = makeUniforms(field, step, this.height, this.ops, this.part, this.rim);
    const parts: [Part, THREE.BufferGeometry][] = [['grid', gridGeometry(field, step)], ['skirt', skirtGeometry(field)], ['bottom', bottomGeometry()]];
    this.materials = parts.map(([part]) => makeMaterial(part, this.uniforms));
    this.geometries = parts.map(([, geometry]) => geometry);
    parts.forEach(([part, geometry], i) => {
      const mesh = new THREE.Mesh(geometry, this.materials[i]);
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      mesh.userData.camStockField = part;
      this.group.add(mesh);
    });
    this.group.userData.camStockField = { nx, ny, cell: Math.min(field.dx, field.dy), step };
  }

  /** Rows j0..j1 of new heights, tags and rim records (a worker slice); only those rows go to the GPU. */
  apply(j0: number, j1: number, h: Float32Array, op: Uint8Array, rim: Uint32Array) {
    if (j1 < j0) return;
    const { nx } = this.field, at = j0 * nx;
    this.field.h.set(h, at);
    this.field.op.set(op, at);
    this.field.rim.set(rim, at);
    if (!this.upload(this.height, j0, j1, this.field.h) || !this.upload(this.ops, j0, j1, this.field.op) || !this.upload(this.rim, j0, j1, this.field.rim)) {
      this.height.needsUpdate = true;
      this.ops.needsUpdate = true;
      this.rim.needsUpdate = true;
    }
  }

  /**
   * Uploads rows of a texture already on the GPU (three's update ranges are RGBA rows only). False when the texture
   * isn't uploaded yet (the caller then uploads it whole).
   */
  private upload(texture: THREE.DataTexture, j0: number, j1: number, data: Float32Array | Uint8Array | Uint32Array) {
    const handle = (this.renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!handle || texture.version === 0) return false;
    const gl = this.renderer.getContext() as WebGL2RenderingContext, state = this.renderer.state;
    state.bindTexture(gl.TEXTURE_2D, handle);
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const [format, type] = data instanceof Float32Array ? [gl.RED, gl.FLOAT] : data instanceof Uint32Array ? [gl.RED_INTEGER, gl.UNSIGNED_INT] : [gl.RED, gl.UNSIGNED_BYTE];
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, j0, this.field.nx, j1 - j0 + 1, format, type, data, j0 * this.field.nx);
    return true;
  }

  setPart(top: Float32Array) {
    (this.part.image.data as Float32Array).set(top.map((value) => (value === -Infinity ? -1e30 : value)));
    this.part.needsUpdate = true;
  }

  setLook(mode: 'solid' | 'translucent', compare: { on: boolean; missing: number; excess: number; range: number }) {
    const translucent = mode === 'translucent';
    for (const material of this.materials) {
      if (material.transparent !== translucent) { material.transparent = translucent; material.needsUpdate = true; }
      material.opacity = translucent ? 0.32 : 1;
      material.depthWrite = !translucent;
      // Solid, the stock sits a hair behind coincident faces (the part's); see-through, a hair in front, so neither flickers.
      material.polygonOffsetFactor = material.polygonOffsetUnits = translucent ? -1 : 1;
      material.metalness = compare.on ? 0.1 : 0.55;
      material.roughness = compare.on ? 0.7 : 0.42;
      material.color.set(compare.on ? '#ffffff' : STOCK_COLOR);
    }
    for (const child of this.group.children) child.renderOrder = translucent ? 8 : 1;
    this.uniforms.uCompare.value = compare.on ? 1 : 0;
    this.uniforms.uTolerance.value.set(compare.missing, compare.excess);
    this.uniforms.uRange.value = compare.range;
  }

  dispose() {
    for (const texture of [this.height, this.ops, this.part, this.rim]) texture.dispose();
    for (const material of this.materials) material.dispose();
    for (const geometry of this.geometries) geometry.dispose();
  }
}

/** The design's triangles in machine space (the design sits in the work frame; machine = work + origin). */
function partTriangles(origin: number[]): Float32Array | null {
  const root = viewer.model?.root;
  if (!root) return null;
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const v = new THREE.Vector3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (object as THREE.InstancedMesh).isInstancedMesh) return;
    const position = mesh.geometry?.getAttribute('position');
    if (!position) return;
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    for (let k = 0; k < count; k++) {
      v.fromBufferAttribute(position, index ? index.getX(k) : k).applyMatrix4(mesh.matrixWorld);
      out.push(v.x + origin[0], v.y + origin[1], v.z + origin[2]);
    }
  });
  return out.length ? new Float32Array(out) : null;
}

/** The program's moves with each one's cutter and tag (its operation band + 1). */
function simMoves(player: Player, plan: Extract<FieldPlan, { ok: true }>): SimMoves {
  const motion = player.motion!, count = motion.count;
  const start = new Float64Array(count * 3), end = new Float64Array(count * 3), cutter = new Int16Array(count), tag = new Uint8Array(count);
  const at: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    start.set(moveStart(motion, i, at), i * 3);
    end.set(motion.end.subarray(i * 3, i * 3 + 3), i * 3);
    cutter[i] = plan.cutterOf.get(motion.tool[i]) ?? -1;
  }
  tag.fill(player.bands.length ? UNASSIGNED_TAG : 1);
  player.bands.forEach((band, b) => tag.fill(Math.min(254, b + 1), band.first, Math.min(count, band.last + 1)));
  return { count, start, end, cutter, tag };
}

/** The display stock for a 3-axis milling job (see stockView.fieldPlan for when it applies). */
export default function HeightStock({ player, plan, mode }: { player: Player; plan: Extract<FieldPlan, { ok: true }>; mode: 'solid' | 'translucent' }) {
  const invalidate = useThree((state) => state.invalidate);
  const renderer = useThree((state) => state.gl);
  const compare = useStockView((state) => state.compare);
  const setup = useMemo(() => {
    const { min, max } = plan;
    const cell = cellSizeFor(max[0] - min[0], max[1] - min[1], plan.smallest);
    const field = new HeightField(min, max, cell);
    return { cell, field, view: new HeightStockView(field, renderer) };
  }, [plan, renderer]);
  useEffect(() => {
    const { field, view, cell } = setup;
    let live = true;
    const worker = new Worker(new URL('./stockSim.worker.ts', import.meta.url), { type: 'module' });
    const send = (message: SimRequest, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
    const status = (patch: Partial<NonNullable<ReturnType<typeof useStockView.getState>['status']>>) => useStockView.setState((state) => ({
      status: { cell, nx: field.nx, ny: field.ny, cutting: null, ms: 0, work: 0, initial: plan.initial, part: null, ...state.status, ...patch },
    }));
    useStockView.setState({ status: null });
    status({});
    worker.onmessage = (event: MessageEvent<SimReply>) => {
      if (!live) return;
      const reply = event.data;
      if (reply.type === 'rows') {
        view.apply(reply.j0, reply.j1, reply.h, reply.op, reply.rim);
        view.group.userData.camStockField = { ...view.group.userData.camStockField, at: reply.at, done: reply.done };
        status({ cutting: reply.done ? null : reply.at, ms: reply.ms, work: reply.work });
        invalidate();
      } else if (reply.type === 'part') {
        view.setPart(reply.top);
        status({ part: true });
        invalidate();
      } else useStockView.setState({ error: { job: player.job.id, message: reply.message } });
    };
    worker.onerror = (event) => { if (live) useStockView.setState({ error: { job: player.job.id, message: event.message || 'the stock simulation stopped' } }); };
    void (async () => {
      // A carried stock starts from the engine's initial cells (no undercuts, else the plan would have refused it).
      let initial: Float32Array | null = null;
      if (plan.initial === 'engine cells') {
        const first = player.preview!.stock_checkpoints.find((checkpoint) => checkpoint.after_move < 0)!;
        const states = new Uint8Array(await artifactBytes(player.job.id, first.state!));
        initial = topsFromOccupancy(first.snapshot.grid, states, field);
        if (!initial) { useStockView.setState({ error: { job: player.job.id, message: 'the starting stock has undercuts a height field can’t hold' } }); return; }
        if (!live) return;
        view.apply(0, field.ny - 1, initial, new Uint8Array(field.size), new Uint32Array(field.size));
      }
      const moves = simMoves(player, plan);
      // Restore points: more on machines that say they have the memory (Chromium's deviceMemory, in GB).
      const memory = ((navigator as { deviceMemory?: number }).deviceMemory ?? 4) >= 8 ? 256e6 : 128e6;
      send({ type: 'init', min: plan.min, max: plan.max, cell, initial, moves, cutters: plan.cutters, memory }, [moves.start.buffer, moves.end.buffer]);
      send({ type: 'seek', t: usePlayer.getState().position });
    })().catch((error) => { if (live) useStockView.setState({ error: { job: player.job.id, message: error instanceof Error ? error.message : String(error) } }); });
    const unsubscribe = usePlayer.subscribe((state, previous) => { if (state.position !== previous.position) send({ type: 'seek', t: state.position }); });
    // The part's top surface, once, when comparing.
    let asked = false;
    const askPart = (on: boolean) => {
      if (!on || asked) return;
      asked = true;
      const triangles = player.origin ? partTriangles(player.origin) : null;
      if (triangles) send({ type: 'part', triangles }, [triangles.buffer]);
      else status({ part: false });
    };
    askPart(useStockView.getState().compare);
    const unsubscribeView = useStockView.subscribe((state) => askPart(state.compare));
    return () => { live = false; unsubscribe(); unsubscribeView(); worker.terminate(); useStockView.setState({ status: null }); };
  }, [setup, plan, player, invalidate]);
  useEffect(() => {
    setup.view.setLook(mode, { on: compare, missing: plan.tolerance.missing, excess: plan.tolerance.excess, range: compareRange(plan) });
    invalidate();
  }, [setup, mode, compare, plan, invalidate]);
  useEffect(() => () => setup.view.dispose(), [setup]);
  return <primitive object={setup.view.group} />;
}

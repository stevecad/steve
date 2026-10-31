/**
 * Decals (`model.decal`): images over the model. Each ok decal feature's `detail` places it in
 * its part's coordinates. On one flat face it is a textured quad (origin, outward normal, x direction, width, height or
 * null for the image's aspect). A projected decal (curved or several faces: `faces`, its body's face indices in export
 * order) is projected like a slide projector (origin, direction it is seen from, x direction, width, height, depth)
 * onto those faces' triangles: clipped to the projector's box (±depth along its direction) and to the triangles that
 * face it, so it never shows on the far side. A wrapped one (`wrap`: projected's frame and faces) follows the surface
 * like a sticker instead: the faces' triangles unfolded from its centre with lengths kept along the skin (decalWrap.ts),
 * clipped to its rectangle. Each hangs off a face mesh of its body (or, in a design, of its
 * instance), so it moves, hides and explodes with it; it is never picked, and its material follows style, fade and
 * clipping (ModelRuntime.adoptMaterial). Images come from GET /v1/decal-images/{id} (app/decal_images.py) and are
 * shared across models.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { FeatureResult, ModelingResult } from '@/lib/modeling';
import { bodyOrder, componentBodyOrder } from '@/lib/bodyOrder';
import { bodyFaces, modelingOf } from '@/modeling/bodies';
import { instanceSources } from './instanceSource';
import { unfold, weld, type Vec3 } from './decalWrap';
import { viewer } from './viewer';
import type { FaceInfo, ModelRuntime } from './model';
import { withWorkspace } from '@/teams/current';

export interface DecalDetail {
  image: string; origin: number[]; x_dir: number[]; width: number; height: number | null; body?: string;
  /** One flat face: its reference and outward normal. */
  face?: string; normal?: number[];
  /** Projected: the side it is seen from, its reach (null: half the image's larger side) and its body's faces. */
  direction?: number[]; depth?: number | null; faces?: number[];
  /** Wrapped: laid along the faces from `origin` instead of projected (`depth` doesn't apply). */
  wrap?: boolean;
}

/** Lifts the image off its face (mm), on top of the depth offset, so it never fights the face for depth. */
const LIFT = 0.01;
/** A projected decal shows only on triangles turned toward it: normal · direction above this (grazing ones would smear). */
const FACING = 0.05;
const textures = new Map<string, Promise<THREE.Texture | null>>();

/** Where decal images load from: the workspace's API in the app; a share link's own route on the share page. */
let imageUrl = (id: string) => withWorkspace(`/v1/decal-images/${encodeURIComponent(id)}`);
export function setDecalImageUrl(url: (id: string) => string) { imageUrl = url; textures.clear(); }

function texture(id: string, gl: THREE.WebGLRenderer): Promise<THREE.Texture | null> {
  let found = textures.get(id);
  if (!found) {
    found = new THREE.TextureLoader().loadAsync(imageUrl(id)).then((map) => {
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
      return map;
    }).catch(() => {
      textures.delete(id);  // Not uploaded (yet), or not this workspace's: try again with the next build.
      console.warn(`Decal image ${id} couldn't be loaded.`);
      return null;
    });
    textures.set(id, found);
  }
  return found;
}

export const decalsOf = (summary: ModelingResult | null | undefined): (FeatureResult & { detail: DecalDetail })[] =>
  (summary?.features ?? []).filter((f): f is FeatureResult & { detail: DecalDetail } => f.kind === 'decal' && f.status === 'ok' && !!f.detail);

const projected = (detail: DecalDetail) => Array.isArray(detail.faces) && Array.isArray(detail.direction);

const aspectOf = (map: THREE.Texture) => {
  const image = map.image as { width?: number; height?: number } | undefined;
  return image?.width && image.height ? image.height / image.width : 1;
};

function decalMesh(geometry: THREE.BufferGeometry, map: THREE.Texture): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.FrontSide });
  material.userData.decal = true;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.raycast = () => {};
  mesh.renderOrder = 2;
  mesh.userData.decal = true;
  return mesh;
}

/** The quad for one decal on a flat face, in its part's coordinates. */
function quad(detail: DecalDetail, map: THREE.Texture): THREE.Mesh {
  const height = detail.height ?? detail.width * aspectOf(map);
  const mesh = decalMesh(new THREE.PlaneGeometry(detail.width, height), map);
  const normal = new THREE.Vector3(...detail.normal!).normalize();
  const x = new THREE.Vector3(...detail.x_dir).normalize();
  const y = new THREE.Vector3().crossVectors(normal, x);
  mesh.matrix.makeBasis(x, y, normal).setPosition(new THREE.Vector3(...detail.origin).addScaledVector(normal, LIFT));
  return mesh;
}

/** A vertex while clipping: where it is in the projector's frame (u, v, along its direction), on the face, and its normal. */
interface Corner { local: THREE.Vector3; point: THREE.Vector3; normal: THREE.Vector3 }

const mix = (a: Corner, b: Corner, t: number): Corner => ({
  local: a.local.clone().lerp(b.local, t), point: a.point.clone().lerp(b.point, t), normal: a.normal.clone().lerp(b.normal, t),
});

/** Sutherland–Hodgman: the part of a polygon where `side(local)` ≤ 0, `side` linear. */
function clip(polygon: Corner[], side: (local: THREE.Vector3) => number): Corner[] {
  const out: Corner[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = side(a.local), db = side(b.local);
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) out.push(mix(a, b, da / (da - db)));
  }
  return out;
}

/**
 * Every triangle of `faces` in `anchor`'s frame (its part's coordinates): its corners, their normals where the mesh has
 * them, and its own normal (null when it has no area).
 */
function eachTriangle(anchor: THREE.Mesh, faces: THREE.Mesh[], visit: (points: THREE.Vector3[], normals: (THREE.Vector3 | null)[], facing: THREE.Vector3) => void) {
  anchor.updateWorldMatrix(true, false);
  const toAnchor = anchor.matrixWorld.clone().invert();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const face of faces) {
    const position = face.geometry.getAttribute('position');
    if (!position) continue;
    const normal = face.geometry.getAttribute('normal') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    face.updateWorldMatrix(true, false);
    const matrix = toAnchor.clone().multiply(face.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const index = face.geometry.index;
    const count = index ? index.count : position.count;
    for (let t = 0; t + 2 < count; t += 3) {
      const corners = index ? [index.getX(t), index.getX(t + 1), index.getX(t + 2)] : [t, t + 1, t + 2];
      const points = corners.map((i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix));
      const facing = new THREE.Vector3().crossVectors(ab.subVectors(points[1], points[0]), ac.subVectors(points[2], points[0]));
      if (facing.lengthSq() === 0) continue;
      facing.normalize();
      visit(points, corners.map((i) => (normal ? new THREE.Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize() : null)), facing);
    }
  }
}

/** A decal's surface while it is built: triangles lifted a hair along their normals, with the image's UVs. */
interface Surface { positions: number[]; normals: number[]; uvs: number[] }

/** The part of a polygon inside every plane (`side` ≤ 0), fanned into `out`; `local` x, y are the image's mm from its centre. */
function emit(polygon: Corner[], planes: ((local: THREE.Vector3) => number)[], facing: THREE.Vector3, out: Surface, width: number, height: number) {
  for (const side of planes) {
    polygon = clip(polygon, side);
    if (polygon.length < 3) return;
  }
  for (let v = 1; v + 1 < polygon.length; v++) {
    for (const c of [polygon[0], polygon[v], polygon[v + 1]]) {
      const along = c.normal.lengthSq() ? c.normal.clone().normalize() : facing;
      out.positions.push(c.point.x + along.x * LIFT, c.point.y + along.y * LIFT, c.point.z + along.z * LIFT);
      out.normals.push(along.x, along.y, along.z);
      out.uvs.push(c.local.x / width + 0.5, c.local.y / height + 0.5);
    }
  }
}

function geometryOf(out: Surface): THREE.BufferGeometry | null {
  if (!out.positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(out.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(out.uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The image's rectangle, ±width/2 and ±height/2 about its centre. */
const rectangle = (width: number, height: number): ((local: THREE.Vector3) => number)[] =>
  [(l) => l.x - width / 2, (l) => -l.x - width / 2, (l) => l.y - height / 2, (l) => -l.y - height / 2];

/**
 * A projected decal's surface, in `anchor`'s frame (its part's coordinates): the target faces' triangles that face the
 * projector, clipped to its box, lifted a hair along their normals, with the image's UVs from the projector's frame.
 * Work is bounded by the faces' triangles. Null when nothing of the faces is inside the box.
 */
function projection(detail: DecalDetail, map: THREE.Texture, anchor: THREE.Mesh, faces: THREE.Mesh[]): THREE.BufferGeometry | null {
  const width = detail.width, height = detail.height ?? detail.width * aspectOf(map);
  const depth = detail.depth ?? Math.max(width, height) / 2;
  const n = new THREE.Vector3(...detail.direction!).normalize();
  const x = new THREE.Vector3(...detail.x_dir).normalize();
  const y = new THREE.Vector3().crossVectors(n, x);
  const origin = new THREE.Vector3(...detail.origin);
  const planes = [...rectangle(width, height), (l: THREE.Vector3) => l.z - depth, (l: THREE.Vector3) => -l.z - depth];
  const out: Surface = { positions: [], normals: [], uvs: [] };
  eachTriangle(anchor, faces, (points, normals, facing) => {
    if (facing.dot(n) <= FACING) return;  // Turned away (the far side of a fuselage) or grazing.
    const polygon = points.map((point, c): Corner => {
      const offset = point.clone().sub(origin);
      return { local: new THREE.Vector3(offset.dot(x), offset.dot(y), offset.dot(n)), point, normal: normals[c] ?? facing.clone() };
    });
    emit(polygon, planes, facing, out, width, height);
  });
  return geometryOf(out);
}

/** Corners closer than this (mm) are one point when a wrapped decal's faces are joined: their borders, a seam. */
const WELD = 1e-3;
/** How far a wrapped decal's front runs along the mesh's edges, in its half-diagonals (edge paths run longer than the surface's). */
const REACH = 1.5;
/** A triangle whose unfolded edge is this much longer than on the surface lies where the front met itself (round a body): left out. */
const TORN = 2;

/**
 * A wrapped decal's surface, in `anchor`'s frame: the target faces' triangles near its centre unfolded into its plane
 * along the surface (decalWrap.ts), so its lengths are kept on the skin, clipped to its rectangle and lifted a hair.
 * Work is bounded by the triangles within its reach. Null when nothing of the faces is inside it.
 */
function wrapping(detail: DecalDetail, map: THREE.Texture, anchor: THREE.Mesh, faces: THREE.Mesh[]): THREE.BufferGeometry | null {
  const width = detail.width, height = detail.height ?? detail.width * aspectOf(map);
  const origin = new THREE.Vector3(...detail.origin);
  const limit = REACH * Math.hypot(width, height) / 2;
  const corners: number[] = [], normals: number[] = [];
  const middle = new THREE.Vector3();
  let longestEdge = 0;
  eachTriangle(anchor, faces, (points, along, facing) => {
    middle.copy(points[0]).add(points[1]).add(points[2]).divideScalar(3);
    const size = Math.max(...points.map((p) => p.distanceTo(middle)));
    if (middle.distanceTo(origin) - size > limit) return;  // Out of reach: along the surface is never shorter than straight.
    for (let i = 0; i < 3; i++) longestEdge = Math.max(longestEdge, points[i].distanceTo(points[(i + 1) % 3]));
    points.forEach((p, c) => {
      const n = along[c] ?? facing;
      corners.push(p.x, p.y, p.z);
      normals.push(n.x, n.y, n.z);
    });
  });
  const mesh = weld(corners, normals, WELD);
  // CAD meshes can span a cylinder's entire height in one triangle. The decal may
  // intersect its interior while every corner lies beyond the image's reach.
  // Include a mesh-edge halo for the vertex traversal; rectangle clipping below
  // still determines the exact visible size. The nearby-triangle filter bounds work.
  const uv = unfold(mesh, [origin.x, origin.y, origin.z], detail.x_dir as Vec3, limit + longestEdge);
  if (!uv) return null;
  const { points, triangles } = mesh;
  const out: Surface = { positions: [], normals: [], uvs: [] };
  const planes = rectangle(width, height);
  const own = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const ids = [triangles[t], triangles[t + 1], triangles[t + 2]];
    if (ids.some((i) => Number.isNaN(uv[2 * i]))) continue;
    const polygon = ids.map((i): Corner => ({
      local: new THREE.Vector3(uv[2 * i], uv[2 * i + 1], 0),
      point: new THREE.Vector3(points[3 * i], points[3 * i + 1], points[3 * i + 2]),
      normal: new THREE.Vector3(mesh.normals[3 * i], mesh.normals[3 * i + 1], mesh.normals[3 * i + 2]),
    }));
    if (polygon.some((a, k) => {
      const b = polygon[(k + 1) % 3];
      return a.local.distanceTo(b.local) > TORN * a.point.distanceTo(b.point) + 1e-6;
    })) continue;
    own.crossVectors(ab.subVectors(polygon[1].point, polygon[0].point), ac.subVectors(polygon[2].point, polygon[0].point)).normalize();
    emit(polygon, planes, own, out, width, height);
  }
  return geometryOf(out);
}

/** Where a decal goes: the face mesh it hangs off, and for a projected one the faces it lands on. */
interface Placement { anchor: THREE.Mesh; detail: DecalDetail; faces: THREE.Mesh[] }

/** A body's first face index in its exported mesh (bodies in `order`), or null when it isn't reported. */
function bodyStart(report: ModelingResult | null | undefined, order: string[], body: string | undefined): number | null {
  let start = 0;
  for (const id of order) {
    if (id === body) return start;
    start += report?.bodies[id]?.faces ?? 0;
  }
  return null;
}

/** A projected decal's faces among `meshes` (a part's, or one instance's), merged bodies' faces made on demand. */
function landing(model: ModelRuntime, meshes: THREE.Mesh[], detail: DecalDetail, start: number | null): Placement | null {
  if (start === null) return null;
  const wanted = new Set(detail.faces!.map((face) => start + face));
  let anchor: THREE.Mesh | undefined;
  const faces: THREE.Mesh[] = [];
  for (const mesh of meshes) {
    const merged = model.isMerged(mesh);
    for (const info of model.facesOf(mesh)) {
      if (!wanted.has(info.faceIndex)) continue;
      const face = merged ? model.faceMesh(info.node, info.meshIndex, info.faceIndex) : mesh;
      if (!face) continue;
      anchor ??= mesh;
      faces.push(face);
    }
  }
  return anchor ? { anchor, detail, faces } : null;
}

/** Where each decal hangs, for a part or a design's instances. */
function placements(model: ModelRuntime): Placement[] {
  const out: Placement[] = [];
  if (model.build.kind !== 'design') {
    const report = modelingOf(model.build);
    const decals = decalsOf(report);
    if (!decals.length) return out;
    const bodies = bodyFaces(model);
    const order = bodyOrder(report);
    for (const { detail } of decals) {
      if (projected(detail)) {
        const placed = landing(model, model.faces, detail, bodyStart(report, order, detail.body));
        if (placed) out.push(placed);
        continue;
      }
      const mesh = (detail.body ? bodies.get(detail.body)?.[0] : undefined) ?? model.faces[0];
      if (mesh) out.push({ anchor: mesh, detail, faces: [] });
    }
    return out;
  }
  // Each placed instance (a linked design's own, too) shows its part's decals on its own faces (as MaterialAppearance).
  const sourceOf = instanceSources(model);
  const instances = new Map<string, { meshes: THREE.Mesh[]; summary: ModelingResult | null }>();
  for (const mesh of model.faces) {
    const found = sourceOf((mesh.userData.face as FaceInfo).node);
    if (!found) continue;
    const instance = instances.get(found.node);
    if (instance) instance.meshes.push(mesh); else instances.set(found.node, { meshes: [mesh], summary: found.summary });
  }
  for (const { meshes, summary } of instances.values()) {
    for (const { detail } of decalsOf(summary)) {
      if (!projected(detail)) { out.push({ anchor: meshes[0], detail, faces: [] }); continue; }
      const placed = landing(model, meshes, detail, bodyStart(summary, componentBodyOrder(summary), detail.body));
      if (placed) out.push(placed);
    }
  }
  return out;
}

export default function DecalLayer() {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const live = useRef<THREE.Mesh[]>([]);

  // A hidden body's faces leave the render layers (ModelRuntime.setHiddenFaces); its decals go with them.
  useFrame(() => {
    for (const mesh of live.current) mesh.visible = !!mesh.parent && mesh.parent.layers.mask !== 0;
  });

  useEffect(() => {
    let shown: THREE.Mesh[] = [];
    let run = 0;
    let drawn: ModelRuntime | null = null;
    const clear = () => {
      for (const mesh of shown) { mesh.removeFromParent(); mesh.geometry.dispose(); }
      shown = [];
      live.current = shown;
    };
    const apply = () => {
      const model = viewer.model;
      if (model && model === drawn) return;  // Decals come with the build: one pass per model.
      drawn = model;
      const current = ++run;
      clear();
      if (!model) { invalidate(); return; }
      for (const { anchor, detail, faces } of placements(model)) {
        void texture(detail.image, gl).then((map) => {
          if (!map || current !== run || viewer.model !== model) return;
          let mesh: THREE.Mesh;
          if (projected(detail)) {
            const geometry = detail.wrap ? wrapping(detail, map, anchor, faces) : projection(detail, map, anchor, faces);
            if (!geometry) return;
            mesh = decalMesh(geometry, map);
            mesh.userData[detail.wrap ? 'wrapped' : 'projected'] = true;
          } else mesh = quad(detail, map);
          model.adoptMaterial(mesh.material as THREE.MeshStandardMaterial);
          anchor.add(mesh);
          shown.push(mesh);
          live.current = shown;
          invalidate();
        });
      }
      invalidate();
    };
    apply();
    const stop = viewer.onModelChange(apply);
    return () => { run++; clear(); stop(); };
  }, [gl, invalidate]);

  return null;
}

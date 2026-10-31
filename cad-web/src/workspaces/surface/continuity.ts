/**
 * The continuity check of a picked edge: how the two faces that share it meet, read at the edge's points
 * (viewport/surfaceAnalysis.ts continuity). Each face's point and normal there come from the build's tessellation of
 * that face (its nodes on the edge, the surface's normals at them); its curvature across the edge is exact for planes,
 * cylinders and spheres and estimated from its mesh otherwise.
 */
import * as THREE from 'three';
import type { EntityPick } from '@/state/store';
import type { ModelRuntime } from '@/viewport/model';
import { analyticOf } from '@/viewport/measure';
import { acrossEdge, continuity, curvatureToward, exactCurvature, fromMeasured, neighbours, type Continuity, type EdgeSide, type FaceMesh, type Vec } from '@/viewport/surfaceAnalysis';

/** At most this many of the edge's points are compared (spread along it). */
const SAMPLES = 64;

/** One face pair along the edge (a free edge can meet another body's face): which faces, and how they meet. */
export interface PairCheck { faces: [number, number]; result: Continuity; samples: number }
export type EdgeCheck = { pairs: PairCheck[] } | { problem: string };

const tuple = (v: THREE.Vector3): Vec => [v.x, v.y, v.z];

/** A face's mesh in world coordinates, with each node's neighbours. */
function worldFace(model: ModelRuntime, pick: EntityPick, face: number): { mesh: FaceMesh; around: number[][] } | null {
  const object = model.faceMesh(pick.node, pick.mesh, face);
  const position = object?.geometry.getAttribute('position'), normal = object?.geometry.getAttribute('normal');
  if (!object || !position || !normal) return null;
  object.updateWorldMatrix(true, false);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(object.matrixWorld);
  const positions = new Float32Array(position.count * 3), normals = new Float32Array(position.count * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
    positions.set([p.x, p.y, p.z], 3 * i);
    p.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
    normals.set([p.x, p.y, p.z], 3 * i);
  }
  const index = object.geometry.index ? object.geometry.index.array : Array.from({ length: position.count }, (_, i) => i);
  const mesh = { positions, normals, index };
  return { mesh, around: neighbours(mesh) };
}

function nearest(mesh: FaceMesh, point: Vec): number {
  let best = -1, distance = Infinity;
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const dx = mesh.positions[3 * i] - point[0], dy = mesh.positions[3 * i + 1] - point[1], dz = mesh.positions[3 * i + 2] - point[2];
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared < distance) { distance = squared; best = i; }
  }
  return best;
}

const node = (mesh: FaceMesh, i: number, of: 'positions' | 'normals'): Vec => [mesh[of][3 * i], mesh[of][3 * i + 1], mesh[of][3 * i + 2]];

/** The exact shape of a face, when it's one the curvature can be read from exactly. */
function exactShape(model: ModelRuntime, pick: EntityPick, face: number) {
  const surface = analyticOf(model, { kind: 'face', node: pick.node, mesh: pick.mesh, index: face });
  return surface.kind === 'plane' || surface.kind === 'cylinder' || surface.kind === 'sphere' ? surface : null;
}

export function checkEdge(model: ModelRuntime, pick: EntityPick): EdgeCheck {
  const edge = model.topologyFor(pick.mesh)?.edges[pick.index];
  if (!edge) return { problem: 'This edge has no description in the build: generate the model again.' };
  const faces = edge.faces ?? [];
  // Measured on the exact B-rep by the build (smooth edges, and free edges against the face that continues them).
  if (edge.continuity?.length) {
    const frame = model.frameFor(pick.node, pick.mesh);
    const toWorld = (v: Vec): Vec => (frame ? tuple(new THREE.Vector3(...v).applyMatrix4(frame.matrixWorld)) : v);
    return { pairs: edge.continuity.map((measured) => {
      const result = fromMeasured(measured);
      return { faces: measured.faces, samples: measured.samples, result: { ...result, worst: toWorld(result.worst) } };
    }) };
  }
  if (edge.seam) return { problem: 'A seam: the face meets itself here, so it is as smooth as the surface itself.' };
  if (faces.length === 1) return { problem: 'An open edge: it bounds one face, and no other body’s face continues it here.' };
  if (faces.length !== 2) return { problem: 'Pick an edge between two faces.' };
  const all = model.worldEdgePoints(pick).map(tuple);
  if (all.length < 2) return { problem: 'This edge has no points to compare: generate the model again.' };
  const step = Math.max(1, Math.ceil(all.length / SAMPLES));
  const points = all.filter((_, i) => i % step === 0 || i === all.length - 1);
  const [a, b] = faces.map((face) => worldFace(model, pick, face));
  if (!a || !b) return { problem: 'The faces of this edge aren’t shown: show them and pick it again.' };
  const shapes = faces.map((face) => exactShape(model, pick, face));
  const sides: EdgeSide[] = [{ points: [], normals: [], across: [], exactCurvature: !!shapes[0] }, { points: [], normals: [], across: [], exactCurvature: !!shapes[1] }];
  /** One face's node on the edge: its point, normal and curvature across the edge (into the face). */
  const sample = (face: { mesh: FaceMesh; around: number[][] }, index: number, shape: ReturnType<typeof exactShape>, tangent: Vec, side: EdgeSide) => {
    const { mesh, around } = face;
    const p = node(mesh, index, 'positions'), n = node(mesh, index, 'normals');
    // Into the face: towards the middle of the node's neighbours.
    const middle = new THREE.Vector3();
    for (const other of around[index]) middle.add(new THREE.Vector3(...node(mesh, other, 'positions')));
    middle.divideScalar(Math.max(around[index].length, 1)).sub(new THREE.Vector3(...p));
    const across = acrossEdge(n, tangent, tuple(middle));
    side.points.push(p);
    side.normals.push(n);
    side.across.push(shape ? exactCurvature(shape, p, n, across) : curvatureToward(mesh, around, index, across));
  };
  let previous = -1;
  points.forEach((point, k) => {
    const i = nearest(a.mesh, point);
    if (i < 0 || i === previous) return;
    previous = i;
    const j = nearest(b.mesh, node(a.mesh, i, 'positions'));
    const before = new THREE.Vector3(...points[Math.max(k - 1, 0)]), after = new THREE.Vector3(...points[Math.min(k + 1, points.length - 1)]);
    const tangent = tuple(after.sub(before).normalize());
    sample(a, i, shapes[0], tangent, sides[0]);
    sample(b, j, shapes[1], tangent, sides[1]);
  });
  const result = continuity(sides[0], sides[1]);
  return result ? { pairs: [{ faces: [faces[0], faces[1]], result, samples: sides[0].points.length }] } : { problem: 'This edge has no points to compare: generate the model again.' };
}

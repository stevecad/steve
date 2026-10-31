import * as THREE from 'three';
import type { ModelRuntime } from './model';
import { get, samePick, set, type Pick } from '@/state/store';
import { areaText, lengthNum, lengthText, num } from '@/lib/format';
import { setting } from '@/settings/store';
import { analyze } from './semantics';
import { coneApex, meshIsExact, minimumDistance, relations, type Shape, type Surface, type Vec } from './measureMath';

export function addMeasurePick(pick: Pick) {
  const current = get().measurePicks;
  if (current.some((item) => samePick(item, pick))) { set({ measurePicks: current.filter((item) => !samePick(item, pick)) }); return; }
  set({ measurePicks: current.length >= 2 ? [pick] : [...current, pick] });
}

export interface MeasureRow { label: string; value: string; emphasis?: boolean; title?: string }
export interface MeasureLine { a: THREE.Vector3; b: THREE.Vector3; label: string }
export interface Measurement { title: string; rows: MeasureRow[]; lines: MeasureLine[]; points: THREE.Vector3[] }

const deg = (radians: number) => `${num(THREE.MathUtils.radToDeg(radians), 2)}°`;
// In the person's display units (Settings → Display › Units); the model's numbers are mm.
const units = () => setting('display.units');
const len = (value: number) => lengthText(value, units(), 3);
const area = (value: number) => areaText(value, units(), 2);
const v3 = (p: Vec) => new THREE.Vector3(p[0], p[1], p[2]);
const tuple = (v: THREE.Vector3): Vec => [v.x, v.y, v.z];
/** Approximate values say so: measured on the displayed mesh, not the exact surface. */
const APPROXIMATE = 'Measured on the displayed mesh, which approximates curved faces and edges: close, not exact.';

const SURFACE_NAMES: Record<string, string> = {
  plane: 'Planar', cylinder: 'Cylindrical', cone: 'Conical', sphere: 'Spherical', torus: 'Toroidal', bspline: 'B-spline',
  bezier: 'Bézier', revolution: 'Revolved', extrusion: 'Extruded', offset: 'Offset',
};

/** A short name for a pick, for the Measure panel's slots: "Cylindrical face", "Circle edge", "Vertex". */
export function pickLabel(model: ModelRuntime | null | undefined, pick: Pick): string {
  if (pick.kind === 'component') return 'Component';
  if (pick.kind === 'vertex') return 'Vertex';
  const topology = model?.topologyFor(pick.mesh);
  if (pick.kind === 'edge') {
    const type = topology?.edges[pick.index]?.type;
    return type === 'line' ? 'Straight edge' : type === 'circle' ? 'Circular edge' : 'Curved edge';
  }
  const type = topology?.faces[pick.index]?.type;
  return type ? `${SURFACE_NAMES[type] ?? 'Curved'} face` : 'Face';
}

export function describe(model: ModelRuntime, pick: Pick): { title: string; rows: MeasureRow[] } {
  if (pick.kind === 'component') {
    const node = model.tree[pick.node];
    const box = model.bounds(false, pick.node);
    const size = box.getSize(new THREE.Vector3());
    return { title: node?.name ?? 'Component', rows: [
      { label: 'Extents', value: `${lengthNum(size.x, units())} × ${lengthNum(size.y, units())} × ${lengthNum(size.z, units())} ${units()}`, emphasis: true },
    ] };
  }
  const topology = model.topologyFor(pick.mesh);
  if (pick.kind === 'vertex') {
    const p = worldPoints(model, pick)[0];
    return { title: 'Vertex', rows: p ? [
      { label: 'X', value: len(p.x) }, { label: 'Y', value: len(p.y) }, { label: 'Z', value: len(p.z) },
    ] : [] };
  }
  if (pick.kind === 'edge') {
    const edge = topology?.edges[pick.index];
    if (!edge) return { title: 'Edge', rows: [] };
    const rows: MeasureRow[] = [{ label: 'Length', value: len(edge.length), emphasis: true }];
    if (edge.radius !== undefined) rows.push({ label: 'Radius', value: len(edge.radius) }, { label: 'Diameter', value: len(edge.radius * 2) });
    const analytic = analyticOf(model, pick);
    if (analytic.kind === 'circle') rows.push({ label: 'Center', value: pos(analytic.center) });
    if (edge.smooth) rows.push({ label: 'Continuity', value: 'Tangent' });
    const semantics = analyze(model, pick, units());
    if (semantics.pattern) rows.push({ label: 'Pattern', value: `${semantics.pattern.index + 1} of ${semantics.pattern.count}` });
    return { title: semantics.headline || `${titleCase(edge.type)} edge`, rows };
  }
  const face = topology?.faces[pick.index];
  if (!face) {
    const mesh = model.faceMesh(pick.node, pick.mesh, pick.index);
    return { title: 'Face', rows: mesh ? [{ label: 'Area', value: `≈ ${area(meshArea(mesh))}`, emphasis: true, title: APPROXIMATE }] : [] };
  }
  const rows: MeasureRow[] = [{ label: 'Area', value: area(face.area), emphasis: true }];
  const analytic = analyticOf(model, pick);
  switch (analytic.kind) {
    case 'plane':
      rows.push({ label: 'Normal', value: vec(analytic.normal) });
      break;
    case 'cylinder':
      rows.push({ label: 'Radius', value: len(analytic.radius) }, { label: 'Diameter', value: len(analytic.radius * 2) }, { label: 'Axis', value: vec(analytic.axis) },
        { label: 'Axis through', value: pos(analytic.point) });
      break;
    case 'cone': {
      const apex = coneApex(analytic);
      rows.push({ label: 'Half angle', value: deg(Math.abs(analytic.halfAngle)) }, { label: 'Axis', value: vec(analytic.axis) }, { label: 'Apex', value: pos(apex) });
      break;
    }
    case 'sphere':
      rows.push({ label: 'Radius', value: len(analytic.radius) }, { label: 'Diameter', value: len(analytic.radius * 2) }, { label: 'Center', value: pos(analytic.center) });
      break;
    case 'torus':
      rows.push({ label: 'Major radius', value: len(analytic.radius) }, { label: 'Minor radius', value: len(analytic.minorRadius) }, { label: 'Axis', value: vec(analytic.axis) },
        { label: 'Center', value: pos(analytic.center) });
      break;
    default:
      break;
  }
  const semantics = analyze(model, pick, units());
  const span = semantics.geometry.length_along_axis_mm;
  if (typeof span === 'number' && (analytic.kind === 'cylinder' || analytic.kind === 'cone')) rows.push({ label: 'Length along axis', value: `≈ ${len(span)}`, title: APPROXIMATE });
  if (semantics.pattern) rows.push({ label: 'Pattern', value: `${semantics.pattern.index + 1} of ${semantics.pattern.count}` });
  return { title: semantics.headline || `${SURFACE_NAMES[face.type] ?? titleCase(face.type)} face`, rows };
}

export function measure(model: ModelRuntime, picks: Pick[]): Measurement | null {
  if (!picks.length) return null;
  if (picks.length === 1) {
    const { title, rows } = describe(model, picks[0]);
    const points = picks[0].kind === 'vertex' ? worldPoints(model, picks[0]) : [];
    const analytic = analyticOf(model, picks[0]);
    if ((analytic.kind === 'circle' || analytic.kind === 'sphere' || analytic.kind === 'torus')) points.push(v3(analytic.center));
    if (analytic.kind === 'cone') points.push(v3(coneApex(analytic)));
    return { title, rows, lines: [], points };
  }
  const [a, b] = picks;
  const A = analyticOf(model, a), B = analyticOf(model, b);
  const rows: MeasureRow[] = [];
  const lines: MeasureLine[] = [];

  // Exact relations from the B-rep: axes, centres, planes.
  for (const relation of relations(A, B)) {
    const value = relation.unit === 'deg' ? `${num(relation.value, 2)}°` : len(relation.value);
    rows.push({ label: relation.label, value: relation.note ? `${value} (${relation.note})` : value, emphasis: !rows.length });
    if (relation.from && relation.to && relation.unit === 'mm' && relation.value > 1e-6) lines.push({ a: v3(relation.from), b: v3(relation.to), label: len(relation.value) });
  }

  // Coplanar circles have an exact gap; the tessellated estimate below would be off by the chord error.
  if (A.kind === 'circle' && B.kind === 'circle'
    && Math.abs(Math.abs(v3(A.axis).dot(v3(B.axis))) - 1) < 1e-6 && Math.abs(v3(A.axis).dot(v3(B.center).sub(v3(A.center)))) < 1e-6) {
    const gap = Math.max(0, v3(A.center).distanceTo(v3(B.center)) - A.radius - B.radius);
    rows.unshift({ label: 'Edge gap', value: len(gap) });
    return { title: 'Circle edge to circle edge', rows, lines, points: [] };
  }

  const closest = minimumDistance(shapeOf(model, a, A), shapeOf(model, b, B));
  if (closest) {
    const { exact, distance } = closest;
    const primary = !rows.some((row) => row.emphasis);
    rows.unshift({ label: 'Minimum distance', value: exact ? len(distance) : `≈ ${len(distance)}`, emphasis: primary, title: exact ? undefined : APPROXIMATE });
    if (a.kind === 'vertex' && b.kind === 'vertex') {
      const delta = v3(closest.b).sub(v3(closest.a));
      rows.push({ label: 'ΔX', value: len(Math.abs(delta.x)) }, { label: 'ΔY', value: len(Math.abs(delta.y)) }, { label: 'ΔZ', value: len(Math.abs(delta.z)) });
    }
    if (!lines.length && distance > 1e-6) lines.push({ a: v3(closest.a), b: v3(closest.b), label: exact ? len(distance) : `≈ ${len(distance)}` });
  }
  const titles = picks.map((pick) => describe(model, pick).title.toLowerCase());
  return { title: `${capital(titles[0])} to ${titles[1]}`, rows, lines, points: [] };
}

/** A pick's exact geometry from the build's B-rep description (topology.json), in world coordinates. */
export function analyticOf(model: ModelRuntime, pick: Pick): Surface {
  if (pick.kind === 'component') return { kind: 'other', curved: true };
  const frame = model.frameFor(pick.node, pick.mesh);
  const topology = model.topologyFor(pick.mesh);
  if (!frame || !topology) return { kind: 'other', curved: true };
  frame.updateWorldMatrix(true, false);
  const matrix = frame.matrixWorld;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  // Placements are rigid (rotation and translation), so lengths and radii carry over unchanged.
  const point = (p: number[]): Vec => tuple(new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(matrix));
  const direction = (d: number[]): Vec => tuple(new THREE.Vector3(d[0], d[1], d[2]).applyMatrix3(normalMatrix).normalize());
  if (pick.kind === 'vertex') {
    const vertex = topology.vertices[pick.index];
    return vertex ? { kind: 'point', point: point(vertex) } : { kind: 'other', curved: false };
  }
  if (pick.kind === 'edge') {
    const edge = topology.edges[pick.index];
    if (!edge) return { kind: 'other', curved: true };
    if (edge.type === 'circle' && edge.center && edge.normal && edge.radius !== undefined) return { kind: 'circle', center: point(edge.center), axis: direction(edge.normal), radius: edge.radius };
    if (edge.type === 'line' && edge.points.length >= 6) {
      const p0 = point(edge.points.slice(0, 3)), p1 = point(edge.points.slice(-3));
      return { kind: 'line', point: p0, axis: tuple(v3(p1).sub(v3(p0)).normalize()) };
    }
    return { kind: 'other', curved: true };
  }
  const face = topology.faces[pick.index];
  if (!face) return { kind: 'other', curved: true };
  const { origin, axis, normal, radius } = face;
  if (face.type === 'plane' && origin && normal) return { kind: 'plane', point: point(origin), normal: direction(normal) };
  if (face.type === 'cylinder' && origin && axis && radius !== undefined) return { kind: 'cylinder', point: point(origin), axis: direction(axis), radius };
  if (face.type === 'cone' && origin && axis && radius !== undefined && face.half_angle) return { kind: 'cone', point: point(origin), axis: direction(axis), radius, halfAngle: face.half_angle };
  if (face.type === 'sphere' && origin && radius !== undefined) return { kind: 'sphere', center: point(origin), radius };
  if (face.type === 'torus' && origin && axis && radius !== undefined && face.minor_radius !== undefined) return { kind: 'torus', center: point(origin), axis: direction(axis), radius, minorRadius: face.minor_radius };
  return { kind: 'other', curved: face.type !== 'plane' };
}

/** A pick's displayed geometry for the minimum distance: a face's triangles, an edge's polyline, a vertex. Exact when
 * the display is the geometry: a flat face bounded by straight edges, a straight edge, a vertex. */
function shapeOf(model: ModelRuntime, pick: Pick, analytic: Surface): Shape {
  if (pick.kind === 'vertex' || pick.kind === 'edge') {
    const points = worldPoints(model, pick).map(tuple);
    return { points, segments: points.slice(1).map((_, i) => [i, i + 1] as [number, number]), exact: meshIsExact(analytic) };
  }
  const meshes: THREE.Mesh[] = [];
  if (pick.kind === 'face') {
    const mesh = model.faceMesh(pick.node, pick.mesh, pick.index);
    if (mesh) meshes.push(mesh);
  } else model.objects.get(pick.node)?.traverse((object) => { if (object instanceof THREE.Mesh && object.userData.face && !object.userData.lazyFace) meshes.push(object); });
  const points: Vec[] = [];
  const triangles: [number, number, number][] = [];
  const p = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const base = points.length;
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    // A face made from a merged body (model.ts lazyFace) draws a range of the body's triangles.
    const start = mesh.geometry.drawRange.start, count = Math.min(mesh.geometry.drawRange.count, index ? index.count : position.count);
    for (let i = 0; i < position.count; i++) points.push(tuple(p.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld)));
    for (let i = start; i + 2 < start + count; i += 3) {
      const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
      triangles.push([base + ia, base + ib, base + ic]);
    }
  }
  const topology = pick.kind === 'face' ? model.topologyFor(pick.mesh) : undefined;
  const face = pick.kind === 'face' ? topology?.faces[pick.index] : undefined;
  const straight = !!face?.edges?.length && face.edges.every((edge) => topology?.edges[edge]?.type === 'line');
  return { points, triangles, exact: analytic.kind === 'plane' && straight };
}

export function worldPoints(model: ModelRuntime, pick: Pick): THREE.Vector3[] {
  if (pick.kind === 'edge') return model.worldEdgePoints(pick);
  if (pick.kind === 'vertex') {
    const frame = model.frameFor(pick.node, pick.mesh);
    const vertex = model.topologyFor(pick.mesh)?.vertices[pick.index];
    return frame && vertex ? [new THREE.Vector3(...vertex).applyMatrix4(frame.matrixWorld)] : [];
  }
  const meshes: THREE.Mesh[] = [];
  if (pick.kind === 'face') {
    const mesh = model.faceMesh(pick.node, pick.mesh, pick.index);
    if (mesh) meshes.push(mesh);
  } else model.objects.get(pick.node)?.traverse((object) => { if (object instanceof THREE.Mesh && object.userData.face && !object.userData.lazyFace) meshes.push(object); });
  const points: THREE.Vector3[] = [];
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  }
  return points;
}

function meshArea(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let area = 0;
  const count = index ? index.count : position.count;
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, ia); b.fromBufferAttribute(position, ib); c.fromBufferAttribute(position, ic);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area;
}

/** A direction (unitless). */
const vec = (v: Vec) => `${num(v[0], 3)}, ${num(v[1], 3)}, ${num(v[2], 3)}`;
/** A point, in display units. */
const pos = (v: Vec) => `${lengthNum(v[0], units(), 3)}, ${lengthNum(v[1], units(), 3)}, ${lengthNum(v[2], units(), 3)}`;
const titleCase = (value: string) => value.replace(/(^|[-_ ])(\w)/g, (_, space: string, letter: string) => `${space ? ' ' : ''}${letter.toUpperCase()}`);
const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

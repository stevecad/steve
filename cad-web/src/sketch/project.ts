/**
 * Projection into the open sketch: model edges, face outlines, vertices and other sketches' curves,
 * projected orthographically onto the sketch plane as fixed geometry. The same rules as the runtime
 * (runtime/steve/sketch.py `_project`), so what the browser shows is what the build makes; reopened
 * sketches use the build's own resolution (metadata.modeling.sketches[id].projections).
 */
import * as THREE from 'three';
import type { Pick } from '@/state/store';
import type { ModelDoc, ModelFeature } from '@/lib/modeling';
import type { TopologyEdge } from '@/lib/api';
import { viewer } from '@/viewport/viewer';
import { sample } from './geometry';
import type { Entity, XY } from './model';
import type { SketchPlane } from './session';

/** An entity before it gets its id. */
export type Shape = Entity extends infer E ? (E extends Entity ? Omit<E, 'id'> : never) : never;
type Curve = { kind: 'line'; a: THREE.Vector3; b: THREE.Vector3 }
  | { kind: 'circle'; center: THREE.Vector3; normal: THREE.Vector3; radius: number; a: THREE.Vector3; b: THREE.Vector3; mid: THREE.Vector3; closed: boolean }
  | { kind: 'polyline'; points: THREE.Vector3[] }
  | { kind: 'point'; at: THREE.Vector3 };

const local = (plane: SketchPlane, p: THREE.Vector3): XY => { const d = p.clone().sub(plane.origin); return [d.dot(plane.x), d.dot(plane.y)]; };
const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

/** One 3D curve (or point) → sketch entities on `plane`. */
export function projectCurve(curve: Curve, plane: SketchPlane): Shape[] {
  if (curve.kind === 'point') return [{ type: 'point', at: local(plane, curve.at) }];
  if (curve.kind === 'line') {
    const a = local(plane, curve.a), b = local(plane, curve.b);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9 ? [{ type: 'point', at: a }] : [{ type: 'line', start: a, end: b }];
  }
  if (curve.kind === 'circle') {
    const c = local(plane, curve.center), r = curve.radius, cos = curve.normal.dot(plane.normal);
    const a = local(plane, curve.a), b = local(plane, curve.b);
    if (Math.abs(Math.abs(cos) - 1) < 1e-9) {
      if (curve.closed) return [{ type: 'circle', center: c, radius: r }];
      let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      // Counter-clockwise from start to end through the edge's midpoint: which end comes first depends on how the
      // edge is oriented, not on the circle's normal.
      const m = local(plane, curve.mid);
      if (norm(Math.atan2(m[1] - c[1], m[0] - c[0]) - a0) > norm(a1 - a0)) [a0, a1] = [a1, a0];
      return [{ type: 'arc', center: c, radius: r, start_angle: a0, end_angle: a1 }];
    }
    if (Math.abs(cos) > 1e-9) {
      const major3 = curve.normal.clone().cross(plane.normal).normalize();
      const major = local(plane, curve.center.clone().add(major3));
      const rotation = Math.atan2(major[1] - c[1], major[0] - c[0]);
      const minor = r * Math.abs(cos);
      if (curve.closed) return [{ type: 'ellipse', center: c, major_radius: r, minor_radius: minor, rotation }];
      const param = (p: XY) => Math.atan2(((p[0] - c[0]) * -Math.sin(rotation) + (p[1] - c[1]) * Math.cos(rotation)) / minor, ((p[0] - c[0]) * Math.cos(rotation) + (p[1] - c[1]) * Math.sin(rotation)) / r);
      let t0 = param(a), t1 = param(b);
      if (norm(param(local(plane, curve.mid)) - t0) > norm(t1 - t0)) [t0, t1] = [t1, t0];
      return [{ type: 'elliptical_arc', center: c, major_radius: r, minor_radius: minor, rotation, start_angle: t0, end_angle: t1 }];
    }
    // Edge-on: fall through to a polyline of the circle's points.
    const u = new THREE.Vector3().subVectors(curve.a, curve.center).normalize(), v = curve.normal.clone().cross(u);
    const sweep = curve.closed ? 2 * Math.PI : norm(Math.atan2(new THREE.Vector3().subVectors(curve.b, curve.center).dot(v), new THREE.Vector3().subVectors(curve.b, curve.center).dot(u)));
    const points = Array.from({ length: 65 }, (_, i) => curve.center.clone().addScaledVector(u, r * Math.cos((sweep * i) / 64)).addScaledVector(v, r * Math.sin((sweep * i) / 64)));
    return projectCurve({ kind: 'polyline', points }, plane);
  }
  const pts = curve.points.map((p) => local(plane, p));
  const span = Math.max(...pts.map((p) => Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1])));
  return span < 1e-9 ? [{ type: 'point', at: pts[0] }] : [{ type: 'bspline', poles: pts, degree: 1, periodic: false }];
}

/** Entities for projection `id`: one keeps the id, several are `id.0`, `id.1`, … (as the runtime names them). */
export function withIds(id: string, shapes: Shape[], construction: boolean): Entity[] {
  return shapes.map((shape, i) => ({ ...shape, id: shapes.length === 1 ? id : `${id}.${i}`, construction: construction || shape.type === 'point', external: true }) as Entity);
}

/* ───────── what was picked ───────── */

function edgeCurve(pick: Pick & { kind: 'edge' }, edge: TopologyEdge): Curve | null {
  const model = viewer.model!;
  const frame = model.frameFor(pick.node, pick.mesh);
  if (!frame) return null;
  const m = frame.matrixWorld;
  const points = model.worldEdgePoints(pick);
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  if (edge.type === 'line') return { kind: 'line', a, b };
  if (edge.type === 'circle' && edge.center && edge.normal && edge.radius) {
    const center = new THREE.Vector3(...edge.center).applyMatrix4(m);
    const normal = new THREE.Vector3(...edge.normal).transformDirection(m);
    const closed = a.distanceTo(b) < 1e-6 && edge.length > edge.radius;
    return { kind: 'circle', center, normal, radius: edge.radius, a, b, mid: points[Math.floor(points.length / 2)], closed };
  }
  return { kind: 'polyline', points };
}

/** 3D curves behind a viewport pick: an edge, a face's outline (seams left out), or a vertex. */
export function pickCurves(pick: Pick): Curve[] {
  const model = viewer.model;
  if (!model || pick.kind === 'component') return [];
  const topology = model.topologyFor(pick.mesh);
  if (!topology) return [];
  if (pick.kind === 'edge') {
    const edge = topology.edges[pick.index];
    const curve = edge && edgeCurve(pick as Pick & { kind: 'edge' }, edge);
    return curve ? [curve] : [];
  }
  if (pick.kind === 'vertex') {
    const v = topology.vertices[pick.index];
    const frame = model.frameFor(pick.node, pick.mesh);
    return v && frame ? [{ kind: 'point', at: new THREE.Vector3(...v).applyMatrix4(frame.matrixWorld) }] : [];
  }
  const face = topology.faces[pick.index];
  return (face?.edges ?? []).flatMap((index) => {
    const edge = topology.edges[index];
    if (!edge || edge.seam) return [];
    const curve = edgeCurve({ kind: 'edge', node: pick.node, mesh: pick.mesh, index } as Pick & { kind: 'edge' }, edge);
    return curve ? [curve] : [];
  });
}

/** Curves of another sketch's entity, in 3D (lines and circles exact; everything else sampled). */
export function sketchCurves(entities: Entity[], plane: SketchPlane): Curve[] {
  const world = ([u, v]: XY) => plane.origin.clone().addScaledVector(plane.x, u).addScaledVector(plane.y, v);
  return entities.flatMap((e): Curve[] => {
    switch (e.type) {
      case 'point': return [{ kind: 'point', at: world(e.at) }];
      case 'line': return [{ kind: 'line', a: world(e.start), b: world(e.end) }];
      case 'circle': { const a = world([e.center[0] + e.radius, e.center[1]]); return [{ kind: 'circle', center: world(e.center), normal: plane.normal.clone(), radius: e.radius, a, b: a, mid: world([e.center[0] - e.radius, e.center[1]]), closed: true }]; }
      case 'arc': {
        const at = (t: number) => world([e.center[0] + e.radius * Math.cos(t), e.center[1] + e.radius * Math.sin(t)]);
        const end = e.end_angle <= e.start_angle ? e.end_angle + 2 * Math.PI : e.end_angle;
        return [{ kind: 'circle', center: world(e.center), normal: plane.normal.clone(), radius: e.radius, a: at(e.start_angle), b: at(end), mid: at((e.start_angle + end) / 2), closed: false }];
      }
      case 'projection': return [];
      default: return [{ kind: 'polyline', points: sample(e, 64).map(world) }];
    }
  });
}

/** Feature ids a reference names (`edge(extrude_1.end|fillet_2.face(…))` → extrude_1, fillet_2). */
export function referencedFeatures(ref: string, doc: ModelDoc): string[] {
  return doc.features.map((f) => f.id).filter((id): id is string => !!id && new RegExp(`(^|[^\\w])${id}(\\.|$|[^\\w])`).test(ref));
}

/** A projection can only use geometry that exists at the sketch's place in history. */
export function laterThan(ref: string, sketchId: string, doc: ModelDoc): string | null {
  const order = doc.features.map((f) => f.id);
  const at = order.indexOf(sketchId);
  if (at < 0) return null;  // A new sketch goes at the end: everything is earlier.
  return referencedFeatures(ref, doc).find((id) => order.indexOf(id) >= at) ?? null;
}

/** The displayed geometry carrying a reference name: a face, an edge or a vertex. */
function pickForAnyRef(ref: string): Pick | null {
  const model = viewer.model;
  if (!model) return null;
  const seen = new Set<string>();
  for (const mesh of model.faces) {
    const info = mesh.userData.face as { node: string; meshIndex: number };
    const key = `${info.node}:${info.meshIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const topology = model.topologyFor(info.meshIndex) as unknown as { faces?: { ref?: string }[]; edges?: { ref?: string }[]; vertex_refs?: string[] } | undefined;
    const face = topology?.faces?.findIndex((f) => f.ref === ref) ?? -1;
    if (face >= 0) return { kind: 'face', node: info.node, mesh: info.meshIndex, index: face };
    const edge = topology?.edges?.findIndex((e) => e.ref === ref) ?? -1;
    if (edge >= 0) return { kind: 'edge', node: info.node, mesh: info.meshIndex, index: edge };
    const vertex = topology?.vertex_refs?.indexOf(ref) ?? -1;
    if (vertex >= 0) return { kind: 'vertex', node: info.node, mesh: info.meshIndex, index: vertex };
  }
  return null;
}

/** A projection's shapes from its reference alone (code STEVE wrote, or a sketch reopened without build data). */
export function resolveRef(ref: string, plane: SketchPlane, doc: ModelDoc, planeOf: (feature: ModelFeature) => SketchPlane | null): Shape[] | null {
  const [head, ...rest] = ref.split('.');
  const feature = doc.features.find((f) => f.kind === 'sketch' && f.id === head);
  if (feature?.document && !/^(edge|vertex|select)\(/.test(ref)) {
    const other = planeOf(feature);
    if (!other) return null;
    const entities = feature.document.entities as unknown as Entity[];
    const name = rest.join('.');
    const chosen = name ? entities.filter((e) => e.id === name) : entities.filter((e) => !e.construction && e.type !== 'point' && e.type !== 'projection');
    return sketchCurves(chosen, other).flatMap((c) => projectCurve(c, plane));
  }
  const pick = pickForAnyRef(ref);
  return pick ? pickCurves(pick).flatMap((c) => projectCurve(c, plane)) : null;
}

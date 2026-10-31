import * as THREE from 'three';
import type { ModelRuntime } from './model';
import type { TopologyFace, TopologyMesh } from '@/lib/api';
import type { EntityPick, Pick } from '@/state/store';
import { lengthNum, type Units } from '@/lib/format';

/**
 * Turns a raw B-rep pick into engineering vocabulary ("Ø6.6 mm hole, one of 4") shared by
 * the hover readout, the Inspector and the context STEVE receives. All positions are in the
 * document frame (mm, Z-up) unless labelled as the part's own frame.
 */
export interface Semantics {
  kind: Pick['kind'];
  /** Short noun: "Hole", "Counterbore", "Fillet", "Planar face", "Circular edge"… */
  name: string;
  /** Name plus key size, e.g. "Hole Ø6.6 mm", in the units asked for (the person's display units). */
  headline: string;
  /** One or two sentences a person or an AI can use to find the feature in the source: always mm, like the code. */
  description: string;
  geometry: Record<string, unknown>;
  pattern?: { count: number; index: number; positions: number[][] };
}

const EPS = 1e-3;
const r3 = (value: number) => Math.round(value * 1000) / 1000;
const fmt = (value: number) => `${r3(value)}`.replace(/^-0$/, '0');
const point = (v: THREE.Vector3) => [r3(v.x), r3(v.y), r3(v.z)];
/** A headline's size: mm as the description writes it, or inches. */
const sizeIn = (units: Units) => (value: number) => (units === 'in' ? `${lengthNum(value, 'in')} in` : `${fmt(value)} mm`);
const pointText = (v: THREE.Vector3 | number[]) => {
  const [x, y, z] = Array.isArray(v) ? v : [v.x, v.y, v.z];
  return `(${fmt(x)}, ${fmt(y)}, ${fmt(z)})`;
};

function axisLabel(v: THREE.Vector3): string {
  const names = ['X', 'Y', 'Z'];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(Math.abs(v.getComponent(i)) - 1) < 1e-4) return `${v.getComponent(i) > 0 ? '+' : '−'}${names[i]}`;
  }
  return `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;
}

/** Position along an axis-aligned axis, e.g. "through (45, 25)" for a Z axis. */
function axisPlacement(axis: THREE.Vector3, p: THREE.Vector3): string {
  const a = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)];
  if (a[2] > 0.9999) return `through (x ${fmt(p.x)}, y ${fmt(p.y)})`;
  if (a[1] > 0.9999) return `through (x ${fmt(p.x)}, z ${fmt(p.z)})`;
  if (a[0] > 0.9999) return `through (y ${fmt(p.y)}, z ${fmt(p.z)})`;
  return `through ${pointText(p)}`;
}

interface Frame { matrix: THREE.Matrix4; normalMatrix: THREE.Matrix3; identity: boolean }

function frameOf(model: ModelRuntime, pick: EntityPick): Frame | null {
  const object = model.frameFor(pick.node, pick.mesh);
  if (!object) return null;
  object.updateWorldMatrix(true, false);
  const matrix = object.matrixWorld.clone();
  return { matrix, normalMatrix: new THREE.Matrix3().getNormalMatrix(matrix), identity: matrix.equals(new THREE.Matrix4()) };
}

const toWorld = (frame: Frame, p: number[] | THREE.Vector3) => (Array.isArray(p) ? new THREE.Vector3(p[0], p[1], p[2]) : p.clone()).applyMatrix4(frame.matrix);
const dirWorld = (frame: Frame, d: number[]) => new THREE.Vector3(d[0], d[1], d[2]).applyMatrix3(frame.normalMatrix).normalize();

/** Is a cylindrical/conical face concave (a hole) or convex (a boss), and how much of the circle does it cover? */
function revolveSense(model: ModelRuntime, pick: EntityPick, faceIndices: number[], axis: THREE.Vector3, origin: THREE.Vector3) {
  let inward = 0, outward = 0;
  const angles: number[] = [];
  let tMin = Infinity, tMax = -Infinity;
  const u = new THREE.Vector3(), w = new THREE.Vector3();
  const helper = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  u.crossVectors(axis, helper).normalize();
  w.crossVectors(axis, u);
  const v = new THREE.Vector3(), n = new THREE.Vector3(), radial = new THREE.Vector3();
  for (const index of faceIndices) {
    const mesh = model.faceMesh(pick.node, pick.mesh, index);
    if (!mesh) continue;
    const positions = mesh.geometry.getAttribute('position');
    const normals = mesh.geometry.getAttribute('normal');
    const step = Math.max(1, Math.floor(positions.count / 96));
    for (let i = 0; i < positions.count; i += step) {
      v.fromBufferAttribute(positions, i);
      radial.copy(v).sub(origin);
      const t = radial.dot(axis);
      tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
      radial.addScaledVector(axis, -t);
      if (normals) {
        n.fromBufferAttribute(normals, i);
        if (n.dot(radial) < 0) inward++; else outward++;
      }
      angles.push(Math.atan2(radial.dot(w), radial.dot(u)));
    }
  }
  angles.sort((a, b) => a - b);
  let gap = angles.length ? angles[0] + Math.PI * 2 - angles[angles.length - 1] : Math.PI * 2;
  for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
  const coverage = THREE.MathUtils.radToDeg(Math.PI * 2 - gap);
  return { concave: inward > outward, full: coverage > 330, coverage, span: [tMin, tMax] as [number, number] };
}

const coaxial = (a: TopologyFace, b: TopologyFace) => {
  if (!a.axis || !b.axis || !a.origin || !b.origin) return false;
  const axisA = new THREE.Vector3(...a.axis), axisB = new THREE.Vector3(...b.axis);
  if (Math.abs(Math.abs(axisA.dot(axisB)) - 1) > 1e-6) return false;
  const delta = new THREE.Vector3(...b.origin).sub(new THREE.Vector3(...a.origin));
  return delta.sub(axisA.clone().multiplyScalar(delta.dot(axisA))).length() < EPS;
};

const sameSize = (a: TopologyFace, b: TopologyFace) => a.type === b.type && Math.abs((a.radius ?? 0) - (b.radius ?? 0)) < EPS
  && Math.abs((a.half_angle ?? 0) - (b.half_angle ?? 0)) < 1e-6;

function describeFace(model: ModelRuntime, pick: EntityPick, topology: TopologyMesh, owner: string, units: Units = 'mm'): Semantics {
  const shown = sizeIn(units);
  const face = topology.faces[pick.index];
  const frame = frameOf(model, pick);
  if (!face || !frame) return { kind: 'face', name: 'Face', headline: 'Face', description: `A face of ${owner}.`, geometry: {} };
  const area = r3(face.area);
  const geometry: Record<string, unknown> = { surface: face.type, area_mm2: area };
  const where = frame.identity ? '' : ' (document frame)';

  if (face.type === 'plane' && face.normal && face.origin) {
    const normal = dirWorld(frame, face.normal);
    const origin = toWorld(frame, face.origin);
    const label = axisLabel(normal);
    const axisIndex = [Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)].findIndex((c) => c > 0.9999);
    const level = axisIndex >= 0 ? ` at ${'xyz'[axisIndex]} = ${fmt(origin.getComponent(axisIndex))} mm` : '';
    const facing = label === '+Z' ? 'Top-facing' : label === '−Z' ? 'Bottom-facing' : `${label}-facing`;
    const mesh = model.faceMesh(pick.node, pick.mesh, pick.index);
    const size = mesh ? new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()) : null;
    const extents = size ? [size.x, size.y, size.z].filter((_, i) => i !== axisIndex || axisIndex < 0).map(fmt).join(' × ') : '';
    Object.assign(geometry, { normal: point(normal), point_on_plane: point(origin), extents_mm: size ? point(size) : undefined });
    return {
      kind: 'face', name: 'Planar face', headline: `${facing} planar face`,
      description: `${facing} planar face${level}${where}, normal ${label}, area ${area} mm²${extents ? `, about ${extents} mm` : ''}, on ${owner}.`,
      geometry,
    };
  }

  if ((face.type === 'cylinder' || face.type === 'cone') && face.axis && face.origin && face.radius !== undefined) {
    const axisLocal = new THREE.Vector3(...face.axis).normalize();
    const originLocal = new THREE.Vector3(...face.origin);
    // Split periodic faces share one axis; treat them as one feature.
    const group = topology.faces.map((other, index) => ({ other, index })).filter(({ other }) => sameSize(other, face) && coaxial(other, face)).map(({ index }) => index);
    const sense = revolveSense(model, pick, group, axisLocal, originLocal);
    const diameter = r3(face.radius * 2);
    // Coaxial concave cylinders of another size make a stepped hole: counterbore above, hole below.
    const concaveCoaxial = (predicate: (radius: number) => boolean) => topology.faces.some((other, index) =>
      other.type === 'cylinder' && other.radius !== undefined && predicate(other.radius) && coaxial(other, face)
      && revolveSense(model, pick, [index], new THREE.Vector3(...other.axis!).normalize(), new THREE.Vector3(...other.origin!)).concave);
    const larger = sense.concave && concaveCoaxial((radius) => radius > face.radius! + EPS);
    const smaller = sense.concave && concaveCoaxial((radius) => radius < face.radius! - EPS);
    let name: string;
    if (face.type === 'cylinder') {
      if (sense.concave) name = sense.full ? (smaller && !larger ? 'Counterbore' : larger ? 'Counterbored hole' : 'Hole') : 'Concave fillet';
      else name = sense.full ? 'Cylindrical boss' : 'Fillet';
    } else name = sense.concave ? (sense.full ? 'Countersink' : 'Concave chamfer') : sense.full ? 'Conical boss' : 'Chamfer';

    const axisWorld = dirWorld(frame, face.axis);
    const start = toWorld(frame, originLocal.clone().addScaledVector(axisLocal, sense.span[0]));
    const end = toWorld(frame, originLocal.clone().addScaledVector(axisLocal, sense.span[1]));
    const length = r3(sense.span[1] - sense.span[0]);
    const center = start.clone().lerp(end, 0.5);

    // Identical features elsewhere on the body: same size and sense, different axis line.
    const siblings: { line: number; start: THREE.Vector3 }[] = [];
    const seen: TopologyFace[] = [];
    topology.faces.forEach((other, index) => {
      if (!sameSize(other, face) || !other.axis || !other.origin || seen.some((s) => coaxial(s, other))) return;
      const otherGroup = topology.faces.map((o, i) => ({ o, i })).filter(({ o }) => sameSize(o, other) && coaxial(o, other)).map(({ i }) => i);
      const otherSense = revolveSense(model, pick, otherGroup, new THREE.Vector3(...other.axis).normalize(), new THREE.Vector3(...other.origin));
      if (otherSense.concave !== sense.concave || otherSense.full !== sense.full || Math.abs((otherSense.span[1] - otherSense.span[0]) - length) > 0.01) return;
      seen.push(other);
      const axis = new THREE.Vector3(...other.axis).normalize();
      siblings.push({ line: index, start: toWorld(frame, new THREE.Vector3(...other.origin).addScaledVector(axis, otherSense.span[0])) });
    });
    const selfIndex = siblings.findIndex(({ line }) => group.includes(line));

    const size = face.type === 'cylinder' ? `Ø${fmt(diameter)} mm` : `Ø${fmt(diameter)} mm at its reference end, half-angle ${fmt(THREE.MathUtils.radToDeg(face.half_angle ?? 0))}°`;
    Object.assign(geometry, {
      feature: name.toLowerCase(), diameter_mm: diameter, radius_mm: r3(face.radius), axis: point(axisWorld),
      axis_start: point(start), axis_end: point(end), length_along_axis_mm: length, center: point(center),
      concave: sense.concave, angular_coverage_deg: Math.round(sense.coverage),
      ...(face.half_angle !== undefined ? { half_angle_deg: r3(THREE.MathUtils.radToDeg(face.half_angle)) } : {}),
      ...(!frame.identity ? { part_frame: { axis: point(axisLocal), point_on_axis: point(originLocal) } } : {}),
    });
    const pattern = siblings.length > 1 ? { count: siblings.length, index: Math.max(selfIndex, 0), positions: siblings.map(({ start: s }) => point(s)) } : undefined;
    const round = name === 'Fillet' || name === 'Concave fillet' || name === 'Chamfer' || name === 'Concave chamfer';
    let text = `${name} ${size}${round ? ` (radius ${fmt(face.radius)} mm, ${Math.round(sense.coverage)}° of arc)` : ''}, axis ${axisLabel(axisWorld)} ${axisPlacement(axisWorld, start)}${where}, spanning ${pointText(start)} → ${pointText(end)} (${length} mm long), area ${area} mm², on ${owner}.`;
    if (name === 'Counterbored hole') text += ' A larger coaxial counterbore sits above it.';
    if (pattern) text += ` It is ${pattern.index + 1} of ${pattern.count} identical ${name.toLowerCase()}s, which start at ${pattern.positions.map(pointText).join(', ')}.`;
    else if (!round) text += ` It is the only ${name.toLowerCase()} of this size on ${owner}.`;
    return { kind: 'face', name, headline: `${name} Ø${shown(diameter)}`, description: text, geometry, pattern };
  }

  if (face.type === 'torus' && face.radius !== undefined) {
    Object.assign(geometry, { major_radius_mm: r3(face.radius), minor_radius_mm: r3(face.minor_radius ?? 0) });
    return { kind: 'face', name: 'Fillet', headline: `Fillet R${shown(face.minor_radius ?? 0)}`, description: `Toroidal fillet face, minor radius ${fmt(face.minor_radius ?? 0)} mm around a Ø${fmt(face.radius * 2)} mm circle, area ${area} mm², on ${owner}.`, geometry };
  }
  if (face.type === 'sphere' && face.radius !== undefined && face.origin) {
    const center = toWorld(frame, face.origin);
    Object.assign(geometry, { radius_mm: r3(face.radius), center: point(center) });
    return { kind: 'face', name: 'Spherical face', headline: `Spherical face R${shown(face.radius)}`, description: `Spherical face, radius ${fmt(face.radius)} mm centered at ${pointText(center)}, area ${area} mm², on ${owner}.`, geometry };
  }
  const label = face.type === 'bspline' || face.type === 'bezier' ? 'Freeform face' : `${face.type.charAt(0).toUpperCase()}${face.type.slice(1)} face`;
  return { kind: 'face', name: label, headline: label, description: `${label} (${face.type}), area ${area} mm², on ${owner}.`, geometry };
}

function describeEdge(model: ModelRuntime, pick: EntityPick, topology: TopologyMesh, owner: string, units: Units = 'mm'): Semantics {
  const shown = sizeIn(units);
  const edge = topology.edges[pick.index];
  const frame = frameOf(model, pick);
  if (!edge || !frame) return { kind: 'edge', name: 'Edge', headline: 'Edge', description: `An edge of ${owner}.`, geometry: {} };
  const adjacent = (edge.faces ?? []).map((index) => {
    const face = topology.faces[index];
    return face ? describeFace(model, { ...pick, kind: 'face', index }, topology, owner).headline.toLowerCase() : null;
  }).filter(Boolean);
  const between = adjacent.length ? ` It borders the ${adjacent.join(' and the ')}.` : '';
  const geometry: Record<string, unknown> = { curve: edge.type, length_mm: r3(edge.length), smooth: !!edge.smooth };
  if (edge.type === 'circle' && edge.center && edge.radius !== undefined) {
    const center = toWorld(frame, edge.center);
    const normal = edge.normal ? dirWorld(frame, edge.normal) : new THREE.Vector3(0, 0, 1);
    const similar = topology.edges.filter((other) => other.type === 'circle' && Math.abs((other.radius ?? 0) - edge.radius!) < EPS && other.normal && Math.abs(Math.abs(new THREE.Vector3(...other.normal).dot(new THREE.Vector3(...edge.normal!))) - 1) < 1e-6);
    const sameLevel = similar.filter((other) => Math.abs(new THREE.Vector3(...other.center!).sub(new THREE.Vector3(...edge.center!)).dot(new THREE.Vector3(...edge.normal!))) < EPS);
    Object.assign(geometry, { diameter_mm: r3(edge.radius * 2), radius_mm: r3(edge.radius), center: point(center), axis: point(normal) });
    const pattern = sameLevel.length > 1 ? { count: sameLevel.length, index: Math.max(sameLevel.indexOf(edge), 0), positions: sameLevel.map((other) => point(toWorld(frame, other.center!))) } : undefined;
    const arc = Math.abs(edge.length - Math.PI * 2 * edge.radius) > 0.01 ? `arc (${Math.round(THREE.MathUtils.radToDeg(edge.length / edge.radius))}°)` : 'circle';
    let text = `Circular edge, ${arc} Ø${fmt(edge.radius * 2)} mm centered at ${pointText(center)}, axis ${axisLabel(normal)}, on ${owner}.${between}`;
    if (pattern) text += ` One of ${pattern.count} identical circles in this plane, centered at ${pattern.positions.map(pointText).join(', ')}.`;
    return { kind: 'edge', name: 'Circular edge', headline: `Circular edge Ø${shown(edge.radius * 2)}`, description: text, geometry, pattern };
  }
  if (edge.type === 'line' && edge.points.length >= 6) {
    const a = toWorld(frame, edge.points.slice(0, 3)), b = toWorld(frame, edge.points.slice(-3));
    const direction = b.clone().sub(a).normalize();
    Object.assign(geometry, { start: point(a), end: point(b), direction: point(direction) });
    return { kind: 'edge', name: 'Linear edge', headline: `Linear edge ${shown(edge.length)}`, description: `Straight edge ${fmt(edge.length)} mm long from ${pointText(a)} to ${pointText(b)}, direction ${axisLabel(direction)}, on ${owner}.${between}`, geometry };
  }
  return { kind: 'edge', name: 'Edge', headline: `${edge.type} edge ${shown(edge.length)}`, description: `${edge.type} edge, ${fmt(edge.length)} mm long${edge.smooth ? ', tangent between its faces' : ''}, on ${owner}.${between}`, geometry };
}

/** Semantic description of any pick, falling back gracefully when the build has no topology. `units` sets the headline's
 *  (what a person reads); the description and geometry stay mm for STEVE. */
export function analyze(model: ModelRuntime, pick: Pick, units: Units = 'mm'): Semantics {
  const node = model.tree[pick.node];
  const owner = node ? (node.type === 'body' ? `${model.tree[model.rootId]?.name ?? 'the part'} (${node.name})` : `component “${node.name}”`) : 'the model';
  if (pick.kind === 'component') {
    const box = model.bounds(false, pick.node);
    const size = box.getSize(new THREE.Vector3());
    const object = model.objects.get(pick.node);
    const placement = object ? new THREE.Vector3().setFromMatrixPosition(object.matrixWorld) : new THREE.Vector3();
    const kind = node?.type === 'assembly' ? 'Subassembly' : node?.type === 'body' ? 'Body' : 'Component';
    return {
      kind: 'component', name: kind, headline: `${kind} ${node?.name ?? ''}`.trim(),
      description: `${kind} “${node?.name ?? pick.node}”${node?.documentId ? ` (references part document ${node.documentId})` : ''}, placed at ${pointText(placement)}, bounding box ${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm from ${pointText(box.min)} to ${pointText(box.max)}.`,
      geometry: { placement: point(placement), bounds_min: point(box.min), bounds_max: point(box.max), size_mm: point(size), part_document_id: node?.documentId ?? null },
    };
  }
  const topology = model.topologyFor(pick.mesh);
  if (!topology) {
    const mesh = pick.kind === 'face' ? model.faceMesh(pick.node, pick.mesh, pick.index) : undefined;
    const box = mesh ? new THREE.Box3().setFromObject(mesh) : null;
    return {
      kind: pick.kind, name: pick.kind === 'face' ? 'Face' : pick.kind, headline: pick.kind === 'face' ? 'Face' : pick.kind,
      description: `A ${pick.kind} of ${owner}${box ? ` spanning ${pointText(box.min)} to ${pointText(box.max)}` : ''}. (This build predates B-rep topology; regenerate for exact geometry.)`,
      geometry: box ? { bounds_min: point(box.min), bounds_max: point(box.max) } : {},
    };
  }
  if (pick.kind === 'face') return describeFace(model, pick, topology, owner, units);
  if (pick.kind === 'edge') return describeEdge(model, pick, topology, owner, units);
  const frame = frameOf(model, pick);
  const vertex = topology.vertices[pick.index];
  const p = frame && vertex ? toWorld(frame, vertex) : new THREE.Vector3();
  return { kind: 'vertex', name: 'Vertex', headline: 'Vertex', description: `Vertex at ${pointText(p)} on ${owner}.`, geometry: { position: point(p) } };
}

/** Payload for the assistant: what the user has selected, in words and numbers. */
export interface SelectionContext {
  kind: Pick['kind'];
  description: string;
  component: string | null;
  part_document_id: string | null;
  build_id: string;
  topology_ref: string | null;
  geometry: Record<string, unknown>;
}

export function selectionContext(model: ModelRuntime, picks: Pick[]): SelectionContext[] {
  return picks.slice(0, 12).map((pick) => {
    const semantics = analyze(model, pick);
    const node = model.tree[pick.node];
    return {
      kind: pick.kind,
      description: semantics.description,
      component: node?.name ?? null,
      part_document_id: node?.documentId ?? null,
      build_id: model.build.id,
      // The persistent name the design's code uses for this face/edge/vertex, when the build exported one.
      topology_ref: pick.kind === 'component' ? null : referenceName(model, pick) ?? `mesh ${pick.mesh} ${pick.kind} ${pick.index}`,
      geometry: { ...semantics.geometry, ...(semantics.pattern ? { pattern: semantics.pattern } : {}) },
    };
  });
}

function referenceName(model: ModelRuntime, pick: Pick): string | null {
  if (pick.kind === 'component') return null;
  const mesh = model.topologyFor(pick.mesh) as unknown as { faces?: { ref?: string }[]; edges?: { ref?: string }[]; vertex_refs?: string[] } | undefined;
  const ref = pick.kind === 'face' ? mesh?.faces?.[pick.index]?.ref : pick.kind === 'edge' ? mesh?.edges?.[pick.index]?.ref : mesh?.vertex_refs?.[pick.index];
  return ref ?? null;
}

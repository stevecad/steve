/**
 * The design's sketch curves as engraving sources: every non-construction curve of a sketch drawn on a horizontal
 * plane, in work XY (the design frame), as straight segments within a chord tolerance. Hit-testing a screen point
 * against them lets the Manufacture viewport pick curves while the engrave editor asks for them.
 */
import * as THREE from 'three';
import { get as app } from '@/state/store';
import type { ModelFeature } from '@/lib/modeling';
import { viewer } from '@/viewport/viewer';
import { sample } from '@/sketch/geometry';
import type { Entity } from '@/sketch/model';
import { sketchPlane } from '@/sketch/actions';
import { simplify, type XY } from './engrave';

export interface SketchCurve { sketch: string; sketchName: string; entity: string; label: string; points: XY[]; z: number }
export interface HorizontalSketch { id: string; name: string; z: number; curves: SketchCurve[] }

const KIND: Record<string, string> = { line: 'Line', circle: 'Circle', arc: 'Arc', ellipse: 'Ellipse', elliptical_arc: 'Elliptical arc', bspline: 'Spline' };
const PICK_PX = 7;

/** A curve in sketch coordinates as straight segments within `chord` of it (lines stay two points). */
function segments(entity: Entity, chord: number): XY[] {
  if (entity.type === 'line') return [entity.start, entity.end];
  const radius = entity.type === 'circle' || entity.type === 'arc' ? entity.radius
    : entity.type === 'ellipse' || entity.type === 'elliptical_arc' ? entity.major_radius : 0;
  if (radius > 0 && (entity.type === 'circle' || entity.type === 'arc')) {
    // The segment count whose chord stays within the tolerance of the circle.
    const step = 2 * Math.acos(Math.max(-1, 1 - Math.min(chord, radius) / radius));
    return sample(entity, Math.min(8192, Math.max(12, Math.ceil((2 * Math.PI) / Math.max(step, 1e-4)))));
  }
  // Ellipses and splines: densely sampled, then reduced to the tolerance.
  return simplify(sample(entity, entity.type === 'bspline' ? 4096 : 2048), chord);
}

let cache: { doc: unknown; version: number; chord: number; sketches: HorizontalSketch[] } | null = null;

/** The design's sketches on horizontal planes, with their curves in work XY (cached per build and tolerance). */
export function horizontalSketches(chord: number): HorizontalSketch[] {
  const state = app();
  const doc = state.modeling;
  if (!doc) return [];
  if (cache && cache.doc === doc && cache.version === state.modelVersion && cache.chord === chord) return cache.sketches;
  const sketches: HorizontalSketch[] = [];
  for (const feature of doc.features as ModelFeature[]) {
    if (feature.kind !== 'sketch' || !feature.id || !feature.document) continue;
    const plane = sketchPlane(feature, doc);
    if (!plane || Math.abs(plane.normal.z) < 1 - 1e-6) continue;
    const z = plane.origin.z;
    const world = ([u, v]: XY): XY => [plane.origin.x + plane.x.x * u + plane.y.x * v, plane.origin.y + plane.x.y * u + plane.y.y * v];
    const entities = ((feature.document.entities ?? []) as unknown as Entity[]).filter((entity) => !entity.construction && entity.type !== 'point' && entity.type !== 'projection');
    const curves = entities.map((entity) => ({
      sketch: feature.id!, sketchName: feature.name, entity: entity.id, label: `${KIND[entity.type] ?? entity.type} ${entity.id}`,
      points: segments(entity, chord).map(world), z,
    })).filter((curve) => curve.points.length >= 2);
    if (curves.length) sketches.push({ id: feature.id, name: feature.name, z, curves });
  }
  cache = { doc, version: state.modelVersion, chord, sketches };
  return sketches;
}

/** One picked curve by its sketch and entity, or null when the design no longer has it. */
export function sketchCurve(sketch: string, entity: string, chord: number): SketchCurve | null {
  return horizontalSketches(chord).find((item) => item.id === sketch)?.curves.find((curve) => curve.entity === entity) ?? null;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** The sketch curve within a few pixels of a screen point (on its sketch's plane), nearest first. */
export function curveAt(clientX: number, clientY: number, element: HTMLElement, chord: number): SketchCurve | null {
  const camera = viewer.camera;
  if (!camera) return null;
  const rect = element.getBoundingClientRect();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
  const ray = raycaster.ray;
  let best: { curve: SketchCurve; distance: number } | null = null;
  for (const sketch of horizontalSketches(chord)) {
    if (Math.abs(ray.direction.z) < 1e-6) continue;
    const depth = (sketch.z - ray.origin.z) / ray.direction.z;
    if (depth <= 0) continue;
    const point = ray.at(depth, new THREE.Vector3());
    const pixel = camera instanceof THREE.OrthographicCamera
      ? (camera.top - camera.bottom) / camera.zoom / Math.max(rect.height, 1)
      : (2 * depth * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov ?? 50) / 2)) / Math.max(rect.height, 1);
    for (const curve of sketch.curves) {
      let near = Infinity;
      for (let i = 1; i < curve.points.length; i++) near = Math.min(near, segmentDistance([point.x, point.y], curve.points[i - 1], curve.points[i]));
      if (near <= PICK_PX * pixel && (!best || near < best.distance)) best = { curve, distance: near };
    }
  }
  return best?.curve ?? null;
}

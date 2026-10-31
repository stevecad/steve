/**
 * The automatic operation of an extrude left on Auto, as in Fusion: pushed into the solid it starts on it's a cut, pulled
 * out of it (or into empty space) it joins. It's decided from the geometry from before this feature (the dialog's measurement build),
 * and written into the code as an explicit `op`, so the code always says what happens.
 */
import * as THREE from 'three';
import { viewer } from '@/viewport/viewer';
import type { SketchPlane } from '@/sketch/session';

/** Whether there is solid material just past the sketch, along its normal (`forward`) and against it (`backward`). */
export interface MaterialAround { forward: boolean; backward: boolean }

const raycaster = new THREE.Raycaster();

/** Whether `point` is inside the displayed solid: the first surface a ray from it meets is one it leaves through. */
function insideModel(point: THREE.Vector3, direction: THREE.Vector3): boolean {
  const model = viewer.model;
  if (!model) return false;
  const meshes = model.faces.filter((mesh) => model.isShown(mesh));
  if (!meshes.length) return false;
  // Faces render one-sided; the exit surface is seen from behind, so both sides count for this one ray.
  const materials = new Map<THREE.Material, THREE.Side>();
  for (const mesh of meshes) for (const material of [mesh.material].flat()) materials.set(material, material.side);
  for (const material of materials.keys()) material.side = THREE.DoubleSide;
  try {
    raycaster.set(point, direction);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit?.face) return false;
    return hit.face.normal.clone().transformDirection(hit.object.matrixWorld).dot(direction) > 0;
  } finally {
    for (const [material, side] of materials) material.side = side;
  }
}

/** A point inside each region of a profile: the centroid of its largest triangle (a ring's centre is in its hole). */
function interiorPoints(shapes: THREE.Shape[]): THREE.Vector2[] {
  return shapes.slice(0, 8).flatMap((shape) => {
    const contour = shape.getPoints();
    const holes = shape.holes.map((hole) => hole.getPoints());
    const all = [...contour, ...holes.flat()];
    let best: THREE.Vector2 | null = null;
    let largest = 0;
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      const [p, q, r] = [all[a], all[b], all[c]];
      const area = Math.abs((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y));
      if (area > largest) { largest = area; best = new THREE.Vector2((p.x + q.x + r.x) / 3, (p.y + q.y + r.y) / 3); }
    }
    return best ? [best] : [];
  });
}

/** Material just past a profile's regions on either side of its plane, in the displayed model; null without a model. */
export function materialAround(plane: SketchPlane, shapes: THREE.Shape[]): MaterialAround | null {
  // Hidden: the history marker is before the first solid, so there is nothing before this feature.
  if (!viewer.model?.faces.length || !viewer.model.root.visible) return null;
  const step = Math.max(viewer.modelRadius() * 1e-3, 0.01);  // Clear of the face the sketch sits on.
  const result: MaterialAround = { forward: false, backward: false };
  for (const p of interiorPoints(shapes)) {
    const at = plane.origin.clone().addScaledVector(plane.x, p.x).addScaledVector(plane.y, p.y);
    for (const [key, sign] of [['forward', 1], ['backward', -1]] as const) {
      if (result[key]) continue;
      const direction = plane.normal.clone().multiplyScalar(sign).normalize();
      result[key] = insideModel(at.clone().addScaledVector(direction, step), direction);
    }
  }
  return result;
}

/** The operation Auto stands for: a cut when the extrusion goes into material, else a join. */
export function autoExtrudeOp(around: MaterialAround | null, extent: string, distance: number): 'cut' | 'join' {
  if (!around) return 'join';
  if (extent === 'distance') return (distance >= 0 ? around.forward : around.backward) ? 'cut' : 'join';
  // Through all goes through whatever is there. Symmetric from a face is half in, half out (a boss); from inside the
  // solid (material both ways) it's a cut.
  if (extent === 'through') return around.forward || around.backward ? 'cut' : 'join';
  return around.forward && around.backward ? 'cut' : 'join';
}

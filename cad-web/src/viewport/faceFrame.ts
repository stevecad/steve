import * as THREE from 'three';
import type { ModelRuntime } from './model';
import type { Pick } from '@/state/store';

/** Area-weighted centroid, mean normal and bounds of a picked face, in world space. */
export function faceFrame(model: ModelRuntime, pick: Pick): { center: THREE.Vector3; normal: THREE.Vector3; size: number; bounds: THREE.Box3 } | null {
  if (pick.kind !== 'face') return null;
  const mesh = model.faceMesh(pick.node, pick.mesh, pick.index);
  if (!mesh) return null;
  mesh.updateWorldMatrix(true, false);
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const center = new THREE.Vector3(), normal = new THREE.Vector3(), cross = new THREE.Vector3();
  let area = 0;
  const count = index ? index.count : position.count;
  const centroids: THREE.Vector3[] = [];
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
    cross.subVectors(b, a).cross(c.clone().sub(a));
    const triangle = cross.length() / 2;
    area += triangle;
    normal.add(cross);
    const centroid = a.clone().add(b).add(c).divideScalar(3);
    centroids.push(centroid);
    center.addScaledVector(centroid, triangle);
  }
  if (area <= 0) return null;
  center.divideScalar(area);
  // Faces with holes have their centroid in empty space; snap onto the surface.
  let nearest = centroids[0], best = Infinity;
  for (const point of centroids) { const d = point.distanceToSquared(center); if (d < best) { best = d; nearest = point; } }
  center.copy(nearest);
  // Closed curved faces (cylinders) have a near-zero mean normal; fall back to the nearest vertex normal.
  if (normal.lengthSq() < 1e-12) normal.set(0, 0, 1);
  const box = new THREE.Box3().setFromObject(mesh);
  return { center, normal: normal.normalize(), size: box.getSize(new THREE.Vector3()).length(), bounds: box };
}

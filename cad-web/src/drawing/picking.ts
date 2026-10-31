/**
 * The model's geometry, picked on a drawing sheet. A click in a view is a ray along that view's line of sight, cast at
 * the 3D view's model (loaded beneath the Drawing tab) by the 3D view's own picking (ModelRuntime.pick), so faces,
 * edges, vertices and the selection filter work as they do there; a section's rays start at its cutting plane, a
 * detail picks inside its circle only. The other way, what's selected (and under the pointer) is drawn on the sheet
 * through every view. Both go by what the build reports about each view (`views_placed[].projection`,
 * runtime/steve/drawing.py); sheets drawn before it reported that simply aren't pickable until they're redrawn.
 */
import * as THREE from 'three';
import type { DrawingSheet, Vec3 } from '@/lib/api';
import type { Pick, SelectionFilter } from '@/state/store';
import type { ModelRuntime } from '@/viewport/model';
import { viewer } from '@/viewport/viewer';

type PlacedView = NonNullable<DrawingSheet['views_placed']>[number];

/** The picking camera's size in screen pixels: edges and vertices are picked within a few of them, as in the 3D view. */
const PICK_VIEWPORT = { width: 1000, height: 1000 };
/** Sheet mm around a view's box that still pick in it (an outline sits on the box's edge). */
const BOX_MARGIN = 2;

const vector = (v: Vec3 | number[]) => new THREE.Vector3(v[0], v[1], v[2]);

/** The view drawn at sheet point (x, y) (mm, y down) that can be picked in: inside its box, or a detail's circle. */
export function viewAt(sheet: DrawingSheet, x: number, y: number): PlacedView | null {
  const inside = (view: PlacedView) => {
    const clip = view.projection?.clip;
    if (clip) return Math.hypot(x - clip[0], y - clip[1]) <= clip[2];
    const [x0, y0, x1, y1] = view.box;
    return x >= x0 - BOX_MARGIN && x <= x1 + BOX_MARGIN && y >= y0 - BOX_MARGIN && y <= y1 + BOX_MARGIN;
  };
  const views = (sheet.views_placed ?? []).filter((view) => view.projection);
  // A detail's circle can sit in its parent's box: the detail first.
  return views.find((view) => view.projection!.clip && inside(view)) ?? views.find(inside) ?? null;
}

/** Where the sheet's model axes are in the 3D view, and the node to keep picks to: a component's sheet is in its own
 *  axes, which its first placed instance's placement puts in the design (placement.ts); else the model's own. */
function sheetFrame(model: ModelRuntime, sheet: DrawingSheet): { matrix: THREE.Matrix4; node?: string } {
  if (sheet.component) {
    for (const [node, instance] of model.instances) {
      const object = instance.component === sheet.component ? model.objects.get(node) : undefined;
      if (!object) continue;
      object.updateWorldMatrix(true, false);
      return { matrix: object.matrixWorld.clone(), node };
    }
  }
  return { matrix: new THREE.Matrix4() };
}

/**
 * The geometry under sheet point (x, y) (mm, y down) as the 3D view would pick it, with `pixelsPerMm` screen pixels a
 * sheet millimetre at the current zoom; null over paper, a table, or a sheet that can't be picked.
 */
export function pickOnSheet(sheet: DrawingSheet, x: number, y: number, pixelsPerMm: number, filter: SelectionFilter): Pick | null {
  const model = viewer.model;
  const projection = viewAt(sheet, x, y)?.projection;
  if (!model || !projection) return null;
  const { matrix, node } = sheetFrame(model, sheet);
  const turn = new THREE.Matrix4().extractRotation(matrix);
  const up = vector(projection.y).applyMatrix4(turn).normalize();
  const towards = vector(projection.towards).applyMatrix4(turn).normalize();
  // The point under the pointer on the view's paper plane (through the model's origin), in the 3D view.
  const u = projection.model[0] + (x - projection.sheet[0]) / projection.scale;
  const v = projection.model[1] - (y - projection.sheet[1]) / projection.scale;
  const onPlane = vector(projection.x).multiplyScalar(u).addScaledVector(vector(projection.y), v).applyMatrix4(matrix);
  const sphere = model.bounds(false).getBoundingSphere(new THREE.Sphere());
  if (sphere.isEmpty()) return null;
  const middle = sphere.center.clone().sub(onPlane).dot(towards);
  // Looking along the view from just past the model; a section from its cutting plane, so what it cut away isn't hit.
  const depth = projection.cut ?? middle + sphere.radius + 1;
  const far = Math.max(depth - (middle - sphere.radius) + 1, 1);
  const half = PICK_VIEWPORT.width / 2 / (pixelsPerMm * projection.scale);
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0, far);
  camera.up.copy(up);
  camera.position.copy(onPlane).addScaledVector(towards, depth);
  camera.lookAt(camera.position.clone().sub(towards));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const raycaster = new THREE.Raycaster();
  const tolerance = Math.max(sphere.radius * 1e-4, 1e-6);
  const cutAway = (point: THREE.Vector3) => projection.cut !== undefined && point.clone().sub(onPlane).dot(towards) > projection.cut + tolerance;
  const at = (which: SelectionFilter) => model.pickFrom(raycaster, camera, new THREE.Vector2(), PICK_VIEWPORT, which, node);
  let hit = at(filter);
  // A vertex is found near the line of sight, wherever it is along it: one the section cut away gives way to an edge or face.
  if (hit && cutAway(hit.point) && filter === 'auto') hit = at('edge') ?? at('face');
  return hit && !cutAway(hit.point) ? hit.pick : null;
}

/** A pick's outline in the 3D view: an edge's polyline, a face's boundary edges, a vertex's point. */
function outline(model: ModelRuntime, pick: Pick): { lines: THREE.Vector3[][]; points: THREE.Vector3[] } {
  if (pick.kind === 'component') return { lines: [], points: [] };
  const topology = model.topologyFor(pick.mesh);
  const frame = model.frameFor(pick.node, pick.mesh);
  if (!topology || !frame) return { lines: [], points: [] };
  frame.updateWorldMatrix(true, false);
  const world = (points: number[]) => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i + 2 < points.length; i += 3) out.push(new THREE.Vector3(points[i], points[i + 1], points[i + 2]).applyMatrix4(frame.matrixWorld));
    return out;
  };
  if (pick.kind === 'vertex') {
    const vertex = topology.vertices[pick.index];
    return { lines: [], points: vertex ? world(vertex) : [] };
  }
  const edges = pick.kind === 'edge' ? [topology.edges[pick.index]].filter(Boolean) : topology.edges.filter((edge) => edge.faces?.includes(pick.index));
  return { lines: edges.map((edge) => world(edge.points)), points: [] };
}

/** What `picks` look like in one view of the sheet: an SVG path (sheet mm, y down), points, and a detail's circle. */
export interface SheetMarks { view: string; path: string; points: [number, number][]; clip?: [number, number, number] }

/** `picks` drawn through every pickable view of the sheet (an edge seen end-on is a point there). */
export function sheetMarks(sheet: DrawingSheet, picks: Pick[]): SheetMarks[] {
  const model = viewer.model;
  if (!model || !picks.length) return [];
  const shapes = picks.map((pick) => outline(model, pick));
  if (!shapes.some((shape) => shape.lines.length || shape.points.length)) return [];
  const toModel = sheetFrame(model, sheet).matrix.clone().invert();
  const marks: SheetMarks[] = [];
  for (const view of sheet.views_placed ?? []) {
    const projection = view.projection;
    if (!projection) continue;
    const [ax, ay, az] = projection.x, [bx, by, bz] = projection.y;
    const local = new THREE.Vector3();
    const place = (point: THREE.Vector3): [number, number] => {
      local.copy(point).applyMatrix4(toModel);
      return [projection.sheet[0] + (local.x * ax + local.y * ay + local.z * az - projection.model[0]) * projection.scale,
        projection.sheet[1] - (local.x * bx + local.y * by + local.z * bz - projection.model[1]) * projection.scale];
    };
    let path = '';
    const points: [number, number][] = [];
    for (const shape of shapes) {
      for (const line of shape.lines) {
        line.forEach((point, i) => { const [x, y] = place(point); path += `${i ? 'L' : 'M'}${x.toFixed(3)} ${y.toFixed(3)}`; });
      }
      points.push(...shape.points.map(place));
    }
    marks.push({ view: view.view, path, points, clip: projection.clip });
  }
  return marks;
}

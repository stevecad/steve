import * as THREE from 'three';
import type { ModelRuntime } from '@/viewport/model';
import { get, set, toast, type AppState, type EntityPick, type PlaneDraft } from '@/state/store';
import { setCode, updateModel } from '@/state/actions';
import { insertPlane, nextPlaneName, planeLine, parallelMidplane, parsePlanes, type ConstructionPlane } from '@/lib/construction';
import { ensureModel } from '@/lib/modeling';

export interface DraftPlane { origin: THREE.Vector3; normal: THREE.Vector3; comment: string; xDir?: THREE.Vector3 }

export function editPlane(plane: ConstructionPlane) {
  set({ tool: 'plane', workspace: 'design', selection: [], planeDraft: { mode: 'offset', reference: 'existing', offset: 0, flip: false,
    editing: { name: plane.name, origin: plane.origin.toArray(), normal: plane.normal.toArray(), xDir: plane.xDir.toArray() } } });
}

const ORIGIN_NORMALS: Record<'XY' | 'XZ' | 'YZ', THREE.Vector3> = { XY: new THREE.Vector3(0, 0, 1), XZ: new THREE.Vector3(0, -1, 0), YZ: new THREE.Vector3(1, 0, 0) };
const fmt = (value: number) => `${Math.round(value * 1000) / 1000}`;

/** Planar faces and vertices from the current selection, in document coordinates. */
function planarFaces(model: ModelRuntime, state: AppState) {
  return state.selection.filter((pick): pick is EntityPick => pick.kind === 'face').flatMap((pick) => {
    const face = model.topologyFor(pick.mesh)?.faces[pick.index];
    const frame = model.frameFor(pick.node, pick.mesh);
    if (!face || face.type !== 'plane' || !face.normal || !face.origin || !frame) return [];
    frame.updateWorldMatrix(true, false);
    const normal = new THREE.Vector3(...face.normal).applyMatrix3(new THREE.Matrix3().getNormalMatrix(frame.matrixWorld)).normalize();
    return [{ normal, point: new THREE.Vector3(...face.origin).applyMatrix4(frame.matrixWorld) }];
  });
}

function vertices(model: ModelRuntime, state: AppState) {
  return state.selection.filter((pick): pick is EntityPick => pick.kind === 'vertex').flatMap((pick) => {
    const vertex = model.topologyFor(pick.mesh)?.vertices[pick.index];
    const frame = model.frameFor(pick.node, pick.mesh);
    return vertex && frame ? [new THREE.Vector3(...vertex).applyMatrix4(frame.matrixWorld)] : [];
  });
}

/** The plane the tool would create now, or the reason it can't. */
export function draftPlane(model: ModelRuntime | null, state: AppState, draft: PlaneDraft = state.planeDraft): DraftPlane | { error: string } {
  const sign = draft.flip ? -1 : 1;
  if (draft.mode === 'offset') {
    if (draft.reference === 'existing') {
      if (!draft.editing) return { error: 'Choose a reference plane.' };
      const normal = new THREE.Vector3().fromArray(draft.editing.normal);
      return { origin: new THREE.Vector3().fromArray(draft.editing.origin).addScaledVector(normal, draft.offset),
        normal: normal.multiplyScalar(sign), xDir: new THREE.Vector3().fromArray(draft.editing.xDir), comment: 'edited construction plane' };
    }
    if (draft.reference !== 'face') {
      const normal = ORIGIN_NORMALS[draft.reference].clone().multiplyScalar(sign);
      return { origin: normal.clone().multiplyScalar(draft.offset), normal, comment: `offset ${fmt(draft.offset)} mm from origin ${draft.reference}` };
    }
    if (!model) return { error: 'There’s no geometry yet.' };
    const [face] = planarFaces(model, state);
    if (!face) return { error: 'Select a planar face to offset from.' };
    const normal = face.normal.clone().multiplyScalar(sign);
    return { origin: face.point.clone().addScaledVector(normal, draft.offset), normal, comment: `offset ${fmt(draft.offset)} mm from a face at ${pointText(face.point)}` };
  }
  if (!model) return { error: 'There’s no geometry yet.' };
  if (draft.mode === 'midplane') {
    const faces = planarFaces(model, state);
    if (faces.length < 2) return { error: 'Select two parallel planar faces.' };
    const [a, b] = faces;
    const middle = parallelMidplane(a.point, a.normal, b.point, b.normal);
    if ('error' in middle) return middle;
    return { origin: middle.origin, normal: middle.normal.multiplyScalar(sign), comment: `midplane between two faces ${fmt(middle.gap)} mm apart` };
  }
  const points = vertices(model, state);
  if (points.length < 3) return { error: `Select three vertices (${points.length} selected).` };
  const [p0, p1, p2] = points;
  const normal = p1.clone().sub(p0).cross(p2.clone().sub(p0));
  if (normal.lengthSq() < 1e-10) return { error: 'The three vertices are collinear.' };
  normal.normalize().multiplyScalar(sign);
  return { origin: p0.clone(), normal, comment: `through ${pointText(p0)}, ${pointText(p1)}, ${pointText(p2)}` };
}

const pointText = (v: THREE.Vector3) => `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;

/** Writes the plane into the source as a named cq.Plane. */
export function createPlane(model: ModelRuntime | null) {
  const state = get();
  const plane = draftPlane(model, state);
  if ('error' in plane) { toast('warning', 'Can’t create the plane', plane.error); return; }
  const name = state.planeDraft.editing?.name ?? nextPlaneName(state.doc.code);
  const base = state.doc.code.trim() ? state.doc.code : ensureModel(state.doc.code, state.modeling);
  const line = planeLine(name, plane.origin, plane.normal, plane.comment, plane.xDir);
  let code: string;
  if (state.planeDraft.editing) {
    const current = parsePlanes(base).find((p) => p.name === name);
    if (!current) { toast('warning', 'Plane no longer exists', 'Close the panel and select the plane again.'); return; }
    const lines = base.split('\n'); lines[current.line - 1] = line; code = lines.join('\n');
  } else code = insertPlane(base, line);
  setCode(code);
  set({ tool: 'select' });
  void updateModel();
  toast('success', `${name} ${state.planeDraft.editing ? 'updated' : 'created'}`, 'Sketches referencing this plane follow its placement.');
}

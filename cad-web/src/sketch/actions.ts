/**
 * Entering and leaving sketch mode. Finishing writes the sketch back into the code as one
 * `with model.sketch(...)` block and regenerates the model.
 */
import * as THREE from 'three';
import { parsePlanes } from '@/lib/construction';
import { get, set, toast, type Pick } from '@/state/store';
import { advanceRollback, insertionPoint } from '@/modeling/rollback';
import { faceFrame } from '@/viewport/faceFrame';
import { setCode, updateModel } from '@/state/actions';
import { ensureModel, insertFeature, modelingReport, nextId, parseModel, pyString, replaceFeature, type ModelDoc, type ModelFeature } from '@/lib/modeling';
import { viewer } from '@/viewport/viewer';
import { setSketchNavigation } from '@/viewport/mouseStyle';
import { emitSketch, expand, setProjections, statementsFrom, type Entity, type Stmt } from './model';
import { resolveRef, withIds } from './project';
import { activeComponent, componentOfNode, foreignComponents, refSource, withImport } from '@/state/designRefs';
import { NAMED_PLANES, planeBasis, resolve, useSketch, type SketchPlane } from './session';
import { bounds } from './geometry';
import { setTool } from './tools';

export interface SketchTarget {
  /** Python source for `on=` (e.g. `"XY"`, `"extrude_1.end"`, `"plane_2"`). */
  on: string;
  plane: SketchPlane;
  label: string;
  /** The face's world-space bounds, for a sketch on a model face: the camera frames the whole face. */
  view?: THREE.Box3;
}

/** The plane a sketch sits on, for sources the browser can resolve by itself. */
export function namedTarget(name: string): SketchTarget {
  const [x, n] = NAMED_PLANES[name];
  return { on: pyString(name), plane: planeBasis([0, 0, 0], x, n), label: `${name} plane` };
}

/** Construction-plane placement shared by new sketches, editing and overlays.
 * Matches Model.plane: offset along the base normal, then rotate about its local x/y axis. */
function placedPlane(feature: ModelFeature, doc: ModelDoc, depth = 0): SketchPlane | null {
  if (depth > 16) return null;
  const arg = (index: number, key: string) => feature.kwargs?.[key] ?? feature.args?.[index];
  const on = arg(0, 'on')?.value ?? 'XY';
  let base: SketchPlane | null = null;
  if (typeof on === 'string' && NAMED_PLANES[on]) base = planeBasis([0, 0, 0], NAMED_PLANES[on][0], NAMED_PLANES[on][1]);
  else if (typeof on === 'string') {
    const other = doc.features.find((f) => f.id === on && f.kind === 'plane');
    if (other) base = placedPlane(other, doc, depth + 1);
    else {
      const pick = pickForRef(on);
      const face = pick ? faceTarget(pick) : null;
      if (face && typeof face !== 'string') base = face.plane;
    }
  } else if (Array.isArray(on) && on.length === 3) {
    const [origin, normal, x] = on as number[][];
    base = planeBasis(origin, x, normal);
  }
  if (!base) return null;
  const origin = base.origin.clone().addScaledVector(base.normal, Number(arg(1, 'offset')?.value ?? 0) || 0);
  const x = base.x.clone(), normal = base.normal.clone();
  const angle = Number(arg(2, 'angle')?.value ?? 0) || 0;
  if (angle) {
    const axis = arg(3, 'axis')?.value === 'y' ? base.y.clone() : base.x.clone();
    x.applyAxisAngle(axis, THREE.MathUtils.degToRad(angle));
    normal.applyAxisAngle(axis, THREE.MathUtils.degToRad(angle));
  }
  return planeBasis(origin.toArray(), x.toArray(), normal.toArray());
}

export function planeFeatureTarget(feature: ModelFeature, doc: ModelDoc): SketchTarget | null {
  const plane = feature.id ? placedPlane(feature, doc) : null;
  return plane ? { on: pyString(feature.id!), plane, label: feature.name } : null;
}

/** Target for an existing sketch's `on=` source, when the browser can place it. */
export function targetForSource(source: string, doc: ModelDoc, plane?: SketchPlane): SketchTarget | null {
  // A cq.Plane variable is a live reference, not a snapshot of its coordinates.
  const construction = parsePlanes(get().doc.code).find((p) => p.name === source.trim());
  if (construction) return { on: source, plane: planeBasis(construction.origin.toArray(), construction.xDir.toArray(), construction.normal.toArray()), label: construction.name };
  const value = source.replace(/^["']|["']$/g, '');
  if (NAMED_PLANES[value]) return namedTarget(value);
  const feature = doc.features.find((f) => f.id === value && f.kind === 'plane');
  if (feature) return planeFeatureTarget(feature, doc);
  if (plane) return { on: source, plane, label: value };
  return null;
}

function lookAt(target: SketchTarget, statements: Stmt[]) {
  // Look straight at the sketch; framed on its geometry and the face it sits on, or a 120 mm square around its origin.
  const { plane, view } = target;
  const dir = plane.normal.clone();
  if (Math.abs(dir.z) > 0.9999) dir.set(0, -1e-4, Math.sign(dir.z)).normalize();
  const square = (min: number[], max: number[]) => new THREE.Box3().setFromPoints(
    [[min[0], min[1]], [max[0], max[1]], [min[0], max[1]], [max[0], min[1]]]
      .map(([u, v]) => plane.origin.clone().addScaledVector(plane.x, u).addScaledVector(plane.y, v)));
  const box = bounds(expand(statements).entities);
  const pad = box ? Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1]) * 0.35 + 8 : 0;
  let frame = box ? square([box.min[0] - pad, box.min[1] - pad], [box.max[0] + pad, box.max[1] + pad]) : null;
  if (view && !view.isEmpty()) {
    // The whole face, with a margin so its edges show (its origin may be far from it, or it may be far bigger than 120 mm).
    const size = view.getSize(new THREE.Vector3());
    const face = view.clone().expandByScalar(Math.max(size.x, size.y, size.z) * 0.08 + 2);
    frame = frame ? frame.union(face) : face;
  }
  viewer.frame(frame ?? square([-60, -60], [60, 60]), dir, true);
  set({ view: null });
}

function setNavigation(sketching: boolean) {
  // In a sketch the left button draws; the other buttons follow Settings → Navigation's mouse style (in STEVE's own,
  // right-drag orbits and middle pans).
  setSketchNavigation(viewer.controls, sketching);
}

/** Opens a new sketch on `target`, or edits an existing sketch feature. */
export async function startSketch(target: SketchTarget, feature?: ModelFeature) {
  const state = get();
  if (!state.doc.open || state.busy) return;
  if (useSketch.getState().active) return;
  const doc = await parseModel(state.doc.code);
  const statements = feature ? statementsFrom(feature) : [];
  const featureId = feature?.id ?? nextId(doc, 'sketch');
  const extra: Record<string, string> = {};
  for (const [key, arg] of Object.entries(feature?.kwargs ?? {})) if (key !== 'on' && key !== 'name') extra[key] = arg.source;
  // Projections: exactly as the last build resolved them, else from their references on the displayed model.
  const built = ((modelingReport(state.displayed?.metadata, state.doc.activeFile)?.sketches as Record<string, { projections?: Record<string, Entity[]> }> | undefined)?.[featureId]?.projections) ?? {};
  const resolved: Record<string, Entity[]> = {};
  for (const s of statements) {
    if (s.op !== 'project') continue;
    const id = String(s.args[0]?.value ?? ''), ref = s.args[1]?.value ?? s.kwargs.ref?.value;
    const construction = (s.args[2] ?? s.kwargs.construction)?.value === true;
    if (built[id]?.length) resolved[id] = built[id];
    else if (typeof ref === 'string') resolved[id] = withIds(id, resolveRef(ref, target.plane, doc, (f) => sketchPlane(f, doc)) ?? [], construction);
  }
  setProjections(resolved);
  useSketch.setState({
    active: true, featureId, isNew: !feature, name: feature?.name ?? featureId.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()),
    on: target.on, planeLabel: target.label, extra, plane: target.plane, statements, expansion: expand(statements), result: null, selection: [], hover: null,
    preview: [], hints: [], undo: [], redo: [], editing: null, placing: null, labelDrag: null, construction: false, message: null, highlight: [],
  });
  setTool('select');  // Entering a sketch arms no tool; pick one from the ribbon or a key.
  set({ selection: [], tool: 'select', contextMenu: null, workspace: 'design' });
  setNavigation(true);
  lookAt(target, statements);
  await resolve();
}

/** Writes the sketch into the code and regenerates. */
export async function finishSketch(): Promise<boolean> {
  const sketchState = useSketch.getState();
  if (!sketchState.active) return false;
  const { statements, featureId, isNew, on, name, extra } = sketchState;
  const state = get();
  let code = state.doc.code;
  let doc = await parseModel(code);
  if (!doc.canonical) {
    code = ensureModel(code, doc);
    doc = await parseModel(code);
  }
  const existing = doc.features.find((f) => f.id === featureId && f.kind === 'sketch');
  const text = emitSketch({ id: featureId, on, name, extra, model: doc.model?.variable }, statements, existing?.body_indent ?? '    ', existing?.alias ?? 's');
  if (!isNew && existing) code = replaceFeature(code, existing, text);
  else {
    if (!statements.length) { cancelSketch(); return true; }
    code = insertFeature(code, doc, text, insertionPoint());
    advanceRollback(featureId);
  }
  // References into other components of a design need their imports (never in a part: it is one file).
  if (state.doc.kind === 'design' && state.doc.activeFile.startsWith('components/')) {
    for (const component of foreignComponents(text, doc.model?.variable ?? null)) code = withImport(code, component);
  }
  closeSketch();
  setCode(code);
  if (sketchState.result?.status === 'failed') toast('warning', `${name} has conflicting constraints`, 'The sketch keeps its last solved shape until you fix them.');
  // A design made only of sketches and planes has no solid to generate yet.
  const after = await parseModel(code);
  if (after.features.some((f) => !['sketch', 'plane', 'axis', 'point', 'code'].includes(f.kind))) void updateModel();
  return true;
}

export function cancelSketch() {
  closeSketch();
}

function closeSketch() {
  setProjections({});
  useSketch.setState({ active: false, preview: [], hints: [], selection: [], hover: null, highlight: [], editing: null, placing: null, labelDrag: null });
  setNavigation(false);
  viewer.invalidate?.();
}

/* ───────── choosing where to sketch ───────── */


const fmt = (v: number) => { const r = Math.round(v * 1e9) / 1e9; return Number.isInteger(r) ? `${r}.0` : String(r); };

/**
 * A planar face as a sketch target: the model origin projected onto it, global X projected as
 * the x axis (Y when X is normal to it) — the same rule as the runtime's face sketches.
 */
export function faceTarget(pick: Pick): SketchTarget | string {
  const model = viewer.model;
  if (!model || pick.kind !== 'face') return 'Pick a planar face.';
  const topology = model.topologyFor(pick.mesh)?.faces[pick.index] as { type?: string; ref?: string } | undefined;
  if (topology && topology.type !== 'plane') return 'Sketches need a flat face. Pick a planar face or a plane.';
  const frame = faceFrame(model, pick);
  if (!frame) return 'That face can’t be sketched on.';
  const n = frame.normal.clone().normalize();
  const origin = n.clone().multiplyScalar(frame.center.dot(n));
  let x = new THREE.Vector3(1, 0, 0);
  if (Math.abs(x.dot(n)) > 0.99) x = new THREE.Vector3(0, 1, 0);
  x.addScaledVector(n, -x.dot(n)).normalize();
  const plane = planeBasis(origin.toArray(), x.toArray(), n.toArray());
  // In a design, another component's face is written as `<component>.face("…")`.
  const on = topology?.ref
    ? refSource(pick, topology.ref).source
    : `((${origin.toArray().map(fmt).join(', ')}), (${n.toArray().map(fmt).join(', ')}), (${x.toArray().map(fmt).join(', ')}))`;
  return { on, plane, label: topology?.ref ?? 'Face', view: frame.bounds };
}

/** New sketch: on the selected planar face if there is one, otherwise ask for a plane. */
export function newSketch() {
  const state = get();
  if (!state.doc.open || state.busy || useSketch.getState().active) return;
  const face = state.selection.find((pick) => pick.kind === 'face');
  if (face) {
    const target = faceTarget(face);
    if (typeof target === 'string') { toast('warning', 'Can’t sketch there', target); return; }
    void startSketch(target);
    return;
  }
  useSketch.setState({ choosing: true, planeHover: null });
  set({ selection: [] });
  // Nothing to sketch on but the origin planes: bring them into view from an isometric angle.
  if (!viewer.model) viewer.frame(new THREE.Box3(new THREE.Vector3(-34, -34, -34), new THREE.Vector3(34, 34, 34)), new THREE.Vector3(1, -1, 0.8), true);
}

/** While choosing: a click on a face in the viewport. */
export function chooseFace(pick: Pick): boolean {
  if (!useSketch.getState().choosing) return false;
  const target = faceTarget(pick);
  if (typeof target === 'string') { toast('warning', 'Can’t sketch there', target); return true; }
  useSketch.setState({ choosing: false, planeHover: null });
  void startSketch(target);
  return true;
}

export function choosePlane(name: string) {
  useSketch.setState({ choosing: false, planeHover: null });
  void startSketch(namedTarget(name));
}

/** Opens an existing sketch feature for editing. */
export async function editSketch(featureId: string) {
  const doc = await parseModel(get().doc.code);
  const feature = doc.features.find((f) => f.id === featureId && f.kind === 'sketch');
  if (!feature) return;
  if (!feature.editable) { toast('info', 'This sketch is written as custom code', 'Edit it in Source; STEVE can convert it to an editable sketch.'); return; }
  const on = feature.args?.[0] ?? feature.kwargs?.on;
  const source = on?.source ?? '"XY"';
  let target = targetForSource(source, doc);
  if (!target && Array.isArray(on?.value)) {
    const [origin, normal, x] = on!.value as number[][];
    target = { on: source, plane: planeBasis(origin, x, normal), label: 'Face' };
  }
  const foreign = !target && on ? /^([a-z][a-z0-9_]*)\.face\((["'])(.+)\2\)$/.exec(on.source.trim()) : null;
  if (foreign) {
    // Another component's face in a design: find it among that component's displayed faces.
    const pick = pickForRef(foreign[3], foreign[1]);
    const found = pick ? faceTarget(pick) : null;
    if (found && typeof found !== 'string') target = { ...found, on: source };
  }
  if (!target && typeof on?.value === 'string') {
    // A face reference: find that face in the displayed geometry and sketch on it again.
    const pick = pickForRef(on.value);
    const found = pick ? faceTarget(pick) : null;
    if (found && typeof found !== 'string') target = { ...found, on: source };
  }
  if (!target) {
    toast('info', 'Regenerate the model first', 'This sketch sits on a model face that the displayed geometry doesn’t show.');
    return;
  }
  await startSketch(target, feature);
}

/** Where an existing sketch sits in 3D: a named or construction plane, a literal plane, or a model face. */
export function sketchPlane(feature: ModelFeature, doc: ModelDoc): SketchPlane | null {
  const on = feature.args?.[0] ?? feature.kwargs?.on;
  if (!on) return namedTarget('XY').plane;
  if (Array.isArray(on.value) && on.value.length === 3) {
    const [origin, normal, x] = on.value as number[][];
    return planeBasis(origin, x, normal);
  }
  const target = targetForSource(on.source, doc);
  if (target) return target.plane;
  const foreign = /^([a-z][a-z0-9_]*)\.face\((["'])(.+)\2\)$/.exec(on.source.trim());
  if (foreign) {
    const pick = pickForRef(foreign[3], foreign[1]);
    const found = pick ? faceTarget(pick) : null;
    return found && typeof found !== 'string' ? found.plane : null;
  }
  if (typeof on.value === 'string') {
    const pick = pickForRef(on.value);
    const found = pick ? faceTarget(pick) : null;
    if (found && typeof found !== 'string') return found.plane;
  }
  return builtPlane(feature);
}

/** Where the last build placed a sketch ([origin, x, normal], runtime/steve/model.py summary): for one whose face a
 *  later feature used up, so it isn't in the finished model to find. In the same frame as a literal plane. */
function builtPlane(feature: ModelFeature): SketchPlane | null {
  const { displayed, doc } = get();
  const sketches = modelingReport(displayed?.metadata, doc.activeFile)?.sketches as Record<string, { plane?: number[][] }> | undefined;
  const plane = feature.id ? sketches?.[feature.id]?.plane : undefined;
  if (!Array.isArray(plane) || plane.length !== 3 || plane.some((v) => !Array.isArray(v) || v.length !== 3)) return null;
  const [origin, x, normal] = plane;
  return planeBasis(origin, x, normal);
}

/** The displayed face carrying a reference name (exported by the runtime into topology). */
export function pickForRef(ref: string, component?: string): Pick | null {
  const model = viewer.model;
  if (!model) return null;
  const own = activeComponent();
  for (const info of model.allFaces()) {  // Merged huge parts expanded into their faces.
    // In a design, names repeat across components: look only at the component meant.
    const owner = get().doc.kind === 'design' ? componentOfNode(info.node) : null;
    if (owner && owner !== (component ?? own)) continue;
    const face = (model.topologyFor(info.meshIndex) as unknown as { faces?: { ref?: string }[] } | undefined)?.faces?.[info.faceIndex];
    if (face?.ref === ref) return { kind: 'face', node: info.node, mesh: info.meshIndex, index: info.faceIndex };
  }
  return null;
}

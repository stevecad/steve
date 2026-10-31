/**
 * "New cutter/holder → From part": a right-dock tool that turns a saved STEVE part (modelled, or imported from a
 * vendor STEP with `model.import_step`) into a source-backed library record. Frames are picked click-first in the
 * viewport and stored as the persistent references the backend resolves (manufacturing/tool_frames.py): a face,
 * edge, vertex, construction point/plane/axis or datum, optionally with a separate axis/origin and a +Z flip.
 *
 * The previews here only mirror the backend's rules to help the pick; the geometry job is authoritative.
 */
import * as THREE from 'three';
import { create } from 'zustand';
import { get as app, set as setApp, toast, isDirty, type Pick } from '@/state/store';
import { refFor } from '@/modeling/dialog';
import { bodiesOfPick, bodyIds } from '@/modeling/bodies';
import { insertFeature, nextId, parseModel, pyString } from '@/lib/modeling';
import type { TopologyEdge, TopologyFace } from '@/lib/api';
import { viewer } from '@/viewport/viewer';
import { library, MfgError, requestKey, type LibraryRecord } from './api';
import { loadLibrary, openLibrary } from './state';
import { sourceOf, type FrameSelection, type ToolGeometrySource } from './toolGeometry';

export type ToolKind = 'rotary_cutter' | 'tool_holder';
type EntityPick = Exclude<Pick, { kind: 'component' }>;
export type FrameKey = 'tip' | 'machine_side' | 'tool_side';
export type SlotPart = 'reference' | 'axis' | 'origin';
export interface Slot { reference: string | null; axis: string | null; origin: string | null; reverse: boolean }
export const FRAME_KEYS: Record<ToolKind, FrameKey[]> = { rotary_cutter: ['tip'], tool_holder: ['machine_side', 'tool_side'] };
export const FRAME_LABELS: Record<FrameKey, { title: string; hint: string }> = {
  tip: { title: 'Tip', hint: 'Tip at the origin, +Z along the axis into the shank (toward the spindle).' },
  machine_side: { title: 'Machine-side face', hint: 'The gauge plane that seats against the spindle; +Z points into the spindle.' },
  tool_side: { title: 'Tool-side mouth', hint: 'Where the cutter or next component enters, on the same axis, toward −Z.' },
};

export interface FromPartState {
  open: boolean;
  kind: ToolKind;
  /** Re-picking an existing record saves its next revision. */
  editing: LibraryRecord | null;
  documentId: string | null;
  documentName: string;
  /** The saved part revision the picks were made on. */
  revision: number | null;
  /** The part revision the edited record pinned (re-picking may move it to a newer one). */
  pinned: number | null;
  notice: string | null;
  body: string | null;
  frames: Partial<Record<FrameKey, Slot>>;
  target: { frame: FrameKey; part: SlotPart } | null;
  fields: Record<string, string>;
  errors: Record<string, string>;
  focus: string | null;
  busy: string | null;
  problem: string | null;
}

const emptySlot = (): Slot => ({ reference: null, axis: null, origin: null, reverse: false });

export const useFromPart = create<FromPartState>(() => ({
  open: false, kind: 'rotary_cutter', editing: null, documentId: null, documentName: '', revision: null, pinned: null, notice: null, body: null,
  frames: {}, target: null, fields: {}, errors: {}, focus: null, busy: null, problem: null,
}));
const set = useFromPart.setState;
const get = useFromPart.getState;

const CUTTER_DEFAULTS: Record<string, string> = { dimension_source: 'catalog', cutter_type: 'flat_end_mill', flute_count: '2', hand: 'right', center_cutting: 'true', material: 'carbide', cutting_length_mm: '' };
const HOLDER_DEFAULTS: Record<string, string> = { dimension_source: 'catalog', component_type: 'holder', input_interface: 'bt30', output_interface: 'cylindrical_shank', clamp_bore_mm: '', engagement_depth_mm: '', clamp_min_diameter_mm: '', clamp_max_diameter_mm: '', clamp_min_engagement_mm: '', clamp_max_engagement_mm: '' };

/** The open, saved part the picks come from (null with the reason it can't be used). */
export function openPart(): { id: string; name: string; revision: number } | string {
  const state = app();
  if (!state.doc.open) return 'Open the part first: frames are picked on its saved geometry.';
  if (state.doc.kind !== 'part') return 'Open the tool or holder part itself; tools come from parts, not designs.';
  if (!state.doc.saved) return 'Save the part first: a tool pins a saved revision.';
  if (state.doc.branch !== 'main') return 'Switch to main: a tool pins the part’s main revision.';
  if (!state.displayed) return 'Generate the part first.';
  if (isDirty(state)) return 'Save the part first: the picks must match a saved revision.';
  return { id: state.doc.saved.id, name: state.doc.name, revision: state.doc.saved.revision };
}

function slotFrom(selection: FrameSelection | null | undefined): Slot {
  if (!selection) return emptySlot();
  if (typeof selection === 'string') return { ...emptySlot(), reference: selection };
  return { reference: selection.reference, axis: selection.axis ?? null, origin: selection.origin ?? null, reverse: !!selection.reverse_z };
}

/** Opens the tool for a new record, or to re-pick frames for `record` (its next revision). */
export function startFromPart(kind: ToolKind, record: LibraryRecord | null = null, focus: string | null = null) {
  const part = openPart();
  const source = sourceOf(record);
  const definition = (record?.definition ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = { ...(kind === 'rotary_cutter' ? CUTTER_DEFAULTS : HOLDER_DEFAULTS) };
  fields.name = String(definition.name ?? (typeof part === 'string' ? `New ${kind === 'rotary_cutter' ? 'cutter' : 'holder'}` : part.name));
  for (const key of ['manufacturer', 'product_code', 'dimension_source', 'cutter_type', 'flute_count', 'hand', 'center_cutting', 'material', 'component_type', 'input_interface', 'output_interface', 'max_rpm', 'mass_kg']) {
    if (definition[key] !== undefined && definition[key] !== null) fields[key] = String(definition[key]);
  }
  if (source) for (const key of ['cutting_length_mm', 'clamp_bore_mm', 'engagement_depth_mm'] as const) if (source[key] != null) fields[key] = String(source[key]);
  const clamp = definition.clamp as Record<string, number> | undefined;
  if (clamp) for (const [key, value] of Object.entries(clamp)) fields[`clamp_${key}`] = String(value);
  const frames: Partial<Record<FrameKey, Slot>> = {};
  for (const key of FRAME_KEYS[kind]) frames[key] = slotFrom(source?.frames[key]);
  const same = source && typeof part !== 'string' && part.id === source.document_id;
  set({
    open: true, kind, editing: record, fields, frames, errors: {}, problem: null, busy: null, focus, pinned: source?.revision ?? null, notice: null,
    documentId: typeof part === 'string' ? source?.document_id ?? null : part.id,
    documentName: typeof part === 'string' ? '' : part.name,
    // An edited record keeps its pinned revision until the open part is the same document at a newer one.
    revision: typeof part === 'string' ? source?.revision ?? null : part.revision,
    body: same || !source ? source?.body ?? null : null,
    // A field to fix is focused, not armed for picking; re-picking arms the first frame.
    target: focus?.startsWith('frames.') ? { frame: focus.split('.')[1] as FrameKey, part: 'reference' } : focus ? null : { frame: FRAME_KEYS[kind][0], part: 'reference' },
  });
  if (!same && source && typeof part !== 'string') set({ frames: Object.fromEntries(FRAME_KEYS[kind].map((key) => [key, emptySlot()])) });
  setApp({ dialog: null });
}

export function closeFromPart() { set({ open: false, target: null }); }

export const setField = (key: string, value: string) => set((state) => ({ fields: { ...state.fields, [key]: value }, errors: { ...state.errors, [key]: '' } }));
export const setTarget = (frame: FrameKey, part: SlotPart) => set({ target: { frame, part } });
export function updateSlot(frame: FrameKey, patch: Partial<Slot>) {
  set((state) => ({ frames: { ...state.frames, [frame]: { ...(state.frames[frame] ?? emptySlot()), ...patch } }, errors: { ...state.errors, [`frames.${frame}`]: '' } }));
}

/** Viewport clicks while the tool waits for a frame reference. Returns true when it used the click. */
export function pickIntoFrames(pick: Pick): boolean {
  const state = get();
  if (!state.open || !state.target) return false;
  const part = openPart();
  if (typeof part === 'string') { toast('info', 'Can’t pick yet', part); return true; }
  const ref = refFor(pick);
  if (!ref) { toast('info', 'Regenerate to pick references', 'This geometry was generated before face and edge names existed.'); return true; }
  const { frame, part: slotPart } = state.target;
  const entity = entityFor(ref);
  if (slotPart === 'axis' && entity && !entity.z) { toast('info', 'That has no axis', 'Pick a circular edge, straight edge, planar face, construction plane or axis.'); return true; }
  const [body] = bodiesOfPick(pick);
  const current = part.revision === state.revision && part.id === state.documentId;
  const holding = Object.values(state.frames).some((slot) => slot?.reference || slot?.axis || slot?.origin);
  if (current && holding && body && state.body && body !== state.body) { toast('info', 'Another body', `Frames come from one body; this pick is on “${body}”. Clear the frames to switch bodies.`); return true; }
  if (!current) {
    // Picks made on another revision may name different faces (a re-imported STEP numbers its faces afresh).
    const picked = Object.values(state.frames).some((slot) => slot?.reference);
    set({
      documentId: part.id, documentName: part.name, revision: part.revision, body: null,
      frames: Object.fromEntries(FRAME_KEYS[state.kind].map((key) => [key, emptySlot()])),
      notice: picked && part.id === state.documentId ? `The part was saved as revision ${part.revision} after you picked on revision ${state.revision}, so the earlier picks were cleared. Re-pick every frame: a re-imported vendor file names its faces and edges afresh.` : null,
    });
  }
  updateSlot(frame, { [slotPart]: ref });
  set({ body: body ?? get().body });
  setApp({ selection: [pick] });
  // Move on to the next empty reference so picking flows click after click.
  const next = FRAME_KEYS[state.kind].find((key) => !(get().frames[key]?.reference));
  set({ target: slotPart === 'reference' && next ? { frame: next, part: 'reference' } : null });
  return true;
}

// ── Frame previews from the displayed topology ───────────────────────────────

export interface Entity {
  ref: string;
  kind: 'face' | 'edge' | 'vertex' | 'datum';
  type: string;
  /** Mesh-local (model) coordinates, as the backend sees the part body. */
  origin: THREE.Vector3 | null;
  z: THREE.Vector3 | null;
  face?: TopologyFace;
  edge?: TopologyEdge;
  pick?: EntityPick;
  matrix: THREE.Matrix4;
  describe: string;
}

const v3 = (value: number[] | undefined | null) => (value ? new THREE.Vector3(value[0], value[1], value[2]) : null);
const DATUM_AXES: Record<string, number[]> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const DATUM_PLANES: Record<string, number[]> = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0], ZX: [0, 1, 0], YX: [0, 0, -1], ZY: [-1, 0, 0], top: [0, 0, 1], front: [0, -1, 0], right: [1, 0, 0] };

const triple = (source: string | undefined) => {
  const match = source && /^\(\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,?\s*\)$/.exec(source.trim());
  return match ? new THREE.Vector3(Number(match[1]), Number(match[2]), Number(match[3])) : null;
};

/** A construction point or axis written with literal coordinates (`model.point`/`model.axis`), as the runtime places it. */
function construction(ref: string): Entity | null {
  const feature = app().modeling?.features.find((f) => f.id === ref && (f.kind === 'point' || f.kind === 'axis') && !f.suppressed);
  if (!feature) return null;
  const kwargs = feature.kwargs ?? {};
  if (feature.kind === 'point') {
    const at = triple(kwargs.at?.source ?? feature.args?.[1]?.source);
    return at ? { ref, kind: 'datum', type: 'point', origin: at, z: null, matrix: rootMatrix(), describe: `Construction point ${ref} — origin only (add an axis)` } : null;
  }
  const through = kwargs.through ? triple(kwargs.through.source) : new THREE.Vector3();
  const direction = kwargs.direction ? triple(kwargs.direction.source) : new THREE.Vector3(0, 0, 1);
  return through && direction ? { ref, kind: 'datum', type: 'axis', origin: through, z: direction.normalize(), matrix: rootMatrix(), describe: `Construction axis ${ref}` } : null;
}

/** The displayed entity behind a persistent reference, with the origin/axis the backend would derive from it. */
export function entityFor(ref: string): Entity | null {
  if (DATUM_AXES[ref]) return { ref, kind: 'datum', type: 'axis', origin: new THREE.Vector3(), z: v3(DATUM_AXES[ref]), matrix: rootMatrix(), describe: `Datum axis ${ref}` };
  if (DATUM_PLANES[ref]) return { ref, kind: 'datum', type: 'plane', origin: new THREE.Vector3(), z: v3(DATUM_PLANES[ref]), matrix: rootMatrix(), describe: `Datum plane ${ref}` };
  const built = construction(ref);
  if (built) return built;
  const model = viewer.model;
  if (!model) return null;
  for (const mesh of model.faces) {
    const info = mesh.userData.face as { node: string; meshIndex: number; faceIndex: number } | undefined;
    if (!info || info.faceIndex !== 0) continue;
    const topology = model.topologyFor(info.meshIndex);
    if (!topology) continue;
    const frame = model.frameFor(info.node, info.meshIndex);
    const matrix = frame ? (frame.updateWorldMatrix(true, false), frame.matrixWorld.clone()) : new THREE.Matrix4();
    const faceIndex = topology.faces.findIndex((face) => face.ref === ref);
    if (faceIndex >= 0) {
      const face = topology.faces[faceIndex];
      const pick: EntityPick = { kind: 'face', node: info.node, mesh: info.meshIndex, index: faceIndex };
      if (face.type === 'plane' && face.normal && face.origin) {
        const normal = v3(face.normal)!.normalize();
        // tool_frames.py: a planar face's frame origin is the model origin projected onto its plane.
        const origin = normal.clone().multiplyScalar(normal.dot(v3(face.origin)!));
        return { ref, kind: 'face', type: 'plane', origin, z: normal, face, pick, matrix, describe: 'Planar face — axis from its normal; origin is the model origin projected onto it' };
      }
      return { ref, kind: 'face', type: face.type, origin: null, z: null, face, pick, matrix, describe: `${face.type[0].toUpperCase()}${face.type.slice(1)} face — no axis (pick an edge, plane or axis)` };
    }
    const edges = topology.edges as (TopologyEdge & { ref?: string | null })[];
    const edgeIndex = edges.findIndex((edge) => edge.ref === ref || (ref.startsWith('edge(') && !!edge.ref?.startsWith(`${ref}[`)));
    if (edgeIndex >= 0) {
      const edge = topology.edges[edgeIndex];
      const pick: EntityPick = { kind: 'edge', node: info.node, mesh: info.meshIndex, index: edgeIndex };
      if (edge.type === 'circle' && edge.center && edge.normal) {
        return { ref, kind: 'edge', type: 'circle', origin: v3(edge.center), z: v3(edge.normal)!.normalize(), edge, pick, matrix, describe: `Circular edge Ø${Number((2 * (edge.radius ?? 0)).toFixed(3))} — origin at its centre, axis along its normal` };
      }
      if (edge.type === 'line' && edge.points.length >= 6) {
        const p = edge.points;
        const start = new THREE.Vector3(p[0], p[1], p[2]), end = new THREE.Vector3(p[p.length - 3], p[p.length - 2], p[p.length - 1]);
        return { ref, kind: 'edge', type: 'line', origin: start, z: end.sub(start).normalize(), edge, pick, matrix, describe: 'Straight edge — origin at its start, axis along it' };
      }
      return { ref, kind: 'edge', type: edge.type, origin: null, z: null, edge, pick, matrix, describe: 'Curved edge — no axis' };
    }
    const vertexIndex = (topology as unknown as { vertex_refs?: (string | null)[] }).vertex_refs?.indexOf(ref) ?? -1;
    if (vertexIndex >= 0) {
      return { ref, kind: 'vertex', type: 'point', origin: v3(topology.vertices[vertexIndex]), z: null, pick: { kind: 'vertex', node: info.node, mesh: info.meshIndex, index: vertexIndex }, matrix, describe: 'Vertex — origin only (add an axis)' };
    }
  }
  return null;
}

function rootMatrix(): THREE.Matrix4 {
  const model = viewer.model;
  const object = model?.faces[0] ? model.frameFor((model.faces[0].userData.face as { node: string }).node, (model.faces[0].userData.face as { meshIndex: number }).meshIndex) : undefined;
  if (!object) return new THREE.Matrix4();
  object.updateWorldMatrix(true, false);
  return object.matrixWorld.clone();
}

export interface Preview { origin: THREE.Vector3; z: THREE.Vector3; matrix: THREE.Matrix4; problems: string[]; notes: string[] }

/** The frame a slot resolves to, mirroring resolve_frame (origin from `origin` or the reference, axis from `axis` or the reference). */
export function previewSlot(slot: Slot | undefined): Preview | null {
  if (!slot?.reference) return null;
  const base = entityFor(slot.reference);
  const axis = slot.axis ? entityFor(slot.axis) : base;
  const originEntity = slot.origin ? entityFor(slot.origin) : base;
  const problems: string[] = [], notes: string[] = [];
  if (!base) notes.push(`“${slot.reference}” isn’t on screen (a construction point, plane or axis); the server resolves it.`);
  if (!axis || !originEntity) return null;
  if (!axis.z) { problems.push('This reference has no axis: add an axis (a circular edge, plane or axis).'); return null; }
  if (!originEntity.origin) { problems.push('This reference has no single origin point.'); return null; }
  const z = axis.z.clone().multiplyScalar(slot.reverse ? -1 : 1);
  return { origin: originEntity.origin.clone(), z, matrix: (base ?? originEntity).matrix, problems, notes };
}

/** Advice the backend would otherwise return as a failed job: wrong +Z, frames not coaxial, mouth above the gauge. */
export function frameAdvice(kind: ToolKind, frames: Partial<Record<FrameKey, Slot>>): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  const model = viewer.model;
  if (kind === 'rotary_cutter') {
    const tip = previewSlot(frames.tip);
    const com = model?.topologyFor(entityFor(frames.tip?.reference ?? '')?.pick?.mesh ?? 0)?.center_of_mass;
    if (tip && com && v3(com)!.sub(tip.origin).dot(tip.z) < 0) out.push({ field: 'frames.tip', message: 'The body lies toward −Z: flip +Z so it points from the tip into the shank.' });
    return out;
  }
  const machine = previewSlot(frames.machine_side), tool = previewSlot(frames.tool_side);
  if (!machine || !tool) return out;
  if (machine.z.dot(tool.z) < 1 - 1e-6) out.push({ field: 'frames.tool_side', message: tool.z.dot(machine.z) < -1 + 1e-6 ? 'The mouth’s +Z points the other way: flip it so both point toward the spindle.' : 'These frames aren’t on one axis.' });
  else {
    const offset = tool.origin.clone().sub(machine.origin);
    const along = offset.dot(machine.z);
    if (offset.clone().sub(machine.z.clone().multiplyScalar(along)).length() > 1e-4) out.push({ field: 'frames.tool_side', message: 'The mouth’s origin is off the gauge face’s axis. Pick circular edges (their centres lie on the axis) rather than planar faces.' });
    else if (along > 1e-6) out.push({ field: 'frames.machine_side', message: 'The mouth lies toward +Z of the gauge face: flip both frames so +Z points into the spindle.' });
  }
  return out;
}

// ── Smooth tips: a construction point at the axis extreme ────────────────────

/** For a ball or bull-nose face: where its tip lies on the axis (or why it can't be found). */
export function smoothTip(slot: Slot | undefined): { point: THREE.Vector3; axisRef: string | null; reverse: boolean; face: string } | string | null {
  if (!slot?.reference) return null;
  const entity = entityFor(slot.reference);
  if (!entity?.face || !['sphere', 'torus'].includes(entity.face.type)) return null;
  const face = entity.face;
  const center = v3(face.origin)!;
  const axisEntity = slot.axis ? entityFor(slot.axis) : null;
  const axis = axisEntity?.z?.clone() ?? v3(face.axis)?.normalize();
  if (!axis) return 'Pick an axis first (a circular edge on the shank).';
  const com = v3(viewer.model?.topologyFor(entity.pick!.mesh)?.center_of_mass);
  // +Z points from the tip into the body: the tip is the extreme on the side away from the body's centre of mass.
  const sign = com && com.clone().sub(center).dot(axis) < 0 ? -1 : 1;
  const z = axis.clone().multiplyScalar(sign);
  const reach = face.type === 'sphere' ? face.radius ?? 0 : face.minor_radius ?? 0;
  const point = center.clone().addScaledVector(z, -reach);
  const datum = Object.entries(DATUM_AXES).find(([, d]) => Math.abs(Math.abs(new THREE.Vector3(...d).dot(axis)) - 1) < 1e-9 && center.clone().sub(new THREE.Vector3(...d).multiplyScalar(center.dot(new THREE.Vector3(...d)))).length() < 1e-6);
  const axisRef = slot.axis ?? datum?.[0] ?? null;
  const axisZ = slot.axis ? axisEntity!.z! : datum ? new THREE.Vector3(...datum[1]) : z;
  return { point, axisRef, reverse: axisZ.dot(z) < 0, face: face.type };
}

const round = (value: number) => Number(value.toFixed(6));

/** Writes `model.point(...)` at the smooth tip into the open part, regenerates and saves it, then uses it as the tip. */
export async function addTipPoint(frame: FrameKey = 'tip') {
  const tip = smoothTip(get().frames[frame]);
  if (!tip || typeof tip === 'string') return;
  const { setCode, updateModel, saveDocument } = await import('@/state/actions');
  set({ busy: 'tip' });
  try {
    const code = app().doc.code;
    const doc = await parseModel(code);
    const id = doc.features.some((f) => f.id === 'tool_tip') ? nextId(doc, 'tool_tip') : 'tool_tip';
    const variable = app().modeling?.model?.variable ?? 'model';
    const text = `${variable}.point(${pyString(id)}, at=(${round(tip.point.x)}, ${round(tip.point.y)}, ${round(tip.point.z)}), name=${pyString('Tool tip')})`;
    setCode(insertFeature(code, doc, text));
    await updateModel({ quiet: true });
    if (app().phase === 'failed') throw new Error('The part didn’t rebuild with the tip point.');
    if (!await saveDocument()) throw new Error('The part wasn’t saved.');
    const saved = app().doc.saved!;
    set({ revision: saved.revision, documentId: saved.id });
    updateSlot(frame, { reference: id, axis: tip.axisRef, origin: null, reverse: tip.reverse });
    if (!tip.axisRef) set({ target: { frame, part: 'axis' } });
    if (get().kind === 'rotary_cutter' && get().fields.cutter_type === 'flat_end_mill') setField('cutter_type', tip.face === 'sphere' ? 'ball_end_mill' : 'bull_end_mill');
    toast('success', 'Tip point added', `${id} at the ${tip.face === 'sphere' ? 'ball' : 'corner'}’s axis extreme · part revision ${saved.revision}${tip.axisRef ? '' : '. Now pick the axis.'}`);
  } catch (error) {
    set({ problem: (error as Error).message });
  } finally { set({ busy: null }); }
}

// ── Saving ───────────────────────────────────────────────────────────────────

const number = (text: string | undefined) => (text === undefined || text.trim() === '' ? null : Number(text));

function selectionOf(slot: Slot | undefined): FrameSelection | null {
  if (!slot?.reference) return null;
  if (!slot.axis && !slot.origin && !slot.reverse) return slot.reference;
  return { reference: slot.reference, ...(slot.axis ? { axis: slot.axis } : {}), ...(slot.origin ? { origin: slot.origin } : {}), ...(slot.reverse ? { reverse_z: true } : {}) };
}

export function definitionOf(state: FromPartState = get()): Record<string, unknown> {
  const f = state.fields;
  const source: ToolGeometrySource = {
    version: 1, document_id: state.documentId!, revision: state.revision!, branch: 'main', body: state.body ?? '',
    frames: Object.fromEntries(FRAME_KEYS[state.kind].map((key) => [key, selectionOf(state.frames[key])])),
  };
  const common: Record<string, unknown> = {
    ...(state.editing?.definition ?? {}), version: 1, kind: state.kind, name: f.name?.trim() || 'Untitled', manufacturer: f.manufacturer ?? '', product_code: f.product_code ?? '',
    dimension_source: f.dimension_source, max_rpm: number(f.max_rpm), mass_kg: number(f.mass_kg), geometry_source: source,
  };
  if (state.kind === 'rotary_cutter') {
    source.cutting_length_mm = number(f.cutting_length_mm);
    for (const key of ['diameter_mm', 'cutting_length_mm', 'overall_length_mm', 'shank_diameter_mm', 'neck_diameter_mm', 'corner_radius_mm', 'included_angle_rad', 'tip_diameter_mm']) delete common[key];
    return { ...common, neck_length_mm: 0, cutter_type: f.cutter_type, flute_count: Number(f.flute_count), hand: f.hand, center_cutting: f.center_cutting === 'true', material: f.material || 'carbide' };
  }
  const bore = number(f.clamp_bore_mm), depth = number(f.engagement_depth_mm);
  if (bore !== null || depth !== null) { source.clamp_bore_mm = bore; source.engagement_depth_mm = depth; }
  const limits = ['min_diameter_mm', 'max_diameter_mm', 'min_engagement_mm', 'max_engagement_mm'].map((key) => [key, number(f[`clamp_${key}`])] as const);
  delete common.output_frame; delete common.outer_profile;
  return {
    ...common, component_type: f.component_type, input_interface: f.input_interface, output_interface: f.output_interface,
    clamp: limits.some(([, value]) => value !== null) ? Object.fromEntries(limits) : null,
  };
}

/** Backend field paths → the tool's field keys (frames focus their slot). */
export function fieldKey(path: string): string {
  const clean = path.replace(/^(body\.)?definition\.(rotary_cutter|tool_holder)\./, '').replace(/^definition\./, '');
  const frame = /geometry_source\.frames\.(tip|machine_side|tool_side)/.exec(clean);
  if (frame) return `frames.${frame[1]}`;
  if (/geometry_source\.frames/.test(clean)) return `frames.${FRAME_KEYS[get().kind][0]}`;
  const clamp = /^clamp\.(\w+)/.exec(clean);
  if (clamp) return `clamp_${clamp[1]}`;
  const own = clean.replace(/^geometry_source\./, '');
  // A reference name from a failed job (tool_frame_reference): the slot that uses it.
  for (const [key, slot] of Object.entries(get().frames)) if (slot && [slot.reference, slot.axis, slot.origin].includes(own)) return `frames.${key}`;
  return own === 'body' ? 'frames.' + FRAME_KEYS[get().kind][0] : own;
}

export async function saveFromPart() {
  const state = get();
  const missing = FRAME_KEYS[state.kind].find((key) => !state.frames[key]?.reference);
  if (!state.documentId || !state.revision || !state.body) { set({ problem: 'Pick the frames on the part first.', focus: `frames.${FRAME_KEYS[state.kind][0]}` }); return null; }
  if (missing) { set({ errors: { ...state.errors, [`frames.${missing}`]: 'Pick this frame.' }, focus: `frames.${missing}`, problem: 'Pick every frame first.' }); return null; }
  if (state.kind === 'rotary_cutter' && !number(state.fields.cutting_length_mm)) {
    set({ errors: { ...state.errors, cutting_length_mm: 'The fluted length from the tip, from the catalog or measured.' }, focus: 'cutting_length_mm', problem: 'Add the cutting length.' });
    return null;
  }
  set({ busy: 'save', problem: null, errors: {} });
  const definition = definitionOf();
  try {
    const saved = state.editing
      ? await library.edit(state.editing, definition, false, requestKey(`edit-${state.kind}`))
      : await library.create(definition, requestKey(`create-${state.kind}`));
    await loadLibrary();
    toast('success', state.editing ? 'Saved' : 'Created', `${saved.definition.name} · revision ${saved.revision}. Resolve its geometry next.`);
    set({ open: false, target: null, busy: null });
    useLibraryIntent.setState({ tab: 'geometry' });
    openLibrary(state.kind, saved.id);
    return saved;
  } catch (error) {
    if (error instanceof MfgError && error.status === 409 && state.editing) {
      const latest = await library.get(state.editing.id).catch(() => null);
      set({ busy: null, problem: `Revision ${latest?.revision ?? '?'} of this record was saved after the one you started from (${state.editing.revision}). Your picks are kept: save again to put them on top.`, editing: latest ?? state.editing });
      return null;
    }
    const errors: Record<string, string> = {};
    if (error instanceof MfgError) for (const field of error.fields) errors[fieldKey(field.path)] = field.message;
    set({ busy: null, errors, focus: Object.keys(errors)[0] ?? null, problem: error instanceof MfgError ? `${error.message}` : (error as Error).message });
    return null;
  }
}

/** Which tab the library opens on next (the From-part tool lands on Geometry). */
export const useLibraryIntent = create<{ tab: string | null }>(() => ({ tab: null }));

export const bodiesOfOpenPart = () => bodyIds(app().displayed);

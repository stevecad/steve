import type * as THREE from 'three';
import type { Build } from '@/lib/api';
import { bodyOrder, componentBodyOrder } from '@/lib/bodyOrder';
import { modelingReport, type DesignResult, type ModelDoc, type ModelingResult } from '@/lib/modeling';
import { get, type EntityPick, type Pick } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import type { FaceInfo, ModelRuntime } from '@/viewport/model';

/**
 * Bodies of a displayed part. The runtime exports `model.bodies` in order as one mesh and each
 * body's faces in order (docs/MODELING.md section 4), so a face's primitive index tells its body.
 */
export const modelingOf = (build: Build | null | undefined) => modelingReport(build?.metadata, get().doc.activeFile);

/** What a build did for one move feature (the runtime's `detail`): the transform it shows. */
export interface MoveDetail { bodies: string[]; translate: [number, number, number]; axis: number[] | null; angle: number; copies?: string[] }

export function moveDetail(build: Build | null | undefined, id: string): MoveDetail | null {
  const feature = modelingOf(build)?.features.find((f) => f.id === id && f.kind === 'move' && f.status === 'ok');
  return (feature?.detail as MoveDetail | undefined) ?? null;
}

/** Body ids in export order (`bodyOrder`). */
export const bodyIds = (build: Build | null | undefined): string[] => bodyOrder(modelingOf(build));

function ranges(build: Build): [string, number, number][] {
  const out: [string, number, number][] = [];
  const bodies = modelingOf(build)?.bodies ?? {};
  let start = 0;
  for (const id of bodyIds(build)) {
    out.push([id, start, start + bodies[id].faces]);
    start += bodies[id].faces;
  }
  return out;
}

const bodyAt = (table: [string, number, number][], face: number) => table.find(([, from, to]) => face >= from && face < to)?.[0] ?? null;

export const designOf = (build: Build | null | undefined) => (build?.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design ?? null;

/** Designs: the component whose file is open, whose bodies the browser and body tools work on. */
export function editedComponent(build: Build | null | undefined): string | null {
  const design = designOf(build);
  return design ? Object.entries(design.components).find(([, component]) => component.file === get().doc.activeFile)?.[0] ?? null : null;
}

/**
 * Whether a viewport node shows `component`'s bodies (by default the edited one). A part's nodes always do; in a
 * design, face indices restart in every placed instance, so only that component's instances count.
 */
function inScope(model: ModelRuntime, node: string, component = editedComponent(model.build)): boolean {
  if (model.build.kind === 'part') return true;
  const instance = model.instanceOf(node);
  return !!component && !!instance && !instance.link && instance.component === component;
}

/** The face a face, edge or vertex pick is on (an edge's or vertex's first adjacent face). */
function faceOfPick(model: ModelRuntime, pick: EntityPick): number | undefined {
  const topology = model.topologyFor(pick.mesh);
  return pick.kind === 'face' ? pick.index
    : pick.kind === 'edge' ? topology?.edges[pick.index]?.faces?.[0]
      : topology?.edges.find((edge) => edge.vertices?.includes(pick.index))?.faces?.[0];
}

/** The bodies a pick belongs to:a face's, an edge's or vertex's (through an adjacent face), or all of a component's.
 *  Copies shown by the move being edited (`feature`) stand for the bodies they copy. */
export function bodiesOfPick(pick: Pick, model: ModelRuntime | null = viewer.model, feature?: string): string[] {
  if (!model || !inScope(model, pick.node)) return [];
  if (pick.kind === 'component') return bodyIds(model.build);
  const face = faceOfPick(model, pick);
  const body = face === undefined ? null : bodyAt(ranges(model.build), face);
  const detail = feature ? moveDetail(model.build, feature) : null;
  const copied = body && detail?.copies ? detail.copies.indexOf(body) : -1;
  return body ? [copied >= 0 ? detail!.bodies[copied] : body] : [];
}

export const selectedBodies = () => [...new Set(get().selection.flatMap((pick) => bodiesOfPick(pick)))];

/** A component's body face ranges in its exported mesh (bodies in export order, faces in order). */
function componentTable(summary: ModelingResult | null | undefined): [string, number, number][] {
  const out: [string, number, number][] = [];
  let start = 0;
  for (const id of componentBodyOrder(summary)) { const faces = summary!.bodies[id].faces; out.push([id, start, start + faces]); start += faces; }
  return out;
}

/** Designs: the body of `component` (open or not) that a face, edge or vertex of one of its placed instances is on. */
export function componentBodyOfPick(pick: Pick, component: string, model: ModelRuntime | null = viewer.model): string | null {
  if (!model || pick.kind === 'component' || !inScope(model, pick.node, component)) return null;
  const face = faceOfPick(model, pick);
  return face === undefined ? null : bodyAt(componentTable(designOf(model.build)?.components[component]), face);
}

/** Face meshes of each body:a part's, or in a design the edited component's (or `component`'s), across its instances. */
export function bodyFaces(model: ModelRuntime, component?: string): Map<string, THREE.Mesh[]> {
  const design = model.build.kind !== 'part';
  const scope = component ?? (design ? editedComponent(model.build) : null);
  const table = design ? componentTable(scope ? designOf(model.build)?.components[scope] : null) : ranges(model.build);
  const out = new Map<string, THREE.Mesh[]>(table.map(([id]) => [id, []]));
  if (design && !scope) return out;
  for (const mesh of model.faces) {
    const face = mesh.userData.face as FaceInfo;
    if (design && !inScope(model, face.node, scope!)) continue;
    const body = bodyAt(table, face.faceIndex);
    if (body) out.get(body)!.push(mesh);
  }
  return out;
}

/** Face picks of bodies (of `component` in a design, else the edited one), keyed `mesh:face` too (hiding bodies in the view). */
export function bodyPicks(model: ModelRuntime, bodies: string[], component?: string): Pick[] {
  const faces = bodyFaces(model, component);
  return bodies.flatMap((body) => (faces.get(body) ?? []).flatMap((mesh) => model.facesOf(mesh)).map((face): Pick =>
    ({ kind: 'face', node: face.node, mesh: face.meshIndex, index: face.faceIndex })));
}

export const faceKeys = (picks: Pick[]) => new Set(picks.map((pick) => (pick.kind === 'face' ? `${pick.mesh}:${pick.index}` : '')).filter(Boolean));

/** The feature a persistent face name comes from: `extrude_1.side(r1.left)` → `extrude_1`. */
export const featureOfRef = (ref: string | null | undefined) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(ref ?? '')?.[0] ?? null;

/** Faces a feature made (by provenance), in the part or the edited component's instances: the code ↔ model link. */
export function featureFacePicks(model: ModelRuntime, feature: string): Pick[] {
  const out: Pick[] = [];
  for (const face of model.allFaces()) {  // Merged huge parts expanded into their faces.
    if (!inScope(model, face.node)) continue;
    if (featureOfRef(model.topologyFor(face.meshIndex)?.faces[face.faceIndex]?.ref) === feature) {
      out.push({ kind: 'face', node: face.node, mesh: face.meshIndex, index: face.faceIndex });
    }
  }
  return out;
}

/** The feature that made a picked face (an edge or vertex: through an adjacent face), or null. */
export function featureOfPick(pick: Pick, model: ModelRuntime | null = viewer.model): string | null {
  if (!model || pick.kind === 'component' || !inScope(model, pick.node)) return null;
  const topology = model.topologyFor(pick.mesh);
  const face = pick.kind === 'face' ? pick.index
    : pick.kind === 'edge' ? topology?.edges[pick.index]?.faces?.[0]
      : topology?.edges.find((edge) => edge.vertices?.includes(pick.index))?.faces?.[0];
  return face === undefined ? null : featureOfRef(topology?.faces[face]?.ref);
}

/**
 * What people call a body: its `model.body_name(...)` (docs/MODELING.md section 4), else the feature
 * that made it; split pieces and move copies say where they came from.
 */
export function bodyLabel(id: string, doc: ModelDoc | null, report?: ModelingResult | null): string {
  const named = [...(doc?.body_names ?? [])].reverse().find((entry) => entry.body === id && entry.name)?.name ?? report?.bodies[id]?.name;
  if (named) return named;
  const features = doc?.features ?? [];
  const own = features.find((f) => f.id === id);
  if (own) return own.name;
  const piece = /^(.+)_(\d+)$/.exec(id);
  const split = piece && features.find((f) => f.id === piece[1] && f.kind === 'split');
  if (split) return `${split.name} ${piece![2]}`;
  const move = features.find((f) => f.kind === 'move' && f.id && id.endsWith(`_${f.id}`) && id.length > f.id.length + 1);
  if (move) return `${bodyLabel(id.slice(0, -move.id!.length - 1), doc, report)} copy`;
  return id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** Body ids from a `bodies` source: `["a", "b"]` or a single `"a"`. */
export function bodyList(source: string | undefined): string[] {
  if (!source?.trim()) return [];
  try {
    const value = JSON.parse(source.replace(/'/g, '"'));
    return Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [];
  } catch { return []; }
}

/** Top-level items of a Python tuple or list source: `(a, (1, 2), "x")` → `a`, `(1, 2)`, `"x"`. */
export function splitTuple(source: string): string[] | null {
  const text = source.trim();
  if (!/^[([]/.test(text) || !/[)\]]$/.test(text)) return null;
  const parts: string[] = [];
  let depth = 0, quote = '', current = '';
  for (const char of text.slice(1, -1)) {
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    if (char === ',' && depth === 0 && !quote) { parts.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

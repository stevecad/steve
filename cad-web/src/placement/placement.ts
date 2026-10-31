/**
 * Placing an instance in a design: drag it on the canvas (or type its position and turn), and the
 * Place tool writes `at=(…)` into the `design.add(…)` call that made it in main.py. Linking a part
 * and inserting an import open it straight away, so a new part is placed where it belongs.
 */
import * as THREE from 'three';
import { create } from 'zustand';
import { get, set, toast } from '@/state/store';
import { openFile, setCode, updateModel } from '@/state/actions';
import { MAIN, filesOf } from '@/state/design';
import { pretty } from '@/lib/format';
import { viewer } from '@/viewport/viewer';
import type { DesignResult } from '@/lib/modeling';

export interface PlacementDraft {
  /** The instance being placed (its name in main.py's design). */
  instance: string | null;
  /** Its placement: translation (mm) and a rotation (axis, degrees), as `at=` writes it. */
  position: [number, number, number];
  axis: [number, number, number];
  angle: number;
  error: string | null;
  /** Bumped when the placement changes other than by dragging (the handle re-centres). */
  nonce: number;
}

export const usePlacement = create<PlacementDraft>(() => ({ instance: null, position: [0, 0, 0], axis: [0, 0, 1], angle: 0, error: null, nonce: 0 }));

/** A typed change (panel fields): applied and shown at once. */
export function setPlacement(change: Partial<Pick<PlacementDraft, 'position' | 'axis' | 'angle'>>) {
  usePlacement.setState((state) => ({ ...change, nonce: state.nonce + 1, error: null }));
  previewPlacement();
}

const instances = () => ((get().displayed?.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design?.instances ?? []) as { name: string; component: string; at: unknown; link?: boolean }[];

/** The viewport node of an instance (the document's children are named after them). */
export function instanceNode(instance: string): string | null {
  const model = viewer.model;
  if (!model) return null;
  return model.tree[model.rootId]?.children.find((id) => model.tree[id].name === pretty(instance)) ?? null;
}

/**
 * An instance's placement (its cq.Location in the design frame). CadQuery's glTF puts the Z-up → Y-up turn
 * on a node above the instances, which the viewer's root turns back, so an instance node's world matrix is
 * its placement.
 */
export function placementMatrix(instance: string): THREE.Matrix4 | null {
  const node = instanceNode(instance);
  const object = node ? viewer.model?.objects.get(node) : undefined;
  if (!object) return null;
  object.updateWorldMatrix(true, false);
  return object.matrixWorld.clone();
}

function placementOf(instance: string): Pick<PlacementDraft, 'position' | 'axis' | 'angle'> {
  const matrix = placementMatrix(instance);
  return matrix ? decompose(matrix) : { position: [0, 0, 0], axis: [0, 0, 1], angle: 0 };
}

const clean = (value: number) => (Math.abs(value) < 1e-7 ? 0 : Number(value.toFixed(6)));

export function decompose(matrix: THREE.Matrix4): Pick<PlacementDraft, 'position' | 'axis' | 'angle'> {
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(quaternion.w)));
  const s = Math.sqrt(Math.max(0, 1 - quaternion.w * quaternion.w));
  const sign = quaternion.w < 0 ? -1 : 1;
  const degrees = THREE.MathUtils.radToDeg(angle);
  // Float noise in an unturned placement reads as a hair of rotation: below a thousandth of a degree it is none.
  if (s < 1e-6 || degrees < 1e-3) return { position: position.toArray().map(clean) as [number, number, number], axis: [0, 0, 1], angle: 0 };
  const axis = [sign * quaternion.x / s, sign * quaternion.y / s, sign * quaternion.z / s].map(clean) as [number, number, number];
  return { position: position.toArray().map(clean) as [number, number, number], axis, angle: Number(degrees.toFixed(4)) };
}

/** The placement as a world matrix (rotation about the origin, then the translation: cq.Location). */
export function composePlacement(draft: Pick<PlacementDraft, 'position' | 'axis' | 'angle'>): THREE.Matrix4 {
  const rotation = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(...draft.axis).normalize(), THREE.MathUtils.degToRad(draft.angle));
  return new THREE.Matrix4().makeTranslation(...draft.position).multiply(rotation);
}

export function openPlacement(instance?: string) {
  const state = get();
  if (state.doc.kind !== 'design') { toast('warning', 'Placing belongs to designs', 'Open a design to place its components and linked parts.'); return; }
  const target = instance ?? state.selection.map((pick) => instanceOfNode(pick.node)).find((name): name is string => !!name);
  if (!target) { toast('info', 'Pick an instance', 'Select a component or linked part in the viewport, then Place.'); return; }
  const code = mainCode();
  const problem = /\bDesign\(/.test(code) ? callFor(code, target).error : 'This design builds its own cq.Assembly: its parts are placed with loc= in main.py (Source).';
  usePlacement.setState((state) => ({ instance: target, ...placementOf(target), error: problem, nonce: state.nonce + 1 }));
  set({ tool: 'place', selection: [] });  // Its options open in the Dock (shell/toolDock.ts).
}

export function closePlacement() {
  if (get().tool === 'place') set({ tool: 'select' });
  // The preview moved the node; the shown build is still where it was.
  const { instance } = usePlacement.getState();
  const node = instance ? instanceNode(instance) : null;
  const object = node ? viewer.model?.objects.get(node) : undefined;
  const rest = object?.userData.placementRest as THREE.Matrix4 | undefined;
  if (object && rest) { rest.decompose(object.position, object.quaternion, object.scale); delete object.userData.placementRest; viewer.invalidate(); }
  usePlacement.setState({ instance: null, error: null });
}

export function instanceOfNode(node: string): string | null {
  const model = viewer.model;
  if (!model) return null;
  let current = model.tree[node];
  while (current?.parent && current.parent !== model.rootId) current = model.tree[current.parent];
  return instances().find((item) => current && pretty(item.name) === current.name)?.name ?? null;
}

/** Shows the draft on the canvas: the instance's node moves (the build updates when the placement is applied). */
export function previewPlacement() {
  const { instance, ...draft } = usePlacement.getState();
  const node = instance ? instanceNode(instance) : null;
  const object = node ? viewer.model?.objects.get(node) : undefined;
  const model = viewer.model;
  if (!object || !object.parent || !model) return;
  if (!object.userData.placementRest) object.userData.placementRest = object.matrix.clone();
  object.parent.updateWorldMatrix(true, false);
  // World = placement (see placementMatrix); local = parent⁻¹ · world.
  const local = new THREE.Matrix4().copy(object.parent.matrixWorld).invert().multiply(composePlacement(draft));
  local.decompose(object.position, object.quaternion, object.scale);
  object.updateMatrixWorld(true);
  viewer.invalidate();
}

function mainCode(): string {
  const { doc } = get();
  return doc.activeFile === MAIN ? doc.code : filesOf(doc)[MAIN] ?? '';
}

/** Where a call that opens at `open` (its "(") ends, skipping strings. */
function callEnd(code: string, open: number): number {
  let depth = 0, quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return code.length;
}

/** The `design.add(…)` call that made an instance: the runtime's naming (name=, else the component or link, then _2, _3…). */
export function callFor(code: string, instance: string): { from: number; to: number; open: number; error: string | null } {
  const used = new Set<string>();
  for (const match of code.matchAll(/^[ \t]*\w+\.(add|pattern)\(/gm)) {
    const open = match.index! + match[0].length - 1;
    const to = callEnd(code, open);
    const inner = code.slice(open + 1, to - 1);
    const name = /\bname\s*=\s*["']([^"']+)["']/.exec(inner)?.[1];
    const base = name ?? /^\s*([A-Za-z_]\w*)/.exec(inner)?.[1] ?? '';
    if (match[1] === 'pattern') {
      const count = Number(/\bcount\s*=\s*(\d+)/.exec(inner)?.[1] ?? /,\s*(\d+)/.exec(inner)?.[1] ?? 0);
      for (let i = 1; i <= count; i++) used.add(`${base}_${i}`);
      if (new RegExp(`^${base}_\\d+$`).test(instance)) return { from: match.index!, to, open, error: `${instance} is one of the pattern ${base}: place the whole pattern with its at= in main.py.` };
      continue;
    }
    let made = base;
    for (let n = 2; used.has(made); n++) made = `${base}_${n}`;
    used.add(made);
    if (made === instance) return { from: match.index!, to, open, error: null };
  }
  return { from: -1, to: -1, open: -1, error: `Couldn’t find the design.add(…) that places ${instance} in main.py.` };
}

const num = (value: number) => String(Number(value.toFixed(4)) || 0);

/** `at=` for a placement: `(x, y, z)`, or `((x, y, z), (axis, degrees))` with "X"/"Y"/"Z" when the axis is one. */
export function atSource(draft: Pick<PlacementDraft, 'position' | 'axis' | 'angle'>): string {
  const position = `(${draft.position.map(num).join(', ')})`;
  if (Math.abs(draft.angle) < 1e-3) return position;
  const axis = new THREE.Vector3(...draft.axis).normalize();
  const named = (['X', 'Y', 'Z'] as const).find((_, i) => Math.abs(Math.abs(axis.getComponent(i)) - 1) < 1e-6);
  if (named) {
    const sign = Math.sign(axis.getComponent('XYZ'.indexOf(named)));
    return `(${position}, ("${named}", ${num(draft.angle * sign)}))`;
  }
  return `(${position}, ((${axis.toArray().map(num).join(', ')}), ${num(draft.angle)}))`;
}

/** Writes the placement into main.py and regenerates. */
export async function applyPlacement() {
  const draft = usePlacement.getState();
  if (!draft.instance) return;
  const code = mainCode();
  const call = callFor(code, draft.instance);
  if (call.error) { usePlacement.setState({ error: call.error }); return; }
  const inner = code.slice(call.open + 1, call.to - 1);
  const at = `at=${atSource(draft)}`;
  const replaced = /\bat\s*=/.test(inner)
    ? replaceKeyword(inner, 'at', atSource(draft))
    : `${inner.replace(/\s+$/, '')}, ${at}`;
  const next = code.slice(0, call.open + 1) + replaced + code.slice(call.to - 1);
  const instance = draft.instance;
  closePlacement();
  openFile(MAIN);
  setCode(next);
  await updateModel();
  toast('success', `Placed ${instance}`, `main.py: ${at}`);
}

/** Replaces the value of keyword `key` in a call's arguments (the value may span brackets). */
function replaceKeyword(inner: string, key: string, value: string): string {
  const match = new RegExp(`\\b${key}\\s*=\\s*`).exec(inner);
  if (!match) return inner;
  const start = match.index + match[0].length;
  let depth = 0, quote: string | null = null, end = inner.length;
  for (let i = start; i < inner.length; i++) {
    const c = inner[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { end = i; break; }
  }
  return inner.slice(0, start) + value + inner.slice(end);
}

/**
 * The Joint tool: pick a parent and a child instance and the axis (a face or edge on either, or a
 * datum axis), set limits and an optional drive, and it writes `design.<type>(…)` into main.py.
 */
import { create } from 'zustand';
import { get, set, toast, type Pick } from '@/state/store';
import { updateModel } from '@/state/actions';
import { componentOfNode } from '@/state/designRefs';
import { viewer } from '@/viewport/viewer';
import { designInstances, instanceOfNode } from './instances';
import { freeJointName, jointCall, jointNameProblem, writeJoint, type JointSpec } from './code';
import type { JointType } from './kinematics';
import { selectJoint } from './state';
import { motionToolPick, motionToolPicking } from './motionTool';

export type Slot = 'parent' | 'child' | 'axis';
export interface AxisChoice { source: string; component: string | null; label: string }

export interface JointDraft {
  editing: string | null;
  name: string;
  type: JointType;
  parent: string;
  child: string;
  axis: AxisChoice | null;
  /** The slot the next viewport click fills. */
  slot: Slot | null;
  limits: [number, number] | null;
  slideLimits: [number, number] | null;
  drive: { speed: number | null; check?: boolean } | null;
  error: string | null;
}

const EMPTY: JointDraft = { editing: null, name: 'hinge', type: 'revolute', parent: '', child: '', axis: null, slot: 'parent', limits: null, slideLimits: null, drive: null, error: null };

export const useJointTool = create<JointDraft>(() => EMPTY);

export const DATUM_AXES: AxisChoice[] = (['X', 'Y', 'Z'] as const).map((axis) => ({ source: JSON.stringify(axis), component: null, label: `${axis} axis` }));

const BASE_NAME: Record<JointType, string> = { revolute: 'hinge', slider: 'slide', cylindrical: 'shaft', rigid: 'fixed' };

export { designInstances, instanceOfNode };

export function openJointTool(editing?: string, type: JointType = 'revolute') {
  const state = get();
  if (state.doc.kind !== 'design') { toast('warning', 'Joints belong to designs', 'Open or create a design, place two components, then add a joint.'); return; }
  const instances = designInstances();
  if (instances.length < 2) { toast('warning', 'Place two instances first', 'A joint connects two placed components or links.'); return; }
  const call = editing ? jointCall(editing) : null;
  if (call) {
    useJointTool.setState({
      ...EMPTY, editing: call.name, name: call.name, type: call.type, parent: call.parent, child: call.child, slot: null,
      axis: call.axis ? { source: call.axis, component: call.axisComponent ?? null, label: axisLabel(call.axis) } : null,
      limits: call.limits, slideLimits: call.slideLimits ?? null, drive: call.drive ?? null,
    });
    selectJoint(call.name);
  } else {
    // Start from what is selected: a component picked in the viewport becomes the child.
    const picked = state.selection.map((pick) => instanceOfNode(pick.node)).filter((name): name is string => !!name);
    const child = picked[0] ?? instances[1].name;
    const parent = picked[1] ?? instances.find((item) => item.name !== child)!.name;
    useJointTool.setState({ ...EMPTY, type, name: freeJointName(BASE_NAME[type]), parent, child, slot: type === 'rigid' ? null : 'axis' });
  }
  set({ tool: 'joint', selection: [] });  // Its options open in the Dock (shell/toolDock.ts).
}

export function closeJointTool() {
  if (get().tool === 'joint') set({ tool: 'select' });
  useJointTool.setState({ slot: null });
}

export function setJointType(type: JointType) {
  const draft = useJointTool.getState();
  const renamed = !draft.editing && draft.name === freeJointName(BASE_NAME[draft.type]) ? freeJointName(BASE_NAME[type]) : draft.name;
  useJointTool.setState({ type, name: renamed, limits: type === draft.type ? draft.limits : null, slideLimits: type === 'cylindrical' ? draft.slideLimits : null,
    drive: type === 'rigid' ? null : draft.drive, slot: type === 'rigid' && draft.slot === 'axis' ? null : draft.slot, error: null });
}

const axisLabel = (source: string) => {
  const match = /^([a-z][a-z0-9_]*)\.(face|edge|vertex|ref)\((["'])(.*)\3\)$/.exec(source);
  if (match) return `${match[1]} · ${match[4]}`;
  if (/^["'][XYZ]["']$/.test(source)) return `${source[1]} axis`;
  return source;
};

/** A face or edge as the joint's axis: `<component>.face("ref")`, named on whichever component it belongs to. */
export function axisFromPick(pick: Pick): AxisChoice | string {
  const model = viewer.model;
  if (!model || (pick.kind !== 'face' && pick.kind !== 'edge')) return 'Pick a face (a pin, a bore, a flat face) or an edge for the axis.';
  const topology = model.topologyFor(pick.mesh) as unknown as { faces?: { ref?: string; type?: string }[]; edges?: { ref?: string; type?: string }[] } | undefined;
  const item = pick.kind === 'face' ? topology?.faces?.[pick.index] : topology?.edges?.[pick.index];
  if (!item?.ref) return 'That geometry has no reference name yet. Regenerate the model, then pick it.';
  const component = componentOfNode(pick.node);
  if (!component) return 'Joint axes come from a component’s geometry; linked documents can’t be referenced yet. Pick a face on a component, or use a datum axis.';
  if (pick.kind === 'face' && item.type && !['cylinder', 'cone', 'plane'].includes(item.type)) return 'Pick a cylindrical face (its axis), a planar face (its normal), or a straight or circular edge.';
  const source = `${component}.${pick.kind}(${JSON.stringify(item.ref)})`;
  return { source, component, label: axisLabel(source) };
}

/** A viewport click while the tool is open fills the active slot (the motion tool's own slots when it is open). */
export function jointPick(pick: Pick | null): boolean {
  if (get().tool === 'motion') return motionToolPick(pick);
  const draft = useJointTool.getState();
  if (!draft.slot || !pick) return false;
  if (draft.slot === 'axis') {
    const axis = axisFromPick(pick);
    if (typeof axis === 'string') { useJointTool.setState({ error: axis }); return true; }
    useJointTool.setState({ axis, slot: null, error: null });
    set({ selection: [pick] });
    return true;
  }
  const instance = instanceOfNode(pick.node);
  if (!instance) { useJointTool.setState({ error: 'Pick a placed component.' }); return true; }
  const next = { ...draft, [draft.slot]: instance };
  useJointTool.setState({ [draft.slot]: instance, slot: draft.slot === 'parent' && !next.child ? 'child' : !next.axis && draft.type !== 'rigid' ? 'axis' : null, error: null });
  set({ selection: [{ kind: 'component', node: pick.node }] });
  return true;
}

/** What the viewport should pick for the active slot: whole components, or faces and edges. */
export function jointPicking(): 'component' | 'geometry' | null {
  if (get().tool === 'motion') return motionToolPicking();
  if (get().tool !== 'joint') return null;
  const slot = useJointTool.getState().slot;
  return slot === 'axis' ? 'geometry' : slot ? 'component' : null;
}

export function draftProblem(draft: JointDraft = useJointTool.getState()): string | null {
  const nameProblem = jointNameProblem(draft.name, draft.editing);
  if (nameProblem) return nameProblem;
  if (!draft.parent || !draft.child) return 'Pick the parent (it stays) and the child (it moves).';
  if (draft.parent === draft.child) return 'Parent and child must be different instances.';
  if (draft.type !== 'rigid' && !draft.axis) return 'Pick the axis: a pin or bore, a flat face (its normal), an edge, or a datum axis.';
  for (const limits of [draft.limits, draft.slideLimits]) if (limits && !(limits[0] < limits[1])) return 'Limits need min < max.';
  return null;
}

export async function commitJoint() {
  const draft = useJointTool.getState();
  const problem = draftProblem(draft);
  if (problem) { useJointTool.setState({ error: problem }); return; }
  const spec: JointSpec = { name: draft.name, type: draft.type, parent: draft.parent, child: draft.child, axis: draft.type === 'rigid' ? null : draft.axis!.source,
    axisComponent: draft.axis?.component ?? null, limits: draft.limits, slideLimits: draft.slideLimits, drive: draft.drive };
  writeJoint(spec, draft.editing ?? undefined);
  closeJointTool();
  selectJoint(draft.name);
  await updateModel();
}

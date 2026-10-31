/**
 * The Explode steps tool (Dock): authors a named exploded view, `design.explode(...)` in main.py, that the timeline
 * plays like an animation. Steps in order; each moves some parts (picked in the viewport or the browser) by a move
 * dragged with the arrows or typed; moves add up from step to step. Or Automatic: `auto=True` works the steps out from
 * the geometry at the build. The draft plays as it stands (motion/state.ts setDraft) before OK writes it.
 */
import { create } from 'zustand';
import * as THREE from 'three';
import { get, set, toast, useApp, type Pick as ViewPick } from '@/state/store';
import { updateModel } from '@/state/actions';
import { stored } from '@/state/design';
import { Api } from '@/lib/api';
import { viewer } from '@/viewport/viewer';
import type { DesignResult } from '@/lib/modeling';
import {
  EXPLODE_DURATION, EXPLODE_HOLD, explodeNamesInCode, animationNamesInCode, freeExplodeName, removeExplode, writeExplode, codeWithExplode, type ExplodeSpec,
} from './code';
import { kinematicsOf, type MotionExplode } from './kinematics';
import { instanceOfNode } from './instances';
import { nodeOfPath } from './PoseLayer';
import { seek, selectClip, setDraft, useMotion } from './state';

type Vec = [number, number, number];

export interface DraftStep {
  /** A stable key for the list while steps are reordered. */
  key: number;
  name?: string;
  /** Each part's move (mm, design frame): one shared move, or (from an automatic explode or screws out) each its own. */
  moves: Record<string, Vec>;
  /** Placed screws out along their axes, as written (their moves are the build's). Dragging turns it into plain moves. */
  out?: true | number;
  duration?: number;
  hold?: number;
}

export interface ExplodeTool {
  /** The explode being edited, by its name in main.py (null: a new one). */
  editing: string | null;
  name: string;
  /** Automatic: `auto=True`, the steps worked out at the build (shown, not edited, until written out as steps). */
  auto: boolean;
  gap: number | null;
  steps: DraftStep[];
  /** The step being edited (its parts get the arrows), or null. */
  active: number | null;
  loop: boolean;
  duration: number;
  hold: number;
  error: string | null;
  generating: boolean;
  easing: 'linear' | 'ease';
  initialSteps: string | null;
}

const BLANK: ExplodeTool = { editing: null, name: '', auto: false, gap: null, steps: [], active: null, loop: false, duration: EXPLODE_DURATION, hold: EXPLODE_HOLD, error: null, generating: false, easing: 'ease', initialSteps: null };
const stepValues = (steps: DraftStep[]) => JSON.stringify(steps.map(({ key: _key, ...step }) => step));

export const useExplodeTool = create<ExplodeTool>(() => BLANK);
const tool = useExplodeTool.getState;
let keys = 0;
let automaticRun = 0;
let automaticBuild: string | null = null;
function cancelAutomatic() {
  ++automaticRun;
  if (automaticBuild) void Api.cancelBuild(automaticBuild);
  automaticBuild = null;
  useExplodeTool.setState({ generating: false });
}

/** The draft as the timeline plays it: each step's start after the ones before have moved and held. */
export function draftExplode(draft: ExplodeTool = tool()): MotionExplode {
  let start = 0;
  const steps = draft.steps.map((step) => {
    const duration = step.duration ?? draft.duration;
    const hold = step.hold ?? draft.hold;
    const out = { name: step.name, start, duration, hold, moves: step.moves };
    start += duration + hold;
    return out;
  });
  return { name: draft.name || 'explode', steps, duration: Math.max(start, 1e-3), easing: draft.easing, loop: draft.loop, auto: draft.auto };
}

/** Applies a change to the draft and plays the result (keeping the playhead), or shows a step's end. */
function change(next: Partial<ExplodeTool>, showStep?: number | null) {
  useExplodeTool.setState({ error: null, ...next });
  const draft = draftExplode();
  setDraft(draft);
  const index = showStep === undefined ? null : showStep;
  if (index !== null && draft.steps[index]) seek(draft.steps[index].start + draft.steps[index].duration);
}
export const updateExplodeTool = (next: Partial<ExplodeTool>) => change(next);

const stepsOf = (explode: MotionExplode): DraftStep[] => explode.steps.map((step, index) => ({
  key: ++keys, name: step.name && step.name !== `step_${index + 1}` ? step.name : undefined, moves: Object.fromEntries(Object.entries(step.moves).map(([path, v]) => [path, [...v] as Vec])),
  ...(step.out ? { out: outOf(step.moves) } : {}),
  duration: step.duration, hold: step.hold,
}));

/** How a screws-out step is written back: the distance when every screw goes as far, else out=True (each its own length). */
function outOf(moves: Record<string, Vec>): true | number {
  const lengths = Object.values(moves).map((v) => Math.hypot(...v));
  return lengths.every((length) => Math.abs(length - lengths[0]) < 1e-6) ? lengths[0] : true;
}

export function openExplodeTool(editing?: string) {
  const state = get();
  if (state.doc.kind !== 'design') { toast('warning', 'Explodes belong to designs', 'Open or create a design and place its components first.'); return; }
  if (!state.displayed) { toast('warning', 'Generate the design first', 'Explode steps move the parts of the built design.'); return; }
  const built = editing ? useMotion.getState().kinematics?.explodes?.find((item) => item.name === editing) : undefined;
  const steps = built ? stepsOf(built) : [];
  const draft: ExplodeTool = built
    ? { ...BLANK, editing: built.name, name: built.name, auto: !!built.auto, loop: built.loop, easing: built.easing, steps, initialSteps: stepValues(steps), active: null }
    : { ...BLANK, name: freeExplodeName() };
  useExplodeTool.setState(draft);
  set({ tool: 'explodeSteps', explode: 0 });   // Its options open in the Dock (shell/toolDock.ts); the quick explode collapses.
  setDraft(draftExplode());
  if (!built) seek(0);
}

export function closeExplodeTool() {
  cancelAutomatic();
  if (get().tool === 'explodeSteps') set({ tool: 'select' });
  setDraft(null);
}

/* ───────── Parts ───────── */

/** The instance a node belongs to; with `inner` (Alt-click) the instance inside a linked design, by path ("kit/tray"). */
export function partOfNode(node: string, inner = false): string | null {
  const top = instanceOfNode(node);
  if (!top || !inner) return top;
  const state = get();
  let current = state.tree[node];
  const chain: string[] = [];
  while (current?.parent && current.parent !== state.rootId) { chain.unshift(current.name); current = state.tree[current.parent]; }
  const design = (state.displayed?.metadata as { modeling?: { design?: DesignResult & { links?: Record<string, { summary?: { instances?: { name: string }[] } }> } } } | null)?.modeling?.design;
  const component = design?.instances?.find((item) => item.name === top)?.component;
  const inside = component ? design?.links?.[component]?.summary?.instances ?? [] : [];
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nested = chain.length > 1 ? inside.find((item) => key(item.name) === key(chain[1])) : undefined;
  return nested ? `${top}/${nested.name}` : top;
}

/** The parts picked now, as instance names (or paths). */
function selectedParts(): string[] {
  const out: string[] = [];
  for (const pick of get().selection) {
    const part = partOfNode(pick.node);
    if (part && !out.includes(part)) out.push(part);
  }
  return out;
}

/** How far a new step moves its parts: a third of their size, at least 10 mm, in whole millimetres. */
function startingDistance(parts: string[]): number {
  const model = viewer.model;
  const box = new THREE.Box3();
  for (const part of parts) {
    const node = model ? nodeOfPath(model, part) : undefined;
    if (node && model) box.union(model.bounds(false, node));
  }
  return box.isEmpty() ? 20 : Math.max(10, Math.round(box.getSize(new THREE.Vector3()).length() / 3));
}

/** A new step after the active one (or at the end) with the picked parts, moving up; it becomes the active step. */
export function addStep() {
  const draft = tool();
  const parts = selectedParts();
  const up: Vec = [0, 0, startingDistance(parts)];
  const step: DraftStep = { key: ++keys, moves: Object.fromEntries(parts.map((part) => [part, [...up] as Vec])) };
  const at = draft.active === null ? draft.steps.length : draft.active + 1;
  const steps = [...draft.steps.slice(0, at), step, ...draft.steps.slice(at)];
  change({ steps, active: at, auto: false }, at);
  set({ selection: [] });
}

export function removeStep(index: number) {
  const draft = tool();
  const steps = draft.steps.filter((_, i) => i !== index);
  const active = draft.active === null ? null : draft.active === index ? null : draft.active > index ? draft.active - 1 : draft.active;
  change({ steps, active });
}

export function moveStep(index: number, by: -1 | 1) {
  const draft = tool();
  const other = index + by;
  if (other < 0 || other >= draft.steps.length) return;
  const steps = [...draft.steps];
  [steps[index], steps[other]] = [steps[other], steps[index]];
  change({ steps, active: draft.active === index ? other : draft.active === other ? index : draft.active }, draft.active === index ? other : undefined);
}

/** Makes a step the one being edited, and shows the parts where it leaves them. */
export function activateStep(index: number | null) {
  change({ active: index }, index);
}

function editStep(index: number, edit: (step: DraftStep) => DraftStep, show = true) {
  const draft = tool();
  if (!draft.steps[index]) return;
  change({ steps: draft.steps.map((step, i) => (i === index ? edit(step) : step)), auto: false }, show ? index : undefined);
}

/** The move every part of a step shares (its first part's, when they differ). */
export const stepMove = (step: DraftStep): Vec => (Object.values(step.moves)[0] ?? [0, 0, 0]) as Vec;
export const uniform = (step: DraftStep) => Object.values(step.moves).every((v) => v.every((value, k) => Math.abs(value - stepMove(step)[k]) < 1e-9));

/** Sets the move of every part of a step (typed). */
export function setStepMove(index: number, move: Vec) {
  editStep(index, (step) => ({ ...step, out: undefined, moves: Object.fromEntries(Object.keys(step.moves).map((part) => [part, [...move] as Vec])) }));
}

/** Moves every part of a step by `start` (their moves when the drag began) plus `delta` (the drag). */
export function dragStep(index: number, start: Record<string, Vec>, delta: Vec) {
  editStep(index, (step) => ({ ...step, out: undefined,
    moves: Object.fromEntries(Object.entries(start).map(([part, v]) => [part, v.map((value, k) => round(value + delta[k])) as Vec])) }));
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function setStepTiming(index: number, timing: { duration?: number; hold?: number; name?: string }) {
  editStep(index, (step) => ({ ...step, ...timing }));
}

/** Adds a part to the active step, or takes it out; a part joins with the step's move. */
export function togglePart(index: number, part: string) {
  editStep(index, (step) => {
    if (part in step.moves) {
      const moves = { ...step.moves };
      delete moves[part];
      return { ...step, moves };
    }
    return { ...step, out: undefined, moves: { ...step.moves, [part]: [...stepMove(step)] as Vec } };
  });
}

/** Adds the parts picked in the viewport or the browser to the active step. */
export function addSelectionToStep(index: number) {
  for (const part of selectedParts()) if (!(part in (tool().steps[index]?.moves ?? {}))) togglePart(index, part);
  set({ selection: [] });
}

/** While the tool is open, a viewport click on a part adds it to the active step or takes it out (Alt: a part inside a linked design). */
export function explodeToolPick(pick: ViewPick | null, inner = false): boolean {
  const draft = tool();
  if (get().tool !== 'explodeSteps' || draft.active === null || draft.auto) return false;
  if (!pick) return true;
  const part = partOfNode(pick.node, inner);
  if (!part) { useExplodeTool.setState({ error: 'Pick a placed part.' }); return true; }
  togglePart(draft.active, part);
  return true;
}

/* ───────── Commit ───────── */

export function explodeProblem(draft: ExplodeTool = tool()): string | null {
  if (draft.generating) return 'Preparing the automatic preview…';
  if (!/^[a-z][a-z0-9_]*$/.test(draft.name)) return 'Explode names are lowercase letters, digits and underscores, starting with a letter.';
  if (draft.name !== draft.editing && [...explodeNamesInCode(), ...animationNamesInCode()].includes(draft.name)) return `There is already an animation or explode named ${draft.name}.`;
  if (draft.auto) return null;
  if (!draft.steps.length) return 'Add a step: pick parts, then Add step.';
  const empty = draft.steps.findIndex((step) => !Object.keys(step.moves).length);
  if (empty >= 0) return `Step ${empty + 1} moves nothing: click parts to add them.`;
  const still = draft.steps.findIndex((step) => step.out === undefined && Object.values(step.moves).some((v) => v.every((value) => Math.abs(value) < 1e-9)));
  if (still >= 0) return `Step ${still + 1}: drag the arrows or type a move.`;
  return null;
}

export function explodeSpec(draft: ExplodeTool = tool()): ExplodeSpec {
  return { name: draft.name, auto: draft.auto, loop: draft.loop, gap: draft.gap, easing: draft.easing, preserveSteps: draft.initialSteps === stepValues(draft.steps),
    steps: draft.steps.map((step) => ({ name: step.name, moves: step.moves, out: step.out, duration: step.duration, hold: step.hold })) };
}

export async function commitExplodeTool() {
  const draft = tool();
  const problem = explodeProblem(draft);
  if (problem) { useExplodeTool.setState({ error: problem }); return; }
  writeExplode(explodeSpec(draft), draft.editing ?? undefined);
  closeExplodeTool();
  await updateModel();
  selectClip(draft.name);
}

/** Build automatic steps in isolation. Only OK writes to the document. */
export async function generateAutomatic() {
  const draft = tool();
  if (draft.generating) return;
  const problem = explodeProblem({ ...draft, auto: true });
  if (problem) { useExplodeTool.setState({ error: problem }); return; }
  cancelAutomatic();
  const run = automaticRun;
  const doc = get().doc;
  const source = stored(doc);
  useExplodeTool.setState({ auto: true, generating: true, error: null, active: null });
  try {
    let build = await Api.submit({ kind: doc.kind, name: doc.name, ...source,
      code: codeWithExplode(source.code, explodeSpec({ ...draft, auto: true }), draft.editing ?? undefined), mode: 'preview' });
    if (run !== automaticRun) { if (build.status === 'queued' || build.status === 'running') void Api.cancelBuild(build.id); return; }
    automaticBuild = build.id;
    while (build.status === 'queued' || build.status === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (run !== automaticRun) return;
      build = await Api.build(build.id);
    }
    if (run !== automaticRun || get().tool !== 'explodeSteps') return;
    if (get().doc.name !== doc.name || JSON.stringify(stored(get().doc)) !== JSON.stringify(source)) throw new Error('The document changed during the preview. Generate Automatic again.');
    if (build.status !== 'succeeded') throw new Error(build.error || 'The automatic preview could not be built.');
    const built = kinematicsOf(build.metadata)?.explodes?.find((item) => item.name === draft.name);
    if (!built) throw new Error('The build did not produce an exploded view.');
    change({ steps: stepsOf(built), auto: true, generating: false });
    seek(built.duration);
  } catch (error) {
    if (run === automaticRun) useExplodeTool.setState({ error: (error as Error).message, generating: false, auto: draft.auto });
  } finally {
    if (run === automaticRun) { automaticBuild = null; useExplodeTool.setState({ generating: false }); }
  }
}

/** Turns an automatic explode into steps (kept in the draft; OK writes them), so they can be edited. */
export function writeOutSteps() {
  cancelAutomatic();
  change({ auto: false });
}

export async function deleteExplode() {
  const draft = tool();
  if (!draft.editing) return;
  removeExplode(draft.editing);
  closeExplodeTool();
  await updateModel();
}

/** The parts the arrows move: the active step's, in the viewport now. */
export function activeParts(): string[] {
  const draft = tool();
  return draft.active !== null && !draft.auto ? Object.keys(draft.steps[draft.active]?.moves ?? {}) : [];
}

// Leaving the tool any way (Esc, another tool, Close) drops its draft: the timeline goes back to what main.py has.
useApp.subscribe((state) => state.tool, (next, previous) => {
  if (previous === 'explodeSteps' && next !== 'explodeSteps') {
    cancelAutomatic();
    if (useMotion.getState().draft) setDraft(null);
  }
});

/**
 * Constraint tools, as in Fusion and Onshape. A ribbon constraint applies at once to a selection that fits it
 * (select-first); otherwise it becomes the active tool (`c.<kind>`) and asks for its inputs one pick at a time. Only
 * what the constraint accepts at that step lights up under the pointer, and a pick it can't take says why. When the
 * inputs are complete the constraint is added (or refused with the reason when the solver finds it conflicting or
 * redundant) and the tool waits for the next set, until OK, Esc or Select. While the tool is active its picks are
 * the sketch selection, so they draw as picked. Auto-constraints while drawing are separate (tools.ts snap/tie).
 */
import { toast } from '@/state/store';
import { axisHits, hitCandidates, type Hit } from './geometry';
import { points as pointMap, type Entity, type Stmt } from './model';
import { commit, sketch, useSketch, type ToolId } from './session';
import { planConstraint, setTool, type Pointer } from './tools';

export const CONSTRAINT_LABELS = {
  coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
  tangent: 'Tangent', equal: 'Equal', symmetric: 'Symmetric', midpoint: 'Midpoint', concentric: 'Concentric', collinear: 'Collinear', fix: 'Fix',
} as const;
export type ConstraintKind = keyof typeof CONSTRAINT_LABELS;

/** The constraint a sketch tool is, if it is one. */
export const constraintOf = (tool: ToolId): ConstraintKind | null =>
  (tool.startsWith('c.') && tool.slice(2) in CONSTRAINT_LABELS ? (tool.slice(2) as ConstraintKind) : null);

type Role = 'point' | 'line' | 'axis' | 'round' | 'curve';

function roleOf(ref: string, entities: Entity[]): Role | null {
  if (ref === 'x_axis' || ref === 'y_axis') return 'axis';
  const entity = entities.find((e) => e.id === ref);
  if (entity) {
    if (entity.type === 'line') return 'line';
    if (entity.type === 'circle' || entity.type === 'arc') return 'round';
    if (entity.type === 'point') return 'point';
    if (entity.type === 'projection') return null;
    return 'curve';
  }
  return pointMap(entities).has(ref) ? 'point' : null;
}

const isOwnLine = (ref: string, entities: Entity[]) => roleOf(ref, entities) === 'line' && !entities.find((e) => e.id === ref)?.external;

/** What the next pick may be, in words, for the prompt (`picked`: the roles picked so far). */
function wants(kind: ConstraintKind, picked: Role[]): { roles: Role[]; prompt: string } {
  const [a] = picked;
  switch (kind) {
    case 'coincident':
      if (!a) return { roles: ['point', 'line', 'round', 'curve', 'axis'], prompt: 'Pick a point, or a curve to put a point on.' };
      if (a === 'point') return { roles: ['point', 'line', 'round', 'curve', 'axis'], prompt: 'Pick the point to join it to, or a curve or axis to put it on.' };
      if (a === 'line' || a === 'axis') return { roles: ['point', 'line', 'axis'], prompt: 'Pick a point to put on it, or a line to make collinear.' };
      return { roles: ['point'], prompt: 'Pick the point to put on it.' };
    case 'horizontal': case 'vertical':
      if (!a) return { roles: ['line', 'point'], prompt: `Pick a line to make ${kind}, or the first of two points to align.` };
      return { roles: ['point'], prompt: `Pick the second point to align ${kind}ly.` };
    case 'parallel': case 'perpendicular': case 'collinear':
      return { roles: ['line', 'axis'], prompt: a ? `Pick the second line (or an axis).` : 'Pick the first line (or an axis).' };
    case 'equal':
      if (!a) return { roles: ['line', 'round'], prompt: 'Pick a line, or a circle or arc.' };
      return a === 'line' ? { roles: ['line'], prompt: 'Pick the line to make the same length.' } : { roles: ['round'], prompt: 'Pick the circle or arc to give the same radius.' };
    case 'tangent':
      if (!a) return { roles: ['line', 'axis', 'round', 'curve'], prompt: 'Pick the first curve (a line, circle or arc).' };
      return a === 'line' || a === 'axis' ? { roles: ['round', 'curve'], prompt: 'Pick the circle or arc to make tangent to it.' } : { roles: ['line', 'axis', 'round', 'curve'], prompt: 'Pick the second curve.' };
    case 'concentric':
      return { roles: ['round'], prompt: a ? 'Pick the second circle or arc.' : 'Pick the first circle or arc.' };
    case 'midpoint':
      if (!a) return { roles: ['point', 'line'], prompt: 'Pick a point and the line it sits at the middle of (either first).' };
      return a === 'point' ? { roles: ['line'], prompt: 'Pick the line whose middle it goes to.' } : { roles: ['point'], prompt: 'Pick the point to put at its middle.' };
    case 'symmetric':
      if (picked.length < 2) return { roles: ['point'], prompt: picked.length ? 'Pick the second point.' : 'Pick the first of two points to mirror.' };
      return { roles: ['line', 'axis', 'point'], prompt: 'Pick the line, axis or point they mirror about.' };
    case 'fix':
      return { roles: ['point'], prompt: 'Pick a point to fix where it is (a fixed point unfixes).' };
  }
}

/** How many picks make the constraint, given the first one. */
function complete(kind: ConstraintKind, picked: Role[]): boolean {
  if (kind === 'fix') return picked.length === 1;
  if ((kind === 'horizontal' || kind === 'vertical') && picked[0] === 'line') return picked.length === 1;
  return picked.length === (kind === 'symmetric' ? 3 : 2);
}

const nounOf: Record<Role, string> = { point: 'a point', line: 'a line', axis: 'an axis', round: 'a circle or arc', curve: 'that curve' };

/** Whether `ref` can be the next pick, or why not. */
function accepts(kind: ConstraintKind, picks: string[], ref: string, entities: Entity[]): true | string {
  if (picks.includes(ref)) return 'Already picked.';
  const role = roleOf(ref, entities);
  if (!role) return 'That can’t be constrained here.';
  const picked = picks.map((p) => roleOf(p, entities)!);
  const { roles, prompt } = wants(kind, picked);
  if (!roles.includes(role)) return `${CONSTRAINT_LABELS[kind]} can’t use ${nounOf[role]} here. ${prompt}`;
  if (role === 'axis' && picked.includes('axis')) return 'Both axes are fixed; pick one of the sketch’s own lines.';
  if ((kind === 'horizontal' || kind === 'vertical' || kind === 'equal') && role === 'line' && !isOwnLine(ref, entities)) return 'Projected lines are fixed; pick one of the sketch’s own.';
  if (kind === 'midpoint' && role === 'line' && !isOwnLine(ref, entities)) return 'Pick one of the sketch’s own lines.';
  return true;
}

/** The current step's prompt for the panel. */
export function constraintPrompt(kind: ConstraintKind, picks = sketch().selection, entities = sketch().expansion.entities): string {
  return wants(kind, picks.map((p) => roleOf(p, entities) ?? 'point')).prompt;
}

/** The picks so far and what comes next, for the panel's step list. */
export function constraintSteps(kind: ConstraintKind, picks = sketch().selection, entities = sketch().expansion.entities): { ref: string | null; prompt: string }[] {
  const roles = picks.map((p) => roleOf(p, entities) ?? 'point');
  const steps = picks.map((ref, i) => ({ ref, prompt: wants(kind, roles.slice(0, i)).prompt }));
  return complete(kind, roles) ? steps : [...steps, { ref: null, prompt: wants(kind, roles).prompt }];
}

const candidates = (ptr: Pointer): Hit[] => [...hitCandidates(ptr.p, ptr.tol, sketch().expansion.entities), ...axisHits(ptr.p, ptr.tol)];

/** Under the pointer, only what the constraint accepts at this step lights up. */
export function constraintMove(ptr: Pointer) {
  const kind = constraintOf(sketch().tool);
  if (!kind) return;
  const { selection, expansion, hover } = sketch();
  const valid = candidates(ptr).find((hit) => accepts(kind, selection, hit.ref, expansion.entities) === true)?.ref ?? null;
  if (valid !== hover) useSketch.setState({ hover: valid });
}

/** A click: the first acceptable item under the pointer is the next pick; complete picks are applied. */
export function constraintDown(ptr: Pointer) {
  const kind = constraintOf(sketch().tool);
  if (!kind) return;
  const { selection, expansion } = sketch();
  const hits = candidates(ptr);
  if (!hits.length) return;
  const hit = hits.find((h) => accepts(kind, selection, h.ref, expansion.entities) === true);
  if (!hit) { useSketch.setState({ message: accepts(kind, selection, hits[0].ref, expansion.entities) as string }); return; }
  const picks = [...selection, hit.ref];
  if (!complete(kind, picks.map((p) => roleOf(p, expansion.entities)!))) { useSketch.setState({ selection: picks, message: null }); return; }
  useSketch.setState({ selection: picks, message: null });
  void applyPicks(kind, picks);
}

async function applyPicks(kind: ConstraintKind, picks: string[]) {
  const outcome = kind === 'fix' ? await toggleFix(picks[0]) : await addPlanned(kind, picks);
  // Ready for the next set either way (Fusion keeps the constraint tool until you leave it).
  if (constraintOf(sketch().tool) === kind) useSketch.setState({ selection: [], hover: null, message: outcome === true ? `${CONSTRAINT_LABELS[kind]} added. Pick the next, or OK.` : outcome });
}

async function addPlanned(kind: ConstraintKind, picks: string[]): Promise<true | string> {
  const plan = planConstraint(kind, picks);
  return typeof plan === 'string' ? plan : addConstraint(plan);
}

/** Fixes a point where it is, or unfixes it when it already is. */
async function toggleFix(ref: string): Promise<true | string> {
  const { statements } = sketch();
  const index = statements.findIndex((s) => s.op === 'fix' && s.args.length === 1 && s.args[0].value === ref);
  if (index >= 0) { await commit(statements.filter((_, i) => i !== index)); return `${ref} is free again.`; }
  const plan = planConstraint('fix', [ref]);
  return typeof plan === 'string' ? plan : addConstraint(plan);
}

/**
 * Adds constraint statements and keeps them only if the solver accepts them: one that conflicts with the sketch, or
 * repeats what other constraints already say (redundant), is taken back and the reason returned.
 */
export async function addConstraint(plan: Stmt[]): Promise<true | string> {
  const before = sketch().statements;
  const failing = sketch().result?.status === 'failed';
  await commit([...before, ...plan]);
  const { expansion, result } = sketch();
  const added = new Set(expansion.owners.slice(before.length).flatMap((owner) => owner.constraints));
  const conflicting = (result?.conflicting ?? []).some((id) => added.has(id));
  const redundant = (result?.redundant ?? []).some((id) => added.has(id));
  if (!conflicting && !redundant && (failing || result?.status !== 'failed')) return true;
  useSketch.setState((state) => ({ undo: state.undo.slice(0, -1) }));
  await commit(before, { undoable: false });
  return redundant && !conflicting
    ? 'Not added: the other constraints already say that (it would be redundant).'
    : 'Not added: it conflicts with the sketch’s other constraints.';
}

/** The ribbon command: apply to a selection that fits, else start the tool (keeping the picks that fit its first steps). */
export async function runConstraint(kind: ConstraintKind) {
  const { selection, expansion, tool } = sketch();
  if (constraintOf(tool) !== kind && selection.length) {
    if (kind === 'fix' && selection.length === 1) {
      const outcome = await toggleFix(selection[0]);
      if (outcome !== true) toast('info', CONSTRAINT_LABELS[kind], outcome);
      return;
    }
    const plan = planConstraint(kind);
    if (typeof plan !== 'string') {
      const outcome = await addConstraint(plan);
      if (outcome !== true) toast('warning', CONSTRAINT_LABELS[kind], outcome);
      return;
    }
  }
  const seed: string[] = [];
  for (const ref of selection) {
    if (accepts(kind, seed, ref, expansion.entities) !== true) continue;
    if (complete(kind, [...seed, ref].map((p) => roleOf(p, expansion.entities)!))) break;
    seed.push(ref);
  }
  setTool(`c.${kind}`);
  useSketch.setState({ selection: seed, hover: null, message: null });
}

/** Esc in a constraint tool: drop a half-picked set first, then leave the tool. */
export function constraintEscape(): boolean {
  if (sketch().selection.length) { useSketch.setState({ selection: [], message: null }); return true; }
  setTool('select');
  return true;
}

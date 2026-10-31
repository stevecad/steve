/**
 * The timeline's history marker, like Fusion's or SolidWorks' rollback bar. Drag it back and the
 * model shows itself as of that step: every later feature is suppressed for the build only; the
 * saved code is untouched. New features go in at the marker, which then moves past them.
 */
import { get, set, toast } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { parseModel, type ModelDoc, type ModelFeature } from '@/lib/modeling';

/** `suppressed=True` added after a feature call's last argument (sketches: inside `model.sketch(...)`). */
function suppress(code: string, feature: ModelFeature): string {
  const ends = [...(feature.args ?? []), ...Object.values(feature.kwargs ?? {})].map((arg) => arg.span[1]);
  const end = ends.length ? Math.max(...ends) : -1;
  if (end < 0) return code;
  return `${code.slice(0, end)}, suppressed=True${code.slice(end)}`;
}

/** The code with every feature after `after` suppressed (`null`: before the first feature). */
export function rolledCode(code: string, doc: ModelDoc, after: string | null): string {
  const index = after === null ? -1 : doc.features.findIndex((feature) => feature.id === after);
  if (after !== null && index < 0) return code;
  let next = code;
  // From the end, so earlier spans stay valid.
  for (const feature of doc.features.slice(index + 1).reverse()) {
    if (feature.kind === 'code' || feature.kwargs?.suppressed) continue;
    next = suppress(next, feature);
  }
  return next;
}

/** Where new features go while rolled back: after the marker's feature (null: at the start). Undefined: at the end. */
export function insertionPoint(): string | null | undefined {
  const rollback = get().rollback;
  return rollback ? rollback.after : undefined;
}

/** The code a build of the open part should use: rolled back when the marker is. Null: nothing to build at the marker. */
export async function buildCode(code: string): Promise<string | null> {
  const state = get();
  const rollback = state.rollback;
  if (!rollback || state.doc.kind !== 'part') return code;
  const doc = await parseModel(code);
  if (rollback.after !== null && !doc.features.some((feature) => feature.id === rollback.after)) {
    set({ rollback: null });
    toast('info', 'Rolled forward', 'The step the history marker was on is gone; the timeline is at its end again.');
    return code;
  }
  const rolled = rolledCode(code, doc, rollback.after);
  const empty = !solidBy(doc, rollback.after);
  if (code === get().doc.code) set({ rollback: { ...rollback, source: code, code: rolled, empty } });
  showModel(!empty);
  return empty ? null : rolled;
}

const NO_SOLID = ['sketch', 'plane', 'axis', 'point', 'code'];

/** Whether anything up to the marker makes a solid (sketches, planes and axes alone have nothing to build). */
function solidBy(doc: ModelDoc, after: string | null): boolean {
  if (after === null) return false;
  const index = doc.features.findIndex((feature) => feature.id === after);
  return doc.features.slice(0, index + 1).some((feature) => !NO_SOLID.includes(feature.kind) && !feature.kwargs?.suppressed);
}

function showModel(visible: boolean) {
  if (viewer.model && viewer.model.root.visible !== visible) { viewer.model.root.visible = visible; viewer.invalidate(); }
}

/** Moves the marker after `after` (null: before every feature; undefined: to the end) and regenerates. */
export async function rollTo(after: string | null | undefined) {
  const state = get();
  if (state.doc.kind !== 'part' || state.busy) return;
  const { updateModel } = await import('@/state/actions');
  const doc = state.modeling ?? await parseModel(state.doc.code);
  const last = doc.features.at(-1)?.id;
  if (after === undefined || (after !== null && after === last)) {
    if (!state.rollback) return;
    set({ rollback: null });
  } else {
    const rollback = { after, source: state.doc.code, code: rolledCode(state.doc.code, doc, after) };
    if (!solidBy(doc, after)) {
      // Before the first solid there is nothing to build: the sketches show on their own.
      set({ rollback: { ...rollback, empty: true }, activeFeature: after, phase: 'succeeded', phaseLabel: 'No solid yet at this step', error: '' });
      showModel(false);
      return;
    }
    set({ rollback, activeFeature: after });
  }
  showModel(true);
  await updateModel();
}

/** A new feature went in at the marker: the marker moves past it. */
export function advanceRollback(id: string) {
  const rollback = get().rollback;
  if (rollback) set({ rollback: { ...rollback, after: id } });
}

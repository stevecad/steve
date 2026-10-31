import { get, isNodeVisible, set, type AppState } from './store';
import { hideNodes, selectionNodes, toggleNodes } from './actions';
import { isRemembered, remember } from './treeOpen';
import { dependents } from '@/modeling/FeatureInspector';
import { bodyIds, bodyPicks, faceKeys } from '@/modeling/bodies';
import { parsePlanes } from '@/lib/construction';
import { viewer } from '@/viewport/viewer';

/**
 * Hide / show, one way for everything with an eye in the browser: components, bodies, sketches, construction planes
 * and simulation studies. The eyes, the menus and Space (H to hide) all go through these.
 */

/** Explicitly shown or hidden, else: unused sketches and the selected one show (like the viewport overlay). */
export function sketchShown(id: string, state: AppState = get()): boolean {
  return state.sketchVisibility[id] ?? (state.activeFeature === id || !state.modeling || dependents(id, state.modeling).length === 0);
}
export const toggleSketch = (id: string) => set((state) => ({ sketchVisibility: { ...state.sketchVisibility, [id]: !sketchShown(id, state) } }));
export const togglePlane = (id: string) => set((state) => ({ hiddenPlanes: state.hiddenPlanes.includes(id) ? state.hiddenPlanes.filter((item) => item !== id) : [...state.hiddenPlanes, id] }));

export function toggleBody(id: string) {
  const hidden = get().hiddenBodies.includes(id);
  set((state) => ({ hiddenBodies: hidden ? state.hiddenBodies.filter((body) => body !== id) : [...state.hiddenBodies, id] }));
  if (!hidden) deselectBodies([id]);
}

export function deselectBodies(bodies: string[]) {
  const model = viewer.model;
  if (!model) return;
  const keys = faceKeys(bodyPicks(model, bodies));
  set((state) => ({ selection: state.selection.filter((pick) => pick.kind !== 'face' || !keys.has(`${pick.mesh}:${pick.index}`)) }));
}

/** A whole group at once (the group heading's eye and its menu): bodies, sketches or construction planes. */
export function setBodiesShown(ids: string[], shown: boolean) {
  set((state) => ({ hiddenBodies: shown ? state.hiddenBodies.filter((id) => !ids.includes(id)) : [...new Set([...state.hiddenBodies, ...ids])] }));
  if (!shown) deselectBodies(ids);
}
export const setSketchesShown = (ids: string[], shown: boolean) => set((state) => ({ sketchVisibility: { ...state.sketchVisibility, ...Object.fromEntries(ids.map((id) => [id, shown])) } }));
export const setPlanesShown = (ids: string[], shown: boolean) => set((state) => ({
  hiddenPlanes: shown ? state.hiddenPlanes.filter((id) => !ids.includes(id)) : [...new Set([...state.hiddenPlanes, ...ids])],
}));

export type VisibilityGroup = keyof AppState['groupRestore'];
const groupShown: Record<VisibilityGroup, (id: string, state: AppState) => boolean> = {
  bodies: (id, state) => !state.hiddenBodies.includes(id),
  sketches: (id, state) => sketchShown(id, state),
  planes: (id, state) => !state.hiddenPlanes.includes(id),
};
const groupSet: Record<VisibilityGroup, (ids: string[], shown: boolean) => void> = { bodies: setBodiesShown, sketches: setSketchesShown, planes: setPlanesShown };

/**
 * A group heading's eye: hiding remembers each item's state (a sketch: its explicit choice, so its default comes back),
 * showing puts that back, as if each eye had been clicked. With nothing remembered, or nothing that would show, all show.
 */
export function setGroupShown(group: VisibilityGroup, ids: string[], shown: boolean) {
  const state = get();
  if (!shown) {
    const before = Object.fromEntries(ids.map((id) => [id, group === 'sketches' ? state.sketchVisibility[id] ?? null : groupShown[group](id, state)]));
    set({ groupRestore: { ...state.groupRestore, [group]: before } });
    groupSet[group](ids, false);
    return;
  }
  const before = state.groupRestore[group] ?? {};
  set({ groupRestore: { ...state.groupRestore, [group]: undefined } });
  const remembered = (id: string) => (id in before ? before[id] : true);
  let next: Partial<AppState>;
  if (group === 'sketches') {
    const visibility = { ...state.sketchVisibility };
    for (const id of ids) { const was = remembered(id); if (was === null) delete visibility[id]; else visibility[id] = was; }
    next = { sketchVisibility: visibility };
  } else {
    const back = ids.filter((id) => remembered(id) !== false);
    next = group === 'bodies' ? { hiddenBodies: state.hiddenBodies.filter((id) => !back.includes(id)) } : { hiddenPlanes: state.hiddenPlanes.filter((id) => !back.includes(id)) };
  }
  if (ids.some((id) => groupShown[group](id, { ...get(), ...next }))) set(next);
  else groupSet[group](ids, true);
}

/** A study hidden from the all-studies view (remembered per document, like the browser's open groups). */
export const hiddenKey = (id: string) => `study-hidden:${id}`;
export const studyHidden = (id: string) => isRemembered(hiddenKey(id), false);
export const toggleStudy = (id: string) => remember(hiddenKey(id), !studyHidden(id));

export type Hideable =
  | { kind: 'nodes'; ids: string[] }
  | { kind: 'bodies'; ids: string[] }
  | { kind: 'sketch'; id: string }
  | { kind: 'plane'; id: string }
  | { kind: 'study'; id: string };

/** The browser row whose own button has keyboard focus (`sketch:sketch_1`, `study:…`), the person's latest choice there. */
export function focusedItem(): string | null {
  if (typeof document === 'undefined') return null;
  const row = document.activeElement?.parentElement;
  return row?.getAttribute('data-item') ?? null;
}

// The rows with an eye: a modeled part's sketches and planes, and an older part's named cq.Plane lines.
const isSketch = (id: string, state: AppState) => !!state.modeling?.canonical && state.modeling.features.some((feature) => feature.id === id && feature.kind === 'sketch');
const isPlane = (id: string, state: AppState) => (state.modeling?.canonical
  ? state.modeling.features.some((feature) => feature.id === id && feature.kind === 'plane')
  : parsePlanes(state.doc.code).some((plane) => plane.name === id));

/** Bodies of a multi-body part (or edited component) the selection covers exactly: every face of each, nothing else. */
function selectedBodies(state: AppState): string[] {
  const model = viewer.model;
  const bodies = bodyIds(state.displayed);
  if (!model || bodies.length < 2 || !state.selection.length || state.selection.some((pick) => pick.kind !== 'face')) return [];
  const chosen = faceKeys(state.selection);
  const covered = bodies.filter((id) => { const keys = faceKeys(bodyPicks(model, [id])); return keys.size > 0 && [...keys].every((key) => chosen.has(key)); });
  const all = faceKeys(bodyPicks(model, covered));
  return covered.length && [...chosen].every((key) => all.has(key)) ? covered : [];
}

/**
 * What hide / show acts on: the browser row with focus, else the selection (whole bodies, else components), else the
 * chosen sketch or plane, else in Simulate the chosen study.
 */
export function hideableTarget(state: AppState = get(), item: string | null = focusedItem()): Hideable | null {
  const colon = item?.indexOf(':') ?? -1;
  const kind = item && colon > 0 ? item.slice(0, colon) : '';
  const id = item && colon > 0 ? item.slice(colon + 1) : '';
  if (kind === 'sketch' && isSketch(id, state)) return { kind: 'sketch', id };
  if (kind === 'construction' && isPlane(id, state)) return { kind: 'plane', id };
  if (kind === 'body' && bodyIds(state.displayed).includes(id)) return { kind: 'bodies', ids: [id] };
  if (kind === 'study' && state.studies.some((study) => study.id === id)) return { kind: 'study', id };
  if (state.selection.length) {
    const bodies = selectedBodies(state);
    if (bodies.length) return { kind: 'bodies', ids: bodies };
    const ids = selectionNodes(state.selection);
    return ids.length ? { kind: 'nodes', ids } : null;
  }
  const feature = state.activeFeature;
  if (state.workspace === 'design' && feature && isSketch(feature, state)) return { kind: 'sketch', id: feature };
  if (state.workspace === 'design' && feature && isPlane(feature, state)) return { kind: 'plane', id: feature };
  if (state.workspace === 'simulate' && state.activeStudy && state.studies.some((study) => study.id === state.activeStudy)) return { kind: 'study', id: state.activeStudy };
  return null;
}

/** Whether the target shows now (for components: all of them). */
export function targetShown(target: Hideable, state: AppState = get()): boolean {
  switch (target.kind) {
    case 'nodes': return target.ids.every((id) => isNodeVisible(state.tree, id));
    case 'bodies': return target.ids.every((id) => !state.hiddenBodies.includes(id));
    case 'sketch': return sketchShown(target.id, state);
    case 'plane': return !state.hiddenPlanes.includes(target.id);
    case 'study': return !studyHidden(target.id);
  }
}

/** Hides the target when it shows, otherwise shows it again: Space. */
export function toggleTarget(target: Hideable) {
  switch (target.kind) {
    case 'nodes': toggleNodes(target.ids); return;
    case 'bodies': {
      const shown = targetShown(target);
      for (const id of target.ids) if (shown !== get().hiddenBodies.includes(id)) toggleBody(id);
      return;
    }
    case 'sketch': toggleSketch(target.id); return;
    case 'plane': togglePlane(target.id); return;
    case 'study': toggleStudy(target.id); return;
  }
}

/** Hides the target (H); the components leave the selection, as before. */
export function hideTarget(target: Hideable) {
  if (target.kind === 'nodes') { hideNodes(target.ids); set({ selection: [] }); return; }
  if (target.kind === 'bodies') { for (const id of target.ids) if (!get().hiddenBodies.includes(id)) toggleBody(id); return; }
  if (targetShown(target)) toggleTarget(target);
}

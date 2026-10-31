import { create } from 'zustand';
import { get, set, toast } from '@/state/store';
import { openFile, setCode } from '@/state/actions';
import { componentOfNode } from '@/state/designRefs';
import { componentPath } from '@/state/design';
import { persistWorkspaceData } from '@/state/workspaceData';
import { parseModel, type Look, type ModelDoc } from '@/lib/modeling';
import {
  currentAssignments, loadLibrary, materialRecord, prepareForMaterials, refreshOwnMaterials, useMaterialLibrary, writeAppearance, writeFaceAppearance, writeMaterial, type Assignment,
} from '@/lib/materials';
import { regenerate } from '@/modeling/rename';
import { bodyIds, modelingOf, selectedBodies } from '@/modeling/bodies';

export type MaterialTarget = 'part' | string[];

/** Which bodies the material browser assigns to; set when it opens. */
export const useMaterialDialog = create<{ target: MaterialTarget }>(() => ({ target: 'part' }));

let explicit = false;
const defaultTarget = (): MaterialTarget => {
  const bodies = get().doc.kind === 'part' ? selectedBodies() : [];
  return bodies.length ? bodies : 'part';
};

/** In a design's main.py, a selected instance's component file takes the material or appearance: opens it ('part'),
 *  or says what to pick (null). Elsewhere, the target as given. */
function componentTarget(target: MaterialTarget | undefined, what: string): MaterialTarget | undefined | null {
  const { doc, selection } = get();
  if (doc.kind !== 'design' || doc.activeFile.startsWith('components/')) return target;
  const component = selection.map((pick) => componentOfNode(pick.node)).find((id): id is string => !!id);
  if (!component) { toast('info', 'Pick a component', `Select a component in the viewport, or open its file, to give it ${what}.`); return null; }
  openFile(componentPath(component));
  set({ selection: [] });
  return 'part';
}

export function openMaterials(requested?: MaterialTarget) {
  const target = componentTarget(requested, 'a material');
  if (target === null) return;
  explicit = true;
  useMaterialDialog.setState({ target: target ?? defaultTarget() });
  set({ dialog: 'material', contextMenu: null });
  // The person's own materials are read again: another tab or device may have changed them.
  if (useMaterialLibrary.getState().library) void refreshOwnMaterials();
  else void loadLibrary().catch(() => undefined);
}

/** The Appearance tool (its options are a tab of the Dock: shell/toolDock.ts): open, and which bodies it sets. */
export const useAppearanceTool = create<{ open: boolean; target: MaterialTarget }>(() => ({ open: false, target: 'part' }));

export function openAppearance(requested?: MaterialTarget) {
  const target = componentTarget(requested, 'an appearance');
  if (target === null) return;
  useAppearanceTool.setState({ open: true, target: target ?? defaultTarget() });
  set({ contextMenu: null });
  if (!useMaterialLibrary.getState().library) void loadLibrary().catch(() => undefined);
}

export const closeAppearance = () => useAppearanceTool.setState({ open: false });

/** Commands that only `set({ dialog: 'material' })` (Simulate's) get the selection-based target too. */
export function materialDialogOpened() {
  if (!explicit) useMaterialDialog.setState({ target: defaultTarget() });
  explicit = false;
}

/** Writes `model.material(...)` for the part or some bodies (null clears) and regenerates. Resolves to an error message or null. */
export function assignMaterial(target: MaterialTarget, value: Assignment | null): Promise<string | null> {
  return rewrite('Materials', (code, doc) => writeMaterial(code, doc, target, value));
}

/** Writes `model.appearance(...)` for the part or some bodies (null clears) and regenerates; never touches materials. */
export function assignAppearance(target: MaterialTarget, look: Look | null): Promise<string | null> {
  return rewrite('Appearances', (code, doc) => writeAppearance(code, doc, target, look));
}

/** Writes `model.appearance(..., faces=[...])` for faces by their references (null clears) and regenerates. */
export function assignFaceAppearance(refs: string[], look: Look | null): Promise<string | null> {
  return rewrite('Appearances', (code, doc) => writeFaceAppearance(code, doc, refs, look));
}

async function rewrite(what: string, write: (code: string, doc: ModelDoc) => string): Promise<string | null> {
  const state = get();
  if (!state.doc.open) return 'Open a design first.';
  if (state.doc.kind === 'design' && !state.doc.activeFile.startsWith('components/')) return `${what} belong to components: choose one to edit (Components in the browser).`;
  const code = state.doc.code;
  try {
    let next = prepareForMaterials(code, await parseModel(code));
    next = write(next, await parseModel(next));
    if (next === code) return null;
    const doc = await parseModel(next);
    if (get().doc.code !== code) return 'The code changed meanwhile. Try again.';
    setCode(next);
    set({ modeling: doc });
    if (get().displayed) void regenerate();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * Materials used to be a per-browser choice (`materials.root` in workspace data). The first time such a
 * design opens, offer to write the choice into the code; either answer forgets the browser copy.
 */
export async function offerLegacyMaterial() {
  const state = get();
  const legacy = state.materials.root;
  if (!legacy || !state.doc.open || state.doc.kind !== 'part' || !state.modeling?.materials) return;
  // Forgotten before anything async, so a second trigger finds nothing to offer.
  set((s) => ({ materials: Object.fromEntries(Object.entries(s.materials).filter(([key]) => key !== 'root')) }));
  persistWorkspaceData();
  if (state.modeling.materials.length) return;
  const library = await loadLibrary().catch(() => null);
  const material = library ? materialRecord(legacy) : undefined;
  if (!material) return;
  toast('info', `Write ${material.name} into the design?`, 'It was set in this browser only. In the code it versions and merges with the design.', {
    sticky: true,
    action: { label: 'Write it', run: () => { void assignMaterial('part', { material: material.id }).then((error) => error && toast('danger', 'Couldn’t assign the material', error)); } },
  });
}

let checked: string | null = null;

/**
 * Per parse of the open design: the legacy offer (once per document), and `materials.root` kept equal to the
 * design's part material, read-only, for code still on the browser-era state (the Simulate workspace).
 */
export function syncMaterialState() {
  const state = get();
  if (!state.doc.open || !state.modeling) return;
  const key = `${state.activeTab ?? ''}:${state.doc.saved?.id ?? ''}`;
  if (checked !== key) { checked = key; void offerLegacyMaterial(); }
  if (!state.modeling.materials) return;
  const assignments = currentAssignments(state.modeling, modelingOf(state.displayed));
  const ids = bodyIds(state.displayed);
  const shared = ids.length && ids.every((id) => assignments.bodies[id]?.material === assignments.bodies[ids[0]]?.material) ? assignments.bodies[ids[0]]?.material : undefined;
  const root = shared ?? assignments.part?.material ?? '';
  if ((get().materials.root ?? '') !== root) set((s) => ({ materials: { ...s.materials, root } }));
}

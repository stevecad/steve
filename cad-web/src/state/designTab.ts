/**
 * The Design workspace's tool tab (Solid | Sheet metal | Surface | Motion | Drawing) follows the work: opening a part
 * with sheet metal, editing or creating a sheet feature, or selecting sheet geometry shows Sheet metal; solid
 * features show Solid. Selecting solid geometry doesn't leave Sheet metal (Convert starts from a solid
 * face). Editing or creating a surface-only feature (fill, boundary surface) and turning on a surface analysis show
 * Surface; opening a document never does. In a design, the Joint and motion tools, choosing a joint or coupling, and
 * opening main.py of a design with joints show Motion. A click on a tab always wins until the next such change.
 */
import { get, set, useApp, type AppState, type DesignTab } from './store';
import { useFeatureDialog, refFor } from '@/modeling/dialog';
import { SPECS } from '@/modeling/specs';
import { useMotion } from '@/motion/state';
import { useSurfaceAnalysis } from '@/workspaces/surface/state';
import { isCad } from '@/lib/api';
import { isPhone } from '@/phone/detect';

/** Whether the displayed build is a Blender scene that moves (blender/blender_run.py scene facts: animated datablocks). */
export const sceneAnimated = (state: Pick<AppState, 'doc' | 'displayed'>): boolean =>
  state.doc.kind === 'blender' && state.displayed?.kind === 'blender'
  && ((state.displayed.metadata as { scene?: { animation?: { animated?: number } } } | null | undefined)?.scene?.animation?.animated ?? 0) > 0;

/** The tab the ribbon shows: Motion belongs to designs, so a part shows Solid instead; Animation to an animated Blender
 *  scene; the Drawing editor is for desktops and tablets (phones open drawings from Export). */
export const shownTab = (state: Pick<AppState, 'designTab' | 'doc' | 'displayed'>): DesignTab =>
  state.doc.kind === 'blender' && state.designTab !== 'animation' ? 'solid' :
  ((state.designTab === 'motion' && state.doc.kind !== 'design') || (state.designTab === 'animation' && !sceneAnimated(state))
    || (state.designTab === 'drawing' && (isPhone() || !isCad(state.doc.kind))) ? 'solid' : state.designTab);

/** The Animation tab is what the Design workspace shows: the scene playing in the view, its strip below. */
export const animationShown = (state: Pick<AppState, 'workspace' | 'designTab' | 'doc' | 'displayed' | 'sketching'>): boolean =>
  state.workspace === 'design' && state.doc.open && shownTab(state) === 'animation' && !state.sketching;

/** The Drawing tab is what the Design workspace shows: its sheet in the centre, its setup as the Drawing tool's
 *  panel on the right (shell/toolDock.ts). */
export const drawingShown = (state: Pick<AppState, 'workspace' | 'designTab' | 'doc' | 'displayed' | 'sketching'>): boolean =>
  state.workspace === 'design' && state.doc.open && shownTab(state) === 'drawing' && !state.sketching;

export function setDesignTab(designTab: DesignTab) {
  if (get().designTab === designTab) return;
  set({ designTab });
  try { localStorage.setItem('steve-design-tab', designTab); } catch { /* Optional. */ }
}

/** The tab a feature kind belongs to, or null for kinds both tabs use (sketches, planes, moves, code). */
function tabOf(kind: string | undefined): DesignTab | null {
  const spec = kind ? SPECS[kind] : undefined;
  if (!spec) return null;
  if (spec.sheet) return 'sheet';
  if (spec.surface) return 'surface';
  return ['plane', 'move'].includes(spec.kind) ? null : 'solid';
}

const follow = (kind: string | undefined) => { const tab = tabOf(kind); if (tab) setDesignTab(tab); };

/** Feature ids that made or changed sheet bodies in the open file. */
const sheetFeatures = () => new Set((get().modeling?.features ?? []).filter((f) => f.id && SPECS[f.kind]?.sheet).map((f) => f.id!));

/** The feature a face or edge reference was named by: `flange_1.top`, `edge(base_1.side(r1.left)|base_1.top)` → base_1. */
const ownerOf = (ref: string) => /^(?:edge\()?([A-Za-z_][\w]*)/.exec(ref)?.[1] ?? null;

let installed = false;

export function installDesignTabFollow() {
  if (installed) return;
  installed = true;
  // A feature dialog opening (new or edit) shows its tab.
  useFeatureDialog.subscribe((state, previous) => {
    if (state.open && (!previous.open || state.kind !== previous.kind)) follow(state.kind);
  });
  // A feature chosen in the timeline or browser.
  useApp.subscribe((state) => state.activeFeature, (id) => {
    if (!id) return;
    follow(get().modeling?.features.find((f) => f.id === id)?.kind);
  });
  // Selecting sheet geometry in the view.
  useApp.subscribe((state) => state.selection, (selection) => {
    if (get().workspace !== 'design' || !selection.length) return;
    const sheet = sheetFeatures();
    if (!sheet.size) return;
    const owners = selection.filter((pick) => pick.kind === 'face' || pick.kind === 'edge').map(refFor).filter(Boolean).map((ref) => ownerOf(ref!));
    if (owners.some((owner) => owner && sheet.has(owner))) setDesignTab('sheet');
  });
  // The Joint and motion tools, and a joint or coupling chosen in the tree or Properties.
  useApp.subscribe((state) => state.tool, (tool) => { if ((tool === 'joint' || tool === 'motion' || tool === 'explodeSteps') && get().doc.kind === 'design') setDesignTab('motion'); });
  useMotion.subscribe((state, previous) => { if (state.active && state.active !== previous.active && get().doc.kind === 'design') setDesignTab('motion'); });
  // A surface analysis turned on (from the palette too).
  useSurfaceAnalysis.subscribe((state, previous) => { if (state.mode && state.mode !== previous.mode && get().workspace === 'design') setDesignTab('surface'); });
  // A design's main.py with joints opens on Motion (once per document and file, when its joints arrive).
  let mechanism: string | null = null;
  useMotion.subscribe((state) => {
    const app = get();
    const key = `${app.activeTab ?? ''}\u0000${app.doc.activeFile}`;
    if (!state.kinematics?.joints.length || key === mechanism || app.doc.kind !== 'design' || app.doc.activeFile !== 'main.py') return;
    mechanism = key;
    if (app.designTab !== 'drawing') setDesignTab('motion');  // The Drawing tab edits main.py too: it stays.
  });
  // An animated Blender scene opens on Animation (once per document, when its first animated build arrives).
  let scene: string | null = null;
  useApp.subscribe((state) => sceneAnimated(state), (animated) => {
    const app = get();
    const key = app.activeTab ?? app.doc.saved?.id ?? '';
    if (!animated || key === scene) return;
    scene = key;
    setDesignTab('animation');
  });
  // A document (or design file) opening: sheet metal parts open on Sheet metal, others on Solid. The Drawing tab stays
  // while its own document moves to another file (it writes the sheets into main.py).
  let opened: string | null = null;
  useApp.subscribe((state) => [state.activeTab, state.doc.activeFile, state.modeling] as const, ([tab, file, modeling]) => {
    const key = `${tab ?? ''}\u0000${file}`;
    if (!modeling || key === opened) return;
    const sameDocument = opened !== null && opened.split('\u0000')[0] === (tab ?? '');
    opened = key;
    if (sameDocument && get().designTab === 'drawing') return;
    setDesignTab(modeling.features.some((f) => SPECS[f.kind]?.sheet) ? 'sheet' : 'solid');
  }, { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] });
}

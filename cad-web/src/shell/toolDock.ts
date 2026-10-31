/**
 * Tool options live in the right-hand panel: opening any tool (a feature dialog, section,
 * measure, explode, a construction plane, one of the Drawing tab's tools) shows its options there
 * and switches to them; closing the last one returns to the tab that was open before.
 * The layout contract for every region of the app: docs/UI_LAYOUT.md.
 */
import { useSyncExternalStore } from 'react';
import { Expand, Layers, Move3d, Palette, Rows3, Spline, Wrench } from 'lucide-react';
import { get, set, useApp, type AppState, type DockTab } from '@/state/store';
import { drawingShown } from '@/state/designTab';
import { narrow } from '@/state/layout';
import { isPhone } from '@/phone/detect';
import { useFeatureDialog } from '@/modeling/dialog';
import { useFromPart } from '@/workspaces/manufacture/fromPart';
import { useCam } from '@/workspaces/manufacture/cam/state';
import { useDrawingTool, TOOL_TITLES } from '@/drawing/tools';
import { ANALYSIS_TITLES, useSurfaceAnalysis } from '@/workspaces/surface/state';
import { useAppearanceTool } from '@/materials/actions';
import { TOOL_ICONS } from '@/drawing/toolIcons';
import { OP_LABEL } from '@/workspaces/manufacture/cam/program';
import { SPECS } from '@/modeling/specs';
import { DraftIcon, DrillOpIcon, FaceMillIcon, JointIcon, MeasureIcon, OriginIcon, PocketIcon, SectionIcon, SetupIcon, SketchIcon, TangentIcon } from '@/icons/cad';
import type { IconType } from '@/commands';

const ANALYSIS_ICONS: Record<string, IconType> = { zebra: Rows3 as IconType, curvature: Spline as IconType, draft: DraftIcon, continuity: TangentIcon };

export type ToolId = 'sketch' | 'feature' | 'plane' | 'explode' | 'explodeSteps' | 'measure' | 'section' | 'analysis' | 'joint' | 'motion' | 'place' | 'toolpart' | 'cam' | 'drawing' | 'appearance';
export interface ActiveTool { id: ToolId; title: string; icon: IconType }

export function activeTools(state: AppState = get(), dialog = useFeatureDialog.getState()): ActiveTool[] {
  const tools: ActiveTool[] = [];
  // Choosing where to sketch is part of the Sketch tool: the plane prompt is in the panel, not over the view.
  if (state.sketching) tools.push({ id: 'sketch', title: state.sketching.choosing ? 'New sketch' : 'Sketch', icon: SketchIcon });
  const spec = dialog.open ? SPECS[dialog.kind] : undefined;
  if (spec) tools.push({ id: 'feature', title: dialog.editing ? `Edit ${spec.label.toLowerCase()}` : spec.label, icon: spec.icon as IconType });
  if (state.doc.open && state.tool === 'plane') tools.push({ id: 'plane', title: 'Construction plane', icon: OriginIcon });
  if (state.doc.open && state.tool === 'joint') tools.push({ id: 'joint', title: 'Joint', icon: JointIcon });
  if (state.doc.open && state.tool === 'motion') tools.push({ id: 'motion', title: 'Motion', icon: JointIcon });
  if (state.displayed && state.tool === 'place') tools.push({ id: 'place', title: 'Place', icon: Move3d });
  // A phone shows the exploded view as a strip under the model (phone/ExplodeStrip.tsx): the dock stays as it was.
  if (state.displayed && state.tool === 'explode' && !isPhone()) tools.push({ id: 'explode', title: 'Quick explode', icon: Expand });
  if (state.displayed && state.tool === 'explodeSteps') tools.push({ id: 'explodeSteps', title: 'Explode steps', icon: Layers });
  // Appearance (model.appearance): colour, finish, opacity of the part or some bodies, apart from their material.
  if (state.doc.open && state.displayed && useAppearanceTool.getState().open) tools.push({ id: 'appearance', title: 'Appearance', icon: Palette as IconType });
  if (state.displayed && state.tool === 'measure') tools.push({ id: 'measure', title: 'Measure', icon: MeasureIcon });
  // A saved section view shown from the tree is fixed: no options to show, the dock stays where it was.
  if (state.displayed && state.section.enabled && !state.section.saved) tools.push({ id: 'section', title: 'Section analysis', icon: SectionIcon });
  // The Surface tab's analysis (zebra, curvature, draft, continuity): its options and legend.
  const analysis = useSurfaceAnalysis.getState().mode;
  if (state.displayed && state.workspace === 'design' && analysis) tools.push({ id: 'analysis', title: ANALYSIS_TITLES[analysis], icon: ANALYSIS_ICONS[analysis] });
  // The Drawing tab's tools: the sheet is in the centre, the open tool's options here.
  const drawing = useDrawingTool.getState().tool;
  if (drawingShown(state) && drawing) tools.push({ id: 'drawing', title: TOOL_TITLES[drawing], icon: TOOL_ICONS[drawing] });
  const toolPart = useFromPart.getState();
  if (toolPart.open) tools.push({ id: 'toolpart', title: toolPart.kind === 'rotary_cutter' ? 'Cutter from part' : 'Holder from part', icon: Wrench as IconType });
  const cam = useCam.getState().editor;
  if (cam) {
    const kind = cam.draft.op.kind;
    const icon = cam.mode === 'setup' ? SetupIcon : kind === 'face' ? FaceMillIcon : kind === 'drill' || kind === 'peck_drill' ? DrillOpIcon : PocketIcon;
    tools.push({ id: 'cam', title: cam.mode === 'setup' ? 'Setup' : OP_LABEL[kind], icon: icon as IconType });
  }
  return tools;
}

const key = (tools: ActiveTool[]) => tools.map((t) => `${t.id}:${t.title}`).join('|');

function subscribe(callback: () => void) {
  const a = useApp.subscribe(callback);
  const b = useFeatureDialog.subscribe(callback);
  const c = useFromPart.subscribe(callback);
  const d = useCam.subscribe(callback);
  const e = useDrawingTool.subscribe(callback);
  const f = useSurfaceAnalysis.subscribe(callback);
  const g = useAppearanceTool.subscribe(callback);
  return () => { a(); b(); c(); d(); e(); f(); g(); };
}

let snapshot: ActiveTool[] = [];
function current(): ActiveTool[] {
  const next = activeTools();
  if (key(next) !== key(snapshot)) snapshot = next;
  return snapshot;
}

export function useActiveTools(): ActiveTool[] {
  return useSyncExternalStore(subscribe, current, current);
}

/** Switches the dock to a tool when one opens and back when the last one closes, closing it again if it was closed
 * before (on tablets and desktops; a phone's drawer stays as it is). */
export function installToolDock(): () => void {
  let before: DockTab | null = null;
  let wasClosed = false;
  let open = new Set<ToolId>();
  return subscribe(() => {
    const tools = activeTools();
    const ids = new Set(tools.map((t) => t.id));
    const opened = [...ids].some((id) => !open.has(id));
    open = ids;
    const { dockTab, dockOpen } = get();
    if (opened) {
      if (dockTab !== 'tool') { before = dockTab; wasClosed = !dockOpen; }
      if (dockTab !== 'tool' || !dockOpen) set({ dockTab: 'tool', dockOpen: true });
    } else if (!ids.size && dockTab === 'tool') {
      set({ dockTab: before ?? 'properties', ...(wasClosed && !narrow() ? { dockOpen: false } : {}) });
      before = null;
      wasClosed = false;
    }
  });
}

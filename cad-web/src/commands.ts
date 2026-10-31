import {openInBlender} from '@/state/actions';
import { HOSTED_COMMANDS, NON_CAD_COMMANDS } from './localCapabilities';
import { setting, useSettings } from '@/settings/store';
import { bindingLabel, resolveBindings } from '@/settings/keyboard';
import { chooseProjectArchive, downloadProjectArchive } from '@/state/projectArchive';
import { openDesktop } from './localDesktop';
import type { ComponentType } from 'react';
import { setThemeChoice } from '@/state/theme';
import { openSettings, settingsSections } from '@/settings/registry';
import { feedbackEnabled, openBugReport, openFeatureRequest, openMyReports } from '@/feedback/feedback';
import { openRmfgOrders } from '@/lib/rmfgOrders';
import { Bolt, Box, Bug, Camera, CircleHelp, Code2, Download, Expand, ExternalLink, Eye, EyeOff, Factory, FileCode, FilePlus2, FileText, Focus, FolderOpen, GitBranch, GitBranchPlus, GitMerge, Grid3x3, Import, Inbox, Keyboard, Layers3, Library, Lightbulb, Maximize2, MessageSquare, Moon, Move3d, Package, PackagePlus, Palette, PanelLeft, PanelRight, PenLine, Play, Plug, Presentation, RefreshCw, Save, ScanSearch, Settings, Share2, Sparkles, Square, Store, Variable, Workflow, X } from 'lucide-react';
import {
  FitIcon, HiddenLineIcon, MaterialIcon, MeasureIcon, OrthoIcon, OriginIcon, PerspectiveIcon, SectionIcon, ShadedEdgesIcon, ShadedIcon,
  WireframeIcon, XrayIcon,
} from '@/icons/cad';
import { get, isPreviewStale, set, type AppState, type DisplayStyle, type StandardView, type Workspace } from '@/state/store';
import {
  canLeave, captureImage, clearWorkspace, declaresDrawing, downloadSource, exportBlend, exportDrawing, exportProductDrawings, exportStep, isolate, leave,
  linksDocuments, openPart, saveDocument, selectionNodes, showAll, stopBuild, updateModel, zoomToSelection,
} from '@/state/actions';
import { hideTarget, hideableTarget, toggleTarget } from '@/state/visibility';
import { closeTab, cycleTab, openTab } from '@/state/tabs';
import { autoInspect } from '@/state/layout';
import { chooseStepFile } from '@/state/imports';
import { easeInOutCubic, tween, viewer } from '@/viewport/viewer';
import { togglePresentation, usePresent } from '@/present/state';
import { simulateCommands, simulateRibbon } from '@/workspaces/simulate/commands';
import { sketchCommands, SKETCH_RIBBON } from '@/sketch/commands';
import { HIGH, KEEP, LOW, MID } from '@/ribbonPriority';
import { sheetMetalCommands, sheetMetalRibbon } from '@/workspaces/sheetmetal/commands';
import { motionCommands, motionRibbon } from '@/motion/commands';
import { sceneCommands, sceneRibbon } from '@/motion/sceneCommands';
import { drawingCommands, drawingRibbon } from '@/drawing/commands';
import { surfaceCommands, surfaceRibbon } from '@/workspaces/surface/commands';
import { newSketch } from '@/sketch/actions';
import { openFeature, openTablePattern } from '@/modeling/dialog';
import { openAppearance, openMaterials, useAppearanceTool } from '@/materials/actions';
import { componentOfNode } from '@/state/designRefs';
import { exportComponentStep, selectionTarget } from '@/state/componentStep';
import { exportMesh } from '@/state/meshExport';
import { rememberFormat } from '@/state/exportFormat';
import { exportPrintSet, printedRows } from '@/state/printSet';
import { SPECS } from '@/modeling/specs';
import { BoxIcon, CircuitIcon, FillIcon, JointIcon, SketchIcon } from '@/icons/cad';
import { openJointTool } from '@/motion/jointTool';
import { togglePlay, useMotion } from '@/motion/state';
import { behindLinks, updateLinks } from '@/state/linkWatch';
import { openPlacement } from '@/placement/placement';
import { manufactureCommands, manufactureRibbon } from '@/workspaces/manufacture/commands';
import { electronicsCommands, electronicsRibbon } from '@/workspaces/electronics/commands';
import { useCircuit } from '@/workspaces/electronics/state';
import { openDocs, openWhatsNew } from '@/lib/docs';
import { askText } from '@/ui/confirm';
import { librariesUsable, openLibraries } from '@/state/libraries';

export type IconType = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;

export interface Command {
  id: string;
  label: string;
  /** Short label for the ribbon when the full label is long. */
  short?: string;
  description?: string;
  icon: IconType;
  shortcut?: string;
  keys?: string[];
  /** The shortcut's key is handled outside `keys` (e.g. Esc in a sketch: App's sketch keys, sketch/tools.ts escape()). */
  keysElsewhere?: true;
  category: string;
  run: () => void;
  /** true when available, otherwise the reason it isn't. */
  enabled?: (state: AppState) => true | string;
  active?: (state: AppState) => boolean;
  /** Future capability: shown in the UI but not runnable yet. */
  soon?: string;
  hidden?: (state: AppState) => boolean;
}

/** Save, asking first what this revision is (the version history shows it). */
async function saveWithMessage() {
  const message = await askText({ title: 'Save with message', detail: 'Say what this revision is. Versions shows it in the history.',
    action: 'Save', danger: false, text: { label: 'Message', placeholder: 'Exterior validation complete' } });
  if (message !== null) void saveDocument(message.trim().slice(0, 200) || undefined);
}

const needsDocument = (state: AppState) => state.doc.open || 'Open or create a design first.';
const needsModel = (state: AppState) => !!state.displayed || 'There’s no geometry yet.';
const needsIdle = (state: AppState) => !state.busy || 'Wait for the current operation to finish.';
const drawingDeclared = (state: AppState) => declaresDrawing(state.doc)
  || 'No drawing yet: add a sheet in the Drawing tab, or ask STEVE for one (“make an ISO A3 drawing with a parts list”).';
/** Opening another document needn't wait on an automatic rebuild or a document still opening (abandonQuietBuild). */
const canNavigate = (state: AppState) => state.sketching ? 'Finish or cancel the sketch before changing documents.'
  : canLeave(state) || 'Wait for the current operation to finish.';
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};

const styleCommand = (style: DisplayStyle, label: string, icon: IconType, description: string): Command => ({
  id: `view.style.${style}`, label, icon, category: 'Display', description,
  run: () => set({ style }), active: (state) => state.style === style,
});

/** The 3D view is on screen: always in CAD; in Electronics only with the 3D view (the schematic and board are flat). */
const shows3d = (state: AppState) => state.workspace !== 'electronics' || useCircuit.getState().view === '3d' || 'Switch to the 3D view first.';

const viewCommand = (view: StandardView, label: string, key: string): Command => ({
  id: `view.${view}`, label: `${label} view`, icon: Box, category: 'View', shortcut: key, keys: [key],
  run: () => viewer.setView(view), enabled: all(needsModel, shows3d), active: (state) => state.view === view,
});

/** Sketches, features and materials go into a part, or into a design's component file. */
const modelable = (state: AppState) => state.doc.kind === 'part' || (state.doc.kind === 'design'
  ? state.doc.activeFile.startsWith('components/') || 'Choose a component to edit first (Components in the browser).'
  : 'Sketches and features belong in parts and designs.');

export const baseCommands: Command[] = [
  // Document
  { id: 'doc.new.part', label: 'New part', icon: FilePlus2, category: 'Document', shortcut: 'Alt+N', keys: ['alt+n'], description: 'Start an empty part document.', run: () => openTab({ kind: 'part' }), enabled: all(needsIdle, canNavigate) },
  { id: 'design.link', label: 'Link a design or part', short: 'Link', icon: PackagePlus, category: 'Design', description: 'Use a saved part or design here, pinned to a revision, with its parameters set per use.',
    run: () => set({ dialog: 'insert' }), enabled: all(needsDocument, needsIdle, (state) => state.doc.kind === 'design' || 'Open or create a design to place parts.') },
  { id: 'shop.link', label: 'Link a shop', short: 'Link', icon: PackagePlus, category: 'Document', description: 'Use another of your shops here, pinned to a revision: its machines and tools are then <alias>.<item> in this shop’s code.',
    run: () => set({ dialog: 'insert' }), enabled: all(needsDocument, needsIdle, (state) => state.doc.kind === 'shop' || 'Open a shop to link another shop to it.'), hidden: (state) => state.doc.kind !== 'shop' },
  { id: 'design.linkCircuit', label: 'Insert circuit board', short: 'Circuit board', icon: CircuitIcon, category: 'Design',
    description: 'Place one of your circuits in this design as its 3D board, with its parts at their real heights, pinned to a revision (for an enclosure around it).',
    run: () => set({ dialog: 'insert', linkFilter: 'circuit' }), hidden: (state) => !state.workspaces.includes('electronics'),
    enabled: all(needsDocument, needsIdle, (state) => state.doc.kind === 'design' || 'Open or create a design to place a circuit board in it.') },
  { id: 'design.place', label: 'Place', short: 'Place', icon: Move3d, category: 'Design',
    description: 'Move or turn a placed component or linked part on the canvas; it writes at=(…) into main.py.',
    run: () => openPlacement(), enabled: all(needsModel, needsIdle, (state) => (state.doc.kind !== 'design' ? 'Placing belongs to designs.' : state.selection.length ? true : 'Select a component or linked part first.')),
    active: (state) => state.tool === 'place' },
  { id: 'design.joint', label: 'Joint', short: 'Joint', icon: JointIcon, category: 'Design', shortcut: 'J', keys: ['j'],
    description: 'Connect two instances so one moves on the other: revolute, slider, cylindrical or rigid, with its axis picked from a pin, bore, face or edge.',
    run: () => openJointTool(), enabled: all(needsDocument, needsIdle, (state) => state.doc.kind === 'design' || 'Joints connect the instances of a design.'),
    active: (state) => state.tool === 'joint' },
  { id: 'design.updateLinks', label: 'Update links', short: 'Update', icon: RefreshCw, category: 'Design',
    description: 'Take the latest revision of every linked part or design that has moved on. The design stays pinned until you do.',
    run: () => { void updateLinks(); }, enabled: all(needsDocument, needsIdle, (state) => (state.doc.kind !== 'design' && state.doc.kind !== 'part' ? 'Links belong to parts and designs.' : behindLinks().length ? true : 'Every link is at its latest revision.')) },
  { id: 'design.animate', label: 'Play motion', short: 'Animate', icon: Play, category: 'Design',
    description: 'Play the design’s drive (design.drive in main.py); click again to pause. Joint sliders are in Properties → Motion.',
    run: () => togglePlay(), enabled: (state) => (state.doc.kind !== 'design' ? 'Motion belongs to designs.' : useMotion.getState().kinematics?.drives.length ? true : 'Add a drive to a joint first (Joint → Drive).'),
    active: () => !!useMotion.getState().playing },
  { id: 'doc.new.blender', label: 'New Blender scene', icon: FilePlus2, category: 'Document', description: 'Meshes made with Blender Python (bpy): organic and sculpted forms, modifiers and renders.', run: () => openTab({ kind: 'blender' }), enabled: needsIdle, hidden: (state) => !state.blenderInstalled },
  { id: 'doc.new.design', label: 'New design', icon: Layers3, category: 'Document', description: 'Several components designed together: shared parameters, one file per component.', run: () => openTab({ kind: 'design' }), enabled: all(needsIdle, canNavigate) },
  { id: 'doc.new', label: 'New', icon: FilePlus2, category: 'Document', description: 'Create a part or a design.', run: () => set({ dialog: 'new' }), enabled: all(needsIdle, canNavigate) },
  { id: 'doc.open', label: 'Open…', short: 'Open', icon: FolderOpen, category: 'Document', shortcut: 'Mod+O', keys: ['mod+o'], description: 'Browse your saved parts and designs, with previews.', run: () => set({ dialog: 'open' }), enabled: canNavigate },
  { id: 'doc.import', label: 'Import…', short: 'Import', icon: Import, category: 'Document', description: 'Bring a STEP (.step, .stp) or Autodesk Fusion (.f3d) file in as a new part or as bodies in the open part. You can also drop the file on the window.', run: chooseStepFile, enabled: needsIdle },
  { id: 'doc.importProject', label: 'Import project archive…', icon: FolderOpen, category: 'Document', description: 'Restore a local project archive with its pinned linked documents, decal images and imported STEP files.', run: chooseProjectArchive, enabled: needsIdle },
  { id: 'insert.standardPart', label: 'Standard parts…', short: 'Standard part', icon: Bolt, category: 'Document',
    description: 'Search about 17,000 open-source STEP models of bought-in parts (step.parts: bearings, fasteners, motors, pulleys, extrusions…) and insert one into the open part or design.',
    run: () => set({ dialog: 'standardParts' }), enabled: needsIdle },
  { id: 'insert.library', label: 'Libraries…', short: 'Libraries', icon: Library, category: 'Document',
    description: 'Link a part from your own libraries: folders you chose with Use as library (right-click a folder in Open). File → Libraries lists them all.',
    run: () => { void openLibraries(); }, enabled: all(needsDocument, needsIdle, librariesUsable) },
  { id: 'insert.mcmaster', label: 'McMaster-Carr…', short: 'McMaster', icon: Store, category: 'Document',
    description: 'Browse McMaster-Carr in its own window, download a part’s 3-D STEP, and drop it here: it’s inserted named by its part number and kept in your McMaster parts.',
    run: () => set({ dialog: 'mcmaster' }), enabled: needsIdle },
  { id: 'doc.save', label: 'Save', icon: Save, category: 'Document', shortcut: 'Mod+S', keys: ['mod+s'], description: 'Save the name, source, references and current preview.', run: () => { void saveDocument(); }, enabled: all(needsDocument, needsIdle) },
  { id: 'doc.saveWithMessage', label: 'Save with message…', icon: Save, category: 'Document',
    description: 'Save, saying what this revision is ("Exterior validation complete"). Versions shows it in the history.',
    run: () => { void saveWithMessage(); }, enabled: all(needsDocument, needsIdle) },
  { id: 'doc.rename', label: 'Rename design', icon: PenLine, category: 'Document', shortcut: 'F2', keys: ['f2'], description: 'Rename the active design.', run: () => set({ renaming: true }), enabled: all(needsDocument, needsIdle) },
  { id: 'doc.close', label: 'Close design', icon: X, category: 'Document', description: 'Close the workspace.', run: () => { const key = get().activeTab; if (key) closeTab(key); else leave(clearWorkspace); }, enabled: all(needsDocument, needsIdle, canNavigate) },

  // Create
  { id: 'create.source', label: 'Source editor', short: 'Source', icon: Code2, category: 'Create', shortcut: 'Mod+E', keys: ['mod+e'], description: 'Edit the Python source that defines this document.', run: () => toggleDock('source'), active: (state) => state.dockOpen && state.dockTab === 'source', enabled: needsDocument },
  { id: 'create.assistant', label: 'Ask STEVE', short: 'STEVE', icon: MessageSquare, category: 'Create', shortcut: 'Mod+I', keys: ['mod+i'], description: 'Describe a part or an edit; STEVE writes and generates it.', run: () => toggleDock('assistant'), active: (state) => state.dockOpen && state.dockTab === 'assistant' },
  { id: 'create.update', label: 'Update model', short: 'Update', icon: RefreshCw, category: 'Create', shortcut: 'Mod+Enter', keys: ['mod+enter'], description: 'Regenerate geometry from the current source.', run: () => { void updateModel(); }, enabled: all(needsDocument, needsIdle, (state) => !!state.doc.code.trim() || 'Add source first.'), active: (state) => isPreviewStale(state) },
  { id: 'create.stop', label: 'Stop build', short: 'Stop', icon: Square, category: 'Create', description: 'Stop the build in progress. Your source and saved revision stay as they are, and the last model stays shown.',
    run: () => { void stopBuild(); }, enabled: (state) => !!state.buildInFlight || 'No build is running.' },

  // Model
  { id: 'model.sketch', label: 'New sketch', short: 'Sketch', icon: SketchIcon, category: 'Create', shortcut: 'Shift+S', keys: ['shift+s'],
    description: 'Sketch on the selected flat face, or choose a plane. Lines, arcs, circles, constraints and dimensions become code.',
    run: newSketch, enabled: all(needsDocument, needsIdle, modelable), active: (state) => !!state.sketching },
  ...Object.values(SPECS).filter((spec) => !spec.sheet).map((spec): Command => ({
    id: `model.${spec.kind}`, label: spec.label, short: { linear_pattern: 'Linear', circular_pattern: 'Circular', point_pattern: 'Table', plane: 'Offset plane', move: 'Move' }[spec.kind], icon: spec.icon, category: spec.kind === 'plane' ? 'Construct' : 'Create', description: spec.description,
    // Table pattern also works in a design's main.py (a component at each row of a table).
    ...(spec.kind === 'point_pattern'
      ? { run: () => { void openTablePattern(); }, enabled: all(needsDocument, needsIdle, (state: AppState) => state.doc.kind === 'design' || modelable(state)) }
      : { run: () => { void openFeature(spec.kind); }, enabled: all(needsDocument, needsIdle, modelable) }),
    ...(spec.kind === 'extrude' ? { shortcut: 'E', keys: ['e'] } : spec.kind === 'fillet' ? { shortcut: 'Shift+F', keys: ['shift+f'] } : spec.kind === 'move' ? { shortcut: 'Shift+M', keys: ['shift+m'] } : {}),
  })),

  // Assemble
  { id: 'assemble.explode', label: 'Quick explode', short: 'Quick explode', icon: Expand, category: 'Assemble', description: 'Spread every component apart with one slider to see how they fit together. Not saved: Explode steps keeps a named, step-by-step exploded view in the design.', run: toggleExplode, enabled: all(needsModel, (state) => state.displayed?.kind === 'design' || 'Available for designs.'), active: (state) => state.tool === 'explode' },
  { id: 'assemble.openPart', label: 'Open linked document', short: 'Open link', icon: ExternalLink, category: 'Assemble', description: 'Open the saved part or design behind the selected component.', run: openSelectedPart, enabled: (state) => !!selectedDocumentId(state) || 'Select a linked component.' },

  // Modify
  { id: 'model.material', label: 'Assign material', short: 'Material', icon: MaterialIcon, category: 'Modify', description: 'Choose from a few hundred engineering materials: mass, study inputs and rendering follow. Written into the code as model.material(…).',
    run: () => openMaterials(), enabled: all(needsDocument, needsModel, (state) => (state.doc.kind === 'design' && !state.doc.activeFile.startsWith('components/')
      ? state.selection.some((pick) => !!componentOfNode(pick.node)) || 'Select a component in the viewport (or open its file) to give it a material.'
      : modelable(state))) },
  { id: 'model.appearance', label: 'Appearance', short: 'Appearance', icon: Palette, category: 'Modify', description: 'Color, finish, opacity, roughness and metalness of the part, some bodies or some faces, without a material: paint, glazing, bands, presentation. No mass or study inputs. Written into the code as model.appearance(…).',
    run: () => openAppearance(), enabled: all(needsDocument, needsModel, (state) => (state.doc.kind === 'design' && !state.doc.activeFile.startsWith('components/')
      ? state.selection.some((pick) => !!componentOfNode(pick.node)) || 'Select a component in the viewport (or open its file) to give it an appearance.'
      : modelable(state))), active: () => useAppearanceTool.getState().open },
  { id: 'modify.parameters', label: 'Parameters', short: 'Parameters', icon: Variable, category: 'Modify', description: 'Edit the named numbers that drive the design; the server regenerates and verifies before saving.', run: () => set({ activeFeature: '__parameters', parameterFocus: null, selection: [], dockOpen: true, dockTab: 'properties', workspace: 'design' }),
    enabled: (state) => (state.doc.open && !!state.modeling) || (state.features?.state === 'ready' && (state.features.tree.design_parameters?.length ?? 0) > 0) || 'Open a design first.' },

  // Construct
  { id: 'construct.plane', label: 'Construction plane', short: 'Plane', icon: OriginIcon, category: 'Construct', description: 'Offset, midplane or 3-point plane, written into the source as a named cq.Plane.', run: () => openPlaneTool('offset'), enabled: needsDocument, active: (state) => state.tool === 'plane' },
  { id: 'construct.midplane', label: 'Midplane', icon: OriginIcon, category: 'Construct', description: 'Plane centered between two parallel planar faces.', run: () => openPlaneTool('midplane'), enabled: needsModel },
  { id: 'construct.points', label: 'Plane through 3 points', short: '3-point', icon: OriginIcon, category: 'Construct', description: 'Plane through three selected vertices.', run: () => openPlaneTool('points'), enabled: needsModel },

  // Inspect
  { id: 'inspect.measure', label: 'Measure', icon: MeasureIcon, category: 'Inspect', shortcut: 'M', keys: ['m'], description: 'Distances, angles, radii and areas between faces, edges and vertices.', run: () => toggleTool('measure'), enabled: (state) => (state.doc.kind === 'circuit' && state.circuitView !== '3d' ? 'Measure the board in the 3D view (the PCB view has its own ruler).' : needsModel(state)), active: (state) => state.tool === 'measure' },
  { id: 'inspect.section', label: 'Section analysis', short: 'Section', icon: SectionIcon, category: 'Inspect', shortcut: 'X', keys: ['x'], description: 'Cut the model with a plane to see inside, with hatched caps. Opens on the plane facing your view.', run: toggleSection, enabled: needsModel, active: (state) => state.section.enabled },
  { id: 'inspect.zoomSelection', label: 'Zoom to selection', icon: ScanSearch, category: 'View', shortcut: 'Z', keys: ['z'], run: zoomToSelection, enabled: needsModel },

  // Visibility
  { id: 'visibility.hide', label: 'Hide selected', icon: EyeOff, category: 'Visibility', shortcut: 'H', keys: ['h'],
    description: 'Hide what is selected: components, bodies, a sketch, a construction plane or a study.',
    run: () => { const target = hideableTarget(); if (target) hideTarget(target); },
    enabled: (state) => (state.sketching ? 'Finish the sketch first.' : !!hideableTarget(state) || 'Select something to hide.') },
  { id: 'visibility.toggle', label: 'Hide / show selected', icon: Eye, category: 'Visibility', shortcut: 'Space', keys: ['space'],
    description: 'Hide what is selected (components, bodies, a sketch, a construction plane or a study), or show it again if it is hidden. The selection stays, so Space again undoes it.',
    run: () => { const target = hideableTarget(); if (target) toggleTarget(target); },
    enabled: (state) => (state.workspace === 'manufacture' ? 'Space plays the simulation here.' : state.sketching ? 'Finish the sketch first.' : !!hideableTarget(state) || 'Select something to hide or show.') },
  { id: 'visibility.isolate', label: 'Isolate selected', short: 'Isolate', icon: Focus, category: 'Visibility', shortcut: 'I', keys: ['i'], run: () => isolate(selectionNodes()), enabled: (state) => selectionNodes(state.selection).length > 0 || 'Select components to isolate.' },
  { id: 'visibility.showAll', label: 'Show all', icon: Eye, category: 'Visibility', shortcut: 'Shift+H', keys: ['shift+h'], run: showAll, enabled: (state) => Object.values(state.tree).some((node) => node.hidden) || state.hiddenBodies.length > 0 || 'Everything is visible.' },

  // View
  { id: 'view.fit', label: 'Fit all', short: 'Fit', icon: FitIcon, category: 'View', shortcut: 'F', keys: ['f'], run: () => viewer.fit(), enabled: all(needsModel, shows3d) },
  viewCommand('iso', 'Isometric', '0'),
  viewCommand('front', 'Front', '1'),
  viewCommand('back', 'Back', '2'),
  viewCommand('left', 'Left', '3'),
  viewCommand('right', 'Right', '4'),
  viewCommand('top', 'Top', '5'),
  viewCommand('bottom', 'Bottom', '6'),
  styleCommand('shaded-edges', 'Shaded with edges', ShadedEdgesIcon, 'Solid shading with crisp B-rep edges.'),
  styleCommand('shaded', 'Shaded', ShadedIcon, 'Solid shading without edges.'),
  styleCommand('hidden-line', 'Hidden line', HiddenLineIcon, 'Line drawing with hidden edges dashed.'),
  styleCommand('wireframe', 'Wireframe', WireframeIcon, 'All edges, no faces.'),
  styleCommand('xray', 'X-ray', XrayIcon, 'Translucent faces reveal internal geometry.'),
  { id: 'view.cycleStyle', label: 'Cycle display style', icon: ShadedEdgesIcon, category: 'Display', shortcut: 'V', keys: ['v'], run: cycleStyle },
  { id: 'view.projection', label: 'Toggle perspective', icon: PerspectiveIcon, category: 'View', shortcut: 'P', keys: ['p'], run: () => set((state) => ({ projection: state.projection === 'orthographic' ? 'perspective' : 'orthographic' })), active: (state) => state.projection === 'perspective' },
  { id: 'view.ortho', label: 'Orthographic', icon: OrthoIcon, category: 'View', run: () => set({ projection: 'orthographic' }), active: (state) => state.projection === 'orthographic' },
  { id: 'view.grid', label: 'Toggle grid', icon: Grid3x3, category: 'Display', shortcut: 'G', keys: ['g'], run: () => set((state) => ({ showGrid: !state.showGrid })), active: (state) => state.showGrid },
  { id: 'view.origin', label: 'Toggle origin planes', icon: OriginIcon, category: 'Display', shortcut: 'O', keys: ['o'], run: () => set((state) => ({ showOrigin: !state.showOrigin })), active: (state) => state.showOrigin },
  { id: 'view.present', label: 'Presentation view', short: 'Present', icon: Presentation, category: 'View', shortcut: 'Shift+P', keys: ['shift+p'],
    description: 'Only the 3D view, full screen: no panels, file names or highlights, with a small player for the motion that fades away. Esc leaves it.',
    run: togglePresentation, enabled: all(needsModel, shows3d, (state) => !state.sketching || 'Finish the sketch first.'), active: () => usePresent.getState().active },
  { id: 'view.shadows', label: 'Toggle ground shadow', icon: Box, category: 'Display', run: () => set((state) => ({ showShadows: !state.showShadows })), active: (state) => state.showShadows },
  { id: 'view.collisions', label: 'Toggle collision highlights', icon: Box, category: 'Display',
    description: 'Show or hide the red tint on colliding parts and the overlap markers. Display only: checks and their results don’t change.',
    run: () => set((state) => ({ showCollisions: !state.showCollisions })), active: (state) => state.showCollisions },

  // Export
  { id: 'export.step', label: 'Export STEP', short: 'STEP', icon: Download, category: 'Export', description: 'Download the complete CAD model as STEP AP214.', run: () => { rememberFormat('step'); void exportStep(); }, enabled: all(needsIdle, (state) => !!state.displayed || 'There’s no geometry yet.') },
  { id: 'export.3mf', label: 'Export 3MF', short: '3MF', icon: Download, category: 'Export',
    description: 'Download a 3MF for your slicer: millimetres, each body a named object placed as modelled. The selection if there is one, otherwise the whole model.',
    run: () => { rememberFormat('3mf'); void exportMesh('3mf'); }, enabled: all(needsIdle, needsModel) },
  { id: 'export.stl', label: 'Export STL', short: 'STL', icon: Download, category: 'Export',
    description: 'Download one binary STL in millimetres, bodies placed as modelled. The selection if there is one, otherwise the whole model.',
    run: () => { rememberFormat('stl'); void exportMesh('stl'); }, enabled: all(needsIdle, needsModel) },
  { id: 'export.component', label: 'Export selected component', short: 'Component', icon: Download, category: 'Export',
    description: 'Download the selected component (or linked document) as STEP: as modelled, in its own coordinates, each body a named solid.',
    run: () => { const target = selectionTarget(); if (target) void exportComponentStep(target); },
    enabled: all(needsIdle, (state) => (state.doc.kind !== 'design' ? 'Component export is for designs.' : !!selectionTarget(state) || 'Select one component of the design.')) },
  { id: 'export.printSet', label: 'Export print set', short: 'Print set', icon: Download, category: 'Export',
    description: 'Download every part marked as printed (print= on design.add) in one zip: a 3MF per unique part standing on its bed in millimetres, '
      + 'plates with every copy laid out on the print bed chosen in the Export menu, quantities, a print list and a manifest tied to the revision. '
      + 'The selected printed parts if the selection has any.',
    run: () => { void exportPrintSet('3mf'); },
    enabled: all(needsIdle, needsModel, (state) => (state.doc.kind !== 'design' ? 'Print sets are for designs.'
      : printedRows(state.displayed?.metadata).length > 0 || 'Mark parts as printed first: design.add(part, print={"build_direction": "+Z"}) in main.py.')) },
  { id: 'export.drawing', label: 'Open drawing', short: 'Drawing', icon: FileText, category: 'Export',
    description: 'Open the engineering drawing the code declares (ISO or ANSI sheet, views, title block, revision table, parts and cut lists) in a full-window preview, with sheet navigation and PDF, SVG and DXF downloads. Set it up in the Drawing tab, or ask STEVE to make or change one.',
    run: () => { void exportDrawing('open'); }, enabled: all(needsIdle, needsModel, drawingDeclared) },
  { id: 'export.drawingPdf', label: 'Export drawing (PDF)', short: 'PDF', icon: FileText, category: 'Export',
    description: 'Download every drawing sheet as one PDF, a page each, at its paper size: ready to send or print, no print dialog.',
    run: () => { void exportDrawing('pdf'); }, enabled: all(needsIdle, needsModel, drawingDeclared) },
  { id: 'export.drawings', label: 'Export drawings (SVG · DXF)', short: 'Drawings', icon: Download, category: 'Export',
    description: 'Download every drawing sheet as SVG and DXF, with its parts list and cut list as CSV.',
    run: () => { void exportDrawing('zip'); }, enabled: all(needsIdle, needsModel, drawingDeclared) },
  { id: 'export.productDrawings', label: 'Export product drawings (PDF · STEP)', short: 'Product', icon: FileText, category: 'Export',
    description: 'The whole product at once: this document and every document it links, at their pinned revisions. Prints every sheet as one PDF, '
      + 'in assembly order (this document first), and downloads every document’s STEP in one zip. Documents without sheets, or that don’t build, are named.',
    run: () => { void exportProductDrawings(); },
    enabled: all(needsIdle, (state) => linksDocuments(state.doc) || 'Link parts or designs into this document first: the package is this document and everything it links.') },
  { id: 'blender.render', label: 'Render Blender scene', short: 'Render scene', icon: Camera, category: 'Export', run: () => set({dialog:'blender-renders'}), hidden: (state) => state.doc.kind !== 'blender', enabled: needsIdle },
  { id: 'blender.open', label: 'Open in Blender', short: 'Open in Blender', icon: FolderOpen, category: 'Document', run: () => {void openInBlender();}, hidden: (state) => state.doc.kind !== 'blender', enabled: all(needsIdle, (state) => !!state.displayed || 'Build the scene first.') },
  { id: 'export.blend', label: 'Export Blender file', short: '.blend', icon: Download, category: 'Export', description: 'Download the scene as a Blender (.blend) file.', run: () => { void exportBlend(); }, hidden: (state) => state.doc.kind !== 'blender', enabled: all(needsIdle, (state) => !!state.displayed || 'Build the scene first.') },
  { id: 'export.image', label: 'Capture image', short: 'Image', icon: Camera, category: 'Export', description: 'Save the viewport as a PNG.', run: captureImage, enabled: needsModel },
  { id: 'export.source', label: 'Download source', short: 'Source', icon: FileCode, category: 'Export', description: 'Download the source: the file, or every file of a design or circuit as a zip.', run: () => void downloadSource(), enabled: (state) => !!state.doc.code || 'The source is empty.' },
  { id: 'export.project', label: 'Export project archive', icon: Package, category: 'Export', description: 'Archive current source, pinned linked documents, decal images and imported STEP files for another local workspace.', run: () => void downloadProjectArchive(), enabled: (state) => (state.doc.open && ['part', 'design'].includes(state.doc.kind)) || 'Open a CAD document first.' },

  // Versions
  { id: 'doc.carbon', label: 'Send to Carbon…', short: 'Carbon', icon: Factory, category: 'Export', description: 'Send this part or design to your Carbon ERP: its item and revision, 3D model, drawing and bill of materials.',
    run: () => set({ dialog: 'carbon' }),
    enabled: (state) => (state.doc.kind !== 'part' && state.doc.kind !== 'design' ? 'Only parts and designs go to Carbon.' : state.doc.saved ? true : 'Save it first.') },
  { id: 'doc.rmfg', label: 'Order from RMFG…', short: 'RMFG', icon: Package, category: 'Export', description: 'Have RMFG make this part or design: a quote with manufacturability findings, then a cart on rmfg.com.',
    run: () => set({ dialog: 'rmfg', rmfgOrder: null }),
    enabled: (state) => (state.doc.kind !== 'part' && state.doc.kind !== 'design' ? 'Only parts and designs are made at RMFG.' : state.doc.saved ? true : 'Save it first.') },
  { id: 'doc.rmfgOrders', label: 'RMFG quotes and carts…', short: 'RMFG orders', icon: Package, category: 'Export', description: 'Every open RMFG quote, cart and order, whoever asked for it (you, STEVE or an AI agent): what’s in it, its price, and buying it.',
    run: () => openRmfgOrders() },
  { id: 'doc.share', label: 'Share link…', short: 'Share', icon: Share2, category: 'Document', description: 'Share a read-only link to this saved version: you choose what people can do with it.', run: () => set({ dialog: 'share' }), enabled: (state) => (state.doc.kind === 'circuit' ? 'Circuits can’t be shared yet.' : state.doc.kind === 'blender' ? 'Blender scenes can’t be shared yet.' : state.doc.saved ? true : 'Save the design first.') },
  { id: 'branch.new', label: 'New branch', icon: GitBranchPlus, category: 'Versions', description: 'Start a variant of this design without touching main.', run: () => set({ dialog: 'branch', branchFrom: null }), enabled: (state) => (state.doc.saved ? (state.branches ? true : 'This server doesn’t support branches yet.') : 'Save the design first.') },
  { id: 'branch.merge', label: 'Compare & merge into main', short: 'Merge', icon: GitMerge, category: 'Versions', description: 'Compare geometry and source, resolve conflicts, and merge.', run: () => set((state) => ({ dialog: 'merge', mergeBranch: state.doc.branch })), enabled: (state) => (state.doc.branch !== 'main' || 'Switch to a branch to merge it.') },
  { id: 'branch.versions', label: 'Show version history', icon: GitBranch, category: 'Versions', shortcut: 'Mod+Shift+H', keys: ['mod+shift+h'], run: () => set({ browserOpen: true, leftTab: 'versions' }) },

  // Tabs
  { id: 'tab.next', label: 'Next document tab', icon: PanelRight, category: 'Tabs', shortcut: 'Alt+]', keys: ['alt+]'], run: () => cycleTab(1), enabled: (state) => state.tabs.length > 1 || 'Only one document is open.' },
  { id: 'tab.previous', label: 'Previous document tab', icon: PanelLeft, category: 'Tabs', shortcut: 'Alt+[', keys: ['alt+['], run: () => cycleTab(-1), enabled: (state) => state.tabs.length > 1 || 'Only one document is open.' },
  { id: 'tab.close', label: 'Close document tab', icon: X, category: 'Tabs', shortcut: 'Alt+W', keys: ['alt+w'], run: () => { const key = get().activeTab; if (key) closeTab(key); }, enabled: (state) => !!state.activeTab || 'No document is open.' },

  // App
  { id: 'app.palette', label: 'Command palette', icon: Keyboard, category: 'App', shortcut: 'Mod+K', keys: ['mod+k'], run: () => set((state) => ({ dialog: state.dialog === 'palette' ? null : 'palette', paletteQuery: '' })) },
  { id: 'app.settings', label: 'Settings', icon: Settings, category: 'App', shortcut: 'Mod+,', keys: ['mod+,'], description: 'Configure Steve, local CAD, tools and this workspace.', run: () => openSettings() },
  ...settingsSections().map((section): Command => ({
    id: `app.settings.${section.id}`, label: `Settings: ${section.label}`, icon: section.icon, category: 'App', description: section.description, run: () => openSettings(section.id),
  })),
  { id: 'app.mcp', label: 'MCP servers', icon: Plug, category: 'App', description: 'Connect Steve to local or remote MCP servers and manage their sign-in.', run: () => { void openDesktop('mcp'); } },
  { id: 'app.reportBug', label: 'Report a bug', icon: Bug, category: 'App', description: 'Tell the team what went wrong; your report goes to STEVE.', run: () => openBugReport(), hidden: () => !feedbackEnabled() },
  { id: 'app.requestFeature', label: 'Request a feature', icon: Lightbulb, category: 'App', description: 'Tell the team what you’d like Steve to do; your request goes to STEVE.', run: () => openFeatureRequest(), hidden: () => !feedbackEnabled() },
  { id: 'app.myReports', label: 'My reports', icon: Inbox, category: 'App', description: 'See whether your bug reports and feature requests were fixed, added or declined.', run: () => openMyReports(), hidden: () => !feedbackEnabled() },
  { id: 'app.runAction', label: 'Run an action…', icon: Workflow, category: 'App', description: 'Run something your own software offers through a connector: print, load a program, simulate on your hardware, check stock…', run: () => set({ dialog: 'runAction' }) },
  { id: 'app.help', label: 'CAD help', icon: CircleHelp, category: 'App', shortcut: 'F1', keys: ['f1'], description: 'Open the offline CAD manual inside Steve: modeling guides, assemblies, drawings and local settings.', run: () => openDocs() },
  { id: 'app.whatsNew', label: "What's new", icon: Sparkles, category: 'App', description: 'See what changed in STEVE recently, newest first, in a new tab.', run: () => openWhatsNew() },
  { id: 'app.shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, category: 'App', shortcut: '?', keys: ['?'], run: () => set({ dialog: 'shortcuts' }) },
  { id: 'app.theme', label: 'Toggle light / dark', icon: Moon, category: 'App', run: () => setTheme(get().theme === 'dark' ? 'light' : 'dark') },
  { id: 'app.fullscreen', label: 'Toggle full screen', icon: Maximize2, category: 'App', description: 'Fill the screen with STEVE, like a desktop CAD app. Esc leaves full screen.', run: () => toggleFullscreen(), active: (state) => state.fullscreen, hidden: () => !fullscreenAvailable() },
  { id: 'app.browser', label: 'Toggle browser panel', icon: PanelLeft, category: 'App', shortcut: 'Mod+B', keys: ['mod+b'], run: () => set((state) => ({ browserOpen: !state.browserOpen })), active: (state) => state.browserOpen },
  { id: 'app.dock', label: 'Toggle inspector panel', icon: PanelRight, category: 'App', shortcut: 'Mod+.', keys: ['mod+.'], run: () => set((state) => ({ dockOpen: !state.dockOpen })), active: (state) => state.dockOpen },
  { id: 'workspace.design', label: 'Design workspace', icon: Box, category: 'Workspace', shortcut: 'Alt+1', keys: ['alt+1'], run: () => setWorkspace('design') },
  { id: 'workspace.simulate', label: 'Simulate workspace', icon: Box, category: 'Workspace', shortcut: 'Alt+2', keys: ['alt+2'], run: () => setWorkspace('simulate') },
  { id: 'workspace.manufacture', label: 'Manufacture workspace', icon: Box, category: 'Workspace', shortcut: 'Alt+3', keys: ['alt+3'], run: () => setWorkspace('manufacture') },
  { id: 'workspace.electronics', label: 'Electronics workspace', icon: Box, category: 'Workspace', shortcut: 'Alt+4', keys: ['alt+4'], run: () => setWorkspace('electronics') },
];

export const commands: Command[] = [...baseCommands, ...sketchCommands, ...simulateCommands, ...manufactureCommands, ...sheetMetalCommands, ...surfaceCommands, ...motionCommands, ...sceneCommands, ...drawingCommands, ...electronicsCommands];

export const defaultBindings = Object.fromEntries(commands.filter(c => !c.keysElsewhere).map(c => [c.id, c.keys ?? []]));
let resolvedBindings = resolveBindings(defaultBindings, setting('keyboard.preset'), setting('keyboard.overrides'));
// One source for dispatch, menus, ribbons, sketch controls and the shortcut reference.
for (const cmd of commands) {
  if (cmd.keysElsewhere) continue;
  const originalLabel = cmd.shortcut;
  Object.defineProperties(cmd, {
    keys: { get: () => resolvedBindings[cmd.id] },
    shortcut: { get: () => setting('keyboard.preset') === 'steve' && !(cmd.id in setting('keyboard.overrides'))
      && JSON.stringify(resolvedBindings[cmd.id]) === JSON.stringify(defaultBindings[cmd.id]) ? originalLabel : bindingLabel(resolvedBindings[cmd.id] ?? []) },
  });
}
useSettings.subscribe((next, previous) => {
  if (next.values['keyboard.preset'] === previous.values['keyboard.preset'] && next.values['keyboard.overrides'] === previous.values['keyboard.overrides']) return;
  resolvedBindings = resolveBindings(defaultBindings, next.values['keyboard.preset'], next.values['keyboard.overrides']);
  set({});
});
const byId = new Map(commands.map((command) => [command.id, command]));
export const command = (id: string) => {
  const found = byId.get(id);
  if (!found) throw new Error(`Unknown command ${id}`);
  return found;
};

/** The top-level workspace a command belongs to, when the deployment can turn that workspace off. */
function workspaceOf(cmd: Command): Workspace | null {
  if (cmd.id.startsWith('workspace.')) return cmd.id.slice('workspace.'.length) as Workspace;
  return cmd.category === 'Manufacture' ? 'manufacture' : cmd.category === 'Simulate' ? 'simulate' : cmd.category === 'Electronics' ? 'electronics' : null;
}

/** Commands of a workspace this deployment has turned off: hidden from the palette and never runnable. */
export function switchedOff(cmd: Command, state: AppState): boolean {
  if (HOSTED_COMMANDS.has(cmd.id) || NON_CAD_COMMANDS.has(cmd.id)) return true;
  // Blender scene playback/rendering is not a local CAD capability. Assembly
  // motion uses separate motion.* commands and remains available.
  if (cmd.id.startsWith('scene.')) return true;
  const workspace = workspaceOf(cmd);
  return !!workspace && !state.workspaces.includes(workspace);
}

export function availability(cmd: Command, state: AppState): true | string {
  if (switchedOff(cmd, state)) return 'Not available yet.';
  if (cmd.soon) return cmd.soon;
  return cmd.enabled ? cmd.enabled(state) : true;
}

export function runCommand(id: string) {
  const cmd = command(id);
  if (availability(cmd, get()) !== true) return;
  cmd.run();
}

/* ───────── Ribbon layouts ───────── */

/** Every export menu (ribbon, File, the top bar's split button) lists these; shell/ExportMenu.tsx draws them. */
export const EXPORT_MENU = ['export.step', 'export.3mf', 'export.stl', 'export.component', 'export.printSet', 'export.drawing', 'export.drawingPdf', 'export.drawings', 'export.productDrawings', 'export.image', 'export.source', 'export.project'];

export interface RibbonGroup {
  title: string; items: (string | { menu: string; label: string; icon: IconType; items: string[] })[]; visible?: (state: AppState) => boolean;
  /** Per-button visibility inside a shown group (e.g. only the boundaries a study's physics takes). */
  show?: (item: string, state: AppState) => boolean;
  /**
   * Desktop ribbon (fine pointer, ≥ 1024 px): when the groups don't fit, whole groups fold into one dropdown button,
   * lowest priority first (default 0; equal priorities fold right to left). Groups the ribbon can't do without get the most.
   */
  priority?: number;
  /** Desktop ribbon: always one dropdown button (the group's title and icon), whatever the width. */
  compact?: boolean;
  /** The folded button's icon (default: the first command's). */
  icon?: IconType;
}

export { SKETCH_RIBBON, sheetMetalRibbon, surfaceRibbon, motionRibbon, sceneRibbon, drawingRibbon };

export const RIBBONS: Record<Workspace, RibbonGroup[]> = {
  design: [
    // One "Design" dropdown on the desktop ribbon: Link, Circuit board, Place, Update. A part that links parts gets Update only.
    { title: 'Design', compact: true, icon: PackagePlus, items: ['design.link', 'design.linkCircuit', 'design.place', 'design.updateLinks'],
      visible: (state) => state.doc.kind === 'design' || (state.doc.kind === 'part' && Object.keys(state.doc.links).length > 0),
      show: (item, state) => (state.doc.kind === 'part' ? item === 'design.updateLinks' : item !== 'design.linkCircuit' || state.workspaces.includes('electronics')) },
    { title: 'Sketch', priority: KEEP, items: ['model.sketch'] },
    { title: 'Create', priority: KEEP, items: ['model.extrude', 'model.revolve', 'model.sweep', 'model.loft', 'model.hole', 'model.boundary_fill',
      { menu: 'primitive', label: 'Primitive', icon: BoxIcon, items: ['model.box', 'model.cylinder', 'model.sphere', 'model.cone', 'model.torus', 'model.text'] },
      { menu: 'surface', label: 'Surface', icon: FillIcon, items: ['model.fill', 'model.boundary_surface', 'model.thicken', 'model.solidify'] }] },
    { title: 'Modify', priority: HIGH, items: ['model.fillet', 'model.chamfer', 'model.shell', 'model.draft', 'model.move', 'model.material', 'model.appearance', 'model.decal', 'modify.parameters'] },
    { title: 'Pattern', priority: LOW, items: ['model.linear_pattern', 'model.circular_pattern', 'model.point_pattern', 'model.mirror'] },
    { title: 'Construct', items: [{ menu: 'construct', label: 'Plane', icon: OriginIcon, items: ['model.plane', 'construct.plane', 'construct.midplane', 'construct.points'] }] },
    { title: 'Assemble', priority: MID, items: ['assemble.explode', 'motion.explode', 'assemble.openPart'], visible: (state) => state.doc.kind === 'design' },
    { title: 'Inspect', priority: MID, items: ['inspect.measure', 'inspect.section'] },
    { title: 'Visibility', priority: MID, items: ['visibility.isolate', 'visibility.showAll'], visible: (state) => state.displayed?.kind === 'design' },
    { title: 'Parts', items: ['insert.standardPart', 'insert.library', 'insert.mcmaster'] },
  ],
  simulate: simulateRibbon,
  manufacture: manufactureRibbon,
  electronics: electronicsRibbon,
};

/* ───────── Helpers used by commands ───────── */

export function toggleDock(tab: AppState['dockTab']) {
  set((state) => (state.dockOpen && state.dockTab === tab ? { dockOpen: false } : { dockOpen: true, dockTab: tab }));
}

export function toggleTool(tool: AppState['tool']) {
  if (get().tool === 'explode') toggleExplode();
  set((state) => ({ tool: state.tool === tool ? 'select' : tool, measurePicks: [], selection: state.tool === tool ? state.selection : [] }));
}

let explodeRun = 0;

export function toggleExplode() {
  const run = ++explodeRun;
  const state = get();
  const leaving = state.tool === 'explode';
  set({ tool: leaving ? 'select' : 'explode', measurePicks: [] });
  const from = state.explode, to = leaving ? 0 : Math.max(state.explode, 0.55);
  // Frame the destination extent while the components travel.
  set({ explode: to });
  const box = viewer.model?.bounds(true);
  set({ explode: from });
  if (box) viewer.zoomTo(box);
  // A newer toggle supersedes this animation (e.g. Escape right after Explode).
  void tween(leaving ? 420 : 620, (t) => { if (run === explodeRun) set({ explode: from + (to - from) * t }); }, easeInOutCubic);
}

function openPlaneTool(mode: 'offset' | 'midplane' | 'points') {
  set((state) => {
    const faceSelected = state.selection.some((pick) => pick.kind === 'face');
    return { tool: 'plane', workspace: 'design', planeDraft: { ...state.planeDraft, editing: undefined, mode, reference: mode === 'offset' && faceSelected ? 'face' : state.planeDraft.reference === 'existing' ? 'XY' : state.planeDraft.reference } };
  });
}

export function toggleSection() {
  if (get().section.enabled) { set((state) => ({ section: { ...state.section, enabled: false } })); return; }
  // Open on the plane facing the camera, with the near half removed so the cap looks at the viewer.
  // Near-ties (e.g. the isometric view) prefer Z, then Y.
  const direction = viewer.cameraDirection();
  const axisIndex = [2, 1, 0].reduce((best, index) => (Math.abs(direction.getComponent(index)) > Math.abs(direction.getComponent(best)) + 1e-3 ? index : best));
  set((state) => ({ section: { ...state.section, enabled: true, axis: (['x', 'y', 'z'] as const)[axisIndex], flip: direction.getComponent(axisIndex) < 0, saved: null, at: null } }));
}

function cycleStyle() {
  const order: DisplayStyle[] = ['shaded-edges', 'shaded', 'hidden-line', 'wireframe', 'xray'];
  set((state) => ({ style: order[(order.indexOf(state.style) + 1) % order.length] }));
}

/** Light or dark for this browser (the account menu also offers the system's). */
export function setTheme(theme: AppState['theme']) {
  setThemeChoice(theme);
}

export const fullscreenAvailable = () => typeof document !== 'undefined' && !!document.fullscreenEnabled;

/** Full screen on the root element, so menus, tooltips and dialogs (portalled to body) stay visible. */
export function toggleFullscreen() {
  if (!fullscreenAvailable()) return;
  const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  request.catch(() => { /* Refused (not a user gesture, or blocked); nothing to do. */ });
}

/** Keep `fullscreen` in step with the browser, which also leaves full screen on Esc or F11. */
export function installFullscreenSync() {
  const sync = () => set({ fullscreen: !!document.fullscreenElement });
  sync();
  document.addEventListener('fullscreenchange', sync);
  return () => document.removeEventListener('fullscreenchange', sync);
}

export function setWorkspace(workspace: Workspace) {
  if (!get().workspaces.includes(workspace)) return;   // Turned off on this deployment.
  set((state) => ({ workspace, tool: 'select', measurePicks: [], ...(state.workspace !== workspace ? autoInspect() : {}) }));
}

function selectedDocumentId(state: AppState): string | undefined {
  const pick = state.selection[0];
  return pick ? state.tree[pick.node]?.documentId : undefined;
}

function openSelectedPart() {
  const id = selectedDocumentId(get());
  if (id) openPart(id);
}

/* ───────── Keyboard ───────── */

/** Normalizes a key event to strings like "mod+s", "shift+h", "alt+1" or "?". */
export function eventKey(event: KeyboardEvent) {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  let key = event.key;
  // Alt changes the produced character on some layouts; use the physical key instead.
  if (event.altKey && /^Digit\d$/.test(event.code)) key = event.code.slice(5);
  if (event.altKey && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  key = key.toLowerCase();
  if (event.shiftKey && (key.length > 1 || /[a-z]/.test(key))) parts.push('shift');
  parts.push(key === ' ' ? 'space' : key);
  return parts.join('+');
}

const HIDEABLE_ROWS = ['node', 'component', 'body', 'sketch', 'construction', 'study'].map((kind) => `[data-item^="${kind}:"]`).join(', ');

export function handleShortcut(event: KeyboardEvent): boolean {
  // An input that consumes a shortcut owns it (for example, sending a message
  // with Ctrl+Enter must not also run the global Update model command).
  if (event.defaultPrevented) return false;
  const key = eventKey(event);
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !!target.closest('.cm-editor'));
  if (typing && !key.startsWith('mod+')) return false;
  // Space presses a focused button (ribbon, dialog, a row's eye or chevron); only the own button of a row that can be
  // hidden (with an eye) gives it up, to hide or show that row.
  const pressable = key === 'space' ? target?.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"]') : null;
  if (pressable && (pressable.hasAttribute('aria-expanded') || !pressable.parentElement?.matches(HIDEABLE_ROWS))) return false;
  const state = get();
  if (state.dialog && state.dialog !== 'palette' && !command('app.palette').keys?.includes(key)) return false;
  // While sketching, sketch tools own the single-letter keys.
  const pool = state.sketching ? [...sketchCommands, ...commands] : commands.filter((candidate) => !candidate.id.startsWith('sketch.'));
  // A key can mean different things per workspace (S: a circuit's schematic; Shift+S: sketch in CAD): the available one wins.
  const bound = pool.filter((candidate) => candidate.keys?.includes(key));
  const cmd = bound.find((candidate) => availability(candidate, state) === true) ?? bound[0];
  if (!cmd) return false;
  if (typing && !['doc.save', 'app.palette', 'app.settings'].includes(cmd.id)) return false;
  if (typing && cmd.id === 'create.update' && target?.closest('.cm-editor')) return false;
  // An unavailable Space keeps its native press (a focused row still selects).
  if (key === 'space' && availability(cmd, state) !== true) return false;
  event.preventDefault();
  if (availability(cmd, state) === true) cmd.run();
  return true;
}

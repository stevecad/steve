/**
 * The Design workspace's Drawing tab: engineering drawing sheets of the part or design, written as `Drawing(...)` code,
 * the same code STEVE writes. Its ribbon is its tools, one a button (drawing/tools.ts): sheet, views, annotations,
 * tables, and the sheets' export.
 */
import { Code2, FilePlus2, FileText, ListOrdered, Maximize, MessageSquare, Scissors, Trash2, Undo2 } from 'lucide-react';
import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID, LOW } from '@/ribbonPriority';
import type { AppState } from '@/state/store';
import { get } from '@/state/store';
import { setDesignTab, drawingShown } from '@/state/designTab';
import { TOOL_ICONS } from './toolIcons';
import { arg, drawingCalls, withViewsFixed } from './code';
import { askAboutSheet, currentCall, editSheet, fitSheet, removeSheet, replacements, selectItem, showSheetCode, undoReplacement, useDrawingTab } from './state';
import { deleteBlocked, deleteItem } from './items';
import { cancelTool, isDesignSheet, startNewSheet, startTool, toolBlocked, useDrawingTool, TOOL_TITLES, type ToolKind } from './tools';
import { MAIN, filesOf } from '@/state/design';

const needsCad = (state: AppState) => (state.doc.open && (state.doc.kind === 'part' || state.doc.kind === 'design')) || 'Open or create a part or design first.';
const needsIdle = (state: AppState) => !state.busy || 'Wait for the current operation to finish.';
const all = (...checks: ((state: AppState) => true | string)[]) => (state: AppState) => {
  for (const check of checks) { const result = check(state); if (result !== true) return result; }
  return true as const;
};
const code = (state: AppState) => (state.doc.kind !== 'design' || state.doc.activeFile === MAIN ? state.doc.code : filesOf(state.doc)[MAIN] ?? '');
const hasSheet = (state: AppState) => drawingCalls(code(state)).length > 0 || 'Add a sheet first (New sheet).';
const onDrawing = (state: AppState) => drawingShown(state) || 'Open the Drawing tab.';

/** A ribbon button that starts one of the Drawing tab's tools; pressed while it's open. */
function tool(kind: ToolKind, description: string, short?: string): Command {
  return {
    id: `drawing.${kind}`, label: TOOL_TITLES[kind], short, icon: TOOL_ICONS[kind], category: 'Drawing', description,
    run: () => (useDrawingTool.getState().tool === kind ? cancelTool() : startTool(kind)),
    enabled: (state) => { const ready = all(needsCad, onDrawing, hasSheet)(state); return ready === true ? toolBlocked(kind) ?? true : ready; },
    active: () => useDrawingTool.getState().tool === kind,
  };
}

export const drawingCommands: Command[] = [
  { id: 'drawing.tab', label: 'Drawing tab', icon: FileText, category: 'Drawing',
    description: 'Engineering drawings of this part or design: sheets, views, dimensions, GD&T, tables and title block, with STEVE beside it.',
    run: () => setDesignTab('drawing'), enabled: needsCad, active: (state) => state.designTab === 'drawing' },
  { id: 'drawing.new', label: 'New sheet', icon: FilePlus2, category: 'Drawing',
    description: 'Add a sheet: choose its standard, size, orientation, template and what it draws, then place its views (or start with the standard ones). Written into the code as Drawing(…).',
    run: () => (useDrawingTool.getState().tool === 'new-sheet' ? cancelTool() : startNewSheet()), enabled: all(needsCad, needsIdle),
    active: () => useDrawingTool.getState().tool === 'new-sheet' },
  tool('sheet-format', 'The sheet’s standard, size, orientation, projection, scale and units (a second one in brackets too), and templates to reuse them.', 'Format'),
  tool('title-block', 'The title and the title block’s fields: number, owner, drawn and checked by, material, tolerances…'),
  tool('base', 'Add a view of the model: choose its orientation (or a sheet-metal part’s flat pattern), then click where it goes.', 'Base'),
  tool('projected', 'Project a view from another: pick it, move to the side the new view goes, click.', 'Projected'),
  tool('section', 'Draw a cutting line across a view, then click the side the section looks from.', 'Section'),
  tool('detail', 'Circle part of a view to show it larger: click its centre, drag out the circle, click where it goes.', 'Detail'),
  tool('dimension', 'Click one or two edges, circles or corners in a view, then where the dimension goes: a diameter, a length, a distance or an angle.'),
  tool('note', 'Click where a note goes on the sheet, then type it; click an edge, face or corner first to put it on a leader (FLUSH, TYP).'),
  tool('balloon', 'Click a part of the design, then where its balloon goes: numbered from the parts list.'),
  tool('frame', 'A feature control frame: set its tolerance, click a feature or a dimension, then where it goes.', 'GD&T'),
  tool('datum', 'A datum feature symbol: click a feature or a dimension, then where it goes.'),
  tool('weld', 'A weld symbol (AWS A2.4 or ISO 2553): set its type and size, click one or more edges, faces or corners of the joint (an arrow each), then where the reference line goes.'),
  { id: 'drawing.parts-list', label: 'Parts list', icon: ListOrdered, category: 'Drawing',
    description: 'The design’s parts list above the title block, numbered as its balloons are.',
    run: () => { void showTable('parts-list'); },
    enabled: (state) => { const ready = all(needsCad, onDrawing, hasSheet, needsIdle)(state); if (ready !== true) return ready; const current = currentCall(); return !current || !isDesignSheet(current.call) ? 'A parts list goes on a design’s sheet.' : true; } },
  tool('hole-table', 'List a view’s holes with their positions, sizes and threads: click the view, then the holes and a corner to measure from.', 'Hole table'),
  tool('revision', 'Add a row to the revision table: what changed, when and by whom.', 'Revision'),
  { id: 'drawing.cut-list', label: 'Cut list', icon: Scissors, category: 'Drawing', description: 'Each body’s stock size, above the title block.',
    run: () => { void showTable('cut-list'); }, enabled: all(needsCad, onDrawing, hasSheet, needsIdle) },
  { id: 'drawing.delete', label: 'Delete', icon: Trash2, category: 'Drawing', shortcut: 'Delete', keys: ['delete', 'backspace'],
    description: 'Delete what’s selected on the drawing sheet.',
    run: () => { const selected = useDrawingTab.getState().selected; if (selected) void deleteItem(selected); },
    enabled: (state) => {
      const selected = useDrawingTab.getState().selected;
      if (!drawingShown(state) || !selected || useDrawingTool.getState().tool) return 'Select something on the drawing sheet first.';
      // null: it can go; undefined: it never can (the title block stays with its sheet); else why not now.
      const blocked = deleteBlocked(selected, currentCall()?.call);
      return blocked === null ? true : blocked ?? 'The title block stays with its sheet.';
    },
    hidden: () => true },
  // The key is handled by the Drawing tab itself (DrawingTab.tsx), which leaves Ctrl+Z to text boxes and the code editor.
  { id: 'drawing.undo-value', label: 'Undo writing a value over an expression', icon: Undo2, category: 'Drawing', shortcut: 'Mod+Z', keysElsewhere: true,
    description: 'Put back the variable or expression the last edit on the sheet wrote a plain value over.',
    run: () => { void undoReplacement(); },
    enabled: (state) => { const ready = all(needsCad, onDrawing, needsIdle)(state); return ready !== true ? ready : replacements().length > 0 || 'No edit wrote a value over an expression.'; } },
  { id: 'drawing.remove', label: 'Delete drawing sheet', icon: Trash2, category: 'Drawing',
    description: 'Delete the shown sheet’s Drawing(…) from the code.', run: () => { void removeSheet(); }, enabled: all(needsCad, needsIdle, hasSheet) },
  { id: 'drawing.fit', label: 'Fit sheet', icon: Maximize, category: 'Drawing', description: 'Show the whole sheet. Scroll to zoom and drag to pan.', run: fitSheet, enabled: needsCad },
  { id: 'drawing.code', label: 'Show drawing code', icon: Code2, category: 'Drawing', description: 'Open the code at the shown sheet’s Drawing(…).',
    run: showSheetCode, enabled: all(needsCad, hasSheet) },
  { id: 'drawing.ask', label: 'Ask STEVE about the drawing', icon: MessageSquare, category: 'Drawing',
    description: 'STEVE edits the same Drawing(…) code: “fill the title block”, “add a revision B for the new holes”, “a sheet per component”.',
    run: askAboutSheet, enabled: needsCad },
];

/** Puts a table on the shown sheet when it isn't there, and selects it. */
async function showTable(kind: 'parts-list' | 'cut-list') {
  const current = currentCall();
  if (!current) return;
  selectItem({ kind });
  const changes = kind === 'parts-list'
    ? arg(current.call, 'bom').value === false ? { bom: undefined } : null
    : arg(current.call, 'cut_list').value !== true ? { cut_list: 'True' } : null;
  if (!changes) return;
  const tab = useDrawingTab.getState();
  const report = tab.reports?.sheets[current.index];
  // Tables can switch the runtime's layout from above to beside the title block.
  // Preserve the user's placed views instead of applying their offsets to a new grid
  // and pushing them off the paper. Untouched standard views still arrange automatically.
  const placed = report?.views_placed?.some((view) => view.at?.some((offset) => offset !== 0));
  const positions = placed && tab.built === code(get()) && report ? withViewsFixed(current.call, report) : null;
  await editSheet({ ...positions, ...changes });
}

export const drawingRibbon: RibbonGroup[] = [
  { title: 'Sheet', priority: KEEP, items: ['drawing.new', 'drawing.sheet-format', 'drawing.title-block'] },
  { title: 'Views', priority: KEEP, items: ['drawing.base', 'drawing.projected', 'drawing.section', 'drawing.detail'] },
  { title: 'Annotate', priority: HIGH, items: ['drawing.dimension', 'drawing.note', 'drawing.balloon', 'drawing.frame', 'drawing.datum', 'drawing.weld'] },
  { title: 'Tables', priority: MID, items: ['drawing.parts-list', 'drawing.hole-table', 'drawing.revision', 'drawing.cut-list'] },
  { title: 'Export', priority: LOW, items: ['export.drawing', 'export.drawings', 'export.productDrawings'] },
];

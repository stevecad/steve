/**
 * The Drawing tab's right-click menus (a long press on touch, the Menu key or Shift+F10), on the sheet and in the
 * Browser's drawing tree alike: for what was clicked, what it can do now. A view: edit it, project, cut or detail it,
 * line it up again, delete it; a dimension: edit, tolerance, flip it, move its text, delete; a weld symbol: edit, add
 * or remove an arrow, reset its placement, delete; a sheet: a new view, its
 * format and title block, rename, duplicate, reorder (up and down in the tree, left and right on its tab), delete; a table: edit, delete; empty paper: the tools that make
 * something there; while a tool is open, only that tool's own actions. Delete is the Delete key.
 */
import type { ReactNode } from 'react';
import { Box, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Copy, FlipHorizontal2, Maximize, Minus, Pencil, PencilLine, Percent, Plus, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { ContextItem, ContextLabel, ContextSeparator, ContextSub } from '@/ui';
import type { DrawingSheet } from '@/lib/api';
import { useApp } from '@/state/store';
import {
  arg, atOf, balloonRows, hasLeaders, noteRows, OWN_VIEWS, pyList, viewItems, viewName, WELD_LEADERS, weldRefs, weldRows, withKeys, withoutLeader, withViewAt, type DrawingCall,
} from './code';
import { deleteBlocked, deleteItem, itemLabel, listOf, renamable, viewsOf } from './items';
import {
  currentCall, duplicateSheet, showInModel, editDimension, editBalloon, editItem, editSheet, editWeld, fitSheet, moveSheet, sheetCalls, sheetMoveProblem, useDrawingTab, type DrawingItem,
} from './state';
import { TOOL_ICONS } from './toolIcons';
import { cancelTool, finishBlocked, finishTool, toolEscape, tryTool, useDrawingTool, TOOL_TITLES, type ToolKind } from './tools';

/** `geometry`: the right click was on the model's geometry in that view (picked into the selection). */
export type MenuTarget = { kind: 'item'; item: DrawingItem; geometry?: boolean } | { kind: 'empty' } | { kind: 'tool' };

const I = { size: 15 } as const;

function ToolItem({ tool, label, preset }: { tool: ToolKind; label?: string; preset?: { view?: string } }) {
  const Icon = TOOL_ICONS[tool];
  return <ContextItem icon={<Icon {...I} />} onSelect={() => tryTool(tool, preset)}>{label ?? `${TOOL_TITLES[tool]}`}</ContextItem>;
}

function DeleteItem({ item, call }: { item: DrawingItem; call?: DrawingCall }) {
  const blocked = deleteBlocked(item, call);
  if (blocked === undefined) return null;
  return (
    <ContextItem icon={<Trash2 {...I} />} danger shortcut="Delete" disabled={!!blocked} reason={blocked ?? undefined} onSelect={() => { void deleteItem(item); }}>
      {item.kind === 'sheet' ? 'Delete sheet' : 'Delete'}
    </ContextItem>
  );
}

/** Turns a section round: it looks the other way, and goes on the other side of its cutting line. */
async function flipSection(call: DrawingCall, name: string) {
  const rows = listOf(arg(call, 'section_views').value);
  await editSheet({ section_views: pyList(rows.map((row) => (row.name === name ? withKeys(row, { flip: row.flip === true ? undefined : true, at: undefined }) : row))) });
}

/** Moves a sheet one place; when it can't be moved safely, the entry says why. */
function MoveItem({ index, to, icon, children }: { index: number; to: number; icon: ReactNode; children: ReactNode }) {
  const problem = sheetMoveProblem(index, to);
  return <ContextItem icon={icon} disabled={!!problem} reason={problem ?? undefined} onSelect={() => { void moveSheet(index, to); }}>{children}</ContextItem>;
}

/** The menu for something on a sheet. `rename` starts renaming it in place (the tree's rows); `tabs`: a sheet's tab
 *  above the paper, whose sheets move left and right. */
export function ItemMenu({ item, report, rename, sheet, geometry, tabs }: { item: DrawingItem; report?: DrawingSheet; rename?: () => void; sheet?: number; geometry?: boolean; tabs?: boolean }) {
  useApp((state) => state.busy);  // Its entries follow whether a build is running.
  const shown = useDrawingTab((state) => state.sheet);
  const call = sheet !== undefined ? sheetCalls()[sheet] : currentCall()?.call;
  if (!call) return null;
  const label = itemLabel(item, call, report);
  const renameEntry = rename && renamable(item, call) ? <ContextItem icon={<PencilLine {...I} />} shortcut="F2" onSelect={rename}>Rename</ContextItem> : null;
  const edit = (title = 'Edit', field?: string) => <ContextItem icon={<Pencil {...I} />} onSelect={() => editItem(item, field, sheet)}>{title}</ContextItem>;
  let entries: ReactNode;
  switch (item.kind) {
    case 'sheet': {
      const index = sheet ?? shown;
      const count = sheetCalls().length;
      entries = (
        <>
          <ToolItem tool="base" label="New view" />
          <ToolItem tool="sheet-format" label="Sheet format…" />
          <ToolItem tool="title-block" label="Title block…" />
          <ContextSeparator />
          {renameEntry}
          <ContextItem icon={<Copy {...I} />} onSelect={() => { void duplicateSheet(index); }}>Duplicate</ContextItem>
          {index > 0 && <MoveItem index={index} to={index - 1} icon={tabs ? <ArrowLeft {...I} /> : <ArrowUp {...I} />}>{tabs ? 'Move left' : 'Move up'}</MoveItem>}
          {index < count - 1 && <MoveItem index={index} to={index + 1} icon={tabs ? <ArrowRight {...I} /> : <ArrowDown {...I} />}>{tabs ? 'Move right' : 'Move down'}</MoveItem>}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    }
    case 'view': {
      const view = viewsOf(call).find((entry) => entry.name === item.name);
      const own = view?.kind === 'base' ? viewItems(call).find((entry) => viewName(entry) === item.name) : view?.row;
      const at = atOf(own && typeof own === 'object' && !Array.isArray(own) ? own.at : undefined);
      const fixed = !!(own && typeof own === 'object' && !Array.isArray(own) && own.position !== undefined);
      const moved = (at[0] !== 0 || at[1] !== 0 || fixed) && !!withViewAt(call, item.name, [0, 0]);
      const orthographic = !OWN_VIEWS.includes(item.name);
      entries = (
        <>
          {geometry && <ContextItem icon={<Box {...I} />} onSelect={showInModel}>Show in 3D view</ContextItem>}
          {edit('Edit view')}
          {renameEntry}
          {orthographic && <ContextSeparator />}
          {view?.kind === 'base' && orthographic && <ToolItem tool="projected" label="Projected view from here" preset={{ view: item.name }} />}
          {orthographic && <ToolItem tool="section" label="Section view" preset={{ view: item.name }} />}
          {orthographic && <ToolItem tool="detail" label="Detail view" preset={{ view: item.name }} />}
          {view?.kind === 'section' && arg(call, 'section_views').editable && (
            <ContextItem icon={<FlipHorizontal2 {...I} />} onSelect={() => { void flipSection(call, item.name); }}>Flip direction</ContextItem>
          )}
          {moved && (
            <>
              <ContextSeparator />
              <ContextItem icon={<RotateCcw {...I} />} onSelect={() => { void editSheet(withViewAt(call, item.name, [0, 0])!); }}>
                {view?.kind === 'detail' || item.name === 'front' || OWN_VIEWS.includes(item.name) ? 'Back to its place' : 'Align with its parent'}
              </ContextItem>
            </>
          )}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    }
    case 'dimension': {
      const row = listOf(arg(call, 'feature_dimensions').value)[item.number - 1];
      const placed = report?.placed?.find((entry) => entry.dimension === item.number);
      const side = (row?.side as string | undefined) ?? placed?.side ?? placed?.sides[0];
      const other = placed?.sides.length === 2 ? placed.sides.find((name) => name !== side) : undefined;
      const moved = !!row && ['offset', 'side', 'text_at'].some((key) => row[key] !== undefined);
      const textAt = row?.text_at;
      const editable = arg(call, 'feature_dimensions').editable && !!row;
      entries = (
        <>
          {edit()}
          {edit('Tolerance…', 'tolerance')}
          {editable && (other || placed?.type === 'linear' || placed?.type === 'aligned' || placed?.type === 'angle' || moved) && <ContextSeparator />}
          {editable && other && (
            <ContextItem icon={<FlipHorizontal2 {...I} />} onSelect={() => { void editDimension(item.number, { side: other === placed!.sides[0] ? undefined : other }); }}>Flip side</ContextItem>
          )}
          {editable && placed && placed.type !== 'round' && (textAt === undefined ? (
            <>
              <ContextItem icon={<ArrowUp {...I} style={{ transform: 'rotate(-90deg)' }} />} onSelect={() => { void editDimension(item.number, { text_at: 'start' }); }}>Move text to start</ContextItem>
              <ContextItem icon={<ArrowUp {...I} style={{ transform: 'rotate(90deg)' }} />} onSelect={() => { void editDimension(item.number, { text_at: 'end' }); }}>Move text to end</ContextItem>
            </>
          ) : <ContextItem icon={<RotateCcw {...I} />} onSelect={() => { void editDimension(item.number, { text_at: undefined }); }}>Place text automatically</ContextItem>)}
          {editable && moved && (
            <ContextItem icon={<RotateCcw {...I} />} onSelect={() => { void editDimension(item.number, { offset: undefined, side: undefined, text_at: undefined }); }}>Reset placement</ContextItem>
          )}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    }
    case 'balloon': {
      const drawn = report?.balloons_placed ?? [];
      const placed = drawn.find((entry) => entry.balloon === item.number);
      const rows = balloonRows(call);
      const row = Array.isArray(rows) && placed?.index ? rows[placed.index - 1] : undefined;
      const moved = !!row && (row.side !== undefined || row.offset !== undefined);
      entries = (
        <>
          {edit()}
          {moved && placed && <ContextItem icon={<RotateCcw {...I} />} onSelect={() => { void editBalloon(placed, drawn, { side: undefined, offset: undefined }); }}>Reset placement</ContextItem>}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    }
    case 'weld': {
      const rows = weldRows(call);
      const row = rows?.[item.number - 1];
      const refs = row && hasLeaders(row) ? weldRefs(row) : [];
      const moved = !!row && ['at', 'place', 'offset'].some((key) => row[key] !== undefined);
      entries = (
        <>
          {edit()}
          {row && hasLeaders(row) && <ContextSeparator />}
          {row && hasLeaders(row) && (
            <ContextItem icon={<Plus {...I} />} disabled={refs.length >= WELD_LEADERS} reason={refs.length >= WELD_LEADERS ? `A weld symbol has up to ${WELD_LEADERS} arrows.` : undefined}
              onSelect={() => tryTool('weld', { weld: item.number })}>Add arrow</ContextItem>
          )}
          {refs.length > 1 && (
            <ContextSub icon={<Minus {...I} />} label="Remove arrow" id="drawing-weld-remove-arrow">
              {refs.map((ref, i) => (
                <ContextItem key={ref} onSelect={() => { void editWeld(item.number, { refs: withoutLeader(row!, i).refs }); }}>{`Arrow ${i + 1} · ${ref}`}</ContextItem>
              ))}
            </ContextSub>
          )}
          {moved && <ContextItem icon={<RotateCcw {...I} />} onSelect={() => { void editWeld(item.number, { at: undefined, place: undefined, offset: undefined }); }}>Reset placement</ContextItem>}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    }
    case 'note': {
      const row = noteRows(call)[item.number - 1];
      entries = (
        <>
          {edit(row && typeof row !== 'string' ? 'Edit text' : 'Edit')}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    }
    case 'title-block':
      entries = edit();
      break;
    case 'revisions':
      entries = (
        <>
          {edit()}
          <ToolItem tool="revision" label="Add revision" />
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
      break;
    default:
      entries = (
        <>
          {edit()}
          <ContextSeparator />
          <DeleteItem item={item} call={call} />
        </>
      );
  }
  return (
    <>
      <ContextLabel>{label}</ContextLabel>
      {entries}
    </>
  );
}

/** While a tool is open: its own actions, and nothing else. */
function ToolMenu() {
  const tool = useDrawingTool();
  if (!tool.tool) return null;
  const blocked = finishBlocked(tool);
  return (
    <>
      <ContextLabel>{TOOL_TITLES[tool.tool]}</ContextLabel>
      {!blocked && <ContextItem icon={<Check {...I} />} shortcut="Enter" onSelect={() => { void finishTool(); }}>OK</ContextItem>}
      {tool.tool === 'dimension' && tool.picks.length === 1 && tool.picks[0].kind === 'circle' && (
        <ContextItem icon={<Percent {...I} />} onSelect={() => useDrawingTool.setState({ options: { ...tool.options, kind: tool.options.kind === 'radius' ? 'diameter' : 'radius' } })}>
          {tool.options.kind === 'radius' ? 'Diameter instead' : 'Radius instead'}
        </ContextItem>
      )}
      {(((tool.tool === 'dimension' || tool.tool === 'weld') && tool.picks.length > 0) || (['datum', 'frame', 'balloon'].includes(tool.tool) && tool.step === 'place')) && (
        <ContextItem icon={<Undo2 {...I} />} onSelect={() => toolEscape()}>Undo last pick</ContextItem>
      )}
      <ContextItem icon={<X {...I} />} shortcut="Esc" onSelect={cancelTool}>Cancel</ContextItem>
    </>
  );
}

/** The sheet's menu, for what was right-clicked on it. */
export function SheetMenu({ target, report }: { target: MenuTarget; locked: string | null; report?: DrawingSheet }) {
  if (target.kind === 'tool') return <ToolMenu />;
  if (target.kind === 'item') return <ItemMenu item={target.item} report={report} geometry={target.geometry} />;
  return (
    <>
      <ToolItem tool="base" />
      <ToolItem tool="note" />
      <ToolItem tool="dimension" />
      <ContextSeparator />
      <ContextItem icon={<Maximize {...I} />} shortcut="Double-click" onSelect={fitSheet}>Fit sheet</ContextItem>
    </>
  );
}

/**
 * What a sheet holds, as the Drawing tab lists and edits it: its views (section and detail views under their parent),
 * the annotations on each, its tables, notes and title block (the Browser's drawing tree, drawing/DrawingTree.tsx), and
 * the edits each one takes from its menus and the Delete key: delete, rename, reorder. Every edit rewrites the sheet's
 * `Drawing(...)` call (drawing/code.ts) and rebuilds, as STEVE's edits do.
 */
import type { DrawingSheet } from '@/lib/api';
import { get } from '@/state/store';
import {
  arg, balloonRows, CHARACTERISTICS, childViews, datumOf, dependantsOf, FLAT, fixedNote, holeTableRows, isLeaderNote, isListedNote, labelOf, noteRows, notesText, OWN_VIEWS, parseDatumLabel, py, pyList, scaleLabel,
  standardOf, viewItems, viewName, weldRows, weldsText, withKeys, withoutView, withViewRenamed, type DrawingCall, type PyValue,
} from './code';
import {
  currentCall, editSheet, removeBalloon, removeHoleTable, removeSheet, renameSheet, selectItem, sheetCalls, useDrawingTab, type DrawingItem,
} from './state';
import { askConfirm } from '@/ui/confirm';

export const BUSY = 'Wait for the current operation to finish.';

const text = (value: PyValue | undefined) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
export const asDict = (value: PyValue | undefined): Record<string, PyValue> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
/** An argument's rows (the runtime takes one dict as well as a list of them). */
export const listOf = (value: PyValue | undefined): Record<string, PyValue>[] =>
  (Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []).map((row) => asDict(row));
const asList = (value: PyValue | undefined): PyValue[] => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []);
export const refsOf = (row: Record<string, PyValue>): PyValue[] => (Array.isArray(row.datums) ? row.datums : typeof row.datums === 'string' ? [row.datums] : []);

/** A view's name as people read it: Front, Isometric, Section A-A, Detail B. */
export function viewTitle(name: string, kind?: 'section' | 'detail'): string {
  if (kind === 'section') return `Section ${name}-${name}`;
  if (kind === 'detail') return `Detail ${name}`;
  if (/^[A-Z]/.test(name)) return `View ${name}`;
  return name === 'iso' ? 'Isometric' : name === FLAT ? 'Flat pattern' : name[0].toUpperCase() + name.slice(1);
}

/** A weld type as people read it: Fillet, Flare-bevel, V-groove. */
export const weldTypeName = (type: string) => ({ fillet: 'Fillet', plug: 'Plug', slot: 'Slot', spot: 'Spot', square: 'Square groove', v: 'V-groove',
  bevel: 'Bevel groove', u: 'U-groove', j: 'J-groove', flare_v: 'Flare-V', flare_bevel: 'Flare-bevel' } as Record<string, string>)[type] ?? type;
/** A weld's type and size, as the drawing tree shows it. */
const weldMeta = (row: Record<string, PyValue>) => [weldTypeName(text(row.type)), text(row.size)].filter(Boolean).join(' ') || undefined;

export const characteristicName =(characteristic: string) => CHARACTERISTICS.find(([name]) => name === characteristic)?.[1] ?? characteristic;

/** The sheet's views in drawing order, each with its kind and parent. */
export function viewsOf(call: DrawingCall): { name: string; kind: 'base' | 'section' | 'detail'; parent?: string; row?: Record<string, PyValue> }[] {
  return [
    ...viewItems(call).map((item) => ({ name: viewName(item), kind: 'base' as const })),
    ...childViews(call).map((child) => ({ name: text(child.row.name), kind: child.kind, parent: text(child.row.parent) || undefined, row: child.row })),
  ].filter((view) => view.name);
}

/** The orthographic views on the sheet: what dimensions, GD&T and hole tables can go on. */
export const orthographic = (call: DrawingCall) => viewsOf(call).filter((view) => !OWN_VIEWS.includes(view.name));

export interface TreeNode {
  item: DrawingItem;
  label: string;
  meta?: string;
  /** Why it isn't drawn (geometry gone, can't be measured), from the build. */
  issue?: string;
  children: TreeNode[];
}

/** One sheet's contents as the drawing tree lists them: views (child views under their parent, each view's
 *  annotations under it), then the tables, notes and title block. */
export function sheetTree(call: DrawingCall, report?: DrawingSheet): TreeNode[] {
  const views = viewsOf(call);
  const first = views.find((view) => !OWN_VIEWS.includes(view.name))?.name ?? 'front';
  const nodes = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const view of views) {
    const own = view.kind === 'base' ? asDict(viewItems(call).find((item) => viewName(item) === view.name)) : view.row ?? {};
    // The front view is the sheet's master: the others are projected from it (`front=` turns it).
    const meta = [view.kind === 'base' && view.name === 'front' ? 'master' : undefined, view.name === FLAT ? text(own.body) : undefined, scaleLabel(own.scale)]
      .filter(Boolean).join(' · ') || undefined;
    const node: TreeNode = { item: { kind: 'view', name: view.name }, label: viewTitle(view.name, view.kind === 'base' ? undefined : view.kind), meta, children: [] };
    nodes.set(view.name, node);
    (view.parent && nodes.get(view.parent) ? nodes.get(view.parent)!.children : roots).push(node);
  }
  for (const item of report?.dangling_views ?? []) { const node = nodes.get(item.view); if (node) node.issue = `Not drawn: its geometry is gone from the model (${item.problem}).`; }
  for (const item of report?.view_problems ?? []) { const node = nodes.get(item.view); if (node) node.issue = `Not drawn: ${item.problem}`; }
  const under = (view: string | undefined) => nodes.get(view ?? first) ?? roots[0];
  const issueOf = (match: (item: { dimension?: number; annotation?: string; index?: number | null }) => boolean) => {
    const gone = report?.dangling?.find(match);
    if (gone) return `Not drawn: its geometry is gone from the model (${gone.problem}).`;
    const problem = report?.dimension_problems?.find(match) ?? report?.hole_problems?.find(match) ?? report?.balloon_problems?.find(match);
    return problem ? `Not drawn: ${problem.problem}` : undefined;
  };

  const dims = listOf(arg(call, 'feature_dimensions').value);
  dims.forEach((row, i) => {
    under(text(row.view))?.children.push({ item: { kind: 'dimension', number: i + 1 }, label: `Dimension ${i + 1}`,
      meta: text(row.kind) || asList(row.refs).map(String).join(' ↔ '), issue: issueOf((item) => item.dimension === i + 1 && !item.annotation), children: [] });
  });
  const viewOfDimension = (id: PyValue | undefined) => text(dims.find((row) => row.id === id)?.view);
  listOf(arg(call, 'datums').value).forEach((row, i) => {
    under(text(row.view) || viewOfDimension(row.dimension))?.children.push({ item: { kind: 'datum', number: i + 1 }, label: `Datum ${text(row.label)}`,
      meta: row.dimension !== undefined ? 'on a dimension' : text(row.ref), issue: issueOf((item) => item.annotation === 'datum' && item.index === i + 1), children: [] });
  });
  listOf(arg(call, 'tolerance_frames').value).forEach((row, i) => {
    under(text(row.view) || viewOfDimension(row.dimension))?.children.push({ item: { kind: 'frame', number: i + 1 }, label: characteristicName(text(row.characteristic)),
      meta: text(row.tolerance), issue: issueOf((item) => item.annotation === 'frame' && item.index === i + 1), children: [] });
  });
  (weldRows(call) ?? []).forEach((row, i) => {
    under(text(row.view))?.children.push({ item: { kind: 'weld', number: i + 1 }, label: `Weld symbol ${i + 1}`, meta: weldMeta(row),
      issue: issueOf((item) => item.annotation === 'weld' && item.index === i + 1), children: [] });
  });
  noteRows(call).forEach((row, i) => {  // Leader notes under the view they point into.
    if (isLeaderNote(row)) under(row.view)?.children.push({ item: { kind: 'note', number: i + 1 }, label: row.text || 'Note', meta: row.ref,
      issue: issueOf((item) => item.annotation === 'note' && item.index === i + 1), children: [] });
  });
  for (const balloon of report?.balloons_placed ?? []) {
    under(balloon.view)?.children.push({ item: { kind: 'balloon', number: balloon.balloon }, label: `Balloon ${balloon.item}`, meta: balloon.instance, children: [] });
  }
  const sheetLevel: TreeNode[] = [];
  holeTableRows(call).forEach((row, i) => {
    sheetLevel.push({ item: { kind: 'hole-table', number: i + 1 }, label: `Hole table ${i + 1}`, meta: viewTitle(text(row.view) || 'top'),
      issue: issueOf((item) => item.annotation === 'hole' && item.index === i + 1 && !('refs' in item && (item as { refs: string[] }).refs.length)), children: [] });
  });
  if (report?.parts_list || (report === undefined && arg(call, 'bom').value === true)) sheetLevel.push({ item: { kind: 'parts-list' }, label: 'Parts list', meta: report ? `${report.parts_list} items` : undefined, children: [] });
  if (arg(call, 'cut_list').value === true) sheetLevel.push({ item: { kind: 'cut-list' }, label: 'Cut list', children: [] });
  const revisions = asList(arg(call, 'revisions').value);
  if (revisions.length) sheetLevel.push({ item: { kind: 'revisions' }, label: 'Revisions', meta: String(revisions.length), children: [] });
  const notes = noteRows(call);
  const listed = notes.filter(isListedNote).length;
  if (listed) sheetLevel.push({ item: { kind: 'notes' }, label: 'Notes', meta: String(listed), children: [] });
  notes.forEach((note, i) => {
    if (typeof note !== 'string' && note.at && !isLeaderNote(note)) sheetLevel.push({ item: { kind: 'note', number: i + 1 }, label: note.text || 'Note', children: [] });
  });
  sheetLevel.push({ item: { kind: 'title-block' }, label: 'Title block', meta: text(arg(call, 'title').value) || undefined, children: [] });
  return [...roots, ...sheetLevel];
}

/** What the sheet calls an item in menus and confirmations. */
export function itemLabel(item: DrawingItem, call: DrawingCall | undefined, report?: DrawingSheet): string {
  if (!call) return '';
  switch (item.kind) {
    case 'sheet': return labelOf(call, currentCall()?.index ?? 0);
    case 'view': { const view = viewsOf(call).find((entry) => entry.name === item.name); return viewTitle(item.name, view && view.kind !== 'base' ? view.kind : undefined); }
    case 'dimension': return `Dimension ${item.number}`;
    case 'datum': return `Datum ${text(listOf(arg(call, 'datums').value)[item.number - 1]?.label)}`;
    case 'frame': return `Tolerance frame ${item.number}`;
    case 'weld': return `Weld symbol ${item.number}`;
    case 'balloon': { const placed = report?.balloons_placed?.find((entry) => entry.balloon === item.number); return placed ? `Balloon ${placed.item}` : `Balloon ${item.number}`; }
    case 'hole-table': return `Hole table ${item.number}`;
    case 'note': return 'Note';
    case 'notes': return 'Notes';
    case 'revisions': return 'Revision table';
    case 'parts-list': return 'Parts list';
    case 'cut-list': return 'Cut list';
    case 'title-block': return 'Title block';
  }
}

/* ───────── Delete ───────── */

/** Why an item can't be deleted now (shown as the Delete entry's reason), or null; undefined when it never can be (no
 *  Delete entry at all: the title block). */
export function deleteBlocked(item: DrawingItem, call: DrawingCall | undefined): string | null | undefined {
  if (!call) return BUSY;
  if (get().busy) return BUSY;
  const IN_CODE = fixedNote(call);  // Made by a loop, or a value the tab can't write out.
  switch (item.kind) {
    case 'title-block': return undefined;
    case 'sheet': return null;
    case 'view': return withoutView(call, item.name) ? null : IN_CODE;
    case 'dimension': return arg(call, 'feature_dimensions').editable && arg(call, 'datums').editable && arg(call, 'tolerance_frames').editable ? null : IN_CODE;
    case 'datum': {
      if (!arg(call, 'datums').editable || !arg(call, 'tolerance_frames').editable) return IN_CODE;
      const label = text(listOf(arg(call, 'datums').value)[item.number - 1]?.label);
      const users = listOf(arg(call, 'tolerance_frames').value).map((row, i) => (refsOf(row).some((datum) => datumOf(datum).letter === label) ? i + 1 : 0)).filter(Boolean);
      return users.length ? `Tolerance frame${users.length > 1 ? 's' : ''} ${users.join(', ')} refer${users.length > 1 ? '' : 's'} to it: change ${users.length > 1 ? 'them' : 'that'} first.` : null;
    }
    case 'frame': return arg(call, 'tolerance_frames').editable ? null : IN_CODE;
    case 'weld': return weldRows(call) ? null : IN_CODE;
    case 'balloon': return balloonRows(call) === null ? IN_CODE : null;
    case 'hole-table': return arg(call, 'hole_tables').editable ? null : IN_CODE;
    case 'note': case 'notes': return arg(call, 'notes').editable ? null : IN_CODE;
    case 'revisions': return arg(call, 'revisions').editable ? null : IN_CODE;
    case 'parts-list': return arg(call, 'bom').editable ? null : IN_CODE;
    case 'cut-list': return arg(call, 'cut_list').editable ? null : IN_CODE;
  }
}

/** Deletes an item from the shown sheet (asking first when more goes with it), as its menu's Delete and the Delete key do. */
export async function deleteItem(item: DrawingItem) {
  const current = currentCall();
  if (!current || deleteBlocked(item, current.call) !== null) return;
  const { call, index } = current;
  const report = useDrawingTab.getState().reports?.sheets[index];
  const done = () => { if (useDrawingTab.getState().selected && JSON.stringify(useDrawingTab.getState().selected) === JSON.stringify(item)) selectItem(null); };
  switch (item.kind) {
    case 'sheet': await removeSheet(index); return;
    case 'view': {
      const { views, annotations } = dependantsOf(call, item.name);
      const more = [views.length ? `${views.length} view${views.length > 1 ? 's' : ''} taken from it` : '', annotations ? `${annotations} annotation${annotations > 1 ? 's' : ''}` : ''].filter(Boolean);
      if (more.length && !await askConfirm({ title: `Delete ${itemLabel(item, call)}?`, detail: `The ${more.join(' and ')} on it go too.`, action: 'Delete' })) return;
      done();
      await editSheet(withoutView(call, item.name)!);
      return;
    }
    case 'dimension': {
      const rows = listOf(arg(call, 'feature_dimensions').value);
      const row = rows[item.number - 1];
      if (!row) return;
      const attached = (key: string) => listOf(arg(call, key).value).filter((entry) => row.id !== undefined && entry.dimension === row.id).length;
      const count = attached('datums') + attached('tolerance_frames');
      if (count && !await askConfirm({ title: `Delete dimension ${item.number}?`, detail: `The ${count} datum${count > 1 ? 's and frames' : ' or frame'} attached to it go${count > 1 ? '' : 'es'} too.`, action: 'Delete' })) return;
      const keep = (key: string) => { const all = listOf(arg(call, key).value); const kept = all.filter((entry) => row.id === undefined || entry.dimension !== row.id); return kept.length === all.length ? {} : { [key]: kept.length ? pyList(kept) : undefined }; };
      done();
      const next = rows.filter((_, i) => i !== item.number - 1);
      await editSheet({ feature_dimensions: next.length ? pyList(next) : undefined, ...keep('datums'), ...keep('tolerance_frames') });
      return;
    }
    case 'datum': case 'frame': {
      const key = item.kind === 'datum' ? 'datums' : 'tolerance_frames';
      const rows = listOf(arg(call, key).value).filter((_, i) => i !== item.number - 1);
      done();
      await editSheet({ [key]: rows.length ? pyList(rows) : undefined });
      return;
    }
    case 'weld': {
      const rows = weldRows(call)!.filter((_, i) => i !== item.number - 1);
      done();
      await editSheet({ welds: weldsText(rows) });
      return;
    }
    case 'balloon': {
      const drawn = report?.balloons_placed ?? [];
      const placed = drawn.find((entry) => entry.balloon === item.number);
      done();
      if (placed) await removeBalloon(placed, drawn);
      return;
    }
    case 'hole-table': done(); await removeHoleTable(item.number); return;
    case 'note': {
      const rows = noteRows(call).filter((_, i) => i !== item.number - 1);
      done();
      await editSheet({ notes: notesText(rows) });
      return;
    }
    case 'notes': {
      const rows = noteRows(call);
      const listed = rows.filter(isListedNote);
      if (listed.length > 1 && !await askConfirm({ title: `Delete the ${listed.length} numbered notes?`, action: 'Delete notes' })) return;
      done();
      await editSheet({ notes: notesText(rows.filter((note) => !isListedNote(note))) });
      return;
    }
    case 'revisions': {
      const rows = asList(arg(call, 'revisions').value);
      if (rows.length > 1 && !await askConfirm({ title: 'Delete the revision table?', detail: `Its ${rows.length} revisions go too.`, action: 'Delete table' })) return;
      done();
      await editSheet({ revisions: undefined });
      return;
    }
    case 'parts-list': {
      // A design's own result lists its parts unless told not to; rows written in the code go with it.
      done();
      await editSheet({ bom: 'False' });
      return;
    }
    case 'cut-list': done(); await editSheet({ cut_list: undefined }); return;
    case 'title-block': return;
  }
}

/* ───────── Rename ───────── */

/** Whether an item is renamed in place (in the tree, or from its menu): sheets, section and detail views, datums. */
export function renamable(item: DrawingItem, call: DrawingCall | undefined): boolean {
  if (!call) return false;
  if (item.kind === 'sheet') return arg(call, 'name').editable;
  if (item.kind === 'view') return viewsOf(call).some((view) => view.name === item.name && view.kind !== 'base') && !!withViewRenamed(call, item.name, item.name);
  if (item.kind === 'datum') return arg(call, 'datums').editable && arg(call, 'tolerance_frames').editable;
  return false;
}

/** The name an item is renamed from. */
export function nameOf(item: DrawingItem, call: DrawingCall, index: number): string {
  if (item.kind === 'sheet') return labelOf(call, index);
  if (item.kind === 'view') return item.name;
  if (item.kind === 'datum') return text(listOf(arg(call, 'datums').value)[item.number - 1]?.label);
  return '';
}

/** Why a new name can't be used, or null. */
export function renameProblem(item: DrawingItem, call: DrawingCall, typed: string): string | null {
  if (item.kind === 'sheet') return typed.trim() ? null : 'A sheet needs a name.';
  const standard = standardOf(call);
  const letter = parseDatumLabel(typed, standard);
  if (!letter) return `One or two capital letters${standard === 'ANSI' ? ', not I, O or Q' : ''}.`;
  const taken = item.kind === 'view' ? viewsOf(call).map((view) => view.name) : listOf(arg(call, 'datums').value).map((row) => text(row.label));
  return taken.includes(letter) && letter !== nameOf(item, call, 0) ? `${letter} is taken on this sheet.` : null;
}

/** Renames an item on sheet `index`: a sheet's name, a section or detail view's letter (everything that names it
 *  follows), a datum's letter (the frames that refer to it follow). */
export async function renameItem(item: DrawingItem, index: number, typed: string) {
  const call = sheetCalls()[index];
  if (!call || !renamable(item, call) || renameProblem(item, call, typed)) return;
  if (item.kind === 'sheet') { await renameSheet(index, typed); return; }
  const to = parseDatumLabel(typed, standardOf(call))!;
  const from = nameOf(item, call, index);
  if (to === from) return;
  if (index !== currentCall()?.index) useDrawingTab.setState({ sheet: index });
  if (item.kind === 'view') {
    selectItem({ kind: 'view', name: to });
    await editSheet(withViewRenamed(call, from, to)!);
    return;
  }
  if (item.kind !== 'datum') return;
  const datums = listOf(arg(call, 'datums').value);
  const frames = listOf(arg(call, 'tolerance_frames').value);
  const changes: Record<string, string | undefined> = { datums: pyList(datums.map((row, i) => (i === item.number - 1 ? withKeys(row, { label: to }) : row))) };
  if (frames.some((row) => refsOf(row).some((datum) => datumOf(datum).letter === from))) {
    changes.tolerance_frames = pyList(frames.map((row) => (refsOf(row).length ? withKeys(row, { datums: refsOf(row).map((datum) => {
      const { letter, condition } = datumOf(datum);
      return condition ? [letter === from ? to : letter, condition] : letter === from ? to : letter;
    }) }) : row)));
  }
  await editSheet(changes);
}

export { py };

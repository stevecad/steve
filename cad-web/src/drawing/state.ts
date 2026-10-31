/**
 * The Drawing tab's state and edits. Sheets are `Drawing(...)` calls in the part's code or a design's main.py
 * (drawing/code.ts); every edit rewrites the call there, as STEVE's edits do. The sheet itself is drawn by the build
 * (exact hidden-line projection): drawing/DrawingTab.tsx asks for a drawing build of the new code when the tab shows,
 * and the 3D model is rebuilt only when code outside the sheets changed (rebuild).
 */
import { create } from 'zustand';
import type { BuildMetadata } from '@/lib/api';
import { get, isPreviewStale, set, toast } from '@/state/store';
import { openFile, setCode, updateModel } from '@/state/actions';
import { setDesignTab } from '@/state/designTab';
import { MAIN, componentPath, filesOf } from '@/state/design';
import { withImport } from '@/state/designRefs';
import type { DesignResult } from '@/lib/modeling';
import { useSteve } from '@/panels/steve';
import { setting, updateSetting } from '@/settings/store';
import { viewer } from '@/viewport/viewer';
import {
  arg, balloonRows, balloonsText, drawingCalls, holeTableRows, labelOf, py, pyList, replacedBy, standardOf, stillWritten, templateChanges, templateOf, TEMPLATE_LIMIT, TEXT_LIMIT, withChanges,
  moveProblem, withSheetMoved, withCopiedCall, withNewDrawing, withoutCall, withKeys, withValues, weldRows, weldsText, withWeld, type BalloonPlacement, type DrawingCall, type DrawingTemplate,
  type PyValue,
} from './code';
import { askConfirm } from '@/ui/confirm';

/**
 * What's on a sheet, as the Drawing tab selects it (on the sheet, in the Browser's drawing tree, or from a menu).
 * Annotations are numbered from 1 as the build reports them (a balloon by its number on the sheet; a note by its place
 * in `notes`, listed or placed); views by name.
 */
export type DrawingItem =
  | { kind: 'sheet' }
  | { kind: 'view'; name: string }
  | { kind: 'dimension' | 'balloon' | 'datum' | 'frame' | 'weld' | 'hole-table' | 'note'; number: number }
  | { kind: 'title-block' | 'revisions' | 'notes' | 'parts-list' | 'cut-list' };

export const itemKey = (item: DrawingItem | null | undefined): string =>
  !item ? '' : 'name' in item ? `${item.kind}:${item.name}` : 'number' in item ? `${item.kind}:${item.number}` : item.kind;

/** An argument written as a variable or an expression that an edit wrote a literal over: the document tab it's in, its
 *  sheet, its key, its text as it was, and what the tab wrote (undefined: removed). Undo puts the text back. */
export interface Replacement { tab: string | null; sheet: number; key: string; was: string; now: string | undefined }

/** The sheet being edited, what's selected on it, Fit requests, a request to put the cursor in one of the Inspector's
 *  fields (Edit, Tolerance…), what the last full build reported about the sheets and the code it drew (`built`), and
 *  the expressions edits wrote over. */
export const useDrawingTab = create<{
  sheet: number; selected: DrawingItem | null; fitNonce: number; reports?: BuildMetadata['drawings']; built?: string;
  focus: { field: string; nonce: number } | null; replaced: Replacement[];
}>(() => ({ sheet: 0, selected: null, fitNonce: 0, focus: null, replaced: [] }));

/** Shows another sheet (nothing selected on it yet). */
export const selectSheet = (sheet: number) => useDrawingTab.setState({ sheet, selected: null });

/** Selects something on the shown sheet (or sheet `sheet`, which is shown), or nothing. */
export function selectItem(item: DrawingItem | null, sheet?: number) {
  useDrawingTab.setState((state) => ({ selected: item, ...(sheet !== undefined && sheet !== state.sheet ? { sheet } : {}) }));
}

/** Edits an item: selects it and shows its properties in the Inspector, with the cursor in `field` when given. */
export function editItem(item: DrawingItem, field = 'first', sheet?: number) {
  selectItem(item, sheet);
  useDrawingTab.setState({ focus: { field, nonce: Date.now() } });
  set({ dockOpen: true, dockTab: 'properties' });
}

/** The code the sheets are written in: a part's code, or a design's main.py. */
export function mainCode(): string {
  const { doc } = get();
  return doc.kind !== 'design' || doc.activeFile === MAIN ? doc.code : filesOf(doc)[MAIN] ?? '';
}

function writeMain(code: string) {
  openFile(MAIN);
  setCode(code);
}

/** After an edit: the model is rebuilt only when code outside the sheets changed (a component's import for its sheet).
 *  A change to the sheets alone isn't a model edit: the Drawing tab draws it with one drawing build (DrawingTab.tsx). */
async function rebuild() {
  if (isPreviewStale()) await updateModel();
}

/** The sheets in `code` (main.py's), with what the last drawing build evaluated their expressions to (code.ts withValues). */
export function callsIn(code: string, state: { reports?: BuildMetadata['drawings']; built?: string } = useDrawingTab.getState()): DrawingCall[] {
  return withValues(code, state.built, (state.reports?.sheets ?? []).map((sheet) => sheet.args as Record<string, PyValue> | undefined));
}

export const sheetCalls = (): DrawingCall[] => callsIn(mainCode());

/** The sheet the tab is on (clamped to the sheets there are), or null. */
export function currentCall(): { call: DrawingCall; index: number } | null {
  const calls = sheetCalls();
  if (!calls.length) return null;
  const index = Math.min(useDrawingTab.getState().sheet, calls.length - 1);
  return { call: calls[index], index };
}

/** Writes sheet `index`'s argument changes, keeping what each expression they write over was (shown with Undo). */
function writeSheet(index: number, call: DrawingCall, changes: Record<string, string | undefined>): boolean {
  const code = mainCode();
  const next = withChanges(code, call, changes);
  if (next === code) return false;
  const tab = get().activeTab ?? null;
  useDrawingTab.setState((state) => {
    // An argument edited again keeps what it was first; the rest of the sheet's notes stay while they're still true.
    const mine = (item: Replacement) => item.tab === tab && item.sheet === index;
    const again = state.replaced.filter((item) => mine(item) && item.key in changes && stillWritten(call, item.key, item.now));
    const kept = state.replaced.filter((item) => !(mine(item) && item.key in changes));
    const fresh = replacedBy(call, changes).map(({ key, was }) => ({ tab, sheet: index, key, was, now: changes[key] }));
    return { replaced: [...kept, ...again.map((item) => ({ ...item, now: changes[item.key] })), ...fresh].slice(-50) };
  });
  writeMain(next);
  return true;
}

/** Changes the shown sheet's arguments (Python text; undefined removes one) and rebuilds. */
export async function editSheet(changes: Record<string, string | undefined>) {
  const current = currentCall();
  if (!current || !writeSheet(current.index, current.call, changes)) return;
  await rebuild();
}

/** The expressions edits wrote over that are still as the tab wrote them, on sheet `sheet` (all sheets when left out),
 *  last written last. */
export function replacements(sheet?: number): Replacement[] {
  const calls = sheetCalls();
  const tab = get().activeTab ?? null;
  return useDrawingTab.getState().replaced.filter((item) => item.tab === tab && (sheet === undefined || item.sheet === sheet)
    && !!calls[item.sheet] && stillWritten(calls[item.sheet], item.key, item.now));
}

/** Puts back an expression an edit wrote over (the last one when none is given), and rebuilds. */
export async function undoReplacement(item: Replacement | undefined = replacements().at(-1)) {
  const call = item && sheetCalls()[item.sheet];
  useDrawingTab.setState((state) => ({ replaced: state.replaced.filter((other) => other !== item) }));
  if (!item || !call || !stillWritten(call, item.key, item.now)) return;
  const code = mainCode();
  writeMain(withChanges(code, call, { [item.key]: item.was }));
  await rebuild();
}

/** The shown sheet's feature dimensions as written (or evaluated), when the tab may rewrite them (else null). */
export function dimensionRows(call: DrawingCall): Record<string, PyValue>[] | null {
  const dims = arg(call, 'feature_dimensions');
  if (!dims.editable) return null;
  // The runtime takes one dict as well as a list of them.
  const rows = Array.isArray(dims.value) ? dims.value : dims.value && typeof dims.value === 'object' ? [dims.value] : [];
  return rows.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? row : {}));
}

/** Changes feature dimension `number`'s keys on the shown sheet (undefined removes one) and rebuilds. */
export async function editDimension(number: number, patch: Record<string, PyValue | undefined>) {
  const current = currentCall();
  const rows = current && dimensionRows(current.call);
  if (!rows || !rows[number - 1]) return;
  await editSheet({ feature_dimensions: pyList(rows.map((row, i) => (i === number - 1 ? withKeys(row, patch) : row))) });
}

/** Changes a drawn balloon's keys on the shown sheet (undefined removes one) and rebuilds. With `balloons=True`, the
 *  balloons drawn (`drawn`, in order) are written out one by one first, so this one can have its own place. */
export async function editBalloon(placed: BalloonPlacement, drawn: BalloonPlacement[], patch: Record<string, PyValue | undefined>) {
  const current = currentCall();
  const rows = current && balloonRows(current.call);
  if (!rows) return;
  if (rows === 'all') {
    const every = drawn.map((item) => withKeys({ instance: item.instance }, item.balloon === placed.balloon ? patch : {}));
    await editSheet({ balloons: balloonsText(every) });
  } else if (placed.index !== null && rows[placed.index - 1]) {
    await editSheet({ balloons: balloonsText(rows.map((row, i) => (i === placed.index! - 1 ? withKeys(row, patch) : row))) });
  }
}

/** Changes weld symbol `number`'s keys on the shown sheet (undefined removes one; the others, its placement too, stay as
 *  written) and rebuilds. */
export async function editWeld(number: number, patch: Record<string, PyValue | undefined>) {
  const current = currentCall();
  const rows = current && weldRows(current.call);
  if (!rows || !rows[number - 1]) return;
  await editSheet({ welds: weldsText(rows.map((row, i) => (i === number - 1 ? withWeld(row, patch) : row))) });
}

/** Removes feature dimension `number` from the shown sheet and rebuilds (the next ones renumber, as in the panel). */
export async function removeDimension(number: number) {
  const current = currentCall();
  const rows = current && dimensionRows(current.call);
  if (!rows || !rows[number - 1]) return;
  const next = rows.filter((_, i) => i !== number - 1);
  const selected = useDrawingTab.getState().selected;
  if (selected?.kind === 'dimension' && selected.number === number) selectItem(null);
  await editSheet({ feature_dimensions: next.length ? pyList(next) : undefined });
}

/** Removes a drawn balloon from the shown sheet and rebuilds. With `balloons=True`, the other balloons drawn are
 *  written out one by one so they stay. */
export async function removeBalloon(placed: BalloonPlacement, drawn: BalloonPlacement[]) {
  const current = currentCall();
  const rows = current && balloonRows(current.call);
  if (!rows) return;
  if (rows === 'all') {
    await editSheet({ balloons: balloonsText(drawn.filter((item) => item.balloon !== placed.balloon).map((item) => ({ instance: item.instance }))) });
  } else if (placed.index !== null && rows[placed.index - 1]) {
    await editSheet({ balloons: balloonsText(rows.filter((_, i) => i !== placed.index! - 1)) });
  }
}

/** Removes hole table `number` from the shown sheet and rebuilds. */
export async function removeHoleTable(number: number) {
  const current = currentCall();
  if (!current || !arg(current.call, 'hole_tables').editable) return;
  const rows = holeTableRows(current.call);
  if (!rows[number - 1]) return;
  const next = rows.filter((_, i) => i !== number - 1);
  await editSheet({ hole_tables: next.length ? pyList(next) : undefined });
}

/** The standard a new sheet starts on: the last sheet's, else ISO. */
export function nextStandard(): 'ISO' | 'ANSI' {
  const calls = sheetCalls();
  return calls.length ? standardOf(calls[calls.length - 1]) : 'ISO';
}

/** A design's components a sheet can draw on their own (New sheet → Draw), by the components/<id>.py convention: id and
 *  name, from the last build. */
export function drawableComponents(): { id: string; name: string }[] {
  const { doc, displayed } = get();
  if (doc.kind !== 'design') return [];
  const files = filesOf(doc);
  const design = (displayed?.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design;
  return Object.entries(design?.components ?? {})
    .filter(([id, component]) => component.file === componentPath(id) && new RegExp(`^${id}\\s*=\\s*Component\\(`, 'm').test(files[component.file] ?? ''))
    .map(([id, component]) => ({ id, name: component.name }));
}

/** Adds a sheet set up in New sheet (its arguments as Python text; the standard last used when it has none), of the
 *  model's `result` or one of a design's components, shows it in the Drawing tab, and rebuilds. */
export async function addSheet(setup: { args?: Record<string, string | undefined>; component?: string } = {}) {
  let code = mainCode();
  const calls = drawingCalls(code);
  const name = get().doc.name.trim();
  // A component's sheet is titled with the component's name by the runtime.
  const title = setup.component ? undefined : calls.length ? `${name || 'Untitled'} ${calls.length + 1}` : name || undefined;
  if (setup.component) code = withImport(code, setup.component);
  writeMain(withNewDrawing(code, { standard: nextStandard(), title, source: setup.component, args: setup.args }));
  selectSheet(calls.length);
  setDesignTab('drawing');
  await rebuild();
}

/** Deletes sheet `index` (the shown one by default) from the code, once confirmed. */
export async function removeSheet(index = currentCall()?.index) {
  const call = index === undefined ? undefined : sheetCalls()[index];
  if (!call || index === undefined || !await askConfirm({ title: `Delete the sheet “${labelOf(call, index)}”?`, detail: 'Everything on it goes too.', action: 'Delete sheet' })) return;
  writeMain(withoutCall(mainCode(), call));
  selectSheet(Math.max(0, Math.min(useDrawingTab.getState().sheet, sheetCalls().length - 1)));
  await rebuild();
}

/** Renames sheet `index` (its `name`, the file it exports as; the title block's title is its own). */
export async function renameSheet(index: number, name: string) {
  const call = sheetCalls()[index];
  const text = name.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, TEXT_LIMIT);
  if (!call || !arg(call, 'name').editable || text === labelOf(call, index)) return;
  if (writeSheet(index, call, { name: text ? py(text) : undefined })) await rebuild();
}

/** Copies sheet `index` after itself, as its own sheet, and shows the copy. */
export async function duplicateSheet(index: number) {
  const call = sheetCalls()[index];
  if (!call) return;
  const names = sheetCalls().map((item, i) => labelOf(item, i));
  let copy = `${labelOf(call, index)} copy`;
  for (let n = 2; names.includes(copy); n++) copy = `${labelOf(call, index)} copy ${n}`;
  writeMain(withCopiedCall(mainCode(), call, { name: py(copy.slice(0, TEXT_LIMIT)) }));
  selectSheet(index + 1);
  await rebuild();
}

/** Why sheet `index` can't be moved to place `to` (null when it can): code.ts moveProblem, or sheets the last drawing
 *  build made that this file's statements don't number one by one (a function or another file makes some). */
export function sheetMoveProblem(index: number, to: number): string | null {
  const code = mainCode();
  const { reports, built } = useDrawingTab.getState();
  if (reports && built === code && reports.sheets.length !== drawingCalls(code).length) return 'Some sheets are made elsewhere in the code: reorder them there.';
  return moveProblem(code, index, to);
}

/** Moves sheet `index` to place `to` (its statement, the comments above it and what only builds it) in the code, which
 *  is the order sheets are numbered in: one edit, one undo. When it can't be, says why and changes nothing. */
export async function moveSheet(index: number, to: number) {
  if (index === to) return;
  const problem = sheetMoveProblem(index, to);
  if (problem) { toast('warning', 'Sheet not moved', problem); return; }
  writeMain(withSheetMoved(mainCode(), index, to));
  selectSheet(to);
  await rebuild();
}

/** Opens the code at the shown sheet's call. */
export function showSheetCode() {
  const current = currentCall();
  openFile(MAIN);
  if (!current) { set({ dockOpen: true, dockTab: 'source' }); return; }
  const length = get().doc.code.length;
  set({ sourceReveal: { from: Math.min(current.call.from, length), to: Math.min(current.call.to, length), nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
}

/** Opens STEVE with a question about the shown sheet, to finish and send. */
export function askAboutSheet() {
  const current = currentCall();
  useSteve.setState({ prefill: current ? `On the drawing sheet “${labelOf(current.call, current.index)}”, ` : 'Make an engineering drawing of this: ' });
  set({ dockOpen: true, dockTab: 'assistant' });
}

/** Opens STEVE with a question about something on the shown sheet (“feature dimension 3”), to finish and send. */
export function askAboutAnnotation(what: string) {
  const current = currentCall();
  if (!current) return askAboutSheet();
  useSteve.setState({ prefill: `On the drawing sheet “${labelOf(current.call, current.index)}”, ${what} ` });
  set({ dockOpen: true, dockTab: 'assistant' });
}


/* ───────── Sheet templates (account setting `drawing.templates`, drawing/code.ts) ───────── */

const ARGUMENT_NAMES: Record<string, string> = { standard: 'standard', sheet: 'size', orientation: 'orientation', projection: 'projection',
  units: 'units', fields: 'title block fields', notes: 'notes', title_block: 'title block layout', dual_units: 'second unit',
  dual_precision: 'second unit decimals', dimensions: 'overall dimensions', feature_dimensions: 'dimensions', tolerance_frames: 'tolerance frames',
  section_views: 'section views', detail_views: 'detail views', front: 'master view', hole_tables: 'hole tables', welds: 'weld symbols',
  bom: 'parts list', cut_list: 'cut list', hidden: 'hidden lines', shaded: 'shaded views' };
const named = (keys: string[]) => keys.map(argumentName).join(', ');

/** An argument as the tab names it (`feature_dimensions`: dimensions). */
export const argumentName = (key: string) => ARGUMENT_NAMES[key] ?? key.replace(/_/g, ' ');

/** Saves the shown sheet's setup (or a new sheet's, `call`) as a template (replacing one of the same name), for every
 *  drawing in the account. */
export async function saveTemplate(name: string, call = currentCall()?.call) {
  const templates = setting('drawing.templates');
  if (!call || !name.trim()) return;
  const { template, skipped } = templateOf(call, name);
  const others = templates.filter((item) => item.name.trim().toLowerCase() !== template.name.trim().toLowerCase());
  if (others.length >= TEMPLATE_LIMIT) {
    toast('warning', 'Template not saved', `You can keep up to ${TEMPLATE_LIMIT} templates: delete one first.`);
    return;
  }
  await updateSetting('drawing.templates', [...others, template]);
  if (!setting('drawing.templates').some((item) => item.name === template.name)) return;  // Refused: the settings store said why.
  if (skipped.length) toast('info', `Saved “${template.name}”`, `Left out what’s made by a loop in the code, or isn’t a template’s: ${named(skipped)}.`);
  else toast('success', `Saved “${template.name}”`, 'Use it for a new sheet, or apply it to another sheet, from Sheet format → Templates.');
}

/** Puts a template's setup on the shown sheet (views, scale, title, revisions and dimensions stay) and rebuilds. */
export async function applyTemplate(template: DrawingTemplate) {
  const current = currentCall();
  if (!current) return;
  const { changes, skipped } = templateChanges(template, current.call);
  await editSheet(changes);
  if (skipped.length) toast('info', `Applied “${template.name}”`, `Left alone what’s made by a loop in the code: ${named(skipped)}.`);
}

export function removeTemplate(name: string) {
  void updateSetting('drawing.templates', setting('drawing.templates').filter((item) => item.name !== name));
}

export const fitSheet = () => useDrawingTab.setState((state) => ({ fitNonce: state.fitNonce + 1 }));

/** Shows the selection made on the sheet in the 3D view (the Solid tab), framed, still selected. */
export function showInModel() {
  setDesignTab('solid');
  const { selection } = get();
  if (viewer.model && selection.length) viewer.zoomTo(viewer.model.pickBox(selection));
}

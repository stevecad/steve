/**
 * The Drawing tab's tools: each ribbon button starts one, it's used on the sheet (picks and clicks in the centre,
 * drawing/Paper.tsx), and its options are its panel in the Dock (drawing/ToolPanel.tsx) with OK and Cancel. What a tool
 * makes is written into the sheet's `Drawing(...)` call (drawing/code.ts), so the sheet the tool makes is the sheet
 * STEVE's code makes:
 *
 * - Base view: choose the orientation, click where it goes. The first on a sheet with no front, top or side view is its
 *   master: written as `front` with that orientation (`front=`), so the views projected from it follow it.
 * - Projected view: pick a view, move the pointer to the side the new one goes (the projection method says which
 *   view that is), click.
 * - Section view: draw the cutting line across a view (horizontal or vertical, snapping to holes and corners), click
 *   the side to look from, where the section goes.
 * - Detail view: click the centre on a view, drag out the circle, click where the detail goes.
 * - Dimension: click one or two edges, circles or corners in a view (the kind follows: a circle's diameter, an edge's
 *   length, a distance or an angle between two), click where it goes. The dimension and its value are drawn as it's
 *   picked, following the pointer (drawing/measure.ts), until the build draws its own.
 * - Note: click where it goes, type it. For a leader note (FLUSH, TYP…), first click the edge, face or corner it
 *   points at in a view: its leader runs from there to where the note goes.
 * - Balloon: click a part, click where its balloon goes.
 * - Datum, GD&T frame: click a feature in a view (or a dimension, for its feature of size), click where it goes.
 * - Weld: click edges, faces or corners of the joint in one view (an arrow to each), then where the reference line
 *   starts (or Enter: the sheet places it). From an existing weld's menu, Add arrow picks one more for it.
 * - Hole table: click the view, then the holes to list (none: every hole) and a corner to measure from.
 * - Sheet format, title block, revision: their fields, written on OK.
 * - New sheet: the sheet's standard, size, orientation and template, and what it draws (the part or design, or one of
 *   a design's components), written on OK as a blank sheet (`views=[]`) for Base view to start, or with the standard
 *   views when they're ticked.
 *
 * Views are written first and moved where they were clicked once the sheet is drawn (`at`, paper mm from where the
 * projection method puts them): where a view goes depends on every other view, so it's only known then.
 */
import { create } from 'zustand';
import { get, set, toast } from '@/state/store';
import type { DrawingSheet } from '@/lib/api';
import {
  arg, atOf, balloonPlacement, balloonRows, balloonsText, childViews, dimensionId, dimensionPlacement, dualOf, fixedNote, FLAT, frontText, nextDatumLabel, noteRows, notesText, offsetMm, OWN_VIEWS, projectedFrom,
  positionValue, projectionOf, py, pyList, sectionFlip, SIDE_UP, standardOf, templateChanges, toModel, unitsOf, viewItems, viewName, viewsText, VIEWS, withViewAt, withViewPatches, withKeys,
  hasLeaders, newWeld, weldAt, WELD_LEADERS, weldRefs, weldRows, weldsText, weldSpacingProblem, withLeader,
  type DrawingCall, type DrawingTemplate, type PyValue, type ViewOnSheet,
} from './code';
import { anchorOf, refFor, type Point, type SheetPick } from './picks';
import { dimensionText, drawDimension, measure, type DimensionDrawing, type DimensionKind } from './measure';
import { addSheet, currentCall, editSheet, nextStandard, selectItem, useDrawingTab } from './state';
import { setDesignTab } from '@/state/designTab';
import { listOf, orthographic, viewsOf, viewTitle } from './items';

export type ToolKind = 'base' | 'projected' | 'section' | 'detail' | 'dimension' | 'note' | 'balloon' | 'datum' | 'frame' | 'weld'
  | 'new-sheet' | 'sheet-format' | 'title-block' | 'hole-table' | 'revision';

export const TOOL_TITLES: Record<ToolKind, string> = {
  'new-sheet': 'New sheet', base: 'Base view', projected: 'Projected view', section: 'Section view', detail: 'Detail view', dimension: 'Dimension', note: 'Note',
  balloon: 'Balloon', datum: 'Datum', frame: 'GD&T frame', weld: 'Weld', 'sheet-format': 'Sheet format', 'title-block': 'Title block', 'hole-table': 'Hole table',
  revision: 'Revision',
};

/** What's under the pointer on the sheet, as the tools see it. */
export interface Hit {
  p: Point;
  pick: SheetPick | null;
  view: ViewOnSheet | null;
  /** A feature dimension's number, when the pointer is on one. */
  dimension: number | null;
  /** Everything pickable on the sheet. */
  all: SheetPick[];
}

export interface ToolState {
  tool: ToolKind | null;
  /** Which click comes next. */
  step: 'pick' | 'parent' | 'line' | 'centre' | 'radius' | 'place' | 'text';
  /** What's been picked (feature dimension: up to two; datum, frame, balloon: one; hole table: its holes). */
  picks: SheetPick[];
  /** A feature dimension a datum or frame attaches to (its number). */
  dimension: number | null;
  /** Weld: the symbol an arrow is added to (Add arrow), else null for a new one. */
  weld: number | null;
  /** The view picked: a new view's parent, the view a hole table lists. */
  view: string | null;
  /** A section's cutting line while it's drawn, and where it went. */
  line: [Point, Point] | null;
  /** A detail's centre on the sheet, and its circle's radius there. */
  centre: Point | null;
  radius: number | null;
  /** Where a section cuts or a detail is centred, as written: a persistent name or a model point. */
  through: PyValue | null;
  /** A hole table's origin (a vertex). */
  origin: SheetPick | null;
  /** The pointer on the sheet, for previews; what it's over. */
  pointer: Point | null;
  hover: SheetPick | null;
  hoverView: string | null;
  hoverDimension: number | null;
  /** The tool's options (orientation, a dimension's kind, a section's flip, a note's text, a frame's characteristic…). */
  options: Record<string, PyValue>;
  /** Sheet format, title block and new sheet: the sheet's arguments as they'll be written (Python text; undefined
   *  removes one). */
  changes: Record<string, string | undefined>;
  /** Why the last click did nothing (shown in the tool's panel). */
  hint: string | null;
}

const IDLE: ToolState = {
  tool: null, step: 'pick', picks: [], dimension: null, weld: null, view: null, line: null, centre: null, radius: null, through: null, origin: null,
  pointer: null, hover: null, hoverView: null, hoverDimension: null, options: {}, changes: {}, hint: null,
};

export const useDrawingTool = create<ToolState>(() => IDLE);
// The ribbon shows the open tool's button pressed: it follows the app's store, so a tool opening or closing tells it.
useDrawingTool.subscribe((state, previous) => { if (state.tool !== previous.tool) set({}); });

const tool = () => useDrawingTool.getState();
const patch = (next: Partial<ToolState>) => useDrawingTool.setState(next);

/** A view written now and moved to where it was clicked once the sheet is drawn (see the top of this file). */
interface Pending { sheet: number; view: string; target: Point; axis: 'x' | 'y' | null; keep: Point; parent: string | null }
export const usePending = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** A dimension the tool just placed, drawn as it was previewed until the sheet is drawn again with the build's own
 *  (drawing/Paper.tsx drops it then, or when the build fails). */
export const usePlacedDimension = create<{ placed: { drawing: DimensionDrawing; text: string } | null }>(() => ({ placed: null }));

const sheetReport = (): DrawingSheet | undefined => {
  const current = currentCall();
  return current ? useDrawingTab.getState().reports?.sheets[current.index] : undefined;
};
export const placedView = (name: string | null | undefined): ViewOnSheet | undefined =>
  name ? sheetReport()?.views_placed?.find((view) => view.view === name) as ViewOnSheet | undefined : undefined;

/** Whether a sheet draws a whole design (its parts are placed instances, listed in its parts list): the build says. */
export const isDesignSheet = (call: DrawingCall) => (get().doc.kind === 'design' && call.source === 'result') || (sheetReport()?.parts_list ?? 0) > 0;

/** The sheet-metal bodies the shown sheet draws (the build says), as its flat view names them. */
export const sheetMetalBodies = (): string[] => sheetReport()?.sheet_metal_bodies ?? [];

/** The views Base view offers: the standard ones not on the sheet yet, and the flat pattern when it draws sheet metal. */
export function baseChoices(call: DrawingCall): string[] {
  const taken = viewItems(call).map(viewName);
  return [...VIEWS, ...(sheetMetalBodies().length ? [FLAT] : [])].filter((view) => !taken.includes(view));
}

/** Why a tool can't start on the shown sheet, or null. */
export function toolBlocked(kind: ToolKind): string | null {
  if (kind === 'new-sheet') return null;
  const current = currentCall();
  if (!current) return 'Add a sheet first (New sheet).';
  const { call } = current;
  const editable = (...keys: string[]) => keys.every((key) => arg(call, key).editable);
  // Only what's made by a loop in the code (or has no value the tab can write out) is left as written.
  const fixed = fixedNote(call);
  switch (kind) {
    case 'base': return !editable('views') ? fixed
      : !baseChoices(call).length ? 'Every standard view is on this sheet.' : null;
    case 'projected': return !editable('views') ? fixed
      : !viewItems(call).some((item) => !OWN_VIEWS.includes(viewName(item))) ? 'Add a front, top or side view first.' : null;
    case 'section': case 'detail': return !editable('section_views', 'detail_views') ? fixed
      : !orthographic(call).length ? 'Add a front, top or side view first.' : isDesignSheet(call) ? 'Cut and detail each part on its own sheet (New sheet, then draw its component).' : null;
    case 'dimension': return !editable('feature_dimensions') ? fixed
      : isDesignSheet(call) ? 'Dimension each part on its own sheet: a design’s parts are measured on their component’s sheet.'
        : !viewItems(call).some((item) => viewName(item) !== 'iso') ? 'Add a front, top, side or flat view first.' : null;
    case 'datum': case 'frame': return !editable('datums', 'tolerance_frames', 'feature_dimensions') ? fixed
      : isDesignSheet(call) ? 'Put GD&T on each part on its own sheet (New sheet, then draw its component).' : !orthographic(call).length ? 'Add a front, top or side view first.' : null;
    case 'weld': return !weldRows(call) ? fixed : !viewsOf(call).length ? 'Add a view first.' : null;
    case 'balloon': return !isDesignSheet(call) ? 'Balloons go on a design’s sheet: its parts list numbers them.'
      : balloonRows(call) === null ? fixed : balloonRows(call) === 'all' ? 'Every part already has a balloon (balloons=True).' : null;
    case 'note': return editable('notes') ? null : fixed;
    case 'hole-table': return !editable('hole_tables') ? fixed
      : isDesignSheet(call) ? 'List each part’s holes on its own sheet (New sheet, then draw its component).' : !orthographic(call).length ? 'Add a front, top or side view first.' : null;
    case 'revision': return editable('revisions') ? null : fixed;
    case 'sheet-format': case 'title-block': return null;
  }
}

/** New sheet: shows the Drawing tab with the sheet's setup in the Dock (nothing is written until OK), on the standard
 *  last used, or a saved template's. */
export function startNewSheet(template?: DrawingTemplate) {
  const changes = template ? templateChanges(template).changes : { standard: py(nextStandard()) };
  setDesignTab('drawing');
  useDrawingTool.setState({ ...IDLE, tool: 'new-sheet', options: { component: null, standardViews: false }, changes });
}

/** Starts a tool (ending any other), with a view or the feature already chosen when it's started from a menu; Weld with
 *  `weld`, to add an arrow to that weld symbol. */
export function startTool(kind: ToolKind, preset: { view?: string; dimension?: number; weld?: number } = {}) {
  if (kind === 'new-sheet') { startNewSheet(); return; }
  const current = currentCall();
  if (!current || toolBlocked(kind)) return;
  const { call } = current;
  const options: Record<string, PyValue> = {};
  let step: ToolState['step'] = 'pick';
  if (kind === 'base') options.orientation = baseChoices(call)[0] ?? 'front';
  if (kind === 'projected') step = preset.view ? 'place' : 'parent';
  if (kind === 'section') step = 'line';
  if (kind === 'detail') step = 'centre';
  if (kind === 'section' || kind === 'detail') options.name = nextDatumLabel(viewsOf(call).map((view) => view.name), standardOf(call));
  if (kind === 'datum') options.label = nextDatumLabel(listOf(arg(call, 'datums').value).map((row) => String(row.label ?? '')), standardOf(call));
  if (kind === 'frame') Object.assign(options, { characteristic: 'position', tolerance: unitsOf(call) === 'in' ? 0.005 : 0.1 });
  // A weld's values are the person's (its drawing, its WPS): none are assumed.
  if (kind === 'weld') Object.assign(options, { type: 'fillet', side: 'arrow' });
  if (kind === 'note') { options.text = ''; step = 'place'; }
  if (kind === 'hole-table') step = preset.view ? 'pick' : 'parent';
  if (kind === 'revision') {
    const rows = listOf(arg(call, 'revisions').value);
    const last = String(rows.at(-1)?.rev ?? '');
    Object.assign(options, { rev: nextRev(last), description: rows.length ? '' : 'First release', date: today(), by: String(asText(arg(call, 'fields').value, 'drawn_by')) });
  }
  if (preset.dimension !== undefined) step = 'place';
  let view = preset.view ?? null;
  if (kind === 'weld' && preset.weld !== undefined) {
    const row = weldRows(call)?.[preset.weld - 1];
    if (!row || !hasLeaders(row) || weldRefs(row).length >= WELD_LEADERS) return;
    view = typeof row.view === 'string' ? row.view : orthographic(call)[0]?.name ?? null;
  }
  useDrawingTool.setState({ ...IDLE, tool: kind, step, options, view, dimension: preset.dimension ?? null, weld: kind === 'weld' ? preset.weld ?? null : null });
}

export const cancelTool = () => useDrawingTool.setState(IDLE);

const asText = (value: PyValue | undefined, key: string) => (value && typeof value === 'object' && !Array.isArray(value) && typeof value[key] === 'string' ? value[key] : '');
function nextRev(rev: string): string {
  if (/^\d+$/.test(rev)) return String(Number(rev) + 1);
  if (/^[A-Y]$/i.test(rev)) return String.fromCharCode(rev.toUpperCase().charCodeAt(0) + 1);
  return 'A';
}
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

/* ───────── What each tool picks ───────── */

/** The views a tool works in: orthographic ones (sections and details too) for annotations, base ones for projecting;
 *  the flat view takes dimensions (its blank's edges, holes and bend lines). */
function viewAccepted(kind: ToolKind, view: ViewOnSheet | null): boolean {
  if (!view) return false;
  if (kind === 'projected') return view.kind === 'base' && !OWN_VIEWS.includes(view.view);
  if (kind === 'balloon') return view.view !== FLAT;
  if (kind === 'dimension') return view.view !== 'iso';
  return !OWN_VIEWS.includes(view.view);
}

/** Whether a pick is what the tool takes now (it highlights under the pointer). */
export function pickAccepted(state: ToolState, pick: SheetPick): boolean {
  switch (state.tool) {
    case 'dimension':
      if (pick.kind === 'instance' || !refFor(pick)) return false;
      return !state.picks.length || pick.view === state.picks[0].view;
    case 'datum': case 'frame': return pick.kind !== 'instance' && pick.kind !== 'vertex' && !!(pick.face ?? pick.ref);
    case 'weld':  // One view's edges, faces and corners; an arrow added to a weld goes in its view.
      if (pick.kind === 'instance' || !weldRef(pick)) return false;
      return state.weld !== null ? pick.view === state.view : !state.picks.length || pick.view === state.picks[0].view;
    case 'balloon': return pick.kind === 'instance';
    case 'note': return state.step === 'place' && !state.picks.length && pick.kind !== 'instance' && !!weldRef(pick);
    case 'section': case 'detail': return pick.kind === 'vertex' || pick.kind === 'circle';
    case 'hole-table': return pick.view === state.view && ((pick.kind === 'circle' && /\.wall\(\d+\)$/.test(pick.face ?? '')) || (pick.kind === 'vertex' && !!pick.ref));
    default: return false;
  }
}

/** Why a pick under the pointer can't be used (shown while hovering it), or null. */
export function pickProblem(state: ToolState, pick: SheetPick | null): string | null {
  if (!pick || !state.tool) return null;
  if (['dimension', 'datum', 'frame', 'weld'].includes(state.tool) && pick.kind !== 'instance' && !refFor(pick) && !pick.face)
    return 'This geometry has no persistent name (plain CadQuery): ask STEVE to dimension it with a selector.';
  if (state.tool === 'dimension' && state.picks.length && pick.view !== state.picks[0].view) return 'Pick the second one in the same view.';
  if (state.tool === 'weld' && pick.kind !== 'instance') {
    const view = state.weld !== null ? state.view : state.picks[0]?.view;
    if (view && pick.view !== view) return `A weld’s arrows all go in one view: pick in ${viewTitle(view)}.`;
  }
  return null;
}

/** What a weld's arrow names: the edge or corner itself (the joint's line), else the face seen edge-on. */
export const weldRef = (pick: SheetPick): string | null => pick.ref ?? pick.face;

/** Where the build points a weld's arrow on a pick (drawing.py _weld_anchor): the point of its line nearest the
 *  line's middle (an edge's midpoint; a point on a circle's rim). */
export function weldTip(pick: SheetPick): Point {
  const { points } = pick;
  if (points.length === 1) return points[0];
  const [cx, cy] = [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
  let best = points[0], far = Infinity;
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / length)) : 0;
    const p: Point = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - cx, p[1] - cy);
    if (d < far) { best = p; far = d; }
  }
  return best;
}

/** The pointer moved on the sheet: previews follow it. */
export function toolPointer(hit: Hit) {
  const state = tool();
  if (!state.tool) return;
  const pick = hit.pick && viewAccepted(state.tool, hit.view) && pickAccepted(state, hit.pick) ? hit.pick : null;
  const next: Partial<ToolState> = { pointer: hit.p, hover: pick, hoverView: hit.view && viewAccepted(state.tool, hit.view) ? hit.view.view : null,
    hoverDimension: ['datum', 'frame'].includes(state.tool) ? hit.dimension : null };
  if (state.tool === 'section' && state.step === 'line' && state.line) next.line = [state.line[0], hit.p];
  if (state.tool === 'detail' && state.step === 'radius' && state.centre) next.radius = Math.hypot(hit.p[0] - state.centre[0], hit.p[1] - state.centre[1]);
  if (state.tool === 'projected' && state.step === 'place') {
    const candidate = projectedCandidate(hit.p);
    next.options = { ...state.options, candidate: candidate?.name ?? null, axis: candidate?.axis ?? null };
  }
  if (state.tool === 'section' && state.step === 'place' && state.line) next.options = { ...state.options, flip: sectionSide(hit.p) };
  patch(next);
}

/** The view a projected view from the chosen parent would be, toward the pointer, and the way it's projected. */
function projectedCandidate(p: Point): { name: string; axis: 'x' | 'y' } | undefined {
  const state = tool();
  const parent = placedView(state.view);
  const current = currentCall();
  if (!parent || !current) return undefined;
  const [x0, y0, x1, y1] = parent.box;
  const [dx, dy] = [p[0] - (x0 + x1) / 2, p[1] - (y0 + y1) / 2];
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return undefined;
  const direction: Point = Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, -Math.sign(dy)];  // The grid's y is up.
  const name = projectedFrom(projectionOf(current.call), parent.view, direction);
  return name ? { name, axis: direction[0] ? 'x' : 'y' } : undefined;
}

/** Which way a section looks (its flip) so that it goes on the pointer's side of its cutting line. */
function sectionSide(p: Point): boolean {
  const state = tool();
  const current = currentCall();
  if (!state.line || !current) return false;
  const horizontal = state.options.direction !== 'vertical';
  const [a] = state.line;
  const side = horizontal ? (p[1] < a[1] ? 'up' : 'down') : (p[0] > a[0] ? 'right' : 'left');
  return sectionFlip(side, projectionOf(current.call));
}

/** Where a section cuts or a detail is centred: a hole's axis or a corner when the point is on one (a persistent
 *  name, so it follows the model), else the model point there. */
function anchorFor(pick: SheetPick | null, view: ViewOnSheet, p: Point): { at: PyValue; point: Point } | null {
  if (pick?.kind === 'circle' && (pick.face || pick.ref)) return { at: (pick.face ?? pick.ref)!, point: pick.centre! };
  if (pick?.kind === 'vertex' && pick.ref) return { at: pick.ref, point: pick.points[0] };
  const model = toModel(view, p);
  return model ? { at: model, point: p } : null;
}

/** A press on the sheet (before it's known to be a click or a drag): a section's cutting line starts here. True when
 *  the tool takes the press (no panning). */
export function toolPress(hit: Hit): boolean {
  const state = tool();
  if (state.tool === 'section' && state.step === 'line' && !state.line && viewAccepted('section', hit.view)) {
    patch({ line: [hit.p, hit.p], view: hit.view!.view, hint: null });
    return true;
  }
  return false;
}

/** The pointer went up after a drag the tool took: a drawn cutting line ends there. */
export function toolRelease(hit: Hit) {
  const state = tool();
  if (state.tool === 'section' && state.step === 'line' && state.line && Math.hypot(hit.p[0] - state.line[0][0], hit.p[1] - state.line[0][1]) > 2) endLine(hit);
}

function endLine(hit: Hit) {
  const state = tool();
  const view = placedView(state.view);
  if (!state.line || !view) return;
  const [a] = state.line;
  const b = hit.p;
  const horizontal = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  // The line goes through the hole or corner it passes nearest (within a few mm of paper), else where it was drawn.
  const across = horizontal ? 1 : 0;
  const level = (a[across] + b[across]) / 2;
  const middle: Point = horizontal ? [(view.box[0] + view.box[2]) / 2, level] : [level, (view.box[1] + view.box[3]) / 2];
  const near = (pick: SheetPick) => Math.abs(anchorOf(pick)[across] - level);
  const snap = hit.all.filter((pick) => pick.view === view.view && (pick.kind === 'circle' || (pick.kind === 'vertex' && pick.ref)) && near(pick) < 2.5)
    .sort((a, b) => Number(b.kind === 'circle') - Number(a.kind === 'circle') || near(a) - near(b))[0];
  const anchor = anchorFor(snap ?? null, view, snap ? anchorOf(snap) : middle);
  if (!anchor) return;
  const y = anchor.point[across];
  const line: [Point, Point] = horizontal ? [[view.box[0] - 6, y], [view.box[2] + 6, y]] : [[y, view.box[1] - 6], [y, view.box[3] + 6]];
  patch({ line, through: anchor.at, step: 'place', options: { ...state.options, direction: horizontal ? 'horizontal' : 'vertical' } });
}

/** A click on the sheet while a tool is open. */
export function toolClick(hit: Hit) {
  const state = tool();
  const current = currentCall();
  if (!state.tool || !current) return;
  const pick = hit.pick && viewAccepted(state.tool, hit.view) && pickAccepted(state, hit.pick) ? hit.pick : null;
  patch({ hint: null });
  switch (state.tool) {
    case 'base': void addBaseView(hit.p); return;
    case 'projected':
      if (state.step === 'parent') {
        if (hit.view && viewAccepted('projected', hit.view)) patch({ view: hit.view.view, step: 'place' });
        else patch({ hint: 'Click a front, top or side view to project from.' });
        return;
      }
      void addProjectedView(hit.p);
      return;
    case 'section':
      if (state.step === 'line') {
        if (!state.line) {
          if (viewAccepted('section', hit.view)) patch({ line: [hit.p, hit.p], view: hit.view!.view });
          else patch({ hint: 'Start the cutting line on a view.' });
        } else endLine(hit);
        return;
      }
      void addSection(hit.p);
      return;
    case 'detail': {
      if (state.step === 'centre') {
        if (!hit.view || !viewAccepted('detail', hit.view)) { patch({ hint: 'Click the centre of the detail on a view.' }); return; }
        const anchor = anchorFor(pick, hit.view, hit.p);
        if (anchor) patch({ view: hit.view.view, centre: anchor.point, through: anchor.at, step: 'radius', radius: 0 });
        return;
      }
      if (state.step === 'radius') {
        if ((state.radius ?? 0) < 1) { patch({ hint: 'Drag out the circle around what the detail shows.' }); return; }
        patch({ step: 'place' });
        return;
      }
      void addDetail(hit.p);
      return;
    }
    case 'dimension': {
      if (pick && state.picks.length < 2 && !state.picks.some((item) => item === pick)) {
        const picks = [...state.picks, pick];
        patch({ picks, view: pick.view, step: picks.length === 2 || pick.kind === 'circle' ? 'place' : 'pick' });
        return;
      }
      if (state.picks.length && !finishBlocked(state)) { void addDimension(hit.p); return; }
      patch({ hint: state.picks.length ? finishBlocked(state) : pickProblem(state, hit.pick) ?? 'Click an edge, a circle or a corner in a view.' });
      return;
    }
    case 'datum': case 'frame': {
      if (state.step === 'pick') {
        if (pick) patch({ picks: [pick], view: pick.view, dimension: null, step: 'place' });
        else if (hit.dimension) patch({ picks: [], dimension: hit.dimension, step: 'place' });
        else patch({ hint: pickProblem(state, hit.pick) ?? 'Click a feature in a view, or a dimension (for its feature of size).' });
        return;
      }
      void addGdt(hit.p);
      return;
    }
    case 'weld': {
      if (pick && state.weld !== null) { void addLeader(pick); return; }
      if (pick) {
        if (state.picks.some((item) => weldRef(item) === weldRef(pick))) { patch({ hint: 'That one has an arrow already: pick another, or click where the symbol goes.' }); return; }
        if (state.picks.length >= WELD_LEADERS) { patch({ hint: `A weld symbol has up to ${WELD_LEADERS} arrows: click where it goes.` }); return; }
        patch({ picks: [...state.picks, pick], view: pick.view, step: 'place' });
        return;
      }
      if (state.picks.length && state.weld === null) {
        // On a line it can't take (another view's, one with no name): say why rather than place the symbol there.
        const problem = (hit.pick && pickProblem(state, hit.pick)) || finishBlocked(state);
        if (problem) patch({ hint: problem }); else void addWeld(hit.p);
        return;
      }
      patch({ hint: pickProblem(state, hit.pick) ?? (state.weld !== null ? 'Click the edge, face or corner the new arrow points at.' : 'Click an edge, a face or a corner of the joint in a view.') });
      return;
    }
    case 'balloon': {
      if (state.step === 'pick') {
        if (pick) patch({ picks: [pick], view: pick.view, step: 'place' });
        else patch({ hint: 'Click a part in a view.' });
        return;
      }
      void addBalloon(hit.p);
      return;
    }
    case 'note':
      // An edge, face or corner first: the note goes on a leader to it. Else where it's clicked.
      if (pick && !state.picks.length) { patch({ picks: [pick], view: pick.view }); return; }
      patch({ pointer: hit.p, options: { ...state.options, at: [hit.p[0], hit.p[1]] }, step: 'text' });
      return;
    case 'hole-table': {
      if (state.step === 'parent') {
        if (hit.view && viewAccepted('hole-table', hit.view)) patch({ view: hit.view.view, step: 'pick' });
        else patch({ hint: 'Click the view that looks along the holes.' });
        return;
      }
      if (pick?.kind === 'vertex') { patch({ origin: state.origin === pick ? null : pick }); return; }
      if (pick) {
        const picks = state.picks.some((item) => item.face === pick.face) ? state.picks.filter((item) => item.face !== pick.face) : [...state.picks, pick];
        patch({ picks });
        return;
      }
      if (hit.view && viewAccepted('hole-table', hit.view) && hit.view.view !== state.view) patch({ view: hit.view.view, picks: [], origin: null });
      return;
    }
    default:
  }
}

/** Esc inside a tool: back one step (a pick, the cutting line, the circle); false when there's nothing to go back
 *  from, so the tool closes. */
export function toolEscape(): boolean {
  const state = tool();
  if (state.tool === 'dimension' && state.picks.length) { patch({ picks: state.picks.slice(0, -1), step: 'pick', hint: null }); return true; }
  if (state.tool === 'weld' && state.picks.length) { patch({ picks: state.picks.slice(0, -1), step: state.picks.length > 1 ? 'place' : 'pick', hint: null }); return true; }
  if ((state.tool === 'datum' || state.tool === 'frame' || state.tool === 'balloon') && state.step === 'place') { patch({ picks: [], dimension: null, step: 'pick' }); return true; }
  if (state.tool === 'section' && (state.line || state.step === 'place')) { patch({ line: null, through: null, step: 'line' }); return true; }
  if (state.tool === 'detail' && state.step !== 'centre') { patch({ centre: null, radius: null, through: null, step: 'centre' }); return true; }
  if (state.tool === 'projected' && state.step === 'place') { patch({ view: null, step: 'parent' }); return true; }
  if (state.tool === 'note' && state.step === 'text') { patch({ step: 'place', options: { ...state.options, at: null } }); return true; }
  if (state.tool === 'note' && state.picks.length) { patch({ picks: [], view: null, hint: null }); return true; }
  if (state.tool === 'hole-table' && state.step === 'pick' && (state.picks.length || state.origin)) { patch({ picks: [], origin: null }); return true; }
  return false;
}

/** Why OK can't finish the tool yet, or null. */
export function finishBlocked(state: ToolState = tool()): string | null {
  switch (state.tool) {
    case 'projected': return state.step === 'parent' ? 'Pick the view to project from.' : !state.options.candidate ? 'Move the pointer to the side the new view goes.'
      : viewItems(currentCall()!.call).some((item) => viewName(item) === state.options.candidate) ? `The ${state.options.candidate} view is on the sheet already.` : null;
    case 'section': return state.step !== 'place' ? 'Draw the cutting line across a view.' : null;
    case 'detail': return state.step === 'centre' ? 'Click the detail’s centre on a view.' : (state.radius ?? 0) < 1 ? 'Drag out its circle.' : null;
    case 'dimension': return !state.picks.length ? 'Pick an edge, a circle or a corner in a view.'
      : state.picks.length === 1 && state.picks[0].kind === 'vertex' ? 'Pick a second corner or an edge to measure to.' : null;
    case 'datum': case 'frame': return state.picks.length || state.dimension ? null : 'Pick a feature, or a dimension.';
    case 'balloon': return state.picks.length ? null : 'Pick a part.';
    case 'weld': return state.weld !== null ? 'Pick the edge, face or corner the new arrow points at.'
      : !state.picks.length ? 'Pick an edge, a face or a corner of the joint.' : weldSpacingProblem(state.options);
    case 'note': return String(state.options.text ?? '').trim() ? (state.options.at ? null : 'Click where the note goes.') : 'Type the note.';
    case 'hole-table': return state.view ? null : 'Pick the view that looks along the holes.';
    case 'revision': return String(state.options.rev ?? '').trim() ? null : 'Give the revision a letter or number.';
    case 'sheet-format': case 'title-block': return Object.keys(state.changes).length ? null : 'Nothing changed yet.';
    case 'new-sheet': return get().busy ? 'Wait for the current operation to finish.' : null;
    default: return null;
  }
}

/** The Dimension tool's provisional dimension: what its picks measure (drawing/measure.ts) in the sheet's units, and,
 *  with a point to place it at, its lines there. Null with nothing measurable picked. */
export function dimensionPreview(state: ToolState = tool(), p: Point | null = state.pointer):
  { kind: DimensionKind; text: string | null; drawing: DimensionDrawing | null } | null {
  const current = currentCall();
  const view = placedView(state.picks[0]?.view);
  if (state.tool !== 'dimension' || !current || !view?.map) return null;
  const placement = p ? dimensionPlacement(state.picks, view.box, p) : {};
  const direction = placement.direction === 'horizontal' || placement.direction === 'vertical' ? placement.direction : undefined;
  const measured = measure(state.picks, view.map.scale, { radius: state.options.kind === 'radius', direction });
  if (!measured) return null;
  const dualPlaces = arg(current.call, 'dual_precision').value;
  return { kind: measured.kind, text: dimensionText(measured, unitsOf(current.call), dualOf(current.call), typeof dualPlaces === 'number' ? dualPlaces : undefined), drawing: p && measured.shape ? drawDimension(measured.shape, p) : null };
}

/** OK or Enter: writes what the tool has (placed where the runtime puts it, when it wasn't clicked into place). */
export async function finishTool() {
  const state = tool();
  if (!state.tool || finishBlocked(state)) return;
  switch (state.tool) {
    case 'base': await addBaseView(null); return;
    case 'projected': await addProjectedView(null); return;
    case 'section': await addSection(null); return;
    case 'detail': await addDetail(null); return;
    case 'dimension': await addDimension(null); return;
    case 'datum': case 'frame': await addGdt(null); return;
    case 'balloon': await addBalloon(null); return;
    case 'weld': await addWeld(null); return;
    case 'note': await addNote(); return;
    case 'hole-table': await addHoleTable(); return;
    case 'revision': await addRevision(); return;
    case 'sheet-format': case 'title-block': {
      const changes = state.changes;
      cancelTool();
      await editSheet(changes);
      return;
    }
    case 'new-sheet': {
      const component = typeof state.options.component === 'string' ? state.options.component : undefined;
      // Blank for Base view to start, unless the standard views (the runtime's default) are ticked.
      const args = { ...state.changes, views: state.options.standardViews === true ? undefined : '[]' };
      cancelTool();
      await addSheet({ args, component });
      return;
    }
  }
}

/* ───────── What each tool writes ───────── */

function placeLater(view: string, target: Point | null, axis: 'x' | 'y' | null, keep: Point, parent: string | null = null) {
  const current = currentCall();
  usePending.setState({ pending: target && current ? { sheet: current.index, view, target, axis, keep, parent } : null });
}

/** Once the sheet is drawn with a view written by a tool, moves it to where it was clicked; on a sheet whose views are
 *  fixed, fixes it there too (lined up with the view it's projected from), so annotations don't move it either. */
export async function placePending(report: DrawingSheet | undefined, sheet: number) {
  const { pending } = usePending.getState();
  if (!pending || pending.sheet !== sheet || !report) return;
  const drawn = report.views_placed?.find((view) => view.view === pending.view) as ViewOnSheet | undefined;
  if (!drawn) return;
  usePending.setState({ pending: null });
  const current = currentCall();
  if (!current || current.index !== sheet) return;
  const [x0, y0, x1, y1] = drawn.box;
  const [dx, dy] = [pending.target[0] - (x0 + x1) / 2, -(pending.target[1] - (y0 + y1) / 2)];  // `at` is y up.
  if (drawn.position && report.views_placed?.some((view) => view.fixed)) {
    const from = report.views_placed.find((view) => view.view === pending.parent)?.position;
    const [x, y] = [drawn.position[0] + dx, drawn.position[1] + dy];
    const next: Point = from && pending.axis === 'x' ? [x, from[1]] : from && pending.axis === 'y' ? [from[0], y] : [x, y];
    const changes = withViewPatches(current.call, new Map([[pending.view, { position: positionValue(next), at: undefined }]]));
    if (changes) await editSheet(changes);
    return;
  }
  const at = drawn.at ?? [0, 0];
  const next: Point = pending.axis === 'x' ? [at[0] + dx, pending.keep[1]] : pending.axis === 'y' ? [pending.keep[0], at[1] + dy] : [at[0] + dx, at[1] + dy];
  if (Math.hypot(next[0] - at[0], next[1] - at[1]) < 2) return;  // Where the projection method puts it anyway.
  const changes = withViewAt(current.call, pending.view, next);
  if (changes) await editSheet(changes);
}

/** Whether the next base view is the sheet's master: there's no front, top or side view on it yet (a blank sheet). */
export const placesMaster = (call: DrawingCall) => !viewItems(call).some((item) => !OWN_VIEWS.includes(viewName(item))) && arg(call, 'front').editable;

async function addBaseView(target: Point | null) {
  const current = currentCall();
  const picked = String(tool().options.orientation ?? '');
  if (!current || !picked || viewItems(current.call).some((item) => viewName(item) === picked)) return;
  // The master shows the picked side, up as that side's own view has it: it's the sheet's front, the others follow it.
  const master = !OWN_VIEWS.includes(picked) && placesMaster(current.call);
  const name = master ? 'front' : picked;
  // A flat view of one of several sheet-metal bodies names it (the one picked in the panel; its properties change it).
  const bodies = sheetMetalBodies();
  const body = typeof tool().options.body === 'string' && bodies.includes(tool().options.body as string) ? tool().options.body as string : bodies[0];
  const item: PyValue = name === FLAT && bodies.length > 1 ? { view: FLAT, body } : name;
  cancelTool();
  placeLater(name, target, null, [0, 0]);
  selectItem({ kind: 'view', name });
  await editSheet({ views: viewsText([...viewItems(current.call), item]), ...(master ? { front: frontText(picked, SIDE_UP[picked]) } : {}) });
}

async function addProjectedView(target: Point | null) {
  const state = tool();
  const current = currentCall();
  const name = String(state.options.candidate ?? '');
  if (!current || !name || !state.view || viewItems(current.call).some((item) => viewName(item) === name)) return;
  const parent = viewItems(current.call).find((item) => viewName(item) === state.view);
  const parentAt = atOf(parent && typeof parent === 'object' && !Array.isArray(parent) ? parent.at : undefined);
  // A projected view stays lined up with its parent: it moves only along the way it's projected.
  const axis = state.options.axis === 'y' ? 'y' : 'x';
  cancelTool();
  placeLater(name, target, axis, parentAt, state.view);
  selectItem({ kind: 'view', name });
  await editSheet({ views: viewsText([...viewItems(current.call), name]) });
}

const childRows = (call: DrawingCall, kind: 'section' | 'detail') => childViews(call).filter((child) => child.kind === kind).map((child) => child.row);

async function addSection(target: Point | null) {
  const state = tool();
  const current = currentCall();
  if (!current || !state.view || state.through === null) return;
  const name = String(state.options.name ?? 'A');
  const horizontal = state.options.direction !== 'vertical';
  const row: Record<string, PyValue> = { name, parent: state.view, through: state.through };
  if (!horizontal) row.direction = 'vertical';
  if (state.options.flip === true) row.flip = true;
  cancelTool();
  placeLater(name, target, horizontal ? 'y' : 'x', [0, 0], state.view);  // Lined up with its parent, out along the way it looks.
  selectItem({ kind: 'view', name });
  await editSheet({ section_views: pyList([...childRows(current.call, 'section'), row]) });
}

async function addDetail(target: Point | null) {
  const state = tool();
  const current = currentCall();
  const parent = placedView(state.view);
  if (!current || !state.view || state.through === null || !parent?.map) return;
  const name = String(state.options.name ?? 'A');
  const radius = Math.max(0.5, Math.round(((state.radius ?? 0) / parent.map.scale) * 2) / 2);
  cancelTool();
  placeLater(name, target, null, [0, 0]);
  selectItem({ kind: 'view', name });
  await editSheet({ detail_views: pyList([...childRows(current.call, 'detail'), { name, parent: state.view, centre: state.through, radius }]) });
}

async function addDimension(target: Point | null) {
  const state = tool();
  const current = currentCall();
  const view = placedView(state.view);
  if (!current || !state.picks.length || !state.view) return;
  const lines = state.picks.filter((pick) => pick.kind !== 'vertex' && pick.kind !== 'circle');
  const between = state.picks.length === 2 && lines.length === 2 && lines.every((pick) => pick.face);
  const refs = state.picks.map((pick) => refFor(pick, between));
  if (refs.some((ref) => !ref)) return;
  const rows = listOf(arg(current.call, 'feature_dimensions').value);
  const row: Record<string, PyValue> = { view: state.view, refs: refs as string[] };
  if (state.picks.length === 1 && state.picks[0].kind === 'circle' && state.options.kind === 'radius') row.kind = 'radius';
  if (target && view) Object.assign(row, dimensionPlacement(state.picks, view.box, target));
  // What was previewed stays drawn until the build draws it.
  const preview = target ? dimensionPreview(state, target) : null;
  usePlacedDimension.setState({ placed: preview?.drawing && preview.text ? { drawing: preview.drawing, text: preview.text } : null });
  // The tool stays open for the next one.
  patch({ picks: [], step: 'pick', view: null, hover: null });
  selectItem({ kind: 'dimension', number: rows.length + 1 });
  await editSheet({ feature_dimensions: pyList([...rows, row]) });
}

async function addGdt(target: Point | null) {
  const state = tool();
  const current = currentCall();
  if (!current || !state.tool) return;
  const { call } = current;
  const dims = listOf(arg(call, 'feature_dimensions').value);
  const changes: Record<string, string | undefined> = {};
  const at: Record<string, PyValue> = {};
  if (state.dimension) {
    const row = dims[state.dimension - 1];
    if (!row) return;
    const id = typeof row.id === 'string' ? row.id : dimensionId(dims);  // Frames and datums name a dimension by its id.
    if (row.id === undefined) changes.feature_dimensions = pyList(dims.map((item, i) => (i === state.dimension! - 1 ? withKeys(item, { id }) : item)));
    at.dimension = id;
  } else {
    const pick = state.picks[0];
    if (!pick) return;
    at.view = pick.view;
    at.ref = (pick.face ?? pick.ref)!;
    if (target) at.offset = offsetMm(Math.hypot(target[0] - anchorOf(pick)[0], target[1] - anchorOf(pick)[1]));
  }
  const kind = state.tool;
  const key = kind === 'datum' ? 'datums' : 'tolerance_frames';
  const rows = listOf(arg(call, key).value);
  let row: Record<string, PyValue>;
  if (kind === 'datum') {
    const label = String(state.options.label ?? 'A');
    if (listOf(arg(call, 'datums').value).some((item) => item.label === label)) { patch({ hint: `Datum ${label} is on this sheet already: choose another letter.` }); return; }
    row = { label, ...at };
  } else {
    row = { characteristic: state.options.characteristic ?? 'position', tolerance: state.options.tolerance ?? 0.1, ...at };
    for (const option of ['zone', 'modifier']) if (state.options[option]) row[option] = state.options[option];
    const datums = (Array.isArray(state.options.datums) ? state.options.datums : []).filter(Boolean);
    if (datums.length) row.datums = datums;
  }
  const standard = standardOf(call);
  patch({ picks: [], dimension: null, step: 'pick', hover: null, ...(kind === 'datum' ? { options: { ...state.options, label: nextDatumLabel([...rows.map((item) => String(item.label ?? '')), String(row.label)], standard) } } : {}) });
  selectItem({ kind: kind as 'datum' | 'frame', number: rows.length + 1 });
  await editSheet({ ...changes, [key]: pyList([...rows, row]) });
}

async function addWeld(target: Point | null) {
  const state = tool();
  const current = currentCall();
  const rows = current && weldRows(current.call);
  const refs = state.picks.map(weldRef);
  if (!rows || !state.picks.length || refs.some((ref) => !ref) || finishBlocked(state)) return;
  // Clicked into place: the reference line starts there, from the first arrow's tip (`at`); else the sheet places it.
  const row = newWeld(state.options, state.picks[0].view, refs as string[], target ? weldAt(weldTip(state.picks[0]), target) : undefined);
  // The tool stays open for the next one, with the same values.
  patch({ picks: [], step: 'pick', view: null, hover: null });
  selectItem({ kind: 'weld', number: rows.length + 1 });
  await editSheet({ welds: weldsText([...rows, row]) });
}

/** Add arrow: one more arrow on the weld symbol the tool was started for, to the pick. */
async function addLeader(pick: SheetPick) {
  const state = tool();
  const current = currentCall();
  const rows = current && weldRows(current.call);
  const ref = weldRef(pick);
  const row = rows?.[(state.weld ?? 0) - 1];
  if (!rows || !row || !ref || state.weld === null) return;
  if (weldRefs(row).includes(ref)) { patch({ hint: 'That one has an arrow already: pick another.' }); return; }
  const number = state.weld;
  cancelTool();
  selectItem({ kind: 'weld', number });
  await editSheet({ welds: weldsText(rows.map((entry, i) => (i === number - 1 ? withLeader(entry, ref) : entry))) });
}

async function addBalloon(target: Point | null) {
  const state = tool();
  const current = currentCall();
  const pick = state.picks[0];
  const view = placedView(pick?.view);
  if (!current || !pick?.ref) return;
  const rows = balloonRows(current.call);
  if (!Array.isArray(rows)) return;
  if (rows.some((row) => row.instance === pick.ref)) { patch({ picks: [], step: 'pick', hint: `${pick.ref} has a balloon already.` }); return; }
  const row: Record<string, PyValue> = { instance: pick.ref, view: pick.view, ...(target && view ? balloonPlacement(view.box, target) : {}) };
  patch({ picks: [], step: 'pick', hover: null });
  await editSheet({ balloons: balloonsText([...rows, row]) });
}

async function addNote() {
  const state = tool();
  const current = currentCall();
  const at = state.options.at;
  const text = String(state.options.text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);
  if (!current || !text || !Array.isArray(at)) return;
  const report = sheetReport();
  const height = report?.size_mm?.[1];
  if (!height) return;
  const rows = noteRows(current.call);
  const pick = state.picks[0];
  const ref = pick && weldRef(pick);
  cancelTool();
  selectItem({ kind: 'note', number: rows.length + 1 });
  if (pick && ref) {  // On a leader: its shoulder where it was clicked, from the leader's tip there (as a weld's `at`).
    await editSheet({ notes: notesText([...rows, { text, view: pick.view, ref, at: weldAt(weldTip(pick), [Number(at[0]), Number(at[1])]) }]) });
    return;
  }
  const point: Point = [Math.round(Number(at[0]) * 2) / 2, Math.round((height - Number(at[1])) * 2) / 2];  // From the lower-left, y up.
  await editSheet({ notes: notesText([...rows, { text, at: point }]) });
}

async function addHoleTable() {
  const state = tool();
  const current = currentCall();
  if (!current || !state.view) return;
  const rows = listOf(arg(current.call, 'hole_tables').value);
  const row: Record<string, PyValue> = { view: state.view };
  if (state.picks.length) row.holes = state.picks.map((pick) => pick.face!);
  if (state.origin?.ref) row.origin = state.origin.ref;
  cancelTool();
  selectItem({ kind: 'hole-table', number: rows.length + 1 });
  await editSheet({ hole_tables: pyList([...rows, row]) });
}

async function addRevision() {
  const state = tool();
  const current = currentCall();
  if (!current) return;
  const rows = listOf(arg(current.call, 'revisions').value);
  const field = (key: string) => String(state.options[key] ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 200);
  cancelTool();
  selectItem({ kind: 'revisions' });
  await editSheet({ revisions: pyList([...rows, { rev: field('rev'), description: field('description') || 'Describe the change', date: field('date'), by: field('by') }]) });
}

/** A sheet-wide tool's draft (sheet format, title block): the arguments it will write. */
export function draftChange(changes: Record<string, string | undefined>) {
  patch({ changes: { ...tool().changes, ...changes } });
}

/** Tells the person why a tool can't start (from a menu or the keyboard; the ribbon shows it on the button). */
export function tryTool(kind: ToolKind, preset?: { view?: string; dimension?: number; weld?: number }) {
  const blocked = toolBlocked(kind);
  if (blocked) { toast('info', TOOL_TITLES[kind], blocked); return; }
  startTool(kind, preset);
}

export { viewAccepted };

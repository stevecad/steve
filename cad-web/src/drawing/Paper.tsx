/**
 * One drawing sheet, sanitized, on a pannable and zoomable table (scroll to zoom, drag empty paper to pan), and what's
 * done on it with the pointer:
 *
 * - With no tool open, a click selects what's under it (a view, a dimension, a balloon, a datum, a frame, a note, a
 *   table, the title block), the same thing the Browser's drawing tree selects; a double click edits it in the
 *   Inspector (a placed note's text in place); a double click on empty paper fits the sheet. Views, feature
 *   dimensions, balloons, weld symbols and placed and leader notes are dragged into place: a view's drop writes its `at`, or its
 *   `position` when it's fixed there (projected views move only along the way they're projected, unless Alt is held; the views lined up with the front
 *   view follow it), a dimension's its `offset`, `side` and `text_at`, a weld symbol's and a leader note's its `at`. Escape cancels a drag. What's dragged moves on the sheet itself (a
 *   view with its lines, its annotations and the views hanging off it: the build groups them, `data-view-lines` and
 *   `data-on-view`; an annotation's leaders and extension lines stay on what they point at, drawn again to where it's
 *   dragged: drawMoves), and stays where it's dropped, faded, until the sheet is drawn again; the sheet isn't locked
 *   meanwhile: further drags, picks and tools work on it (not inside a view still to be redrawn), each edit on the
 *   latest code.
 * - With a tool open (drawing/tools.ts), the pointer picks the model geometry the sheet's lines are traced to
 *   (drawing/picks.ts), highlighting what the tool takes, and clicks place what it makes; its preview is drawn over the
 *   sheet (a dimension with its value, which stays drawn once placed until the sheet is drawn again).
 * - A right click (a long press on touch, the Menu key or Shift+F10) opens the menu for what's under it, or for the
 *   open tool (drawing/menus.tsx).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ContextContent, ContextRoot, ContextTrigger } from '@/ui';
import type { DrawingSheet } from '@/lib/api';
import { sanitizeSvg } from '@/lib/sanitize';
import { get, samePick, set, useApp, type Pick } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { pickOnSheet, sheetMarks } from './picking';
import {
  atOf, atValue, childViews, dragged, draggedBalloon, draggedNote, draggedWeld, isLeaderNote, noteRows, notesText, positionValue, weldRows, withViewPatches, writtenViewAt, writtenViewPosition,
  type DimensionPlacement, type DrawingCall, type PlacementPatch, type PyValue, type ViewOnSheet,
} from './code';
import { anchorOf, pathOf, pickAt, readPicks, type Point, type SheetPick } from './picks';
import { editBalloon, editDimension, editItem, editSheet, editWeld, itemKey, mainCode, selectItem, useDrawingTab, type DrawingItem } from './state';
import {
  useDrawingTool, usePlacedDimension, dimensionPreview, toolClick, toolPointer, toolPress, toolRelease, finishTool, toolEscape, pickProblem, weldTip, type Hit,
} from './tools';
import type { DimensionDrawing } from './measure';
import { SheetMenu, type MenuTarget } from './menus';
import { viewTitle, weldTypeName } from './items';
import styles from './Drawing.module.css';

const GROUPS = ['dimension', 'balloon', 'hole-table', 'datum', 'frame', 'weld', 'note'] as const;

/** Annotations' lines are hairlines: a wider, invisible copy of each makes them easy to pick (the sheet's files stay
 *  as drawn). */
function widenHits(svg: SVGSVGElement) {
  for (const path of svg.querySelectorAll(GROUPS.map((kind) => `[data-${kind}] path[stroke-width]`).join(', '))) {
    const hit = path.cloneNode() as SVGPathElement;
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '2.5');
    hit.setAttribute('pointer-events', 'stroke');
    hit.setAttribute('data-hit', '');
    path.after(hit);
  }
}

/** The annotation group an element is in, as an item. */
function groupItem(target: Element | null): { item: DrawingItem; group: Element } | null {
  for (const kind of GROUPS) {
    const group = target?.closest?.(`[data-${kind}]`);
    if (group) return { item: { kind, number: Number(group.getAttribute(`data-${kind}`)) }, group };
  }
  return null;
}

/** Expanded leader hit areas must not steal clicks on another annotation's visible text. */
function annotationTarget(clientX: number, clientY: number): Element | null {
  const elements = document.elementsFromPoint(clientX, clientY);
  const target = elements[0] ?? null;
  const sheet = target?.closest('svg[data-sheet]');
  if (!sheet) return target;
  return elements.find((element) => element.localName === 'text'
    && element.closest('svg[data-sheet]') === sheet && groupItem(element)) ?? target;
}

const inside = (box: [number, number, number, number], p: Point, pad = 0) => p[0] >= box[0] - pad && p[0] <= box[2] + pad && p[1] >= box[1] - pad && p[1] <= box[3] + pad;
const area = (box: [number, number, number, number]) => (box[2] - box[0]) * (box[3] - box[1]);

/** The base views lined up with `name` in the projection method's grid, which follow it when it's dragged: the ones
 *  above and below the front view follow it sideways, the ones beside it up and down. */
const COLUMN = ['front', 'top', 'bottom'], ROW = ['front', 'right', 'left', 'back'];
/** Which way a view may be dragged and keep lined up with what it's projected from. */
function dragAxis(view: ViewOnSheet, call: DrawingCall): 'x' | 'y' | null {
  if (view.kind === 'base') return ['top', 'bottom'].includes(view.view) ? 'y' : ['right', 'left', 'back'].includes(view.view) ? 'x' : null;
  if (view.kind === 'section') return childViews(call).find((child) => child.row.name === view.view)?.row.direction === 'vertical' ? 'x' : 'y';
  return null;
}

/** Something moved on the sheet by (dx, dy) paper mm: a view (`view:<name>`, its own annotations along) or an
 *  annotation (`dimension:3`, `balloon:1`, `note:2`), its leaders and extension lines staying on what they point at;
 *  `text`: a dimension's text, further along its line. */
interface Move { key: string; d: Point; text?: Point }

const add = (a: Point, b?: Point): Point => (b ? [a[0] + b[0], a[1] + b[1]] : a);
const mm = (n: number) => n.toFixed(3);
const numbers = (text: string | null) => (text?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
/** What the build tags in an annotation's group (runtime/steve/drawing.py Sheet.leader, Sheet.tagged): a leader or
 *  extension line from its tip on the model (`data-leader`), its arrowhead (`data-arrow`: its tip, the line's other
 *  end), a dot on the model (`data-anchored`), a dimension line and its arrows (`data-dimension-line`). */
const TAGGED = '[data-leader], [data-arrow], [data-anchored], [data-dimension-line]';

function translate(element: Element, d: Point) {
  element.setAttribute('transform', `translate(${mm(d[0])} ${mm(d[1])})`);
  element.setAttribute('data-moved', '');
}

/** A leader (or its arrowhead) drawn again from its tip, moved only with its view (`whole`), to its other end moved
 *  with what it points from (`moved`). */
function reroute(element: Element, whole: Point, moved: Point) {
  const drawn = element.getAttribute('d') ?? '';
  element.setAttribute('data-drawn', drawn);
  element.setAttribute('data-moved', '');
  const leader = element.hasAttribute('data-leader');
  const [tx, ty, ex, ey] = leader ? [...numbers(element.getAttribute('data-leader')), ...numbers(drawn).slice(-2)] : numbers(element.getAttribute('data-arrow'));
  if (![tx, ty, ex, ey].every(Number.isFinite)) { translate(element, moved); return; }
  const tip: Point = [tx + whole[0], ty + whole[1]], end: Point = [ex + moved[0], ey + moved[1]];
  if (leader) { element.setAttribute('d', `M${mm(tip[0])} ${mm(tip[1])} L${mm(end[0])} ${mm(end[1])}`); return; }
  const length = Math.hypot(end[0] - tip[0], end[1] - tip[1]);
  if (length < 1e-6) { translate(element, whole); return; }
  // As Sheet.arrow draws it: 3 mm long, 1 mm wide at its back.
  const [ux, uy] = [(end[0] - tip[0]) / length, (end[1] - tip[1]) / length];
  const back: Point = [tip[0] + 3 * ux, tip[1] + 3 * uy];
  element.setAttribute('d', `M${mm(tip[0])} ${mm(tip[1])} L${mm(back[0] - 0.5 * uy)} ${mm(back[1] + 0.5 * ux)} L${mm(back[0] + 0.5 * uy)} ${mm(back[1] - 0.5 * ux)} Z`);
}

/** Moves what's in a moved group: the dimension line by `moved`, its text and everything else by `text`, and its
 *  leaders and extension lines from where they start (moved only by `whole`) to where they now end. A group without
 *  tags (sheets drawn before them) moves whole. */
function shift(element: Element, whole: Point, moved: Point, text: Point) {
  if (element.hasAttribute('data-leader') || element.hasAttribute('data-arrow')) reroute(element, whole, moved);
  else if (element.hasAttribute('data-anchored')) translate(element, whole);
  else if (element.hasAttribute('data-dimension-line')) translate(element, moved);
  else if (!element.querySelector(TAGGED)) translate(element, text);
  else for (const child of element.children) shift(child, whole, moved, text);
}

/** The sheet's elements a move moves. */
function movedBy(svg: SVGSVGElement, key: string): Element[] {
  const at = key.indexOf(':');
  const [kind, name] = [key.slice(0, at), CSS.escape(key.slice(at + 1))];
  return [...svg.querySelectorAll(kind === 'view' ? `[data-view-lines="${name}"], [data-on-view="${name}"]` : `[data-${kind}="${name}"]`)];
}

/** Draws what's moved where it's been moved to: `moves` dropped and written, faded until the sheet is drawn again,
 *  then `live`, the drag under way. Everything else stays as drawn. */
function drawMoves(svg: SVGSVGElement, moves: Move[], live: Move[] = []) {
  for (const element of svg.querySelectorAll('[data-moved]')) {
    element.removeAttribute('transform');
    const drawn = element.getAttribute('data-drawn');
    if (drawn !== null) { element.setAttribute('d', drawn); element.removeAttribute('data-drawn'); }
    element.removeAttribute('data-moved');
    element.removeAttribute('data-redrawing');
  }
  // How far each group has moved with its view (`whole`), by itself (`own`) and its text further (`text`).
  type Moved = { whole: Point; own: Point; text: Point; live: boolean };
  const at = new Map<Element, Moved>();
  for (const [list, dragging] of [[moves, false], [live, true]] as const) {
    for (const move of list) {
      const view = move.key.startsWith('view:');
      for (const element of movedBy(svg, move.key)) {
        const entry: Moved = at.get(element) ?? { whole: [0, 0], own: [0, 0], text: [0, 0], live: false };
        at.set(element, {
          whole: view ? add(entry.whole, move.d) : entry.whole, own: view ? entry.own : add(entry.own, move.d),
          text: add(entry.text, move.text), live: entry.live || dragging,
        });
      }
    }
  }
  for (const [element, { whole, own, text, live: dragging }] of at) {
    const moved = add(whole, own);
    shift(element, whole, moved, add(moved, text));
    element.setAttribute('data-moved', '');
    element.toggleAttribute('data-redrawing', !dragging);
  }
}

export interface PaperProps {
  markup: string; stale: boolean; fitKey: string; report?: DrawingSheet; call?: DrawingCall;
  /** The sheet is being drawn again (a drawing edit): it stays editable meanwhile. */
  redrawing: boolean;
  /** Why the sheet can't be edited right now (busy, the model changed, it couldn't be drawn), else null. */
  locked: string | null;
  /** Dimensions and balloons are dragged when they're written as literals. */
  dimensionsEditable: boolean; balloonsEditable: boolean;
}

export default function Paper({ markup, stale, redrawing, fitKey, report, call, locked, dimensionsEditable, balloonsEditable }: PaperProps) {
  const canvas = useRef<HTMLDivElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const zoom = useRef(view);
  zoom.current = view;
  const fitNonce = useDrawingTab((state) => state.fitNonce);
  const selected = useDrawingTab((state) => state.selected);
  const tool = useDrawingTool();
  // The model's geometry picked on the sheet is the 3D view's selection (drawing/picking.ts), drawn in every view.
  const selection = useApp((state) => state.selection);
  const [modelVersion, setModelVersion] = useState(0);
  useEffect(() => viewer.onModelChange(() => setModelVersion((version) => version + 1)), []);
  const marks = useMemo(() => (report ? sheetMarks(report, selection) : []), [report, selection, modelVersion]);
  const [menu, setMenu] = useState<MenuTarget>({ kind: 'empty' });
  const [hoverView, setHoverView] = useState<string | null>(null);
  // A view's outline follows the pointer on sheets drawn before views were grouped (else the view itself moves).
  const [drag, setDrag] = useState<{ view: string; dx: number; dy: number } | null>(null);
  const [editingNote, setEditingNote] = useState<{ number: number; text: string } | null>(null);
  // What's been dropped and written but not drawn yet (drawn where it was dropped: drawMoves).
  const [moves, setMoves] = useState<Move[]>([]);
  const pending = useRef<Move[]>([]);
  const sheet = useRef<SVGSVGElement | null>(null);
  const keepMoves = (next: Move[]) => {
    pending.current = next;
    setMoves(next);
    if (sheet.current) drawMoves(sheet.current, next);
  };
  /** How far each view still to be redrawn has moved. */
  const movedViews = useMemo(() => {
    const out = new Map<string, Point>();
    for (const { key, d } of moves) {
      if (!key.startsWith('view:')) continue;
      const name = key.slice(5), was = out.get(name) ?? [0, 0];
      out.set(name, [was[0] + d[0], was[1] + d[1]]);
    }
    return out;
  }, [moves]);
  // The views where they're shown: a moved one where it was dropped.
  const views = useMemo(() => ((report?.views_placed ?? []) as ViewOnSheet[]).map((item) => {
    const d = movedViews.get(item.view);
    return d ? { ...item, box: [item.box[0] + d[0], item.box[1] + d[1], item.box[2] + d[0], item.box[3] + d[1]] as ViewOnSheet['box'] } : item;
  }), [report, movedViews]);
  const sheetPicks = useMemo(() => readPicks(svg), [svg]);
  // A moved view's lines are picked once it's drawn again, where it went.
  const picks = useMemo(() => (movedViews.size ? sheetPicks.filter((pick) => !movedViews.has(pick.view)) : sheetPicks), [sheetPicks, movedViews]);
  // A dimension just placed is drawn as previewed until the sheet is drawn again, or the build fails.
  const placed = usePlacedDimension((state) => state.placed);
  const buildError = useApp((state) => state.error);
  useEffect(() => { if (buildError) usePlacedDimension.setState({ placed: null }); }, [buildError]);

  useLayoutEffect(() => {
    const host = paper.current;
    usePlacedDimension.setState({ placed: null });
    if (!host) return;
    const next = sanitizeSvg(markup);
    if (next) widenHits(next);
    host.querySelector('svg[data-sheet]')?.remove();
    if (next) { next.setAttribute('data-sheet', ''); host.prepend(next); }
    sheet.current = next;
    // The sheet drawn again has what was moved (or it's another sheet).
    if (pending.current.length) keepMoves([]);
    setSvg(next);
    const box = next?.viewBox.baseVal;
    // 4 px a millimetre at 100 %: an A3 sheet is 1680 px wide before fitting.
    setSize((previous) => {
      const sized: [number, number] | null = box && box.width && box.height ? [box.width * 4, box.height * 4] : null;
      return previous && sized && previous[0] === sized[0] && previous[1] === sized[1] ? previous : sized;
    });
  }, [markup]);
  // Once the redraw settles (the same drawing again, or none) or the sheet can't be trusted, nothing waits to be drawn.
  const wasRedrawing = useRef(redrawing);
  useEffect(() => {
    if (pending.current.length && ((wasRedrawing.current && !redrawing) || locked)) keepMoves([]);
    wasRedrawing.current = redrawing;
  }, [redrawing, locked]);

  const fit = () => {
    const host = canvas.current;
    if (!host || !size) return;
    const k = Math.min(host.clientWidth / size[0], host.clientHeight / size[1]) * 0.94;
    setView({ k, x: (host.clientWidth - size[0] * k) / 2, y: (host.clientHeight - size[1] * k) / 2 });
  };
  // A new sheet (another page, size or orientation) or Fit frames it whole; rebuilds of the same sheet keep the view.
  useLayoutEffect(fit, [size, fitKey, fitNonce]);

  useEffect(() => {
    const host = canvas.current;
    if (!host) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const cx = event.clientX - rect.left, cy = event.clientY - rect.top;
      setView((current) => {
        const k = Math.min(20, Math.max(0.05, current.k * Math.exp(-event.deltaY * 0.0015)));
        return { k, x: cx - (cx - current.x) * (k / current.k), y: cy - (cy - current.y) * (k / current.k) };
      });
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

  // What's selected stands out on the sheet (and in the tree).
  useLayoutEffect(() => {
    if (!svg) return;
    for (const kind of GROUPS) {
      for (const group of svg.querySelectorAll(`[data-${kind}]`)) {
        group.toggleAttribute('data-selected', selected?.kind === kind && 'number' in selected && Number(group.getAttribute(`data-${kind}`)) === selected.number);
      }
    }
  }, [selected, svg]);

  /** The sheet point (paper mm, y down) under a client point. */
  const sheetPoint = (clientX: number, clientY: number): Point => {
    const rect = canvas.current!.getBoundingClientRect();
    const { x, y, k } = zoom.current;
    return [(clientX - rect.left - x) / (4 * k), (clientY - rect.top - y) / (4 * k)];
  };
  const reach = () => 9 / (4 * zoom.current.k);  // 9 px around the pointer.
  const viewAt = (p: Point): ViewOnSheet | null => views.filter((item) => inside(item.box, p, 2)).sort((a, b) => area(a.box) - area(b.box))[0] ?? null;
  /** Whether `p` is on a view that's been moved and not drawn again yet (its geometry isn't where the build put it). */
  const redrawingAt = (p: Point) => { const at = viewAt(p); return !!at && movedViews.has(at.view); };
  const hitAt = (event: { clientX: number; clientY: number; target: EventTarget | null }): Hit => {
    const p = sheetPoint(event.clientX, event.clientY);
    const state = useDrawingTool.getState();
    const group = groupItem(annotationTarget(event.clientX, event.clientY));
    const dimension = group?.item.kind === 'dimension' && 'number' in group.item ? group.item.number : null;
    if (redrawingAt(p)) return { p, pick: null, view: null, dimension, all: picks };
    const near = pickAt(picks, p, reach(), (pick) => !state.tool || pick.kind !== 'instance' || state.tool === 'balloon');
    return { p, pick: near, view: viewAt(p), dimension, all: picks };
  };
  /** What a click with no tool open selects. */
  const itemAt = (target: Element | null, p: Point): DrawingItem | null => {
    const group = groupItem(target);
    if (group) return group.item;
    const region = report?.regions?.find((item) => inside(item.box, p));
    if (region) return region.kind === 'hole-table' ? { kind: 'hole-table', number: region.index ?? 1 } : { kind: region.kind } as DrawingItem;
    const placed = viewAt(p);
    return placed ? { kind: 'view', name: placed.view } : null;
  };

  const pan = (event: React.PointerEvent<HTMLDivElement>, onClick?: () => void) => {
    const host = event.currentTarget;
    host.setPointerCapture(event.pointerId);
    const first = [event.clientX, event.clientY];
    let last = first;
    const move = (e: PointerEvent) => {
      const [dx, dy] = [e.clientX - last[0], e.clientY - last[1]];
      last = [e.clientX, e.clientY];
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    };
    const up = () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 4) onClick?.();
    };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
  };

  /** Follows a press until it's let go: `move` previews the drag (paper mm, y down) and returns what to write on the
   *  drop, which `commit` writes; Escape or a cancelled pointer puts it back. A press that doesn't move is a click. */
  const follow = <T,>(event: React.PointerEvent<HTMLDivElement>, move: (dx: number, dy: number, free: boolean) => T, commit: (patch: T) => void, reset: () => void, click?: () => void) => {
    event.stopPropagation();
    const host = event.currentTarget;
    host.setPointerCapture(event.pointerId);
    const start = [event.clientX, event.clientY];
    let patch: T | null = null;
    const moved = (e: PointerEvent) => {
      const [px, py] = [e.clientX - start[0], e.clientY - start[1]];
      if (patch === null && Math.hypot(px, py) < 4) return;  // A click, not a drag, until it moves.
      const mm = 1 / (4 * zoom.current.k);
      patch = move(px * mm, py * mm, e.altKey);
    };
    const finish = (done: boolean) => {
      host.removeEventListener('pointermove', moved);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      if (done && patch !== null) commit(patch);  // The rebuilt sheet replaces the preview.
      else { reset(); if (done) click?.(); }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
    host.addEventListener('pointermove', moved);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  };

  const editable = !locked;

  /** The model's face, edge or vertex on a line of a view under the pointer, as the 3D view picks it; null elsewhere. */
  const geometryAt = (target: Element | null, p: Point): Pick | null => {
    if (!report || groupItem(target) || redrawingAt(p) || !pickAt(picks, p, reach(), (pick) => pick.kind !== 'instance')) return null;
    return pickOnSheet(report, p[0], p[1], 4 * zoom.current.k, get().filter);
  };
  /** Selects picked geometry as a click in the 3D view does: Shift or Ctrl (⌘) adds or takes it away. */
  const selectGeometry = (pick: Pick | null, additive: boolean) => {
    const { selection: current } = get();
    if (!pick) { if (!additive && current.length) set({ selection: [] }); return; }
    if (!additive) set({ selection: [pick] });
    else set({ selection: current.some((item) => samePick(item, pick)) ? current.filter((item) => !samePick(item, pick)) : [...current, pick] });
  };

  /** A drag of view `name` by (dx, dy) paper mm (y down), as the argument changes its drop writes: each view it moves
   *  (viewShifts) at its new position when it has one, else by its `at` (a section or detail view without one follows
   *  its parent by itself). */
  const viewMove = (placed: ViewOnSheet, dx: number, dy: number): Record<string, string | undefined> | null => {
    if (!call) return null;
    const patches = new Map<string, Record<string, PyValue | undefined>>();
    for (const { key, d: [mx, my] } of viewShifts(placed, dx, dy)) {
      const name = key.slice(5);
      // From where the code has it now: a move dropped before is written there, though not drawn yet.
      const position = writtenViewPosition(call, name);
      if (position) patches.set(name, { position: positionValue([position[0] + mx, position[1] - my]) });
      else if (name === placed.view || views.find((item) => item.view === name)?.kind === 'base') {
        const at = writtenViewAt(call, name) ?? (name === placed.view ? atOf(placed.at as never) : [0, 0]);
        patches.set(name, { at: atValue([at[0] + mx, at[1] - my]) });
      }
    }
    return withViewPatches(call, patches);
  };

  /** What a drag of view `placed` by (dx, dy) moves on the sheet: the view, the views lined up with it when it's the
   *  front view (as viewMove writes them), and the section and detail views hanging off any of them. */
  const viewShifts = (placed: ViewOnSheet, dx: number, dy: number): Move[] => {
    const by = new Map<string, Point>([[placed.view, [dx, dy]]]);
    if (placed.kind === 'base' && placed.view === 'front') {
      for (const item of views) {
        if (item.kind !== 'base' || item.view === 'front') continue;
        if (COLUMN.includes(item.view)) by.set(item.view, [dx, 0]);
        else if (ROW.includes(item.view)) by.set(item.view, [0, dy]);
      }
    }
    for (let grown = true; grown;) {
      grown = false;
      for (const item of views) {
        if (item.parent && by.has(item.parent) && !by.has(item.view)) { by.set(item.view, by.get(item.parent)!); grown = true; }
      }
    }
    return [...by].map(([name, d]) => ({ key: `view:${name}`, d }));
  };

  /** Moves what's being dragged on the sheet, from where earlier drops left it. */
  const showDrag = (live: Move[]) => { if (sheet.current) drawMoves(sheet.current, pending.current, live); };
  /** How far a drop not drawn yet has moved `key`. */
  const movedSoFar = (key: string): Point => pending.current.filter((move) => move.key === key)
    .reduce<Point>((sum, move) => add(add(sum, move.d), move.text), [0, 0]);
  /** Writes a drop (`edit`, which writes the code before it waits on anything); what it moved stays where it was
   *  dropped until the sheet is drawn with it. A drop that changes nothing goes back. */
  const drop = (moved: Move[], edit: () => unknown) => {
    const before = mainCode();
    void edit();
    keepMoves(mainCode() !== before ? [...pending.current, ...moved] : pending.current);
  };

  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    canvas.current?.focus({ preventScroll: true });
    if (event.button === 1) { pan(event); return; }
    if (event.button !== 0) return;
    const hit = hitAt(event);
    const state = useDrawingTool.getState();
    if (state.tool) {
      if (locked) { useDrawingTool.setState({ hint: locked }); pan(event); return; }
      if (redrawingAt(hit.p)) { useDrawingTool.setState({ hint: 'Wait for this view to redraw.' }); pan(event); return; }
      if (toolPress(hit)) {
        const host = event.currentTarget;
        host.setPointerCapture(event.pointerId);
        const start = [event.clientX, event.clientY];
        const up = (e: PointerEvent) => {
          host.removeEventListener('pointerup', up);
          if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) >= 4) toolRelease(hitAt(e));
        };
        host.addEventListener('pointerup', up);
        return;
      }
      pan(event, () => toolClick(hit));
      return;
    }
    const target = annotationTarget(event.clientX, event.clientY);
    const item = itemAt(target, hit.p);
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (!item) { pan(event, () => { selectItem(null); selectGeometry(null, additive); }); return; }
    selectItem(item);
    const group = groupItem(target)?.group;
    if (item.kind === 'dimension' && group) {
      const placed = (report?.placed ?? []).find((entry) => entry.dimension === item.number);
      if (!placed || !dimensionsEditable || !editable) return;
      const text = !!target?.closest('text');
      const others = (report?.placed ?? []).filter((entry) => entry.dimension !== item.number && entry.view === placed.view && entry.type === placed.type && entry.side === placed.side).map((entry) => entry.offset);
      // Placed as the shown sheet reports it, plus a drop not drawn yet.
      const key = `dimension:${item.number}`, before = movedSoFar(key);
      follow(event, (dx, dy, free) => {
        const patch: PlacementPatch = dragged(placed as DimensionPlacement, { dx: before[0] + dx, dy: before[1] + dy, text, snap: !free, others });
        const moved: Move[] = [{ key, d: [dx, dy] }];
        if (placed.normal && (placed.type === 'linear' || placed.type === 'aligned')) {  // The line moves out from the view only; the text along it too.
          const out = dx * placed.normal[0] + dy * placed.normal[1];
          const line: Point = [out * placed.normal[0], out * placed.normal[1]];
          moved[0] = { key, d: line, text: text ? [dx - line[0], dy - line[1]] : undefined };
        }
        showDrag(moved);
        return { patch, moved };
      }, ({ patch, moved }) => drop(moved, () => editDimension(item.number, patch)), () => showDrag([]));
      return;
    }
    if (item.kind === 'balloon' && group) {
      const drawn = report?.balloons_placed ?? [];
      const placed = drawn.find((entry) => entry.balloon === item.number);
      if (!placed || !balloonsEditable || !editable) return;
      const key = `balloon:${item.number}`, before = movedSoFar(key);
      follow(event, (dx, dy, free) => {
        showDrag([{ key, d: [dx, dy] }]);
        return { patch: draggedBalloon(placed, { dx: before[0] + dx, dy: before[1] + dy, snap: !free }), d: [dx, dy] as Point };
      }, ({ patch, d }) => drop([{ key, d }], () => editBalloon(placed, drawn, patch)), () => showDrag([]));
      return;
    }
    if (item.kind === 'weld' && group && call && editable) {
      // Dropped exactly where it's let go: its `at` from its first arrow's tip, as the sheet reports it plus a drop not drawn yet.
      const placed = report?.welds_placed?.find((entry) => entry.weld === item.number);
      if (!placed || !weldRows(call)) return;
      const key = `weld:${item.number}`, before = movedSoFar(key);
      follow(event, (dx, dy) => {
        showDrag([{ key, d: [dx, dy] }]);
        return { patch: draggedWeld(placed, { dx: before[0] + dx, dy: before[1] + dy }), d: [dx, dy] as Point };
      }, ({ patch, d }) => drop([{ key, d }], () => editWeld(item.number, patch)), () => showDrag([]));
      return;
    }
    if (item.kind === 'note' && group && call && editable) {
      // Notes are placed by the code itself, which has every drop already.
      const rows = noteRows(call);
      const row = rows[item.number - 1];
      const key = `note:${item.number}`;
      if (row && isLeaderNote(row)) {
        // Dropped exactly where it's let go: its `at` from its leader's tip, as the sheet reports it plus a drop not drawn yet.
        const placed = report?.notes_placed?.find((entry) => entry.note === item.number);
        if (!placed) return;
        const before = movedSoFar(key);
        follow(event, (dx, dy) => {
          showDrag([{ key, d: [dx, dy] }]);
          return { next: draggedNote(row, placed, { dx: before[0] + dx, dy: before[1] + dy }), d: [dx, dy] as Point };
        }, ({ next, d }) => drop([{ key, d }], () => editSheet({ notes: notesText(rows.map((entry, i) => (i === item.number - 1 ? next : entry))) })),
        () => showDrag([]));
        return;
      }
      if (!row || typeof row === 'string' || !row.at) return;
      follow(event, (dx, dy) => {
        showDrag([{ key, d: [dx, dy] }]);
        return { at: [Math.round((row.at![0] + dx) * 2) / 2, Math.round((row.at![1] - dy) * 2) / 2] as Point, d: [dx, dy] as Point };
      }, ({ at, d }) => drop([{ key, d }], () => editSheet({ notes: notesText(rows.map((entry, i) => (i === item.number - 1 ? { text: row.text, at } : entry))) })),
      () => showDrag([]));
      return;
    }
    if (item.kind === 'view' && editable && call) {
      const placed = views.find((entry) => entry.view === item.name);
      if (!placed) return;
      const axis = dragAxis(placed, call);
      const geometry = geometryAt(event.target as Element, hit.p);
      // Sheets drawn before views were grouped show the view's outline moving instead.
      const grouped = !!sheet.current?.querySelector('[data-view-lines]');
      follow(event, (dx, dy, free) => {
        const [mx, my] = free || !axis ? [dx, dy] : axis === 'x' ? [dx, 0] : [0, dy];
        if (grouped) showDrag(viewShifts(placed, mx, my));
        else setDrag({ view: placed.view, dx: mx, dy: my });
        return [mx, my] as Point;
      }, ([dx, dy]) => {
        setDrag(null);
        const changes = viewMove(placed, dx, dy);
        drop(grouped ? viewShifts(placed, dx, dy) : [], () => changes && editSheet(changes));
      }, () => { setDrag(null); showDrag([]); }, () => selectGeometry(geometry, additive));
      return;
    }
    pan(event);
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons & 1 && !useDrawingTool.getState().line) return;  // Panning or dragging.
    const hit = hitAt(event);
    if (useDrawingTool.getState().tool) toolPointer(hit);
    else setHoverView(hit.view?.view ?? null);
  };

  const doubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (useDrawingTool.getState().tool) return;
    const p = sheetPoint(event.clientX, event.clientY);
    // A press captures the pointer (to drag), which retargets the double click at the canvas: look under it instead.
    const item = itemAt(annotationTarget(event.clientX, event.clientY), p);
    if (!item) { fit(); return; }
    if (item.kind === 'note' && call) {
      const row = noteRows(call)[item.number - 1];
      if (row && typeof row !== 'string') { setEditingNote({ number: item.number, text: row.text }); return; }
    }
    editItem(item);
  };

  // A right click (a long press on touch) picks what's under it, then the menu opens there with what it can do.
  const menuAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (useDrawingTool.getState().tool) { setMenu({ kind: 'tool' }); return; }
    const p = sheetPoint(event.clientX, event.clientY);
    const item = itemAt(annotationTarget(event.clientX, event.clientY), p);
    if (item && itemKey(item) !== itemKey(useDrawingTab.getState().selected)) selectItem(item);
    const geometry = item?.kind === 'view' ? geometryAt(event.target as Element, p) : null;
    if (geometry && !get().selection.some((pick) => samePick(pick, geometry))) set({ selection: [geometry] });
    setMenu(item ? { kind: 'item', item, geometry: !!geometry } : { kind: 'empty' });
  };

  /** The Menu key or Shift+F10 opens the menu for what's selected (or the sheet's), as a right click there would. */
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
    event.preventDefault();
    const host = canvas.current!;
    const rect = host.getBoundingClientRect();
    const { x, y, k } = zoom.current;
    const box = selectedBox();
    const [cx, cy] = box ? [rect.left + x + ((box[0] + box[2]) / 2) * 4 * k, rect.top + y + ((box[1] + box[3]) / 2) * 4 * k] : [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const target = (box && selected && 'number' in selected ? host.querySelector(`[data-${selected.kind}="${selected.number}"] text, [data-${selected.kind}="${selected.number}"] path`) : null) ?? host;
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.min(Math.max(cx, rect.left + 4), rect.right - 4), clientY: Math.min(Math.max(cy, rect.top + 4), rect.bottom - 4) }));
  };

  /** Where what's selected is on the sheet. */
  const selectedBox = (): [number, number, number, number] | null => {
    if (!selected) return null;
    if (selected.kind === 'view') return views.find((item) => item.view === selected.name)?.box ?? null;
    if ('number' in selected) {
      const group = svg?.querySelector(`[data-${selected.kind}="${selected.number}"]`) as SVGGraphicsElement | null;
      if (group) { const b = group.getBBox(); return [b.x, b.y, b.x + b.width, b.y + b.height]; }
    }
    const region = report?.regions?.find((item) => item.kind === selected.kind);
    return region?.box ?? null;
  };

  const px = 1 / (4 * view.k);
  const box = selectedBox();
  const overlay = svg && size ? (
    <svg className={styles.overlay} viewBox={`0 0 ${size[0] / 4} ${size[1] / 4}`} aria-hidden>
      {!tool.tool && hoverView && hoverView !== (selected?.kind === 'view' ? selected.name : null) && (() => {
        const b = views.find((item) => item.view === hoverView)?.box;
        return b ? <rect className={styles.hoverBox} x={b[0] - 2} y={b[1] - 2} width={b[2] - b[0] + 4} height={b[3] - b[1] + 4} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} /> : null;
      })()}
      {!tool.tool && box && selected && !('number' in selected && ['dimension', 'balloon', 'datum', 'frame', 'weld', 'note', 'hole-table'].includes(selected.kind) && svg.querySelector(`[data-${selected.kind}="${(selected as { number: number }).number}"]`)) && (
        <rect className={styles.selectedBox} x={box[0] - 2} y={box[1] - 2} width={box[2] - box[0] + 4} height={box[3] - box[1] + 4} strokeWidth={1.5 * px} data-selection-box={itemKey(selected)} />
      )}
      {drag && (() => {
        const b = views.find((item) => item.view === drag.view)?.box;
        return b ? <rect className={styles.selectedBox} x={b[0] + drag.dx} y={b[1] + drag.dy} width={b[2] - b[0]} height={b[3] - b[1]} strokeWidth={1.5 * px} strokeDasharray={`${4 * px} ${3 * px}`} /> : null;
      })()}
      {!tool.tool && marks.map((mark, i) => !movedViews.has(mark.view) && (
        <g key={`mark-${i}`} className={styles.geometryMark} data-picked="selected" data-view={mark.view} strokeWidth={2.5 * px}>
          {mark.clip && <clipPath id={`drawing-mark-${i}`}><circle cx={mark.clip[0]} cy={mark.clip[1]} r={mark.clip[2]} /></clipPath>}
          <g clipPath={mark.clip ? `url(#drawing-mark-${i})` : undefined}>
            {mark.path && <path d={mark.path} />}
            {mark.points.map(([x, y], j) => <circle key={j} cx={x} cy={y} r={3.5 * px} />)}
          </g>
        </g>
      ))}
      {placed && <Dimension drawing={placed.drawing} text={placed.text} placed />}
      {tool.tool && <ToolPreview px={px} views={views} />}
    </svg>
  ) : null;

  const notePoint = tool.tool === 'note' && tool.step === 'text' && Array.isArray(tool.options.at) ? tool.options.at as Point : null;
  const editedRow = editingNote && call ? noteRows(call)[editingNote.number - 1] : null;
  const editedKnee = editedRow && isLeaderNote(editedRow) ? report?.notes_placed?.find((entry) => entry.note === editingNote?.number)?.knee : undefined;
  const editedPoint = editedRow && isLeaderNote(editedRow) ? (editedKnee ? [editedKnee[0], editedKnee[1] + 1.2] as Point : null)
    : editedRow && typeof editedRow !== 'string' && editedRow.at && report?.size_mm ? [editedRow.at[0], report.size_mm[1] - editedRow.at[1]] as Point : null;
  const screen = (p: Point) => ({ left: view.x + p[0] * 4 * view.k, top: view.y + p[1] * 4 * view.k });
  const fontPx = 3.5 * 4 * view.k;

  return (
    <ContextRoot>
      <ContextTrigger asChild>
        <div ref={canvas} className={styles.canvas} id="drawing-canvas" tabIndex={0} aria-label="Drawing sheet" data-tool={tool.tool ?? undefined}
          onPointerDown={down} onPointerMove={move} onPointerLeave={() => setHoverView(null)} onDoubleClick={doubleClick} onContextMenu={menuAt} onKeyDown={keyDown}
          data-editable={(dimensionsEditable && editable) || undefined} data-balloons-editable={(balloonsEditable && editable) || undefined}
          data-welds-editable={(!!call && !!weldRows(call) && editable) || undefined}>
          <div ref={paper} className={styles.paper} data-stale={stale || redrawing || moves.length > 0 || undefined} data-moves={moves.length > 0 || undefined}
            style={size ? { width: size[0], height: size[1], transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` } : { visibility: 'hidden' }}>
            {overlay}
          </div>
          {notePoint && (
            <input className={styles.noteInput} id="drawing-note-text" aria-label="Note" autoFocus maxLength={200} placeholder="Type the note"
              style={{ ...screen(notePoint), fontSize: Math.max(11, fontPx), transform: `translateY(-${Math.max(11, fontPx)}px)` }}
              value={String(tool.options.text ?? '')}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => useDrawingTool.setState({ options: { ...useDrawingTool.getState().options, text: event.target.value } })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void finishTool(); }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); toolEscape(); }
              }} />
          )}
          {editingNote && editedPoint && (
            <input className={styles.noteInput} id="drawing-note-edit" aria-label="Note" autoFocus maxLength={200}
              style={{ ...screen(editedPoint), fontSize: Math.max(11, fontPx), transform: `translateY(-${Math.max(11, fontPx)}px)` }}
              value={editingNote.text}
              onPointerDown={(event) => event.stopPropagation()}
              onChange={(event) => setEditingNote({ ...editingNote, text: event.target.value })}
              onBlur={() => setEditingNote(null)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditingNote(null); }
                if (event.key !== 'Enter' || !call) return;
                event.preventDefault();
                const rows = noteRows(call);
                const text = editingNote.text.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
                setEditingNote(null);
                if (text) void editSheet({ notes: notesText(rows.map((row, i) => (i === editingNote.number - 1 && typeof row !== 'string' ? { ...row, text } : row))) });
              }} />
          )}
        </div>
      </ContextTrigger>
      <ContextContent><SheetMenu target={menu} locked={locked} report={report} /></ContextContent>
    </ContextRoot>
  );
}

/** A provisional feature dimension on the sheet (paper mm, the build's line and text sizes): previewed while it's
 *  placed, or just placed and waiting for the build to draw it. */
function Dimension({ drawing, text, kind, placed }: { drawing: DimensionDrawing; text: string; kind?: string; placed?: boolean }) {
  const { at, rotate, anchor } = drawing.text;
  return (
    <g className={styles.provisional} data-provisional={placed ? 'placed' : kind} strokeWidth={0.25}>
      {drawing.lines.map(([a, b], i) => <path key={i} d={`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`} />)}
      {drawing.arc && <path d={drawing.arc} />}
      {drawing.arrows.map((points, i) => <polygon key={`arrow-${i}`} points={points.map((point) => point.join(',')).join(' ')} />)}
      <text className={styles.ghostText} x={at[0]} y={at[1]} fontSize={3.5} textAnchor={anchor} transform={rotate ? `rotate(${rotate} ${at[0]} ${at[1]})` : undefined}
        data-dimension-preview>{text}</text>
    </g>
  );
}

/** What the open tool will make, drawn over the sheet as it's picked and placed. */
function ToolPreview({ px, views }: { px: number; views: ViewOnSheet[] }) {
  const tool = useDrawingTool();
  const p = tool.pointer;
  const label = (at: Point, text: string): ReactNode => (
    <text className={styles.ghostText} x={at[0] + 10 * px} y={at[1] - 8 * px} fontSize={12 * px}>{text}</text>
  );
  const box = (name: string | null, className: string) => {
    const b = views.find((item) => item.view === name)?.box;
    return b ? <rect className={className} x={b[0] - 2} y={b[1] - 2} width={b[2] - b[0] + 4} height={b[3] - b[1] + 4} strokeWidth={1.5 * px} strokeDasharray={`${4 * px} ${3 * px}`} /> : null;
  };
  const highlight = (pick: SheetPick, className: string, key?: string | number) => (pick.kind === 'vertex'
    ? <circle key={key} className={className} cx={pick.points[0][0]} cy={pick.points[0][1]} r={5 * px} strokeWidth={2 * px} />
    : <path key={key} className={className} d={pathOf(pick)} strokeWidth={3 * px} />);
  const out: ReactNode[] = [];
  const hoverProblem = pickProblem(tool, tool.hover);
  if (tool.hoverView && ['projected', 'section', 'detail', 'hole-table', 'base'].includes(tool.tool ?? '') && (tool.step === 'parent' || tool.step === 'line' || tool.step === 'centre'))
    out.push(<g key="hover-view">{box(tool.hoverView, styles.hoverBox)}</g>);
  if (tool.hover && !hoverProblem) out.push(<g key="hover">{highlight(tool.hover, styles.pickHover)}</g>);
  tool.picks.forEach((pick, i) => out.push(highlight(pick, styles.pickChosen, `pick-${i}`)));
  if (tool.origin) out.push(highlight(tool.origin, styles.pickChosen, 'origin'));
  switch (tool.tool) {
    case 'base':
      if (p) out.push(<g key="base">{label(p, `${viewTitle(String(tool.options.orientation))} view`)}<circle className={styles.ghost} cx={p[0]} cy={p[1]} r={3 * px} strokeWidth={px} /></g>);
      break;
    case 'projected':
      if (tool.view) out.push(<g key="parent">{box(tool.view, styles.selectedBox)}</g>);
      if (tool.step === 'place' && p) {
        const parent = views.find((item) => item.view === tool.view);
        const candidate = tool.options.candidate ? String(tool.options.candidate) : null;
        if (parent && candidate) {
          const [cx, cy] = [(parent.box[0] + parent.box[2]) / 2, (parent.box[1] + parent.box[3]) / 2];
          const end: Point = tool.options.axis === 'y' ? [cx, p[1]] : [p[0], cy];
          out.push(<g key="projected"><path className={styles.ghost} d={`M${cx} ${cy} L${end[0]} ${end[1]}`} strokeWidth={px} strokeDasharray={`${6 * px} ${4 * px}`} />
            {label(end, views.some((item) => item.view === candidate) ? `${viewTitle(candidate)} is on the sheet` : `${viewTitle(candidate)} view`)}</g>);
        } else out.push(<g key="projected">{label(p, 'Move to a side of the view')}</g>);
      }
      break;
    case 'section':
      if (tool.line) {
        const [a, b] = tool.step === 'place' ? tool.line : [tool.line[0], p ?? tool.line[1]];
        out.push(<path key="cut" className={styles.cutLine} d={`M${a[0]} ${a[1]} L${b[0]} ${b[1]}`} strokeWidth={2 * px} strokeDasharray={`${12 * px} ${4 * px} ${2 * px} ${4 * px}`} />);
      }
      if (tool.step === 'place' && p) out.push(<g key="section-label">{label(p, `Section ${tool.options.name}-${tool.options.name}`)}</g>);
      break;
    case 'detail':
      if (tool.centre) out.push(<circle key="detail" className={styles.cutLine} cx={tool.centre[0]} cy={tool.centre[1]} r={Math.max(tool.radius ?? 0, 0.1)} strokeWidth={2 * px} fill="none" />);
      if (tool.step === 'place' && p) out.push(<g key="detail-label">{label(p, `Detail ${tool.options.name}`)}</g>);
      break;
    case 'dimension':
      if (p && tool.picks.length) {
        // The dimension as the picks measure it, toward the pointer; guide lines where the sheet can't tell its value.
        const preview = dimensionPreview(tool, p);
        if (preview?.drawing && preview.text) out.push(<Dimension key="dim-preview" drawing={preview.drawing} text={preview.text} kind={preview.kind} />);
        else {
          const anchors = tool.picks.map(anchorOf);
          out.push(<g key="dim-preview">{anchors.map((a, i) => <path key={i} className={styles.ghost} d={`M${a[0]} ${a[1]} L${p[0]} ${p[1]}`} strokeWidth={px} strokeDasharray={`${4 * px} ${3 * px}`} />)}
            {label(p, tool.picks.length === 1 && tool.picks[0].kind === 'circle' ? (tool.options.kind === 'radius' ? 'Radius' : 'Diameter') : tool.picks.length === 2 ? 'Click to place' : 'Pick another, or click to place')}</g>);
        }
      }
      break;
    case 'datum': case 'frame': case 'balloon': {
      const pick = tool.picks[0];
      if (pick && p) {
        const a = anchorOf(pick);
        const text = tool.tool === 'datum' ? `Datum ${tool.options.label}` : tool.tool === 'frame' ? String(tool.options.characteristic) : pick.ref ?? '';
        out.push(<g key="leader"><path className={styles.ghost} d={`M${a[0]} ${a[1]} L${p[0]} ${p[1]}`} strokeWidth={px} />{label(p, text)}</g>);
      } else if (tool.step === 'place' && tool.dimension && p) out.push(<g key="on-dim">{label(p, `On dimension ${tool.dimension}`)}</g>);
      if (tool.hoverDimension && tool.step === 'pick' && p) out.push(<g key="dim-hover">{label(p, `Dimension ${tool.hoverDimension}`)}</g>);
      break;
    }
    case 'weld':
      // An arrow from each pick to where the reference line starts, and the line itself, toward the pointer.
      if (tool.picks.length && p && tool.weld === null) {
        const end: Point = [p[0] + (p[0] >= weldTip(tool.picks[0])[0] ? 12 : -12), p[1]];
        out.push(<g key="weld">{tool.picks.map((pick, i) => { const a = weldTip(pick); return <path key={i} className={styles.ghost} d={`M${a[0]} ${a[1]} L${p[0]} ${p[1]}`} strokeWidth={px} />; })}
          <path className={styles.ghost} d={`M${p[0]} ${p[1]} L${end[0]} ${end[1]}`} strokeWidth={px} />{label(p, weldTypeName(String(tool.options.type ?? 'fillet')))}</g>);
      }
      break;
    case 'hole-table':
      if (tool.view) out.push(<g key="table-view">{box(tool.view, styles.selectedBox)}</g>);
      break;
    case 'note': {
      // A leader note: its leader from the pick to where the text goes (the pointer, or the point clicked).
      const at = tool.step === 'text' && Array.isArray(tool.options.at) ? tool.options.at as Point : p;
      if (tool.picks.length && at) {
        const a = weldTip(tool.picks[0]);
        const end: Point = [at[0] + (at[0] >= a[0] ? 3 : -3), at[1]];
        out.push(<g key="note-leader"><path className={styles.ghost} d={`M${a[0]} ${a[1]} L${at[0]} ${at[1]} L${end[0]} ${end[1]}`} strokeWidth={px} /></g>);
      }
      if (tool.step === 'place' && p) out.push(<g key="note">{label(p, tool.picks.length ? 'Click where the note goes' : 'Click an edge, face or corner for a leader, or where the note goes')}</g>);
      break;
    }
    default:
  }
  if (hoverProblem && p) out.push(<g key="problem">{label(p, hoverProblem.split(':')[0])}</g>);
  return <>{out}</>;
}

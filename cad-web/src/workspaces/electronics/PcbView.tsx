/**
 * The board, in tscircuit's own PCB viewer: copper by layer, pads, silkscreen, routed traces and the rats nest,
 * design-rule errors and measuring.
 *
 * Over it, on the right: the board's routing (Routing.tsx: Not routed · Route board, the routing build's progress, its
 * result) and Move parts.
 *
 * Move parts (M, on by default) keeps the viewer in its edit mode: dragging a part's body moves it, the move comes out
 * as an edit event (pcbEdits.ts: snapped to the board grid, nothing until the pointer has really moved), and the
 * code-rewrite engine writes it into the TSX as `pcbX` / `pcbY`. Dragging the board pans, as it always does.
 *
 * Clicking picks what's under the pointer (picks.ts): a pad (its pin), a trace, a via, a hole, a part's body, the board.
 * The viewer keeps its camera to itself, so the transform it draws with is read from its renderer's live props
 * (pcbCamera.ts), and the pick is hit-tested in board millimetres against the Circuit JSON. Selected parts and picks
 * are outlined in an overlay drawn with the same transform, following parts as they're dragged.
 *
 * The viewer keeps its own camera across rebuilds of the same circuit. Its "View in schematic" (right-click a part)
 * selects the part everywhere and brings the schematic alongside.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { PCBViewer } from '@tscircuit/pcb-viewer';
import { applyToPoint, inverse } from 'transformation-matrix';
import { Move } from 'lucide-react';
import { Spinner, Tip } from '@/ui';
import { clearPcbEdits, isMoving, placePcbMoves, reportPcbEdits, setMoveParts, usePcbEditState, type PcbEditEvent } from './pcbEdits';
import { focusSelection, pickItem, selectParts, setView, useCircuit } from './state';
import { circuitIndex, netPick, pcbHighlight, pcbHit } from './picks';
import { carriesPart, dropPart } from './drop';
import { setViewerEditMode, setViewerRatsNest, shownLayer, viewerTransform } from './pcbCamera';
import { useApp } from '@/state/store';
import { routingOf } from './routing';
import { UNROUTED, type CircuitElement } from './circuit';
import { RoutingBadge, RoutingPanel } from '@/workspaces/electronics/RoutingView';
import styles from './Electronics.module.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attributes: Record<string, string | number>) => {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
};

type Point = { x: number; y: number };
/** How far each part has been dragged and not rebuilt yet (mm), by pcb_component_id. */
function dragged(events: PcbEditEvent[]): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const event of events as { pcb_component_id?: string; original_center?: Point; new_center?: Point }[]) {
    if (!event.pcb_component_id || !event.original_center || !event.new_center) continue;
    const before = out.get(event.pcb_component_id) ?? { x: 0, y: 0 };
    out.set(event.pcb_component_id, { x: before.x + event.new_center.x - event.original_center.x, y: before.y + event.new_center.y - event.original_center.y });
  }
  return out;
}

/** Whether a board point is on a part's body as the viewer's edit mode grabs it: its bounds, with `padding` mm around. */
function onPart(json: CircuitElement[], events: PcbEditEvent[], point: Point, padding: number): boolean {
  const shift = dragged(events);
  return circuitIndex(json).pcbComponents.some((component) => {
    const center = component.center as Point | undefined;
    if (!center) return false;
    const by = shift.get(String(component.pcb_component_id)) ?? { x: 0, y: 0 };
    return Math.abs(point.x - center.x - by.x) < Number(component.width) / 2 + padding && Math.abs(point.y - center.y - by.y) < Number(component.height) / 2 + padding;
  });
}

const OFF_BOARD = '[data-toolbar-overlay], button, input, select, [role="menu"]';

function PcbView({ compact = false }: { compact?: boolean }) {
  const json = useCircuit((state) => state.json);
  const model = useCircuit((state) => state.model);
  const view = useCircuit((state) => state.view);
  const selection = useCircuit((state) => state.selection);
  const picks = useCircuit((state) => state.picks);
  const net = useCircuit((state) => state.net);
  const events = usePcbEditState((state) => state.events);
  const moveParts = usePcbEditState((state) => state.moveParts);
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const [height, setHeight] = useState(0);
  // The viewer frames the board for the width it mounts at and never refits: a settled width change (the dock or the
  // split resized) mounts it again, framed for the new size.
  const [width, setWidth] = useState(0);
  const [dropping, setDropping] = useState(false);
  // Clicks on the board tscircuit's ruler still takes (start, end, put away): parts don't move under it meanwhile.
  const [ruler, setRuler] = useState(0);
  const rulerRef = useRef(0);
  rulerRef.current = ruler;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let first = true;  // The first size applies at once; later ones once the resize has settled.
    const observer = new ResizeObserver(([entry]) => {
      setHeight(Math.floor(entry.contentRect.height));
      const next = Math.floor(entry.contentRect.width);
      clearTimeout(settle);
      settle = setTimeout(() => setWidth((current) => (Math.abs(current - next) > 8 ? next : current)), first ? 0 : 200);
      first = false;
    });
    observer.observe(el);
    return () => { observer.disconnect(); clearTimeout(settle); };
  }, []);

  // A rebuilt circuit already has the moves in its code (or they were undone): the viewer starts clean.
  useEffect(() => { clearPcbEdits(); }, [json]);

  /* ───── Move parts: the viewer's edit mode, as it mounts and whenever it's switched ───── */
  const dragging = moveParts && !ruler;
  // The ratsnest shows while connections lack copper: builds don't route (routing.ts), so it's how an unrouted board shows
  // what's still to connect. Routed, it goes (the viewer's Rats Nest toggle brings it back).
  const status = useApp((state) => routingOf(state.displayed)?.status);
  const ratsNest = status === 'not_routed' || status === 'incomplete' || status === 'failed';
  // Unrouted, tscircuit marks every connection without copper as an error, pointing at it across the view: the ratsnest
  // already says so (and readiness, once), so the viewer isn't given them.
  const shown = useMemo(() => (json && ratsNest ? json.filter((element) => !UNROUTED.has(element.type)) : json), [json, ratsNest]);
  const initialState = useMemo(() => ({ in_edit_mode: dragging, in_move_footprint_mode: dragging, is_showing_rats_nest: ratsNest }), [dragging, ratsNest]);
  useEffect(() => {
    const el = host.current;
    if (!el || !json) return;
    let tries = 0, frame = 0;
    const apply = () => { if (!setViewerEditMode(el, dragging) && ++tries < 120) frame = requestAnimationFrame(apply); };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [dragging, json, width, height]);
  useEffect(() => {
    const el = host.current;
    if (!el || !json) return;
    let tries = 0, frame = 0;
    const apply = () => { if (!setViewerRatsNest(el, ratsNest) && ++tries < 120) frame = requestAnimationFrame(apply); };
    apply();
    return () => cancelAnimationFrame(frame);
  }, [ratsNest, !!json, width]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let pressing = false;
    const arm = () => setRuler(3);
    // The ruler let go of before it measured (another tool, Esc): parts move again. Its own first click disarms it too.
    const disarm = () => { if (!pressing) setRuler(0); };
    const down = (event: PointerEvent) => { pressing = !!host.current?.contains(event.target as Node) && !(event.target as Element).closest(OFF_BOARD); };
    const up = () => { if (pressing && rulerRef.current) setRuler((clicks) => Math.max(0, clicks - 1)); pressing = false; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setRuler(0); };
    window.addEventListener('arm-dimension-tool', arm);
    window.addEventListener('disarm-dimension-tool', disarm);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('arm-dimension-tool', arm);
      window.removeEventListener('disarm-dimension-tool', disarm);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('keydown', key);
    };
  }, []);

  const onEdits = (next: PcbEditEvent[]) => {
    const found = host.current ? viewerTransform(host.current) : null;
    // The same few pixels that tell a click from a drag: a click on a part picks it and doesn't nudge it.
    const placed = placePcbMoves(next, found ? 4 / Math.abs(found.transform.a) : 0);
    reportPcbEdits(placed);
    // A part being moved is the part you're working on.
    const last = placed.at(-1) as { pcb_component_id?: string } | undefined;
    const name = isMoving(placed.at(-1)) && last?.pcb_component_id ? model?.partOf.get(last.pcb_component_id) : undefined;
    if (name && useCircuit.getState().selection.join() !== name) selectParts([name]);
  };

  /*
   * ───── picking: a click (not a drag) on the board picks what's under it ─────
   * Natively, between React's capture and bubble phases: the viewer's measuring clicks, stopped in its capture phase, never
   * get here, and a pick stops the click before its bubble phase, where tscircuit opens its menu on a left click (the
   * same menu, X-Ray and "on Schematic", is still on the right button). A part's body under the pointer shows a grab
   * cursor while Move parts is on.
   */
  const press = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const boardPoint = (event: MouseEvent) => {
      const found = viewerTransform(el);
      if (!found) return null;
      const rect = found.root.getBoundingClientRect();
      return { found, point: applyToPoint(inverse(found.transform), { x: event.clientX - rect.left, y: event.clientY - rect.top }) };
    };
    const down = (event: PointerEvent) => {
      const target = event.target as Element;
      press.current = event.button === 0 && !target.closest(OFF_BOARD) ? { x: event.clientX, y: event.clientY } : null;
      if (press.current && el.dataset.grab) el.dataset.grab = 'moving';
    };
    const hover = (event: PointerEvent) => {
      if (event.buttons) return;
      const { json } = useCircuit.getState();
      const at = json && usePcbEditState.getState().moveParts && !rulerRef.current && !(event.target as Element).closest(OFF_BOARD) ? boardPoint(event) : null;
      // As the viewer grabs: the part's bounds and 10 px around them.
      if (at && json && onPart(json, usePcbEditState.getState().events, at.point, 10 / Math.abs(at.found.transform.a))) el.dataset.grab = 'part';
      else delete el.dataset.grab;
    };
    const release = () => { if (el.dataset.grab === 'moving') el.dataset.grab = 'part'; };
    const click = (event: MouseEvent) => {
      const start = press.current;
      press.current = null;
      const { model, json } = useCircuit.getState();
      if (!start || !model || !json || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const at = boardPoint(event);
      if (!at) return;
      event.stopPropagation();
      (at.found.root.querySelector<HTMLElement>('[tabindex]') ?? at.found.root).focus({ preventScroll: true });  // The viewer's keys, as its own click would.
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const hit = pcbHit(model, json, at.point, shownLayer(el), 4 / Math.abs(at.found.transform.a));
      if (!hit) pickItem(null, additive);
      else if ('part' in hit) selectParts([hit.part], additive);
      else pickItem(hit.pick, additive);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', hover);
    window.addEventListener('pointerup', release);
    el.addEventListener('click', click);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', hover);
      window.removeEventListener('pointerup', release);
      el.removeEventListener('click', click);
    };
  }, []);

  /* ───── highlights: selected parts and picks, drawn with the viewer's transform as it pans, zooms and drags ───── */
  useEffect(() => {
    const el = host.current, svg = overlay.current;
    if (!el || !svg || !model || !json) return;
    const index = circuitIndex(json);
    const picked = [...picks, ...(net && !picks.some((pick) => pick.net === net) ? (() => { const item = model.nets.find((n) => n.key === net); return item ? [netPick(item)] : []; })() : [])];
    const shapes = picked.map((pick) => pcbHighlight(model, json, pick));
    const parts = index.pcbComponents.filter((component) => selection.includes(model.partOf.get(String(component.pcb_component_id)) ?? ''));
    if (!shapes.length && !parts.length) { svg.replaceChildren(); return; }
    const shift = dragged(events);
    const by = (id: unknown) => shift.get(String(id)) ?? { x: 0, y: 0 };
    let last = '';
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const found = viewerTransform(el);
      if (!found) return;
      const root = found.root.getBoundingClientRect(), box = el.getBoundingClientRect();
      const t = found.transform;
      const key = `${t.a},${t.b},${t.c},${t.d},${t.e},${t.f},${root.left - box.left},${root.top - box.top},${box.width},${box.height}`;
      if (key === last) return;
      last = key;
      const dx = root.left - box.left, dy = root.top - box.top;
      const at = (x: number, y: number) => { const p = applyToPoint(t, { x, y }); return { x: p.x + dx, y: p.y + dy }; };
      const scale = Math.abs(t.a);
      svg.replaceChildren();
      for (const component of parts) {
        const moved = by(component.pcb_component_id);
        const center = { x: (component.center as Point).x + moved.x, y: (component.center as Point).y + moved.y };
        const w = Number(component.width) || 0, h = Number(component.height) || 0, pad = 0.35;
        const p = at(center.x - w / 2 - pad, center.y + h / 2 + pad), q = at(center.x + w / 2 + pad, center.y - h / 2 - pad);
        svg.appendChild(svgEl('rect', { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y), rx: 4, class: 'steve-pcb-part' }));
      }
      for (const shape of shapes) {
        for (const segment of shape.segments) {
          const a = at(segment.a.x, segment.a.y), b = at(segment.b.x, segment.b.y);
          svg.appendChild(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, 'stroke-width': Math.max(segment.width * scale + 4, 5), class: 'steve-pcb-copper' }));
        }
        for (const circle of shape.circles) {
          const c = at(circle.x, circle.y);
          svg.appendChild(svgEl('circle', { cx: c.x, cy: c.y, r: Math.max(circle.r * scale + 2, 5), class: 'steve-pcb-pick' }));
        }
        for (const pad of shape.pads) {
          const moved = by(pad.pcb_component_id);
          const c = at(Number(pad.x) + moved.x, Number(pad.y) + moved.y);
          const round = pad.shape === 'circle' || (pad.type === 'pcb_plated_hole' && !String(pad.shape).includes('rect'));
          const w = (Number(pad.width ?? pad.rect_pad_width ?? pad.outer_diameter) || (Number(pad.radius) || 0.5) * 2) * scale;
          const h = (Number(pad.height ?? pad.rect_pad_height ?? pad.outer_diameter) || (Number(pad.radius) || 0.5) * 2) * scale;
          svg.appendChild(round
            ? svgEl('circle', { cx: c.x, cy: c.y, r: Math.max(w, h) / 2 + 3, class: 'steve-pcb-pick' })
            : svgEl('rect', { x: c.x - w / 2 - 3, y: c.y - h / 2 - 3, width: w + 6, height: h + 6, rx: 3, class: 'steve-pcb-pick',
              ...(Number(pad.ccw_rotation ?? pad.rotation) ? { transform: `rotate(${-Number(pad.ccw_rotation ?? pad.rotation)} ${c.x} ${c.y})` } : {}) }));
        }
        if (shape.outline) {
          svg.appendChild(svgEl('polygon', { points: shape.outline.map((point) => { const p = at(point.x, point.y); return `${p.x},${p.y}`; }).join(' '), class: 'steve-pcb-board' }));
        }
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [model, json, picks, net, selection, width, events]);

  return (
    <div className={styles.pcb} data-compact={compact || undefined} id="pcb-view" ref={host} data-ready={json && height ? true : undefined} data-drop={dropping || undefined}
      data-move-parts={dragging || undefined}
      onDragOver={(event) => { if (!carriesPart(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); }}
      onDragLeave={(event) => { if (!host.current?.contains(event.relatedTarget as Node)) setDropping(false); }}
      // The viewer's pan and zoom are its own, so a dropped part goes where tscircuit's layout puts it; drag it after.
      onDrop={(event) => { if (!carriesPart(event)) return; event.preventDefault(); setDropping(false); void dropPart(event, null); }}>
      {dropping && <div className={styles.dropHint} role="status">Drop to add it · drag it into place</div>}
      {!json && <div className={styles.viewLoading}><Spinner /></div>}
      {json && height > 0 && (
        <PCBViewer
          key={width}
          circuitJson={shown as never}
          height={height}
          // The canvas renderer works everywhere; WebGPU stays opt-in from the viewer's own menu.
          renderer="canvas"
          allowEditing
          initialState={initialState}
          editEvents={events}
          onEditEventsChanged={onEdits}
          focusOnHover={false}
          onViewSchematicComponent={(event) => {
            const name = model?.partOf.get(event.source_component_id) ?? model?.partOf.get(event.pcb_component_id);
            if (!name) return;
            selectParts([name]);
            if (view === 'pcb') setView('split');
            requestAnimationFrame(focusSelection);
          }}
        />
      )}
      <svg ref={overlay} className={styles.pcbOverlay} aria-hidden="true" id="pcb-picks" />
      {json && height > 0 && (
        <div className={styles.pcbTools}>
          <RoutingBadge />
          <Tip label="Move parts" shortcut="M"
            description="Drag a part to move it: it lands on a 0.1 mm grid and its place is written into the code as pcbX / pcbY. A click still picks, and dragging the board pans.">
            <button type="button" id="pcb-move" className={styles.pcbTool} aria-pressed={moveParts} onClick={() => setMoveParts(!moveParts)}>
              <Move size={13} strokeWidth={2} />Move parts
            </button>
          </Tip>
        </div>
      )}
      {json && height > 0 && <RoutingPanel />}
    </div>
  );
}

export default memo(PcbView);

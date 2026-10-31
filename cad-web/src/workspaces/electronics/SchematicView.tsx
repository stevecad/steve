/**
 * The schematic, drawn by tscircuit's `circuit-to-svg` from the build's Circuit JSON and made interactive here:
 *
 * - **Navigate:** pan (drag empty space, middle-drag or Space+drag), zoom around the pointer (wheel), fit (F or
 *   double-click empty space).
 * - **Select:** hover and select parts (Shift/Ctrl+click adds), and see the net picked in the tree. A click on a pin's end,
 *   a wire or a net label picks that instead (picks.ts): what STEVE and the inspector are told about.
 * - **Move:** drag a part to move it. A ghost follows, snapped to the schematic grid, and the drop goes out through
 *   schematicEdits.ts for the code-rewrite engine to write as `schX` / `schY`.
 * - **Wire tool (W):** pins become targets. The first click starts a wire with a rubber band to the pointer; the
 *   second finishes it (schematicEdits.ts); Esc drops the wire, then the tool.
 * - **Place tool:** the picked part rides on the pointer as its schematic symbol (schematicGhost.ts), snapped to the
 *   grid; each click reports where it goes (schematicEdits.ts) and the tool stays on for the next; Esc or a
 *   right-click stops. The view holds still while parts arrive.
 *
 * Every element of the SVG carries its Circuit JSON id (`data-schematic-component-id`, `data-schematic-port-id`
 * holding the source port, …); the circuit model turns those into part names, the selection every view shares.
 * Highlights and tool feedback are overlays in the drawing's own coordinates, so they stay crisp at any zoom.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/state/store';
import { Spinner } from '@/ui';
import { sanitizeSvg } from '@/lib/sanitize';
import { hoverPart, pickItem, selectParts, useCircuit } from './state';
import { circuitIndex, labelPick, pinPick, schematicTracePick, type CircuitPick } from './picks';
import { selectorName, type CircuitElement, type CircuitModel } from './circuit';
import {
  hasDragListeners, reportSchematicDrag, reportSchematicPin, reportSchematicPlace, SCHEMATIC_GRID, stopPlacing, useSchematicTool, type Point, type SchematicPin,
} from './schematicEdits';
import { buildGhost, loadSymbols } from './schematicGhost';
import { carriesPart, dropPart } from './drop';
import styles from './Electronics.module.css';

type Box = { x: number; y: number; w: number; h: number };
type Theme = 'dark' | 'light';
/** Real (schematic units) → SVG units: tscircuit's `data-real-to-screen-transform` matrix(a, b, c, d, e, f). */
type Matrix = [number, number, number, number, number, number];

/** Schematic colours per theme (KiCad's colour roles, as circuit-to-svg names them). */
const PALETTES: Record<Theme, Record<string, string>> = {
  dark: {
    background: 'transparent', component_body: '#1d2630', component_outline: '#93a9c2', wire: '#5cc8ff', junction: '#5cc8ff', bus: '#5cc8ff',
    bus_junction: '#5cc8ff', pin: '#d08a6f', pin_name: '#c8d2dc', pin_number: '#7e8a96', reference: '#e8edf2', value: '#9fb0c0',
    net_name: '#e8bd84', label_local: '#e8bd84', label_global: '#e8bd84', label_hier: '#e8bd84', label_background: 'rgba(18, 22, 27, 0.88)',
    no_connect: '#ff7a7a', note: '#9fb0c0', fields: '#9fb0c0', sheet: '#3b4552', sheet_background: 'transparent', sheet_fields: '#7e8a96',
    sheet_filename: '#7e8a96', sheet_label: '#9fb0c0', sheet_name: '#9fb0c0', worksheet: '#323b46', grid: '#1f262e', grid_axes: '#2b333d',
    erc_error: '#ff6b6b', erc_warning: '#e8bd84', hidden: '#56616d', brightened: '#ffffff', shadow: 'rgba(92, 200, 255, 0.25)',
  },
  light: {
    background: 'transparent', component_body: '#fffbe6', component_outline: '#7a1f12', wire: '#0a7fc4', junction: '#0a7fc4', bus: '#0a7fc4',
    bus_junction: '#0a7fc4', pin: '#9a3b22', pin_name: '#1f2a33', pin_number: '#5c6873', reference: '#1a2129', value: '#3d4a56',
    net_name: '#9a5a0b', label_local: '#9a5a0b', label_global: '#9a5a0b', label_hier: '#9a5a0b', label_background: 'rgba(255, 255, 255, 0.9)',
    no_connect: '#c62828', note: '#3d4a56', fields: '#3d4a56', sheet: '#b9a89a', sheet_background: 'transparent', sheet_fields: '#6b5a4c',
    sheet_filename: '#6b5a4c', sheet_label: '#3d4a56', sheet_name: '#3d4a56', worksheet: '#c9b8aa', grid: '#ece6df', grid_axes: '#ddd3c9',
    erc_error: '#c62828', erc_warning: '#b87318', hidden: '#a3adb6', brightened: '#000000', shadow: 'rgba(10, 127, 196, 0.2)',
  },
};

let renderer: Promise<typeof import('circuit-to-svg')> | null = null;

async function renderSchematic(json: CircuitElement[], theme: Theme): Promise<string> {
  renderer ??= import('circuit-to-svg');
  const { convertCircuitJsonToSchematicSvg } = await renderer;
  // As tscircuit draws it for print (no `drawPorts`: that adds debugging labels, like anode/cathode on resistors). Pins
  // are still there as invisible `sch-port-hover` marks, which the Wire tool targets.
  const svg = convertCircuitJsonToSchematicSvg(json as never, { colorOverrides: { schematic: PALETTES[theme] as never }, width: 1600, height: 1000 });
  // Two texts keep circuit-to-svg's print colours whatever the palette: a boxed part's name (teal) and a trace's net
  // label (dark red), near invisible on the dark sheet. They read like the other names.
  return svg.replace(/(<text\b[^>]*?\bfill=")(?:#006464|rgb\(132, 0, 0\))(")/g, `$1${PALETTES[theme].net_name}$2`);
}

const PART_SELECTOR = '[data-schematic-component-id], [data-schematic-port-id], [data-schematic-trace-id], [data-schematic-net-label-id]';
const CONTENT_SELECTOR = '.sch-component, .sch-trace, .sch-net-label, [data-circuit-json-type="schematic_net_label"], [data-circuit-json-type="schematic_text"]';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The part a pointer target belongs to: a symbol, one of its pins, or a wire or label touching it. */
function partAt(target: EventTarget | null, model: CircuitModel): { part: string | null; port: string | null } {
  const pinHit = (target as Element | null)?.closest?.('[data-pin]');
  if (pinHit) { const port = pinHit.getAttribute('data-pin')!; return { part: model.portOf.get(port)?.part ?? null, port }; }
  const element = (target as Element | null)?.closest?.(PART_SELECTOR);
  if (!element) return { part: null, port: null };
  const port = element.getAttribute('data-schematic-port-id');
  if (port) return { part: model.portOf.get(port)?.part ?? null, port };
  const component = element.closest('[data-schematic-component-id]')?.getAttribute('data-schematic-component-id');
  return { part: component ? model.partOf.get(component) ?? null : null, port: null };
}

function union(boxes: DOMRect[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((b) => b.x)), y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width)), bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, w: Math.max(right - x, 1), h: Math.max(bottom - y, 1) };
}

/** The drawing's content (not the sheet frame) in SVG units. */
function contentBox(svg: SVGSVGElement, selector = CONTENT_SELECTOR): Box | null {
  const boxes: DOMRect[] = [];
  for (const element of svg.querySelectorAll<SVGGraphicsElement>(selector)) {
    if (element.closest('.steve-overlay, .steve-tools')) continue;
    try { const box = element.getBBox(); if (box.width || box.height) boxes.push(box); } catch { /* Not rendered. */ }
  }
  return union(boxes);
}

/** Screen pixels the pane's own overlays cover (the view switcher and Fit on top, the board's facts below). */
export interface Insets { top: number; bottom: number }
const NO_INSETS: Insets = { top: 0, bottom: 0 };

/**
 * A box of the host's aspect ratio around `box`, with a margin, framing it in the part of the pane the overlays leave
 * free (`insets`, in screen pixels).
 */
function fitted(box: Box, host: DOMRect, margin = 0.14, minimum: { w: number; h: number } = { w: 120, h: 80 }, insets: Insets = NO_INSETS): Box {
  // Overlays never take more than half the pane (a very short pane frames the drawing behind them instead).
  const shrink = Math.min(1, (host.height / 2) / Math.max(insets.top + insets.bottom, 1));
  const top = insets.top * shrink, free = Math.max(host.height - (insets.top + insets.bottom) * shrink, 1);
  const aspect = host.width / free;
  let w = box.w * (1 + margin * 2), h = box.h * (1 + margin * 2);
  // Never closer than a comfortable reading size for a tiny circuit.
  w = Math.max(w, minimum.w); h = Math.max(h, minimum.h);
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  // The free band's box, grown to the whole pane (SVG units per pixel: h / free).
  const scale = h / free;
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2 - top * scale, w, h: host.height * scale };
}

/** How far the canvas's overlays reach into this pane: the view switcher on top, the board's facts at the bottom. */
function overlayInsets(pane: HTMLElement): Insets {
  const rect = pane.getBoundingClientRect();
  const covered = (selector: string, edge: 'top' | 'bottom') => {
    const element = document.querySelector(selector);
    if (!element) return 0;
    const box = element.getBoundingClientRect();
    if (box.right < rect.left || box.left > rect.right || box.bottom < rect.top || box.top > rect.bottom) return 0;
    return edge === 'top' ? Math.max(0, box.bottom - rect.top + 6) : Math.max(0, rect.bottom - box.top + 6);
  };
  return { top: covered('#circuit-views', 'top'), bottom: covered('#circuit-facts', 'bottom') };
}

/** A box in one drawing's SVG units, in another's: through schematic units (circuit-to-svg's transforms are axis-aligned). */
function remap(box: Box, from: Matrix, to: Matrix): Box {
  const real = (x: number, y: number) => ({ x: (x - from[4]) / from[0], y: (y - from[5]) / from[3] });
  const svg = (point: { x: number; y: number }) => ({ x: to[0] * point.x + to[4], y: to[3] * point.y + to[5] });
  const p = svg(real(box.x, box.y)), q = svg(real(box.x + box.w, box.y + box.h));
  return { x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
}

/** Symbols are mostly lines: a point inside a part's outline counts as on it (the smallest outline wins). */
function partInside(svg: SVGSVGElement, point: DOMPoint, model: CircuitModel): string | null {
  let best: { name: string; area: number } | null = null;
  for (const group of svg.querySelectorAll<SVGGraphicsElement>('[data-schematic-component-id]')) {
    if (group.closest('.steve-overlay, .steve-tools')) continue;
    let box: DOMRect;
    try { box = group.getBBox(); } catch { continue; }
    const pad = Math.max(2, Math.min(box.width, box.height) * 0.1);
    if (point.x < box.x - pad || point.x > box.x + box.width + pad || point.y < box.y - pad || point.y > box.y + box.height + pad) continue;
    const name = model.partOf.get(group.getAttribute('data-schematic-component-id')!);
    const area = box.width * box.height;
    if (name && (!best || area < best.area)) best = { name, area };
  }
  return best?.name ?? null;
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
};

/** A pin's centre in SVG units (the middle of its drawn mark). */
function pinCenter(element: Element): { x: number; y: number } | null {
  try { const box = (element as SVGGraphicsElement).getBBox(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; } catch { return null; }
}

const segmentDistance = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

function SchematicView({ compact = false }: { compact?: boolean }) {
  const json = useCircuit((state) => state.json);
  const model = useCircuit((state) => state.model);
  const selection = useCircuit((state) => state.selection);
  const hover = useCircuit((state) => state.hover);
  const net = useCircuit((state) => state.net);
  const picks = useCircuit((state) => state.picks);
  const focus = useCircuit((state) => state.focus);
  const theme = useApp((state) => state.theme);
  const tool = useSchematicTool((state) => state.tool);
  const wireFrom = useSchematicTool((state) => state.from);
  const placing = useSchematicTool((state) => state.placing);
  // An empty board shows its card here, not a drawing: no spinner behind the card while the blank sheet renders.
  const empty = useCircuit((state) => !!state.model && state.model.parts.length === 0);
  const [symbolLibrary, setSymbolLibrary] = useState<Awaited<ReturnType<typeof loadSymbols>> | null>(null);
  useEffect(() => { if (tool === 'place' && !symbolLibrary) void loadSymbols().then(setSymbolLibrary).catch(() => {}); }, [tool, symbolLibrary]);
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const matrix = useRef<Matrix>([1, 0, 0, -1, 0, 0]);
  const view = useRef<Box | null>(null);
  const [markup, setMarkup] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [grabbing, setGrabbing] = useState<'pan' | 'move' | null>(null);
  const [hoverPin, setHoverPin] = useState<string | null>(null);
  // Bumped while a part is dragged, so its selection ring follows the ghost.
  const [tick, setTick] = useState(0);
  // A part from the Place gallery is being dragged over the schematic.
  const [dropping, setDropping] = useState(false);

  // Circuit JSON facts the canvas needs: each part's schematic centre, each pin's schematic port and names.
  const facts = useMemo(() => {
    const centers = new Map<string, Point>();
    const schPorts = new Map<string, { id: string; center: Point }>();
    const hints = new Map<string, string[]>();
    for (const element of json ?? []) {
      if (element.type === 'schematic_component') centers.set(String(element.schematic_component_id), element.center as Point);
      else if (element.type === 'schematic_port') schPorts.set(String(element.source_port_id), { id: String(element.schematic_port_id), center: element.center as Point });
      else if (element.type === 'source_port') hints.set(String(element.source_port_id), ((element.port_hints as unknown[]) ?? []).filter((hint): hint is string => typeof hint === 'string'));
    }
    return { centers, schPorts, hints };
  }, [json]);

  const pinOf = useCallback((sourcePortId: string): SchematicPin | null => {
    const port = model?.portOf.get(sourcePortId);
    if (!port) return null;
    const sch = facts.schPorts.get(sourcePortId);
    const aliases = [...new Set([port.name, port.label, ...(facts.hints.get(sourcePortId) ?? [])])].filter(Boolean);
    return { schematic_port_id: sch?.id ?? null, source_port_id: sourcePortId, part: port.part, port: port.name, aliases, label: port.label, center: sch?.center ?? { x: 0, y: 0 } };
  }, [model, facts]);

  useEffect(() => {
    if (!json) { setMarkup(null); return; }
    let live = true;
    renderSchematic(json, theme).then((svg) => { if (live) { setMarkup(svg); setFailed(null); } })
      .catch((error: Error) => { if (live) setFailed(error.message); });
    return () => { live = false; };
  }, [json, theme]);

  const apply = useCallback((box: Box) => {
    // A pane with no size yet (mounting, a panel animating) gives no box worth keeping.
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || box.h <= 0) return;
    view.current = box;
    svgRef.current?.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  }, []);

  /** A fit asked for before the pane had a size or the drawing was laid out: the next resize (or frame) does it. */
  const pendingFit = useRef(false);
  /** The whole drawing is framed and the person hasn't panned or zoomed since: resizes and rebuilds keep it framed. */
  const framed = useRef(true);
  const fit = useCallback((selector?: string): boolean => {
    const svg = svgRef.current, el = host.current;
    if (!svg || !el) return false;
    const rect = el.getBoundingClientRect();
    let box = rect.width >= 8 && rect.height >= 8 ? contentBox(svg, selector) ?? contentBox(svg) : null;
    if (!box && rect.width >= 8 && rect.height >= 8 && model && model.parts.length === 0) {
      // An empty board: nothing to frame yet, so frame the schematic's origin (where placed parts start).
      const [a, , , d, e, f] = matrix.current;
      box = { x: e - 2.25 * Math.abs(a), y: f - 1.5 * Math.abs(d), w: 4.5 * Math.abs(a), h: 3 * Math.abs(d) };
    }
    if (!box) { pendingFit.current = true; return false; }
    pendingFit.current = false;
    framed.current = !selector;
    // At least 4.5 × 3 schematic units in view (circuit-to-svg scales each drawing to fill its canvas, so a lone part
    // would otherwise fill the pane); the same framing an empty board gets. Framed below the view switcher and above
    // the board's facts, so nothing of the drawing hides under them.
    const [a, , , d] = matrix.current;
    apply(fitted(box, rect, selector ? 0.6 : 0.06, { w: 4.5 * Math.abs(a), h: 3 * Math.abs(d) }, overlayInsets(el)));
    return true;
  }, [apply, model]);
  /** Fits as soon as the drawing and the pane allow (a few frames at most after mounting). */
  const fitSoon = useCallback(() => {
    let tries = 0;
    const attempt = () => { if (!fit() && ++tries < 30) requestAnimationFrame(attempt); };
    requestAnimationFrame(attempt);
  }, [fit]);

  // A new drawing: insert it, keep the view when it's the same circuit rebuilt, else fit.
  const drawnParts = useRef<string>('');
  /** Set by a placement: the next drawing keeps the view (in schematic units), whatever else changed. */
  const holdView = useRef(false);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !markup) return;
    const previous = view.current;
    const previousMatrix = [...matrix.current] as Matrix;
    // The same circuit rebuilt (most of its parts still there: a part added, moved or deleted) keeps the view; a
    // different circuit is fitted.
    const parts = (model?.parts ?? []).map((part) => part.name);
    const before = drawnParts.current ? drawnParts.current.split(',') : [];
    const kept = before.filter((name) => parts.includes(name)).length;
    const hadDrawing = !!svgRef.current && before.length > 0 && kept >= Math.ceil(before.length / 2);
    drawnParts.current = parts.join(',');
    el.querySelector('.steve-schematic')?.remove();
    const holder = document.createElement('div');
    holder.className = 'steve-schematic';
    // Sanitized (lib/sanitize.ts): the drawing carries part names and labels from the circuit's code.
    const svg = sanitizeSvg(markup);
    if (!svg) return;
    holder.append(svg);
    const width = Number(svg.getAttribute('width')) || 1600, height = Number(svg.getAttribute('height')) || 1000;
    const transform = /matrix\(([^)]+)\)/.exec(svg.getAttribute('data-real-to-screen-transform') ?? '')?.[1].split(',').map(Number);
    if (transform?.length === 6 && transform.every(Number.isFinite)) matrix.current = transform as Matrix;
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.background = 'transparent';
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    if (!svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.appendChild(svgEl('g', { class: 'steve-overlay' }));
    svg.appendChild(svgEl('g', { class: 'steve-tools' }));
    svg.appendChild(svgEl('g', { class: 'steve-place' }));
    el.prepend(holder);
    svgRef.current = svg;
    // The view, carried over in schematic units: circuit-to-svg scales each drawing to its content, so the same SVG box
    // would show a different part of the schematic.
    const held = holdView.current && !!previous;
    holdView.current = false;
    if (previous && (held || (hadDrawing && !pendingFit.current && !framed.current))) {
      framed.current = false;
      apply(remap(previous, previousMatrix, matrix.current));
    } else { view.current = null; fitSoon(); }
  }, [markup]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the drawing's aspect when the pane resizes (split view, panels opening).
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const box = view.current;
      if (pendingFit.current || !box || framed.current) fit(); else apply(fitted(box, rect, 0));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [apply, fit]);

  // Highlights: selected parts (solid), the hovered one (dashed), the picked net's wires and pins.
  useEffect(() => {
    const svg = svgRef.current;
    const overlay = svg?.querySelector('.steve-overlay');
    if (!svg || !overlay || !model) return;
    overlay.replaceChildren();
    svg.querySelectorAll('.steve-net').forEach((element) => element.classList.remove('steve-net'));
    const parts = new Map(model.parts.map((part) => [part.name, part]));
    const ring = (name: string, kind: 'selected' | 'hover') => {
      const id = parts.get(name)?.schematicId;
      const group = id ? svg.querySelector<SVGGraphicsElement>(`[data-schematic-component-id="${CSS.escape(id)}"]`) : null;
      if (!group) return;
      let box: DOMRect;
      try { box = group.getBBox(); } catch { return; }
      const pad = Math.max(3, Math.min(box.width, box.height) * 0.12);
      const shift = group.getAttribute('data-steve-shift');
      overlay.appendChild(svgEl('rect', {
        x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2, rx: pad * 0.8,
        class: `steve-ring steve-ring-${kind}`, 'vector-effect': 'non-scaling-stroke', ...(shift ? { transform: `translate(${shift})` } : {}),
      }));
    };
    for (const name of selection) ring(name, 'selected');
    if (hover && !selection.includes(hover)) ring(hover, 'hover');
    const picked = net ? model.nets.find((item) => item.key === net) : null;
    if (picked) {
      svg.querySelectorAll(`[data-subcircuit-connectivity-map-key="${CSS.escape(picked.key)}"]`).forEach((element) => element.classList.add('steve-net'));
      for (const port of picked.ports) svg.querySelector(`[data-schematic-port-id="${CSS.escape(port.id)}"]`)?.classList.add('steve-net');
    }
    // Picks: a pin's end, a wire, a net label.
    svg.querySelectorAll('.steve-picked').forEach((element) => element.classList.remove('steve-picked'));
    const [a, b, c, d, e, f] = matrix.current;
    const toSvgPoint = (point: Point) => ({ x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f });
    const radius = Math.max(4, (view.current?.w ?? 600) / 130);
    for (const pick of picks) {
      if ((pick.kind === 'pin' || pick.kind === 'pad') && pick.ids.source_port_id) {
        const center = facts.schPorts.get(pick.ids.source_port_id)?.center;
        if (center) {
          const at = toSvgPoint(center);
          overlay.appendChild(svgEl('circle', { cx: at.x, cy: at.y, r: radius, class: 'steve-pick-pin', 'vector-effect': 'non-scaling-stroke', 'data-picked': pick.key }));
        }
      } else if (pick.kind === 'trace' || pick.ids.schematic_trace_id) {  // A wire (a net label's stub picks its net).
        const wires = (json ?? []).filter((element) => element.type === 'schematic_trace'
          && ((pick.ids.source_trace_id && element.source_trace_id === pick.ids.source_trace_id) || (pick.ids.schematic_trace_id && element.schematic_trace_id === pick.ids.schematic_trace_id)));
        for (const wire of wires) svg.querySelectorAll(`[data-schematic-trace-id="${CSS.escape(String(wire.schematic_trace_id))}"]`).forEach((element) => element.classList.add('steve-picked'));
      } else if (pick.kind === 'label' && pick.ids.schematic_net_label_id) {
        svg.querySelectorAll(`[data-schematic-net-label-id="${CSS.escape(pick.ids.schematic_net_label_id)}"]`).forEach((element) => element.classList.add('steve-picked'));
      }
    }
  }, [selection, hover, net, picks, model, markup, tick, facts, json]);

  /* ───── the Wire tool: pin targets, the pin under the pointer, a rubber band from the first pin ───── */
  const band = useRef<SVGLineElement | null>(null);
  // Where the band last ended: the targets are redrawn as the pointer moves between pins, and the band with them.
  const bandEnd = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const svg = svgRef.current;
    const tools = svg?.querySelector('.steve-tools');
    if (!svg || !tools) return;
    tools.replaceChildren();
    band.current = null;
    if (tool !== 'wire') return;
    const box = view.current;
    const radius = Math.max(4, (box?.w ?? 600) / 160);
    // One target per pin, at its end: the pin's hover mark, else whatever else carries its id.
    const marks = [...svg.querySelectorAll('.sch-port-hover[data-schematic-port-id]'), ...svg.querySelectorAll('[data-schematic-port-id]')];
    const placed = new Set<string>();
    for (const element of marks) {
      if (element.closest('.steve-tools')) continue;
      const port = element.getAttribute('data-schematic-port-id')!;
      if (placed.has(port)) continue;
      const center = pinCenter(element);
      if (!center) continue;
      placed.add(port);
      tools.appendChild(svgEl('circle', {
        cx: center.x, cy: center.y, r: radius, 'data-pin': port, 'vector-effect': 'non-scaling-stroke',
        class: `steve-pin${port === hoverPin ? ' steve-pin-hover' : ''}${port === wireFrom?.source_port_id ? ' steve-pin-from' : ''}`,
      }));
    }
    if (wireFrom) {
      const start = svg.querySelector(`[data-pin="${CSS.escape(wireFrom.source_port_id)}"]`);
      if (start) {
        const end = bandEnd.current ?? { x: Number(start.getAttribute('cx')), y: Number(start.getAttribute('cy')) };
        const line = svgEl('line', { x1: start.getAttribute('cx')!, y1: start.getAttribute('cy')!, x2: end.x, y2: end.y,
          class: 'steve-band', 'vector-effect': 'non-scaling-stroke' });
        tools.insertBefore(line, tools.firstChild);
        band.current = line;
      }
    }
  }, [tool, wireFrom, hoverPin, markup]);

  /* ───── the Place tool: the part on the pointer, where a click puts it ───── */
  const ghost = useRef<SVGGElement | null>(null);
  const placeAt = useRef<{ schX: number; schY: number } | null>(null);
  const moveGhost = (at: { schX: number; schY: number } | null) => {
    const g = ghost.current;
    if (!g) return;
    if (!at) { g.setAttribute('visibility', 'hidden'); return; }
    const [a, b, c, d, e, f] = matrix.current;
    g.setAttribute('transform', `translate(${a * at.schX + c * at.schY + e} ${b * at.schX + d * at.schY + f})`);
    g.setAttribute('visibility', 'visible');
  };
  useEffect(() => {
    const layer = svgRef.current?.querySelector('.steve-place');
    if (!layer) return;
    layer.replaceChildren();
    ghost.current = null;
    if (tool !== 'place' || !placing) { placeAt.current = null; return; }
    const g = buildGhost(placing, matrix.current, symbolLibrary);
    layer.appendChild(g);
    ghost.current = g;
    moveGhost(placeAt.current);
  }, [tool, placing, symbolLibrary, markup]); // eslint-disable-line react-hooks/exhaustive-deps

  // Double-click in the tree (focus): frame the selected parts.
  useEffect(() => {
    if (!focus || !model) return;
    const ids = model.parts.filter((part) => selection.includes(part.name) && part.schematicId).map((part) => `[data-schematic-component-id="${CSS.escape(part.schematicId!)}"]`);
    if (ids.length) fit(ids.join(', '));
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ───── pointer: pan, zoom, hover, select, move, wire ───── */
  interface Drag { x: number; y: number; box: Box; mode: 'pan' | 'move' | null; part: string | null; pick: CircuitPick | null; additive: boolean; panOnly: boolean; group: SVGGElement | null; base: string; offset: Point }
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => { if (event.code === 'Space') space.current = true; };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') space.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  };

  const onWheel = useCallback((event: WheelEvent) => {
    const box = view.current;
    const point = toSvg(event.clientX, event.clientY);
    if (!box || !point) return;
    event.preventDefault();
    framed.current = false;
    const factor = Math.exp(event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0016));
    const w = Math.min(Math.max(box.w * factor, 20), 40000);
    const scale = w / box.w;
    apply({ x: point.x - (point.x - box.x) * scale, y: point.y - (point.y - box.y) * scale, w, h: box.h * scale });
  }, [apply]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  /** A move in SVG units as a move in schematic units that lands the part's centre on the grid (`from`: where it was). */
  const snapped = (dx: number, dy: number, from: Point = { x: 0, y: 0 }): { real: Point; svg: Point } => {
    const [a, , , d] = matrix.current;
    const snap = (value: number) => Math.round(value / SCHEMATIC_GRID) * SCHEMATIC_GRID;
    const real = { x: snap(from.x + dx / a) - from.x, y: snap(from.y + dy / d) - from.y };
    return { real, svg: { x: real.x * a, y: real.y * d } };
  };

  /**
   * What a click (not a drag) picks, besides a part: a pin's end (within a few pixels), a net label, a wire. Pins and
   * wires are tested against the Circuit JSON geometry, so thin strokes and invisible pin marks are easy to hit.
   */
  const pickAt = (event: React.PointerEvent): CircuitPick | null => {
    if (!model || !json) return null;
    const point = toSvg(event.clientX, event.clientY);
    const rect = host.current?.getBoundingClientRect();
    if (!point || !rect || !view.current) return null;
    const [a, , , d, e, f] = matrix.current;
    const real = { x: (point.x - e) / a, y: (point.y - f) / d };
    const perPixel = view.current.w / rect.width / Math.abs(a);  // Schematic units per screen pixel.
    const index = circuitIndex(json);
    let pin: { id: string; distance: number } | null = null;
    for (const [id, port] of facts.schPorts) {
      const distance = Math.hypot(real.x - port.center.x, real.y - port.center.y);
      if (distance <= 8 * perPixel && (!pin || distance < pin.distance)) pin = { id, distance };
    }
    if (pin) return pinPick(model, index, pin.id);
    const label = (event.target as Element | null)?.closest?.('[data-schematic-net-label-id]')?.getAttribute('data-schematic-net-label-id');
    if (label) return labelPick(index, label);
    let wire: { id: string; distance: number } | null = null;
    for (const [id, trace] of index.schTraces) {
      for (const edge of (trace.edges as { from: Point; to: Point }[] | undefined) ?? []) {
        const distance = segmentDistance(real, edge.from, edge.to);
        if (distance <= 5 * perPixel && (!wire || distance < wire.distance)) wire = { id, distance };
      }
    }
    return wire ? schematicTracePick(model, index, wire.id) : null;
  };

  const onPointerDown = (event: React.PointerEvent) => {
    // The canvas's own buttons (Fit) keep their clicks: capturing the pointer would take them.
    if ((event.target as Element).closest('button')) return;
    if (tool === 'place' && !space.current && view.current) {
      // A click puts the part there (the tool stays on for the next); a right-click stops. The middle button still pans.
      if (event.button === 2) { event.preventDefault(); stopPlacing(); return; }
      if (event.button === 0) {
        const at = dropAt(event.clientX, event.clientY);
        if (at) { holdView.current = true; reportSchematicPlace(at); }
        return;
      }
    }
    if (!model || !view.current || (event.button !== 0 && event.button !== 1)) return;
    const hit = partAt(event.target, model);
    const point = toSvg(event.clientX, event.clientY);
    const part = hit.part ?? (point && svgRef.current ? partInside(svgRef.current, point, model) : null);
    const port = hit.port;
    if (tool === 'wire' && event.button === 0 && port && !space.current) {
      const pin = pinOf(port);
      if (pin) reportSchematicPin(pin);
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const panOnly = event.button === 1 || space.current || tool === 'wire';
    const id = part ? model.parts.find((item) => item.name === part)?.schematicId : null;
    const group = !panOnly && id ? svgRef.current?.querySelector<SVGGElement>(`[data-schematic-component-id="${CSS.escape(id)}"]`) ?? null : null;
    drag.current = { x: event.clientX, y: event.clientY, box: view.current, mode: null, part: panOnly ? null : part, pick: panOnly || event.button !== 0 ? null : pickAt(event), additive: event.shiftKey || event.ctrlKey || event.metaKey,
      panOnly, group, base: group?.getAttribute('data-steve-base') ?? group?.getAttribute('transform') ?? '', offset: { x: 0, y: 0 } };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (!state) {
      if (tool === 'place') {
        hoverPart(null);
        placeAt.current = dropAt(event.clientX, event.clientY);
        moveGhost(placeAt.current);
        return;
      }
      if (!model) return;
      const hit = partAt(event.target, model);
      const point = hit.part ? null : toSvg(event.clientX, event.clientY);
      const part = hit.part ?? (point && svgRef.current ? partInside(svgRef.current, point, model) : null);
      const port = hit.port;
      hoverPart(part);
      if (tool === 'wire') {
        setHoverPin(port);
        // The rubber band ends at the pin under the pointer, else at the pointer.
        const line = band.current;
        const target = port ? svgRef.current?.querySelector(`[data-pin="${CSS.escape(port)}"]`) : null;
        const point = target ? { x: Number(target.getAttribute('cx')), y: Number(target.getAttribute('cy')) } : toSvg(event.clientX, event.clientY);
        if (point) bandEnd.current = { x: point.x, y: point.y };
        if (line && point) { line.setAttribute('x2', String(point.x)); line.setAttribute('y2', String(point.y)); }
      }
      return;
    }
    const dx = event.clientX - state.x, dy = event.clientY - state.y;
    if (!state.mode) {
      if (Math.hypot(dx, dy) < 4) return;
      state.mode = state.group && state.part ? 'move' : 'pan';
      setGrabbing(state.mode);
      if (state.mode === 'move') {
        selectParts([state.part!]);
        state.group!.setAttribute('data-steve-base', state.base);
        state.group!.classList.add('steve-ghost');
      }
    }
    const rect = host.current!.getBoundingClientRect();
    const unit = Math.max(state.box.w / rect.width, state.box.h / rect.height);
    if (state.mode === 'move') {
      const { svg } = snapped(dx * unit, dy * unit, facts.centers.get(state.group!.getAttribute('data-schematic-component-id')!));
      state.offset = svg;
      state.group!.setAttribute('transform', `translate(${svg.x} ${svg.y})${state.base ? ` ${state.base}` : ''}`);
      state.group!.setAttribute('data-steve-shift', `${svg.x} ${svg.y}`);
      setTick((value) => value + 1);  // The selection ring follows the ghost.
      return;
    }
    framed.current = false;
    apply({ ...state.box, x: state.box.x - dx * unit, y: state.box.y - dy * unit });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const state = drag.current;
    drag.current = null;
    setGrabbing(null);
    if (!state || event.button !== 0 && event.button !== 1) return;
    if (state.mode === 'move' && state.group && state.part) {
      const id = state.group.getAttribute('data-schematic-component-id')!;
      const original = facts.centers.get(id);
      const { real } = snapped(state.offset.x, state.offset.y, original);
      if (original && (real.x || real.y) && hasDragListeners()) {
        // The ghost stays where it was dropped until the rebuilt drawing replaces it.
        reportSchematicDrag({ schematic_component_id: id, part: state.part, original_center: original,
          new_center: { x: Number((original.x + real.x).toFixed(4)), y: Number((original.y + real.y).toFixed(4)) } });
      } else {
        // Nothing writes moves yet (or it didn't move): the part goes back.
        state.group.setAttribute('transform', state.base);
        state.group.removeAttribute('data-steve-shift');
        state.group.classList.remove('steve-ghost');
      }
      setTick((value) => value + 1);
      return;
    }
    if (state.mode === 'pan' || event.button !== 0) return;
    // A pin's end, a net label or a wire was clicked: that's what's picked, not the part around it.
    if (state.pick) pickItem(state.pick, state.additive);
    else if (state.part) selectParts([state.part], state.additive);
    else if (!state.additive) selectParts([]);
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    if (!model || tool === 'wire' || tool === 'place') return;
    const point = toSvg(event.clientX, event.clientY);
    const part = partAt(event.target, model).part ?? (point && svgRef.current ? partInside(svgRef.current, point, model) : null);
    if (part) { selectParts([part]); fit(`[data-schematic-component-id="${CSS.escape(model.parts.find((p) => p.name === part)?.schematicId ?? '')}"]`); }
    else fit();
  };

  // F frames everything (or the selection), as in the 3D view. It listens first (capture) and keeps the key, so the
  // app's F (Flip side, with a part selected) doesn't also run while the pointer is over the schematic.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'f' || event.ctrlKey || event.metaKey || event.altKey || !el.matches(':hover')) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, .cm-editor, [contenteditable]') || useApp.getState().dialog) return;
      event.preventDefault();
      event.stopPropagation();
      const chosen = useCircuit.getState().selection;
      const ids = model?.parts.filter((part) => chosen.includes(part.name) && part.schematicId).map((part) => `[data-schematic-component-id="${CSS.escape(part.schematicId!)}"]`) ?? [];
      fit(ids.length ? ids.join(', ') : undefined);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [fit, model]);

  /** A drop point in schematic units, snapped to the grid. */
  const dropAt = (clientX: number, clientY: number) => {
    const point = toSvg(clientX, clientY);
    if (!point) return null;
    const [a, , , d, e, f] = matrix.current;
    const snap = (value: number) => Number((Math.round(value / SCHEMATIC_GRID) * SCHEMATIC_GRID).toFixed(2));
    return { schX: snap((point.x - e) / a), schY: snap((point.y - f) / d) };
  };

  return (
    <div className={styles.schematic} data-compact={compact || undefined} data-grabbing={grabbing ?? undefined} data-tool={tool} id="schematic-view" ref={host}
      data-drop={dropping || undefined}
      onDragOver={(event) => { if (!carriesPart(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); }}
      onDragLeave={(event) => { if (!host.current?.contains(event.relatedTarget as Node)) setDropping(false); }}
      onDrop={(event) => { if (!carriesPart(event)) return; event.preventDefault(); setDropping(false); void dropPart(event, dropAt(event.clientX, event.clientY)); }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerLeave={() => { if (!drag.current) { hoverPart(null); setHoverPin(null); moveGhost(null); } }}
      onContextMenu={(event) => { if (tool === 'place') { event.preventDefault(); stopPlacing(); } }}
      onDoubleClick={onDoubleClick} data-ready={markup ? true : undefined} data-hover={hover ?? undefined} data-wiring={wireFrom ? true : undefined}>
      {!markup && !failed && json && !empty && <div className={styles.viewLoading}><Spinner /></div>}
      {failed && <div className={styles.viewError} role="alert">The schematic couldn’t be drawn: {failed}</div>}
      {dropping && <div className={styles.dropHint} role="status">Drop to place it here</div>}
      {tool === 'place' && placing && (
        <div className={styles.toolHint} id="place-hint" role="status">
          Click to place <b>{placing.name ?? placing.label}</b> · Esc to finish
        </div>
      )}
      {tool === 'wire' && (
        <div className={styles.toolHint} id="wire-hint" role="status">
          {wireFrom ? <>From <b>{wireFrom.part}.{selectorName({ name: wireFrom.port, label: wireFrom.label })}</b> · click the pin to connect · Esc drops it</>
            : <>Wire · click a pin to start · Esc leaves the tool</>}
        </div>
      )}
      <button type="button" className={styles.fitButton} onClick={() => fit()} title="Fit (F, or double-click empty space)" aria-label="Fit the schematic">Fit</button>
    </div>
  );
}

export default memo(SchematicView);

/**
 * What a click picked in a circuit besides whole parts: a pin, a pad, a trace, a net, a via, a hole, the board or a net
 * label. Each pick keeps the Circuit JSON ids it came from and says what it is the way people, and STEVE, read it:
 *
 *   pin U1.VCC (pin 8) · net V3_3 · also R1.pin1, C1.pin1
 *   trace R1.pin2 → C1.pin1 · net VOUT · 0.4 mm · top
 *   via at (3.2, -1.0) · net GND · 0.3/0.6 mm
 *   board 30 × 20 mm · 1.6 mm · 2 layers
 *
 * Every view makes them: the schematic (pins, wires, net labels), the PCB (pads, traces, vias, holes, the board, by
 * hit-testing the Circuit JSON in board millimetres), the 3D view (the board) and the tree (nets).
 */
import type { CircuitRouting } from '@/lib/api';
import type { CircuitElement, CircuitModel, CircuitNet, CircuitPort } from './circuit';

export type CircuitPickKind = 'pin' | 'pad' | 'trace' | 'net' | 'via' | 'hole' | 'board' | 'label';

export interface CircuitPick {
  kind: CircuitPickKind;
  /** Identity: the kind and the Circuit JSON id it stands for (toggling, equality, highlights). */
  key: string;
  /** The Circuit JSON ids it came from (source_port_id, pcb_trace_id, source_trace_id, pcb_via_id, …). */
  ids: Record<string, string>;
  /** How it reads: "pin U1.VCC (pin 8)", "trace R1.pin2 → C1.pin1", "via at (3.2, -1)". */
  label: string;
  /** The part it belongs to (pins and pads). */
  part?: string;
  /** Its net's connectivity key (pins, pads, traces, vias, labels and nets). */
  net?: string | null;
  /** Where it is on the board (mm). */
  at?: { x: number; y: number };
  layer?: string;
}

/** What STEVE is told about a pick: `selection_detail` entries (app/assistant.py SelectedEntity). */
export interface PickContext {
  kind: 'component' | 'port' | 'net' | 'trace' | 'via' | 'hole' | 'board';
  description: string;
  component?: string;
  geometry?: Record<string, unknown>;
}

type El = CircuitElement;
type Point = { x: number; y: number };

/** The Circuit JSON elements picks are made of, indexed once per circuit. */
export interface CircuitIndex {
  sourcePorts: Map<string, El>;
  sourceTraces: Map<string, El>;
  sourceNets: Map<string, El>;
  pcbPorts: Map<string, El>;
  pcbTraces: Map<string, El>;
  pcbComponents: El[];
  smtpads: El[];
  platedHoles: El[];
  holes: El[];
  vias: El[];
  board: El | null;
  schPorts: Map<string, El>;
  schTraces: Map<string, El>;
  schLabels: Map<string, El>;
}

const indexes = new WeakMap<CircuitElement[], CircuitIndex>();

export function circuitIndex(json: CircuitElement[]): CircuitIndex {
  let index = indexes.get(json);
  if (index) return index;
  const map = (type: string, by = `${type}_id`) => new Map(json.filter((e) => e.type === type).map((e) => [String(e[by]), e]));
  const list = (type: string) => json.filter((e) => e.type === type);
  index = {
    sourcePorts: map('source_port'), sourceTraces: map('source_trace'), sourceNets: map('source_net'),
    pcbPorts: map('pcb_port'), pcbTraces: map('pcb_trace'), pcbComponents: list('pcb_component'),
    smtpads: list('pcb_smtpad'), platedHoles: list('pcb_plated_hole'), holes: list('pcb_hole'), vias: list('pcb_via'),
    board: json.find((e) => e.type === 'pcb_board') ?? null,
    schPorts: map('schematic_port', 'source_port_id'), schTraces: map('schematic_trace'), schLabels: map('schematic_net_label'),
  };
  indexes.set(json, index);
  return index;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** Millimetres as people read them: 0.4, 1.27, 30. */
export const mm = (value: number) => String(Number(value.toFixed(3)));
const pointText = (p: Point) => `(${mm(p.x)}, ${mm(p.y)})`;
const keyOf = (element: El | undefined) => (typeof element?.subcircuit_connectivity_map_key === 'string' ? element.subcircuit_connectivity_map_key as string : null);

export const netByKey = (model: CircuitModel, key: string | null | undefined): CircuitNet | null => (key ? model.nets.find((net) => net.key === key) ?? null : null);
const portText = (port: CircuitPort) => `${port.part}.${port.label}`;

/** A pin by its source port: "pin U1.VCC (pin 8)". `kind` 'pad' when it was picked as copper on the board. */
export function pinPick(model: CircuitModel, index: CircuitIndex, sourcePortId: string, kind: 'pin' | 'pad' = 'pin'): CircuitPick | null {
  const port = model.portOf.get(sourcePortId);
  const source = index.sourcePorts.get(sourcePortId);
  if (!port || !source) return null;
  const number = num(source.pin_number);
  const label = `${kind === 'pad' ? 'pad' : 'pin'} ${portText(port)}${number !== null && port.label !== `pin${number}` ? ` (pin ${number})` : ''}`;
  const pcb = [...index.pcbPorts.values()].find((item) => item.source_port_id === sourcePortId);
  const at = pcb && num(pcb.x) !== null ? { x: Number(pcb.x), y: Number(pcb.y) } : undefined;
  return {
    kind, key: `pin:${sourcePortId}`, ids: { source_port_id: sourcePortId, ...(pcb ? { pcb_port_id: String(pcb.pcb_port_id) } : {}) },
    label, part: port.part, net: keyOf(source), at,
  };
}

/** The ends a source trace joins: ports and named nets. */
function traceEnds(model: CircuitModel, index: CircuitIndex, trace: El): string[] {
  const ports = ((trace.connected_source_port_ids as unknown[]) ?? []).map((id) => model.portOf.get(String(id))).filter((p): p is CircuitPort => !!p).map(portText);
  const nets = ((trace.connected_source_net_ids as unknown[]) ?? []).map((id) => index.sourceNets.get(String(id))?.name).filter((n): n is string => typeof n === 'string').map((n) => `net ${n}`);
  return [...ports, ...nets];
}

/** A connection by its source trace (the `<trace>` in the code): "trace R1.pin2 → C1.pin1". */
export function tracePick(model: CircuitModel, index: CircuitIndex, sourceTraceId: string, pcbTraceId?: string): CircuitPick | null {
  const trace = index.sourceTraces.get(sourceTraceId);
  if (!trace) return null;
  const ends = traceEnds(model, index, trace);
  return {
    kind: 'trace', key: `trace:${sourceTraceId}`, ids: { source_trace_id: sourceTraceId, ...(pcbTraceId ? { pcb_trace_id: pcbTraceId } : {}) },
    label: `trace ${ends.length ? ends.join(' → ') : String(trace.display_name ?? sourceTraceId)}`, net: keyOf(trace),
  };
}

/** Copper on the board: its trace when it has one, else the ports it joins. */
export function pcbTracePick(model: CircuitModel, index: CircuitIndex, pcbTraceId: string): CircuitPick | null {
  const copper = index.pcbTraces.get(pcbTraceId);
  if (!copper) return null;
  const source = typeof copper.source_trace_id === 'string' ? tracePick(model, index, copper.source_trace_id, pcbTraceId) : null;
  if (source) return source;
  const ports = ((copper.connectsTo as unknown[]) ?? []).map((id) => index.pcbPorts.get(String(id))?.source_port_id).map((id) => (id ? model.portOf.get(String(id)) : undefined))
    .filter((p): p is CircuitPort => !!p).map(portText);
  const first = ((copper.connectsTo as unknown[]) ?? []).map((id) => index.pcbPorts.get(String(id))?.source_port_id).find(Boolean);
  return { kind: 'trace', key: `trace:${pcbTraceId}`, ids: { pcb_trace_id: pcbTraceId }, label: `trace ${ports.join(' → ') || pcbTraceId}`,
    net: first ? keyOf(index.sourcePorts.get(String(first))) : null };
}

/** A schematic wire: its trace when it's a `<trace>` of the code, else (a net label's stub) the net it's on. */
export function schematicTracePick(model: CircuitModel, index: CircuitIndex, schematicTraceId: string): CircuitPick | null {
  const wire = index.schTraces.get(schematicTraceId);
  if (!wire) return null;
  const real = typeof wire.source_trace_id === 'string' ? tracePick(model, index, wire.source_trace_id) : null;
  if (real) return { ...real, ids: { ...real.ids, schematic_trace_id: schematicTraceId } };
  const key = keyOf(wire);
  const net = netByKey(model, key);
  return net ? { ...netPick(net), ids: { net: net.key, schematic_trace_id: schematicTraceId } } : null;
}

export const netPick = (net: CircuitNet): CircuitPick => ({ kind: 'net', key: `net:${net.key}`, ids: { net: net.key }, label: `net ${net.name}`, net: net.key });

/** A net label in the schematic: "net label VOUT". */
export function labelPick(index: CircuitIndex, labelId: string): CircuitPick | null {
  const label = index.schLabels.get(labelId);
  if (!label) return null;
  const source = typeof label.source_net_id === 'string' ? index.sourceNets.get(label.source_net_id) : undefined;
  const key = keyOf(label) ?? keyOf(source);
  return { kind: 'label', key: `label:${labelId}`, ids: { schematic_net_label_id: labelId, ...(source ? { source_net_id: String(source.source_net_id) } : {}) },
    label: `net label ${String(label.text ?? source?.name ?? '')}`, net: key };
}

export function viaPick(index: CircuitIndex, via: El): CircuitPick {
  const at = { x: Number(via.x), y: Number(via.y) };
  const trace = typeof via.pcb_trace_id === 'string' ? index.pcbTraces.get(via.pcb_trace_id) : undefined;
  const source = typeof trace?.source_trace_id === 'string' ? index.sourceTraces.get(trace.source_trace_id) : undefined;
  return { kind: 'via', key: `via:${String(via.pcb_via_id)}`, ids: { pcb_via_id: String(via.pcb_via_id), ...(trace ? { pcb_trace_id: String(trace.pcb_trace_id) } : {}) },
    label: `via at ${pointText(at)}`, net: keyOf(via) ?? keyOf(source), at };
}

export function holePick(hole: El): CircuitPick {
  const at = { x: Number(hole.x), y: Number(hole.y) };
  const diameter = num(hole.hole_diameter) ?? num(hole.hole_width);
  return { kind: 'hole', key: `hole:${String(hole.pcb_hole_id)}`, ids: { pcb_hole_id: String(hole.pcb_hole_id) },
    label: `hole${diameter ? ` Ø${mm(diameter)} mm` : ''} at ${pointText(at)}`, at };
}

export function boardPick(index: CircuitIndex): CircuitPick | null {
  const board = index.board;
  if (!board) return null;
  return { kind: 'board', key: 'board', ids: { pcb_board_id: String(board.pcb_board_id) }, label: 'board' };
}

/* ───────────── what a pick says, for STEVE and the inspector ───────────── */

/** Copper geometry of a trace on the board: widths, layers and length (mm), from its routed segments. */
export function traceCopper(index: CircuitIndex, pick: CircuitPick): { widths: number[]; layers: string[]; length: number; vias: number } | null {
  const copper = [...index.pcbTraces.values()].filter((item) => (pick.ids.pcb_trace_id && item.pcb_trace_id === pick.ids.pcb_trace_id)
    || (pick.ids.source_trace_id && item.source_trace_id === pick.ids.source_trace_id));
  if (!copper.length) return null;
  const widths = new Set<number>(), layers = new Set<string>();
  let length = 0, vias = 0;
  for (const trace of copper) {
    const route = (trace.route as Record<string, unknown>[] | undefined) ?? [];
    for (let i = 0; i < route.length; i++) {
      const point = route[i];
      if (point.route_type === 'via') { vias++; continue; }
      if (num(point.width)) widths.add(Number(point.width));
      if (typeof point.layer === 'string') layers.add(point.layer);
      const next = route[i + 1];
      if (next && next.route_type === 'wire' && num(point.x) !== null && num(next.x) !== null) length += Math.hypot(Number(next.x) - Number(point.x), Number(next.y) - Number(point.y));
    }
  }
  return { widths: [...widths].sort((a, b) => a - b), layers: [...layers], length, vias };
}

/** The other pins on a pick's net ("also R1.pin1, C1.pin1"). */
function others(model: CircuitModel, pick: CircuitPick) {
  const net = netByKey(model, pick.net);
  const own = pick.ids.source_port_id;
  return net ? net.ports.filter((port) => port.id !== own).map(portText) : [];
}

/** Whether the board is routed, for STEVE: "routed 46/46", "not routed yet: the ratsnest, 0 of 46 connections with copper". */
export function routingText(routing: CircuitRouting | null | undefined): string | null {
  if (!routing?.status || routing.status === 'none') return null;
  const total = routing.connections ?? 0, done = routing.connections_routed ?? 0;
  if (routing.status === 'routed') return `routed ${total}/${total}`;
  if (routing.status === 'incomplete') return `routing stopped at its budget: ${done} of ${total} connections routed`;
  if (routing.status === 'failed') return 'routing failed';
  return `not routed yet: the ratsnest, ${done} of ${total} connections with copper`;
}

/** The pick as STEVE gets it: what it is, its net, its size and where it sits (and, for the board, whether it's routed). */
export function pickContext(pick: CircuitPick, model: CircuitModel, json: CircuitElement[], routing?: CircuitRouting | null): PickContext {
  const index = circuitIndex(json);
  const net = netByKey(model, pick.net);
  const onNet = net ? ` · net ${net.name}` : '';
  const geometry: Record<string, unknown> = {};
  if (pick.at) geometry.pcb = { x: Number(pick.at.x.toFixed(3)), y: Number(pick.at.y.toFixed(3)) };
  if (pick.layer) geometry.layer = pick.layer;
  switch (pick.kind) {
    case 'pin': case 'pad': {
      const also = others(model, pick);
      const sch = pick.ids.source_port_id ? index.schPorts.get(pick.ids.source_port_id) : undefined;
      if (sch?.center) geometry.sch = sch.center;
      const pad = padOf(index, pick.ids.pcb_port_id);
      if (pad) Object.assign(geometry, padSize(pad));
      return { kind: 'port', component: pick.part, geometry,
        description: `${pick.label}${onNet || ' · not connected'}${also.length ? ` · also ${also.slice(0, 8).join(', ')}${also.length > 8 ? ', …' : ''}` : ''}` };
    }
    case 'trace': {
      const copper = traceCopper(index, pick);
      if (copper) Object.assign(geometry, { widths_mm: copper.widths, layers: copper.layers, length_mm: Number(copper.length.toFixed(2)), vias: copper.vias });
      const width = copper?.widths.length ? ` · ${copper.widths.map(mm).join('/')} mm` : '';
      const layers = copper?.layers.length ? ` · ${copper.layers.join(' + ')}` : copper ? '' : routing?.status === 'not_routed' ? ' · not routed yet (a ratsnest line on the board)' : ' · no copper on the board';
      return { kind: 'trace', geometry, description: `${pick.label}${onNet}${width}${layers}` };
    }
    case 'via': {
      const via = index.vias.find((item) => item.pcb_via_id === pick.ids.pcb_via_id);
      const hole = num(via?.hole_diameter), outer = num(via?.outer_diameter);
      if (hole) geometry.hole_diameter_mm = hole;
      if (outer) geometry.outer_diameter_mm = outer;
      if (via) geometry.layers = [via.from_layer ?? 'top', via.to_layer ?? 'bottom'];
      return { kind: 'via', geometry, description: `${pick.label}${onNet}${hole && outer ? ` · ${mm(hole)}/${mm(outer)} mm` : ''}` };
    }
    case 'hole':
      return { kind: 'hole', geometry, description: `${pick.label} · not plated, no net` };
    case 'board': {
      const board = index.board;
      const width = num(board?.width), height = num(board?.height), thickness = num(board?.thickness), layers = num(board?.num_layers);
      Object.assign(geometry, { width_mm: width, height_mm: height, thickness_mm: thickness, layers });
      if (routing?.status) Object.assign(geometry, { routing: routing.status, connections: routing.connections ?? null, connections_routed: routing.connections_routed ?? null });
      const routed = routingText(routing);
      return { kind: 'board', geometry,
        description: `board ${width !== null && height !== null ? `${mm(width)} × ${mm(height)} mm` : ''}${thickness !== null ? ` · ${mm(thickness)} mm thick` : ''}${layers ? ` · ${layers} layers` : ''} · ${model.parts.length} parts${routed ? ` · ${routed}` : ''}` };
    }
    case 'label': case 'net': {
      const pins = net ? net.ports.map(portText) : [];
      return { kind: 'net', geometry,
        description: `${pick.kind === 'label' ? `${pick.label} · ` : ''}net ${net?.name ?? pick.label.replace(/^net (label )?/, '')}${pins.length ? ` · ${pins.slice(0, 12).join(', ')}${pins.length > 12 ? ', …' : ''}` : ''}` };
    }
  }
}

/* ───────────── PCB hit-testing (board millimetres) ───────────── */

function padOf(index: CircuitIndex, pcbPortId: string | undefined): El | null {
  if (!pcbPortId) return null;
  return index.smtpads.find((pad) => pad.pcb_port_id === pcbPortId) ?? index.platedHoles.find((hole) => hole.pcb_port_id === pcbPortId) ?? null;
}

function padSize(pad: El): Record<string, unknown> {
  if (pad.type === 'pcb_plated_hole') return { hole_diameter_mm: num(pad.hole_diameter) ?? num(pad.hole_width), pad_mm: [num(pad.rect_pad_width) ?? num(pad.outer_diameter), num(pad.rect_pad_height) ?? num(pad.outer_diameter)], layers: pad.layers };
  return { pad_mm: [num(pad.width) ?? (num(pad.radius) ?? 0) * 2, num(pad.height) ?? (num(pad.radius) ?? 0) * 2], layer: pad.layer, shape: pad.shape };
}

const distanceToSegment = (p: Point, a: Point, b: Point) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const inPolygon = (p: Point, points: Point[]) => {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** How far `p` is outside a pad (≤ 0: on it), in mm. */
function padDistance(pad: El, p: Point): number {
  const x = Number(pad.x), y = Number(pad.y);
  if (pad.type === 'pcb_plated_hole') {
    const w = num(pad.rect_pad_width) ?? num(pad.outer_diameter) ?? num(pad.outer_width) ?? num(pad.hole_diameter) ?? 0;
    const h = num(pad.rect_pad_height) ?? num(pad.outer_diameter) ?? num(pad.outer_height) ?? w;
    if (/circle|circular$/.test(String(pad.shape)) && !String(pad.shape).includes('rect')) return Math.hypot(p.x - x, p.y - y) - w / 2;
    return Math.max(Math.abs(p.x - x) - w / 2, Math.abs(p.y - y) - h / 2);
  }
  if (pad.shape === 'circle') return Math.hypot(p.x - x, p.y - y) - (num(pad.radius) ?? 0);
  if (pad.shape === 'polygon' && Array.isArray(pad.points)) return inPolygon(p, pad.points as Point[]) ? -0.001 : Infinity;
  const w = num(pad.width) ?? 0, h = num(pad.height) ?? 0;
  const angle = ((num(pad.ccw_rotation) ?? num(pad.rotation) ?? 0) * Math.PI) / 180;
  // Into the pad's own frame (rotated rects and pills).
  const cx = Math.cos(-angle) * (p.x - x) - Math.sin(-angle) * (p.y - y), cy = Math.sin(-angle) * (p.x - x) + Math.cos(-angle) * (p.y - y);
  return Math.max(Math.abs(cx) - w / 2, Math.abs(cy) - h / 2);
}

const padOnLayer = (pad: El, layer: string | null) => !layer || pad.type === 'pcb_plated_hole' || pad.layer === layer;

/** The board's outline (mm): its outline points, else its width × height around its centre. */
export function boardOutline(index: CircuitIndex): Point[] | null {
  const board = index.board;
  if (!board) return null;
  if (Array.isArray(board.outline) && board.outline.length >= 3) return board.outline as Point[];
  const center = (board.center as Point | undefined) ?? { x: 0, y: 0 }, w = num(board.width) ?? 0, h = num(board.height) ?? 0;
  return [{ x: center.x - w / 2, y: center.y - h / 2 }, { x: center.x + w / 2, y: center.y - h / 2 }, { x: center.x + w / 2, y: center.y + h / 2 }, { x: center.x - w / 2, y: center.y + h / 2 }];
}

export type PcbHit = { part: string } | { pick: CircuitPick } | null;

/**
 * What's under a point on the board (mm): pads and through-holes (their pins), vias and holes, then trace copper, then
 * a part's body, then the board itself. `tolerance` widens thin targets (a few pixels at the current zoom); `layer`, the
 * layer on top in the viewer, wins over copper on the other side.
 */
export function pcbHit(model: CircuitModel, json: CircuitElement[], p: Point, layer: string | null, tolerance: number): PcbHit {
  const index = circuitIndex(json);
  // Pads and plated holes: the smallest under the point, on the shown layer first.
  let best: { pad: El; score: number } | null = null;
  for (const pad of [...index.smtpads, ...index.platedHoles]) {
    const distance = padDistance(pad, p);
    if (distance > tolerance) continue;
    const score = distance + (padOnLayer(pad, layer) ? 0 : 1000);
    if (!best || score < best.score) best = { pad, score };
  }
  if (best) {
    const port = typeof best.pad.pcb_port_id === 'string' ? index.pcbPorts.get(best.pad.pcb_port_id) : undefined;
    const pick = port && typeof port.source_port_id === 'string' ? pinPick(model, index, port.source_port_id, 'pad') : null;
    if (pick) return { pick: { ...pick, at: { x: Number(best.pad.x), y: Number(best.pad.y) }, layer: best.pad.type === 'pcb_plated_hole' ? 'through' : String(best.pad.layer ?? 'top') } };
    if (best.pad.type === 'pcb_plated_hole' && !port) return { pick: { ...holePick({ ...best.pad, pcb_hole_id: String(best.pad.pcb_plated_hole_id) }), kind: 'hole' } };
  }
  for (const via of index.vias) {
    if (Math.hypot(p.x - Number(via.x), p.y - Number(via.y)) <= (num(via.outer_diameter) ?? 0.6) / 2 + tolerance) return { pick: viaPick(index, via) };
  }
  for (const hole of index.holes) {
    const radius = (num(hole.hole_diameter) ?? Math.max(num(hole.hole_width) ?? 0, num(hole.hole_height) ?? 0)) / 2;
    if (Math.hypot(p.x - Number(hole.x), p.y - Number(hole.y)) <= radius + tolerance) return { pick: holePick(hole) };
  }
  // Trace copper: the nearest segment within its half-width, on the shown layer first.
  let trace: { id: string; score: number; layer: string } | null = null;
  for (const copper of index.pcbTraces.values()) {
    const route = (copper.route as Record<string, unknown>[] | undefined) ?? [];
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i], b = route[i + 1];
      if (a.route_type !== 'wire' || b.route_type !== 'wire' || num(a.x) === null || num(b.x) === null) continue;
      const half = (num(a.width) ?? 0.15) / 2;
      const distance = distanceToSegment(p, { x: Number(a.x), y: Number(a.y) }, { x: Number(b.x), y: Number(b.y) }) - half;
      if (distance > tolerance) continue;
      const score = distance + (!layer || a.layer === layer ? 0 : 1000);
      if (!trace || score < trace.score) trace = { id: String(copper.pcb_trace_id), score, layer: String(a.layer ?? 'top') };
    }
  }
  if (trace) {
    const pick = pcbTracePick(model, index, trace.id);
    if (pick) return { pick: { ...pick, ids: { ...pick.ids, pcb_trace_id: trace.id }, at: p, layer: trace.layer } };
  }
  // A part's body: the smallest whose bounds hold the point.
  let part: { name: string; area: number } | null = null;
  for (const component of index.pcbComponents) {
    const center = component.center as Point | undefined;
    const w = num(component.width) ?? 0, h = num(component.height) ?? 0;
    if (!center || Math.abs(p.x - center.x) > w / 2 + tolerance || Math.abs(p.y - center.y) > h / 2 + tolerance) continue;
    const name = model.partOf.get(String(component.pcb_component_id));
    if (name && (!part || w * h < part.area)) part = { name, area: w * h };
  }
  if (part) return { part: part.name };
  const outline = boardOutline(index);
  if (outline && inPolygon(p, outline)) { const pick = boardPick(index); return pick ? { pick: { ...pick, at: p } } : null; }
  return null;
}

/** A pick's highlight on the board, in mm: outlines to draw (pads, vias, holes), polylines with widths (traces). */
export function pcbHighlight(model: CircuitModel, json: CircuitElement[], pick: CircuitPick): { pads: El[]; circles: { x: number; y: number; r: number }[]; segments: { a: Point; b: Point; width: number }[]; outline: Point[] | null } {
  const index = circuitIndex(json);
  const out = { pads: [] as El[], circles: [] as { x: number; y: number; r: number }[], segments: [] as { a: Point; b: Point; width: number }[], outline: null as Point[] | null };
  const copperOf = (filter: (trace: El) => boolean) => {
    for (const copper of index.pcbTraces.values()) {
      if (!filter(copper)) continue;
      const route = (copper.route as Record<string, unknown>[] | undefined) ?? [];
      for (let i = 0; i + 1 < route.length; i++) {
        const a = route[i], b = route[i + 1];
        if (a.route_type === 'via' && num(a.x) !== null) out.circles.push({ x: Number(a.x), y: Number(a.y), r: (num(a.outer_diameter) ?? 0.6) / 2 });
        if (a.route_type !== 'wire' || b.route_type !== 'wire') continue;
        out.segments.push({ a: { x: Number(a.x), y: Number(a.y) }, b: { x: Number(b.x), y: Number(b.y) }, width: num(a.width) ?? 0.15 });
      }
    }
  };
  const padsOfPorts = (ports: string[]) => {
    const pcbPorts = new Set([...index.pcbPorts.values()].filter((port) => ports.includes(String(port.source_port_id))).map((port) => String(port.pcb_port_id)));
    out.pads.push(...[...index.smtpads, ...index.platedHoles].filter((pad) => pcbPorts.has(String(pad.pcb_port_id))));
  };
  switch (pick.kind) {
    case 'pin': case 'pad': if (pick.ids.source_port_id) padsOfPorts([pick.ids.source_port_id]); break;
    case 'trace': copperOf((trace) => (pick.ids.pcb_trace_id ? trace.pcb_trace_id === pick.ids.pcb_trace_id : false) || (!!pick.ids.source_trace_id && trace.source_trace_id === pick.ids.source_trace_id)); break;
    case 'via': { const via = index.vias.find((item) => item.pcb_via_id === pick.ids.pcb_via_id); if (via) out.circles.push({ x: Number(via.x), y: Number(via.y), r: (num(via.outer_diameter) ?? 0.6) / 2 }); break; }
    case 'hole': if (pick.at) { const hole = index.holes.find((item) => item.pcb_hole_id === pick.ids.pcb_hole_id) ?? index.platedHoles.find((item) => item.pcb_plated_hole_id === pick.ids.pcb_hole_id); out.circles.push({ x: pick.at.x, y: pick.at.y, r: ((num(hole?.outer_diameter) ?? num(hole?.hole_diameter) ?? 1) / 2) }); } break;
    case 'board': out.outline = boardOutline(index); break;
    case 'net': case 'label': {
      const net = netByKey(model, pick.net);
      if (net) padsOfPorts(net.ports.map((port) => port.id));
      copperOf((trace) => {
        const source = typeof trace.source_trace_id === 'string' ? index.sourceTraces.get(trace.source_trace_id) : undefined;
        return !!pick.net && keyOf(source) === pick.net;
      });
      break;
    }
  }
  return out;
}

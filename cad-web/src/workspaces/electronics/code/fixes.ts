/**
 * One-step fixes for the fabrication-readiness verdict (docs/ELECTRONICS.md "Readiness"): each is a code edit that
 * clears one rule's issue the way the rule's own `fix` sentence says, with real in-stock JLCPCB Basic parts so the
 * fix doesn't open a sourcing issue. Geometry (where to put a new part) comes from the current Circuit JSON.
 */
import { indexFor, insertElement, resolveTarget, setBoard, setProp } from './edits';
import { nextName } from './naming';
import { CircuitLookup, netSelector, parseSelector, portSelector } from './selectors';
import { EditError, type EditResult, type Element, type SourceIndex } from './types';

/**
 * Verified JLCPCB Basic, in-stock parts (jlcsearch through GET /v1/electronics/parts, 2026-10-03; 27 pF and 30 pF are
 * Extended). Each is the part a fix inserts, so the board stays sourced.
 */
export const STOCK_PARTS = {
  cap100n: { capacitance: '100nF', footprint: '0402', lcsc: 'C1525', mpn: 'CL05B104KO5NNNC' },
  cap1u: { capacitance: '1uF', footprint: '0402', lcsc: 'C52923', mpn: 'CL05A105KA5NQNC' },
  cap10u: { capacitance: '10uF', footprint: '0603', lcsc: 'C19702', mpn: 'CL10A106KP8NNNC' },
  res1k: { resistance: '1k', footprint: '0402', lcsc: 'C11702', mpn: '0402WGF1001TCE' },
  res5k1: { resistance: '5.1k', footprint: '0402', lcsc: 'C25905', mpn: '0402WGF5101TCE' },
  res10k: { resistance: '10k', footprint: '0402', lcsc: 'C25744', mpn: '0402WGF1002TCE' },
} as const;

/** C0G 0402 load capacitors by value (pF). */
const LOAD_CAPS: { pf: number; lcsc: string; mpn: string; basic: boolean }[] = [
  { pf: 10, lcsc: 'C32949', mpn: 'CL05C100JB5NNNC', basic: true }, { pf: 12, lcsc: 'C1547', mpn: '0402CG120J500NT', basic: true },
  { pf: 15, lcsc: 'C1548', mpn: '0402CG150J500NT', basic: true }, { pf: 18, lcsc: 'C1549', mpn: '0402CG180J500NT', basic: true },
  { pf: 20, lcsc: 'C1554', mpn: '0402CG200J500NT', basic: true }, { pf: 22, lcsc: 'C1555', mpn: '0402CG220J500NT', basic: true },
  { pf: 27, lcsc: 'C1557', mpn: '0402CG270J500NT', basic: false }, { pf: 30, lcsc: 'C1570', mpn: '0402CG300J500NT', basic: false },
  { pf: 33, lcsc: 'C1562', mpn: '0402CG330J500NT', basic: true },
];

type StockPart = { lcsc: string; mpn: string; footprint: string } & Record<string, string>;
const pinned = ({ lcsc, mpn, ...props }: StockPart) => ({ ...props, supplierPartNumbers: { jlcpcb: [lcsc] }, manufacturerPartNumber: mpn });

/** The board settings that clear the default-driven issues (board.thickness, fab.trace_spacing, fab.via_size). */
export const FAB_READY_BOARD = { thickness: '1.6mm', minTraceToPadEdgeClearance: '0.15mm', pcbStyle: { viaHoleDiameter: '0.3mm', viaPadDiameter: '0.6mm' } };

const GROUND = /^(A|D|P|S)?GND\w*$|^VSS\w*$|^0V$/i;
const SUPPLY = /^(VCC|VDD|VIN|VBUS|VBAT|VSYS|VREF|AVCC|AVDD|DVCC|DVDD|VCCIO|VDDIO|VIO|VSS_?IO|V\d+(V\d*|_\d+)?|\d+V\d*|V_?\d+V\d*|\d+V\d+|[A-Z]*_?\d+V\d*)$/i;

/** Whether a net name reads as ground or a supply rail (GND, VCC, V3_3, 5V, 3V3, VBUS…). */
export const isGroundNet = (name: string) => GROUND.test(name);
export const isPowerNet = (name: string) => GROUND.test(name) || SUPPLY.test(name);

/** The board settings STEVE designs to, merged into the board's own (pcbStyle keeps its other entries). */
export function applyFabReadyBoard(code: string): EditResult {
  const index = indexFor(code);
  if (index.board === null) throw new EditError('not_found', 'There’s no <board> in the code.');
  const board = index.elements[index.board];
  const style = [...board.attrs].reverse().find((attr) => attr.name === 'pcbStyle');
  if (style && !style.static) throw new EditError('computed', `pcbStyle on the board is computed (${style.raw}); set viaHoleDiameter "0.3mm" and viaPadDiameter "0.6mm" in the source.`);
  const pcbStyle = { ...((style?.value as Record<string, unknown> | undefined) ?? {}), ...FAB_READY_BOARD.pcbStyle };
  const edit = setBoard(code, { thickness: 1.6, minTraceToPadEdgeClearance: FAB_READY_BOARD.minTraceToPadEdgeClearance, pcbStyle });
  return { ...edit, notes: edit.changed ? ['Board set to 1.6 mm with 0.15 mm trace clearance and 0.3/0.6 mm vias (JLCPCB’s standard, no surcharge).', ...edit.notes] : edit.notes };
}

/** `<net name="GND" nominalTraceWidth="0.4mm" />`: widens a power or ground net's traces (electrical.power_trace_width). */
export function setNetTraceWidth(code: string, net: string, width = '0.4mm'): EditResult {
  const index = indexFor(code);
  const existing = index.elements.filter((element) => element.tag === 'net' && element.name === net);
  if (existing.length) return setProp(code, { start: existing[0].span.start }, 'nominalTraceWidth', width);
  return insertElement(code, { tag: 'net', name: net, props: { nominalTraceWidth: width } });
}

// ---- Geometry from the circuit ----

type Point = { x: number; y: number };
type Box = { minX: number; maxX: number; minY: number; maxY: number };
type Row = { type: string; [key: string]: unknown };

interface Port { id: string; name: string; hints: string[]; pad: Point | null; net: string | null }

/** A component's ports, with their pad positions and the named net each is on. */
function portsOf(lookup: CircuitLookup, component: string): { source: Row; ports: Port[]; box: Box | null; center: Point | null } {
  const source = lookup.ofType('source_component').find((row) => row.name === component);
  if (!source) throw new EditError('not_found', `${component} isn’t in the last build; build the circuit first.`);
  const pcb = lookup.ofType('pcb_component').find((row) => row.source_component_id === source.source_component_id);
  const netByKey = new Map<string, string>();
  for (const net of lookup.ofType('source_net')) if (typeof net.name === 'string') netByKey.set(String(net.subcircuit_connectivity_map_key ?? net.source_net_id), net.name);
  // Ports joined by traces to a named net (when connectivity keys are absent).
  const traceNet = new Map<string, string>();
  for (const trace of lookup.ofType('source_trace')) {
    const nets = (trace.connected_source_net_ids as string[] | undefined ?? []).map((id) => lookup.get(id)?.name).filter((name): name is string => typeof name === 'string');
    if (nets.length) for (const port of (trace.connected_source_port_ids as string[] | undefined ?? [])) traceNet.set(port, nets[0]);
  }
  const ports = lookup.ofType('source_port').filter((row) => row.source_component_id === source.source_component_id).map((row): Port => {
    const pcbPort = lookup.ofType('pcb_port').find((item) => item.source_port_id === row.source_port_id);
    const key = row.subcircuit_connectivity_map_key as string | undefined;
    return {
      id: String(row.source_port_id), name: String(row.name), hints: ((row.port_hints as string[] | undefined) ?? []).map(String),
      pad: pcbPort ? { x: Number(pcbPort.x), y: Number(pcbPort.y) } : null,
      net: (key && netByKey.get(key)) || traceNet.get(String(row.source_port_id)) || null,
    };
  });
  let box: Box | null = null;
  const courtyard = pcb && lookup.rows.filter((row) => (row.type === 'pcb_courtyard_outline' || row.type === 'pcb_courtyard_rect') && row.pcb_component_id === pcb.pcb_component_id);
  for (const row of courtyard ?? []) {
    const points = (row.outline as Point[] | undefined) ?? (row.center ? [
      { x: (row.center as Point).x - Number(row.width) / 2, y: (row.center as Point).y - Number(row.height) / 2 },
      { x: (row.center as Point).x + Number(row.width) / 2, y: (row.center as Point).y + Number(row.height) / 2 },
    ] : []);
    for (const point of points) box = box ? { minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x), minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y) } : { minX: point.x, maxX: point.x, minY: point.y, maxY: point.y };
  }
  const center = pcb?.center ? (pcb.center as Point) : null;
  if (!box && pcb && center) box = { minX: center.x - Number(pcb.width) / 2, maxX: center.x + Number(pcb.width) / 2, minY: center.y - Number(pcb.height) / 2, maxY: center.y + Number(pcb.height) / 2 };
  return { source, ports, box, center };
}

const names = (port: Port) => [port.name, ...port.hints];
const portAnswers = (port: Port, pattern: RegExp) => names(port).some((name) => pattern.test(name));

/** Where the board's `pcbX`/`pcbY` are measured from. */
const boardCenter = (lookup: CircuitLookup): Point => (lookup.ofType('pcb_board')[0]?.center as Point | undefined) ?? { x: 0, y: 0 };

/**
 * A spot for a small part just outside a component's courtyard, beside one of its pads: the side the pad faces,
 * level with it. `slot` spreads several parts along that side. Returns the board-relative position and a rotation that
 * lays the part along the edge.
 */
function besidePad(lookup: CircuitLookup, owner: ReturnType<typeof portsOf>, pad: Point | null, slot = 0): { pcbX: number; pcbY: number; pcbRotation?: number } | null {
  if (!owner.box || !owner.center) return null;
  const at = pad ?? owner.center;
  const dx = at.x - owner.center.x;
  const dy = at.y - owner.center.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const gap = 0.25 + 0.47;  // Courtyard margin plus half the width of an 0402's courtyard across its pads.
  const along = slot * 1.3;
  const origin = boardCenter(lookup);
  const round = (value: number) => Math.round(value * 100) / 100;
  if (horizontal) {
    const x = dx >= 0 ? owner.box.maxX + gap : owner.box.minX - gap;
    return { pcbX: round(x - origin.x), pcbY: round(at.y + along - origin.y), pcbRotation: 90 };
  }
  const y = dy >= 0 ? owner.box.maxY + gap : owner.box.minY - gap;
  return { pcbX: round(at.x + along - origin.x), pcbY: round(y - origin.y) };
}

/** The ground net to tie to: the component's own ground pin's net, else a GND net in the circuit, else GND. */
function groundOf(lookup: CircuitLookup, owner: ReturnType<typeof portsOf>): string {
  const own = owner.ports.find((port) => port.net && isGroundNet(port.net))?.net;
  if (own) return own;
  const any = lookup.ofType('source_net').map((net) => String(net.name ?? '')).find(isGroundNet);
  return any ?? 'GND';
}

/** The parent to insert a fix into: the board (positions are board-relative). */
function boardOf(index: SourceIndex): Element {
  if (index.board === null) throw new EditError('not_found', 'There’s no <board> in the code.');
  return index.elements[index.board];
}

/** Inserts a pinned part and the traces that wire it, returning the edit with the new part's name. */
function insertWired(code: string, tag: string, prefix: string, part: StockPart, at: ReturnType<typeof besidePad>, wires: [string, string][], note: string): EditResult & { name: string } {
  const index = indexFor(code);
  boardOf(index);
  const name = nextName(index, prefix);
  let next = insertElement(code, { tag, name, props: { ...pinned(part), ...(at ?? {}) } }).code;
  for (const [pin, to] of wires) next = insertElement(next, { tag: 'trace', name: null, props: { from: `.${name} > .${pin}`, to } }).code;
  return { code: next, changed: true, notes: [note.replace('{name}', name)], name };
}

/**
 * A 100 nF decoupling capacitor for a chip's supply (electrical.decoupling): from the supply net to ground, placed at
 * the chip's supply pin. Wired by net, so tscircuit doesn't hold it to a 1 mm trace it can't route next to a package.
 */
export function addDecoupling(code: string, circuit: readonly unknown[], chip: string, supplyNet?: string | null): EditResult & { name: string } {
  const lookup = new CircuitLookup(circuit);
  const owner = portsOf(lookup, chip);
  const ground = groundOf(lookup, owner);
  const supply = owner.ports.filter((port) => (supplyNet ? port.net === supplyNet : (port.net && isPowerNet(port.net) && !isGroundNet(port.net)) || portAnswers(port, SUPPLY)) && !(port.net && isGroundNet(port.net)));
  const port = supply[0];
  if (!port) throw new EditError('not_found', `${chip} has no supply pin on ${supplyNet ?? 'a power net'}.`);
  const net = supplyNet ?? port.net;
  // A supply pin on an unnamed net is wired directly (pin 1 to the pin); a named supply is joined by net.
  const to = net ? netSelector(net) : portSelector(chip, port.name, lookup.subcircuitPath(owner.source.source_group_id as string | undefined));
  const existing = indexFor(code).elements.filter((element) => element.tag === 'capacitor').length;
  return insertWired(code, 'capacitor', 'C', STOCK_PARTS.cap100n, besidePad(lookup, owner, port.pad, existing % 3), [['pin1', to], ['pin2', netSelector(ground)]],
    `Added {name}, 100 nF from ${net ?? `${chip}.${port.name}`} to ${ground}, next to ${chip}. Move it closer to the pin if the board has room.`);
}

const ANODE = /^(anode|pos|pin1|A|\+)$/i;
const CATHODE = /^(cathode|neg|pin2|K|C|-)$/i;

/**
 * A 1 kΩ resistor in series with an LED (electrical.led_current): the trace into its anode (else its cathode) now goes
 * through the resistor. 1 kΩ gives about 1–3 mA from 3.3–5 V; lower it for a brighter LED.
 */
export function addLedResistor(code: string, circuit: readonly unknown[], led: string): EditResult & { name: string } {
  const lookup = new CircuitLookup(circuit);
  const owner = portsOf(lookup, led);
  const index = indexFor(code);
  resolveTarget(index, led);
  const pins = [owner.ports.find((port) => portAnswers(port, ANODE)), owner.ports.find((port) => portAnswers(port, CATHODE))];
  for (const pin of pins) {
    if (!pin) continue;
    // A trace written with a literal selector for this pin: its LED end moves to the resistor.
    for (const trace of index.elements.filter((element) => element.tag === 'trace')) {
      for (const end of ['from', 'to'] as const) {
        const attr = [...trace.attrs].reverse().find((item) => item.name === end);
        const selector = attr?.static && typeof attr.value === 'string' ? parseSelector(attr.value) : null;
        if (!selector || selector.kind !== 'port' || selector.component !== led || !names(pin).includes(selector.port)) continue;
        const name = nextName(index, 'R');
        let next = setProp(code, { start: trace.span.start }, end, `.${name} > .pin1`).code;
        next = insertElement(next, { tag: 'resistor', name, props: { ...pinned(STOCK_PARTS.res1k), ...(besidePad(lookup, owner, pin.pad) ?? {}) } }).code;
        next = insertElement(next, { tag: 'trace', name: null, props: { from: `.${name} > .pin2`, to: `.${led} > .${selector.port}` } }).code;
        return { code: next, changed: true, name, notes: [`Added ${name}, 1 kΩ in series with ${led} (about 1–3 mA from 3.3–5 V). Lower it for a brighter LED; stay under its rated current.`] };
      }
    }
  }
  throw new EditError('not_found', `${led} isn’t wired with a plain <trace> to its anode or cathode, so the resistor can’t be put in series automatically; add it in the source.`);
}

/**
 * Load capacitors for a crystal (electrical.crystal_load_caps): one from each terminal to ground, C = 2·(C_L − 4 pF)
 * rounded to the nearest stocked C0G value. C_L comes from the crystal's loadCapacitance (18 pF if not given).
 */
export function addCrystalLoadCaps(code: string, circuit: readonly unknown[], crystal: string): EditResult & { names: string[] } {
  const lookup = new CircuitLookup(circuit);
  const owner = portsOf(lookup, crystal);
  const ground = groundOf(lookup, owner);
  const terminals = owner.ports.filter((port) => !(port.net && isGroundNet(port.net)) && !portAnswers(port, /^(gnd|case)$/i)).slice(0, 2);
  if (terminals.length < 2) throw new EditError('not_found', `${crystal} doesn’t have two signal pins to load.`);
  const loadPf = Number(owner.source.load_capacitance ?? NaN) * 1e12 || 18;
  const want = 2 * (loadPf - 4);
  const cap = LOAD_CAPS.reduce((best, item) => (Math.abs(item.pf - want) < Math.abs(best.pf - want) ? item : best));
  let current = code;
  const added: string[] = [];
  const path = lookup.subcircuitPath(owner.source.source_group_id as string | undefined);
  terminals.forEach((terminal) => {
    const step = insertWired(current, 'capacitor', 'C', { capacitance: `${cap.pf}pF`, footprint: '0402', lcsc: cap.lcsc, mpn: cap.mpn }, besidePad(lookup, owner, terminal.pad),
      [['pin1', portSelector(crystal, terminal.name, path)], ['pin2', netSelector(ground)]], '');
    current = step.code;
    added.push(step.name);
  });
  return { code: current, changed: true, names: added, notes: [`Added ${added.join(' and ')}, ${cap.pf} pF from each pin of ${crystal} to ${ground} (2 × (${loadPf} pF load − 4 pF stray) ≈ ${want.toFixed(0)} pF${cap.basic ? '' : '; an Extended part'}).`] };
}

/** 5.1 kΩ from each USB-C CC pin to ground, never shared (electrical.usb_c_cc): the connector reads as a 5 V sink. */
export function addUsbCcResistors(code: string, circuit: readonly unknown[], connector: string): EditResult & { names: string[] } {
  const lookup = new CircuitLookup(circuit);
  const owner = portsOf(lookup, connector);
  const ground = groundOf(lookup, owner);
  const cc = ['CC1', 'CC2'].map((label) => owner.ports.find((port) => portAnswers(port, new RegExp(`^${label}$`, 'i'))));
  if (!cc[0] || !cc[1]) throw new EditError('not_found', `${connector}’s CC1 and CC2 pins aren’t named, so they can’t be found; name them in pinLabels first.`);
  let current = code;
  const added: string[] = [];
  const path = lookup.subcircuitPath(owner.source.source_group_id as string | undefined);
  cc.forEach((port) => {
    const step = insertWired(current, 'resistor', 'R', STOCK_PARTS.res5k1, besidePad(lookup, owner, port!.pad), [['pin1', portSelector(connector, port!.hints.find((hint) => /^CC\d$/i.test(hint)) ?? port!.name, path)], ['pin2', netSelector(ground)]], '');
    current = step.code;
    added.push(step.name);
  });
  return { code: current, changed: true, names: added, notes: [`Added ${added.join(' and ')}, 5.1 kΩ from ${connector}.CC1 and .CC2 to ${ground}, one each, so any USB-C charger supplies 5 V.`] };
}

/** 1 µF on a regulator's input and output to ground (electrical.regulator_caps); check the datasheet for its own values. */
export function addRegulatorCaps(code: string, circuit: readonly unknown[], regulator: string): EditResult & { names: string[] } {
  const lookup = new CircuitLookup(circuit);
  const owner = portsOf(lookup, regulator);
  const ground = groundOf(lookup, owner);
  const sides = [/^(VIN|IN|VI)$/i, /^(VOUT|OUT|VO)$/i].map((pattern) => owner.ports.find((port) => portAnswers(port, pattern)));
  if (!sides[0] || !sides[1]) throw new EditError('not_found', `${regulator}’s input and output pins aren’t named VIN and VOUT.`);
  let current = code;
  const added: string[] = [];
  const path = lookup.subcircuitPath(owner.source.source_group_id as string | undefined);
  sides.forEach((port) => {
    const to = port!.net ? netSelector(port!.net) : portSelector(regulator, port!.name, path);
    const step = insertWired(current, 'capacitor', 'C', STOCK_PARTS.cap1u, besidePad(lookup, owner, port!.pad), [['pin1', to], ['pin2', netSelector(ground)]], '');
    current = step.code;
    added.push(step.name);
  });
  return { code: current, changed: true, names: added, notes: [`Added ${added.join(' and ')}, 1 µF on ${regulator}’s input and output to ${ground}. Check its datasheet: some regulators need more, or a particular ESR.`] };
}

/** The readiness rules these fixes clear, by rule id. */
export const FIXABLE_RULES = ['electrical.decoupling', 'electrical.led_current', 'electrical.crystal_load_caps', 'electrical.usb_c_cc', 'electrical.regulator_caps', 'electrical.power_trace_width', 'board.thickness', 'fab.trace_spacing', 'fab.via_size'] as const;


/**
 * What a circuit build's Circuit JSON says, read for people: the board, the parts (by name, with value and
 * footprint), the nets that connect them, and the problems tscircuit found. Every view and the tree select by part
 * name, so these maps also turn each view's element ids (schematic, PCB, ports) back into names.
 */
import type { CircuitDiagnostic, CircuitMetadata } from '@/lib/api';

/** tscircuit's findings that only say a connection has no copper yet: on an unrouted board, that's the ratsnest. */
export const UNROUTED = new Set(['pcb_trace_missing_error', 'pcb_port_not_connected_error', 'pcb_autorouting_error']);
/** tscircuit's advice that asks for nothing on a board you order (a schematic sheet frame): not listed as a problem. */
const ADVICE_ONLY = new Set(['schematic_missing_sheet_warning']);

/** One Circuit JSON element: tscircuit's own types are richer, but these fields are all the UI reads. */
export type CircuitElement = { type: string } & Record<string, unknown>;

export interface CircuitPort { id: string; name: string; label: string; part: string }
export interface CircuitPart {
  id: string;
  name: string;
  ftype: string;
  /** The group it's listed under: Resistors, Capacitors, Chips… */
  group: string;
  value: string | null;
  footprint: string | null;
  layer: string | null;
  /** Where it sits on the board (mm, board coordinates) and its rotation (degrees). */
  pcb: { x: number; y: number; rotation: number } | null;
  pcbId: string | null;
  schematicId: string | null;
  ports: CircuitPort[];
}
export interface CircuitNet { key: string; name: string; ground: boolean; power: boolean; named: boolean; ports: CircuitPort[] }
export interface CircuitProblem {
  id: string; type: string; message: string; severity: 'error' | 'warning' | 'info';
  /** How to fix it, in a sentence (readiness issues). */
  fix?: string | null;
  /** The readiness issue it shows (its one-click fix comes from it). */
  issue?: import('./readiness').ReadinessIssue;
  /** The parts it names (selecting a problem selects them). */
  parts: string[];
  line: number | null;
}
export interface CircuitModel {
  board: { width: number | null; height: number | null; layers: number | null } | null;
  parts: CircuitPart[];
  nets: CircuitNet[];
  problems: CircuitProblem[];
  /** Element id (source, schematic or PCB component; port; trace; net label) → the part name it belongs to. */
  partOf: Map<string, string>;
  /** Source, schematic or PCB port id → its port. */
  portOf: Map<string, CircuitPort>;
}

const GROUPS: Record<string, string> = {
  simple_resistor: 'Resistors', simple_capacitor: 'Capacitors', simple_inductor: 'Inductors', simple_diode: 'Diodes', simple_led: 'LEDs',
  simple_chip: 'Chips', simple_pin_header: 'Connectors', simple_connector: 'Connectors', simple_push_button: 'Switches', simple_switch: 'Switches',
  simple_crystal: 'Crystals', simple_resonator: 'Crystals', simple_transistor: 'Transistors', simple_mosfet: 'Transistors',
  simple_battery: 'Power', simple_power_source: 'Power', simple_voltage_source: 'Power', simple_fuse: 'Protection',
  simple_potentiometer: 'Resistors', simple_test_point: 'Test points', simple_mounting_hole: 'Mechanical', simple_fiducial: 'Mechanical',
  simple_jumper: 'Jumpers', simple_solderjumper: 'Jumpers', simple_opamp: 'Chips',
};
/** Groups in the order a schematic is read: connectors and chips, then passives, then the rest. */
export const GROUP_ORDER = ['Connectors', 'Chips', 'Transistors', 'Resistors', 'Capacitors', 'Inductors', 'Diodes', 'LEDs', 'Crystals', 'Switches', 'Power', 'Protection', 'Jumpers', 'Test points', 'Mechanical'];

const groupOf = (ftype: string) => GROUPS[ftype] ?? ftype.replace(/^simple_/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).replace(/([^s])$/, '$1s');

/** A diagnostic's ids as a flat list: the kernel keys them by type (`{source_port_id: …}`); older shapes were lists. */
export function idList(ids: unknown): string[] {
  if (!ids) return [];
  const values = Array.isArray(ids) ? ids : typeof ids === 'object' ? Object.values(ids as Record<string, unknown>) : [ids];
  return values.flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value): value is string => typeof value === 'string');
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** What a part's value reads as: 10kΩ, 100nF, red, or its part number. */
function valueOf(component: CircuitElement): string | null {
  for (const key of ['display_resistance', 'display_capacitance', 'display_inductance', 'display_value', 'display_frequency', 'display_voltage']) {
    const value = text(component[key]);
    if (value) return value;
  }
  return text(component.color) ?? text(component.manufacturer_part_number) ?? text(component.mpn) ?? null;
}

/** Natural order by name: R2 before R10. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Every id an element names a part by (singular or plural fields). */
function idsIn(element: CircuitElement): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(element)) {
    if (!/_component_ids?$|_port_ids?$|_trace_ids?$|_net_label_ids?$/.test(key)) continue;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return out;
}

export function circuitModel(json: CircuitElement[], metadata?: Partial<CircuitMetadata> | null): CircuitModel {
  const byType = new Map<string, CircuitElement[]>();
  for (const element of json) {
    const list = byType.get(element.type);
    if (list) list.push(element); else byType.set(element.type, [element]);
  }
  const all = (type: string) => byType.get(type) ?? [];
  const partOf = new Map<string, string>();
  const portOf = new Map<string, CircuitPort>();

  const footprints = new Map(all('cad_component').map((cad) => [String(cad.source_component_id), text(cad.footprinter_string)]));
  const pcbBySource = new Map(all('pcb_component').map((pcb) => [String(pcb.source_component_id), pcb]));
  const schBySource = new Map(all('schematic_component').map((sch) => [String(sch.source_component_id), sch]));
  const ports = new Map<string, CircuitPort[]>();
  const portById = new Map<string, CircuitPort>();
  const names = new Map(all('source_component').map((component) => [String(component.source_component_id), String(component.name ?? '')]));
  const ftypes = new Map(all('source_component').map((component) => [String(component.source_component_id), String(component.ftype ?? '')]));
  for (const port of all('source_port')) {
    const part = names.get(String(port.source_component_id)) ?? '';
    const hints = Array.isArray(port.port_hints) ? (port.port_hints as unknown[]).filter((hint): hint is string => typeof hint === 'string') : [];
    const name = String(port.name ?? hints[0] ?? '');
    // The pin's own label (VCC on a chip, anode on a diode) when it has one, else its name. tscircuit gives every
    // two-pin part generic hints (anode, pos, left): only diodes and LEDs really have an anode and a cathode.
    const polar = /diode|led/.test(ftypes.get(String(port.source_component_id)) ?? '');
    const generic = polar ? /^pin\d+$|^\d+$|^(left|right|top|bottom|pos|neg)$/ : /^pin\d+$|^\d+$|^(left|right|top|bottom|pos|neg|anode|cathode)$/;
    const label = hints.find((hint) => hint !== name && !generic.test(hint)) ?? name;
    const entry: CircuitPort = { id: String(port.source_port_id), name, label, part };
    portById.set(entry.id, entry);
    const list = ports.get(String(port.source_component_id));
    if (list) list.push(entry); else ports.set(String(port.source_component_id), [entry]);
    if (part) partOf.set(entry.id, part);
    // The schematic SVG marks pins by their source port id.
    portOf.set(entry.id, entry);
  }
  for (const type of ['schematic_port', 'pcb_port']) {
    for (const port of all(type)) {
      const source = portById.get(String(port.source_port_id));
      const id = String(port[`${type}_id`]);
      if (source) { portOf.set(id, source); partOf.set(id, source.part); }
    }
  }

  const parts: CircuitPart[] = all('source_component').map((component) => {
    const id = String(component.source_component_id);
    const pcb = pcbBySource.get(id);
    const sch = schBySource.get(id);
    const name = String(component.name ?? id);
    partOf.set(id, name);
    if (pcb) partOf.set(String(pcb.pcb_component_id), name);
    if (sch) partOf.set(String(sch.schematic_component_id), name);
    const ftype = String(component.ftype ?? 'simple_chip');
    return {
      id, name, ftype, group: groupOf(ftype), value: valueOf(component), footprint: footprints.get(id) ?? null,
      layer: pcb ? String(pcb.layer ?? 'top') : null, pcbId: pcb ? String(pcb.pcb_component_id) : null,
      pcb: pcb && pcb.center && typeof pcb.center === 'object' ? { x: Number((pcb.center as { x: number }).x), y: Number((pcb.center as { y: number }).y), rotation: Number(pcb.rotation ?? 0) } : null,
      schematicId: sch ? String(sch.schematic_component_id) : null, ports: ports.get(id) ?? [],
    };
  }).sort((a, b) => collator.compare(a.name, b.name));

  // Nets: ports grouped by tscircuit's own connectivity key, named by their net (GND, VCC) or the trace that names them.
  const netNames = new Map(all('source_net').map((net) => [String(net.subcircuit_connectivity_map_key ?? net.source_net_id), net]));
  const traceNames = new Map<string, string>();
  for (const trace of all('source_trace')) {
    const key = String(trace.subcircuit_connectivity_map_key ?? '');
    const name = text(trace.name);
    if (key && name && !traceNames.has(key)) traceNames.set(key, name);
  }
  const grouped = new Map<string, CircuitPort[]>();
  for (const port of all('source_port')) {
    const key = text(port.subcircuit_connectivity_map_key);
    const entry = portById.get(String(port.source_port_id));
    if (!key || !entry) continue;
    const list = grouped.get(key);
    if (list) list.push(entry); else grouped.set(key, [entry]);
  }
  // A port on its own is unconnected, not a net, unless it's on a named net (one pin tied to GND).
  const nets: CircuitNet[] = [...grouped.entries()].filter(([key, members]) => members.length > 1 || netNames.has(key)).map(([key, members]) => {
    const net = netNames.get(key);
    const named = text(net?.name) ?? traceNames.get(key) ?? null;
    const sorted = [...members].sort((a, b) => collator.compare(`${a.part}.${a.name}`, `${b.part}.${b.name}`));
    return {
      key, name: named ?? `${sorted[0].part}.${sorted[0].label}`, named: !!named, ports: sorted,
      ground: net?.is_ground === true || /^gnd$/i.test(named ?? ''), power: net?.is_power === true || /^(v(cc|dd|in|bus)|\+?\d+v\d*)$/i.test(named ?? ''),
    };
  }).sort((a, b) => Number(b.ground || b.power) - Number(a.ground || a.power) || Number(b.named) - Number(a.named) || collator.compare(a.name, b.name));

  // Problems: the kernel's diagnostics when it sent them (they carry source lines), else read from the Circuit JSON. A kernel
  // that reports routing sends them even when there are none; on an unrouted board it has folded the connections without
  // copper into readiness's one routing.not_routed (docs/ELECTRONICS.md, "Routing"), so they're not read back from the JSON.
  const fromMetadata = metadata?.diagnostics;
  const unrouted = metadata?.routing?.status === 'not_routed' || metadata?.routing?.status === 'incomplete';
  const problems: CircuitProblem[] = (fromMetadata?.length || (fromMetadata && metadata?.routing) ? fromMetadata.map((d: CircuitDiagnostic, index) => ({
    id: `${d.type}:${index}`, type: d.type, message: d.message, severity: d.severity ?? (d.type.endsWith('_error') ? 'error' : 'warning'),
    parts: [...new Set([...(d.component ? [d.component] : []), ...idList(d.ids).map((id) => partOf.get(id))].filter((name): name is string => !!name))],
    // A line in another file (a subcircuit) doesn't point into main.tsx.
    line: d.file && d.file !== 'main.tsx' ? null : d.source_line ?? null,
  })) : json.filter((element) => (element.type.endsWith('_error') || element.type.endsWith('_warning')) && !(unrouted && UNROUTED.has(element.type))).map((element, index) => ({
    id: String(element[`${element.type}_id`] ?? `${element.type}:${index}`), type: element.type, message: String(element.message ?? element.type.replace(/_/g, ' ')),
    severity: element.type.endsWith('_error') ? 'error' as const : 'warning' as const,
    parts: [...new Set(idsIn(element).map((id) => partOf.get(id)).filter((name): name is string => !!name))], line: null,
  }))).filter((problem) => !ADVICE_ONLY.has(problem.type)).sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'));

  const board = all('pcb_board')[0];
  return {
    board: board ? { width: Number(board.width) || null, height: Number(board.height) || null, layers: Number(board.num_layers) || null } : null,
    parts, nets, problems, partOf, portOf,
  };
}

/**
 * The name a selector writes for a port: its label when a selector can say it (`.U1 > .VCC`, `.D1 > .anode`), else its
 * name (`.R1 > .pin1`: a resistor's anode/cathode hints are generic, so its label is its name).
 */
export const selectorName = (port: { name: string; label?: string | null }) =>
  typeof port.label === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(port.label) ? port.label : port.name;

/** A selector as people read it: `.R1 > .pin1` → `R1.pin1`, `net.GND` → `GND`. */
export const plainSelector = (selector: string) => selector.trim().replace(/^net\./, '').replace(/\s*>\s*/g, '').replace(/^\./, '');

/**
 * A problem's message without tscircuit's element references: `<led#25 name=".D1" /> maps…` → `D1 maps…`;
 * `<trace#23(from:.R1 > .pin1 to:.D1 > .anode) /> is missing…` → `The trace R1.pin1 → D1.anode is missing…`.
 */
export const plainMessage = (message: string) => message
  .replace(/<trace#\d+\(from:(.*?) to:(.*?)\)\s*\/>/g, (_, from: string, to: string) => `The trace ${plainSelector(from)} → ${plainSelector(to)}`)
  .replace(/<(\w+)#\d+(?:\s+name="\.?([^"]*)")?[^>]*\/>/g, (_, tag: string, name?: string) => name || tag)
  .replace(/\s+/g, ' ').trim();

/** Where a problem points in the code: its source line, or the line that names its first part. */
export function lineOf(problem: CircuitProblem, code: string): number | null {
  if (problem.line) return problem.line;
  const part = problem.parts[0];
  if (!part) return null;
  const pattern = new RegExp(`name=["'{]+${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'}]`);
  const index = code.split('\n').findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : null;
}

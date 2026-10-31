/**
 * The parts people place from the Place gallery: tscircuit elements with a label, category, icon, reference prefix,
 * default props that evaluate cleanly, and footprint suggestions. The list is curated; `withDerived()` adds any
 * component element `@tscircuit/props` defines that the list doesn't have yet, so new tscircuit parts show up.
 */
import { prefixFor } from '../code/naming';
import { footprintsFor } from './footprints';

export const CATEGORIES = ['Passives', 'Semiconductors', 'ICs', 'Connectors', 'Electromechanical', 'Power', 'PCB features', 'Annotation', 'Structure', 'More'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface PartSpec {
  /** The tscircuit element (`resistor`, `pinheader`, …). */
  tag: string;
  label: string;
  category: Category;
  /** A lucide-react icon name (the palette maps names to components). */
  icon: string;
  /** Reference designator prefix (R, C, U, …); null for elements without names (traces, text, holes by default). */
  prefix: string | null;
  /** Props a newly placed one gets (after its name). Required props are always present. */
  defaults: Record<string, unknown>;
  /** Footprint strings offered first (tscircuit footprinter names); empty when the element has its own footprint. */
  footprints: string[];
  description: string;
  /** Extra search words. */
  keywords: string[];
  /** Added from `@tscircuit/props` rather than the curated list. */
  derived?: boolean;
}

type Entry = Omit<PartSpec, 'prefix' | 'footprints' | 'keywords'> & { prefix?: string | null; footprints?: string[]; keywords?: string[] };

const ENTRIES: Entry[] = [
  // Passives
  { tag: 'resistor', label: 'Resistor', category: 'Passives', icon: 'RectangleHorizontal', defaults: { resistance: '10k', footprint: '0402' }, description: 'Fixed resistor.', keywords: ['res', 'ohm', 'pullup', 'pulldown'] },
  { tag: 'capacitor', label: 'Capacitor', category: 'Passives', icon: 'Pause', defaults: { capacitance: '100nF', footprint: '0402' }, description: 'Ceramic, electrolytic or tantalum capacitor.', keywords: ['cap', 'decoupling', 'bypass', 'farad'] },
  { tag: 'inductor', label: 'Inductor', category: 'Passives', icon: 'Waves', defaults: { inductance: '10uH', footprint: '0603' }, description: 'Inductor or ferrite bead.', keywords: ['coil', 'choke', 'henry', 'ferrite'] },
  { tag: 'potentiometer', label: 'Potentiometer', category: 'Passives', icon: 'SlidersHorizontal', defaults: { maxResistance: '10k' }, description: 'Variable resistor with a wiper.', keywords: ['pot', 'trimmer', 'variable'] },
  { tag: 'fuse', label: 'Fuse', category: 'Passives', icon: 'Minus', defaults: { currentRating: '500mA', footprint: '1206' }, description: 'Fuse or polyfuse.', keywords: ['ptc', 'protection'] },
  { tag: 'crystal', label: 'Crystal', category: 'Passives', icon: 'Diamond', defaults: { frequency: '16MHz', loadCapacitance: '18pF', footprint: 'hc49' }, description: 'Quartz crystal for a clock.', keywords: ['xtal', 'oscillator', 'clock'] },
  { tag: 'resonator', label: 'Resonator', category: 'Passives', icon: 'Diamond', defaults: { frequency: '16MHz', loadCapacitance: '15pF' }, description: 'Ceramic resonator.', keywords: ['clock', 'oscillator'] },
  // Semiconductors
  { tag: 'diode', label: 'Diode', category: 'Semiconductors', icon: 'Triangle', defaults: { footprint: 'sod123' }, description: 'Rectifier, Schottky, Zener or TVS diode.', keywords: ['schottky', 'zener', 'tvs', 'rectifier'] },
  { tag: 'led', label: 'LED', category: 'Semiconductors', icon: 'Lightbulb', defaults: { color: 'red', footprint: '0603' }, description: 'Light-emitting diode.', keywords: ['light', 'indicator'] },
  { tag: 'transistor', label: 'Transistor', category: 'Semiconductors', icon: 'GitFork', defaults: { type: 'npn', footprint: 'sot23' }, description: 'NPN or PNP bipolar transistor.', keywords: ['bjt', 'npn', 'pnp'] },
  { tag: 'mosfet', label: 'MOSFET', category: 'Semiconductors', icon: 'GitFork', defaults: { channelType: 'n', mosfetMode: 'enhancement', footprint: 'sot23' }, description: 'N- or P-channel MOSFET.', keywords: ['fet', 'transistor', 'switch'] },
  // ICs
  { tag: 'chip', label: 'Chip', category: 'ICs', icon: 'Cpu', defaults: { footprint: 'soic8' }, description: 'Any IC: name its pins with pinLabels.', keywords: ['ic', 'microcontroller', 'mcu', 'regulator', 'u'] },
  { tag: 'opamp', label: 'Op amp', category: 'ICs', icon: 'Triangle', defaults: { footprint: 'soic8' }, description: 'Operational amplifier.', keywords: ['amplifier', 'comparator'] },
  // Connectors
  { tag: 'pinheader', label: 'Pin header', category: 'Connectors', icon: 'GripVertical', defaults: { pinCount: 4, gender: 'male' }, description: '0.1" pin header or socket.', keywords: ['header', 'socket', 'pins'] },
  { tag: 'connector', label: 'Connector', category: 'Connectors', icon: 'Plug', defaults: { standard: 'usb_c' }, description: 'USB-C, JST and other standard connectors.', keywords: ['usb', 'jst', 'plug'] },
  { tag: 'jumper', label: 'Jumper', category: 'Connectors', icon: 'Link', defaults: { pinCount: 2 }, description: 'Jumper header.', keywords: ['bridge'] },
  { tag: 'solderjumper', label: 'Solder jumper', category: 'Connectors', icon: 'Link2', defaults: { pinCount: 2 }, description: 'Pads bridged with solder.', keywords: ['bridge', 'pad'] },
  { tag: 'testpoint', label: 'Test point', category: 'Connectors', icon: 'Crosshair', defaults: { footprintVariant: 'pad' }, description: 'A pad to probe.', keywords: ['probe', 'tp'] },
  // Electromechanical
  { tag: 'pushbutton', label: 'Push button', category: 'Electromechanical', icon: 'CircleDot', defaults: { footprint: 'pushbutton' }, description: 'Momentary button.', keywords: ['button', 'switch', 'tactile'] },
  { tag: 'switch', label: 'Switch', category: 'Electromechanical', icon: 'ToggleLeft', defaults: { type: 'spst' }, description: 'Slide or toggle switch.', keywords: ['toggle', 'slide', 'spdt'] },
  { tag: 'battery', label: 'Battery', category: 'Electromechanical', icon: 'BatteryMedium', defaults: { standard: 'CR2032' }, description: 'Battery holder.', keywords: ['cell', 'coin', 'aa'] },
  { tag: 'antenna', label: 'Antenna', category: 'Electromechanical', icon: 'RadioTower', defaults: { frequencyBand: '2.4ghz' }, description: 'PCB antenna.', keywords: ['rf', 'wifi', 'bluetooth'] },
  // Power
  { tag: 'powersource', label: 'Power source', category: 'Power', icon: 'Zap', defaults: { voltage: '5V' }, description: 'An ideal supply for simulation.', keywords: ['supply', 'vcc'] },
  { tag: 'voltagesource', label: 'Voltage source', category: 'Power', icon: 'Zap', defaults: { voltage: '5V' }, description: 'A simulation voltage source.', keywords: ['supply', 'signal'] },
  { tag: 'currentsource', label: 'Current source', category: 'Power', icon: 'Zap', defaults: { current: '1mA' }, description: 'A simulation current source.', keywords: ['supply'] },
  // Power nets get 0.4 mm traces (readiness electrical.power_trace_width; tscircuit's default is 0.15 mm).
  { tag: 'net', label: 'Net', category: 'Power', icon: 'Share2', prefix: null, defaults: { name: 'VCC', nominalTraceWidth: '0.4mm' }, description: 'A named power or signal net (GND, VCC, …), with traces wide enough for power.', keywords: ['gnd', 'vcc', 'rail'] },
  // PCB features
  { tag: 'hole', label: 'Mounting hole', category: 'PCB features', icon: 'Circle', prefix: null, defaults: { diameter: '3.2mm' }, description: 'Non-plated hole.', keywords: ['screw', 'mounting'] },
  { tag: 'platedhole', label: 'Plated hole', category: 'PCB features', icon: 'CircleDot', prefix: null, defaults: { shape: 'circle', holeDiameter: '1mm', outerDiameter: '1.8mm' }, description: 'Through-hole pad.', keywords: ['tht', 'pad'] },
  { tag: 'via', label: 'Via', category: 'PCB features', icon: 'Disc', prefix: null, defaults: { holeDiameter: '0.3mm', outerDiameter: '0.6mm' }, description: 'Layer-to-layer via.', keywords: ['stitching'] },
  { tag: 'fiducial', label: 'Fiducial', category: 'PCB features', icon: 'Target', defaults: { padDiameter: '1mm' }, description: 'Optical alignment mark for assembly.', keywords: ['mark', 'assembly'] },
  { tag: 'copperpour', label: 'Copper pour', category: 'PCB features', icon: 'PaintBucket', prefix: null, defaults: { layer: 'top', connectsTo: 'net.GND' }, description: 'Fill a layer with copper on a net.', keywords: ['ground plane', 'fill', 'pour'] },
  { tag: 'cutout', label: 'Cutout', category: 'PCB features', icon: 'Scissors', prefix: null, defaults: { shape: 'rect', width: '5mm', height: '3mm' }, description: 'Board cutout.', keywords: ['slot', 'routing'] },
  { tag: 'silkscreentext', label: 'Silkscreen text', category: 'PCB features', icon: 'Type', prefix: null, defaults: { text: 'Label', fontSize: '1mm' }, description: 'Text on the silkscreen.', keywords: ['label', 'logo'] },
  { tag: 'coppertext', label: 'Copper text', category: 'PCB features', icon: 'Type', prefix: null, defaults: { text: 'Label', fontSize: '1mm' }, description: 'Text in copper.', keywords: ['label'] },
  // Annotation
  { tag: 'netlabel', label: 'Net label', category: 'Annotation', icon: 'Tag', prefix: null, defaults: { net: 'VCC' }, description: 'A net name in the schematic.', keywords: ['label', 'power symbol'] },
  { tag: 'schematictext', label: 'Schematic text', category: 'Annotation', icon: 'Type', prefix: null, defaults: { text: 'Note' }, description: 'A note in the schematic.', keywords: ['note', 'comment'] },
  { tag: 'pcbnotetext', label: 'PCB note', category: 'Annotation', icon: 'StickyNote', prefix: null, defaults: { text: 'Note' }, description: 'A note on the board drawings.', keywords: ['note', 'comment'] },
  { tag: 'fabricationnotetext', label: 'Fabrication note', category: 'Annotation', icon: 'StickyNote', prefix: null, defaults: { text: 'Note' }, description: 'A note for the board maker.', keywords: ['fab', 'note'] },
  // Structure
  { tag: 'group', label: 'Group', category: 'Structure', icon: 'Group', defaults: {}, description: 'Groups parts so they move and lay out together.', keywords: ['block'] },
  { tag: 'subcircuit', label: 'Subcircuit', category: 'Structure', icon: 'Boxes', defaults: {}, description: 'A reusable block with its own names and routing.', keywords: ['module', 'block'] },
];

const spec = (entry: Entry): PartSpec => ({
  ...entry,
  prefix: entry.prefix === undefined ? prefixFor(entry.tag) : entry.prefix,
  footprints: entry.footprints ?? footprintsFor(entry.tag),
  keywords: entry.keywords ?? [],
});

/** The curated parts, in palette order. */
export const PARTS: readonly PartSpec[] = ENTRIES.map(spec);

export const partFor = (tag: string): PartSpec | undefined => PARTS.find((part) => part.tag === tag);

/**
 * The curated parts plus every component element `@tscircuit/props` has that they don't: anything whose props take
 * a footprint and a PCB position (a placeable part). Their tag is the props name lowercased (`pinHeaderProps` →
 * `pinheader`), as tscircuit names its elements.
 */
export function withDerived(componentSchemas: Record<string, { properties?: Record<string, unknown> }>): PartSpec[] {
  const known = new Set(PARTS.map((part) => part.tag));
  const extra: PartSpec[] = [];
  for (const [tag, schema] of Object.entries(componentSchemas)) {
    if (known.has(tag) || !schema.properties || !('footprint' in schema.properties) || !('pcbX' in schema.properties)) continue;
    extra.push(spec({ tag, label: tag.replace(/^./, (c) => c.toUpperCase()), category: 'More', icon: 'Box', defaults: {}, description: `tscircuit <${tag}>.`, derived: true }));
  }
  return [...PARTS, ...extra.sort((a, b) => a.tag.localeCompare(b.tag))];
}

/** Parts matching a search (label, tag, category, keywords, description). */
export function searchParts(parts: readonly PartSpec[], query: string): PartSpec[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...parts];
  return parts.filter((part) => {
    const text = [part.label, part.tag, part.category, part.description, ...part.keywords].join(' ').toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

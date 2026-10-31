/**
 * Completions for a circuit's TSX (docs/ELECTRONICS.md): after `<`, every tscircuit element; inside an element's tag,
 * that element's props, from tscircuit's own prop schemas (@tscircuit/props, loaded on first use), with their type.
 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';

/** The JSX elements tscircuit renders, each with the schema of its props (@tscircuit/core's IntrinsicElements). */
const TAGS: Record<string, string> = {
  board: 'boardProps', group: 'groupProps', subcircuit: 'subcircuitGroupProps', schematicsheet: 'schematicSheetProps', panel: 'panelProps',
  resistor: 'resistorProps', capacitor: 'capacitorProps', inductor: 'inductorProps', diode: 'diodeProps', led: 'ledProps', chip: 'chipProps',
  pinheader: 'pinHeaderProps', connector: 'connectorProps', pushbutton: 'pushButtonProps', switch: 'switchProps', crystal: 'crystalProps',
  resonator: 'resonatorProps', transistor: 'transistorProps', mosfet: 'mosfetProps', battery: 'batteryProps', fuse: 'fuseProps',
  potentiometer: 'potentiometerProps', jumper: 'jumperProps', solderjumper: 'solderjumperProps', testpoint: 'testpointProps', opamp: 'opampProps',
  antenna: 'antennaProps', powersource: 'powerSourceProps', voltagesource: 'voltageSourceProps', currentsource: 'currentSourceProps',
  trace: 'traceProps', net: 'netProps', netlabel: 'netLabelProps', via: 'viaProps', hole: 'holeProps', platedhole: 'platedHoleProps',
  smtpad: 'smtPadProps', keepout: 'pcbKeepoutProps', copperpour: 'copperPourProps', cutout: 'cutoutProps', fiducial: 'fiducialProps',
  footprint: 'footprintProps', port: 'portProps', cadmodel: 'cadmodelProps', silkscreentext: 'silkscreenTextProps',
  silkscreenline: 'silkscreenLineProps', silkscreenrect: 'silkscreenRectProps', silkscreencircle: 'silkscreenCircleProps',
  silkscreenpath: 'silkscreenPathProps', coppertext: 'copperTextProps', tracehint: 'routeHintPointProps', constraint: 'constraintProps',
  analogsimulation: 'analogSimulationProps', ammeter: 'ammeterProps', voltageprobe: 'voltageProbeProps',
};

const DESCRIPTIONS: Record<string, string> = {
  board: 'The circuit board: width, height, layers, outline', resistor: 'resistance, footprint', capacitor: 'capacitance, footprint',
  chip: 'An IC: footprint and pin labels', trace: 'A connection: from and to (".R1 > .pin1", "net.GND")', net: 'A named net (GND, VCC)',
  pinheader: 'A pin header: pinCount, pitch', led: 'color, footprint', schematicsheet: 'A schematic sheet (title block)',
};

type Schema = { shape?: unknown; _def?: Record<string, unknown> } | null | undefined;
let loading: Promise<Record<string, unknown>> | null = null;
const load = () => (loading ??= import('@tscircuit/props') as unknown as Promise<Record<string, unknown>>);

/** A zod schema's object shape through refinements, defaults and unions of objects. */
function shapeOf(schema: Schema, depth = 0): Record<string, Schema> | null {
  if (!schema || depth > 8) return null;
  const shape = (schema as { shape?: unknown }).shape;
  if (shape) return (typeof shape === 'function' ? (shape as () => Record<string, Schema>)() : shape) as Record<string, Schema>;
  const def = schema._def ?? {};
  for (const key of ['schema', 'innerType', 'in', 'type']) {
    const found = shapeOf(def[key] as Schema, depth + 1);
    if (found) return found;
  }
  const options = (def.options as Schema[] | undefined) ?? [];
  const merged: Record<string, Schema> = {};
  for (const option of options) Object.assign(merged, shapeOf(option, depth + 1) ?? {});
  return Object.keys(merged).length ? merged : null;
}

/** A prop's type, in a word: number, string, boolean, one of a few values. */
function typeLabel(schema: Schema, depth = 0): string {
  const def = schema?._def ?? {};
  const name = String(def.typeName ?? '');
  if (depth < 6 && ['ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodEffects', 'ZodPipeline', 'ZodBranded', 'ZodCatch'].includes(name)) {
    return typeLabel((def.innerType ?? def.schema ?? def.in) as Schema, depth + 1);
  }
  if (name === 'ZodEnum') return ((def.values as string[]) ?? []).slice(0, 4).join(' | ');
  if (name === 'ZodLiteral') return JSON.stringify(def.value);
  if (name === 'ZodUnion') return ((def.options as Schema[]) ?? []).map((option) => typeLabel(option, depth + 1)).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(' | ');
  return name.replace(/^Zod/, '').toLowerCase() || 'value';
}

/** The tag the cursor is inside, when it's within an element's attributes (not in a string or `{…}`). */
function openTag(text: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  let tag: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (tag && (c === '"' || c === "'" || c === '`')) { quote = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); continue; }
    if (depth) continue;
    if (c === '<') {
      const match = /^<([a-z][\w]*)/.exec(text.slice(i, i + 40));
      tag = match ? match[1] : null;
    } else if (c === '>') tag = null;
  }
  return depth || quote ? null : tag;
}

const ELEMENTS: Completion[] = Object.keys(TAGS).map((tag) => ({ label: tag, type: 'type', detail: 'element', info: DESCRIPTIONS[tag] }));

export async function tscircuitCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const tag = context.matchBefore(/<[a-z]*$/);
  if (tag) return { from: tag.from + 1, options: ELEMENTS, validFor: /^[a-z]*$/ };
  const word = context.matchBefore(/(?:^|\s)[A-Za-z]*$/);
  if (!word) return null;
  const start = word.text.match(/^\s/) ? word.from + 1 : word.from;
  if (start === context.pos && !context.explicit) return null;
  const before = context.state.sliceDoc(Math.max(0, context.pos - 4000), context.pos);
  const element = openTag(before);
  const schemaName = element ? TAGS[element] : undefined;
  if (!schemaName) return null;
  const props = await load();
  const shape = shapeOf(props[schemaName] as Schema);
  if (!shape) return null;
  const options: Completion[] = Object.entries(shape).filter(([key]) => key !== 'children' && key !== 'key').map(([key, schema]) => {
    const kind = typeLabel(schema);
    const quoted = /^(string|"|')/.test(kind) && !/number|boolean/.test(kind);
    return { label: key, type: 'property', detail: kind, apply: quoted ? `${key}=""` : `${key}={}`, boost: /^(name|footprint|pcbX|pcbY|resistance|capacitance|from|to|width|height)$/.test(key) ? 2 : 0 };
  });
  return { from: start, options, validFor: /^[A-Za-z]*$/ };
}

/**
 * The part on the pointer while placing (SchematicView, the Place tool): tscircuit's own schematic symbol for it, from
 * the `schematic-symbols` package circuit-to-svg draws with, with its name and value filled in. Chips, connectors and
 * the rest get a clean labelled box. Drawn in the drawing's own SVG units through its real-to-screen transform, at the
 * schematic origin; the canvas moves it with a translate.
 */
import type { PlacingPart } from './schematicEdits';

/** Real (schematic units) → SVG units: tscircuit's `data-real-to-screen-transform` matrix(a, b, c, d, e, f). */
export type Matrix = [number, number, number, number, number, number];

type Primitive =
  | { type: 'path'; points: { x: number; y: number }[]; fill?: boolean }
  | { type: 'circle'; x: number; y: number; radius: number; fill?: boolean }
  | { type: 'text'; text: string; x: number; y: number; anchor?: string };
type SchematicSymbol = { primitives: Primitive[]; size: { width: number; height: number } };

/** The symbol tscircuit draws each part with, in its default orientation. */
const SYMBOL_OF: Record<string, string> = {
  resistor: 'boxresistor_right', capacitor: 'capacitor_right', inductor: 'inductor_right', diode: 'diode_right', led: 'led_right',
  crystal: 'crystal_right', resonator: 'resonator_horz', fuse: 'fuse_horz', battery: 'battery_horz', potentiometer: 'potentiometer_horz',
  pushbutton: 'push_button_normally_open_momentary_horz', switch: 'spst_switch_right', transistor: 'npn_bipolar_transistor_horz',
  mosfet: 'n_channel_e_mosfet_transistor_horz', testpoint: 'testpoint_right', opamp: 'opamp_no_power_right',
};

let symbols: Promise<Record<string, SchematicSymbol>> | null = null;
/** The symbol library, loaded the first time a part is placed (it's large). */
export function loadSymbols(): Promise<Record<string, SchematicSymbol>> {
  symbols ??= import('schematic-symbols').then((module) => module.symbols as unknown as Record<string, SchematicSymbol>);
  return symbols;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) => {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
};

/** Where `anchor` (tscircuit's middle_bottom, left, …) puts text: SVG text-anchor and baseline. */
function anchored(anchor = 'center'): { textAnchor: string; baseline: string } {
  const [vertical, horizontal] = anchor.includes('_') ? anchor.split('_') : ['middle', anchor];
  const h = horizontal ?? anchor;
  return {
    textAnchor: h === 'left' ? 'start' : h === 'right' ? 'end' : 'middle',
    baseline: vertical === 'top' || anchor.endsWith('_top') ? 'hanging' : vertical === 'bottom' || anchor.endsWith('_bottom') ? 'auto' : 'central',
  };
}

/**
 * The ghost for `part`, drawn around the schematic origin in SVG units (move it with `translate`). `symbolsLoaded` is
 * the library (null until it has loaded: a box stands in).
 */
export function buildGhost(part: PlacingPart, matrix: Matrix, library: Record<string, SchematicSymbol> | null): SVGGElement {
  const [a, b, c, d] = matrix;
  const at = (x: number, y: number) => ({ x: a * x + c * y, y: b * x + d * y });
  const unit = Math.abs(a) || 1;
  const group = el('g', { class: 'steve-place-ghost', 'data-tag': part.tag });
  const reference = part.name ?? part.label;
  const symbol = library ? library[SYMBOL_OF[part.tag] ?? ''] : undefined;
  const text = (content: string, x: number, y: number, anchor: string, size = 0.13) => {
    const p = at(x, y);
    const { textAnchor, baseline } = anchored(anchor);
    const node = el('text', { x: p.x, y: p.y, 'text-anchor': textAnchor, 'dominant-baseline': baseline, 'font-size': size * unit, class: 'steve-place-label' });
    node.textContent = content;
    group.appendChild(node);
  };
  if (symbol) {
    for (const primitive of symbol.primitives) {
      if (primitive.type === 'path') {
        const d = primitive.points.map((point, i) => { const p = at(point.x, point.y); return `${i ? 'L' : 'M'}${p.x} ${p.y}`; }).join(' ');
        group.appendChild(el('path', { d, class: primitive.fill ? 'steve-place-fill' : 'steve-place-line', 'vector-effect': 'non-scaling-stroke' }));
      } else if (primitive.type === 'circle') {
        const p = at(primitive.x, primitive.y);
        group.appendChild(el('circle', { cx: p.x, cy: p.y, r: primitive.radius * unit, class: primitive.fill ? 'steve-place-fill' : 'steve-place-line', 'vector-effect': 'non-scaling-stroke' }));
      } else if (primitive.type === 'text') {
        const content = primitive.text.replace('{REF}', reference).replace('{VAL}', part.value ?? '');
        if (content.trim()) text(content, primitive.x, primitive.y, primitive.anchor ?? 'center');
      }
    }
    return group;
  }
  // No symbol (chips, connectors, …): a box the size tscircuit gives small parts, named.
  const [w, h] = part.tag === 'chip' || part.tag === 'pinheader' || part.tag === 'connector' ? [0.8, 1] : [0.6, 0.4];
  const corner = at(-w / 2, h / 2);
  const far = at(w / 2, -h / 2);
  group.appendChild(el('rect', {
    x: Math.min(corner.x, far.x), y: Math.min(corner.y, far.y), width: Math.abs(far.x - corner.x), height: Math.abs(far.y - corner.y),
    rx: 0.03 * unit, class: 'steve-place-box', 'vector-effect': 'non-scaling-stroke',
  }));
  text(reference, 0, h / 2 + 0.06, 'middle_bottom');
  text(part.label, 0, 0, 'center', 0.1);
  return group;
}

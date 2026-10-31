/** Placing a part from the gallery (a click, or a drop on a view at a position). */
import { insertElement, type InsertSpec } from '../code/edits';
import { isPowerNet, setNetTraceWidth } from '../code/fixes';
import { parse } from '../code/source';
import type { EditResult, Target } from '../code/types';
import type { PartSpec } from './catalog';

/** Drag data type for a part dragged out of the Place gallery (the value is the element tag). */
export const PART_DRAG_TYPE = 'application/x-steve-circuit-part';

export interface PlaceOptions {
  /** Where to put it: a PCB position (relative to the board centre) and/or a schematic position. */
  at?: { pcbX?: number; pcbY?: number; schX?: number; schY?: number };
  /** The group or subcircuit to put it in (default: the board). */
  parent?: Target;
  /** Props that override the part's defaults. */
  props?: Record<string, unknown>;
}

/** A free name for parts named by a default rather than a prefix (a net called VCC → VCC, VCC2, …). */
function freeName(code: string, base: string): string {
  const used = new Set(parse(code).elements.map((element) => element.name));
  if (!used.has(base)) return base;
  let number = 2;
  while (used.has(`${base}${number}`)) number++;
  return `${base}${number}`;
}

/** Inserts the part with its defaults, a fresh name, and any position. Throws EditError like the edits do. */
export function placePart(code: string, part: PartSpec, options: PlaceOptions = {}): EditResult & { name: string | null } {
  const { name: defaultName, ...defaults } = part.defaults;
  const round = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 100) / 100);
  const at = options.at ?? {};
  const spec: InsertSpec = {
    tag: part.tag,
    parent: options.parent,
    name: part.prefix ? undefined : typeof defaultName === 'string' ? freeName(code, defaultName) : null,
    props: { ...defaults, ...options.props, pcbX: round(at.pcbX), pcbY: round(at.pcbY), schX: round(at.schX), schY: round(at.schY) },
  };
  const placed = insertElement(code, spec);
  // A label on a power or ground net: that net's traces get power width too (adds or keeps <net … nominalTraceWidth>).
  const net = spec.props?.net;
  if (part.tag === 'netlabel' && typeof net === 'string' && isPowerNet(net)) {
    const widened = setNetTraceWidth(placed.code, net);
    return { ...placed, code: widened.code, notes: [...placed.notes, ...(widened.changed ? [`${net} traces set to 0.4 mm (power width).`] : [])] };
  }
  return placed;
}

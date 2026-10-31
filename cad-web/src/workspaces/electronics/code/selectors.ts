/**
 * tscircuit selectors (docs: guides/tscircuit-essentials/port-and-net-selectors):
 * `.R1 > .pin1`, `.R1 .pin1`, `R1.pin1`, `.S1 .R1 .pin1` (into the named subcircuit S1), and `net.GND`.
 * Placement expressions name parts too: `calc(R1.maxX + 2mm)`, `U1.pin1.x`.
 */

export type Selector =
  | { kind: 'port'; path: string[]; component: string; port: string }
  | { kind: 'component'; path: string[]; component: string }
  | { kind: 'net'; net: string };

const NAME = '[A-Za-z_][A-Za-z0-9_\\-]*';
const NAME_RE = new RegExp(`^${NAME}$`);
/** Net names may start with a digit (5V, 3V3). */
const NET_NAME = '[A-Za-z0-9_][A-Za-z0-9_\\-]*';
const NET_NAME_RE = new RegExp(`^${NET_NAME}$`);

/** A valid name for a part or trace (a net's may also start with a digit). */
export const isValidName = (name: string, tag?: string) => (tag === 'net' ? NET_NAME_RE : NAME_RE).test(name);

/** Reads a selector; null if it isn't one. */
export function parseSelector(text: string): Selector | null {
  const value = text.trim();
  const net = new RegExp(`^net\\.(${NET_NAME})$`).exec(value);
  if (net) return { kind: 'net', net: net[1] };
  const dotted = new RegExp(`^(${NAME})\\.(${NAME})$`).exec(value);
  if (dotted) return { kind: 'port', path: [], component: dotted[1], port: dotted[2] };
  if (!value.startsWith('.')) return null;
  const parts = value.split(/\s*>\s*|\s+/).filter(Boolean);
  if (!parts.length || parts.some((part) => !new RegExp(`^\\.${NAME}$`).test(part))) return null;
  const names = parts.map((part) => part.slice(1));
  if (names.length === 1) return { kind: 'component', path: [], component: names[0] };
  return { kind: 'port', path: names.slice(0, -2), component: names[names.length - 2], port: names[names.length - 1] };
}

/** `.R1 > .pin1`, or `.S1 .R1 > .pin1` for a part inside the named subcircuit S1. */
export function portSelector(component: string, port: string, path: string[] = []): string {
  return [...path.map((name) => `.${name}`), `.${component} > .${port}`].join(' ');
}

export const netSelector = (net: string) => `net.${net}`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Patterns that name a part inside a string:
 * - `.R1` as a selector segment (start, space or `>` before it; end, space, `>` or `)` after it);
 * - `R1.` as a dotted reference (`R1.pin1`, `calc(R1.maxX …)`, `"U1." + pin`): not after a word character or a dot,
 *   so `net.R1` and `XR1.pin` aren't matched.
 */
function referencePatterns(name: string): RegExp[] {
  const quoted = escape(name);
  return [new RegExp(`(?<=^|[\\s>(,])\\.${quoted}(?=$|[\\s>.),\\]])`, 'g'), new RegExp(`(?<![\\w.\\-])${quoted}(?=\\.)`, 'g')];
}

/** Whether a string refers to the part `name`. */
export function referencesName(text: string, name: string): boolean {
  return referencePatterns(name).some((pattern) => pattern.test(text));
}

/** Renames every reference to `from` in a string. */
export function renameReferences(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  const [segment, dotted] = referencePatterns(from);
  out = out.replace(segment, () => { count++; return `.${to}`; });
  out = out.replace(dotted, () => { count++; return to; });
  return { text: out, count };
}

// ---- Circuit JSON → names and selectors ----

type Row = { type: string; [key: string]: unknown };

/** Lookup tables over a Circuit JSON array, built once per circuit. */
export class CircuitLookup {
  readonly rows: Row[];
  private readonly byId = new Map<string, Row>();
  constructor(circuit: readonly unknown[]) {
    this.rows = circuit as Row[];
    for (const row of this.rows) {
      for (const [key, value] of Object.entries(row)) {
        // Each element's own id is `<type>_id`.
        if (key === `${row.type}_id` && typeof value === 'string') this.byId.set(value, row);
      }
    }
  }
  get(id: string | null | undefined): Row | undefined { return id ? this.byId.get(id) : undefined; }
  ofType(type: string): Row[] { return this.rows.filter((row) => row.type === type); }

  /** The source component behind a source, PCB or schematic component id. */
  sourceComponent(id: string): Row | undefined {
    const row = this.get(id);
    if (!row) return undefined;
    if (row.type === 'source_component') return row;
    return this.get(row.source_component_id as string | undefined);
  }

  /** Names of the named subcircuits around a source group, outermost first (the board's own subcircuit excluded). */
  subcircuitPath(sourceGroupId: string | undefined): string[] {
    const path: string[] = [];
    let group = this.get(sourceGroupId);
    while (group) {
      const parent = this.get(group.parent_source_group_id as string | undefined);
      if (group.is_subcircuit && parent && typeof group.name === 'string') path.unshift(group.name);
      group = parent;
    }
    return path;
  }

  /** Every named group around a source group, outermost first: to tell apart parts with the same name. */
  groupPath(sourceGroupId: string | undefined): string[] {
    const path: string[] = [];
    let group = this.get(sourceGroupId);
    while (group) {
      if (typeof group.name === 'string') path.unshift(group.name);
      group = this.get(group.parent_source_group_id as string | undefined);
    }
    return path;
  }

  /** A port's selector from the board's subcircuit: `.R1 > .pin1`, `.S1 .R1 > .pin1`. */
  portSelector(sourcePortId: string): string | null {
    const port = this.get(sourcePortId);
    if (!port || port.type !== 'source_port') return null;
    const component = this.get(port.source_component_id as string | undefined);
    if (!component || typeof component.name !== 'string' || typeof port.name !== 'string') return null;
    return portSelector(component.name, port.name, this.subcircuitPath(component.source_group_id as string | undefined));
  }
}

/**
 * JLCPCB parts (GET /v1/electronics/parts, jlcsearch via tscircuit): ranking for people (in-stock Basic parts first:
 * they assemble without a loading fee) and the tscircuit element a result becomes. A result's `footprint`
 * (`jlcpcb:C25744`) and `supplierPartNumbers` pin the exact part; its value is read from the description so the
 * schematic and BOM say "10kΩ" rather than a part number.
 */

export interface JlcPart {
  lcsc: string;
  mpn: string;
  package: string;
  description: string;
  stock: number;
  in_stock: boolean;
  unit_price_usd: number | null;
  price_breaks?: { quantity?: number; qty?: number; price_usd?: number; price?: number }[];
  basic: boolean;
  preferred: boolean;
  assembly?: string;
  /** `jlcpcb:C25744`: tscircuit fetches the footprint for it. */
  footprint: string;
  /** The props that pin it, as TSX. */
  tsx?: string;
  url?: string;
  category?: string | null;
  /** When the stock figure was read (the index is refreshed nightly). */
  stock_as_of?: string | null;
  stock_source?: string | null;
}

export interface JlcSearch {
  parts: JlcPart[];
  category?: string | null;
  source?: string;
  note?: string;
}

/** In-stock first, then Basic, then Preferred (no loading fee); otherwise the search's own order. */
export function rankJlcParts(parts: readonly JlcPart[]): JlcPart[] {
  const score = (part: JlcPart) => (part.in_stock ? 4 : 0) + (part.basic ? 2 : 0) + (part.preferred ? 1 : 0);
  return parts.map((part, index) => ({ part, index })).sort((a, b) => score(b.part) - score(a.part) || a.index - b.index).map((entry) => entry.part);
}

const NUMBER = '(\\d+(?:\\.\\d+)?)';
const micro = (unit: string) => (unit === 'µ' || unit === 'μ' ? 'u' : unit);

/** "10kΩ" → "10k", "4.7KΩ" → "4.7k", "100Ω" → "100", "1MΩ" → "1M". */
export function resistanceOf(text: string): string | null {
  const match = new RegExp(`${NUMBER}\\s*([kKmMG]?)\\s*(?:Ω|ohms?\\b)`, 'i').exec(text);
  if (!match) return null;
  // tscircuit reads m as milli and M as mega, as the datasheet does; only K is spelled k.
  return `${match[1]}${match[2] === 'K' ? 'k' : match[2]}`;
}

export function capacitanceOf(text: string): string | null {
  const match = new RegExp(`${NUMBER}\\s*(p|n|u|µ|μ|m)F\\b`).exec(text);
  return match ? `${match[1]}${micro(match[2])}F` : null;
}

export function inductanceOf(text: string): string | null {
  const match = new RegExp(`${NUMBER}\\s*(n|u|µ|μ|m)H\\b`).exec(text);
  return match ? `${match[1]}${micro(match[2])}H` : null;
}

export function frequencyOf(text: string): string | null {
  const match = new RegExp(`${NUMBER}\\s*(k|M|G)Hz\\b`).exec(text);
  return match ? `${match[1]}${match[2]}Hz` : null;
}

const COLORS = ['warm white', 'cold white', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'amber', 'pink', 'purple', 'violet', 'rgb', 'infrared', 'uv'];
export function colorOf(text: string): string | null {
  const emitted = /Emitted Colou?r:\s*([A-Za-z ]+?)(?:;|$)/i.exec(text)?.[1]?.trim().toLowerCase();
  if (emitted) return emitted;
  const lower = text.toLowerCase();
  return COLORS.find((color) => new RegExp(`\\b${color}\\b`).test(lower)) ?? null;
}

export interface JlcElement {
  tag: string;
  /** The element's props: its value, the pinned footprint and supplier part, and the manufacturer part number. */
  props: Record<string, unknown>;
}

/** The tscircuit element a JLCPCB result becomes: a typed part when its kind and value are clear, else a chip. */
export function elementForJlcPart(part: JlcPart): JlcElement {
  const text = `${part.category ?? ''} ${part.description} ${part.mpn}`;
  const category = (part.category ?? '').toLowerCase();
  const pin = { footprint: part.footprint, supplierPartNumbers: { jlcpcb: [part.lcsc] }, manufacturerPartNumber: part.mpn };
  const typed = (tag: string, values: Record<string, unknown> | null): JlcElement | null => (values ? { tag, props: { ...values, ...pin } } : null);
  const value = <T,>(found: T | null, make: (value: T) => Record<string, unknown>) => (found === null ? null : make(found));

  const rules: [boolean, () => JlcElement | null][] = [
    [/potentiometer|trimmer/i.test(text), () => typed('potentiometer', value(resistanceOf(text), (maxResistance) => ({ maxResistance })))],
    [category === 'resistors' || /\bResistance:|\bresistors?\b/i.test(text), () => typed('resistor', value(resistanceOf(text), (resistance) => ({ resistance })))],
    [category === 'capacitors' || /capacitor|\bMLCC\b/i.test(text), () => typed('capacitor', value(capacitanceOf(text), (capacitance) => ({ capacitance })))],
    [category === 'leds' || /light emitting|\bLEDs?\b|Emitted Colou?r/i.test(text), () => typed('led', { ...(colorOf(part.description) ? { color: colorOf(part.description) } : {}) })],
    [category === 'inductors' || (/\binductors?\b/i.test(text) && !/ferrite/i.test(text)), () => typed('inductor', value(inductanceOf(text), (inductance) => ({ inductance })))],
    [/\bcrystals?\b/i.test(text) && !/oscillators? \(|active/i.test(text), () => typed('crystal', value(frequencyOf(text), (frequency) => ({ frequency, loadCapacitance: capacitanceOf(text) ?? '18pF' })))],
    [/\bMOSFETs?\b/i.test(text), () => typed('mosfet', { channelType: /P-?channel/i.test(text) ? 'p' : 'n', mosfetMode: 'enhancement' })],
    [/\b(bipolar|BJT|NPN|PNP)\b/i.test(text), () => typed('transistor', { type: /\bPNP\b/i.test(text) ? 'pnp' : 'npn' })],
    [category === 'diodes' || /\b(diodes?|rectifiers?|schottky|zener|TVS)\b/i.test(text), () => typed('diode', {})],
    [/\bfuses?\b/i.test(text), () => typed('fuse', value(new RegExp(`${NUMBER}\\s*(m?A)\\b`).exec(text), (match) => ({ currentRating: `${match[1]}${match[2]}` })))],
  ];
  for (const [applies, make] of rules) {
    if (!applies) continue;
    const element = make();
    if (element) return element;
  }
  return { tag: 'chip', props: pin };
}

/** The unit price as people read it: $0.0005, $0.20, $5.14. */
export function formatPrice(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—';
  return usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toPrecision(2)}`;
}

/** Stock as people read it: 20.7M, 735k, 1,204. */
export function formatStock(stock: number): string {
  if (stock >= 1e6) return `${(stock / 1e6).toFixed(stock >= 1e7 ? 0 : 1)}M`;
  if (stock >= 1e4) return `${Math.round(stock / 1e3)}k`;
  return stock.toLocaleString('en-US');
}

const SCALE: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** A number written plainly (no exponent): 1e-7 → "0.0000001", 4700 → "4700". */
const plain = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(15).replace(/\.?0+$/, ''));

/**
 * A search with its values as plain numbers and the kind they imply, the way the parts index matches them best:
 * "4.7k 0603" → "4700 0603 resistor", "100nF 0402" → "0.0000001 0402 capacitor". The kind word keeps a value from
 * matching the wrong family (4.7k alone also finds 47kΩ); a query that names a kind keeps it. Package names
 * ("0402"), plain numbers and words stay as typed.
 */
export function plainQuery(text: string): string {
  let kind: string | null = null;
  const tokens = text.split(/\s+/).filter(Boolean).map((token) => {
    const match = /^(\d+(?:\.\d+)?)([pnuµμmkKMG])?(Ω|ohms?|F|H)?$/.exec(token);
    if (!match || (!match[2] && !match[3])) return token;
    const [, number, prefix, unit] = match;
    if (prefix === 'm' && !unit) return token;  // "5m" could be anything.
    kind ??= unit === 'F' ? 'capacitor' : unit === 'H' ? 'inductor' : unit || /^[kKMG]$/.test(prefix ?? '') ? 'resistor' : null;
    return plain(Number(number) * (prefix ? SCALE[prefix] : 1));
  });
  const named = /\b(resistors?|res|capacitors?|caps?|inductors?|ferrite|led|diode|crystal|fuse|mosfet|transistor)\b/i.test(text);
  if (kind && !named) tokens.push(kind);
  return tokens.join(' ');
}

/** What to search JLCPCB for to source an element already in the circuit (its value, package and kind). */
export function jlcQueryFor(tag: string, props: Record<string, unknown>): string {
  const text = (key: string) => (typeof props[key] === 'string' || typeof props[key] === 'number' ? String(props[key]) : '');
  const footprint = text('footprint');
  const pkg = footprint && !footprint.startsWith('jlcpcb:') ? footprint.split('_')[0] : '';
  const mpn = text('manufacturerPartNumber') || text('mpn');
  if (mpn) return mpn;
  const parts: Record<string, string[]> = {
    resistor: [text('resistance'), pkg, 'resistor'],
    capacitor: [text('capacitance'), pkg, 'capacitor'],
    inductor: [text('inductance'), pkg, 'inductor'],
    led: [text('color'), 'LED', pkg],
    diode: [pkg, 'diode'],
    crystal: [text('frequency'), 'crystal'],
    mosfet: [props.channelType === 'p' ? 'P-channel' : 'N-channel', 'MOSFET', pkg],
    transistor: [String(props.type ?? 'NPN').toUpperCase(), 'transistor', pkg],
    fuse: [text('currentRating'), 'fuse', pkg],
    pushbutton: ['tactile switch'],
    pinheader: [`${text('pinCount')} pin header`],
  };
  return (parts[tag] ?? [pkg, tag]).filter(Boolean).join(' ').trim();
}

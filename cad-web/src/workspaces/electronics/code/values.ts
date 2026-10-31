/**
 * Literal values in TSX: reading the ones written as literals, and writing values back the way tscircuit code
 * usually spells them (`resistance="10k"`, `pcbX={2.5}`, `pinLabels={{ pin1: "VCC" }}`).
 */
import type { BabelNode } from './parser';

export type Static = { static: true; value: unknown } | { static: false };

const NOT_STATIC: Static = { static: false };

/** The value of an expression written as a literal (strings, numbers, booleans, null, static templates, objects, arrays). */
export function staticValue(node: BabelNode | null | undefined): Static {
  if (!node) return NOT_STATIC;
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return { static: true, value: node.value };
    case 'NullLiteral':
      return { static: true, value: null };
    case 'UnaryExpression': {
      const operator = node.operator as string;
      const argument = node.argument as BabelNode;
      if ((operator === '-' || operator === '+') && argument.type === 'NumericLiteral') {
        const value = argument.value as number;
        return { static: true, value: operator === '-' ? -value : value };
      }
      return NOT_STATIC;
    }
    case 'TemplateLiteral': {
      const expressions = node.expressions as BabelNode[];
      const quasis = node.quasis as { value: { cooked: string | null } }[];
      if (expressions.length || quasis.length !== 1 || quasis[0].value.cooked === null) return NOT_STATIC;
      return { static: true, value: quasis[0].value.cooked };
    }
    case 'ArrayExpression': {
      const out: unknown[] = [];
      for (const element of node.elements as (BabelNode | null)[]) {
        const item = staticValue(element);
        if (!element || !item.static) return NOT_STATIC;
        out.push(item.value);
      }
      return { static: true, value: out };
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const property of node.properties as BabelNode[]) {
        if (property.type !== 'ObjectProperty' || property.computed) return NOT_STATIC;
        const key = property.key as BabelNode;
        const name = key.type === 'Identifier' ? (key.name as string) : key.type === 'StringLiteral' || key.type === 'NumericLiteral' ? String(key.value) : null;
        const item = staticValue(property.value as BabelNode);
        if (name === null || !item.static) return NOT_STATIC;
        out[name] = item.value;
      }
      return { static: true, value: out };
    }
    default:
      return NOT_STATIC;
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A number written the short way, without float noise or -0. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('Not a finite number.');
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A JavaScript literal for a value: `"text"`, `12`, `{ pin1: "VCC" }`, `["a", "b"]`. */
export function formatJs(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatJs).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}: ${formatJs(item)}`).join(', ')} }`;
  }
  throw new TypeError(`Can't write a ${typeof value} as code.`);
}

/**
 * An attribute value as JSX writes it, or null for a bare flag (`true`). Strings go in quotes unless JSX can't hold
 * them there (a double quote or a line break): JSX attribute strings have no escapes, so those go in braces.
 */
export function formatAttrValue(value: unknown): string | null {
  if (value === true) return null;
  if (typeof value === 'string') return /["\n\r]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`;
  return `{${formatJs(value)}}`;
}

/** `name="value"`, `name={2}`, or a bare `name` for `true`. */
export function formatAttr(name: string, value: unknown): string {
  const written = formatAttrValue(value);
  return written === null ? name : `${name}=${written}`;
}

/**
 * `supplierPartNumbers` in the form tscircuit accepts: every supplier maps to a list (`{ jlcpcb: ["C25744"] }`).
 * The string form (`{ jlcpcb: "C25744" }`, shown in older tscircuit docs) makes tscircuit drop the whole part.
 */
export function supplierPartsArrayForm(value: unknown): { value: unknown; repaired: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value, repaired: false };
  let repaired = false;
  const out: Record<string, unknown> = {};
  for (const [supplier, parts] of Object.entries(value as Record<string, unknown>)) {
    if (typeof parts === 'string') { out[supplier] = parts.trim() ? [parts.trim()] : []; repaired = true; } else out[supplier] = parts;
  }
  return { value: repaired ? out : value, repaired };
}

/** A length in millimetres from a value as tscircuit accepts it (`5`, `"5mm"`, `"0.2in"`, `"5"`); null if it isn't one. */
export function lengthMm(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(-?\d+(?:\.\d+)?|-?\.\d+)\s*(mm|cm|m|in|mil)?\s*$/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  const scale = { mm: 1, cm: 10, m: 1000, in: 25.4, mil: 0.0254 }[(match[2] ?? 'mm') as 'mm'];
  return number * scale;
}

/** An angle in degrees from `90`, `"90"` or `"90deg"`; null if it isn't one. */
export function angleDeg(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(deg)?\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

/** Writes a length in the style the code already uses: `"5mm"` stays a string with mm, a number stays a number. */
export function lengthInStyle(mm: number, previous: unknown, fallback: 'number' | 'mm' = 'number'): number | string {
  const rounded = Math.round(mm * 100) / 100;
  const asString = typeof previous === 'string' ? /mm\s*$/.test(previous) || !/[a-z]/i.test(previous) : previous === undefined && fallback === 'mm';
  return asString ? `${formatNumber(rounded)}mm` : Number(formatNumber(rounded));
}

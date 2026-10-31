/**
 * Typed lengths: `2` in the units the field shows, `1in`, `1"`, `2'`, `2 ft`, `3cm`, `0.5 m`, `10mm` in their own,
 * also inside arithmetic (`width + 1in`, `2*1in`). Models and their code are always millimetres, so a unit never
 * reaches the code: `lengthCode` rewrites what's typed to the millimetre form the server's expression subset accepts.
 *
 * A plain number, or arithmetic of plain numbers (`2`, `1/2`), is in the field's units (the units chip, for sketch
 * sizes and dimensions; millimetres elsewhere). Once what's typed has a unit or a parameter in it, its plain numbers are
 * read as the code reads them: factors (`width / 2`) or millimetres (`1in + 3`).
 */
import { arithmetic } from './arithmetic';
import { MM_PER_INCH, type Units } from './format';

/** Millimetres per unit, as written into code. */
export const LENGTH_UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: MM_PER_INCH, '"': MM_PER_INCH, ft: 304.8, "'": 304.8 };

/** Said when a length unit is typed where a value is an angle. */
export const ANGLE_UNITS = 'Angles are in degrees.';

/** How to type a length, for hints and errors. */
export const lengthHint = (units: Units = 'mm') =>
  `Type a number (${units}), a length like ${units === 'in' ? '10mm' : '1in'}, or an expression of parameters, like width / 2.`;

// A number (not part of a name) right after which, with or without a space, comes a unit that isn't the start of a
// longer name: `1in`, `1 in`, `1e1mm`; not `x1in`, `1inch`. Units are only units there, so `m` stays a parameter name.
const QUANTITY = /(?<![\w.])(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)\s*(mm|cm|ft|in|m|"|')(?![\w"'])/gi;
const NUMBER = /(?<![\w.])(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/g;

/** Whether the text has a length with a unit in it. */
export const hasLengthUnit = (text: string) => new RegExp(QUANTITY.source, 'i').test(text);

const millimetres = (value: number) => String(Math.round(value * 1e6) / 1e6 || 0);

/**
 * The text as millimetre code. Plain arithmetic: as typed in millimetres, or its value in mm when the field shows
 * inches (`2` → `50.8`). With units: a plain number when it holds no names (`1in` → `25.4`, `1in + 3mm` → `28.4`,
 * rounded to 1e-6 so inch values stay exact), otherwise each quantity in place (`width + 1in` → `width + (1 * 25.4)`).
 * Anything else (names alone, a misplaced unit like `in` or `1 in in`) is left for the parser to read or refuse.
 */
export function lengthCode(text: string, units: Units = 'mm'): string {
  const source = text.trim();
  if (!hasLengthUnit(source)) {
    const plain = units === 'in' ? arithmetic(source) : null;
    return plain === null ? source : millimetres(plain * MM_PER_INCH);
  }
  const code = source.replace(QUANTITY, (_, number: string, unit: string) => {
    const factor = LENGTH_UNITS[unit.toLowerCase()];
    return factor === 1 ? number : `(${number} * ${factor})`;
  });
  if (/[A-Za-z_]/.test(code.replace(NUMBER, ''))) return code;
  const value = arithmetic(code);
  return value === null ? code : millimetres(value);
}

/**
 * Writing numbers and strings as Python source. Kept free of the API client so code that only emits Python
 * (the sketch model) loads without it, e.g. in the browser ↔ runtime sketch parity test under Node.
 */

/** Full precision, shortest round-trip form: sketches restart the solver from these numbers. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Can't write ${value} into a design.`);
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export function pyString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

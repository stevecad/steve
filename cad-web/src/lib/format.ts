export const pretty = (name: string) => name.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

export function num(value: number | undefined | null, digits = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) < 10 ** -digits / 2 ? 0 : value;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export const mm = (value: number | undefined | null, digits = 2) => `${num(value, digits)} mm`;
export const mm2 = (value: number | undefined | null) => `${num(value, 1)} mm²`;
export const mm3 = (value: number | undefined | null) => `${num(value, 1)} mm³`;

/** Units for lengths shown to a person (Settings → Display › Units, the status bar's chip). Models are always mm. */
export type Units = 'mm' | 'in';
export const MM_PER_INCH = 25.4;
/** A length in mm as a number in `units`. */
export const inUnits = (value: number, units: Units) => (units === 'in' ? value / MM_PER_INCH : value);
/** Places for a length: inches show four (a tenth of a thou), as CAD readouts in inches do. */
export const lengthDigits = (units: Units, mmDigits = 2) => (units === 'in' ? 4 : mmDigits);
/** A length (mm) as a number in `units`, without the unit. */
export const lengthNum = (value: number | undefined | null, units: Units, mmDigits = 2) =>
  num(value === undefined || value === null ? value : inUnits(value, units), lengthDigits(units, mmDigits));
/** 25.4 → "25.4 mm" or "1 in". */
export const lengthText = (value: number | undefined | null, units: Units, mmDigits = 2) => `${lengthNum(value, units, mmDigits)} ${units}`;
/** mm² → "… mm²" or "… in²". */
export const areaText = (value: number | undefined | null, units: Units, mmDigits = 1) =>
  units === 'in' ? `${num(value === undefined || value === null ? value : value / MM_PER_INCH ** 2, 4)} in²` : `${num(value, mmDigits)} mm²`;
/** mm³ → "… mm³" or "… in³". */
export const volumeText = (value: number | undefined | null, units: Units, mmDigits = 1) =>
  units === 'in' ? `${num(value === undefined || value === null ? value : value / MM_PER_INCH ** 3, 4)} in³` : `${num(value, mmDigits)} mm³`;

export function mass(grams: number): string {
  if (!Number.isFinite(grams)) return '—';
  if (grams >= 1000) return `${num(grams / 1000, 3)} kg`;
  if (grams >= 1) return `${num(grams, 2)} g`;
  return `${num(grams * 1000, 1)} mg`;
}

export function relativeTime(iso: string): string {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 45) return 'just now';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return format.format(-Math.round(seconds / 3600), 'hour');
  if (seconds < 604800) return format.format(-Math.round(seconds / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
export const displayShortcut = (shortcut?: string) => shortcut?.replace('Mod', modKey);

/** 950 → "950", 12_345 → "12.3k", 2_400_000 → "2.4M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Estimated USD from a decimal string; cents below a dollar keep three digits. */
export function usd(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
}

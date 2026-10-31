/**
 * Volumes the checks bound (docs/MANUFACTURING_STOCK_INSPECTION.md): material at least `guaranteed` and at most
 * `possible`. Where the inspection ran out of evaluations or resolution, the two differ and the truth lies anywhere
 * between: the words keep it a range, never one number. Rounded outwards (the lower bound down, the upper up), so the
 * range shown always contains the one the check proved. Pure functions (tests/cam_volumes_test.mjs runs them in Node).
 */

export interface VolumeBounds { guaranteed: number; possible: number }

/** Decimals that show a volume of this size usefully: 3 below 10 mm³, 1 below 1000 mm³, else whole mm³. */
const decimalsFor = (value: number) => (value < 10 ? 3 : value < 1000 ? 1 : 0);
const down = (value: number, digits: number) => Math.floor(value * 10 ** digits + 1e-9) / 10 ** digits;
const up = (value: number, digits: number) => Math.ceil(value * 10 ** digits - 1e-9) / 10 ** digits;
const show = (value: number, digits: number) => value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** How the check bounds it: none, exact, at most, or between. */
export type VolumeKind = 'none' | 'exact' | 'up_to' | 'between';

export function volumeKind(bounds: VolumeBounds): VolumeKind {
  if (!(bounds.possible > 0)) return 'none';
  if (bounds.guaranteed >= bounds.possible) return 'exact';
  return bounds.guaranteed > 0 ? 'between' : 'up_to';
}

/**
 * The volume in words: "none", "12.3 mm³" (proved exactly), "up to 12.3 mm³" (none proved present), or
 * "1.2–12.3 mm³" (at least the first, at most the second).
 */
export function volumeWords(bounds: VolumeBounds): string {
  const kind = volumeKind(bounds);
  if (kind === 'none') return 'none';
  const digits = decimalsFor(bounds.possible);
  if (kind === 'exact') return `${show(Number(bounds.possible.toFixed(digits)) || up(bounds.possible, digits), digits)} mm³`;
  const high = up(bounds.possible, digits);
  if (kind === 'up_to') return `up to ${show(high, digits)} mm³`;
  // The lower bound in the upper's decimals; one that rounds down to zero still says some is certain.
  const low = down(bounds.guaranteed, digits);
  return low > 0 ? `${show(low, digits)}–${show(high, digits)} mm³` : `more than 0, up to ${show(high, digits)} mm³`;
}

/** What a range means, for its tooltip. */
export function volumeMeaning(bounds: VolumeBounds): string {
  switch (volumeKind(bounds)) {
    case 'none': return 'The check proved there is none.';
    case 'exact': return 'The check proved this amount.';
    case 'up_to': return 'The check couldn’t prove any is there, nor that none is: at most this much.';
    default: return 'The check proved at least the first amount and at most the second; what it couldn’t resolve lies between.';
  }
}

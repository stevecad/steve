/**
 * Results in the units an engineer reads: the solver works in SI (Pa, m, K); the app shows MPa, mm,
 * °C, N, W/m², m/s. Summary keys like `max_von_mises_pa` become "Max von Mises stress · 65.0 MPa".
 */

export interface Shown { value: string; unit: string; title?: string }

const sig = (value: number, digits = 3) => {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-3) return value.toExponential(2);
  return Number(value.toPrecision(digits)).toLocaleString(undefined, { maximumFractionDigits: 6 });
};

/** A value in SI `unit` (as the solver reports it) converted for display. `flow`: pressures stay in Pa/kPa. */
export function show(value: number, unit: string | null | undefined, flow = false): Shown {
  switch (unit) {
    case 'Pa':
      if (flow) return Math.abs(value) >= 1e4 ? { value: sig(value / 1e3), unit: 'kPa' } : { value: sig(value), unit: 'Pa' };
      return { value: sig(value / 1e6), unit: 'MPa' };
    case 'm': return { value: sig(value * 1e3), unit: 'mm' };
    case 'K': return { value: sig(value - 273.15), unit: '°C', title: `${sig(value, 5)} K` };
    case 'W/m²': case 'W/m^2': return { value: sig(value), unit: 'W/m²' };
    case 'm/s': return { value: sig(value), unit: 'm/s' };
    case 'N': return { value: sig(value), unit: 'N' };
    case 'Hz': return { value: sig(value, 4), unit: 'Hz' };
    case 'W': return { value: sig(value), unit: 'W' };
    case '': case '1': case null: case undefined: return { value: sig(value), unit: '' };
    default: return { value: sig(value), unit };
  }
}

/** A value in SI `unit` as the number shown in `toUnit` (one of show()'s display units). */
export function convert(value: number, unit: string | null | undefined, toUnit: string): number {
  if (unit === 'Pa') return toUnit === 'MPa' ? value / 1e6 : toUnit === 'kPa' ? value / 1e3 : value;
  if (unit === 'm') return value * 1e3;
  if (unit === 'K') return value - 273.15;
  return value;
}

/** The inverse: a number typed in display unit `fromUnit` back to SI `unit`. */
export function toSI(value: number, unit: string | null | undefined, fromUnit: string): number {
  if (unit === 'Pa') return fromUnit === 'MPa' ? value * 1e6 : fromUnit === 'kPa' ? value * 1e3 : value;
  if (unit === 'm') return value / 1e3;
  if (unit === 'K') return value + 273.15;
  return value;
}

/**
 * Legend labels at the band boundaries, highest first: `bands + 1` values from max to min in one
 * display unit and one format, so a column of them reads like a CAE legend (65.0, 58.5, … 0.0 MPa).
 */
export function scaleLabels(min: number, max: number, unit: string | null | undefined, flow = false, bands = 10): { unit: string; labels: string[] } {
  const display = show(Math.abs(max) >= Math.abs(min) ? max : min, unit, flow).unit;
  const values = Array.from({ length: bands + 1 }, (_, i) => convert(max - ((max - min) * i) / bands, unit, display));
  const largest = Math.max(...values.map(Math.abs));
  const step = Math.abs(values[0] - values[bands]) / bands;
  let format: (value: number) => string;
  if (largest >= 1e5 || (largest > 0 && largest < 1e-3)) format = (value) => (value === 0 ? '0' : value.toExponential(step > 0 && step / largest < 1e-2 ? 3 : 2));
  else {
    const decimals = step > 0 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)) + 1)) : Math.min(6, Math.max(0, 3 - Math.ceil(Math.log10(largest || 1))));
    format = (value) => {
      const text = value.toFixed(decimals);
      return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
    };
  }
  return { unit: display, labels: values.map(format) };
}

/** The display unit for a field's SI unit (legend title). */
export const displayUnit = (unit: string | null | undefined, flow = false, sample = 0) => show(sample, unit, flow).unit;

const SUFFIXES: [RegExp, string][] = [
  [/_n_m$/, 'N·m'], [/_kg_s$/, 'kg/s'], [/_w_m3$/, 'W/m³'], [/_w_m2$/, 'W/m²'], [/_m3_s$/, 'm³/s'], [/_m_s$/, 'm/s'], [/_pa$/, 'Pa'], [/_hz$/, 'Hz'], [/_k$/, 'K'], [/_kelvin$/, '°C'], [/_n$/, 'N'],
  [/_w$/, 'W'], [/_m$/, 'm'], [/_s$/, 's'], [/_kg$/, 'kg'],
];

const NAMES: Record<string, string> = {
  max_von_mises: 'Max von Mises stress', max_displacement: 'Max displacement', min_temperature: 'Min temperature',
  max_temperature: 'Max temperature', mean_temperature: 'Mean temperature', mass_weighted_temperature: 'Mass-weighted temperature',
  max_speed: 'Max flow speed', min_gauge_pressure: 'Min gauge pressure', max_gauge_pressure: 'Max gauge pressure',
  first_frequency: 'First natural frequency', returned_modes: 'Modes found', max_thermal_strain: 'Max thermal strain',
  heat_in: 'Heat in', max_courant: 'Max Courant number',
  first_load_factor: 'First buckling load factor', preload_max_von_mises: 'Max von Mises stress under the loads',
  preload_max_displacement: 'Max displacement under the loads',
  // Compressible flow: absolute pressures.
  max_mach: 'Max Mach number', min_pressure: 'Min absolute pressure', max_pressure: 'Max absolute pressure', thrust: 'Thrust',
  isp: 'Specific impulse (Isp)', inlet_mass_flow: 'Mass flow in', outlet_mass_flow: 'Mass flow out',
  // Rotating machinery.
  torque: 'Torque on the rotor', shaft_power: 'Shaft power', total_pressure_rise: 'Total pressure rise', volume_flow: 'Volume flow',
  rotor_total_pressure_rise: 'Rotor total pressure rise',
};

/** A mode as the legend names it: "Mode 1 · 125.3 Hz" (vibration) or "Mode 1 · load factor 4.21" (buckling). */
export function modeText(mode: { number: number; frequency_hz?: number; load_factor?: number }): string {
  return mode.load_factor !== undefined ? `Mode ${mode.number} · load factor ${sig(mode.load_factor, 4)}`
    : `Mode ${mode.number} · ${show(mode.frequency_hz ?? NaN, 'Hz').value} Hz`;
}

/** A summary entry (`max_von_mises_pa: 6.49e7`) as a label and a display value. */
export function summaryLine(key: string, value: number, flow = false): { label: string; shown: Shown } {
  const match = SUFFIXES.find(([pattern]) => pattern.test(key));
  const base = match ? key.replace(match[0], '') : key;
  const label = NAMES[base] ?? base.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
  if (key === 'returned_modes') return { label, shown: { value: String(value), unit: '' } };
  return { label, shown: show(value, match?.[1] ?? '', flow) };
}

/** Field names in words. */
export const FIELD_LABELS: Record<string, string> = {
  mesh: 'Mesh', von_mises: 'Von Mises stress', displacement: 'Displacement', reaction: 'Support reaction',
  temperature: 'Temperature', heat_flux: 'Heat flux', velocity: 'Flow speed', pressure: 'Gauge pressure', safety: 'Safety factor',
  mach: 'Mach number', density: 'Density',
};

/** A field's name for a result of `analysis`: compressible flow's pressure is absolute, not gauge. */
export function fieldLabel(field: string, analysis?: string): string | undefined {
  if (field === 'pressure' && analysis?.startsWith('flow_compressible')) return 'Absolute pressure';
  return FIELD_LABELS[field];
}

/** A "nice" exaggeration (1, 2, 5 × 10ⁿ) at or below `value`, never below 1. */
export function niceScale(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const multiple = [5, 2, 1].find((m) => m * power <= value) ?? 1;
  return multiple * power;
}

/**
 * A persistent face name as people read it: "part:extrude_1.side(r1.left)" → "Extrude 1 · side r1 left".
 * `names` maps feature ids to their display names; instances other than "part" lead ("Blade 2 › …").
 */
export function faceLabel(reference: string, names: Record<string, string> = {}): string {
  const colon = reference.indexOf(':');
  const instance = colon > 0 ? reference.slice(0, colon) : 'part';
  const ref = colon > 0 ? reference.slice(colon + 1) : reference;
  const prefix = instance === 'part' ? '' : `${instance.split('/').map(pretty).join(' › ')} › `;
  const match = /^([A-Za-z_][\w]*)\.(.+)$/.exec(ref);
  if (!match) return `${prefix}${ref}`;
  const [, feature, role] = match;
  const name = names[feature] ?? pretty(feature);
  const words = role
    .replace(/^side\((.+)\)$/, 'side $1').replace(/^face\((\d+)\)$/, 'face $1').replace(/^solid\((\d+)\)\.face\((\d+)\)$/, 'solid $1 face $2')
    .replace(/^end$/, 'end face').replace(/^start$/, 'start face')
    .replace(/[._()]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${prefix}${name} · ${words}`;
}

const pretty = (id: string) => id.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

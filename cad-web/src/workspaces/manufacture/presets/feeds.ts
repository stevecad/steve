/**
 * Feeds and speeds from a cutting preset. A preset is a set of LIMITS a cutter may run at in one stock material
 * (docs/MANUFACTURING_CUTTING_PRESETS.md), not a recommendation: the backend checks every posted spindle-on feed move
 * against them. These are the same dimensional relationships the checker uses (Sandvik Coromant's milling formulas):
 *
 *   surface speed  Vc = π · D · n / 1000       (m/min, D the full nominal diameter in mm, n in rpm)
 *   feed per tooth fz = vf / (n · z)            (mm, vf in mm/min, z flutes)
 *   feed per rev   fn = vf / n                  (mm)
 *
 * Everything here is a read-only hint for a person choosing values; the server's check of the actual output decides.
 * Nothing is inferred beyond the limits the preset states.
 */
import type { LibraryRecord, Pin } from '../api';

export interface PresetDefinition {
  name: string;
  material: Pin;
  cutter: Pin;
  operations: string[];
  maximum_stickout_mm: number;
  maximum_spindle_rpm?: number | null;
  maximum_feed_per_tooth_mm?: number | null;
  maximum_feed_per_revolution_mm?: number | null;
  maximum_nominal_surface_speed_m_min?: number | null;
  maximum_material_removal_rate_mm3_min?: number | null;
  description?: string;
}

export const presetOf = (record: LibraryRecord) => record.definition as unknown as PresetDefinition & LibraryRecord['definition'];

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

export const rpmForSurfaceSpeed = (speed: number, diameter: number) => (speed * 1000) / (Math.PI * diameter);
export const surfaceSpeed = (rpm: number, diameter: number) => (Math.PI * diameter * rpm) / 1000;

/** What bounds the spindle speed, in order: the preset's RPM, its surface speed at this diameter, the cutter's and the spindle's own maximum. */
export interface SpeedBound { id: 'preset_rpm' | 'surface_speed' | 'cutter' | 'spindle'; label: string; rpm: number }
/** What bounds the feed at a speed: feed per tooth (needs the flute count) and feed per revolution. */
export interface FeedBound { id: 'feed_per_tooth' | 'feed_per_revolution'; label: string; feed: number }

export interface Envelope {
  /** Highest spindle speed within every bound (null: nothing in the preset or tool limits it). */
  rpm: number | null;
  speedBounds: SpeedBound[];
  /** Highest feed at `rpm` within every bound (null: no feed limit, or no speed to apply it at). */
  feed: number | null;
  feedBounds: FeedBound[];
  /** Feed limits that couldn't be turned into mm/min (feed per tooth without a flute count). */
  missing: string[];
}

/**
 * The highest speed and feed the preset allows for a cutter of `diameter` mm with `flutes` flutes, rounded down (rpm to
 * a whole number, feed to a whole mm/min) so a rounded value never exceeds an exact limit.
 */
export function envelope(preset: PresetDefinition, diameter: number | null, flutes: number | null, limits: { cutterRpm?: number | null; spindleRpm?: number | null } = {}): Envelope {
  const speedBounds: SpeedBound[] = [];
  const presetRpm = positive(preset.maximum_spindle_rpm);
  if (presetRpm) speedBounds.push({ id: 'preset_rpm', label: 'Preset spindle speed', rpm: presetRpm });
  const vc = positive(preset.maximum_nominal_surface_speed_m_min);
  if (vc && positive(diameter)) speedBounds.push({ id: 'surface_speed', label: `Surface speed ${format(vc)} m/min at Ø${format(diameter!)} mm`, rpm: rpmForSurfaceSpeed(vc, diameter!) });
  if (positive(limits.cutterRpm)) speedBounds.push({ id: 'cutter', label: 'Cutter maximum', rpm: limits.cutterRpm! });
  if (positive(limits.spindleRpm)) speedBounds.push({ id: 'spindle', label: 'Spindle maximum', rpm: limits.spindleRpm! });
  const rpm = speedBounds.length ? Math.floor(Math.min(...speedBounds.map((bound) => bound.rpm))) : null;

  const feedBounds: FeedBound[] = [];
  const missing: string[] = [];
  const fz = positive(preset.maximum_feed_per_tooth_mm);
  const fn = positive(preset.maximum_feed_per_revolution_mm);
  if (rpm) {
    if (fz && positive(flutes)) feedBounds.push({ id: 'feed_per_tooth', label: `${format(fz)} mm per tooth × ${flutes} flutes`, feed: fz * flutes! * rpm });
    if (fn) feedBounds.push({ id: 'feed_per_revolution', label: `${format(fn)} mm per revolution`, feed: fn * rpm });
  }
  if (fz && !positive(flutes)) missing.push('feed per tooth (the cutter has no flute count)');
  const feed = feedBounds.length ? Math.floor(Math.min(...feedBounds.map((bound) => bound.feed))) : null;
  return { rpm, speedBounds, feed, feedBounds, missing };
}

export type Verdict = 'within' | 'over' | 'unknown';
export interface LimitCheck { id: string; label: string; unit: string; limit: number; actual: number | null; verdict: Verdict }

/**
 * Each of the preset's limits against a speed and feed (an operation's settings): within, over, or unknown when the
 * value can't be worked out (no flute count, no speed). The material-removal-rate limit depends on the actual cut, so it
 * is never judged here.
 */
export function checkValues(preset: PresetDefinition, diameter: number | null, flutes: number | null, values: { rpm?: number | null; feed?: number | null }): LimitCheck[] {
  const rpm = positive(values.rpm), feed = positive(values.feed);
  const out: LimitCheck[] = [];
  const add = (id: string, label: string, unit: string, limit: number | null, actual: number | null) => {
    if (limit === null) return;
    out.push({ id, label, unit, limit, actual, verdict: actual === null ? 'unknown' : actual <= limit ? 'within' : 'over' });
  };
  add('maximum_spindle_rpm', 'Spindle speed', 'rpm', positive(preset.maximum_spindle_rpm), rpm);
  add('maximum_nominal_surface_speed_m_min', 'Surface speed', 'm/min', positive(preset.maximum_nominal_surface_speed_m_min), rpm && positive(diameter) ? surfaceSpeed(rpm, diameter!) : null);
  add('maximum_feed_per_tooth_mm', 'Feed per tooth', 'mm', positive(preset.maximum_feed_per_tooth_mm), rpm && feed && positive(flutes) ? feed / (rpm * flutes!) : null);
  add('maximum_feed_per_revolution_mm', 'Feed per revolution', 'mm', positive(preset.maximum_feed_per_revolution_mm), rpm && feed ? feed / rpm : null);
  return out;
}

export function format(value: number): string {
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 1 ? 2 : 4;
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** Why a preset doesn't apply to an operation, in plain words (null: it applies). */
export function mismatch(preset: PresetDefinition, need: { cutter?: Pin | null; material?: Pin | null; operation?: string | null; stickout?: number | null }): string | null {
  if (need.cutter && preset.cutter.id !== need.cutter.id) return 'It’s for a different cutter.';
  if (need.cutter && preset.cutter.revision !== need.cutter.revision) return `It pins revision ${preset.cutter.revision} of this cutter; the tool uses revision ${need.cutter.revision}.`;
  if (need.material && preset.material.id !== need.material.id) return 'It’s for a different stock material.';
  if (need.material && preset.material.revision !== need.material.revision) return `It pins revision ${preset.material.revision} of this material; the setup uses revision ${need.material.revision}.`;
  if (need.operation && !preset.operations.includes(need.operation)) return `It doesn’t list ${need.operation} operations.`;
  if (typeof need.stickout === 'number' && need.stickout > preset.maximum_stickout_mm) return `The tool sticks out ${format(need.stickout)} mm; this preset covers up to ${format(preset.maximum_stickout_mm)} mm.`;
  return null;
}

/**
 * Choose a cutting preset for an operation and fill its speed and feed from it.
 *
 * A preset pins one cutter revision and one machining-material revision, lists the operation kinds it covers and the
 * longest stick-out it holds for, and states LIMITS (docs/MANUFACTURING_CUTTING_PRESETS.md). The picker offers the
 * presets that apply to this cutter, material and operation (the others are listed with the reason they don't), shows
 * the current settings against each limit, and "Use" sets the highest speed and feed within them (rounded down).
 * Those numbers are a hint worked out from the limits; the backend checks the actual posted program.
 *
 * Binding: the operation's `strategy.cutting_preset` names a `libraries` alias pinning the chosen preset revision, and
 * the setup's `machining_material` names an alias pinning `values.material` (the preset's own material revision).
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Gauge, Plus, TriangleAlert } from 'lucide-react';
import { Button } from '@/ui';
import { library, pinOf, type LibraryRecord, type Pin } from '../api';
import { loadLibrary, useMfg } from '../state';
import { checkValues, envelope, format, mismatch, presetOf } from './feeds';
import { newPresetFor } from './intent';
import styles from './Presets.module.css';
import { RECORD_FORMS } from '../shop/recordForms';

export interface PresetValues {
  /** The preset revision chosen (pin it as the operation's `strategy.cutting_preset` alias). */
  preset: Pin;
  /** The machining-material revision the preset pins (the setup's `machining_material` alias). */
  material: Pin;
  /** Highest whole rpm within the preset, cutter and spindle limits; null when nothing limits the speed. */
  rpm: number | null;
  /** Highest whole mm/min at that speed within the feed limits; null when the preset has no usable feed limit. */
  feed: number | null;
  /** The operation's plunge feed, lowered to `feed` when it was higher (every spindle-on feed move is checked); null if not given. */
  plunge: number | null;
}

export interface PresetPickerProps {
  /** The operation tool's cutter revision (from its tool assembly). Null: no tool chosen yet. */
  cutter: Pin | null;
  /** The setup's machining material, when set; presets for other materials are listed as not applying. */
  material?: Pin | null;
  /** The operation kind (`face`, `pocket`, `contour`, …). */
  operation: string;
  /** The tool's stick-out in mm, when known (a preset covers up to its maximum stick-out). */
  stickout?: number | null;
  /** The machine spindle's maximum speed, when known. */
  spindleMaxRpm?: number | null;
  /** The operation's settings now: shown against the chosen preset's limits. */
  current?: { rpm?: number | null; feed?: number | null; plunge?: number | null };
  /** The preset bound now (its pin), or null. */
  value?: Pin | null;
  /** A preset was chosen (or cleared): bind it. The record is the exact revision listed. */
  onChange?: (preset: LibraryRecord | null) => void;
  /** "Use": the speed and feed to set, with the pins to bind. */
  onApply: (values: PresetValues) => void;
  readOnly?: boolean;
  /** The Use button's label (default "Use these"). */
  applyLabel?: string;
}

const verdictIcon = { within: <Check size={12} />, over: <TriangleAlert size={12} />, unknown: null };

/** The record at exactly this pin's revision: the listed head when it is that revision, else read from its history. */
export function usePinned(pin: Pin | null | undefined, byId: Map<string, LibraryRecord>): LibraryRecord | null {
  const head = pin ? byId.get(pin.id) : undefined;
  const [older, setOlder] = useState<LibraryRecord | null>(null);
  const exact = !!pin && head?.revision === pin.revision;
  useEffect(() => {
    setOlder(null);
    if (!pin || exact) return;
    let live = true;
    library.get(pin.id, pin.revision).then((record) => { if (live) setOlder(record); }).catch(() => { if (live) setOlder(null); });
    return () => { live = false; };
  }, [pin?.id, pin?.revision, exact]); // eslint-disable-line react-hooks/exhaustive-deps
  return exact ? head! : older && pin && older.id === pin.id && older.revision === pin.revision ? older : null;
}

export default function PresetPicker({ cutter, material = null, operation, stickout = null, spindleMaxRpm = null, current = {}, value = null, onChange, onApply, readOnly, applyLabel = 'Use these' }: PresetPickerProps) {
  const records = useMfg((state) => state.records);
  const loaded = useMfg((state) => state.recordsLoaded);
  useEffect(() => { if (!loaded) void loadLibrary(); }, [loaded]);
  const byId = useMemo(() => new Map(records.map((record) => [record.id, record])), [records]);
  const presets = useMemo(() => records.filter((record) => record.kind === 'cutting_preset' && !record.archived && (!cutter || presetOf(record).cutter.id === cutter.id)), [records, cutter]);
  const options = useMemo(() => presets.map((record) => ({ record, why: mismatch(presetOf(record), { cutter, material, operation, stickout }) }))
    .sort((a, b) => Number(!!a.why) - Number(!!b.why) || a.record.definition.name.localeCompare(b.record.definition.name)), [presets, cutter, material, operation, stickout]);
  const applicable = options.filter((option) => !option.why);
  const [chosenId, setChosenId] = useState<string | null>(value?.id ?? null);
  useEffect(() => { setChosenId(value?.id ?? null); }, [value?.id, value?.revision]);
  // The bound revision exactly (an older one is read from history); a newly chosen preset is its latest revision.
  const bound = usePinned(value, byId);
  const chosen = chosenId && chosenId === value?.id ? bound : chosenId ? byId.get(chosenId) ?? null : null;
  const latest = value ? byId.get(value.id) : undefined;
  const pinnedOlder = !!value && chosenId === value.id && !!latest && latest.revision !== value.revision;
  const cutterRecord = usePinned(cutter, byId);
  const cutterDefinition = (cutterRecord?.definition ?? null) as { diameter_mm?: number; flute_count?: number; max_rpm?: number | null } | null;
  const diameter = cutterDefinition?.diameter_mm ?? null;
  const flutes = cutterDefinition?.flute_count ?? null;

  const preset = chosen ? presetOf(chosen) : null;
  const limits = preset ? envelope(preset, diameter, flutes, { cutterRpm: cutterDefinition?.max_rpm ?? null, spindleRpm: spindleMaxRpm }) : null;
  // With no speed limit in the preset, the feed limits apply at the operation's own speed.
  const rpm = limits?.rpm ?? (typeof current.rpm === 'number' && current.rpm > 0 ? current.rpm : null);
  const feed = preset && limits ? (limits.rpm !== null ? limits.feed : envelope({ ...preset, maximum_spindle_rpm: rpm }, diameter, flutes).feed) : null;
  const checks = preset ? checkValues(preset, diameter, flutes, current) : [];
  const why = preset ? mismatch(preset, { cutter, material, operation, stickout }) : null;

  const choose = (id: string) => {
    setChosenId(id || null);
    onChange?.(id ? byId.get(id) ?? null : null);
  };
  const apply = () => {
    if (!chosen || !preset) return;
    const plunge = typeof current.plunge === 'number' ? (feed !== null ? Math.min(current.plunge, feed) : current.plunge) : null;
    onApply({ preset: pinOf(chosen), material: preset.material, rpm: limits?.rpm ?? null, feed, plunge });
  };

  if (!cutter) return <div className={styles.picker} data-preset-picker data-state="no-cutter"><p className={styles.muted}>Choose a tool first: presets belong to a cutter.</p></div>;
  return (
    <div className={styles.picker} data-preset-picker data-applicable={applicable.length}>
      <div className={styles.pickerHead}>
        <Gauge size={14} />
        <span className={styles.pickerTitle}>Cutting preset</span>
        {!readOnly && (
          <select className={styles.select} aria-label="Cutting preset" value={chosenId ?? ''} onChange={(event) => choose(event.target.value)} data-preset-select>
            <option value="">{applicable.length ? 'None — set speed and feed by hand' : 'No preset applies'}</option>
            {pinnedOlder && <option value={value!.id}>{latest!.definition.name} · rev {value!.revision} (pinned)</option>}
            {applicable.filter(({ record }) => !(pinnedOlder && record.id === value!.id)).map(({ record }) => <option key={record.id} value={record.id}>{record.definition.name} · rev {record.revision}</option>)}
            {options.some((option) => option.why) && (
              <optgroup label="Don’t apply here">
                {options.filter((option) => option.why).map(({ record, why: reason }) => <option key={record.id} value={record.id} disabled>{record.definition.name} — {reason}</option>)}
              </optgroup>
            )}
          </select>
        )}
        {readOnly && <span className={styles.readValue}>{chosen ? `${chosen.definition.name} · rev ${chosen.revision}` : 'None'}</span>}
      </div>
      {pinnedOlder && (
        <p className={styles.note} data-tone="warning" data-preset-older>
          Pinned to revision {value!.revision}; revision {latest!.revision} is the latest. Pins never move on their own.
          {!readOnly && <button type="button" className={styles.link} onClick={() => onChange?.(latest!)}>Use rev {latest!.revision}</button>}
        </p>
      )}
      {!applicable.length && !chosen && (
        <div className={styles.empty} data-preset-empty>
          <span>{presets.length ? `None of this cutter’s ${presets.length} preset${presets.length === 1 ? '' : 's'} applies: ${options[0]?.why ?? ''}` : 'This cutter has no cutting presets yet.'} Speeds and feeds stay as you set them, and no rate check runs.</span>
          {!readOnly && RECORD_FORMS && <Button size="sm" icon={<Plus />} data-new-preset onClick={() => newPresetFor({ cutter, material, operations: [operation], maximum_stickout_mm: stickout })}>New preset</Button>}
        </div>
      )}
      {chosen && preset && (
        <div className={styles.limits} data-preset-limits>
          {why && <p className={styles.note} data-tone="warning">{why}</p>}
          <ul className={styles.limitChips}>
            {preset.maximum_spindle_rpm ? <li>≤ {format(preset.maximum_spindle_rpm)} <small>rpm</small></li> : null}
            {preset.maximum_nominal_surface_speed_m_min ? <li>≤ {format(preset.maximum_nominal_surface_speed_m_min)} <small>m/min</small></li> : null}
            {preset.maximum_feed_per_tooth_mm ? <li>≤ {format(preset.maximum_feed_per_tooth_mm)} <small>mm/tooth</small></li> : null}
            {preset.maximum_feed_per_revolution_mm ? <li>≤ {format(preset.maximum_feed_per_revolution_mm)} <small>mm/rev</small></li> : null}
            {preset.maximum_material_removal_rate_mm3_min ? <li title="Checked against the actual cut and remaining stock">≤ {format(preset.maximum_material_removal_rate_mm3_min)} <small>mm³/min removed</small></li> : null}
            <li title="The longest stick-out these limits hold for">stick-out ≤ {format(preset.maximum_stickout_mm)} <small>mm</small></li>
          </ul>
          {checks.length > 0 && (current.rpm || current.feed) && (
            <ul className={styles.checks} data-preset-checks>
              {checks.map((check) => (
                <li key={check.id} data-verdict={check.verdict}>
                  {verdictIcon[check.verdict]}
                  <span>{check.label}</span>
                  <b>{check.actual === null ? '—' : format(check.actual)}</b>
                  <small>{check.verdict === 'unknown' ? 'can’t tell' : `of ${format(check.limit)} ${check.unit}`}</small>
                </li>
              ))}
            </ul>
          )}
          <div className={styles.applyRow}>
            <span className={styles.suggest} data-suggest>
              {rpm !== null ? <><b>{format(rpm)}</b> rpm</> : 'Speed: no limit'}
              {' · '}
              {feed !== null ? <><b>{format(feed)}</b> mm/min</> : 'feed: no limit'}
            </span>
            {!readOnly && <Button size="sm" variant="primary" data-apply-preset onClick={apply} disabled={limits?.rpm === null && feed === null}>{applyLabel}</Button>}
          </div>
          <small className={styles.muted}>
            The highest settings within these limits{diameter ? ` for Ø${format(diameter)} mm` : ''}{flutes ? `, ${flutes} flutes` : ''}, rounded down. Limits, not recommendations: Steve checks every posted feed move against them.
            {limits?.missing.length ? ` Can’t use ${limits.missing.join(', ')}.` : ''}
          </small>
        </div>
      )}
    </div>
  );
}

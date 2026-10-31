/**
 * The library's feeds & speeds views:
 * - a cutting preset's limits worked out as a spindle speed and feed for a cutter diameter and flute count (the pinned
 *   cutter's by default; change them to see another size), showing which limit governs;
 * - a cutter's presets: choose the stock material and operation, and the preset picker offers what applies.
 * Read-only hints from the preset's limits; the backend checks the actual posted program.
 */
import { useEffect, useMemo, useState } from 'react';
import { Gauge, Plus } from 'lucide-react';
import { Button } from '@/ui';
import { library, type LibraryRecord, type Pin } from '../api';
import { useMfg } from '../state';
import { valueLabel } from '../schema';
import { envelope, format, presetOf } from './feeds';
import PresetPicker, { type PresetValues } from './PresetPicker';
import { newPresetFor } from './intent';
import styles from './Presets.module.css';
import { RECORD_FORMS } from '../shop/recordForms';
import TextNumber from '../TextNumber';

interface CutterFacts { diameter_mm?: number; flute_count?: number; max_rpm?: number | null; name?: string; cutter_type?: string }

export function FeedsPanel({ record }: { record: LibraryRecord }) {
  const preset = presetOf(record);
  // The exact cutter and material revisions the preset pins (a later edit of either doesn't change this preset).
  const [snapshot, setSnapshot] = useState<{ cutter: LibraryRecord; material: LibraryRecord } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(null); setError(null);
    library.presetSnapshot(record.id, record.revision).then((value) => { if (live) setSnapshot(value); }).catch((caught) => { if (live) setError((caught as Error).message); });
    return () => { live = false; };
  }, [record.id, record.revision]);
  const cutter = (snapshot?.cutter.definition ?? null) as CutterFacts | null;
  const [diameter, setDiameter] = useState('');
  const [flutes, setFlutes] = useState('');
  useEffect(() => {
    setDiameter(cutter?.diameter_mm ? String(cutter.diameter_mm) : '');
    setFlutes(cutter?.flute_count ? String(cutter.flute_count) : '');
  }, [cutter?.diameter_mm, cutter?.flute_count]);
  const d = Number.parseFloat(diameter), z = Number.parseInt(flutes, 10);
  const result = useMemo(() => envelope(preset, Number.isFinite(d) && d > 0 ? d : null, Number.isFinite(z) && z > 0 ? z : null, { cutterRpm: cutter?.max_rpm ?? null }),
    [preset, d, z, cutter?.max_rpm]);
  const governsSpeed = result.rpm !== null ? result.speedBounds.reduce((low, bound) => (bound.rpm < low.rpm ? bound : low)).id : null;
  const governsFeed = result.feed !== null ? result.feedBounds.reduce((low, bound) => (bound.feed < low.feed ? bound : low)).id : null;
  return (
    <section className={styles.feeds} id="preset-feeds" aria-label="Feeds and speeds">
      <div className={styles.feedsHead}><Gauge size={14} /><h4>Feeds &amp; speeds</h4></div>
      {error && <p className={styles.note} data-tone="warning">The pinned cutter couldn’t be read: {error}</p>}
      <div className={styles.feedsInputs}>
        <label>Cutter Ø mm<TextNumber className={styles.input} min={0} step={0.1} value={diameter} ariaLabel="Cutter diameter" onChange={setDiameter} /></label>
        <label>Flutes<TextNumber className={styles.input} min={1} integer value={flutes} ariaLabel="Flutes" onChange={setFlutes} /></label>
      </div>
      <dl className={styles.result}>
        <div className={styles.resultCell} data-result="rpm"><dt>Spindle speed up to</dt><dd>{result.rpm !== null ? <>{format(result.rpm)}<small>rpm</small></> : <small>no limit stated</small>}</dd></div>
        <div className={styles.resultCell} data-result="feed"><dt>Feed up to</dt><dd>{result.feed !== null ? <>{format(result.feed)}<small>mm/min</small></> : <small>{result.rpm === null ? 'needs a speed limit' : 'no feed limit stated'}</small>}</dd></div>
      </dl>
      {(result.speedBounds.length > 0 || result.feedBounds.length > 0) && (
        <ul className={styles.bounds} data-bounds>
          {result.speedBounds.map((bound) => <li key={bound.id} data-governs={bound.id === governsSpeed || undefined}><span>{bound.label}</span><span>{format(bound.rpm)} rpm</span></li>)}
          {result.feedBounds.map((bound) => <li key={bound.id} data-governs={bound.id === governsFeed || undefined}><span>{bound.label}</span><span>{format(bound.feed)} mm/min</span></li>)}
        </ul>
      )}
      <small className={styles.muted}>
        The highest settings within the preset’s limits{cutter?.name ? ` (cutter: ${cutter.name}, revision ${snapshot!.cutter.revision})` : ''}, rounded down.
        {preset.maximum_material_removal_rate_mm3_min ? ` The removal-rate limit (${format(preset.maximum_material_removal_rate_mm3_min)} mm³/min) depends on the actual cut, so it’s checked on the program, not here.` : ''}
        {result.missing.length ? ` Can’t use ${result.missing.join(', ')}.` : ''} Limits, not recommendations: Steve checks every posted feed move against them.
      </small>
    </section>
  );
}

/** A cutter's presets: pick the stock material and operation; the picker shows what applies and the settings it allows. */
export function CutterPresets({ record }: { record: LibraryRecord }) {
  const records = useMfg((state) => state.records);
  const presets = useMemo(() => records.filter((item) => item.kind === 'cutting_preset' && !item.archived && presetOf(item).cutter.id === record.id), [records, record.id]);
  const materials = useMemo(() => {
    const ids = new Set(presets.map((item) => presetOf(item).material.id));
    return records.filter((item) => item.kind === 'machining_material' && ids.has(item.id));
  }, [records, presets]);
  const kinds = useMemo(() => [...new Set(presets.flatMap((item) => presetOf(item).operations))], [presets]);
  const [material, setMaterial] = useState<string>('');
  const [operation, setOperation] = useState<string>('');
  const [applied, setApplied] = useState<PresetValues | null>(null);
  useEffect(() => { setMaterial(materials[0]?.id ?? ''); }, [materials]);
  useEffect(() => { setOperation((current) => (kinds.includes(current) ? current : kinds[0] ?? '')); }, [kinds]);
  useEffect(() => { setApplied(null); }, [material, operation, record.id]);
  const cutterPin: Pin = { id: record.id, revision: record.revision, kind: record.kind, sha256: record.sha256 };
  if (!presets.length) {
    return (
      <section className={styles.cutterPresets} id="cutter-presets" aria-label="Cutting presets for this cutter">
        <div className={styles.empty} data-preset-empty>
          <span>No cutting presets for this cutter yet. A preset states the speeds and feeds it may run at in a stock material; Steve checks programs against it.</span>
          {RECORD_FORMS && <Button size="sm" icon={<Plus />} data-new-preset onClick={() => newPresetFor({ cutter: cutterPin })}>New preset</Button>}
        </div>
      </section>
    );
  }
  const materialRecord = materials.find((item) => item.id === material);
  const materialPin: Pin | null = materialRecord ? { id: materialRecord.id, revision: materialRecord.revision, kind: materialRecord.kind, sha256: materialRecord.sha256 } : null;
  return (
    <section className={styles.cutterPresets} id="cutter-presets" aria-label="Cutting presets for this cutter">
      <div className={styles.cutterPresetsHead}>
        <label>Stock material
          <select className={styles.select} aria-label="Stock material" value={material} onChange={(event) => setMaterial(event.target.value)}>
            {materials.map((item) => <option key={item.id} value={item.id}>{item.definition.name}{typeof item.definition.condition === 'string' ? ` · ${item.definition.condition}` : ''}</option>)}
          </select>
        </label>
        <label>Operation
          <select className={styles.select} aria-label="Operation" value={operation} onChange={(event) => setOperation(event.target.value)}>
            {kinds.map((kind) => <option key={kind} value={kind}>{valueLabel(kind)}</option>)}
          </select>
        </label>
      </div>
      <PresetPicker cutter={cutterPin} material={materialPin} operation={operation} onApply={setApplied} applyLabel="Show settings" />
      {applied && (
        <div className={styles.applied} data-applied>
          Set the operation to {applied.rpm !== null ? `${format(applied.rpm)} rpm` : 'its own speed'}{applied.feed !== null ? ` and ${format(applied.feed)} mm/min` : ''}, with this preset selected so Steve checks it.
        </div>
      )}
    </section>
  );
}

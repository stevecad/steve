import { useEffect, useMemo } from 'react';
import { Crosshair, FlipVertical2, Info, MapPin, RefreshCw, Wrench, X } from 'lucide-react';
import { Button, Select, Spinner, Switch } from '@/ui';
import { useApp } from '@/state/store';
import { Panel } from '@/viewport/CommandPanels';
import ToolFooter from '@/shell/ToolFooter';
import {
  addTipPoint, closeFromPart, entityFor, FRAME_KEYS, FRAME_LABELS, frameAdvice, openPart, previewSlot, saveFromPart, setField, setTarget,
  smoothTip, updateSlot, useFromPart, type FrameKey, type SlotPart,
} from './fromPart';
import TextNumber from './TextNumber';
import styles from './ToolPart.module.css';

const CUTTER_TYPES = [['flat_end_mill', 'Flat end mill'], ['ball_end_mill', 'Ball end mill'], ['bull_end_mill', 'Bull-nose end mill'], ['drill', 'Drill'], ['chamfer_mill', 'Chamfer mill'], ['face_mill', 'Face mill'], ['reamer', 'Reamer']] as const;
const SLOT_LABELS: Record<SlotPart, string> = { reference: 'Reference', axis: 'Axis from', origin: 'Origin from' };

/** A text field, or (`type="number"`) a scrubbable number that stays text in the draft, as the server checks it on save. */
function TextField({ field, label, unit, hint, type = 'text', step, integer }: { field: string; label: string; unit?: string; hint?: string; type?: 'text' | 'number'; step?: number; integer?: boolean }) {
  const value = useFromPart((state) => state.fields[field] ?? '');
  const error = useFromPart((state) => state.errors[field]);
  return (
    <label className={styles.field} data-field={field} data-error={error ? true : undefined}>
      <span className={styles.fieldLabel}>{label}{unit && <small> {unit}</small>}</span>
      {type === 'number'
        ? <TextNumber id={`tp-${field}`} className={styles.input} min={0} integer={integer} step={step} value={value} ariaLabel={label} onChange={(next) => setField(field, next)} />
        : <input id={`tp-${field}`} className={styles.input} value={value} aria-label={label} onChange={(event) => setField(field, event.target.value)} />}
      {error ? <span className={styles.fieldError}>{error}</span> : hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </label>
  );
}

function ChoiceField({ field, label, options }: { field: string; label: string; options: readonly (readonly [string, string])[] }) {
  const value = useFromPart((state) => state.fields[field] ?? options[0][0]);
  const error = useFromPart((state) => state.errors[field]);
  return (
    <div className={styles.field} data-field={field} data-error={error ? true : undefined}>
      <span className={styles.fieldLabel}>{label}</span>
      <Select value={value} ariaLabel={label} onChange={(next) => setField(field, next)} options={options.map(([v, l]) => ({ value: v, label: l }))} />
      {error && <span className={styles.fieldError}>{error}</span>}
    </div>
  );
}

function FrameCard({ frame, live }: { frame: FrameKey; live: boolean }) {
  const slot = useFromPart((state) => state.frames[frame]);
  const target = useFromPart((state) => state.target);
  const error = useFromPart((state) => state.errors[`frames.${frame}`]);
  const busy = useFromPart((state) => state.busy);
  const version = useApp((state) => state.modelVersion);
  const preview = useMemo(() => (live ? previewSlot(slot) : null), [live, slot, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => (live && slot?.reference ? entityFor(slot.reference) : null), [live, slot?.reference, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const tip = useMemo(() => (live && frame === 'tip' ? smoothTip(slot) : null), [live, frame, slot, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts: SlotPart[] = ['reference', 'axis', 'origin'];
  return (
    <section className={styles.frameCard} data-field={`frames.${frame}`} data-frame={frame} data-error={error ? true : undefined}>
      <header className={styles.frameHead}>
        <Crosshair size={13} />
        <b>{FRAME_LABELS[frame].title}</b>
        {slot?.reference && <button type="button" className={styles.clear} aria-label={`Clear ${FRAME_LABELS[frame].title}`} onClick={() => updateSlot(frame, { reference: null, axis: null, origin: null, reverse: false })}><X size={12} /></button>}
      </header>
      <p className={styles.fieldHint}>{FRAME_LABELS[frame].hint}</p>
      {parts.map((part) => {
        const value = slot?.[part] ?? null;
        const active = target?.frame === frame && target.part === part;
        if (part !== 'reference' && !slot?.reference && !value) return null;
        return (
          <div key={part} className={styles.slotRow}>
            <span className={styles.fieldLabel}>{SLOT_LABELS[part]}{part !== 'reference' && <small> optional</small>}</span>
            <button type="button" className={styles.slot} data-active={active || undefined} data-filled={value ? true : undefined} data-slot={`${frame}.${part}`}
              onClick={() => (active ? useFromPart.setState({ target: null }) : setTarget(frame, part))}>
              {value ? <code>{value}</code> : <span>{active ? 'Click the part…' : part === 'reference' ? 'Pick in the viewport' : 'Use the reference'}</span>}
            </button>
            {value && part !== 'reference' && <button type="button" className={styles.clear} aria-label={`Clear ${SLOT_LABELS[part]}`} onClick={() => updateSlot(frame, { [part]: null })}><X size={12} /></button>}
          </div>
        );
      })}
      {slot?.reference && (
        <div className={styles.slotRow}>
          <span className={styles.fieldLabel}>+Z toward the spindle</span>
          <Switch checked={slot.reverse} onCheckedChange={(reverse) => updateSlot(frame, { reverse })} label={`Flip ${FRAME_LABELS[frame].title} +Z`} />
          <FlipVertical2 size={13} className={styles.muted} />
        </div>
      )}
      {base && <p className={styles.fieldHint} data-describe>{base.describe}</p>}
      {preview && <p className={styles.fieldHint} data-preview>Origin ({preview.origin.toArray().map((v) => Number(v.toFixed(3))).join(', ')}) · +Z ({preview.z.toArray().map((v) => Number(v.toFixed(3))).join(', ')})</p>}
      {tip && typeof tip !== 'string' && (
        <div className={styles.callout} data-smooth-tip>
          <Info size={13} />
          <div>
            <span>A {tip.face === 'sphere' ? 'ball' : 'bull-nose'} tip has no vertex or edge at its tip. STEVE can write a construction point at the axis extreme,
              ({tip.point.toArray().map((v) => Number(v.toFixed(3))).join(', ')}), into the part and use it as the tip origin{tip.axisRef ? <> with axis <code>{tip.axisRef}</code></> : '; then pick the axis (a circular edge on the shank)'}.</span>
            <Button size="sm" icon={busy === 'tip' ? <Spinner size={11} /> : <MapPin />} disabled={!!busy} id="add-tip-point" onClick={() => void addTipPoint(frame)}>Add tip point</Button>
          </div>
        </div>
      )}
      {typeof tip === 'string' && <p className={styles.fieldHint} data-tone="warning">{tip}</p>}
      {error && <p className={styles.fieldError} role="alert">{error}</p>}
    </section>
  );
}

export default function FromPartPanel() {
  const state = useFromPart();
  const doc = useApp((app) => app.doc);
  useApp((app) => app.displayed?.id);
  const part = openPart();
  const live = typeof part !== 'string' && part.id === state.documentId && part.revision === state.revision;
  const advice = useMemo(() => (live ? frameAdvice(state.kind, state.frames) : []), [live, state.kind, state.frames]);
  useEffect(() => {
    if (!state.focus) return;
    const element = document.querySelector(`[data-panel="toolpart"] [data-field="${state.focus}"]`);
    if (element) {
      element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      (element.querySelector('input, button') as HTMLElement | null)?.focus({ preventScroll: true });
      element.setAttribute('data-flash', '');
      setTimeout(() => element.removeAttribute('data-flash'), 1600);
    }
    useFromPart.setState({ focus: null });
  }, [state.focus]);
  const cutter = state.kind === 'rotary_cutter';
  const title = `${state.editing ? 'Re-pick' : cutter ? 'Cutter' : 'Holder'} from part`;
  return (
    <Panel id="toolpart" icon={<Wrench size={16} />} title={title} onClose={closeFromPart}
      footer={<ToolFooter onCancel={closeFromPart} onOk={() => void saveFromPart()} okId="save-from-part" okBusy={state.busy === 'save'}
        onEscape={() => { if (!useFromPart.getState().target) return false; useFromPart.setState({ target: null }); return true; }}
        okDisabled={state.busy ? 'Working…' : null}
        okTitle={state.editing ? `Save revision ${state.editing.revision + 1}` : `Create the ${cutter ? 'cutter' : 'holder'} in the library`} />}>
      <div className={styles.partLine} data-part>
        {typeof part === 'string' ? <span className={styles.warn}>{part}</span> : (
          <>
            <b>{part.name}</b>
            <span>revision {state.revision ?? part.revision}{state.body ? <> · body <code>{state.body}</code></> : ''}</span>
          </>
        )}
      </div>
      {state.pinned !== null && state.revision !== null && state.pinned !== state.revision && (
        <div className={styles.callout} data-tone="warning" data-repick>
          <RefreshCw size={13} />
          <div>
            <span>This record pinned part revision {state.pinned}; the open part is revision {state.revision}. <b>Re-pick the frames after re-importing a newer vendor file</b>:
              an imported STEP names its faces and edges in file order, so references from revision {state.pinned} may be gone or point elsewhere. Saving pins revision {state.revision}.</span>
          </div>
        </div>
      )}
      {state.notice && <div className={styles.callout} data-tone="warning" data-notice><RefreshCw size={13} /><div><span>{state.notice}</span></div></div>}
      {doc.saved && !live && typeof part !== 'string' && state.documentId && state.documentId !== part.id && (
        <p className={styles.fieldHint} data-tone="warning">These frames belong to another part. Picking here starts over on {part.name}.</p>
      )}
      <p className={styles.fieldHint}>Click a frame’s slot, then click the part. Circular edges give an exact origin on the axis and the axis itself, which suits imported vendor STEP files.</p>
      {FRAME_KEYS[state.kind].map((frame) => <FrameCard key={frame} frame={frame} live={live} />)}
      {advice.map((item) => <p key={item.message} className={styles.fieldHint} data-tone="warning" data-advice>{item.message}</p>)}

      <h4 className={styles.subhead}>{cutter ? 'Cutting length' : 'Clamping'}</h4>
      <p className={styles.fieldHint}>{cutter
        ? 'Catalog or measured values. The part’s shape gives the envelope; it can’t tell flutes from shank.'
        : 'Catalog or measured values. The bore and engagement are checked against the part; the gripping limits can’t be read from shape alone.'}</p>
      {cutter ? (
        <TextField field="cutting_length_mm" label="Cutting length from the tip" unit="mm" type="number" />
      ) : (
        <div className={styles.grid2}>
          <TextField field="clamp_bore_mm" label="Clamp bore Ø" unit="mm" type="number" />
          <TextField field="engagement_depth_mm" label="Engagement depth" unit="mm" type="number" />
          <TextField field="clamp_min_diameter_mm" label="Grips Ø from" unit="mm" type="number" />
          <TextField field="clamp_max_diameter_mm" label="Grips Ø up to" unit="mm" type="number" />
          <TextField field="clamp_min_engagement_mm" label="Min engagement" unit="mm" type="number" />
          <TextField field="clamp_max_engagement_mm" label="Max engagement" unit="mm" type="number" />
        </div>
      )}

      <h4 className={styles.subhead}>Record</h4>
      <TextField field="name" label="Name" />
      <div className={styles.grid2}>
        <TextField field="manufacturer" label="Manufacturer" />
        <TextField field="product_code" label="Product code" />
      </div>
      <ChoiceField field="dimension_source" label="Values are" options={[['catalog', 'From the catalog'], ['measured', 'Measured']]} />
      {cutter ? (
        <>
          <ChoiceField field="cutter_type" label="Type" options={CUTTER_TYPES} />
          <div className={styles.grid2}>
            <TextField field="flute_count" label="Flutes" type="number" integer />
            <TextField field="material" label="Material" />
            <ChoiceField field="hand" label="Hand" options={[['right', 'Right'], ['left', 'Left']]} />
            <ChoiceField field="center_cutting" label="Centre cutting" options={[['true', 'Yes'], ['false', 'No']]} />
          </div>
        </>
      ) : (
        <>
          <ChoiceField field="component_type" label="Component" options={[['holder', 'Holder'], ['adaptor', 'Adaptor'], ['collet', 'Collet']]} />
          <div className={styles.grid2}>
            <TextField field="input_interface" label="Spindle side" hint="e.g. bt30" />
            <TextField field="output_interface" label="Tool side" hint="e.g. cylindrical_shank" />
          </div>
        </>
      )}
      <div className={styles.grid2}>
        <TextField field="max_rpm" label="Max speed" unit="rpm" type="number" step={100} />
        <TextField field="mass_kg" label="Mass" unit="kg" type="number" step={0.01} />
      </div>
      {state.problem && <div className={styles.callout} data-tone="danger" role="alert" id="from-part-problem"><Info size={13} /><div><span>{state.problem}</span>{Object.entries(state.errors).filter(([, m]) => m).length > 0 && <ul>{Object.entries(state.errors).filter(([, m]) => m).map(([k, m]) => <li key={k}><code>{k}</code>: {m}</li>)}</ul>}</div></div>}
    </Panel>
  );
}

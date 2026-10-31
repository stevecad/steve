/**
 * The results legend and display settings, in the inspector (StudyInspector's Results and Display sections): what is
 * shown, in what unit, from which study, at which step and deformation; bands with ticks whose ends take a typed value;
 * the colours, range and what else is drawn. None of it floats over the viewport: there is only
 * ResultsOverlay's slim colour key, and only while the inspector is closed.
 */
import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { NumberField, Segmented, Switch } from '@/ui';
import { useApp } from '@/state/store';
import { visibleFields } from './api';
import { AMBER, COLORMAPS, css, FAIL, GREEN, legendGradient, MAX_BANDS, MIN_BANDS, NEUTRAL, type ColormapId, type SafetyMode } from './colormap';
import { legendModel } from './legend';
import { animationKind, SAFETY_CAP, useSimulation } from './state';
import { toSI } from './units';
import sim from './Simulate.module.css';

export const ZONE = { fail: FAIL, amber: AMBER, green: GREEN, neutral: NEUTRAL };

/** Everything the legend draws from, as one comparable key (it shouldn't redraw on every animation frame). */
export const legendKey = (s: ReturnType<typeof useSimulation.getState>) => [s.result?.run.id, s.field, s.region, s.frame, s.range?.min, s.range?.max, s.legendRange?.min,
  s.legendRange?.max, s.outOfRange, s.contours, s.bands, s.colormap, s.safetyMode, s.trafficRed, s.trafficAmber, s.safetyTarget, s.showYield, s.deformation,
  s.autoDeformation, s.interior].join('|');

/** A typed range end, in the legend's display unit, kept only when it leaves max above min. */
function setEnd(side: 'min' | 'max', shown: number, unit: string) {
  const s = useSimulation.getState();
  const range = s.legendRange ?? s.range;
  const manifest = s.result?.manifest;
  if (!range || !manifest) return;
  const siUnit = s.field === 'safety' ? '' : visibleFields(manifest, s.region)[s.field]?.units;
  const next = { ...range, [side]: toSI(shown, siUnit, unit) };
  if (next.max > next.min) useSimulation.setState({ legendRange: next });
}

/** A legend end value that turns into an input on click; Enter applies, Escape cancels. */
function EndValue({ label, value, side, onSet }: { label: string; value: number | null; side: 'max' | 'min'; onSet: (value: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  if (value === null) return <>{label}</>;
  if (editing) return <input className={sim.endInput} autoFocus aria-label={side === 'max' ? 'Legend maximum' : 'Legend minimum'} value={text}
    onChange={(event) => setText(event.target.value)} onBlur={() => setEditing(false)}
    onKeyDown={(event) => {
      if (event.key === 'Escape') setEditing(false);
      if (event.key === 'Enter') { const number = Number(text.replace(/,/g, '')); if (Number.isFinite(number)) onSet(number); setEditing(false); }
    }} />;
  return <button type="button" className={sim.endValue} title="Click to type a value" data-end={side} onClick={() => { setText(String(Number(value.toPrecision(6)))); setEditing(true); }}>{label}</button>;
}

/** The contour legend of the showing result: title, unit, state lines, the bands with their ticks, what falls outside. */
export function ResultsLegend({ studyName }: { studyName: string | undefined }) {
  useSimulation(legendKey);
  const s = useSimulation.getState();
  const sectioned = useApp((state) => state.section.enabled);
  const model = legendModel(studyName);
  if (!s.result || !model) return null;
  const flow = !!s.result.manifest.engine.openfoam;
  const editable = s.field !== 'safety' && !!model.rangeShown;
  const ticks = model.labels;
  return (
    <div className={sim.paneLegend} aria-label="Contour legend" data-field={s.field} data-bands={model.banded && !model.zones.length ? model.bands : 0}
      data-colormap={s.field === 'safety' ? s.safetyMode : s.colormap} data-edited={model.edited || undefined}>
      <div className={sim.paneLegendHead}>
        <b id="results-title">{model.title}{model.edited && <span className={sim.edited} title="Custom range">*</span>}</b>
        {model.subtitle && <span className={sim.scaleUnit}>{model.subtitle}</span>}
        <span className={sim.spacer} />
        {model.edited && <button type="button" className={sim.headButton} aria-label="Reset the range" title="Full range" onClick={() => useSimulation.setState({ legendRange: null })}><RotateCcw size={13} /></button>}
      </div>
      <dl className={sim.stateBlock} id="results-state">{model.details.map((line) => <dd key={line}>{line}</dd>)}</dl>
      {model.zones.length ? <ul className={sim.zones}>{model.zones.map((zone) => <li key={zone.label}><i style={{ background: css(ZONE[zone.color]) }} />{zone.label}</li>)}</ul>
        : <div className={sim.scaleBody}>
          <div className={sim.scaleBar} style={{ background: legendGradient(model.palette, model.banded, 'to top', model.bands) }}>
            {model.yieldAt !== null && <span className={sim.yieldMark} style={{ bottom: `${model.yieldAt * 100}%` }} title={model.yieldLabel} />}
          </div>
          <ol className={sim.scaleTicks}>
            {ticks.map((label, i) => <li key={i} style={{ top: `${(i / Math.max(1, ticks.length - 1)) * 100}%` }}>
              {editable && i === 0 ? <EndValue label={label} value={model.rangeShown!.max} side="max" onSet={(value) => setEnd('max', value, model.unit)} />
                : editable && i === ticks.length - 1 ? <EndValue label={label} value={model.rangeShown!.min} side="min" onSet={(value) => setEnd('min', value, model.unit)} /> : label}
            </li>)}
          </ol>
        </div>}
      {model.yieldLabel && <div className={sim.scaleFail}><i className={sim.yieldSwatch} />{model.yieldLabel}</div>}
      {model.outside.map((note) => <div key={note} className={sim.scaleFail}>
        <i className={note.startsWith('Yield') ? sim.yieldSwatch : undefined} style={note.startsWith('Yield') ? undefined : { background: css(note.startsWith('Below 1') ? FAIL : NEUTRAL) }} />{note}</div>)}
      {editable && <small className={sim.settingHint}>Click the top or bottom value to type a range.</small>}
      {sectioned && <p className={sim.scaleNote} id="section-results-note">{s.interior
        ? 'Section: values inside the part, interpolated from the solved nodes.'
        : flow
          ? 'Section: flow results hold boundary values only; cell values are in the downloadable results.'
          : 'Section: this result holds surface values only (inside shown grey). Solve again to see values inside.'}</p>}
    </div>
  );
}

const Toggle = ({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) => (
  <div className={sim.settingRow}><span>{label}</span><Switch checked={checked} onCheckedChange={onChange} label={label} /></div>
);

/** How the showing result is drawn: colours and contours, the range, and what else shows with it. */
export function DisplaySettings() {
  const s = useSimulation();
  const manifest = s.result?.manifest;
  if (!manifest) return null;
  const safety = s.field === 'safety';
  const stress = s.field === 'von_mises';
  const deform = animationKind(manifest, s.field) === 'deform';
  const model = legendModel(undefined);
  return <div className={sim.settings} id="results-settings">
    {s.field !== 'mesh' && <>
      <h4>Colours</h4>
      {!safety && <><div className={sim.settingRow}><span>Colormap</span>
        <Segmented size="sm" value={s.colormap} onChange={(colormap) => useSimulation.setState({ colormap: colormap as ColormapId })}
          options={COLORMAPS.map((map) => ({ value: map.id, label: map.label }))} /></div>
        <small className={sim.settingHint}>{COLORMAPS.find((map) => map.id === s.colormap)?.hint}</small></>}
      <div className={sim.settingRow}><span>Contours</span>
        <Segmented size="sm" value={s.contours} onChange={(contours) => useSimulation.setState({ contours: contours as 'banded' | 'smooth' })}
          options={[{ value: 'banded', label: 'Banded' }, { value: 'smooth', label: 'Smooth' }]} /></div>
      {s.contours === 'banded' && !(safety && s.safetyMode === 'traffic') && <div className={sim.settingRow}><span>Bands</span>
        <NumberField value={s.bands} unit="" ariaLabel="Contour bands" onChange={(bands) => {
          if (Number.isInteger(bands) && bands >= MIN_BANDS && bands <= MAX_BANDS) useSimulation.setState({ bands });
        }} /></div>}
    </>}
    {!safety && model?.rangeShown && <>
      <h4>Range {model.unit && <small>({model.unit})</small>}</h4>
      <div className={sim.settingPair}>
        <NumberField value={Number(model.rangeShown.min.toPrecision(5))} unit={model.unit} prefix="Min" ariaLabel="Range minimum" onChange={(value) => setEnd('min', value, model.unit)} />
        <NumberField value={Number(model.rangeShown.max.toPrecision(5))} unit={model.unit} prefix="Max" ariaLabel="Range maximum" onChange={(value) => setEnd('max', value, model.unit)} />
      </div>
      <div className={sim.settingRow}><span>Outside the range</span>
        <Segmented size="sm" value={s.outOfRange} onChange={(outOfRange) => useSimulation.setState({ outOfRange: outOfRange as 'grey' | 'clamp' })}
          options={[{ value: 'grey', label: 'Grey' }, { value: 'clamp', label: 'End colours' }]} /></div>
      {s.legendRange && <button type="button" className={sim.textButton} onClick={() => useSimulation.setState({ legendRange: null })}><RotateCcw size={12} />Full range</button>}
    </>}
    <h4>Show</h4>
    {deform && <Toggle checked={s.ghost} onChange={(ghost) => useSimulation.setState({ ghost })} label="Undeformed shape (ghost)" />}
    <Toggle checked={s.meshEdges} onChange={(meshEdges) => useSimulation.setState({ meshEdges })} label="Element edges" />
    {!!manifest.provenance?.design?.instances?.length && <Toggle checked={s.context} onChange={(context) => useSimulation.setState({ context })} label="Rest of the model" />}
    {stress && <Toggle checked={s.showYield} onChange={(showYield) => useSimulation.setState({ showYield })} label="Yield strength on the scale" />}
    <Toggle checked={s.colourKey} onChange={(colourKey) => useSimulation.setState({ colourKey })} label="Colour key on the model while this panel is closed" />
  </div>;
}

/** Safety factor views: the 1–10 gradient, traffic-light zones, or only what falls short of a target. */
export function SafetyControls() {
  const s = useSimulation();
  return <>
    <span className={sim.label}>Safety factor view</span>
    <Segmented size="sm" value={s.safetyMode} onChange={(safetyMode) => useSimulation.setState({ safetyMode: safetyMode as SafetyMode })}
      options={[{ value: 'gradient', label: 'Gradient' }, { value: 'traffic', label: 'Traffic light' }, { value: 'target', label: 'Below target' }]} />
    {s.safetyMode === 'traffic' && <>
      <div className={sim.settingRow}><span><i className={sim.zoneDot} style={{ background: css(FAIL) }} />Red below</span>
        <NumberField value={s.trafficRed} unit="" ariaLabel="Red below" onChange={(trafficRed) => { if (trafficRed > 0 && trafficRed < s.trafficAmber) useSimulation.setState({ trafficRed }); }} /></div>
      <div className={sim.settingRow}><span><i className={sim.zoneDot} style={{ background: css(AMBER) }} />Amber below</span>
        <NumberField value={s.trafficAmber} unit="" ariaLabel="Amber below" onChange={(trafficAmber) => { if (trafficAmber > s.trafficRed) useSimulation.setState({ trafficAmber }); }} /></div>
    </>}
    {s.safetyMode === 'target' && <div className={sim.settingRow}><span>Target</span>
      <NumberField value={s.safetyTarget} unit="" ariaLabel="Safety factor target" onChange={(safetyTarget) => { if (safetyTarget > 0 && safetyTarget <= SAFETY_CAP) useSimulation.setState({ safetyTarget }); }} /></div>}
  </>;
}

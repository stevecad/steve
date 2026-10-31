import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Crosshair, Download, Sparkles, Square, Trash2, X } from 'lucide-react';
import { StudyIcon } from '@/icons/cad';
import { Button, NumberField, Section, Segmented, Slider } from '@/ui';
import { get, isDirty, isPreviewStale, set, useApp, type Study, type StudyLoad } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import { createStudy, LOAD_TYPES, STUDY_TYPES } from './commands';
import StudyPose, { PoseNote } from './StudyPose';
import CopyMessage from '@/shell/CopyMessage';
import ToolFooter from '@/shell/ToolFooter';
import { analysableInstances, askSteve, cancelRun, DEFORMATION_PRESETS, deformationText, instanceOfNode, needsInstance, pinnedSelection, presetOf, presetScale, qualifiedReference, replaceStudy, report, resolveCurrent, runStudy, SAFETY_CAP, saveStudy, setAnalysed, setPose, singleSolid, staleness, startPicking, stopPicking, cancelPicking, studyDirty, suggestedInstance, useSimulation, yieldOf, type DeformationPreset } from './state';
import { viewer } from '@/viewport/viewer';
import { pretty } from '@/lib/format';
import { surfaceNote } from '@/lib/modeling';
import { isCompressible, terminal, visibleFields, type StudyProbe } from './api';
import { finiteVolume, fluid, modelWritten, stageLabel, structural } from './physics';
import { faceLabel, fieldLabel, FIELD_LABELS, show, summaryLine } from './units';
import { CompressibleBehavior, GAS_BOUNDARIES, GasBoundaryFields, GasPerformance, GasSetup, PERFORMANCE_KEYS } from './CompressibleSetup';
import styles from '@/panels/Panels.module.css';
import sim from './Simulate.module.css';
import { DisplaySettings, ResultsLegend, SafetyControls } from './ResultsLegend';
import { AllStudies } from './StudiesOverview';
import ConjugateSetup from './ConjugateSetup';
import CaseSetup from './CaseSetup';
import { RotationResults, RotationSetup } from './RotationSetup';
import ResourceSettings from './ResourceSettings';
import { withWorkspace } from '@/teams/current';

function updateStudy(studyId: string, change: (study: Study) => Study) {
  set((state) => ({ studies: state.studies.map((study) => (study.id === studyId ? change(study) : study)) }));
  persistWorkspaceData();
}

function updateLoad(studyId: string, loadId: string, patch: Partial<StudyLoad>) {
  updateStudy(studyId, (study) => ({ ...study, loads: study.loads.map((load) => load.id === loadId ? { ...load, ...patch } : load) }));
}

function removeLoad(studyId: string, loadId: string) {
  if (useSimulation.getState().picking?.loadId === loadId) stopPicking();
  updateStudy(studyId, (study) => ({ ...study, loads: study.loads.filter((load) => load.id !== loadId) }));
}

const DIRECTIONS: { value: string; label: string; v: [number, number, number] }[] = [
  { value: '-z', label: '−Z', v: [0, 0, -1] }, { value: '+z', label: '+Z', v: [0, 0, 1] },
  { value: '-x', label: '−X', v: [-1, 0, 0] }, { value: '+x', label: '+X', v: [1, 0, 0] },
  { value: '-y', label: '−Y', v: [0, -1, 0] }, { value: '+y', label: '+Y', v: [0, 1, 0] },
];
const directionKey = (v?: [number, number, number]) => DIRECTIONS.find((d) => d.v.every((c, i) => c === v?.[i]))?.value ?? '-z';
const number = (value: number) => value === 0 ? '0' : value.toPrecision(4);
/** Kelvin in the code, Celsius on screen. */
const C = (kelvin: number) => Number((kelvin - 273.15).toFixed(2));
const K = (celsius: number) => celsius + 273.15;

/** Seconds since `since`, ticking. */
function useElapsed(since: number | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

/** Feature ids → display names, for face labels ("Extrude 1 · side r1 left"). */
function useFeatureNames(): Record<string, string> {
  const modeling = useApp((state) => state.modeling);
  return useMemo(() => Object.fromEntries((modeling?.features ?? []).filter((f) => f.id).map((f) => [f.id!, f.name])), [modeling]);
}

function Boundary({ study, load, names }: { study: Study; load: StudyLoad; names: Record<string, string> }) {
  const picking = useSimulation((state) => state.picking?.loadId === load.id);
  const refs = load.refs ?? [];
  const type = LOAD_TYPES[load.type];
  const temperatureLike = load.type === 'temperature';
  return (
    <div className={sim.boundary} data-picking={picking || undefined} data-empty={load.type !== 'gravity' && !refs.length || undefined} data-boundary={load.type}>
      <div className={sim.boundaryHead}>
        <b>{load.type === 'named' ? load.id : type.label}</b>
        <span className={styles.muted}>{load.type === 'gravity' ? 'Whole body' : `${refs.length} face${refs.length === 1 ? '' : 's'}`}</span>
        <span className={sim.spacer} />
        {load.type !== 'gravity' && !picking && <Button size="sm" variant="ghost" icon={<Crosshair />} onClick={() => startPicking(study.id, load.id)} title="Click faces in the viewport to add or remove them">Faces</Button>}
        {load.picks.length > 0 && !picking && <Button size="sm" variant="ghost" onClick={() => set({ selection: load.picks })}>Show</Button>}
        <button type="button" className={sim.remove} aria-label={`Remove ${type.label}`} onClick={() => removeLoad(study.id, load.id)}><Trash2 size={13} /></button>
      </div>
      {picking && <div className={sim.pickBar} role="status">
        <span>Click faces to add · click again to remove</span>
        {/* Picking faces is an operation like any tool's: OK keeps them, Cancel puts back what was there. */}
        <ToolFooter inline onOk={stopPicking} onCancel={cancelPicking} okId="boundary-done" cancelId="boundary-cancel" okTitle={`Use these faces for ${type.label.toLowerCase()}`} />
      </div>}
      {load.type !== 'gravity' && !refs.length && !picking && <p className={sim.warn}>No faces yet. Use Faces, then click them in the viewport.</p>}
      {refs.length > 0 && <ul className={sim.faces}>
        {refs.map((ref) => <li key={ref} title={ref}><span>{faceLabel(ref, names)}</span><code>{ref.replace(/^part:/, '')}</code></li>)}
      </ul>}
      {load.type === 'fixed' && <div className={sim.axes}>{['X', 'Y', 'Z'].map((axis, i) => <label key={axis}>
        <input type="checkbox" checked={(load.axes ?? [0, 1, 2]).includes(i)} onChange={(e) => {
          const axes = e.target.checked ? [...(load.axes ?? [0, 1, 2]), i] : (load.axes ?? [0, 1, 2]).filter((a) => a !== i);
          if (axes.length) updateLoad(study.id, load.id, { axes });
        }} /> {axis}</label>)}</div>}
      {load.type === 'named' && <NamedFields study={study} load={load} />}
      {GAS_BOUNDARIES.has(load.type) && <GasBoundaryFields study={study} load={load} />}
      {load.magnitude !== undefined && !GAS_BOUNDARIES.has(load.type) && (temperatureLike
        ? <NumberField value={C(load.magnitude)} unit="°C" ariaLabel={`${type.label} magnitude`} onChange={(value) => updateLoad(study.id, load.id, { magnitude: K(value) })} />
        : <NumberField value={load.magnitude} unit={type.unit} ariaLabel={`${type.label} magnitude`} onChange={(magnitude) => updateLoad(study.id, load.id, { magnitude })} />)}
      {load.type === 'convection' && <><span className={sim.label}>Ambient temperature</span><NumberField value={C(load.ambientTemperature ?? 300)} unit="°C" ariaLabel="Ambient temperature" onChange={(value) => updateLoad(study.id, load.id, { ambientTemperature: K(value) })} /></>}
      {load.direction && <Segmented size="sm" value={directionKey(load.direction)} onChange={(value) => updateLoad(study.id, load.id, { direction: DIRECTIONS.find((d) => d.value === value)!.v })} options={DIRECTIONS.map((d) => ({ value: d.value, label: d.label }))} />}
    </div>
  );
}

const PATCH_TYPES = ['patch', 'wall', 'symmetry', 'symmetryPlane', 'empty', 'wedge'] as const;

/** A named face group's name (what the case or deck calls it) and, in an OpenFOAM case, its patch type. */
function NamedFields({ study, load }: { study: Study; load: StudyLoad }) {
  const [name, setName] = useState(load.id);
  useEffect(() => setName(load.id), [load.id]);
  const taken = study.loads.some((other) => other !== load && other.id === name);
  const valid = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) && !taken;
  return <>
    <label className={sim.row}>Name <input className={sim.text} aria-label="Face group name" value={name} spellCheck={false}
      onChange={(event) => setName(event.target.value.trim())} onBlur={() => { if (valid && name !== load.id) updateLoad(study.id, load.id, { id: name }); else setName(load.id); }} /></label>
    {!valid && <p className={sim.warn}>{taken ? 'Another face group has this name.' : 'A letter, then letters, digits or _.'}</p>}
    {study.type === 'openfoam_case' && <label className={sim.row}>Patch type <select aria-label="Patch type" value={load.patchType ?? 'patch'}
      onChange={(event) => updateLoad(study.id, load.id, { patchType: event.target.value as (typeof PATCH_TYPES)[number] })}>
      {PATCH_TYPES.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>}
  </>;
}

/**
 * A result, in sections: what is shown with its legend (and the way back to setup), how it is drawn, the deformation or
 * mode shape, probes, and the summary numbers. The legend lives here only, not over the viewport.
 */
function Results({ study }: { study: Study }) {
  const state = useSimulation();
  const result = state.result!.manifest;
  const flow = fluid(study);
  const resultFrame = result.frames?.[state.frame];
  const availableFields = visibleFields(result, state.region);
  const yieldPa = yieldOf(result);
  const gasFlow = isCompressible(result.analysis);
  const fields = Object.entries(FIELD_LABELS).map(([name, label]) => [name, fieldLabel(name, result.analysis) ?? label] as const).filter(([name]) => name === 'mesh' || availableFields[name] || (name === 'safety' && structural(study) && result.arrays.von_mises && yieldPa));
  const summary = resultFrame?.summary ?? result.regions?.[state.region]?.summary ?? result.summary ?? {};
  const maxVonMises = result.summary?.max_von_mises_pa;
  const deformable = !!result.arrays.displacement && !result.modal;
  const sliderMax = Math.max(state.autoDeformation * 6, 2);
  const preset = presetOf(state.deformation, state.autoDeformation);
  const run = state.result!.run;
  const engineId = run.engine_key ?? result.provenance.engine_key;
  // New results open at the top of the panel, wherever setup left it scrolled.
  useEffect(() => { document.getElementById('study-results')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [state.result?.run.id]);
  return <div id="study-results">
    <Section title="Results" id="results-shown"><div className={styles.stack}>
      {result.regions && <label className={sim.row}>Region <select aria-label="Result region" value={state.region} onChange={(event) => {
        const region = event.target.value, regionFields = visibleFields(result, region);
        useSimulation.setState({ region, field: state.field === 'mesh' || regionFields[state.field] ? state.field : regionFields.temperature ? 'temperature' : 'mesh' });
      }}><option value="">All regions</option>
        {Object.entries(result.regions).map(([name, item]) => <option key={name} value={name}>{name} · {item.phase} · {item.body}</option>)}
      </select></label>}
      {result.frames && <label className={sim.row}>{result.frames.some((frame) => frame.label) ? 'Shown' : 'Time'} <select aria-label="Result time" value={state.frame} onChange={(event) => useSimulation.setState({ frame: Number(event.target.value) })}>
        {result.frames.map((frame, index) => <option key={index} value={index}>{frame.label ?? `${number(frame.time_s)} s`}</option>)}
      </select></label>}
      {result.modes ? <label className={sim.row}>Mode <select aria-label={result.analysis === 'buckling' ? 'Buckling mode' : 'Vibration mode'} value={state.field} onChange={(event) => useSimulation.setState({ field: event.target.value })}>
        {result.modes.map((mode) => <option key={mode.field} value={mode.field}>Mode {mode.number} · {mode.load_factor !== undefined ? `load factor ${number(mode.load_factor)}` : `${number(mode.frequency_hz ?? NaN)} Hz`}</option>)}
        <option value="mesh">Mesh</option>
      </select></label> : <label className={sim.row}>Show <select aria-label="Result field" value={state.field} onChange={(event) => useSimulation.setState({ field: event.target.value })}>
        {fields.map(([name, label]) => <option key={name} value={name}>{label}</option>)}
      </select></label>}
      {state.field !== 'mesh' && state.range && <div aria-label="Result legend" className={styles.stack} data-field={state.field}>
        <ResultsLegend studyName={study.name} />
        {state.field === 'safety' && <small>Yield strength {show(yieldPa ?? 0, 'Pa').value} MPa ÷ von Mises stress. Red: below 1, where the material yields.</small>}
        {state.field === 'safety' && <SafetyControls />}
      </div>}
      {state.field === 'von_mises' && <small className={styles.muted}>Nodal stress, extrapolated. Peaks at sharp corners or at point supports depend on the mesh.</small>}
      {result.engine.openfoam && <small className={styles.muted}>Surface colors show boundary values. {gasFlow ? 'Pressures and temperatures are absolute' : 'Pressures are gauge values'}; cell fields are in the downloadable results.</small>}
      <div className={sim.buttons}>
        <Button size="sm" icon={<Sparkles />} id="study-ask-steve" onClick={() => askSteve(study)}>Ask STEVE about these results</Button>
        <span className={sim.spacer} />
        <Button size="sm" onClick={() => useSimulation.setState({ result: null })}>Back to setup</Button>
      </div>
    </div></Section>
    <Section title="Display" id="results-display" defaultOpen={false}><DisplaySettings /></Section>
    {deformable && <Section title="Deformation" id="results-deformation"><div className={sim.deformation}>
      <div className={sim.row}><span>Scale</span><b id="deformation-scale" title={deformationText(state.deformation, state.autoDeformation)}>×{number(state.deformation)}</b></div>
      <Segmented size="sm" value={(preset ?? '') as DeformationPreset} onChange={(id) => useSimulation.setState({ deformation: presetScale(id, state.autoDeformation) })}
        options={DEFORMATION_PRESETS.map((item) => ({ value: item.id, label: item.label }))} />
      <Slider label="Deformation scale" value={Math.min(state.deformation, sliderMax)} min={0} max={sliderMax} step={sliderMax / 400} onChange={(deformation) => useSimulation.setState({ deformation })} />
      <small id="deformation-text">{deformationText(state.deformation, state.autoDeformation)}{preset === 'auto' ? ': the largest displacement drawn at 10% of the part’s size' : ''}{state.deformation > 0 && state.ghost ? '. The undeformed shape shows as a ghost.' : ''}</small>
    </div></Section>}
    {result.modal && <Section title="Mode shape" id="results-mode"><div className={styles.stack}>
      <span className={sim.label}>Display amplitude</span>
      <NumberField value={state.deformation * result.modal.display_amplitude_m * 1000} unit="mm" ariaLabel="Mode display amplitude" onChange={(value) => {
        if (value >= 0) useSimulation.setState({ deformation: value / (result.modal!.display_amplitude_m * 1000) });
      }} />
      <small>Mode amplitude is arbitrary. Colors show relative motion normalized to a maximum of 1.</small>
      <Button size="sm" disabled={state.field === 'mesh'} onClick={() => useSimulation.setState({ playing: !state.playing })}>{state.playing ? 'Stop mode animation' : 'Animate mode shape'}</Button>
      <small>{result.modal.assumptions}</small>
    </div></Section>}
    {state.field !== 'mesh' && <Section title={`Probes${state.probes.length ? ` · ${state.probes.length}` : ''}`} id="results-probes"><Probes study={study} /></Section>}
    {!!result.probes?.length && <Section title="Temperature history" id="results-temperature-history"><TemperatureHistory /></Section>}
    <Section title="Summary" id="results-summary"><div className={styles.stack}>
      {gasFlow && <GasPerformance study={study} manifest={result} summary={summary} checks={(resultFrame?.checks ?? result.checks) as Record<string, unknown>} />}
      <RotationResults summary={summary} />
      <dl className={sim.summary} id="result-summary">
        {Object.entries(summary).filter(([key, value]) => typeof value === 'number' && !(gasFlow && PERFORMANCE_KEYS.has(key))).map(([key, value]) => {
          const { label, shown } = summaryLine(key, value, flow);
          return <div key={key}><dt>{label}</dt><dd title={shown.title}>{shown.value} {shown.unit}</dd></div>;
        })}
        {structural(study) && maxVonMises && yieldPa ? <div data-tone={yieldPa / maxVonMises < 1 ? 'danger' : undefined}><dt>Min safety factor</dt><dd id="min-safety">{number(yieldPa / maxVonMises)}</dd></div> : null}
      </dl>
      {result.checks?.turbulence && <small id="turbulence-record">k-ω SST turbulence · wall y+ {number(Math.min(...Object.values(result.checks.turbulence.y_plus).map((wall) => wall.min)))}–{number(Math.max(...Object.values(result.checks.turbulence.y_plus).map((wall) => wall.max)))}. Below 5 the flow next to the wall is resolved, 30–300 it follows the log law; between them is least accurate.</small>}
      {result.checks?.temperature_bounds_warning && <p className={sim.resultWarning} id="temperature-bounds-warning" role="note"><b>Check this result.</b> {result.checks.temperature_bounds_warning}</p>}
      {result.checks?.mesh_quality_warning && <MeshWarning warning={result.checks.mesh_quality_warning} quality={(result.checks as Record<string, unknown>).mesh_quality} />}
      <PoseNote note={(state.runs[study.id] as { pose_note?: string } | undefined)?.pose_note} />
      {result.transient && <small>{result.transient.time_integrator} · {result.transient.output_interval_s !== undefined
        ? <>saved every {number(result.transient.output_interval_s)} s · {result.transient.solver_steps?.toLocaleString()} solver steps of {number(result.transient.min_time_step_s ?? result.transient.time_step_s)}–{number(result.transient.time_step_s)} s, max Courant {number(result.transient.max_courant ?? 0)} (target {number(result.transient.courant_limit ?? 1)}). Refine the mesh, and lower the Courant target to refine time.</>
        : <>step {number(result.transient.time_step_s)} s. Refine time steps as well as the mesh.</>} {result.transient.assumptions}</small>}
      <span className={styles.muted} id="study-provenance">{result.engine.openfoam ? `OpenFOAM ${result.engine.openfoam}` : `CalculiX ${result.engine.calculix}`} · Gmsh {result.engine.gmsh}{engineId ? ` · engine ${engineId.slice(0, 8)}` : ''}{result.provenance.steve_version ? ` · STEVE ${result.provenance.steve_version}` : ''} · design revision {result.provenance.design.revision}, study revision {result.provenance.study_revision} · {result.mesh.elements.toLocaleString()} elements{result.mesh.options ? ` (${Object.values(result.mesh.options).join(', ').replaceAll('_', ' ')})` : ''}</span>
      {run.reused_from && <small className={styles.muted} id="study-reused">These inputs were already {run.operation === 'mesh' ? 'meshed' : 'solved'}: this is that result, kept rather than computed again.</small>}
      {run.engine_current === false && <div className={sim.row} id="study-engine-note"><small className={styles.muted}>Solved on an earlier engine version. The result stays valid for these inputs.</small>
        <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => { void runStudy(run.operation, true); }}>Re-run on current engine</Button></div>}
      <a className={sim.link} href={withWorkspace(`/v1/simulation/runs/${run.id}/results`)} download="simulation-results.json"><Download size={13} /> Download results (JSON)</a>
    </div></Section>
  </div>;
}

/** Temperature probes a thermal study may have (simulation/schema.py MAX_PROBES). */
const PROBE_LIMIT = 20;
const pointText = (point: number[]) => `${point.map((v) => Number(v.toFixed(2))).join(', ')} mm`;
const probeLabel = (probe: StudyProbe, names: Record<string, string>) => probe.face ? faceLabel(probe.face, names) : `Point ${pointText(probe.point_mm ?? [])}`;

function setProbes(study: Study, probes: StudyProbe[]) {
  if (!study.definition) return;
  updateStudy(study.id, (item) => ({ ...item, definition: { ...item.definition!, probes: probes.slice(0, PROBE_LIMIT) } }));
}

/** Setup: the faces and points where the thermal solve reports the temperature at every time step. */
function TemperatureProbes({ study, names }: { study: Study; names: Record<string, string> }) {
  const selection = useApp((state) => state.selection);
  const [point, setPoint] = useState<[number, number, number]>([0, 0, 0]);
  const probes = study.definition?.probes ?? [];
  const full = probes.length >= PROBE_LIMIT;
  const faces = pinnedSelection(study) ? selection.flatMap((pick) => { try { return [qualifiedReference(pick)]; } catch { return []; } })
    .filter((ref) => !probes.some((probe) => probe.face === ref)) : [];
  return <Section title={`Temperature probes${probes.length ? ` · ${probes.length}` : ''}`}><div className={styles.stack} id="study-probes">
    {probes.length ? <ul className={sim.probes}>
      {probes.map((probe, index) => <li key={index} data-study-probe={index}>
        <span title={probe.face ?? undefined}>{probeLabel(probe, names)}</span>
        <button type="button" aria-label={`Remove temperature probe ${index + 1}`} onClick={() => setProbes(study, probes.filter((_, i) => i !== index))}><X size={12} /></button>
      </li>)}
    </ul> : <small className={styles.muted}>The solve reports the temperature here at every time step: a face’s minimum, mean and maximum, or a point inside the part.</small>}
    <Button size="sm" disabled={!faces.length || full} onClick={() => setProbes(study, [...probes, ...faces.map((face) => ({ face }))])}
      title={faces.length ? undefined : 'Select faces in the viewport first'}>Probe selected face{faces.length > 1 ? 's' : ''}</Button>
    <span className={sim.label}>Point</span>
    {(['X', 'Y', 'Z'] as const).map((axis, index) => <NumberField key={axis} value={point[index]} unit="mm" prefix={axis} ariaLabel={`Probe point ${axis}`} onChange={(value) => {
      setPoint((current) => current.map((v, i) => i === index ? value : v) as [number, number, number]);
    }} />)}
    <Button size="sm" disabled={full} onClick={() => setProbes(study, [...probes, { point_mm: point }])}>Probe this point</Button>
    {full && <small className={sim.warn}>A study has at most {PROBE_LIMIT} probes.</small>}
  </div></Section>;
}

/** A result's temperature probes: the reading at the shown time, the peak over the whole history, and the history as CSV. */
function TemperatureHistory() {
  const names = useFeatureNames();
  const frame = useSimulation((s) => s.frame);
  const probes = useSimulation((s) => s.result?.manifest.probes);
  if (!probes?.length) return null;
  const c = (kelvin: number | undefined) => kelvin === undefined ? '—' : show(kelvin, 'K').value;
  const transient = probes[0].history.some((step) => step.time_s !== undefined);
  const download = () => {
    const quote = (text: string) => `"${text.replaceAll('"', '""')}"`;
    const header = [...(transient ? ['time (s)'] : []), ...probes.flatMap((probe) => {
      const label = probeLabel(probe, names);
      return probe.face ? [`${label} min (°C)`, `${label} mean (°C)`, `${label} max (°C)`] : [`${label} (°C)`];
    })];
    const rows = probes[0].history.map((_, index) => [...(transient ? [String(probes[0].history[index].time_s)] : []), ...probes.flatMap((probe) => {
      const step = probe.history[index];
      const values = probe.face ? [step.min_temperature_k, step.mean_temperature_k, step.max_temperature_k] : [step.temperature_k];
      return values.map((value) => value === undefined ? '' : String(value - 273.15));
    })].join(','));
    const url = URL.createObjectURL(new Blob([[header.map(quote).join(','), ...rows].join('\n') + '\n'], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'temperature-probes.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className={styles.stack} id="result-temperature-history">
    <ul className={sim.probes}>
      {probes.map((probe, index) => {
        const step = probe.history[Math.min(frame, probe.history.length - 1)];
        const peak = probe.history.reduce((best, item) => ((item.max_temperature_k ?? item.temperature_k ?? -Infinity) > (best.max_temperature_k ?? best.temperature_k ?? -Infinity) ? item : best), probe.history[0]);
        return <li key={index} data-probe-history={index} title={probe.face ? 'Minimum / mean / maximum over the face' : undefined}>
          <span>{probeLabel(probe, names)}{transient && peak.time_s !== undefined ? ` · peak ${c(peak.max_temperature_k ?? peak.temperature_k)} °C at ${number(peak.time_s)} s` : ''}</span>
          <b>{probe.face ? `${c(step.min_temperature_k)} / ${c(step.mean_temperature_k)} / ${c(step.max_temperature_k)}` : c(step.temperature_k)} °C</b>
        </li>;
      })}
    </ul>
    <small className={styles.muted}>{transient ? 'At the time shown above. ' : ''}Faces show minimum / mean / maximum; points are interpolated in the element that holds them.</small>
    <Button size="sm" icon={<Download />} onClick={download}>Download {transient ? 'history' : 'readings'} (CSV)</Button>
  </div>;
}

/** Probes: hover reads the value under the pointer; a click pins it. */
function Probes({ study }: { study: Study }) {
  const probes = useSimulation((s) => s.probes);
  const field = useSimulation((s) => s.field);
  const region = useSimulation((s) => s.region);
  const manifest = useSimulation((s) => s.result?.manifest);
  if (!manifest) return null;
  const unit = field === 'safety' ? '' : visibleFields(manifest, region)[field]?.units;
  const value = (v: number) => (field === 'safety' ? { value: v >= SAFETY_CAP ? `≥ ${SAFETY_CAP}` : v.toPrecision(3), unit: '' } : show(v, unit, fluid(study)));
  const mm = (v: number) => (Math.abs(v) < 0.05 ? '0' : v.toFixed(1));
  const tracked = study.definition?.probes ?? [];
  const trackable = study.type === 'thermal' && !!study.definition && tracked.length < PROBE_LIMIT;
  return <div className={styles.stack} id="result-probes">
    {!!probes.length && <div className={sim.row}><span className={styles.muted}>Pinned on the model</span>
      {trackable && <Button size="sm" variant="ghost" id="probes-track" title="Add these points to the study’s temperature probes; solve again for their temperature at every time step"
        onClick={() => setProbes(study, [...tracked, ...probes.map((probe) => ({ point_mm: probe.at.map((v) => Number(v.toFixed(3))) as [number, number, number] }))])}>Track over time</Button>}
      <Button size="sm" variant="ghost" onClick={() => useSimulation.setState({ probes: [] })}>Clear</Button>
    </div>}
    {probes.length ? <ul className={sim.probes}>
      {probes.map((probe) => {
        const shown = value(probe.value);
        return <li key={probe.id} data-probe={probe.id}>
          <b>{shown.value}{shown.unit ? ` ${shown.unit}` : ''}</b>
          <span>{probe.inside ? 'inside · ' : ''}{mm(probe.at[0])}, {mm(probe.at[1])}, {mm(probe.at[2])} mm</span>
          <button type="button" aria-label={`Remove probe ${probe.id}`} onClick={() => useSimulation.setState({ probes: useSimulation.getState().probes.filter((item) => item.id !== probe.id) })}><X size={12} /></button>
        </li>;
      })}
    </ul> : <small>Hover the part to read the value under the pointer; click to pin a probe.</small>}
  </div>;
}

const instanceLabel = (name: string) => name.split('/').map(pretty).join(' › ');

/**
 * What a design study analyses. Structural, thermal, modal and flow studies solve one solid, so they take one
 * component instance (the one its faces are on); conjugate heat transfer joins several (all by default).
 */
function Analyse({ study }: { study: Study }) {
  const build = useApp((state) => state.displayed?.id);
  const selection = useApp((state) => state.selection);
  const options = useMemo(() => analysableInstances(), [build]); // eslint-disable-line react-hooks/exhaustive-deps
  const analysed = study.definition?.design.instances ?? [];
  const single = singleSolid(study);
  const fromFaces = study.loads.some((load) => load.refs?.length);
  // Faces already picked on one component settle it (a study created before this choice existed, say).
  useEffect(() => {
    if (needsInstance(study) && fromFaces) { const suggested = suggestedInstance(study); if (suggested) setAnalysed(study.id, [suggested], true); }
  }, [study.id, fromFaces, analysed.length, build]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!study.definition || (options.length < 2 && !analysed.length)) return null;
  if (!pinnedSelection(study)) return <Section title="Analyse"><div className={styles.stack}>
    <span>{analysed.length ? analysed.map(instanceLabel).join(', ') : 'The whole design'}</span>
    <small className={styles.muted}>Open the design revision this study is pinned to (and generate it) to change what it analyses.</small>
  </div></Section>;
  const groups = [...options.reduce((all, option) => all.set(option.groupLabel, [...(all.get(option.groupLabel) ?? []), option]), new Map<string, typeof options>())];
  const chosen = options.find((option) => option.name === analysed[0]);
  let selected: string | null = null;
  for (const pick of selection) { try { selected = instanceOfNode(pick.node); break; } catch { /* not an instance */ } }
  if (single) return <Section title="Analyse"><div className={styles.stack} id="study-analyse">
    <label className={sim.row}>Component <select aria-label="Analysed component" value={analysed[0] ?? ''} onChange={(event) => setAnalysed(study.id, event.target.value ? [event.target.value] : [])}>
      {!analysed.length && <option value="">Choose a component…</option>}
      {groups.map(([group, items]) => items.length === 1 && items[0].label === group
        ? <option key={items[0].name} value={items[0].name}>{items[0].label}</option>
        : <optgroup key={group} label={group}>{items.map((option) => <option key={option.name} value={option.name}>{option.label}</option>)}</optgroup>)}
    </select></label>
    <small className={styles.muted}>{study.type === 'flow' || study.type === 'compressible' ? 'A flow study analyses one fluid volume: choose the component that models it.'
      : 'Structural, thermal and modal studies analyse one component at a time (contact between parts isn’t modelled yet); the rest of the design stays out of the solve.'}</small>
    {!analysed.length && selected && options.some((option) => option.name === selected) && <Button size="sm" onClick={() => setAnalysed(study.id, [selected!])}>Analyse {instanceLabel(selected)} (selected)</Button>}
    {!analysed.length && <p className={sim.warn}>Choose the component to analyse, or pick a boundary’s faces on it.</p>}
    {chosen && chosen.bodies.length > 1 && <p className={sim.warn}>{chosen.label} has {chosen.bodies.length} bodies; this study solves one solid. Analyse a single-body component, or make each body its own component.</p>}
  </div></Section>;
  const included = analysed.length ? analysed : options.map((option) => option.name);
  const toggle = (name: string, on: boolean) => {
    const next = on ? [...included, name] : included.filter((item) => item !== name);
    if (!next.length) return;
    setAnalysed(study.id, next.length === options.length ? [] : options.map((option) => option.name).filter((item) => next.includes(item)));
  };
  return <Section title="Analyse"><div className={styles.stack} id="study-analyse">
    <div className={sim.instances} role="group" aria-label="Analysed components">
      {options.map((option) => <label key={option.name}><input type="checkbox" checked={included.includes(option.name)} onChange={(event) => toggle(option.name, event.target.checked)} />
        <span>{option.label}</span>{option.groupLabel !== option.label && <small>{option.groupLabel}</small>}</label>)}
    </div>
    <small className={styles.muted}>Conjugate heat transfer joins the components you include, through their shared faces.</small>
  </div></Section>;
}

/** Points the camera at a location in the design (mm). */
function focusOn(point: number[]) {
  const radius = Math.max(viewer.modelRadius() * 0.35, 1);
  viewer.frame(new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(point[0], point[1], point[2]), new THREE.Vector3(radius, radius, radius)), null, true);
}

interface Overlap { bodies: string[]; volume_mm3: number; near_mm: number[] }

/** Where checkMesh found cells that put a flow result at risk (mesh_quality.problems, per region for CHT): each place's
 *  centre (mm), a place several checks found once, at most four. */
function badCellPlaces(quality: unknown): number[][] {
  if (!quality || typeof quality !== 'object') return [];
  const item = quality as Record<string, unknown>;
  const qualities = 'quality_warnings' in item ? [item] : Object.values(item) as Record<string, unknown>[];
  const places: number[][] = [];
  for (const one of qualities) {
    for (const check of Object.values((one?.problems ?? {}) as Record<string, { at?: { center_mm: number[] }[] }>)) {
      for (const place of check?.at ?? []) {
        if (places.length < 4 && !places.some((seen) => seen.every((v, i) => Math.abs(v - place.center_mm[i]) < 1))) places.push(place.center_mm);
      }
    }
  }
  return places;
}

/** A button per place with bad cells, pointing the camera there. */
function BadCells({ quality }: { quality: unknown }) {
  const places = badCellPlaces(quality);
  if (!places.length) return null;
  return <div className={sim.buttons}>{places.map((place, index) => <Button key={index} size="sm" icon={<Crosshair />} data-show-bad-cells={index}
    onClick={() => focusOn(place)}>{places.length > 1 ? `Show bad cells ${index + 1}` : 'Show bad cells'}</Button>)}</div>;
}

/** A flow result whose mesh failed checkMesh's risky quality checks: what failed, then where and what to do on request. */
function MeshWarning({ warning, quality }: { warning: string; quality: unknown }) {
  const end = warning.indexOf('. ') + 1;
  return <div className={sim.resultWarning} id="mesh-quality-warning" role="note">
    <p style={{ margin: 0 }}><b>Check this result.</b> {end ? warning.slice(0, end) : warning}</p>
    {end > 0 && <details><summary>Where, and what to do</summary><p style={{ margin: '4px 0 0' }}>{warning.slice(end + 1)}</p></details>}
    <BadCells quality={quality} />
  </div>;
}

/** A failed run. Faces that no longer exist in the study's revision name the boundaries that used them, with a way to pick again. */
function RunError({ study, error }: { study: Study; error: { code: string; message: string } & Record<string, unknown> }) {
  const references = new Set([...(Array.isArray(error.references) ? error.references : []), ...(typeof error.reference === 'string' ? [error.reference] : [])].map(String));
  const affected = error.code === 'reference_missing' ? study.loads.filter((load) => load.refs?.some((ref) => references.has(ref))) : [];
  if (error.code === 'geometry_overlap') {
    const overlaps = (Array.isArray(error.overlaps) ? error.overlaps : []) as Overlap[];
    return <div role="alert" className={sim.error} data-code={error.code}>
      <p style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}><span style={{ flex: 1 }}>{error.message}</span><CopyMessage text={`${error.message} (${error.code})`} /></p>
      {overlaps.length > 1 && <ul className={sim.overlaps}>{overlaps.map((item, index) => <li key={index}>
        {pretty(item.bodies[0])} ↔ {item.bodies[1]} · {item.volume_mm3.toLocaleString(undefined, { maximumFractionDigits: 0 })} mm³</li>)}</ul>}
      <div className={sim.buttons}>{overlaps.map((item, index) => <Button key={index} size="sm" icon={<Crosshair />} data-show-overlap={index}
        onClick={() => focusOn(item.near_mm)}>{overlaps.length > 1 ? `Show overlap ${index + 1}` : 'Show overlap'}</Button>)}</div>
    </div>;
  }
  if (error.code === 'unsupported_physics' && Array.isArray(error.bodies)) return <div role="alert" className={sim.error} data-code={error.code}>
    <p style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}><span style={{ flex: 1 }}>{error.message}</span><CopyMessage text={`${error.message} (${error.code})`} /></p>
    <p className={styles.muted}>Choose the component under Analyse, then solve again.</p>
  </div>;
  if (!affected.length) return <div role="alert" className={sim.error} data-code={error.code}><p style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}><span style={{ flex: 1 }}>{error.message}</span><CopyMessage text={`${error.message} (${error.code})`} /></p>
    <BadCells quality={error.mesh_quality} />
    {typeof error.log_tail === 'string' && error.log_tail.trim() && <details className={sim.log} data-solver-log>
      <summary>Solver log{typeof error.returncode === 'number' && error.returncode ? ` (exit code ${error.returncode})` : ''}</summary>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><CopyMessage text={error.log_tail} /></div>
      <pre>{error.log_tail}</pre>
    </details>}</div>;
  const names = affected.map((load) => LOAD_TYPES[load.type].label);
  return (
    <div role="alert" className={sim.error} data-code={error.code}>
      <p>The faces chosen for {names.join(', ')} aren’t in this revision of the design any more (the geometry changed). Pick them again, then solve.</p>
      <div className={sim.buttons}>
        {affected.map((load) => <Button key={load.id} size="sm" icon={<Crosshair />} onClick={() => startPicking(study.id, load.id)}>Pick faces for {LOAD_TYPES[load.type].label}</Button>)}
      </div>
    </div>
  );
}

export default function StudyInspector() {
  const study = useApp((state) => state.studies.find((item) => item.id === state.activeStudy));
  const design = useApp((state) => state.doc.saved);
  const state = useSimulation();
  const names = useFeatureNames();
  // Until a flow study's fluid is confirmed once, its fields are a draft (water by default); then they apply directly.
  const [fluidDraft, setFluidDraft] = useState({ density_kg_m3: 1000, dynamic_viscosity_pa_s: .001 });
  const run = study ? state.runs[study.id] : undefined;
  const elapsed = useElapsed(run && !terminal(run) ? state.startedAt[run.id] : undefined);
  const overview = useApp((app) => app.studyOverview);
  // Surface bodies (model.fill, boundary_surface) are left out of every study's geometry: said, not silently dropped.
  const surfaces = useApp((app) => app.displayed?.metadata?.surface_bodies);
  // All studies at once (the Studies row in the browser): their list and colour scales, here rather than over the model.
  if (overview) return <AllStudies />;
  if (!study) return <div className={styles.empty} style={{ height: 'auto', paddingTop: 48 }}>
    <StudyIcon size={30} /><h3>No simulation study</h3>
    <p>A study keeps its design revision, materials, supports, loads and results together. Start with a static stress study, or pick another type from New study.</p>
    <Button variant="primary" size="sm" disabled={!design || state.busy} onClick={() => createStudy('static')}>New static stress study</Button>
    {!design && <p className={styles.muted}>Save the design first.</p>}
    {state.error && <p role="alert">{state.error}</p>}
  </div>;
  const active = run && !terminal(run);
  const pin = study.definition?.design;
  const updateAvailable = pin && design && (pin.revision !== design.revision || pin.branch !== get().doc.branch);
  const dirty = studyDirty(study);
  const missing = study.loads.filter((load) => load.type !== 'gravity' && !load.refs?.length);
  const choose = needsInstance(study);
  // An unchanged study whose last run failed runs again only when asked: the button says so.
  const tryAgain = (operation: 'mesh' | 'solve') => !dirty && run?.status === 'failed' && run.operation === operation;
  const updateAnalysis = (patch: Partial<NonNullable<typeof study.definition>['analysis']>) => {
    if (!study.definition) return;
    updateStudy(study.id, (item) => ({ ...item, definition: { ...study.definition!, analysis: { ...study.definition!.analysis, ...patch } } }));
  };
  // Laminar or k-omega SST: incompressible flow, the fluid region of conjugate heat transfer and compressible flow.
  const flowModel = <>
    <label className={sim.row}>Flow model <select aria-label="Flow model" value={study.definition?.analysis.turbulence?.model ?? 'laminar'} onChange={(event) => {
      if (!study.definition) return;
      const definition = study.definition;
      // Turbulent flow: tetrahedral cells with a wall-aligned stack of layers on the walls (the tetrahedra go on
      // without it where it cannot grow), and turbulent heat transfer with second-order energy convection
      // (simulation/schema.py Study.physics, new_study). Back to laminar, that stack is taken off again.
      const turbulent = event.target.value === 'k_omega_sst';
      const heat = definition.analysis.type === 'cht_steady';
      const layered = definition.analysis.type === 'flow_steady' || definition.analysis.type === 'flow_transient';
      const { boundary_layers: layers, ...mesh } = definition.mesh;
      updateStudy(study.id, (item) => ({ ...item, definition: { ...definition,
        analysis: { ...definition.analysis, turbulence: turbulent ? { model: 'k_omega_sst' } : undefined,
          ...(heat && turbulent ? { solver: { ...definition.analysis.solver, energy_scheme: 'linear_upwind' } } : {}) },
        mesh: turbulent
          ? { ...definition.mesh, flow_cells: 'tetrahedral', dual_concave_edges: undefined,
              ...(layered && !layers && !definition.analysis.rotation?.length ? { boundary_layers: { stack: true, growth: 1.25 } } : {}) }
          : layers?.stack ? mesh : definition.mesh } }));
    }}><option value="laminar">{study.definition?.gas?.dynamic_viscosity_pa_s === 0 ? 'Inviscid' : 'Laminar'}</option><option value="k_omega_sst">Turbulent (k-ω SST)</option></select></label>
    {study.definition?.analysis.turbulence?.model === 'k_omega_sst' && <>
      <span className={sim.label}>Inlet turbulence</span>
      <NumberField value={(study.definition.analysis.turbulence.inlet_intensity ?? 0.05) * 100} unit="%" ariaLabel="Inlet turbulence intensity" onChange={(percent) => {
        if (percent >= 0.01 && percent <= 50) updateAnalysis({ turbulence: { ...study.definition!.analysis.turbulence!, inlet_intensity: percent / 100 } });
      }} />
      <small>Turbulent when the Reynolds number is high: above about 2300 in a pipe or channel (hydraulic diameter). Inlet turbulence: 5 % for an ordinary duct, 1 % for a quiet stream, 10–20 % behind a fan or grille. Turbulent flow is meshed with tetrahedral cells, with thin cells stacked along the walls.</small>
    </>}
  </>;
  const updateLink = async () => {
    if (!study.definition || !design) return;
    if (get().pastVersion || isDirty() || isPreviewStale()) { report(new Error('Save and generate the design before updating the study link.')); return; }
    const updated = { ...study, definition: { ...study.definition, design: { ...study.definition.design, revision: design.revision, branch: get().doc.branch } } };
    // An incomplete setup can follow a new design revision before it is ready
    // to become a durable study; this must not create an invalid server record.
    if (!study.revision) { replaceStudy(updated, design.id); return; }
    try { await saveStudy(updated); }
    catch (error) { report(error); }
  };
  const fluidValue = study.definition?.fluid;
  const setFluid = (patch: { density_kg_m3?: number; dynamic_viscosity_pa_s?: number }) => {
    if (!study.definition) return;
    const current = study.definition.fluid ?? { name: 'Study fluid', density_kg_m3: 1000, dynamic_viscosity_pa_s: .001 };
    updateStudy(study.id, (item) => ({ ...item, definition: { ...study.definition!, materials: {}, fluid: { ...current, ...patch } } }));
  };
  const stale = state.result ? staleness(study, state.result.manifest, state.result.run) : null;
  return <>
    <div className={styles.hero}>
      <div className={styles.heroIcon}><StudyIcon size={20} /></div>
      <div className={styles.heroText}><div className={styles.heroTitle}>{study.name}</div>
        <div className={styles.heroSub}>{STUDY_TYPES[study.type].label} · {study.revision ? (dirty ? `Revision ${study.revision} · unsaved changes` : `Revision ${study.revision} · saved`) : 'Draft'}</div></div>
    </div>
    <Section title="Solve" id="study-solve-section"><div className={styles.stack}>
      {!state.result && <ol className={sim.steps}>
        <li data-done={study.type === 'flow' ? !!fluidValue || undefined : study.type === 'compressible' ? !!study.definition?.gas || undefined : true}>{study.type === 'flow' ? 'Fluid properties' : study.type === 'compressible' ? 'Gas' : modelWritten(study) ? (study.type === 'openfoam_case' ? 'The case’s files, below' : 'The deck, below') : 'Materials come from the design'}</li>
        <li data-done={study.loads.length > 0 && !missing.length || undefined}>{study.type === 'flow' || study.type === 'compressible' ? 'Inlets, outlets and walls' : modelWritten(study) ? 'Named face groups' : study.type === 'thermal' ? 'Temperatures and heat flows' : study.type === 'modal' ? 'Supports' : 'Supports and loads'} from the ribbon, then click their faces</li>
        <li>Solve (it meshes first)</li>
      </ol>}
      {stale && <div className={sim.staleBanner} role="status" id="study-stale"><span><b>Out of date.</b> {stale}</span>
        <Button size="sm" disabled={state.busy} onClick={() => { void resolveCurrent(study); }}>Re-solve</Button></div>}
      {run && <div className={sim.run} role="status" data-status={run.status} id="study-run">
        <span className={sim.dot} />
        <span title={run.waiting?.message}>{run.operation === 'mesh' ? 'Mesh' : 'Solve'} · {run.cancel_requested && !terminal(run) ? 'Stopping' : stageLabel(run.stage, run.status, run.waiting)}{active ? ` · ${elapsed} s` : ''}</span>
        <span className={sim.spacer} />
        {active && <Button size="sm" variant="ghost" icon={<Square />} disabled={run.cancel_requested} onClick={() => { void cancelRun(run); }}>Cancel</Button>}
      </div>}
      {state.error ? <div role="alert" className={sim.error}><p style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}><span style={{ flex: 1 }}>{state.error}</span><CopyMessage text={state.error} /></p></div> : run?.error ? <RunError study={study} error={run.error} /> : null}
      {missing.length > 0 && <p className={sim.warn}>{missing.map((load) => LOAD_TYPES[load.type].label).join(', ')} {missing.length === 1 ? 'has' : 'have'} no faces yet.</p>}
      {surfaces && <p className={sim.warn} id="study-surfaces">{surfaceNote(surfaces)}</p>}
      {choose && <p className={sim.warn} id="study-choose">Choose the component to analyse (Analyse, under Setup) before solving.</p>}
      <div className={sim.buttons}>
        <Button size="sm" variant="primary" id="study-solve" disabled={state.busy || !!active || !pin || missing.length > 0 || choose} onClick={() => { void runStudy('solve', tryAgain('solve')); }}>{tryAgain('solve') ? 'Try again' : 'Solve'}</Button>
        <Button size="sm" disabled={state.busy || !!active || !pin || missing.length > 0} onClick={() => { void runStudy('mesh', tryAgain('mesh')); }} title="Optional: Solve meshes on its own">{tryAgain('mesh') ? 'Try mesh again' : 'Preview mesh'}</Button>
        <span className={sim.spacer} />
        {dirty ? <Button size="sm" variant="ghost" disabled={state.busy || !pin} onClick={() => { void saveStudy(study).catch(report); }}>Save study</Button> : null}
      </div>
      <small className={styles.muted}>{study.revision ? (dirty ? 'Unsaved changes are saved as a new study revision when you solve.' : `Saved as study revision ${study.revision}.`) : 'Saved when you solve.'}</small>
      <details className={sim.advanced}><summary>Advanced</summary>
        <ResourceSettings key={study.id} disabled={state.busy || !!active} run={run} />
      </details>
    </div></Section>
    {state.result && <Results study={study} />}
    <div className={sim.paneGroup}>Setup</div>
    <Section title="Design link"><div className={styles.stack}>
      {pin ? <>
        <span>Pinned to {pin.branch} · design revision {pin.revision}</span>
        <span className={styles.muted}>{study.type === 'flow' || study.type === 'compressible' ? 'The modeled body must represent the volume occupied by the fluid.'
          : modelWritten(study) ? 'Every body of the design is meshed; the case or deck gives the materials.' : 'Materials come from this revision of the design; overrides are saved in study.py.'}</span>
        {updateAvailable && <><span>The design has a newer revision. Existing results keep the inputs they were solved with.</span><Button size="sm" disabled={state.busy} onClick={() => { void updateLink(); }}>Use current design revision</Button></>}
      </> : <p role="alert">This older browser draft has no verified design revision. Create a linked study and reselect its faces.</p>}
    </div></Section>
    <Analyse study={study} />
    <StudyPose pose={study.definition?.design.pose} editable={pinnedSelection(study)} onChange={(pose) => setPose(study.id, pose)} />
    {study.type === 'cht' && study.definition && <ConjugateSetup key={study.id} study={study} />}
    {modelWritten(study) && study.definition && <CaseSetup key={study.id} study={study} />}
    {study.type === 'cht' && study.definition && <Section title="Fluid flow"><div className={styles.stack}>{flowModel}</div></Section>}
    {study.type === 'modal' && <Section title="Natural vibration"><div className={styles.stack}>
      <NumberField value={study.definition?.analysis.modes ?? 6} unit="modes" ariaLabel="Number of modes" onChange={(modes) => {
        if (!study.definition || !Number.isInteger(modes) || modes < 1 || modes > 1000) return;
        updateAnalysis({ modes });
      }} />
      <small>Finds the lowest undamped frequencies. The material needs elastic properties and a density; add supports to stop rigid-body motion.</small>
    </div></Section>}
    {study.type === 'buckling' && <Section title="Buckling"><div className={styles.stack}>
      <NumberField value={study.definition?.analysis.modes ?? 6} unit="modes" ariaLabel="Number of buckling modes" onChange={(modes) => {
        if (!study.definition || !Number.isInteger(modes) || modes < 1 || modes > 1000) return;
        updateAnalysis({ modes });
      }} />
      <small>Finds the lowest load factors: how many times the loads below the part carries before it buckles. Add supports that stop rigid-body motion and loads that compress the part. A real part, with its imperfections, buckles at or below the factor.</small>
    </div></Section>}
    {['thermal', 'thermal_stress'].includes(study.type) && <Section title="Heat transfer"><div className={styles.stack}>
      {study.type === 'thermal' && <label className={sim.row}>Behavior <select aria-label="Thermal behavior" value={study.definition?.analysis.type} onChange={(event) => {
        const transient = event.target.value === 'thermal_transient';
        updateAnalysis({ type: transient ? 'thermal_transient' : 'thermal_steady', time: transient ? { duration_s: 10, steps: 20, initial_temperature_k: 300 } : null });
      }}><option value="thermal_steady">Steady</option><option value="thermal_transient">Transient</option></select></label>}
      {study.definition?.analysis.time && <>
        <span className={sim.label}>Initial temperature</span>
        <NumberField value={C(study.definition.analysis.time.initial_temperature_k)} unit="°C" ariaLabel="Initial temperature" onChange={(value) => {
          if (K(value) >= 0) updateAnalysis({ time: { ...study.definition!.analysis.time!, initial_temperature_k: K(value) } });
        }} />
        <span className={sim.label}>Duration</span>
        <NumberField value={study.definition.analysis.time.duration_s} unit="s" ariaLabel="Thermal duration" onChange={(value) => {
          if (value > 0) updateAnalysis({ time: { ...study.definition!.analysis.time!, duration_s: value } });
        }} />
        <span className={sim.label}>Time steps</span>
        <NumberField value={study.definition.analysis.time.steps} unit="steps" ariaLabel="Thermal steps" onChange={(value) => {
          if (Number.isInteger(value) && value >= 1 && value <= 100000) updateAnalysis({ time: { ...study.definition!.analysis.time!, steps: value } });
        }} />
        <small>Equal time steps; constant loads and material properties. The material needs a density and specific heat.</small>
      </>}
      <span className={sim.label}>Heat generated inside the part</span>
      <NumberField value={study.definition?.analysis.heat_generation_w_m3 ?? 0} unit="W/m³" ariaLabel="Heat generation" onChange={(heat_generation_w_m3) => updateAnalysis({ heat_generation_w_m3 })} />
      <small>Uniform throughout the solid; positive adds heat. Faces with no boundary are insulated.</small>
    </div></Section>}
    {study.type === 'thermal_stress' && <Section title="Thermal expansion"><div className={styles.stack}>
      <span className={sim.label}>Stress-free temperature</span>
      <NumberField value={C(study.definition?.analysis.reference_temperature_k ?? 300)} unit="°C" ariaLabel="Stress-free temperature" onChange={(value) => {
        if (K(value) >= 0) updateAnalysis({ reference_temperature_k: K(value) });
      }} />
      <small>The part is stress-free at this temperature. The material needs conductivity, elastic properties and a thermal expansion coefficient.</small>
    </div></Section>}
    {study.type === 'flow' && <Section title="Flow behavior"><div className={styles.stack}>
      <label className={sim.row}>Behavior <select aria-label="Flow behavior" value={study.definition?.analysis.type} onChange={(event) => {
        const transient = event.target.value === 'flow_transient';
        if (!transient && study.loads.some((load) => load.type === 'pressure_inlet')) {
          report(new Error('Replace pressure inlets with velocity inlets before switching to steady flow.')); return;
        }
        updateAnalysis({ type: transient ? 'flow_transient' : 'flow_steady', flow_time: transient ? { duration_s: 1, steps: 20, initial_velocity_m_s: [0, 0, 0], max_outer_iterations: 100, max_courant: 1 } : null });
      }}><option value="flow_steady">Steady</option><option value="flow_transient">Transient</option></select></label>
      {flowModel}
      {study.definition?.analysis.flow_time && <>
        <span className={sim.label}>Duration</span>
        <NumberField value={study.definition.analysis.flow_time.duration_s} unit="s" ariaLabel="Flow duration" onChange={(duration_s) => {
          if (duration_s > 0) updateAnalysis({ flow_time: { ...study.definition!.analysis.flow_time!, duration_s } });
        }} />
        <span className={sim.label}>Saved frames</span>
        <NumberField value={study.definition.analysis.flow_time.steps} unit="frames" ariaLabel="Flow steps" onChange={(steps) => {
          if (Number.isInteger(steps) && steps >= 1 && steps <= 10000) updateAnalysis({ flow_time: { ...study.definition!.analysis.flow_time!, steps } });
        }} />
        <span className={sim.label}>Uniform initial velocity</span>
        {(['X', 'Y', 'Z'] as const).map((axis, index) => <NumberField key={axis} value={study.definition!.analysis.flow_time!.initial_velocity_m_s[index]} unit="m/s" prefix={axis} ariaLabel={`Initial velocity ${axis}`} onChange={(value) => {
          const initial_velocity_m_s = [...study.definition!.analysis.flow_time!.initial_velocity_m_s] as [number, number, number];
          initial_velocity_m_s[index] = value;
          updateAnalysis({ flow_time: { ...study.definition!.analysis.flow_time!, initial_velocity_m_s } });
        }} />)}
        <small>Fields are saved at equal intervals; between them the solver takes as many time steps as the Courant limit needs. Constant boundaries apply from the start. The solve rejects unconverged steps and reversed inlet/outlet flow.</small>
      </>}
    </div></Section>}
    {study.type === 'compressible' && study.definition && <><CompressibleBehavior study={study} model={flowModel} /><GasSetup study={study} /></>}
    {(study.type === 'flow' && study.definition?.analysis.type === 'flow_steady'
      || study.type === 'compressible' && study.definition?.analysis.type === 'flow_compressible_steady') && <RotationSetup key={`rotation-${study.id}`} study={study} />}
    {study.type === 'flow' && <Section title="Fluid properties"><div className={styles.stack}>
      <p className={styles.muted}>Constant properties of a Newtonian fluid at the operating temperature (incompressible). Water at 20 °C: 998 kg/m³, 0.001 Pa·s.</p>
      <span className={sim.label}>Density</span>
      <NumberField value={fluidValue?.density_kg_m3 ?? fluidDraft.density_kg_m3} unit="kg/m³" ariaLabel="Fluid density" onChange={(density_kg_m3) => {
        if (density_kg_m3 <= 0) return;
        if (fluidValue) setFluid({ density_kg_m3 }); else setFluidDraft((draft) => ({ ...draft, density_kg_m3 }));
      }} />
      <span className={sim.label}>Dynamic viscosity</span>
      <NumberField value={fluidValue?.dynamic_viscosity_pa_s ?? fluidDraft.dynamic_viscosity_pa_s} unit="Pa·s" ariaLabel="Dynamic viscosity" onChange={(dynamic_viscosity_pa_s) => {
        if (dynamic_viscosity_pa_s <= 0) return;
        if (fluidValue) setFluid({ dynamic_viscosity_pa_s }); else setFluidDraft((draft) => ({ ...draft, dynamic_viscosity_pa_s }));
      }} />
      {!fluidValue && <><Button size="sm" onClick={() => setFluid(fluidDraft)}>Use these fluid properties</Button><small className={sim.warn}>Confirm the fluid before solving.</small></>}
    </div></Section>}
    <Section title={`Boundaries · ${study.loads.length}`}><div className={styles.stack} id="study-boundaries">
      {!study.loads.length && <p className={styles.muted}>{study.type === 'compressible' ? 'Add an inlet (stagnation or mass flow), an ambient outlet and walls from the ribbon.'
        : study.type === 'flow' ? 'Give every fluid face an inlet, outlet or wall condition from the ribbon.'
        : modelWritten(study) ? 'Add named face groups from the ribbon and click their faces: the case or deck refers to them by name.' : 'Add a support or load from the ribbon, then click its faces in the viewport. (Select faces first and they are used straight away.)'}</p>}
      {study.loads.map((load) => <Boundary key={load.id} study={study} load={load} names={names} />)}
    </div></Section>
    {study.type === 'thermal' && study.definition && <TemperatureProbes study={study} names={names} />}
    <Section title="Mesh"><div className={styles.stack}>
      <span className={sim.label}>Element size</span>
      <NumberField value={study.meshSize} unit="mm" ariaLabel="Mesh size" onChange={(meshSize) => { if (meshSize > 0) updateStudy(study.id, (item) => ({ ...item, meshSize })); }} />
      <small>{finiteVolume(study.type) ? 'Polyhedral finite-volume cells.' : 'Quadratic tetrahedra.'} Smaller elements are more accurate and slower: halve the size and compare the numbers you rely on.</small>
    </div></Section>
  </>;
}

import { useEffect, useState } from 'react';
import { Button, NumberField, Section, Segmented } from '@/ui';
import { set, type Study } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import type { Definition, RotatingZone, SlidingMesh } from './api';
import { LOAD_TYPES } from './commands';
import { displayedBodies } from './state';
import { summaryLine } from './units';
import styles from '@/panels/Panels.module.css';
import sim from './Simulate.module.css';

const AXES: { value: string; label: string; v: [number, number, number] }[] = [
  { value: '+x', label: 'X', v: [1, 0, 0] }, { value: '+y', label: 'Y', v: [0, 1, 0] }, { value: '+z', label: 'Z', v: [0, 0, 1] },
  { value: '-x', label: '−X', v: [-1, 0, 0] }, { value: '-y', label: '−Y', v: [0, -1, 0] }, { value: '-z', label: '−Z', v: [0, 0, -1] },
];
const axisKey = (axis: number[]) => AXES.find((a) => a.v.every((value, i) => Math.abs(value - axis[i] / Math.hypot(...axis)) < 1e-9))?.value ?? '';
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A sliding mesh's starting settings (simulation/schema.py SlidingMesh): six revolutions of one degree steps, the last one averaged. */
const SLIDING: Required<Omit<SlidingMesh, 'max_outer_iterations'>> = { revolutions: 6, steps_per_revolution: 360, average_revolutions: 1, phases: 4 };

/**
 * Rotating machinery in a steady flow study (analysis.rotation, frozen rotor): each zone is a fluid body of its own
 * around a rotor, turning at its speed about its axis, with the walls that turn with it. The same zones can run
 * time-accurate on a sliding mesh (analysis.sliding_mesh).
 */
export function RotationSetup({ study }: { study: Study }) {
  const definition = study.definition!;
  const zones = definition.analysis.rotation ?? [];
  const bodies = displayedBodies(study);
  const walls = study.loads.filter((load) => load.type === 'no_slip');
  const update = (change: (value: Definition) => Definition) => {
    set((state) => ({ studies: state.studies.map((item) => item.id === study.id && item.definition ? { ...item, definition: change(item.definition) } : item) }));
    persistWorkspaceData();
  };
  const sliding = definition.analysis.sliding_mesh ?? null;
  const setSliding = (next: SlidingMesh | null) => update((d) => ({ ...d, analysis: { ...d.analysis, sliding_mesh: next } }));
  const setZones = (next: RotatingZone[]) => update((d) => ({
    ...d, analysis: { ...d.analysis, rotation: next, ...(next.length ? {} : { sliding_mesh: null }) },
    // A zone is its body's tetrahedra, and every body of the design is fluid.
    ...(next.length ? { mesh: { ...d.mesh, flow_cells: 'tetrahedral', ...(d.mesh.dual_concave_edges ? { dual_concave_edges: 'single_cell' as const } : {}) }, design: { ...d.design, instances: [] } } : {}),
  }));
  const change = (index: number, patch: Partial<RotatingZone>) => setZones(zones.map((zone, i) => (i === index ? { ...zone, ...patch } : zone)));
  const add = () => {
    const free = bodies.find((body) => !zones.some((zone) => zone.body === body)) ?? '';
    let n = zones.length + 1;
    while (zones.some((zone) => zone.id === `rotor_${n}`)) n += 1;
    setZones([...zones, { id: `rotor_${n}`, body: free, origin_m: [0, 0, 0], axis: [0, 0, 1], rpm: 1000, walls: [] }]);
  };
  return <Section title="Rotating zones"><div className={styles.stack}>
    {study.type === 'compressible' && study.definition?.analysis.compressible?.solver !== 'pressure_based'
      && zones.length > 0 && <p className={sim.warn}>Rotating zones need the Subsonic (pressure-based) solver.</p>}
    <span className={styles.muted}>Fans, pumps and impellers as a frozen rotor: the fluid around the rotor is its own body (a cylinder or ring about the axis,
      minus the rotor), meeting the rest of the fluid over complete faces. Inlets and outlets stay outside it.</span>
    {zones.map((zone, index) => <div key={index} className={sim.boundary}>
      <ZoneName zone={zone} taken={zones.filter((_, i) => i !== index).map((other) => other.id)} onChange={(id) => change(index, { id })} />
      <label className={sim.row}>Body <select aria-label="Rotating body" value={zone.body} onChange={(event) => change(index, { body: event.target.value })}>
        {!bodies.includes(zone.body) && <option value={zone.body}>{zone.body || 'Choose a body'}</option>}
        {bodies.map((body) => <option key={body} value={body}>{body}</option>)}</select></label>
      <span className={sim.label}>Axis</span>
      <Segmented size="sm" value={axisKey(zone.axis)} onChange={(value) => change(index, { axis: AXES.find((a) => a.value === value)!.v })}
        options={AXES.map((a) => ({ value: a.value, label: a.label }))} />
      <span className={sim.label}>Axis origin</span>
      <div className={sim.buttons}>{['X', 'Y', 'Z'].map((label, i) => <NumberField key={label} value={zone.origin_m[i] * 1000} unit="mm" ariaLabel={`Axis origin ${label}`}
        onChange={(value) => change(index, { origin_m: zone.origin_m.map((v, j) => (j === i ? value / 1000 : v)) as [number, number, number] })} />)}</div>
      <span className={sim.label}>Speed (negative turns the other way)</span>
      <NumberField value={zone.rpm} unit="rpm" ariaLabel="Rotor speed" onChange={(rpm) => { if (rpm) change(index, { rpm }); }} />
      <span className={sim.label}>Walls that turn with it</span>
      {walls.length ? walls.map((wall, i) => <label key={wall.id} className={sim.row}>
        <span>{LOAD_TYPES.no_slip.label} {i + 1} · {wall.refs?.length ?? 0} faces</span>
        <input type="checkbox" checked={zone.walls.includes(wall.id)} aria-label={`No-slip wall ${i + 1} turns`}
          onChange={(event) => change(index, { walls: event.target.checked ? [...zone.walls, wall.id] : zone.walls.filter((id) => id !== wall.id) })} />
      </label>) : <p className={sim.warn}>Add the rotor's blades and hub as a no-slip wall of their own, then tick it here.</p>}
      <Button size="sm" variant="ghost" onClick={() => setZones(zones.filter((_, i) => i !== index))}>Remove zone</Button>
    </div>)}
    <Button size="sm" onClick={add}>Add rotating zone</Button>
    {/* Incompressible only: a compressible sliding mesh is not validated yet (simulation/schema.py refuses it). */}
    {zones.length > 0 && study.type !== 'compressible' && <SlidingSettings value={sliding} onChange={setSliding} />}
  </div></Section>;
}

/** Frozen rotor (off) or the same zones time-accurate on a sliding mesh: its revolutions, steps and averaging window. */
function SlidingSettings({ value, onChange }: { value: SlidingMesh | null; onChange: (next: SlidingMesh | null) => void }) {
  const settings = value ? { ...SLIDING, ...value } : null;
  const field = (key: keyof typeof SLIDING, label: string, unit: string, valid: (n: number) => boolean) => settings && <>
    <span className={sim.label}>{label}</span>
    <NumberField value={settings[key]} unit={unit} ariaLabel={label} onChange={(n) => { if (valid(n)) onChange({ ...settings, [key]: n }); }} />
  </>;
  return <div className={sim.boundary}>
    <label className={sim.row}><span>Time-accurate (sliding mesh)</span>
      <input type="checkbox" checked={!!settings} aria-label="Time-accurate (sliding mesh)" onChange={(event) => onChange(event.target.checked ? { ...SLIDING } : null)} /></label>
    <span className={styles.muted}>{settings ? 'The zones turn with their cells every step: blade passing, pulsation and torque ripple are resolved. '
      + 'It costs many times a frozen rotor; the run says its expected time when it starts. The zone must be a body of revolution about its '
      + 'axis, with a ring of still fluid between it and a casing: the only still walls it may touch are planes across the axis.' : 'Frozen rotor: steady, the rotor at its modelled position.'}</span>
    {field('revolutions', 'Revolutions', 'rev', (n) => n > 0)}
    {field('steps_per_revolution', 'Steps per revolution', 'steps', (n) => Number.isInteger(n) && n >= 12)}
    {field('average_revolutions', 'Averaged revolutions', 'rev', (n) => n > 0)}
    {field('phases', 'Phases', 'per rev', (n) => Number.isInteger(n) && n >= 1 && n <= 360)}
  </div>;
}

function ZoneName({ zone, taken, onChange }: { zone: RotatingZone; taken: string[]; onChange: (id: string) => void }) {
  const [name, setName] = useState(zone.id);
  useEffect(() => setName(zone.id), [zone.id]);
  const valid = NAME.test(name) && !taken.includes(name);
  return <label className={sim.row}>Name <input className={sim.text} aria-label="Zone name" value={name} spellCheck={false}
    onChange={(event) => setName(event.target.value.trim())} onBlur={() => { if (valid) onChange(name); else setName(zone.id); }} /></label>;
}

interface RotorResult { id: string; rpm: number; torque_n_m?: number; shaft_power_w?: number; pressure_torque_n_m?: number; viscous_torque_n_m?: number;
  torque_min_n_m?: number; torque_max_n_m?: number; torque_dominant_order?: number; torque_dominant_frequency_hz?: number;
  rotor_total_pressure_rise_pa?: number; rotor_efficiency?: number; rotor_total_pressure_ratio?: number; rotor_isentropic_efficiency?: number }
interface RotationResult { zones: RotorResult[]; total_pressure_rise_pa?: number; volume_flow_m3_s?: number; hydraulic_power_w?: number; efficiency?: number }

/** A rotating study's machine numbers: each rotor's torque and shaft power, and with through-flow its pressure rise and efficiency. */
export function RotationResults({ summary }: { summary: Record<string, unknown> }) {
  const rotation = summary.rotation as RotationResult | undefined;
  if (!rotation?.zones?.length) return null;
  const line = (key: string, value: number | undefined) => {
    if (typeof value !== 'number') return null;
    const { label, shown } = summaryLine(key, value, true);
    return <><dt>{label}</dt><dd>{shown.value}{shown.unit ? ` ${shown.unit}` : ''}</dd></>;
  };
  return <dl className={sim.summary} id="result-rotation">
    {rotation.zones.map((zone) => <span key={zone.id} style={{ display: 'contents' }}>
      {rotation.zones.length > 1 && <><dt>{zone.id}</dt><dd>{zone.rpm} rpm</dd></>}
      {line('torque_n_m', zone.torque_n_m)}{line('shaft_power_w', zone.shaft_power_w)}
      {typeof zone.torque_min_n_m === 'number' && typeof zone.torque_max_n_m === 'number' && <><dt>Torque range</dt>
        <dd>{zone.torque_min_n_m.toPrecision(4)} to {zone.torque_max_n_m.toPrecision(4)} N·m</dd></>}
      {typeof zone.torque_dominant_order === 'number' && <><dt>Torque ripple</dt>
        <dd>{zone.torque_dominant_order.toFixed(1)} × shaft speed ({zone.torque_dominant_frequency_hz?.toPrecision(4)} Hz)</dd></>}
      {line('rotor_total_pressure_rise_pa', zone.rotor_total_pressure_rise_pa)}
      {typeof zone.rotor_efficiency === 'number' && <><dt>Rotor efficiency</dt><dd>{(zone.rotor_efficiency * 100).toFixed(1)} %</dd></>}
      {typeof zone.rotor_total_pressure_ratio === 'number' && <><dt>Total pressure ratio</dt><dd>{zone.rotor_total_pressure_ratio.toFixed(4)}</dd></>}
      {typeof zone.rotor_isentropic_efficiency === 'number' && <><dt>Isentropic efficiency</dt><dd>{(zone.rotor_isentropic_efficiency * 100).toFixed(1)} %</dd></>}
    </span>)}
    {line('total_pressure_rise_pa', rotation.total_pressure_rise_pa)}
    {line('volume_flow_m3_s', rotation.volume_flow_m3_s)}
    {typeof rotation.efficiency === 'number' && <><dt>Efficiency with the duct</dt><dd>{(rotation.efficiency * 100).toFixed(1)} %</dd></>}
  </dl>;
}

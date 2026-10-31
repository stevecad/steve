/**
 * Compressible flow (an ideal gas, simulation/compressible.py) in the Study inspector: the gas, steady or transient
 * behaviour with its solver settings, the gas boundaries' values, and the result's performance readout.
 */
import { useEffect, useState } from 'react';
import { NumberField, Section } from '@/ui';
import { set, type Study, type StudyLoad } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import type { Definition, Gas, ResultManifest } from './api';
import { COMPRESSIBLE_MAX_ITERATIONS, GAS_TIME_DEFAULT } from './physics';
import { report, simulationCapabilities } from './state';
import { show } from './units';
import styles from '@/panels/Panels.module.css';
import sim from './Simulate.module.css';

type Analysis = Definition['analysis'];

function updateDefinition(study: Study, change: (definition: Definition) => Definition) {
  if (!study.definition) return;
  set((state) => ({ studies: state.studies.map((item) => item.id === study.id && item.definition ? { ...item, definition: change(item.definition) } : item) }));
  persistWorkspaceData();
}

function updateLoad(study: Study, loadId: string, patch: Partial<StudyLoad>) {
  set((state) => ({ studies: state.studies.map((item) => item.id !== study.id ? item
    : { ...item, loads: item.loads.map((load) => load.id === loadId ? { ...load, ...patch } : load) }) }));
  persistWorkspaceData();
}

const R_UNIVERSAL = 8.314462618;
const CUSTOM = 'custom';
const sameGas = (a: Gas, b: Gas) => a.name === b.name && a.molar_mass_kg_mol === b.molar_mass_kg_mol && a.specific_heat_cp_j_kgk === b.specific_heat_cp_j_kgk
  && a.dynamic_viscosity_pa_s === b.dynamic_viscosity_pa_s && (a.prandtl_number ?? .72) === (b.prandtl_number ?? .72);

/** The server's gas presets (capabilities.gas_presets), and the same gases with temperature-dependent properties, once per page. */
function useGasPresets(): { presets: Record<string, Gas>; varying: Record<string, Gas> } {
  const [value, setValue] = useState<{ presets: Record<string, Gas>; varying: Record<string, Gas> }>({ presets: {}, varying: {} });
  useEffect(() => {
    let live = true;
    simulationCapabilities().then((caps) => { if (live) setValue({ presets: caps.gas_presets ?? {}, varying: caps.gas_presets_temperature_dependent ?? {} }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  return value;
}

/** The gas: a preset (with its source), or custom properties. */
export function GasSetup({ study }: { study: Study }) {
  const { presets, varying } = useGasPresets();
  const gas = study.definition?.gas ?? null;
  const temperatureDependent = gas?.thermo === 'nasa_polynomials';
  const preset = gas ? Object.entries(presets).find(([, item]) => sameGas(item, gas))?.[0] ?? CUSTOM : '';
  const setGas = (next: Gas) => updateDefinition(study, (definition) => ({ ...definition, gas: next }));
  const edit = (patch: Partial<Gas>) => gas && setGas({ ...gas, ...(preset !== CUSTOM ? { name: 'Custom gas' } : {}), source: 'study', ...patch });
  const gasConstant = gas ? R_UNIVERSAL / gas.molar_mass_kg_mol : 0;
  const turbulent = study.definition?.analysis.turbulence?.model === 'k_omega_sst';
  return <Section title="Gas"><div className={styles.stack} id="study-gas">
    <label className={sim.row}>Gas <select aria-label="Gas" value={preset} onChange={(event) => {
      const key = event.target.value;
      if (key === CUSTOM) { if (gas) setGas({ ...gas, name: 'Custom gas', source: 'study' }); return; }
      if (presets[key]) setGas({ ...(temperatureDependent && varying[key] ? varying[key] : presets[key]) });
    }}>
      {!gas && <option value="">Choose a gas…</option>}
      {Object.entries(presets).map(([key, item]) => <option key={key} value={key}>{item.name}</option>)}
      <option value={CUSTOM} disabled={!gas}>Custom</option>
    </select></label>
    {gas && preset !== CUSTOM && varying[preset] && <label className={sim.row}>Properties vary with temperature
      <input type="checkbox" aria-label="Properties vary with temperature" checked={temperatureDependent}
        onChange={(event) => setGas({ ...(event.target.checked ? varying[preset] : presets[preset]) })} /></label>}
    {gas && preset !== CUSTOM && gas.source && <small className={styles.muted} data-gas-source>{gas.source}</small>}
    {gas && preset === CUSTOM && <>
      <span className={sim.label}>Molar mass</span>
      <NumberField value={gas.molar_mass_kg_mol} unit="kg/mol" precision={10} ariaLabel="Gas molar mass" onChange={(molar_mass_kg_mol) => { if (molar_mass_kg_mol > 0 && molar_mass_kg_mol <= 1) edit({ molar_mass_kg_mol }); }} />
      <span className={sim.label}>Specific heat at constant pressure</span>
      <NumberField value={gas.specific_heat_cp_j_kgk} unit="J/(kg·K)" precision={10} ariaLabel="Gas specific heat" onChange={(specific_heat_cp_j_kgk) => { if (specific_heat_cp_j_kgk > 0) edit({ specific_heat_cp_j_kgk }); }} />
      <span className={sim.label}>Dynamic viscosity <small className={styles.muted}>· 0 = inviscid</small></span>
      <NumberField value={gas.dynamic_viscosity_pa_s} unit="Pa·s" precision={10} ariaLabel="Gas dynamic viscosity" onChange={(dynamic_viscosity_pa_s) => { if (dynamic_viscosity_pa_s >= 0 && dynamic_viscosity_pa_s <= 1) edit({ dynamic_viscosity_pa_s }); }} />
      <span className={sim.label}>Prandtl number</span>
      <NumberField value={gas.prandtl_number ?? .72} unit="" precision={10} ariaLabel="Gas Prandtl number" onChange={(prandtl_number) => { if (prandtl_number > 0 && prandtl_number <= 100) edit({ prandtl_number }); }} />
      {gas.specific_heat_cp_j_kgk <= gasConstant && <p className={sim.warn}>Cp must exceed the gas constant R = {gasConstant.toPrecision(4)} J/(kg·K) of this molar mass.</p>}
    </>}
    {gas && <small className={styles.muted}>Ideal gas, {temperatureDependent ? 'Cp varying with temperature (NASA polynomials)' : 'constant Cp'}
      {gas.viscosity === 'sutherland' ? ' and Sutherland viscosity' : ''}; {gas.dynamic_viscosity_pa_s === 0 ? 'inviscid (Euler).' : turbulent ? 'turbulent (k-ω SST).' : 'laminar.'}
      {temperatureDependent && gas.polynomials ? ` Valid ${gas.polynomials.t_low_k}–${gas.polynomials.t_high_k} K: a run that leaves the range stops.` : ''}</small>}
    {gas && turbulent && gas.dynamic_viscosity_pa_s === 0 && <p className={sim.warn}>Turbulent flow needs a viscous gas: enter its viscosity or choose Laminar.</p>}
    {!gas && <p className={sim.warn}>Choose the gas before solving.</p>}
  </div></Section>;
}

/** Steady or transient, the simulated time, the flow model (`model`: laminar or turbulent), and the solver settings (collapsed). */
export function CompressibleBehavior({ study, model }: { study: Study; model?: React.ReactNode }) {
  const analysis = study.definition?.analysis;
  if (!analysis) return null;
  const update = (patch: Partial<Analysis>) => updateDefinition(study, (definition) => ({ ...definition, analysis: { ...definition.analysis, ...patch } }));
  const settings = analysis.compressible ?? {};
  const solver = (patch: NonNullable<Analysis['compressible']>) => update({ compressible: { ...settings, ...patch } });
  const time = analysis.gas_time;
  const steady = analysis.type === 'flow_compressible_steady';
  const pressureBased = settings.solver === 'pressure_based';
  // Below the critical pressure ratio ((γ+1)/2)^(γ/(γ-1)), about 1.9, a supply cannot choke a passage: the flow is
  // subsonic, which the pressure-based solver is for (simulation/compressible.py).
  const supply = Math.max(0, ...study.loads.filter((load) => load.type === 'stagnation_inlet').map((load) => load.magnitude ?? 0));
  const ambient = Math.min(...study.loads.filter((load) => load.type === 'ambient_outlet').map((load) => load.magnitude ?? Infinity));
  const gamma = study.definition?.gas ? study.definition.gas.specific_heat_cp_j_kgk / (study.definition.gas.specific_heat_cp_j_kgk - R_UNIVERSAL / study.definition.gas.molar_mass_kg_mol) : 1.4;
  const critical = ((gamma + 1) / 2) ** (gamma / (gamma - 1));
  const ratio = supply > 0 && Number.isFinite(ambient) && ambient > 0 ? supply / ambient : null;
  return <Section title="Flow behavior"><div className={styles.stack} id="study-compressible">
    <label className={sim.row}>Behavior <select aria-label="Compressible flow behavior" value={analysis.type} onChange={(event) => {
      const transient = event.target.value === 'flow_compressible_transient';
      update({ type: transient ? 'flow_compressible_transient' : 'flow_compressible_steady', gas_time: transient ? { ...GAS_TIME_DEFAULT } : null });
    }}><option value="flow_compressible_steady">Steady</option><option value="flow_compressible_transient">Transient</option></select></label>
    {time && <>
      <span className={sim.label}>Duration</span>
      <NumberField value={time.duration_s} unit="s" precision={10} ariaLabel="Gas flow duration" onChange={(duration_s) => { if (duration_s > 0 && duration_s <= 1e6) update({ gas_time: { ...time, duration_s } }); }} />
      <span className={sim.label}>Saved frames</span>
      <NumberField value={time.steps} unit="frames" ariaLabel="Gas flow frames" onChange={(steps) => { if (Number.isInteger(steps) && steps >= 1 && steps <= 10000) update({ gas_time: { ...time, steps } }); }} />
      <small>The gas starts at rest at the supply’s total pressure and temperature; boundaries apply from the start.</small>
    </>}
    {steady && <small>Runs until the mass flow, thrust and every cell's mass balance settle.</small>}
    <label className={sim.row}>Solver <select aria-label="Compressible solver" value={settings.solver ?? 'density_based'} onChange={(event) => {
      const choice = event.target.value as 'density_based' | 'pressure_based';
      // The flux scheme belongs to the density-based solver.
      update({ compressible: { ...settings, solver: choice, ...(choice === 'pressure_based' ? { flux_scheme: undefined } : {}) } });
    }}><option value="pressure_based">Subsonic (pressure-based)</option><option value="density_based">Supersonic and shocks (density-based)</option></select></label>
    {ratio !== null && <small>Supply to ambient pressure ratio {ratio.toPrecision(3)}: {ratio < critical ? 'below' : 'above'} the {critical.toPrecision(3)} that chokes a passage, so {ratio < critical ? 'the flow stays subsonic: use Subsonic.' : 'it can go supersonic: use Supersonic and shocks.'}</small>}
    {pressureBased && study.definition?.gas?.dynamic_viscosity_pa_s === 0 && <p className={sim.warn}>The subsonic solver needs the gas viscosity; make the walls slip for a frictionless passage.</p>}
    {model}
    <details className={sim.advanced} id="study-compressible-solver"><summary>Solver</summary><div className={styles.stack}>
      {!pressureBased && <label className={sim.row}>Flux scheme <select aria-label="Flux scheme" value={settings.flux_scheme ?? 'kurganov'} onChange={(event) => solver({ flux_scheme: event.target.value as 'kurganov' | 'tadmor' })}>
        <option value="kurganov">Kurganov (less dissipative)</option><option value="tadmor">Tadmor</option>
      </select></label>}
      <span className={sim.label}>Max Courant number</span>
      <NumberField value={settings.max_courant ?? .5} unit="≤ 0.5" precision={6} step={.05} ariaLabel="Max Courant number" onChange={(max_courant) => { if (max_courant > 0 && max_courant <= .5) solver({ max_courant }); }} />
      {steady && <>
        <span className={sim.label}>Convergence tolerance</span>
        <NumberField value={settings.convergence_tolerance ?? 1e-5} unit="relative" precision={6} ariaLabel="Convergence tolerance" onChange={(convergence_tolerance) => { if (convergence_tolerance >= 1e-9 && convergence_tolerance <= 1e-2) solver({ convergence_tolerance }); }} />
        <span className={sim.label}>Max iterations</span>
        <NumberField value={analysis.max_iterations ?? COMPRESSIBLE_MAX_ITERATIONS} unit="steps" ariaLabel="Max iterations" onChange={(max_iterations) => { if (Number.isInteger(max_iterations) && max_iterations >= 10 && max_iterations <= 1_000_000) update({ max_iterations }); }} />
      </>}
      <small>{pressureBased ? 'The Courant number holds each step to the flow crossing that fraction of a cell; lower it if a run diverges.' : 'The explicit scheme is stable at a Courant number of 0.5 and below; lower it if a run diverges.'}</small>
    </div></details>
  </div></Section>;
}

/** A gas boundary's values: absolute pressure or mass flow, and its temperature (K). */
export function GasBoundaryFields({ study, load }: { study: Study; load: StudyLoad }) {
  const value = load.magnitude ?? 0;
  const temperature = load.gasTemperature ?? 300;
  const setValue = (magnitude: number) => { if (magnitude > 0) updateLoad(study, load.id, { magnitude }); else report(new Error('Enter a value above zero.')); };
  const setTemperature = (gasTemperature: number) => { if (gasTemperature > 0 && gasTemperature <= 1e4) updateLoad(study, load.id, { gasTemperature }); };
  const [label, unit, temperatureLabel] = load.type === 'stagnation_inlet' ? ['Total pressure (absolute)', 'Pa', 'Total temperature']
    : load.type === 'mass_flow_inlet' ? ['Mass flow', 'kg/s', 'Total temperature'] : ['Ambient pressure (absolute)', 'Pa', 'Backflow temperature'];
  return <>
    <span className={sim.label}>{label}</span>
    <NumberField value={value} unit={unit} precision={10} ariaLabel={label} onChange={setValue} />
    <span className={sim.label}>{temperatureLabel}</span>
    <NumberField value={temperature} unit="K" precision={10} ariaLabel={temperatureLabel} onChange={setTemperature} />
  </>;
}

export const GAS_BOUNDARIES = new Set<StudyLoad['type']>(['stagnation_inlet', 'mass_flow_inlet', 'ambient_outlet']);

interface Outlet { mass_flow_kg_s?: number; area_m2?: number; mean_mach?: number; mean_pressure_pa?: number; mean_temperature_k?: number; exit_velocity_m_s?: number; thrust_n?: number }
/** Shown in the performance readout, so left out of the summary list below it. */
export const PERFORMANCE_KEYS = new Set(['thrust_n', 'isp_s', 'inlet_mass_flow_kg_s', 'outlet_mass_flow_kg_s']);

const text = (value: number | undefined, unit: string) => {
  if (typeof value !== 'number') return '—';
  const shown = show(value, unit, true);
  return `${shown.value}${shown.unit ? ` ${shown.unit}` : ''}`;
};

/**
 * A compressible result's verdict and key numbers: whether the exit is supersonic, thrust, Isp, mass flow, each
 * outlet's exit Mach number and pressure, and the mass balance. The rest of the numbers are collapsed.
 */
export function GasPerformance({ study, manifest, summary, checks }: { study: Study; manifest: ResultManifest; summary: Record<string, unknown>; checks: Record<string, unknown> }) {
  const outlets = (summary.outlets ?? {}) as Record<string, Outlet>;
  const order = study.loads.filter((load) => load.type === 'ambient_outlet').map((load) => load.id);
  const ids = Object.keys(outlets).sort((a, b) => (order.indexOf(a) + 1 || Infinity) - (order.indexOf(b) + 1 || Infinity));
  const name = (id: string, index: number) => ids.length === 1 ? 'Exit' : `Outlet ${(order.indexOf(id) + 1) || index + 1}`;
  const num = (key: string) => typeof summary[key] === 'number' ? summary[key] as number : undefined;
  const exitMach = Math.max(...ids.map((id) => outlets[id].mean_mach ?? 0), 0);
  const balance = typeof checks.mass_balance_relative === 'number' ? checks.mass_balance_relative : undefined;
  const cellBalance = typeof checks.max_cell_mass_balance_relative === 'number' ? checks.max_cell_mass_balance_relative : undefined;
  const steps = typeof checks.steps === 'number' ? checks.steps : undefined;
  const gas = checks.gas as { name?: string; gamma?: number; gas_constant_j_kgk?: number; model?: string } | undefined;
  const thrust = num('thrust_n');
  return <div className={styles.stack} id="result-performance">
    {ids.length > 0 && <p id="result-verdict"><b>{exitMach >= 1 ? 'Supersonic exit' : 'Subsonic exit'}</b> · Mach {text(exitMach, '')}</p>}
    <dl className={sim.summary}>
      <div><dt>Thrust</dt><dd id="result-thrust">{text(thrust, 'N')}</dd></div>
      <div><dt>Specific impulse (Isp)</dt><dd id="result-isp">{text(num('isp_s'), 's')}</dd></div>
      <div><dt>Mass flow</dt><dd id="result-mass-flow">{text(num('outlet_mass_flow_kg_s'), 'kg/s')}</dd></div>
      {ids.map((id, index) => <div key={id} data-outlet={id}><dt>{name(id, index)} · Mach / pressure</dt>
        <dd>{text(outlets[id].mean_mach, '')} / {text(outlets[id].mean_pressure_pa, 'Pa')}</dd></div>)}
      {balance !== undefined && <div data-tone={balance > 1e-3 ? 'danger' : undefined}><dt>Mass balance (in vs out)</dt><dd id="result-mass-balance">{balance.toExponential(1)}</dd></div>}
    </dl>
    <details className={sim.advanced} id="result-performance-details"><summary>Details</summary><div className={styles.stack}>
      <dl className={sim.summary}>
        <div><dt>Mass flow in</dt><dd>{text(num('inlet_mass_flow_kg_s'), 'kg/s')}</dd></div>
        {ids.map((id, index) => {
          const outlet = outlets[id];
          return <div key={id}><dt>{name(id, index)}</dt><dd>{text(outlet.mass_flow_kg_s, 'kg/s')} · {text(outlet.exit_velocity_m_s, 'm/s')} · {text(outlet.mean_temperature_k, 'K')} · {text(outlet.thrust_n, 'N')} · {((outlet.area_m2 ?? 0) * 1e6).toPrecision(3)} mm²</dd></div>;
        })}
        {cellBalance !== undefined && <div><dt>Worst cell mass balance</dt><dd>{cellBalance.toExponential(1)}</dd></div>}
        {steps !== undefined && <div><dt>Solver steps</dt><dd>{steps.toLocaleString()}</dd></div>}
        {gas?.gamma !== undefined && <div><dt>{gas.name ?? 'Gas'} · γ</dt><dd>{gas.gamma.toPrecision(4)}{gas.model ? ` · ${gas.model}` : ''}</dd></div>}
      </dl>
      <small className={styles.muted}>Mass balances are relative to the throughput. Thrust is the exit-plane force: momentum flux plus the pressure difference to ambient; Isp = thrust ÷ (mass flow × g₀).{manifest.frames ? ' Values at the time shown above.' : ''}</small>
    </div></details>
  </div>;
}

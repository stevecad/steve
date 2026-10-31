import { useEffect, useState } from 'react';
import { Button, NumberField, Section } from '@/ui';
import { get, set, useApp, type Study } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import type { Definition } from './api';
import { conjugateProblems, regionNameAllowed } from './conjugate';
import { displayedBodies, pinnedSelection, picksFor, qualifiedBody, qualifiedReference, report, useSimulation } from './state';
import styles from '@/panels/Panels.module.css';

const properties = [
  ['density_kg_m3', 'Density', 'kg/m³'], ['specific_heat_j_kgk', 'Specific heat', 'J/(kg·K)'],
  ['conductivity_w_mk', 'Conductivity', 'W/(m·K)'], ['dynamic_viscosity_pa_s', 'Dynamic viscosity', 'Pa·s'],
] as const;

export default function ConjugateSetup({ study }: { study: Study }) {
  useApp((state) => state.modelVersion);
  const selection = useApp((state) => state.selection);
  const definition = study.definition!, regions = definition.regions ?? [], interfaces = definition.interfaces ?? [];
  const current = pinnedSelection(study), bodies = displayedBodies(study);
  const available = bodies.filter((body) => !regions.some((r) => r.body === body));
  const [body, setBody] = useState(''), [phase, setPhase] = useState<'fluid' | 'solid'>('fluid'), [name, setName] = useState('fluid');
  const [regionA, setRegionA] = useState(''), [regionB, setRegionB] = useState('');
  const [facesA, setFacesA] = useState<string[]>([]), [facesB, setFacesB] = useState<string[]>([]);
  const [interfaceName, setInterfaceName] = useState('interface_1');
  const problems = conjugateProblems(definition);
  useEffect(() => { setFacesA([]); setFacesB([]); }, [JSON.stringify(definition.design)]);
  useEffect(() => {
    if (phase === 'fluid' && regions.some((r) => r.phase === 'fluid')) { setPhase('solid'); setName(`solid_${regions.filter((r) => r.phase === 'solid').length + 1}`); }
  }, [phase, regions]);
  useEffect(() => { if (!available.includes(body)) setBody(available[0] ?? ''); }, [body, available.join('\0')]);
  useEffect(() => {
    if (!regions.some((r) => r.id === regionA)) { setRegionA(regions[0]?.id ?? ''); setFacesA([]); }
    if (!regions.some((r) => r.id === regionB)) { setRegionB(regions[1]?.id ?? ''); setFacesB([]); }
  }, [regions, regionA, regionB]);
  const update = (change: (value: Definition) => Definition) => {
    set((state) => ({ studies: state.studies.map((item) => item.id === study.id && item.definition ? { ...item, definition: change(item.definition) } : item) }));
    persistWorkspaceData();
  };
  const capture = (side: 'a' | 'b') => {
    try {
      if (!pinnedSelection(study)) throw new Error('Interface picks must come from the pinned design revision. Save and generate the design, then update the study link if needed.');
      const region = regions.find((r) => r.id === (side === 'a' ? regionA : regionB));
      const picks = get().selection.filter((pick) => pick.kind === 'face');
      if (!region || !picks.length || picks.some((pick) => qualifiedBody(pick) !== region.body)) throw new Error('Select only faces belonging to the chosen region.');
      const refs = [...new Set(picks.map(qualifiedReference))];
      (side === 'a' ? setFacesA : setFacesB)(refs);
      useSimulation.setState({ error: null });
      set({ selection: [] });
    } catch (error) { report(error); }
  };
  return <Section title="Thermal regions and interfaces"><div className={styles.stack}>
    <small>Assign the modeled fluid volume and every adjoining solid. One constant-property laminar fluid is supported. Interfaces transfer heat; unassigned external solid faces are insulated.</small>
    {!study.revision && <p>Local setup draft. Complete the regions, interfaces and properties, then save to create the linked study document.</p>}
    {!current && <p>Body and face picking requires the displayed pinned design without study parameter overrides. Save and generate the design, then update the study link if needed.</p>}
    {current && !bodies.length && <p role="alert">Rebuild the design to obtain exact body identities for region selection.</p>}
    {available.length > 0 && <div className={styles.stack}>
      <label>Body <select aria-label="Thermal region body" value={body} onChange={(event) => setBody(event.target.value)}>
        {available.map((id) => <option key={id} value={id}>{id}</option>)}
      </select></label>
      <label>Phase <select aria-label="Thermal region phase" value={phase} onChange={(event) => { const value = event.target.value as typeof phase; setPhase(value); setName(value === 'fluid' ? 'fluid' : `solid_${regions.filter((r) => r.phase === 'solid').length + 1}`); }}>
        <option value="fluid" disabled={regions.some((r) => r.phase === 'fluid')}>Fluid</option><option value="solid">Solid</option>
      </select></label>
      <label>Name <input aria-label="Thermal region name" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <Button size="sm" disabled={!current || !body || !regionNameAllowed(name) || regions.some((r) => r.id === name || (phase === 'fluid' && r.phase === 'fluid'))} onClick={() => {
        update((d) => ({ ...d, regions: [...(d.regions ?? []), { id: name, body, phase, initial_temperature_k: 300 }],
          materials: phase === 'fluid' ? { ...d.materials, [body]: { name: 'Study fluid', density_kg_m3: 0, specific_heat_j_kgk: 0, conductivity_w_mk: 0, dynamic_viscosity_pa_s: 0 } } : d.materials }));
        setPhase('solid'); setName(`solid_${regions.filter((r) => r.phase === 'solid').length + (phase === 'solid' ? 2 : 1)}`);
      }}>Add thermal region</Button>
      <small>{available.length} modeled {available.length === 1 ? 'body still needs' : 'bodies still need'} a region.</small>
    </div>}
    {regions.map((region) => {
      const material = definition.materials[region.body];
      const property = (key: string, value: string | number) => update((d) => ({ ...d, materials: { ...d.materials, [region.body]: { name: region.id, ...d.materials[region.body], [key]: value } } }));
      return <div key={region.id} className={styles.listItem} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <b>{region.id} · {region.phase}</b><span style={{ overflowWrap: 'anywhere' }}>{region.body}</span>
        <span>Initial temperature estimate</span><NumberField value={region.initial_temperature_k} unit="K" ariaLabel={`${region.id} temperature estimate`} onChange={(value) => {
          if (value > 0) update((d) => ({ ...d, regions: d.regions!.map((r) => r.id === region.id ? { ...r, initial_temperature_k: value } : r) }));
        }} />
        <label>Material <select aria-label={`${region.id} material source`} value={material ? 'override' : 'design'} onChange={(event) => {
          update((d) => { const materials = { ...d.materials }; if (event.target.value === 'design') delete materials[region.body]; else materials[region.body] = { name: `${region.id} material`, density_kg_m3: 0, specific_heat_j_kgk: 0, conductivity_w_mk: 0 }; return { ...d, materials }; });
        }}><option value="design" disabled={region.phase === 'fluid'}>Inherit pinned design material</option><option value="override">Study properties</option></select></label>
        {material ? <>
          <label>Material name <input aria-label={`${region.id} material name`} value={String(material.name ?? region.id)} onChange={(event) => property('name', event.target.value)} /></label>
          {properties.filter(([key]) => region.phase === 'fluid' || key !== 'dynamic_viscosity_pa_s').map(([key, label, unit]) => <label key={key}>{label}
            {material[key] == null ? <span>From pinned design <Button size="sm" onClick={() => property(key, 0)}>Override {label.toLowerCase()}</Button></span>
              : <NumberField value={Number(material[key])} unit={unit} ariaLabel={`${region.id} ${label}`} onChange={(value) => property(key, value)} />}
          </label>)}
        </> : <small>The pinned design material must provide density, specific heat and conductivity.</small>}
        <Button size="sm" variant="ghost" onClick={() => update((d) => {
          const materials = { ...d.materials }; delete materials[region.body];
          return { ...d, materials, regions: d.regions!.filter((r) => r.id !== region.id), interfaces: d.interfaces?.filter((i) => i.region_a !== region.id && i.region_b !== region.id) };
        })}>Remove {region.id} region and interfaces</Button>
      </div>;
    })}
    {interfaces.map((pair) => <div key={pair.id} className={styles.listItem} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
      <b>{pair.id}: {pair.region_a} ↔ {pair.region_b}</b>
      <small style={{ overflowWrap: 'anywhere' }}>{pair.faces_a.join(', ')} ↔ {pair.faces_b.join(', ')}</small>
      <Button size="sm" disabled={!current} onClick={() => set({ selection: picksFor([...pair.faces_a, ...pair.faces_b]) })}>Show {pair.id} faces</Button>
      <Button size="sm" variant="ghost" onClick={() => update((d) => ({ ...d, interfaces: d.interfaces!.filter((i) => i.id !== pair.id) }))}>Remove {pair.id} interface</Button>
    </div>)}
    {regions.length >= 2 && <div className={styles.stack}>
      <b>Add a thermal interface</b><small>Capture the complete touching faces on each side. Geometry and mesh correspondence are checked before solving.</small>
      <label>Interface name <input aria-label="Thermal interface name" value={interfaceName} onChange={(event) => setInterfaceName(event.target.value)} /></label>
      {(['a', 'b'] as const).map((side) => <div key={side} className={styles.stack}>
        <label>Side {side.toUpperCase()} <select aria-label={`Interface region ${side.toUpperCase()}`} value={side === 'a' ? regionA : regionB} onChange={(event) => {
          (side === 'a' ? setRegionA : setRegionB)(event.target.value); (side === 'a' ? setFacesA : setFacesB)([]);
        }}>{regions.map((r) => <option key={r.id} value={r.id}>{r.id} · {r.body}</option>)}</select></label>
        <Button size="sm" disabled={!current || !selection.some((p) => p.kind === 'face')} onClick={() => capture(side)}>Use selected faces for side {side.toUpperCase()}</Button>
        <small aria-label={`Interface faces ${side.toUpperCase()}`} style={{ overflowWrap: 'anywhere' }}>{(side === 'a' ? facesA : facesB).join(', ') || 'No faces captured'}</small>
      </div>)}
      <Button size="sm" disabled={!current || regionA === regionB || !facesA.length || !facesB.length || !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(interfaceName) || interfaces.some((i) => i.id === interfaceName)} onClick={() => {
        update((d) => ({ ...d, interfaces: [...(d.interfaces ?? []), { id: interfaceName, region_a: regionA, region_b: regionB, faces_a: facesA, faces_b: facesB }] }));
        setFacesA([]); setFacesB([]); setInterfaceName(`interface_${interfaces.length + 2}`);
      }}>Add thermal interface</Button>
    </div>}
    <span>Maximum steady iterations</span><NumberField value={definition.analysis.max_iterations ?? 2000} unit="iterations" ariaLabel="CHT maximum iterations" onChange={(value) => {
      if (Number.isInteger(value) && value >= 10 && value <= 1000000) update((d) => ({ ...d, analysis: { ...d.analysis, max_iterations: value } }));
    }} />
    <small>Results must meet the residual and heat/mass conservation checks. The iteration limit alone does not establish convergence. Buoyancy, radiation and contact resistance are not included.</small>
    {problems.map((problem) => <small key={problem} role="status">{problem}</small>)}
  </div></Section>;
}

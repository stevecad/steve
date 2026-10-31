import type { Definition } from './api';

export const regionNameAllowed = (name: string) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)
  && !['controlDict', 'fvSchemes', 'fvSolution', 'g', 'region0', 'regionProperties'].includes(name);

/** Editing can be incomplete; only a complete region graph becomes a saved revision. */
export function conjugateProblems(definition: Definition): string[] {
  if (definition.analysis.type !== 'cht_steady') return [];
  const regions = definition.regions ?? [], interfaces = definition.interfaces ?? [], problems: string[] = [];
  if (regions.filter((r) => r.phase === 'fluid').length !== 1 || !regions.some((r) => r.phase === 'solid')) problems.push('Assign one fluid region and at least one solid region.');
  if (new Set(regions.map((r) => r.id)).size !== regions.length || new Set(regions.map((r) => r.body)).size !== regions.length) problems.push('Region names and body assignments must be unique.');
  if (!interfaces.length) problems.push('Pair the touching region faces with a thermal interface.');
  const connected = new Set(regions.filter((r) => r.phase === 'fluid').map((r) => r.id));
  for (let i = 0; i < regions.length; i++) for (const pair of interfaces) {
    if (connected.has(pair.region_a) || connected.has(pair.region_b)) { connected.add(pair.region_a); connected.add(pair.region_b); }
  }
  if (regions.some((r) => !connected.has(r.id))) problems.push('Every region must connect to the fluid through thermal interfaces.');
  for (const region of regions) {
    if (!regionNameAllowed(region.id) || region.initial_temperature_k <= 0) problems.push(`${region.id}: use a valid, unreserved name and a positive temperature estimate.`);
    const material = definition.materials[region.body];
    if (region.phase === 'fluid' && !material?.dynamic_viscosity_pa_s) problems.push(`${region.id}: specify the fluid viscosity.`);
    if (material) {
      const required = ['density_kg_m3', 'specific_heat_j_kgk', 'conductivity_w_mk', ...(region.phase === 'fluid' ? ['dynamic_viscosity_pa_s'] : [])];
      // Missing properties inherit from the pinned design, as in the worker's
      // material resolver. Explicit overrides must be positive.
      if (required.some((key) => material[key] != null && (typeof material[key] !== 'number' || !Number.isFinite(material[key]) || (material[key] as number) <= 0))) problems.push(`${region.id}: provide positive density, specific heat, conductivity${region.phase === 'fluid' ? ' and viscosity' : ''}.`);
    }
  }
  return problems;
}

/**
 * Which boundaries each study's physics accepts: the ribbon shows only these, and the commands
 * refuse anything else. One list, so the two never disagree.
 */
import type { AppState, Study, StudyLoad } from '@/state/store';
import { waitingLabel, type Waiting } from '@/lib/waiting';
import { isCompressible, type AnalysisType, type Definition } from './api';

type Kind = StudyLoad['type'];

/** Boundary types each physics accepts (in ribbon order). */
export function allowedBoundaries(study: Pick<Study, 'type' | 'definition'> | undefined): Kind[] {
  switch (study?.type) {
    case undefined: return [];
    case 'modal': return ['fixed'];
    case 'thermal': return ['temperature', 'heat_flux', 'convection'];
    case 'thermal_stress': return ['fixed', 'force', 'pressure', 'gravity', 'temperature', 'heat_flux', 'convection'];
    case 'flow': return ['velocity_inlet', ...(study.definition?.analysis.type === 'flow_transient' ? ['pressure_inlet' as const] : []), 'pressure_outlet', 'no_slip', 'slip'];
    case 'cht': return ['velocity_inlet', 'pressure_outlet', 'no_slip', 'slip', 'temperature', 'heat_flux'];
    case 'compressible': return ['stagnation_inlet', 'mass_flow_inlet', 'ambient_outlet', 'no_slip', 'slip', 'symmetry'];
    case 'static': case 'buckling': return ['fixed', 'force', 'pressure', 'gravity'];
    case 'openfoam_case': case 'calculix_deck': return ['named'];
    default: return [];
  }
}

export const activeStudy = (state: AppState) => state.studies.find((study) => study.id === state.activeStudy);

/** Whether the ribbon shows a boundary command for the active study. */
export const shows = (type: Kind) => (state: AppState) => allowedBoundaries(activeStudy(state)).includes(type);

/** Structural results (stress, displacement, safety factor) exist for these studies. */
export const structural = (study: Pick<Study, 'type'> | undefined) => study?.type === 'static' || study?.type === 'thermal_stress';
export const thermal = (study: Pick<Study, 'type'> | undefined) => study?.type === 'thermal' || study?.type === 'thermal_stress' || study?.type === 'cht';
export const fluid = (study: Pick<Study, 'type'> | undefined) => study?.type === 'flow' || study?.type === 'cht' || study?.type === 'compressible';
export const compressible = (study: Pick<Study, 'type'> | undefined) => study?.type === 'compressible';

/** The study kind an analysis belongs to (the inverse of studyAnalysis). */
export function studyKind(analysis: string): Study['type'] {
  switch (analysis) {
    case 'thermal_steady': case 'thermal_transient': return 'thermal';
    case 'flow_steady': case 'flow_transient': return 'flow';
    case 'cht_steady': return 'cht';
    case 'flow_compressible_steady': case 'flow_compressible_transient': return 'compressible';
    default: return analysis as Study['type'];
  }
}

/** The analysis a new study of a kind starts as (steady where there is a choice). */
export function studyAnalysis(kind: Study['type']): AnalysisType {
  switch (kind) {
    case 'thermal': return 'thermal_steady';
    case 'flow': return 'flow_steady';
    case 'cht': return 'cht_steady';
    case 'compressible': return 'flow_compressible_steady';
    default: return kind;
  }
}

/** Finite-volume studies: first-order polyhedral meshes. */
export const finiteVolume = (kind: Study['type']) => kind === 'flow' || kind === 'cht' || kind === 'compressible' || kind === 'openfoam_case';
/** Studies whose input is the person's (or their AI's) own solver case: STEVE meshes and runs it. */
export const modelWritten = (study: Pick<Study, 'type'> | undefined) => study?.type === 'openfoam_case' || study?.type === 'calculix_deck';

/** Local time stepping needs far more iterations than the backend default (2000) to settle a compressible steady flow. */
export const COMPRESSIBLE_MAX_ITERATIONS = 20000;
/** A new transient compressible study: 1 ms, 20 saved frames. */
export const GAS_TIME_DEFAULT = { duration_s: 0.001, steps: 20 } as const;

/** What a compressible study still needs before the server accepts it (simulation/schema.py Study.physics). */
export function compressibleProblems(definition: Pick<Definition, 'analysis' | 'gas' | 'boundaries'>): string[] {
  if (!isCompressible(definition.analysis.type)) return [];
  const problems: string[] = [];
  if (!definition.gas) problems.push('Choose the gas.');
  const kinds = new Set(definition.boundaries.map((b) => b.type));
  if (!kinds.has('stagnation_inlet') && !kinds.has('mass_flow_inlet')) problems.push('Add an inlet (stagnation or mass flow).');
  if (!kinds.has('ambient_outlet')) problems.push('Add an ambient outlet.');
  return problems;
}

/** Run stages in words a user follows ("Meshing", not "geometry_publish"); a queued run's says why it waits. */
export function stageLabel(stage: string | undefined, status: string, waiting?: Waiting | null): string {
  if (status === 'queued') return waitingLabel(waiting);
  if (status === 'succeeded') return 'Done';
  if (status === 'failed') return 'Failed';
  if (status === 'cancelled') return 'Cancelled';
  switch (stage) {
    case 'starting': return 'Starting';
    case 'waiting_executor': return 'Waiting for a solver';
    case 'waiting_capacity': return 'Waiting for capacity';
    case 'geometry_wait': case 'geometry_download': case 'geometry_publish': case 'prepare': return 'Preparing geometry';
    case 'mesh': return 'Meshing';
    case 'thermal_prepare': return 'Preparing heat transfer';
    case 'solve': case 'thermal_solve': case 'structural_solve': return 'Solving';
    case 'temperature_transfer': return 'Transferring temperatures';
    case 'postprocess': case 'validate': case 'coupling_validate': return 'Checking results';
    case 'result_publish': return 'Publishing results';
    default: return 'Running';
  }
}

/** A new OpenFOAM case starts with its controlDict; the rest of the case (schemes, solution, fields) is written in. */
export const CASE_START: Record<string, string> = {
  'system/controlDict': 'FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }\n\napplication simpleFoam;\n'
    + 'startFrom startTime;\nstartTime 0;\nstopAt endTime;\nendTime 1000;\ndeltaT 1;\nwriteControl timeStep;\nwriteInterval 100;\n',
};
/** A new CalculiX deck starts by including STEVE's mesh. */
export const DECK_START = '** mesh.inp (written by STEVE, SI units: m): *NODE, *ELEMENT in ELSET EALL and one ELSET per body,\n'
  + '** and an NSET and element-face *SURFACE for each named face group, both called by its name.\n*INCLUDE, INPUT=mesh.inp\n';

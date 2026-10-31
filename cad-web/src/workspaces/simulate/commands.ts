import type { Command, RibbonGroup } from '@/commands';
import { KEEP, HIGH, MID } from '@/ribbonPriority';
import {
  DisplacementIcon, FixedIcon, ForceIcon, GravityIcon, MaterialIcon, MeshIcon, ModalIcon, MomentIcon, PinIcon,
  PressureIcon, SafetyIcon, SolveIcon, StressIcon, StudyIcon, SymmetricIcon, ThermalIcon, ContactIcon,
} from '@/icons/cad';
import { get, set, toast, type AppState, type Study, type StudyLoad } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import { admitFaces, createLinkedStudy, needsInstance, pinnedSelection, qualifiedReference, report, runStudy, selectResult, startPicking, unpickedBoundary } from './state';
import { activeStudy, allowedBoundaries, compressible, fluid, shows, structural, thermal } from './physics';
import { uuid } from '@/lib/uuid';

const SOLVER = 'Arrives with the simulation solver.';

export const STUDY_TYPES: Record<Study['type'], { label: string; description: string }> = {
  static: { label: 'Static stress', description: 'Linear stress, strain and displacement under steady loads.' },
  modal: { label: 'Modal frequencies', description: 'Natural frequencies and mode shapes.' },
  thermal: { label: 'Thermal', description: 'Steady or transient temperature and heat flux.' },
  thermal_stress: { label: 'Thermal stress', description: 'Steady temperature, thermal expansion, stress and displacement.' },
  buckling: { label: 'Structural buckling', description: 'Critical load factors and buckled shapes.' },
  flow: { label: 'Fluid flow', description: 'Steady or transient incompressible flow, laminar or turbulent, through a modeled fluid volume.' },
  cht: { label: 'Conjugate heat transfer', description: 'Steady heat transfer between a fluid, laminar or turbulent, and adjoining solids.' },
  compressible: { label: 'Compressible flow', description: 'Steady or transient ideal-gas flow with shocks: Mach number, thrust and specific impulse of nozzles and jets.' },
  openfoam_case: { label: 'OpenFOAM case', description: 'Your own OpenFOAM case (any solver) on STEVE’s mesh and compute.' },
  calculix_deck: { label: 'CalculiX deck', description: 'Your own CalculiX input deck (any procedure) on STEVE’s mesh and compute.' },
};

/** The New study menus (ribbon and the browser's Studies group), in order; the server's capabilities still decide at creation. */
export const NEW_STUDY_TYPES: Study['type'][] = ['static', 'modal', 'thermal', 'thermal_stress', 'flow', 'compressible', 'cht', 'buckling', 'openfoam_case', 'calculix_deck'];
/** The analyses people can create; the rest are listed but greyed out while they're validated. */
const AVAILABLE_STUDY_TYPES: Study['type'][] = ['static', 'thermal', 'thermal_stress', 'modal', 'buckling', 'flow', 'cht', 'compressible', 'openfoam_case', 'calculix_deck'];

export const LOAD_TYPES: Record<StudyLoad['type'], { label: string; group: 'Constraint' | 'Load'; unit?: string }> = {
  fixed: { label: 'Fixed', group: 'Constraint' },
  pin: { label: 'Pin', group: 'Constraint' },
  force: { label: 'Force', group: 'Load', unit: 'N' },
  pressure: { label: 'Pressure', group: 'Load', unit: 'MPa' },
  moment: { label: 'Moment', group: 'Load', unit: 'N·m' },
  gravity: { label: 'Gravity', group: 'Load', unit: 'm/s²' },
  temperature: { label: 'Temperature', group: 'Constraint', unit: 'K' },
  convection: { label: 'Convection', group: 'Load', unit: 'W/(m²·K)' },
  heat_flux: { label: 'Heat flux', group: 'Load', unit: 'W/m²' },
  velocity_inlet: { label: 'Velocity inlet', group: 'Load', unit: 'm/s' },
  pressure_inlet: { label: 'Pressure inlet', group: 'Load', unit: 'Pa' },
  pressure_outlet: { label: 'Pressure outlet', group: 'Load', unit: 'Pa' },
  no_slip: { label: 'No-slip wall', group: 'Constraint' },
  slip: { label: 'Slip wall', group: 'Constraint' },
  stagnation_inlet: { label: 'Stagnation inlet', group: 'Load', unit: 'Pa' },
  mass_flow_inlet: { label: 'Mass-flow inlet', group: 'Load', unit: 'kg/s' },
  ambient_outlet: { label: 'Ambient outlet', group: 'Load', unit: 'Pa' },
  symmetry: { label: 'Symmetry', group: 'Constraint' },
  named: { label: 'Named faces', group: 'Constraint' },
};

const uid = () => `b_${uuid().replaceAll('-', '')}`;
const needsSaved = (state: AppState) => (state.doc.saved && state.displayed ? true : state.displayed ? 'Save the design first so its studies are kept.' : "There's no geometry yet.");
const needsStudy = (state: AppState) => (state.activeStudy && state.studies.some((study) => study.id === state.activeStudy) ? true : 'Create a study first.');
const faceSelection = (state: AppState) => state.selection.filter((pick) => pick.kind === 'face');
/** Mesh and Solve need every boundary to have faces. */
const needsFacesOnBoundaries = (state: AppState) => {
  const missing = unpickedBoundary(activeStudy(state));
  return missing ? `${LOAD_TYPES[missing.type].label} has no faces yet: click faces in the viewport to add them, or remove it.` : true;
};
const needsComponent = (state: AppState) => {
  const study = activeStudy(state);
  return study && needsInstance(study) ? 'Choose the component to analyse (Analyse, in the study).' : true;
};

export function createStudy(type: Study['type']) {
  void createLinkedStudy(type, STUDY_TYPES[type].label);
}

export function addLoad(type: StudyLoad['type']) {
  const state = get();
  const study = state.studies.find((s) => s.id === state.activeStudy);
  if (!study?.definition || !pinnedSelection(study)) {
    report(new Error('Boundary picks require the displayed pinned design without study parameter overrides. Save and generate the design, then update the study link if needed.'));
    return;
  }
  const picks = type === 'gravity' ? [] : faceSelection(state);
  if (type === 'gravity' && study.loads.some((load) => load.type === 'gravity')) { report(new Error('Edit the existing gravity acceleration in the study.')); return; }
  // Nothing selected: the boundary is added empty and the next face clicks go to it.
  const picking = type !== 'gravity' && !picks.length;
  const defaults: Partial<StudyLoad> = type === 'force' ? { magnitude: 100, direction: [0, 0, -1] } : type === 'pressure' ? { magnitude: 1 } : type === 'moment' ? { magnitude: 10, direction: [0, 0, 1] } : type === 'gravity' ? { magnitude: 9.81, direction: [0, 0, -1] } : {};
  let refs: string[];
  try { refs = [...new Set(picks.map(qualifiedReference))]; } catch (error) { report(error); return; }
  if (!admitFaces(study, refs)) return;
  const load: StudyLoad = { id: uid(), type, picks, refs, ...defaults,
    ...(type === 'convection' ? { magnitude: 10, ambientTemperature: 300 } : type === 'temperature' ? { magnitude: 300 } : type === 'heat_flux' ? { magnitude: 1000 } : type === 'velocity_inlet' ? { magnitude: .01, direction: [1, 0, 0] as [number, number, number] } : type === 'pressure_outlet' || type === 'pressure_inlet' ? { magnitude: 0 }
      : type === 'stagnation_inlet' ? { magnitude: 1e6, gasTemperature: 300 } : type === 'mass_flow_inlet' ? { magnitude: .01, gasTemperature: 300 }
      : type === 'ambient_outlet' ? { magnitude: 101325, gasTemperature: 300 } : {}) };
  set({
    studies: state.studies.map((study) => (study.id === state.activeStudy ? { ...study, loads: [...study.loads, load] } : study)),
    selection: [],
    dockOpen: true, dockTab: 'properties',
  });
  persistWorkspaceData();
  if (picking) { startPicking(study.id, load.id, true); return; }
  toast('success', `${LOAD_TYPES[type].label} added`, picks.length ? `Applied to ${picks.length} face${picks.length === 1 ? '' : 's'}.` : undefined);
}

const load = (type: StudyLoad['type'], icon: Command['icon'], description: string): Command => ({
  id: `sim.load.${type}`, label: LOAD_TYPES[type].label, icon, category: 'Simulate', description,
  run: () => addLoad(type),
  enabled: (state) => {
    for (const check of [needsSaved, needsStudy]) { const result = check(state); if (result !== true) return result; }
    if (!allowedBoundaries(activeStudy(state)).includes(type)) return type === 'pin' || type === 'moment' ? 'Not supported by the solver yet.' : 'Choose a boundary appropriate to this study’s physics.';
    return true;
  },
});

export const simulateCommands: Command[] = [
  ...(Object.keys(STUDY_TYPES) as Study['type'][]).map((type): Command => ({
    id: `sim.study.${type}`, label: STUDY_TYPES[type].label, icon: type === 'modal' ? ModalIcon : type === 'thermal' ? ThermalIcon : StudyIcon,
    category: 'Simulate', description: STUDY_TYPES[type].description, run: () => createStudy(type), enabled: (state) => AVAILABLE_STUDY_TYPES.includes(type) ? needsSaved(state) : 'This analysis is still undergoing numerical validation.',
  })),
  { id: 'sim.material', label: 'Material', icon: MaterialIcon, category: 'Simulate', description: 'Assign an engineering material. Mass and study inputs use it.', run: () => set({ dialog: 'material' }), enabled: (state) => (state.displayed ? true : "There's no geometry yet.") },
  load('fixed', FixedIcon, 'Prevent all translation and rotation of the selected faces.'),
  load('pin', PinIcon, 'Allow rotation about a cylindrical face axis.'),
  load('force', ForceIcon, 'Apply a total force distributed over the selected faces.'),
  load('pressure', PressureIcon, 'Apply a uniform pressure normal to the selected faces.'),
  load('moment', MomentIcon, 'Apply a moment about an axis.'),
  load('gravity', GravityIcon, 'Body load from acceleration due to gravity.'),
  load('temperature', ThermalIcon, 'Prescribe an absolute temperature in kelvin.'),
  load('convection', ThermalIcon, 'Exchange heat with an ambient fluid using a film coefficient.'),
  load('heat_flux', ThermalIcon, 'Apply heat flux; positive values add heat to the body.'),
  load('velocity_inlet', ForceIcon, 'Prescribe velocity into the selected fluid faces.'),
  load('pressure_inlet', PressureIcon, 'Set an inlet gauge pressure for transient flow in pascals.'),
  load('pressure_outlet', PressureIcon, 'Set an outlet gauge pressure in pascals.'),
  load('no_slip', FixedIcon, 'Set fluid velocity to zero at the wall.'),
  load('slip', PinIcon, 'Prevent flow through a wall with no tangential friction.'),
  load('stagnation_inlet', PressureIcon, 'Gas enters from a reservoir at rest: total pressure (absolute) and total temperature.'),
  load('mass_flow_inlet', ForceIcon, 'A prescribed mass flow of gas in, at a total temperature.'),
  load('ambient_outlet', PressureIcon, 'Gas leaves into its surroundings at an ambient absolute pressure.'),
  load('symmetry', SymmetricIcon, 'A plane of symmetry: model half or a quarter of the part.'),
  { id: 'sim.contacts', label: 'Contacts', icon: ContactIcon, category: 'Simulate', description: 'Bonded and separating contact between components.', run: () => {}, soon: SOLVER },
  { id: 'sim.mesh', label: 'Mesh', icon: MeshIcon, category: 'Simulate', description: 'Preview the mesh. Optional: Solve meshes on its own.', run: () => { void runStudy('mesh'); }, enabled: (state) => { const ok = needsStudy(state); return ok === true ? needsFacesOnBoundaries(state) : ok; } },
  { id: 'sim.solve', label: 'Solve', icon: SolveIcon, category: 'Simulate', description: 'Save the study, mesh it and solve on the server.', run: () => { void runStudy('solve'); }, enabled: (state) => { const ok = needsStudy(state); if (ok !== true) return ok; const faces = needsFacesOnBoundaries(state); return faces === true ? needsComponent(state) : faces; } },
  { id: 'sim.results.stress', label: 'Von Mises stress', short: 'Stress', icon: StressIcon, category: 'Simulate', description: 'Color the model by equivalent stress.', run: () => selectResult('von_mises') },
  { id: 'sim.results.displacement', label: 'Displacement', short: 'Displace', icon: DisplacementIcon, category: 'Simulate', description: 'Deformed shape with adjustable scale.', run: () => selectResult('displacement') },
  { id: 'sim.results.safety', label: 'Safety factor', short: 'Safety', icon: SafetyIcon, category: 'Simulate', description: 'Yield strength divided by von Mises stress; below 1 shows red.', run: () => selectResult('safety') },
  { id: 'sim.results.temperature', label: 'Temperature', short: 'Temp', icon: ThermalIcon, category: 'Simulate', description: 'Color the model by temperature.', run: () => selectResult('temperature') },
  { id: 'sim.results.heat_flux', label: 'Heat flux', short: 'Heat flux', icon: ThermalIcon, category: 'Simulate', description: 'Color the model by heat flux magnitude.', run: () => selectResult('heat_flux') },
  { id: 'sim.results.velocity', label: 'Flow speed', short: 'Speed', icon: DisplacementIcon, category: 'Simulate', description: 'Color the fluid boundary by flow speed.', run: () => selectResult('velocity') },
  { id: 'sim.results.pressure', label: 'Gauge pressure', short: 'Pressure', icon: PressureIcon, category: 'Simulate', description: 'Color the fluid boundary by gauge pressure.', run: () => selectResult('pressure') },
  { id: 'sim.results.mach', label: 'Mach number', short: 'Mach', icon: DisplacementIcon, category: 'Simulate', description: 'Color the gas boundary by Mach number: flow speed over the local speed of sound.', run: () => selectResult('mach') },
  { id: 'sim.results.absolute_pressure', label: 'Absolute pressure', short: 'Pressure', icon: PressureIcon, category: 'Simulate', description: 'Color the gas boundary by absolute pressure.', run: () => selectResult('pressure') },
  { id: 'sim.results.modes', label: 'Mode shapes', short: 'Modes', icon: ModalIcon, category: 'Simulate', description: 'Show a natural vibration or buckling mode; pick which in Properties.', run: () => selectResult('displacement') },
];

/** A ribbon group of boundary commands: shown, with only its valid buttons, when the study's physics takes any of them. */
const boundaries = (title: string, types: StudyLoad['type'][]): RibbonGroup => ({
  title, priority: HIGH, items: types.map((type) => `sim.load.${type}`),
  visible: (state) => types.some((type) => shows(type)(state)),
  show: (item, state) => shows(item.replace('sim.load.', '') as StudyLoad['type'])(state),
});

const RESULT_PHYSICS: Record<string, (study: Study | undefined) => boolean> = {
  'sim.results.stress': structural, 'sim.results.displacement': structural, 'sim.results.safety': structural,
  'sim.results.mach': compressible,
  'sim.results.temperature': (study) => thermal(study) || compressible(study), 'sim.results.heat_flux': (study) => study?.type === 'thermal' || study?.type === 'thermal_stress',
  'sim.results.velocity': fluid, 'sim.results.pressure': (study) => fluid(study) && !compressible(study), 'sim.results.absolute_pressure': compressible,
  'sim.results.modes': (study) => study?.type === 'modal' || study?.type === 'buckling',
};

export const simulateRibbon: RibbonGroup[] = [
  { title: 'Study', priority: KEEP, items: [{ menu: 'study', label: 'New study', icon: StudyIcon, items: NEW_STUDY_TYPES.map((type) => `sim.study.${type}`) }] },
  { title: 'Material', priority: HIGH, items: ['sim.material'], visible: (state) => !!activeStudy(state) && !['flow', 'compressible'].includes(activeStudy(state)!.type) },
  boundaries('Supports', ['fixed']),
  boundaries('Loads', ['force', 'pressure', 'gravity']),
  boundaries('Thermal', ['temperature', 'heat_flux', 'convection']),
  boundaries('Flow', ['velocity_inlet', 'pressure_inlet', 'stagnation_inlet', 'mass_flow_inlet', 'pressure_outlet', 'ambient_outlet', 'no_slip', 'slip', 'symmetry']),
  { title: 'Solve', priority: KEEP, items: ['sim.mesh', 'sim.solve'], visible: (state) => !!activeStudy(state) },
  { title: 'Results', priority: MID, items: Object.keys(RESULT_PHYSICS), visible: (state) => !!activeStudy(state),
    show: (item, state) => RESULT_PHYSICS[item]?.(activeStudy(state)) ?? false },
  { title: 'Inspect', items: ['inspect.measure', 'inspect.section'] },
];

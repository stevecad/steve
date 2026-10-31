import { create } from 'zustand';
import { get, set, isDirty, isPreviewStale, toast, type Pick, type Study, type StudyLoad } from '@/state/store';
import { persistWorkspaceData } from '@/state/workspaceData';
import { narrow } from '@/state/layout';
import { viewer } from '@/viewport/viewer';
import type { FaceInfo } from '@/viewport/model';
import { isCompressible, simulationApi, terminal, visibleFields, type Boundary, type Gas, type Definition, type Run, type StudyRecord, type ResultManifest } from './api';
import { conjugateProblems } from './conjugate';
import { mergeOutcome, outdated, studyStatus, withRun, type StudyNow, type StudyOutcome, type StudyStatus } from './outcome';
import { fieldLabel, summaryLine } from './units';
import { CASE_START, compressibleProblems, COMPRESSIBLE_MAX_ITERATIONS, DECK_START, finiteVolume, studyAnalysis, studyKind } from './physics';
import type { ColormapId, SafetyMode } from './colormap';
import { uuid } from '@/lib/uuid';
import { pretty } from '@/lib/format';
import type { DesignResult } from '@/lib/modeling';
import { useSteve } from '@/panels/steve';

/** Metres to millimetres without float noise (0.0069 m is 6.9 mm, not 6.8999999999999995). */
const millimetres = (metres: number) => Math.round(metres * 1e9) / 1e6;

/** A value read off the result: `at` is the undeformed location (mm); `inside` when read on a section cut. */
export interface ProbeReading { value: number; at: [number, number, number]; inside: boolean }
/** A probe pinned to the part: `point` is where its label sits on the displayed (deformed) shape. */
export interface PinnedProbe extends ProbeReading { id: number; point: [number, number, number] }

export type Playback = 'mirror' | 'loop' | 'once';

export const useSimulation = create<{
  busy: boolean; error: string | null; runs: Record<string, Run>; result: { run: Run; manifest: ResultManifest } | null;
  /** Each study's durable outcome, from the study list (see outcome.ts); `runs` holds only the run being watched. */
  outcomes: Record<string, StudyOutcome>;
  field: string; frame: number; region: string; deformation: number;
  /** The exaggeration that makes the deformed shape visible (max displacement ≈ 10% of the part). */
  autoDeformation: number;
  /** The decoded result's full range (SI units). */
  range: { min: number; max: number } | null;
  /** Contour style: bands (as CAE legends read) or a smooth ramp; how many bands; which colormap. */
  contours: 'banded' | 'smooth';
  bands: number;
  colormap: ColormapId;
  /** A legend range typed in (SI units), or null for the result's full range. */
  legendRange: { min: number; max: number } | null;
  /** Values outside a typed-in range: grey, or the end colours. */
  outOfRange: 'grey' | 'clamp';
  /** The material's yield strength marked on stress legends. */
  showYield: boolean;
  /** The undeformed part as a translucent ghost behind the deformed result; the element edges over the result. */
  ghost: boolean;
  meshEdges: boolean;
  /** The rest of the design, dimmed around a result of some of its components (when it lines up with the result). */
  context: boolean;
  /** A slim colour key over the viewport while the inspector, where the legend is, is closed (ResultsOverlay). */
  colourKey: boolean;
  /** Safety factor colouring: a 1–10 gradient, traffic-light zones, or only what falls below a target. */
  safetyMode: SafetyMode;
  trafficRed: number;
  trafficAmber: number;
  safetyTarget: number;
  /** Results animation: deformation, a mode shape or transient steps. */
  playing: boolean;
  playback: Playback;
  /** Where the animation stands in its cycle (0–1), or null to show the full result still. */
  phase: number | null;
  speed: number;
  /** Recording the viewport to a video (WebM). */
  recording: boolean;
  /** The reading under the pointer, with its screen position. */
  probe: (ProbeReading & { clientX: number; clientY: number }) | null;
  probes: PinnedProbe[];
  /** Whether this result has values inside the part (so a section cut shows them), once decoded. */
  interior: boolean | null;
  resourceClass: string;
  /** A boundary waiting for faces: viewport face clicks add (or remove) them until Done or Esc. */
  /** A boundary taking face clicks. `before`: its faces when picking began (Cancel puts them back); null when the
   *  boundary was added for this picking (Cancel removes it). */
  picking: { studyId: string; loadId: string; before: { refs: string[]; picks: Pick[] } | null } | null;
  /** When each run was first seen running (ms), for elapsed time while it works. */
  startedAt: Record<string, number>;
}>(() => ({ busy: false, error: null, runs: {}, outcomes: {}, result: null, field: 'von_mises', frame: 0, region: '', deformation: 0, autoDeformation: 1, range: null,
  contours: 'banded', bands: 10, colormap: 'rainbow', legendRange: null, outOfRange: 'grey', showYield: true, ghost: true, meshEdges: false, context: true, colourKey: true,
  safetyMode: 'gradient', trafficRed: 1, trafficAmber: 2, safetyTarget: 2,
  playing: false, playback: 'mirror', phase: null, speed: 1, recording: false,
  probe: null, probes: [], interior: null,
  resourceClass: 'standard', picking: null, startedAt: {} }));

/** Safety factors above this show as this (the colour scale stays readable). */
export const SAFETY_CAP = 10;

/** The yield strength the solve used (Pa), the weakest if several bodies: from the result's resolved materials. */
export function yieldOf(manifest: ResultManifest | undefined): number | null {
  const resolved = (manifest as { materials?: { resolved?: Record<string, { yield_strength_pa?: number | null }> } } | undefined)?.materials?.resolved;
  const values = Object.values(resolved ?? {}).map((m) => m.yield_strength_pa).filter((v): v is number => typeof v === 'number' && v > 0);
  return values.length ? Math.min(...values) : null;
}

/** The first boundary that still needs faces (gravity needs none). */
export function unpickedBoundary(study: Study | undefined): StudyLoad | undefined {
  return study?.loads.find((load) => load.type !== 'gravity' && !load.refs?.length);
}

/** Face clicks go to this boundary until OK (stopPicking) or Cancel (cancelPicking). `added`: it was just created for this. */
export function startPicking(studyId: string, loadId: string, added = false) {
  const load = get().studies.find((study) => study.id === studyId)?.loads.find((item) => item.id === loadId);
  useSimulation.setState({ picking: { studyId, loadId, before: added || !load ? null : { refs: [...(load.refs ?? [])], picks: [...load.picks] } } });
  set({ selection: [], studyOverview: false });
}

/** OK: keep the faces picked. */
export function stopPicking() {
  useSimulation.setState({ picking: null });
}

/** Cancel: the boundary's faces as they were before picking (a boundary added for this picking is removed). */
export function cancelPicking() {
  const picking = useSimulation.getState().picking;
  if (!picking) return;
  useSimulation.setState({ picking: null });
  set((state) => ({ studies: state.studies.map((study) => study.id !== picking.studyId ? study : {
    ...study,
    loads: picking.before === null ? study.loads.filter((load) => load.id !== picking.loadId)
      : study.loads.map((load) => (load.id === picking.loadId ? { ...load, refs: picking.before!.refs, picks: picking.before!.picks } : load)),
  }) }));
  persistWorkspaceData();
}

/** A face clicked while a boundary is picking: added, or removed if it was already there. */
export function togglePickedFace(pick: Pick) {
  const picking = useSimulation.getState().picking;
  if (!picking || pick.kind !== 'face') return;
  let reference: string;
  try { reference = qualifiedReference(pick); } catch (error) { report(error); return; }
  const study = get().studies.find((item) => item.id === picking.studyId);
  const known = study?.loads.find((load) => load.id === picking.loadId)?.refs?.includes(reference);
  if (study && !known && !admitFaces(study, [reference])) return;
  set((state) => ({ studies: state.studies.map((study) => study.id !== picking.studyId ? study : { ...study, loads: study.loads.map((load) => {
    if (load.id !== picking.loadId) return load;
    const refs = load.refs ?? [];
    if (refs.includes(reference)) {
      return { ...load, refs: refs.filter((ref) => ref !== reference), picks: load.picks.filter((p) => !(p.kind === 'face' && p.mesh === pick.mesh && p.index === pick.index && p.node === pick.node)) };
    }
    return { ...load, refs: [...refs, reference], picks: [...load.picks, pick] };
  }) }) }));
  persistWorkspaceData();
}

export function report(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  useSimulation.setState({ error: message, busy: false });
  toast('danger', 'Simulation', message);
}

function instanceFor(pick: Pick): string {
  if (!viewer.model || pick.kind !== 'face') throw new Error('Choose a named face in the viewport.');
  return instanceOfNode(pick.node);
}

/** The instance a model node belongs to, as studies name it ("blade_2", "link/sub"); "part" in a part. */
export function instanceOfNode(node: string): string {
  const model = viewer.model;
  if (!model) throw new Error('The design has no geometry yet.');
  if (model.build.kind === 'part') return 'part';
  const nodes = (model.gltf.parser.json as { nodes: { name?: string }[] }).nodes;
  const names: string[] = [];
  let id: string | null = node;
  while (id && id !== model.rootId) {
    const node: (typeof model.tree)[string] = model.tree[id];
    const name = nodes[Number(id.replace(/^n/, ''))]?.name;
    if (!node || !name) throw new Error('The selected face has no named component instance.');
    // Tree labels are prettified for display; only original instance names are identities.
    names.unshift(name);
    id = node.parent;
  }
  if (!names.length) throw new Error('The selected face has no named component instance.');
  return names.join('/');
}

/** Analyses CalculiX and the flow solver run on one solid; conjugate heat transfer joins several. */
/** Studies of one solid; conjugate heat transfer, model-written cases and rotating flow take several bodies. */
export const singleSolid = (study: Study) => study.type !== 'cht' && study.type !== 'openfoam_case' && study.type !== 'calculix_deck'
  && !study.definition?.analysis.rotation?.length;

/** A design's placed instances a study can analyse, grouped by component, with their bodies. */
export interface InstanceOption { name: string; label: string; group: string; groupLabel: string; bodies: string[]; /** Has surface bodies (left out). */ surfaces?: boolean }

let instanceCache: { build: string; options: InstanceOption[] } | null = null;
export function analysableInstances(): InstanceOption[] {
  const model = viewer.model;
  if (!model || model.build.kind === 'part') return [];
  if (instanceCache?.build === model.build.id) return instanceCache.options;
  const design = (model.build.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design;
  const found = new Map<string, InstanceOption>();
  for (const mesh of model.faces) {
    const face = mesh.userData.face as FaceInfo;
    let name: string;
    try { name = instanceOfNode(face.node); } catch { continue; }
    let option = found.get(name);
    if (!option) {
      const top = model.instanceOf(face.node);
      const component = top?.component ?? name.split('/')[0];
      option = { name, label: name.split('/').map(pretty).join(' › '), group: top?.link ? `link:${component}` : component,
        groupLabel: top?.link ? `${pretty(component)} (linked)` : design?.components[component]?.name ?? pretty(component), bodies: [] };
      found.set(name, option);
    }
    const topology = model.topologyFor(face.meshIndex);
    const bodies = topology?.faces[face.faceIndex]?.bodies;
    // Surface bodies aren't solids: never analysed, so never counted as a component's bodies.
    if (bodies?.length === 1 && !topology?.surface_bodies?.includes(bodies[0]) && !option.bodies.includes(bodies[0])) option.bodies.push(bodies[0]);
    if (topology?.surface_bodies?.length) option.surfaces = true;
  }
  // A component of surface bodies only has nothing to analyse (the study's geometry leaves it out).
  const options = [...found.values()].filter((option) => option.bodies.length || !option.surfaces).sort((a, b) => a.groupLabel.localeCompare(b.groupLabel) || a.label.localeCompare(b.label, undefined, { numeric: true }));
  instanceCache = { build: model.build.id, options };
  return options;
}

/** The instance a qualified face reference ("blade_2:extrude_1.end") belongs to. */
export const instanceOfRef = (ref: string) => ref.split(':', 1)[0];

/** The instance a single-solid study should analyse when none is chosen: where its faces are, else the selection. */
export function suggestedInstance(study: Study): string | null {
  const fromFaces = study.loads.flatMap((load) => load.refs ?? []).map(instanceOfRef)[0];
  if (fromFaces) return fromFaces;
  for (const pick of get().selection) {
    try { return instanceOfNode(pick.node); } catch { /* not a design instance */ }
  }
  return null;
}

/** Whether a single-solid study on a multi-solid design still needs its component chosen. */
export function needsInstance(study: Study): boolean {
  if (!singleSolid(study) || study.definition?.design.instances.length || !pinnedSelection(study)) return false;
  return analysableInstances().reduce((sum, option) => sum + Math.max(option.bodies.length, 1), 0) > 1;
}

const loadLabel = (type: string) => type.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Sets what a study analyses. Boundaries keep only faces on what is analysed; anything cleared is said once,
 * so the person can pick those faces again on the new component.
 */
export function setAnalysed(studyId: string, instances: string[], quiet = false) {
  const study = get().studies.find((item) => item.id === studyId);
  if (!study?.definition) return;
  const keep = (ref: string) => !instances.length || instances.includes(instanceOfRef(ref));
  const cleared = study.loads.filter((load) => load.refs?.some((ref) => !keep(ref)));
  set((state) => ({ studies: state.studies.map((item) => item.id !== studyId ? item : {
    ...item, definition: { ...item.definition!, design: { ...item.definition!.design, instances } },
    loads: item.loads.map((load) => !load.refs?.some((ref) => !keep(ref)) ? load : {
      ...load, refs: load.refs!.filter(keep), picks: load.picks.filter((pick) => { try { return keep(qualifiedReference(pick)); } catch { return false; } }) }),
  }) }));
  persistWorkspaceData();
  if (cleared.length && !quiet) toast('info', 'Faces cleared', `${cleared.map((load) => loadLabel(load.type)).join(', ')} had faces on another component. Pick them again on ${instances.map((name) => name.split('/').map(pretty).join(' › ')).join(', ')}.`);
}

/** The pose a moving design is simulated in (null: as modelled); see StudyPose. */
export function setPose(studyId: string, pose: string | Record<string, number> | null) {
  set((state) => ({ studies: state.studies.map((item) => item.id !== studyId || !item.definition ? item : {
    ...item, definition: { ...item.definition, design: { ...item.definition.design, pose } } }) }));
  persistWorkspaceData();
}

/**
 * Whether faces may join a study, as its component rule allows. A single-solid study on a design analyses one
 * component: its first faces choose it (with nothing picked yet, faces elsewhere switch it); faces on another
 * component are refused with a note. A conjugate study refuses faces on components it leaves out.
 */
export function admitFaces(study: Study, refs: string[]): boolean {
  if (!refs.length || !viewer.model || viewer.model.build.kind === 'part' || analysableInstances().length < 2) return true;
  const analysed = study.definition?.design.instances ?? [];
  const wanted = [...new Set(refs.map(instanceOfRef))];
  const label = (name: string) => name.split('/').map(pretty).join(' › ');
  if (!singleSolid(study)) {
    const outside = wanted.filter((name) => analysed.length && !analysed.includes(name));
    if (outside.length) toast('info', `${label(outside[0])} isn’t in this study`, 'Add it under Analyse to pick its faces.');
    return !outside.length;
  }
  if (wanted.length > 1) {
    toast('info', 'One component at a time', `These faces are on ${wanted.map(label).join(' and ')}. Structural, thermal, modal and flow studies analyse one component: pick faces on one of them.`);
    return false;
  }
  const [instance] = wanted;
  const current = study.loads.flatMap((load) => load.refs ?? []).map(instanceOfRef)[0];
  if (current && current !== instance) {
    toast('info', `This study analyses ${label(current)}`, `${label(instance)} isn’t part of it. To study ${label(instance)} instead, choose it under Analyse.`);
    return false;
  }
  if (analysed[0] !== instance || analysed.length !== 1) {
    setAnalysed(study.id, [instance], true);
    if (analysed.length) toast('info', `Now analysing ${label(instance)}`, 'Structural, thermal, modal and flow studies analyse one component at a time.');
  }
  return true;
}

export function qualifiedReference(pick: Pick): string {
  if (pick.kind !== 'face') throw new Error('Choose a named face in the viewport.');
  const reference = viewer.model?.topologyFor(pick.mesh)?.faces[pick.index]?.ref;
  if (!reference) throw new Error('This face has no persistent name. Rebuild a STEVE modeling design before assigning this boundary.');
  return `${instanceFor(pick)}:${reference}`;
}

export function qualifiedBody(pick: Pick): string {
  if (pick.kind !== 'face') throw new Error('Choose a face of the region body.');
  const bodies = viewer.model?.topologyFor(pick.mesh)?.faces[pick.index]?.bodies;
  if (!bodies?.length) throw new Error('This face has no body identity. Rebuild the design before assigning thermal regions.');
  if (bodies.length !== 1) throw new Error('This face belongs to multiple bodies. Interface picking requires a uniquely owned named face.');
  return `${instanceFor(pick)}:${bodies[0]}`;
}

export function pinnedSelection(study: Study): boolean {
  const state = get(), pin = study.definition?.design;
  return !!pin && pin.document_id === state.doc.saved?.id && pin.revision === state.doc.saved?.revision && pin.branch === state.doc.branch
    && viewer.model?.build.id === state.displayed?.id && !Object.keys(pin.overrides).length && !state.pastVersion && !isDirty(state) && !isPreviewStale(state);
}

export function displayedBodies(study: Study): string[] {
  if (!pinnedSelection(study)) return [];
  const bodies = new Set<string>();
  for (const mesh of viewer.model?.faces ?? []) {
    const face = mesh.userData.face as FaceInfo;
    const pick: Pick = { kind: 'face', node: face.node, mesh: face.meshIndex, index: face.faceIndex };
    if (study.definition?.design.instances.length && !study.definition.design.instances.includes(instanceFor(pick))) continue;
    try { bodies.add(qualifiedBody(pick)); } catch { /* Unnamed or ambiguous bodies cannot be assigned through preview picks. */ }
  }
  return [...bodies].sort();
}

export function picksFor(refs: string[]): Pick[] {
  const model = viewer.model;
  if (!model) return [];
  return model.allFaces().flatMap((face) => {  // Merged huge parts expanded into their faces.
    const pick: Pick = { kind: 'face', node: face.node, mesh: face.meshIndex, index: face.faceIndex };
    try { return refs.includes(qualifiedReference(pick)) ? [pick] : []; } catch { return []; }
  });
}

export function fromRecord(record: StudyRecord): Study {
  const d = record.compiled;
  const loads: StudyLoad[] = d.boundaries.map((b) => {
    const same = get().doc.saved?.id === d.design.document_id && get().doc.saved?.revision === d.design.revision
      && get().doc.branch === d.design.branch && viewer.model?.build.id === get().displayed?.id
      && !Object.keys(d.design.overrides).length && !get().pastVersion && !isDirty() && !isPreviewStale();
    const base = { id: b.id, type: b.type, picks: same ? picksFor(b.faces) : [] as Pick[], refs: b.faces };
    if (b.type === 'force' || b.type === 'velocity_inlet') {
      const vector = b.type === 'force' ? b.force_n : b.velocity_m_s;
      const magnitude = Math.hypot(...vector);
      return { ...base, magnitude, direction: vector.map((v) => magnitude ? v / magnitude : 0) as [number, number, number] };
    }
    if (b.type === 'pressure') return { ...base, magnitude: b.pressure_pa / 1e6 };
    if (b.type === 'temperature') return { ...base, magnitude: b.temperature_k };
    if (b.type === 'convection') return { ...base, magnitude: b.coefficient_w_m2k, ambientTemperature: b.ambient_temperature_k };
    if (b.type === 'heat_flux') return { ...base, magnitude: b.flux_w_m2 };
    if (b.type === 'pressure_inlet' || b.type === 'pressure_outlet') return { ...base, magnitude: b.gauge_pressure_pa };
    if (b.type === 'stagnation_inlet') return { ...base, magnitude: b.total_pressure_pa, gasTemperature: b.total_temperature_k };
    if (b.type === 'mass_flow_inlet') return { ...base, magnitude: b.mass_flow_kg_s, gasTemperature: b.total_temperature_k };
    if (b.type === 'ambient_outlet') return { ...base, magnitude: b.pressure_pa, gasTemperature: b.temperature_k };
    if (b.type === 'named') return { ...base, patchType: b.patch_type ?? 'patch' };
    return { ...base, ...(b.type === 'fixed' ? { axes: b.axes } : {}) };
  });
  const gravity = d.analysis.gravity_m_s2 ?? [0, 0, 0];
  const acceleration = Math.hypot(...gravity);
  if (acceleration) loads.push({ id: '__gravity', type: 'gravity', picks: [], refs: [], magnitude: acceleration,
    direction: gravity.map((value) => value / acceleration) as [number, number, number] });
  const study: Study = { id: (record.study_id ?? record.id)!, revision: record.revision, branch: record.branch, source: record.source,
    name: d.name, type: studyKind(d.analysis.type), loads,
    meshSize: millimetres(d.mesh.size_m), definition: d };
  savedPrints.set(`${study.id}@${study.revision}`, fingerprint(study));
  return study;
}

/** What a study saves, as a string: a study differs from its saved revision when this does. */
function fingerprint(study: Study): string {
  return JSON.stringify([study.name, study.meshSize, study.loads.map((l) => [l.id, l.type, l.refs, l.magnitude, l.direction, l.axes, l.ambientTemperature, l.gasTemperature, l.patchType]),
    study.definition?.analysis, study.definition?.fluid, study.definition?.gas ?? null, study.definition?.materials, study.definition?.regions, study.definition?.interfaces, study.definition?.probes ?? [],
    study.definition?.design.instances, study.definition?.design.pose ?? null, study.definition?.design.revision, study.definition?.design.branch]);
}
const savedPrints = new Map<string, string>();

/** Whether a study has edits not yet saved as a revision (Solve and Mesh save first). */
export function studyDirty(study: Study): boolean {
  if (!study.revision) return true;
  const saved = savedPrints.get(`${study.id}@${study.revision}`);
  return saved === undefined || saved !== fingerprint(study);
}

export function definitionOf(study: Study): Definition {
  if (!study.definition) throw new Error('This browser-only study has no verified design pin. Create a linked study and reselect its boundaries.');
  const gravities = study.loads.filter((load) => load.type === 'gravity');
  if (gravities.length > 1) throw new Error('A study has one global gravity acceleration.');
  const gravity = gravities[0];
  const boundaries: Boundary[] = study.loads.filter((load) => load.type !== 'gravity').map((load) => {
    if (!load.refs?.length) throw new Error(`${load.type.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())} has no faces yet: click faces in the viewport to add them, or remove it.`);
    const base = { id: load.id, faces: load.refs };
    if (load.type === 'fixed') return { ...base, type: 'fixed', axes: load.axes ?? [0, 1, 2] };
    if (load.type === 'force') return { ...base, type: 'force', force_n: (load.direction ?? [0, 0, -1]).map((v) => v * (load.magnitude ?? 0)) as [number, number, number] };
    if (load.type === 'pressure') return { ...base, type: 'pressure', pressure_pa: (load.magnitude ?? 0) * 1e6 };
    if (load.type === 'temperature') return { ...base, type: 'temperature', temperature_k: load.magnitude ?? 300 };
    if (load.type === 'convection') return { ...base, type: 'convection', coefficient_w_m2k: load.magnitude ?? 10, ambient_temperature_k: load.ambientTemperature ?? 300 };
    if (load.type === 'heat_flux') return { ...base, type: 'heat_flux', flux_w_m2: load.magnitude ?? 0 };
    if (load.type === 'velocity_inlet') return { ...base, type: 'velocity_inlet', velocity_m_s: (load.direction ?? [1, 0, 0]).map((v) => v * (load.magnitude ?? 0)) as [number, number, number] };
    if (load.type === 'pressure_inlet' || load.type === 'pressure_outlet') return { ...base, type: load.type, gauge_pressure_pa: load.magnitude ?? 0 };
    if (load.type === 'no_slip' || load.type === 'slip' || load.type === 'symmetry') return { ...base, type: load.type };
    if (load.type === 'stagnation_inlet') return { ...base, type: 'stagnation_inlet', total_pressure_pa: load.magnitude ?? 1e6, total_temperature_k: load.gasTemperature ?? 300 };
    if (load.type === 'mass_flow_inlet') return { ...base, type: 'mass_flow_inlet', mass_flow_kg_s: load.magnitude ?? .01, total_temperature_k: load.gasTemperature ?? 300 };
    if (load.type === 'ambient_outlet') return { ...base, type: 'ambient_outlet', pressure_pa: load.magnitude ?? 101325, temperature_k: load.gasTemperature ?? 300 };
    if (load.type === 'named') return { ...base, type: 'named', patch_type: load.patchType ?? 'patch' };
    throw new Error(`${load.type} has not passed the solver acceptance tests yet.`);
  });
  return { ...study.definition, name: study.name, boundaries,
    analysis: { ...study.definition.analysis, gravity_m_s2: gravity ? (gravity.direction ?? [0, 0, -1]).map((value) => value * (gravity.magnitude ?? 0)) : [0, 0, 0] },
    mesh: { ...study.definition.mesh, size_m: study.meshSize / 1000 } };
}

export function replaceStudy(study: Study, documentId: string) {
  if (get().doc.saved?.id !== documentId) return;
  set((state) => ({ studies: state.studies.some((s) => s.id === study.id) ? state.studies.map((s) => s.id === study.id ? study : s) : [...state.studies, study] }));
  persistWorkspaceData();
}

export async function createLinkedStudy(type: Study['type'], label: string) {
  if (useSimulation.getState().busy) return;
  useSimulation.setState({ busy: true, error: null });
  try {
    const state = get(), saved = state.doc.saved;
    if (!saved || state.pastVersion || isDirty(state) || isPreviewStale(state)) throw new Error('Save and generate the current design before creating a linked study.');
    if (!['static', 'thermal', 'thermal_stress', 'modal', 'buckling', 'flow', 'cht', 'compressible', 'openfoam_case', 'calculix_deck'].includes(type)) throw new Error('This analysis is still undergoing numerical validation.');
    const analysis = studyAnalysis(type);
    const capabilities = await simulationCapabilities(true);
    if (!capabilities.analyses.includes(analysis)) throw new Error('This analysis is not available in the server’s configured solver image.');
    const extent = Math.max(...(state.displayed?.metadata?.bounds_mm ?? [20, 20, 20]));
    // A design study of one solid starts on the selected component, if one is selected.
    let instances: string[] = [];
    if (type !== 'cht' && type !== 'openfoam_case' && type !== 'calculix_deck' && viewer.model && viewer.model.build.kind !== 'part' && analysableInstances().length > 1) {
      for (const pick of state.selection) { try { instances = [instanceOfNode(pick.node)]; break; } catch { /* not an instance */ } }
    }
    const definition: Definition = { schema_version: 1, name: `${label} ${state.studies.length + 1}`,
      design: { document_id: saved.id, revision: saved.revision, branch: state.doc.branch, overrides: {}, instances },
      analysis: { type: analysis,
        ...(type === 'thermal_stress' ? { reference_temperature_k: 300 } : {}),
        ...(type === 'compressible' ? { max_iterations: COMPRESSIBLE_MAX_ITERATIONS } : {}),
        ...(type === 'openfoam_case' ? { case: { application: 'simpleFoam', files: { ...CASE_START } } } : {}),
        ...(type === 'calculix_deck' ? { deck: { input: DECK_START } } : {}) },
      materials: {}, boundaries: [], mesh: { size_m: extent / 20000, order: finiteVolume(type) ? 1 : 2 } };
    if (type === 'compressible') {
      // The server takes a compressible study once it has its gas, an inlet and an ambient outlet: until its first
      // save it is a local draft, as a conjugate study is. Air to start with; the Gas section changes it.
      const presets = capabilities.gas_presets ?? {};
      const gas = presets.air ?? Object.values(presets)[0] ?? null;
      const study: Study = { id: `draft_${uuid()}`, name: definition.name, type, loads: [], meshSize: millimetres(definition.mesh.size_m),
        definition: { ...definition, gas: gas ? { ...gas } : null } };
      replaceStudy(study, saved.id);
      if (get().doc.saved?.id === saved.id) set({ activeStudy: study.id, dockOpen: true, dockTab: 'properties' });
      return;
    }
    if (type === 'cht') {
      // Region graphs must be complete before the server can accept a revision.
      // This explicit local setup draft is replaced atomically on its first save.
      const study: Study = { id: `draft_${uuid()}`, name: definition.name, type, loads: [], meshSize: millimetres(definition.mesh.size_m),
        definition: { ...definition, regions: [], interfaces: [] } };
      replaceStudy(study, saved.id);
      if (get().doc.saved?.id === saved.id) set({ activeStudy: study.id, dockOpen: true, dockTab: 'properties' });
      return;
    }
    const record = await simulationApi<StudyRecord>('studies', 'POST', { definition });
    const study = fromRecord(record);
    replaceStudy(study, saved.id);
    if (get().doc.saved?.id === saved.id) set({ activeStudy: study.id, dockOpen: true, dockTab: 'properties' });
  } catch (error) { report(error); }
  finally { useSimulation.setState({ busy: false }); }
}

/** What the server's solvers offer (GET simulation/capabilities): asked once per page, again after a failure. */
export interface Capabilities { analyses: string[]; gas_presets?: Record<string, Gas>; gas_presets_temperature_dependent?: Record<string, Gas> }
let capabilitiesRequest: Promise<Capabilities> | null = null;
/** `fresh`: ask again (creating a study checks what the solvers offer now). */
export function simulationCapabilities(fresh = false): Promise<Capabilities> {
  if (fresh || !capabilitiesRequest) capabilitiesRequest = simulationApi<Capabilities>('simulation/capabilities').catch((error) => { capabilitiesRequest = null; throw error; });
  return capabilitiesRequest;
}

const pendingSaves = new Map<string, Promise<Study>>();
export async function saveStudy(study: Study): Promise<Study> {
  if (pendingSaves.has(study.id)) return pendingSaves.get(study.id)!;
  const saving = (async () => {
    const definition = definitionOf(study);
    const problems = [...conjugateProblems(definition), ...compressibleProblems(definition)];
    if (problems.length) throw new Error(problems.join(' '));
    const record = await simulationApi<StudyRecord>(study.revision ? `studies/${study.id}` : 'studies', study.revision ? 'PUT' : 'POST',
      { definition, branch: study.branch ?? 'main', ...(study.revision ? { expected_revision: study.revision } : {}) });
    const saved = fromRecord(record);
    if (study.revision) replaceStudy(saved, definition.design.document_id);
    else if (get().doc.saved?.id === definition.design.document_id) {
      set((state) => ({ studies: state.studies.map((item) => item.id === study.id ? saved : item), activeStudy: state.activeStudy === study.id ? saved.id : state.activeStudy }));
      persistWorkspaceData();
    }
    return saved;
  })();
  pendingSaves.set(study.id, saving);
  try { return await saving; } finally { pendingSaves.delete(study.id); }
}

let subscription: EventSource | null = null;
let watching = 0;
export function stopWatching() { watching++; subscription?.close(); subscription = null; }

/** Shows a run's results while `watched` is still the study's watched run (the run itself, or a newer attempt it sits behind). */
async function openResults(run: Run, studyId: string, watched = run.id) {
  const manifest = await simulationApi<ResultManifest>(`simulation/runs/${run.id}/results`);
  // A result asked for in an earlier revision: learn that revision's setup, so staleness() compares inputs.
  const study = get().studies.find((item) => item.id === studyId);
  if (study?.revision && run.revision !== study.revision && (!run.study_id || run.study_id === studyId) && !savedPrints.has(`${studyId}@${run.revision}`)) {
    await simulationApi<StudyRecord>(`studies/${studyId}?branch=${encodeURIComponent(run.branch)}&revision=${run.revision}`).then(fromRecord).catch(() => undefined);
  }
  const now = useSimulation.getState();
  if (get().activeStudy !== studyId || now.runs[studyId]?.id !== watched || (watched !== run.id && now.result)) return;
  const auto = autoDeformationFor(manifest);
  useSimulation.setState({ result: { run, manifest }, playing: false, phase: null, legendRange: null, region: '', frame: Math.max(0, (manifest.frames?.length ?? 1) - 1),
    ...(manifest.modes ? { deformation: 1 } : { deformation: auto, autoDeformation: auto }),
    field: resultField(run, manifest) });
}

/** The field a result opens on: the mesh, the first mode, von Mises stress, Mach number, temperature or velocity. */
export function resultField(run: Run, manifest: ResultManifest): string {
  return run.operation === 'mesh' ? 'mesh' : manifest.modes?.[0]?.field ?? (manifest.arrays.von_mises ? 'von_mises' : manifest.arrays.mach ? 'mach'
    : manifest.arrays.temperature || manifest.regions ? 'temperature' : 'velocity');
}

/**
 * All studies on the model at once (the Studies row in the browser); choosing a study goes back to it alone. The list,
 * their states and the colour scales are in the inspector (StudyInspector → AllStudies), never over the viewport.
 */
export function showAllStudies() {
  stopPicking();
  // On a phone both panels are drawers over the canvas: they close to show the model (the inspector opens on request).
  set({ studyOverview: true, ...(narrow() ? { browserOpen: false, dockOpen: false } : { dockOpen: true, dockTab: 'properties' as const }) });
}

/** Auto deformation: the largest displacement drawn at this fraction of the part's size (as SOLIDWORKS and Abaqus do). */
export const AUTO_FRACTION = 0.1;

/** An exaggeration making the largest displacement about 10% of the part's size, to two figures (1 when already visible). */
function autoDeformationFor(manifest: ResultManifest): number {
  const displacement = manifest.summary?.max_displacement_m ?? Math.max(Math.abs(manifest.arrays.displacement?.min ?? 0), Math.abs(manifest.arrays.displacement?.max ?? 0));
  const positions = manifest.arrays.positions;
  if (!manifest.arrays.displacement || !displacement || !positions) return 0;
  const scale = AUTO_FRACTION * (positions.max - positions.min) / displacement;
  return Number.isFinite(scale) && scale > 1 ? Number(scale.toPrecision(2)) : 1;
}

/** Deformation presets: multiples of Auto, plus true scale and none (Ansys's 0.5× / Auto / 2× / 5×). */
export const DEFORMATION_PRESETS = [
  { id: 'undeformed', label: 'Undeformed' }, { id: 'true', label: 'True' }, { id: 'half', label: '0.5×' },
  { id: 'auto', label: 'Auto' }, { id: 'double', label: '2×' }, { id: 'five', label: '5×' },
] as const;
export type DeformationPreset = (typeof DEFORMATION_PRESETS)[number]['id'];

export function presetScale(preset: DeformationPreset, auto: number): number {
  return { undeformed: 0, true: 1, half: auto / 2, auto, double: auto * 2, five: auto * 5 }[preset];
}

/** The preset a scale matches, if any. */
export function presetOf(scale: number, auto: number): DeformationPreset | null {
  return DEFORMATION_PRESETS.find((preset) => Math.abs(presetScale(preset.id, auto) - scale) <= 1e-9 * Math.max(1, scale))?.id ?? null;
}

/** "×240 (Auto)", "True scale", "Undeformed": the deformation as the results header states it. */
export function deformationText(scale: number, auto: number): string {
  if (scale === 0) return 'Undeformed';
  if (Math.abs(scale - 1) < 1e-9) return 'True scale (×1)';
  const preset = presetOf(scale, auto);
  const factor = `×${Number(scale.toPrecision(3)).toLocaleString()}`;
  return preset === 'auto' ? `${factor} (Auto)` : preset ? `${factor} (${DEFORMATION_PRESETS.find((p) => p.id === preset)!.label} Auto)` : factor;
}

/**
 * Why the showing result no longer matches what is open (null while it is current), by the same rule as the study
 * tree (outcome.ts outdated): with the server's verdict when the result is the study's last solve.
 */
export function staleness(study: Study | undefined, manifest: ResultManifest | undefined, run?: Run): string | null {
  if (!study || !manifest) return null;
  // The revision this study asked for the result in (a result reused from another study was asked for in this one's).
  const asked = run?.study_id && run.study_id !== study.id ? study.revision ?? manifest.provenance.study_revision : run?.revision ?? manifest.provenance.study_revision;
  const known = run ? useSimulation.getState().outcomes[study.id]?.last_solve : undefined;
  const listed = known && known.id === run?.id ? known : undefined;
  return outdated({ revision: asked, design: manifest.provenance.design, current: listed?.current, outdated: listed?.outdated }, studyNow(study));
}

/** The study and saved design as they are now, to judge a result against. */
function studyNow(study: Study): StudyNow {
  const state = get(), saved = state.doc.saved, dirty = studyDirty(study);
  return { revision: study.revision, dirty, setup: dirty && !study.loads.length, sameInputs: (revision) => sameInputs(study, revision),
    design: saved ? { id: saved.id, revision: saved.revision, branch: state.doc.branch } : null };
}

/** What the study tree shows for a study: its durable outcome, with the run this page watches folded in. */
export function statusOf(study: Study): StudyStatus {
  const { outcomes, runs } = useSimulation.getState();
  const run = runs[study.id];
  return studyStatus(withRun(outcomes[study.id], run, run?.revision === study.revision ? study.definition?.design : undefined), studyNow(study));
}

/** Whether a study's revision `revision` saved the same setup as its current one (both known: fromRecord). */
function sameInputs(study: Study, revision: number): boolean {
  const then = savedPrints.get(`${study.id}@${revision}`);
  return then !== undefined && then === savedPrints.get(`${study.id}@${study.revision}`);
}

/** Solves again on the design as it is now: the study follows the current design revision, then solves. */
export async function resolveCurrent(study: Study) {
  const state = get(), design = state.doc.saved;
  if (!study.definition || !design) return;
  if (state.pastVersion || isDirty(state) || isPreviewStale(state)) { report(new Error('Save and generate the design before solving it again.')); return; }
  const pin = study.definition.design;
  if (pin.document_id === design.id && (pin.revision !== design.revision || pin.branch !== state.doc.branch)) {
    replaceStudy({ ...study, definition: { ...study.definition, design: { ...pin, revision: design.revision, branch: state.doc.branch } } }, design.id);
  }
  await runStudy('solve');
}

/**
 * A question for STEVE about the showing result: the study (by name and id), what it analysed, its headline
 * numbers as the solver reported them, and what an engineer wants to know next. STEVE reads the study itself.
 */
export function resultQuestion(study: Study, manifest: ResultManifest): string {
  const state = get();
  const analysed = study.definition?.design.instances ?? [];
  const target = analysed.length ? analysed.map((name) => name.split('/').map(pretty).join(' › ')).join(', ') : state.doc.name || 'the part';
  const flow = !!manifest.engine.openfoam;
  const numbers = Object.entries(manifest.summary ?? {}).filter(([, value]) => typeof value === 'number').slice(0, 4).map(([key, value]) => {
    const { label, shown } = summaryLine(key, value, flow);
    return `${label.charAt(0).toLowerCase()}${label.slice(1)} ${shown.value}${shown.unit ? ` ${shown.unit}` : ''}`;
  });
  const yieldPa = yieldOf(manifest), stress = manifest.summary?.max_von_mises_pa;
  if (yieldPa && stress) numbers.push(`min safety factor ${(yieldPa / stress).toPrecision(3)}`);
  const kind = manifest.analysis;
  const question = kind.startsWith('modal') ? `Are these natural frequencies a problem for ${target}? Which modes matter, and how would I move them if they do?`
    : kind === 'buckling' ? `Is there enough margin against buckling for ${target}? What would raise the first load factor if there isn't?`
    : kind.startsWith('thermal_steady') || kind.startsWith('thermal_transient') ? `Are these temperatures a problem for ${target}? Where does heat build up, and what would improve it?`
    : isCompressible(kind) ? `What does this result tell me about ${target}? Is the flow choked, are there shocks, and how could the thrust or mass flow improve?`
    : kind.startsWith('flow') || kind.startsWith('cht') ? `What does this result tell me about ${target}? Where are the losses or hot spots, and what should I change?`
    : `Is ${target} strong and stiff enough under these loads? Where would it fail first, and what should I change?`;
  return `About the simulation study “${study.name}” (study id ${study.id}, solved run ${useSimulation.getState().result?.run.id ?? ''}): `
    + `${fieldLabel(useSimulation.getState().field, kind) ?? 'results'} shown${numbers.length ? `; ${numbers.join(', ')}` : ''}. ${question}`;
}

export function watchRun(run: Run, studyId: string) {
  stopWatching();
  const generation = watching;
  let updating = false;
  const refresh = async () => {
    if (updating) return;
    updating = true;
    try {
      const current = await simulationApi<Run>(`simulation/runs/${run.id}`);
      if (generation !== watching) return;
      useSimulation.setState((state) => ({ runs: { ...state.runs, [studyId]: current },
        startedAt: !terminal(current) && !state.startedAt[current.id] ? { ...state.startedAt, [current.id]: Date.now() } : state.startedAt }));
      if (terminal(current)) {
        subscription?.close(); subscription = null;
        if (current.status === 'succeeded') await openResults(current, studyId);
      }
    } catch (error) { if (generation === watching) report(error); }
    finally { updating = false; }
  };
  useSimulation.setState((state) => ({ runs: { ...state.runs, [studyId]: run },
    startedAt: !terminal(run) && !state.startedAt[run.id] ? { ...state.startedAt, [run.id]: Date.now() } : state.startedAt }));
  if (!terminal(run)) {
    subscription = new EventSource(`/v1/simulation/runs/${run.id}/events`);
    for (const event of ['status', 'stage', 'cancellation']) subscription.addEventListener(event, () => { void refresh(); });
    // A queued run's heartbeat: why it waits now, as other runs start.
    subscription.addEventListener('waiting', (event) => {
      let waiting: Run['waiting'];
      try { waiting = JSON.parse((event as MessageEvent).data) as Run['waiting']; } catch { return; }
      if (generation !== watching) return;
      useSimulation.setState((state) => {
        const shown = state.runs[studyId];
        return shown?.id === run.id && shown.status === 'queued' ? { runs: { ...state.runs, [studyId]: { ...shown, waiting } } } : {};
      });
    });
    subscription.onopen = () => { void refresh(); };
    // EventSource reconnects with Last-Event-ID; status remains durable if this tab closes.
  }
  void refresh();
}

export async function loadLinkedStudies(documentId: string) {
  const records = await simulationApi<StudyRecord[]>(`studies?design_id=${encodeURIComponent(documentId)}`);
  if (get().doc.saved?.id !== documentId) return;
  const main = records.filter((r) => r.branch === 'main');
  const durable = main.map(fromRecord);
  useSimulation.setState((state) => ({ outcomes: { ...state.outcomes, ...Object.fromEntries(main.map((r) => {
    const id = (r.study_id ?? r.id)!;
    return [id, mergeOutcome(state.outcomes[id], { last_solve: r.last_solve, last_mesh: r.last_mesh, latest_attempt: r.latest_attempt })];
  })) } }));
  set((state) => {
    // Preserve local unsaved drafts and legacy studies for explicit repair.
    const studies = [...durable.map((s) => state.studies.find((old) => old.id === s.id && old.revision === s.revision) ?? s), ...state.studies.filter((s) => !s.revision)];
    return { studies, activeStudy: studies.some((s) => s.id === state.activeStudy) ? state.activeStudy : studies[0]?.id ?? null };
  });
}

/** A run a link names (?run=, state/deepLink.ts): shown instead of the latest when its study opens. */
let requestedRun: string | null = null;
export function requestRun(id: string | null) { requestedRun = id; }

export async function resumeStudy(study: Study) {
  const runs = await simulationApi<Run[]>(`studies/${study.id}/runs?branch=${encodeURIComponent(study.branch ?? 'main')}`);
  const requested = requestedRun ? runs.find((run) => run.id === requestedRun) : undefined;
  if (requested) requestedRun = null;
  const latest = requested ?? runs[0];
  if (get().activeStudy !== study.id || !latest) return;
  // The latest successful solve opens by default: a newer mesh-only, failed, cancelled or running attempt never hides it.
  const solvedId = requested ? undefined : runs.find((run) => run.operation === 'solve' && run.status === 'succeeded')?.id
    ?? useSimulation.getState().outcomes[study.id]?.last_solve?.id;
  if (!solvedId || solvedId === latest.id) { watchRun(latest, study.id); return; }
  const solved = runs.find((run) => run.id === solvedId) ?? await simulationApi<Run>(`simulation/runs/${solvedId}`);
  if (get().activeStudy !== study.id) return;
  if (latest.status === 'succeeded') { watchRun(solved, study.id); return; }
  // Watch the newer attempt (its progress or error shows) and show the solve's results meanwhile.
  watchRun(latest, study.id);
  await openResults(solved, study.id, latest.id);
}

/**
 * Meshes or solves the active study. An unchanged study keeps its revision, and inputs already solved come back
 * with their result instead of solving again (an earlier failure too). `retry`: the person asked to run it again
 * anyway (Try again, Re-run on current engine).
 */
export async function runStudy(operation: 'mesh' | 'solve', retry = false) {
  if (useSimulation.getState().busy) return;
  const active = get().studies.find((s) => s.id === get().activeStudy);
  if (!active) return;
  const missing = unpickedBoundary(active);
  if (missing) { report(new Error(`${missing.type.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())} has no faces yet: click faces in the viewport to add them, or remove it.`)); return; }
  stopPicking();
  set({ studyOverview: false });
  useSimulation.setState({ busy: true, error: null, result: null });
  try {
    const saved = active.revision && !studyDirty(active) ? active : await saveStudy(active);
    const run = await simulationApi<Run>(`studies/${saved.id}/runs`, 'POST', { study_revision: saved.revision, branch: saved.branch ?? 'main', operation,
      resource_class: useSimulation.getState().resourceClass, ...(retry ? { retry: true } : {}) }, uuid());
    const what = operation === 'mesh' ? 'meshed' : 'solved';
    if (run.reused_from) toast('info', `Already ${what}`, `Nothing changed since this study was ${what}: showing that result.`);
    else if (run.status === 'failed') toast('info', 'This failed before', `Nothing changed since this study failed, so it wasn’t ${what} again. Change the study, or choose Try again.`);
    if (get().activeStudy === saved.id) watchRun(run, saved.id);
  } catch (error) { report(error); }
  finally { useSimulation.setState({ busy: false }); }
}

export async function cancelRun(run: Run) {
  try { await simulationApi(`simulation/runs/${run.id}/cancel`, 'POST'); }
  catch (error) { report(error); }
}

export function selectResult(field: string) {
  const state = useSimulation.getState();
  if (!state.result) { toast('info', 'No results yet', 'Run a study and wait for it to complete.'); return; }
  const manifest = state.result.manifest;
  if (field === 'displacement' && manifest.modes?.length) {
    field = manifest.modes.find((mode) => mode.field === state.field)?.field ?? manifest.modes[0].field;
  }
  if (field === 'safety') {
    if (!manifest.arrays.von_mises) { toast('info', 'No stress result', 'Safety factor needs a structural (static or thermal stress) result.'); return; }
    if (!yieldOf(manifest)) { toast('info', 'Yield strength unknown', 'The material this study solved with has no yield strength. Assign one that does (most metals and plastics in the library have it).'); return; }
    useSimulation.setState({ field });
    return;
  }
  if (field !== 'mesh' && !visibleFields(manifest, state.region)[field]) { toast('info', 'Field unavailable', 'Choose a result provided by this study.'); return; }
  useSimulation.setState({ field });
}

/** Opens STEVE with a question about the showing result, ready to send (or edit). */
export function askSteve(study: Study) {
  const manifest = useSimulation.getState().result?.manifest;
  if (!manifest) return;
  useSteve.setState({ prefill: resultQuestion(study, manifest) });
  set({ dockOpen: true, dockTab: 'assistant' });
}

/** What a result animates: transient steps, a mode shape, or the deformation growing from nothing. */
export function animationKind(manifest: ResultManifest | undefined, field: string): 'frames' | 'mode' | 'deform' | null {
  if (!manifest) return null;
  if ((manifest.frames?.length ?? 0) > 1) return 'frames';
  if (manifest.modes?.some((mode) => mode.field === field)) return 'mode';
  if (manifest.arrays.displacement && !manifest.modal) return 'deform';
  return null;
}

/** The displacement multiplier at `phase` (cycles): mode shapes swing ±1; deformation grows 0 → 1 (and back, mirrored). */
export function amplitude(kind: 'mode' | 'deform', playback: Playback, phase: number | null): number {
  if (phase === null) return 1;
  if (kind === 'mode') return Math.sin(2 * Math.PI * phase);
  const p = Math.min(1, Math.max(0, phase));
  return playback === 'mirror' ? (p < 0.5 ? p * 2 : 2 - p * 2) : p;
}

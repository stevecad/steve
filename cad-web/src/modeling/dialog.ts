import { create } from 'zustand';
import { get as app, rolledDoc, set as setApp, toast, type Pick } from '@/state/store';
import { advanceRollback, insertionPoint, rolledCode } from './rollback';
import { holdPreview, openFile, previewCode, releasePreview, restoreDisplayed, setCode, showPreview } from '@/state/actions';
import { ensureModel, insertFeature, modelingReport, nextId, parseModel, pyString, replaceFeature, type ModelDoc, type ModelFeature } from '@/lib/modeling';
import { viewer } from '@/viewport/viewer';
import { DESIGN_TABLE_PATTERN, SPECS, type Context, type FeatureSpec, type Field, type Values } from './specs';
import { bodiesOfPick, bodyList } from './bodies';
import { builtFrom, filesOf, isTable, MAIN, placeables, withMainStatement } from '@/state/design';

/**
 * The open feature dialog. Every change rebuilds a candidate (the code with this feature
 * written in) as a preview; OK keeps that code, Cancel restores the previous geometry. An extrude's
 * candidate is built only to check it: its transparent preview stays over the geometry from before it.
 */
export interface DialogState {
  open: boolean;
  kind: string;
  id: string;
  name: string;
  editing: boolean;
  values: Values;
  /** Values worked out for fields left on Auto (an extrude pushed into the solid is a cut), written into the code. */
  auto: Values;
  /** The field that viewport picks go into. */
  target: string | null;
  status: 'idle' | 'previewing' | 'ok' | 'error';
  message: string | null;
  returnBuildId: string | null;
  /** The build Auto measures material on: the geometry from before this feature. Null: there is none (nothing to cut). */
  measureBuildId: string | null;
  /** That build is still being made (an edited feature's): Auto isn't decided, and the preview waits. */
  measuring: boolean;
  /** Table pattern in a design's main.py (DESIGN_TABLE_PATTERN): a design.pattern statement, not a feature. */
  design?: boolean;
}

export const useFeatureDialog = create<DialogState>(() => ({
  open: false, kind: '', id: '', name: '', editing: false, values: {}, auto: {}, target: null, status: 'idle', message: null, returnBuildId: null,
  measureBuildId: null, measuring: false, design: false,
}));

/** The fields the open dialog shows. */
export const fieldsOf = (state: { kind: string; design?: boolean }): Field[] => (state.design ? DESIGN_TABLE_PATTERN : SPECS[state.kind]?.fields ?? []);

const dialog = () => useFeatureDialog.getState();

/** Reference names for picks, from the build's topology (`refs` exported by the runtime). */
export function refFor(pick: Pick): string | null {
  const model = viewer.model;
  if (!model || pick.kind === 'component') return null;
  const mesh = model.topologyFor(pick.mesh) as unknown as { faces?: { ref?: string }[]; edges?: { ref?: string }[]; vertex_refs?: string[] } | undefined;
  if (pick.kind === 'face') return mesh?.faces?.[pick.index]?.ref ?? null;
  if (pick.kind === 'edge') return mesh?.edges?.[pick.index]?.ref ?? null;
  return mesh?.vertex_refs?.[pick.index] ?? null;
}

function context(doc: ModelDoc | null): Context {
  const selection = app().selection;
  const faces = selection.filter((p) => p.kind === 'face').map(refFor).filter(Boolean) as string[];
  const edges = selection.filter((p) => p.kind === 'edge').map(refFor).filter(Boolean) as string[];
  const features = doc?.features ?? [];
  const active = app().activeFeature;
  const activeFeature = features.find((f) => f.id === active);
  const lastSketch = activeFeature?.kind === 'sketch' ? activeFeature.id : [...features].reverse().find((f) => f.kind === 'sketch')?.id ?? null;
  const solid = new Set(['extrude', 'revolve', 'sweep', 'loft', 'hole', 'box', 'cylinder', 'sphere', 'cone', 'torus', 'text']);
  const lastSolid = activeFeature && solid.has(activeFeature.kind) ? activeFeature.id : [...features].reverse().find((f) => solid.has(f.kind))?.id ?? null;
  return { doc, faces, edges, lastSketch, lastSolid };
}

/** Opens a new feature of `kind`, pre-filled from the selection. */
export async function openFeature(kind: string) {
  const spec = SPECS[kind];
  const state = app();
  if (!spec || !state.doc.open || state.busy) return;
  const doc = await parseModel(state.doc.code);
  const values: Values = {};
  for (const field of spec.fields) values[field.key] = field.initial ?? '';
  Object.assign(values, Object.fromEntries(Object.entries(spec.preselect?.(context(doc)) ?? {}).filter(([, v]) => v)));
  const id = nextId(doc.canonical ? doc : null, spec.prefix);
  const firstPick = spec.fields.find((f) => ['edges', 'edge', 'faces', 'face', 'features', 'sketch', 'sketches', 'bodies'].includes(f.type) && !values[f.key]);
  // Faces or edges chosen on plain CadQuery have no names to fill the dialog with.
  const unnamed = state.selection.some((p) => (p.kind === 'face' || p.kind === 'edge') && !refFor(p));
  useFeatureDialog.setState({ open: true, kind, id, name: '', editing: false, values, auto: {}, target: firstPick?.key ?? null, status: 'idle', message: null,
    returnBuildId: state.displayed?.id ?? null, measureBuildId: state.displayed?.id ?? null, measuring: false, design: false });
  setApp({ selection: [], tool: 'select' });
  if (unnamed && plainPart()) offerConversion();
  schedulePreview();
}

/**
 * Pattern → Table pattern: in a part or a design's component file, the feature (offsets typed in the panel); in a
 * design's main.py, a component placed at each row of one of the design's tables (design.pattern with table()).
 */
export async function openTablePattern() {
  const state = app();
  if (state.doc.kind !== 'design' || state.doc.activeFile.startsWith('components/')) { await openFeature('point_pattern'); return; }
  if (!state.doc.open || state.busy) return;
  if (state.doc.activeFile !== MAIN) openFile(MAIN);
  const components = placeables(app().doc.code);
  const tables = Object.keys(filesOf(app().doc)).filter(isTable).sort();
  const values: Values = Object.fromEntries(DESIGN_TABLE_PATTERN.map((field) => [field.key, field.initial ?? '']));
  Object.assign(values, { component: components[0]?.source ?? '', table: tables[0] ?? '' });
  useFeatureDialog.setState({ open: true, kind: 'point_pattern', id: MAIN, name: '', editing: false, values, auto: {}, target: null, status: 'idle', message: null,
    returnBuildId: state.displayed?.id ?? null, measureBuildId: null, measuring: false, design: true });
  setApp({ selection: [], tool: 'select' });
  schedulePreview();
}

/** A part still written as plain CadQuery: its geometry has no face or edge names until it is in the modeling format. */
const plainPart = () => app().doc.kind === 'part' && app().modeling?.canonical === false;

let offered: number | null = null;

/** Asks before wrapping plain CadQuery as one imported feature, saying exactly what changes. */
function offerConversion() {
  if (offered !== null && app().toasts.some((t) => t.id === offered)) return;
  offered = toast('info', 'Convert this part to pick faces and edges?',
    'It’s written as plain CadQuery, which doesn’t name its faces and edges. Convert keeps your code as it is and adds a few lines after it, '
    + 'making its result one “Imported code” feature that decals, fillets, sketches and other features can refer to. '
    + 'The shape doesn’t change, and nothing is saved until you save; earlier revisions stay in History. '
    + 'Faces are named in order, so editing that code later can move a feature onto a different face.',
    { sticky: true, action: { label: 'Convert', run: () => { void convertToModel(); } } });
}

/** Wraps plain CadQuery in the modeling format and regenerates, so the next pick has names. An open dialog stays open. */
export async function convertToModel() {
  const code = app().doc.code;
  const doc = await parseModel(code);
  if (doc.canonical || app().doc.code !== code) return;
  setCode(ensureModel(code, doc));
  const { updateModel } = await import('@/state/actions');
  while (app().busy) await new Promise((resolve) => setTimeout(resolve, 150));
  await updateModel();
  // Cancelling the dialog now goes back to the converted geometry, not the unnamed one.
  if (dialog().open) useFeatureDialog.setState({ returnBuildId: app().displayed?.id ?? null, ...(dialog().editing ? {} : { measureBuildId: app().displayed?.id ?? null }) });
  if (app().phase === 'succeeded') toast('success', 'Converted to the modeling format', 'Pick faces and edges as usual.');
}

/** Opens an existing feature for editing (from the timeline or browser). */
export async function editFeature(featureId: string) {
  const state = app();
  const doc = await parseModel(state.doc.code);
  const feature = doc.features.find((f) => f.id === featureId);
  if (!feature) return;
  const spec = SPECS[feature.kind];
  if (!spec) { toast('info', feature.name, 'Edit this feature in Source.'); return; }
  if (!feature.editable) { toast('info', `${feature.name} is written as custom code`, 'Edit it in Source, or ask STEVE to rewrite it as a feature.'); return; }
  const values = valuesFrom(spec, feature);
  useFeatureDialog.setState({ open: true, kind: feature.kind, id: featureId, name: feature.name, editing: true, values, auto: {}, target: null, status: 'idle', message: null,
    returnBuildId: state.displayed?.id ?? null, measureBuildId: null, measuring: false, design: false });
  // The part without this extrude goes under its transparent preview (and is what Auto measures on).
  if (feature.kind === 'extrude') void measureBefore();
  else schedulePreview();
}

const MAKES_NO_MATERIAL = ['sketch', 'plane', 'axis', 'point'];
let measurement = 0;

/**
 * An edited extrude: the displayed model already holds it and every later feature, so its own solid would show opaque
 * under the transparent preview and read as material to cut into. Show the part as of the feature before it (as the
 * history marker does), to preview over and measure on.
 */
async function measureBefore() {
  const state = dialog();
  if (!state.open || !state.editing || state.measuring || state.measureBuildId) return;
  const run = ++measurement;
  const code = app().doc.code;
  const doc = await parseModel(code);
  const index = doc.features.findIndex((f) => f.id === state.id);
  if (index < 1) { schedulePreview(); return; }
  const current = () => run === measurement && dialog().open && dialog().editing && dialog().id === state.id;
  // Before the first solid there is no body to cut: Auto makes a new one (the runtime's default when `op` is left out).
  const material = doc.features.slice(0, index).some((f) => !MAKES_NO_MATERIAL.includes(f.kind) && !f.kwargs?.suppressed);
  clearTimeout(timer);
  useFeatureDialog.setState({ measuring: true, status: 'previewing', message: null });
  let build: Awaited<ReturnType<typeof previewCode>> = null;
  try { build = await previewCode(rolledCode(code, doc, doc.features[index - 1].id)); } catch { /* Measured as no material. */ }
  if (!current()) return;
  useFeatureDialog.setState({ measuring: false, measureBuildId: material && build?.status === 'succeeded' && app().displayed?.id === build.id ? build.id : null });
  // The edited feature's preview, once Auto has been measured (the measurement shows first).
  schedulePreview();
}

function valuesFrom(spec: FeatureSpec, feature: ModelFeature): Values {
  const values: Values = {};
  const positional = spec.fields.filter((f) => f.positional);
  positional.forEach((field, index) => { const arg = feature.args?.[index]; if (arg) values[field.key] = arg.source; });
  const kwargs = Object.fromEntries(Object.entries(feature.kwargs ?? {}).map(([k, v]) => [k, v.source]));
  for (const field of spec.fields) {
    if (field.key in kwargs) values[field.key] = kwargs[field.key];
    else if (!(field.key in values)) values[field.key] = field.omit ?? field.initial ?? '';
  }
  Object.assign(values, spec.read?.(kwargs) ?? {});
  return values;
}

/** The feature's call, as it will be written into the code. */
export function emit(state: DialogState = dialog()): string {
  if (state.design) return emitDesignPattern(state.values);
  const spec = SPECS[state.kind];
  const parts = [pyString(state.id)];
  const visible = spec.fields.filter((f) => !f.virtual && (!f.when || f.when(state.values)));
  for (const field of visible.filter((f) => f.positional)) parts.push(state.values[field.key] || (field.type === 'faces' ? '[]' : 'None'));
  const derived = spec.emit?.(state.values) ?? {};
  for (const field of visible.filter((f) => !f.positional)) {
    if (field.key in derived) continue;
    const value = state.values[field.key] || state.auto[field.key];
    if (!value || (field.omit !== undefined && value === field.omit)) continue;
    parts.push(`${field.key}=${value}`);
  }
  for (const [key, value] of Object.entries(derived)) if (value) parts.push(`${key}=${value}`);
  if (state.name && state.name !== defaultName(state.id)) parts.push(`name=${pyString(state.name)}`);
  return `${app().modeling?.model?.variable ?? 'model'}.${state.kind}(${parts.join(', ')})`;  // A design component's own variable
}

const defaultName = (id: string) => id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const textOf = (source: string | undefined) => { try { const text = JSON.parse(source || '""'); return typeof text === 'string' ? text : ''; } catch { return ''; } };

/** Table pattern's statement in main.py: `design.pattern(pin, points=table("holes.csv", columns=("x", "y")), polar=True)`. */
function emitDesignPattern(values: Values): string {
  const variable = /^(\w+)\s*=\s*Design\(/m.exec(app().doc.code)?.[1] ?? 'design';
  const columns = textOf(values.columns).split(',').map((name) => name.trim()).filter(Boolean);
  const picked = columns.length ? `, columns=(${columns.map(pyString).join(', ')}${columns.length === 1 ? ',' : ''})` : '';
  const parts = [values.component || 'None', `points=table(${pyString(values.table ?? '')}${picked})`];
  if (values.polar === 'True') parts.push('polar=True');
  if (values.at && values.at.replace(/\s/g, '') !== '(0,0,0)') parts.push(`at=${values.at}`);
  if (textOf(values.name)) parts.push(`name=${values.name}`);
  return `${variable}.pattern(${parts.join(', ')})`;
}

export function missing(state: DialogState = dialog()): string | null {
  if (state.design && !state.values.table) return 'Choose a table, or import one (.csv or .xlsx).';
  if (state.design && !state.values.component) return 'Add a component to the design first (Components in the browser).';
  for (const field of fieldsOf(state)) {
    if (field.when && !field.when(state.values)) continue;
    const value = state.values[field.key];
    if (field.required && (!value || value === '[]' || value === '""')) return `${field.label} is needed.`;
  }
  return null;
}

/** The whole document with this feature written in (new or replacing the edited one). */
export async function candidate(state: DialogState = dialog()): Promise<string> {
  if (state.design) {
    if (app().doc.activeFile !== MAIN) openFile(MAIN);
    return withMainStatement(app().doc.code, emit(state));
  }
  let code = app().doc.code;
  let doc = await parseModel(code);
  if (!doc.canonical) { code = ensureModel(code, doc); doc = await parseModel(code); }
  const text = emit(state);
  const existing = state.editing ? doc.features.find((f) => f.id === state.id) : undefined;
  return existing ? replaceFeature(code, existing, text) : insertFeature(code, doc, text, insertionPoint());
}

let timer: ReturnType<typeof setTimeout> | undefined;

export function setValue(key: string, value: string) {
  useFeatureDialog.setState((state) => ({ values: { ...state.values, [key]: value } }));
  schedulePreview();
  // Switched to Auto while editing: measure on the geometry from before the feature first (if that wasn't measured).
  if (key === 'op' && !value && dialog().kind === 'extrude') void measureBefore();
}

/** Records what a field left on Auto stands for (e.g. an extrude's cut); a change rebuilds the preview. */
export function setAuto(key: string, value: string) {
  if ((dialog().auto[key] ?? '') === value) return;
  useFeatureDialog.setState((state) => ({ auto: { ...state.auto, [key]: value } }));
  schedulePreview();
}

export function schedulePreview(delay = 450) {
  clearTimeout(timer);
  const version = ++previewVersion;
  validated = null;
  if (dialog().open) useFeatureDialog.setState({ status: 'previewing', message: null });
  timer = setTimeout(() => { void runPreview(version); }, delay);
}

/** An extrude's last checked preview and the candidate it was built from: OK shows it as the result. */
let previewed: { code: string; build: NonNullable<Awaited<ReturnType<typeof previewCode>>> } | null = null;
let previewVersion = 0;
let validated: { key: string; code: string } | null = null;

/** Validation belongs to these exact inputs and document dependencies. */
function validationKey(state: DialogState): string {
  const { doc, rollback } = app();
  return JSON.stringify([doc.kind, doc.code, doc.files, doc.links, doc.activeFile, rollback?.after, rollback?.empty,
    state.kind, state.id, state.name, state.editing, state.design, state.values, state.auto]);
}

function currentPreview(version: number, key: string): boolean {
  if (!dialog().open || version !== previewVersion) return false;
  if (key !== validationKey(dialog())) { schedulePreview(0); return false; }
  return true;
}

async function runPreview(version: number) {
  const state = dialog();
  if (!state.open || state.measuring || version !== previewVersion) return;  // Measurement schedules it when done.
  const key = validationKey(state);
  const problem = missing(state);
  if (problem) { useFeatureDialog.setState({ status: 'idle', message: problem }); return; }
  useFeatureDialog.setState({ status: 'previewing', message: null });
  // An extrude or cut stays a transparent preview over the geometry from before it: its build is checked, not shown.
  const extrude = !state.design && state.kind === 'extrude';
  try {
    const code = await candidate(state);
    if (!currentPreview(version, key)) return;
    // At a history marker the candidate must include the feature being edited
    // or inserted, even when the marker is before the first solid.
    const rollback = app().doc.kind === 'part' ? app().rollback : null;
    let previewSource = code;
    if (rollback) {
      const outline = await parseModel(code);
      const markerIndex = outline.features.findIndex((feature) => feature.id === rollback.after);
      const featureIndex = outline.features.findIndex((feature) => feature.id === state.id);
      previewSource = rolledCode(code, outline, state.editing && markerIndex > featureIndex ? rollback.after : state.id);
      if (!currentPreview(version, key)) return;
    }
    const build = await previewCode(previewSource, { show: !extrude, applyRollback: !rollback });
    if (!build || !currentPreview(version, key)) return;
    if (extrude) previewed = { code, build };
    if (build.status === 'failed') { useFeatureDialog.setState({ status: 'error', message: firstLine(build.error) }); return; }
    const report = state.design ? undefined : modelingReport(build.metadata, app().doc.activeFile)?.features.find((f) => f.id === state.id);
    if (report?.status === 'error') useFeatureDialog.setState({ status: 'error', message: report.error ?? 'This feature failed.' });
    else { validated = { key, code }; useFeatureDialog.setState({ status: 'ok', message: null }); }
  } catch (error) {
    if (currentPreview(version, key)) useFeatureDialog.setState({ status: 'error', message: (error as Error).message });
  }
}

const firstLine = (text: string | null | undefined) => (text ?? 'The preview failed.').trim().split('\n').filter(Boolean).at(-1) ?? 'The preview failed.';

/** Writes the feature into the design. The preview build already matches the new code. */
export async function commitFeature() {
  const state = dialog();
  const checked = validated;
  if (!state.open || state.status !== 'ok' || !checked) return;
  const problem = missing(state);
  if (problem) { useFeatureDialog.setState({ message: problem, status: 'error' }); return; }
  const code = await candidate(state);
  if (!dialog().open || validated !== checked || dialog().status !== 'ok') return;
  if (code !== checked.code || validationKey(dialog()) !== checked.key) { schedulePreview(0); return; }
  clearTimeout(timer);
  ++previewVersion;
  validated = null;
  // A late preview would otherwise take the display from the update below; one of exactly this code is that update's build.
  const held = holdPreview();
  const kept = previewed;
  previewed = null;
  useFeatureDialog.setState({ open: false, target: null });
  setCode(code);
  if (!state.design) {
    setApp({ activeFeature: state.id });
    if (!state.editing) advanceRollback(state.id);
  }
  // Refresh the marker's source before comparing against the displayed preview.
  // Otherwise rolledDoc falls back to the full document after an edit and can
  // incorrectly keep geometry from features beyond the marker.
  if (app().rollback && app().doc.kind === 'part') {
    const { buildCode } = await import('@/modeling/rollback');
    await buildCode(code);
  }
  // An extrude's preview was checked but not shown: it's the result if built from exactly this code.
  if (state.status === 'ok' && kept?.code === code && kept.build.status === 'succeeded') await showPreview(kept.build);
  // The last preview is the result only if it was built from exactly this code (not an earlier value, mid-drag).
  if (state.status === 'ok' && builtFrom(app().displayed, rolledDoc(app()))) {
    void releasePreview(held, null);
    setApp({ error: '', phase: 'succeeded', phaseLabel: 'Model ready' });
    return;
  }
  await releasePreview(held, code);
  const { updateModel } = await import('@/state/actions');
  while (app().busy) await new Promise((resolve) => setTimeout(resolve, 150));  // A preview still in flight may be the right one.
  if (app().doc.code === code && !builtFrom(app().displayed, rolledDoc(app()))) void updateModel();
}

export function cancelFeature() {
  const state = dialog();
  clearTimeout(timer);
  ++previewVersion;
  validated = null;
  previewed = null;
  useFeatureDialog.setState({ open: false, target: null });
  void restoreDisplayed(state.returnBuildId).then(() => {
    if (!dialog().open && app().rollback?.empty && viewer.model) { viewer.model.root.visible = false; viewer.invalidate(); }
  });
}

/** Viewport picks while a dialog waits for geometry: add the pick's reference to the target field. */
export function pickIntoDialog(pick: Pick): boolean {
  const state = dialog();
  if (!state.open || !state.target) return false;
  const spec = SPECS[state.kind];
  const field = spec.fields.find((f) => f.key === state.target);
  if (!field) return false;
  if (field.type === 'points') { toast('info', 'Pick a sketch point', 'Hole positions take a sketch’s points, circle centres or line ends; type a position to place one anywhere.'); return true; }
  if (field.type === 'bodies') {
    const [body] = bodiesOfPick(pick, viewer.model, state.id);
    if (!body) { toast('info', 'Regenerate to pick bodies', 'This geometry was generated before bodies were reported.'); return true; }
    const current = bodyList(state.values[field.key]);
    const next = current.includes(body) ? current.filter((b) => b !== body) : [...current, body];
    setValue(field.key, next.length ? `[${next.map((b) => JSON.stringify(b)).join(', ')}]` : '');
    return true;
  }
  const picked = refFor(pick);
  if (!picked) {
    if (plainPart()) offerConversion();
    else toast('info', 'Regenerate to pick references', 'This geometry was generated before face and edge names existed.');
    return true;
  }
  const ref = spec.pick ? spec.pick(picked, field.key) : picked;
  if (!ref) { toast('info', `That isn’t usable for ${field.label.toLowerCase()}`, (typeof spec.pickHint === 'function' ? spec.pickHint(field.key) : spec.pickHint) ?? ''); return true; }
  if (field.type === 'edges' || field.type === 'faces' || field.type === 'features') {
    const current = parseList(state.values[field.key]);
    const next = current.includes(ref) ? current.filter((r) => r !== ref) : [...current, ref];
    setValue(field.key, next.length ? `[${next.map((r) => JSON.stringify(r)).join(', ')}]` : '');
  } else setValue(field.key, JSON.stringify(ref));
  return true;
}

export function parseList(source: string | undefined): string[] {
  if (!source) return [];
  // A single reference (`on="extrude_1.end"`) is a list of one: picking more makes it a list.
  try { const value = JSON.parse(source.replace(/'/g, '"')); return Array.isArray(value) ? value.map(String) : typeof value === 'string' && value ? [value] : []; } catch { return []; }
}

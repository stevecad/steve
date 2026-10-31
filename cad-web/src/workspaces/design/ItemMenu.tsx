import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { create } from 'zustand';
import * as THREE from 'three';
import { ArchiveRestore, Code2, Copy, Download, ExternalLink, Eye, EyeOff, FileCode, Focus, Hash, History, MousePointer2, Palette, Pause, PenLine, Pencil, Play, Plus, RefreshCw, ScanSearch, SlidersHorizontal, Trash2, Variable } from 'lucide-react';
import { ContextItem, ContextLabel, ContextSeparator, ContextSub } from '@/ui';
import { ExtrudeIcon, MaterialIcon, MoveIcon, RevolveIcon, ShadedEdgesIcon, SketchIcon, XrayIcon } from '@/icons/cad';
import { get, isNodeSeeThrough, isNodeVisible, set, toast, type AppState, type Pick } from '@/state/store';
import { exportStep, hideNodes, isolate, openFile, openPart, removeComponent, setCode, setName, showAll, toggleHidden, toggleSeeThrough, updateLink, updateModel } from '@/state/actions';
import { componentTarget, exportComponentStep, linkTarget, nodeTarget, type StepTarget } from '@/state/componentStep';
import { removeAnimation, removeExplode, removeJoint, renameJoint, showCall, showJointCode } from '@/motion/code';
import { openJointTool } from '@/motion/jointTool';
import { rollTo } from '@/modeling/rollback';
import { pauseClip, play, playClip, selectClip, stop, useMotion } from '@/motion/state';
import { openMotionTool } from '@/motion/motionTool';
import { openExplodeTool } from '@/motion/explodeTool';
import { pyString, type ModelDoc } from '@/lib/modeling';
import type { Feature } from '@/lib/features';
import { isReferenced, parsePlanes, removePlane, type ConstructionPlane } from '@/lib/construction';
import { viewer } from '@/viewport/viewer';
import { editSketch, namedTarget, startSketch } from '@/sketch/actions';
import { planeBasis } from '@/sketch/session';
import { openFeature, setValue, useFeatureDialog } from '@/modeling/dialog';
import { SPECS } from '@/modeling/specs';
import { openRow, type FeatureRow } from '@/modeling/features';
import { deleteFeature, dependents, toggleSuppressed } from '@/modeling/FeatureInspector';
import { bodiesOfPick, bodyIds, bodyLabel, bodyPicks, designOf, editedComponent, modelingOf } from '@/modeling/bodies';
import { openAppearance, openMaterials } from '@/materials/actions';
import { exportMesh, type MeshFormat } from '@/state/meshExport';
import { deselectBodies, setBodiesShown, setPlanesShown, setSketchesShown, sketchShown, toggleBody, togglePlane, toggleSketch } from '@/state/visibility';
import { behindLinks, refreshLinks, updateLinks } from '@/state/linkWatch';
import { linkTrashed } from '@/lib/trash';
import { restoreFromTrash } from '@/state/trash';
import { filesOf, MAIN, PARAMS, withoutComponent } from '@/state/design';
import { availability, command as commandOf, runCommand } from '@/commands';
import { ADD_PARAMETER, usage } from '@/modeling/ParametersTable';
import { checkExpression, checkName, checkParameterName, deleteParameter, renameBody, renameFeature, renameParameter, setParameterValue } from '@/modeling/rename';
import { revealSource } from './FeatureTree';
import { PARAMETERS_ID } from './featureEdit';
import { planeTarget } from './modelPlanes';
import styles from './ItemMenu.module.css';
import { renamePlane } from '@/modeling/rename';
import { editPlane } from './planeTool';

/**
 * One menu per kind of thing in the model browser, shared by the tree and the timeline so the two
 * never drift: right click, the Menu key or Shift+F10. Only what applies to the item is listed;
 * what doesn't apply to this design yet is disabled with the reason.
 */
export type ItemTarget =
  | { kind: 'feature'; row: FeatureRow }
  | { kind: 'body'; id: string }
  | { kind: 'node'; id: string }
  /** A design's component (one file) or link, with the viewport nodes of its placed instances. */
  | { kind: 'component'; id: string; path: string; name: string; nodes: string[] }
  | { kind: 'link'; alias: string; name: string; nodes: string[] }
  | { kind: 'parameters' }
  | { kind: 'parameter'; name: string }
  | { kind: 'joint'; name: string }
  | { kind: 'origin' }
  | { kind: 'origin-plane'; plane: 'XY' | 'XZ' | 'YZ' }
  | { kind: 'document' }
  | { kind: 'legacy-feature'; feature: Feature }
  | { kind: 'legacy-plane'; plane: ConstructionPlane }
  /** A body or sketch of a design component whose file isn't open (the tree lists them from the build's summary). */
  | { kind: 'component-body'; component: ComponentRef; id: string }
  | { kind: 'component-sketch'; component: ComponentRef; id: string }
  /** A group heading (Bodies, Sketches, …); in a design, the component it belongs to. */
  | { kind: 'group'; group: GroupKind; component?: ComponentRef }
  /** A design's shared files: params.py and main.py (Placement). */
  | { kind: 'design-file'; file: 'params' | 'main' }
  | { kind: 'coupling'; name: string }
  | { kind: 'animation'; name: string }
  | { kind: 'explode'; name: string };

/** A design component as its rows know it: its id, file, display name, placed instances' viewport nodes, and whether its file is open. */
export interface ComponentRef { id: string; path: string; name: string; nodes: string[]; open: boolean }
export type GroupKind = 'bodies' | 'surfaces' | 'sketches' | 'construction' | 'components' | 'links' | 'joints' | 'explodes' | 'instances';

export type Place = 'tree' | 'timeline';

/* ───────── Renaming ───────── */

/** What is being edited in place (`feature:<id>`, `body:<id>`, `parameter:<name>`, `value:<name>`, `document`) and where. */
export const useRenaming = create<{ key: string | null; place: Place }>(() => ({ key: null, place: 'tree' }));

export function renameKey(target: ItemTarget): string | null {
  if (target.kind === 'legacy-plane') return `construction:${target.plane.name}`;
  if (target.kind === 'feature') return target.row.id ? `feature:${target.row.id}` : null;
  if (target.kind === 'body') return `body:${target.id}`;
  if (target.kind === 'parameter') return `parameter:${target.name}`;
  if (target.kind === 'joint') return `joint:${target.name}`;
  if (target.kind === 'document') return 'document';
  return null;
}

export const startRename = (target: ItemTarget, place: Place = 'tree') => { const key = renameKey(target); if (key) useRenaming.setState({ key, place }); };
export const stopRename = () => useRenaming.setState({ key: null });
/** From a menu: once it has closed, so its focus handling doesn't pull focus out of the field. */
const renameLater = (target: ItemTarget, place: Place) => { setTimeout(() => startRename(target, place), 0); };
/** The key being edited at `place`, if it is this one. */
export const useEditing = (key: string | null, place: Place = 'tree') => useRenaming((state) => (key && state.key === key && state.place === place ? key : null));

interface EditSpec { initial: string; label: string; mono?: boolean; validate: (text: string) => string | null; commit: (text: string) => Promise<string | null> }

function editSpec(key: string): EditSpec | null {
  const state = get();
  const doc = state.modeling;
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  if (kind === 'construction') return { initial: id, label: `Name of plane ${id}`, mono: true,
    validate: (text) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? null : 'Use a Python identifier: letters, digits and underscores.',
    commit: (text) => renamePlane(id, text) };
  if (kind === 'feature') {
    const feature = doc?.features.find((f) => f.id === id);
    return feature ? { initial: feature.name, label: `Name of ${feature.name}`, validate: checkName, commit: (text) => renameFeature(id, text) } : null;
  }
  if (kind === 'body') {
    const name = bodyLabel(id, doc, modelingOf(state.displayed));
    return { initial: name, label: `Name of ${name}`, validate: checkName, commit: (text) => renameBody(id, text) };
  }
  if (kind === 'parameter') return { initial: id, label: `Name of parameter ${id}`, mono: true, validate: (text) => checkParameterName(text, get().modeling, id), commit: (text) => renameParameter(id, text) };
  if (kind === 'value') {
    const parameter = doc?.parameters.find((p) => p.name === id);
    return parameter ? { initial: parameter.expression, label: `${id} value`, mono: true, validate: (text) => checkExpression(text, id, get().modeling), commit: (text) => setParameterValue(id, text) } : null;
  }
  if (kind === 'joint') {
    const check = (text: string) => (!/^[a-z][a-z0-9_]*$/.test(text) ? 'Joint names are lowercase letters, digits and underscores, starting with a letter.'
      : useMotion.getState().kinematics?.joints.some((j) => j.name === text) ? `There is already a joint named ${text}.` : null);
    return { initial: id, label: `Name of joint ${id}`, mono: true, validate: check,
      commit: async (text) => { const done = renameJoint(id, text); if (done !== true) return done; await updateModel(); return null; } };
  }
  if (kind === 'document') return { initial: state.doc.name, label: 'Design name', validate: checkName, commit: async (text) => { setName(text); return null; } };
  return null;
}

/** Edits a name (or a parameter's value) in place: Enter keeps it, Escape cancels, clicking away keeps a valid one. */
export function RenameField({ editKey, place = 'tree' }: { editKey: string; place?: Place }) {
  const [spec] = useState(() => editSpec(editKey));
  const [text, setText] = useState(spec?.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const state = useRef({ closed: false, pending: false });
  useEffect(() => { const timer = setTimeout(() => { if (!state.current.closed && document.activeElement !== input.current) input.current?.focus(); }, 40); return () => clearTimeout(timer); }, []);
  if (!spec) return null;
  const value = text.trim();
  const live = value !== spec.initial ? spec.validate(value) : null;
  const shown = error ?? (value ? live : null);
  const close = () => { if (!state.current.closed) { state.current.closed = true; stopRename(); } };
  const commit = async (blur: boolean) => {
    if (state.current.closed || state.current.pending) return;
    if (value === spec.initial || (blur && (!value || live))) { close(); return; }
    if (live) { setError(live); return; }
    state.current.pending = true;
    const failure = await spec.commit(value);
    state.current.pending = false;
    if (!failure) { close(); return; }
    if (blur && document.activeElement !== input.current) { toast('warning', 'Couldn’t rename', failure); close(); return; }
    setError(failure);
    input.current?.focus();
  };
  return (
    <span className={styles.field} data-place={place} data-mono={spec.mono || undefined}>
      <motion.input
        ref={input}
        autoFocus
        className={styles.input}
        value={text}
        spellCheck={false}
        autoComplete="off"
        aria-label={spec.label}
        aria-invalid={!!shown}
        data-invalid={shown ? true : undefined}
        data-rename={editKey}
        initial={{ opacity: 0.4, scaleX: 0.97 }}
        animate={{ opacity: 1, scaleX: 1 }}
        transition={{ duration: 0.14, ease: [0.2, 0, 0, 1] }}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => { setText(event.target.value); setError(null); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void commit(false); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }}
        onBlur={() => { void commit(true); }}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      {place === 'timeline' ? <Problem text={shown} /> : <FieldProblem text={shown} anchor={input} />}
    </span>
  );
}

function Problem({ text, style }: { text: string | null; style?: CSSProperties }) {
  return (
    <AnimatePresence>
      {text && (
        <motion.small key="error" role="alert" className={styles.error} style={style} initial={{ opacity: 0, y: -3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: 0.14 }}>
          {text}
        </motion.small>
      )}
    </AnimatePresence>
  );
}

/** Under the field, above the tree (whose collapsible groups clip their rows). */
function FieldProblem({ text, anchor }: { text: string | null; anchor: RefObject<HTMLInputElement | null> }) {
  const [box, setBox] = useState<DOMRect | null>(null);
  useLayoutEffect(() => { if (text && anchor.current) setBox(anchor.current.getBoundingClientRect()); }, [text, anchor]);
  return createPortal(<Problem text={box ? text : null} style={box ? { position: 'fixed', top: box.bottom + 4, left: box.left } : undefined} />, document.body);
}

/* ───────── Keyboard ───────── */

/** The Menu key or Shift+F10 opens the item's menu at the item; F2 renames. */
export function itemKeyDown(event: KeyboardEvent<HTMLElement>, target: ItemTarget, place: Place = 'tree') {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault();
    event.stopPropagation();
    const box = event.currentTarget.getBoundingClientRect();
    event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + Math.min(28, box.width / 2), clientY: box.bottom - 2 }));
  } else if (event.key === 'F2' && renameKey(target)) {
    event.preventDefault();
    event.stopPropagation();
    startRename(target, place);
  }
}

/* ───────── Actions ───────── */

const MODELING_ONLY = 'Needs the modeling format: add any feature first.';
const CUSTOM = 'Written as custom code: edit it in Source.';

const listed = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));

function reveal(from: number, to: number) {
  const length = get().doc.code.length;
  set({ sourceReveal: { from: Math.min(from, length), to: Math.min(to, length), nonce: Date.now() }, dockOpen: true, dockTab: 'source' });
}

async function copyReference(id: string) {
  const text = pyString(id);
  try { await navigator.clipboard.writeText(text); } catch {
    // Plain-HTTP origins have no async clipboard.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('success', 'Reference copied', `${text}: paste it into Source or ask STEVE about it.`);
}

export const openParameters = (focus: string | null = null) =>
  set({ activeFeature: PARAMETERS_ID, parameterFocus: focus, selection: [], dockOpen: true, dockTab: 'properties', workspace: 'design' });

export { sketchShown, toggleBody, togglePlane, toggleSketch };

const reportBodies = (state: AppState = get()) => bodyIds(state.displayed);

function isolateBody(id: string) {
  const others = reportBodies().filter((body) => body !== id);
  set({ hiddenBodies: others });
  deselectBodies(others);
  requestAnimationFrame(() => viewer.fit(true));
}

/** Selects a body: the whole part when it is the only one, else that body's faces. */
export function selectBody(id: string) {
  const state = get();
  const model = viewer.model;
  if (!model) return;
  const nodes = state.rootId ? state.tree[state.rootId]?.children ?? [] : [];
  set({ activeFeature: null, selection: reportBodies(state).length === 1 && nodes.length === 1 ? [{ kind: 'component', node: nodes[0] }] : bodyPicks(model, [id]) });
}

/** How much of a body the selection holds: all its faces (or the part, when it is the only body), some, or none. */
export function bodySelection(state: AppState, id: string): 'all' | 'some' | null {
  const model = viewer.model;
  if (!model || !state.selection.length) return null;
  if (state.selection.length === 1 && state.selection[0].kind === 'component') return reportBodies(state).length === 1 ? 'all' : null;
  const mine = state.selection.filter((pick) => bodiesOfPick(pick, model)[0] === id).length;
  if (!mine) return null;
  // In a design a body's faces repeat in each placed instance.
  return mine === state.selection.length && mine === bodyPicks(model, [id]).length ? 'all' : 'some';
}

function zoomToBody(id: string) {
  const model = viewer.model;
  if (!model) return;
  const box = model.pickBox(bodyPicks(model, [id]));
  if (!box.isEmpty()) viewer.zoomTo(box);
}

async function moveBody(id: string) {
  await openFeature('move');
  if (!useFeatureDialog.getState().open || useFeatureDialog.getState().kind !== 'move') return;
  useFeatureDialog.setState({ target: null });
  setValue('bodies', `[${JSON.stringify(id)}]`);
}

function fromSketch(id: string, kind: 'extrude' | 'revolve') {
  set({ activeFeature: id, selection: [] });
  void openFeature(kind);
}

const lineOffset = (code: string, line: number) => code.split('\n').slice(0, Math.max(0, line - 1)).reduce((sum, text) => sum + text.length + 1, 0);

function deleteLegacyPlane(plane: ConstructionPlane) {
  if (get().busy) return;
  const code = get().doc.code;
  if (isReferenced(code, plane.name)) { toast('warning', `${plane.name} is in use`, 'Remove the code that uses it first.'); return; }
  setCode(removePlane(code, plane));
  void updateModel();
}

/** Deletes a component's file, import and placements; greyed out while something else still uses it. */
function deleteComponentEntry(target: Extract<ItemTarget, { kind: 'component' }>, state: AppState): Entry {
  const check = withoutComponent(filesOf(state.doc), target.path, target.id);
  const reason = state.busy ? BUSY : 'users' in check ? `Used in ${check.users.join(', ')}: remove those uses first.` : null;
  return { label: 'Delete component', icon: <Trash2 {...I} />, danger: true, reason, run: () => {
    const done = removeComponent(target.path, target.id);
    if (done !== true) toast('warning', `${target.name} is in use`, done);
  } };
}

/* ───────── Menus ───────── */

export interface Entry { label: string; icon: ReactNode; run: () => void; shortcut?: string; reason?: string | null; danger?: boolean }
/** A row that opens its own items beside it (a submenu): shown only when it has some. */
export interface SubEntry { label: string; icon: ReactNode; items: Entry[]; id?: string }
export type Line = Entry | SubEntry | 'sep' | null | false | '' | undefined;

const I = { size: 15 };
const noop = () => {};

function featureEntries(target: Extract<ItemTarget, { kind: 'feature' }>, place: Place, state: AppState): Line[] {
  const { row } = target;
  const doc = state.modeling;
  const id = row.id;
  const showCode: Entry = { label: 'Show in source', icon: <Code2 {...I} />, run: () => reveal(row.feature.span[0], row.feature.span[1]) };
  if (!id) return [showCode];
  const users = doc ? dependents(id, doc) : [];
  const suppressed = row.status === 'suppressed';
  const rename: Entry = { label: 'Rename', icon: <PenLine {...I} />, shortcut: 'F2', run: () => renameLater(target, place) };
  const common: Line[] = [
    'sep',
    { label: suppressed ? 'Unsuppress' : 'Suppress', icon: suppressed ? <Eye {...I} /> : <EyeOff {...I} />, run: () => { void toggleSuppressed(id); } },
    showCode,
    { label: 'Copy reference', icon: <Copy {...I} />, run: () => { void copyReference(id); } },
    // The timeline's history marker: see the model as of this step; new features go in after it.
    place === 'timeline' && { label: state.rollback?.after === id ? 'Roll to end' : 'Roll back to here', icon: <History {...I} />, reason: state.busy ? 'Wait for the current operation to finish.' : null,
      run: () => { void rollTo(state.rollback?.after === id ? undefined : id); } },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: users.length ? `Used by ${listed(users)}.` : null, run: () => { void deleteFeature(id); } },
  ];
  if (row.kind === 'sketch') {
    const shown = sketchShown(id, state);
    return [
      { label: 'Edit sketch', icon: <SketchIcon {...I} />, reason: row.editable ? null : CUSTOM, run: () => { void editSketch(id); } },
      rename,
      { label: shown ? 'Hide' : 'Show', icon: shown ? <EyeOff {...I} /> : <Eye {...I} />, shortcut: 'Space', run: () => toggleSketch(id) },
      'sep',
      { label: 'Extrude…', icon: <ExtrudeIcon {...I} />, shortcut: 'E', run: () => fromSketch(id, 'extrude') },
      { label: 'Revolve…', icon: <RevolveIcon {...I} />, run: () => fromSketch(id, 'revolve') },
      ...common,
    ];
  }
  const edit: Entry = { label: 'Edit', icon: <Pencil {...I} />, reason: !SPECS[row.kind] ? 'This feature is edited in Source.' : row.editable ? null : CUSTOM, run: () => openRow(row) };
  if (row.kind === 'plane') {
    const sketchOn = doc ? planeTarget(row.feature, doc) : null;
    const hidden = state.hiddenPlanes.includes(id);
    return [
      { label: 'New sketch on this plane', icon: <SketchIcon {...I} />, reason: suppressed ? 'Unsuppress the plane first.' : sketchOn ? null : 'Regenerate the model so this plane can be placed.', run: () => { if (sketchOn) void startSketch(sketchOn); } },
      edit,
      rename,
      { label: hidden ? 'Show' : 'Hide', icon: hidden ? <Eye {...I} /> : <EyeOff {...I} />, shortcut: 'Space', run: () => togglePlane(id) },
      ...common,
    ];
  }
  return [edit, rename, ...common];
}

/** The feature a body comes from: its own (extrude `box_1` → body `box_1`), the split it is a piece of, or the move that copied it. */
function bodyMaker(id: string, doc: ModelDoc | null) {
  const features = doc?.features ?? [];
  const own = features.find((f) => f.id === id);
  if (own) return own;
  const piece = /^(.+)_(\d+)$/.exec(id);
  return (piece && features.find((f) => f.id === piece[1] && f.kind === 'split'))
    || features.find((f) => f.kind === 'move' && !!f.id && id.endsWith(`_${f.id}`) && id.length > f.id.length + 1) || null;
}

const BUSY = 'Wait for the current operation to finish.';

/** 3MF and STL of what `select` selects (a row's body, component or the whole model), for the person's slicer. */
function meshEntries(select: () => void, state: AppState, of = ''): Line[] {
  const reason = busyReason(state);
  const run = (format: MeshFormat) => () => { select(); void exportMesh(format); };
  return [
    { label: `Export 3MF${of}`, icon: <Download {...I} />, reason, run: run('3mf') },
    { label: `Export STL${of}`, icon: <Download {...I} />, reason, run: run('stl') },
  ];
}

function bodyEntries(target: Extract<ItemTarget, { kind: 'body' }>, place: Place, state: AppState): Line[] {
  const { id } = target;
  const hidden = state.hiddenBodies.includes(id);
  const bodies = reportBodies(state);
  const doc = state.modeling;
  const maker = bodyMaker(id, doc);
  const users = maker?.id && doc ? dependents(maker.id, doc) : [];
  // In a design, the open component's body: its STEP is the component's.
  const component = state.doc.kind === 'design' ? editedComponent(state.displayed) : null;
  const componentName = component ? designOf(state.displayed)?.components[component]?.name || component : '';
  const deleteReason = !maker ? 'Regenerate the model to find the feature that made it.'
    : maker.id !== id ? `Made by ${maker.name}: edit or delete that feature.` : users.length ? `Used by ${listed(users)}.` : state.busy ? BUSY : null;
  return [
    { label: 'Rename', icon: <PenLine {...I} />, shortcut: 'F2', run: () => renameLater(target, place) },
    { label: 'Select', icon: <MousePointer2 {...I} />, reason: hidden ? 'Show it first.' : null, run: () => selectBody(id) },
    { label: hidden ? 'Show' : 'Hide', icon: hidden ? <Eye {...I} /> : <EyeOff {...I} />, shortcut: 'Space', run: () => toggleBody(id) },
    bodies.length > 1 && { label: 'Isolate', icon: <Focus {...I} />, run: () => isolateBody(id) },
    { label: 'Zoom to', icon: <ScanSearch {...I} />, reason: hidden ? 'Show it first.' : null, run: () => zoomToBody(id) },
    'sep',
    { label: 'Move/Copy…', icon: <MoveIcon {...I} />, shortcut: 'Shift+M', run: () => { void moveBody(id); } },
    { label: 'Material…', icon: <MaterialIcon {...I} />, reason: state.busy ? BUSY : null, run: () => openMaterials([id]) },
    { label: 'Appearance…', icon: <Palette {...I} />, reason: state.busy ? BUSY : null, run: () => openAppearance([id]) },
    'sep',
    { label: 'Show in source', icon: <Code2 {...I} />, reason: maker ? null : 'Regenerate the model to find the code that made it.', run: () => { if (maker) reveal(maker.span[0], maker.span[1]); } },
    { label: 'Copy reference', icon: <Copy {...I} />, run: () => { void copyReference(id); } },
    'sep',
    component
      ? { label: 'Export component STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportComponentStep(componentTarget(component, componentName)); } }
      : { label: 'Export STEP', icon: <Download {...I} />, reason: bodies.length > 1 ? 'STEP exports the whole part (File → Export STEP); 3MF and STL export one body.' : busyReason(state), run: () => { void exportStep(); } },
    ...meshEntries(() => selectBody(id), state),
    state.hiddenBodies.length > 0 && 'sep',
    state.hiddenBodies.length > 0 && { label: 'Show all bodies', icon: <Eye {...I} />, run: () => set({ hiddenBodies: [] }) },
    'sep',
    // The inspector shows a selected body: its material, volume and mass.
    { label: 'Properties', icon: <SlidersHorizontal {...I} />, reason: hidden ? 'Show it first.' : null, run: () => { selectBody(id); set({ dockOpen: true, dockTab: 'properties' }); } },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: deleteReason, run: () => { if (maker?.id) void deleteFeature(maker.id); } },
  ];
}

/* ───────── Design components that aren't open ───────── */

/** Opens a design component's file and runs `then` once its code is parsed (the tree's rows for it are live then). */
function inComponent(path: string, then: () => void) {
  const state = get();
  if (state.doc.activeFile === path && state.modeling) { then(); return; }
  const before = state.modeling;
  openFile(path);
  const started = Date.now();
  const tick = () => {
    const now = get();
    if (now.doc.activeFile !== path) return;
    if (now.modeling && now.modeling !== before) { then(); return; }
    if (Date.now() - started < 6000) setTimeout(tick, 50);
  };
  setTimeout(tick, 50);
}

const zoomToPicks = (picks: Pick[]) => {
  const model = viewer.model;
  if (!model) return;
  const box = model.pickBox(picks);
  if (!box.isEmpty()) viewer.zoomTo(box);
};

/** The component's placed instances: hidden, shown or isolated together (one body of a closed component can't be hidden alone). */
function instanceEntries(component: ComponentRef, state: AppState): Line[] {
  const { nodes, name } = component;
  const visible = nodes.some((id) => isNodeVisible(state.tree, id));
  const placed = nodes.length ? null : 'Not placed in this design.';
  return [
    { label: visible ? `Hide ${name}` : `Show ${name}`, icon: visible ? <EyeOff {...I} /> : <Eye {...I} />, reason: placed,
      run: () => (visible ? hideNodes(nodes) : nodes.forEach((id) => { if (get().tree[id]?.hidden) toggleHidden(id); })) },
    seeThroughEntry(nodes, state, ` ${name}`),
    { label: `Isolate ${name}`, icon: <Focus {...I} />, reason: placed, run: () => isolate(nodes) },
  ];
}

/** Draws placed nodes see-through (to look at how they meet the parts around them) or opaque again. */
function seeThroughEntry(nodes: string[], state: AppState, name = ''): Entry {
  const on = nodes.length > 0 && nodes.every((id) => isNodeSeeThrough(state.tree, id));
  return { label: on ? `Make${name} opaque` : `Make${name} see-through`, icon: on ? <ShadedEdgesIcon {...I} /> : <XrayIcon {...I} />,
    reason: !nodes.length ? 'Not placed in this design.' : !nodes.some((id) => isNodeVisible(state.tree, id)) ? 'Show it first.' : null, run: () => toggleSeeThrough(nodes) };
}

const selectNodes = (nodes: string[]) => set({ activeFeature: null, selection: nodes.map((node) => ({ kind: 'component' as const, node })) });

function componentBodyEntries(target: Extract<ItemTarget, { kind: 'component-body' }>, state: AppState): Line[] {
  const { component, id } = target;
  const picks = () => (viewer.model ? bodyPicks(viewer.model, [id], component.id) : []);
  const select = () => set({ activeFeature: null, selection: picks() });
  const placed = component.nodes.length ? null : 'This component has no bodies yet.';
  return [
    { label: 'Edit component', icon: <Pencil {...I} />, run: () => openFile(component.path) },
    { label: 'Select', icon: <MousePointer2 {...I} />, reason: placed, run: select },
    { label: 'Zoom to', icon: <ScanSearch {...I} />, reason: placed, run: () => zoomToPicks(picks()) },
    'sep',
    { label: 'Rename', icon: <PenLine {...I} />, run: () => inComponent(component.path, () => startRename({ kind: 'body', id })) },
    { label: 'Material…', icon: <MaterialIcon {...I} />, reason: state.busy ? BUSY : null, run: () => inComponent(component.path, () => openMaterials([id])) },
    { label: 'Appearance…', icon: <Palette {...I} />, reason: state.busy ? BUSY : null, run: () => inComponent(component.path, () => openAppearance([id])) },
    { label: 'Show in source', icon: <Code2 {...I} />, run: () => inComponent(component.path, () => { const maker = bodyMaker(id, get().modeling); if (maker) reveal(maker.span[0], maker.span[1]); }) },
    'sep',
    ...instanceEntries(component, state),
    'sep',
    { label: 'Export component STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportComponentStep(componentTarget(component.id, component.name)); } },
    ...meshEntries(select, state),
  ];
}

function componentSketchEntries(target: Extract<ItemTarget, { kind: 'component-sketch' }>): Line[] {
  const { component, id } = target;
  const inIt = (then: () => void) => () => inComponent(component.path, then);
  return [
    { label: 'Edit sketch', icon: <SketchIcon {...I} />, run: inIt(() => { void editSketch(id); }) },
    { label: 'Rename', icon: <PenLine {...I} />, run: inIt(() => useRenaming.setState({ key: `feature:${id}`, place: 'tree' })) },
    { label: 'Show in source', icon: <Code2 {...I} />, run: inIt(() => { const feature = get().modeling?.features.find((f) => f.id === id); if (feature) reveal(feature.span[0], feature.span[1]); }) },
    'sep',
    { label: 'Extrude…', icon: <ExtrudeIcon {...I} />, run: inIt(() => fromSketch(id, 'extrude')) },
    { label: 'Revolve…', icon: <RevolveIcon {...I} />, run: inIt(() => fromSketch(id, 'revolve')) },
    'sep',
    { label: 'Edit component', icon: <Pencil {...I} />, run: () => openFile(component.path) },
  ];
}

/* ───────── Group headings ───────── */

/** "New component" from a menu: the tree's inline name field opens (ModelStructure listens). */
export const useNewComponent = create<{ request: number }>(() => ({ request: 0 }));
const newComponent = () => { set({ workspace: 'design' }); useNewComponent.setState((state) => ({ request: state.request + 1 })); };

/** A ribbon command as a menu item: its label (or `label`), icon, shortcut and, when unavailable, why. */
export function commandEntry(id: string, label?: string, before?: () => void): Entry {
  const cmd = commandOf(id);
  const ok = availability(cmd, get());
  const Icon = cmd.icon;
  return { label: label ?? cmd.label, icon: <Icon size={15} />, shortcut: cmd.shortcut, reason: ok === true ? null : ok, run: () => { before?.(); runCommand(id); } };
}

const sketchIds = (state: AppState) => (state.modeling?.features ?? []).filter((f) => f.kind === 'sketch' && f.id).map((f) => f.id!);
const planeIds = (state: AppState) => [...(state.modeling?.features ?? []).filter((f) => (f.kind === 'plane' || f.kind === 'axis' || f.kind === 'point') && f.id).map((f) => f.id!), ...parsePlanes(state.doc.code).map((plane) => plane.name)];

function groupEntries(target: Extract<ItemTarget, { kind: 'group' }>, state: AppState): Line[] {
  const { component } = target;
  // A closed design component: its groups open it, select it or work on its instances.
  if (component && !component.open && target.group !== 'instances') {
    const edit: Entry = { label: 'Edit component', icon: <Pencil {...I} />, run: () => openFile(component.path) };
    if (target.group === 'sketches') return [edit, { label: `New sketch in ${component.name}`, icon: <SketchIcon {...I} />, shortcut: 'Shift+S', reason: state.busy ? BUSY : null, run: () => inComponent(component.path, () => runCommand('model.sketch')) }];
    if (target.group !== 'bodies') return [edit];
    return [
      edit,
      { label: 'Select', icon: <MousePointer2 {...I} />, reason: component.nodes.length ? null : 'This component has no bodies yet.', run: () => selectNodes(component.nodes) },
      ...instanceEntries(component, state),
    ];
  }
  // Plain CadQuery parts: no body, sketch or plane features to show or hide one by one.
  const canonical = !!state.modeling?.canonical;
  switch (target.group) {
    case 'bodies': {
      if (!canonical && !component) return [
        { label: 'Show all', icon: <Eye {...I} />, shortcut: 'Shift+H', run: showAll },
        'sep',
        { label: 'Export STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportStep(); } },
        ...meshEntries(() => set({ selection: [] }), state),
      ];
      const bodies = reportBodies(state);
      const hidden = state.hiddenBodies.length;
      const whole = () => (component ? selectNodes(component.nodes) : set({ selection: [] }));
      return [
        { label: 'Show all bodies', icon: <Eye {...I} />, reason: hidden ? null : 'Every body is shown.', run: () => set({ hiddenBodies: [] }) },
        { label: 'Hide all bodies', icon: <EyeOff {...I} />, reason: !bodies.length ? 'There are no bodies yet.' : hidden === bodies.length ? 'Every body is hidden.' : null,
          run: () => setBodiesShown(bodies, false) },
        'sep',
        component
          ? { label: 'Export component STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportComponentStep(componentTarget(component.id, component.name)); } }
          : { label: 'Export STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportStep(); } },
        ...meshEntries(whole, state),
      ];
    }
    case 'surfaces': {
      const ids = reportBodies(state).filter((id) => modelingOf(state.displayed)?.bodies[id]?.kind === 'surface');
      const hidden = ids.filter((id) => state.hiddenBodies.includes(id)).length;
      return [
        commandEntry('model.fill'), commandEntry('model.boundary_surface'),
        'sep',
        { label: 'Show all surfaces', icon: <Eye {...I} />, reason: hidden ? null : 'Every surface is shown.', run: () => setBodiesShown(ids, true) },
        { label: 'Hide all surfaces', icon: <EyeOff {...I} />, reason: hidden === ids.length ? 'Every surface is hidden.' : null, run: () => setBodiesShown(ids, false) },
      ];
    }
    case 'sketches': {
      if (!canonical) return [commandEntry('model.sketch')];
      const ids = sketchIds(state);
      return [
        commandEntry('model.sketch'),
        'sep',
        { label: 'Show all sketches', icon: <Eye {...I} />, reason: ids.length ? null : 'No sketches yet.', run: () => setSketchesShown(ids, true) },
        { label: 'Hide all sketches', icon: <EyeOff {...I} />, reason: ids.length ? null : 'No sketches yet.', run: () => setSketchesShown(ids, false) },
      ];
    }
    case 'construction': {
      if (!canonical) return [
        commandEntry('construct.plane', 'New construction plane…'),
        { label: 'Show all', icon: <Eye {...I} />, reason: state.hiddenPlanes.length ? null : 'All are shown.', run: () => set({ hiddenPlanes: [] }) },
      ];
      const ids = planeIds(state);
      return [
        commandEntry('construct.plane', 'New construction plane…'),
        'sep',
        { label: 'Show all', icon: <Eye {...I} />, reason: ids.some((id) => state.hiddenPlanes.includes(id)) ? null : 'All are shown.', run: () => setPlanesShown(ids, true) },
        { label: 'Hide all', icon: <EyeOff {...I} />, reason: ids.every((id) => state.hiddenPlanes.includes(id)) ? 'All are hidden.' : null, run: () => setPlanesShown(ids, false) },
      ];
    }
    case 'components': return [
      { label: 'New component', icon: <Plus {...I} />, reason: state.busy ? BUSY : null, run: newComponent },
      commandEntry('design.link', 'Link a saved part or design…'),
      'sep',
      { label: 'Show all', icon: <Eye {...I} />, shortcut: 'Shift+H', run: showAll },
      { label: 'Export STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportStep(); } },
      ...meshEntries(() => set({ selection: [] }), state),
    ];
    case 'links': {
      const behind = behindLinks();
      return [
        commandEntry('design.link', 'Link a saved part or design…'),
        { label: behind.length > 1 ? `Update ${behind.length} links` : 'Update links', icon: <RefreshCw {...I} />,
          reason: !behind.length ? 'Every link is at its latest revision.' : state.busy ? BUSY : null, run: () => { void updateLinks(); } },
      ];
    }
    case 'joints': return [
      commandEntry('motion.revolute', 'New revolute joint…'),
      commandEntry('motion.slider', 'New slider joint…'),
      commandEntry('motion.rigid', 'New fixed joint…'),
      'sep',
      { label: 'Show in source', icon: <Code2 {...I} />, run: () => { openFile(MAIN); set({ dockOpen: true, dockTab: 'source' }); } },
    ];
    case 'explodes': return [
      commandEntry('motion.explode', 'New explode…'),
      'sep',
      { label: 'Show in source', icon: <Code2 {...I} />, run: () => { openFile(MAIN); set({ dockOpen: true, dockTab: 'source' }); } },
    ];
    case 'instances': return component ? placedEntries(component.nodes, componentTarget(component.id, component.name), state) : [];
  }
}

function designFileEntries(target: Extract<ItemTarget, { kind: 'design-file' }>, state: AppState): Line[] {
  const open = (path: string) => () => { openFile(path); set({ dockOpen: true, dockTab: 'source' }); };
  if (target.file === 'params') return [{ label: 'Open params.py', icon: <FileCode {...I} />, run: open(PARAMS) }];
  return [
    { label: 'Open main.py', icon: <FileCode {...I} />, run: open(MAIN) },
    'sep',
    { label: 'New component', icon: <Plus {...I} />, reason: state.busy ? BUSY : null, run: newComponent },
    commandEntry('design.link', 'Link a saved part or design…'),
    commandEntry('motion.revolute', 'New revolute joint…'),
  ];
}

function couplingEntries(target: { kind: 'coupling'; name: string }, state: AppState): Line[] {
  const motion = useMotion.getState();
  const driven = motion.kinematics?.drives.some((drive) => drive.joint === target.name);
  const playing = motion.playing === target.name;
  return [
    { label: 'Edit coupling…', icon: <Pencil {...I} />, reason: state.busy ? BUSY : null, run: () => openMotionTool('couple', target.name) },
    driven ? { label: playing ? 'Pause' : 'Play drive', icon: playing ? <Pause {...I} /> : <Play {...I} />, run: () => (playing ? stop() : play(target.name)) } : null,
    { label: 'Show in source', icon: <Code2 {...I} />, run: () => showCall('couple', target.name) },
  ];
}

function animationEntries(target: { kind: 'animation'; name: string }, state: AppState): Line[] {
  const motion = useMotion.getState();
  const playing = motion.clip === target.name && !!motion.clipStart;
  return [
    { label: playing ? 'Pause' : 'Play', icon: playing ? <Pause {...I} /> : <Play {...I} />, run: () => (playing ? pauseClip() : playClip(target.name)) },
    { label: 'Edit animation…', icon: <Pencil {...I} />, reason: state.busy ? BUSY : null, run: () => { selectClip(target.name); openMotionTool('animation', target.name); } },
    { label: 'Show in source', icon: <Code2 {...I} />, run: () => showCall('animation', target.name) },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: state.busy ? BUSY : null, run: () => { removeAnimation(target.name); void updateModel(); } },
  ];
}

function explodeEntries(target: { kind: 'explode'; name: string }, state: AppState): Line[] {
  const motion = useMotion.getState();
  const playing = motion.clip === target.name && !!motion.clipStart;
  return [
    { label: playing ? 'Pause' : 'Play', icon: playing ? <Pause {...I} /> : <Play {...I} />, run: () => (playing ? pauseClip() : playClip(target.name)) },
    { label: 'Edit explode…', icon: <Pencil {...I} />, reason: state.busy ? BUSY : null, run: () => { selectClip(target.name); openExplodeTool(target.name); } },
    { label: 'Show in source', icon: <Code2 {...I} />, run: () => showCall('explode', target.name) },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: state.busy ? BUSY : null, run: () => { removeExplode(target.name); void updateModel(); } },
  ];
}

const busyReason = (state: AppState) => (!state.displayed ? 'There’s no geometry yet.' : state.busy ? 'Wait for the current operation to finish.' : null);

function exportEntry(target: StepTarget | null, state: AppState): Line {
  return target && { label: 'Export STEP', icon: <Download {...I} />, reason: busyReason(state), run: () => { void exportComponentStep(target); } };
}

/** A component or link of a design: its placed instances together. */
function placedEntries(nodes: string[], target: StepTarget, state: AppState, edit?: () => void): Line[] {
  const visible = nodes.some((id) => isNodeVisible(state.tree, id));
  const select = () => set({ activeFeature: null, selection: nodes.map((node) => ({ kind: 'component' as const, node })) });
  const box = () => { const bounds = new THREE.Box3(); for (const id of nodes) { const b = viewer.model?.bounds(true, id); if (b && !b.isEmpty()) bounds.union(b); } return bounds; };
  return [
    !!edit && { label: 'Edit component', icon: <Pencil {...I} />, run: edit },
    { label: nodes.length > 1 ? `Select ${nodes.length} instances` : 'Select', icon: <MousePointer2 {...I} />, reason: nodes.length ? null : 'This component has no bodies yet.', run: select },
    { label: visible ? 'Hide' : 'Show', icon: visible ? <EyeOff {...I} /> : <Eye {...I} />, shortcut: 'Space', reason: nodes.length ? null : 'Not placed in this design.',
      run: () => (visible ? hideNodes(nodes) : nodes.forEach((id) => { if (get().tree[id]?.hidden) toggleHidden(id); })) },
    seeThroughEntry(nodes, state),
    { label: 'Isolate', icon: <Focus {...I} />, reason: nodes.length ? null : 'Not placed in this design.', run: () => isolate(nodes) },
    { label: 'Zoom to', icon: <ScanSearch {...I} />, reason: visible ? null : 'Show it first.', run: () => { const b = box(); if (!b.isEmpty()) viewer.zoomTo(b); } },
    'sep',
    exportEntry(target, state),
  ];
}

function nodeEntries(id: string, state: AppState): Line[] {
  const canonical = !!state.modeling?.canonical;
  const node = state.tree[id];
  const visible = isNodeVisible(state.tree, id);
  const siblings = node?.parent ? state.tree[node.parent]?.children.length ?? 0 : 0;
  const placed = state.doc.kind === 'design' && node?.parent === state.rootId ? nodeTarget(state, id) : null;
  return [
    { label: 'Rename', icon: <PenLine {...I} />, reason: canonical ? 'Regenerate the model to name its bodies.' : 'Plain CadQuery code names its own bodies.', run: noop },
    { label: visible ? 'Hide' : 'Show', icon: visible ? <EyeOff {...I} /> : <Eye {...I} />, shortcut: 'Space', run: () => toggleHidden(id) },
    siblings > 1 && { label: 'Isolate', icon: <Focus {...I} />, run: () => isolate([id]) },
    { label: 'Zoom to', icon: <ScanSearch {...I} />, reason: visible ? null : 'Show it first.', run: () => { const box = viewer.model?.bounds(true, id); if (box && !box.isEmpty()) viewer.zoomTo(box); } },
    'sep',
    { label: 'Move/Copy…', icon: <MoveIcon {...I} />, shortcut: 'Shift+M', reason: canonical ? null : MODELING_ONLY, run: () => { void openFeature('move'); } },
    { label: 'Copy reference', icon: <Copy {...I} />, reason: canonical ? 'Regenerate the model to name its bodies.' : 'Plain CadQuery bodies have no reference name.', run: noop },
    'sep',
    exportEntry(placed, state),
  ];
}

function parameterEntries(target: Extract<ItemTarget, { kind: 'parameter' }>, place: Place, state: AppState): Line[] {
  const users = state.modeling ? usage(state.modeling).get(target.name) ?? [] : [];
  return [
    { label: 'Rename', icon: <PenLine {...I} />, shortcut: 'F2', run: () => renameLater(target, place) },
    { label: 'Edit value', icon: <Hash {...I} />, run: () => { setTimeout(() => useRenaming.setState({ key: `value:${target.name}`, place }), 0); } },
    { label: 'Open parameters', icon: <Variable {...I} />, run: () => openParameters(target.name) },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: users.length ? `In use by ${listed(users)}.` : null, run: () => { void deleteParameter(target.name); } },
  ];
}

function entries(target: ItemTarget, place: Place): Line[] {
  const state = get();
  const part = state.doc.kind === 'part';
  switch (target.kind) {
    case 'feature': return featureEntries(target, place, state);
    case 'body': return bodyEntries(target, place, state);
    case 'node': return nodeEntries(target.id, state);
    case 'component': return [
      ...placedEntries(target.nodes, componentTarget(target.id, target.name), state, () => openFile(target.path)),
      ...meshEntries(() => selectNodes(target.nodes), state),
      'sep',
      { label: 'Material…', icon: <MaterialIcon {...I} />, reason: state.busy ? BUSY : null, run: () => inComponent(target.path, () => openMaterials('part')) },
      { label: 'Appearance…', icon: <Palette {...I} />, reason: state.busy ? BUSY : null, run: () => inComponent(target.path, () => openAppearance('part')) },
      { label: 'Show in source', icon: <Code2 {...I} />, run: () => { openFile(target.path); set({ dockOpen: true, dockTab: 'source' }); } },
      'sep',
      deleteComponentEntry(target, state),
    ];
    case 'link': {
      const ref = state.doc.links[target.alias];
      const status = state.doc.saved?.link_status?.[target.alias];
      const latest = status?.latest != null && ref?.revision != null && status.latest > ref.revision ? status.latest : null;
      return [
        ...placedEntries(target.nodes, linkTarget(target.alias, target.name), state),
        ...meshEntries(() => selectNodes(target.nodes), state),
        'sep',
        latest !== null && { label: `Update to revision ${latest}`, icon: <RefreshCw {...I} />, reason: state.busy ? BUSY : null, run: () => { void updateLink(target.alias); } },
        // A linked document in the Trash still builds at its pinned revision; it opens again once restored.
        !!ref?.document_id && (linkTrashed(status)
          ? { label: 'Restore from the Trash', icon: <ArchiveRestore {...I} />, run: () => { void restoreFromTrash([{ id: ref.document_id, name: status?.name ?? target.name }]).then(() => refreshLinks(false)); } }
          : { label: status?.kind === 'circuit' ? 'Open circuit' : 'Open linked document', icon: <ExternalLink {...I} />, run: () => openPart(ref.document_id) }),
      ];
    }
    case 'component-body': return componentBodyEntries(target, state);
    case 'component-sketch': return componentSketchEntries(target);
    case 'group': return groupEntries(target, state);
    case 'design-file': return designFileEntries(target, state);
    case 'coupling': return couplingEntries(target, state);
    case 'animation': return animationEntries(target, state);
    case 'explode': return explodeEntries(target, state);
    case 'parameter': return parameterEntries(target, place, state);
    case 'joint': return jointEntries(target, place, state);
    case 'parameters': return [
      { label: 'Open parameters', icon: <Variable {...I} />, run: () => openParameters() },
      { label: 'Add parameter', icon: <Plus {...I} />, run: () => openParameters(ADD_PARAMETER) },
    ];
    case 'origin': return [
      { label: state.showOrigin ? 'Hide origin' : 'Show origin', icon: state.showOrigin ? <EyeOff {...I} /> : <Eye {...I} />, shortcut: 'O', run: () => set({ showOrigin: !state.showOrigin }) },
    ];
    case 'origin-plane': return [
      { label: 'New sketch on this plane', icon: <SketchIcon {...I} />, reason: part ? null : 'Sketches belong in part documents.', run: () => { void startSketch(namedTarget(target.plane)); } },
      { label: state.showOrigin ? 'Hide origin' : 'Show origin', icon: state.showOrigin ? <EyeOff {...I} /> : <Eye {...I} />, shortcut: 'O', run: () => set({ showOrigin: !state.showOrigin }) },
    ];
    case 'document': return [
      { label: 'Rename design', icon: <PenLine {...I} />, shortcut: 'F2', run: () => renameLater(target, place) },
      { label: 'Parameters', icon: <Variable {...I} />, reason: part ? null : 'Parameters belong in part documents.', run: () => openParameters() },
      'sep',
      { label: 'Export STEP', icon: <Download {...I} />, reason: !state.displayed ? 'There’s no geometry yet.' : state.busy ? 'Wait for the current operation to finish.' : null, run: () => { void exportStep(); } },
      ...meshEntries(() => set({ selection: [] }), state),
    ];
    case 'legacy-feature': return [
      { label: 'Properties', icon: <SlidersHorizontal {...I} />, run: () => set({ activeFeature: target.feature.id, selection: [], dockOpen: true, dockTab: 'properties' }) },
      { label: 'Show in source', icon: <Code2 {...I} />, reason: target.feature.source ? null : 'This step has no source location.', run: () => revealSource(target.feature) },
      'sep',
      { label: 'Rename', icon: <PenLine {...I} />, reason: MODELING_ONLY, run: noop },
      { label: 'Suppress', icon: <EyeOff {...I} />, reason: MODELING_ONLY, run: noop },
      { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: MODELING_ONLY, run: noop },
    ];
    case 'legacy-plane': {
      const { plane } = target;
      const hidden = state.hiddenPlanes.includes(plane.name);
      const code = state.doc.code;
      const on = plane.name;
      return [
        { label: 'Edit plane', icon: <Pencil {...I} />, reason: state.busy ? BUSY : null, run: () => editPlane(plane) },
        { label: 'New sketch on this plane', icon: <SketchIcon {...I} />, run: () => { void startSketch({ on, plane: planeBasis(plane.origin.toArray(), plane.xDir.toArray(), plane.normal.toArray()), label: plane.name }); } },
        { label: hidden ? 'Show' : 'Hide', icon: hidden ? <Eye {...I} /> : <EyeOff {...I} />, shortcut: 'Space', run: () => togglePlane(plane.name) },
        { label: 'Show in source', icon: <Code2 {...I} />, run: () => reveal(lineOffset(code, plane.line), lineOffset(code, plane.line + 1) - 1) },
        'sep',
        { label: 'Rename', icon: <PenLine {...I} />, reason: state.busy ? BUSY : null, run: () => renameLater(target, place) },
        { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: state.busy ? BUSY : isReferenced(code, plane.name) ? 'In use: remove the code that uses it first.' : null, run: () => deleteLegacyPlane(plane) },
      ];
    }
  }
}

function jointEntries(target: { kind: 'joint'; name: string }, place: Place, state: AppState): Line[] {
  const motion = useMotion.getState();
  const driven = motion.kinematics?.drives.some((drive) => drive.joint === target.name);
  const playing = motion.playing === target.name;
  const busy = state.busy ? 'Wait for the current operation to finish.' : null;
  return [
    { label: 'Edit joint…', icon: <Pencil {...I} />, reason: busy, run: () => openJointTool(target.name) },
    { label: 'Rename', icon: <PenLine {...I} />, shortcut: 'F2', reason: busy, run: () => renameLater(target, place) },
    driven ? { label: playing ? 'Pause' : 'Play drive', icon: playing ? <Pause {...I} /> : <Play {...I} />, run: () => (playing ? stop() : play(target.name)) } : null,
    { label: 'Show in source', icon: <Code2 {...I} />, run: () => showJointCode(target.name) },
    'sep',
    { label: 'Delete', icon: <Trash2 {...I} />, danger: true, reason: busy, run: () => { removeJoint(target.name); void updateModel(); } },
  ];
}

/** Separators only between groups that have items. */
function tidy(lines: Line[]): (Entry | SubEntry | 'sep')[] {
  const out: (Entry | SubEntry | 'sep')[] = [];
  for (const line of lines) {
    if (!line || (line !== 'sep' && 'items' in line && !line.items.length)) continue;
    if (line === 'sep' && (!out.length || out.at(-1) === 'sep')) continue;
    out.push(line);
  }
  if (out.at(-1) === 'sep') out.pop();
  return out;
}

/** Menu items built elsewhere (Simulate's and Manufacture's trees), drawn like the model browser's: same separators, reasons, shortcuts. */
export function MenuLines({ lines, title }: { lines: Line[]; title?: string }) {
  const items = tidy(lines);
  return (
    <>
      {title && <ContextLabel>{title}</ContextLabel>}
      {items.map((item, index) => item === 'sep' ? <ContextSeparator key={`sep-${index}`} /> : 'items' in item ? (
        <ContextSub key={item.label} icon={item.icon} label={item.label} id={item.id}>
          {item.items.map((sub, at) => <ContextItem key={`${at}:${sub.label}`} icon={sub.icon} shortcut={sub.shortcut} reason={sub.reason ?? undefined} disabled={!!sub.reason} danger={sub.danger} onSelect={sub.run}>{sub.label}</ContextItem>)}
        </ContextSub>
      ) : (
        <ContextItem key={item.label} icon={item.icon} shortcut={item.shortcut} reason={item.reason ?? undefined} disabled={!!item.reason} danger={item.danger} onSelect={item.run}>{item.label}</ContextItem>
      ))}
    </>
  );
}

/** The menu's items; rendered only while it is open. */
export function ItemMenu({ target, place = 'tree', title }: { target: ItemTarget; place?: Place; title?: string }) {
  return <MenuLines lines={entries(target, place)} title={title} />;
}

export { deleteLegacyPlane, isolateBody, lineOffset, reveal, selectNodes };

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Box, Copy, Eye, EyeOff, FileCode, Hash, Layers3, Link2, Pencil, Plus, SlidersHorizontal, Trash2, Variable } from 'lucide-react';
import { addComponent, hideNodes, openFile, toggleHidden, updateLink } from '@/state/actions';
import { areaText, pretty, volumeText, type Units } from '@/lib/format';
import { useSetting } from '@/settings/store';
import { fileLabel, filesOf, MAIN, PARAMS } from '@/state/design';
import { CircuitIcon, FillIcon, OriginIcon, SketchIcon } from '@/icons/cad';
import { modelingIcon, useFeatureRows, type FeatureRow } from '@/modeling/features';
import { bodyIds, bodyLabel, bodyPicks, designOf, modelingOf } from '@/modeling/bodies';
import type { DesignResult, ModelingResult } from '@/lib/modeling';
import { viewer } from '@/viewport/viewer';
import TreeRow from '@/shell/TreeRow';
import JointsGroup, { ExplodesGroup } from '@/motion/JointsGroup';
import SectionsGroup from './SectionsGroup';
import { BrowserGroup, NodeRow, SeeThroughButton } from '@/shell/Browser';
import { useGroupOpen, useOnChange } from '@/state/treeOpen';
import { get, isNodeVisible, samePick, set, setHover, useApp, type AppState, type Pick, type TreeNode } from '@/state/store';
import { setGroupShown, type VisibilityGroup } from '@/state/visibility';
import { constructionFeatures, groupSketches, summarize, type Feature } from '@/lib/features';
import { parsePlanes, type ConstructionPlane } from '@/lib/construction';
import { featureIcon } from './featureIcons';
import { revealSource } from './FeatureTree';
import { PARAMETERS_ID } from './featureEdit';
import {
  ItemMenu, RenameField, bodySelection, deleteLegacyPlane, itemKeyDown, lineOffset, openParameters, reveal, selectBody, sketchShown, startRename,
  toggleBody, togglePlane, toggleSketch, useEditing, useNewComponent, useRenaming, type ComponentRef, type GroupKind, type ItemTarget,
} from './ItemMenu';
import { linkTrashed } from '@/lib/trash';
import styles from '@/shell/Browser.module.css';

const NONE: string[] = [];

/** A group heading's right-click menu (and its stable handle for tests: `group:<kind>[:<component>]`). */
const groupMenu = (group: GroupKind, component?: ComponentRef) => ({
  menu: <ItemMenu target={{ kind: 'group', group, component }} />,
  item: `group:${group}${component ? `:${component.id}` : ''}`,
});

const selectFeature = (feature: Feature) => set({ activeFeature: feature.id, selection: [], dockOpen: true, dockTab: 'properties' });

function Eyeball({ shown, label, onToggle, pinned }: { shown: boolean; label: string; onToggle: () => void; pinned?: boolean }) {
  return (
    <button type="button" className={styles.eye} data-hidden={pinned || undefined} aria-label={`${shown ? 'Hide' : 'Show'} ${label}`} aria-pressed={shown} onClick={onToggle}>
      {shown ? <Eye size={13} /> : <EyeOff size={13} />}
    </button>
  );
}

function NamedPlaneItem({ plane }: { plane: ConstructionPlane }) {
  const code = useApp((state) => state.doc.code);
  const hidden = useApp((state) => state.hiddenPlanes.includes(plane.name));
  const busy = useApp((state) => state.busy);
  const target: ItemTarget = { kind: 'legacy-plane', plane };
  const editing = useEditing(`construction:${plane.name}`);
  return <TreeRow depth={2} icon={<OriginIcon size={14} />} label={editing ? <RenameField editKey={editing} /> : plane.name}
    title={plane.comment} dimmed={hidden}
    item={`construction:${plane.name}`} menu={<ItemMenu target={target} />}
    onKeyDown={(event) => itemKeyDown(event, target)}
    onClick={() => reveal(lineOffset(code, plane.line), lineOffset(code, plane.line + 1) - 1)}
    actions={<>
      <Eyeball shown={!hidden} pinned={hidden} label={plane.name} onToggle={() => togglePlane(plane.name)} />
      <button type="button" className={styles.eye} disabled={busy} aria-label={`Delete ${plane.name}`} onClick={() => deleteLegacyPlane(plane)}><Trash2 size={12} /></button>
    </>} />;
}

/** A group heading's eye: hides every item when any shows, else puts each back as it was. Nothing to hide, no eye. */
function GroupEye({ ids, label, isShown, group }: { ids: string[]; label: string; isShown: (id: string, state: AppState) => boolean; group: VisibilityGroup }) {
  const shown = useApp((state) => ids.some((id) => isShown(id, state)));
  if (!ids.length) return null;
  return <Eyeball shown={shown} pinned={!shown} label={label} onToggle={() => setGroupShown(group, ids, !shown)} />;
}

const bodyShown = (id: string, state: AppState) => !state.hiddenBodies.includes(id);
const planeShown = (id: string, state: AppState) => !state.hiddenPlanes.includes(id);
const rowIds = (rows: FeatureRow[]) => rows.flatMap((row) => (row.id ? [row.id] : []));
const BodiesEye = ({ ids }: { ids: string[] }) => <GroupEye ids={ids} label="all bodies" isShown={bodyShown} group="bodies" />;
const SketchesEye = ({ rows }: { rows: FeatureRow[] }) => <GroupEye ids={rowIds(rows)} label="all sketches" isShown={sketchShown} group="sketches" />;
// Like the rows: only planes have an eye of their own.
const PlanesEye = ({ rows }: { rows: FeatureRow[] }) => <GroupEye ids={rowIds(rows.filter((row) => row.kind === 'plane'))} label="all construction planes" isShown={planeShown} group="planes" />;

/** A modeling feature in the browser: select on click, rename on double-click or F2, its menu on right click. */
function FeatureItem({ row, meta, title, actions, dimmed, depth = 2 }: { row: FeatureRow; meta?: string; title?: string; actions?: ReactNode; dimmed?: boolean; depth?: number }) {
  const active = useApp((state) => state.activeFeature);
  const target: ItemTarget = { kind: 'feature', row };
  const editing = useEditing(row.id ? `feature:${row.id}` : null);
  const Icon = row.kind === 'sketch' ? SketchIcon : modelingIcon(row.kind);
  return (
    <TreeRow depth={depth} icon={<Icon size={14} />} label={row.name} meta={meta} title={row.error ?? title} item={`${row.kind === 'sketch' ? 'sketch' : 'construction'}:${row.id}`}
      selected={!!row.id && active === row.id} error={row.status === 'error'} dimmed={dimmed || row.status === 'suppressed'} actions={actions}
      menu={<ItemMenu target={target} />} editor={editing ? <RenameField editKey={editing} /> : undefined}
      onClick={() => set({ activeFeature: row.id, selection: [] })} onContextSelect={() => set({ activeFeature: row.id, selection: [] })}
      onDoubleClick={() => startRename(target)} onKeyDown={(event) => itemKeyDown(event, target)} />
  );
}

function SketchItem({ row, depth }: { row: FeatureRow; depth?: number }) {
  const report = useApp((state) => modelingOf(state.displayed));
  const shown = useApp((state) => (row.id ? sketchShown(row.id, state) : false));
  const pinned = useApp((state) => (row.id ? state.sketchVisibility[row.id] === false : false));
  const solved = row.id ? report?.sketches?.[row.id] : undefined;
  const meta = row.status === 'error' ? 'error' : row.status === 'suppressed' ? 'suppressed' : solved?.dof === 0 ? 'defined' : solved?.dof != null ? `${solved.dof} free`
    : solved ? `${solved.regions.length} profile${solved.regions.length === 1 ? '' : 's'}` : undefined;
  return <FeatureItem row={row} meta={meta} depth={depth} title="Double-click or F2 to rename · right-click for more" actions={row.id && <Eyeball shown={shown} pinned={pinned} label={row.name} onToggle={() => toggleSketch(row.id!)} />} />;
}

function PlaneItem({ row, depth }: { row: FeatureRow; depth?: number }) {
  const hidden = useApp((state) => !!row.id && state.hiddenPlanes.includes(row.id));
  return <FeatureItem row={row} depth={depth} dimmed={hidden} actions={row.kind === 'plane' && row.id && <Eyeball shown={!hidden} pinned={hidden} label={row.name} onToggle={() => togglePlane(row.id!)} />} />;
}

type BodyReport = ModelingResult['bodies'][string] | undefined;

/** A surface body (model.fill, model.boundary_surface) has its own icon and its area; a solid its volume. */
const bodyIcon = (body: BodyReport) => (body?.kind === 'surface' ? <FillIcon size={15} strokeWidth={1.6} /> : <Box size={15} strokeWidth={1.6} />);
const bodySize = (body: BodyReport, units: Units) => (body?.kind === 'surface'
  ? ` · surface${body.area_mm2 ? `, ${areaText(body.area_mm2, units, 0)}` : ''}`
  : body?.volume ? ` · ${volumeText(body.volume, units, 0)}` : '');

/** Solid and surface bodies apart: surfaces get their own group in the tree (they have no inside, no volume). */
function splitBodies(ids: string[], report: ModelingResult | null | undefined): { solids: string[]; surfaces: string[] } {
  const surfaces = ids.filter((id) => report?.bodies[id]?.kind === 'surface');
  return { solids: ids.filter((id) => !surfaces.includes(id)), surfaces };
}

const SurfacesEye = ({ ids }: { ids: string[] }) => <GroupEye ids={ids} label="all surfaces" isShown={bodyShown} group="bodies" />;

function SurfacesGroup({ ids, depth = 1, component }: { ids: string[]; depth?: number; component?: ComponentRef }) {
  if (!ids.length) return null;
  return (
    <BrowserGroup title="Surfaces" icon={<FillIcon size={depth > 1 ? 14 : 15} />} count={ids.length} depth={depth} actions={<SurfacesEye ids={ids} />} {...groupMenu('surfaces', component)}>
      {ids.map((id) => <BodyItem key={id} id={id} depth={depth + 1} />)}
    </BrowserGroup>
  );
}

function BodyItem({ id, depth = 2 }: { id: string; depth?: number }) {
  const doc = useApp((state) => state.modeling);
  const report = useApp((state) => modelingOf(state.displayed));
  const hidden = useApp((state) => state.hiddenBodies.includes(id));
  const selection = useApp((state) => bodySelection(state, id));
  const editing = useEditing(`body:${id}`);
  const target: ItemTarget = { kind: 'body', id };
  const name = bodyLabel(id, doc, report);
  const body = report?.bodies[id];
  const units = useSetting('display.units');
  return (
    <TreeRow depth={depth} icon={bodyIcon(body)} label={name} item={`body:${id}`} title={`${name} · ${id}${bodySize(body, units)}`}
      selected={selection === 'all'} partial={selection === 'some'} dimmed={hidden} menu={<ItemMenu target={target} />} editor={editing ? <RenameField editKey={editing} /> : undefined}
      onClick={() => selectBody(id)} onContextSelect={() => { if (!hidden) selectBody(id); }} onDoubleClick={() => startRename(target)} onKeyDown={(event) => itemKeyDown(event, target)}
      actions={<Eyeball shown={!hidden} pinned={hidden} label={name} onToggle={() => toggleBody(id)} />} />
  );
}

function ParameterItem({ name, value, unit }: { name: string; value: number; unit: string | null }) {
  const focus = useApp((state) => state.parameterFocus === name && state.activeFeature === PARAMETERS_ID);
  const editing = useRenaming((state) => (state.place === 'tree' && (state.key === `parameter:${name}` || state.key === `value:${name}`) ? state.key : null));
  const target: ItemTarget = { kind: 'parameter', name };
  return (
    <TreeRow depth={2} icon={<Hash size={13} />} label={<span className={styles.mono}>{name}</span>} meta={`${Number(value.toFixed(4))}${unit ? ` ${unit}` : ''}`} item={`parameter:${name}`}
      selected={focus} menu={<ItemMenu target={target} />} editor={editing ? <RenameField key={editing} editKey={editing} /> : undefined}
      onClick={() => openParameters(name)} onDoubleClick={() => startRename(target)} onKeyDown={(event) => itemKeyDown(event, target)} />
  );
}

function ParametersGroup() {
  const doc = useApp((state) => state.modeling);
  const active = useApp((state) => state.activeFeature);
  const [open, setOpen] = useGroupOpen('parameters', false);
  const parameters = doc?.parameters ?? [];
  return (
    <div className={styles.group}>
      <TreeRow depth={1} icon={<Variable size={15} />} label={<span className={styles.groupLabel}>Parameters</span>} meta={parameters.length || '+'} testId="Parameters" item="parameters"
        expanded={open} onToggle={parameters.length ? () => setOpen(!open) : undefined} selected={active === PARAMETERS_ID}
        menu={<ItemMenu target={{ kind: 'parameters' }} />} onKeyDown={(event) => itemKeyDown(event, { kind: 'parameters' })}
        onClick={() => openParameters()} />
      <AnimatePresence initial={false}>
        {open && parameters.length > 0 && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} style={{ overflow: 'hidden' }}>
            {parameters.map((p) => <ParameterItem key={p.name} name={p.name} value={p.value} unit={p.unit} />)}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Modeling documents: parameters, bodies, sketches and planes straight from the code. Features are in the timeline. */
function ModelingStructure() {
  const code = useApp((state) => state.doc.code);
  const namedPlanes = useMemo(() => parsePlanes(code), [code]);
  const rootId = useApp((state) => state.rootId);
  const nodes = useApp((state) => (state.rootId ? state.tree[state.rootId]?.children ?? NONE : NONE));
  const workspace = useApp((state) => state.workspace);
  const rows = useFeatureRows() ?? [];
  const sketches = rows.filter((row) => row.kind === 'sketch');
  const planes = rows.filter((row) => row.kind === 'plane' || row.kind === 'axis' || row.kind === 'point');
  const displayed = useApp((state) => state.displayed);
  const { solids: bodies, surfaces } = useMemo(() => splitBodies(bodyIds(displayed), modelingOf(displayed)), [displayed]);
  return (
    <>
      {workspace === 'design' && <ParametersGroup />}
      <BrowserGroup title="Bodies" icon={<Box size={15} />} count={bodies.length || (surfaces.length ? 0 : nodes.length)} depth={1} actions={<BodiesEye ids={bodies} />} {...groupMenu('bodies')}>
        {bodies.length ? bodies.map((id) => <BodyItem key={id} id={id} />)
          : surfaces.length ? <p className={styles.emptyHint}>Only surfaces so far: thicken or solidify them into a solid.</p>
          : rootId && nodes.length ? nodes.map((id) => <NodeRow key={id} id={id} depth={2} />)
            : <p className={styles.emptyHint}>{rows.length ? 'No bodies yet: extrude a sketch, or add a primitive from Create.' : 'Start with a sketch, or a primitive from Create.'}</p>}
      </BrowserGroup>
      <SurfacesGroup ids={surfaces} />
      {workspace === 'design' && (
        <BrowserGroup title="Sketches" icon={<SketchIcon size={14} />} count={sketches.length} depth={1} defaultOpen actions={<SketchesEye rows={sketches} />} {...groupMenu('sketches')}>
          {sketches.length ? sketches.map((row) => <SketchItem key={row.key} row={row} />)
            : <p className={styles.emptyHint}>Press Sketch (Shift+S) to draw on a plane or a flat face.</p>}
        </BrowserGroup>
      )}
      {workspace === 'design' && planes.length + namedPlanes.length > 0 && (
        <BrowserGroup title="Construction" icon={<OriginIcon size={15} />} count={planes.length + namedPlanes.length} depth={1} defaultOpen={namedPlanes.length > 0}
          actions={<GroupEye ids={[...rowIds(planes.filter((row) => row.kind === 'plane')), ...namedPlanes.map((plane) => plane.name)]} label="all construction planes" isShown={planeShown} group="planes" />} {...groupMenu('construction')}>
          {planes.map((row) => <PlaneItem key={row.key} row={row} />)}
          {namedPlanes.map((plane) => <NamedPlaneItem key={plane.name} plane={plane} />)}
        </BrowserGroup>
      )}
      <SectionsGroup />
    </>
  );
}

/** "New component" in the tree: type a name, Enter makes components/<name>.py, places it and opens it. */
function AddComponentRow() {
  const [name, setName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // "New component" from a menu (Components, Placement) opens this field.
  const request = useNewComponent((state) => state.request);
  useEffect(() => { if (request) { setName(''); setProblem(null); } }, [request]);
  const commit = () => {
    const id = (name ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!id) { setName(null); setProblem(null); return; }
    const outcome = addComponent(id, '');
    if (outcome === true) { setName(null); setProblem(null); } else setProblem(outcome);
  };
  if (name === null) {
    return <TreeRow depth={2} icon={<Plus size={14} />} label={<span className={styles.addLabel}>New component</span>} testId="add-component-tree" item="new-component"
      title="A new component in its own file, placed in main.py" onClick={() => { setName(''); setProblem(null); }} menu={<ItemMenu target={{ kind: 'group', group: 'components' }} />} />;
  }
  return (
    <TreeRow depth={2} icon={<Plus size={14} />} label="" testId="add-component-tree"
      editor={<span className={styles.newComponent} data-invalid={problem ? true : undefined} title={problem ?? undefined}>
        <input autoFocus value={name} placeholder="component_name" aria-label="New component name" spellCheck={false}
          onChange={(event) => { setName(event.target.value); setProblem(null); }} onBlur={commit}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') commit(); if (event.key === 'Escape') { setName(null); setProblem(null); } }} />
        {problem && <small role="alert">{problem}</small>}
      </span>} />
  );
}

/** The viewport nodes of a link's placed instances (instances are the document's children, named after them). */
function linkNodes(alias: string): string[] {
  const state = get();
  const design = (state.displayed?.metadata as { modeling?: { design?: { instances: { name: string; component: string; link?: boolean }[] } } } | null | undefined)?.modeling?.design;
  const names = new Set((design?.instances ?? []).filter((item) => item.link && item.component === alias).map((item) => pretty(item.name)));
  return (state.rootId ? state.tree[state.rootId]?.children ?? [] : []).filter((id) => names.has(state.tree[id]?.name));
}

function setLinkHidden(alias: string, hidden: boolean) {
  const nodes = linkNodes(alias);
  if (hidden) hideNodes(nodes);
  else for (const id of nodes) if (get().tree[id]?.hidden) toggleHidden(id);
}

type ComponentSummary = ModelingResult & { name: string; file: string | null };

/** The viewport nodes of a component's placed instances (children of the document, named after them). */
function instanceNodesOf(tree: Record<string, TreeNode>, rootId: string | null, design: DesignResult | null, component: string): string[] {
  if (!rootId || !design) return NONE;
  const names = new Set(design.instances.filter((item) => !item.link && item.component === component).map((item) => pretty(item.name)));
  return (tree[rootId]?.children ?? NONE).filter((id) => names.has(tree[id]?.name));
}

const chosen = (selection: Pick[], picks: Pick[]) => picks.filter((pick) => selection.some((item) => samePick(item, pick))).length;

/** Selects picks (with Shift/Ctrl/Cmd: adds them, or takes them away when all are already selected). */
function selectPicks(picks: Pick[], additive: boolean) {
  if (!picks.length) return;
  const { selection } = get();
  if (!additive) { set({ selection: picks, activeFeature: null }); return; }
  const all = chosen(selection, picks) === picks.length;
  set({ activeFeature: null, selection: all ? selection.filter((item) => !picks.some((pick) => samePick(item, pick))) : [...selection, ...picks.filter((pick) => !selection.some((item) => samePick(item, pick)))] });
}

const additive = (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => event.shiftKey || event.ctrlKey || event.metaKey;

/** A body of a component that isn't open: selecting it highlights it in every placed instance. */
function ComponentBodyRow({ component, id, summary, owner }: { component: string; id: string; summary: ComponentSummary; owner: ComponentRef }) {
  const selection = useApp((state) => state.selection);
  const displayed = useApp((state) => state.displayed);
  const picks = useMemo(() => (viewer.model ? bodyPicks(viewer.model, [id], component) : []), [id, component, displayed]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = chosen(selection, picks);
  const name = summary.bodies[id]?.name ?? summary.features.find((feature) => feature.id === id)?.name ?? bodyLabel(id, null, summary);
  const body = summary.bodies[id];
  const units = useSetting('display.units');
  return (
    <TreeRow depth={4} icon={bodyIcon(body)} label={name} item={`component-body:${component}:${id}`}
      title={`${name} · ${id}${bodySize(body, units)}`}
      selected={!!picks.length && count === picks.length} partial={count > 0 && count < picks.length}
      menu={<ItemMenu target={{ kind: 'component-body', component: owner, id }} />} onContextSelect={() => selectPicks(picks, false)}
      onClick={(event) => selectPicks(picks, additive(event))} onHover={(hovering) => setHover(hovering ? picks : null)} />
  );
}

/** What a component holds: its own bodies and sketches (editable in place once its file is open), and its placed instances. */
function ComponentContents({ path, component, summary, active, nodes, owner }: { path: string; component: string; summary: ComponentSummary | null; active: boolean; nodes: string[]; owner: ComponentRef }) {
  const canonical = useApp((state) => !!state.modeling?.canonical);
  const displayed = useApp((state) => state.displayed);
  const rows = useFeatureRows() ?? [];
  const live = active && canonical;
  const sketches = live ? rows.filter((row) => row.kind === 'sketch') : [];
  const planes = live ? rows.filter((row) => row.kind === 'plane' || row.kind === 'axis' || row.kind === 'point') : [];
  const all = useMemo(() => (live ? bodyIds(displayed) : Object.entries(summary?.bodies ?? {}).sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0)).map(([id]) => id)),
    [live, displayed, summary]);
  // Live, a component's surfaces get their own group; closed, its rows say which are surfaces (their icon and area).
  const { solids: bodies, surfaces } = useMemo(() => (live ? splitBodies(all, modelingOf(displayed)) : { solids: all, surfaces: [] as string[] }), [live, all, displayed]);
  const summarySketches = live ? [] : (summary?.features ?? []).filter((feature) => feature.kind === 'sketch');
  const bodiesHint = 'No bodies yet: sketch and extrude in this component.';
  return (
    <div data-component-contents={component}>
      <BrowserGroup title="Bodies" icon={<Box size={14} />} count={bodies.length} depth={3} actions={live && <BodiesEye ids={bodies} />} {...groupMenu('bodies', owner)}>
        {bodies.length ? bodies.map((id) => (live ? <BodyItem key={id} id={id} depth={4} /> : <ComponentBodyRow key={id} component={component} id={id} summary={summary!} owner={owner} />))
          : <p className={styles.emptyHint}>{surfaces.length ? 'Only surfaces so far.' : bodiesHint}</p>}
      </BrowserGroup>
      {live && <SurfacesGroup ids={surfaces} depth={3} component={owner} />}
      <BrowserGroup title="Sketches" icon={<SketchIcon size={13} />} count={live ? sketches.length : summarySketches.length} depth={3} actions={live && <SketchesEye rows={sketches} />} {...groupMenu('sketches', owner)}>
        {live ? (sketches.length ? sketches.map((row) => <SketchItem key={row.key} row={row} depth={4} />) : <p className={styles.emptyHint}>Press Sketch (Shift+S) to draw on a plane or a flat face.</p>)
          : summarySketches.length ? summarySketches.map((feature) => {
            const solved = summary?.sketches?.[feature.id];
            return (
              <TreeRow key={feature.id} depth={4} icon={<SketchIcon size={14} />} label={feature.name} item={`component-sketch:${component}:${feature.id}`}
                meta={solved?.dof === 0 ? 'defined' : solved?.dof != null ? `${solved.dof} free` : undefined} title={`${feature.name} · click to edit it in ${path}`}
                menu={<ItemMenu target={{ kind: 'component-sketch', component: owner, id: feature.id }} />}
                onClick={() => { openFile(path); set({ activeFeature: feature.id, selection: [] }); }} />
            );
          }) : <p className={styles.emptyHint}>No sketches.</p>}
      </BrowserGroup>
      {planes.length > 0 && (
        <BrowserGroup title="Construction" icon={<OriginIcon size={14} />} count={planes.length} depth={3} defaultOpen={false} actions={<PlanesEye rows={planes} />} {...groupMenu('construction', owner)}>
          {planes.map((row) => <PlaneItem key={row.key} row={row} depth={4} />)}
        </BrowserGroup>
      )}
      {nodes.length > 1 && (
        <BrowserGroup title="Instances" icon={<Copy size={14} />} count={nodes.length} depth={3} defaultOpen={false} {...groupMenu('instances', owner)}>
          {nodes.map((id) => <NodeRow key={id} id={id} depth={4} />)}
        </BrowserGroup>
      )}
    </div>
  );
}

/** A component (one file): click selects every placed instance, double-click or the pencil opens its file. */
function ComponentRow({ path }: { path: string }) {
  const active = useApp((state) => state.doc.activeFile === path);
  const displayed = useApp((state) => state.displayed);
  const tree = useApp((state) => state.tree);
  const rootId = useApp((state) => state.rootId);
  const selection = useApp((state) => state.selection);
  const design = designOf(displayed);
  const entry = design ? Object.entries(design.components).find(([, component]) => component.file === path) : undefined;
  const component = entry?.[0] ?? fileLabel(path);
  const summary = (entry?.[1] ?? null) as ComponentSummary | null;
  const nodes = useMemo(() => instanceNodesOf(tree, rootId, design, component), [tree, rootId, design, component]);
  const picks = useMemo(() => nodes.map((node): Pick => ({ kind: 'component', node })), [nodes]);
  const [open, setOpen] = useGroupOpen(`component:${path}`, active);
  useOnChange(active, (now) => { if (now && !open) setOpen(true); });
  const count = chosen(selection, picks);
  const shown = nodes.some((node) => isNodeVisible(tree, node));
  const name = summary?.name || fileLabel(path);
  const owner = useMemo((): ComponentRef => ({ id: component, path, name, nodes, open: active }), [component, path, name, nodes, active]);
  const setShown = (visible: boolean) => {
    if (!visible) hideNodes(nodes);
    else for (const id of nodes) if (get().tree[id]?.hidden) toggleHidden(id);
  };
  return (
    <>
      <TreeRow depth={2} icon={<span className={styles.nodeIcon} style={{ color: nodes.length ? tree[nodes[0]]?.color : undefined }}><Box size={15} strokeWidth={1.6} /></span>}
        label={name} meta={active ? 'editing' : nodes.length > 1 ? `×${nodes.length}` : undefined} testId={`component-${fileLabel(path)}`} item={`component:${component}`}
        title={`${path} · click to select${nodes.length > 1 ? ` its ${nodes.length} instances` : ''} · double-click to edit`}
        expanded={open} onToggle={() => setOpen(!open)} selected={!!picks.length && count === picks.length} partial={count > 0 && count < picks.length}
        dimmed={nodes.length > 0 && !shown}
        onClick={(event) => selectPicks(picks, additive(event))} onDoubleClick={() => openFile(path)} onContextSelect={() => selectPicks(picks, false)}
        onHover={(hovering) => setHover(hovering ? picks : null)}
        menu={<ItemMenu target={{ kind: 'component', id: component, path, name, nodes }} />}
        actions={<>
          <button type="button" className={styles.eye} data-edit-component={component} aria-label={`Edit ${name}`} title={active ? `Editing ${path}` : `Edit ${path}`}
            onClick={(event) => { event.stopPropagation(); openFile(path); }}><Pencil size={12} /></button>
          {nodes.length > 0 && shown && <SeeThroughButton nodes={nodes} name={name} handle={{ 'data-component-transparency': component }} />}
          {nodes.length > 0 && (
            <button type="button" className={styles.eye} data-hidden={!shown || undefined} data-component-visibility={component} aria-pressed={shown}
              aria-label={`${shown ? 'Hide' : 'Show'} ${name}`} onClick={(event) => { event.stopPropagation(); setShown(!shown); }}>
              {shown ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
          )}
        </>} />
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }} style={{ overflow: 'hidden' }}>
            <ComponentContents path={path} component={component} summary={summary} active={active} nodes={nodes} owner={owner} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/** A design: components (one file each) with their own bodies and sketches, the shared files, links and joints. No design-wide body list. */
function DesignStructure() {
  const doc = useApp((state) => state.doc);
  const tree = useApp((state) => state.tree);
  const canonical = useApp((state) => !!state.modeling?.canonical);
  const workspace = useApp((state) => state.workspace);
  const selection = useApp((state) => state.selection);
  const files = filesOf(doc);
  const components = Object.keys(files).filter((path) => path.startsWith('components/')).sort();
  const editing = doc.activeFile.startsWith('components/');
  // A design whose main.py builds its own cq.Assembly (e.g. a former assembly) has no component files: list what it placed.
  const instances = useApp((state) => (!components.length && state.rootId ? state.tree[state.rootId]?.children ?? NONE : NONE));
  return (
    <>
      {workspace === 'design' && editing && canonical && <ParametersGroup />}
      <BrowserGroup title="Components" icon={<Layers3 size={15} />} count={components.length || instances.length} depth={1} defaultOpen {...groupMenu('components')}>
        {components.length ? components.map((path) => <ComponentRow key={path} path={path} />)
          : instances.length ? instances.map((id) => <NodeRow key={id} id={id} depth={2} />)
            : <p className={styles.emptyHint}>Each component is its own file: add one below.</p>}
        {(components.length > 0 || !instances.length) && <AddComponentRow />}
        {PARAMS in files && <TreeRow depth={2} icon={<SlidersHorizontal size={14} />} label="Shared parameters" selected={doc.activeFile === PARAMS} title="params.py: values every component can import"
          onClick={() => openFile(PARAMS)} testId="design-parameters" item="file:params" menu={<ItemMenu target={{ kind: 'design-file', file: 'params' }} />} />}
        <TreeRow depth={2} icon={<FileCode size={14} />} label="Placement" meta="main.py" selected={doc.activeFile === MAIN} title="main.py: places the components"
          onClick={() => openFile(MAIN)} testId="design-main" item="file:main" menu={<ItemMenu target={{ kind: 'design-file', file: 'main' }} />} />
      </BrowserGroup>
      <BrowserGroup title="Links" icon={<Link2 size={15} />} count={Object.keys(doc.links).length} depth={1} defaultOpen {...groupMenu('links')}>
        {Object.entries(doc.links).map(([alias, link]) => {
          const status = doc.saved?.link_status?.[alias];
          const behind = status?.latest && link.revision && status.latest > link.revision;
          const trashed = linkTrashed(status);
          const nodes = linkNodes(alias);
          const shown = nodes.some((id) => !tree[id]?.hidden);
          return (
            <TreeRow key={alias} depth={2} icon={status?.kind === 'circuit' ? <CircuitIcon size={14} /> : <Link2 size={14} />} label={<span className={styles.mono}>{alias}</span>} testId={`link-${alias}`}
              meta={trashed ? 'in Trash' : behind ? undefined : <span className={styles.linkRevision}>rev {link.revision ?? '—'}</span>} dimmed={nodes.length > 0 && !shown}
              selected={nodes.length > 0 && chosen(selection, nodes.map((node): Pick => ({ kind: 'component', node }))) === nodes.length}
              actions={<>
                {behind && <button type="button" className={styles.updateBadge} data-update-link={alias} onClick={(event) => { event.stopPropagation(); void updateLink(alias); }}
                  title={`Take revision ${status!.latest} of ${status!.name ?? alias}`}>rev {link.revision} → {status!.latest}</button>}
                {nodes.length > 0 && shown && <SeeThroughButton nodes={nodes} name={alias} handle={{ 'data-link-transparency': alias }} />}
                {nodes.length > 0 && (
                  <button type="button" className={styles.eye} data-hidden={!shown || undefined} data-link-visibility={alias} aria-pressed={shown}
                    aria-label={`${shown ? 'Hide' : 'Show'} ${alias}`} title={`${shown ? 'Hide' : 'Show'} every placed ${alias}`}
                    onClick={(event) => { event.stopPropagation(); setLinkHidden(alias, shown); }}>
                    {shown ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                )}
              </>}
              title={`${link.component ? `${link.component} of ` : ''}${status?.name ?? alias}${status?.kind ? ` (${status.kind})` : ''} · pinned at revision ${link.revision}${trashed ? ' · in the Trash (the pinned revision keeps working; restore it from the menu)' : ''}${behind ? ' · an update is available' : ''} · click to select · double-click to edit the placement`}
              onClick={(event) => selectPicks(nodes.map((node): Pick => ({ kind: 'component', node })), additive(event))} onDoubleClick={() => openFile(MAIN)}
              onContextSelect={() => selectPicks(nodes.map((node): Pick => ({ kind: 'component', node })), false)} item={`link:${alias}`}
              onHover={(hovering) => setHover(hovering ? nodes.map((node): Pick => ({ kind: 'component', node })) : null)}
              menu={<ItemMenu target={{ kind: 'link', alias, name: status?.name ?? alias, nodes }} />} />
          );
        })}
        {!Object.keys(doc.links).length && <p className={styles.emptyHint}>Use a saved part or design here: Design → Link. It stays at the revision you link until you update it.</p>}
      </BrowserGroup>
      <JointsGroup />
      <ExplodesGroup />
      <SectionsGroup />
    </>
  );
}

/** Bodies, sketches and construction geometry of a part, like a desktop CAD browser. */
export default function ModelStructure() {
  const canonical = useApp((state) => !!state.modeling?.canonical);
  const design = useApp((state) => state.doc.kind === 'design');
  if (design) return <DesignStructure />;
  return canonical ? <ModelingStructure /> : <LegacyStructure />;
}

function LegacyStructure() {
  const rootId = useApp((state) => state.rootId);
  const bodies = useApp((state) => (state.rootId ? state.tree[state.rootId]?.children ?? NONE : NONE));
  const features = useApp((state) => state.features);
  const active = useApp((state) => state.activeFeature);
  const code = useApp((state) => state.doc.code);
  const workspace = useApp((state) => state.workspace);
  const tree = features?.state === 'ready' ? features.tree : null;
  const sketches = tree ? groupSketches(tree) : [];
  const workplanes = tree ? constructionFeatures(tree) : [];
  const planes = parsePlanes(code);

  const legacy = (feature: Feature): ItemTarget => ({ kind: 'legacy-feature', feature });
  const designParameters = tree?.design_parameters ?? [];
  return (
    <>
      {workspace === 'design' && designParameters.length > 0 && (
        <TreeRow depth={1} icon={<Variable size={15} />} label={<span className={styles.groupLabel}>Parameters</span>} meta={designParameters.length} item="parameters"
          selected={active === PARAMETERS_ID} onClick={() => openParameters()} menu={<ItemMenu target={{ kind: 'parameters' }} />} onKeyDown={(event) => itemKeyDown(event, { kind: 'parameters' })} />
      )}
      <BrowserGroup title="Bodies" icon={<Box size={15} />} count={bodies.length} depth={1} {...groupMenu('bodies')}>
        {rootId && bodies.length ? bodies.map((id) => <NodeRow key={id} id={id} depth={2} />) : <p className={styles.emptyHint}>No bodies yet.</p>}
      </BrowserGroup>
      {workspace === 'design' && sketches.length > 0 && (
        <BrowserGroup title="Sketches" icon={<LegacySketchIcon />} count={sketches.length} depth={1} defaultOpen={false} {...groupMenu('sketches')}>
          {sketches.map((sketch, index) => {
            const first = sketch.features[0];
            const Icon = featureIcon(first.operation, 'sketch');
            const detail = sketch.features.map((feature) => feature.label.replace(/\s+\d+$/, '')).filter((label, i, all) => all.indexOf(label) === i).slice(0, 3).join(', ');
            return (
              <TreeRow
                key={sketch.id}
                depth={2}
                icon={<Icon size={14} />}
                label={`Sketch ${index + 1}`}
                meta={summarize(first) || detail}
                title={`${detail}${sketch.plane ? ` · on ${sketch.plane.label}` : ''}${sketch.consumer ? ` · used by ${sketch.consumer.label}` : ''}`}
                selected={sketch.features.some((feature) => feature.id === active)}
                item={`sketch:${first.id}`}
                menu={<ItemMenu target={legacy(first)} />}
                onKeyDown={(event) => itemKeyDown(event, legacy(first))}
                onContextSelect={() => set({ activeFeature: first.id, selection: [] })}
                onClick={() => selectFeature(first)}
                onDoubleClick={() => revealSource(first)}
              />
            );
          })}
        </BrowserGroup>
      )}
      {workspace === 'design' && (planes.length > 0 || workplanes.length > 0) && (
        <BrowserGroup title="Construction" icon={<OriginIcon size={15} />} count={planes.length + workplanes.length} depth={1} defaultOpen={planes.length > 0}
          actions={<GroupEye ids={planes.map((plane) => plane.name)} label="all construction planes" isShown={planeShown} group="planes" />} {...groupMenu('construction')}>
          {planes.map((plane) => <NamedPlaneItem key={plane.name} plane={plane} />)}
          {workplanes.map((feature) => {
            const Icon = featureIcon(feature.operation, feature.category);
            const inPlane = feature.parameters.inPlane?.value;
            return (
              <TreeRow key={feature.id} depth={2} icon={<Icon size={14} />} label={feature.label} meta={typeof inPlane === 'string' ? inPlane : undefined} item={`construction:${feature.id}`}
                selected={active === feature.id} onClick={() => selectFeature(feature)} onDoubleClick={() => revealSource(feature)} onContextSelect={() => set({ activeFeature: feature.id, selection: [] })}
                menu={<ItemMenu target={legacy(feature)} />} onKeyDown={(event) => itemKeyDown(event, legacy(feature))} />
            );
          })}
        </BrowserGroup>
      )}
      <SectionsGroup />
    </>
  );
}

function LegacySketchIcon() {
  const Icon = featureIcon('polyline', 'sketch');
  return <Icon size={15} />;
}

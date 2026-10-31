/**
 * The manufacturing library: machines, controllers, tools and posts, as revisioned records
 * (docs/MANUFACTURING_API.md). Every edit appends a revision with the expected revision; a stale edit becomes a
 * clear conflict, never a silent overwrite. Forms come from the backend's schemas.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowDownUp, BookOpen, Copy, Crosshair, Download, Factory, Gauge, History, Pencil, Plus, Upload, Wrench } from 'lucide-react';
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner } from '@/ui';
import { PaneEmpty, PaneSpacer, SectionedDialog, SectionPane } from '@/ui/SectionedDialog';
import { set as setApp, toast } from '@/state/store';
import { library, mfg, MfgError, requestKey, type Kind, type LibraryRecord, type Pin } from './api';
import { definitionSchema, defaultFor, labelOf, openApi, type OpenApi } from './schema';
import SchemaForm, { type FormContext } from './SchemaForm';
import CodeArea from './CodeArea';
import { EXAMPLE_SETS, importExamples, type ExampleSet } from './examples';
import { loadLibrary, report, useMfg, type LibraryView } from './state';
import ShopPage from './shop/ShopPage';
import RecordShop from './shop/RecordShop';
import { RECORD_FORMS } from './shop/recordForms';
import { startFromPart, useLibraryIntent, type ToolKind } from './fromPart';
import { sourceOf } from './toolGeometry';
import ToolGeometryTab from './ToolGeometryTab';
import { AssemblyBuilder, AssemblySnapshotView } from './AssemblyView';
import SetupAssistant, { type BundleRow, type BundleView } from '@/setup/SetupAssistant';
import { setupOptions, type SetupBundle } from '@/setup/api';
import { bundleItems, entriesOf, newBundleId, requestKeyFor, saveOrder, toSave, type BundleEntry, type BundleState } from './setupBundle';
import { effective, fromSetupMarks, manualClaim, notesOf, payload, recordNotes, sessionOf, toSetupMarks, valueAt, type FieldSource, type PageInfo, type SourceSession } from './provenance';
import setupStyles from '@/setup/Setup.module.css';
import { GROUPS, KIND_LABELS, kindLabel } from './kinds';
import { cellText, factColumns, lookupOf } from './libraryColumns';
import { friendlyMessage } from './fieldHelp';
import LibraryTable from './LibraryTable';
import { hasPreview, KeyFacts, Preview } from './RecordPreview';
import { CutterPresets, FeedsPanel } from './presets/FeedsPanel';
import { controlsFor, type OperationCapability } from './presets/fields';
import { machineControls } from './machine/MachineFields';
import { usePresetIntent } from './presets/intent';
import TransferDialog, { useTransfer } from './interchange/TransferDialog';
import MachineBodies from './machine/MachineBodies';
import InstanceView from './machine/InstanceView';
import styles from './Manufacture.module.css';

/** Print profiles, and printer models/controllers (a `printer` section, or FFF as their only process). */
function printingOnly(record: LibraryRecord): boolean {
  const definition = record.definition as { printer?: unknown; processes?: unknown };
  if (record.kind === 'fff_profile') return true;
  if (record.kind !== 'machine_model' && record.kind !== 'controller') return false;
  const processes = Array.isArray(definition.processes) ? definition.processes : [];
  return !!definition.printer || (processes.length > 0 && processes.every((process) => process === 'fff'));
}
const pinnedId = (pin: unknown) => (pin && typeof pin === 'object' && typeof (pin as { id?: unknown }).id === 'string' ? (pin as { id: string }).id : '');

type Tab = 'details' | 'json' | 'history' | 'snapshot' | 'source' | 'geometry' | 'build' | 'bodies';

/**
 * Fields a person setting a record up rarely knows or needs (a controller's resolution or arc conventions, a machine's
 * collision coverage): shown under a collapsed "More details", with sensible values filled in for a new record. The
 * visible form leads with what's on a spec sheet. Until the contracts make these optional (requested in
 * docs/MANUFACTURING_STATUS.md), the UI supplies the defaults below.
 */
const DETAILS: Partial<Record<Kind, Set<string>>> = {
  controller: new Set(['firmware_version', 'rapid_behavior', 'linear_resolution_mm', 'spindle_speed_resolution_rpm', 'feed_resolution_mm_min', 'angular_resolution_rad', 'feed_modes', 'work_offsets', 'arc_planes', 'arc_centers',
    'radius_arcs', 'full_circle_arcs', 'tool_length_compensation', 'cutter_compensation', 'canned_cycles', 'lathe_x_convention', 'constant_surface_speed',
    'synchronous_threading', 'machine_coordinate_retract', 'tool_change']),
  machine_model: new Set(['collision_geometry', 'collision_coverage', 'cutting_heads']),
  machine_instance: new Set(['joint_overrides', 'mounting']),
};
/** Filled in by the server when left blank (app/manufacturing/api.py fill_unknowable): never required of the person. */
const FILLED: Partial<Record<Kind, Set<string>>> = { controller: new Set(['firmware_version']) };
/** Honest starting values for a new record, where the schema's own default would claim something (a 1 mm resolution,
 *  linear rapids): "unknown" where the contract allows it, the documented common value otherwise. */
const SENSIBLE: Partial<Record<Kind, Record<string, unknown>>> = {
  controller: { firmware_version: 'unknown', rapid_behavior: 'unknown', linear_resolution_mm: 0.001, work_offsets: [1] },
  // A preset's pins and limits are the person's to choose: nothing is pre-claimed.
  cutting_preset: { material: null, cutter: null, operations: [], maximum_stickout_mm: null },
};

const short = (sha: string) => sha.slice(0, 10);
/** A tool setup saves without the machine it was once made on: any machine can use it. */
const untied = (definition: Record<string, unknown>) => {
  if (definition.kind !== 'tool_setup' || !('machine' in definition)) return definition;
  const { machine: _machine, ...rest } = definition;  // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest;
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The server's field problems in plain words, keyed by the form's field paths. `definition`: what was sent. */
function errorMap(error: unknown, definition?: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (error instanceof MfgError) {
    for (const field of error.fields) {
      // Paths arrive as `definition.<kind>.<field>` (the union tag included); the form keys fields from the definition.
      const [head, ...rest] = field.path.replace(/^(body\.)?definition\./, '').split('.');
      const path = head in KIND_LABELS && rest.length ? rest.join('.') : [head, ...rest].join('.');
      map.set(path, friendlyMessage(field, valueAt(definition, path)));
    }
  }
  return map;
}

/** A save problem: plain words first, the server's own text behind "Details". */
function problemOf(error: unknown, fields: Map<string, string>): { message: string; raw?: string[] } {
  if (!(error instanceof MfgError)) return { message: (error as Error).message };
  const raw = [`${error.code}: ${error.message}`, ...error.fields.map((field) => `${field.path}${field.code ? ` (${field.code})` : ''}: ${field.message}`)];
  if (!fields.size) return { message: error.message, raw: error.fields.length ? raw : undefined };
  return { message: fields.size === 1 ? 'One field needs attention.' : `${fields.size} fields need attention.`, raw };
}

/** A revision's saved sources at a glance: fields with a source, and estimates. */
function SourceTally({ record }: { record: LibraryRecord }) {
  const fields = Object.values(record.provenance?.fields ?? {});
  const estimates = fields.filter((claim) => claim.kind === 'estimate').length;
  if (!fields.length) return <span />;
  return (
    <small className={styles.sourceTally} data-source-tally>
      {fields.length > estimates && <span>◆{fields.length - estimates}</span>}
      {estimates > 0 && <em>{estimates} estimate{estimates === 1 ? '' : 's'}</em>}
    </small>
  );
}

function Facts({ items }: { items: [string, unknown][] }) {
  const shown = items.filter(([, value]) => value !== undefined && value !== null && value !== '');
  return <dl className={styles.facts}>{shown.map(([key, value]) => <div key={key} style={{ display: 'contents' }}><dt>{key}</dt><dd>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</dd></div>)}</dl>;
}

function Checks({ checks }: { checks?: { id: string; status: string; message: string }[] }) {
  if (!checks?.length) return null;
  return <ul className={styles.checks}>{checks.map((check) => <li key={check.id} data-status={check.status}><span>{check.status}</span><span>{check.message}</span></li>)}</ul>;
}

function Snapshot({ record }: { record: LibraryRecord }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const [pose, setPose] = useState<{ nodes: [string, { origin_mm: number[] }][] } | null>(null);
  useEffect(() => {
    let live = true;
    setData(null); setError(null); setPose(null);
    const load = record.kind === 'machine_instance' ? library.machineSnapshot(record.id, record.revision)
      : library.toolSetupSnapshot(record.id, record.revision);
    load.then((value) => { if (live) setData(value); }).catch((caught) => { if (live) setError((caught as Error).message); });
    return () => { live = false; };
  }, [record.id, record.revision, record.kind]);
  if (error) return <div className={styles.banner} data-tone="danger">{error}</div>;
  if (!data) return <p className={styles.muted}><Spinner size={12} /> Resolving pinned records…</p>;
  if (record.kind === 'machine_instance') {
    const model = (data.model as { definition?: { nodes?: { id: string; kind: string; limits?: { unit: string; minimum: number; maximum: number } | null }[]; printer?: unknown } }) ?? {};
    const controller = data.controller as { definition?: { name?: string; dialect?: string } } | undefined;
    const joints = (model.definition?.nodes ?? []).filter((node) => node.kind !== 'fixed' && node.limits);
    return (
      <div>
        <h4 className={styles.subhead}>Pinned records</h4>
        <Facts items={[['Model', (data.model as { definition?: { name?: string }; revision?: number })?.definition?.name + ` · rev ${(data.model as { revision?: number })?.revision}`],
          ['Controller', `${controller?.definition?.name} · ${controller?.definition?.dialect}`], ['Snapshot', short(String(data.snapshot_sha256 ?? ''))]]} />
        {joints.length > 0 && <>
          <h4 className={styles.subhead}>Pose</h4>
          <p className={styles.muted}>Forward kinematics for a pose within the joints’ limits. It doesn’t imply a motion sequence or a collision check.</p>
          {joints.map((joint) => {
            const value = positions[joint.id] ?? Math.min(Math.max(0, joint.limits!.minimum), joint.limits!.maximum);
            return (
              <label key={joint.id} className={styles.jointRow}>
                <span>{joint.id} <small className={styles.muted}>{joint.limits!.unit}</small></span>
                <input type="range" min={joint.limits!.minimum} max={joint.limits!.maximum} step={(joint.limits!.maximum - joint.limits!.minimum) / 200} value={value}
                  aria-label={`${joint.id} position`} onChange={(event) => setPositions({ ...positions, [joint.id]: Number(event.target.value) })} />
                <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{value.toFixed(joint.limits!.unit === 'rad' ? 3 : 1)}</span>
              </label>
            );
          })}
          <Button size="sm" icon={<Gauge />} id="compute-pose" onClick={() => {
            const body = joints.map((joint) => ({ joint: joint.id, value: positions[joint.id] ?? Math.min(Math.max(0, joint.limits!.minimum), joint.limits!.maximum) }));
            library.kinematics(record, body).then((value) => setPose(value as typeof pose)).catch((caught) => report(caught, 'Pose'));
          }}>Compute pose</Button>
          {pose && (
            <table className={styles.table} style={{ marginTop: 8 }} id="pose-table">
              <thead><tr><th>Node</th><th>X mm</th><th>Y mm</th><th>Z mm</th></tr></thead>
              <tbody>{pose.nodes.map(([node, frame]) => <tr key={node}><td>{node}</td>{frame.origin_mm.map((value, index) => <td key={index}>{value.toFixed(3)}</td>)}</tr>)}</tbody>
            </table>
          )}
        </>}
        {Array.isArray((model.definition as { collision_geometry?: unknown[] } | undefined)?.collision_geometry) && (model.definition as { collision_geometry: unknown[] }).collision_geometry.length > 0 && (
          <>
            <h4 className={styles.subhead}>Collision bodies {pose ? 'at this pose' : 'at rest'}</h4>
            <InstanceView model={model.definition as never} instance={(data.instance as { definition?: { mounting?: never } } | undefined)?.definition} pose={pose?.nodes as never ?? null} />
          </>
        )}
        {model.definition?.printer ? <p className={styles.muted} style={{ marginTop: 10 }}>This machine is a printer; its build volume and extruder come from its model.</p> : null}
      </div>
    );
  }
  const assignments = (data.assignments as { assignment: { id: string; tool_number?: number }; tool: { geometry: Record<string, unknown> }; checks: { id: string; status: string; message: string }[] }[]) ?? [];
  return (
    <div>
      {assignments.map((item) => (
        <div key={item.assignment.id} className={styles.card}>
          <div className={styles.cardHead}><span>{item.assignment.id}{item.assignment.tool_number ? ` · T${item.assignment.tool_number}` : ''}</span></div>
          <Facts items={[['Cutter diameter', `${item.tool.geometry.cutter_diameter_mm} mm`], ['Gauge length', `${item.tool.geometry.gauge_length_mm} mm`]]} />
          <Checks checks={item.checks} />
        </div>
      ))}
    </div>
  );
}

export default function LibraryDialog({ open }: { open: boolean }) {
  const all = useMfg((state) => state.records);
  // 3D printing is backend-only for now (docs/MANUFACTURING_STATUS.md): its records stay in the library, out of view.
  const records = useMemo(() => {
    const printers = new Set(all.filter((record) => printingOnly(record)).map((record) => record.id));
    return all.filter((record) => !printingOnly(record) && !(record.kind === 'machine_instance' && printers.has(pinnedId(record.definition.model))));
  }, [all]);
  // The shop and the catalogue are pages of their own; everything else lists library records of a kind.
  const view = useMfg((state) => state.libraryKind);
  const page = view === 'shop' || view === 'catalogue' ? view : null;
  const kind: Kind | 'all' = page ? 'all' : view as Kind | 'all';
  const selectedId = useMfg((state) => state.librarySelect);
  const [api, setApi] = useState<OpenApi | null>(null);
  const [archived, setArchived] = useState(false);
  const [tab, setTab] = useState<Tab>('details');
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState<Kind | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [problem, setProblem] = useState<{ message: string; conflict?: LibraryRecord; raw?: string[] } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [json, setJson] = useState('');
  const [historyItems, setHistory] = useState<LibraryRecord[] | null>(null);
  const [viewing, setViewing] = useState<LibraryRecord | null>(null);
  // Set up with STEVE: the pane and the kinds it can draft.
  const [assisting, setAssisting] = useState(false);
  // The kinds STEVE drafts; null when the server couldn't say (no key yet, or a stored model it no longer offers): then
  // it's offered anyway and its panel shows why it can't start, or the models to pick from.
  const [setupKinds, setSetupKinds] = useState<Set<string> | null>(new Set());
  // While editing: where each field's value came from (saved claims, STEVE's draft, the person's own), saved with it.
  const [sources, setSources] = useState<SourceSession | null>(null);
  // Set up with STEVE, several records at once (setupBundle.ts): the drafts, which one the form shows, and save state.
  const [bundle, setBundle] = useState<BundleState | null>(null);
  const bundleRef = useRef<BundleState | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  // The last bundle, all saved: its card stays in STEVE's pane.
  const [doneBundle, setDoneBundle] = useState<BundleState | null>(null);
  // STEVE's pane keeps its conversation until the person opens another record, starts a new one or closes it.
  const [assistSession, setAssistSession] = useState(0);
  // A model or controller defined from the Machine form: the machine's draft to go back to, with the new record pinned.
  const [parent, setParent] = useState<{ kind: Kind; draft: Record<string, unknown>; field: string; base: LibraryRecord | null } | null>(null);
  const putBundle = (next: BundleState | null) => { bundleRef.current = next; setBundle(next); };
  const activeEntry = bundle?.entries.find((entry) => entry.ref === bundle.active) ?? null;

  useEffect(() => { if (open) { void loadLibrary(); openApi().then(setApi).catch((error) => report(error, 'Library')); } }, [open]);
  useEffect(() => { if (open) setupOptions().then((options) => setSetupKinds(new Set(Object.keys(options.kinds)))).catch(() => setSetupKinds(null)); }, [open]);
  // Dialects Steve can post and verify (the output interpreters the backend advertises); others come from the library.
  const [executable, setExecutable] = useState<string[]>([]);
  // The operations Steve runs and the cutter types each takes (a preset's operation choices).
  const [operations, setOperations] = useState<OperationCapability[]>([]);
  useEffect(() => {
    if (!open) return;
    mfg<{ operations?: (OperationCapability & { output_interpreters?: string[] })[] }>('/capabilities')
      .then((value) => {
        setExecutable([...new Set((value.operations ?? []).flatMap((operation) => operation.output_interpreters ?? []))]);
        setOperations(value.operations ?? []);
      })
      .catch(() => { setExecutable([]); setOperations([]); });
  }, [open]);
  useEffect(() => { setSources(null); }, [selectedId]);
  const selected = records.find((record) => record.id === selectedId) ?? null;
  const shown = viewing ?? selected;
  // Edit from the table (double-click, Enter) on a row that isn't selected yet: the draft starts once it is.
  const pendingEdit = useRef<string | null>(null);
  useEffect(() => {
    setDraft(null); setCreating(null); setErrors(new Map()); setProblem(null); setHistory(null); setViewing(null);
    putBundle(null);
    const intent = useLibraryIntent.getState().tab as Tab | null;
    useLibraryIntent.setState({ tab: null });
    if (selected) setTab(intent ?? (selected.kind === 'post_processor' ? 'source' : 'details'));
    if (selected && pendingEdit.current === selected.id) setDraft(structuredClone(selected.definition) as Record<string, unknown>);
    pendingEdit.current = null;
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dialects = useMemo(() => {
    const named = all.flatMap((record) => (record.kind === 'post_processor' && Array.isArray(record.definition.controller_dialects) ? record.definition.controller_dialects as string[]
      : record.kind === 'controller' && typeof record.definition.dialect === 'string' ? [record.definition.dialect] : []));
    return [...new Set([...executable, ...named])].map((id) => ({ id, executable: executable.includes(id) }));
  }, [all, executable]);
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const record of records) if (!record.archived) out[record.kind] = (out[record.kind] ?? 0) + 1;
    return out;
  }, [records]);
  // A machine's model belongs to the machine (picked in its form): "All" doesn't list models.
  const listed = useMemo(() => records.filter((record) => (kind === 'all' ? record.kind !== 'machine_model' : record.kind === kind) && (archived || !record.archived)), [records, kind, archived]);
  const lookup = useMemo(() => lookupOf(records), [records]);

  const editingKind = creating ?? shown?.kind ?? null;
  const schema = api && editingKind ? definitionSchema(api, editingKind) : null;
  const value = draft ?? (shown?.definition as Record<string, unknown> | undefined) ?? null;
  const readOnly = !draft || !!viewing;
  // Editing starts a source session from the record being edited (a new record has none).
  useEffect(() => {
    if (!draft) setSources(null);
    else setSources((current) => current ?? sessionOf(creating ? null : selected));
  }, [!!draft]); // eslint-disable-line react-hooks/exhaustive-deps
  // A field keeps its mark while it holds the value its source was given for: an edit by hand drops it.
  const claims = useMemo(() => (draft && sources ? effective(sources, draft) : null), [draft, sources]);
  const annotations = useMemo(() => (viewing ? recordNotes(viewing) : claims ? notesOf(claims) : draft ? undefined : shown ? recordNotes(shown) : undefined), [viewing, claims, draft, shown]);
  const setSource = (path: string, claim: FieldSource | null) => setSources((current) => (current && draft ? { ...current, manual: { ...current.manual, [path]: manualClaim(claim, draft, path) } } : current));
  // Fields with their own editor: a post's source (Source tab), a machine's collision bodies (Collision bodies tab), a bundle's links.
  // A tool setup isn't tied to a machine (a setup picks both): its old "machine" note isn't shown or saved.
  const skipped = [...(editingKind === 'post_processor' ? ['source'] : []), ...(editingKind === 'machine_model' ? ['collision_geometry', 'collision_coverage'] : []),
    ...(editingKind === 'tool_setup' ? ['machine'] : []),
    ...(activeEntry ? Object.keys(activeEntry.links) : [])];
  const skip = skipped.length ? new Set(skipped) : undefined;
  const cutterType = editingKind === 'cutting_preset' ? String(lookup.byId.get(pinnedId(value?.cutter))?.definition.cutter_type ?? '') || null : null;
  const context: FormContext | null = api ? { api, readOnly, errors, records, skip, kind: editingKind,
    onOpenPin: (pin: Pin) => { useMfg.setState({ libraryKind: pin.kind, librarySelect: pin.id }); }, annotations, onSetSource: setSource,
    dialects, details: editingKind ? DETAILS[editingKind] : undefined, filled: editingKind ? FILLED[editingKind] : undefined,
    controls: editingKind === 'machine_instance' ? machineControls(readOnly ? undefined : (target, field) => define(target, field))
      : controlsFor(editingKind, operations, cutterType) } : null;
  const sourceNotes = draft ? sources?.notes ?? null : (viewing ?? shown)?.provenance?.notes ?? null;
  const drafts = (target: string) => setupKinds === null || setupKinds.has(target);
  const canAssist = RECORD_FORMS && !!editingKind && drafts(editingKind) && !viewing && tab !== 'build';
  const assist = assisting && (canAssist || !!bundle);
  const toggleAssist = () => {
    if (!assisting && !draft && selected) setDraft(structuredClone(selected.definition) as Record<string, unknown>);
    if (!assisting) { setTab('details'); setAssistSession((n) => n + 1); setDoneBundle(null); }
    setAssisting(!assisting);
  };

  /* ───── a setup bundle: the form shows one draft at a time; Save all saves them in order ───── */
  // The form's edits, back into the draft it shows.
  const stash = (current: BundleState): BundleState => (draft && sources
    ? { ...current, entries: current.entries.map((entry) => (entry.ref === current.active && entry.state !== 'saved' ? { ...entry, definition: draft, session: sources } : entry)) }
    : current);
  const showEntry = (entry: BundleEntry) => {
    setViewing(null);
    if (entry.state === 'saved' && entry.saved) {
      // Saved already: shown as saved (read-only); Save all skips it.
      setCreating(null); setDraft(null); setSources(null); setViewing(entry.saved);
    } else {
      setCreating(entry.base ? null : entry.kind); setDraft(entry.definition); setSources(entry.session);
    }
    setErrors(entry.errors ?? new Map()); setProblem(entry.error ? { message: entry.error } : null); setTab('details');
  };
  const startBundle = (result: SetupBundle, { pages }: { pages: PageInfo }) => {
    const current = bundleRef.current ? stash(bundleRef.current) : null;
    const base = current ? current.entries.find((entry) => entry.ref === current.main)?.base ?? null : creating ? null : selected;
    const entries = entriesOf(result, pages, base, current?.entries);
    const next: BundleState = {
      id: current?.id ?? newBundleId(), kind: (current?.kind ?? editingKind) as Kind, main: result.main, notes: result.notes, entries, active: result.main,
      origin: current?.origin ?? { creating, draft, sources },
    };
    putBundle(next);
    setDoneBundle(null);
    showEntry(entries.find((entry) => entry.ref === result.main)!);
  };
  const showRecord = (ref: string) => {
    const current = bundleRef.current;
    if (!current || current.active === ref) return;
    const next = { ...stash(current), active: ref };
    putBundle(next);
    showEntry(next.entries.find((entry) => entry.ref === ref)!);
  };
  const discardBundle = () => {
    const current = bundleRef.current;
    if (!current) return;
    putBundle(null);
    setViewing(null); setCreating(current.origin.creating); setDraft(current.origin.draft); setSources(current.origin.sources);
    setErrors(new Map()); setProblem(null);
  };
  const saveAll = async () => {
    if (!bundleRef.current || savingAll) return;
    let current = stash(bundleRef.current);
    putBundle(current);
    setSavingAll(true); setErrors(new Map()); setProblem(null);
    const change = (ref: string, update: Partial<BundleEntry>) => {
      current = { ...current, entries: current.entries.map((entry) => (entry.ref === ref ? { ...entry, ...update } : entry)) };
      putBundle(current);
    };
    for (const { ref } of saveOrder(current.entries)) {
      const entry = current.entries.find((item) => item.ref === ref)!;
      if (entry.state === 'saved') continue;
      const definition = toSave(entry, current.entries);
      if (typeof definition === 'string') { change(ref, { state: 'failed', error: definition }); break; }
      const provenance = payload(entry.session, entry.definition);
      change(ref, { state: 'saving', error: undefined, errors: undefined });
      try {
        const key = await requestKeyFor(current.id, ref, definition, provenance);
        const saved = entry.base ? await library.edit(entry.base, definition, entry.base.archived, key, provenance)
          : await library.create(definition, key, provenance);
        change(ref, { state: 'saved', saved });
      } catch (error) {
        const fields = errorMap(error, definition);
        change(ref, { state: 'failed', error: problemOf(error, fields).message, errors: fields });
        current = { ...current, active: ref };
        putBundle(current);
        showEntry(current.entries.find((item) => item.ref === ref)!);
        break;
      }
    }
    await loadLibrary();
    if (current.entries.every((entry) => entry.state === 'saved')) {
      const main = current.entries.find((entry) => entry.ref === current.main)!.saved!;
      toast('success', `Saved ${current.entries.length} records`, current.entries.map((entry) => entry.saved!.definition.name).join(' · '));
      setDoneBundle(current);
      putBundle(null); setViewing(null); setDraft(null); setCreating(null); setSources(null);
      useMfg.setState({ libraryKind: main.kind, librarySelect: main.id });
    }
    setSavingAll(false);
  };
  const shownBundle = bundle ?? doneBundle;
  const bundleView: BundleView | null = shownBundle ? {
    notes: shownBundle.notes, saving: savingAll, onShow: showRecord, onSaveAll: () => void saveAll(), onDiscard: discardBundle,
    rows: (bundle ? stash(shownBundle) : shownBundle).entries.map((entry): BundleRow => {
      const definition = entry.saved?.definition ?? entry.definition;
      const claims = Object.values(effective(entry.session, entry.definition));
      const record = { ...(entry.saved ?? { id: '', revision: 0, sha256: '', archived: false, created_at: '' }), kind: entry.kind, definition } as LibraryRecord;
      const facts = factColumns(entry.kind).map((column) => cellText(column, record, lookup)).filter(Boolean).slice(0, 3);
      const linked = Object.entries(entry.links).map(([name, ref]) => {
        const target = shownBundle.entries.find((item) => item.ref === ref);
        return { label: labelOf(name), name: String(target?.definition.name ?? ref), source: target?.state === 'saved' ? 'saved' as const : 'new' as const };
      });
      const pinned = Object.entries(definition).filter(([name, value]) => !(name in entry.links) && pinnedId(value) && lookup.byId.has(pinnedId(value)))
        .map(([name, value]) => ({ label: labelOf(name), name: String(lookup.byId.get(pinnedId(value))!.definition.name), source: 'library' as const }));
      return {
        ref: entry.ref, label: KIND_LABELS[entry.kind]?.one ?? entry.kind, name: String(definition.name ?? ''), main: entry.ref === shownBundle.main,
        active: !!bundle && entry.ref === bundle.active, state: entry.state, revision: entry.saved?.revision, error: entry.error, facts,
        sourced: claims.filter((claim) => claim.kind !== 'estimate').length, estimated: claims.filter((claim) => claim.kind === 'estimate').length,
        uses: [...linked, ...pinned],
      };
    }),
  } : null;

  const select = (id: string | null) => { setAssistSession((n) => n + 1); useMfg.setState({ librarySelect: id }); };
  const editRecord = (record: LibraryRecord) => {
    // The live selection: a double-click's first click may not have re-rendered yet.
    if (record.id === useMfg.getState().librarySelect) { setCreating(null); setDraft(structuredClone(record.definition) as Record<string, unknown>); return; }
    pendingEdit.current = record.id;
    select(record.id);
  };
  const startNew = (target: Kind, prefill: Record<string, unknown> = {}) => {
    // The library is written by the shop: no record form starts here (a preset asked for opens its kind's list).
    if (!RECORD_FORMS) { useMfg.setState({ librarySelect: null, libraryKind: target }); return; }
    if (!api) return;
    const schemaFor = definitionSchema(api, target);
    if (!schemaFor) return;
    const initial = { ...(defaultFor(api, schemaFor) as Record<string, unknown>), ...structuredClone(SENSIBLE[target] ?? {}), ...prefill };
    initial.kind = target;
    initial.name = `New ${KIND_LABELS[target].one.toLowerCase()}`;
    useMfg.setState({ librarySelect: null, libraryKind: target });
    setAssistSession((n) => n + 1);
    setTimeout(() => { setCreating(target); setDraft(initial); setTab(target === 'post_processor' ? 'source' : target === 'tool_assembly' ? 'build' : 'details'); setErrors(new Map()); setProblem(null); });
  };
  // "New preset" from an operation or a cutter: start one with the cutter, material and operation already chosen.
  const presetIntent = usePresetIntent((state) => state.draft);
  useEffect(() => {
    if (!open || !api || !presetIntent) return;
    usePresetIntent.setState({ draft: null });
    startNew('cutting_preset', Object.fromEntries(Object.entries(presetIntent).filter(([, item]) => item !== null && item !== undefined)));
  }, [open, api, presetIntent]); // eslint-disable-line react-hooks/exhaustive-deps
  const fromPart = (target: ToolKind) => startFromPart(target);
  const newItems = (item: Kind) => (item === 'rotary_cutter' || item === 'tool_holder'
    ? [<MenuItem key={item} onSelect={() => startNew(item)} hint="Diameters and lengths you enter">{KIND_LABELS[item].one} (parametric)</MenuItem>,
      <MenuItem key={`${item}-part`} icon={<Crosshair size={14} />} onSelect={() => fromPart(item)} hint="A saved STEVE part or imported vendor STEP; pick its frames">{KIND_LABELS[item].one} from part…</MenuItem>]
    : [<MenuItem key={item} onSelect={() => startNew(item)}>{KIND_LABELS[item].one}</MenuItem>]);
  /** From the Machine form: define a model or controller, then come back to the machine with it pinned. */
  const define = (target: Kind, field: string) => {
    if (!draft || !editingKind) return;
    setParent({ kind: editingKind, draft: structuredClone(draft), field, base: creating ? null : selected });
    startNew(target);
  };
  /** Back to the machine being edited, with `pin` (the record just defined) in its field, or as it was. */
  const backToParent = (pin: Pin | null) => {
    if (!parent) return;
    const restored = pin ? { ...parent.draft, [parent.field]: pin } : parent.draft;
    const { kind: parentKind, base } = parent;
    setParent(null);
    useMfg.setState({ libraryKind: parentKind, librarySelect: base?.id ?? null });
    setTimeout(() => { setCreating(base ? null : parentKind); setDraft(restored); setTab('details'); setErrors(new Map()); setProblem(null); });
  };
  const save = async (base: LibraryRecord | null = selected) => {
    if (!draft) return;
    setBusy(true); setErrors(new Map()); setProblem(null);
    try {
      const definition = untied(draft);
      const provenance = payload(sources, definition);
      const saved = creating ? await library.create(definition, requestKey(`create-${creating}`), provenance)
        : await library.edit(base!, definition, base!.archived, requestKey(`edit-${base!.kind}`), provenance);
      await loadLibrary();
      toast('success', creating ? 'Created' : 'Saved', `${saved.definition.name} · revision ${saved.revision}`);
      if (parent && creating) { backToParent({ id: saved.id, revision: saved.revision, kind: saved.kind, sha256: saved.sha256 }); return; }
      useMfg.setState({ librarySelect: saved.id });
      setDraft(null); setCreating(null);
    } catch (error) {
      if (error instanceof MfgError && error.status === 409 && base) {
        const latest = await library.get(base.id).catch(() => null);
        setProblem({ message: `Revision ${latest?.revision ?? '?'} was saved after the revision you edited (${base.revision}).`, conflict: latest ?? undefined });
      } else {
        const fields = errorMap(error, draft);
        setErrors(fields);
        setProblem(problemOf(error, fields));
        setShowRaw(false);
      }
    } finally { setBusy(false); }
  };
  const archive = async (record: LibraryRecord, flag: boolean) => {
    try {
      await library.edit(record, record.definition, flag, requestKey('archive'));
      await loadLibrary();
      toast('success', flag ? 'Archived' : 'Restored', `${record.definition.name}${flag ? ' is hidden from lists. Saved programs that pin it still work.' : ' is back in the list.'}`);
    } catch (error) { report(error, flag ? 'Couldn’t archive' : 'Couldn’t restore'); }
  };
  const duplicate = (record: LibraryRecord) => {
    const copy = structuredClone(record.definition) as Record<string, unknown>;
    copy.name = `${record.definition.name} (copy)`;
    useMfg.setState({ librarySelect: null, libraryKind: record.kind });
    setAssistSession((n) => n + 1);
    // The copy keeps the sources of the values it copies; to the server they're new claims.
    setTimeout(() => { setCreating(record.kind); setSources(sessionOf(record, true)); setDraft(copy); setTab(record.kind === 'post_processor' ? 'source' : 'details'); });
  };
  const loadHistory = async (record: LibraryRecord) => {
    setHistory(null);
    try { setHistory((await library.history(record.id)).slice().reverse()); } catch (error) { report(error, 'History'); }
  };
  useEffect(() => { if (tab === 'history' && selected && !historyItems) void loadHistory(selected); }, [tab, selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'json') setJson(JSON.stringify(value ?? {}, null, 2)); }, [tab, shown?.id, shown?.revision, creating, !!draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const examples = async (set: ExampleSet) => {
    setBusy(true);
    try {
      const made = await importExamples(set);
      await loadLibrary();
      toast('success', 'Examples added', `${made.length} record${made.length === 1 ? '' : 's'} ready. They’re reference fixtures, not qualified equipment.`);
    } catch (error) { report(error, 'Couldn’t add the examples'); }
    finally { setBusy(false); }
  };
  const close = () => setApp({ dialog: null });
  const snapshotKinds: Kind[] = ['machine_instance', 'tool_assembly', 'tool_setup'];
  const tabs: [Tab, string][] = [
    ...(editingKind === 'post_processor' ? [['source', 'Source'] as [Tab, string]] : []),
    ...(RECORD_FORMS && editingKind === 'tool_assembly' && !viewing ? [['build', 'Build'] as [Tab, string]] : []),
    ['details', 'Details'], ...(editingKind === 'machine_model' ? [['bodies', 'Collision bodies'] as [Tab, string]] : []), ['json', 'JSON'],
    ...(shown && !creating && sourceOf(shown) ? [['geometry', 'Geometry'] as [Tab, string]] : []),
    ...(shown && !creating && snapshotKinds.includes(shown.kind) ? [['snapshot', shown.kind === 'machine_instance' ? 'Snapshot & pose' : shown.kind === 'tool_assembly' ? 'Assembly' : 'Snapshot'] as [Tab, string]] : []),
    ...(selected && !creating ? [['history', 'History'] as [Tab, string]] : []),
  ];

  const newMenu = kind === 'all' ? (
    <Menu>
      <MenuTrigger asChild><Button size="sm" icon={<Plus />} id="new-record" disabled={!api}>New</Button></MenuTrigger>
      <MenuContent>{GROUPS.map((group, index) => [index > 0 ? <MenuSeparator key={`sep-${group.title}`} /> : null, ...group.kinds.flatMap(newItems)])}</MenuContent>
    </Menu>
  ) : kind === 'machine_instance' ? (
    // A machine: STEVE drafts its model, controller and the machine from a model number or spec sheet (the person
    // reviews and saves), or the person fills in the form.
    <Menu>
      <MenuTrigger asChild><Button size="sm" icon={<Plus />} id="new-record" disabled={!api}>New machine</Button></MenuTrigger>
      <MenuContent>
        {drafts('machine_instance') && <MenuItem onSelect={() => { startNew('machine_instance'); setTimeout(() => setAssisting(true)); }} hint="From the model number or spec sheet: you review and save">Set up with STEVE</MenuItem>}
        <MenuItem onSelect={() => startNew('machine_instance')} hint="Pick its model and controller, then its serial and options">Add manually</MenuItem>
      </MenuContent>
    </Menu>
  ) : kind === 'rotary_cutter' || kind === 'tool_holder' ? (
    <Menu>
      <MenuTrigger asChild><Button size="sm" icon={<Plus />} id="new-record" disabled={!api}>New</Button></MenuTrigger>
      <MenuContent>{newItems(kind)}</MenuContent>
    </Menu>
  ) : <Button size="sm" icon={<Plus />} id="new-record" disabled={!api} onClick={() => startNew(kind)}>New</Button>;
  const editing = !!draft || !!creating || tab === 'build';
  // Browsing a record: its preview and key facts above the tabs (not while a tab shows the same tool bigger).
  const browsing = !!shown && !draft && !creating && !viewing && tab !== 'build';
  const previewShown = browsing && hasPreview(shown!) && !(tab === 'geometry' || (tab === 'snapshot' && shown!.kind === 'tool_assembly'));

  return (
    <SectionedDialog open={open} onOpenChange={(value) => { if (!value) close(); }} icon={<Wrench size={18} />} title="Manufacturing library"
      description="Your machines, controllers and tools as code, Steve’s catalogue to start from, and the library records your shop writes. Saved programs keep what they were made with."
      id="mfg-library" className={styles.library} navLabel="Library kinds" active={page ?? 'all'} onSelect={(item) => useMfg.setState({ libraryKind: item as LibraryView })}
      rootAttrs={page ? { 'data-page': page } : { 'data-assist': assist || undefined, 'data-editing': (editing && !assist) || undefined }} detailOpen={!page && !!(shown || creating)}
      nav={[
        { items: [
          { id: 'shop', label: 'Your shop', icon: <Factory size={14} />, attrs: { 'data-page': 'shop' } },
          { id: 'catalogue', label: 'Steve’s catalogue', icon: <BookOpen size={14} />, attrs: { 'data-page': 'catalogue' } },
        ] },
        // The records, one entry: their kind is a filter inside the view (less to read than a list of every kind).
        { items: [{ id: 'all', label: 'All records', count: records.filter((record) => !record.archived).length, attrs: { 'data-kind': 'all' } }] },
      ]}
      navFooter={page ? undefined : (
        <>
          <label className={styles.muted} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />Show archived</label>
          <Menu>
            <MenuTrigger asChild><Button size="sm" icon={<ArrowDownUp />} id="library-transfer">{RECORD_FORMS ? 'Import / export' : 'Export'}</Button></MenuTrigger>
            <MenuContent>
              {RECORD_FORMS && <MenuItem icon={<Upload size={14} />} onSelect={() => useTransfer.setState({ mode: 'import' })} hint="A STEVE library file or a vendor spreadsheet, reviewed before it’s saved">Import…</MenuItem>}
              <MenuItem icon={<Download size={14} />} onSelect={() => useTransfer.setState({ mode: 'export' })} hint="The selected record, this list or everything, as a library file or spreadsheet">Export…</MenuItem>
            </MenuContent>
          </Menu>
          {RECORD_FORMS && (
          <Menu>
            <MenuTrigger asChild><Button size="sm" icon={<Download />} disabled={busy} id="import-examples">Add examples</Button></MenuTrigger>
            <MenuContent>{EXAMPLE_SETS.map((set) => <MenuItem key={set.id} onSelect={() => void examples(set.id)} hint={set.description}>{set.label}</MenuItem>)}</MenuContent>
          </Menu>
          )}
        </>
      )}
      after={(
        <>
          {editingKind && !schema && api && <p className={styles.muted}>{labelOf(editingKind)} has no schema on this server.</p>}
          <TransferDialog records={records} kind={kind} selected={selected} api={api} />
        </>
      )}>
      {page ? <ShopPage page={page} /> : <>
        <LibraryTable kind={kind} records={listed} lookup={lookup} api={api} selectedId={selectedId} creating={creating ? String(draft?.name ?? 'New record') : null}
          tools={<>
            <select id="library-kind" className={styles.kindFilter} aria-label="Kind" value={kind} onChange={(event) => useMfg.setState({ libraryKind: event.target.value as LibraryView, librarySelect: null })}>
              <option value="all" data-kind="all">Every kind</option>
              {GROUPS.map((group) => (
                <optgroup key={group.title} label={group.title}>
                  {group.kinds.map((item) => <option key={item} value={item} data-kind={item}>{KIND_LABELS[item].many} ({counts[item] ?? 0})</option>)}
                </optgroup>
              ))}
            </select>
            {RECORD_FORMS && newMenu}
          </>} onSelect={select} onEdit={RECORD_FORMS ? editRecord : (record) => select(record.id)}
          empty={kind === 'all' || !records.some((record) => !record.archived)
            ? (RECORD_FORMS ? 'The library is empty. Add the examples to start with a reference mill, tools and a post, or create a record with New.'
              : 'The library is empty. Add your machines and tools in Your shop: building it fills the library.')
            : `No ${KIND_LABELS[kind].many.toLowerCase()} yet.${RECORD_FORMS ? ' Create one with New, or import them.' : ' Add them in Your shop.'}`} />
        <SectionPane label="Record details" overlay
          empty={!shown && !creating ? <PaneEmpty icon={<Wrench size={22} />} hint={RECORD_FORMS ? 'Double-click a row, or press Enter, to edit it.' : 'Records are written by your shop: change them there.'}>Choose a record to see it here{RECORD_FORMS ? ', or create one with New' : ''}.</PaneEmpty> : undefined}
          onBack={() => { if (bundle) discardBundle(); else if (parent && creating) backToParent(null); else if (creating) { setDraft(null); setCreating(null); } else select(null); }} backLabel={parent && creating ? 'Back to the machine' : 'Back to the list'}
          title={<>{String(value?.name ?? '')}{viewing ? ` — revision ${viewing.revision}` : ''}</>}
          subtitle={shown || creating ? (creating ? `New ${KIND_LABELS[creating].one.toLowerCase()}` : `${kindLabel(shown!.kind).one} · revision ${shown!.revision} · ${when(shown!.created_at)} · ${short(shown!.sha256)}`) : undefined}
          actions={(
            <>
                {viewing && <Button size="sm" onClick={() => setViewing(null)}>Back to latest</Button>}
                {parent && creating && <Button size="sm" id="back-to-machine" onClick={() => backToParent(null)}>Back to the machine</Button>}
                {canAssist && (
                  <button type="button" className={setupStyles.toggle} id="setup-toggle" aria-pressed={assist} onClick={toggleAssist}
                    title={assist ? 'Close STEVE' : 'STEVE researches it and fills the form as a draft; you review and save'}>
                    <span className={setupStyles.steveMark}>S</span>Set up with STEVE
                  </button>
                )}
            </>
          )}
          before={(
            <>
              {browsing && (
                <div className={styles.overview}>
                  {previewShown && <Preview key={`${shown!.id}:${shown!.revision}`} record={shown!} onOpenGeometry={() => setTab('geometry')} />}
                  <KeyFacts record={shown!} lookup={lookup} />
                  {shown!.kind === 'cutting_preset' && <FeedsPanel key={`${shown!.id}:${shown!.revision}`} record={shown!} />}
                  {shown!.kind === 'rotary_cutter' && <CutterPresets key={shown!.id} record={shown!} />}
                </div>
              )}
            </>
          )}
          tabs={tabs.map(([id, label]) => ({ id, label }))} tab={tab} onTab={(id) => setTab(id as Tab)}
          footer={(
            <>
                {tab === 'build' ? (
                  <span className={styles.muted}>The builder saves its own revisions. Every save is checked and assembled on the server.</span>
                ) : bundle ? (
                  <>
                    <Button size="sm" onClick={discardBundle} disabled={savingAll} id="bundle-discard">Discard setup</Button>
                    <PaneSpacer />
                    <span className={styles.muted}>{bundle.entries.length} records · saved together, in order</span>
                    <Button size="sm" variant="primary" disabled={savingAll} id="save-all-records" onClick={() => void saveAll()}>
                      {savingAll ? 'Saving…' : `Save all (${bundle.entries.filter((entry) => entry.state !== 'saved').length})`}
                    </Button>
                  </>
                ) : draft ? (
                  <>
                    <Button size="sm" onClick={() => { setDraft(null); setCreating(null); setErrors(new Map()); setProblem(null); }}>Cancel</Button>
                    <PaneSpacer />
                    <Button size="sm" variant="primary" disabled={busy} id="save-record" onClick={() => void save(selected)}>{busy ? 'Saving…' : creating ? 'Create' : `Save revision ${(selected?.revision ?? 0) + 1}`}</Button>
                  </>
                ) : viewing ? (
                  <>
                    <PaneSpacer />
                    {RECORD_FORMS && <Button size="sm" icon={<History />} id="restore-revision" onClick={() => {
                      // That revision's sources come along; saved over the latest, so an empty set must still clear its sources.
                      setSources({ ...sessionOf(viewing), had: !!(viewing.provenance || selected?.provenance) });
                      setDraft(structuredClone(viewing.definition) as Record<string, unknown>); setViewing(null);
                    }}>Edit from this revision</Button>}
                  </>
                ) : selected && !RECORD_FORMS ? <RecordShop record={selected} /> : selected && (
                  <>
                    <Button size="sm" icon={selected.archived ? <ArchiveRestore /> : <Archive />} id="archive-record" onClick={() => void archive(selected, !selected.archived)}>{selected.archived ? 'Restore' : 'Archive'}</Button>
                    <Button size="sm" icon={<Copy />} id="duplicate-record" onClick={() => duplicate(selected)}>Duplicate</Button>
                    <PaneSpacer />
                    <Button size="sm" variant="primary" icon={<Pencil />} id="edit-record" onClick={() => setDraft(structuredClone(selected.definition) as Record<string, unknown>)}>Edit</Button>
                  </>
                )}
            </>
          )}>
                {problem && (
                  <div className={styles.banner} data-tone={problem.conflict ? 'warning' : 'danger'} role="alert" id="library-problem">
                    <div>
                      <b>{problem.conflict ? 'Saved elsewhere first. ' : 'Not saved. '}</b>{problem.message}
                      {errors.size > 0 && <ul>{[...errors].map(([path, message]) => <li key={path}><b>{path ? path.split('.').map((part) => (/^\d+$/.test(part) ? `#${Number(part) + 1}` : labelOf(part))).join(' › ') : 'The record'}</b>: {message}</li>)}</ul>}
                      {problem.raw && (
                        <div className={styles.rawProblem}>
                          <button type="button" className={styles.linkButton} aria-expanded={showRaw} onClick={() => setShowRaw(!showRaw)} id="problem-details">{showRaw ? 'Hide details' : 'Details'}</button>
                          {showRaw && <pre data-selectable>{problem.raw.join('\n')}</pre>}
                        </div>
                      )}
                      {problem.conflict && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <Button size="sm" onClick={() => { void loadLibrary(); setDraft(null); setProblem(null); }}>Discard mine, reload theirs</Button>
                          <Button size="sm" variant="primary" id="save-on-top" onClick={() => { const latest = problem.conflict!; useMfg.setState({ records: records.map((record) => (record.id === latest.id ? latest : record)) }); setProblem(null); void save(latest); }}>Save mine on top</Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {tab === 'source' && value && (
                  <>
                    <p className={styles.muted} style={{ marginBottom: 8 }}>A post translates Steve’s canonical motion into a machine’s NC files (format <code>steve_javascript_v1</code>). It never runs in the browser or on save; it runs in an isolated container when a CNC job is posted, and its output is reported as generated, not verified.</p>
                    <CodeArea value={String(value.source ?? '')} readOnly={readOnly} label="Post source" onChange={(text) => setDraft({ ...(draft ?? value), source: text })} />
                  </>
                )}
                {tab === 'details' && activeEntry && Object.keys(activeEntry.links).length > 0 && (
                  <div className={styles.bundleLinks} id="bundle-links">
                    {Object.entries(activeEntry.links).map(([name, ref]) => {
                      const target = bundle!.entries.find((entry) => entry.ref === ref);
                      return (
                        <div key={name} className={styles.bundleLink}>
                          <span className={styles.fieldLabel}>{labelOf(name)}</span>
                          <span><b>{String(target?.definition.name ?? ref)}</b> · {target?.state === 'saved' ? `saved, revision ${target.saved?.revision}` : 'drafted in this setup, saved first'}</span>
                          <Button size="sm" variant="ghost" onClick={() => showRecord(ref)}>Show</Button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {tab === 'details' && schema && value && context && <SchemaForm schema={schema} value={value} context={context} onChange={setDraft} />}
                {tab === 'details' && editingKind === 'machine_model' && value && (
                  <p className={styles.muted} style={{ marginTop: 8 }} id="bodies-summary">
                    Collision bodies: {Array.isArray(value.collision_geometry) ? value.collision_geometry.length : 0}.{' '}
                    <button type="button" className={styles.linkButton} onClick={() => setTab('bodies')}>Show them in 3D</button>
                  </p>
                )}
                {tab === 'bodies' && value && (
                  <MachineBodies key={creating ? 'new' : shown?.id} definition={value} readOnly={readOnly} saved={!draft} errors={errors} onChange={setDraft}
                    onEdit={() => {
                      if (!RECORD_FORMS || viewing || !selected) return null;
                      const copy = structuredClone(selected.definition) as Record<string, unknown>;
                      setDraft(copy);
                      return copy;
                    }} />
                )}
                {tab === 'details' && value && (draft ? !!sources : !!sourceNotes) && (
                  <div className={styles.sourceNotes} id="source-notes">
                    <span className={styles.fieldLabel}>Notes on sources</span>
                    {draft && !viewing
                      ? <textarea className={styles.textarea} rows={2} value={sources?.notes ?? ''} aria-label="Notes on sources" maxLength={4096}
                          placeholder="Assumptions, the variant described, what still needs checking"
                          onChange={(event) => setSources((current) => (current ? { ...current, notes: event.target.value || null } : current))} />
                      : <p className={styles.readValue}>{sourceNotes}</p>}
                  </div>
                )}
                {tab === 'json' && value && (
                  <CodeArea value={json} readOnly={readOnly} label="Definition JSON" onChange={(text) => {
                    setJson(text);
                    try { setDraft(JSON.parse(text)); setErrors(new Map()); } catch { /* keep typing */ }
                  }} />
                )}
                {tab === 'snapshot' && selected && (selected.kind === 'tool_assembly'
                  ? <AssemblySnapshotView key={`${selected.id}:${selected.revision}`} record={selected} />
                  : <Snapshot key={`${selected.id}:${selected.revision}`} record={selected} />)}
                {tab === 'geometry' && shown && <ToolGeometryTab key={`${shown.id}:${shown.revision}`} record={shown} />}
                {tab === 'build' && (creating === 'tool_assembly' || selected?.kind === 'tool_assembly') && (
                  <AssemblyBuilder key={creating ? 'new' : `${selected!.id}:${selected!.revision}`} record={creating ? null : selected}
                    onSaved={(saved) => { if (creating) { useLibraryIntent.setState({ tab: 'build' }); setCreating(null); setDraft(null); useMfg.setState({ librarySelect: saved.id }); } }} />
                )}
                {tab === 'history' && (
                  historyItems === null ? <p className={styles.muted}><Spinner size={12} /> Loading revisions…</p> : (
                    <div className={styles.history} id="library-history">
                      {historyItems.map((item) => (
                        <button key={item.revision} type="button" className={styles.historyRow} data-revision={item.revision} onClick={() => { setViewing(item.revision === selected?.revision ? null : item); setTab('details'); }}>
                          <b>rev {item.revision}</b><span>{when(item.created_at)}{item.archived ? ' · archived' : ''}{item.revision === selected?.revision ? ' · latest' : ''}</span>
                          <SourceTally record={item} /><code>{short(item.sha256)}</code>
                        </button>
                      ))}
                    </div>
                  )
                )}
        </SectionPane>
        {assist && (
          <SetupAssistant key={assistSession} kind={bundle?.kind ?? editingKind!} draft={value} provenance={toSetupMarks(claims ?? {})} notes={sources?.notes ?? null}
            onBundle={startBundle} bundle={bundleView} bundleItems={bundle ? bundleItems(stash(bundle)) : null}
            onDraft={(definition, marks, { pages, notes }) => {
              const base = sources ?? sessionOf(creating ? null : selected);
              const known = Object.fromEntries([...Object.entries(base.saved), ...Object.entries(base.steve)].flatMap(([path, bound]) => (bound.claim ? [[path, bound.claim]] : [])));
              setSources({ ...base, steve: fromSetupMarks(marks, definition, pages, { ...known, ...(claims ?? {}) }), notes });
              setDraft(definition); setTab('details'); setErrors(new Map()); setProblem(null);
            }}
            onClose={() => setAssisting(false)} />
        )}
      </>}
    </SectionedDialog>
  );
}

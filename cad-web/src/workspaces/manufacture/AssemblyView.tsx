/**
 * Tool assemblies: the builder (holder stack with adapters, cutter, explicit geometry pins, stick-out) and the
 * assembled tool rendered from the server's snapshot — every part-backed component's display mesh placed by its
 * frame in tip coordinates (sha256-checked), parametric components revolved from their profile, the checked
 * envelope around it all, and the readouts and checks exactly as the snapshot states them.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, Trash2, Wrench } from 'lucide-react';
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, NumberField, Spinner } from '@/ui';
import { toast } from '@/state/store';
import { library, MfgError, pinOf, requestKey, type LibraryRecord, type Pin } from './api';
import { loadLibrary, useMfg } from './state';
import {
  displayGeometry, frameMatrix, mm, regionPoints, sourceOf, toolJobs, useChosenPins,
  type AssemblySnapshot, type Check, type GeometryPin,
} from './toolGeometry';
import { newestSuccess, useToolJobs } from './ToolGeometryTab';
import ToolView, { LEGEND, type ViewMesh, type ViewShell } from './ToolView';
import styles from './ToolPart.module.css';
import mfgStyles from './Manufacture.module.css';

const ROLE_SHELL: Record<string, ViewShell['role']> = { cutter: 'cutter', shank: 'shank', holder: 'holder' };

export function Readouts({ geometry }: { geometry: AssemblySnapshot['geometry'] }) {
  const items: [string, string, number | null | undefined, string][] = [
    ['gauge_length_mm', 'Gauge length', geometry.gauge_length_mm, mm(geometry.gauge_length_mm)],
    ['stickout_mm', 'Stick-out', geometry.stickout_mm, mm(geometry.stickout_mm)],
    ['engagement_mm', 'Engagement', geometry.engagement_mm, mm(geometry.engagement_mm)],
    ['cutter_diameter_mm', 'Cutter Ø', geometry.cutter_diameter_mm, mm(geometry.cutter_diameter_mm)],
    ['maximum_diameter_mm', 'Largest Ø', geometry.maximum_diameter_mm, mm(geometry.maximum_diameter_mm)],
    ['dimensional_uncertainty_mm', 'Uncertainty', geometry.dimensional_uncertainty_mm ?? 0, `± ${mm(geometry.dimensional_uncertainty_mm ?? 0, 4)}`],
    ['max_rpm', 'Max speed', geometry.max_rpm, geometry.max_rpm ? `${geometry.max_rpm} rpm` : 'unrated'],
    ['mass_kg', 'Mass', geometry.mass_kg, geometry.mass_kg ? `${geometry.mass_kg} kg` : 'unknown'],
  ];
  return (
    <div className={styles.readouts} id="assembly-readouts">
      {items.map(([key, label, value, text]) => <div key={key} className={styles.readout} data-readout={key} data-value={value ?? ''}><span>{label}</span><b>{text}</b></div>)}
    </div>
  );
}

function Checks({ checks }: { checks: Check[] }) {
  return <ul className={mfgStyles.checks} id="assembly-checks">{checks.map((check) => <li key={check.id} data-status={check.status} data-check={check.id}><span>{check.status}</span><span>{check.message}</span></li>)}</ul>;
}

/** A snapshot's part meshes placed by frame (sha256-checked) and its regions as solids (parametric) and envelopes. */
export function useAssembledShapes(snapshot: AssemblySnapshot | null) {
  const geometry = snapshot?.geometry;
  const [meshes, setMeshes] = useState<ViewMesh[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const parts = useMemo(() => geometry?.placements.filter((placement) => placement.part && placement.geometry) ?? [], [geometry]);
  useEffect(() => {
    let live = true;
    setMeshes([]); setProblem(null);
    Promise.all(parts.map(async (placement) => {
      const part = placement.part!;
      const loaded = await displayGeometry(placement.geometry!.job_id, part.display);
      const cutting = part.regions.find((region) => region.role === 'cutter');
      return { key: placement.id, geometry: loaded, matrix: frameMatrix(placement.frame), cutting: cutting ? [cutting.z_min_mm, cutting.z_max_mm] as [number, number] : null, role: placement.id === 'cutter' ? 'cutter' as const : 'holder' as const };
    })).then((value) => { if (live) setMeshes(value); }).catch((error) => { if (live) setProblem((error as Error).message); });
    return () => { live = false; };
  }, [snapshot?.snapshot_sha256]); // eslint-disable-line react-hooks/exhaustive-deps
  const shells = useMemo(() => {
    const out: ViewShell[] = [];
    const meshBacked = new Set(parts.map((placement) => placement.id));
    for (const region of geometry?.regions ?? []) {
      const points = regionPoints(region.segment);
      // Parametric components have no mesh: their profile is the component. Every region also shows as envelope.
      if (!meshBacked.has(region.component)) out.push({ key: `solid:${region.id}`, points, role: ROLE_SHELL[region.role], solid: true });
      out.push({ key: `env:${region.id}`, points, role: ROLE_SHELL[region.role] });
    }
    return out;
  }, [geometry]); // eslint-disable-line react-hooks/exhaustive-deps
  return { meshes, shells, parts, problem };
}

/** The assembled tool from a saved assembly's snapshot. */
export function AssembledView({ snapshot }: { snapshot: AssemblySnapshot }) {
  const geometry = snapshot.geometry;
  const { meshes, shells, parts, problem } = useAssembledShapes(snapshot);
  const uncertainty = geometry.dimensional_uncertainty_mm ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} id="assembled-tool" data-placements={geometry.placements.length} data-part-placements={parts.length} data-resolver={geometry.resolver}>
      {problem && <div className={styles.callout} data-tone="danger" role="alert">{problem}</div>}
      <ToolView id="assembled-view" tall meshes={meshes} shells={shells} spinDefault planes={[{ key: 'gauge', z: geometry.gauge_length_mm, color: '#38bdf8' }]}
        loading={meshes.length < parts.length && !problem ? `Placing ${parts.length} part mesh${parts.length === 1 ? '' : 'es'}…` : null}
        note={<>Tip at the origin · gauge line at {mm(geometry.gauge_length_mm)} · {parts.length} part mesh{parts.length === 1 ? '' : 'es'} placed by frame{geometry.placements.length > parts.length ? `, ${geometry.placements.length - parts.length} drawn from profile` : ''}</>} />
      <p className={styles.uncertainty} id="assembly-uncertainty">
        {parts.length ? <>Shown: your parts. Checked: their revolved envelopes (≤ {mm(uncertainty, 4)}, conservative).</> : <>Shown and checked: the parametric profiles.</>}
        <small>Clearance, clamping and holder checks use the envelope, which encloses each part as it turns. Physical qualification is {geometry.physical_qualification}.</small>
      </p>
      <div className={styles.legend}>{LEGEND.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>
      <Readouts geometry={geometry} />
      <Checks checks={geometry.checks} />
    </div>
  );
}

/** Loads and shows a saved assembly revision. */
export function AssemblySnapshotView({ record }: { record: LibraryRecord }) {
  const [snapshot, setSnapshot] = useState<AssemblySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(null); setError(null);
    toolJobs.snapshot(record.id, record.revision).then((value) => { if (live) setSnapshot(value); }).catch((caught) => { if (live) setError((caught as Error).message); });
    return () => { live = false; };
  }, [record.id, record.revision]);
  if (error) return <div className={styles.callout} data-tone="danger" role="alert">{error}</div>;
  if (!snapshot) return <p className={mfgStyles.muted}><Spinner size={12} /> Resolving pinned records…</p>;
  return <AssembledView snapshot={snapshot} />;
}

// ── Builder ──────────────────────────────────────────────────────────────────

interface Use { id: string; holder: Pin; geometry: GeometryPin | null }
interface Draft { name: string; description: string; dimension_source: string; holders: Use[]; cutter: Pin | null; cutter_geometry: GeometryPin | null; stickout_mm: number }

function draftOf(record: LibraryRecord | null): Draft {
  const d = (record?.definition ?? {}) as Record<string, unknown>;
  return {
    name: String(d.name ?? 'New tool assembly'), description: String(d.description ?? ''), dimension_source: String(d.dimension_source ?? 'catalog'),
    holders: ((d.holders as Use[] | undefined) ?? []).map((use) => ({ id: use.id, holder: use.holder, geometry: use.geometry ?? null })),
    cutter: (d.cutter as Pin | undefined) ?? null, cutter_geometry: (d.cutter_geometry as GeometryPin | undefined) ?? null, stickout_mm: Number(d.stickout_mm ?? 20),
  };
}

/** A shell or face mill on an arbor: it seats on the arbor face, so its body height is its stick-out. */
const faceMounted = (cutter: LibraryRecord | undefined) => cutter?.definition.mounting === 'face';

function definitionOf(draft: Draft, face: boolean): Record<string, unknown> {
  return {
    version: 1, kind: 'tool_assembly', name: draft.name.trim() || 'Tool assembly', description: draft.description, dimension_source: draft.dimension_source,
    holders: draft.holders.map((use) => ({ id: use.id, holder: use.holder, ...(use.geometry ? { geometry: use.geometry } : {}) })),
    cutter: draft.cutter, ...(draft.cutter_geometry ? { cutter_geometry: draft.cutter_geometry } : {}), ...(face ? {} : { stickout_mm: draft.stickout_mm }),
  };
}

/** Explicit pin of one successful geometry job for a part-backed component revision. */
function PinPicker({ component, value, onChange }: { component: LibraryRecord | undefined; value: GeometryPin | null; onChange: (pin: GeometryPin | null) => void }) {
  const { items } = useToolJobs(component && sourceOf(component) ? component : null);
  const chosen = useChosenPins((pins) => (component ? pins[`${component.id}:${component.revision}`] : undefined));
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});
  const succeeded = (items ?? []).filter((job) => job.status === 'succeeded');
  const newest = newestSuccess(items);
  useEffect(() => {
    // A job id alone isn't a pin: read each result's immutable snapshot identity.
    let live = true;
    for (const job of succeeded) if (!snapshots[job.id]) toolJobs.resolution(job.id).then((value) => { if (live) setSnapshots((current) => ({ ...current, [job.id]: value.pin.snapshot_sha256 })); }).catch(() => {});
    return () => { live = false; };
  }, [succeeded.map((job) => job.id).join()]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!value && chosen) onChange(chosen); }, [chosen?.job_id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!component || !sourceOf(component)) return <p className={mfgStyles.muted} style={{ margin: 0 }}>Parametric: drawn and checked from its profile.</p>;
  if (items === null) return <p className={mfgStyles.muted} style={{ margin: 0 }}><Spinner size={11} /> Geometry jobs…</p>;
  if (!succeeded.length) return <p className={styles.fieldHint} data-tone="warning" style={{ margin: 0 }}>No resolved geometry for revision {component.revision}: open it in the library and resolve it first.</p>;
  return (
    <div className={styles.pinChoice} data-pin-picker={component.id}>
      {succeeded.map((job) => (
        <button key={job.id} type="button" data-job={job.id} data-newest={job.id === newest?.id || undefined} data-on={value?.job_id === job.id || undefined} disabled={!snapshots[job.id]}
          title={job.id === newest?.id ? 'Newest successful job — pin it explicitly' : 'An earlier successful job'}
          onClick={() => onChange(value?.job_id === job.id ? null : { job_id: job.id, snapshot_sha256: snapshots[job.id] })}>
          {value?.job_id === job.id ? 'Pinned ' : 'Pin '}{job.id.slice(0, 8)}{job.id === newest?.id ? ' · newest' : ''}
        </button>
      ))}
    </div>
  );
}

function StickoutRange({ draft, cutter, holders }: { draft: Draft; cutter: LibraryRecord | undefined; holders: (LibraryRecord | undefined)[] }) {
  const [length, setLength] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    setLength(null);
    if (!cutter) return;
    if (!sourceOf(cutter)) { setLength(Number(cutter.definition.overall_length_mm ?? 0) || null); return; }
    if (draft.cutter_geometry) toolJobs.resolution(draft.cutter_geometry.job_id).then((value) => { if (live) setLength(value.geometry.bounds_mm[5]); }).catch(() => {});
    return () => { live = false; };
  }, [cutter?.id, cutter?.revision, draft.cutter_geometry?.job_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const clamp = holders.at(-1)?.definition.clamp as { min_engagement_mm: number; max_engagement_mm: number } | undefined;
  const cutting = Number((sourceOf(cutter) ?? cutter?.definition ?? {} as Record<string, unknown>).cutting_length_mm ?? 0);
  if (!length) return null;
  const lo = Math.max(cutting, clamp ? length - clamp.max_engagement_mm : cutting), hi = clamp ? length - clamp.min_engagement_mm : length;
  return <p className={styles.fieldHint} data-stickout-range>Cutter length {mm(length)}; flutes {mm(cutting)}.{clamp ? ` The holder’s declared engagement allows ${mm(lo)}–${mm(hi)} of stick-out` : ''} (the server checks it with the profile uncertainty).</p>;
}

export function AssemblyBuilder({ record, onSaved }: { record: LibraryRecord | null; onSaved?: (saved: LibraryRecord) => void }) {
  const records = useMfg((state) => state.records);
  const [draft, setDraft] = useState<Draft>(() => draftOf(record));
  const [base, setBase] = useState<LibraryRecord | null>(record);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; field?: string; conflict?: LibraryRecord } | null>(null);
  const [snapshot, setSnapshot] = useState<AssemblySnapshot | null>(null);
  useEffect(() => { setDraft(draftOf(record)); setBase(record); setProblem(null); setSnapshot(null); }, [record?.id, record?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!base) return;
    let live = true;
    toolJobs.snapshot(base.id, base.revision).then((value) => { if (live) setSnapshot(value); }).catch(() => {});
    return () => { live = false; };
  }, [base?.id, base?.revision]);
  const byId = (id: string | undefined) => records.find((item) => item.id === id);
  const holders = records.filter((item) => item.kind === 'tool_holder' && !item.archived);
  const cutters = records.filter((item) => item.kind === 'rotary_cutter' && !item.archived);
  const patch = (value: Partial<Draft>) => { setDraft((current) => ({ ...current, ...value })); setProblem(null); };
  const addHolder = (holder: LibraryRecord) => {
    const kind = String(holder.definition.component_type ?? 'holder');
    let n = 1;
    while (draft.holders.some((use) => use.id === `${kind}${n === 1 ? '' : `_${n}`}`)) n++;
    patch({ holders: [...draft.holders, { id: `${kind}${n === 1 ? '' : `_${n}`}`, holder: pinOf(holder), geometry: null }] });
  };
  const move = (index: number, by: number) => {
    const next = [...draft.holders];
    const [item] = next.splice(index, 1);
    next.splice(index + by, 0, item);
    patch({ holders: next });
  };
  const save = async (onto: LibraryRecord | null = base) => {
    setBusy(true); setProblem(null);
    try {
      const definition = definitionOf(draft, faceMounted(byId(draft.cutter?.id)));
      const saved = onto ? await library.edit(onto, definition, onto.archived, requestKey('edit-tool_assembly')) : await library.create(definition, requestKey('create-tool_assembly'));
      await loadLibrary();
      setBase(saved);
      toast('success', onto ? 'Saved' : 'Created', `${saved.definition.name} · revision ${saved.revision}`);
      onSaved?.(saved);
    } catch (error) {
      if (error instanceof MfgError && error.status === 409 && onto) {
        const latest = await library.get(onto.id).catch(() => null);
        setProblem({ message: `Revision ${latest?.revision ?? '?'} was saved after the revision you edited (${onto.revision}).`, conflict: latest ?? undefined });
      } else {
        const field = error instanceof MfgError ? error.fields[0]?.path : undefined;
        setProblem({ message: error instanceof MfgError ? `${error.message}${error.code !== 'error' ? ` (${error.code})` : ''}` : (error as Error).message, field });
      }
    } finally { setBusy(false); }
  };
  const cutter = byId(draft.cutter?.id);
  const stack = draft.holders.map((use) => byId(use.holder.id));
  const bodyHeight = cutter && typeof cutter.definition.body_height_mm === 'number' ? cutter.definition.body_height_mm : null;
  const fieldIs = (name: string) => problem?.field && (problem.field === name || problem.field.endsWith(`.${name}`) || problem.field.startsWith(`${name}.`) || problem.field.includes(`.${name}.`));
  return (
    <div className={styles.builder} id="assembly-builder">
      <div className={styles.stack}>
        <label className={styles.field}><span className={styles.fieldLabel}>Name</span><input className={styles.input} id="assembly-name" value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
        <h4 className={mfgStyles.subhead} style={{ margin: '6px 0 0' }}>Holder stack · spindle first</h4>
        {draft.holders.map((use, index) => {
          const holder = stack[index];
          return (
            <div key={`${use.id}:${index}`} className={styles.component} data-holder-use={use.id} data-error={fieldIs('holders') || undefined}>
              <div className={styles.componentHead}>
                <span className={styles.order}>{index + 1}</span>
                <b>{holder?.definition.name ?? use.holder.id}</b>
                <small>rev {use.holder.revision}{holder && holder.revision !== use.holder.revision ? ` (latest ${holder.revision})` : ''}</small>
                <button type="button" className={styles.clear} aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
                <button type="button" className={styles.clear} aria-label="Move down" disabled={index === draft.holders.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
                <button type="button" className={styles.clear} aria-label={`Remove ${use.id}`} onClick={() => patch({ holders: draft.holders.filter((_, i) => i !== index) })}><Trash2 size={12} /></button>
              </div>
              <small className={mfgStyles.muted}>{String(holder?.definition.input_interface ?? '?')} → {String(holder?.definition.output_interface ?? '?')}{holder?.definition.clamp ? ' · clamps' : ''}</small>
              {holder && holder.revision !== use.holder.revision && <Button size="sm" variant="ghost" onClick={() => patch({ holders: draft.holders.map((u, i) => (i === index ? { ...u, holder: pinOf(holder), geometry: null } : u)) })}>Use revision {holder.revision}</Button>}
              <PinPicker component={holder && holder.revision === use.holder.revision ? holder : undefined} value={use.geometry}
                onChange={(pin) => patch({ holders: draft.holders.map((u, i) => (i === index ? { ...u, geometry: pin } : u)) })} />
            </div>
          );
        })}
        <Menu>
          <MenuTrigger asChild><Button size="sm" icon={<Plus />} id="add-holder" disabled={!holders.length}>{draft.holders.length ? 'Add holder or adapter' : 'Add holder'}</Button></MenuTrigger>
          <MenuContent>{holders.map((holder) => <MenuItem key={holder.id} onSelect={() => addHolder(holder)} hint={`${holder.definition.component_type} · ${sourceOf(holder) ? 'from part' : 'parametric'} · rev ${holder.revision}`}>{holder.definition.name}</MenuItem>)}</MenuContent>
        </Menu>
        <h4 className={mfgStyles.subhead} style={{ margin: '6px 0 0' }}>Cutter</h4>
        <div className={styles.component} data-error={fieldIs('cutter') || undefined} id="assembly-cutter">
          <div className={styles.componentHead}>
            <Wrench size={13} />
            <b>{cutter?.definition.name ?? 'Choose a cutter'}</b>
            {draft.cutter && <small>rev {draft.cutter.revision}</small>}
            <Menu>
              <MenuTrigger asChild><Button size="sm" id="choose-cutter" disabled={!cutters.length}>{draft.cutter ? 'Change' : 'Choose'}</Button></MenuTrigger>
              <MenuContent>{cutters.map((item) => <MenuItem key={item.id} onSelect={() => patch({ cutter: pinOf(item), cutter_geometry: null })} hint={`${String(item.definition.cutter_type).replace(/_/g, ' ')} · ${sourceOf(item) ? 'from part' : 'parametric'} · rev ${item.revision}`}>{item.definition.name}</MenuItem>)}</MenuContent>
            </Menu>
          </div>
          {cutter && <PinPicker component={cutter.revision === draft.cutter?.revision ? cutter : undefined} value={draft.cutter_geometry} onChange={(pin) => patch({ cutter_geometry: pin })} />}
        </div>
        <h4 className={mfgStyles.subhead} style={{ margin: '6px 0 0' }}>Stick-out</h4>
        {faceMounted(cutter) ? (
          <p className={styles.fieldHint} data-face-mounted>Face-mounted: the cutter seats on the arbor face, so its stick-out is its body height{bodyHeight !== null ? ` (${mm(bodyHeight)})` : ''}.</p>
        ) : (
          <>
            <div className={styles.stickout} data-error={fieldIs('stickout_mm') || undefined}>
              <input type="range" min={1} max={Math.max(150, draft.stickout_mm * 1.5)} step={0.1} value={draft.stickout_mm} aria-label="Stick-out" onChange={(event) => patch({ stickout_mm: Number(event.target.value) })} />
              <label className={styles.field}><NumberField className={styles.input} id="assembly-stickout" eager step={0.1} value={draft.stickout_mm} ariaLabel="Stick-out in mm" onChange={(stickout_mm) => patch({ stickout_mm })} /></label>
            </div>
            <StickoutRange draft={draft} cutter={cutter} holders={stack} />
          </>
        )}
        {problem && (
          <div className={styles.callout} data-tone={problem.conflict ? 'warning' : 'danger'} role="alert" id="assembly-problem">
            <div>
              <span><b>{problem.conflict ? 'Saved elsewhere first. ' : 'Not saved. '}</b>{problem.message}{problem.field ? <> · <code>{problem.field}</code></> : null}</span>
              {problem.conflict && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button size="sm" onClick={() => { setDraft(draftOf(problem.conflict!)); setBase(problem.conflict!); setProblem(null); }}>Discard mine, load theirs</Button>
                  <Button size="sm" variant="primary" id="assembly-save-on-top" onClick={() => void save(problem.conflict!)}>Save mine on top</Button>
                </div>
              )}
            </div>
          </div>
        )}
        <Button variant="primary" icon={busy ? <Spinner size={12} /> : <Save />} disabled={busy || !draft.cutter || !draft.holders.length} id="save-assembly" onClick={() => void save()}>
          {busy ? 'Saving…' : base ? `Save revision ${base.revision + 1}` : 'Create assembly'}
        </Button>
      </div>
      <div style={{ minWidth: 0 }}>
        {snapshot && base && snapshot.assembly.revision === base.revision ? <AssembledView snapshot={snapshot} />
          : <div className={styles.view} style={{ display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24 }}><span className={mfgStyles.muted}>{base ? <><Spinner size={12} /> Resolving the saved assembly…</> : 'Save the assembly to see it assembled from its snapshot.'}</span></div>}
      </div>
    </div>
  );
}

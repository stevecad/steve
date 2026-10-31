/**
 * A part-backed cutter or holder's geometry: resolve its exact library revision as a durable job (one request key
 * per revision), follow progress and events, cancel, read failures back to the field that caused them, and show the
 * result — the part's display mesh inside the conservative envelope that the checks use. Jobs for the revision are
 * listed; the newest success is highlighted but only the user pins one for assemblies.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { Ban, Crosshair, Pin as PinIcon, Play, RefreshCw, RotateCcw } from 'lucide-react';
import { Button, Spinner } from '@/ui';
import { Api } from '@/lib/api';
import { get as app, set as setApp } from '@/state/store';
import { terminal, type LibraryRecord } from './api';
import { report } from './state';
import { fieldKey, startFromPart, useFromPart, type ToolKind } from './fromPart';
import {
  choosePin, displayGeometry, mm, profilePoints, resolveKey, sourceOf, toolJobs, useChosenPins,
  type JobEventRecord, type ResolvedToolPart, type ToolJob,
} from './toolGeometry';
import ToolView, { LEGEND, type ViewMesh } from './ToolView';
import styles from './ToolPart.module.css';
import mfgStyles from './Manufacture.module.css';
import { RECORD_FORMS } from './shop/recordForms';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
const shortId = (id: string) => id.slice(0, 8);

/** Opens the part (when another one is open) and the From-part tool on this record, focused on `field`. */
export async function repick(record: LibraryRecord, field: string | null = null, message: string | null = null) {
  const source = sourceOf(record);
  setApp({ dialog: null });
  const start = () => { startFromPart(record.kind as ToolKind, record, field); if (message) useFromPart.setState({ notice: `The resolver said: ${message}` }); };
  if (!source || app().doc.saved?.id === source.document_id) { start(); return; }
  const { leave, openDocument } = await import('@/state/actions');
  leave(() => { void openDocument(source.document_id).then(start); });
}

export function useToolJobs(record: Pick<LibraryRecord, 'id' | 'revision'> | null) {
  const [items, setItems] = useState<ToolJob[] | null>(null);
  const load = useCallback(async () => {
    if (!record) return;
    try { setItems((await toolJobs.list(record.id)).filter((job) => job.revision === record.revision)); } catch (error) { report(error, 'Geometry jobs'); setItems([]); }
  }, [record?.id, record?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setItems(null); void load(); }, [load]);
  const running = items?.some((job) => !terminal(job.status));
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), 1200);
    return () => clearInterval(timer);
  }, [running, load]);
  return { items, reload: load, setItems };
}

export const newestSuccess = (items: ToolJob[] | null) => items?.find((job) => job.status === 'succeeded') ?? null;

export function PartPreview({ jobId, part, spinDefault = false, id }: { jobId: string; part: ResolvedToolPart; spinDefault?: boolean; id?: string }) {
  const [mesh, setMesh] = useState<ViewMesh | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setMesh(null); setError(null);
    displayGeometry(jobId, part.display).then((geometry) => {
      if (!live) return;
      const cutting = part.regions.find((region) => region.role === 'cutter');
      setMesh({ key: jobId, geometry, matrix: new THREE.Matrix4(), cutting: cutting ? [cutting.z_min_mm, cutting.z_max_mm] : null, role: part.coordinate_space === 'cutter_tip' ? 'cutter' : 'holder' });
    }).catch((caught) => { if (live) setError((caught as Error).message); });
    return () => { live = false; };
  }, [jobId, part]);
  const shells = useMemo(() => [{ key: 'envelope', points: profilePoints(part.profile), role: part.coordinate_space === 'cutter_tip' ? 'shank' as const : 'holder' as const }], [part]);
  if (error) return <div className={styles.callout} data-tone="danger" role="alert">{error}</div>;
  return (
    <ToolView id={id} meshes={mesh ? [mesh] : []} shells={shells} spinDefault={spinDefault} loading={mesh ? null : 'Loading and checking the display mesh…'}
      note={<>Display mesh: {part.display.triangles.toLocaleString()} triangles · sha256 {part.display.sha256.slice(0, 12)} verified · {part.coordinate_space === 'cutter_tip' ? 'tip' : 'gauge plane'} at the origin, +Z toward the spindle</>} />
  );
}

export default function ToolGeometryTab({ record }: { record: LibraryRecord }) {
  const source = sourceOf(record);
  const { items, reload, setItems } = useToolJobs(record);
  const [selected, setSelected] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEventRecord[]>([]);
  const [result, setResult] = useState<{ jobId: string; part: ResolvedToolPart } | null>(null);
  const [busy, setBusy] = useState(false);
  const [part, setPart] = useState<{ name: string; revision: number } | null>(null);
  const chosen = useChosenPins((pins) => pins[`${record.id}:${record.revision}`]);
  const newest = newestSuccess(items);
  const job = items?.find((item) => item.id === selected) ?? items?.[0] ?? null;

  useEffect(() => { setSelected(null); setResult(null); setEvents([]); }, [record.id, record.revision]);
  useEffect(() => {
    if (!source) return;
    let live = true;
    Api.document(source.document_id).then((doc) => { if (live) setPart({ name: doc.name, revision: doc.revision }); }).catch(() => { if (live) setPart(null); });
    return () => { live = false; };
  }, [source?.document_id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!job) return;
    let live = true;
    toolJobs.events(job.id).then((value) => { if (live) setEvents(value); }).catch(() => {});
    return () => { live = false; };
  }, [job?.id, job?.status, job?.stage, job?.progress]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!job || job.status !== 'succeeded' || result?.jobId === job.id) return;
    let live = true;
    toolJobs.resolution(job.id).then((value) => { if (live) setResult({ jobId: job.id, part: value.geometry }); }).catch((error) => report(error, 'Geometry'));
    return () => { live = false; };
  }, [job?.id, job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!source) {
    return (
      <div className={styles.callout} id="geometry-parametric">
        <Crosshair size={13} />
        <div>This {record.kind === 'rotary_cutter' ? 'cutter' : 'holder'} uses parametric dimensions; its envelope comes from them directly, so there is nothing to resolve.
          Make a new one from a saved part to check a real vendor model.</div>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    try {
      const attempts = items?.length ?? 0;
      const latest = items?.[0];
      // One key per revision; a new key only when the last attempt for this revision ended without a result.
      const key = !latest || latest.status === 'succeeded' || !terminal(latest.status) ? resolveKey(record) : resolveKey(record, attempts);
      const submitted = await toolJobs.submit(record, key);
      setItems((current) => [submitted, ...(current ?? []).filter((item) => item.id !== submitted.id)]);
      setSelected(submitted.id);
      void reload();
    } catch (error) { report(error, 'Couldn’t resolve the geometry'); }
    finally { setBusy(false); }
  };
  const cancel = async (target: ToolJob) => {
    try { await toolJobs.cancel(target.id); void reload(); } catch (error) { report(error, 'Couldn’t cancel'); }
  };
  const newer = part && part.revision > source.revision;
  const failedField = job?.status === 'failed' && job.error?.field ? job.error.field : null;
  const uncertainty = result?.part.profile.approximation_bound_mm;

  const preview = result && job?.status === 'succeeded' && job.id === result.jobId ? result : null;
  return (
    <div className={styles.geometry} id="tool-geometry">
      <div className={styles.partLine}>
        <b>{part?.name ?? 'Part'}</b>
        <span>revision {source.revision} · body <code>{source.body}</code> · frames {Object.entries(source.frames).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ')}</span>
        {RECORD_FORMS && <Button size="sm" variant="ghost" icon={<Crosshair />} style={{ marginLeft: 'auto' }} onClick={() => void repick(record)}>Re-pick frames…</Button>}
      </div>
      {newer && (
        <div className={styles.callout} data-tone="warning" data-repick id="geometry-newer-part">
          <RefreshCw size={13} />
          <div>
            <span>{part!.name} has revision {part!.revision}; this record pins revision {source.revision} and keeps resolving that one.
              To move to the newer part, re-pick the frames: after re-importing a newer vendor file, its faces and edges are named afresh, so the old references can’t be trusted.</span>
            {RECORD_FORMS && <Button size="sm" icon={<Crosshair />} onClick={() => void repick(record)}>Re-pick on revision {part!.revision}</Button>}
          </div>
        </div>
      )}
      <div className={styles.actionBar}>
        <Button variant="primary" icon={busy ? <Spinner size={12} /> : items?.[0]?.status === 'failed' || items?.[0]?.status === 'cancelled' ? <RotateCcw /> : <Play />} disabled={busy || (!!job && !terminal(job.status))} id="resolve-geometry" onClick={() => void submit()}>
          {items?.length && items[0].status !== 'succeeded' && terminal(items[0].status) ? 'Resolve again' : 'Resolve geometry'}
        </Button>
        <p className={mfgStyles.muted} style={{ margin: 0 }}>Runs revision {record.revision} of this record in an isolated worker; asking again for the same revision returns the same job.</p>
      </div>
      {job && (
        <div className={styles.component} id="geometry-job" data-status={job.status}>
          <div className={styles.progressRow}>
            <span className={mfgStyles.status} data-status={job.status}>{job.status} · {job.stage} · {Math.round(job.progress * 100)}%</span>
            {!terminal(job.status) && <Button size="sm" variant="ghost" icon={<Ban />} id="cancel-geometry" onClick={() => void cancel(job)}>Cancel</Button>}
          </div>
          <div className={mfgStyles.progress}><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          {job.status === 'failed' && job.error && (
            <div className={styles.callout} data-tone="danger" role="alert" id="geometry-error">
              <div>
                <b>{job.error.message}</b>
                <span><code>{job.error.code}</code>{failedField ? <> · field <code>{failedField}</code></> : null}</span>
                {RECORD_FORMS && failedField && <Button size="sm" icon={<Crosshair />} id="fix-geometry-field" onClick={() => void repick(record, fieldKey(failedField), job.error!.message)}>Fix {fieldLabel(failedField)}</Button>}
              </div>
            </div>
          )}
          {job.cached_from && <p className={mfgStyles.muted} style={{ margin: 0 }}>Reused the identical result of job {shortId(job.cached_from)}.</p>}
          <ul className={styles.events} aria-label="Job events">
            {events.map((event) => <li key={event.sequence}><span>#{event.sequence}</span><span>{event.status}</span><span>{event.stage}</span><span>{Math.round(event.progress * 100)}%</span></li>)}
          </ul>
        </div>
      )}
      {preview ? <PartPreview jobId={preview.jobId} part={preview.part} id="geometry-preview" />
        : job && (!terminal(job.status) || job.status === 'succeeded') ? <div className={styles.view} style={{ display: 'grid', placeItems: 'center' }}><span className={mfgStyles.muted}><Spinner size={12} /> {job.status === 'succeeded' ? 'Reading the result…' : 'Resolving the part on the server…'}</span></div>
          : <div className={styles.view} style={{ display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}><span className={mfgStyles.muted}>{items === null ? 'Loading jobs…' : 'Resolve the geometry to see the part inside the envelope the checks use.'}</span></div>}
      <div className={styles.lower}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          {preview && (
            <>
              <p className={styles.uncertainty} id="geometry-uncertainty" data-bound={uncertainty}>
                Shown: your part. Checked: its revolved envelope (≤ {mm(uncertainty, 4)}, conservative).
                <small>The envelope encloses every point of the part as it turns about the {preview.part.coordinate_space === 'cutter_tip' ? 'tip' : 'gauge'} axis ({preview.part.profile.error_metric === 'radial' ? 'radial' : 'meridional'} error bound). It fills bores, so it can’t prove material is removed inside them; physical qualification is {preview.part.physical_qualification}.</small>
              </p>
              <div className={styles.legend}>{LEGEND.map(([label, color]) => <span key={label}><i style={{ background: color }} />{label}</span>)}</div>
              <dl className={mfgStyles.facts}>
                <dt>Length along Z</dt><dd>{mm(preview.part.bounds_mm[5] - preview.part.bounds_mm[2])}</dd>
                <dt>Largest Ø</dt><dd>{mm(2 * Math.max(...profilePoints(preview.part.profile).map(([r]) => r)))}</dd>
                <dt>Regions</dt><dd>{preview.part.regions.map((region) => `${region.role} ${Number(region.z_min_mm.toFixed(3))}–${Number(region.z_max_mm.toFixed(3))} mm`).join(' · ')}</dd>
                {preview.part.coordinate_space === 'holder_gauge' && <><dt>Gauge contribution</dt><dd>{mm(preview.part.gauge_contribution_mm)}</dd></>}
                <dt>Envelope excess</dt><dd>{Number(preview.part.profile.envelope_excess_volume_mm3.toFixed(2))} mm³ over {Number(preview.part.profile.source_volume_mm3.toFixed(1))} mm³</dd>
                <dt>Snapshot</dt><dd><code>{preview.part.snapshot_sha256.slice(0, 16)}</code></dd>
              </dl>
            </>
          )}
        </div>
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <h4 className={mfgStyles.subhead} style={{ margin: 0 }}>Jobs for revision {record.revision}</h4>
          <div className={styles.jobs} id="geometry-jobs">
            {(items ?? []).map((item) => {
              const pinned = chosen?.job_id === item.id;
              return (
                <button key={item.id} type="button" className={styles.job} data-job={item.id} data-status={item.status} data-on={item.id === job?.id || undefined} data-newest={item.id === newest?.id || undefined} onClick={() => setSelected(item.id)}>
                  <span><span className={mfgStyles.status} data-status={item.status}>{item.status}</span> <small>{shortId(item.id)}</small></span>
                  <span>{pinned ? <span className={styles.pinned}><PinIcon size={10} />pinned</span> : <span className={styles.newest}>newest result</span>}</span>
                  <small>{when(item.created_at)}</small>
                </button>
              );
            })}
            {items?.length === 0 && <p className={mfgStyles.muted} style={{ margin: 0 }}>No jobs yet.</p>}
          </div>
          {preview && (
            <Button size="sm" icon={<PinIcon />} id="pin-geometry" disabled={chosen?.job_id === preview.jobId} onClick={() => choosePin(record, { job_id: preview.jobId, snapshot_sha256: preview.part.snapshot_sha256 })}>
              {chosen?.job_id === preview.jobId ? 'Pinned for assemblies' : 'Pin this result for assemblies'}
            </Button>
          )}
          <p className={mfgStyles.muted} style={{ margin: 0 }}>The newest success is highlighted; assemblies use only the job you pin, never “latest” on their own.</p>
        </aside>
      </div>
    </div>
  );
}

function fieldLabel(field: string) {
  const key = fieldKey(field);
  if (key.startsWith('frames.')) return `the ${key.slice(7).replace('_', ' ')} frame`;
  return key.replace(/_mm$/, '').replace(/_/g, ' ');
}

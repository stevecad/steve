/**
 * The top of a library record's details: the tool in 3D where there is something real to draw (an assembly's
 * snapshot, a part-backed component's resolved mesh, a parametric holder's own profile), then its key facts — the
 * same values as the table's columns.
 */
import { useEffect, useMemo, useState } from 'react';
import { Box } from 'lucide-react';
import { Button } from '@/ui';
import type { LibraryRecord } from './api';
import { cellText, factColumns, type Lookup } from './libraryColumns';
import { mm, regionPoints, sourceOf, toolJobs, useChosenPins, type AssemblySnapshot, type FrustumSegment, type ResolvedToolPart } from './toolGeometry';
import { newestSuccess, PartPreview, useToolJobs } from './ToolGeometryTab';
import { useAssembledShapes } from './AssemblyView';
import ToolView, { type ViewShell } from './ToolView';
import styles from './Manufacture.module.css';

function AssemblyPreview({ record }: { record: LibraryRecord }) {
  const [snapshot, setSnapshot] = useState<AssemblySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(null); setError(null);
    toolJobs.snapshot(record.id, record.revision).then((value) => { if (live) setSnapshot(value); }).catch((caught) => { if (live) setError((caught as Error).message); });
    return () => { live = false; };
  }, [record.id, record.revision]);
  const { meshes, shells, parts, problem } = useAssembledShapes(snapshot);
  if (error || problem) return <p className={styles.previewEmpty} data-tone="danger" role="alert">{error ?? problem}</p>;
  const geometry = snapshot?.geometry;
  return (
    <ToolView id="record-preview" meshes={meshes} shells={shells} spinDefault={false} planes={geometry ? [{ key: 'gauge', z: geometry.gauge_length_mm, color: '#38bdf8' }] : []}
      loading={!snapshot ? 'Resolving the assembly…' : meshes.length < parts.length ? 'Placing part meshes…' : null}
      note={geometry ? <>Gauge {mm(geometry.gauge_length_mm)} · stick-out {mm(geometry.stickout_mm)} · Ø {mm(geometry.cutter_diameter_mm)}</> : undefined} />
  );
}

function GeometryPreview({ record, onOpenGeometry }: { record: LibraryRecord; onOpenGeometry: () => void }) {
  const { items } = useToolJobs(record);
  const chosen = useChosenPins((pins) => pins[`${record.id}:${record.revision}`]);
  const job = (chosen ? items?.find((item) => item.id === chosen.job_id && item.status === 'succeeded') : undefined) ?? newestSuccess(items);
  const [part, setPart] = useState<{ jobId: string; part: ResolvedToolPart } | null>(null);
  useEffect(() => {
    if (!job) { setPart(null); return; }
    let live = true;
    toolJobs.resolution(job.id).then((value) => { if (live) setPart({ jobId: job.id, part: value.geometry }); }).catch(() => { if (live) setPart(null); });
    return () => { live = false; };
  }, [job?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (items !== null && !job) {
    return (
      <div className={styles.previewEmpty} id="record-preview-unresolved">
        <Box size={18} />
        <span>Revision {record.revision} isn’t resolved yet, so there is no mesh to show.</span>
        <Button size="sm" onClick={onOpenGeometry}>Resolve geometry</Button>
      </div>
    );
  }
  if (!part || part.jobId !== job?.id) return <ToolView id="record-preview" meshes={[]} shells={[]} spinDefault={false} loading="Reading the resolved geometry…" />;
  return <PartPreview id="record-preview" jobId={part.jobId} part={part.part} />;
}

/** A parametric holder drawn from its own outer profile (gauge-plane coordinates). */
function ProfilePreview({ record }: { record: LibraryRecord }) {
  const shells = useMemo<ViewShell[]>(() => ((record.definition.outer_profile as FrustumSegment[] | undefined) ?? [])
    .map((segment, index) => ({ key: `profile:${index}`, points: regionPoints(segment), role: 'holder' as const, solid: true })), [record.definition.outer_profile]);
  if (!shells.length) return null;
  return <ToolView id="record-preview" meshes={[]} shells={shells} spinDefault={false} note={<>Drawn from its parametric profile · gauge plane at the origin</>} />;
}

/** The 3D preview a record has, or null. */
export function hasPreview(record: LibraryRecord): boolean {
  if (record.kind === 'tool_assembly') return true;
  if (record.kind === 'rotary_cutter' || record.kind === 'tool_holder') return !!sourceOf(record) || (record.kind === 'tool_holder' && Array.isArray(record.definition.outer_profile) && record.definition.outer_profile.length > 0);
  return false;
}

export function Preview({ record, onOpenGeometry }: { record: LibraryRecord; onOpenGeometry: () => void }) {
  let view = null;
  if (record.kind === 'tool_assembly') view = <AssemblyPreview record={record} />;
  else if ((record.kind === 'rotary_cutter' || record.kind === 'tool_holder') && sourceOf(record)) view = <GeometryPreview record={record} onOpenGeometry={onOpenGeometry} />;
  else if (record.kind === 'tool_holder') view = <ProfilePreview record={record} />;
  return view ? <div className={styles.preview} data-preview={record.kind}>{view}</div> : null;
}

/** Key facts: the kind's table columns that this record fills. */
export function KeyFacts({ record, lookup }: { record: LibraryRecord; lookup: Lookup }) {
  const facts = factColumns(record.kind).map((column) => [column, cellText(column, record, lookup)] as const).filter(([, text]) => text);
  const description = typeof record.definition.description === 'string' ? record.definition.description.trim() : '';
  if (!facts.length && !description) return null;
  return (
    <div className={styles.keyFacts} id="record-facts">
      {facts.length > 0 && (
        <dl>
          {facts.map(([column, text]) => (
            <div key={column.id} data-fact={column.id}>
              <dt>{column.label}</dt>
              <dd title={`${text}${column.unit ? ` ${column.unit}` : ''}`}>{column.code ? <code>{text}</code> : text}{column.unit && <small>{column.unit}</small>}</dd>
            </div>
          ))}
        </dl>
      )}
      {description && <p>{description}</p>}
    </div>
  );
}

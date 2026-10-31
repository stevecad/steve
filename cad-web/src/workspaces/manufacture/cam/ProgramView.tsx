/**
 * A milling program in the inspector: its setup at a glance, its operations with their latest run, the run in
 * progress, and the selected run's results — the backend's check verdicts, whether the machine file can be
 * downloaded (failed checks block it; everything else is unverified output), its files and the job history.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, CircleDashed, CircleHelp, Download, Info, Pencil, Play, Plus, SquareX, Trash2, XCircle } from 'lucide-react';
import { Button, Section } from '@/ui';
import { useApp } from '@/state/store';
import { BoreIcon, ContourIcon, RoughIcon, DrillOpIcon, FaceMillIcon, PocketIcon, RestIcon, SetupIcon, SimulateToolIcon, SlotIcon, TabIcon, ChamferOpIcon, EngraveIcon, ParallelFinishIcon, WaterlineIcon } from '@/icons/cad';
import CopyMessage from '@/shell/CopyMessage';
import panel from '@/panels/Panels.module.css';
import { jobs, terminal, type JobRecord, type ProgramRecord } from '../api';
import { useMfg } from '../state';
import { artifactJson, type StockTransferRecord } from './api';
import { CODE_HINTS, failureField, isDrilling, kindOf, OP_LABEL, presetOf, stockBoxOf, TRANSFER_LABEL, type OpKind } from './program';
import {
  cancelJob, cancelRun, downloadMachineFile, editOperation, editSetup, expandedOps, fixField, highlightContour, instanceKey, loadExpansion, operationName, sourceOperation, highlightHole, highlightSlot, highlightSurface, highlightTab, latestProgram, loadBores, loadContours, loadEngrave, loadHoles, loadJobs, loadRest, loadResults, loadSlots, loadSurfaces,
  addSetup, followDesign, newSetupTool, loadFixtureChecks, openPlayer, postSetup, setupPosts, showFixtureContact, postRun, deleteOperationChecked, moveOperationOf, runOperation, runProgram, selectJob, useCam, type Results,
} from './state';
import CheckFamilies, { RunSummary, showCheckDetails } from '@/workspaces/manufacture/cam/ChecksView';
import { summarize } from './checkSummary';
import { CHECK_HEIGHTS, ReferenceReviewBanner } from './ReferenceReview';
import { horizontalSketches } from './sketchCurves';
import { CamRunSection, operationJob, useCamRunJobs } from './CamProgram';
import { volumeKind, volumeWords } from './volumes';
import { postedResolutionNextStep } from './postedResolution';
import styles from './Cam.module.css';

type Rec = Record<string, unknown>;
const STAGE: Record<string, string> = {
  queued: 'Waiting for a worker', preparing: 'Resolving the pinned design, machine and tools', generating: 'Planning the toolpath',
  checking: 'Posting, decoding and checking', publishing: 'Publishing results', complete: 'Done',
};
const OP_ICON: Record<OpKind, typeof PocketIcon> = { rough: RoughIcon, pocket: PocketIcon, rest: RestIcon, slot: SlotIcon, face: FaceMillIcon, contour: ContourIcon, drill: DrillOpIcon, peck_drill: DrillOpIcon, bore: BoreIcon, engrave: EngraveIcon, chamfer: ChamferOpIcon, parallel: ParallelFinishIcon, waterline: WaterlineIcon };
export const OpIcon = ({ kind, size = 16 }: { kind: OpKind; size?: number }) => { const Icon = OP_ICON[kind]; return <Icon size={size} />; };
/** A run operation's state in plain words (the scheduler's; verdicts are each child job's). */
const RUN_OP: Record<string, string> = { waiting: 'Waiting', queued: 'Queued', running: 'Running', checking: 'Checking', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', blocked: 'Blocked by an earlier failure' };
const num = (value: number, digits = 3) => Number(value.toFixed(digits)).toString();
const size = (bytes: number) => (bytes >= 1048576 ? `${num(bytes / 1048576, 1)} MB` : bytes >= 1024 ? `${num(bytes / 1024, 0)} KB` : `${bytes} B`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The run's state in plain words: the backend's verdict where there is one. `revision`: the program's current revision,
 * so a job generated for an older one reads "Out of date". Every generated output is unverified until a machine trial
 * qualifies it; the run's results say so, the status names what differs between operations.
 */
export function runStatus(job: JobRecord | null, results: Results | undefined, revision?: number): { s: string; label: string } {
  if (!job) return { s: 'none', label: 'Not generated' };
  if (job.status === 'queued') return { s: 'queued', label: 'Queued' };
  if (job.status === 'running') return { s: 'running', label: `${Math.round(job.progress * 100)}%` };
  if (job.status === 'failed') return { s: 'failed', label: 'Failed' };
  if (job.status === 'cancelled') return { s: 'cancelled', label: 'Cancelled' };
  if (results?.assessment?.download_status === 'blocked_failed_checks') return { s: 'blocked', label: 'Checks failed' };
  if (revision !== undefined && job.revision !== revision) return { s: 'stale', label: 'Out of date' };
  return { s: 'unverified', label: 'Generated' };
}

/** "4 × circular" / "2 × 3 grid" / "3 placements", with how many are left out. */
function patternSummary(pattern: { layout?: Rec; suppress?: string[] }): string {
  const layout = pattern.layout ?? {};
  const off = pattern.suppress?.length ?? 0;
  const text = layout.kind === 'circular' ? `${Number(layout.count ?? 1)} × circular`
    : layout.kind === 'placements' ? `${((layout.instances as unknown[] | undefined) ?? []).length} placements`
      : `${Number(layout.count_u ?? 1)} × ${Number(layout.count_v ?? 1)} grid`;
  return off ? `${text}, ${off} left out` : text;
}

export function StatusPill({ job, compact, revision }: { job: JobRecord | null; compact?: boolean; revision?: number }) {
  const results = useCam((state) => (job ? state.results[job.id] : undefined));
  const status = runStatus(job, results, revision);
  if (compact) return <span className={styles.dot} data-s={status.s} data-job-status={job?.status} title={status.label} aria-label={status.label} />;
  return <span className={styles.status} data-s={status.s} data-job-status={job?.status}><i />{status.label}</span>;
}

function Progress({ job }: { job: JobRecord }) {
  return (
    <div className={styles.progress} id="cam-progress" data-stage={job.stage}>
      <div><span>{STAGE[job.stage] ?? job.stage}</span><span>{Math.round(job.progress * 100)}%</span></div>
      <div className={styles.bar} data-indeterminate={job.status === 'queued' || undefined}><i style={{ width: `${Math.max(4, job.progress * 100)}%` }} /></div>
    </div>
  );
}

const ICON = { passed: CheckCircle2, failed: XCircle, uncertain: CircleHelp, unassessed: CircleDashed } as const;

const setupOf = (program: ProgramRecord, id?: string | null) => ((id ? (program.compiled.setups as Rec[]).find((setup) => setup.id === id) : null) ?? program.compiled.setups[0] ?? {}) as Rec;
/** The setup a job ran in: a combined program's selected setup, else its operation's (a pattern instance's source's). */
const jobSetupId = (program: ProgramRecord, job: JobRecord) => postSetup(job) ?? (job.operation ? String(((program.compiled.operations as Rec[]).find((op) => op.id === sourceOperation(program.id, job.operation)) ?? {}).setup ?? '') || null : null);
const originOf = (program: ProgramRecord, id?: string | null) => (((setupOf(program, id).work_to_machine as Rec | undefined)?.origin_mm ?? [0, 0, 0]) as number[]);
const stockTopOf = (program: ProgramRecord, id?: string | null) => Number(stockBoxOf(program.compiled, String(setupOf(program, id).id ?? 'setup'))?.max[2] ?? 0);

/** Drilling results: each hole's completion and deepest tip (the backend's); clicking one shows it in the viewport. */
function HoleResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const holes = useCam((state) => state.holes[job.id]);
  const highlight = useCam((state) => state.highlight);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes('drill-check.json') || files.includes('program-check.json');
  useEffect(() => { if (has) void loadHoles(job, originOf(program, jobSetupId(program, job))); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => highlightHole(null), []);
  if (!has || !holes || (!holes.holes.length && !holes.error)) return null;
  if (holes.error) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Hole results: {holes.error}</span><CopyMessage text={holes.error} /></div>;
  const done = holes.holes.filter((hole) => hole.status === 'passed').length;
  const top = stockTopOf(program, jobSetupId(program, job));
  return (
    <div className={styles.holeResults} id="cam-hole-results">
      <div className={styles.estimatesHead}><DrillOpIcon size={13} /><b>Holes</b><span>{done} of {holes.holes.length} reached their depth (the engine’s check of the posted moves)</span></div>
      {holes.holes.map((hole) => {
        const Icon = ICON[hole.status as keyof typeof ICON] ?? CircleDashed;
        const key = `${hole.operation}:${hole.hole}`;
        const name = operationName(program, hole.operation);
        return (
          <button key={key} type="button" className={styles.holeRow} data-hole-result={hole.hole} data-s={hole.status} data-on={highlight?.id === key || undefined}
            onClick={() => highlightHole(highlight?.id === key || !hole.center ? null : { id: key, center: hole.center, radius: hole.radius ?? 1, top, bottom: hole.deepestZ ?? top - 1 })}
            title={hole.center ? 'Show it in the viewport' : undefined}>
            <Icon size={14} />
            <b>{hole.hole.replace(/_/g, ' ')}</b>
            <span>{name}{hole.center ? ` · X${num(hole.center[0], 2)} Y${num(hole.center[1], 2)}` : ''}{hole.radius ? ` · Ø${num(hole.radius * 2, 3)}` : ''}</span>
            <small>{hole.deepestZ !== null ? `deepest tip Z ${num(hole.deepestZ)}` : 'not reached'}</small>
          </button>
        );
      })}
    </div>
  );
}

/** Contour results: each chain's finishing-path coverage (the backend's); clicking one shows it in the viewport. */
function ContourResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const contours = useCam((state) => state.contours[job.id]);
  const highlight = useCam((state) => state.contourHighlight);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes('contour-check.json') || files.includes('program-check.json');
  useEffect(() => { if (has) void loadContours(job, originOf(program, jobSetupId(program, job))); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => highlightContour(null), []);
  if (!has || !contours || (!contours.contours.length && !contours.tabs.length && !contours.error)) return null;
  if (contours.error) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Contour results: {contours.error}</span><CopyMessage text={contours.error} /></div>;
  if (!contours.contours.length) return <TabResults job={job} program={program} />;
  const done = contours.contours.filter((row) => row.status === 'passed').length;
  // A rough's coverage is of its rings nearest the part (ring 0), not of a finishing path.
  const roughOf = (operation: string) => kindOf(((program.compiled.operations as Rec[]).find((op) => op.id === sourceOperation(program.id, operation)) ?? {}) as Rec) === 'rough';
  const allRough = contours.contours.every((row) => roughOf(row.operation));
  return (
    <div className={styles.holeResults} id="cam-contour-results">
      <div className={styles.estimatesHead}>{allRough ? <RoughIcon size={13} /> : <ContourIcon size={13} />}<b>{allRough ? 'Roughing' : 'Contours'}</b>
        <span>{done} of {contours.contours.length} {allRough ? `ring${contours.contours.length === 1 ? '' : 's'} nearest the part` : 'finishing paths'} covered (the engine’s check of the posted moves)</span></div>
      {contours.contours.map((row) => {
        const Icon = ICON[row.status as keyof typeof ICON] ?? CircleDashed;
        const key = `${row.operation}:${row.chain}`;
        const name = operationName(program, row.operation);
        const z = row.z ?? row.floor;
        return (
          <button key={key} type="button" className={styles.holeRow} data-contour-result={row.chain} data-s={row.status} data-on={highlight?.id === key || undefined}
            onClick={() => highlightContour(highlight?.id === key || !row.points.length || z === null ? null : { id: key, points: row.points, closed: row.closed, z, floor: row.floor })}
            title={row.points.length ? 'Show it in the viewport' : undefined}>
            <Icon size={14} />
            <b>{roughOf(row.operation) ? 'Nearest ring' : row.chain.replace(/_/g, ' ')}</b>
            <span>{name}{roughOf(row.operation) ? ' · path coverage' : ` · ${row.closed ? 'closed' : 'open'}`}</span>
            <small>{row.covered_segments} of {row.required_segments} segments</small>
          </button>
        );
      })}
      <TabResults job={job} program={program} />
    </div>
  );
}

const TAB_WORDS: Record<string, string> = { passed: 'checked', failed: 'failed', uncertain: 'uncertain', unassessed: 'not assessed' };

/** Contour retention tabs: whether each bridge starts as material and survives the posted program (the backend's). */
function TabResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const tabs = useCam((state) => state.contours[job.id]?.tabs ?? []);
  const highlight = useCam((state) => state.tabHighlight);
  useEffect(() => () => highlightTab(null), []);
  if (!tabs.length) return null;
  const kept = tabs.filter((tab) => tab.preservation === 'passed').length;
  const rank = (status: string) => ['failed', 'uncertain', 'unassessed', 'passed'].indexOf(status);
  return (
    <div className={styles.tabResults} id="cam-tab-results">
      <div className={styles.estimatesHead}><TabIcon size={13} /><b>Tabs</b><span>{kept} of {tabs.length} bridges kept by the posted program (the engine’s check)</span></div>
      {tabs.map((tab) => {
        const worst = rank(tab.initial_material) < rank(tab.preservation) ? tab.initial_material : tab.preservation;
        const Icon = ICON[worst as keyof typeof ICON] ?? CircleDashed;
        const key = `${tab.operation}:${tab.tab}`;
        const name = operationName(program, tab.operation);
        return (
          <button key={key} type="button" className={styles.holeRow} data-tab-result={tab.tab} data-s={worst} data-preservation={tab.preservation} data-on={highlight?.id === key || undefined}
            onClick={() => highlightTab(highlight?.id === key || !tab.corners || tab.bottom === null || tab.top === null ? null : { id: key, corners: tab.corners, bottom: tab.bottom, top: tab.top })}
            title={tab.corners ? 'Show the bridge in the viewport' : undefined}>
            <Icon size={14} />
            <b>{tab.tab.replace(/_/g, ' ')}</b>
            <span>{name}{tab.top !== null ? ` · up to Z ${num(tab.top)}` : ''}</span>
            <small>material {TAB_WORDS[tab.initial_material] ?? tab.initial_material} · kept {TAB_WORDS[tab.preservation] ?? tab.preservation}</small>
          </button>
        );
      })}
    </div>
  );
}

/** Bore results: each bore's finishing-circle coverage (the backend's); clicking one shows it in the viewport. */
function BoreResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const bores = useCam((state) => state.bores[job.id]);
  const highlight = useCam((state) => state.highlight);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes('bore-check.json') || files.includes('program-check.json');
  useEffect(() => { if (has) void loadBores(job, originOf(program, jobSetupId(program, job))); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!has || !bores || (!bores.bores.length && !bores.error)) return null;
  if (bores.error) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Bore results: {bores.error}</span><CopyMessage text={bores.error} /></div>;
  const done = bores.bores.filter((bore) => bore.status === 'passed').length;
  const top = stockTopOf(program, jobSetupId(program, job));
  return (
    <div className={styles.holeResults} id="cam-bore-results">
      <div className={styles.estimatesHead}><BoreIcon size={13} /><b>Bores</b><span>{done} of {bores.bores.length} finishing circles covered (the engine’s check of the posted moves)</span></div>
      {bores.bores.map((bore) => {
        const Icon = ICON[bore.status as keyof typeof ICON] ?? CircleDashed;
        const key = `${bore.operation}:${bore.hole}`;
        const name = operationName(program, bore.operation);
        return (
          <button key={key} type="button" className={styles.holeRow} data-bore-result={bore.hole} data-s={bore.status} data-on={highlight?.id === key || undefined}
            onClick={() => highlightHole(highlight?.id === key || !bore.center ? null : { id: key, center: bore.center, radius: bore.radius ?? 1, top, bottom: bores.floor ?? top - 1 })}
            title={bore.center ? 'Show it in the viewport' : undefined}>
            <Icon size={14} />
            <b>{bore.hole.replace(/_/g, ' ')}</b>
            <span>{name}{bore.center ? ` · X${num(bore.center[0], 2)} Y${num(bore.center[1], 2)}` : ''}
              {bore.cut_diameter_mm && bore.modelled_diameter_mm ? ` · cut Ø${num(bore.cut_diameter_mm, 4)} (modelled Ø${num(bore.modelled_diameter_mm, 4)})` : bore.radius ? ` · Ø${num(bore.radius * 2, 3)}` : ''}</span>
            <small>{bore.covered_segments} of {bore.required_segments} segments</small>
          </button>
        );
      })}
    </div>
  );
}

/** Slot results: each slot's finishing coverage (the backend's); clicking one shows it in the viewport. */
function SlotResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const slots = useCam((state) => state.slots[job.id]);
  const highlight = useCam((state) => state.slotHighlight);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes('slot-check.json') || files.includes('program-check.json');
  useEffect(() => { if (has) void loadSlots(job, originOf(program, jobSetupId(program, job))); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => highlightSlot(null), []);
  if (!has || !slots || (!slots.slots.length && !slots.error)) return null;
  if (slots.error) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Slot results: {slots.error}</span><CopyMessage text={slots.error} /></div>;
  const done = slots.slots.filter((slot) => slot.status === 'passed').length;
  const floor = slots.floor ?? stockTopOf(program, jobSetupId(program, job));
  return (
    <div className={styles.holeResults} id="cam-slot-results">
      <div className={styles.estimatesHead}><SlotIcon size={13} /><b>Slots</b><span>{done} of {slots.slots.length} finished (the engine’s check of the posted moves)</span></div>
      {slots.slots.map((slot) => {
        const Icon = ICON[slot.status as keyof typeof ICON] ?? CircleDashed;
        const key = `${slot.operation}:${slot.slot}`;
        const name = operationName(program, slot.operation);
        return (
          <button key={key} type="button" className={styles.holeRow} data-slot-result={slot.slot} data-s={slot.status} data-on={highlight?.id === key || undefined}
            onClick={() => highlightSlot(highlight?.id === key || !slot.points.length || !slot.width ? null : { id: key, points: slot.points, width: slot.width, z: floor })}
            title={slot.points.length ? 'Show it in the viewport' : undefined}>
            <Icon size={14} />
            <b>{slot.slot.replace(/_/g, ' ')}</b>
            <span>{name}{slot.width ? ` · ${num(slot.width, 3)} mm wide` : ''}</span>
            <small>{slot.covered_segments} of {slot.required_segments} segments</small>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Engraving and chamfer results: each path's coverage by the posted moves (the same conical check for both; a combined
 * program reports them together, split here by the operation's kind). Clicking one draws it: an engraving's groove at
 * the surface, a chamfer's centreline at its lower edge.
 */
/**
 * The open design saved since this program pinned it: the program still machines the revision it pins (its paths,
 * engraving curves and checks), so offer to move it onto the new one and run it again.
 */
function DesignChanged({ program }: { program: ProgramRecord }) {
  const saved = useApp((state) => state.doc.saved);
  const pinned = program.compiled.designs.find((design) => design.alias === 'part')?.pin;
  const [busy, setBusy] = useState(false);
  if (!saved || !pinned || pinned.document_id !== saved.id || saved.revision <= pinned.revision) return null;
  return (
    <div className={styles.banner} data-tone="warn" id="cam-design-changed" data-pinned={pinned.revision} data-saved={saved.revision}>
      <Info size={14} />
      <span><b>The design changed</b> (r{pinned.revision} → r{saved.revision}). This program still machines revision {pinned.revision}: its paths and checks don’t include the edits yet.
        <span className={styles.actions}><Button size="sm" variant="primary" icon={<Play />} id="cam-follow-design" disabled={busy} onClick={() => { setBusy(true); void followDesign(program).finally(() => setBusy(false)); }}>Update to r{saved.revision} and run</Button></span>
      </span>
    </div>
  );
}

/** What a linked engraving path follows: its pinned source's sketch curve ("Mark · Line 3") or model edge, by path ID. */
function engraveSourceLabel(program: ProgramRecord, operation: string, path: string): string | null {
  const op = (program.compiled.operations as Rec[]).find((item) => item.id === sourceOperation(program.id, operation));
  const source = (((op?.strategy as Rec | undefined)?.engrave_sources as Rec[] | undefined) ?? []).find((item) => item.id === path);
  const ref = source?.reference as Rec | undefined;
  if (!ref) return null;
  if (ref.kind === 'sketch_curve') {
    const sketch = horizontalSketches(0.01).find((item) => item.id === ref.sketch);
    return `${sketch?.name ?? String(ref.sketch)} · ${sketch?.curves.find((curve) => curve.entity === ref.entity)?.label ?? String(ref.entity)}`;
  }
  return `Edge ${String((ref.names as string[] | undefined)?.[0] ?? '').split(':').slice(1).join(':')}`;
}

function ConicalResults({ job, program, kind }: { job: JobRecord; program: ProgramRecord; kind: 'engrave' | 'chamfer' }) {
  const results = useCam((state) => state.engrave[job.id]);
  const highlight = useCam((state) => state.slotHighlight);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes(`${kind}-check.json`) || files.includes('program-check.json');
  useEffect(() => { if (has) void loadEngrave(job, originOf(program, jobSetupId(program, job)), program); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => highlightSlot(null), []);
  const ops = program.compiled.operations as Rec[];
  const mine = new Set(ops.filter((op) => kindOf(op) === kind).map((op) => String(op.id)));
  const paths = (results?.paths ?? []).filter((path) => mine.has(sourceOperation(program.id, path.operation)));
  if (!has || !results || (!paths.length && !results.error)) return null;
  const label = kind === 'chamfer' ? 'Chamfer' : 'Engraving';
  if (results.error) return kind === 'engrave' ? <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>{label} results: {results.error}</span><CopyMessage text={results.error} /></div> : null;
  const done = paths.filter((path) => path.status === 'passed').length;
  const Head = kind === 'chamfer' ? ChamferOpIcon : EngraveIcon;
  return (
    <div className={styles.holeResults} id={`cam-${kind}-results`}>
      <div className={styles.estimatesHead}><Head size={13} /><b>{label}</b><span>{done} of {paths.length} {kind === 'chamfer' ? 'chain' : 'path'}{paths.length === 1 ? '' : 's'} covered (the engine’s check of the posted moves)</span></div>
      {paths.map((path) => {
        const Icon = ICON[path.status as keyof typeof ICON] ?? CircleDashed;
        const key = `${kind}:${path.operation}:${path.path}`;
        const name = operationName(program, path.operation);
        const points = path.closed && path.points.length ? [...path.points, path.points[0]] : path.points;
        return (
          <button key={key} type="button" className={styles.holeRow} data-engrave-result={kind === 'engrave' ? path.path : undefined} data-chamfer-result={kind === 'chamfer' ? path.path : undefined}
            data-s={path.status} data-on={highlight?.id === key || undefined}
            onClick={() => highlightSlot(highlight?.id === key || points.length < 2 || path.z === null ? null : { id: key, points, width: kind === 'chamfer' ? 0.3 : path.width ?? 0.05, z: path.z })}
            title={points.length ? 'Show it in the viewport' : undefined}>
            <Icon size={14} />
            <b data-source={kind === 'engrave' && engraveSourceLabel(program, path.operation, path.path) ? 'linked' : undefined}>{(kind === 'engrave' ? engraveSourceLabel(program, path.operation, path.path) : null) ?? path.path.replace(/_/g, ' ')}</b>
            <span>{name}{path.width ? ` · ${num(path.width, 3)} mm ${kind === 'chamfer' ? 'chamfer' : 'wide'}` : ''}{path.closed ? ' · loop' : ''}</span>
            <small>{path.covered_segments} of {path.required_segments} segments</small>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 3D finishing results: each approved path's coverage by the posted moves (the backend's check; it isn't a scallop or
 * finished-part inspection). Clicking one draws its approved tool-tip path in the viewport.
 */
function SurfaceResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const results = useCam((state) => state.surfaces[job.id]);
  const highlight = useCam((state) => state.surfaceHighlight);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes('surface-check.json') || files.includes('program-check.json');
  useEffect(() => { if (has) void loadSurfaces(job, originOf(program, jobSetupId(program, job))); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => highlightSurface(null), []);
  if (!has || !results || (!results.paths.length && !results.error)) return null;
  if (results.error) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>3D finishing results: {results.error}</span><CopyMessage text={results.error} /></div>;
  const done = results.paths.filter((path) => path.status === 'passed').length;
  return (
    <div className={styles.holeResults} id="cam-surface-results">
      <div className={styles.estimatesHead}><ParallelFinishIcon size={13} /><b>3D finishing</b><span>{done} of {results.paths.length} path{results.paths.length === 1 ? '' : 's'} covered (the engine’s check of the posted moves; not a scallop or finished-part inspection)</span></div>
      {results.paths.map((path) => {
        const Icon = ICON[path.status as keyof typeof ICON] ?? CircleDashed;
        const key = `${path.operation}:${path.path}`;
        const name = operationName(program, path.operation);
        const zs = path.points.map((p) => p[2]);
        const [low, high] = zs.length ? [num(Math.min(...zs), 2), num(Math.max(...zs), 2)] : ['', ''];
        return (
          <button key={key} type="button" className={styles.holeRow} data-surface-result={path.path} data-s={path.status} data-on={highlight?.id === key || undefined}
            onClick={() => highlightSurface(highlight?.id === key || path.points.length < 2 ? null : { id: key, points: path.points, closed: path.closed })}
            title={path.points.length ? 'Show it in the viewport' : undefined}>
            <Icon size={14} />
            <b>{path.path.replace(/_/g, ' ')}</b>
            <span>{name}{path.closed ? ' · loop' : ''}{zs.length ? ` · Z ${low === high ? low : `${low}–${high}`}` : ''}</span>
            <small>{path.covered_segments} of {path.required_segments} segments</small>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A setup's starting stock, carried from the setup before (stock-transfer.json, docs/MANUFACTURING_SETUPS.md): the
 * operation it came from, how the part was turned, and whether every cell moved exactly or was enclosed.
 */
function TransferResults({ job, program }: { job: JobRecord; program: ProgramRecord }) {
  const has = job.output?.files.some((file) => file.name === 'stock-transfer.json') ?? false;
  const [loaded, setLoaded] = useState<{ id: string; record: StockTransferRecord | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!has) return;
    let live = true;
    artifactJson<StockTransferRecord>(job.id, 'stock-transfer.json')
      .then((record) => { if (live) setLoaded({ id: job.id, record, error: null }); })
      .catch((error: Error) => { if (live) setLoaded({ id: job.id, record: null, error: error.message }); });
    return () => { live = false; };
  }, [job.id, has]);
  if (!has || !loaded || loaded.id !== job.id) return null;
  if (loaded.error || !loaded.record) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Stock transfer: {loaded.error}</span><CopyMessage text={loaded.error ?? ''} /></div>;
  const record = loaded.record;
  const setup = setupOf(program, jobSetupId(program, job));
  const stock = setup.stock as Rec | undefined;
  const from = (program.compiled.operations as Rec[]).find((op) => op.id === stock?.operation);
  const fromSetup = from ? setupOf(program, String(from.setup ?? '')) : null;
  const sourceBox = fromSetup ? stockBoxOf(program.compiled, String(fromSetup.id)) : null;
  const preset = sourceBox ? presetOf({ origin: record.frame.origin_mm as [number, number, number], x: record.frame.x as [number, number, number], y: record.frame.y as [number, number, number], z: record.frame.z as [number, number, number] }, sourceBox.min, sourceBox.max) : 'custom';
  const exact = record.method === 'grid_permutation';
  const measure = record.result.measure;
  return (
    <div className={styles.banner} data-tone="ok" style={{ margin: '0 0 8px' }} id="cam-transfer-results" data-method={record.method}>
      <SetupIcon size={14} />
      <span>
        <b>Stock from {String(from?.name ?? stock?.operation ?? 'the setup before')}{fromSetup ? ` (${String(fromSetup.name ?? fromSetup.id)})` : ''}</b>, {TRANSFER_LABEL[preset].toLowerCase()}:{' '}
        {exact ? 'every cell carried exactly (the grid turned a quarter or half turn).' : 'each new cell encloses what it could hold, so cells on the boundary stay uncertain.'}{' '}
        {volumeKind({ guaranteed: measure.guaranteed_material_mm3, possible: measure.possible_material_mm3 }) === 'exact'
          ? `${volumeWords({ guaranteed: measure.guaranteed_material_mm3, possible: measure.possible_material_mm3 })} of stock`
          : `Stock ${volumeWords({ guaranteed: measure.guaranteed_material_mm3, possible: measure.possible_material_mm3 })} (at least the first, at most the second)`}; checked against the actual result of the setup before.
      </span>
    </div>
  );
}

/** Tool regions in plain words: `cut_0` → cutter, `holder_0_0` → holder. */
const regionWord = (region: string) => (/^cut/.test(region) ? 'cutter' : /^holder|adapt/.test(region) ? 'holder' : region.replace(/_\d+/g, '').replace(/_/g, ' '));

/**
 * Fixture clearance (docs/MANUFACTURING_FIXTURE_SOLIDS.md): per fixture, whether a tool region collides with it (a
 * witness point inside both), may touch it (unresolved), or was never found near it; how the solids were checked; and
 * a way into the simulation at the first contact.
 */
function FixtureResults({ job }: { job: JobRecord }) {
  const results = useCam((state) => state.fixtureChecks[job.id]);
  const files = job.output?.files.map((file) => file.name) ?? [];
  const has = files.includes('fixtures.json') && (files.includes('fixture-check.json') || files.includes('program-check.json'));
  useEffect(() => { if (has) void loadFixtureChecks(job); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!has || !results || (!results.fixtures.length && !results.error)) return null;
  if (results.error) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Fixture clearance: {results.error}</span><CopyMessage text={results.error} /></div>;
  const refinement = results.refinement;
  const words = { passed: 'clear', failed: 'collision', uncertain: 'unresolved' } as const;
  return (
    <div className={styles.holeResults} id="cam-fixture-results">
      <div className={styles.estimatesHead}><SetupIcon size={13} /><b>Fixture clearance</b>
        <span>{refinement
          ? <>Checked along every move against each fixture’s own solid: {refinement.separated_pairs} of {refinement.evaluated_pairs} close passes proved clear{refinement.failed_pairs ? `, ${refinement.failed_pairs} collide` : ''}{refinement.exhausted_pairs + refinement.numerical_failures ? `, ${refinement.exhausted_pairs + refinement.numerical_failures} left unresolved by the engine’s limits` : ''}.</>
          : <>Checked against each fixture’s bounding box (an older job): contacts there are only possible, not proved.</>}</span>
      </div>
      {results.fixtures.map((fixture) => {
        const Icon = ICON[fixture.status];
        return (
          <div key={fixture.fixture} className={styles.fixtureResult} data-fixture-result={fixture.name} data-s={fixture.status}>
            <div className={styles.holeRow} data-s={fixture.status}>
              <Icon size={14} />
              <b>{fixture.name}</b>
              <span>{fixture.status === 'passed' ? (refinement ? 'No tool region reaches it' : 'No contact found') : fixture.status === 'failed' ? 'The tool collides with it' : 'Possible contact the engine couldn’t resolve'}</span>
            </div>
            {fixture.regions.map((row) => (
              <button key={row.region} type="button" className={styles.holeRow} data-region={row.region} data-s={row.status}
                onClick={() => void showFixtureContact(job, fixture.fixture, row.region)} title="Show it in the simulation">
                {row.status === 'failed' ? <XCircle size={14} /> : <CircleHelp size={14} />}
                <b>{regionWord(row.region)}</b>
                <span>{words[row.status]}{row.status === 'failed' && row.first.witness_mm ? ' · a point inside both' : ''}</span>
                <small>{row.contacts} move{row.contacts === 1 ? '' : 's'}</small>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Rest machining: what the actual remaining stock left to cut (rest-plan.json), or that nothing remained. */
function RestResults({ job }: { job: JobRecord }) {
  const rest = useCam((state) => state.rest[job.id]);
  const has = job.output?.files.some((file) => file.name === 'rest-plan.json') ?? false;
  useEffect(() => { if (has) void loadRest(job); }, [job.id, has]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!has || !rest) return null;
  if (rest.error || !rest.plan) return <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>Rest results: {rest.error}</span><CopyMessage text={rest.error ?? ''} /></div>;
  const plan = rest.plan;
  const empty = plan.status === 'no_remaining_material';
  return (
    <div className={styles.banner} data-tone={empty ? undefined : 'ok'} style={{ margin: '0 0 8px' }} id="cam-rest-results" data-rest={plan.status}>
      <RestIcon size={14} />
      <span>{empty
        ? <><b>Nothing left to cut.</b> The stock the operation before left has no material on this cutter’s paths: the program moves nothing and the stock is unchanged.</>
        : <><b>{num(plan.retained_cut_length_mm, 0)} mm of cutting</b> out of {num(plan.candidate_cut_length_mm, 0)} mm of full pocket paths; {num(plan.proven_air_length_mm, 0)} mm proven to be air and skipped ({plan.required_spans.length} span{plan.required_spans.length === 1 ? '' : 's'} where material remains).</>}</span>
    </div>
  );
}

/**
 * A job's results: the verdict and what to do, each kind's results (holes, contours, fixtures…), then every check
 * folded for engineers. `program`: the revision the job ran (a CAM program's frozen one: its names, setups and work
 * frames); `owner`: the program its Fix edits (a CAM program's document), else `program`; `brief`: the verdict is
 * already above (a CAM program's posted program, whose verdict is its Run's).
 */
function RunResults({ job, program, owner = program, brief }: { job: JobRecord; program: ProgramRecord; owner?: ProgramRecord; brief?: boolean }) {
  const results = useCam((state) => state.results[job.id]);
  const cam = !!owner.cam;
  if (job.status === 'failed' || job.status === 'cancelled') {
    const field = job.error ? failureField(job.error.code, job.error.field) : undefined;
    const operation = job.error?.operation ?? job.operation;
    const hint = job.error ? CODE_HINTS[job.error.code] : undefined;
    const message = job.error ? `${job.error.message}${job.error.code ? ` (${job.error.code})` : ''}` : 'The job was cancelled.';
    return (
      <div className={styles.error} role="alert" id="cam-run-error" data-code={job.error?.code}>
        <AlertTriangle size={13} />
        <span>{hint && <b>{hint} </b>}{message}</span>
        <CopyMessage text={message} />
        {field && field !== 'form' && operation && <Button size="sm" variant="ghost" icon={<Pencil />} id="cam-fix" data-fix-operation={operation} data-field={field} onClick={() => fixField(owner, operation, field, job.error!.message, job.error!.code)}>Fix</Button>}
      </div>
    );
  }
  if (job.status !== 'succeeded') return null;
  const assessment = results?.assessment;
  if (!assessment) return results?.error ? <div className={styles.error} role="alert"><AlertTriangle size={13} /><span>{results.error}</span><CopyMessage text={results.error} /></div> : null;
  const blocked = assessment.download_status === 'blocked_failed_checks';
  const files = job.output?.files ?? [];
  return (
    <div id="cam-results" data-download={assessment.download_status} data-job={job.id}>
      {!brief && <RunSummary summary={summarize(assessment.checks, assessment.input_estimates, assessment.download_status)} program={program} jobOf={() => job}
        diagnostic={assessment.diagnostic?.message} onDetails={showCheckDetails} />}
      {results?.posted && (
        <div className={styles.banner} data-tone="warn" style={{ margin: '0 0 8px' }} id="cam-posted-resolution" data-setup={results.posted.setup}>
          <AlertTriangle size={14} />
          <span><b>{results.posted.message}</b> {postedResolutionNextStep(results.posted, cam ? 'cam' : 'program')}</span>
        </div>
      )}
      <TransferResults job={job} program={program} />
      <RestResults job={job} />
      <HoleResults job={job} program={program} />
      <BoreResults job={job} program={program} />
      <SlotResults job={job} program={program} />
      <ConicalResults job={job} program={program} kind="engrave" />
      <ConicalResults job={job} program={program} kind="chamfer" />
      <ContourResults job={job} program={program} />
      <SurfaceResults job={job} program={program} />
      <FixtureResults job={job} />
      <CheckFamilies job={job} program={program} assessment={assessment} />
      {/* A CAM program's G-code downloads from Run, once posted and checked; an operation's own files aren't its program. */}
      {!cam && <Section title={`Files (${files.length})`} defaultOpen={false} id="cam-files">
        <div className={styles.files}>
          {files.map((file) => (
            <div key={file.name} className={styles.file} data-file={file.name}>
              <span title={file.artifact.sha256}>{file.name}</span>
              <small>{size(file.artifact.bytes)}</small>
              {file.role === 'machine_program'
                ? <button type="button" disabled={blocked} onClick={() => void downloadMachineFile(job)} aria-label="Download the machine file"><Download size={12} /></button>
                : <a href={jobs.artifactUrl(job.id, file.name)} download={file.name} aria-label={`Download ${file.name}`}><Download size={12} /></a>}
            </div>
          ))}
        </div>
      </Section>}
    </div>
  );
}

/** The whole program: run every operation in order (stock carried along), then one combined machine program. */
function ProgramRun({ program }: { program: ProgramRecord }) {
  const runs = useCam((state) => state.runs[program.id]);
  const posts = useCam((state) => state.posts[program.id]);
  const jobsList = useCam((state) => state.jobs[program.id]);
  const activeOperation = useCam((state) => state.activeOperation);
  const ops = program.compiled.operations as Rec[];
  const expansions = useCam((state) => state.expansions);
  // Re-read on every change of runs/posts (latestProgram reads the store).
  const { run: full, last, post, posted } = useMemo(() => latestProgram(program), [program, runs, posts, expansions]); // eslint-disable-line react-hooks/exhaustive-deps
  // Shown: the latest run of this revision (one operation's, or a pattern's instances, when it's newer than the
  // program's own); the combined program is the full run's.
  const run = last && (!full || last.created_at > full.created_at) ? last : full;
  const active = run && !terminal(run.status);
  // What runs: the authored operations, a pattern counted as its instances.
  const executed = expandedOps(program)?.length ?? ops.length;
  const combined = executed > 1;
  const playable = combined ? posted : null;
  const compiled = program.compiled;
  // Several setups: one combined machine program per setup (each clamped and run on its own).
  const multi = (compiled.setups as unknown[]).length > 1;
  const activeJob = useCam((state) => state.activeJob);
  const outputs = useMemo(() => (multi ? setupPosts(program) : {}), [program, multi, posts]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => operationName(program, id);
  const childJob = (id: string | null) => (id ? (jobsList ?? []).find((job) => job.id === id) ?? null : null);
  return (
    <Section title="Program" id="cam-program-run" actions={active
      ? <Button size="sm" variant="ghost" icon={<SquareX />} onClick={() => void cancelRun(run!)} id="cam-cancel-run">Cancel run</Button>
      : <Button size="sm" variant="primary" icon={<Play />} onClick={() => void runProgram(program)} id="cam-run-program" disabled={!ops.length}>{run?.status === 'succeeded' ? 'Run again' : 'Run program'}</Button>}>
      {!run && (
        <p className={styles.note} style={{ margin: '0 0 8px' }}>
          {multi ? <>Every operation in order, each on the stock the one before leaves; <b>one machine file per setup</b>, checked as posted.</>
            : combined ? <>Every operation in order, each on the stock the one before leaves; <b>one machine file</b> with its tool changes, checked as posted.</>
              : <>The operation, posted and checked as one machine file.</>}
        </p>
      )}
      {run && (
        <div className={styles.runOps} id="cam-run-ops" data-run={run.id} data-status={run.status}>
          {run.operations.map((op) => {
            const job = childJob(op.job_id);
            return (
              <div key={op.operation} className={styles.runOp} data-run-op={op.operation} data-s={op.status}>
                <i />
                <span>{name(op.operation)}</span>
                <small>{op.status === 'running' && job ? `${Math.round(job.progress * 100)}% · ${STAGE[job.stage] ?? job.stage}` : RUN_OP[op.status] ?? op.status}</small>
              </div>
            );
          })}
          {run.status === 'failed' && (run.error || run.operations.find((op) => op.error)) && (() => {
            const failed = run.operations.find((op) => op.error);
            const error = failed?.error ?? run.error!;
            const field = failureField(error.code, error.field);
            const operation = error.operation ?? failed?.operation ?? null;
            return (
              <div className={styles.error} role="alert" style={{ margin: '6px 0 0' }} id="cam-run-failure" data-code={error.code}>
                <AlertTriangle size={13} />
                <span>{CODE_HINTS[error.code] && <b>{CODE_HINTS[error.code]} </b>}{error.message} ({error.code})</span>
                <CopyMessage text={`${error.message} (${error.code})`} />
                {field && field !== 'form' && <Button size="sm" variant="ghost" icon={<Pencil />} id="cam-run-fix" data-fix-operation={operation ?? undefined} data-field={field} onClick={() => fixField(program, operation, field, error.message, error.code)}>Fix</Button>}
              </div>
            );
          })()}
        </div>
      )}
      {multi && full?.status === 'succeeded' && (compiled.setups as Rec[]).map((setup) => {
        const id = String(setup.id);
        const output = outputs[id] ?? { post: null, posted: null };
        const mine = ops.filter((op) => String(op.setup ?? 'setup') === id);
        return (
          <div key={id} className={styles.op} data-setup-output={id} data-active={(activeOperation === null && !!output.post && activeJob === output.post.id) || undefined} style={{ marginTop: 8 }}>
            <button type="button" className={styles.opHead} onClick={() => { useCam.setState({ activeOperation: null, activeJob: output.post?.id ?? null }); if (output.post) selectJob(output.post); }} data-select-setup={id}>
              <SetupIcon size={16} />
              <div>
                <b>{String(setup.name ?? id)} program</b>
                <small>{mine.length} operation{mine.length === 1 ? '' : 's'} · {new Set(mine.map((op) => String((op.strategy as Rec | undefined)?.tool ?? ''))).size} tool{new Set(mine.map((op) => String((op.strategy as Rec | undefined)?.tool ?? ''))).size === 1 ? '' : 's'} · its own file, run after clamping</small>
              </div>
              <StatusPill job={output.post} />
            </button>
            {output.post && !terminal(output.post.status) && <Progress job={output.post} />}
            <div className={styles.opActions}>
              {!output.post && <Button size="sm" variant="primary" icon={<Play />} onClick={() => void postRun(full, undefined, id)} data-post-setup={id}>Post this setup</Button>}
              <Button size="sm" icon={<SimulateToolIcon size={14} />} disabled={!output.posted} onClick={() => output.posted && void openPlayer(output.posted)} data-simulate-setup={id}>Simulate</Button>
              <Button size="sm" variant="ghost" icon={<Download />} disabled={!output.posted} onClick={() => output.posted && void downloadMachineFile(output.posted)} data-download-setup={id}>Machine file</Button>
            </div>
          </div>
        );
      })}
      {!multi && combined && full?.status === 'succeeded' && (
        <div className={styles.op} data-operation="__program__" data-active={activeOperation === null || undefined} style={{ marginTop: 8 }}>
          <button type="button" className={styles.opHead} onClick={() => { useCam.setState({ activeOperation: null, activeJob: post?.id ?? null }); if (post) selectJob(post); }} id="cam-combined">
            <SetupIcon size={16} />
            <div>
              <b>Combined program</b>
              <small>{executed} operation{executed === 1 ? '' : 's'}{executed !== ops.length ? ` (${ops.length} authored)` : ''} · {new Set(ops.map((op) => String((op.strategy as Rec | undefined)?.tool ?? ''))).size} tools · one file</small>
            </div>
            <StatusPill job={post} />
          </button>
          {post && !terminal(post.status) && <Progress job={post} />}
          <div className={styles.opActions}>
            {!post && <Button size="sm" variant="primary" icon={<Play />} onClick={() => void postRun(full)} id="cam-post-run">Post the program</Button>}
            <Button size="sm" icon={<SimulateToolIcon size={14} />} disabled={!playable} onClick={() => playable && void openPlayer(playable)} id="cam-simulate-program">Simulate</Button>
            <Button size="sm" variant="ghost" icon={<Download />} disabled={!playable} onClick={() => playable && void downloadMachineFile(playable)} id="cam-download-program">Machine file</Button>
          </div>
        </div>
      )}
    </Section>
  );
}

/** The selected program, or (`setupId`) one setup of it with its operations. */
export default function ProgramView({ program, setupId }: { program: ProgramRecord; setupId?: string }) {
  const all = useCam((state) => state.jobs[program.id]);
  const list = useMemo(() => all ?? [], [all]);
  const posts = useCam((state) => state.posts[program.id]);
  const activeOperation = useCam((state) => state.activeOperation);
  const activeJob = useCam((state) => state.activeJob);
  const capabilities = useCam((state) => state.capabilities);
  const records = useMfg((state) => state.records);
  useCam((state) => state.expansions);  // Instance names and counts arrive with the expansion.
  useEffect(() => { void loadJobs(program.id); }, [program.id]);
  useEffect(() => { void loadExpansion(program); }, [program.id, program.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const compiled = program.compiled;
  const setups = (compiled.setups as Rec[]).filter((item) => !setupId || String(item.id) === setupId);
  const transferable = !!capabilities?.some((item) => item.manual_stock_transfer);
  const pins = new Map(compiled.libraries.map((item) => [item.alias, item.pin]));
  const name = (alias: unknown) => { const pin = pins.get(String(alias)); return pin ? `${records.find((record) => record.id === pin.id)?.definition.name ?? pin.kind} r${pin.revision}` : '—'; }
  // The setup's machine's controller decides which built-in post runs (its label comes from /capabilities).
  const builtInPosts = useCam((state) => state.builtInPosts);
  const builtInPost = (alias: unknown) => {
    const pin = pins.get(String(alias));
    const machine = pin && records.find((record) => record.id === pin.id);
    const controllerPin = machine?.definition.controller as { id?: string } | undefined;
    const dialect = records.find((record) => record.id === controllerPin?.id)?.definition.dialect as string | undefined;
    return (dialect && builtInPosts[dialect]) || 'Built-in';
  };;
  const ops = (compiled.operations as Rec[]).filter((op) => !setupId || String(op.setup ?? 'setup') === setupId);
  const opId = activeOperation && ops.some((op) => op.id === activeOperation) ? activeOperation : null;
  const executed = expandedOps(program)?.length ?? ops.length;
  const programPost = !opId && executed > 1 ? (posts ?? []).find((job) => job.id === activeJob) ?? (posts ?? []).find((job) => job.revision === program.revision) ?? null : null;
  const ofOp = (job: JobRecord, id: string) => job.operation === id || (!!job.operation && sourceOperation(program.id, job.operation) === id);
  // A CAM program runs as a whole (Run), and its code is shown and edited here. Its results are its last run's jobs
  // (useCamRunJobs): the selected operation's, else the posted program's (the whole program's checks).
  const cam = !!program.cam;
  const runJobs = useCamRunJobs(program);
  const runList = [...runJobs.operations.map((row) => row.job), runJobs.post].filter((job): job is JobRecord => !!job);
  const selected = cam
    ? runList.find((job) => job.id === activeJob) ?? (opId ? runJobs.of(opId) : runJobs.post) ?? null
    : programPost ?? list.find((job) => job.id === activeJob) ?? list.find((job) => ofOp(job, opId ?? String(ops[0]?.id ?? ''))) ?? null;
  const selectedName = !selected ? '' : selected.id === runJobs.post?.id ? 'Posted program' : selected.operation ? operationName(runJobs.frozen ?? program, selected.operation) : 'Run';
  useEffect(() => { if (selected?.status === 'succeeded') void loadResults(selected); }, [selected]);
  // Moves and removals: one new revision each; what worked on a removed operation's stock carries on (programEdits.ts).
  const move = (id: string, delta: -1 | 1) => moveOperationOf(program, id, delta);
  const remove = (id: string) => deleteOperationChecked(program, id);
  return (
    <div id="program-view" data-program={program.id} data-revision={program.revision}>
      <div className={panel.hero}>
        <span className={panel.heroIcon}><SetupIcon size={18} /></span>
        <div className={panel.heroText}>
          <div className={panel.heroTitle}>{setupId ? String(setups[0]?.name ?? 'Setup') : compiled.name}</div>
          <div className={panel.heroSub}>{setupId ? `Setup · ${ops.length ? `${ops.length} operation${ops.length === 1 ? '' : 's'}` : 'no operations yet'}` : 'Milling'} · revision {program.revision} · {cam ? 'part' : 'design'} r{compiled.designs[0]?.pin.revision}</div>
        </div>
      </div>
      <DesignChanged program={program} />
      {/* A CAM program's review is its frozen revision's (the one its run holds). */}
      {(cam ? runJobs.frozen : program) && <ReferenceReviewBanner program={cam ? runJobs.frozen! : program} editor={cam ? program : undefined}
        onCheck={(operation) => editOperation(program, operation, { heights: CHECK_HEIGHTS })} />}
      {!setups.length && (
        <div className={panel.empty} style={{ height: 'auto', paddingTop: 24 }} id="cam-no-setups">
          <SetupIcon size={26} />
          <p>No setups yet: the machine and its tools, the stock and program zero.</p>
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => void newSetupTool()} id="cam-program-new-setup">New setup</Button>
        </div>
      )}
      {setups.length > 0 && <Section title={setups.length > 1 ? `Setups (${setups.length})` : 'Setup'} id="cam-setup-summary"
        actions={<Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => editSetup(program, String(setups[0]?.id ?? 'setup'))} id="cam-edit-setup">Edit</Button>}>
        {setups.map((item, index) => {
          const id = String(item.id);
          const box = stockBoxOf(compiled, id);
          const dims = box ? box.max.map((value, axis) => num(value - box.min[axis], 2)).join(' × ') : '—';
          const stock = item.stock as Rec | undefined;
          const from = stock?.kind === 'previous_operation' ? (ops.find((op) => op.id === stock.operation) ?? null) : null;
          const fromSetup = from ? setupOf(program, String(from.setup ?? '')) : null;
          const sourceBox = from ? stockBoxOf(compiled, String(fromSetup?.id ?? 'setup')) : null;
          const transfer = stock?.transfer as Rec | undefined;
          const preset = transfer && sourceBox ? presetOf({ origin: transfer.origin_mm as [number, number, number], x: transfer.x as [number, number, number], y: transfer.y as [number, number, number], z: transfer.z as [number, number, number] }, sourceBox.min, sourceBox.max) : 'custom';
          const origin = originOf(program, id);
          const fixtures = (item.fixtures as Rec[] | undefined) ?? [];
          return (
            <div key={id} className={styles.setupCard} data-setup={id}>
              {setups.length > 1 && (
                <div className={styles.setupHead}>
                  <SetupIcon size={14} /><b>{String(item.name ?? id)}</b>
                  {index > 0 && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => editSetup(program, id)} data-edit-setup={id}>Edit</Button>}
                </div>
              )}
              <div className={styles.spec} style={{ margin: 0 }}>
                <span>Machine <b>{name(item.machine)}</b></span>
                <span>Tools <b>{name(item.tooling)}</b></span>
                <span>Post <b>{item.post ? name((item.post as Rec).library) : builtInPost(item.machine)}</b></span>
                {from
                  ? <span data-transfer={id}>Stock <b>what {String(from.name ?? from.id)} leaves</b> in {String(fromSetup?.name ?? '')} · {TRANSFER_LABEL[preset].toLowerCase()} · {dims} mm</span>
                  : <span>Stock <b>{dims} mm</b></span>}
                {item.work_to_machine === undefined
                  ? <span>Zero <b>at the middle of the machine’s travel</b></span>
                  : <span>Zero at X{num(origin[0], 2)} Y{num(origin[1], 2)} Z{num(origin[2], 2)} (machine)</span>}
                <span>Fixtures <b>{fixtures.length}</b>{item.fixture_coverage === 'missing' ? ' · not all modelled' : ''}</span>
              </div>
            </div>
          );
        })}
        {transferable && ops.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => addSetup(program)} id="cam-add-setup"
            title="Unclamp the part, turn it and clamp it again: the next setup machines the stock this one leaves">New setup (turn the part over)</Button>
        )}
      </Section>}
      <Section title={`Operations (${ops.length})`} id="cam-ops">
        {/* Operations are added from the ribbon (or a setup's right-click menu), after the last one in the selected setup. */}
        {!ops.length && <p className={styles.note} id="cam-no-ops">No operations yet: choose one from the ribbon (Face, Pocket, Drill…) and it goes into {setupId ? 'this setup' : 'the selected setup'}.</p>}
        <div className={styles.ops}>
          {ops.map((op, index) => {
            const id = String(op.id);
            const kind = kindOf(op);
            const strategy = (op.strategy ?? {}) as Rec;
            // A pattern's jobs are its instances'. The tree's dot reads the same (operationJob).
            const { job: latest, stale, revision } = operationJob(program, runJobs, list, id);
            const done = cam ? (latest?.status === 'succeeded' ? latest : null) : list.find((job) => ofOp(job, id) && job.status === 'succeeded') ?? null;
            const pattern = op.pattern as { layout?: Rec; suppress?: string[] } | undefined;
            const instances = pattern ? (expandedOps(program) ?? []).filter((item) => item.pattern_instance?.source_operation === id) : [];
            const running = latest && !terminal(latest.status) ? latest : null;
            const after = (op.depends_on as string[] | undefined) ?? [];
            const target = ((op.targets as Rec[] | undefined) ?? [])[0];
            const heights = kind === 'face' ? `Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`
              : kind === 'contour' ? `${target?.kind === 'edge' ? `${(target.names as string[]).length} edge${(target.names as string[]).length === 1 ? '' : 's'}, ${String(strategy.contour_side ?? 'auto')} side` : target?.kind === 'face' ? `${(target.names as string[]).length} face${(target.names as string[]).length === 1 ? '' : 's'}` : `${String(strategy.contour_boundary ?? 'outer') === 'outer' ? 'outside' : String(strategy.contour_boundary)} outline`} · Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`
              : isDrilling(kind) ? `${kind === 'peck_drill' ? `peck ${num(Number(strategy.peck_mm ?? 0))} · ` : ''}to Z ${num(Number(strategy.bottom_mm ?? 0))} (${strategy.drill_depth_reference === 'full_diameter' ? 'full Ø' : 'tip'})`
                : kind === 'bore' ? `${target?.kind === 'face' ? `${(target.names as string[]).length} bore${(target.names as string[]).length === 1 ? '' : 's'}` : 'every bore'} · ${strategy.entry === 'helix' ? 'helix' : 'plunge'} · Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`
                  : kind === 'slot' ? `${((strategy.slot_guides as unknown[] | undefined) ?? []).length ? `${((strategy.slot_guides as unknown[]).length)} centreline${(strategy.slot_guides as unknown[]).length === 1 ? '' : 's'}` : target?.kind === 'face' ? 'picked floor' : 'every slot floor'} · Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`
                  : kind === 'engrave' ? `${((strategy.engrave_paths as unknown[] | undefined) ?? []).length} path${((strategy.engrave_paths as unknown[] | undefined) ?? []).length === 1 ? '' : 's'} · ${num(Number(strategy.top_mm ?? 0) - Number(strategy.bottom_mm ?? 0), 3)} mm deep at Z ${num(Number(strategy.top_mm ?? 0))}`
                  : kind === 'chamfer' ? `${strategy.chamfer_intent === 'existing_chamfer' ? 'modelled bevel' : `${num(Number(strategy.chamfer_width_mm ?? 0), 3)} mm`} · ${target?.kind === 'edge' ? `${(target.names as string[]).length} edge${(target.names as string[]).length === 1 ? '' : 's'}, ${String(strategy.chamfer_side ?? 'auto')} side` : target?.kind === 'face' ? `${(target.names as string[]).length} face${(target.names as string[]).length === 1 ? '' : 's'}` : `${String(strategy.chamfer_boundary ?? 'outer') === 'outer' ? 'outside' : String(strategy.chamfer_boundary)} top outline`} · lower edge Z ${num(Number(strategy.bottom_mm ?? 0))}`
                  : kind === 'rough' ? `${strategy.entry === 'helix' ? 'helix · ' : ''}leaves ${num(Number(strategy.radial_allowance_mm ?? 0))} walls, ${num(Number(strategy.axial_allowance_mm ?? 0))} floor · Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`
                  : kind === 'rest' ? `after ${String(ops.find((other) => other.id === strategy.rest_from)?.name ?? strategy.rest_from ?? '?')} · Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`
                    : `${kind === 'pocket' && strategy.entry && strategy.entry !== 'plunge' ? `${String(strategy.entry)} entry · ` : ''}Z ${num(Number(strategy.top_mm ?? 0))} → ${num(Number(strategy.bottom_mm ?? 0))}`;
            const tabs = kind === 'contour' ? ((strategy.contour_tabs as unknown[] | undefined) ?? []).length : 0;
            const setupId = String(op.setup ?? 'setup');
            const opening = setups.length > 1 && (index === 0 || String(ops[index - 1].setup ?? 'setup') !== setupId);
            return (
              <div key={id} style={{ display: 'contents' }}>
              {opening && <div className={styles.setupDivider} data-setup-head={setupId}><SetupIcon size={13} />{String(setupOf(program, setupId).name ?? setupId)}</div>}
              <div className={styles.op} data-active={id === opId || undefined} data-operation={id} data-kind={kind} data-setup={setupId}>
                <button type="button" className={styles.opHead} onClick={() => { useCam.setState({ activeOperation: id, activeJob: latest?.id ?? null }); if (latest) selectJob(latest); }}>
                  <span className={styles.opIndex}>{index + 1}</span>
                  <OpIcon kind={kind} />
                  <div>
                    <b>{String(op.name ?? id)}</b>
                    <small>{OP_LABEL[kind]} · {name(strategy.tool)} · {heights}{tabs ? ` · ${tabs} tab${tabs === 1 ? '' : 's'}` : ''}{pattern ? ` · ${patternSummary(pattern)}` : ''}{stale ? (cam ? ' · before the last change' : ` · last run r${latest!.revision}`) : ''}</small>
                  </div>
                  <StatusPill job={latest} revision={revision} />
                </button>
                {running && <Progress job={running} />}
                {instances.length > 0 && (
                  <div className={styles.instances} style={{ margin: '0 10px 6px' }} data-pattern-instances={id}>
                    {instances.map((instance) => {
                      const job = list.find((item) => item.operation === instance.id) ?? null;
                      const key = instanceKey(program.id, instance.id) ?? instance.id;
                      return (
                        <button key={instance.id} type="button" data-instance={key} data-job-status={job?.status ?? 'none'} data-on={job && job.id === activeJob ? true : undefined}
                          title={`${instance.name}${job ? ` · ${job.status}` : ' · not generated yet'}`} onClick={() => { if (job) selectJob(job); }} disabled={!job}>
                          <i className={styles.instanceDot} data-s={job?.status ?? 'none'} />{key}
                        </button>
                      );
                    })}
                  </div>
                )}
                {id === opId && after.length > 0 && <p className={styles.note} style={{ margin: '0 10px 8px' }}>After {after.map((item) => String(ops.find((other) => other.id === item)?.name ?? item)).join(', ')}, on the stock it leaves: generating this runs those first.</p>}
                {/* The selected operation's actions (the ribbon's Generate, Simulate and Post act on it too). */}
                {(id === opId || running) && <div className={styles.opActions}>
                  {cam ? null : running
                    ? <Button size="sm" variant="ghost" icon={<SquareX />} onClick={() => void cancelJob(running)} id="cam-cancel">Cancel</Button>
                    : <Button size="sm" variant="primary" icon={<Play />} onClick={() => void runOperation(program, id)} data-generate={id}>{done && !stale ? 'Generate again' : 'Generate'}</Button>}
                  {!cam && <Button size="sm" icon={<SimulateToolIcon size={14} />} disabled={!done} onClick={() => done && void openPlayer(done)} data-simulate={id}>Simulate</Button>}
                  {!cam && <Button size="sm" variant="ghost" icon={<Download />} disabled={!done} onClick={() => done && void downloadMachineFile(done)} data-download={id}>Machine file</Button>}
                  <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => editOperation(program, id)} data-edit={id}>Edit</Button>
                  <span className={styles.opOrder}>
                    <button type="button" className={styles.iconBtn} aria-label={`Move ${String(op.name ?? id)} up`} title="Move up (runs earlier)" disabled={index === 0 || opening} onClick={() => move(id, -1)} data-move-up={id}><ArrowUp size={13} /></button>
                    <button type="button" className={styles.iconBtn} aria-label={`Move ${String(op.name ?? id)} down`} title="Move down (runs later)" disabled={index === ops.length - 1 || String(ops[index + 1].setup ?? 'setup') !== setupId} onClick={() => move(id, 1)} data-move-down={id}><ArrowDown size={13} /></button>
                    <button type="button" className={styles.iconBtn} aria-label={`Remove ${String(op.name ?? id)}`} title="Remove (a new revision; earlier revisions keep it)" onClick={() => remove(id)} data-remove={id}><Trash2 size={13} /></button>
                  </span>
                </div>}
              </div>
              </div>
            );
          })}
        </div>
      </Section>
      {/* The whole program's run: not for one setup on its own, nor before there's anything to run. */}
      {!setupId && !cam && ops.length > 0 && <ProgramRun program={program} />}
      {/* A CAM program runs as a whole, so its run shows in each setup too: where Generate was pressed. */}
      {cam && <CamRunSection program={program} />}
      {selected && !cam && (
        <Section title={`${programPost ? 'Combined program' : 'Run'} · ${when(selected.created_at)}${selected.cached_from ? ' · same as before' : ''}`} id="cam-run">
          <RunResults job={selected} program={program} />
        </Section>
      )}
      {selected && cam && !setupId && (
        <Section title={`Results · ${selectedName}`} id="cam-run" actions={<small className={styles.note} style={{ margin: 0 }}
          title={selected.cached_from ? 'Nothing it depends on changed, so the earlier result was used again.' : undefined}>{when(selected.created_at)}{selected.cached_from ? ' · same as before' : ''}</small>}>
          {runJobs.stale && <p className={styles.note} style={{ margin: '0 0 8px' }} id="cam-results-stale" data-tone="warn">From the last run, before the program’s latest change: Run again to check the program as it is now.</p>}
          {/* The posted program's verdict is the Run's, just above. */}
          <RunResults job={selected} program={runJobs.frozen ?? program} owner={program} brief={selected.id === runJobs.post?.id && runJobs.posts.length <= 1} />
        </Section>
      )}
      {list.length > 0 && (
        <Section title={`History (${list.length + (posts?.length ?? 0)})`} defaultOpen={false} id="cam-history">
          <div className={styles.history}>
            {[...list, ...(posts ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((job) => (
              <button key={job.id} type="button" className={styles.historyRow} data-on={job.id === selected?.id || undefined} onClick={() => selectJob(job)} data-job={job.id}>
                <span>{job.operation ? operationName(program, job.operation) : 'Combined program'} · r{job.revision}</span>
                <small>{when(job.created_at)}</small>
                <StatusPill job={job} />
              </button>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}


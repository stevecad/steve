/**
 * A CAM program's own sections in the inspector (cam/camDoc.ts): Run (every operation, the post for the machine and
 * Steve's check of the G-code, step by step), what the check found, and Download G-code (with what the controller rounds,
 * for a program posted at six decimals: cam/postedResolution.ts). Each operation of the run and the posted program are
 * a click away from their own results (ProgramView: the same panels a program's runs show, from the run's jobs). Its
 * code is in the code editor (state/codeTargets.ts).
 */
import { useEffect, useMemo } from 'react';
import { AlertTriangle, Download, Pencil, Play } from 'lucide-react';
import { Button, Section, Spinner } from '@/ui';
import { SimulateToolIcon } from '@/icons/cad';
import CopyMessage from '@/shell/CopyMessage';
import type { CamFailure, CamPost } from '@/lib/api';
import type { JobRecord, ProgramRecord } from '../api';
import { downloadGcode, failureText, runCam, runMayBeStale, simulateCam, useCamDoc } from './camDoc';
import { postedResolutionNextStep } from './postedResolution';
import { CODE_HINTS, failureField } from './program';
import { fixField, loadJobs, loadResults, openPlayer, operationName, selectJob, sourceOperation, useCam, type Results } from './state';
import { RunSummary } from '@/workspaces/manufacture/cam/ChecksView';
import { summarize, type SummaryCheck } from './checkSummary';
import styles from './Cam.module.css';

const STAGE: Record<string, string> = {
  reviewing: 'The part changed: comparing how the selections land on it', running: 'Running the operations', posting: 'Posting the G-code and checking it', verified: 'Verified: Steve’s checks passed',
  checked: 'Posted: not every check passed', failed: 'Failed',
};
const OP_STATUS: Record<string, string> = { waiting: 'Waiting', queued: 'Queued', running: 'Running', checking: 'Checking', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', blocked: 'Blocked by an earlier failure' };

/** A failure in Steve's words; Fix opens the form on the field it names (as a program's run failures do). */
function Failure({ error, id, program, operation }: { error: CamFailure; id?: string; program: ProgramRecord; operation?: string | null }) {
  const field = failureField(error.code, error.field);
  const target = error.operation ?? operation ?? null;
  const hint = CODE_HINTS[error.code];
  return (
    <div className={styles.error} role="alert" id={id} data-code={error.code}>
      <AlertTriangle size={13} />
      <span>{hint && <b>{hint} </b>}<b>{error.message}</b>{error.why ? ` ${error.why}` : ''}{error.next_step ? <> <b>Next:</b> {error.next_step}</> : null}</span>
      <CopyMessage text={`${failureText(error)} (${error.code})`} />
      {field && field !== 'form' && (target || ['machine', 'tooling', 'stock', 'placement', 'fixtures', 'post', 'material', 'inspection'].includes(field)) && (
        <Button size="sm" variant="ghost" icon={<Pencil />} data-fix-operation={target ?? undefined} data-field={field}
          onClick={() => fixField(program, target, field, error.message, error.code, error.setup)}>Fix</Button>
      )}
    </div>
  );
}

/** A CAM program's last run as jobs (its frozen program's): each operation's, the posted program's, and whether the
 * program may have changed since. */
export interface CamRunJobs {
  frozen: ProgramRecord | null;
  operations: { operation: string; source: string; job: JobRecord | null }[];
  post: JobRecord | null;
  /** With several setups, each setup's post (one machine file each), in setup order. */
  posts: { setup: string | null; job: JobRecord | null }[];
  stale: boolean;
  /** The run's job of an authored operation (its first instance's, for a pattern). */
  of: (operation: string) => JobRecord | null;
}

export function useCamRunJobs(program: ProgramRecord): CamRunJobs {
  const id = program.cam?.document_id ?? '';
  const run = useCamDoc((state) => state.runs[id]);
  const frozen = useCamDoc((state) => state.frozen[id]) ?? null;
  const doc = useCamDoc((state) => state.docs[id]);
  const list = useCam((state) => (frozen ? state.jobs[frozen.id] : undefined));
  const posts = useCam((state) => (frozen ? state.posts[frozen.id] : undefined));
  useCam((state) => state.expansions);
  const operations = run?.state?.run?.operations ?? run?.last?.run?.operations ?? [];
  const postId = (run?.state?.post ?? run?.last?.post)?.job_id ?? null;
  const setupPosts = run?.state?.posts ?? run?.last?.posts ?? [];
  const key = `${operations.map((op) => `${op.operation}:${op.job_id ?? ''}`).join(',')}|${postId ?? ''}|${setupPosts.map((post) => post.job_id).join(',')}`;
  // The run's jobs are its frozen program's: read them (and their results) once the run names them.
  const named = operations.some((op) => op.job_id) || !!postId || setupPosts.length > 0;
  useEffect(() => { if (frozen && id && named) void loadJobs(frozen.id); }, [frozen?.id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const byId = new Map([...(list ?? []), ...(posts ?? [])].map((job) => [job.id, job]));
    const rows = operations.map((op) => ({ operation: op.operation, source: frozen ? sourceOperation(frozen.id, op.operation) : op.operation, job: op.job_id ? byId.get(op.job_id) ?? null : null }));
    return {
      frozen, operations: rows, post: postId ? byId.get(postId) ?? null : null, stale: id ? runMayBeStale(id) : false,
      posts: setupPosts.map((post) => ({ setup: post.setup, job: byId.get(post.job_id) ?? null })),
      of: (operation: string) => rows.find((row) => row.operation === operation || row.source === operation)?.job ?? null,
    };
  }, [list, posts, key, frozen, doc, run]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * An operation's latest job and the revision its status reads against, the same for its card and its tree row: a CAM
 * program's is its last run's (the frozen program's jobs, "Out of date" once the program may have changed), a
 * program's its own latest (a pattern's, its first instance's). `list`: the program's own jobs.
 */
export function operationJob(program: ProgramRecord, runJobs: CamRunJobs, list: JobRecord[], operation: string): { job: JobRecord | null; stale: boolean; revision: number | undefined } {
  if (program.cam) {
    const job = runJobs.of(operation);
    const stale = !!job && runJobs.stale;
    return { job, stale, revision: stale ? -1 : job?.revision };
  }
  const job = list.find((item) => item.operation === operation || (!!item.operation && sourceOperation(program.id, item.operation) === operation)) ?? null;
  return { job, stale: !!job && job.revision !== program.revision, revision: program.revision };
}

/**
 * What an operation's (or the posted program's) checks found, as the check reported it: failed if any failed, else
 * uncertain if any is, else not all assessed if any isn't, else passed. Null until its results are read.
 */
export function checksVerdict(results: Results | undefined): { s: 'failed' | 'uncertain' | 'unassessed' | 'passed'; label: string } | null {
  const checks = results?.assessment?.checks;
  if (!checks) return null;
  const count = (status: string) => checks.filter((check) => check.status === status).length;
  if (count('failed')) return { s: 'failed', label: `${count('failed')} check${count('failed') === 1 ? '' : 's'} failed` };
  if (count('uncertain')) return { s: 'uncertain', label: `${count('uncertain')} uncertain` };
  if (count('unassessed')) return { s: 'unassessed', label: `${count('unassessed')} not assessed` };
  return { s: 'passed', label: 'checks passed' };
}

/** One row of the run: an operation (or the posted program), its status and its checks' verdict; a click shows its results. */
function RunRow({ name, status, job, error, program, operation, id, setup }: { name: string; status: string; job: JobRecord | null; error?: CamFailure | null; program: ProgramRecord; operation: string | null; id?: string; setup?: string | null }) {
  const results = useCam((state) => (job ? state.results[job.id] : undefined));
  const activeJob = useCam((state) => state.activeJob);
  const verdict = status === 'succeeded' ? checksVerdict(results) : null;
  const words = OP_STATUS[status] ?? status;
  // An operation that generated plays on its own, whatever happened after it; posts have their own Simulate.
  const playable = operation !== null && job?.status === 'succeeded' && !!program.cam;
  return (
    <div style={{ display: 'contents' }}>
      <div className={styles.runRow}>
        <button type="button" className={styles.runOp} data-run-op={operation ?? '__program__'} data-post-setup={setup ?? undefined} data-s={status} data-verdict={verdict?.s} data-on={(!!job && job.id === activeJob) || undefined} id={id}
          disabled={!job} title={job ? 'Show its results' : undefined}
          onClick={() => { if (!job) return; useCam.setState({ activeOperation: operation, activeJob: job.id }); selectJob(job); }}>
          <i /><span>{name}</span><small>{verdict ? `${words} · ${verdict.label}` : words}</small>
        </button>
        {playable && (
          <button type="button" className={styles.runPlay} title="Simulate this operation" aria-label={`Simulate ${name}`} data-simulate-op={operation}
            onClick={() => void openPlayer(job!)}><SimulateToolIcon size={13} /></button>
        )}
      </div>
      {error && <Failure error={error} program={program} operation={operation} />}
    </div>
  );
}

/** Run: the stage, each operation's status, then the check's verdict and what to do about it, and the G-code. */
export function CamRunSection({ program }: { program: ProgramRecord }) {
  const id = program.cam!.document_id;
  const run = useCamDoc((state) => state.runs[id]);
  const saving = useCamDoc((state) => state.saving?.id === id);
  const state = run?.state ?? null;
  const last = run?.last ?? null;
  const ops = program.compiled.operations as { id?: string }[];
  const operations = state?.run?.operations ?? last?.run?.operations ?? [];
  const stage = state?.stage ?? (last?.run ? (last.post?.status === 'succeeded' ? null : last.run.status === 'failed' ? 'failed' : last.run.status === 'succeeded' ? 'posting' : 'running') : null);
  const verification = state?.verification;
  const posted = (state?.post ?? last?.post)?.status === 'succeeded';
  // Posted at six decimals for a controller that rounds finer words: said beside its check and its G-code.
  const rounding = state ? state.posted_resolution : last?.posted_resolution;
  const error = state?.error ?? (state?.stage === 'failed' ? state.post?.error ?? state.run?.error ?? null : null);
  const busy = !!run?.running;
  const name = (operation: string) => operationName(program, operation);
  const runJobs = useCamRunJobs(program);
  const postStatus = (state?.post ?? last?.post)?.status ?? null;
  // One machine file per setup: with several setups, each has its post, check, G-code and simulation.
  const setupPosts = (state?.posts ?? last?.posts ?? []) as CamPost[];
  const perSetup = setupPosts.length > 1;
  const setupName = (setup: string | null | undefined) => (program.compiled.setups as { id?: string; name?: string }[]).find((item) => item.id === setup)?.name ?? setup ?? '';
  // The check, summarized: from the posted programs' own results (every check and the estimated inputs) once they're
  // read, else from the run's list of what didn't pass.
  const postJobs = useMemo(() => (perSetup ? runJobs.posts.map((post) => ({ setup: post.setup, job: post.job })) : [{ setup: null, job: runJobs.post }]), [perSetup, runJobs]);
  const results = useCam((state) => state.results);
  const postKey = postJobs.map((post) => `${post.job?.id ?? ''}:${post.job?.status ?? ''}`).join(',');
  useEffect(() => { for (const post of postJobs) if (post.job?.status === 'succeeded') void loadResults(post.job); }, [postKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const assessments = postJobs.map((post) => (post.job ? results[post.job.id]?.assessment ?? null : null));
  // A run in progress has no verdict yet (its last run's isn't this one's).
  const full = (!!verification || !state) && postJobs.length > 0 && postJobs.every((post) => post.job?.status === 'succeeded') && assessments.every(Boolean);
  const download = verification?.download_status
    ?? (full ? (assessments.some((item) => item!.download_status === 'blocked_failed_checks') ? 'blocked_failed_checks' : assessments.every((item) => item!.download_status === 'software_verified') ? 'software_verified' : 'unverified') : undefined);
  const summary = full
    ? summarize(postJobs.flatMap((post, index) => assessments[index]!.checks.map((check) => ({ ...check, setup: perSetup ? post.setup : null }))),
      assessments.flatMap((item) => item!.input_estimates ?? []), download)
    : verification ? summarize(verification.not_passed, null, verification.download_status) : null;
  // A run Steve's checks stopped at an operation: its checks are that operation's, shown in its simulation.
  const checkedOperation = state?.stage === 'failed' && state.error?.code === 'run_failed_checks' ? state.error.operation ?? null : null;
  const jobOf = (check: SummaryCheck) => (checkedOperation ? runJobs.of(checkedOperation)
    : perSetup ? postJobs.find((post) => post.setup === check.setup)?.job ?? null : runJobs.post);
  return (
    <Section title="Run" id="cam-doc-run" actions={
      <Button size="sm" variant="primary" icon={busy ? <Spinner size={12} /> : <Play />} disabled={busy || saving || !ops.length} onClick={() => void runCam(id)} id="cam-doc-run-button">
        {busy ? (run?.phase ?? 'Running') : state?.done ? 'Run again' : 'Run'}
      </Button>}>
      {!ops.length && <p className={styles.note}>Add an operation to a setup, then run the program.</p>}
      {ops.length > 0 && !state && !last && !busy && (
        <p className={styles.note}>Every operation in order, each on the stock the one before leaves; then the G-code for the machine, which Steve checks before you download it.</p>
      )}
      {run?.error && <div className={styles.error} role="alert" id="cam-doc-run-error"><AlertTriangle size={13} /><span>{run.error}</span><CopyMessage text={run.error} /></div>}
      {stage && <p className={styles.note} id="cam-doc-stage" data-stage={stage}>{busy && !state?.done ? <Spinner size={11} /> : null} <b>{STAGE[stage] ?? stage}</b>{!state && last ? ' (last run)' : ''}</p>}
      {!stage && last?.post?.status === 'succeeded' && <p className={styles.note} id="cam-doc-stage" data-stage="posted"><b>Posted</b> (last run): run it again to see the check.</p>}
      {operations.length > 0 && (
        <div className={styles.runOps} id="cam-doc-ops">
          {operations.map((op) => (
            <RunRow key={op.operation} name={name(op.operation)} status={op.status} error={op.error} program={program}
              operation={runJobs.frozen ? sourceOperation(runJobs.frozen.id, op.operation) : op.operation}
              job={runJobs.operations.find((row) => row.operation === op.operation)?.job ?? null} />
          ))}
          {perSetup
            ? setupPosts.map((post) => (
              <RunRow key={post.setup} name={`Posted program · ${setupName(post.setup)} (G-code)`} status={post.status} setup={post.setup}
                error={post.error ?? null} job={runJobs.posts.find((item) => item.setup === post.setup)?.job ?? null}
                program={program} operation={null} id={`cam-doc-post-row-${post.setup}`} />
            ))
            : postStatus && <RunRow name="Posted program (G-code)" status={postStatus} job={runJobs.post} program={program} operation={null} id="cam-doc-post-row" />}
        </div>
      )}
      {error && !operations.some((op) => op.error) && !(perSetup && (error as CamFailure & { setup?: string }).setup) && <Failure error={error} id="cam-doc-failure" program={program} />}
      {summary && (
        <div id="cam-doc-verification" style={{ marginTop: 8 }} data-from={full ? 'results' : 'verification'}>
          <RunSummary summary={summary} program={program} idPrefix="cam-doc" jobOf={jobOf} setupName={perSetup ? setupName : undefined} />
        </div>
      )}
      {perSetup
        ? setupPosts.filter((post) => post.status === 'succeeded').map((post) => {
          const resolution = post.posted_resolution;
          const verified = post.verification?.download_status === 'software_verified';
          return (
            <div key={post.setup} data-post-files={post.setup} style={{ marginTop: 8 }}>
              {resolution && (
                <div className={styles.banner} data-tone="warn" style={{ margin: '0 0 6px' }} data-setup={resolution.setup}>
                  <AlertTriangle size={14} />
                  <span><b>{setupName(post.setup)}: {resolution.message}</b> {postedResolutionNextStep(resolution, 'cam')}</span>
                </div>
              )}
              <div className={styles.opActions}>
                <span className={styles.note} style={{ margin: 0 }}>{setupName(post.setup)}</span>
                <Button size="sm" variant={verified ? 'primary' : 'secondary'} icon={<Download />} disabled={state ? !verified : false}
                  title={state && !verified ? 'Not every check of this setup passed: its G-code downloads once it is verified.' : undefined}
                  onClick={() => void downloadGcode(id, post.setup)} id={`cam-doc-download-${post.setup}`}>Download G-code</Button>
                <Button size="sm" icon={<SimulateToolIcon size={14} />} onClick={() => void simulateCam(id, post.setup)} id={`cam-doc-simulate-${post.setup}`}>Simulate</Button>
              </div>
            </div>
          );
        })
        : <>
      {rounding && (posted || !!state?.gcode?.length) && (
        <div className={styles.banner} data-tone="warn" style={{ margin: '8px 0 0' }} id="cam-doc-posted-resolution" data-setup={rounding.setup}>
          <AlertTriangle size={14} />
          <span><b>{rounding.message}</b> {postedResolutionNextStep(rounding, 'cam')}</span>
        </div>
      )}
      {(posted || state?.gcode?.length) && (
        <div className={styles.opActions} style={{ marginTop: 8 }}>
          <Button size="sm" variant={state?.stage === 'verified' ? 'primary' : 'secondary'} icon={<Download />} disabled={state ? state.stage !== 'verified' : false}
            title={state && state.stage !== 'verified' ? 'Not every check passed: the G-code downloads once the program is verified.' : undefined}
            onClick={() => void downloadGcode(id)} id="cam-doc-download">Download G-code</Button>
          <Button size="sm" icon={<SimulateToolIcon size={14} />} onClick={() => void simulateCam(id)} id="cam-doc-simulate">Simulate</Button>
        </div>
      )}
        </>}
    </Section>
  );
}

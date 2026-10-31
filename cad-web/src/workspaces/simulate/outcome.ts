import type { DesignPin, Run, StudyAttempt, StudyRecord, StudyResult } from './api';
import { stageLabel } from './physics';

/**
 * A study's durable outcome: its latest successful solve and mesh (of any study revision) and its newest attempt, as
 * GET studies reports them. Once solved, a study stays solved until it or its design changes (then it's outdated, still
 * openable); a later failed, cancelled or mesh-only attempt, the time, or which run this page loaded never change that.
 */
export type StudyOutcome = Pick<StudyRecord, 'last_solve' | 'last_mesh' | 'latest_attempt'>;

/** What an outcome is judged against: the study as open now and the saved design (with the branch you're on). */
export interface StudyNow {
  revision?: number; dirty: boolean; setup: boolean;
  design?: { id: string; revision: number; branch: string } | null;
  /** Whether an earlier study revision saved the same setup as this one (then its result is still current). */
  sameInputs?: (revision: number) => boolean;
}

export interface StudyStatus {
  /** The study row: "Solved", "Solved · outdated", "Solved · re-running", "Meshed", "Solving", "Ready"… */
  label: string; tone: 'ok' | 'warn';
  /** The Results row: "Ready", "Outdated", "Mesh only", "Not solved"… */
  results: string;
  /** The solve whose results open, and why it no longer matches what is open (null while current). */
  solved: StudyResult | null; outdated: string | null;
}

type Dated = { id: string; created_at?: string | null };
const time = (value?: string | null) => (value ? Date.parse(value) : NaN);
/** Whether `a` is at least as new as `b` (an undated run counts as newest: it was just submitted). */
const asNew = (a: Dated, b?: Dated | null) => !b || a.id === b.id || !(time(a.created_at) < time(b.created_at));
const done = (status: Run['status']) => status === 'succeeded' || status === 'failed' || status === 'cancelled';

/** The newer of two of the same kind (the second when they're the same run). */
function newer<T extends Dated>(a: T | null | undefined, b: T | null | undefined): T | null {
  if (!a || !b) return b ?? a ?? null;
  return a.id !== b.id && !asNew(b, a) ? a : b;
}

/** A fresh server outcome over what was known: nothing goes backwards when an older response lands late. */
export function mergeOutcome(old: StudyOutcome | undefined, next: StudyOutcome): StudyOutcome {
  return { last_solve: newer(old?.last_solve, next.last_solve), last_mesh: newer(old?.last_mesh, next.last_mesh),
    latest_attempt: newer(old?.latest_attempt, next.latest_attempt) };
}

/**
 * The outcome with the run this page is watching folded in: it may be the newest attempt, and when it succeeded it's
 * the latest solve or mesh. It never replaces a newer result, and a run that hasn't succeeded never removes one.
 * `pin`: the design the run solved against when the outcome doesn't know it yet.
 */
export function withRun(outcome: StudyOutcome | undefined, run: Run | undefined, pin?: DesignPin): StudyOutcome {
  const next: StudyOutcome = { ...outcome };
  if (!run) return next;
  const attempt: StudyAttempt = { id: run.id, revision: run.revision, created_at: run.created_at, operation: run.operation, status: run.status, stage: run.stage };
  const latest = next.latest_attempt;
  if (asNew(attempt, latest) && !(latest?.id === run.id && done(latest.status) && !done(run.status))) next.latest_attempt = attempt;
  if (run.status === 'succeeded') {
    const key = run.operation === 'solve' ? 'last_solve' : 'last_mesh';
    const known = next[key];
    if (asNew(attempt, known)) next[key] = known?.id === run.id ? known : { id: run.id, revision: run.revision, created_at: run.created_at, design: pin };
  }
  return next;
}

/**
 * Why a result no longer matches what is open: the design was saved again (or you're on another branch) since, or
 * the study changed. Null while it is current. A result belongs to its inputs, not to a revision number (a later
 * revision that changed nothing it was solved with leaves it current), and a newer engine never makes it outdated.
 * The saved state is judged by the server (`result.outdated`, the rule read_design gives agents); this page adds
 * only what it knows first: the branch you're on, the design or study revision open now, and unsaved study edits.
 */
export function outdated(result: Pick<StudyResult, 'revision' | 'design' | 'current' | 'outdated'>, now: StudyNow): string | null {
  const solved = result.design, saved = now.design;
  if (solved && saved && saved.id === solved.document_id && (saved.revision !== solved.revision || saved.branch !== solved.branch)) {
    return saved.branch !== solved.branch ? `Solved on ${solved.branch}; you are on ${saved.branch}.`
      : `Solved with design revision ${solved.revision}; the design is now at revision ${saved.revision}.`;
  }
  if (now.revision && (now.dirty || (now.revision !== result.revision && !result.current && !now.sameInputs?.(result.revision)))) {
    return now.dirty ? 'The study has changed since it was solved.' : `Solved as study revision ${result.revision}; the study is now at revision ${now.revision}.`;
  }
  return result.outdated ?? null;
}

/** What the study tree says about a study: its durable result first, a newer unfinished or failed attempt alongside. */
export function studyStatus(outcome: StudyOutcome, now: StudyNow): StudyStatus {
  const solve = outcome.last_solve ?? null, result = solve ?? outcome.last_mesh ?? null;
  // The newest attempt is newer than any result; until it succeeds it's shown with the result, never instead of it.
  const pending = outcome.latest_attempt && outcome.latest_attempt.status !== 'succeeded' ? outcome.latest_attempt : null;
  const stage = pending ? stageLabel(pending.stage, pending.status) : null;
  if (!result) return { label: stage ?? (now.setup ? 'Setup' : 'Ready'), tone: 'warn', results: stage ?? 'Not solved', solved: null, outdated: null };
  const stale = outdated(result, now);
  const note = !pending ? null : pending.status === 'failed' ? (solve ? 'last re-run failed' : 'last run failed')
    : pending.status === 'cancelled' ? (solve ? 're-run cancelled' : 'last run cancelled') : solve ? 're-running' : stage!.toLowerCase();
  return {
    label: [solve ? 'Solved' : 'Meshed', stale && 'outdated', note].filter(Boolean).join(' · '),
    tone: stale || pending?.status === 'failed' ? 'warn' : 'ok',
    results: solve ? [stale ? 'Outdated' : 'Ready', note].filter(Boolean).join(' · ') : stage ?? 'Mesh only',
    solved: solve, outdated: solve ? stale : null,
  };
}

/**
 * Design-update reference review (docs/MANUFACTURING_REFERENCES.md). When a design a program machines changes in a way
 * its saved selections depend on, the server holds every job of that program revision (409 reference_review_required)
 * until a person has reviewed how each selection resolves on the new design and accepted it. The review is a job that
 * builds both design revisions; acceptance is human-only (the server refuses agents, MCP and API tokens), so it
 * happens here: the person sees every change and confirms the exact entities. Machining checks still run afterwards.
 *
 * Accepting re-resolves selections, not heights: heights that sat on the old geometry are offered at the same place on
 * the new design (referenceHeights.ts), and saved as the next revision right after the acceptance (saved before it,
 * the edit would carry the pending review along and need its own). Heights that follow nothing are flagged to check.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { CheckCircle2, GitCompareArrows, Info, Pencil, TriangleAlert } from 'lucide-react';
import { Button, Spinner } from '@/ui';
import { toast } from '@/state/store';
import { jobs, mfg, MfgError, programs, requestKey, terminal, type JobRecord, type ProgramRecord } from '../api';
import { useMfg } from '../state';
import { heightChanges, withHeights, type Catalogs, type HeightChange, type HeightCheck } from './referenceHeights';
import styles from './Cam.module.css';

interface Pin { program_id: string; branch: string; revision: number; revision_sha256: string }
/** `cleared`: the review found every selection on exactly the same geometry, so there was nothing to accept. */
export interface ReviewStatus { candidate: Pin; baseline: Pin | null; status: 'not_required' | 'required' | 'accepted'; accepted_report_sha256: string | null; cleared?: 'selections_unchanged' | null }
interface Resolution { reference: Record<string, unknown>; status: string; entities: string[]; names: string[]; message: string }
export interface ReferenceChange {
  path: string; owner: 'operation' | 'setup' | 'fixture_library'; owner_id: string;
  before: Resolution | null; after: Resolution | null; status: string; requires_decision: boolean;
}
interface Snapshot { report: { changes: ReferenceChange[]; before: Catalogs; after: Catalogs; before_errors?: Record<string, { message?: string }> }; report_sha256: string }

const pinOf = (record: ProgramRecord): Pin => ({ program_id: record.id, branch: record.branch, revision: record.revision, revision_sha256: record.revision_sha256 });
const keyOf = (record: ProgramRecord) => `${record.id}:${record.branch}:${record.revision}`;

export const references = {
  status: (record: ProgramRecord) =>
    mfg<ReviewStatus>(`/programs/${record.id}/reference-status?branch=${encodeURIComponent(record.branch)}&revision=${record.revision}`),
  submit: (record: ProgramRecord) => mfg<JobRecord>('/reference-reviews', { body: { request_key: requestKey('reference-review'), ...pinOf(record) } }),
  report: (job: string) => mfg<Snapshot>(`/jobs/${job}/reference-review`),
  accept: (job: string, record: ProgramRecord, snapshot: Snapshot) => mfg<ReviewStatus>(`/jobs/${job}/reference-review/accept`, {
    body: { request_key: requestKey('reference-accept'), expected_revision: record.revision, report_sha256: snapshot.report_sha256, decisions: decisionsOf(snapshot.report.changes) },
  }),
};

/** One decision per change that needs one: exactly the entities the review resolved on the new design. */
export const decisionsOf = (changes: ReferenceChange[]) => changes
  .filter((change) => change.requires_decision && change.after?.status === 'resolved')
  .map((change) => ({ path: change.path, entities: change.after!.entities }));

/** Why the review can't be accepted as it is (empty: it can). */
export function blockers(changes: ReferenceChange[]): string[] {
  return changes.filter((change) => change.status === 'repair_required' || change.status === 'unsupported'
    || (change.requires_decision && change.after?.status !== 'resolved'))
    .map((change) => `${where(change)}: ${change.after?.message ?? change.before?.message ?? 'no matching geometry on the new design'}`);
}

const where = (change: ReferenceChange) => `${change.owner === 'operation' ? 'Operation' : change.owner === 'setup' ? 'Setup' : 'Fixture'} ${change.owner_id}`;
const STATUS: Record<string, string> = {
  unchanged: 'Unchanged', geometry_changed: 'Same selection, changed shape', revision_local_review: 'Confirm the selection',
  new_selection: 'New selection', explicit_reselection: 'Reselected', removed: 'Removed', repair_required: 'Needs a new selection',
  unsupported: 'Unsupported',
};
const names = (resolution: Resolution | null) => (resolution?.names.length ? resolution.names.join(', ') : resolution ? `${resolution.entities.length} entities` : '—');

/** `heights`: what the review found for the heights; `skipped`: proposals the person unticked (heightKey). */
interface Review { status?: ReviewStatus; job?: JobRecord; snapshot?: Snapshot; busy?: boolean; error?: string; heights?: { changes: HeightChange[]; checks: HeightCheck[] }; skipped?: string[] }
export const useReferenceReview = create<Record<string, Review>>(() => ({}));
const patch = (key: string, value: Review) => useReferenceReview.setState((state) => ({ [key]: { ...state[key], ...value } }));

/**
 * After an acceptance, per program (its revisions change as heights are saved): heights still to save (the save hit
 * another revision first), and operations to check, each with the operation as it was flagged: the flag stays until
 * the operation is edited. `accepted`: the revision with the heights saved, still shown as the accepted design change.
 */
interface Followup { pending: HeightChange[]; checks: (HeightCheck & { signature: string })[]; accepted?: number; busy?: boolean; error?: string; inCode?: boolean; signatures?: Record<string, string> }
export const useHeightFollowups = create<Record<string, Followup>>(() => ({}));
const follow = (id: string, value: Partial<Followup>) => useHeightFollowups.setState((state) => ({ [id]: { ...(state[id] ?? { pending: [], checks: [] }), ...value } }));
const heightKey = (change: HeightChange) => `${change.operation}:${change.field}`;
const signatureOf = (record: ProgramRecord, operation: string) => JSON.stringify(record.compiled.operations.find((op) => op.id === operation) ?? null);
const FIELD: Record<HeightChange['field'], string> = { top: 'top', bottom: 'bottom', clearance: 'clearance' };
const num = (value: number) => String(Number(value.toFixed(3)));

export async function loadStatus(record: ProgramRecord) {
  try { patch(keyOf(record), { status: await references.status(record) }); } catch { /* shown as no banner */ }
}

/** Submits the review job (or reuses this revision's), waits for it and loads its report. */
export async function startReview(record: ProgramRecord) {
  const key = keyOf(record);
  patch(key, { busy: true, error: undefined });
  try {
    let job = useReferenceReview.getState()[key]?.job ?? await references.submit(record);
    patch(key, { job });
    while (!terminal(job.status)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      job = await jobs.get(job.id);
      patch(key, { job });
    }
    if (job.status !== 'succeeded') throw new MfgError(0, job.error?.code ?? 'review_failed', job.error?.message ?? 'The review didn’t finish.');
    const snapshot = await references.report(job.id);
    const { changes, before, after } = snapshot.report;
    patch(key, { snapshot, heights: heightChanges(record.compiled.operations, changes, before ?? {}, after ?? {}), skipped: [] });
    // Reading a review that found nothing changed clears the revision on the server (reference_gate.clear_unchanged).
    const status = await references.status(record).catch(() => null);
    if (status) patch(key, { status });
    if (status?.cleared) toast('success', 'Nothing to accept', 'Every selection lands on exactly the same geometry in the new design. Run the program again.');
  } catch (error) {
    patch(key, { error: (error as Error).message, job: undefined });
  } finally {
    patch(key, { busy: false });
  }
}

/** Ticks or unticks one proposed height. */
export function toggleHeight(record: ProgramRecord, change: HeightChange) {
  const key = keyOf(record);
  const skipped = useReferenceReview.getState()[key]?.skipped ?? [];
  patch(key, { skipped: skipped.includes(heightKey(change)) ? skipped.filter((item) => item !== heightKey(change)) : [...skipped, heightKey(change)] });
}

/**
 * Accepts the review, then saves the ticked heights as the next revision (in that order: see the header). A CAM
 * program's (`editor`, its document's record; `record` is the revision its run froze) heights are numbers in its code:
 * they are listed there to set, never saved into the frozen program, which the next run would replace.
 */
export async function acceptReview(record: ProgramRecord, editor?: ProgramRecord) {
  const key = keyOf(record);
  const { job, snapshot, heights, skipped = [] } = useReferenceReview.getState()[key] ?? {};
  if (!job || !snapshot) return;
  patch(key, { busy: true, error: undefined });
  try {
    patch(key, { status: await references.accept(job.id, record, snapshot) });
  } catch (error) {
    patch(key, { error: (error as Error).message, busy: false });
    return;
  }
  if (editor) {
    follow(editor.id, {
      pending: heights?.changes ?? [], inCode: true, error: undefined,
      signatures: Object.fromEntries((heights?.changes ?? []).map((change) => [change.operation, signatureOf(editor, change.operation)])),
      checks: (heights?.checks ?? []).map((check) => ({ ...check, signature: signatureOf(editor, check.operation) })),
    });
    toast('success', 'Design change accepted', heights?.changes.length ? 'Set the heights listed on the program, then run it again.' : 'Run the program again; its machining checks still run.');
    patch(key, { busy: false });
    return;
  }
  follow(record.id, {
    pending: heights?.changes.filter((change) => !skipped.includes(heightKey(change))) ?? [],
    checks: (heights?.checks ?? []).map((check) => ({ ...check, signature: signatureOf(record, check.operation) })),
    error: undefined,
  });
  await saveHeights(record, true);
  patch(key, { busy: false });
}

/**
 * Saves the heights the acceptance left to update onto `record` (a new revision). If another revision was saved first,
 * they stay listed to apply to it; a height changed since the review is left as it is.
 */
export async function saveHeights(record: ProgramRecord, accepted = false) {
  const { pending = [], checks = [] } = useHeightFollowups.getState()[record.id] ?? {};
  const done = (detail: string) => toast('success', accepted ? 'Design change accepted' : 'Heights updated', detail);
  if (!pending.length) {
    if (accepted) done('This program revision can be generated again; its machining checks still run.');
    return;
  }
  follow(record.id, { busy: true, error: undefined });
  try {
    const saved = await programs.edit(record, await programs.render(withHeights(record.compiled, pending)));
    useMfg.setState((state) => ({ programs: [saved, ...state.programs.filter((item) => item.id !== saved.id)], activeProgram: saved.id }));
    follow(record.id, { pending: [], checks: checks.map((check) => ({ ...check, signature: signatureOf(saved, check.operation) })), ...(accepted ? { accepted: saved.revision } : {}) });
    done(`${pending.length === 1 ? '1 height follows' : `${pending.length} heights follow`} the new design (revision ${saved.revision}); machining checks still run.`);
  } catch (error) {
    if (error instanceof MfgError && error.status === 409) {
      follow(record.id, { error: 'Another revision of this program was saved first: update the heights on it, or check them yourself.' });
      toast('warning', 'Saved elsewhere first', 'Another revision of this program was saved. Its heights are listed to update again.');
      try {
        const latest = await programs.get(record.id, record.branch);
        useMfg.setState((state) => ({ programs: [latest, ...state.programs.filter((item) => item.id !== latest.id)] }));
      } catch { /* the list reloads with the document */ }
    } else follow(record.id, { error: (error as Error).message });
  } finally {
    follow(record.id, { busy: false });
  }
}

/**
 * After an acceptance: heights still to update, and operations whose heights follow nothing the review could place
 * (typed by hand, or picked from geometry that moved differently). Each opens its operation at its heights.
 */
function HeightFollowups({ program, onCheck }: { program: ProgramRecord; onCheck: (operation: string) => void }) {
  const followup = useHeightFollowups((state) => state[program.id]);
  const checks = followup?.checks.filter((check) => signatureOf(program, check.operation) === check.signature) ?? [];
  const pending = followup?.pending.filter((change) => !followup.inCode || signatureOf(program, change.operation) === followup.signatures?.[change.operation]) ?? [];
  if (!pending.length && !checks.length) return null;
  return (
    <div className={styles.banner} data-tone="warn" id="cam-reference-heights">
      <TriangleAlert size={14} />
      <span>
        {pending.length > 0 && (
          <>
            <b>{followup.inCode ? 'Heights to set.' : 'Heights to update.'}</b> These heights sat on geometry that moved in the new design{followup.inCode ? ': set them in the program (edit the operation), then run it again' : ''}.
            <HeightList changes={pending} />
          </>
        )}
        {followup.error && <span className={styles.error} role="alert"><Info size={13} /> {followup.error}</span>}
        {checks.length > 0 && <CheckList checks={checks} onCheck={onCheck} />}
        {pending.length > 0 && !followup.inCode && (
          <span className={styles.actions}>
            <Button size="sm" variant="primary" icon={followup.busy ? <Spinner size={12} /> : <CheckCircle2 />} id="cam-reference-heights-save"
              disabled={followup.busy} onClick={() => void saveHeights(program)}>Update {followup.pending.length === 1 ? '1 height' : `${followup.pending.length} heights`}</Button>
          </span>
        )}
      </span>
    </div>
  );
}

function HeightList({ changes, skipped, onToggle }: { changes: HeightChange[]; skipped?: string[]; onToggle?: (change: HeightChange) => void }) {
  return (
    <span className={styles.heightList} id="cam-reference-height-changes">
      {changes.map((change) => (
        <label key={heightKey(change)} data-operation={change.operation} data-field={change.field}>
          {onToggle && <input type="checkbox" checked={!skipped?.includes(heightKey(change))} onChange={() => onToggle(change)} />}
          <span>{change.name} · {FIELD[change.field]} {num(change.before)} → {num(change.after)} <small>({change.reason})</small></span>
        </label>
      ))}
    </span>
  );
}

function CheckList({ checks, onCheck }: { checks: HeightCheck[]; onCheck?: (operation: string) => void }) {
  return (
    <span className={styles.heightList} id="cam-reference-height-checks">
      <span><b>Check heights:</b> the selections of these operations changed, but their heights don’t follow geometry the review can place.</span>
      {checks.map((check) => (
        <span key={check.operation} data-operation={check.operation}>
          <span>{check.name}</span>
          {onCheck && <Button size="sm" variant="ghost" icon={<Pencil />} onClick={() => onCheck(check.operation)}>Check</Button>}
        </span>
      ))}
    </span>
  );
}

/** The message an operation opened from a "Check heights" flag shows at its heights. */
export const CHECK_HEIGHTS = 'A linked design changed under this operation: check these heights against the new design, then save.';

/**
 * The banner on a program whose saved revision waits for a reference review: start the review, read every change,
 * and accept it with the heights that follow the new design. Without a review to do, only what an acceptance left:
 * heights still to update and operations to check. A CAM program passes the revision its run froze as `program` and its
 * document's record as `editor`: the review and acceptance are the frozen revision's, the heights to set are in its code.
 */
export function ReferenceReviewBanner({ program, editor, onCheck }: { program: ProgramRecord; editor?: ProgramRecord; onCheck: (operation: string) => void }) {
  const key = keyOf(program);
  const review = useReferenceReview((state) => state[key]);
  useEffect(() => { void loadStatus(program); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const status = review?.status?.status;
  const heightsSaved = useHeightFollowups((state) => state[program.id]?.accepted === program.revision);
  const followups = editor ?? program;
  if ((status === 'accepted' && review?.snapshot) || (status !== 'required' && heightsSaved)) {
    return (
      <>
        <div className={styles.banner} data-tone="ok" id="cam-reference-review" data-status="accepted">
          <CheckCircle2 size={14} /><span><b>Design change accepted.</b> {editor ? 'Run' : 'Generate'} the program again: its paths and checks use the new design.</span>
        </div>
        <HeightFollowups program={followups} onCheck={onCheck} />
      </>
    );
  }
  if (review?.status?.cleared && review.snapshot) {
    return (
      <div className={styles.banner} data-tone="ok" id="cam-reference-review" data-status="cleared">
        <CheckCircle2 size={14} /><span><b>Nothing to accept.</b> The design changed, but every selection of this program lands on exactly the same geometry. {editor ? 'Run' : 'Generate'} the program again.</span>
      </div>
    );
  }
  if (status !== 'required') return <HeightFollowups program={followups} onCheck={onCheck} />;
  const changes = review?.snapshot?.report.changes.filter((change) => change.status !== 'unchanged') ?? [];
  const blocked = review?.snapshot ? blockers(review.snapshot.report.changes) : [];
  const heights = review?.heights;
  const ticked = editor ? 0 : heights?.changes.filter((change) => !review?.skipped?.includes(heightKey(change))).length ?? 0;
  return (
    <div className={styles.banner} data-tone="warn" id="cam-reference-review" data-status={review?.snapshot ? 'reviewed' : 'required'}>
      <TriangleAlert size={14} />
      <span>
        <b>A linked design changed.</b> Before this revision can be machined, review how its selections (targets, setup
        and fixture references) resolve on the new design, and accept them. Only you can accept this, here in STEVE;
        agents can review and repair selections but not accept them.
        {review?.error && <span className={styles.error} role="alert"><Info size={13} /> {review.error}</span>}
        {review?.snapshot && (
          <table className={styles.reviewTable} id="cam-reference-changes">
            <thead><tr><th>Where</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              {changes.length ? changes.map((change) => (
                <tr key={change.path} data-status={change.status}>
                  <td>{where(change)}</td><td>{STATUS[change.status] ?? change.status}</td>
                  <td>{names(change.before)}</td><td title={change.after?.message}>{names(change.after)}</td>
                </tr>
              )) : <tr><td colSpan={4}>No selection changed: accepting confirms the program on the new design.</td></tr>}
            </tbody>
          </table>
        )}
        {heights && heights.changes.length > 0 && (
          <>
            {editor
              ? <><b>Heights.</b> These sat on geometry that moved. They are numbers in the program’s code: after accepting, set them there.</>
              : <><b>Heights.</b> These sat on geometry that moved; accepting moves the ticked ones with it (as the next revision).</>}
            <HeightList changes={heights.changes} skipped={review?.skipped} onToggle={editor ? undefined : (change) => toggleHeight(program, change)} />
          </>
        )}
        {heights && heights.checks.length > 0 && <CheckList checks={heights.checks} />}
        {blocked.length > 0 && (
          <span className={styles.error} role="alert"><Info size={13} /> Can’t be accepted yet: {blocked.join('; ')}. Edit the program’s selections and save; the new revision gets its own review.</span>
        )}
        <span className={styles.actions}>
          {!review?.snapshot ? (
            <Button size="sm" variant="primary" icon={review?.busy ? <Spinner size={12} /> : <GitCompareArrows />} id="cam-reference-start"
              disabled={review?.busy} onClick={() => void startReview(program)}>
              {review?.busy ? (review.job ? `Reviewing… ${Math.round((review.job.progress ?? 0) * 100)}%` : 'Starting the review…') : 'Review the design change'}
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={review.busy ? <Spinner size={12} /> : <CheckCircle2 />} id="cam-reference-accept"
              disabled={review.busy || blocked.length > 0} onClick={() => void acceptReview(program, editor)}>
              {ticked ? `Accept and update ${ticked === 1 ? '1 height' : `${ticked} heights`}` : 'Accept these selections'}
            </Button>
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * A run's checks in the inspector. RunSummary: the verdict and what to do (each estimated library record once, a click
 * away in the Library; each failed or uncertain check, a click away in the simulation). CheckFamilies, folded under
 * "Details for engineers": every check in plain words, grouped by what it is about and worst first, with where its
 * events happened; the finished-part inspection lists its regions, feeds and speeds the posted figures against their
 * pinned limits.
 */
import { useEffect, useMemo } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, CircleHelp, Eye, Library, Play, XCircle } from 'lucide-react';
import type { JobRecord, ProgramRecord } from '../api';
import { openLibrary, useMfg } from '../state';
import { labelOf } from '../schema';
import type { Check, PostAssessment, VerificationEvent } from './api';
import {
  CUTTING_WORDS, FAMILIES, STATUS_RANK, checkWords, familyOf, loadCheckDetails, plainMessage, showCheckEvent, showInspectionRegion, showLine, useChecks, worst,
  type CheckDetails, type CheckSummary, type CuttingEvent, type FamilyKey,
} from './checks';
import type { EstimatedRecord, SummaryCheck } from './checkSummary';
import { openPlayer, operationName } from './state';
import { volumeKind, volumeMeaning, volumeWords } from './volumes';
import styles from './Cam.module.css';

const ICON = { passed: CheckCircle2, failed: XCircle, uncertain: CircleHelp, unassessed: CircleDashed } as const;
const StatusIcon = ({ status, size = 14 }: { status: string; size?: number }) => { const Icon = ICON[status as keyof typeof ICON] ?? CircleDashed; return <Icon size={size} />; };
const num = (value: number, digits = 3) => Number(value.toFixed(digits)).toLocaleString(undefined, { maximumFractionDigits: digits });
const STATUS_WORDS: Record<string, string> = { failed: 'failed', uncertain: 'uncertain', unassessed: 'not assessed', passed: 'passed' };

/** Consecutive events of one check on the same move span, bodies and region: what a row in the list stands for. */
interface Span { first: number; count: number; from: number; to: number; event: VerificationEvent }
function spansOf(events: VerificationEvent[], indices: number[]): Span[] {
  const key = (event: VerificationEvent) => [event.severity, event.region, event.fixture, event.target, event.machine_body, event.machine_bodies?.join('|')].join('/');
  const sorted = [...indices].sort((a, b) => (STATUS_RANK[events[a].severity] - STATUS_RANK[events[b].severity]) || ((events[a].move_range?.[0] ?? -1) - (events[b].move_range?.[0] ?? -1)));
  const spans: Span[] = [];
  for (const index of sorted) {
    const event = events[index], last = spans.at(-1);
    const from = event.move_range?.[0] ?? -1, to = event.move_range?.[1] ?? -1;
    if (last && from >= 0 && key(last.event) === key(event) && from <= last.to + 1) { last.to = Math.max(last.to, to); last.count++; continue; }
    spans.push({ first: index, count: 1, from, to, event });
  }
  return spans;
}
const spanWhere = (span: Span) => (span.from < 0 ? 'Whole program' : span.from === span.to ? `Move ${num(span.from + 1, 0)}` : `Moves ${num(span.from + 1, 0)}–${num(span.to + 1, 0)}`);
const spanWhat = (span: Span) => {
  const event = span.event, words = (id: string) => id.replace(/_/g, ' ');
  return [
    event.machine_bodies && `machine ${event.machine_bodies.map(words).join(' & ')}`, event.machine_body && `machine ${words(event.machine_body)}`,
    event.region && `tool ${words(event.region)}`, event.fixture && `fixture ${event.fixture}`, event.target && `part ${event.target}`,
    span.count > 1 && `${span.count} events`,
  ].filter(Boolean).join(' · ') || event.message;
};

/** A check's events (by the check they belong to): the first few spans, each a jump into the simulation. */
function CheckEvents({ job, details, check }: { job: JobRecord; details: CheckDetails; check: string }) {
  const spans = useMemo(() => {
    // Events the backend tied to a move (one without a place only repeats the check's own message).
    const indices = details.events.flatMap((event, index) => ((event.check ?? event.kind) === check && event.move_range ? [index] : []));
    return spansOf(details.events, indices);
  }, [details.events, check]);
  if (!spans.length) return null;
  const shown = spans.slice(0, 4);
  return (
    <div className={styles.checkEvents} data-check-events={check}>
      {shown.map((span) => (
        <button key={span.first} type="button" className={styles.event} data-event={span.first} data-s={span.event.severity} disabled={span.from < 0}
          title={`${span.event.message} Show it in the simulation.`} onClick={() => void showCheckEvent(job, span.first)}>
          <b><i className={styles.sev} data-s={span.event.severity} /> {spanWhere(span)}</b><span>{spanWhat(span)}</span>
        </button>
      ))}
      {spans.length > shown.length && (
        <div className={styles.more}>{spans.length - shown.length} more · <button type="button" onClick={() => void showCheckEvent(job, spans[shown.length].first)}>Show all in the simulation</button></div>
      )}
    </div>
  );
}

/** Failed and uncertain checks listed under the verdict (worst first); the rest are one line, each in the details. */
const ATTENTION_SHOWN = 6;

/** `spindles.0.max_rpm` → "Spindles 1 › Max rpm". */
const fieldLabel = (path: string) => path.split('.').map((part) => (/^\d+$/.test(part) ? String(Number(part) + 1) : labelOf(part))).join(' › ').replace(/ › (\d+)/g, ' $1');

/** "The BT30 ER20 collet chuck's dimensions are estimates: confirm them in the Library", with the button that opens it. */
function EstimateAction({ record }: { record: EstimatedRecord }) {
  const records = useMfg((state) => state.records);
  const name = records.find((entry) => entry.id === record.library.id)?.definition.name ?? labelOf(record.library.kind);
  const fields = record.fields.map(fieldLabel);
  const what = record.whole || !fields.length ? 'dimensions are estimates'
    : `${fields.slice(0, 3).join(', ')}${fields.length > 3 ? ` and ${fields.length - 3} more` : ''} ${fields.length === 1 ? 'is an estimate' : 'are estimates'}`;
  return (
    <div className={styles.actionItem} data-action="estimate" data-library={record.library.id} data-s="unassessed">
      <AlertTriangle size={14} />
      <span>The <b>{name}</b>’s {what}: confirm {fields.length === 1 && !record.whole ? 'it' : 'them'} in the Library.</span>
      <button type="button" className={styles.linkButton} onClick={() => openLibrary(record.library.kind as Parameters<typeof openLibrary>[0], record.library.id)}><Library size={12} /> Open in Library</button>
    </div>
  );
}

/**
 * Can I use this program, and what do I need to do: the verdict line, then each estimated record once, each failed or
 * uncertain check (Show: where it happened in the simulation), and one line for the rest that couldn't be assessed.
 * `jobOf`: the job a check's events are in (a setup's post when there are several); `onDetails` opens the details.
 */
export function RunSummary({ summary, program, jobOf, idPrefix = 'cam', setupName, diagnostic, onDetails }: {
  summary: CheckSummary; program: ProgramRecord; jobOf: (check: SummaryCheck) => JobRecord | null; idPrefix?: string;
  setupName?: (setup: string) => string; diagnostic?: string | null; onDetails?: () => void;
}) {
  const details = useChecks((state) => state.details);
  // Where the failed and uncertain checks' events are: read once per job.
  const jobs = [...new Map(summary.attention.map((check) => jobOf(check)).filter((job): job is JobRecord => !!job).map((job) => [job.id, job])).values()];
  const key = jobs.map((job) => job.id).join(',');
  useEffect(() => { for (const job of jobs) void loadCheckDetails(job); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const show = (check: SummaryCheck) => {
    const job = jobOf(check);
    if (!job) return;
    const found = details[job.id];
    const index = found ? found.events.findIndex((event) => (event.check ?? event.kind) === check.id && !!event.move_range) : -1;
    if (index >= 0) void showCheckEvent(job, index);
    else if (/^stock_(excess|missing)_material$/.test(check.id) && found?.inspection) void showInspectionRegion(job, null);
    else void openPlayer(job);
  };
  const Icon = summary.s === 'failed' ? XCircle : summary.s === 'passed' ? CheckCircle2 : AlertTriangle;
  const where = (check: SummaryCheck) => [check.setup && setupName ? setupName(check.setup) : null, check.operation ? operationName(program, check.operation) : null].filter(Boolean).join(' · ');
  const actions = summary.estimates.length + summary.attention.length + (summary.unassessed.length ? 1 : 0) + (summary.estimated && !summary.estimates.length ? 1 : 0);
  return (
    <>
      <div className={styles.banner} data-tone={summary.s === 'failed' ? 'danger' : summary.s === 'passed' ? 'ok' : 'warn'} style={{ margin: '0 0 6px' }} id={`${idPrefix}-verdict`} data-s={summary.s}>
        <Icon size={14} />
        <span><b>{summary.verdict}.</b>{summary.next && <> {summary.next}</>}{diagnostic && <> {diagnostic}</>}</span>
      </div>
      {actions > 0 && (
        <div className={styles.actionList} id={`${idPrefix}-actions`}>
          {summary.estimates.map((record) => <EstimateAction key={record.library.id} record={record} />)}
          {summary.estimated > 0 && !summary.estimates.length && (
            <div className={styles.actionItem} data-action="estimate" data-s="unassessed"><AlertTriangle size={14} /><span>Some library values this run used are estimates: confirm them in the Library.</span></div>
          )}
          {summary.attention.slice(0, ATTENTION_SHOWN).map((check) => (
            <div key={`${check.id}:${check.operation ?? ''}:${check.setup ?? ''}`} className={styles.actionItem} data-action="check" data-action-check={check.id} data-s={check.status}>
              <StatusIcon status={check.status} />
              <span><b>{checkWords(check.id)}</b> {check.status === 'failed' ? 'failed' : 'is uncertain'}{where(check) ? ` · ${where(check)}` : ''}<small title={plainMessage(check.message)}>{plainMessage(check.message)}</small></span>
              {jobOf(check) && <button type="button" className={styles.linkButton} onClick={() => show(check)} title="Show where it happened in the simulation"><Play size={12} /> Show</button>}
            </div>
          ))}
          {summary.attention.length > ATTENTION_SHOWN && (
            <div className={styles.actionItem} data-action="more" data-s={summary.attention[ATTENTION_SHOWN].status}>
              <StatusIcon status={summary.attention[ATTENTION_SHOWN].status} />
              <span>{summary.attention.length - ATTENTION_SHOWN} more failed or uncertain check{summary.attention.length - ATTENTION_SHOWN === 1 ? '' : 's'}, each in the details.</span>
              {onDetails && <button type="button" className={styles.linkButton} onClick={onDetails}>Details</button>}
            </div>
          )}
          {summary.unassessed.length > 0 && (
            <div className={styles.actionItem} data-action="unassessed" data-s="unassessed">
              <CircleDashed size={14} />
              <span>{summary.unassessed.length === 1 ? `${checkWords(summary.unassessed[0].id)} couldn’t be assessed.` : `${summary.unassessed.length} checks couldn’t be assessed: ${summary.unassessed.slice(0, 2).map((check) => checkWords(check.id).toLowerCase()).join(', ')}${summary.unassessed.length > 2 ? '…' : '.'}`}</span>
              {onDetails && <button type="button" className={styles.linkButton} onClick={onDetails}>Details</button>}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function CheckRow({ job, check, details, estimated }: { job: JobRecord; check: Check; details: CheckDetails | undefined; estimated: boolean }) {
  // The name and status; what the engine said only where it's to act on (failed, uncertain), else on hover.
  const message = plainMessage(check.message);
  const open = check.status === 'failed' || check.status === 'uncertain';
  return (
    <div className={styles.check} data-s={check.status} data-check={check.id} data-family={familyOf(check.id)}>
      <StatusIcon status={check.status} />
      <b title={open ? undefined : message}>{checkWords(check.id)}{estimated && <em className={styles.estimatedTag} data-estimated-input>estimated input</em>}</b>
      {open && <p>{message}</p>}
      {details && open && <CheckEvents job={job} details={details} check={check.id} />}
    </div>
  );
}

/** The finished stock against the design: how much is off, and each region (click: framed in the simulation). */
function InspectionDetails({ job, details }: { job: JobRecord; details: CheckDetails }) {
  const inspection = details.inspection!;
  const ranked = useMemo(() => inspection.regions.map((region, index) => ({ region, index }))
    .sort((a, b) => STATUS_RANK[a.region.status] - STATUS_RANK[b.region.status] || b.region.guaranteed_depth_mm - a.region.guaranteed_depth_mm), [inspection]);
  // As the inspection bounds them: a range wherever it couldn't resolve all of it (rounded outwards: cam/volumes.ts).
  const bounds = (value: { guaranteed_mm3: number; possible_mm3: number }) => ({ guaranteed: value.guaranteed_mm3, possible: value.possible_mm3 });
  const ranged = volumeKind(bounds(inspection.excess)) === 'between' || volumeKind(bounds(inspection.excess)) === 'up_to'
    || volumeKind(bounds(inspection.missing)) === 'between' || volumeKind(bounds(inspection.missing)) === 'up_to';
  const shown = ranked.slice(0, 8);
  const size = (bounds: { minimum_mm: number[]; maximum_mm: number[] }) => bounds.maximum_mm.map((value, axis) => num(value - bounds.minimum_mm[axis], 3)).join(' × ');
  return (
    <div className={styles.inspection} id="cam-inspection" data-regions={inspection.regions.length} data-total={inspection.total_regions}>
      <div className={styles.inspectionHead}>
        <span title={volumeMeaning(bounds(inspection.excess))} data-volume="excess" data-volume-kind={volumeKind(bounds(inspection.excess))}><i className={styles.legendDot} data-kind="excess" />Material left <b>{volumeWords(bounds(inspection.excess))}</b></span>
        <span title={volumeMeaning(bounds(inspection.missing))} data-volume="missing" data-volume-kind={volumeKind(bounds(inspection.missing))}><i className={styles.legendDot} data-kind="missing" />Cut too deep <b>{volumeWords(bounds(inspection.missing))}</b></span>
        <button type="button" className={styles.linkButton} id="cam-inspection-show" onClick={() => void showInspectionRegion(job, ranked[0]?.index ?? null)}><Eye size={12} /> Show on the part</button>
      </div>
      {shown.map(({ region, index }) => (
        <button key={index} type="button" className={styles.event} data-region={index} data-kind={region.kind} data-s={region.status}
          onClick={() => void showInspectionRegion(job, index)} title="Show this region on the finished stock">
          <b><i className={styles.sev} data-s={region.status} /> {region.kind === 'excess' ? 'Material left' : 'Cut too deep'}</b>
          <span>{region.guaranteed_depth_mm > 0 ? `at least ${num(region.guaranteed_depth_mm, 3)} mm beyond the band · ` : ''}{size(region.bounds)} mm box{region.status === 'uncertain' ? ' · unresolved' : ''}</span>
        </button>
      ))}
      {(ranked.length > shown.length || inspection.total_regions > inspection.regions.length) && (
        <div className={styles.more}>{inspection.total_regions - shown.length} more region{inspection.total_regions - shown.length === 1 ? '' : 's'}{inspection.total_regions > inspection.regions.length ? ` (${inspection.regions.length} kept)` : ''} · shown on the part</div>
      )}
      {ranged && <p className={styles.familyNote} id="cam-inspection-ranges">These are ranges: the inspection proves at least the lower amount and at most the upper; what it couldn’t resolve lies between{inspection.exhausted ? ` (it stopped at its resolution or work limit, after ${num(inspection.evaluations, 0)} evaluations)` : ''}.</p>}
      {(inspection.exhausted || inspection.numerical_failures > 0) && (
        <p className={styles.familyNote}>{inspection.exhausted ? 'The comparison reached its resolution or work limit; what it couldn’t resolve stays uncertain. ' : ''}
          {inspection.numerical_failures > 0 ? `${inspection.numerical_failures} CAD evaluation${inspection.numerical_failures === 1 ? '' : 's'} failed numerically (left uncertain).` : ''}</p>
      )}
    </div>
  );
}

/** Posted feeds and speeds per operation and tool against the pinned cutting data, then the removal rate. */
function RateDetails({ job, program, details }: { job: JobRecord; program: ProgramRecord; details: CheckDetails }) {
  const cutting = details.cutting, removal = details.removal;
  const name = (id: string | null) => (id ? operationName(program, id) : 'Tool change');
  const range = (lower: number, upper: number | null, digits: number) => (upper === null ? `≥ ${num(lower, digits)}` : Math.abs(upper - lower) < 10 ** -digits ? num(upper, digits) : `${num(lower, digits)}–${num(upper, digits)}`);
  const metrics = [...(cutting?.metrics ?? [])].filter((metric) => metric.limit !== null || metric.status !== 'passed')
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  // Lines over a limit, consecutive ones of one metric merged ("Lines 18–40"); the line is the posted one (`line_18`).
  const lineOf = (event: { move: string; source_line?: number | null }) => event.source_line ?? Number(/^line_(\d+)$/.exec(event.move)?.[1] ?? NaN);
  const spans: { first: number; last: number; event: CuttingEvent }[] = [];
  for (const event of [...(cutting?.events ?? [])].filter((item) => Number.isFinite(lineOf(item))).sort((a, b) => lineOf(a) - lineOf(b))) {
    const line = lineOf(event), last = spans.find((span) => span.event.metric === event.metric && span.event.status === event.status && line - span.last <= 1);
    if (last) last.last = line;
    else spans.push({ first: line, last: line, event });
  }
  const events = spans.sort((a, b) => STATUS_RANK[a.event.status] - STATUS_RANK[b.event.status] || a.first - b.first).slice(0, 4);
  const rates = [...(removal?.metrics ?? [])].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
  if (!metrics.length && !rates.length && !events.length && cutting?.mapping !== 'unavailable') return null;
  return (
    <div className={styles.rates} id="cam-rates">
      {metrics.map((metric) => {
        const words = CUTTING_WORDS[metric.metric];
        return (
          <div key={`${metric.operation}:${metric.tool_number}:${metric.metric}`} className={styles.rate} data-s={metric.status} data-metric={metric.metric} data-rate-operation={metric.operation}>
            <i className={styles.sev} data-s={metric.status} />
            <span>{name(metric.operation)} · T{metric.tool_number} · {words.label}</span>
            <b>{range(metric.maximum_lower, metric.maximum_upper, words.digits)} {words.unit}{metric.limit !== null && <small> / limit {num(metric.limit, words.digits)}</small>}</b>
          </div>
        );
      })}
      {events.map(({ first, last, event }) => {
        const words = CUTTING_WORDS[event.metric];
        return (
          <button key={`${event.metric}:${first}`} type="button" className={styles.event} data-s={event.status} data-line={first} onClick={() => void showLine(job, first)}
            title="Show this line of the machine program in the simulation">
            <b><i className={styles.sev} data-s={event.status} /> {first === last ? `Line ${first}` : `Lines ${first}–${last}`}</b>
            <span>{words.label} {range(event.lower, event.upper, words.digits)} {words.unit} over the {num(event.limit, words.digits)} limit{event.operation ? ` · ${name(event.operation)}` : ''}</span>
          </button>
        );
      })}
      {cutting && cutting.total_events > (cutting.events.length) && <div className={styles.more}>{cutting.total_events - cutting.events.length} more lines over a limit weren’t kept.</div>}
      {cutting?.mapping === 'unavailable' && <p className={styles.familyNote}>The posted moves couldn’t be matched to their operations, so feeds and speeds aren’t assessed per operation.</p>}
      {rates.map((metric) => (
        <div key={`mrr:${metric.operation}:${metric.tool_number}`} className={styles.rate} data-s={metric.status} data-metric="removal_rate" data-rate-operation={metric.operation ?? undefined}>
          <i className={styles.sev} data-s={metric.status} />
          <span>{name(metric.operation)} · T{metric.tool_number} · Removal rate</span>
          <b>{metric.cutting_moves ? `${range(metric.maximum_lower_mm3_min, metric.maximum_upper_mm3_min, 0)} mm³/min` : 'no cutting'}{metric.limit_mm3_min !== null && <small> / limit {num(metric.limit_mm3_min, 0)}</small>}</b>
        </div>
      ))}
    </div>
  );
}

/** What the machine checks couldn't cover (bodies without geometry, a spent budget), and stock-contact timing. */
function familyNotes(key: FamilyKey, details: CheckDetails): string[] {
  const out: string[] = [];
  if (key === 'machine') {
    const machine = details.machine, contacts = details.contacts;
    if (machine?.unsupported_bodies.length) out.push(`Not modelled, so not checked: ${machine.unsupported_bodies.map((body) => body.replace(/_/g, ' ')).join(', ')}.`);
    if (machine?.budget_exhausted) out.push('The machine check ran out of its work budget; what it couldn’t resolve stays uncertain.');
    const permitted = (machine?.permitted_contacts.length ?? 0) + (contacts?.permitted_contacts.length ?? 0);
    if (permitted) out.push(`${permitted} contact${permitted === 1 ? '' : 's'} the machine permits (such as the tool in the spindle) ${permitted === 1 ? 'isn’t' : 'aren’t'} reported.`);
    const kept = (machine?.events.length ?? 0) + (contacts?.events.length ?? 0), total = (machine?.total_events ?? 0) + (contacts?.total_events ?? 0);
    if (total > kept) out.push(`${total} machine events; the first ${kept} are kept.`);
    if (contacts?.exhausted_pairs) out.push(`${contacts.exhausted_pairs} body pair${contacts.exhausted_pairs === 1 ? '' : 's'} reached the refinement limit (uncertain).`);
  }
  if (key === 'stock' && details.timing) {
    const timing = details.timing;
    out.push(`Timed by the actual cut: ${timing.pairs} body/stock pair${timing.pairs === 1 ? '' : 's'} refined — ${timing.cleared_pairs} clear, ${timing.collision_pairs} collide, ${timing.uncertain_pairs} unresolved.`);
  }
  return out;
}

/** Opens the details for engineers and brings them into view (the summary's "Details"). */
export function showCheckDetails() {
  const element = document.getElementById('cam-checks') as HTMLDetailsElement | null;
  if (!element) return;
  element.open = true;
  element.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/**
 * The checks of one run (an operation's or a combined program's), folded under "Details for engineers": grouped into
 * families, the worst family first. Rows keep each check's ID (`data-check`) and status (`data-s`); failed and
 * uncertain checks stay open in their family, the rest fold under it.
 */
export default function CheckFamilies({ job, program, assessment }: { job: JobRecord; program: ProgramRecord; assessment: PostAssessment }) {
  const details = useChecks((state) => state.details[job.id]);
  useEffect(() => { void loadCheckDetails(job); }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const families = useMemo(() => {
    const groups = new Map<FamilyKey, Check[]>();
    for (const check of assessment.checks) {
      const key = familyOf(check.id);
      groups.set(key, [...groups.get(key) ?? [], check]);
    }
    // The inspection and the rates have families even when their checks are listed elsewhere.
    return FAMILIES.filter((family) => groups.has(family.key)).map((family, order) => {
      const checks = [...groups.get(family.key)!].sort((a, b) => (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4));
      return { ...family, order, checks, status: worst(checks.map((check) => check.status)) };
    }).sort((a, b) => (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4) || a.order - b.order);
  }, [assessment.checks]);
  const estimated = (check: Check) => check.status === 'unassessed' && check.id !== 'input_provenance'
    && !!assessment.input_estimates?.some((item) => item.all_checks || item.affected_checks.includes(check.id));
  return (
    <details className={styles.engineerDetails} id="cam-checks" data-loaded={details ? 'true' : undefined}>
      <summary>Details for engineers <small>{assessment.checks.length} check{assessment.checks.length === 1 ? '' : 's'}</small></summary>
      <div className={styles.families}>
      {details?.error && <p className={styles.familyNote}>The detailed reports couldn’t be read: {details.error}</p>}
      {families.map((family) => {
        // What to act on stays in view (failed, uncertain); the rest folds away (not assessed, passed).
        const open = family.checks.filter((check) => check.status === 'failed' || check.status === 'uncertain');
        const unassessed = family.checks.filter((check) => check.status === 'unassessed');
        const passed = family.checks.filter((check) => check.status === 'passed');
        const counts = (['failed', 'uncertain', 'unassessed', 'passed'] as const).map((status) => [status, family.checks.filter((check) => check.status === status).length] as const).filter(([, n]) => n);
        const notes = details ? familyNotes(family.key, details) : [];
        return (
          <section key={family.key} className={styles.family} data-family={family.key} data-s={family.status} id={`cam-family-${family.key}`}>
            <header className={styles.familyHead} title={family.about}>
              <StatusIcon status={family.status} size={15} />
              <b>{family.title}</b>
              <small>{counts.map(([status, n]) => `${n} ${STATUS_WORDS[status]}`).join(' · ')}</small>
            </header>
            {open.map((check) => <CheckRow key={check.id} job={job} check={check} details={details} estimated={false} />)}
            {family.key === 'part' && details?.inspection && <InspectionDetails job={job} details={details} />}
            {family.key === 'rates' && details && <RateDetails job={job} program={program} details={details} />}
            {notes.map((note) => <p key={note} className={styles.familyNote}>{note}</p>)}
            {unassessed.length > 0 && (
              <details className={styles.passedChecks} data-folded="unassessed">
                <summary>{unassessed.length} not assessed</summary>
                {unassessed.map((check) => <CheckRow key={check.id} job={job} check={check} details={details} estimated={estimated(check)} />)}
              </details>
            )}
            {passed.length > 0 && (
              <details className={styles.passedChecks}>
                <summary>{open.length || unassessed.length ? `${passed.length} passed` : `All ${passed.length} passed`}</summary>
                {passed.map((check) => <CheckRow key={check.id} job={job} check={check} details={details} estimated={false} />)}
              </details>
            )}
          </section>
        );
      })}
      </div>
    </details>
  );
}

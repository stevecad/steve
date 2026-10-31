/**
 * Whether the board can be ordered (docs/ELECTRONICS.md, "Readiness"): the build's own verdict (fabrication limits,
 * electrical rules, sourcing) plus stock at JLCPCB for the order quantity, read when shown (app/electronic_parts.py's
 * overlay: the nightly catalogue snapshot, never live). "Ready to order" is the owner's definition of done.
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { get as getApp, isDirty, set as setApp, toast, useApp } from '@/state/store';
import { saveDocument, setCode } from '@/state/actions';
import { askSteveNow } from '@/panels/steve';
import { idList, type CircuitModel, type CircuitProblem } from './circuit';

export type Severity = 'blocking' | 'advisory' | 'info';

export interface ReadinessIssue {
  rule: string;
  severity: Severity;
  message: string;
  fix?: string | null;
  source?: { name?: string; url?: string | null; detail?: string | null } | null;
  component?: string | null;
  net?: string | null;
  ids?: Record<string, string | string[]> | string[] | null;
  measured?: number | null;
  limit?: number | null;
  detail?: string | null;
  source_line?: number | null;
  file?: string | null;
  tscircuit_type?: string | null;
  stock_as_of?: string | null;
}

export interface Readiness {
  version: number;
  verdict: 'ready' | 'blocked';
  fab_profile?: string;
  assembly?: boolean;
  blocking: ReadinessIssue[];
  advisories: ReadinessIssue[];
  checked?: string[];
  /** Copper checks that wait for the routed board (docs/ELECTRONICS.md, "Routing"): neither passed nor failed yet. */
  after_routing?: string[];
  /** Their titles, from the kernel's rules: `{rule: title}`. */
  after_routing_titles?: Record<string, string>;
}

/** The copper checks' names, for a server from before it sent `after_routing_titles`. */
const AFTER_ROUTING_NAMES: Record<string, string> = {
  'fab.trace_width': 'Traces are wide enough to make',
  'fab.trace_spacing': 'Copper of different connections is far enough apart',
  'fab.via_size': 'Vias can be drilled',
  'power.trace_current': 'Traces carry their declared current',
  'electrical.power_trace_width': 'Power and ground traces are wide enough',
};
/** A check's title: the kernel's (`titles`, from the readiness verdict), else this copy, else its rule id in words. */
export const checkName = (rule: string, titles?: Record<string, string>) =>
  titles?.[rule] ?? AFTER_ROUTING_NAMES[rule] ?? rule.replace(/^[a-z]+\./, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export interface StockOverlay {
  build_id: string;
  order_quantity: number;
  parts: { lcsc: string; mpn?: string | null; designators: string[]; quantity?: number; needed: number; stock?: number | null }[];
  blocking: ReadinessIssue[];
  advisories: ReadinessIssue[];
  stock_as_of: string;
  source: string;
  note?: string;
}

const QUANTITY_KEY = 'steve-order-quantity';
/** Prototype boards: what the research recommends ordering first. */
export const DEFAULT_QUANTITY = 5;
const initialQuantity = () => {
  try { const value = Number(localStorage.getItem(QUANTITY_KEY)); return Number.isInteger(value) && value >= 1 ? value : DEFAULT_QUANTITY; } catch { return DEFAULT_QUANTITY; }
};

interface StockState {
  quantity: number;
  /** Keyed `build:quantity`. `missing`: the server has no stock check (older); `failed`: it couldn't reach the catalogue. */
  results: Record<string, { status: 'loading' | 'ready' | 'missing' | 'failed'; overlay?: StockOverlay; error?: string }>;
  /** The readiness list is open. */
  open: boolean;
}

export const useReadiness = create<StockState>(() => ({ quantity: initialQuantity(), results: {}, open: false }));

export function setOrderQuantity(quantity: number) {
  const value = Math.max(1, Math.min(100_000, Math.round(quantity) || DEFAULT_QUANTITY));
  useReadiness.setState({ quantity: value });
  try { localStorage.setItem(QUANTITY_KEY, String(value)); } catch { /* Optional. */ }
}

export const openReadiness = (open = true) => useReadiness.setState({ open });

async function loadStock(buildId: string, quantity: number) {
  const key = `${buildId}:${quantity}`;
  const current = useReadiness.getState().results[key];
  if (current && current.status !== 'failed') return;
  useReadiness.setState((state) => ({ results: { ...state.results, [key]: { status: 'loading' } } }));
  let result: StockState['results'][string];
  try {
    const response = await fetch(`/v1/builds/${buildId}/stock?order_quantity=${quantity}`);
    if (response.status === 404 || response.status === 405) result = { status: 'missing' };
    else if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      result = { status: 'failed', error: body?.detail ?? `The stock check failed (${response.status}).` };
    } else result = { status: 'ready', overlay: await response.json() as StockOverlay };
  } catch (error) {
    result = { status: 'failed', error: (error as Error).message };
  }
  useReadiness.setState((state) => {
    const results = { ...state.results, [key]: result };
    // Keep the last few: builds come often while editing.
    const keys = Object.keys(results);
    for (const old of keys.slice(0, Math.max(0, keys.length - 12))) delete results[old];
    return { results };
  });
}

export interface ReadinessView {
  /** No readiness on this build (an older electronics service). */
  available: boolean;
  verdict: 'ready' | 'blocked' | 'checking';
  blocking: ReadinessIssue[];
  advisories: ReadinessIssue[];
  readiness: Readiness | null;
  stock: StockState['results'][string] | null;
  quantity: number;
}

const issueKey = (issue: ReadinessIssue) => `${issue.rule}|${issue.component ?? ''}|${issue.net ?? ''}|${issue.message}`;
const unique = (issues: ReadinessIssue[]) => [...new Map(issues.map((issue) => [issueKey(issue), issue])).values()];

/** The verdict for a circuit build with its stock check (if any) folded in. */
function viewOf(build: { metadata?: unknown } | null, quantity: number, stock: StockState['results'][string] | null): ReadinessView {
  const readiness = ((build?.metadata as { readiness?: Readiness } | null)?.readiness ?? null);
  if (!readiness) return { available: false, verdict: 'checking', blocking: [], advisories: [], readiness: null, stock, quantity };
  const overlay = stock?.status === 'ready' ? stock.overlay : null;
  const unchecked: ReadinessIssue[] = stock?.status === 'failed' ? [{
    rule: 'parts.stock_unchecked', severity: 'advisory', message: 'Stock at JLCPCB couldn’t be checked just now.',
    fix: 'Try again in a moment, or confirm stock in JLCPCB’s BOM upload before ordering.', source: { name: 'jlcsearch nightly snapshot of JLCPCB’s catalogue', url: 'https://jlcsearch.tscircuit.com' },
  }] : [];
  const blocking = unique([...readiness.blocking, ...(overlay?.blocking ?? [])]);
  const advisories = unique([...readiness.advisories, ...(overlay?.advisories ?? []), ...unchecked]);
  const verdict = blocking.length ? 'blocked' : stock?.status === 'loading' ? 'checking' : 'ready';
  return { available: true, verdict, blocking, advisories, readiness, stock, quantity };
}

const shownBuild = () => {
  const displayed = getApp().displayed;
  return displayed?.kind === 'circuit' && displayed.status === 'succeeded' ? displayed : null;
};

/** The verdict for the circuit build on screen, with stock for the order quantity folded in. */
export function useReadinessView(): ReadinessView {
  const build = useApp((state) => (state.displayed?.kind === 'circuit' && state.displayed.status === 'succeeded' ? state.displayed : null));
  const quantity = useReadiness((state) => state.quantity);
  const stock = useReadiness((state) => (build ? state.results[`${build.id}:${quantity}`] ?? null : null));
  useEffect(() => { if (build && (build.metadata as { readiness?: unknown } | null)?.readiness) void loadStock(build.id, quantity); }, [build?.id, quantity]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => viewOf(build, quantity, stock), [build, quantity, stock]);
}

/** The same, read once (commands). */
export function readinessNow(): ReadinessView {
  const build = shownBuild();
  const { quantity, results } = useReadiness.getState();
  return viewOf(build, quantity, build ? results[`${build.id}:${quantity}`] ?? null : null);
}

/** The parts an issue is about: its component (one or a list, "R1, R2"), or the parts its ids name. */
export function issueParts(issue: ReadinessIssue, partOf?: Map<string, string>): string[] {
  const named = (issue.component ?? '').split(/,\s*/).map((name) => name.trim()).filter(Boolean);
  const fromIds = partOf ? idList(issue.ids).map((id) => partOf.get(id)).filter((name): name is string => !!name) : [];
  return [...new Set([...named, ...fromIds])];
}

/** A measured value against its limit, in the rule's units: "0.15 mm, needs at least 0.3 mm"; "4 in stock, 10 needed". */
export function measuredText(issue: ReadinessIssue): string | null {
  if (issue.measured === undefined || issue.measured === null || issue.limit === undefined || issue.limit === null) return null;
  const n = (value: number) => Number(value.toFixed(3)).toString();
  if (issue.rule.startsWith('parts.')) return `${n(issue.measured)} in stock · ${n(issue.limit)} wanted`;
  const mm = /^(fab|board)\.|width|spacing|clearance|size|thickness|edge/.test(issue.rule) ? ' mm' : '';
  const below = issue.measured < issue.limit;
  return `${n(issue.measured)}${mm} · ${below ? 'needs at least' : 'limit'} ${n(issue.limit)}${mm}`;
}

const NAMES: Record<string, string> = { 'jlcpcb-standard': 'JLCPCB standard' };
export const profileName = (profile?: string) => (profile ? NAMES[profile] ?? profile : 'the board house');

/** The message STEVE gets for one issue, or all the blocking ones. */
function steveRequest(issues: ReadinessIssue[], quantity: number): string {
  const lines = issues.map((issue, index) => [
    `${index + 1}. [${issue.rule}] ${issue.message}`,
    issue.component ? `   Part: ${issue.component}` : '',
    issue.net ? `   Net: ${issue.net}` : '',
    issue.source_line ? `   Line ${issue.source_line}${issue.file ? ` of ${issue.file}` : ''}` : '',
    measuredText(issue) ? `   Measured: ${measuredText(issue)}` : '',
    issue.fix ? `   Suggested fix: ${issue.fix}` : '',
  ].filter(Boolean).join('\n'));
  const one = issues.length === 1;
  return `Make this circuit ready to order${one ? ': fix this readiness issue' : `: fix these ${issues.length} readiness issues`} (order of ${quantity} board${quantity === 1 ? '' : 's'}).\n\n${lines.join('\n')}\n\n`
    + 'Change only what they need, keep everything else, regenerate, and check the readiness verdict again.';
}

/** Hands issues to STEVE (saving first: STEVE edits the saved circuit). */
export async function fixWithSteve(issues: ReadinessIssue[]) {
  if (!issues.length) return;
  const state = getApp();
  if (!state.doc.saved || isDirty(state)) {
    if (!await saveDocument()) { toast('warning', 'Save the circuit first', 'STEVE works on the saved circuit.'); return; }
  }
  askSteveNow(steveRequest(issues, useReadiness.getState().quantity));
  setApp({ dockOpen: true, dockTab: 'assistant' });
}

/** tscircuit diagnostics a readiness rule restates in plain words (the rule's issue is shown, not the diagnostic). */
const RESTATED: Record<string, string> = {
  'electrical.unnamed_traces': 'source_unnamed_trace_warning',
  'parts.footprint_match': 'supplier_footprint_mismatch_warning',
};

/**
 * Everything wrong with the circuit, for the browser's Problems and the editor: the readiness issues (what blocks the
 * order, then advisories), and tscircuit's own diagnostics that no readiness issue already explains.
 */
export function mergeProblems(model: CircuitModel | null, view: ReadinessView): CircuitProblem[] {
  const diagnostics = model?.problems ?? [];
  if (!view.available) return diagnostics;
  // An empty board is a starting point (its card and chip say what to do), not a problem to list.
  const issues = [...view.blocking, ...view.advisories].filter((issue) => issue.rule !== 'board.empty');
  const severity = (issue: ReadinessIssue): CircuitProblem['severity'] => (issue.severity === 'blocking' ? 'error' : issue.severity === 'advisory' ? 'warning' : 'info');
  const fromReadiness: CircuitProblem[] = issues.map((issue, index) => ({
    id: `readiness:${issue.rule}:${index}`, type: issue.rule, message: issue.message, severity: severity(issue), fix: issue.fix ?? null, issue,
    parts: issueParts(issue, model?.partOf), line: issue.file && issue.file !== 'main.tsx' ? null : issue.source_line ?? null,
  }));
  const explained = (problem: CircuitProblem) => issues.some((issue) => {
    const type = issue.tscircuit_type ?? RESTATED[issue.rule];
    if (type !== problem.type) return false;
    const parts = issueParts(issue, model?.partOf);
    return !parts.length || !problem.parts.length || problem.parts.some((part) => parts.includes(part));
  });
  return [...fromReadiness, ...diagnostics.filter((problem) => !explained(problem))];
}

/** Exporting fabrication files from a board that isn't ready: asked first (ReadinessPanel's ExportGuard). */
export const useExportGuard = create<{ pending: (() => void) | null; count: number }>(() => ({ pending: null, count: 0 }));

/** Runs `exporting` when the board is ready to order; otherwise asks first, showing how many issues stand in the way. */
export function guardExport(exporting: () => void) {
  const view = readinessNow();
  if (!view.available || view.verdict !== 'blocked') { exporting(); return; }
  useExportGuard.setState({ pending: exporting, count: view.blocking.length });
}

/**
 * The one-click fix for an issue, where the code-rewrite engine has one (E3: inspector/Readiness.tsx `fixFor`):
 * fab-ready board settings, a power net at 0.4 mm, decoupling, an LED resistor, crystal load caps, USB-C CC resistors,
 * regulator capacitors. Null: STEVE (or the person) fixes it.
 */
type FixModule = { fixFor: (issue: ReadinessIssue, code: string, circuit: readonly unknown[] | null) => { label: string; run: () => { code: string; changed: boolean; notes?: string[] } } | null };
const fixers = import.meta.glob<FixModule>('./inspector/Readiness.tsx', { eager: true });
const fixer = Object.values(fixers)[0];

export function directFix(issue: ReadinessIssue, code: string, circuit: readonly unknown[] | null): { label: string; apply: () => void } | null {
  let fix: ReturnType<FixModule['fixFor']> = null;
  try { fix = fixer?.fixFor(issue, code, circuit) ?? null; } catch { fix = null; }
  if (!fix) return null;
  const { label, run } = fix;
  return {
    label,
    apply: () => {
      try {
        const result = run();
        if (!result.changed) { toast('info', 'Already done', 'The code already has this.'); return; }
        setCode(result.code);
        toast('success', label, result.notes?.join(' ') || 'The code is updated; the board rebuilds now.');
      } catch (error) {
        toast('warning', 'Couldn’t apply the fix', `${(error as Error).message} STEVE can do it instead.`);
      }
    },
  };
}

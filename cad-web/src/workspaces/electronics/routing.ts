/**
 * Routing the board (docs/ELECTRONICS.md, "Routing"). Builds don't autoroute: the PCB shows the ratsnest, plus any copper
 * the workspace's routing cache holds. Routing is one explicit step, Route board: a full build asked for with
 * `route: true`, which takes minutes within the server's budget and finishes with a result (`metadata.routing`): routed,
 * or stopped at the budget with what to change instead.
 *
 * Nothing here cancels it. Leaving the circuit, editing it or reloading the page keeps it running on the server, and it's
 * found and followed again. When it finishes, its board is shown if the code is still the code it routed. After an edit,
 * the edit's own preview stays (unrouted, with the cache's copper for whatever the edit didn't change). Only one routing
 * build runs per workspace: asking again while one runs shows it.
 */
import { create } from 'zustand';
import { Api, serverCapabilities, type Build, type CircuitRouting } from '@/lib/api';
import { get as getApp, toast, useApp } from '@/state/store';
import { showFinishedBuild } from '@/state/actions';
import { builtFrom, stored } from '@/state/design';
import { budgetText, clock, duration } from './routingWords';

export type { CircuitRouting };

/** A build's routing report, or null (not a circuit, or a server from before explicit routing). */
export const routingOf = (build: { metadata?: unknown } | null | undefined): CircuitRouting | null =>
  ((build?.metadata as { routing?: CircuitRouting } | null)?.routing ?? null);

const isRouteBuild = (build: Build) => build.kind === 'circuit' && (build.route === true || routingOf(build)?.requested === true);
export const isRunning = (build: Build | null | undefined) => !!build && (build.status === 'queued' || build.status === 'running');

interface RouteState {
  /** The routing build this workspace is running, or the last one followed here, as last read. */
  build: Build | null;
  /** The document it routes (`docKey`), when it's one open here; null for another board of the workspace. */
  owner: string | null;
  /** When it was asked for here (ms): the elapsed time before the server says it started. */
  asked: number | null;
  /** The routing panel (progress and result) is open. */
  open: boolean;
  /** The server takes `route` in a build request; null until known. */
  supported: boolean | null;
}

export const useRouting = create<RouteState>(() => ({ build: null, owner: null, asked: null, open: false, supported: null }));

/** Which document is open: its saved id, else its tab. */
export const docKey = () => { const state = getApp(); return state.doc.saved?.id ?? state.activeTab ?? ''; };

/** Whether the routing build is this board's (asked for here, or routing the code that's open), not another board's. */
export const routesThisBoard = (state: { build: Build | null; owner: string | null }) =>
  !!state.build && (state.owner === docKey() || (getApp().doc.kind === 'circuit' && builtFrom(state.build, getApp().doc)));
export const openRouting = (open = true) => useRouting.setState({ open });

const LAST = 'steve-route-build';
const remember = (id: string) => { try { localStorage.setItem(LAST, id); } catch { /* Optional. */ } };
const remembered = () => { try { return localStorage.getItem(LAST); } catch { return null; } };

/* ───────── words ───────── */

export { clock, duration };

/** What a routing report says, in a line: "46/46 connections routed in 3 min 13 s". */
export function routingSummary(routing: CircuitRouting | null): string | null {
  if (!routing?.status) return null;
  const total = routing.connections ?? 0, done = routing.connections_routed ?? 0;
  const took = routing.used_s ?? routing.routing_s;
  switch (routing.status) {
    case 'routed':
      if (!routing.requested || !routing.routing_s) return `${total}/${total} connections routed (from earlier routing)`;
      return `${total}/${total} connections routed${took ? ` in ${duration(took)}` : ''}`;
    case 'incomplete': return `Routed ${done} of ${total} connections before ${budgetText(routing.budget_s)}`;
    case 'not_routed': return done ? `Not routed: ${done} of ${total} connections have copper from earlier routing` : `Not routed: ${total} ${total === 1 ? 'connection' : 'connections'} to route`;
    case 'failed': return 'Routing failed';
    case 'none': return 'Nothing to route';
  }
  return null;
}

const BUDGET = 'steve-route-budget';
/** The budget the server gave the last routing build seen here: its builds don't say it until they finish. */
const lastBudget = () => { try { return Number(localStorage.getItem(BUDGET)) || null; } catch { return null; } };
const noteBudget = (build: Build | null | undefined) => {
  const seconds = routingOf(build)?.budget_s;
  if (seconds) try { localStorage.setItem(BUDGET, String(seconds)); } catch { /* Optional. */ }
};

/** The time a routing build has: the server's word on the build or in its report, else its last routing build's. */
export const budgetOf = (build: Build | null | undefined) => routingOf(build)?.budget_s ?? build?.route_budget_s ?? (build?.route ? lastBudget() : null);

/** Seconds a routing build has been going: from the server's start, else from when it was asked for here. */
export function elapsedOf(build: Build | null | undefined, asked: number | null, now = Date.now()): number {
  if (!build) return 0;
  const from = build.started_at ? new Date(build.started_at).getTime() : asked ?? new Date(build.created_at).getTime();
  const to = build.finished_at ? new Date(build.finished_at).getTime() : now;
  return Math.max(0, (to - from) / 1000);
}

/** Where a running build is ("autorouting"): the kernel's last stage line, when the server passes its log on. */
export function stageOf(build: Build | null | undefined): string | null {
  const lines = (build?.logs ?? '').split('\n').filter((line) => line.startsWith('STEVE stage: '));
  return lines.length ? lines[lines.length - 1].slice('STEVE stage: '.length).trim() : null;
}

/* ───────── doing it ───────── */

export async function routingSupported(): Promise<boolean> {
  const known = useRouting.getState().supported;
  if (known !== null) return known;
  const supported = (await serverCapabilities()).routeBuilds;
  useRouting.setState({ supported });
  return supported;
}

let following: string | null = null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a routing build until it finishes: it's never cancelled from here. */
async function follow(id: string) {
  if (following === id) return;
  following = id;
  let failures = 0;
  while (following === id) {
    let build: Build;
    try { build = await Api.build(id); failures = 0; }
    catch {
      // A redeploy or a dropped connection: the build goes on on the server; keep asking, less often.
      if (++failures > 40) { following = null; return; }
      await pause(Math.min(2000 * failures, 15_000));
      continue;
    }
    if (following !== id) return;
    useRouting.setState({ build });
    if (!isRunning(build)) { following = null; await finished(build); return; }
    await pause(2000);
  }
}

/** A routing build has finished: say how it went, and show its board if the code is still what it routed. */
async function finished(build: Build) {
  const routing = routingOf(build);
  noteBudget(build);
  const owner = useRouting.getState().owner;
  const state = getApp();
  const current = state.doc.kind === 'circuit' && builtFrom(build, state.doc);
  // Another board's routing (found running in the workspace, not asked for here): only that Route board is free again.
  if (!current && !owner) {
    if (state.doc.kind === 'circuit') toast('info', `“${build.name || 'Another board'}” finished routing`, 'Boards in a workspace route one at a time: this one can be routed now.');
    return;
  }
  if (build.status === 'failed') {
    toast('danger', 'Routing didn’t finish', build.error?.trim().split('\n').pop() || 'The routing build failed.', {
      action: { label: 'Details', run: () => openRouting(true) },
    });
    return;
  }
  const summary = routingSummary(routing) ?? 'Routing finished';
  const tone = routing?.status === 'routed' ? 'success' : routing?.status === 'incomplete' || routing?.status === 'failed' ? 'warning' : 'info';
  if (current) {
    const shown = await showFinishedBuild(build);
    // An update was in flight for the same code: show the routed board once it has landed.
    if (!shown) {
      const stop = useApp.subscribe((now) => now.busy, (busy) => {
        if (busy) return;
        stop();
        const now = getApp();
        if (now.doc.kind === 'circuit' && builtFrom(build, now.doc) && routingOf(now.displayed)?.status !== 'routed') void showFinishedBuild(build);
      });
    }
  }
  toast(tone, routing?.status === 'routed' ? 'Board routed' : routing?.status === 'incomplete' ? 'Routing stopped at its budget' : 'Routing finished',
    current ? summary : owner === docKey()
      ? `${summary}. The code has changed since: the board shows your edit, with the copper it didn’t affect; Route board again for the rest.`
      : `${build.name}: ${summary}. Open it to see the routed board.`,
    { action: { label: 'Details', run: () => openRouting(true) } });
}

/**
 * Finds this workspace's routing build (one running here or anywhere in the workspace, or the last one asked for here)
 * and follows it; shows its board if it routed the code that's open.
 */
export async function findRouting(): Promise<Build | null> {
  if (!await routingSupported()) return null;
  let candidates: Build[] = [];
  try { candidates = (await Api.builds(30)).builds.filter(isRouteBuild); } catch { /* Offline: nothing to follow yet. */ }
  const running = candidates.find(isRunning);
  const last = remembered();
  const pick = running ?? (last ? candidates.find((build) => build.id === last) : undefined);
  if (!pick) return useRouting.getState().build;
  const known = useRouting.getState().build;
  if (known?.id === pick.id && known.status === pick.status && !isRunning(known)) return known;  // Nothing new since.
  let build: Build;
  try { build = await Api.build(pick.id); } catch { return null; }  // With its code: whether it routed what's open.
  const state = getApp();
  const mine = state.doc.kind === 'circuit' && builtFrom(build, state.doc);
  useRouting.setState((current) => ({ build, owner: mine ? docKey() : current.build?.id === build.id ? current.owner : null }));
  if (isRunning(build)) void follow(build.id);
  else {
    const state = getApp();
    if (build.status === 'succeeded' && state.doc.kind === 'circuit' && builtFrom(build, state.doc) && routingOf(state.displayed)?.status !== 'routed') await showFinishedBuild(build);
  }
  return build;
}

/** Route board: a routing build of the open circuit, or the one already running in this workspace. */
export async function routeBoard() {
  const state = getApp();
  if (state.doc.kind !== 'circuit' || !state.doc.open) return;
  if (!await routingSupported()) {
    toast('warning', 'This server can’t route boards yet', 'Its build service is from before routing became its own step.');
    return;
  }
  // Never a second: asking again shows the one that's running.
  if (isRunning(useRouting.getState().build) || isRunning(await findRouting())) { openRouting(true); return; }
  const doc = getApp().doc;
  let build: Build;
  try {
    build = await Api.submit({ kind: 'circuit', name: doc.name.trim() || 'Untitled', ...stored(doc), mode: 'full', route: true });
  } catch (error) {
    toast('danger', 'Couldn’t start routing', (error as Error).message);
    return;
  }
  remember(build.id);
  useRouting.setState({ build, owner: docKey(), asked: Date.now(), open: true });
  if (isRunning(build)) void follow(build.id);
  else {
    // Routed before (the same code): the server answers from its cache at once.
    const full = await Api.build(build.id).catch(() => build);
    useRouting.setState({ build: full });
    await finished(full);
  }
}

/** Whether Route board makes sense for what's shown: unrouted, and not stopped at a budget it would only hit again. */
export function canRoute(routing: CircuitRouting | null): boolean {
  if (!routing?.status) return false;
  if (routing.status === 'not_routed') return true;
  if (routing.status === 'incomplete' || routing.status === 'failed') return routing.retryable !== false;
  return false;
}

let installed = false;
/** Follows routing across the app: found again whenever a circuit is shown (a reload, another circuit, a new session). */
export function installRouting() {
  if (installed) return;
  installed = true;
  let lastDoc: string | null = null;
  useApp.subscribe((state) => state.displayed, (displayed) => {
    noteBudget(displayed);
    const state = getApp();
    if (displayed?.kind !== 'circuit' || state.doc.kind !== 'circuit') return;
    const key = state.doc.saved?.id ?? state.activeTab ?? '';
    if (key === lastDoc) return;
    lastDoc = key;
    void findRouting();
  });
  // Another board of the workspace may start routing meanwhile (STEVE, another tab): look now and then while a circuit is
  // open, so Route board says so before it's pressed.
  setInterval(() => {
    const state = getApp();
    if (state.doc.kind !== 'circuit' || !state.doc.open || following || document.visibilityState !== 'visible') return;
    void findRouting();
  }, 15_000);
}

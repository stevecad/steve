/**
 * Route board in the PCB view (routing.ts): a quiet "Not routed · Route board" badge on an unrouted board, the routing
 * build's progress while it runs (elapsed against its budget, its stage, connections routed), then its result: routed,
 * or stopped at the budget with the server's message and next steps in plain words. Routing goes on whatever happens
 * here; the status bar keeps showing it in the other views.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Check, CircleSlash, Route, X } from 'lucide-react';
import { useApp } from '@/state/store';
import { Button, IconButton, Spinner, Tip } from '@/ui';
import { waitingLabel } from '@/lib/waiting';
import { setView } from './state';
import {
  budgetOf, canRoute, clock, duration, elapsedOf, isRunning, openRouting, routeBoard, routesThisBoard, routingOf, routingSummary, stageOf, useRouting,
  type CircuitRouting,
} from './routing';
import styles from './Electronics.module.css';

/** Seconds since `asked`/the start of a running routing build, ticking. */
function useElapsed(): number {
  const build = useRouting((state) => state.build);
  const asked = useRouting((state) => state.asked);
  const [now, setNow] = useState(Date.now());
  const running = isRunning(build);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return elapsedOf(build, asked, running ? now : undefined);
}

/** What the routing UI shows: the running routing build, else the routing of the board on screen. */
export function useRoutingView() {
  const build = useRouting((state) => state.build);
  const supported = useRouting((state) => state.supported);
  const displayed = useApp((state) => (state.displayed?.kind === 'circuit' && state.displayed.status === 'succeeded' ? state.displayed : null));
  const shown = routingOf(displayed);
  const owner = useRouting((state) => state.owner);
  useApp((state) => state.doc.code);  // Whose it is depends on the code that's open.
  const mine = routesThisBoard({ build, owner });
  const running = isRunning(build);
  const elapsed = useElapsed();
  const result = !running && mine && build && build.status !== 'queued' ? routingOf(build) : null;
  // Another board of the workspace routing: one at a time, so Route board waits for it.
  return { build, running, mine, elsewhere: running && !mine, shown, result, elapsed, budget: budgetOf(build), stage: stageOf(build), supported: supported !== false };
}

type Tone = 'quiet' | 'running' | 'ok' | 'warn' | 'danger';
const toneOf = (routing: CircuitRouting | null): Tone | null => {
  switch (routing?.status) {
    case 'not_routed': return 'quiet';
    case 'routed': return 'ok';
    case 'incomplete': return 'warn';
    case 'failed': return 'danger';
    default: return null;
  }
};

/** The PCB view's routing badge: what the board's routing is, and Route board when it's unrouted. */
export function RoutingBadge() {
  const view = useRoutingView();
  const open = useRouting((state) => state.open);
  if (view.running) {
    const share = view.budget ? Math.min(1, view.elapsed / view.budget) : null;
    return (
      <div className={styles.routeBadge} data-tone="running" id="route-badge" data-state={view.elsewhere ? 'elsewhere' : 'running'}>
        <button type="button" onClick={() => openRouting(!open)} aria-expanded={open} id="route-progress">
          <Spinner size={11} /><span>{view.elsewhere ? 'Routing another board' : 'Routing'}</span><span className={styles.routeClock}>{clock(view.elapsed)}{view.budget ? ` / ${clock(view.budget)}` : ''}</span>
        </button>
        {share !== null && <span className={styles.routeMeter} style={{ width: `${share * 100}%` }} />}
      </div>
    );
  }
  const routing = view.shown;
  const tone = toneOf(routing);
  if (!routing || !tone) return null;
  const total = routing.connections ?? 0, done = routing.connections_routed ?? 0;
  if (tone === 'quiet') {
    return (
      <div className={styles.routeBadge} data-tone="quiet" id="route-badge" data-state="not_routed">
        <Tip label="Not routed" description={`${routingSummary(routing)}. The board shows the ratsnest; routing takes minutes, once the parts are placed.`}>
          <button type="button" className={styles.routeStatus} onClick={() => openRouting(!open)} aria-expanded={open}>
            <span className={styles.routeDot} />Not routed{done ? <small>{done}/{total}</small> : null}
          </button>
        </Tip>
        {view.supported && canRoute(routing) && (
          <Tip label="Route board" description="Lays the copper for every connection. Takes minutes; you can keep working meanwhile.">
            <button type="button" className={styles.routeAction} id="route-board" onClick={() => { void routeBoard(); }}><Route size={13} />Route board</button>
          </Tip>
        )}
      </div>
    );
  }
  const Icon = tone === 'ok' ? Check : tone === 'warn' ? AlertTriangle : CircleSlash;
  const label = tone === 'ok' ? 'Routed' : tone === 'warn' ? 'Partly routed' : 'Routing failed';
  return (
    <div className={styles.routeBadge} data-tone={tone} id="route-badge" data-state={routing.status}>
      <button type="button" onClick={() => openRouting(!open)} aria-expanded={open}>
        <Icon size={13} strokeWidth={2.2} />{label}{total > 0 && tone !== 'danger' ? <small>{tone === 'ok' ? total : done}/{total}</small> : null}
      </button>
    </div>
  );
}

/** The routing panel under the badge: progress while routing, then the result and what to do about it. */
export function RoutingPanel() {
  const open = useRouting((state) => state.open);
  const view = useRoutingView();
  const displayedId = useApp((state) => state.displayed?.id ?? null);
  const routing = view.running ? routingOf(view.build) : view.result ?? view.shown;
  const status = view.running ? 'running' : routing?.status ?? null;
  const visible = open && (view.running || !!routing);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target as HTMLElement | null)?.closest('input, textarea, .cm-editor')) { openRouting(false); event.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible]);
  const title = status === 'running' ? (view.elsewhere ? 'Routing another board' : 'Routing the board') : status === 'routed' ? 'Board routed' : status === 'incomplete' ? 'Routing stopped at its budget'
    : status === 'failed' ? 'Routing failed' : status === 'none' ? 'Nothing to route' : 'Not routed';
  const total = routing?.connections ?? 0, done = routing?.connections_routed ?? 0;
  const share = view.running && view.budget ? Math.min(1, view.elapsed / view.budget) : null;
  // The result of a routing build for code that has changed since: the board shows the edit.
  const earlier = !view.running && !!view.result && !!view.build && displayedId !== view.build.id;
  return (
    <AnimatePresence>
      {visible && (
        <motion.div className={styles.routePanel} id="route-panel" data-status={status ?? undefined} role="dialog" aria-label="Routing"
          initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.12 } }}
          transition={{ type: 'spring', stiffness: 440, damping: 34 }}>
          <header>
            <h3>{title}</h3>
            <IconButton small label="Close" shortcut="Esc" onClick={() => openRouting(false)}><X /></IconButton>
          </header>
          {view.running && (
            <div className={styles.routeRunning}>
              <p id="route-summary">{view.elsewhere
                ? `${view.build?.name || 'Another board'} in this workspace is being routed. Boards route one at a time: Route board is here again when it’s done.`
                : 'Routing takes minutes. Keep working: an edit shows an unrouted preview, and the routed board comes back if the code is still what it routed.'}</p>
              <div className={styles.routeTrack}><span style={{ width: share !== null ? `${share * 100}%` : undefined }} data-indeterminate={share === null || undefined} /></div>
              <dl className={styles.routeFacts}>
                <dt>Elapsed</dt><dd id="route-elapsed">{duration(view.elapsed)}{view.budget ? ` of ${duration(view.budget)}` : ''}</dd>
                <dt>Stage</dt><dd title={view.build?.status === 'queued' ? view.build.waiting?.message : undefined}>{view.build?.status === 'queued' ? waitingLabel(view.build.waiting, 'Waiting for a routing kernel') : view.stage ?? 'Placing, then autorouting'}</dd>
                {total > 0 && <><dt>Connections</dt><dd>{done} of {total} routed</dd></>}
              </dl>
            </div>
          )}
          {!view.running && routing && (
            <div className={styles.routeResult}>
              <p id="route-summary" data-status={routing.status}>{routingSummary(routing)}</p>
              {earlier && <p className={styles.routeNote}>For the code as it was when routing started. The board shows your edit since.</p>}
              <dl className={styles.routeFacts}>
                {total > 0 && <><dt>Connections</dt><dd>{routing.status === 'routed' ? total : done} of {total} with copper</dd></>}
                {routing.requested && routing.used_s != null && <><dt>Time</dt><dd>{duration(routing.used_s)}{routing.budget_s ? ` of ${duration(routing.budget_s)}` : ''}</dd></>}
                {!!routing.from_cache && <><dt>From earlier</dt><dd>{routing.from_cache} of {routing.phases ?? routing.from_cache} {routing.phases === 1 ? 'phase' : 'phases'}</dd></>}
              </dl>
              {routing.message && routing.status !== 'routed' && <p className={styles.routeMessage} id="route-message">{routing.message}</p>}
              {!!routing.next_steps?.length && (
                <>
                  <p className={styles.routeStepsTitle}>What to change</p>
                  <ul className={styles.routeSteps} id="route-next-steps">{routing.next_steps.map((step) => <li key={step}>{step}</li>)}</ul>
                </>
              )}
              {view.supported && canRoute(view.shown) && (
                <div><Button size="sm" variant="primary" icon={<Route />} id="route-board-panel" onClick={() => { void routeBoard(); }}>Route board</Button></div>
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Route board as a readiness issue's action: the routing build's clock while it runs. */
export function RouteIssueAction() {
  const view = useRoutingView();
  if (view.running) return <button type="button" className={styles.issueQuick} disabled data-route><Spinner size={10} />{view.elsewhere ? 'Another board is routing' : `Routing ${clock(view.elapsed)}`}</button>;
  if (!view.supported || !canRoute(view.shown)) return null;
  return <button type="button" className={styles.issueQuick} data-route onClick={() => { void routeBoard(); }}><Route size={12} />Route board</button>;
}

/** The status bar's note while a board routes, from any view: it opens the progress on the board. */
export function RoutingStatus() {
  const view = useRoutingView();
  const circuit = useApp((state) => state.doc.kind === 'circuit');
  if (!view.running || !circuit) return null;
  return (
    <button type="button" className={styles.routeStatusBar} id="route-status" onClick={() => { if (useApp.getState().circuitView === 'schematic' || useApp.getState().circuitView === '3d') setView('pcb'); openRouting(true); }}>
      <Spinner size={10} />{view.elsewhere ? 'Routing another board' : 'Routing board'} <span>{clock(view.elapsed)}{view.budget ? ` / ${clock(view.budget)}` : ''}</span>
    </button>
  );
}

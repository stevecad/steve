/**
 * Why a queued job waits and when it should start, as the server reports it on builds and simulation runs
 * (app/waiting.py), in the few words a status shows: "Queued: 3 ahead, starts in about 2 min".
 */
export interface Waiting {
  reason: string;
  /** The same in a plain sentence (with the estimate), for a tooltip or an agent. */
  message: string;
  /** Queued jobs taken first, counted up to 20 (20 means "20 or more"); null when unknown. */
  ahead: number | null;
  /** When it should start (an estimate); null when unknown. */
  estimated_start: string | null;
  /** reason at_once: the person's own running builds or simulations it waits for (oldest first), how many run at once,
   *  and what they are ("builds", "simulations"). It is waiting its turn, not failing. */
  busy?: { name: string; mode: string; since: string | null }[];
  slots?: number | null;
  of?: string;
}

const SHORT: Record<string, string> = {
  same_build: 'the same build is running',
  route: 'another board is routing',
  no_workers: 'waiting for a worker',
  preview_reserve: 'workers busy with long jobs',
  capacity: 'waiting for capacity',
  starting: 'starting',
  paused: 'simulations paused',
  design_limit: 'this design’s limit at once is in use',
  solver_limit: 'waiting for a solver',
};

/** "starts in about 2 min" from the estimate, or '' when there is none (or it starts now). */
export function startsIn(waiting: Waiting, now = Date.now()): string {
  if (!waiting.estimated_start || waiting.reason === 'starting') return '';
  const minutes = (new Date(waiting.estimated_start).getTime() - now) / 60_000;
  return minutes < 1 ? 'starts in under a minute' : `starts in about ${Math.round(minutes)} min`;
}

/** "after one of your 6 builds (Gearbox 4 min, +5)": what a job past the person's allowance at once waits behind. */
function behind(waiting: Waiting, now: number): string {
  const busy = waiting.busy ?? [];
  const of = waiting.of ?? 'builds';
  if (!busy.length) return `waiting for one of your ${of}`;
  const first = busy[0];
  const minutes = first.since ? Math.round((now - new Date(first.since).getTime()) / 60_000) : 0;
  const more = busy.length > 1 ? `, +${busy.length - 1}` : '';
  return `after one of your ${busy.length} ${of} (${first.name} ${minutes < 1 ? '<1' : minutes} min${more})`;
}

/** A queued job's status line: `fallback` until the server explains it. */
export function waitingLabel(waiting: Waiting | null | undefined, fallback = 'Queued', now = Date.now()): string {
  if (!waiting) return fallback;
  const why = waiting.reason === 'queue' && waiting.ahead ? `${waiting.ahead}${waiting.ahead >= 20 ? '+' : ''} ahead`
    : waiting.reason === 'at_once' ? behind(waiting, now) : SHORT[waiting.reason];
  return `Queued: ${[why, startsIn(waiting, now)].filter(Boolean).join(', ') || 'waiting'}`;
}

/**
 * A build the platform put back in the queue (its worker was replaced in an update, its geometry kernel stopped, it
 * needed more memory reserved…) says so in the status bar, and keeps its own clock across the restart.
 */

/** What a restart's reason (builds.restarted_reason, app/worker.py RESTARTS) says. */
const REASONS: Record<string, string> = {
  worker: 'the build service was updated',
  kernel: 'its geometry worker stopped',
  room: 'its geometry worker had no room',
  memory: 'it needed more memory',
  cpu: 'it needed more processor time',
  joined: 'it was asked for again',
};

/** The fields of a build these read (lib/api.ts Build). */
export interface RestartFields {
  id: string;
  status: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  restarts?: number;
  restarted_reason?: string | null;
}

export function restartWords(reason: string | null | undefined): string {
  return REASONS[reason ?? ''] ?? 'its geometry worker stopped';
}

/** A followed build's status line (`label`, its waiting or progress words), saying it restarted and why. */
export function restartedLabel(build: Pick<RestartFields, 'status' | 'restarts' | 'restarted_reason'>, label: string): string {
  if (!build.restarts) return label;
  const why = restartWords(build.restarted_reason);
  return build.status === 'queued' ? `Restarting: ${why} · ${label}` : `${label} (restarted: ${why})`;
}

/** A followed build's clock: when it started, for the status bar's elapsed time. */
export interface BuildClock { id: string; started: number }

/**
 * The clock of `build`, as polled: the same build keeps `previous` through queued, running, restarts and loading. A build
 * first seen queued or running counts from its own creation (it was asked for before this window followed it: a
 * reopened document, a joined build); one already finished when first seen (a cached build being opened) starts now,
 * since only its loading is left. Another build starts its own clock.
 */
export function clockFor(previous: BuildClock | null, build: RestartFields, now = Date.now()): BuildClock {
  if (previous?.id === build.id) return previous;
  const created = Date.parse(build.created_at ?? '');
  const live = build.status === 'queued' || build.status === 'running';
  return { id: build.id, started: live && Number.isFinite(created) ? Math.min(created, now) : now };
}

const seconds = (from: string, to: string | number) => Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 1000);

/** The time a build ran, shown once it's done: "4.2 s", or after a restart this attempt's and the whole build's
 *  ("4.2 s · 16 min 3 s in total, restarted once"); '' before it started. */
export function runtimeText(build: RestartFields, now = Date.now()): string {
  if (!build.started_at) return '';
  const run = `${seconds(build.started_at, build.finished_at || now).toFixed(1)} s`;
  if (!build.restarts || !build.created_at) return run;
  const total = seconds(build.created_at, build.finished_at || now);
  const minutes = Math.floor(total / 60);
  const whole = minutes ? `${minutes} min ${Math.floor(total % 60)} s` : `${total.toFixed(1)} s`;
  return `${run} · ${whole} in total, restarted ${build.restarts === 1 ? 'once' : `${build.restarts} times`}`;
}

/**
 * Connector runs waiting for this person's confirmation (asked by the STEVE assistant, an AI agent, an API key or an
 * app; app/connector_runs.py), and calls to outside MCP servers' tools that wait the same way (app/mcp_servers.py):
 * one shared, lightly polled list, so the top bar, the assistant panel and the Run an action dialog all show the same
 * ones, and a new one is announced once.
 */
import { create } from 'zustand';
import { toast } from '@/state/store';
import { api } from '@/lib/api';
import { ASKED_BY, type Run } from '@/lib/actions';
import { useRmfgOrders } from '@/lib/rmfgOrders';

const EVERY = 30_000;   // ms between looks while the tab is visible
const SOON = 4_000;     // ms after something that may have asked for one (the assistant ran an action)

/** A call to an outside MCP server's tool, waiting (Settings → MCP servers confirms it). */
export interface WaitingCall { id: string; server: string | null; tool: string; asked_by: string }
interface Pending { runs: Run[]; calls: WaitingCall[]; refresh: () => Promise<void> }

let seen: Set<string> | null = null;
let timer: number | undefined;

export const usePendingRuns = create<Pending>((set) => ({
  runs: [],
  calls: [],
  refresh: async () => {
    let runs: Run[];
    try {
      runs = (await api<{ runs: Run[] }>('/v1/action-runs?state=awaiting_confirmation&limit=20')).runs;
    } catch {
      return;   // Not signed in yet, or connectors unavailable: nothing waits.
    }
    let calls: WaitingCall[] = [];
    try {
      calls = (await api<{ calls: WaitingCall[] }>('/v1/mcp-servers/calls?state=awaiting_confirmation')).calls;
    } catch { /* outside servers unavailable: none wait */ }
    if (seen) {
      for (const run of runs) {
        if (!seen.has(run.id)) toast('info', `${run.action.title} waits for you`, `Asked by ${ASKED_BY[run.requested_by.kind]}. Confirm it to run.`);
      }
      for (const call of calls) {
        if (!seen.has(call.id)) toast('info', `${call.server} · ${call.tool} waits for you`, 'A tool that may change things on that server. Confirm it in Settings → MCP servers.');
      }
    }
    seen = new Set([...runs.map((run) => run.id), ...calls.map((call) => call.id)]);
    set({ runs, calls });
  },
}));

const lookAll = () => { void usePendingRuns.getState().refresh(); void useRmfgOrders.getState().refresh(); };

/** Starts the shared polling once (paused while the tab is hidden): the waiting runs and calls, and RMFG's open orders. */
export function watchPendingRuns(): void {
  if (timer !== undefined) return;
  const tick = () => { if (document.visibilityState === 'visible') lookAll(); };
  tick();
  timer = window.setInterval(tick, EVERY);
  document.addEventListener('visibilitychange', tick);
}

/** Looks again shortly: something may have just asked for a confirmation, or made an RMFG quote or cart. */
export function checkPendingSoon(): void {
  window.setTimeout(lookAll, SOON);
}

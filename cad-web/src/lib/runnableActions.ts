/**
 * The connector actions this person may run (lib/actions.ts), kept for the top bar's quick button: looked up when
 * first needed and again when the window comes back, at most once a minute. Errors leave the list as it was.
 */
import { create } from 'zustand';
import { Actions, type RunnableAction } from '@/lib/actions';

interface Runnable { actions: RunnableAction[]; loaded: boolean; refresh: () => Promise<void> }

let last = 0;
let watching = false;

export const useRunnableActions = create<Runnable>((set) => ({
  actions: [],
  loaded: false,
  refresh: async () => {
    if (Date.now() - last < 60_000) return;
    last = Date.now();
    try { set({ actions: await Actions.runnable(), loaded: true }); } catch { /* Not signed in, or connectors unavailable. */ }
  },
}));

/** Starts keeping the list (once): now, and when the window regains focus. */
export function watchRunnableActions(): void {
  if (watching) return;
  watching = true;
  void useRunnableActions.getState().refresh();
  window.addEventListener('focus', () => void useRunnableActions.getState().refresh());
}

/** Looks again now (after a grant changed in Settings). */
export function refreshRunnableActions(): void {
  last = 0;
  void useRunnableActions.getState().refresh();
}

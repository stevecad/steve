import { create } from 'zustand';
import { get, set, type DialogId } from '@/state/store';

const HOME = '/docs/local/start/';
export const useHelp = create<{ urls: string[]; index: number; returnTo: DialogId }>(() => ({ urls: [HOME], index: 0, returnTo: null }));

export function showHelp(url = HOME) {
  const parsed = new URL(url, window.location.origin);
  if (parsed.origin !== window.location.origin || !/^\/docs\/(?:[a-z0-9-]+\/)*$/.test(parsed.pathname) || parsed.search) throw new Error('Invalid local help address.');
  const target = parsed.pathname + parsed.hash;
  const state = useHelp.getState();
  const current = get().dialog;
  if (current !== 'help') useHelp.setState({ urls: [target], index: 0, returnTo: current });
  else if (state.urls[state.index] !== target) useHelp.setState({ urls: [...state.urls.slice(0, state.index + 1), target], index: state.index + 1 });
  set({ dialog: 'help' });
}

export function closeHelp() {
  if (get().dialog === 'help') set({ dialog: useHelp.getState().returnTo });
}

export function moveHelp(direction: number) {
  const state = useHelp.getState();
  useHelp.setState({ index: Math.max(0, Math.min(state.urls.length - 1, state.index + direction)) });
}

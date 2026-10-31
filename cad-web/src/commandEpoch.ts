/**
 * Command availability that depends on state outside the app store (a workspace's own store: Manufacture's setups and
 * selection) bumps this, so the ribbon and menus check `enabled` again. Its own module: workspace stores import it
 * without importing the command registry (which imports them).
 */
import { create } from 'zustand';

export const useCommandEpoch = create<{ n: number }>(() => ({ n: 0 }));
export const touchCommands = () => useCommandEpoch.setState((state) => ({ n: state.n + 1 }));

/**
 * The Browser and the Dock stay open or closed, and as wide, as the person last left them: across reloads, other
 * designs and tabs, new designs and workspaces. Kept in this browser for the account (accountKey). Phones and narrow
 * windows are left out: the panels are drawers there and open only when asked (layout.ts, phone/state.ts).
 */
import { get, set, useApp, type AppState } from './store';
import { accountKey } from './accountStorage';
import { narrow } from './layout';

const KEY = 'steve.panels';

export type PanelPreference = Pick<AppState, 'browserOpen' | 'browserWidth' | 'dockOpen' | 'dockWidth'>;

export function readPanels(): Partial<PanelPreference> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey(KEY)) || 'null') as Partial<PanelPreference> | null;
    if (!saved || typeof saved !== 'object') return null;
    const patch: Partial<PanelPreference> = {};
    if (typeof saved.browserOpen === 'boolean') patch.browserOpen = saved.browserOpen;
    if (typeof saved.dockOpen === 'boolean') patch.dockOpen = saved.dockOpen;
    if (typeof saved.browserWidth === 'number' && saved.browserWidth > 0) patch.browserWidth = saved.browserWidth;
    if (typeof saved.dockWidth === 'number' && saved.dockWidth > 0) patch.dockWidth = saved.dockWidth;
    return Object.keys(patch).length ? patch : null;
  } catch { return null; }
}

function savePanels(state: AppState, previous: Partial<PanelPreference> | null) {
  // A tool's options open the Dock for as long as it's open (shell/toolDock.ts): that isn't the person's choice.
  const dockOpen = state.dockTab === 'tool' ? previous?.dockOpen ?? state.dockOpen : state.dockOpen;
  const next: PanelPreference = { browserOpen: state.browserOpen, browserWidth: state.browserWidth, dockOpen, dockWidth: state.dockWidth };
  try { localStorage.setItem(accountKey(KEY), JSON.stringify(next)); } catch { /* Storage is optional. */ }
}

/** At start-up: the panels as the person left them; with nothing saved, a window under 1100 px starts with the Browser
 * hidden (and under 900 px, the Dock too). */
export function restorePanelPreference() {
  const saved = narrow() ? null : readPanels();
  if (saved) set(saved);
  else if (window.innerWidth < 1100) set({ browserOpen: false, dockOpen: window.innerWidth >= 900 });
}

let remembering = false;

/** Saves the panels whenever they change (not mid-drag, nor on a phone or narrow window). */
export function rememberPanels() {
  if (remembering) return;
  remembering = true;
  const key = (state: AppState) => [state.browserOpen, state.browserWidth, state.dockTab === 'tool' ? '' : state.dockOpen, state.dockWidth].join('|');
  let last = key(get());
  useApp.subscribe((state) => {
    if (state.resizing || narrow()) return;
    const next = key(state);
    if (next === last) return;
    last = next;
    savePanels(state, readPanels());
  });
}

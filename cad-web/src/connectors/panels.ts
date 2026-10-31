/**
 * Connector panels (app/connector_panels.py): a connector's own page shown as a tab in the left pane, the right pane or
 * both (PanelFrame.tsx). The list is looked up at start, when the window comes back and every minute, with the request
 * an AI agent made to turn automatic mode on (AutomaticPrompt.tsx asks the person about it once).
 */
import { create } from 'zustand';
import { Actions, type ConnectorPanel } from '@/lib/actions';

interface Panels {
  panels: ConnectorPanel[];
  automatic: boolean;
  request: { at: string; by: string; wanted: string } | null;
  refresh: () => Promise<void>;
}

export const usePanels = create<Panels>((set) => ({
  panels: [],
  automatic: false,
  request: null,
  refresh: async () => {
    try { set(await Actions.panels()); } catch { /* Not signed in, or connectors unavailable: keep what we have. */ }
  },
}));

/** A pane tab's id for a panel (DockTab / leftTab). */
export const panelTab = (id: string) => `panel:${id}` as const;
export const panelOfTab = (tab: string) => (tab.startsWith('panel:') ? tab.slice('panel:'.length) : null);

let watching = false;

/** Keeps the list (once): now, when the window comes back, and every minute while it's visible. */
export function watchPanels(): void {
  if (watching) return;
  watching = true;
  const refresh = () => void usePanels.getState().refresh();
  refresh();
  window.addEventListener('focus', refresh);
  window.setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60_000);
}

export function refreshPanels(): void {
  void usePanels.getState().refresh();
}

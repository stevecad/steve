/**
 * The phone shell's own state: which of its sheets is up. The panel sheets (the browser and the inspector's tabs) use
 * the app's browserOpen / dockOpen instead, so every command that opens a panel opens its sheet on a phone too.
 * One sheet at a time: opening any closes the rest.
 */
import { create } from 'zustand';
import { get, set as setApp, useApp } from '@/state/store';
import { isPhone } from './detect';

export type PhoneSheet = 'tools' | 'view' | 'document' | 'more' | 'workspace';

export const usePhoneUi = create<{ sheet: PhoneSheet | null; search: boolean }>(() => ({ sheet: null, search: false }));

export function openSheet(sheet: PhoneSheet | null, search = false) {
  if (sheet) closePanels();
  usePhoneUi.setState({ sheet, search });
}

export const closeSheet = () => usePhoneUi.setState({ sheet: null, search: false });

export function closePanels() {
  const state = get();
  if (state.browserOpen || state.dockOpen) setApp({ browserOpen: false, dockOpen: false });
}

/** A panel opening (from a command, a tool, a tree row) takes over from whatever sheet was up, and from the other panel. */
export function installSheetFollow(): () => void {
  if (!isPhone()) return () => {};
  return useApp.subscribe((state, before) => {
    if (state.dockOpen && !before.dockOpen) {
      usePhoneUi.setState({ sheet: null });
      if (state.browserOpen) setApp({ browserOpen: false });
    } else if (state.browserOpen && !before.browserOpen) {
      usePhoneUi.setState({ sheet: null });
      if (state.dockOpen) setApp({ dockOpen: false });
    }
  });
}

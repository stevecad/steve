/**
 * The Parts tab in the right dock (palette/PartsPanel.tsx): which list it shows (the parts library or JLCPCB's in-stock
 * parts) and a request to focus its search. Place (Shift+A), Find JLCPCB part and an empty board's "Place a part" all
 * open it.
 */
import { create } from 'zustand';
import { set } from '@/state/store';

export type PartsList = 'library' | 'jlcpcb';

export const usePartsTab = create<{ list: PartsList; focus: number; query: string }>(() => ({ list: 'library', focus: 0, query: '' }));

/** Opens the Parts tab (on `list`, else the one shown last) with its search focused. */
export function openParts(list?: PartsList) {
  usePartsTab.setState((state) => ({ list: list ?? state.list, focus: state.focus + 1 }));
  set({ dockOpen: true, dockTab: 'parts' });
}

export const setPartsList = (list: PartsList) => usePartsTab.setState({ list });

/** The library had no match: the same words, searched among JLCPCB's real parts. */
export const searchJlcpcb = (query: string) => usePartsTab.setState((state) => ({ list: 'jlcpcb', query, focus: state.focus + 1 }));

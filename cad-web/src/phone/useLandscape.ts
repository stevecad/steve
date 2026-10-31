import { useSyncExternalStore } from 'react';

const query = () => window.matchMedia('(orientation: landscape)');
const subscribe = (callback: () => void) => { const media = query(); media.addEventListener('change', callback); return () => media.removeEventListener('change', callback); };

/** The phone is on its side: the shell lays out in columns and sheets come from the right. */
export const useLandscape = () => useSyncExternalStore(subscribe, () => query().matches, () => false);

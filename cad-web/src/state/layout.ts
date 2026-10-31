/**
 * Phone-width screens: the browser and the inspector are drawers over the canvas there (App.module.css), so the app
 * opens one only when asked, and closes the browser once something in it is chosen, keeping the model in view.
 */
import type { AppState } from './store';
import { isPhone } from '@/phone/detect';

export const narrow = () => isPhone() || (typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 900px)').matches);

/** The inspector's tab for a new workspace: the Dock stays open or closed as the person left it (panels.ts). */
export const autoInspect = (): Partial<AppState> => (narrow() ? {} : { dockTab: 'properties' });

/** Something chosen whose setup is in the inspector (a study): it opens, though not over the canvas on a phone. */
export const inspect = (): Partial<AppState> => (narrow() ? {} : { dockOpen: true, dockTab: 'properties' });

/** Something chosen in the browser: on a phone its drawer closes so the canvas shows. */
export const chosen = (): Partial<AppState> => (narrow() ? { browserOpen: false } : {});

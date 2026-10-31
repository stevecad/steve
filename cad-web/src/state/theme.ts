/**
 * The colour theme, chosen in the account menu: light, dark, or the system's (`prefers-color-scheme`, followed live).
 * It belongs to this browser (it's applied before the app renders, so a page never flashes the wrong one).
 */
import { create } from 'zustand';
import { set } from './store';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'steve-theme';
const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

export function themeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch { /* Optional. */ }
  return 'dark';
}

const resolve = (choice: ThemeChoice): 'light' | 'dark' => (choice === 'system' ? (media()?.matches ? 'light' : 'dark') : choice);

function apply(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  set({ theme });
}

/** The choice, for menus that show it (the app state's `theme` is what it resolves to). */
export const useThemeChoice = create<{ choice: ThemeChoice }>(() => ({ choice: themeChoice() }));

/** Chooses the theme (and remembers it in this browser). */
export function setThemeChoice(choice: ThemeChoice) {
  try { localStorage.setItem(KEY, choice); } catch { /* Optional. */ }
  useThemeChoice.setState({ choice });
  apply(resolve(choice));
}

/** Before rendering: the remembered theme, without a store (main.tsx). */
export function applyThemeEarly() {
  document.documentElement.dataset.theme = resolve(themeChoice());
}

/** At start: applies the choice and follows the system while the choice is "system". */
export function installTheme() {
  apply(resolve(themeChoice()));
  media()?.addEventListener('change', () => { if (themeChoice() === 'system') apply(resolve('system')); });
}

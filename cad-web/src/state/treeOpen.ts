import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useAccount } from '@/auth/auth';
import { accountKey } from './accountStorage';
import { get, useApp } from './store';

/**
 * Which browser groups (Bodies, Studies, a component…) the person opened or closed, per saved document, so they stay
 * that way when the browser is drawn again: another workspace or left-panel tab, the panel hidden, another document
 * tab, a reload. Kept in this browser only (accountKey), for the most recent documents.
 */
type Remembered = Record<string, Record<string, boolean>>;

const STORAGE_KEY = 'steve-tree-open';
const DOCUMENTS = 50;

const read = (): Remembered => {
  try { return JSON.parse(localStorage.getItem(accountKey(STORAGE_KEY)) || '{}') as Remembered; } catch { return {}; }
};

const useTreeOpen = create<{ open: Remembered }>(() => ({ open: read() }));
// Each account has its own (the account is known once signed in).
useAccount.subscribe(() => useTreeOpen.setState({ open: read() }));

function rememberIn(scope: string, key: string, open: boolean) {
  const { [scope]: entries, ...others } = useTreeOpen.getState().open;
  // The document last touched goes last, so the oldest are the ones dropped.
  const kept = Object.entries(others).slice(-(DOCUMENTS - 1));
  const next: Remembered = { ...Object.fromEntries(kept), [scope]: { ...entries, [key]: open } };
  useTreeOpen.setState({ open: next });
  try { localStorage.setItem(accountKey(STORAGE_KEY), JSON.stringify(next)); } catch { /* Optional. */ }
}

/** The open saved document's remembered rows: `isOpen(key, fallback)`, and `setOpen` (a no-op for an unsaved one). */
export function useTreeMemory() {
  const scope = useApp((state) => state.doc.saved?.id ?? null);
  const entries = useTreeOpen((state) => (scope ? state.open[scope] : undefined));
  return {
    isOpen: (key: string, fallback: boolean) => entries?.[key] ?? fallback,
    setOpen: (key: string, open: boolean) => { if (scope) rememberIn(scope, key, open); },
  };
}

/** The same, outside React (a command): the open saved document's remembered row, and setting it. */
export function isRemembered(key: string, fallback: boolean) {
  const scope = get().doc.saved?.id;
  return (scope ? useTreeOpen.getState().open[scope]?.[key] : undefined) ?? fallback;
}
export function remember(key: string, open: boolean) {
  const scope = get().doc.saved?.id;
  if (scope) rememberIn(scope, key, open);
}

/** Rows a reveal ("Show in tree") is unfolding: they open as they're drawn, remembered or not (an unsaved document). */
const useUnfolding = create<{ keys: string[] }>(() => ({ keys: [] }));

/** Opens these groups and remembers them open; `done()` once the reveal has settled, so a later redraw keeps a close. */
export function unfold(keys: string[]) {
  for (const key of keys) remember(key, true);
  useUnfolding.setState({ keys });
  return () => useUnfolding.setState({ keys: [] });
}

/**
 * Runs `effect` when `value` changes after the row was first drawn, not when it's drawn again with the same value, so
 * an auto-open (the active study or component) doesn't undo a remembered close on every workspace switch or reload.
 */
export function useOnChange<T>(value: T, effect: (value: T, before: T) => void) {
  const previous = useRef(value);
  useEffect(() => {
    const before = previous.current;
    if (Object.is(before, value)) return;
    previous.current = value;
    effect(value, before);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A group's open state, remembered under `key` for the open saved document; without a key (or a saved document) it
 * lasts as long as the row is drawn, as before.
 */
export function useGroupOpen(key: string | undefined, fallback: boolean): [boolean, (open: boolean) => void] {
  const memory = useTreeMemory();
  const [local, setLocal] = useState(fallback);
  const open = key ? memory.isOpen(key, local) : local;
  const setOpen = (value: boolean) => {
    setLocal(value);
    if (key) memory.setOpen(key, value);
  };
  const unfolding = useUnfolding((state) => !!key && state.keys.includes(key));
  useEffect(() => { if (unfolding) setLocal(true); }, [unfolding]);
  return [open, setOpen];
}

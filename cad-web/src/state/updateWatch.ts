/**
 * A tab keeps running the app it loaded; after a deploy it doesn't know a newer one is out. This compares the deployed
 * version (STEVE_VERSION, served with GET /v1/feedback/config) with the one the tab started on, and offers a reload
 * once per new version, with a link to "What's new". Checks when the window comes back into focus and every 5 min while it's visible. Off when the
 * server doesn't know its version (dev, a manual deploy).
 */
import { api } from '@/lib/api';
import { openWhatsNew } from '@/lib/docs';
import { get, toast } from './store';
import { saveDraft } from './actions';
import { rememberView, saveView } from './reloadView';

let loaded = '';
let checking = false;
const notified = new Set<string>();

export async function checkForUpdate() {
  if (checking) return;
  checking = true;
  let version: string;
  try {
    version = (await api<{ version?: string }>('/v1/feedback/config')).version?.trim() || '';
  } catch {
    return;
  } finally {
    checking = false;
  }
  if (!version) return;
  if (!loaded) { loaded = version; return; }
  if (version === loaded || notified.has(version)) return;
  notified.add(version);
  toast('info', 'STEVE Studio has been updated', 'Reload to get the latest version. Unsaved edits are kept.',
    { sticky: true, action: { label: 'Reload', run: () => reload(version) }, link: { label: "What's new", run: openWhatsNew } });
}

function reload(version: string) {
  if (get().busy) {
    notified.delete(version);  // Offered again at the next check.
    toast('info', 'Still working', 'Reload once the current task finishes.');
    return;
  }
  saveDraft();
  saveView();
  location.reload();
}

/*
 * A deploy removes the previous build's code-split chunks (their names are content hashes), so a tab still running the
 * old build fails to load any part it hasn't loaded yet ("Failed to fetch dynamically imported module"). Reload once to
 * pick up the new build; a second failure within a minute is a real outage and is reported instead of looping.
 */
const STALE_KEY = 'steve.staleChunkReload';
let reloading = false;
let draftRestored = false;

/** Boot has restored the last session's draft, so saving the draft before a reload can't discard it. */
export function markDraftRestored() { draftRestored = true; rememberView(); }

export function isStaleChunk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(message);
}

/** Reloads to get the deployed build after a missing chunk. False when it can't (just tried, or a task is running). */
export function reloadForStaleChunk(): boolean {
  if (reloading) return true;
  try {
    if (Date.now() - Number(sessionStorage.getItem(STALE_KEY) || 0) < 60_000) return false;
    sessionStorage.setItem(STALE_KEY, String(Date.now()));
  } catch { return false; }
  if (draftRestored && get().busy) {
    toast('info', 'STEVE Studio has been updated', 'Reload to get the latest version. Unsaved edits are kept.',
      { sticky: true, action: { label: 'Reload', run: () => reload('') } });
    return true;
  }
  reloading = true;
  if (draftRestored) { saveDraft(); saveView(); }
  location.reload();
  return true;
}

/** A reload the person asked for (after a missing chunk): keeps unsaved edits and waits for a running task. */
export function reloadApp() {
  if (draftRestored) reload('');
  else location.reload();
}

export function installUpdateWatch(): () => void {
  void checkForUpdate();  // The version this tab started on.
  const onFocus = () => { if (document.visibilityState === 'visible') void checkForUpdate(); };
  const onPreloadError = () => { reloadForStaleChunk(); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('vite:preloadError', onPreloadError);
  const timer = window.setInterval(onFocus, 5 * 60_000);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.clearInterval(timer);
  };
}

/**
 * Linked documents move on while a design is open (someone saves the part in another tab, or
 * STEVE does). The design keeps its pinned revisions; this notices newer ones so the Links group
 * shows the update and a notice offers it. Checks when the window comes back into focus, when the
 * design's tab becomes active, and every 30 s while it stays open.
 */
import { Api } from '@/lib/api';
import { Branches } from '@/lib/branches';
import { get, patchDoc, toast, useApp } from './store';
import { saveDraft, updateModel } from './actions';
import { hasLinks } from './design';

const notified = new Set<string>();
let checking = false;

/** Links whose document has a newer revision than the design pins. */
export function behindLinks(): { alias: string; name: string; revision: number; latest: number }[] {
  const { doc } = get();
  const status = doc.saved?.link_status ?? {};
  return Object.entries(doc.links).flatMap(([alias, link]) => {
    const latest = status[alias]?.latest;
    return latest && link.revision && latest > link.revision ? [{ alias, name: status[alias]?.name ?? alias, revision: link.revision, latest }] : [];
  });
}

export async function refreshLinks(notify = true) {
  const { doc } = get();
  if (checking || !doc.open || !hasLinks(doc.kind) || !doc.saved || !Object.keys(doc.links).length) return;
  const id = doc.saved.id;
  const branch = doc.branch;
  checking = true;
  let status;
  try {
    status = (branch === 'main' ? await Api.document(id) : await Branches.read(id, branch)).link_status;
  } catch {
    return;
  } finally {
    checking = false;
  }
  const now = get().doc;
  if (now.saved?.id !== id || now.branch !== branch || !status) return;
  patchDoc({ saved: { ...now.saved, link_status: status } });
  if (!notify) return;
  const fresh = behindLinks().filter((item) => !notified.has(`${id}:${item.alias}:${item.latest}`));
  if (!fresh.length) return;
  for (const item of fresh) notified.add(`${id}:${item.alias}:${item.latest}`);
  const one = fresh.length === 1 ? fresh[0] : null;
  const kind = get().doc.kind;
  const noun = kind === 'shop' || kind === 'part' ? kind : 'design';
  toast('info', one ? `${one.name} has a new revision` : `${fresh.length} linked documents have new revisions`,
    one ? `This ${noun} uses revision ${one.revision}; ${one.latest} is the latest. It stays as it is until you update.` : `This ${noun} keeps its pinned revisions until you update them.`,
    { action: { label: fresh.length === 1 ? 'Update' : 'Update all', run: () => { void updateLinks(fresh.map((item) => item.alias)); } } });
}

/** Moves links to their latest revisions (all that are behind, or the given ones) and regenerates. */
export async function updateLinks(aliases?: string[]) {
  const behind = behindLinks().filter((item) => !aliases || aliases.includes(item.alias));
  if (!behind.length) { toast('success', 'Links are up to date'); return; }
  const { doc } = get();
  const links = { ...doc.links };
  for (const item of behind) links[item.alias] = { ...links[item.alias], revision: item.latest };
  patchDoc({ links });
  saveDraft();
  await updateModel();
  toast('success', behind.length === 1 ? `${behind[0].name} updated to revision ${behind[0].latest}` : `${behind.length} links updated`, 'Save to keep the new revisions.');
}

export function installLinkWatch(): () => void {
  const onFocus = () => { if (document.visibilityState === 'visible') void refreshLinks(); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshLinks(); }, 30_000);
  // A design tab becoming active (or a save elsewhere in this window that changes revisions).
  const stop = useApp.subscribe((state) => `${state.activeTab}|${state.doc.saved?.id}`, () => { void refreshLinks(); });
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.clearInterval(timer);
    stop();
  };
}

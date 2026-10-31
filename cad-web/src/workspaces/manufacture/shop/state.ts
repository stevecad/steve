/**
 * The workspace's shop in Manufacture (docs/site manufacture/shop.md): its document, the build of its saved revision
 * (the records the page shows) and Steve's catalogue. Every change goes through the shop's code: the edit applies to
 * the latest saved revision, the new source builds, the document saves (the build attached) and the saved revision is
 * applied to the library (POST /v1/documents/{id}/shop/apply), the same path as saving a shop in the code editor.
 * A source that doesn't build is never saved. Nothing here writes library records directly.
 */
import { create } from 'zustand';
import { Api, ApiError, api, json, shopMetadata, type Build, type CadDocument, type DocumentSummary } from '@/lib/api';
import { toast } from '@/state/store';
import { MAIN, PARAMS, SHOP_FILES } from '@/state/design';
import { catalogue as fetchCatalogue, mfg, type Catalogue } from '../api';
import { loadLibrary } from '../state';
import type { ShopItem, ShopSource } from './shopCode';

interface ShopState {
  /** The workspace's shops (null until listed) and the one shown. */
  shops: DocumentSummary[] | null;
  doc: CadDocument | null;
  /** The build of the shown revision: its records are what the page shows. */
  build: Build | null;
  /** Why the shown revision doesn't build, when it doesn't. */
  error: string | null;
  /** What's happening now (Saving, Building, …), or null. */
  busy: string | null;
  catalogue: Catalogue | null;
  /** Dialects Steve posts and checks (the server's output interpreters). */
  executable: string[];
  /** Which shop holds each library record (its id → the shop document and the item's key). */
  holders: Record<string, ShopHolder>;
  /** An item to show in the Code tab (Edit in your shop): its file and line. */
  focus: { file: string; line: number } | null;
}

export interface ShopHolder { document_id: string; document_name: string | null; key: string; library_id: string }

export const useShop = create<ShopState>(() => ({ shops: null, doc: null, build: null, error: null, busy: null, catalogue: null, executable: [], holders: {}, focus: null }));
const set = useShop.setState;
const get = useShop.getState;

const CHOSEN = 'steve.manufacture.shop';
const remember = (id: string) => { try { localStorage.setItem(CHOSEN, id); } catch { /* Optional. */ } };
const remembered = () => { try { return localStorage.getItem(CHOSEN); } catch { return null; } };

export const shopRecords = (build: Build | null): ShopItem[] => (shopMetadata(build)?.records ?? []) as ShopItem[];
export const sourceOf = (doc: CadDocument): ShopSource => ({ code: doc.code, files: { ...(doc.files ?? {}) }, links: { ...(doc.links ?? {}) } });
const lastLine = (text: string | null | undefined) => (text ?? '').trim().split('\n').filter(Boolean).pop() ?? 'The shop doesn’t build.';
const sorted = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Whether a build ran exactly this source. */
function builtFrom(build: Build, source: ShopSource): boolean {
  const links = (value: Record<string, { document_id: string; revision: number | null }>) => sorted(Object.fromEntries(Object.entries(value).map(([alias, pin]) => [alias, [pin.document_id, pin.revision]])));
  return build.kind === 'shop' && build.code === source.code && sorted(build.files ?? {}) === sorted(source.files) && links(build.links ?? {}) === links(source.links);
}

/** Builds a shop's source (a cache hit when it was built before) and waits for the result. */
async function buildSource(name: string, source: ShopSource): Promise<Build> {
  let build = await Api.submit({ kind: 'shop', name, ...source, mode: 'full' });
  while (build.status !== 'succeeded' && build.status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 700));
    build = await Api.build(build.id);
  }
  // A cache hit answers without the records' source: read it whole.
  if (build.metadata === undefined || build.code === undefined) build = await Api.build(build.id);
  return build;
}

/** Lists the workspace's shops and shows one: `prefer`, the one shown last, or the latest changed. */
export async function loadShop(prefer?: string) {
  try {
    const { documents } = await Api.documents({ kind: 'shop', limit: 100 });
    const shops = documents.filter((doc) => doc.kind === 'shop').sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    set({ shops });
    const id = [prefer, get().doc?.id, remembered()].find((candidate) => candidate && shops.some((doc) => doc.id === candidate)) ?? shops[0]?.id;
    if (id) await showShop(id);
    else set({ doc: null, build: null, error: null });
  } catch (error) {
    set({ shops: get().shops ?? [] });
    toast('danger', 'Couldn’t read your shop', (error as Error).message);
  }
}

/** Shows one shop: its saved revision and that revision's build (built now when it hasn't been). */
export async function showShop(id: string) {
  remember(id);
  set({ busy: 'Reading the shop' });
  try {
    const doc = await Api.document(id);
    set({ doc, error: null });
    const source = sourceOf(doc);
    let build: Build | null = doc.preview_build_id ? await Api.build(doc.preview_build_id).catch(() => null) : null;
    if (!build || build.status !== 'succeeded' || !builtFrom(build, source)) build = await buildSource(doc.name, source);
    if (get().doc?.id !== id) return;
    set({ build, error: build.status === 'failed' ? lastLine(build.error) : null });
  } catch (error) {
    toast('danger', 'Couldn’t read your shop', (error as Error).message);
  } finally { set({ busy: null }); }
}

/** A new shop document for the workspace (main.py and params.py, as File → New shop starts one). */
export async function createShop() {
  set({ busy: 'Creating your shop' });
  try {
    const doc = await Api.createDocument({ name: 'Shop', kind: 'shop', code: SHOP_FILES[MAIN], files: { [PARAMS]: SHOP_FILES[PARAMS] }, links: {}, preview_build_id: null });
    set({ busy: null });
    await loadShop(doc.id);
  } catch (error) {
    set({ busy: null });
    toast('danger', 'Couldn’t create your shop', (error as Error).message);
  }
}

/** Steve's catalogue and the dialects Steve posts, once per session. */
export async function loadCatalogue(force = false) {
  if (get().catalogue && !force) return;
  const [listing, capabilities] = await Promise.all([
    fetchCatalogue().catch((error) => { toast('danger', 'Couldn’t read Steve’s catalogue', (error as Error).message); return null; }),
    mfg<{ operations?: { output_interpreters?: string[] }[] }>('/capabilities').catch(() => null),
  ]);
  const executable = [...new Set((capabilities?.operations ?? []).flatMap((operation) => operation.output_interpreters ?? []))];
  // The catalogue says which of its dialects are executable too (the same registry).
  for (const item of listing?.items ?? []) if (item.status === 'executable' && item.dialect && !executable.includes(item.dialect)) executable.push(item.dialect);
  set({ catalogue: listing, executable });
}

/**
 * Changes the shown shop through its code: `edit` gets the latest saved source and returns the new one (or why it
 * can't, shown as is). The new source builds first; only a source that builds is saved, as a new revision with its
 * build, and then applied to the library. Returns whether it saved.
 */
export async function changeShop(what: string, edit: (source: ShopSource, records: ShopItem[]) => ShopSource | string): Promise<boolean> {
  const shown = get().doc;
  if (!shown) { toast('info', what, 'Your shop isn’t open yet: wait a moment and try again.'); return false; }
  if (get().busy) { toast('info', what, `Wait until the shop has finished: ${get().busy}.`); return false; }
  set({ busy: 'Saving' });
  try {
    const latest = await Api.document(shown.id);
    // The items of the revision shown (their keys and source lines); the edit itself applies to the latest source.
    const next = edit(sourceOf(latest), shopRecords(get().build));
    if (typeof next === 'string') { toast('info', what, next); return false; }
    set({ busy: 'Building' });
    const build = await buildSource(latest.name, next);
    if (build.status !== 'succeeded') {
      toast('danger', `${what}: not saved`, `The shop wouldn’t build with this change: ${lastLine(build.error)}`);
      return false;
    }
    set({ busy: 'Saving' });
    let saved: CadDocument;
    try {
      saved = await Api.updateDocument(latest.id, { name: latest.name, kind: 'shop', ...next, preview_build_id: build.id, revision: latest.revision });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast('warning', `${what}: not saved`, 'The shop was saved somewhere else at the same moment. It’s reloaded: try again.');
        void showShop(latest.id);
        return false;
      }
      throw error;
    }
    set({ doc: saved, build, error: null, busy: 'Updating the library' });
    try {
      const result = await Api.applyShop(saved.id, { revision: saved.revision });
      const { created, revised } = result.counts;
      toast('success', what, [created && `${created} created`, revised && `${revised} revised`].filter(Boolean).join(', ') || 'Saved. The library was already up to date.');
    } catch (error) {
      toast('danger', `${what}: saved, but the library refused it`, (error as Error).message);
    }
    void loadLibrary();
    void loadHolders();
    return true;
  } catch (error) {
    toast('danger', `${what}: not saved`, (error as Error).message);
    return false;
  } finally { set({ busy: null }); }
}

/** Which shop holds each library record (GET /v1/manufacturing/shop-items). */
export async function loadHolders() {
  try {
    const { items } = await mfg<{ items: ShopHolder[] }>('/shop-items');
    set({ holders: Object.fromEntries(items.map((item) => [item.library_id, item])) });
  } catch { /* The records show without their shop; adding one says why it can't. */ }
}

/**
 * Edit in your shop: the shop that holds the record, on its Code tab at the item's file and line (from the shop's
 * build). Returns false when the shop doesn't list the item (not built since).
 */
export async function focusItem(holder: ShopHolder): Promise<boolean> {
  if (get().doc?.id !== holder.document_id) await showShop(holder.document_id);
  const item = shopRecords(get().build).find((record) => record.key === holder.key);
  set({ focus: item ? { file: item.file, line: item.line } : { file: 'main.py', line: 1 } });
  return !!item;
}

/**
 * Add to your shop: library records no shop holds yet written into the shown shop (a new one when there is none) as
 * code (POST /v1/documents/{id}/shop/adopt, with what they pin), then built and applied: the records stay the same
 * records, and from then on they change in the shop. Returns whether they were added.
 */
export async function addToShop(ids: string[], what: string): Promise<boolean> {
  if (!get().doc) { await loadShop(); if (!get().doc) await createShop(); }
  const shown = get().doc;
  if (!shown || get().busy) return false;
  set({ busy: 'Adding to your shop' });
  try {
    const latest = await Api.document(shown.id);
    const result = await api<{ document: CadDocument; adopted: { key: string; library_id: string }[] }>(`/v1/documents/${shown.id}/shop/adopt`, json('POST', { revision: latest.revision, record_ids: ids }));
    const saved = result.document;
    set({ doc: saved, busy: 'Building' });
    const build = await buildSource(saved.name, sourceOf(saved));
    set({ build, error: build.status === 'failed' ? lastLine(build.error) : null });
    if (build.status !== 'succeeded') { toast('danger', `${what}: added, but the shop doesn’t build`, lastLine(build.error)); return false; }
    set({ busy: 'Updating the library' });
    const applied = await Api.applyShop(saved.id, { revision: saved.revision });
    const { created, revised } = applied.counts;
    toast('success', `${what} is in your shop`, `${result.adopted.length} ${result.adopted.length === 1 ? 'item' : 'items'} written as code in ${saved.name}`
      + (created || revised ? ` (${[created && `${created} created`, revised && `${revised} revised`].filter(Boolean).join(', ')})` : '.'));
    void loadLibrary();
    await loadHolders();
    return true;
  } catch (error) {
    toast('danger', `${what}: not added`, (error as Error).message);
    return false;
  } finally { set({ busy: null }); }
}

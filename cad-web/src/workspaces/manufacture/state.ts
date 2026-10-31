/**
 * Manufacture workspace state (CAM): the library and the open document's CNC programs. Server records are
 * authoritative. 3D-print (FFF) programs stay in the backend but aren't part of this workspace: designs export
 * 3MF/STL for the person's own slicer (web/src/state/meshExport.ts).
 */
import { create } from 'zustand';
import { get as app, set as setApp, toast } from '@/state/store';
import { library, MfgError, programs, type Kind, type LibraryRecord, type Program, type ProgramRecord } from './api';

interface State {
  records: LibraryRecord[];
  recordsLoaded: boolean;
  /** A kind of record, all of them, or a page: the shop (as code) or Steve's catalogue. */
  libraryKind: LibraryView;
  librarySelect: string | null;
  programs: ProgramRecord[];
  programsLoaded: boolean;
  activeProgram: string | null;
}

export type LibraryView = Kind | 'all' | 'shop' | 'catalogue';

export const useMfg = create<State>(() => ({
  records: [], recordsLoaded: false, libraryKind: 'all', librarySelect: null,
  programs: [], programsLoaded: false, activeProgram: null,
}));
const set = useMfg.setState;

/** A failure's first field problems ("setups: List should have at least 1 item…"): paths and messages, never values. */
const problems = (error: MfgError) => error.fields.filter((item) => item.message && item.message !== error.message).slice(0, 2)
  .map((item) => `${item.path.replace(/^body\.?/, '') || 'request'}: ${item.message.replace(/\.$/, '')}`).join('; ');

export function report(error: unknown, title = 'Manufacturing') {
  const fields = error instanceof MfgError ? problems(error) : '';
  const message = error instanceof MfgError
    ? `${error.message}${fields ? ` ${fields}.` : ''}${error.code && error.code !== 'error' ? ` (${error.code})` : ''}`
    : (error as Error).message;
  toast('danger', title, message);
}

/** Whether a current record still pins an older revision of another (links saved before saves carried edits along). */
function staleLinks(records: LibraryRecord[]): boolean {
  const heads = new Map(records.map((record) => [record.id, record.revision]));
  const stale = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(stale);
    if (!value || typeof value !== 'object') return false;
    const pin = value as { id?: unknown; revision?: unknown; kind?: unknown; sha256?: unknown };
    if (typeof pin.id === 'string' && typeof pin.revision === 'number' && typeof pin.sha256 === 'string' && typeof pin.kind === 'string') {
      return pin.revision < (heads.get(pin.id) ?? 0);
    }
    return Object.values(value).some(stale);
  };
  return records.some((record) => !record.archived && (record.kind as string) !== 'library_collection' && stale(record.definition));
}
let repaired = false;

export async function loadLibrary() {
  try {
    const items: LibraryRecord[] = [];
    let after: string | undefined;
    do {
      const page = await library.list({ after, limit: 200 });
      items.push(...page.items);
      after = page.next_after ?? undefined;
    } while (after && items.length < 5000);
    // Archived records still resolve pins in old programs; list them too (shown dimmed).
    const archived = await library.list({ archived: true, limit: 200 }).catch(() => ({ items: [] as LibraryRecord[] }));
    const seen = new Set(items.map((item) => item.id));
    const records = [...items, ...archived.items.filter((item) => !seen.has(item.id))];
    if (!repaired && staleLinks(records)) {
      // Once per session: the server moves them to the latest, then the library reloads.
      repaired = true;
      const { skipped } = await library.followLatest();
      if (skipped.length) toast('warning', 'Some items still use an older version', skipped.map((item) => `${item.name}: ${item.reason}`).join(' · '));
      return loadLibrary();
    }
    set({ records, recordsLoaded: true });
  } catch (error) { report(error, 'Library'); }
}

export function openLibrary(kind: LibraryView = 'all', select: string | null = null) {
  set({ libraryKind: kind, librarySelect: select });
  setApp({ dialog: 'tools' });
  void loadLibrary();
}

// ── Programs for the open document ─────────────────────────────────────────

export const documentId = () => app().doc.saved?.id ?? null;
/** A program's process: its first setup's (a program with no setup yet is a milling program waiting for its first). */
export const programProcess = (program: Program) => String((program.setups[0] as { process?: string } | undefined)?.process ?? (program.setups.length ? 'unknown' : 'milling'));

/**
 * This document's CNC programs: its CAM programs (documents linking it, cam/camDoc.ts) first, then the programs saved
 * before them, newest first (FFF prints are left out of Manufacture; a CAM program's frozen runs aren't programs of
 * their own).
 */
export async function loadPrograms() {
  const id = documentId();
  if (!id) { set({ programs: [], programsLoaded: true }); return; }
  try {
    const { loadCamRecords, isFrozen, takePending } = await import('./cam/camDoc');
    const [all, cam] = await Promise.all([programs.list(), loadCamRecords(id).catch((error) => { report(error, 'Programs'); return [] as ProgramRecord[]; })]);
    if (documentId() !== id) return;
    const mine = all.filter((program) => programProcess(program.compiled) !== 'fff' && !isFrozen(program) && program.compiled.designs.some((design) => design.pin.document_id === id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const list = [...cam, ...mine];
    const pending = takePending(list.map((program) => program.id));
    set({ programs: list, programsLoaded: true, ...(pending ? { activeProgram: pending } : {}) });
  } catch (error) { set({ programsLoaded: true }); report(error, 'Programs'); }
}

/**
 * Manufacture picks named faces and bodies (the part, floors, holes, edges, fixtures): a saved part still shown from its
 * preview build gets its full build (actions.ensureNamedGeometry), once per build.
 */
let preparing: string | null = null;
export function prepareGeometry() {
  const { displayed, doc } = app();
  if (!displayed || displayed.mode === 'full' || !doc.saved || preparing === displayed.id) return;
  preparing = displayed.id;
  void import('@/state/actions').then(({ ensureNamedGeometry }) => ensureNamedGeometry());
}

export function selectProgram(id: string | null) {
  set({ activeProgram: id });
  setApp({ dockOpen: true, dockTab: 'properties' });
}

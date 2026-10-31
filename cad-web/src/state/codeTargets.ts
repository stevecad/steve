/**
 * The code editor follows the workspace (panels/SourcePanel.tsx): Design and Electronics show the open document's own
 * code; Manufacture the active program of the open part (a CAM program's main.py and files, or an older program's
 * manufacturing.py), or the shop's code while its page is up; Simulate the active study's study.py. Each object is
 * saved its own way (a CAM program and the shop are built first; a program and a study with the revision they were
 * edited on), and the person's unsaved edits stay with that object while they switch workspaces, and across a reload of
 * the tab (sessionStorage, per account: each object's edits with the revision they were made on, so a revision saved
 * since shows them as stale rather than being replaced).
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { toast, useApp } from './store';
import { labelOf, storedEdits, type Edits, type TargetKind } from '@/panels/source/codeTarget';
import { useAccount } from '@/auth/auth';
import { accountKey } from './accountStorage';
import { useMfg } from '@/workspaces/manufacture/state';
import { useShop } from '@/workspaces/manufacture/shop/state';
import { useCamDoc } from '@/workspaces/manufacture/cam/camDoc';
import type { ProgramRecord } from '@/workspaces/manufacture/api';

export interface CodeTarget {
  key: string;
  kind: TargetKind;
  /** Whose it is (the open part or design), shown first in the header; null for the shop. */
  owner: string | null;
  label: string;
  files: Record<string, string>;
  main: string;
  revision: number;
  /** The workspace's action: Run program, Build shop, Run study. */
  action: { label: string; id: string; run: (edited: Record<string, string> | null) => Promise<void> };
  save: (files: Record<string, string>) => Promise<boolean>;
  /** A document STEVE edits in place from the editor (Change…, Fix), and how to read back its files once it has; none
   * (a study isn't a document) asks STEVE in the chat instead. */
  steve?: { documentId: string; kind: string; reload: () => Promise<Record<string, string> | null> };
}
/** The workspace has nothing to show yet: what to say, and how to start one. */
export interface EmptyTarget { empty: true; title: string; detail: string; start?: { label: string; id: string; run: () => void } }

export const useCodeEdits = create<{ edits: Record<string, Edits>; active: Record<string, string> }>(() => ({ edits: {}, active: {} }));

/* Unsaved edits survive a reload of this tab: kept in sessionStorage under the signed-in account's key. */
const EDITS_KEY = 'steve.codeEdits';
let restoredFrom: string | null = null;
/** This tab's stored edits, once per account key (edits made since the page loaded win). */
function restoreEdits() {
  const key = accountKey(EDITS_KEY);
  if (restoredFrom === key) return;
  restoredFrom = key;
  let stored: Record<string, Edits> = {};
  try { stored = storedEdits(sessionStorage.getItem(key)); } catch { /* Storage is optional. */ }
  if (Object.keys(stored).length) useCodeEdits.setState((state) => ({ edits: { ...stored, ...state.edits } }));
}
function storeEdits(edits: Record<string, Edits>) {
  try {
    const key = accountKey(EDITS_KEY);
    if (Object.keys(edits).length) sessionStorage.setItem(key, JSON.stringify(edits)); else sessionStorage.removeItem(key);
  } catch { /* Storage is optional (full, or blocked): the edits stay in this page. */ }
}
restoreEdits();
useAccount.subscribe(restoreEdits);
useCodeEdits.subscribe((state, previous) => {
  if (state.edits === previous.edits) return;
  if (restoredFrom !== accountKey(EDITS_KEY)) { restoreEdits(); return; }   // Read this account's first; that change stores.
  storeEdits(state.edits);
});

/** Saved: the edits to that object are done. */
const settle = (key: string) => useCodeEdits.setState((state) => { const edits = { ...state.edits }; delete edits[key]; return { edits }; });

function camTarget(record: ProgramRecord, owner: string | null): CodeTarget | null {
  const id = record.cam!.document_id;
  const doc = useCamDoc.getState().docs[id];
  if (!doc) return null;
  const files = { 'main.py': doc.code, ...(doc.files ?? {}) };
  const save = async (next: Record<string, string>) => {
    const { saveCamFiles } = await import('@/workspaces/manufacture/cam/camDoc');
    const ok = await saveCamFiles(id, next, doc.revision);
    if (ok) settle(`cam:${id}`);
    return ok;
  };
  return {
    key: `cam:${id}`, kind: 'cam', owner, label: labelOf('cam', record.compiled.name), files, main: 'main.py', revision: doc.revision,
    steve: { documentId: id, kind: 'CAM program', reload: async () => {
      const { reloadCam } = await import('@/workspaces/manufacture/cam/camDoc');
      const latest = await reloadCam(id);
      return latest ? { 'main.py': latest.code, ...(latest.files ?? {}) } : null;
    } },
    action: { label: 'Run program', id: 'source-run-program', run: async (edited) => {
      if (edited && !(await save(edited))) return;
      const { runCam } = await import('@/workspaces/manufacture/cam/camDoc');
      void runCam(id);
    } },
    save,
  };
}

function programTarget(record: ProgramRecord, owner: string | null): CodeTarget {
  const key = `program:${record.id}`;
  const save = async (next: Record<string, string>) => {
    const { programs, MfgError } = await import('@/workspaces/manufacture/api');
    try {
      const saved = await programs.edit(record, next['manufacturing.py']);
      useMfg.setState((state) => ({ programs: state.programs.map((item) => (item.id === saved.id ? saved : item)) }));
      settle(key);
      toast('success', 'Code saved', `${saved.compiled.name} · revision ${saved.revision}`);
      return true;
    } catch (error) {
      toast(error instanceof MfgError && error.status === 409 ? 'warning' : 'danger', 'Code not saved', (error as Error).message);
      return false;
    }
  };
  return {
    key, kind: 'program', owner, label: labelOf('program', record.compiled.name), files: { 'manufacturing.py': record.source }, main: 'manufacturing.py', revision: record.revision,
    action: { label: 'Run program', id: 'source-run-program', run: async (edited) => {
      if (edited && !(await save(edited))) return;
      const { runProgram } = await import('@/workspaces/manufacture/cam/state');
      const latest = useMfg.getState().programs.find((item) => item.id === record.id) ?? record;
      void runProgram(latest);
    } },
    save,
  };
}

function shopTarget(): CodeTarget | null {
  const doc = useShop.getState().doc;
  if (!doc) return null;
  const files = { ...(doc.files ?? {}), 'main.py': doc.code };
  const key = `shop:${doc.id}`;
  const save = async (next: Record<string, string>) => {
    const { changeShop } = await import('@/workspaces/manufacture/shop/state');
    const base = JSON.stringify(files);
    const ok = await changeShop('Code saved', (latest) => {
      if (JSON.stringify({ ...latest.files, 'main.py': latest.code }) !== base) return 'The shop was saved meanwhile (by a form, or by STEVE). Copy your edits; the new revision is shown.';
      const { 'main.py': code, ...rest } = next;
      return { ...latest, code: code ?? latest.code, files: rest };
    });
    if (ok) settle(key);
    return ok;
  };
  return {
    key, kind: 'shop', owner: null, label: labelOf('shop', doc.name), files, main: 'main.py', revision: doc.revision,
    steve: { documentId: doc.id, kind: 'shop', reload: async () => {
      // STEVE's generate applied the shop to the library: the forms and programs read the records again.
      const [{ showShop, loadHolders }, { loadLibrary }] = await Promise.all([import('@/workspaces/manufacture/shop/state'), import('@/workspaces/manufacture/state')]);
      await showShop(doc.id);
      void loadLibrary();
      void loadHolders();
      const latest = useShop.getState().doc;
      return latest?.id === doc.id ? { ...(latest.files ?? {}), 'main.py': latest.code } : null;
    } },
    action: { label: 'Build shop', id: 'source-build-shop', run: async (edited) => {
      if (edited) { await save(edited); return; }   // Saving builds it and updates the library.
      const { showShop } = await import('@/workspaces/manufacture/shop/state');
      const { Api } = await import('@/lib/api');
      await showShop(doc.id);
      const built = useShop.getState();
      if (built.error) { toast('danger', 'The shop doesn’t build', built.error); return; }
      try {
        const { counts } = await Api.applyShop(doc.id, { revision: doc.revision });
        toast('success', 'Shop built', [counts.created && `${counts.created} created`, counts.revised && `${counts.revised} revised`].filter(Boolean).join(', ') || 'The library is up to date.');
      } catch (error) { toast('danger', 'Couldn’t update the library', (error as Error).message); }
    } },
    save,
  };
}

function studyTarget(study: { id: string; name: string; source?: string; revision?: number; branch?: string }, owner: string | null): CodeTarget {
  const key = `study:${study.id}`;
  const save = async (next: Record<string, string>) => {
    const [{ simulationApi }, { fromRecord, replaceStudy, report }] = await Promise.all([import('@/workspaces/simulate/api'), import('@/workspaces/simulate/state')]);
    try {
      const record = await simulationApi<Parameters<typeof fromRecord>[0]>(`studies/${study.id}`, 'PUT', { source: next['study.py'], branch: study.branch ?? 'main', expected_revision: study.revision });
      replaceStudy(fromRecord(record), record.compiled.design.document_id);
      settle(key);
      toast('success', 'Code saved', `${study.name} · revision ${record.revision}`);
      return true;
    } catch (error) { report(error); return false; }
  };
  return {
    key, kind: 'study', owner, label: labelOf('study', study.name), files: { 'study.py': study.source ?? '' }, main: 'study.py', revision: study.revision ?? 0,
    action: { label: 'Run study', id: 'source-run-study', run: async (edited) => {
      if (edited && !(await save(edited))) return;
      const { runStudy } = await import('@/workspaces/simulate/state');
      void runStudy('solve');
    } },
    save,
  };
}

/** The shown shop's code (its page's Code tab is the same editor, on the same edits). */
export function useShopTarget(): CodeTarget | null {
  const doc = useShop((state) => state.doc);
  return useMemo(() => shopTarget(), [doc]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** What the code editor shows in this workspace: an object's code, an empty state, or null (the document's own code). */
export function useCodeTarget(): CodeTarget | EmptyTarget | null {
  const workspace = useApp((state) => state.workspace);
  const open = useApp((state) => state.doc.open);
  const owner = useApp((state) => state.doc.name);
  const library = useApp((state) => state.dialog === 'tools');
  const shopKind = useMfg((state) => state.libraryKind === 'shop');
  const shopPage = library && shopKind;
  const shopDoc = useShop((state) => state.doc);
  const programs = useMfg((state) => state.programs);
  const activeProgram = useMfg((state) => state.activeProgram);
  const camDocs = useCamDoc((state) => state.docs);
  const study = useApp((state) => state.studies.find((item) => item.id === state.activeStudy) ?? null);
  return useMemo(() => {
    if (workspace === 'manufacture' && shopPage) return shopTarget() ?? { empty: true, title: 'No shop yet', detail: 'Add your first machine: the shop is your machines and tools as code.' };
    if (!open) return null;
    if (workspace === 'manufacture') {
      const milling = programs.filter((item) => item.cam || (item.compiled.setups[0] as { process?: string } | undefined)?.process !== 'fff');
      const record = milling.find((item) => item.id === activeProgram) ?? (milling.length === 1 ? milling[0] : null);
      if (record) return (record.cam ? camTarget(record, owner) : programTarget(record, owner)) ?? { empty: true, title: 'Reading the program', detail: '' };
      return { empty: true, title: milling.length ? 'Choose a program' : 'No program yet',
        detail: milling.length ? 'Select a program, a setup or an operation in the tree: its code shows here.' : 'A program is code: its setups and operations, written by the forms and by you.',
        start: milling.length ? undefined : { label: 'New program', id: 'source-new-program', run: () => { void import('@/workspaces/manufacture/cam/state').then(({ newProgram }) => newProgram()); } } };
    }
    if (workspace === 'simulate') {
      if (study?.source !== undefined && study.revision) return studyTarget(study, owner);
      return { empty: true, title: study ? 'Not saved yet' : 'No study yet', detail: study ? 'The study’s code shows once it’s saved: run it, or change a setting.' : 'A study is code too: its type, materials, supports and loads. Start one from New study.' };
    }
    return null;
  }, [workspace, open, owner, shopPage, shopDoc, programs, activeProgram, camDocs, study]); // eslint-disable-line react-hooks/exhaustive-deps
}

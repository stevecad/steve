import { ApiError, api, serverCapabilities, type Build, type CadDocument } from './api';
import type { Who } from '@/teams/attribution';

/** Draft contract: BACKEND_SPEC.md "Experimental local Git history". */
export interface Revision { event_id: string | number; revision: number; recorded_at: string; commit_id: string | null; message?: string | null; preview_build_id?: string | null; by?: Who | null }

export type HistoryFetch = { state: 'ready'; revisions: Revision[] } | { state: 'unavailable' } | { state: 'error'; message: string };

export async function fetchHistory(documentId: string): Promise<HistoryFetch> {
  if (!(await serverCapabilities()).history) return { state: 'unavailable' };
  try {
    const result = await api<{ document_id: string; revisions: Revision[] }>(`/v1/documents/${documentId}/history?limit=100`);
    return { state: 'ready', revisions: result.revisions };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return { state: 'unavailable' };
    return { state: 'error', message: (error as Error).message };
  }
}

export const historicalDocument = (documentId: string, commit: string) =>
  api<{ commit_id: string; document: Pick<CadDocument, 'id' | 'name' | 'kind' | 'revision' | 'code' | 'files' | 'links'> }>(`/v1/documents/${documentId}/history/${commit}`);

/** Makes a recorded revision (from any branch) the new head of `branch`; `revision` is that branch's current revision. */
export const restoreRevision = (documentId: string, revision: number, commit: string, branch = 'main') =>
  api<{ document: CadDocument; model: Build | null; restored_from: string }>(`/v1/documents/${documentId}/history/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, commit_id: commit, branch }),
  });

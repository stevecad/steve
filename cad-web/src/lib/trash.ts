import { api, type FileSummary } from './api';

/** The Trash (app/trash.py, app/files.py): deleted parts, designs, circuits, simulation studies and CAM programs wait
 * there, restorable, until they're deleted for good. */

/** What uses a document: designs linking it (on main or a branch), studies and CAM programs pinned to it. */
export interface References {
  designs: { id: string; name: string; trashed: boolean; branches: string[] }[];
  studies: { id: string; name: string }[];
  programs: { id: string; name: string }[];
  count: number;
}

export interface TrashedDocument extends FileSummary {
  deleted_at: string;
  deleted_by: string;
  /** When the retention purge deletes it for good; null when the server keeps the Trash until it's emptied. */
  purge_at: string | null;
  references: References;
  /** "Used by 2 designs and 1 CAM program", or "". */
  used_by: string;
  /** Why it stays though nothing uses it (its CAM work is still running, an accepted reference review), or "". */
  blocked?: string;
}

export interface Skipped { id: string; name?: string | null; reason: string; references?: References }

const post = (url: string, body?: unknown) => api<never>(url, {
  method: 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});

export const Trash = {
  references: (id: string) => api<References & { used_by: string }>(`/v1/documents/${id}/references`),
  /** Moves documents to the Trash; one that can't go (gone already, not yours) is skipped with the reason. */
  remove: (ids: string[]) => post(`/v1/trash`, { ids }) as Promise<{ moved: { document: FileSummary; used_by: string }[]; skipped: Skipped[] }>,
  restore: (ids: string[]) => post(`/v1/trash/restore`, { ids }) as Promise<{ restored: FileSummary[]; skipped: Skipped[] }>,
  list: () => api<{ documents: TrashedDocument[]; retention_days: number | null }>('/v1/trash'),
  /** Deletes for good; anything still used elsewhere stays in the Trash and comes back in `skipped`. */
  purge: (ids: string[]) => post(`/v1/trash/purge`, { ids }) as Promise<{ purged: { id: string; name: string }[]; skipped: Skipped[] }>,
  empty: () => post(`/v1/trash/empty`) as Promise<{ purged: { id: string; name: string }[]; skipped: Skipped[] }>,
};

/** A design's link to a document that's in the Trash (its pinned revision still builds). */
export const linkTrashed = (status: unknown) => !!(status as { trashed?: boolean } | undefined)?.trashed;

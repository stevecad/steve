/**
 * Share links (app/shares.py): a person shares one saved version of a design through a revocable link anyone can open.
 * The server accepts these calls only from this web app in a person's browser; nothing else (STEVE, MCP) can make them.
 */
import { api, json } from './api';

export type ShareLevel = 'view' | 'step' | 'code';

export interface Share {
  id: string;
  document_id: string;
  document_name: string;
  branch: string;
  revision: number;
  level: ShareLevel;
  /** Visitors may move the mechanism along its joints, and on shares made since, play its motors and animations (the owner chose it, with its own sentences in the terms). */
  motion: boolean;
  /** Only on the share just made: the link is shown once and never stored readable. */
  url?: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  views: number;
  last_viewed_at: string | null;
  /**
   * On the share just made, and from Shares.get: the STEP file and the link-preview picture come from the full model of
   * this version, which the server builds when the link is made if it isn't there yet (the link works at once).
   */
  prepared?: { step: Preparation; picture: Preparation };
  /** Why the full model couldn't be asked for (e.g. the build queue was full). */
  note?: string;
}

export type Preparation = 'ready' | 'preparing' | 'unavailable';

/** What anyone with the link can do at each level, and (`motion`) what letting them move the mechanism adds. */
export interface ShareTerms { version: string; levels: Record<ShareLevel, string[]>; motion: string[]; fresh_seconds: number }

export const Shares = {
  terms: () => api<ShareTerms>('/v1/shares/terms'),
  list: (documentId?: string) => api<{ shares: Share[] }>(`/v1/shares${documentId ? `?document_id=${encodeURIComponent(documentId)}` : ''}`),
  create: (body: { document_id: string; branch: string; revision: number; level: ShareLevel; acknowledged: boolean; terms_version: string; expires_in_days: number | null; motion: boolean }) =>
    api<Share>('/v1/shares', json('POST', body)),
  get: (id: string) => api<Share>(`/v1/shares/${id}`),
  revoke: (id: string) => api<Share>(`/v1/shares/${id}`, { method: 'DELETE' }),
};

/** The full link to give people. */
export const shareLink = (share: Share) => `${location.origin}${share.url ?? ''}`;

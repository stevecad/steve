import { api, serverCapabilities, type Build, type CadDocument, type Kind, type LinkRef } from './api';
import type { Who } from '@/teams/attribution';

/** Contract: BACKEND_SPEC.md "Branches and merges". `main` is the document itself. */
export interface Branch {
  name: string;
  revision: number;
  base_revision: number | null;
  updated_at: string;
  created_at?: string;
  preview_build_id: string | null;
  ahead: number;
  behind: number;
  merged?: boolean;
  /** Who started the branch and how. */
  by?: Who | null;
}

export interface BranchDocument extends CadDocument { branch: string; base_revision: number | null }

/** A code conflict spans merged-source lines; a file conflict is one design file deleted on one side and changed on the
 * other; a link conflict is one alias linked to different documents or revisions (ours/theirs: "<document_id>@<revision>"). */
export interface MergeConflict {
  index: number;
  kind: 'code' | 'file' | 'link';
  file?: string;
  start_line: number | null;
  end_line: number | null;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  alias?: string;
  message?: string;
}

interface Side { revision: number; code: string; preview_build_id: string | null; name: string }

export interface Comparison {
  base: { revision: number; name: string; code: string; source: { branch: string; revision: number } };
  main: Side;
  branch: Side;
  ahead: number;
  behind: number;
  merge: { status: 'up_to_date' | 'fast_forward' | 'clean' | 'conflict'; name: string; code: string; links?: Record<string, string>; conflicts: MergeConflict[] };
}

/** Body for merge and sync: the revisions compared, plus the resolution when there were conflicts or edits. */
export interface MergeBody { main_revision: number; branch_revision: number; code?: string; links?: Record<string, LinkRef>; name?: string }

export interface GraphNode {
  key: string;
  branch: string;
  revision: number;
  recorded_at: string;
  parents: string[];
  kind: 'create' | 'edit' | 'branch' | 'merge' | 'sync' | 'restore' | string;
  message: string;
  commit_id: string | null;
  preview_build_id?: string | null;
  /** Who saved it and how (docs/TEAMS.md "Attribution"); absent on servers or revisions from before attribution. */
  by?: Who | null;
  /** What STEVE sees changed ("Edited source"), when `message` is the saver's own words instead. */
  change?: string;
}

/** Deleted branches that main merged keep their line, labelled `name~id`. */
export interface VersionGraph { document_id: string; nodes: GraphNode[]; branches: { name: string; head_key: string; color_index?: number; deleted?: boolean }[] }

const base = (id: string) => `/v1/documents/${id}/branches`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const Branches = {
  available: async () => (await serverCapabilities()).branches,
  list: (id: string) => api<{ document_id: string; default: string; branches: Branch[] }>(base(id)),
  create: (id: string, name: string, fromRevision?: number) => api<Branch>(base(id), json('POST', { name, ...(fromRevision ? { from_revision: fromRevision } : {}) })),
  read: (id: string, name: string) => api<BranchDocument>(`${base(id)}/${encodeURIComponent(name)}`),
  update: (id: string, name: string, body: { name: string; kind: Kind; code: string; files?: Record<string, string>; links?: Record<string, LinkRef>; preview_build_id: string | null; revision: number; message?: string }) =>
    api<BranchDocument>(`${base(id)}/${encodeURIComponent(name)}`, json('PUT', body)),
  remove: (id: string, name: string) => fetch(`${base(id)}/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((response) => { if (!response.ok) throw new Error(`Couldn’t delete the branch (${response.status}).`); }),
  compare: (id: string, name: string) => api<Comparison>(`${base(id)}/${encodeURIComponent(name)}/compare`),
  merge: (id: string, name: string, body: MergeBody) =>
    api<{ document: CadDocument; model: Build | null; merge: { branch: string; main_revision: number; commit_id: string | null } }>(`${base(id)}/${encodeURIComponent(name)}/merge`, json('POST', body)),
  sync: (id: string, name: string, body: MergeBody) =>
    api<BranchDocument>(`${base(id)}/${encodeURIComponent(name)}/sync`, json('POST', body)),
  graph: (id: string) => api<VersionGraph>(`/v1/documents/${id}/graph?limit=300`),
};

export const BRANCH_COLORS = ['#8fdcc0', '#a99bff', '#e8bd84', '#5cb8ff', '#ff8a78', '#b7e27a', '#f39bd0', '#7fd6e8'];

/** Stable color per branch: main is always the brand mint. */
export function branchColor(name: string, order: string[]): string {
  if (name === 'main') return BRANCH_COLORS[0];
  const index = order.filter((item) => item !== 'main').indexOf(name);
  return BRANCH_COLORS[1 + ((index < 0 ? hash(name) : index) % (BRANCH_COLORS.length - 1))];
}

const hash = (text: string) => Array.from(text).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);

/** Mirrors the server's BRANCH_NAME / valid_name / NAME_RULE in app/features/branches.py: keep the three in step. */
export const BRANCH_NAME_RULE = 'Lowercase letters, numbers, dots, underscores and dashes; starts with a letter or number.';
export const validBranchName = (name: string) =>
  /^[a-z0-9][a-z0-9._-]{0,47}$/.test(name) && name !== 'main' && !name.includes('..') && !name.endsWith('.') && !name.endsWith('.lock');
export const slugBranch = (text: string) => text.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.')
  .replace(/^[^a-z0-9]+/, '').slice(0, 48).replace(/(?:\.lock|\.)+$/, '');

/**
 * One canonical branch order so a branch has the same color everywhere. The server's graph
 * numbers every branch ever created (color_index), which stays stable across deletions;
 * without it, main then live branches by creation.
 */
export function branchOrder(branches: Branch[] | null | undefined, graph?: VersionGraph | null): string[] {
  const order: string[] = ['main'];
  for (const item of graph?.branches ?? []) if (item.name !== 'main' && item.color_index) order[item.color_index] = item.name;
  const rest = (branches ?? []).filter((item) => item.name !== 'main' && !order.includes(item.name))
    .sort((a, b) => (a.created_at ?? a.updated_at).localeCompare(b.created_at ?? b.updated_at) || a.name.localeCompare(b.name));
  return [...Array.from(order, (name) => name ?? ''), ...rest.map((item) => item.name)];
}

/**
 * Comments pinned to geometry (app/comments.py): the person selects faces, edges, corners or components and
 * writes a comment; their AI agent reads it over MCP (list_comments), replies and resolves it. This keeps the open
 * document's threads, refreshes them while the Comments panel or pins are showing (agents reply from outside the
 * app), and turns the current selection into an anchor: the viewer's own description of each pick plus a world point
 * for its pin.
 */
import * as THREE from 'three';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { get, set, toast, useApp, type Pick } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { analyze, selectionContext } from '@/viewport/semantics';
import { faceFrame } from '@/viewport/faceFrame';
import type { Who } from '@/teams/attribution';

export interface Anchor {
  kind: Pick['kind'];
  description: string;
  component: string | null;
  part_document_id: string | null;
  topology_ref: string | null;
  point: [number, number, number] | null;
}

export interface CommentItem {
  id: string;
  parent_id: string | null;
  body: string;
  author: 'person' | 'agent';
  status: 'open' | 'resolved';
  resolved_by: string | null;
  revision: number | null;
  anchor: Anchor[];
  created_at: string;
  /** Who wrote it and how (docs/TEAMS.md "Attribution"); absent on comments from before attribution. */
  who?: Who | null;
  /** Addressed to AI agents (marked "For AI", or mentioning @ai): their work queue (list_comments for_agents). */
  for_agents?: boolean;
  /** How it was resolved: by whom, and the branch or revision that dealt with it. */
  resolution?: { by: Who | null; branch?: string; revision?: number } | null;
}

export interface Thread extends CommentItem { number: number; replies: CommentItem[] }

interface CommentsState {
  /** `${documentId}:${branch}` the threads belong to. */
  key: string | null;
  threads: Thread[];
  loading: boolean;
  error: string;
  /** The thread the person is looking at (its pin is emphasized). */
  focus: string | null;
  showResolved: boolean;
}

export const useComments = create<CommentsState>(() => ({ key: null, threads: [], loading: false, error: '', focus: null, showResolved: false }));

const current = () => {
  const { doc } = get();
  return doc.open && doc.saved ? { id: doc.saved.id, branch: doc.branch, revision: doc.saved.revision, key: `${doc.saved.id}:${doc.branch}` } : null;
};
const base = (id: string) => `/v1/documents/${id}/comments`;

export async function loadComments(quiet = false) {
  const doc = current();
  if (!doc) { useComments.setState({ key: null, threads: [], error: '' }); return; }
  if (useComments.getState().key !== doc.key) useComments.setState({ key: doc.key, threads: [], focus: null });
  if (!quiet) useComments.setState({ loading: true, error: '' });
  try {
    const data = await api<{ comments: Thread[] }>(`${base(doc.id)}?branch=${encodeURIComponent(doc.branch)}`);
    if (useComments.getState().key === doc.key) useComments.setState({ threads: data.comments, loading: false, error: '' });
  } catch (error) {
    useComments.setState({ loading: false, error: quiet ? useComments.getState().error : (error as Error).message });
  }
}

/** A point on the picked entity for its pin (world mm): the vertex, an edge's midpoint, a point on a face near its middle, a component's center. */
function pickPoint(pick: Pick): [number, number, number] | null {
  const model = viewer.model;
  if (!model) return null;
  let p: THREE.Vector3 | null = null;
  if (pick.kind === 'component') {
    const box = model.bounds(true, pick.node);
    if (!box.isEmpty()) p = box.getCenter(new THREE.Vector3());
  } else if (pick.kind === 'edge') {
    const points = model.worldEdgePoints(pick);
    if (points.length) p = points[Math.floor(points.length / 2)];
  } else if (pick.kind === 'face') {
    // On the face itself: its bounding box's centre is empty space for a plate with a hole, a ring or an L.
    p = faceFrame(model, pick)?.center ?? null;
  } else {
    const position = analyze(model, pick).geometry?.position as number[] | undefined;
    if (position) p = new THREE.Vector3(position[0], position[1], position[2]);
  }
  return p && [p.x, p.y, p.z].every(Number.isFinite) ? [p.x, p.y, p.z] : null;
}

/** The current selection as an anchor (at most what the viewer describes: 12 picks). */
export function selectionAnchor(): Anchor[] {
  const model = viewer.model;
  const picks = get().selection;
  if (!model || !picks.length) return [];
  return selectionContext(model, picks).map((context, i) => ({
    kind: context.kind, description: context.description.slice(0, 600), component: context.component,
    part_document_id: context.part_document_id, topology_ref: context.topology_ref?.slice(0, 200) ?? null, point: pickPoint(picks[i]),
  }));
}

export async function addComment(body: string, anchor: Anchor[], forAgents = false): Promise<boolean> {
  const doc = current();
  if (!doc) return false;
  try {
    const created = await api<CommentItem>(base(doc.id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, anchor, branch: doc.branch, revision: doc.revision, build_id: viewer.model?.build.id ?? null, for_agents: forAgents }),
    });
    await loadComments(true);
    useComments.setState({ focus: created.id });
    return true;
  } catch (error) {
    toast('danger', 'Couldn’t add the comment', (error as Error).message);
    return false;
  }
}

export async function replyTo(thread: Thread, body: string): Promise<boolean> {
  const doc = current();
  if (!doc) return false;
  try {
    await api(base(doc.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, parent_id: thread.id }) });
    await loadComments(true);
    return true;
  } catch (error) {
    toast('danger', 'Couldn’t reply', (error as Error).message);
    return false;
  }
}

export async function setThreadStatus(thread: Thread, status: 'open' | 'resolved') {
  const doc = current();
  if (!doc) return;
  try {
    await api(`${base(doc.id)}/${thread.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    await loadComments(true);
  } catch (error) {
    toast('danger', 'Couldn’t update the comment', (error as Error).message);
  }
}

export async function deleteComment(item: CommentItem) {
  const doc = current();
  if (!doc) return;
  try {
    await api<null>(`${base(doc.id)}/${item.id}`, { method: 'DELETE' });
    await loadComments(true);
  } catch (error) {
    toast('danger', 'Couldn’t delete the comment', (error as Error).message);
  }
}

/** "Comment on selection…" (viewer context menu): the Comments panel, ready to write about what's selected. */
export function commentOnSelection() {
  set({ dockOpen: true, dockTab: 'comments', contextMenu: null });
  window.setTimeout(() => document.getElementById('comment-new')?.focus(), 250);
}

/** Keeps the open document's comments current: when it changes, on focus, and every 15 s while visible. */
export function installCommentWatch(): () => void {
  const refresh = () => { if (document.visibilityState === 'visible' && current()) void loadComments(true); };
  const timer = window.setInterval(refresh, 15_000);
  window.addEventListener('focus', refresh);
  const stop = useApp.subscribe((state) => `${state.doc.open}|${state.doc.saved?.id}|${state.doc.branch}`, () => { void loadComments(); });
  void loadComments();
  return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); stop(); };
}

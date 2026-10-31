/**
 * What the share page knows about the shared design, and the few things a visitor can change: which parts show, which
 * one is selected, explode and the mechanism's pose. Only the app store and the motion store; never the /v1 API.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import * as THREE from 'three';
import { get, set, useApp, type TreeNode } from '@/state/store';
import { viewer } from '@/viewport/viewer';
import { assignmentsFromReport, materialRecord } from '@/lib/materials';
import { resetPose, useMotion } from '@/motion/state';
import { jointOfInstance } from '@/motion/kinematics';
import { instanceOfNode } from '@/motion/instances';
import type { Build } from '@/lib/api';
import type { DesignResult, ModelingResult } from '@/lib/modeling';

export interface Info {
  name: string; revision: number; kind: Build['kind']; level: 'view' | 'step' | 'code'; shared_at: string;
  model: string; topology: string; decals: string;
  /** The allow-listed subset of the build's metadata the viewer reads (app/shares.py viewer_metadata). */
  viewer: Build['metadata'];
  downloads: Download[];
}

/** A download the link allows: ready, or (the STEP file, made when it's first downloaded) being prepared, with the
 *  server's own words for how far it is. */
export interface Download { name: string; url: string; status?: 'ready' | 'preparing' | 'unavailable'; message?: string }

type Design = DesignResult & { links?: Record<string, { name?: string; kind?: string; summary?: ModelingResult | null }> };

/** A placed part's facts for the inspector: its component's name and the materials its bodies show. */
export function factsOf(info: Info | null, name: string): { component: string | null; materials: string[] } {
  const design = (info?.viewer as { modeling?: { design?: Design } } | null | undefined)?.modeling?.design;
  const instance = design?.instances.find((item) => item.name.replaceAll('_', ' ').toLowerCase() === name.toLowerCase());
  const report: (ModelingResult & { name?: string }) | null | undefined = instance
    ? (instance.link ? design?.links?.[instance.component]?.summary : design?.components[instance.component])
    : design ? null : (info?.viewer as { modeling?: ModelingResult } | null | undefined)?.modeling;
  const assignments = assignmentsFromReport(report);
  const ids = new Set([assignments?.part?.material, ...Object.values(assignments?.bodies ?? {}).map((item) => item.material)].filter((id): id is string => !!id));
  return {
    component: instance ? (instance.link ? design?.links?.[instance.component]?.name : report?.name) ?? instance.component : null,
    materials: [...ids].map((id) => materialRecord(id)?.name ?? id),
  };
}

/** The joint that moves a placed part, when the owner let visitors move the mechanism. */
export function useJointOf(node: string | undefined) {
  const kinematics = useMotion((state) => state.kinematics);
  return useMemo(() => {
    const instance = node && kinematics ? instanceOfNode(node) : null;
    return instance ? jointOfInstance(kinematics, instance) : undefined;
  }, [kinematics, node]);
}

/** The placed parts: the nodes directly under the document. */
export function useParts() {
  const tree = useApp((state) => state.tree);
  return useMemo(() => (tree.root?.children ?? []).map((id) => tree[id]).filter(Boolean), [tree]);
}

/** The selected placed part, if any. */
export const useSelectedPart = () => useApp((state) => (state.selection[0]?.kind === 'component' ? state.tree[state.selection[0].node] : undefined));

/** A placed part's overall size, from the model on screen. */
export function usePartSize(part: TreeNode | undefined) {
  return useMemo(() => {
    const box = part ? viewer.model?.bounds(false, part.id) : null;
    return box && !box.isEmpty() ? box.getSize(new THREE.Vector3()) : null;
  }, [part]);
}

const setHidden = (hidden: (node: TreeNode) => boolean) => set((state) => ({
  tree: Object.fromEntries(Object.entries(state.tree).map(([id, node]) => [id, node.parent === 'root' ? { ...node, hidden: hidden(node) } : node])),
}));
export const showAll = () => setHidden(() => false);
export const isolate = (id: string) => setHidden((node) => node.id !== id);
export const toggleHidden = (id: string) => setHidden((node) => (node.id === id ? !node.hidden : !!node.hidden));
export const hide = (id: string) => setHidden((node) => node.id === id || !!node.hidden);
export const choose = (id: string) => set({ selection: [{ kind: 'component', node: id }] });

/** Explode and the pose both place the parts: exploding starts from the mechanism's own pose (dragging collapses it). */
export function setExplode(value: number) {
  if (useMotion.getState().kinematics && get().explode === 0 && value > 0) resetPose();
  set({ explode: value });
}
export function resetMotion() { set({ explode: 0 }); resetPose(); }

/** Saves a file the link allows (a same-origin /share/<token>/download/… URL). */
export function download(url: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}

/** Downloads the visitor asked for that are still being made (the STEP file: made on its first download), by URL. */
export const useAsked = create<{ items: Record<string, Pick<Download, 'status' | 'message'>> }>(() => ({ items: {} }));
const asked = (url: string, item: Pick<Download, 'status' | 'message'> | null) => useAsked.setState((state) => {
  const items = { ...state.items };
  if (item) items[url] = item; else delete items[url];
  return { items };
});

/** A download as the visitor sees it: what the page was told, or how far the one they asked for is now. */
export const effective = (item: Download, items: Record<string, Pick<Download, 'status' | 'message'>>): Download => ({ ...item, ...items[item.url] });

const filename = (header: string | null) => {
  const star = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (star) { try { return decodeURIComponent(star); } catch { /* the plain name below */ } }
  return header?.match(/filename="?([^";]+)"?/i)?.[1] ?? '';
};

/**
 * Asks for a download and saves it once the server has it: the STEP file may still be being made (202, preparing, with
 * a Retry-After): the visitor sees the server's words for it, and it downloads by itself once made. A file that can't be
 * made says why. `pause` and `save` are for tests.
 */
export async function requestDownload(url: string, { pause = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)),
  save = (blob: Blob, name: string) => { const link = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = link; a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(link), 60_000); } } = {}): Promise<void> {
  if (useAsked.getState().items[url]?.status === 'preparing') return;   // Already waiting for it.
  for (let tries = 0; tries < 400; tries++) {
    let response: Response;
    try { response = await fetch(url); } catch { asked(url, { status: 'unavailable', message: 'The download didn’t start. Check your connection and try again.' }); return; }
    if (response.status === 202) {
      const body = await response.json().catch(() => ({})) as { message?: string };
      asked(url, { status: 'preparing', message: body.message || 'Being prepared…' });
      await pause(Math.min(30, Math.max(3, Number(response.headers.get('Retry-After')) || 5)));
      continue;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string; detail?: string };
      asked(url, { status: 'unavailable', message: body.message || body.detail || 'Not available' });
      return;
    }
    asked(url, null);
    save(await response.blob(), filename(response.headers.get('Content-Disposition')));
    return;
  }
  asked(url, null);
}

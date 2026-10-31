/**
 * The design's placed instances as the shown build reports them, and the instance a viewport node belongs to. Read
 * from the app store only, so the share page (web/src/share) can use them without the editor.
 */
import { get } from '@/state/store';
import type { DesignResult } from '@/lib/modeling';

/** The design's placed instances (by the names main.py gives them), from the shown build. */
export function designInstances(): { name: string; component: string; link: boolean }[] {
  const design = (get().displayed?.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design;
  return (design?.instances ?? []).map((item) => ({ name: item.name, component: item.component, link: !!(item as { link?: boolean }).link }));
}

/** The instance a viewport node belongs to (its top-level ancestor under the document). */
export function instanceOfNode(node: string): string | null {
  const state = get();
  let current = state.tree[node];
  while (current?.parent && current.parent !== state.rootId) current = state.tree[current.parent];
  if (!current) return null;
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return designInstances().find((item) => key(item.name) === key(current!.name))?.name ?? null;
}

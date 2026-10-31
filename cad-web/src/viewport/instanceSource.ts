/**
 * Designs: which part report a viewport node shows, for materials (src/materials) and decals (DecalLayer). A node
 * belongs to an instance placed directly under the document: a component (its report), a linked part (the link's
 * report) or a linked design, whose summary is itself a design's (runtime/steve/design.py `summary`): its nodes are
 * that design's own instances, further down, resolved the same way (its links too). When a big build dropped a linked
 * design's summary (runtime/kernel.py `success_payload`), its instances keep the component tint.
 */
import type { DesignResult, ModelingResult } from '@/lib/modeling';
import { pretty } from '@/lib/format';
import type { ModelRuntime } from './model';

type DesignSummary = Pick<DesignResult, 'instances' | 'components'> & { links?: Record<string, { kind?: string; summary?: unknown }> };

/** The report a node shows: `key` names its source (one per component, per link path), `node` is the instance node its
 *  faces are counted from (and its decals hang off). */
export interface InstanceSource { key: string; node: string; summary: ModelingResult | null }

const isDesign = (summary: unknown): summary is DesignSummary =>
  !!summary && Array.isArray((summary as DesignSummary).instances) && typeof (summary as DesignSummary).components === 'object';

/** A resolver for one model's nodes; null for a part, or a node outside any instance. */
export function instanceSources(model: ModelRuntime): (node: string) => InstanceSource | null {
  const design = (model.build.metadata as { modeling?: { design?: DesignSummary } } | null | undefined)?.modeling?.design;
  const names = new Map<DesignSummary, Map<string, DesignSummary['instances'][number]>>();
  const byName = (summary: DesignSummary) => {
    if (!names.has(summary)) names.set(summary, new Map(summary.instances.map((item) => [pretty(item.name), item])));
    return names.get(summary)!;
  };
  // `path`: the node's ancestors from just under the instance's design down to the node itself. The document's own
  // instances are its direct children; a linked design's are the first nodes named after them (an exporter may add a level).
  const resolve = (summary: DesignSummary, path: string[], prefix: string, top: boolean): InstanceSource | null => {
    const instances = byName(summary);
    const at = top ? (instances.has(model.tree[path[0]]?.name ?? '') ? 0 : -1) : path.findIndex((id) => instances.has(model.tree[id]?.name ?? ''));
    if (at < 0) return null;
    const instance = instances.get(model.tree[path[at]].name)!;
    if (!instance.link) return { key: `${prefix}component:${instance.component}`, node: path[at], summary: summary.components[instance.component] ?? null };
    const linked = summary.links?.[instance.component]?.summary;
    if (isDesign(linked)) return resolve(linked, path.slice(at + 1), `${prefix}link:${instance.component}/`, false);
    return { key: `${prefix}link:${instance.component}`, node: path[at], summary: (linked as ModelingResult | null | undefined) ?? null };
  };
  const resolved = new Map<string, InstanceSource | null>();  // Faces share nodes: one walk per node.
  return (node) => {
    if (!design) return null;
    if (!resolved.has(node)) {
      const path: string[] = [];
      for (let id: string | null = node; id && id !== model.rootId; id = model.tree[id]?.parent ?? null) path.unshift(id);
      resolved.set(node, path.length ? resolve(design, path, '', true) : null);
    }
    return resolved.get(node) ?? null;
  };
}

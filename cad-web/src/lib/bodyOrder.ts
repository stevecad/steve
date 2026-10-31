import type { FaceLook, ModelingResult } from './modeling';

/**
 * A part's body ids in export order (each body's faces are a run of the part's mesh, in this order). Builds report each
 * body's `index`; older ones came back from jsonb with their keys sorted, so the order is recovered from the feature
 * that made each body.
 */
export function bodyOrder(report: ModelingResult | null | undefined): string[] {
  const entries = Object.entries(report?.bodies ?? {});
  if (entries.every(([, body]) => typeof body.index === 'number')) return entries.sort((a, b) => a[1].index! - b[1].index!).map(([id]) => id);
  const features = report?.features ?? [];
  const made = (id: string) => features.findIndex((f) => f.id === id || f.body === id || (f.kind === 'split' && id.startsWith(`${f.id}_`)) || (f.kind === 'move' && id.endsWith(`_${f.id}`)));
  return entries.map(([id], order) => [id, made(id), order] as const).sort((a, b) => a[1] - b[1] || a[2] - b[2]).map(([id]) => id);
}

/** A design component's body ids in its exported mesh's order (by reported index). */
export const componentBodyOrder = (report: ModelingResult | null | undefined): string[] =>
  Object.entries(report?.bodies ?? {}).sort((a, b) => (a[1].index ?? 0) - (b[1].index ?? 0)).map(([id]) => id);

/**
 * `model.appearance(faces=...)` as a build reported it: each face's look (its reported group, one object per group) by
 * the face's index in the exported mesh, bodies in `order`. A face's look wins over its body's. Empty without face looks.
 */
export function faceLooks(report: ModelingResult | null | undefined, order: string[]): Map<number, FaceLook> {
  const out = new Map<number, FaceLook>();
  let start = 0;
  for (const id of order) {
    const body = report?.bodies[id];
    if (!body) continue;
    for (const group of body.face_appearances ?? []) for (const face of group.faces) if (face >= 0 && face < body.faces) out.set(start + face, group);
    start += body.faces;
  }
  return out;
}

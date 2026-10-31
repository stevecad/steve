/**
 * Exporting one piece of a design as STEP. A full design build's components-step.zip (made with its STEP file, on
 * request: stepFileFor) holds a STEP
 * per local component (in its own frame, each body a named solid), per linked document and, for a main.py that
 * builds its own cq.Assembly, per top-level instance. GET /v1/builds/{id}/components/{key} serves one.
 */
import { Api, type ComponentStep } from '@/lib/api';
import { pretty } from '@/lib/format';
import { designOf } from '@/modeling/bodies';
import { ensureFullBuild, exportStatus } from './actions';
import { stepFileFor } from './stepFile';
import { get, toast, type AppState } from './store';
import { withWorkspace } from '@/teams/current';

/** What a row or a selection exports: `id` identifies it (`component:<id>`, `link:<alias>`, `instance:<label>`). */
export interface StepTarget { id: string; name: string; kind: ComponentStep['kind']; match: (entry: ComponentStep) => boolean }

export const componentTarget = (id: string, name: string): StepTarget =>
  ({ id: `component:${id}`, name, kind: 'component', match: (entry) => entry.kind === 'component' && entry.id === id });

export const linkTarget = (alias: string, name: string): StepTarget =>
  ({ id: `link:${alias}`, name, kind: 'link', match: (entry) => entry.kind === 'link' && entry.id === alias });

type Links = Record<string, { name?: string }>;

/** The placed instance a viewport node belongs to (a direct child of the design), as an export target. */
export function nodeTarget(state: AppState, node: string): StepTarget | null {
  if (state.doc.kind !== 'design' || !state.rootId) return null;
  let id: string | null = node;
  while (id && state.tree[id] && state.tree[id].parent !== state.rootId) id = state.tree[id].parent ?? null;
  const label = id ? state.tree[id]?.name : undefined;
  if (!id || !label) return null;
  const design = designOf(state.displayed);
  const instance = design?.instances.find((item) => pretty(item.name) === label);
  if (design && instance) {
    if (instance.link) return linkTarget(instance.component, (design as unknown as { links?: Links }).links?.[instance.component]?.name ?? instance.component);
    return componentTarget(instance.component, design.components[instance.component]?.name ?? instance.component);
  }
  return { id: `instance:${label}`, name: label, kind: 'instance', match: (entry) => entry.kind === 'instance' && pretty(entry.id) === label };
}

/** The single component, link or instance the selection is on, if there is exactly one. */
export function selectionTarget(state: AppState = get()): StepTarget | null {
  const targets = new Map<string, StepTarget>();
  for (const pick of state.selection) {
    const target = nodeTarget(state, pick.node);
    if (!target) return null;
    targets.set(target.id, target);
  }
  return targets.size === 1 ? [...targets.values()][0] : null;
}

const fileName = (name: string) => `${name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'component'}.step`;

/** Downloads one component's STEP, building the full model first when only a preview is shown and making its STEP
 *  files when they aren't made yet. */
export async function exportComponentStep(target: StepTarget) {
  let build = await ensureFullBuild();
  if (!build) return;
  if (!await stepFileFor(build, exportStatus, () => { void exportComponentStep(target); })) return;
  // Made just now: the build lists its components' files (metadata.component_steps) from then on.
  if (!build.metadata?.component_steps) build = await Api.build(build.id);
  // A full build from before per-component export (an older runtime) has none: build it again once.
  if (!build.metadata?.component_steps) {
    const fresh = await ensureFullBuild(true);
    if (!fresh || !await stepFileFor(fresh, exportStatus, () => { void exportComponentStep(target); })) return;
    build = await Api.build(fresh.id);
  }
  const entry = build?.metadata?.component_steps?.find(target.match);
  if (!build || !entry) {
    toast('warning', `No STEP for ${target.name}`, 'A component without bodies has nothing to export.');
    return;
  }
  const link = document.createElement('a');
  link.href = withWorkspace(`/v1/builds/${build.id}/components/${encodeURIComponent(entry.key)}`);
  link.download = fileName(target.name);
  link.click();
  toast('success', `Exporting ${target.name}`, target.kind === 'component'
    ? 'STEP of the component as modelled, in its own coordinates, each body a named solid.'
    : target.kind === 'link' ? 'STEP of the linked document at the revision this design uses.' : 'STEP of this instance.');
}

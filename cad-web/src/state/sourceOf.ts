/**
 * From the model to its code: which file holds what made a picked face or edge (a design's component file, or
 * main.py), and showing it in the Source pane. The pane reveals and tints the feature of the current selection.
 */
import { designOf, featureOfPick } from '@/modeling/bodies';
import { instanceOfNode } from '@/placement/placement';
import { MAIN } from '@/state/design';
import { openFile } from '@/state/actions';
import { get, set, type EntityPick, type Pick } from '@/state/store';

/** The file whose code made this pick: its component's file in a design, else main.py. */
export function fileOfPick(pick: Pick): string {
  const state = get();
  if (state.doc.kind !== 'design') return MAIN;
  const instance = instanceOfNode(pick.node);
  const design = designOf(state.displayed);
  const component = design?.instances.find((item) => item.name === instance)?.component;
  return (component && design?.components[component]?.file) || MAIN;
}

/** Whether a pick traces back to a feature in the code. */
export const hasSource = (pick: Pick | undefined) => !!pick && pick.kind !== 'component' && !!featureOfPick(pick);

/** Selects the pick, opens its file and the Source pane, which then reveals the feature that made it. */
export function showInSource(pick: EntityPick) {
  set({ selection: [pick] });
  const file = fileOfPick(pick);
  if (get().doc.kind === 'design' && get().doc.activeFile !== file) openFile(file);
  set({ dockOpen: true, dockTab: 'source' });
}

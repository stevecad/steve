import { get, set, type Pick } from '@/state/store';
import { expandNodes } from '@/state/actions';
import { filesOf } from '@/state/design';
import { componentOfNode } from '@/state/designRefs';
import { unfold } from '@/state/treeOpen';
import { bodiesOfPick, bodyIds, bodyPicks, componentBodyOfPick, designOf } from '@/modeling/bodies';
import { selectBody } from '@/workspaces/design/ItemMenu';
import { viewer } from '@/viewport/viewer';

/** Where a pick shows in the browser: its row's handle, the groups and nodes to unfold above it, and selecting it there. */
interface TreeTarget { item: string; groups: string[]; nodes: string[]; select: () => void }

const selectNodes = (nodes: string[]) => set({ activeFeature: null, selection: nodes.map((node): Pick => ({ kind: 'component', node })) });

/** The nodes above `node` up to (not including) the document. */
function parentsOf(node: string): string[] {
  const { tree, rootId } = get();
  const out: string[] = [];
  for (let id = tree[node]?.parent; id && id !== rootId; id = tree[id]?.parent) out.push(id);
  return out;
}

/** The document's child (a placed instance) that `node` is part of. */
const instanceOf = (node: string) => [node, ...parentsOf(node)].pop()!;

/** A viewport node's own row, in a browser that lists the document's nodes (imported assemblies, parts without bodies). */
function nodeTarget(node: string, group: string): TreeTarget | null {
  const { tree, rootId } = get();
  if (!tree[node] || node === rootId) return null;
  return { item: `node:${node}`, groups: [group], nodes: parentsOf(node), select: () => selectNodes([node]) };
}

/** The browser row for what was picked in the view: a body, a component, a link or a node. Null when it has none. */
export function treeTarget(pick: Pick): TreeTarget | null {
  const state = get();
  const model = viewer.model;
  if (!state.doc.open || !model) return null;
  if (state.doc.kind === 'part') {
    const bodies = state.modeling?.canonical ? bodiesOfPick(pick) : [];
    if (bodies.length === 1) return { item: `body:${bodies[0]}`, groups: ['group:bodies'], nodes: [], select: () => selectBody(bodies[0]) };
    return state.modeling?.canonical && bodyIds(state.displayed).length ? null : nodeTarget(pick.node, 'group:bodies');
  }
  if (state.doc.kind !== 'design') return null;
  const files = filesOf(state.doc);
  if (!Object.keys(files).some((path) => path.startsWith('components/'))) return nodeTarget(pick.node, 'group:components');
  const component = componentOfNode(pick.node);
  if (!component) return null;
  const instance = instanceOf(pick.node);
  if (component in state.doc.links) return { item: `link:${component}`, groups: ['group:links'], nodes: [], select: () => selectNodes([instance]) };
  const file = designOf(state.displayed)?.components[component]?.file;
  if (!file || !(file in files)) return null;
  const row = { item: `component:${component}`, groups: ['group:components'], nodes: [], select: () => selectNodes([instance]) };
  // The body under the cursor, inside its component: editable rows while its file is open, else the component's summary.
  const live = state.doc.activeFile === file && !!state.modeling?.canonical;
  const body = pick.kind === 'component' ? null : live ? bodiesOfPick(pick, model)[0] : componentBodyOfPick(pick, component, model);
  if (!body) return row;
  return {
    item: live ? `body:${body}` : `component-body:${component}:${body}`,
    groups: ['group:components', `component:${file}`, `group:bodies:${component}`],
    nodes: [],
    select: live ? () => selectBody(body) : () => set({ activeFeature: null, selection: bodyPicks(model, [body], component) }),
  };
}

/**
 * "Show in tree": opens the browser at the picked body, component or node, unfolding the groups above it, selects it
 * there and scrolls it into view, so a part found in a big assembly's view is found in its tree too.
 */
export function revealInTree(pick: Pick) {
  const target = treeTarget(pick);
  if (!target) return;
  const done = unfold(target.groups);
  expandNodes(target.nodes);
  set({ browserOpen: true, leftTab: 'model' });
  target.select();
  const selector = `#model-tree [data-item="${CSS.escape(target.item)}"]`;
  const started = performance.now();
  // Groups unfold over ~200 ms (each level after the one above it is drawn): keep the row in view until they settle.
  const follow = () => {
    document.querySelector(selector)?.scrollIntoView({ block: 'center' });
    if (performance.now() - started < 700) requestAnimationFrame(follow);
    else done();
  };
  requestAnimationFrame(follow);
}

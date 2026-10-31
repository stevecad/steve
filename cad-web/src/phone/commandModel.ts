/**
 * What the phone's sheets list, read from the same registry the desktop ribbon draws (commands.ts): the context's
 * ribbon groups for Tools, every command for "All commands", and the view controls the desktop keeps in its viewport
 * toolbar. Nothing here defines a command, so the ribbons stay single-sourced.
 */
import { commands, EXPORT_MENU, RIBBONS, SKETCH_RIBBON, drawingRibbon, motionRibbon, sceneRibbon, sheetMetalRibbon, surfaceRibbon, switchedOff, type Command, type RibbonGroup } from '@/commands';
import { shownTab } from '@/state/designTab';
import type { AppState } from '@/state/store';

/** The ribbon the desktop shows now (shell/Ribbon.tsx): the sketch's while sketching; in Design, its Solid / Sheet metal / Surface / Motion tab. */
export function ribbonGroups(state: AppState): RibbonGroup[] {
  if (state.sketching && !state.sketching.choosing) return SKETCH_RIBBON;
  if (state.workspace !== 'design') return RIBBONS[state.workspace];
  const tab = shownTab(state);
  return tab === 'sheet' ? sheetMetalRibbon : tab === 'surface' ? surfaceRibbon : tab === 'motion' ? motionRibbon : tab === 'drawing' ? drawingRibbon : tab === 'animation' ? sceneRibbon : RIBBONS.design;
}

const CIRCUIT_EXPORTS = ['circuit.export.fabrication', 'circuit.export.step', 'export.source'];

export interface Group { title: string; items: string[] }

/** The shown groups with their shown buttons; a ribbon menu (Primitive, Plane, Export…) lays its items out in place. */
export function toolGroups(state: AppState): Group[] {
  return ribbonGroups(state)
    .filter((group) => !group.visible || group.visible(state))
    .map((group) => ({
      title: group.title,
      items: group.items.flatMap((item) => {
        if (typeof item === 'string') return group.show && !group.show(item, state) ? [] : [item];
        if (item.menu === 'export') return state.doc.open && state.doc.kind === 'circuit' ? CIRCUIT_EXPORTS : EXPORT_MENU;
        return item.items;
      }),
    }))
    .filter((group) => group.items.length > 0);
}

/** Commands people can run here: not hidden, not of a workspace this deployment turned off. */
export const listed = (cmd: Command, state: AppState) => !switchedOff(cmd, state) && !cmd.hidden?.(state);

const CATEGORY_ORDER = ['Document', 'View', 'Display', 'Visibility', 'Inspect', 'Assemble', 'Design', 'Motion', 'Create', 'Modify', 'Construct', 'Sketch',
  'Sheet metal', 'Surface', 'Simulate', 'Manufacture', 'Electronics', 'Export', 'Versions', 'Workspace', 'Tabs', 'App'];

/** Every listed command, by category, for the Tools sheet's "All commands" and its search. */
export function allCommands(state: AppState): { title: string; items: Command[] }[] {
  const byCategory = new Map<string, Command[]>();
  const seen = new Set<string>();
  for (const cmd of commands) {
    if (seen.has(cmd.id) || !listed(cmd, state)) continue;
    seen.add(cmd.id);
    const list = byCategory.get(cmd.category) ?? [];
    list.push(cmd);
    byCategory.set(cmd.category, list);
  }
  const rank = (title: string) => { const index = CATEGORY_ORDER.indexOf(title); return index < 0 ? CATEGORY_ORDER.length : index; };
  return [...byCategory.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([title, items]) => ({ title, items }));
}

/** Search over labels, short labels, descriptions and categories: every word must match somewhere. */
export function search(state: AppState, query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const seen = new Set<string>();
  return commands.filter((cmd) => {
    if (seen.has(cmd.id) || !listed(cmd, state)) return false;
    seen.add(cmd.id);
    const text = `${cmd.label} ${cmd.short ?? ''} ${cmd.description ?? ''} ${cmd.category}`.toLowerCase();
    return words.every((word) => text.includes(word));
  }).sort((a, b) => Number(!a.label.toLowerCase().includes(words[0])) - Number(!b.label.toLowerCase().includes(words[0])));
}

/** The View sheet: what the desktop's viewport toolbar, View cube menu and display commands offer, for looking at a model. */
export const VIEW_GROUPS: Group[] = [
  { title: 'Camera', items: ['view.fit', 'inspect.zoomSelection', 'view.iso', 'view.front', 'view.back', 'view.left', 'view.right', 'view.top', 'view.bottom', 'view.projection'] },
  { title: 'Display', items: ['view.style.shaded-edges', 'view.style.shaded', 'view.style.hidden-line', 'view.style.wireframe', 'view.style.xray'] },
  { title: 'Inspect', items: ['inspect.section', 'inspect.measure', 'assemble.explode', 'visibility.isolate', 'visibility.showAll', 'visibility.toggle'] },
  { title: 'Show', items: ['view.present', 'view.grid', 'view.origin', 'view.shadows', 'export.image', 'app.fullscreen'] },
];

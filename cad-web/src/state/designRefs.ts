/**
 * In-context references in a design: geometry picked on another component is written as
 * `<component>.face("…")` (or edge/vertex) in the component being edited, which imports it
 * (docs/MODELING.md §6). Components are modeled in the design's frame, so the picked geometry is
 * where the runtime finds it (for an instance placed with `at=`, references follow the unplaced
 * component).
 */
import type { Pick } from './store';
import { get } from './store';
import type { DesignResult } from '@/lib/modeling';

/** The component whose file is open, by the components/<id>.py convention. */
export function activeComponent(): string | null {
  const { doc } = get();
  const match = doc.kind === 'design' ? /^components\/([a-z][a-z0-9_]*)\.py$/.exec(doc.activeFile) : null;
  return match ? match[1] : null;
}

/** Which component a displayed node belongs to, from the build's instances. */
export function componentOfNode(node: string): string | null {
  const state = get();
  const design = (state.displayed?.metadata as { modeling?: { design?: DesignResult } } | null | undefined)?.modeling?.design;
  if (!design) return null;
  // The browser shows nodes under friendly names ("blade_2" → "Blade 2"); compare letters and digits only.
  const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = new Map<string, string>();
  for (const item of design.instances) names.set(key(item.name), item.component);
  for (const [id, component] of Object.entries(design.components)) if (!names.has(key(component.name))) names.set(key(component.name), id);
  for (let current: typeof state.tree[string] | undefined = state.tree[node]; current; current = current.parent ? state.tree[current.parent] : undefined) {
    const found = names.get(key(current.name)) ?? names.get(key(current.name.split('/').pop() ?? ''));
    if (found) return found;
  }
  return null;
}

const KIND = { face: 'face', edge: 'edge', vertex: 'vertex' } as const;

/** Python for a picked reference in the open file: a plain string for its own geometry, `<c>.face("…")` for another component's. */
export function refSource(pick: Pick, ref: string): { source: string; component: string | null } {
  const owner = pick.kind === 'component' ? null : componentOfNode(pick.node);
  const own = activeComponent();
  if (!owner || !own || owner === own) return { source: JSON.stringify(ref), component: null };
  const method = pick.kind in KIND ? KIND[pick.kind as keyof typeof KIND] : 'ref';
  return { source: `${owner}.${method}(${JSON.stringify(ref)})`, component: owner };
}

/** `from components.<c> import <c>` added to `code` (after its imports) when it isn't there yet. */
export function withImport(code: string, component: string): string {
  const line = `from components.${component} import ${component}`;
  if (new RegExp(`^\\s*from\\s+components\\.${component}\\s+import\\b`, 'm').test(code)) return code;
  const lines = code.split('\n');
  const last = lines.reduce((found, text, index) => (/^(from|import) /.test(text) ? index : found), -1);
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/**
 * Components a piece of code refers to as `<c>.face(…)` / `.edge(…)` / `.vertex(…)` / `.ref(…)`.
 * String contents don't count: persistent names such as "code_1.face(3)" or "import_1.face(2)" look the same.
 */
export function foreignComponents(text: string, own: string | null): string[] {
  const code = text.replace(/("""|''')[\s\S]*?\1|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '""');
  const found = new Set<string>();
  for (const match of code.matchAll(/\b([a-z][a-z0-9_]*)\.(?:face|edge|vertex|ref)\(/g)) if (match[1] !== own) found.add(match[1]);
  return [...found];
}

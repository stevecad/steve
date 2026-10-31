/**
 * What the code editor shows, whatever the workspace (panels/source/TargetEditor.tsx): the top-level object being worked
 * on there, its files as saved, and the person's unsaved edits to them, kept per object while they switch workspaces and
 * across a reload of the tab. Pure functions (tests/code_target_test.mjs runs them in Node).
 */

export type TargetKind = 'cam' | 'program' | 'shop' | 'study';

/** Unsaved edits to one object: per file, and the revision they were made on. */
export interface Edits { revision: number; files: Record<string, string> }

/** "blocky · CAM program “Top side” · main.py": whose it is, what it is, which file. */
export function headerOf(owner: string | null, label: string, file: string): string {
  return [owner?.trim(), label, file].filter(Boolean).join(' · ');
}

/** What an object of a kind is called in the header. */
export function labelOf(kind: TargetKind, name: string): string {
  const quoted = name.trim() ? ` “${name.trim()}”` : '';
  return kind === 'shop' ? `Shop${quoted}` : kind === 'study' ? `Study${quoted}` : `CAM program${quoted}`;
}

/** Files in the order a person reads them: the main file first, then params.py, then the rest by path. */
export function orderedFiles(files: Record<string, string>, main: string): string[] {
  return Object.keys(files).sort((a, b) => (a === main ? -1 : b === main ? 1 : a === 'params.py' ? -1 : b === 'params.py' ? 1 : a.localeCompare(b)));
}

/** The files with the edits that differ from them: what saving would write (null: nothing edited). */
export function edited(saved: Record<string, string>, edits: Edits | undefined): Record<string, string> | null {
  if (!edits) return null;
  const changed = Object.entries(edits.files).filter(([path, text]) => saved[path] !== text);
  return changed.length ? { ...saved, ...Object.fromEntries(changed) } : null;
}

/** The paths an edit changed. */
export function changedPaths(saved: Record<string, string>, edits: Edits | undefined): string[] {
  return Object.entries(edits?.files ?? {}).filter(([path, text]) => saved[path] !== text).map(([path]) => path);
}

/** One file's text with an edit applied: the edits keep only files that differ from what's saved. */
export function withEdit(edits: Edits | undefined, saved: Record<string, string>, revision: number, path: string, text: string): Edits | undefined {
  const files = { ...(edits?.files ?? {}), [path]: text };
  if (saved[path] === text) delete files[path];
  return Object.keys(files).length ? { revision: edits?.revision ?? revision, files } : undefined;
}

/** Edits made on an older revision than the one saved now: saving them would replace what was saved since. */
export const stale = (edits: Edits | undefined, revision: number) => !!edits && edits.revision !== revision;

/**
 * Unsaved edits read back from this tab's storage (state/codeTargets.ts keeps them across a reload): only well-formed
 * entries, each still on the revision it was made on (a newer saved revision then shows them as stale, never replaces
 * it). Anything unreadable is left out.
 */
export function storedEdits(text: string | null): Record<string, Edits> {
  let value: unknown;
  try { value = JSON.parse(text || 'null'); } catch { return {}; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, Edits> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const { revision, files } = (entry ?? {}) as { revision?: unknown; files?: unknown };
    if (typeof revision !== 'number' || !Number.isInteger(revision) || !files || typeof files !== 'object' || Array.isArray(files)) continue;
    const texts = Object.entries(files as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === 'string');
    if (texts.length) out[key] = { revision, files: Object.fromEntries(texts) };
  }
  return out;
}

import type { WorkspaceEntry } from './current';

/** The roles that may add work to a team's workspace (copy into it, or move out of it). */
export const WRITES: string[] = ['owner', 'admin', 'member'];

/** Where the open document may be copied: Personal (from a team) and the teams where the person may write, never the
 * workspace it's in (teams/CopyDialog.tsx; the server checks the same, app/document_copy.py). */
export function copyTargets(workspaces: WorkspaceEntry[], here: string | null, hereRole: string | null = null): WorkspaceEntry[] {
  // Taking a team's work out of it needs member there (a viewer reads it, but doesn't take it elsewhere).
  if (here !== null && hereRole !== null && !WRITES.includes(hereRole)) return [];
  return workspaces.filter((item) => item.kind === 'personal' ? here !== null : item.workspace_id !== here && WRITES.includes(item.role));
}

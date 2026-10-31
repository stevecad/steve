/**
 * Deep links: the addresses STEVE gives out (MCP results, app/mcp_links.py) and people share.
 *
 *   ?document=<id>[&branch=<name>][&revision=<n>]
 *     [&workspace=design|simulate|manufacture|electronics]
 *     [&study=<id>[&run=<id>]]          a simulation study (and one of its runs) in Simulate
 *     [&program=<id>[&job=<id>]]        a CAM program (and one of its jobs) in Manufacture
 *   ?model=<build id>                   a generated model on its own (boot handles it)
 *   …&team=<team workspace id>          in a team's workspace: taken before boot (teams/current.ts applyTeamParam)
 *
 * Boot opens the document; this applies the rest once it's open. Signed out (oidc), sign-in returns to the same
 * address first (auth.ts).
 */
import { Branches } from '@/lib/branches';
import { get, set, type Workspace } from './store';
import { viewRevision } from './actions';
import { autoInspect } from './layout';

export async function applyLink(params: URLSearchParams) {
  const state = get();
  const id = state.doc.saved?.id;
  if (!id || id !== params.get('document')) return;  // The document didn't open (deleted, no access): nothing to apply.
  const study = params.get('study');
  const program = params.get('program');
  const workspace = (params.get('workspace') ?? (study ? 'simulate' : program ? 'manufacture' : null)) as Workspace | null;
  if (workspace && workspace !== state.workspace && state.workspaces.includes(workspace)) {
    set({ workspace, tool: 'select', measurePicks: [], ...autoInspect() });
  }
  if (study) {
    const { requestRun } = await import('@/workspaces/simulate/state');
    requestRun(params.get('run'));
    set({ activeStudy: study, ...autoInspect() });  // Kept when the design's studies load.
  }
  if (program) {
    const { selectProgram } = await import('@/workspaces/manufacture/state');
    selectProgram(program);
    const job = params.get('job');
    if (job) {
      const [{ jobs }, { selectJob }] = await Promise.all([import('@/workspaces/manufacture/api'), import('@/workspaces/manufacture/cam/state')]);
      try { selectJob(await jobs.get(job)); } catch { /* The program is open; the job may be gone. */ }
    }
  }
  const revision = Number(params.get('revision'));
  if (Number.isInteger(revision) && revision > 0 && revision !== state.doc.saved?.revision) {
    const branch = get().doc.branch;
    try {
      const node = (await Branches.graph(id)).nodes.find((item) => item.branch === branch && item.revision === revision);
      if (node) await viewRevision(node);
    } catch { /* The document is open at its latest revision. */ }
  }
}

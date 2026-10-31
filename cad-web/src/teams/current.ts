/**
 * Which workspace this tab works in: the person's own (Personal) or one of their teams' (docs/TEAMS.md).
 *
 * - Per tab: kept in sessionStorage (a workspace id, not a secret), so two tabs can work in two places at once. A deep
 *   link's `team=<workspace id>` (app/mcp_links.py) chooses it on load and is then taken out of the address.
 * - Every same-origin /v1 request carries it as the `X-Steve-Workspace` header (auth/auth.ts); what can't send headers
 *   (EventSource streams, images, download links, workers) carries `steve_workspace=` in the address instead
 *   (withWorkspace, GET only). The server checks membership and role on every request; this only says what's asked for.
 * - Switching reloads the app in the other workspace (switchWorkspace): nothing open in one workspace carries over to
 *   another, and tabs and unsaved edits are kept per workspace (state/accountStorage.ts keys them by it).
 */
import { create } from 'zustand';

export const HEADER = 'X-Steve-Workspace';
export const QUERY = 'steve_workspace';
const KEY = 'steve.workspace';
const NOTICE = 'steve.workspaceNotice';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TeamRole = 'owner' | 'admin' | 'member' | 'viewer';
export interface WorkspaceEntry { id: string; workspace_id: string; team_id?: string; name: string; kind: 'personal' | 'team'; role: TeamRole }
/** The team this tab works in (null: Personal), and every workspace the person may switch to. */
export const useWorkspace = create<{ team: { workspace: string; teamId: string; name: string; role: TeamRole } | null; workspaces: WorkspaceEntry[] }>(
  () => ({ team: null, workspaces: [] }));

function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

/** The team workspace id this tab asks for, or null for Personal. */
export function selectedWorkspace(): string | null {
  const value = storage()?.getItem(KEY) ?? null;
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

function remember(workspace: string | null) {
  const store = storage();
  if (!store) return;
  try {
    if (workspace) store.setItem(KEY, workspace);
    else store.removeItem(KEY);
  } catch { /* storage off: the tab works in Personal */ }
}

/**
 * Before anything loads: a deep link's `team=<workspace id>` chooses the workspace for this tab; the parameter then
 * leaves the address (the selection lives in the tab, not in links copied from the address bar). Returns the search
 * string without it.
 */
export function takeTeamParam(search: string): { search: string; team: string | null | undefined } {
  const params = new URLSearchParams(search);
  if (!params.has('team')) return { search, team: undefined };
  const value = (params.get('team') ?? '').trim();
  params.delete('team');
  const rest = params.toString();
  return { search: rest ? `?${rest}` : '', team: value === '' || value === 'personal' ? null : UUID.test(value) ? value.toLowerCase() : null };
}

export function applyTeamParam() {
  if (typeof location === 'undefined') return;
  const { search, team } = takeTeamParam(location.search);
  if (team === undefined) return;
  remember(team);
  history.replaceState(history.state, '', location.pathname + search + location.hash);
}

const sameOrigin = (url: URL, origin: string) => url.origin === origin;

/** Whether a request to `url` is one of STEVE's own API requests (same origin, /v1/…): the ones that name a workspace. */
export function isApi(url: string, origin = typeof location === 'undefined' ? 'http://localhost' : location.origin): boolean {
  try {
    const parsed = new URL(url, origin);
    return sameOrigin(parsed, origin) && parsed.pathname.startsWith('/v1/');
  } catch { return false; }
}

/**
 * `url` for a GET that can't send headers (an EventSource, an <img>, a download link, a worker's fetch): with
 * `steve_workspace=<id>` when this tab works in a team. Other addresses, and Personal, come back unchanged.
 */
export function withWorkspace(url: string, workspace: string | null = selectedWorkspace(),
                              origin = typeof location === 'undefined' ? 'http://localhost' : location.origin): string {
  if (!workspace || !url || !isApi(url, origin)) return url;
  const parsed = new URL(url, origin);
  if (parsed.searchParams.has(QUERY)) return url;
  parsed.searchParams.set(QUERY, workspace);
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//');
  return relative ? parsed.pathname + parsed.search + parsed.hash : parsed.href;
}

/** The header for a request (none for Personal). */
export function workspaceHeaders(): Record<string, string> {
  const workspace = selectedWorkspace();
  return workspace ? { [HEADER]: workspace } : {};
}

/** Every EventSource of the app (build, document, simulation and connector streams) asks in this tab's workspace. */
export function installEventSource() {
  if (typeof window === 'undefined' || !window.EventSource) return;
  const Native = window.EventSource;
  if ((Native as unknown as { steveWorkspace?: boolean }).steveWorkspace) return;
  class WorkspaceEventSource extends Native {
    static steveWorkspace = true;
    constructor(url: string | URL, init?: EventSourceInit) { super(withWorkspace(String(url)), init); }
  }
  window.EventSource = WorkspaceEventSource as unknown as typeof EventSource;
}

/**
 * After sign-in, before the account loads (and again after a team change): the person's workspaces, and whether the one
 * this tab asks for is still theirs. A team they left (or that was deleted) puts the tab back in Personal, with a word
 * about it once the app is up; true when that happened (a running app then loads again in Personal).
 */
export async function loadWorkspaces(fetcher: typeof fetch = fetch): Promise<boolean> {
  const wanted = selectedWorkspace();
  let workspaces: WorkspaceEntry[] = [];
  try {
    const response = await fetcher('/v1/teams/workspaces/mine', { headers: { [HEADER]: 'personal' }, cache: 'no-store' });
    if (!response.ok) return false;   // before the terms are accepted, or a server without teams: nothing to offer
    workspaces = ((await response.json()) as { workspaces: WorkspaceEntry[] }).workspaces ?? [];
  } catch { return false; }
  const team = wanted ? workspaces.find((item) => item.kind === 'team' && item.workspace_id === wanted) : undefined;
  if (wanted && !team) {
    remember(null);
    try { storage()?.setItem(NOTICE, '1'); } catch { /* optional */ }
  }
  useWorkspace.setState({ workspaces, team: team ? { workspace: team.workspace_id, teamId: team.team_id ?? '', name: team.name, role: team.role } : null });
  return !!wanted && !team;
}

let leaving = false;
/**
 * The server answered a request made in this tab's team that the team isn't reachable (404 workspace_not_found: the
 * person left or was removed, or 423 workspace_deleting): the tab goes back to Personal, once, with a word about it.
 */
export async function checkStaleWorkspace(response: Response, asked: string | null): Promise<void> {
  if (!asked || asked === 'personal' || leaving || (response.status !== 404 && response.status !== 423)) return;
  if (asked !== selectedWorkspace()) return;
  let code = '';
  try { code = String(((await response.clone().json()) as { detail?: { code?: string } }).detail?.code ?? ''); } catch { return; }
  if (code !== 'workspace_not_found' && code !== 'workspace_deleting') return;
  leaving = true;
  remember(null);
  try { storage()?.setItem(NOTICE, '1'); } catch { /* optional */ }
  if (typeof location !== 'undefined') location.reload();
}

/** Once: the tab had to leave a team it no longer belongs to. */
export function takeWorkspaceNotice(): boolean {
  const store = storage();
  if (!store?.getItem(NOTICE)) return false;
  try { store.removeItem(NOTICE); } catch { /* optional */ }
  return true;
}

/**
 * Works in another workspace (null: Personal): the app loads again there, so nothing of this workspace stays open in
 * the other. `document` opens one of the other workspace's documents.
 */
export function switchWorkspace(workspace: string | null, document?: string, branch?: string) {
  remember(workspace);
  const params = new URLSearchParams();
  if (document) params.set('document', document);
  if (document && branch && branch !== 'main') params.set('branch', branch);
  const query = params.toString();
  location.assign(query ? `/?${query}` : '/');
}

/** A link to a document as the app gives it out: with `team=` when it's a team's, so whoever opens it lands there. */
export function documentLink(documentId: string, workspace: string | null = selectedWorkspace(),
                             origin = typeof location === 'undefined' ? 'http://localhost' : location.origin): string {
  const params = new URLSearchParams({ document: documentId });
  if (workspace) params.set('team', workspace);
  return `${origin}/?${params}`;
}

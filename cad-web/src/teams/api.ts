/** Teams (app/teams.py, docs/TEAMS.md): the same authenticated operations the UI and people's own programs use. */
import type { TeamRole } from './current';
import type { ActivityItem, OpenBranch } from './attribution';

export type { TeamRole };
export interface Team { id: string; workspace_id: string; name: string; version: number; role: TeamRole; mfa_required: boolean; created_at: string }
export interface Member { principal_id: string; display_name: string; role: TeamRole; joined_at: string; email: string | null }
export interface Invitation { id: string; email: string; role: 'member' | 'viewer'; created_at: string; expires_at: string; revoked_at: string | null; accepted_at: string | null }
export interface TeamEvent { id: number; actor_id: string; actor_name: string; action: string; created_at: string; details: Record<string, unknown> }
export interface TeamDetail extends Team { owner_id: string; members: Member[]; invitations: Invitation[]; events: TeamEvent[]; mfa_available: boolean }
export interface TeamList {
  teams: Team[]; personal_workspace: string; verified_email: string; mfa_available: boolean; mfa_acr: string | null;
  mfa_unavailable_reason: string | null; elevated_until: number;
}
export interface Job { id: string; kind: 'export' | 'delete'; status: string; steps: Record<string, string>; created_at: string; finished_at: string | null; expires_at: string | null; error: string | null; size: number | null }
export interface AiClient { client: string; label: string; first_seen: string; last_seen: string; teams: string[] }

export class TeamError extends Error {
  constructor(message: string, public code: string, public status = 0) { super(message); }
}

async function request<T>(path = '', method = 'GET', body?: unknown): Promise<T> {
  // Team management is the person's own business: never asked "in" a team workspace.
  const headers: Record<string, string> = { 'X-Steve-Workspace': 'personal' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`/v1/teams${path}`, { method, cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let result: { detail?: { code?: string; message?: string } | string } | null = null;
  try { result = await response.json(); } catch { /* an empty or unreadable answer */ }
  if (!response.ok) {
    const detail = result?.detail;
    const message = typeof detail === 'object' ? detail?.message : typeof detail === 'string' ? detail : undefined;
    throw new TeamError(message ?? 'The team request failed. Please try again.', typeof detail === 'object' ? detail?.code ?? 'request_failed' : 'request_failed', response.status);
  }
  return result as T;
}

const at = (team: Team) => `/${encodeURIComponent(team.id)}`;

export const teams = {
  list: () => request<TeamList>(),
  get: (id: string) => request<TeamDetail>(`/${encodeURIComponent(id)}`),
  create: (name: string, requestId: string) => request<{ id: string; workspace_id: string }>('', 'POST', { name, request_id: requestId }),
  accept: (token: string) => request<{ id: string; workspace_id: string }>('/accept', 'POST', { token }),
  rename: (team: Team, name: string) => request(at(team), 'PATCH', { name, version: team.version }),
  /** Your own name in the team (what its people and its activity show): only you, in the web app. */
  setName: (team: Team, name: string) => request<{ id: string; name: string }>(`${at(team)}/name`, 'PUT', { name }),
  settings: (team: Team, mfaRequired: boolean) => request(`${at(team)}/settings`, 'PUT', { mfa_required: mfaRequired, version: team.version }),
  invite: (team: Team, email: string, role: 'member' | 'viewer') =>
    request<{ id: string; token: string; link: string; expires_in_seconds: number }>(`${at(team)}/invitations`, 'POST', { email, role, version: team.version }),
  /** What an invitation is for, before accepting (only for the verified email it was made for; nothing is used up). */
  peek: (token: string) => request<{ team_name: string; role: 'member' | 'viewer'; inviter: string; expires_at: string }>('/invitation', 'POST', { token }),
  /** The team's latest changes (who, how, what) and its open branches: any member. */
  activity: (id: string) => request<{ activity: ActivityItem[]; branches: OpenBranch[] }>(`/${encodeURIComponent(id)}/activity`),
  revoke: (team: Team, id: string) => request(`${at(team)}/invitations/${encodeURIComponent(id)}/revoke`, 'POST', { version: team.version }),
  remove: (team: Team, member: string) => request(`${at(team)}/members/${encodeURIComponent(member)}/remove`, 'POST', { version: team.version }),
  role: (team: Team, member: string, role: 'admin' | 'member' | 'viewer') =>
    request(`${at(team)}/members/${encodeURIComponent(member)}`, 'PATCH', { role, version: team.version }),
  transfer: (team: Team, member: string) => request(`${at(team)}/members/${encodeURIComponent(member)}/transfer`, 'POST', { version: team.version }),
  remove_team: (team: Team, confirm: string) => request<Job>(`${at(team)}/delete`, 'POST', { confirm, version: team.version }),
  deletion: (id: string) => request<{ deletion: Job | null }>(`/${encodeURIComponent(id)}/deletion`),
  exports: (team: Team) => request<{ exports: Job[]; days: number }>(`${at(team)}/exports`),
  startExport: (team: Team) => request<Job>(`${at(team)}/exports`, 'POST'),
  exportUrl: (team: Team, job: Job) => `/v1/teams${at(team)}/exports/${encodeURIComponent(job.id)}/download`,
  clients: () => request<{ clients: AiClient[] }>('/clients/ai'),
  setClient: (client: string, teamIds: string[]) => request<{ clients: AiClient[] }>(`/clients/ai/${encodeURIComponent(client)}`, 'PUT', { teams: teamIds }),
};

/** One line of a team's activity (its immutable history), as its owner and admins read it. */
export function describeEvent(event: TeamEvent): string {
  const detail = event.details;
  const member = String(detail.member_name ?? 'a member');
  const confirmed = detail.confirmed === 'mfa' ? ' (confirmed with MFA)' : detail.confirmed === 'web' ? ' (in the web app)' : '';
  switch (event.action) {
    case 'create': return `created ${String(detail.name)}`;
    case 'rename': return `renamed ${String(detail.before)} to ${String(detail.after)}`;
    case 'invite': return `invited ${String(detail.email)} as ${String(detail.role ?? 'member')}`;
    case 'revoke': return `revoked the invitation for ${String(detail.email)}`;
    case 'accept': return `joined the team as ${String(detail.role ?? 'member')}`;
    case 'remove': return `removed ${member}`;
    case 'role': return `changed ${member} from ${String(detail.before)} to ${String(detail.after)}${confirmed}`;
    case 'transfer': return `transferred ownership to ${member}${confirmed}`;
    case 'settings': return `${detail.mfa_required ? 'turned on' : 'turned off'} Require MFA for admin actions${confirmed}`;
    case 'delete': return `deleted the team${confirmed}`;
    case 'name': return detail.new_name ? `changed their name in the team from ${member} to ${String(detail.new_name)}` : 'changed their name in the team';
    default: return 'changed the team';
  }
}

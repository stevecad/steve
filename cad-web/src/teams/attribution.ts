/**
 * Who did something, as people read it (docs/TEAMS.md "Attribution"): the server records each save, branch, merge and
 * comment with the person and how they acted (`via`): the web app, an AI client over MCP, an API key, an app, STEVE.
 * No ids: a name and a way.
 */
export interface Who { name: string; via: string; note?: string }

/** "Alice", "Alice via Claude (MCP)", "Alice via STEVE", "API key ci", "app Bridge". */
export function whoLabel(who: Who | null | undefined): string {
  if (!who?.name) return '';
  const via = (who.via ?? '').trim();
  if (!via || via === 'web') return who.name;
  if (via.startsWith('API key ') || via.startsWith('app ')) return via;
  return `${who.name} via ${via}`;
}

export interface ActivityItem {
  at: string;
  kind: 'save' | 'copy' | 'branch' | 'branch_save' | 'merge' | 'comment' | 'reply' | 'resolved' | string;
  document: { id: string; name: string };
  branch: string | null;
  revision: number | null;
  who: Who | null;
  text?: string;
  comment_id?: string;
  for_agents?: boolean;
  moved?: boolean;
  target_kind?: 'personal' | 'team';
}

export interface OpenBranch {
  document: { id: string; name: string };
  branch: string;
  revision: number;
  updated_at: string | null;
  who: Who | null;
  ahead?: number;
  behind?: number;
  merged?: boolean;
}

const where = (item: ActivityItem) => (item.branch && item.branch !== 'main' ? ` on branch ${item.branch}` : '');
const rev = (item: ActivityItem) => (item.revision ? ` (r${item.revision})` : '');

/** One activity line without its subject: "saved Gripper on branch wider (r3)". */
export function activityText(item: ActivityItem): string {
  const name = item.document.name;
  switch (item.kind) {
    case 'save': return `saved ${name}${rev(item)}`;
    case 'copy_out': return `${item.moved ? 'moved' : 'copied'} ${name} to ${item.target_kind === 'team' ? 'another team' : 'a personal workspace'}`;
    case 'copy': return `added ${name}: ${(item.text ?? '').replace(/^Copied/, 'copied').replace(/^Moved/, 'moved')}`;
    case 'branch': return `started branch ${item.branch} of ${name}`;
    case 'branch_save': return `saved ${name}${where(item)}${rev(item)}`;
    case 'merge': return `merged ${item.branch} into ${name}${rev(item)}`;
    case 'comment': return `${item.for_agents ? 'asked AI agents' : 'commented'} on ${name}${where(item)}`;
    case 'reply': return `replied on ${name}`;
    case 'resolved': return `resolved a comment on ${name}${where(item)}${rev(item)}`;
    default: return `changed ${name}`;
  }
}

/** The whole line: "Alice via Claude (MCP) saved Gripper on branch wider (r3)". */
export function activityLine(item: ActivityItem): string {
  return `${whoLabel(item.who) || 'Someone'} ${activityText(item)}`;
}

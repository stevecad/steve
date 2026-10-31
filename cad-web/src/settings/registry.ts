/**
 * Settings sections, from one registry: each names its group in the nav, its icon, and the panel that edits it.
 * Workbenches add their own (the electronics branch registers an Electronics section) with `registerSection`.
 * `openSettings(id)` opens Settings at a section; commands and buttons elsewhere use it.
 */
import { createElement, lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { create } from 'zustand';
import type { LucideIcon } from 'lucide-react';
import { AppWindow, Bell, BookOpen, Bot, Cpu, MousePointerClick, Cable, Code2, Factory, GitBranch, Info, KeyRound, LayoutGrid, Monitor, Mouse, Network, Package, Plug, Sparkles, UserCog, Users } from 'lucide-react';
import { set as setApp } from '@/state/store';
import { api } from '@/lib/api';
import { useAccount } from '@/auth/auth';
import { docsUrl } from '@/lib/docs';

export type SettingsGroup = 'STEVE' | 'Integrations' | 'Developers' | 'Workspace' | 'General';
export const GROUP_ORDER: SettingsGroup[] = ['STEVE', 'Integrations', 'Developers', 'Workspace', 'General'];

/** Where an integration stands, for its card in Integrations and whether the nav lists it. */
export interface IntegrationStatus { connected: boolean; label: string; attention?: boolean }

export interface SettingsSectionDef {
  id: string;
  label: string;
  /** One line under the title. */
  description: string;
  icon: LucideIcon;
  group: SettingsGroup;
  /** Words people might search for that aren't in the label. */
  keywords?: string[];
  panel: LazyExoticComponent<ComponentType> | ComponentType;
  order: number;
  /** The docs page that explains this section (lib/docs docsUrl), linked from its header. */
  docs?: string;
  /** An integration: a card on the All integrations page (its line and status). */
  integration?: { title?: string; summary: string; status: () => Promise<IntegrationStatus> };
  /** In a team's workspace only its admins manage this (the server refuses others: docs/TEAMS.md): members and viewers
   * see that instead of the section. */
  teamAdmin?: boolean;
}

const sections: SettingsSectionDef[] = [];

export function registerSection(section: SettingsSectionDef) {
  const at = sections.findIndex((item) => item.id === section.id);
  if (at >= 0) sections[at] = section;
  else sections.push(section);
}

export const INTEGRATIONS = 'integrations';

/** Each integration's status, read when Settings opens (and again on the Integrations page). */
export const useIntegrationStatus = create<Record<string, IntegrationStatus>>(() => ({}));
/** Whether this tab works in a team where the person isn't an admin: the team's integrations, devices and keys are its
 * admins' to manage (docs/TEAMS.md), so those sections say so instead. */
export function teamManagedElsewhere(): boolean {
  const role = useAccount.getState().account?.team_role;
  return role === 'member' || role === 'viewer';
}

export async function loadIntegrationStatus() {
  await Promise.all(settingsSections().filter((section) => section.integration).map(async (section) => {
    if (section.teamAdmin && teamManagedElsewhere()) {
      useIntegrationStatus.setState({ [section.id]: { connected: false, label: 'Team admins manage this' } });
      return;
    }
    try { useIntegrationStatus.setState({ [section.id]: await section.integration!.status() }); } catch { /* shown as not connected */ }
  }));
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const localSections = new Set(['local-blender', 'local-git', 'local-updates', 'local-performance', 'local-mcp', 'local-instructions', 'local-skills', 'local-memory', 'steve', 'navigation', 'keyboard', 'display', 'editor', 'about']);
export const settingsSections = () => sections.filter((section) => localSections.has(section.id))
  .map((section) => ({ ...section, docs: docsUrl('local', section.id === 'steve' ? 'assistant' : 'settings') }))
  .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.order - b.order);

registerSection({ id: 'local-performance', label: 'Performance', icon: Cpu, group: 'Workspace', order: 5,
  keywords: ['cpu', 'workers', 'parallel', 'speed', 'memory'], description: 'CPU budget and local CAD workers.',
  panel: lazy(() => import('./sections/LocalPerformance')) });

registerSection({ id: 'steve', label: 'STEVE', icon: Bot, group: 'STEVE', order: 10, keywords: ['api key', 'model', 'limits', 'anthropic', 'openai', 'xai', 'google', 'gemini', 'openrouter', 'cost'],
  description: 'Your ChatGPT subscription, local tools, MCP connections, system prompt, skills and memory.',
  panel: lazy(() => import('./sections/LocalPreferences')) });
const LocalAgentSettings = lazy(() => import('./sections/LocalAgentSettings'));
for (const [id, label, icon, description, order] of [
  ['local-mcp', 'Tools & MCP', Plug, 'Local file access and connected MCP services.', 11],
  ['local-instructions', 'Instructions', Bot, 'System prompt and script execution.', 12],
  ['local-skills', 'Skills', Sparkles, 'Trusted instruction libraries available to Steve.', 13],
  ['local-memory', 'Memory', BookOpen, 'Review and control Steve’s local notes.', 14],
] as const) registerSection({ id, label, icon, description, group: 'STEVE', order,
  panel: () => createElement(LocalAgentSettings, { section: id }) });

registerSection({ id: 'skills', label: 'Skills', icon: Sparkles, group: 'STEVE', order: 20, keywords: ['instructions', 'skill.md'],
  description: 'What STEVE knows how to do: built-in skills you can turn off, and your own.',
  panel: lazy(() => import('./sections/SkillsSection')) });
registerSection({ id: INTEGRATIONS, label: 'All integrations', icon: LayoutGrid, group: 'Integrations', order: 0,
  keywords: ['integration', 'connect', 'erp', 'git', 'mcp', 'fabrication', 'apps'],
  description: 'Connect STEVE to the tools you already use: your git host, your ERP, other MCP servers and AI clients.',
  docs: docsUrl('integrations'),
  panel: lazy(() => import('./sections/IntegrationsSection')) });
registerSection({ id: 'version-control', teamAdmin: true, label: 'Version control', icon: GitBranch, group: 'Integrations', order: 10,
  keywords: ['git', 'github', 'gitlab', 'repository', 'repo', 'version', 'commit', 'push', 'pull', 'backup', 'sync', 'code'],
  description: 'Keep your documents as code in your own git repositories, synced both ways.',
  docs: docsUrl('integrations', 'git'),
  integration: { title: 'Git: GitHub, GitLab', summary: 'GitHub, GitLab or any git host: your documents as code, synced both ways.',
    status: async () => {
      const { repositories } = await api<{ repositories: { status: string; last_error: string | null; problems: unknown[] }[] }>('/v1/git/repositories');
      return { connected: repositories.length > 0, label: repositories.length ? plural(repositories.length, 'repository', 'repositories') : 'Not connected',
               attention: repositories.some((item) => item.last_error || item.problems.length) };
    } },
  panel: lazy(() => import('./sections/VersionControlSection')) });
registerSection({ id: 'carbon', teamAdmin: true, label: 'Carbon', icon: Factory, group: 'Integrations', order: 20,
  keywords: ['erp', 'mes', 'carbon', 'item', 'part number', 'bill of materials', 'bom', 'revision', 'send', 'manufacturing'],
  description: 'Send parts and designs to your Carbon ERP: items, revisions, 3D models, drawings and bills of materials.',
  docs: docsUrl('integrations', 'carbon'),
  integration: { summary: 'Carbon ERP: parts become items with their model, drawing, bill of materials and routing; jobs come back.',
    status: async () => {
      const { connection } = await api<{ connection: { status: string; url: string } | null }>('/v1/carbon');
      return { connected: !!connection, label: connection ? (connection.status === 'error' ? 'Needs a new key' : 'Connected') : 'Not connected',
               attention: connection?.status === 'error' };
    } },
  panel: lazy(() => import('./sections/CarbonSection')) });
registerSection({ id: 'rmfg', teamAdmin: true, label: 'RMFG', icon: Package, group: 'Integrations', order: 25,
  keywords: ['rmfg', 'fabrication', 'sheet metal', 'laser', 'bending', 'tapping', 'powder coat', 'quote', 'order', 'buy', 'cart', 'manufacturing'],
  description: 'Have RMFG make your parts: quotes with manufacturability findings, carts, and purchases only as you allow.',
  docs: docsUrl('integrations', 'rmfg'),
  integration: { summary: 'RMFG: laser-cut, bent, tapped and powder-coated sheet metal and tube, quoted from your part and ordered.',
    status: async () => {
      const { connection } = await api<{ connection: { status: string } | null }>('/v1/rmfg');
      return { connected: !!connection, label: connection ? (connection.status === 'active' ? 'Connected' : 'Sign in again') : 'Not connected',
               attention: !!connection && connection.status !== 'active' };
    } },
  panel: lazy(() => import('./sections/RmfgSection')) });
registerSection({ id: 'mcp-servers', teamAdmin: true, label: 'MCP servers', icon: Network, group: 'Integrations', order: 30,
  keywords: ['mcp', 'server', 'tools', 'erp', 'carbon', 'integration', 'connect', 'oauth', 'remote', 'outside'],
  description: 'Connect other MCP servers (your ERP, a vendor’s tools, your own) for STEVE and your AI tools to use.',
  docs: docsUrl('integrations', 'mcp-servers'),
  integration: { summary: 'Other products’ MCP tools, for STEVE’s assistant and the AI tools you connect to STEVE.',
    status: async () => {
      const { servers } = await api<{ servers: { status: string }[] }>('/v1/mcp-servers');
      return { connected: servers.length > 0, label: servers.length ? plural(servers.length, 'server') : 'Not connected',
               attention: servers.some((item) => item.status !== 'active') };
    } },
  panel: lazy(() => import('./sections/McpServersSection')) });
registerSection({ id: 'mcp', label: 'MCP', icon: Plug, group: 'STEVE', order: 15, keywords: ['agents', 'claude', 'chatgpt', 'codex', 'tools', 'connect', 'ai clients'],
  description: 'Connect Claude, ChatGPT, Codex or any MCP client to your designs, and choose which tools they can use.',
  docs: docsUrl('agents'),
  integration: { title: 'AI clients (MCP)', summary: 'Claude, ChatGPT, Codex or any MCP client designing in STEVE as you.',
    status: async () => {
      const { connections } = await api<{ connections: unknown[] }>('/v1/oauth/connections');
      return { connected: connections.length > 0, label: connections.length ? plural(connections.length, 'app') + ' connected' : 'Not connected' };
    } },
  panel: lazy(() => import('./sections/McpSection')) });
registerSection({ id: 'developers', teamAdmin: true, label: 'Steve API', icon: KeyRound, group: 'Developers', order: 10, keywords: ['api', 'api key', 'service account', 'integration', 'sdk', 'rest', 'token', 'developers', 'webhooks', 'apps'],
  description: 'Keys for your own software to use the Steve API, and what they did.',
  docs: docsUrl('developers', 'steve-api'),
  panel: lazy(() => import('./sections/DevelopersSection')) });
registerSection({ id: 'connectors', teamAdmin: true, label: 'Connectors', icon: Cable, group: 'Developers', order: 20,
  keywords: ['machine', 'cnc', 'printer', 'robot', 'simulation', 'erp', 'action', 'run', 'pair', 'shop', 'g-code', 'send', 'local'],
  description: 'Your own software on your network: the actions it offers STEVE, who may run them, and what they did.',
  docs: docsUrl('developers', 'connectors'),
  panel: lazy(() => import('./sections/ConnectorsSection')) });
registerSection({ id: 'quick-button', label: 'Quick button', icon: MousePointerClick, group: 'Workspace', order: 5,
  keywords: ['toolbar', 'top bar', 'export', 'shortcut', 'button', 'action', 'connector', 'customize'],
  description: 'The split button at the top right: choose its items and the main one.',
  panel: lazy(() => import('./sections/QuickButtonSection')) });
registerSection({ id: 'keyboard', label: 'Keyboard shortcuts', icon: KeyRound, group: 'Workspace', order: 11,
  keywords: ['fusion', 'solidworks', 'keys', 'bindings', 'presets'], description: 'Familiar CAD shortcuts, tailored to the way you work.',
  panel: lazy(() => import('./sections/KeyboardSection')) });
registerSection({ id: 'navigation', label: 'Navigation', icon: Mouse, group: 'Workspace', order: 10, keywords: ['zoom', 'orbit', 'pan', 'wheel', 'spacemouse', '3dconnexion', 'mouse'],
  description: 'How the mouse, trackpad and SpaceMouse move the view.',
  panel: lazy(() => import('./sections/NavigationSection')) });
registerSection({ id: 'display', label: 'Display', icon: Monitor, group: 'Workspace', order: 20, keywords: ['grid', 'shadows', 'perspective', 'orthographic', 'wireframe', 'style'],
  description: 'How a model looks when it opens. The view bar still changes it for the moment.',
  panel: lazy(() => import('./sections/DisplaySection')) });
registerSection({ id: 'editor', label: 'Code editor', icon: Code2, group: 'Workspace', order: 30, keywords: ['source', 'font', 'live', 'auto build', 'rebuild'],
  description: 'The Source panel: building as you type and the text size.',
  panel: lazy(() => import('./sections/EditorSection')) });
registerSection({ id: 'notifications', label: 'Notifications', icon: Bell, group: 'General', order: 10, keywords: ['reports', 'bug', 'alerts'],
  description: 'What STEVE tells you about while you work.',
  panel: lazy(() => import('./sections/NotificationsSection')) });
registerSection({ id: 'teams', label: 'Teams', icon: Users, group: 'General', order: 15,
  keywords: ['team', 'company', 'members', 'invite', 'invitation', 'roles', 'admin', 'viewer', 'workspace', 'organization', 'mfa'],
  description: 'Work together in a team’s own workspace: create a team, invite people, roles, and which AI clients may work there.',
  docs: docsUrl('collaborate', 'teams'),
  panel: lazy(() => import('./sections/TeamsSection')) });
registerSection({ id: 'connected-apps', label: 'Connected apps', icon: AppWindow, group: 'General', order: 20, keywords: ['oauth', 'apps', 'integrations', 'disconnect', 'authorized'],
  description: 'Apps you allowed to work in your workspace, and disconnecting them.',
  panel: lazy(() => import('./sections/ConnectedAppsSection')) });
registerSection({ id: 'account', label: 'Account', icon: UserCog, group: 'General', order: 30, keywords: ['download', 'export', 'data', 'delete', 'account', 'gdpr', 'privacy', 'close'],
  description: 'Download all your data, or delete your account.',
  docs: docsUrl('start', 'your-data'),
  panel: lazy(() => import('./sections/AccountSection')) });
registerSection({ id: 'about', label: 'About', icon: Info, group: 'General', order: 90, keywords: ['version', 'license', 'credits', 'cadquery'],
  description: 'Steve and the open-source engines behind its local CAD tools.',
  panel: lazy(() => import('./sections/AboutSection')) });

export const useSettingsDialog = create<{ section: string }>(() => ({ section: 'steve' }));

/** Opens Settings (at a section). */
export function openSettings(section?: string) {
  if (section && !localSections.has(section)) section = 'steve';
  if (section) useSettingsDialog.setState({ section });
  setApp({ dialog: 'settings' });
}

export interface EngineCredit { name: string; href: string | (() => string); credit: ReactNode; license: string; version?: () => string | null }

/** STEVE's CadQuery fork, at the commit the runtime runs (its build metadata), or the fork's branch for builds that don't say. */
export const CADQUERY_FORK = 'https://github.com/10-X-eng/cadquery';
export function cadquerySourceHref(source?: { url?: string; commit?: string } | null) {
  if (source?.url && source.commit && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(source.url) && /^[0-9a-f]{40}$/.test(source.commit)) {
    return `${source.url}/tree/${source.commit}`;
  }
  return `${CADQUERY_FORK}/tree/steve`;
}
const credits: EngineCredit[] = [];
/** Open-source engines credited in About (CadQuery; workbenches add theirs). */
export function registerCredit(credit: EngineCredit) {
  if (!credits.some((item) => item.name === credit.name)) credits.push(credit);
}
export const engineCredits = () => [...credits];

registerSection({ id: 'local-git', label: 'Version control', icon: GitBranch, group: 'Workspace', order: 6, description: 'Connect your CAD source to GitHub, GitLab or another Git host.', panel: lazy(() => import('./sections/LocalGitSettings')) });

registerSection({ id: 'local-updates', label: 'Updates', icon: Package, group: 'General', order: 2, description: 'Signed releases, update channels and automatic installation.', panel: lazy(() => import('./sections/LocalUpdateSettings')) });

registerSection({ id: 'local-blender', label: 'Blender', icon: Package, group: 'Workspace', order: 7, description: 'Local scene building and rendering on Windows and Linux.', panel: lazy(() => import('./sections/LocalBlender')) });

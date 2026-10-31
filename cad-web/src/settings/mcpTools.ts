/**
 * The tools AI agents may use over MCP, grouped by workbench (`GET /v1/mcp/tools`), and turning them on and off: the
 * account's `mcp.disabledTools` setting, for STEVE in the app and connected AI tools alike. Tools that start off
 * (`default_off`) are turned on in `mcp.enabledTools` instead. Groups whose workspace is off
 * on this server can't be turned on; essential tools (an agent can't do anything useful without them) can't be turned off.
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import { setting, updateSettings } from './store';

export interface McpTool {
  name: string; title?: string | null; description: string; essential: boolean; enabled: boolean;
  /** What STEVE can't do without it ("build models"): turning it off warns. */
  core?: string | null;
  /** Starts off for everyone (a niche tool); turning it on is the person's choice. */
  default_off?: boolean;
  /** Only this kind of agent can use it at all. */
  only?: 'steve' | 'external' | null;
}
export interface McpToolGroup {
  id: string;
  title: string;
  description: string;
  workspace: 'design' | 'simulate' | 'manufacture' | 'electronics' | null;
  available: boolean;
  /** Why the group isn't available, in plain words. */
  reason?: string | null;
  tools: McpTool[];
}

/** `savedAt`: when a change last saved (the page says so once for a run of changes, then hides it). */
interface ToolsState { groups: McpToolGroup[] | null; error: string | null; loading: boolean; savedAt: number | null }
export const useMcpTools = create<ToolsState>(() => ({ groups: null, error: null, loading: false, savedAt: null }));
/** How long “Saved. Start a new session…” stays after the last change. */
export const SAVED_SHOWN_MS = 6000;

/** Asks the server which tools exist and which are on for this account. */
export async function loadMcpTools() {
  useMcpTools.setState({ loading: true, error: null });
  try {
    const reply = await api<{ groups: McpToolGroup[] }>('/v1/mcp/tools');
    useMcpTools.setState({ groups: reply.groups, loading: false });
  } catch (error) {
    useMcpTools.setState({ loading: false, error: error instanceof Error ? error.message : 'The tool list couldn’t be loaded.' });
  }
}

/** Shows a change at once (the list and the settings), then saves it: `mcp.disabledTools` holds the tools turned off,
 *  `mcp.enabledTools` the default-off tools turned on. */
async function apply(changes: Map<string, boolean>) {
  const groups = useMcpTools.getState().groups;
  if (!groups) return;
  const startsOff = new Set(groups.flatMap((group) => group.tools).filter((tool) => tool.default_off).map((tool) => tool.name));
  const disabled = new Set(setting('mcp.disabledTools'));
  const enabled = new Set(setting('mcp.enabledTools'));
  for (const [name, on] of changes) {
    if (startsOff.has(name)) { disabled.delete(name); if (on) enabled.add(name); else enabled.delete(name); }
    else if (on) disabled.delete(name);
    else disabled.add(name);
  }
  useMcpTools.setState({
    groups: groups.map((group) => ({ ...group, tools: group.tools.map((tool) => (changes.has(tool.name) ? { ...tool, enabled: changes.get(tool.name)! } : tool)) })),
  });
  const wanted = { 'mcp.disabledTools': [...disabled].sort(), 'mcp.enabledTools': [...enabled].sort() };
  await updateSettings(wanted);
  // A refused save is put back (and says why); only a save that stuck says "Saved".
  const kept = JSON.stringify([setting('mcp.disabledTools'), setting('mcp.enabledTools')]) === JSON.stringify([wanted['mcp.disabledTools'], wanted['mcp.enabledTools']]);
  if (kept) useMcpTools.setState({ savedAt: Date.now() });
  void loadMcpTools();  // The server's word on what's on (it ignores essential tools).
}

export function setToolEnabled(name: string, on: boolean) {
  return apply(new Map([[name, on]]));
}

/** Every tool of a group on or off (essential tools stay on). */
export function setGroupEnabled(group: McpToolGroup, on: boolean) {
  return apply(new Map(group.tools.filter((tool) => !tool.essential).map((tool) => [tool.name, on])));
}

export const groupState = (group: McpToolGroup): 'on' | 'off' | 'some' => {
  const on = group.tools.filter((tool) => tool.enabled).length;
  return on === group.tools.length ? 'on' : on === 0 || group.tools.every((tool) => tool.enabled === tool.essential) ? 'off' : 'some';
};

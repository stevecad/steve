/**
 * Settings → MCP: connect an AI tool, and choose which of STEVE's tools agents can use, grouped by workbench.
 * The choice applies to STEVE in the app and to connected AI tools (app/assistant_tools.py, app/mcp_tool_settings.py).
 * Turning off a tool STEVE relies on for core work warns, without stopping anyone.
 */
import { useEffect, useMemo, useState } from 'react';
import { Box, Check, ChevronRight, CircuitBoard, Factory, FlaskConical, Lock, MessageSquare, Package, Power, RefreshCw, Search, Sparkles, ToggleRight, TriangleAlert, Wrench } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button, Spinner, Switch, Tip } from '@/ui';
import { settingsSections } from '../registry';
import { Card, SettingsPage } from '../ui';
import { groupState, loadMcpTools, SAVED_SHOWN_MS, setGroupEnabled, setToolEnabled, useMcpTools, type McpToolGroup } from '../mcpTools';
import { McpConnect } from './McpConnect';
import styles from '../Settings.module.css';

/** By group id (app/mcp_tool_settings.py), then by workspace. */
const ICONS: Record<string, LucideIcon> = {
  designs: Box, design: Box, parts: Package, comments: MessageSquare, simulation: FlaskConical, simulate: FlaskConical,
  manufacturing: Factory, manufacture: Factory, electronics: CircuitBoard, help: Sparkles,
};
const iconOf = (group: McpToolGroup) => ICONS[group.id] ?? (group.workspace ? ICONS[group.workspace] : undefined) ?? Wrench;

function Group({ group, query }: { group: McpToolGroup; query: string }) {
  const [open, setOpen] = useState(false);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const tools = words.length ? group.tools.filter((tool) => words.every((word) => `${tool.name} ${tool.title ?? ''} ${tool.description}`.toLowerCase().includes(word))) : group.tools;
  if (words.length && !tools.length) return null;
  const expanded = open || words.length > 0;
  const state = groupState(group);
  const on = group.tools.filter((tool) => tool.enabled).length;
  const Icon = iconOf(group);
  const toggleable = group.available && group.tools.some((tool) => !tool.essential);
  // Core tools turned off: STEVE can't do part of its work (said on the group while it's closed).
  const lost = [...new Set(group.tools.filter((tool) => tool.core && !tool.enabled && group.available).map((tool) => tool.core!))];
  return (
    <div className={styles.group} data-group={group.id} data-open={expanded || undefined} data-on={(group.available && state !== 'off') || undefined} data-available={group.available}>
      <div className={styles.groupHead}>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={expanded} aria-controls={`mcp-tools-${group.id}`}>
          <span className={styles.groupIcon}><Icon size={15} /></span>
          <span className={styles.groupText}>
            <b>{group.title}</b>
            <small>{group.description}</small>
          </span>
        </button>
        {!group.available ? (
          <Tip label="Not available on this server" description={group.reason ?? 'This workbench is turned off on this server, so its tools are hidden from every agent.'}>
            <span className={styles.unavailable}>Not available on this server</span>
          </Tip>
        ) : (
          <>
            <span className={styles.count}><b>{on}</b> of {group.tools.length} on</span>
            {toggleable && <Switch checked={state !== 'off'} onCheckedChange={(next) => void setGroupEnabled(group, next)} label={`${group.title}: all tools`} />}
          </>
        )}
        <ChevronRight size={15} className={styles.chev} onClick={() => setOpen(!open)} />
      </div>
      {lost.length > 0 && !expanded && (
        <p className={styles.coreWarning} data-core-warning={group.id} role="status"><TriangleAlert size={12} />STEVE won’t be able to {lost.join(' or ')} with these off.</p>
      )}
      {expanded && (
        <div className={styles.tools} id={`mcp-tools-${group.id}`}>
          {tools.map((tool) => (
            <div key={tool.name} className={styles.tool} data-tool={tool.name} data-enabled={tool.enabled || undefined}>
              <div>
                <div className={styles.toolName}><code>{tool.name}</code>{tool.essential && (
                  <Tip label="Always on" description="Agents need this one to find and read your designs, so it can’t be turned off.">
                    <span className={styles.lock}><Lock size={10} />Essential</span>
                  </Tip>
                )}{tool.default_off && (
                  <Tip label="Starts off" description="Niche tools start off, so agents choose well among fewer tools. Turn it on if you want it.">
                    <span className={styles.badge} data-default-off>Starts off</span>
                  </Tip>
                )}{tool.only && (
                  <span className={styles.lock} data-only={tool.only}>{tool.only === 'steve' ? 'STEVE in the app only' : 'Connected AI tools only'}</span>
                )}</div>
                <p>{tool.title && tool.title !== tool.name ? <><b>{tool.title}.</b> </> : null}{tool.description}</p>
                {tool.core && !tool.enabled && group.available && (
                  <p className={styles.coreWarning} data-core-warning={tool.name} role="status"><TriangleAlert size={12} />STEVE won’t be able to {tool.core} without this.</p>
                )}
              </div>
              <Switch checked={tool.enabled} disabled={tool.essential || !group.available} onCheckedChange={(next) => void setToolEnabled(tool.name, next)} label={tool.name} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** What the switches do, what starts off, and that AI clients load the list when they connect. */
function Guide() {
  return (
    <ul className={styles.mcpGuide} id="mcp-guide">
      <li><ToggleRight size={15} /><span>The switches choose which of STEVE’s tools <b>STEVE in the app</b> and your <b>connected AI agents</b> can use. Fewer tools help agents choose well.</span></li>
      <li><Power size={14} /><span>Some tools <b>start off</b> and are marked that way. Turn them on to use them.</span></li>
      <li><RefreshCw size={14} /><span>After a change, <b>start a new session</b> in your AI client or reconnect it: clients load the tool list when they connect.</span></li>
    </ul>
  );
}

/** Where AI clients keep their own say over STEVE's tools (each line from the client's own documentation). */
function ClientHelp() {
  return (
    <details className={styles.mcpHelp} id="mcp-help">
      <summary><ChevronRight size={14} className={styles.chev} />Not seeing a tool in your AI client?</summary>
      <div className={styles.mcpHelpBody}>
        <p>STEVE offers the tools that are on here; your AI client decides which ones it loads. Check it’s signed in to this same STEVE account, then:</p>
        <dl>
          <dt>Codex (CLI, IDE extension, ChatGPT desktop app)</dt>
          <dd>They share <code>~/.codex/config.toml</code>. If STEVE’s <code>[mcp_servers.&lt;name&gt;]</code> entry has an <code>enabled_tools</code> list, only those tools load: add the tool or remove the list (<code>disabled_tools</code> hides tools too). Type <code>/mcp</code> in Codex, or run <code>codex mcp list</code>, to see its servers.</dd>
          <dt>Claude (claude.ai and Claude Desktop)</dt>
          <dd>Turn the STEVE connector on for the chat from <b>+</b> → <b>Connectors</b>. Tools turned off in the chat’s <b>Search and tools</b> menu aren’t used.</dd>
          <dt>ChatGPT</dt>
          <dd>Open the STEVE connection in ChatGPT’s <b>Plugins</b>, select <b>Refresh</b>, then start a new conversation.</dd>
          <dt>Cursor</dt>
          <dd>Open <b>Customize</b>: STEVE’s server must be on, and the tool listed under <b>Available Tools</b>. If it isn’t, restart Cursor.</dd>
        </dl>
      </div>
    </details>
  );
}

/** “Saved” after a change, once for a run of changes (it stays while they keep coming), then gone. */
function SavedHint() {
  const savedAt = useMcpTools((state) => state.savedAt);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!savedAt) return;
    setShown(true);
    const timer = window.setTimeout(() => setShown(false), SAVED_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [savedAt]);
  return (
    <p className={styles.savedHint} id="mcp-saved" role="status" data-shown={shown || undefined}>
      {shown && <><Check size={13} />Saved. Start a new session in your AI client to pick this up.</>}
    </p>
  );
}

export default function McpSection() {
  const section = settingsSections().find((item) => item.id === 'mcp')!;
  const { groups, error, loading } = useMcpTools();
  const [query, setQuery] = useState('');
  useEffect(() => { void loadMcpTools(); }, []);
  const totals = useMemo(() => {
    const available = (groups ?? []).filter((group) => group.available).flatMap((group) => group.tools);
    return { on: available.filter((tool) => tool.enabled).length, all: available.length };
  }, [groups]);
  return (
    <SettingsPage section={section}>
      <Card title="Connect an AI tool" id="mcp-connection" description="Claude, ChatGPT, Codex or any MCP client. It signs in as you and works in your own workspace.">
        <McpConnect />
      </Card>
      <Card title="Tools agents can use" id="mcp-tools">
        <Guide />
        <ClientHelp />
        <div className={styles.toolsBar}>
          <div className={styles.toolSearch}>
            <Search size={13} />
            <input type="search" placeholder="Search tools" aria-label="Search tools" value={query} onChange={(event) => setQuery(event.target.value)} id="mcp-tool-search" />
          </div>
          {groups && <span className={styles.count} id="mcp-tool-count"><b>{totals.on}</b> of {totals.all} tools on</span>}
        </div>
        <SavedHint />
        {error && (
          <p className={styles.note} data-tone="warning">{error} <Button size="sm" onClick={() => void loadMcpTools()}>Try again</Button></p>
        )}
        {!groups && loading && <div className={styles.loading} style={{ padding: 24 }}><Spinner size={16} /></div>}
        {groups?.map((group) => <Group key={group.id} group={group} query={query} />)}
        {groups && <div style={{ height: 8 }} />}
      </Card>
    </SettingsPage>
  );
}


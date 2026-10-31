/**
 * Settings → MCP servers (app/mcp_servers.py): other MCP servers the person connects (their ERP, a vendor's tools, their
 * own), whose tools STEVE's assistant and the MCP clients connected to STEVE then use. A server is connected by its
 * address, with a key or through its own sign-in (STEVE opens it, and finishes here on return). A tool that changes
 * things waits for the person's confirmation here (and in the top bar's "waiting" button), unless they chose otherwise.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Network, RefreshCw, X } from 'lucide-react';
import { Button, Select, Spinner } from '@/ui';
import { api, json } from '@/lib/api';
import { askConfirm } from '@/ui/confirm';
import { usePendingRuns } from '@/lib/pendingRuns';
import { settingsSections } from '../registry';
import { Card, Note, SettingsPage } from '../ui';
import own from './Developers.module.css';

type Ask = 'changes' | 'always' | 'never';
interface Tool { name: string; title: string; description: string; read_only: boolean }
interface Server {
  id: string; name: string; url: string; auth: 'none' | 'key' | 'oauth'; status: 'active' | 'needs_sign_in' | 'error';
  key_hint: string | null; ask: Ask; last_error: string | null; server: string | null; tools_at: string | null; tools: Tool[];
}
export interface OutsideCall {
  id: string; server: string | null; tool: string; state: string; arguments: Record<string, unknown>; note: string | null;
  asked_by: string; created_at: string; error?: string;
}

const ASKS: { value: Ask; label: string }[] = [
  { value: 'changes', label: 'Ask before changes' }, { value: 'always', label: 'Ask every time' }, { value: 'never', label: 'Never ask' }];
const ASKED_BY: Record<string, string> = { assistant: 'STEVE', agent: 'an AI agent' };
const STATUS: Record<Server['status'], string> = { active: 'Connected', needs_sign_in: 'Needs you to sign in', error: 'Not working' };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Back from a server's sign-in (main.tsx kept its return): finishes it, signed in. */
async function finishSignIn(): Promise<string | null> {
  let kept: string | null = null;
  try { kept = sessionStorage.getItem('steve.mcpConnect'); sessionStorage.removeItem('steve.mcpConnect'); } catch { return null; }
  if (!kept) return null;
  const params = new URLSearchParams(kept);
  await api('/v1/mcp-servers/finish', json('POST', { state: params.get('state') ?? '', code: params.get('code'), error: params.get('error') }));
  return 'Signed in.';
}

function Connect({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const made = await api<{ sign_in_url?: string }>('/v1/mcp-servers', json('POST', { url: url.trim(), name: name.trim() || null, key: key.trim() || null }));
      setKey('');
      if (made.sign_in_url) { window.location.assign(made.sign_in_url); return; }
      onDone();
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return (
    <div className={own.form} id="mcp-connect">
      <div>
        <span className={own.label}>Server address</span>
        <input className={own.input} value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" id="mcp-url" aria-label="Server address" />
      </div>
      <div className={own.actions}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <span className={own.label}>Name</span>
          <input className={own.input} value={name} onChange={(event) => setName(event.target.value)} placeholder="from its address" id="mcp-name" aria-label="Name" />
        </div>
        <div style={{ flex: 2, minWidth: 200 }}>
          <span className={own.label}>Key</span>
          <input className={own.input} type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)}
                 placeholder="only if the server gave you one" id="mcp-key" aria-label="Key" />
        </div>
      </div>
      <Note>Without a key, STEVE opens the server's own sign-in when it asks for one. STEVE keeps keys and sign-ins encrypted and sends them only to that server.</Note>
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="primary" icon={busy ? <Spinner size={12} /> : <Network size={14} />} disabled={busy || !url.trim().startsWith('https://')} onClick={() => void connect()} id="mcp-connect-button">Connect</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function ServerRow({ server, onChange }: { server: Server; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await run(); onChange(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const signIn = () => act(async () => {
    window.location.assign((await api<{ sign_in_url: string }>(`/v1/mcp-servers/${server.id}/sign-in`, { method: 'POST' })).sign_in_url);
  });
  const changes = server.tools.filter((tool) => !tool.read_only).length;
  return (
    <div className={own.key} data-mcp-server={server.name}>
      <div>
        <b>{server.name}</b> <span>· {host(server.url)}{server.server ? ` · ${server.server}` : ''}</span>
        <p>{STATUS[server.status]}{server.status === 'active' ? ` · ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}${changes ? `, ${changes} that may change things` : ''}` : ''}
          {server.auth === 'key' ? ` · key …${server.key_hint}` : server.auth === 'oauth' ? ' · signed in at the server' : ''}</p>
        {server.status !== 'active' && server.last_error && <Note tone="warning">{server.last_error}</Note>}
        {server.tools.length > 0 && (
          <details>
            <summary className={own.label} style={{ cursor: 'pointer', marginTop: 4 }}>Tools</summary>
            <ul className={own.recent} style={{ fontFamily: 'inherit' }}>
              {server.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code>{tool.read_only ? ' (reads only)' : ''}{tool.description ? ` — ${tool.description.slice(0, 140)}` : ''}</li>)}
            </ul>
          </details>
        )}
        {key !== null && (
          <div className={own.actions}>
            <input className={own.input} type="password" autoComplete="off" value={key} placeholder="New key" style={{ flex: 1, minWidth: 220 }}
                   onChange={(event) => setKey(event.target.value)} aria-label="New key" />
            <Button size="sm" variant="primary" disabled={key.trim().length < 8 || busy}
                    onClick={() => void act(() => api(`/v1/mcp-servers/${server.id}`, json('PATCH', { key: key.trim() }))).then(() => setKey(null))}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setKey(null)}>Cancel</Button>
          </div>
        )}
        {error && <Note tone="warning">{error}</Note>}
      </div>
      <div className={own.actions}>
        {server.status === 'needs_sign_in' && <Button size="sm" variant="primary" disabled={busy} onClick={() => void signIn()}>Sign in</Button>}
        <Select value={server.ask} ariaLabel="When STEVE asks you" options={ASKS}
                onChange={(value) => void act(() => api(`/v1/mcp-servers/${server.id}`, json('PATCH', { ask: value })))} />
        <Button size="sm" variant="ghost" icon={busy ? <Spinner size={12} /> : <RefreshCw size={13} />} disabled={busy}
                onClick={() => void act(() => api(`/v1/mcp-servers/${server.id}/refresh`, { method: 'POST' }))}>Check</Button>
        {server.auth === 'key' && key === null && <Button size="sm" variant="ghost" onClick={() => setKey('')}>Change key</Button>}
        <Button size="sm" variant="ghost" onClick={() => void (async () => {
          if (await askConfirm({ title: `Remove ${server.name}?`, detail: 'STEVE forgets this server, its sign-in and its calls. Nothing changes on the server.', action: 'Remove' })) {
            await act(() => api(`/v1/mcp-servers/${server.id}`, { method: 'DELETE' }));
          }
        })()}>Remove</Button>
      </div>
    </div>
  );
}

/** A call someone asked for that waits for the person: what, by whom, with what arguments; confirm or cancel. */
export function WaitingCall({ call, onChange }: { call: OutsideCall; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (choice: 'confirm' | 'cancel') => {
    setBusy(true); setError(null);
    try { await api(`/v1/mcp-servers/calls/${call.id}/${choice}`, { method: 'POST' }); onChange(); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return (
    <div className={own.key} data-outside-call={call.id}>
      <div>
        <b>{call.server} · {call.tool}</b> <span>· asked by {ASKED_BY[call.asked_by] ?? call.asked_by}</span>
        {call.note && <p>{call.note}</p>}
        <details>
          <summary className={own.label} style={{ cursor: 'pointer', marginTop: 4 }}>What it sends</summary>
          <pre className={own.recent}>{JSON.stringify(call.arguments, null, 2)}</pre>
        </details>
        {error && <Note tone="warning">{error}</Note>}
      </div>
      <div className={own.actions}>
        <Button size="sm" variant="primary" icon={busy ? <Spinner size={12} /> : <Check size={13} />} disabled={busy} onClick={() => void decide('confirm')}>Confirm</Button>
        <Button size="sm" variant="ghost" icon={<X size={13} />} disabled={busy} onClick={() => void decide('cancel')}>Cancel</Button>
      </div>
    </div>
  );
}

export default function McpServersSection() {
  const section = settingsSections().find((item) => item.id === 'mcp-servers')!;
  const [servers, setServers] = useState<Server[] | null>(null);
  const [waiting, setWaiting] = useState<OutsideCall[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [finishing, setFinishing] = useState(() => { try { return Boolean(sessionStorage.getItem('steve.mcpConnect')); } catch { return false; } });
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshPending = usePendingRuns((state) => state.refresh);
  const load = useCallback(async () => {
    try {
      const made = await api<{ servers: Server[]; waiting: OutsideCall[] }>('/v1/mcp-servers');
      setServers(made.servers); setWaiting(made.waiting); setError(null);
    } catch (failure) { setError(message(failure)); }
    void refreshPending();
  }, [refreshPending]);
  useEffect(() => {
    void finishSignIn().then((done) => { if (done) setNote(done); }, (failure) => setError(message(failure))).finally(() => { setFinishing(false); void load(); });
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  return (
    <SettingsPage section={section} id="settings-mcp-servers">
      {waiting.length > 0 && (
        <Card title="Waiting for you" description="Calls to tools that may change things on a server. Nothing is sent until you confirm." id="mcp-waiting">
          {waiting.map((call) => <WaitingCall key={call.id} call={call} onChange={() => void load()} />)}
        </Card>
      )}
      <Card title="Servers" description="Their tools are STEVE's to use, in the app and from the AI tools you connect to STEVE."
            actions={!connecting && !finishing && <Button size="sm" variant="primary" icon={<Network size={14} />} id="mcp-add" onClick={() => setConnecting(true)}>Connect a server</Button>}>
        {finishing && <Note><Spinner size={12} /> Finishing the sign-in…</Note>}
        {note && <Note>{note}</Note>}
        {connecting && <Connect onDone={() => { setConnecting(false); void load(); }} />}
        {error && <Note tone="warning">{error}</Note>}
        {servers === null ? <Spinner size={14} />
          : !servers.length && !connecting ? <Note>No servers yet. Connect one by its MCP address, like your ERP's.</Note>
          : servers.map((server) => <ServerRow key={server.id} server={server} onChange={() => void load()} />)}
      </Card>
    </SettingsPage>
  );
}

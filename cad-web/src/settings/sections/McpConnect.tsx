/**
 * How to connect an AI tool to STEVE over MCP (Settings → MCP). Every client signs the person in through the
 * same Keycloak realm as the web app (app/mcp_auth.py), so it acts as them, in their own workspace.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Segmented } from '@/ui';
import styles from './McpConnect.module.css';

export type Client = 'claude-code' | 'claude' | 'chatgpt' | 'codex' | 'grok' | 'other';

const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude', label: 'Claude' },
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'other', label: 'Other' },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* Clipboard blocked: the text is selectable. */ }
  };
  return (
    <button type="button" className={styles.copy} onClick={() => void copy()} aria-label={label} data-copied={copied || undefined}>
      {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function Code({ text }: { text: string }) {
  return (
    <div className={styles.code}>
      <code>{text}</code>
      <CopyButton text={text} label="Copy command" />
    </div>
  );
}

function Steps({ client, url }: { client: Client; url: string }) {
  switch (client) {
    case 'claude-code':
      return (
        <ol className={styles.steps}>
          <li>Add STEVE in a terminal:<Code text={`claude mcp add --transport http steve ${url}`} /></li>
          <li>In Claude Code, run <kbd>/mcp</kbd>, choose <b>steve</b> and <b>Authenticate</b>.</li>
          <li>Sign in with Google or X in the browser window that opens, and allow access.</li>
        </ol>
      );
    case 'claude':
      return (
        <ol className={styles.steps}>
          <li>In Claude (web or desktop), open <b>Customize → Connectors</b> and choose <b>+ Add → Add custom connector</b>.</li>
          <li>Name it <b>STEVE</b>, paste the server URL above and choose <b>Add</b>.</li>
          <li>Sign in with Google or X when Claude asks, and allow access.</li>
          <li>On Team and Enterprise plans, an Owner adds it under <b>Organization settings → Connectors</b>; members then choose <b>Connect</b> on it in <b>Customize → Connectors</b>.</li>
        </ol>
      );
    case 'chatgpt':
      return (
        <ol className={styles.steps}>
          <li>In ChatGPT, open <b>Plugins</b>, choose <b>+</b> and then <b>Add custom MCP server</b>.</li>
          <li>Name it <b>STEVE</b>, paste the server URL above, choose <b>OAuth</b> authentication, accept the warning and choose <b>Create as a plugin</b>.</li>
          <li>Install the plugin, sign in with Google or X when ChatGPT asks, and allow access. Type <kbd>@</kbd> in a chat to use it.</li>
        </ol>
      );
    case 'codex':
      return (
        <ol className={styles.steps}>
          <li>Add STEVE in a terminal:<Code text={`codex mcp add steve --url ${url}`} /></li>
          <li>Sign in:<Code text="codex mcp login steve" /></li>
          <li>Sign in with Google or X in the browser window that opens, and allow access.</li>
        </ol>
      );
    case 'grok':
      return (
        <ol className={styles.steps}>
          <li>Add STEVE in a terminal:<Code text={`grok mcp add --transport http steve ${url}`} /></li>
          <li>In Grok Build, run <kbd>/mcps</kbd>, select <b>steve</b> and press <kbd>i</kbd> to authenticate.</li>
          <li>Sign in with Google or X in the browser window that opens, and allow access. Grok’s own sign-in doesn’t carry over: STEVE asks you once.</li>
        </ol>
      );
    default:
      return (
        <ol className={styles.steps}>
          <li>Any MCP client that supports remote (streamable HTTP) servers with OAuth sign-in works: give it the server URL above.</li>
          <li>It signs you in through STEVE’s sign-in page (Google or X) and asks you to allow access once.</li>
          <li>If it asks for an OAuth client ID, use <code className={styles.inline}>steve-mcp</code> (no secret).</li>
        </ol>
      );
  }
}

export function McpConnect() {
  const [client, setClient] = useState<Client>('claude-code');
  const url = `${window.location.origin}/mcp`;
  return (
    <div className={styles.body} id="mcp-connect">
      <section>
        <h4 className="caps">MCP server URL</h4>
        <div className={styles.url}>
          <code>{url}</code>
          <CopyButton text={url} label="Copy MCP server URL" />
        </div>
      </section>
      <section>
        <Segmented size="sm" value={client} onChange={setClient} options={CLIENTS.map((item) => ({ value: item.id, label: item.label }))} />
        <Steps client={client} url={url} />
      </section>
      <section className={styles.notes}>
        <p><b>What it can do:</b> the tools turned on below: list, read, create and edit your designs, generate models and inspect geometry, the same tools STEVE uses.</p>
        <p><b>Privacy:</b> a connected tool only sees your workspace. Design data it reads goes to that tool’s AI provider under their terms. To disconnect it, remove STEVE from the tool’s own connector list; to limit it, turn tools off below.</p>
      </section>
    </div>
  );
}

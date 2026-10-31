/**
 * Settings → Developers → Apps: OAuth apps this workspace develops (app/oauth_api.py). An app works for anyone who
 * connects it, on their consent; a new, unverified one shows a warning and is capped at a few dozen people for its first
 * two weeks. Administrators verify, suspend or reject apps here too.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, Spinner } from '@/ui';
import { api, json } from '@/lib/api';
import { Card, Note } from '../ui';
import own from './Developers.module.css';
import { askConfirm, askText } from '@/ui/confirm';

interface App { id: string; name: string; description: string; homepage: string; redirect_uris: string[]; scopes: string[]; confidential: boolean; status: string; review_note: string; verified: boolean; developer_name: string; created_at: string }
interface Scope { name: string; description: string; sensitive: boolean }
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const STATUS: Record<string, string> = { private: 'Anyone can connect it', in_review: 'Anyone can connect it', approved: 'Verified by STEVE: anyone can connect it', rejected: 'Stopped by STEVE: only this workspace', suspended: 'Suspended by STEVE' };

interface Counts { requests: number; client_errors: number; server_errors: number }
interface Usage { people: number; last_used_at: string | null; windows: Record<'24h' | '7d' | '30d', Counts> }
const WINDOWS = [['24h', '24 h'], ['7d', '7 days'], ['30d', '30 days']] as const;

/** An app's use, in counts only (never who, or what): people connected now, requests and errors, last use. */
function AppUsage({ id }: { id: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => { api<Usage>(`/v1/developers/apps/${id}/usage`).then(setUsage, () => setUsage(null)); }, [id]);
  if (!usage) return null;
  const last = usage.last_used_at ? new Date(usage.last_used_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  return (
    <div className={own.usage}>
      <p>{usage.people.toLocaleString()} {usage.people === 1 ? 'person' : 'people'} connected · last used {last}</p>
      <table aria-label="Usage">
        <thead><tr><th />{WINDOWS.map(([key, label]) => <th key={key}>{label}</th>)}</tr></thead>
        <tbody>
          {([['Requests', 'requests'], ['Errors 4xx', 'client_errors'], ['Errors 5xx', 'server_errors']] as const).map(([label, field]) => (
            <tr key={field}><td>{label}</td>{WINDOWS.map(([key]) => <td key={key}>{usage.windows[key][field].toLocaleString()}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Shown({ label, value, secret = true, onDone }: { label: string; value: string; secret?: boolean; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={own.secret} role="status">
      <p>{secret ? <><b>Copy the {label} now.</b> It isn’t shown again; STEVE keeps only a fingerprint of it.</>
        : <><b>This is the app’s {label}.</b> It isn’t secret: a public client has no secret and uses PKCE alone. You can always see it here.</>}</p>
      <div className={own.secretValue}>
        <code>{value}</code>
        <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <div><Button size="sm" onClick={onDone}>Done</Button></div>
    </div>
  );
}

export function DeveloperApps({ invited }: { invited: boolean }) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [form, setForm] = useState({ name: '', description: '', homepage: '', redirects: '', scopes: ['designs:read'], confidential: true });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<App | null>(null);   // the app being edited (the form's other use: registering)
  const [secret, setSecret] = useState<{ label: string; value: string; secret: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ apps: App[]; scopes: Scope[] }>('/v1/developers/apps').then((body) => { setApps(body.apps); setScopes(body.scopes); }, (failure) => setError(message(failure))), []);
  useEffect(() => { void load(); }, [load]);
  const run = async (request: () => Promise<unknown>) => {
    setError(null);
    try { await request(); await load(); } catch (failure) { setError(message(failure)); }
  };
  const register = () => run(async () => {
    const made = await api<App & { client_secret?: string }>('/v1/developers/apps', json('POST', {
      name: form.name, description: form.description, homepage: form.homepage, scopes: form.scopes, confidential: form.confidential,
      redirect_uris: form.redirects.split(/\s+/).filter(Boolean),
    }));
    setOpen(false);
    setSecret(made.client_secret ? { label: 'client id and secret', value: `${made.id}  ${made.client_secret}`, secret: true }
      : { label: 'client id', value: made.id, secret: false });
  });
  const startEdit = (app: App) => {
    setForm({ name: app.name, description: app.description, homepage: app.homepage, redirects: app.redirect_uris.join('\n'), scopes: app.scopes, confidential: app.confidential });
    setEditing(app); setOpen(true);
  };
  const save = () => run(async () => {
    if (!editing) return;
    await api(`/v1/developers/apps/${editing.id}`, json('PATCH', {
      name: form.name, description: form.description, homepage: form.homepage, scopes: form.scopes,
      redirect_uris: form.redirects.split(/\s+/).filter(Boolean),
    }));
    setOpen(false); setEditing(null);
  });
  const rotate = (app: App) => run(async () => {
    if (!await askConfirm({ title: `Make a new secret for ${app.name}?`, detail: 'The current one stops working at once.', action: 'Make a new secret' })) return;
    const made = await api<{ client_id: string; client_secret: string }>(`/v1/developers/apps/${app.id}/secret`, { method: 'POST' });
    setSecret({ label: 'new client secret', value: made.client_secret, secret: true });
  });
  return (
    <Card title="Apps" id="developers-apps" description="Software other people connect to their own STEVE workspace (OAuth 2.1 with PKCE). It acts with the scopes each person allows, until they disconnect it.">
      {secret && <Shown label={secret.label} value={secret.value} secret={secret.secret} onDone={() => setSecret(null)} />}
      {invited && !open && <div className={own.actions} style={{ paddingBottom: 12 }}><Button onClick={() => { setEditing(null); setForm({ name: '', description: '', homepage: '', redirects: '', scopes: ['designs:read'], confidential: true }); setOpen(true); }} id="developers-new-app">Register an app</Button></div>}
      {open && (
        <div className={own.form}>
          <input className={own.input} placeholder="Name people see" aria-label="App name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          <input className={own.input} placeholder="What it does (one sentence)" aria-label="Description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          <input className={own.input} placeholder="https://your-site.example (optional)" aria-label="Homepage" value={form.homepage} onChange={(event) => setForm({ ...form, homepage: event.target.value.trim() })} />
          <textarea className={own.area} placeholder="Redirect URIs, one per line: https://… or http://127.0.0.1:<port>/…" aria-label="Redirect URIs" value={form.redirects} onChange={(event) => setForm({ ...form, redirects: event.target.value })} />
          <div className={own.scopes}>
            {scopes.map((scope) => (
              <label key={scope.name} className={own.scope}>
                <input type="checkbox" checked={form.scopes.includes(scope.name)} onChange={() => setForm({ ...form, scopes: form.scopes.includes(scope.name) ? form.scopes.filter((name) => name !== scope.name) : [...form.scopes, scope.name] })} />
                <span><code>{scope.name}</code>{scope.sensitive && <b className={own.sensitive}> · reaches machines</b>}<br />{scope.description}</span>
              </label>
            ))}
          </div>
          {editing ? (
            <p className={own.empty} style={{ padding: 0 }}>{editing.confidential ? 'A confidential client (it has a secret).' : 'A public client (PKCE only, no secret).'}
              {editing.verified ? ' Changing its name, redirect URIs or scopes ends its verification by STEVE.' : ''} Scopes you add reach only people who connect it from now on; scopes you take away stop at once.</p>
          ) : (
            <label className={own.scope}><input type="checkbox" checked={!form.confidential} onChange={() => setForm({ ...form, confidential: !form.confidential })} />
              <span>It runs on people’s own computers or phones, so it can’t keep a secret (a public client: PKCE only)</span></label>
          )}
          <div className={own.actions}>
            <Button variant="primary" disabled={!form.name.trim() || !form.redirects.trim() || !form.scopes.length} onClick={() => void (editing ? save() : register())}>{editing ? 'Save' : 'Register'}</Button>
            <Button onClick={() => { setOpen(false); setEditing(null); }}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <Note tone="warning">{error}</Note>}
      {!apps ? <Spinner /> : apps.map((item) => (
        <div key={item.id} className={own.key} data-app={item.id}>
          <div>
            <b>{item.name}</b> <code>{item.id}</code>
            <p>{STATUS[item.status] ?? item.status}{item.review_note ? `: ${item.review_note}` : ''} · {item.scopes.join(', ')}</p>
            <p>{item.redirect_uris.join(' · ')}</p>
            <AppUsage id={item.id} />
          </div>
          <div className={own.actions}>
            {!open && <Button size="sm" onClick={() => startEdit(item)}>Edit</Button>}
            {item.confidential && <Button size="sm" onClick={() => void rotate(item)}>New secret</Button>}
            <Button size="sm" onClick={() => void askConfirm({ title: `Delete ${item.name}?`, detail: 'Everyone who connected it is disconnected.', action: 'Delete' })
              .then((yes) => { if (yes) void run(() => api(`/v1/developers/apps/${item.id}`, { method: 'DELETE' })); })}>Delete</Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

type ListedApp = App & { workspace_id: string; people: number; new: boolean };

/** Administrators: every app, how many people connected it, and verifying, suspending or rejecting it. */
export function AppReviews() {
  const [apps, setApps] = useState<ListedApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ apps: ListedApp[] }>('/v1/admin/oauth-apps').then((body) => setApps(body.apps), (failure) => setError(message(failure))), []);
  useEffect(() => { void load(); }, [load]);
  const decide = async (id: string, status: string) => {
    const note = status === 'approved' || status === 'private' ? ''
      : await askText({ title: status === 'suspended' ? 'Suspend this app?' : 'Change this app’s status?', detail: status === 'suspended' ? 'It stops working for everyone who connected it.' : undefined,
                       action: status === 'suspended' ? 'Suspend' : 'Save', danger: status === 'suspended', text: { label: 'A note for the developer (why)' } });
    if (note === null) return;
    try { await api(`/v1/admin/oauth-apps/${id}`, json('POST', { status, note })); await load(); } catch (failure) { setError(message(failure)); }
  };
  return (
    <Card title="Apps" id="developers-app-reviews" description="Administrators only. Apps work for anyone who connects them. A new, unverified app is capped at 25 people for its first 14 days and shows a warning; verify one you trust. Suspending or rejecting stops it outside its developer’s workspace at once.">
      {error && <Note tone="warning">{error}</Note>}
      {!apps ? <Spinner /> : !apps.length ? <p className={own.empty}>No apps yet.</p> : apps.map((item) => (
        <div key={item.id} className={own.key} data-app={item.id}>
          <div>
            <b>{item.name}</b> <code>{item.id}</code>{item.verified && <span className={own.allowed}> Verified</span>}{item.new && <span className={own.notAllowed}> New</span>}
            <p>{STATUS[item.status] ?? item.status} · by {item.developer_name || 'unknown'} · {item.people} {item.people === 1 ? 'person' : 'people'} connected · {item.scopes.join(', ')}</p>
            <p>{item.description} {item.homepage} · redirects: {item.redirect_uris.join(' · ')}</p>
          </div>
          <div className={own.actions}>
            {!item.verified && item.status !== 'suspended' && item.status !== 'rejected' && <Button size="sm" onClick={() => void decide(item.id, 'approved')}>Verify</Button>}
            {item.status !== 'suspended' && <Button size="sm" onClick={() => void decide(item.id, 'suspended')}>Suspend</Button>}
            {(item.status === 'suspended' || item.status === 'rejected') && <Button size="sm" onClick={() => void decide(item.id, 'private')}>Let it run</Button>}
          </div>
        </div>
      ))}
    </Card>
  );
}

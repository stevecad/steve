/**
 * Settings → Developers: service-account keys for the Steve API (/api/v1; app/api_v1.py, app/api_keys.py). A key
 * belongs to this workspace, carries only the scopes chosen here, expires, and is shown once when it's made. The
 * activity log lists every request made with a key; the automated audit's alerts (app/api_watch.py) show here, and a
 * key it suspended is resumed here. Administrators also manage which workspaces are invited (the API
 * is invite-only for now).
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, TriangleAlert } from 'lucide-react';
import { Button, Select, Spinner, Switch } from '@/ui';
import { api, json } from '@/lib/api';
import { useAccount } from '@/auth/auth';
import { settingsSections } from '../registry';
import { Card, Note, Past, SettingsPage } from '../ui';
import styles from '../Settings.module.css';
import own from './Developers.module.css';
import { AppReviews, DeveloperApps } from './DeveloperApps';
import { askConfirm } from '@/ui/confirm';

interface ApiKey {
  id: string; name: string; scopes: string[]; created_at: string; expires_at: string; ip_allowlist: string[];
  last_used_at: string | null; last_used_ip: string | null; revoked_at: string | null; prefix: string;
  suspended_at: string | null; suspended_reason: string | null; hints: string[];
}
interface Alert { id: number; at: string; key_id: string; rule: string; action: 'flagged' | 'suspended'; detail: string; resolved_at: string | null }
interface Webhook {
  id: string; url: string; types: string[]; created_at: string; last_status: number | null; last_error: string | null;
  last_delivered_at: string | null; failing_since: string | null; disabled_at: string | null; disabled_reason: string | null;
}
interface Limits { minute: number; day: number; work: number; keys: number; connectors: number }
interface Access {
  on: boolean; tier: 'starter' | 'standard' | null; limits: Limits; how: string | null; tier_since: string | null;
  can_turn_on: boolean; withdrawn: boolean; paused: boolean; promotion: { after_days: number; active_days: number };
}
interface Overview {
  invited: boolean; access: Access; keys: ApiKey[]; alerts: Alert[]; webhooks: Webhook[]; event_types: string[];
  scopes: { name: string; description: string; sensitive: boolean }[];
  limits: { per_minute: number; per_day: number; work_per_minute: number };
}
interface AuditEntry { at: string; key_id: string; method: string; route: string; document: string | null; status: number; ms: number; ip: string; security: boolean }
interface AccessRow {
  workspace_id: string; granted_at: string; granted_by: string; note: string; how: string; tier: string; tier_since: string;
  limits: Partial<Limits> | null; person_name: string; requests_7d: number; alerts_30d: number; effective: Limits;
}
interface AccessList { access: AccessRow[]; withdrawn: { workspace_id: string; at: string; by: string; note: string }[]; self_serve: boolean; tiers: Record<string, Limits> }
const LIMIT_LABELS: [keyof Limits, string][] = [['minute', 'Requests a minute'], ['day', 'Requests a day'], ['work', 'Builds, studies or CAM runs a minute'], ['keys', 'Keys'], ['connectors', 'Connectors']];
const TIER_LABEL: Record<string, string> = { starter: 'Starter', standard: 'Standard' };

const when = (value: string | null) => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const day = (value: string) => new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function NewKey({ overview, onMade }: { overview: Overview; onMade: (secret: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['designs:read']);
  const [days, setDays] = useState(90);
  const [ips, setIps] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return <div className={own.actions} style={{ padding: '4px 0 14px' }}><Button icon={<Plus size={14} />} onClick={() => setOpen(true)} id="developers-new-key">New key</Button></div>;
  const toggle = (scope: string) => setScopes((now) => (now.includes(scope) ? now.filter((item) => item !== scope) : [...now, scope]));
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api<ApiKey & { key: string }>('/v1/developers/keys', json('POST', {
        name, scopes, days, ip_allowlist: ips.split(/[\s,]+/).filter(Boolean),
      }));
      setOpen(false);
      setName('');
      setIps('');
      onMade(made.key);
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={own.form} id="developers-key-form">
      <div>
        <label className={own.label} htmlFor="developers-key-name">Name (what will use it)</label>
        <input id="developers-key-name" className={own.input} value={name} maxLength={80} placeholder="e.g. ERP sync" onChange={(event) => setName(event.target.value)} autoFocus />
      </div>
      <div>
        <span className={own.label}>Scopes: the key can do only these</span>
        <div className={own.scopes}>
          {overview.scopes.map((scope) => (
            <label key={scope.name} className={own.scope} data-scope={scope.name}>
              <input type="checkbox" checked={scopes.includes(scope.name)} onChange={() => toggle(scope.name)} />
              <span><code>{scope.name}</code>{scope.sensitive && <b className={own.sensitive}> · reaches machines</b>}<br />{scope.description}</span>
            </label>
          ))}
        </div>
      </div>
      <div>
        <label className={own.label} htmlFor="developers-key-days">Expires after</label>
        <select id="developers-key-days" className={own.input} style={{ maxWidth: 200 }} value={days} onChange={(event) => setDays(Number(event.target.value))}>
          {[7, 30, 90, 180, 365].map((count) => <option key={count} value={count}>{count} days</option>)}
        </select>
      </div>
      <div>
        <label className={own.label} htmlFor="developers-key-ips">Allowed addresses (optional): IPs or CIDR ranges, one per line</label>
        <textarea id="developers-key-ips" className={own.area} value={ips} placeholder="203.0.113.7&#10;198.51.100.0/24" onChange={(event) => setIps(event.target.value)} />
      </div>
      {scopes.some((scope) => overview.scopes.find((item) => item.name === scope)?.sensitive) && (
        <Note tone="warning">This key can generate or download G-code. Give it only to software you trust with your machines.</Note>
      )}
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="primary" disabled={busy || !name.trim() || !scopes.length} onClick={() => void make()} id="developers-make-key">{busy ? 'Making…' : 'Make key'}</Button>
        <Button onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </div>
  );
}

function Secret({ secret, onDone }: { secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={own.secret} id="developers-secret" role="status">
      <p><TriangleAlert size={12} className={own.sensitive} /> <b>Copy this key now.</b> It isn’t shown again, and STEVE keeps only a fingerprint of it. Store it like a password; anyone with it can act as this key.</p>
      <div className={own.secretValue}>
        <code>{secret}</code>
        <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void navigator.clipboard.writeText(secret).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
      <div><Button size="sm" onClick={onDone}>Done</Button></div>
    </div>
  );
}

function Webhooks({ overview, reload }: { overview: Overview; reload: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (request: () => Promise<unknown>) => {
    setError(null);
    try { await request(); await reload(); } catch (failure) { setError(message(failure)); }
  };
  const make = () => run(async () => {
    const made = await api<Webhook & { secret: string }>('/v1/developers/webhooks', json('POST', { url, types }));
    setSecret(made.secret);
    setUrl('');
  });
  return (
    <Card title="Webhooks" id="developers-webhooks" description="STEVE sends each event to your HTTPS endpoint as it happens, signed with the webhook’s secret (header Steve-Signature). Only public internet addresses, on port 443.">
      {secret && <Secret secret={secret} onDone={() => setSecret(null)} />}
      {overview.invited && (
        <div className={own.form}>
          <div className={own.actions}>
            <input className={own.input} style={{ flex: 1, minWidth: 220 }} value={url} placeholder="https://example.com/steve-events" aria-label="Webhook URL" onChange={(event) => setUrl(event.target.value.trim())} id="developers-webhook-url" />
            <Button disabled={!url.startsWith('https://')} onClick={() => void make()} id="developers-add-webhook">Add webhook</Button>
          </div>
          <div className={own.scopes}>
            {overview.event_types.map((type) => (
              <label key={type} className={own.scope}>
                <input type="checkbox" checked={types.includes(type)} onChange={() => setTypes((now) => (now.includes(type) ? now.filter((item) => item !== type) : [...now, type]))} />
                <span><code>{type}</code></span>
              </label>
            ))}
          </div>
          <p className={own.empty} style={{ padding: 0 }}>No event types chosen: all of them.</p>
        </div>
      )}
      {error && <Note tone="warning">{error}</Note>}
      {overview.webhooks.map((hook) => (
        <div key={hook.id} className={own.key} data-webhook={hook.id} data-revoked={hook.disabled_at || undefined}>
          <div>
            <b>{hook.url}</b>
            <p>{hook.types.length ? hook.types.join(', ') : 'All events'} · last delivered {when(hook.last_delivered_at)}</p>
            {hook.disabled_at ? <p className={own.sensitive}>Turned off {when(hook.disabled_at)}: {hook.disabled_reason}</p>
              : hook.failing_since ? <p className={own.sensitive}>Failing since {when(hook.failing_since)}: {hook.last_error}. STEVE keeps retrying, then turns it off after a day.</p> : null}
          </div>
          <div className={own.actions}>
            {hook.disabled_at && <Button size="sm" onClick={() => void run(() => api(`/v1/developers/webhooks/${hook.id}/enable`, { method: 'POST' }))}>Turn on</Button>}
            <Button size="sm" onClick={() => void run(() => api(`/v1/developers/webhooks/${hook.id}`, { method: 'DELETE' }))}>Delete</Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

interface Weekly {
  new_keys: number; new_apps: number; apps_in_review: number; connectors_paired: number;
  alerts: { workspace_id: string; key_id: string; rule: string; action: string; n: number; last: string }[];
  top_usage: { workspace_id: string; requests: number; refused: number }[];
}

function WeeklyReport() {
  const [report, setReport] = useState<Weekly | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Weekly>('/v1/admin/api-access/weekly').then(setReport, (failure) => setError(message(failure))); }, []);
  return (
    <Card title="This week" id="developers-weekly" description="Administrators only. The Steve API across every workspace over the last 7 days.">
      {error && <Note tone="warning">{error}</Note>}
      {!report ? (!error && <Spinner />) : (
        <>
          <p className={own.empty}>{report.new_keys} new keys · {report.new_apps} new apps ({report.apps_in_review} waiting for review) · {report.connectors_paired} connectors paired</p>
          {report.alerts.length > 0 && (
            <div className={own.logWrap}>
              <table className={own.log}>
                <thead><tr><th>Last</th><th>Workspace</th><th>Caller</th><th>Rule</th><th>Action</th><th>Times</th></tr></thead>
                <tbody>{report.alerts.map((alert) => (
                  <tr key={`${alert.workspace_id}-${alert.key_id}-${alert.rule}`} data-security={alert.action === 'suspended' || undefined}>
                    <td>{when(alert.last)}</td><td>{alert.workspace_id.slice(0, 8)}</td><td>{alert.key_id}</td><td>{alert.rule}</td><td>{alert.action}</td><td>{alert.n}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          {report.top_usage.length > 0 && (
            <div className={own.logWrap}>
              <table className={own.log}>
                <thead><tr><th>Workspace</th><th>Requests</th><th>Refused</th></tr></thead>
                <tbody>{report.top_usage.map((row) => <tr key={row.workspace_id}><td>{row.workspace_id}</td><td>{row.requests}</td><td>{row.refused}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/** Turning the Steve API on for this workspace (self-serve, starter tier), and what tier it's on. */
function AccessCard({ access, reload }: { access: Access; reload: () => void }) {
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setError(null);
    try { await api('/v1/developers/access', json('POST', { accept_terms: accepted })); reload(); } catch (failure) { setError(message(failure)); }
  };
  const limits = (value: Limits) => `${value.minute} requests a minute and ${value.day.toLocaleString()} a day, ${value.work} builds, studies or CAM runs a minute, ${value.keys} keys and ${value.connectors} connectors`;
  if (access.on) {
    return (
      <Note>
        This workspace uses the Steve API at the <b>{TIER_LABEL[access.tier ?? 'starter']}</b> tier: {limits(access.limits)}.
        {access.tier === 'starter' && ` After ${access.promotion.after_days} days with real use (on ${access.promotion.active_days} different days) and no alerts, it moves to Standard by itself.`}
      </Note>
    );
  }
  if (access.withdrawn) return <Note tone="warning">STEVE withdrew this workspace’s access to the Steve API. If you think that was a mistake, ask STEVE’s team on X (@10_X_eng).</Note>;
  if (access.paused) return <Note>New sign-ups for the Steve API are paused for now. Try again later.</Note>;
  return (
    <div className={own.form} id="developers-turn-on">
      <p className={own.empty} style={{ padding: 0 }}>Turn the Steve API on to let your own software, apps and connectors work with this workspace. You start on the Starter tier: {limits(access.limits)}. It grows by itself with normal use.</p>
      <label className={own.scope}>
        <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} />
        <span>I accept the <a href="/terms" target="_blank" rel="noopener noreferrer">terms</a> for the Steve API, apps and connectors (section 07).</span>
      </label>
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}><Button variant="primary" disabled={!accepted} onClick={() => void turnOn()}>Turn on the Steve API</Button></div>
    </div>
  );
}

/** One workspace on the access list: its tier and own limits (administrators). */
function AccessEntry({ row, onChange }: { row: AccessRow; onChange: (request: Promise<AccessList>) => void }) {
  const [open, setOpen] = useState(false);
  const [own_, setOwn] = useState<Partial<Record<keyof Limits, string>>>(Object.fromEntries(Object.entries(row.limits ?? {}).map(([key, value]) => [key, String(value)])));
  const save = () => {
    const limits = Object.fromEntries(Object.entries(own_).filter(([, value]) => value && value.trim()).map(([key, value]) => [key, Number(value)]));
    onChange(api(`/v1/admin/api-access/${row.workspace_id}`, json('PUT', { limits })));
    setOpen(false);
  };
  return (
    <div className={own.key} data-access={row.workspace_id} style={{ gridTemplateColumns: '1fr' }}>
      <div>
        <b>{row.person_name || 'Invited workspace'}</b> <code>{row.workspace_id.slice(0, 8)}</code> <span className={row.tier === 'standard' ? own.allowed : own.notAllowed}>{TIER_LABEL[row.tier] ?? row.tier}{row.limits ? ' · own limits' : ''}</span>
        <p>{row.how === 'self' ? 'Turned on by them' : `Invited by an administrator${row.note ? `: ${row.note}` : ''}`} {day(row.granted_at)} · {row.requests_7d.toLocaleString()} requests in 7 days{row.alerts_30d ? ` · ${row.alerts_30d} alerts in 30 days` : ''}</p>
        <p>{row.effective.minute}/min · {row.effective.day.toLocaleString()}/day · {row.effective.work} work/min · {row.effective.keys} keys · {row.effective.connectors} connectors</p>
        {open && (
          <div className={own.form}>
            <span className={own.label}>Own limits (empty: the tier’s)</span>
            <div className={own.scopes}>
              {LIMIT_LABELS.map(([key, label]) => (
                <label key={key} className={own.scope}><span style={{ flex: 1 }}>{label}</span>
                  <input className={own.input} style={{ width: 110 }} inputMode="numeric" value={own_[key] ?? ''} placeholder={String(row.effective[key])}
                         onChange={(event) => setOwn({ ...own_, [key]: event.target.value.replace(/[^0-9]/g, '') })} /></label>
              ))}
            </div>
            <div className={own.actions}><Button size="sm" variant="primary" onClick={save}>Save limits</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
          </div>
        )}
      </div>
      <div className={own.actions}>
        <Select value={row.tier} ariaLabel="Tier" options={Object.keys(TIER_LABEL).map((tier) => ({ value: tier, label: TIER_LABEL[tier] }))}
                onChange={(tier) => onChange(api(`/v1/admin/api-access/${row.workspace_id}`, json('PUT', { tier })))} />
        {!open && <Button size="sm" onClick={() => setOpen(true)}>Own limits…</Button>}
        <Button size="sm" onClick={() => void askConfirm({ title: 'Withdraw this workspace’s API access for good?', detail: 'Its keys, apps and connectors stop at once, and it can’t turn the API back on itself.', action: 'Withdraw' })
          .then((yes) => { if (yes) onChange(api(`/v1/admin/api-access/${row.workspace_id}`, { method: 'DELETE' })); })}>Withdraw</Button>
      </div>
    </div>
  );
}

/** Administrators: everyone using the Steve API, their tiers and limits, withdrawn workspaces, and the self-serve switch. */
function AccessList() {
  const [list, setList] = useState<AccessList | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<AccessList>('/v1/admin/api-access').then(setList, (failure) => setError(message(failure))), []);
  useEffect(() => { void load(); }, [load]);
  const change = async (request: Promise<AccessList>) => {
    setError(null);
    try { setList(await request); setWorkspace(''); } catch (failure) { setError(message(failure)); }
  };
  return (
    <Card title="API access" id="developers-invites" description="Administrators only. Everyone using the Steve API: how they got it, their tier and limits, and their use. Anyone signed in can turn it on (Starter); Standard follows by itself after real use without alerts. Withdrawing is for good.">
      {!list ? <Spinner /> : (
        <>
          <div className={own.actions} style={{ paddingBottom: 10 }}>
            <Switch checked={list.self_serve} label="Self-serve sign-up" onCheckedChange={(open) => void change(api('/v1/admin/api-access', json('PUT', { open })))} />
            <span className={own.empty} style={{ padding: 0 }}>{list.self_serve ? 'Open: anyone signed in can turn the API on.' : 'Paused: only administrators let workspaces in.'}</span>
          </div>
          <div className={own.actions} style={{ paddingBottom: 10 }}>
            <input className={own.input} style={{ flex: 1, minWidth: 220 }} value={workspace} placeholder="Workspace id (to let one in at Standard)" aria-label="Workspace id" onChange={(event) => setWorkspace(event.target.value.trim())} />
            <Button disabled={!workspace} onClick={() => void change(api('/v1/admin/api-access', json('POST', { workspace })))}>Let in</Button>
          </div>
          {error && <Note tone="warning">{error}</Note>}
          {!list.access.length ? <p className={own.empty}>No workspace uses the API yet.</p> : list.access.map((row) => <AccessEntry key={`${row.workspace_id}:${row.tier}:${JSON.stringify(row.limits)}`} row={row} onChange={(request) => void change(request)} />)}
          {list.withdrawn.length > 0 && (
            <>
              <span className={own.label} style={{ marginTop: 12 }}>Withdrawn</span>
              {list.withdrawn.map((row) => (
                <div key={row.workspace_id} className={own.key} data-revoked>
                  <div><code>{row.workspace_id}</code><p>Withdrawn {day(row.at)}</p></div>
                  <Button size="sm" onClick={() => void change(api('/v1/admin/api-access', json('POST', { workspace: row.workspace_id })))}>Let back in</Button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default function DevelopersSection() {
  const section = settingsSections().find((item) => item.id === 'developers')!;
  const account = useAccount((state) => state.account);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [next, log] = await Promise.all([api<Overview>('/v1/developers'), api<{ entries: AuditEntry[] }>('/v1/developers/audit?limit=100')]);
      setOverview(next);
      setAudit(log.entries);
    } catch (failure) {
      setError(message(failure));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Keys, webhooks and activity change from outside (software using its keys): look again when the window comes back.
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') void load(); };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => { window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); };
  }, [load]);
  const revoke = async (key: ApiKey) => {
    if (!await askConfirm({ title: `Revoke “${key.name}”?`, detail: 'Software using it stops working at its next request.', action: 'Revoke' })) return;
    try { await api(`/v1/developers/keys/${key.id}`, { method: 'DELETE' }); await load(); } catch (failure) { setError(message(failure)); }
  };
  const resume = async (key: ApiKey) => {
    try { await api(`/v1/developers/keys/${key.id}/resume`, { method: 'POST' }); await load(); } catch (failure) { setError(message(failure)); }
  };
  const names = new Map((overview?.keys ?? []).map((key) => [key.id, key.name]));
  const over = (key: ApiKey) => !!key.revoked_at || new Date(key.expires_at) <= new Date();
  const live = (overview?.keys ?? []).filter((key) => !over(key));
  const past = (overview?.keys ?? []).filter(over);
  const keyRow = (key: ApiKey) => {
    const expired = new Date(key.expires_at) <= new Date();
    return (
      <div key={key.id} className={own.key} data-key={key.id} data-revoked={key.revoked_at || expired || undefined}>
        <div>
          <b><KeyRound size={12} /> {key.name}</b> <code>{key.prefix}</code>
          <p>{key.scopes.join(', ')}</p>
          {key.suspended_at && !key.revoked_at && (
            <p className={own.sensitive} data-suspended><TriangleAlert size={11} /> Suspended {when(key.suspended_at)} after unusual activity ({key.suspended_reason}). Its requests are refused until you resume it. If you don’t recognise the activity, revoke it.</p>
          )}
          {key.hints.map((hint) => <p key={hint} data-hint>{hint}</p>)}
          <p>{key.revoked_at ? `Revoked ${when(key.revoked_at)}` : expired ? `Expired ${day(key.expires_at)}` : `Expires ${day(key.expires_at)}`} · last used {when(key.last_used_at)}{key.last_used_ip ? ` from ${key.last_used_ip}` : ''}{key.ip_allowlist.length ? ` · only from ${key.ip_allowlist.join(', ')}` : ''}</p>
        </div>
        {!key.revoked_at && !expired && (
          <div className={own.actions}>
            {key.suspended_at && <Button size="sm" onClick={() => void resume(key)}>Resume</Button>}
            <Button size="sm" onClick={() => void revoke(key)}>Revoke</Button>
          </div>
        )}
      </div>
    );
  };
  return (
    <SettingsPage section={section}>
      {error && <Note tone="warning">{error} <Button size="sm" onClick={() => void load()}>Try again</Button></Note>}
      {!overview ? (!error && <div className={styles.loading} style={{ padding: 24 }}><Spinner size={16} /></div>) : (
        <>
          <Card title="API keys" id="developers-keys" description={<>Keys let your own software use the Steve API at <code className={styles.inlineCode}>/api/v1</code>. A key works only in this workspace, only with its scopes, and only until it expires. Each key may make up to {overview.limits.per_minute} requests a minute and {overview.limits.per_day.toLocaleString()} a day, and start {overview.limits.work_per_minute} builds, studies or CAM runs a minute, within this workspace’s tier.</>}>
            <AccessCard access={overview.access} reload={() => void load()} />
            {!overview.invited ? null : (
              <>
                {secret && <Secret secret={secret} onDone={() => setSecret(null)} />}
                <NewKey overview={overview} onMade={(made) => { setSecret(made); void load(); }} />
              </>
            )}
            {live.length === 0 && overview.invited && <p className={own.empty}>No keys in use.</p>}
            {live.map(keyRow)}
            <Past label="Revoked and expired keys" count={past.length}>{past.map(keyRow)}</Past>
          </Card>
          {overview.alerts.length > 0 && (
            <Card title="Alerts" id="developers-alerts" description="What STEVE’s automatic checks noticed about your keys: probing, reading many documents fast, a jump in volume, or a new network. Suspended keys are refused until you resume them.">
              {overview.alerts.map((alert) => (
                <div key={alert.id} className={own.key} data-alert={alert.rule}>
                  <div>
                    <b className={alert.resolved_at ? undefined : own.sensitive}>{alert.action === 'suspended' ? 'Suspended' : 'Flagged'}: {names.get(alert.key_id) ?? alert.key_id}</b>
                    <p>{when(alert.at)} · {alert.detail}{alert.resolved_at ? ` · resolved ${when(alert.resolved_at)}` : ''}</p>
                  </div>
                </div>
              ))}
            </Card>
          )}
          <Webhooks overview={overview} reload={load} />
          <DeveloperApps invited={overview.invited} />
          <Card title="Activity" id="developers-activity" description="Every request made with this workspace’s keys, newest first. Refused requests that look like misuse are highlighted.">
            {!audit?.length ? <p className={own.empty}>No requests yet.</p> : (
              <div className={own.logWrap}>
                <table className={own.log}>
                  <thead><tr><th>When</th><th>Key</th><th>Request</th><th>Result</th><th>Time</th><th>From</th></tr></thead>
                  <tbody>
                    {audit.map((entry, index) => (
                      <tr key={index} data-security={entry.security || undefined}>
                        <td>{when(entry.at)}</td><td>{names.get(entry.key_id) ?? entry.key_id}</td><td>{entry.method} {entry.document ? entry.route.replace('{document_id}', entry.document) : entry.route}</td>
                        <td>{entry.status}</td><td>{entry.ms} ms</td><td>{entry.ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
      {account?.admin && <AccessList />}
      {account?.admin && <AppReviews />}
      {account?.admin && <WeeklyReport />}
    </SettingsPage>
  );
}

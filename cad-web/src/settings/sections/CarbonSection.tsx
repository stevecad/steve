/**
 * Settings → Carbon (app/carbon.py): the person's Carbon ERP, connected by its address and an API key made in Carbon
 * (Settings → API Keys). Parts and designs then go there with Send to Carbon (the Export menu); the sends the STEVE
 * assistant or an AI agent asked for wait here for the person; recent sends show what happened, with a link to each item.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Factory, FolderOpen, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Button, Select, Spinner } from '@/ui';
import { api, json } from '@/lib/api';
import { askConfirm } from '@/ui/confirm';
import { set } from '@/state/store';
import { openDocument } from '@/state/actions';
import type { CarbonSend } from '@/dialogs/CarbonDialog';
import { settingsSections } from '../registry';
import { Card, Note, SettingsPage } from '../ui';
import own from './Developers.module.css';

interface Connection {
  url: string; key_hint: string; status: 'active' | 'error'; last_error: string | null; checked_at: string | null;
  shop: { work_centers?: { id: string; name: string }[]; processes?: { id: string; name: string }[] };
  job_updates: { on: boolean; last_call_at: string | null; signed?: string[] };
}
type Send = CarbonSend & { document_id: string; asked_by: string; created_at: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ASKED_BY: Record<string, string> = { person: 'you', assistant: 'STEVE', agent: 'an AI agent' };
const STATE: Record<Send['state'], string> = { awaiting_confirmation: 'waiting for you', queued: 'starting', running: 'sending',
  done: 'sent', failed: 'failed', cancelled: 'cancelled' };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Connect({ current, onDone }: { current: Connection | null; onDone: () => void }) {
  const [url, setUrl] = useState(current?.url ?? 'https://app.carbon.ms');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true); setError(null);
    try { await api('/v1/carbon', json('PUT', { url: url.trim(), key: key.trim() })); setKey(''); onDone(); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return (
    <div className={own.form} id="carbon-connect">
      <div>
        <span className={own.label}>Carbon’s address</span>
        <input className={own.input} value={url} onChange={(event) => setUrl(event.target.value)} id="carbon-url" aria-label="Carbon’s address" />
      </div>
      <div>
        <span className={own.label}>API key</span>
        <input className={own.input} type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)}
               placeholder="crbn_…" id="carbon-key" aria-label="API key" />
        <Note>Make one in Carbon under Settings → API Keys, with Parts, Documents and Production allowed to view, create and update.
          It acts as you in Carbon. STEVE keeps it encrypted and sends it only to Carbon.</Note>
      </div>
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="primary" icon={busy ? <Spinner size={12} /> : <Factory size={14} />} disabled={busy || key.trim().length < 8 || !url.trim().startsWith('https://')}
                onClick={() => void connect()} id="carbon-connect-button">Connect</Button>
        {current && <Button variant="ghost" onClick={onDone}>Cancel</Button>}
      </div>
    </div>
  );
}

interface MappingOptions {
  machines: { key: string; name: string }[]; processes: string[];
  carbon: { work_centers?: { id: string; name: string }[]; processes?: { id: string; name: string }[] }; mapping: Record<string, string>;
}
const NONE = 'none';
const PROCESS: Record<string, string> = { milling: 'Milling', turning: 'Turning', laser: 'Laser cutting', plasma: 'Plasma cutting',
  waterjet: 'Waterjet cutting', fff: '3D printing (FFF)', inspection: 'Inspection (to the drawing)' };

/** Which Carbon work center is each of the person's machines, and which Carbon process each kind of work: what a CAM
 * program's setups become in Carbon's routing. Unmatched ones are matched by name when a part is sent. */
function Matching() {
  const [options, setOptions] = useState<MappingOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<MappingOptions>('/v1/carbon/mapping').then(setOptions, (failure) => setError(message(failure))), []);
  useEffect(() => { void load(); }, [load]);
  if (error) return <Note tone="warning">{error}</Note>;
  if (!options) return <Spinner size={14} />;
  const choose = async (key: string, value: string) => {
    const mapping = { ...options.mapping };
    if (value === NONE) delete mapping[key]; else mapping[key] = value;
    setOptions({ ...options, mapping });
    try { await api('/v1/carbon/mapping', json('PUT', { mapping })); } catch (failure) { setError(message(failure)); }
  };
  const refresh = async () => {
    setBusy(true);
    try { await api('/v1/carbon/refresh', { method: 'POST' }); await load(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const centers = [{ value: NONE, label: 'By name' }, ...(options.carbon.work_centers ?? []).map((item) => ({ value: item.id, label: item.name }))];
  const processes = [{ value: NONE, label: 'By name' }, ...(options.carbon.processes ?? []).map((item) => ({ value: item.id, label: item.name }))];
  return (
    <div id="carbon-matching">
      {options.machines.length > 0 && <span className={own.label}>Machines → work centers</span>}
      {options.machines.map((machine) => (
        <div className={own.actions} key={machine.key} style={{ marginBottom: 6 }}>
          <span style={{ flex: 1, minWidth: 160 }}>{machine.name}</span>
          <Select value={options.mapping[`machine:${machine.key}`] ?? NONE} ariaLabel={`Work center for ${machine.name}`} options={centers}
                  onChange={(value) => void choose(`machine:${machine.key}`, value)} />
        </div>
      ))}
      <span className={own.label} style={{ marginTop: 8 }}>Kinds of work → processes</span>
      {options.processes.map((kind) => (
        <div className={own.actions} key={kind} style={{ marginBottom: 6 }}>
          <span style={{ flex: 1, minWidth: 160 }}>{PROCESS[kind] ?? kind}</span>
          <Select value={options.mapping[`process:${kind}`] ?? NONE} ariaLabel={`Process for ${PROCESS[kind] ?? kind}`} options={processes}
                  onChange={(value) => void choose(`process:${kind}`, value)} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={busy ? <Spinner size={12} /> : <RefreshCw size={13} />} disabled={busy} onClick={() => void refresh()}>
        Read Carbon’s work centers again</Button>
    </div>
  );
}

interface Quote { id: string; number: string | null; status: string | null }
interface Line {
  id: string; description: string | null; quantity: number[] | null; item: { id: string; number: string } | null;
  model: { id: string; name: string | null; bytes: number | null } | null;
}

/** A customer's model from a Carbon quote, opened as a STEVE part linked to the quoted Carbon item: model it, program
 * it, and Send to Carbon goes back to that item. */
function CustomerModels() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [quote, setQuote] = useState(NONE);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<{ quotes: Quote[] }>('/v1/carbon/quotes').then((made) => setQuotes(made.quotes), (failure) => setError(message(failure))); }, []);
  useEffect(() => {
    setLines(null);
    if (quote === NONE) return;
    void api<{ lines: Line[] }>(`/v1/carbon/quotes/${quote}/lines`).then((made) => setLines(made.lines), (failure) => setError(message(failure)));
  }, [quote]);
  const open = async (line: Line) => {
    setBusy(line.id); setError(null);
    try {
      const made = await api<{ document: { id: string } }>('/v1/carbon/open', json('POST', { quote_id: quote, line_id: line.id }));
      set({ dialog: null });
      await openDocument(made.document.id);
    } catch (failure) { setError(message(failure)); } finally { setBusy(null); }
  };
  if (quotes === null) return error ? <Note tone="warning">{error}</Note> : <Spinner size={14} />;
  return (
    <div id="carbon-quotes">
      <Select value={quote} ariaLabel="Quote" onChange={setQuote}
              options={[{ value: NONE, label: quotes.length ? 'Choose a quote…' : 'No quotes in Carbon' },
                        ...quotes.map((item) => ({ value: item.id, label: `${item.number ?? item.id}${item.status ? ` · ${item.status}` : ''}` }))]} />
      {lines === null && quote !== NONE && <Spinner size={14} />}
      {lines?.length === 0 && <Note>No lines on this quote.</Note>}
      {lines?.map((line) => (
        <div className={own.key} key={line.id}>
          <div>
            <b>{line.description || line.item?.number || 'Line'}</b> <span>· {line.item?.number ?? 'no item'}{line.quantity?.length ? ` · qty ${line.quantity.join(', ')}` : ''}</span>
            <p>{line.model ? `Model: ${line.model.name ?? 'attached'}` : 'No model on this line'}</p>
          </div>
          <div className={own.actions}>
            <Button size="sm" variant="ghost" icon={busy === line.id ? <Spinner size={12} /> : <FolderOpen size={13} />} disabled={!line.model || busy !== null}
                    onClick={() => void open(line)}>Open in STEVE</Button>
          </div>
        </div>
      ))}
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

/** The webhooks STEVE follows in Carbon, as Carbon's Settings → Webhooks names their tables (app/carbon.py HOOK_TABLES). */
const HOOK_TABLES = [
  { table: 'job', name: 'Job', events: 'Insert and Update', what: 'job status and quantities' },
  { table: 'makeMethod', name: 'Make Method', events: 'Insert and Update', what: 'a method version released' },
  { table: 'changeOrder', name: 'Change Notice', events: 'Update', what: 'a change notice released' },
];

/** One webhook's signing secret (Carbon shows it in the webhook's edit drawer): once saved, that table's calls must
 * carry Carbon's signature. */
function SigningSecret({ table, name, signed, onChange }: { table: string; name: string; signed: boolean; onChange: () => void }) {
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string | null) => {
    setBusy(true); setError(null);
    try { await api(`/v1/carbon/job-updates/secrets/${table}`, json('PUT', { secret: value })); setSecret(''); onChange(); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  if (signed) {
    return (
      <div className={own.actions}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
          <ShieldCheck size={13} /> Signed</span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>Remove secret</Button>
        {error && <Note tone="warning">{error}</Note>}
      </div>
    );
  }
  return (
    <div className={own.actions}>
      <input className={own.input} type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)}
             placeholder="Signing secret, whsec_…" aria-label={`Signing secret of the ${name} webhook`} style={{ flex: 1, minWidth: 160 }} />
      <Button size="sm" icon={busy ? <Spinner size={12} /> : undefined} disabled={busy || !secret.trim().startsWith('whsec_')}
              onClick={() => void save(secret.trim())}>Save</Button>
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

/** Carbon's jobs and method releases for the parts STEVE sent, back in STEVE: the webhook address to add in Carbon, and
 * each webhook's signing secret. Each call only says what changed; STEVE reads it from Carbon itself. */
function JobUpdates({ state, onChange }: { state: Connection['job_updates']; onChange: () => void }) {
  const [hook, setHook] = useState<{ url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (request: () => Promise<{ url: string } | null>) => {
    setBusy(true); setError(null);
    try { setHook(await request()); setCopied(false); onChange(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const address = (rotate = false) => run(() => api<{ url: string }>(`/v1/carbon/job-updates${rotate ? '?rotate=true' : ''}`, { method: 'POST' }));
  return (
    <div id="carbon-job-updates">
      {!state.on && !hook && (
        <Button size="sm" icon={busy ? <Spinner size={12} /> : undefined} disabled={busy} onClick={() => void address()} id="carbon-job-updates-on">Turn on</Button>
      )}
      {(state.on || hook) && (
        <>
          <p style={{ margin: '0 0 8px', color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
            {state.last_call_at ? `Carbon last called ${when(state.last_call_at)}.` : 'Carbon hasn’t called yet.'}
          </p>
          {hook ? (
            <>
              <div className={own.secretValue}>
                <code aria-label="Webhook address">{hook.url}</code>
                <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void navigator.clipboard.writeText(hook.url).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
              </div>
              <p style={{ margin: '8px 0 0', color: 'var(--text-2)', fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
                In Carbon, open Settings → Webhooks and add one webhook per table below, each with this address.</p>
              <Note>Keep the address private.</Note>
            </>
          ) : null}
          {HOOK_TABLES.map((row) => (
            <div className={own.key} key={row.table}>
              <div>
                <b>{row.name}</b> <span>· {row.events}</span>
                <p>{row.what}</p>
              </div>
              <SigningSecret table={row.table} name={row.name} signed={(state.signed ?? []).includes(row.table)} onChange={onChange} />
            </div>
          ))}
          <Note>Copy each webhook’s signing secret from its edit drawer in Carbon: STEVE then takes only calls Carbon signed.</Note>
          <div className={own.actions} style={{ marginTop: 8 }}>
            {!hook && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void address()}>Show address</Button>}
            <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} disabled={busy} onClick={() => void (async () => {
              if (await askConfirm({ title: 'Make a new address?', detail: 'The address in Carbon stops working: paste the new one into its webhooks.', action: 'New address' })) await address(true);
            })()}>New address</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await api('/v1/carbon/job-updates', { method: 'DELETE' }); return null; })}>Turn off</Button>
          </div>
        </>
      )}
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

function SendRow({ send, onChange }: { send: Send; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (choice: 'confirm' | 'cancel') => {
    setBusy(true); setError(null);
    try { await api(`/v1/carbon/releases/${send.id}/${choice}`, { method: 'POST' }); onChange(); }
    catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  return (
    <div className={own.key} data-carbon-send={send.id}>
      <div>
        <b>{send.document}</b> <span>· {send.options.number} rev {send.options.revision} · {STATE[send.state]} · asked by {ASKED_BY[send.asked_by] ?? send.asked_by}</span>
        <p>{when(send.created_at)}{send.result?.bill ? ` · ${send.result.bill.lines} bill-of-materials lines` : ''}</p>
        {send.state === 'failed' && send.error && <Note tone="warning">{send.error}</Note>}
        {send.steps.length > 0 && (
          <details>
            <summary className={own.label} style={{ cursor: 'pointer', marginTop: 4 }}>Steps</summary>
            <ul className={own.recent} style={{ fontFamily: 'inherit' }}>{send.steps.map((step, index) => <li key={index}>{step.at} · {step.text}</li>)}</ul>
          </details>
        )}
        {error && <Note tone="warning">{error}</Note>}
      </div>
      <div className={own.actions}>
        {send.state === 'awaiting_confirmation' && <>
          <Button size="sm" variant="primary" icon={busy ? <Spinner size={12} /> : <Check size={13} />} disabled={busy} onClick={() => void decide('confirm')}>Send</Button>
          <Button size="sm" variant="ghost" icon={<X size={13} />} disabled={busy} onClick={() => void decide('cancel')}>Cancel</Button>
        </>}
        {send.result?.url && <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => window.open(send.result!.url, '_blank', 'noopener')}>Open in Carbon</Button>}
      </div>
    </div>
  );
}

export default function CarbonSection() {
  const section = settingsSections().find((item) => item.id === 'carbon')!;
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [sends, setSends] = useState<Send[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const made = await api<{ connection: Connection | null; sends: Send[] }>('/v1/carbon');
      setConnection(made.connection); setSends(made.sends); setError(null);
    } catch (failure) { setError(message(failure)); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const waiting = sends.filter((send) => send.state === 'awaiting_confirmation');
  const shop = connection?.shop;
  return (
    <SettingsPage section={section} id="settings-carbon">
      {waiting.length > 0 && (
        <Card title="Waiting for you" description="Sends the STEVE assistant or an AI agent asked for. Nothing reaches Carbon until you send it." id="carbon-waiting">
          {waiting.map((send) => <SendRow key={send.id} send={send} onChange={() => void load()} />)}
        </Card>
      )}
      <Card title="Connection" description="Parts and designs go to your Carbon with Send to Carbon, in the Export menu."
            actions={connection && !editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change key</Button>}>
        {error && <Note tone="warning">{error}</Note>}
        {connection === undefined ? <Spinner size={14} />
          : !connection || editing ? <Connect current={connection} onDone={() => { setEditing(false); void load(); }} />
          : (
            <div className={own.key} id="carbon-connection">
              <div>
                <b>{new URL(connection.url).host}</b> <span>· key …{connection.key_hint}</span>
                <p>{connection.status === 'active' ? 'Connected' : 'Not working'}
                  {shop?.work_centers ? ` · ${shop.work_centers.length} work centers, ${shop.processes?.length ?? 0} processes` : ''}</p>
                {connection.last_error && <Note tone="warning">{connection.last_error}</Note>}
              </div>
              <div className={own.actions}>
                <Button size="sm" variant="ghost" onClick={() => void (async () => {
                  if (await askConfirm({ title: 'Disconnect Carbon?', detail: 'STEVE forgets the key. What it sent stays in Carbon, and STEVE remembers which item each document went to for when you connect again.', action: 'Disconnect' })) {
                    try { await api('/v1/carbon', { method: 'DELETE' }); void load(); } catch (failure) { setError(message(failure)); }
                  }
                })()}>Disconnect</Button>
              </div>
            </div>
          )}
      </Card>
      {connection && !editing && (
        <Card title="Machines and processes" description="What a CAM program’s setups become in Carbon’s routing, when you send a part it machines.">
          <Matching />
        </Card>
      )}
      {connection && !editing && (
        <Card title="Customer models" description="A model from a Carbon quote, opened as a STEVE part linked to the quoted item: Send to Carbon goes back to it.">
          <CustomerModels />
        </Card>
      )}
      {connection && !editing && (
        <Card title="Updates from Carbon" description="Carbon’s jobs for the parts you sent (their status and how many are made) and their method releases, on those parts in STEVE. Open quality issues show there too.">
          <JobUpdates state={connection.job_updates} onChange={() => void load()} />
        </Card>
      )}
      {sends.length > waiting.length && (
        <Card title="Recent sends" description="What went to Carbon, newest first.">
          {sends.filter((send) => send.state !== 'awaiting_confirmation').map((send) => <SendRow key={send.id} send={send} onChange={() => void load()} />)}
        </Card>
      )}
    </SettingsPage>
  );
}

/**
 * Settings → Connectors: software you run on your own network that offers STEVE actions (print, load a program, run a
 * local simulation, look up stock…) and reports events (app/connectors.py, app/connector_runs.py). Pair with a one-time
 * code, confirm by key fingerprint, then allow each action: who may run it, whose runs wait for you (or run at once:
 * auto-approval), and for programs
 * the machine it is. Runs waiting for you and recent runs are here too. STEVE never connects into your network.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Play, Plug2, TriangleAlert } from 'lucide-react';
import { Button, Segmented, Select, Spinner, Switch } from '@/ui';
import { api, json } from '@/lib/api';
import { set } from '@/state/store';
import { Actions, ASKED_BY, CALLER_LABEL, describeInput, STATE_LABEL, type Caller, type Connector, type ConnectorAction,
  type ConnectorsOverview, type Run, type SetupChange } from '@/lib/actions';
import { RunStatus } from '@/dialogs/RunActionDialog';
import { settingsSections } from '../registry';
import { Card, Note, Past, Row, SettingsPage } from '../ui';
import { updateSettings, useSetting } from '../store';
import { refreshPanels } from '@/connectors/panels';
import styles from '../Settings.module.css';
import own from './Developers.module.css';
import { askConfirm } from '@/ui/confirm';
import { acknowledge } from '@/terms/terms';

const when = (value: string | null) => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
// Lowercases a label's first letter for use mid-sentence, but never an acronym's ("AI agents").
const lower = (text: string) => (/^[A-Z]{2}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const CALLERS: Caller[] = ['person', 'assistant', 'agent', 'service_account', 'app', 'panel'];
type Choice = 'no' | 'yes' | 'ask';

/** Pairing: a one-time code to type into the connector. While it's shown the page watches for the connector to enroll
 * (`onCode`), and the code goes away once one has (`used`). */
function Pair({ onDone, onCode, used }: { onDone: () => void; onCode: (until: number | null) => void; used: boolean }) {
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  useEffect(() => { if (used && pairing) { setPairing(null); onCode(null); } }, [used]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setError(null);
    try {
      const made = await api<{ code: string; expires_at: string }>('/v1/connectors/pairings', { method: 'POST' });
      setPairing(made); setCopied(false); onCode(new Date(made.expires_at).getTime());
    } catch (failure) { setError(message(failure)); }
  };
  return (
    <div className={own.form}>
      {pairing ? (
        <div className={own.secret} role="status" id="connectors-code">
          <p>Enter this code in your connector. It works once, until {when(pairing.expires_at)}. This page shows the connector as soon as it checks in.</p>
          <div className={own.secretValue}>
            <code>{pairing.code}</code>
            <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void navigator.clipboard.writeText(pairing.code).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
          <div><Button size="sm" onClick={() => { setPairing(null); onCode(null); onDone(); }}>Done</Button></div>
        </div>
      ) : <div className={own.actions}><Button icon={<Plug2 size={14} />} onClick={() => void make()} id="connectors-pair">Pair a connector</Button></div>}
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

function Confirm({ connector, onDone }: { connector: Connector; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // A connector that just checked in: bring its fingerprint box into view, ready to paste into.
  useEffect(() => {
    if (Date.now() - new Date(connector.enrolled_at).getTime() > 15 * 60_000) return;
    field.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field.current?.focus({ preventScroll: true });
  }, [connector.id, connector.enrolled_at]);
  const confirm = async () => {
    setError(null);
    try { await api(`/v1/connectors/${connector.id}/confirm`, json('POST', { fingerprint: typed.trim() })); onDone(); } catch (failure) { setError(message(failure)); }
  };
  return (
    <div className={own.form}>
      <Note tone="warning">Waiting for you to confirm. Copy the key fingerprint your connector shows (it ends in <code className={styles.inlineCode}>{connector.fingerprint}</code>) and paste it below: a match proves it’s yours. Don’t confirm a connector you didn’t just pair (enrolled from {connector.enrolled_ip || 'an unknown address'}, {when(connector.enrolled_at)}).</Note>
      <div className={own.actions}>
        <input ref={field} className={own.input} style={{ flex: 1, minWidth: 220 }} value={typed} placeholder="Fingerprint as the connector shows it" aria-label="Fingerprint"
               onChange={(event) => setTyped(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && typed.trim()) void confirm(); }} />
        <Button disabled={!typed.trim()} onClick={() => void confirm()}>Confirm</Button>
      </div>
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

/** One action: what it does and takes, and the owner's grant: who may run it, whose runs wait for the owner's
 * confirmation (the rest run at once: auto-approved), and for programs the machine it is. */
function ActionGrant({ action, machines, onDone, hasPanel }: { action: ConnectorAction; machines: ConnectorsOverview['machines']; onDone: () => void; hasPanel: boolean }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Record<Caller, Choice>>(() => Object.fromEntries(CALLERS.map((caller) => [caller,
    !(action.grant.granted ? action.grant.callers : ['person']).includes(caller) ? 'no' : action.grant.ask.includes(caller) ? 'ask' : 'yes'])) as Record<Caller, Choice>);
  const [override, setOverride] = useState(action.grant.override_person);
  const [panelDocuments, setPanelDocuments] = useState(action.grant.panel_documents);
  const takesDocuments = Object.values(action.inputs.properties).some((spec) => !!spec['x-steve']);
  const [machine, setMachine] = useState(action.grant.machine?.id ?? '');
  const [checked, setChecked] = useState(action.grant.verifications.includes('checked'));
  const [error, setError] = useState<string | null>(null);
  const forced = action.needs_person && !override;   // the connector says a person confirms every run
  const callers = CALLERS.filter((caller) => choice[caller] !== 'no');
  const ask = CALLERS.filter((caller) => choice[caller] === 'ask');
  const save = async () => {
    setError(null);
    try {
      await Actions.grant(action.id, { callers, ask: forced ? CALLERS : ask, override_person: override, machine_id: machine || null,
                                       verifications: checked ? ['checked', 'verified'] : ['verified'],
                                       panel_documents: panelDocuments && takesDocuments && choice.panel !== 'no' });
      setOpen(false); onDone();
    } catch (failure) { setError(message(failure)); }
  };
  const remove = async () => {
    setError(null);
    try { await Actions.ungrant(action.id); setOpen(false); onDone(); } catch (failure) { setError(message(failure)); }
  };
  const inputs = Object.entries(action.inputs.properties);
  const granted = action.grant;
  const auto = granted.callers.filter((caller) => !granted.ask.includes(caller));
  const waits = granted.callers.filter((caller) => granted.ask.includes(caller));
  const names = (list: Caller[]) => list.map((caller) => lower(CALLER_LABEL[caller])).join(', ');
  return (
    <div className={own.key} data-action={action.name} data-granted={granted.granted || undefined} data-revoked={action.removed || undefined}>
      <div>
        <b>{action.title}</b>{' '}
        {granted.granted ? <span className={own.allowed}>Allowed</span> : <span className={own.notAllowed}>Not allowed</span>}
        {action.needs_person && <b className={own.sensitive}> · {granted.override_person ? 'connector asks for a person (overridden)' : 'needs a person to confirm'}</b>}
        {action.description && <p>{action.description}</p>}
        <p>{inputs.length ? `Takes: ${inputs.map(([name, spec]) => `${spec.title ?? name} (${lower(describeInput(spec))})`).join(' · ')}` : 'Takes nothing.'}</p>
        {granted.granted && !open && (
          <p>Run by {granted.callers.map((caller) => lower(CALLER_LABEL[caller])).join(', ')}
            {' · '}{!auto.length ? 'every run waits for you' : !waits.length ? 'every run goes at once' : `waits for you when run by ${names(waits)}; at once for ${names(auto)}`}
            {granted.machine ? ` · on ${granted.machine.name}` : ''}
            {granted.panel_documents ? ' · its panel sends the open document on your click without asking' : ''}</p>
        )}
        {action.removed && <p>The connector no longer offers this action.</p>}
        {open && (
          <div className={own.form}>
            <span className={own.label}>Who may run it</span>
            <div className={own.grantRows}>
              {CALLERS.filter((caller) => caller !== 'panel' || hasPanel || choice.panel !== 'no').map((caller) => (
                <div key={caller} className={own.grantRow} data-caller={caller}>
                  <span>{CALLER_LABEL[caller]}</span>
                  <Segmented size="sm" value={forced && choice[caller] === 'yes' ? 'ask' : choice[caller]} onChange={(value: Choice) => setChoice({ ...choice, [caller]: value })}
                             options={[{ value: 'no', label: 'Not allowed' }, { value: 'yes', label: 'Runs at once', disabled: forced }, { value: 'ask', label: 'Asks you first' }]} />
                </div>
              ))}
            </div>
            <p>{forced ? 'The connector says a person confirms every run of this action, so every allowed run asks you first.'
              : 'Runs at once: approved automatically. Asks you first: the run waits until you confirm it (top bar, or Connectors).'}</p>
            {takesDocuments && choice.panel !== 'no' && !forced && (
              <label className={own.scope} data-panel-documents>
                <input type="checkbox" checked={panelDocuments} onChange={() => setPanelDocuments(!panelDocuments)} />
                <span>Its panel may send the document open in STEVE without asking, when you click a button in it. Any other
                  document, or a run you didn’t click, still asks you.</span></label>
            )}
            {action.needs_person && (
              <label className={own.scope}><input type="checkbox" checked={override} onChange={() => setOverride(!override)} />
                <span>Let runs go without a person even though the connector asks for one</span></label>
            )}
            {override && <Note tone="warning">The connector’s author says a person should confirm every run of {action.title}. With this on, the callers you don’t tick above run it without you. Keep your equipment’s own safety systems in place.</Note>}
            {action.takes_program && (
              <>
                <span className={own.label}>The machine it runs on</span>
                <p>A program goes only to the machine it was posted for.</p>
                {machines.length === 0 ? <Note>Add your machines to your shop (Manufacture) first.</Note>
                  : <Select value={machine || 'none'} onChange={(value) => setMachine(value === 'none' ? '' : value)} ariaLabel="Machine"
                            options={[{ value: 'none', label: 'Choose a machine…' }, ...machines.map((item) => ({ value: item.id, label: item.name }))]} />}
                <label className={own.scope}><input type="checkbox" checked={checked} onChange={() => setChecked(!checked)} />
                  <span>Also accept programs that are checked but not fully verified</span></label>
              </>
            )}
            {error && <Note tone="warning">{error}</Note>}
            <div className={own.actions}>
              <Button size="sm" variant="primary" disabled={!callers.length} onClick={() => void save()}>{granted.granted ? 'Save' : 'Allow'}</Button>
              {granted.granted && <Button size="sm" onClick={() => void remove()}>Stop allowing</Button>}
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
      {!open && !action.removed && <div className={own.actions}><Button size="sm" onClick={() => setOpen(true)}>{granted.granted ? 'Change' : 'Allow…'}</Button></div>}
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr data-run={run.id} data-security={run.state === 'rejected' || run.state === 'failed' || undefined} onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
        <td>{when(run.updated_at)}</td><td>{run.action.title}</td><td>{ASKED_BY[run.requested_by.kind]}</td>
        <td>{STATE_LABEL[run.state]}{run.state === 'queued' && run.waiting ? ' · making its files' : ''}{run.files.length ? ` · ${run.files.length} file${run.files.length > 1 ? 's' : ''}` : ''}</td>
      </tr>
      {open && <tr><td colSpan={4}><RunStatus run={run} /></td></tr>}
    </>
  );
}

const CHANGE: Record<string, (change: SetupChange) => string> = {
  confirm: () => 'Paired and confirmed',
  allow: (change) => `Allowed ${change.what || 'an action'}`,
  disallow: (change) => `Took back ${change.what || 'an action'}`,
  publish_panel: (change) => `Published the panel ${change.what}${change.version && change.version > 1 ? ` (version ${change.version})` : ''}`,
  remove_panel: (change) => `Removed the panel ${change.what}`,
  revoke: () => 'Revoked',
};
const short = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** One connector's changes made in automatic mode. */
function ChangeGroup({ changes, onUndo }: { changes: SetupChange[]; onUndo: (change: SetupChange) => void }) {
  const connector = changes[0].connector;
  return (
    <div className={own.changeGroup} data-changes={connector?.id ?? 'other'}>
      <div className={own.changeHead}>
        <b>{connector?.name ?? 'A connector no longer here'}</b>
        {connector && connector.status !== 'active' && <span className={own.notAllowed}>{connector.status === 'revoked' ? 'Revoked' : 'Not confirmed'}</span>}
      </div>
      {changes.map((change) => (
        <div key={change.id} className={own.change} data-change={change.op} data-undone={change.undone_at || undefined}>
          <span>{(CHANGE[change.op] ?? (() => change.op))(change)}</span>
          <span className={own.changeWhen}>{change.by === 'assistant' ? 'STEVE · ' : change.by === 'connector' ? 'by the connector · ' : ''}{change.undone_at ? `undone ${short(change.undone_at)}` : short(change.at)}</span>
          {change.undoable ? <Button size="sm" variant="ghost" onClick={() => onUndo(change)}>Undo</Button> : <span />}
        </div>
      ))}
    </div>
  );
}

/** Automatic mode: the assistant and AI agents set connectors up without asking; what they set up, to undo. */
function Automatic({ overview, onChange }: { overview: ConnectorsOverview; onChange: () => void }) {
  const on = useSetting('connectors.automatic');
  const [error, setError] = useState<string | null>(null);
  const groups = new Map<string, SetupChange[]>();
  for (const change of overview.setup_log) groups.set(change.connector?.id ?? 'other', [...(groups.get(change.connector?.id ?? 'other') ?? []), change]);
  const all = [...groups.values()];
  const current = all.filter((changes) => changes[0].connector?.status === 'active' || changes[0].connector?.status === 'pending');
  const past = all.filter((changes) => !current.includes(changes));
  const undoable = overview.setup_log.filter((change) => change.undoable);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try { await work(); onChange(); } catch (failure) { setError(message(failure)); }
  };
  const undo = async (change: SetupChange) => {
    const detail = change.op === 'confirm' ? 'The connector is revoked: pair it again to reconnect.' : change.op === 'allow' ? 'The action is no longer allowed.' : 'The panel is removed.';
    if (await askConfirm({ title: `Undo “${(CHANGE[change.op] ?? (() => change.op))(change)}”?`, detail, action: 'Undo' })) await act(() => Actions.undo(change.id));
  };
  const undoAll = async () => {
    if (!await askConfirm({ title: 'Undo everything AI set up?', detail: 'Connectors it confirmed are revoked, what it allowed is taken back and panels it published are removed.', action: 'Undo everything' })) return;
    await act(() => Actions.undoAll());
  };
  return (
    <Card title="Automatic mode" id="connectors-automatic" description="The STEVE assistant and your AI agents set connectors up for you: pair them, allow their actions and publish their panels.">
      <Row label="Let AI set up my connectors" hint="Actions a connector says need a person still wait for you on every run. API keys and other apps still need your OK here.">
        <Switch checked={on} label="Let AI set up my connectors"
                onCheckedChange={(value) => void act(async () => {
                  if (value && !await acknowledge('automatic_mode')) return;   // asked once (app/terms.py)
                  await updateSettings({ 'connectors.automatic': value, ...(value ? { 'connectors.automaticRequest': {} } : {}) });
                })} />
      </Row>
      {error && <Note tone="warning">{error}</Note>}
      {all.length > 0 && (
        <div className={own.changes}>
          <div className={own.changesHead}>
            <span className={own.label}>Set up by AI</span>
            {undoable.length > 1 && <Button size="sm" variant="ghost" onClick={() => void undoAll()}>Undo everything</Button>}
          </div>
          {current.map((changes) => <ChangeGroup key={changes[0].connector?.id ?? 'other'} changes={changes} onUndo={(change) => void undo(change)} />)}
          {!current.length && <p className={own.empty}>Nothing set up by AI is in use now.</p>}
          <Past label="Revoked connectors" count={past.length}>
            {past.map((changes) => <ChangeGroup key={changes[0].connector?.id ?? 'other'} changes={changes} onUndo={(change) => void undo(change)} />)}
          </Past>
        </div>
      )}
    </Card>
  );
}

export default function ConnectorsSection() {
  const section = settingsSections().find((item) => item.id === 'connectors')!;
  const [overview, setOverview] = useState<ConnectorsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try { setOverview(await Actions.overview()); } catch (failure) { setError(message(failure)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Connectors check in from outside: while a pairing code is out or a connector waits to be confirmed the page looks
  // every few seconds, so the fingerprint box appears as soon as the connector enrolls; otherwise now and then.
  const [codeUntil, setCodeUntil] = useState<number | null>(null);
  const pendingIds = (overview?.connectors ?? []).filter((connector) => connector.status === 'pending').map((connector) => connector.id).join();
  const [pendingAtCode, setPendingAtCode] = useState('');
  const watching = (codeUntil !== null && codeUntil > Date.now()) || pendingIds !== '';
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, watching ? 3000 : 30_000);
    return () => window.clearInterval(timer);
  }, [watching, load]);
  const codeUsed = codeUntil !== null && pendingIds !== pendingAtCode && pendingIds.split(',').some((id) => id && !pendingAtCode.split(',').includes(id));
  const revoke = async (connector: Connector) => {
    if (!await askConfirm({ title: `Revoke “${connector.name}”?`, detail: 'It stops at once and its unfinished runs are cancelled. This can’t be undone: pair it again to reconnect.', action: 'Revoke' })) return;
    try { await api(`/v1/connectors/${connector.id}/revoke`, { method: 'POST' }); await load(); } catch (failure) { setError(message(failure)); }
  };
  const removePanel = async (id: string, title: string) => {
    if (!await askConfirm({ title: `Remove the panel “${title}”?`, detail: 'It goes from your panes. Whoever published it can publish it again.', action: 'Remove' })) return;
    try { await Actions.removePanel(id); await load(); refreshPanels(); } catch (failure) { setError(message(failure)); }
  };
  const inUse = (overview?.connectors ?? []).filter((connector) => connector.status !== 'revoked');
  const revoked = (overview?.connectors ?? []).filter((connector) => connector.status === 'revoked');
  const connectorRow = (connector: Connector) => (
    <div key={connector.id} className={own.connector} data-connector={connector.id} data-revoked={connector.status === 'revoked' || undefined}>
      <div className={own.key} style={{ borderTop: 0 }}>
        <div>
          <b>{connector.name}</b> <code>{connector.version}</code>{' '}
          {connector.status === 'active' && <span className={connector.online ? own.allowed : own.notAllowed}>{connector.online ? 'Connected' : 'Not connected'}</span>}
          <p>{connector.status === 'active' ? `Last seen ${when(connector.last_seen_at)}${connector.last_seen_ip ? ` from ${connector.last_seen_ip}` : ''}`
            : connector.status === 'pending' ? 'Waiting for confirmation' : `Revoked ${when(connector.revoked_at)}`}</p>
          {connector.status !== 'pending' && <p>Key fingerprint <code>{connector.fingerprint}</code></p>}
        </div>
        {connector.status !== 'revoked' && <div className={own.actions}><Button size="sm" onClick={() => void revoke(connector)}>Revoke</Button></div>}
      </div>
      {connector.status === 'pending' && <Confirm connector={connector} onDone={() => void load()} />}
      {connector.status === 'active' && (
        <>
          {connector.actions.length === 0 && <p className={own.empty}>This connector offers no actions.</p>}
          {connector.actions.map((action) => <ActionGrant key={`${action.id}:${action.grant.granted_at}`} action={action} machines={overview?.machines ?? []}
                                                          hasPanel={connector.panels.length > 0} onDone={() => void load()} />)}
          {connector.panels.map((panel) => (
            <div key={panel.id} className={own.key} data-panel={panel.name}>
              <div>
                <b>{panel.title}</b> <span className={own.allowed}>Panel</span>
                <p>In the {panel.placement.join(' and ')} pane{panel.placement.length > 1 ? 's' : ''} · version {panel.version} · published {when(panel.published_at)}
                  {panel.published_by !== 'person' ? ` by ${ASKED_BY[panel.published_by as Caller] ?? panel.published_by}` : ''} · {Math.max(1, Math.round(panel.bytes / 1000))} kB</p>
                <p>It runs sandboxed, with no network: it can only run this connector’s actions you allow for “Its panel”.</p>
              </div>
              <div className={own.actions}><Button size="sm" onClick={() => void removePanel(panel.id, panel.title)}>Remove</Button></div>
            </div>
          ))}
          {connector.events.length > 0 && <p className={own.empty}>Reports: {connector.events.map((event) => event.name).join(', ')} (in the event feed and webhooks).</p>}
        </>
      )}
    </div>
  );
  const runnable = overview?.connectors.some((connector) => connector.status === 'active' && connector.actions.some((action) => action.grant.granted && !action.removed));
  return (
    <SettingsPage section={section} actions={runnable ? <Button size="sm" icon={<Play size={13} />} onClick={() => set({ dialog: 'runAction' })}>Run an action…</Button> : undefined}>
      {error && <Note tone="warning">{error} <Button size="sm" onClick={() => void load()}>Try again</Button></Note>}
      {!overview ? (!error && <div className={styles.loading} style={{ padding: 24 }}><Spinner size={16} /></div>) : (
        <>
          {overview.waiting.length > 0 && (
            <Card title="Waiting for you" id="connectors-waiting" description="Runs that someone else asked for and that need your confirmation before they go out.">
              {overview.waiting.map((run) => (
                <div key={run.id} className={own.form}><b>{run.action.title}</b><RunStatus run={run} onChange={() => void load()} /></div>
              ))}
            </Card>
          )}
          <Automatic overview={overview} onChange={() => { void load(); refreshPanels(); }} />
          <Card title="Connectors" id="connectors-list" description="Software you run on your own network that offers STEVE actions: print a part, load a program on a machine, run a simulation on your own hardware, check stock, anything it’s written to do. It always connects out to STEVE; STEVE never connects into your network. You allow each action.">
            <Pair onDone={() => void load()} used={codeUsed} onCode={(until) => { setCodeUntil(until); setPendingAtCode(pendingIds); }} />
            {!inUse.length && <p className={own.empty}>No connectors in use.</p>}
            {inUse.map(connectorRow)}
            <Past label="Revoked connectors" count={revoked.length}>{revoked.map(connectorRow)}</Past>
          </Card>
          <Card title="Runs" id="connectors-runs" description="What was asked of your connectors, by whom, and how it ended. Select a run for its result and files.">
            {!overview.runs.length ? <p className={own.empty}>Nothing run yet.</p> : (
              <div className={own.logWrap}>
                <table className={`${own.log} ${own.plain}`}>
                  <thead><tr><th>Updated</th><th>Action</th><th>Asked by</th><th>State</th></tr></thead>
                  <tbody>{overview.runs.map((run) => <RunRow key={run.id} run={run} />)}</tbody>
                </table>
              </div>
            )}
          </Card>
          <Note><TriangleAlert size={12} /> Connectors are yours to run and secure: what an action does is up to the software you run. See the docs for the protocol.</Note>
        </>
      )}
    </SettingsPage>
  );
}

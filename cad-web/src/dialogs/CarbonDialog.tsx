/**
 * Send to Carbon (app/carbon.py): this part or design, as saved on main, to the person's Carbon ERP: its item and
 * revision, its STEP as the item's 3D model, its drawing, and a design's bill of materials as a new Draft method. The
 * number and revision start as the ones it was sent with before (else a number from its name, revision A); the send runs
 * on the server and its steps show here as they happen, then a link to the item in Carbon.
 */
import { useEffect, useState } from 'react';
import { Download, ExternalLink, Factory, Settings2 } from 'lucide-react';
import { Button, Dialog, Field, Spinner, Switch } from '@/ui';
import { api, json } from '@/lib/api';
import { isDirty, set, useApp } from '@/state/store';
import { openSettings } from '@/settings/registry';
import styles from './Dialogs.module.css';
import { withWorkspace } from '@/teams/current';

export interface CarbonSend {
  id: string; document: string; state: 'awaiting_confirmation' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  options: { number: string; revision: string }; steps: { at: string; text: string }[];
  result: { url?: string; file?: string; number: string; revision: string; bill?: { lines: number; notes?: string[] };
            routing?: { operations: number; notes?: string[] }; stock?: { lines: number; stock: string[]; notes?: string[] }; inspection?: { characteristics: number; url: string };
            change_notice?: { readable_id: string; url: string } } | null; error: string | null;
}
export interface CarbonJob {
  id: string; readable_id: string; item: string; status: string; quantity: number | null; complete: number | null;
  scrap: number | null; due: string | null; sales_order: string | null; open: boolean; url: string | null;
}
export interface CarbonIssue { id: string; readable_id: string; name: string; status: string | null; priority: string | null; url: string }
/** Where the item's method stands in Carbon: its Active and newest Draft versions, and the change notice the Draft is on. */
export interface CarbonMethod {
  active: number | null; draft: number | null; notice: { id: string; readable_id: string; status: string; url: string | null } | null;
}
interface ForDocument {
  connected: boolean; kind: string; number: string; revision: string;
  item: { url: string | null; sent_at: string; document_revision: number | null; method?: CarbonMethod | null } | null; sends: CarbonSend[];
  jobs: CarbonJob[]; issues: CarbonIssue[];
}

const count = (value: number | null) => (value == null ? '?' : String(Math.round(value * 1000) / 1000));
/** "J000012 · In Progress · 3 of 10 made (1 scrapped) · due 2026-11-02" */
export const jobText = (job: CarbonJob) => [job.readable_id, job.status, `${count(job.complete)} of ${count(job.quantity)} made${job.scrap ? ` (${count(job.scrap)} scrapped)` : ''}`,
  ...(job.open && job.due ? [`due ${job.due}`] : []), ...(job.item ? [job.item] : [])].join(' · ');
/** "Version 2 released · version 3 a Draft on change notice CN-000007 (Engineering Complete)" */
export const methodText = (method: CarbonMethod) => [
  method.active != null ? `Version ${method.active} released` : 'Not released yet',
  ...(method.draft != null ? [`version ${method.draft} a Draft${method.notice ? ` on change notice ${method.notice.readable_id}${method.notice.status ? ` (${method.notice.status})` : ''}` : ''}`] : []),
].join(' · ');
export const issueText = (issue: CarbonIssue) => [issue.readable_id, issue.status, issue.name].filter(Boolean).join(' · ');

/** The part's jobs in Carbon and its open quality issues, each a link into Carbon. */
function ShopFloor({ jobs, issues }: { jobs: CarbonJob[]; issues: CarbonIssue[] }) {
  if (!jobs.length && !issues.length) return null;
  return (
    <div id="carbon-shop-floor" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-2)', lineHeight: 1.6 }}>
      {issues.length > 0 && <div style={{ color: 'var(--warning)' }}>Open quality issues:</div>}
      {issues.map((issue) => <div key={issue.id} data-carbon-issue={issue.id}><a href={issue.url} target="_blank" rel="noreferrer">{issueText(issue)}</a></div>)}
      {jobs.length > 0 && <div>Jobs in Carbon:</div>}
      {jobs.map((job) => (
        <div key={job.id} data-carbon-job={job.id} style={job.open ? undefined : { color: 'var(--text-3)' }}>
          {job.url ? <a href={job.url} target="_blank" rel="noreferrer">{jobText(job)}</a> : jobText(job)}
        </div>
      ))}
    </div>
  );
}

/** A switch with its label beside it (the label toggles it too). */
function Option({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', fontSize: 'var(--fs-sm)', color: 'var(--text-2)', cursor: 'pointer' }}>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
      <span>{label}</span>
    </label>
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const RUNNING = new Set(['queued', 'running']);

export default function CarbonDialog({ open }: { open: boolean }) {
  const saved = useApp((state) => state.doc.saved);
  const branch = useApp((state) => state.doc.branch);
  const dirty = useApp((state) => isDirty(state));
  const name = useApp((state) => state.doc.name);
  const [info, setInfo] = useState<ForDocument | null>(null);
  const [number, setNumber] = useState('');
  const [revision, setRevision] = useState('');
  const [model, setModel] = useState(true);
  const [drawing, setDrawing] = useState(true);
  const [bom, setBom] = useState(true);
  const [routing, setRouting] = useState(true);
  const [stock, setStock] = useState(true);
  const [inspection, setInspection] = useState(true);
  const [changeNotice, setChangeNotice] = useState(true);
  const [send, setSend] = useState<CarbonSend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const savedId = saved?.id;
  useEffect(() => {
    if (!open || !savedId) return;
    setInfo(null); setSend(null); setError(null);
    api<ForDocument>(`/v1/carbon/documents/${savedId}`).then((found) => {
      setInfo(found); setNumber(found.number); setRevision(found.revision);
      const running = found.sends.find((item) => RUNNING.has(item.state));
      if (running) setSend(running);
    }, (failure) => setError(message(failure)));
  }, [open, savedId]);
  const sendId = send?.id;
  const following = !!send && RUNNING.has(send.state);
  useEffect(() => {   // A send runs on the server: its steps show as they happen.
    if (!following || !sendId) return;
    const timer = window.setInterval(() => {
      api<{ send: CarbonSend }>(`/v1/carbon/releases/${sendId}`).then((made) => setSend(made.send), () => { /* next time */ });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [following, sendId]);
  const go = async (file = false) => {
    if (!savedId) return;
    setError(null);
    try {
      const made = await api<{ send: CarbonSend }>(file ? '/v1/carbon/exports' : '/v1/carbon/releases',
        json('POST', { document_id: savedId, number: number.trim(), revision: revision.trim(), model, drawing, bom, routing, stock, inspection,
                     change_notice: changeNotice }));
      setSend(made.send);
    } catch (failure) { setError(message(failure)); }
  };
  const onBranch = branch !== 'main';
  const ready = !!info && !onBranch && !!number.trim() && !!revision.trim() && !following;
  const close = () => set({ dialog: null });
  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()} width={520} title={`Send “${name}” to Carbon`}
      icon={<div className={styles.itemIcon} style={{ color: 'var(--ws)' }}><Factory size={17} /></div>}
      description={!saved ? 'Save it first.' : onBranch ? 'Only main is sent: switch to main, or merge first.'
        : `Sends revision ${saved.revision} as saved${dirty ? ' (your unsaved changes aren’t included)' : ''}: the item, its 3D model and drawing${info?.kind === 'design' ? ', and its bill of materials as a Draft' : ''}.`}
      footer={<>
        <Button onClick={close}>Close</Button>
        {info && !send?.result && (
          <Button variant={info.connected ? 'ghost' : 'primary'} icon={<Download size={14} />} disabled={!ready} onClick={() => void go(true)} id="carbon-file">
            Download import file</Button>
        )}
        {info?.connected && !send?.result && (
          <Button variant="primary" disabled={!ready} onClick={() => void go()} id="carbon-send">{following ? 'Sending…' : 'Send'}</Button>
        )}
      </>}>
      {error && <div role="alert" className={styles.message}>{error}</div>}
      {!info && !error && <Spinner />}
      {info && !info.connected && !send && (
        <div className={styles.message} style={{ color: 'var(--text-3)' }}>
          Carbon isn’t connected: sending needs its API (Carbon’s Business plan). Download Carbon’s import file instead, for its own
          importers, or <Button size="sm" variant="ghost" icon={<Settings2 size={13} />} onClick={() => { close(); openSettings('carbon'); }}>Connect Carbon</Button>
        </div>
      )}
      {info && !send && !onBranch && (
        <>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 2 }}><Field label="Part number" hint={info.item ? 'The Carbon item it went to before.' : 'From its name; change it to your numbering.'}>
              <input value={number} onChange={(event) => setNumber(event.target.value)} aria-label="Part number" id="carbon-number" maxLength={60} />
            </Field></div>
            <div style={{ flex: 1 }}><Field label="Revision" hint={info.item ? 'A new one makes a Carbon revision.' : undefined}>
              <input value={revision} onChange={(event) => setRevision(event.target.value)} aria-label="Revision" id="carbon-revision" maxLength={20} />
            </Field></div>
          </div>
          <Option checked={model} onChange={setModel} label="3D model (STEP)" />
          <Option checked={drawing} onChange={setDrawing} label="Drawing (PDF), when it has one" />
          {info.kind === 'design' && <Option checked={bom} onChange={setBom} label="Bill of materials, as a Draft method" />}
          <Option checked={routing} onChange={setRouting} label="Routing and G-code from its CAM program, when it has a posted one" />
          <Option checked={stock} onChange={setStock} label="Raw stock: the blank its CAM program starts from" />
          <Option checked={inspection} onChange={setInspection} label="Inspection plan: its drawing ballooned, a characteristic per toleranced dimension" />
          {info.item && <Option checked={changeNotice} onChange={setChangeNotice} label="Once released in Carbon, changes go on a change notice, for Carbon to release" />}
          {info.item?.url && <div className={styles.message} style={{ color: 'var(--text-3)' }}>
            Last sent {new Date(info.item.sent_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            {info.item.document_revision ? ` (revision ${info.item.document_revision})` : ''} · <a href={info.item.url} target="_blank" rel="noreferrer">open in Carbon</a>
          </div>}
          {info.item?.method && <div className={styles.message} style={{ color: 'var(--text-3)' }} id="carbon-method">
            {methodText(info.item.method)}
            {info.item.method.notice?.url && <> · <a href={info.item.method.notice.url} target="_blank" rel="noreferrer">open the change notice</a></>}
          </div>}
          <ShopFloor jobs={info.jobs ?? []} issues={info.issues ?? []} />
        </>
      )}
      {send && (
        <div id="carbon-progress" role="status">
          <ul style={{ margin: '4px 0 8px', paddingLeft: 18, color: 'var(--text-2)', fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
            {send.steps.map((step, index) => <li key={index}>{step.text}</li>)}
            {RUNNING.has(send.state) && <li><Spinner size={11} /> {send.steps.length ? 'Working…' : 'Starting…'}</li>}
          </ul>
          {send.state === 'awaiting_confirmation' && <div className={styles.message}>Waiting for your confirmation in Settings → Carbon.</div>}
          {send.state === 'failed' && <div role="alert" className={styles.message}>{send.error}</div>}
          {send.result?.bill?.notes?.map((note) => <div key={note} className={styles.message} style={{ color: 'var(--text-3)' }}>{note}</div>)}
          {send.result?.routing?.notes?.map((note) => <div key={note} className={styles.message} style={{ color: 'var(--text-3)' }}>{note}</div>)}
          {send.result?.stock?.notes?.map((note) => <div key={note} className={styles.message} style={{ color: 'var(--text-3)' }}>{note}</div>)}
          {send.state === 'done' && send.result?.inspection?.url && (
            <div className={styles.message} style={{ color: 'var(--text-3)' }}>
              <a href={send.result.inspection.url} target="_blank" rel="noreferrer">Open its inspection plan</a> ({send.result.inspection.characteristics} characteristics).
            </div>
          )}
          {send.state === 'done' && send.result?.change_notice && (
            <div className={styles.message} style={{ color: 'var(--text-3)' }}>
              The new version is on change notice <a href={send.result.change_notice.url} target="_blank" rel="noreferrer">{send.result.change_notice.readable_id}</a>:
              release it in Carbon.
            </div>
          )}
          {send.state === 'done' && send.result?.url && (
            <Button variant="primary" icon={<ExternalLink size={14} />} onClick={() => window.open(send.result!.url, '_blank', 'noopener')} id="carbon-open">
              Open {send.result.number} rev {send.result.revision} in Carbon
            </Button>
          )}
          {send.state === 'done' && send.result?.file && (
            <a href={withWorkspace(`/v1/carbon/releases/${send.id}/file`)} download={send.result.file} id="carbon-download">
              <Button variant="primary" icon={<Download size={14} />}>Download {send.result.file}</Button>
            </a>
          )}
        </div>
      )}
    </Dialog>
  );
}

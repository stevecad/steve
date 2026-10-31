/**
 * Download all your data, and delete the account (app/account_data.py): Settings → Account, and the "Before you start"
 * page for someone who doesn't agree to the terms (terms/BeforeYouStart.tsx).
 *
 * Deleting needs a sign-in within the last few minutes: the provider's own sign-in confirms it's really the person.
 * After that sign-in the app opens this again and asks "Continue deleting?" (never deletes by itself); the remembered
 * request lasts PENDING_MINUTES.
 * When STEVE has deleted everything, the person confirms deleting their sign-in account with the provider itself.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@/ui';
import { api, ApiError, json } from '@/lib/api';
import { deleteSignInAccount, reauthenticate } from '@/auth/auth';
import { Note } from '../ui';
import own from './Developers.module.css';

interface Job { id: string; kind: 'export' | 'delete'; status: string; steps: Record<string, string>; created_at: string; finished_at: string | null; expires_at: string | null; error: string | null; size: number | null }

export const PENDING_DELETION = 'steve.pendingDeletion';
const PENDING_MINUTES = 10;
const CONFIRM = 'DELETE';
const STEPS: [string, string][] = [['stopped', 'Stopping your running work'], ['planned', 'Finding your files'], ['erased', 'Deleting your data'], ['done', 'Done']];

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));
const size = (bytes: number | null) => (bytes == null ? '' : bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);

/** A deletion the person confirmed just before the confirming sign-in (a time stamp, valid PENDING_MINUTES). */
export function pendingDeletion(): boolean {
  try {
    const at = Number(sessionStorage.getItem(PENDING_DELETION));
    if (at && Date.now() - at < PENDING_MINUTES * 60_000) return true;
    sessionStorage.removeItem(PENDING_DELETION);
  } catch { /* Storage is optional. */ }
  return false;
}
const forgetPending = () => { try { sessionStorage.removeItem(PENDING_DELETION); } catch { /* Storage is optional. */ } };

/** "Download my data": prepare a zip, then download it while it lasts (`onDays` gets how many days that is). */
export function ExportData({ disabled, onDays }: { disabled?: boolean; onDays?: (days: number) => void }) {
  const [exports, setExports] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ exports: Job[]; days: number }>('/v1/account/exports').then((body) => { setExports(body.exports); onDays?.(body.days); }, (failure) => setError(message(failure))), [onDays]);
  useEffect(() => { void load(); }, [load]);
  const working = exports?.some((job) => job.status === 'waiting' || job.status === 'building');
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [working, load]);

  const startExport = async () => {
    setError(null);
    try { await api('/v1/account/exports', { method: 'POST' }); await load(); } catch (failure) { setError(message(failure)); }
  };
  const download = async (job: Job) => {
    setError(null);
    try {
      const response = await fetch(`/v1/account/exports/${job.id}/download`);
      if (!response.ok) throw new Error('That export isn’t available any more. Make a new one.');
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement('a'), { href: url, download: `steve-data-${(job.finished_at ?? '').slice(0, 10)}.zip` });
      document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (failure) { setError(message(failure)); }
  };

  return (
    <>
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="primary" onClick={() => void startExport()} disabled={!!working || disabled}>Prepare a download</Button>
      </div>
      {!exports ? <Spinner /> : !exports.length ? <p className={own.empty}>No downloads yet.</p> : exports.map((job) => (
        <div key={job.id} className={own.key} data-export={job.id}>
          <div>
            <b>{new Date(job.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b>
            <p>{job.status === 'ready' ? `Ready${job.size ? ` · ${size(job.size)}` : ''}${job.expires_at ? ` · until ${new Date(job.expires_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : ''}`
              : job.status === 'failed' ? (job.error ?? 'Couldn’t be made.') : 'Preparing…'}</p>
          </div>
          {job.status === 'ready' ? <Button size="sm" onClick={() => void download(job)}>Download</Button> : job.status === 'failed' ? null : <Spinner />}
        </div>
      ))}
    </>
  );
}

/** "Delete my account": type DELETE, sign in again, then STEVE deletes everything and the sign-in account goes last. */
export function DeleteAccount({ onDeleting }: { onDeleting?: (deleting: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [asking, setAsking] = useState(false);
  const [deletion, setDeletion] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [resume, setResume] = useState(pendingDeletion);
  useEffect(() => { onDeleting?.(!!deletion); }, [deletion, onDeleting]);

  const startDeletion = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const job = await api<Job>('/v1/account/deletion', json('POST', { confirm: CONFIRM }));
      forgetPending(); setResume(false);
      setDeletion(job);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'reauthentication_required') {
        // Confirm it's really them: the provider's sign-in, then back here to be asked once more.
        try { sessionStorage.setItem(PENDING_DELETION, String(Date.now())); } catch { /* Storage is optional. */ }
        if (reauthenticate()) return;
      }
      forgetPending(); setResume(false);
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!deletion || deletion.status === 'done') return;
    const timer = window.setInterval(() => {
      void api<{ deletion: Job | null }>('/v1/account/deletion').then((body) => { if (body.deletion) setDeletion(body.deletion); }, () => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [deletion]);
  const finish = () => { if (!deleteSignInAccount()) window.location.assign('/'); };

  return deletion ? (
    <div className={own.form} data-deletion={deletion.status}>
      {STEPS.map(([key, label]) => (
        <p key={key} className={own.scope}>{deletion.steps[key] ? '✓' : '…'} {label}</p>
      ))}
      {deletion.status === 'done' ? (
        <>
          <Note>Your STEVE data is deleted; its files and history follow within minutes. Last step: confirm deleting your sign-in account on the next page.</Note>
          <div className={own.actions}><Button variant="danger" onClick={finish}>Continue</Button></div>
        </>
      ) : <Note>This takes a few minutes. You can close this window: it carries on without you.</Note>}
    </div>
  ) : resume ? (
    <div className={own.form}>
      <Note tone="warning">Continue deleting your account? Everything in it will be deleted for good.</Note>
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="danger" disabled={busy} onClick={() => void startDeletion()}>Delete everything</Button>
        <Button variant="ghost" onClick={() => { forgetPending(); setResume(false); }}>Cancel</Button>
      </div>
    </div>
  ) : !asking ? (
    <div className={own.actions}><Button variant="danger" onClick={() => setAsking(true)}>Delete my account…</Button></div>
  ) : (
    <div className={own.form}>
      <label className={own.label} htmlFor="account-delete-confirm">Type {CONFIRM} to confirm. You'll be asked to sign in again to prove it's you.</label>
      <input id="account-delete-confirm" className={own.input} value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} autoFocus />
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="danger" disabled={typed !== CONFIRM || busy} onClick={() => void startDeletion()}>Delete everything</Button>
        <Button variant="ghost" onClick={() => { setAsking(false); setTyped(''); }}>Cancel</Button>
      </div>
    </div>
  );
}

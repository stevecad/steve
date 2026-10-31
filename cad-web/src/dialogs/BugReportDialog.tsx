/**
 * "Report a bug" (feedback/feedback.ts): what happened, what was expected, an optional screenshot of the canvas, and
 * exactly what else is sent: the app version, the OS and the app's local log (redacted, shown here, and left out when
 * the person unticks it). Steve desktop forwards it to STEVE Studio, which alone stores it. "Request a feature" is the
 * same dialog, worded for an idea. Without a STEVE sign-in (or its reporting permission) the dialog asks for one.
 */
import { useEffect, useRef, useState } from 'react';
import { Bug, Camera, Check, ExternalLink, Lightbulb, LogIn, PencilLine, X } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { set, toast, useApp } from '@/state/store';
import { ApiError } from '@/lib/api';
import CopyMessage from '@/shell/CopyMessage';
import { captureCanvas, compressForReport, loadFeedbackConfig, loadReportPreview, newReportId, sendBugReport, useFeedback, type FiledReport, type ReportPreview } from '@/feedback/feedback';
import { studioAction, useStudio, useStudioStatus } from '@/studio/studio';
import Annotator, { flattenMarks, type Mark } from '@/feedback/Annotator';
import ui from '@/ui/ui.module.css';
import styles from './BugReportDialog.module.css';
import { safeHref } from '@/lib/safeUrl';

const WORDING = {
  bug: {
    title: 'Report a bug', description: 'Tell the team what went wrong. They track it and fix it.', icon: Bug,
    what: 'What happened', placeholder: 'What you did, and what went wrong', expected: 'What you expected', send: 'Send report', thanks: 'report',
  },
  feature: {
    title: 'Request a feature', description: 'Tell the team what you’d like Steve to do. They consider every request.', icon: Lightbulb,
    what: 'What you’d like', placeholder: 'The feature or change, and what you’d use it for', expected: 'Why it would help', send: 'Send request', thanks: 'request',
  },
} as const;

type Phase ={ kind: 'editing' } | { kind: 'sending' } | { kind: 'filed'; report: FiledReport } | { kind: 'failed'; message: string };

/** The attached screenshot: the full-size capture and the person's marks (editable until it's sent), and what's sent. */
interface Shot { image: HTMLImageElement; marks: Mark[]; jpeg: string }

function SentDetails({ preview, includeLog, setIncludeLog, shot, disabled }: {
  preview: ReportPreview | null; includeLog: boolean; setIncludeLog: (value: boolean) => void; shot: Shot | null; disabled: boolean;
}) {
  const retention = useFeedback((state) => state.retentionDays);
  const rows: [string, string][] = [
    ['App version', preview?.app_version || '…'], ['Operating system', preview?.os || '…'],
    ['Screenshot', !shot ? 'None' : shot.marks.length ? 'The canvas with your markings, as previewed above' : 'The canvas, as previewed above'],
  ];
  const log = preview?.log ?? '';
  return (
    <details className={styles.disclosure} id="bug-context" open>
      <summary>What's sent with your report</summary>
      <dl className={styles.facts}>
        {rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}
      </dl>
      <label className={styles.check}>
        <input type="checkbox" id="bug-include-log" checked={includeLog} disabled={disabled} onChange={(event) => setIncludeLog(event.target.checked)} />
        <span>Include the app’s log {preview ? `(${log ? `${new Blob([log]).size.toLocaleString()} bytes` : 'empty'}${preview.log_truncated ? ', most recent part' : ''})` : ''}</span>
      </label>
      <details className={styles.log}>
        <summary>Show the log exactly as it’s sent</summary>
        {!preview ? <Spinner size={13} /> : log ? <pre className={styles.recent} id="bug-log">{log}</pre> : <p className={styles.muted}>The log is empty.</p>}
      </details>
      <p className={styles.muted}>
        Your username in file paths, email addresses and sign-in tokens are removed from the log. Never your designs or their files.
        Your report is stored only by STEVE; its log and screenshot are deleted {retention} days after it’s closed.
      </p>
    </details>
  );
}

/** Not signed in to STEVE, or the sign-in predates the reporting permission: one button signs in (again). */
function SignInFirst() {
  const reason = useFeedback((state) => state.reason);
  const message = useFeedback((state) => state.message);
  const studio = useStudioStatus();
  const sending = useStudio((state) => state.sending);
  const busy = !!studio?.busy || sending;
  const canSignIn = reason === 'sign_in_required' || reason === 'consent_required';
  return (
    <div className={styles.body} id="bug-sign-in">
      <p>{message || 'Sign in to STEVE to report a bug or request a feature.'}</p>
      {reason === 'consent_required' && <p className={styles.muted}>Your current sign-in doesn’t include permission to send reports. Signing in again asks for it.</p>}
      {canSignIn && (
        <div><Button variant="primary" icon={busy ? <Spinner size={13} /> : <LogIn />} disabled={busy} id="bug-sign-in-button"
          onClick={() => void studioAction('connect')}>{reason === 'consent_required' ? 'Sign in to STEVE again' : 'Sign in to STEVE'}</Button></div>
      )}
      {busy && <p className={styles.muted}>Finish signing in in your browser, then come back here.</p>}
    </div>
  );
}

export default function BugReportDialog({ open }: { open: boolean }) {
  const prefill = useFeedback((state) => state.prefill);
  const kind = useFeedback((state) => state.kind);
  const words = WORDING[kind];
  const Icon = words.icon;
  const canSend = useFeedback((state) => state.canSend);
  const hasModel = useApp((state) => !!state.displayed);
  const [what, setWhat] = useState('');
  const [expected, setExpected] = useState('');
  const [shot, setShot] = useState<Shot | null>(null);
  // What the mark-up dialog edits (kept after it closes, for its closing animation).
  const [draft, setDraft] = useState<{ image: HTMLImageElement; marks: Mark[] } | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [preview, setPreview] = useState<ReportPreview | null>(null);
  const [includeLog, setIncludeLog] = useState(true);
  // One identifier per report: sending again after a failure reuses it, so Studio never stores the report twice.
  const reportId = useRef('');
  const studioBusy = useStudio((state) => !!state.state?.busy);

  useEffect(() => {
    if (!open) return;
    setWhat(prefill); setExpected(''); setShot(null); setAnnotating(false); setPhase({ kind: 'editing' });
    setIncludeLog(true); setPreview(null); reportId.current = newReportId();
    loadReportPreview().then(setPreview).catch(() => setPreview(null));
  }, [open, prefill, kind]);

  // On opening, and after signing in (again) in the browser: can reports be sent now?
  useEffect(() => { if (open && !studioBusy) void loadFeedbackConfig(); }, [open, studioBusy]);

  const close = () => { set({ dialog: null }); useFeedback.setState({ prefill: '' }); };
  const failed = () => toast('warning', 'Couldn’t capture the canvas', 'Send the report without it, or try again.');
  /** Attach the canvas as it is, or open it to mark up first (attached when the person is done). */
  const capture = async (annotate: boolean) => {
    setCapturing(true);
    try {
      const image = await captureCanvas();
      if (!image) throw new Error('No canvas to capture');
      if (annotate) { setDraft({ image, marks: [] }); setAnnotating(true); return; }
      const jpeg = compressForReport(image);
      if (!jpeg) throw new Error('Too large');
      setShot({ image, marks: [], jpeg });
    }
    catch { setShot(null); failed(); }
    finally { setCapturing(false); }
  };
  const annotated = (marks: Mark[]) => {
    setAnnotating(false);
    if (!draft) return;
    const jpeg = compressForReport(flattenMarks(draft.image, marks));
    if (jpeg) setShot({ image: draft.image, marks, jpeg }); else failed();
  };
  const send = async () => {
    if (!what.trim() || (includeLog && !preview)) return;
    setPhase({ kind: 'sending' });
    try {
      const report = await sendBugReport({
        client_report_id: reportId.current, kind, what: what.trim(), expected: expected.trim(),
        log: includeLog ? preview?.log ?? null : null, screenshot: shot?.jpeg ?? null,
      });
      setPhase({ kind: 'filed', report });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'The report couldn’t be sent. Check your connection and try again.';
      if (error instanceof ApiError && (error.code === 'sign_in_required' || error.code === 'consent_required')) void loadFeedbackConfig();
      setPhase({ kind: 'failed', message });
    }
  };

  const sending = phase.kind === 'sending';
  const footer = phase.kind === 'filed' || !canSend
    ? <Button variant={phase.kind === 'filed' ? 'primary' : undefined} onClick={close} id="bug-done">{phase.kind === 'filed' ? 'Done' : 'Close'}</Button>
    : <>
        <Button onClick={close} disabled={sending}>Cancel</Button>
        <Button variant="primary" id="bug-send" onClick={() => void send()} disabled={sending || !what.trim() || (includeLog && !preview)} icon={sending ? <Spinner size={13} /> : undefined}>
          {sending ? 'Sending…' : words.send}
        </Button>
      </>;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value && !sending) close(); }} width={560} title={words.title}
      description={words.description} icon={<div className={styles.icon}><Icon size={18} /></div>} footer={footer}>
      {phase.kind === 'filed' ? (
        <div className={styles.filed} id="bug-filed" role="status">
          <Check size={20} />
          <div>
            <strong>{`Thanks — the team has your ${words.thanks}.`}</strong>
            {safeHref(phase.report.url)
              ? <a href={safeHref(phase.report.url)} target="_blank" rel="noopener noreferrer" className={styles.link}>Open the issue <ExternalLink size={12} /></a>
              : <span className={styles.muted} id="bug-report-id">Report <code>{phase.report.id}</code> <CopyMessage text={phase.report.id} /></span>}
            <span className={styles.muted}>You’ll hear here when it’s resolved. Follow it in Feedback › My reports.</span>
          </div>
        </div>
      ) : !canSend ? <SignInFirst /> : (
        <div className={styles.body}>
          <label className={styles.field}>
            <span>{words.what}</span>
            <textarea className={`${ui.input} ${styles.text}`} id="bug-what" value={what} onChange={(event) => setWhat(event.target.value)} rows={5}
              placeholder={words.placeholder} maxLength={8_000} autoFocus disabled={sending} />
          </label>
          <label className={styles.field}>
            <span>{words.expected} <em>(optional)</em></span>
            <textarea className={`${ui.input} ${styles.text}`} id="bug-expected" value={expected} onChange={(event) => setExpected(event.target.value)} rows={3}
              maxLength={4_000} disabled={sending} />
          </label>
          <div className={styles.shot}>
            {shot ? (
              <div className={styles.preview} id="bug-screenshot">
                <img src={shot.jpeg} alt="Screenshot of the canvas" />
                <div className={styles.actions}>
                  <button type="button" className={styles.action} aria-label="Mark up the screenshot" title="Mark up the screenshot" disabled={sending}
                    onClick={() => { setDraft({ image: shot.image, marks: shot.marks }); setAnnotating(true); }}><PencilLine size={13} /></button>
                  <button type="button" className={styles.action} aria-label="Remove the screenshot" onClick={() => setShot(null)} disabled={sending}><X size={13} /></button>
                </div>
              </div>
            ) : (
              <>
                <Button size="sm" icon={capturing ? <Spinner size={13} /> : <Camera />} id="bug-capture" onClick={() => void capture(false)} disabled={!hasModel || capturing || sending}>
                  Attach a screenshot of the canvas
                </Button>
                <Button size="sm" icon={<PencilLine />} id="bug-annotate" onClick={() => void capture(true)} disabled={!hasModel || capturing || sending}
                  title="Draw on the canvas, add arrows and comments, then attach it">
                  Mark up the canvas…
                </Button>
              </>
            )}
          </div>
          <Annotator open={annotating} image={draft?.image ?? null} marks={draft?.marks ?? []} onCancel={() => setAnnotating(false)} onDone={annotated} />
          <SentDetails preview={preview} includeLog={includeLog} setIncludeLog={setIncludeLog} shot={shot} disabled={sending} />
          {phase.kind === 'failed' && (
            <div className={styles.error} role="alert" id="bug-error">
              <span>{phase.message} Your report is still here, so you can send it again; it won’t be duplicated.</span>
              <CopyMessage text={phase.message} />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

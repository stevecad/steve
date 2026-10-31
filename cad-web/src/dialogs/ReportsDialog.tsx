/**
 * "My reports" (feedback/feedback.ts): the person's own bug reports and feature requests and what became of them
 * (received, in progress, fixed, declined, a duplicate), with the team's reply. Opening it marks their updates as seen.
 */
import { useEffect, useState } from 'react';
import { Bug, ExternalLink, Inbox, Lightbulb } from 'lucide-react';
import { Button, Dialog, Spinner } from '@/ui';
import { set } from '@/state/store';
import { ApiError } from '@/lib/api';
import { listReports, markReportsSeen, openBugReport, statusWords, type MyReport } from '@/feedback/feedback';
import styles from './ReportsDialog.module.css';
import { safeHref } from '@/lib/safeUrl';

const LABELS: Record<MyReport['status'], string> = { received: 'Received', in_progress: 'In progress', fixed: 'Fixed', declined: 'Closed', duplicate: 'Duplicate' };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export default function ReportsDialog({ open }: { open: boolean }) {
  const [reports, setReports] = useState<MyReport[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let live = true;
    setReports(null); setError('');
    listReports()
      .then((list) => {
        if (!live) return;
        setReports(list);  // Shown with their "new" marks, then marked as seen.
        if (list.some((report) => report.unseen)) void markReportsSeen().catch(() => undefined);
      })
      .catch((err) => { if (live) setError(err instanceof ApiError ? err.message : 'Couldn’t load your reports. Check your connection and try again.'); });
    return () => { live = false; };
  }, [open]);

  const close = () => set({ dialog: null });
  const footer = <Button variant="primary" onClick={close} id="reports-done">Done</Button>;

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }} width={560} title="My reports"
      description="Your bug reports and feature requests, and what became of them." icon={<div className={styles.icon}><Inbox size={18} /></div>} footer={footer}>
      {error ? <p className={styles.error} role="alert">{error}</p>
        : !reports ? <div className={styles.loading}><Spinner size={16} /></div>
        : !reports.length ? (
          <div className={styles.empty} id="reports-empty">
            <p>You haven’t sent any reports yet.</p>
            <Button size="sm" icon={<Bug />} onClick={() => openBugReport()}>Report a bug…</Button>
          </div>
        ) : (
          <ul className={styles.list} id="reports-list">
            {reports.map((report) => {
              const Icon = report.kind === 'feature' ? Lightbulb : Bug;
              return (
                <li key={report.id} className={styles.item} data-status={report.status}>
                  <Icon size={14} className={styles.kind} aria-label={report.kind === 'feature' ? 'Feature request' : 'Bug report'} />
                  <div className={styles.text}>
                    <div className={styles.title}>
                      <span>{report.title}</span>
                      {report.unseen && <span className={styles.new}>New</span>}
                    </div>
                    <div className={styles.meta}>
                      Sent {day(report.created_at)}{report.resolved_at ? ` · updated ${day(report.resolved_at)}` : ''} · {statusWords(report)}
                      {safeHref(report.url) && <> · <a href={safeHref(report.url)} target="_blank" rel="noopener noreferrer">#{report.issue} <ExternalLink size={11} /></a></>}
                    </div>
                    {report.reply && <p className={styles.reply}>{report.reply}</p>}
                  </div>
                  <span className={styles.status}>{LABELS[report.status]}</span>
                </li>
              );
            })}
          </ul>
        )}
    </Dialog>
  );
}

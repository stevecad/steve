/**
 * "Report a bug" and "Request a feature" in Steve desktop: the local server forwards the report to STEVE Studio
 * (/api/v1/desktop-feedback, the person's own sign-in with the feedback:write permission), which alone stores it.
 * The entry points (the Feedback menu next to MCP, command palette, error toasts, the Source pane's diagnostics) show
 * whenever reporting is possible, including when the person still has to sign in to STEVE (the dialog says so).
 * "My reports" shows what became of the person's own reports, and a toast says when one was fixed or declined.
 */
import { create } from 'zustand';
import { api } from '@/lib/api';
import { setting } from '@/settings/store';
import { get, set, toast } from '@/state/store';
import { viewer } from '@/viewport/viewer';

export type FeedbackKind = 'bug' | 'feature';
/** Why reports can't be sent right now (null when they can). */
export type FeedbackBlock = 'sign_in_required' | 'consent_required' | 'not_offered' | 'unsupported_platform' | 'unavailable' | 'busy' | 'disabled' | null;

interface FeedbackState {
  /** The entry points show: reports can be sent, or can be once the person signs in to STEVE. */
  enabled: boolean;
  /** Reports can be sent now. */
  canSend: boolean;
  reason: FeedbackBlock;
  message: string;
  version: string;
  os: string;
  /** What a report carries, in Studio's words. */
  sends: string[];
  retentionDays: number;
  /** A bug report, or a feature request ("Request a feature"): the dialog's wording. */
  kind: FeedbackKind;
  /** Text the dialog opens with ("Report this" on an error). */
  prefill: string;
  /** Reports that were fixed, declined or merged since the person last opened "My reports". */
  unseen: number;
}

export const useFeedback = create<FeedbackState>(() => ({
  enabled: false, canSend: false, reason: null, message: '', version: '', os: '', sends: [], retentionDays: 30, kind: 'bug', prefill: '', unseen: 0,
}));

interface FeedbackConfig {
  enabled: boolean; reason: FeedbackBlock; message: string; version: string; os: string; sends: string[]; retention_days: number;
}

export async function loadFeedbackConfig() {
  try {
    const config = await api<FeedbackConfig>('/v1/feedback/config');
    const signIn = config.reason === 'sign_in_required' || config.reason === 'consent_required';
    useFeedback.setState({
      enabled: !!config.enabled || signIn, canSend: !!config.enabled, reason: config.enabled ? null : config.reason,
      message: config.message || '', version: config.version || '', os: config.os || '', sends: config.sends || [],
      retentionDays: config.retention_days || 30,
    });
    if (config.enabled) void checkReports();
  } catch {
    useFeedback.setState({ enabled: false, canSend: false });
  }
}

export const feedbackEnabled = () => useFeedback.getState().enabled;

export function openBugReport(prefill = '') {
  useFeedback.setState({ kind: 'bug', prefill });
  set({ dialog: 'bug' });
}

export function openFeatureRequest() {
  useFeedback.setState({ kind: 'feature', prefill: '' });
  set({ dialog: 'bug' });
}

/** What's attached besides the person's text, exactly as it would be sent (the dialog shows it). */
export interface ReportPreview {
  app_version: string;
  platform: string;
  os: string;
  /** The app's local log, already redacted (home folders, user name, emails, tokens) and capped. */
  log: string;
  log_truncated: boolean;
  max_log_bytes: number;
  max_screenshot_bytes: number;
}

export const loadReportPreview = () => api<ReportPreview>('/v1/feedback/preview');

/** A new report's idempotency key: a resend of the same report reuses it, so Studio never stores it twice. */
export function newReportId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Requests are capped at 1 MB (app/main.py): the canvas is downscaled and compressed to stay well under it. */
const MAX_DATA_URL = 760_000;

/** The page's background, behind the canvas's transparent pixels (a JPEG has none). */
export const reportBackground = () => getComputedStyle(document.body).backgroundColor || '#111';

/** The 3D canvas at full resolution (to send, or to mark up first), or null when there's no model view. */
export async function captureCanvas(): Promise<HTMLImageElement | null> {
  const png = viewer.screenshot();
  if (!png) return null;
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('capture')); image.src = png; });
  return image;
}

/** An image (the capture, or the capture with the person's markings) as a JPEG data URL small enough to send. */
export function compressForReport(source: HTMLImageElement | HTMLCanvasElement): string | null {
  for (const [width, quality] of [[1600, 0.85], [1280, 0.8], [1024, 0.72], [800, 0.65]] as const) {
    const scale = Math.min(1, width / source.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = reportBackground();
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const jpeg = canvas.toDataURL('image/jpeg', quality);
    if (jpeg.length <= MAX_DATA_URL) return jpeg;
  }
  return null;
}

export interface FiledReport { id: string; status: string; issue: number | null; url: string | null }

/** "My reports": what became of the person's own reports. A status, dates, the team's reply and, once the team
 * describes the technical problem publicly, a link to that issue. */
export type ReportStatus = 'received' | 'in_progress' | 'fixed' | 'declined' | 'duplicate';

export interface MyReport {
  id: string;
  title: string;
  kind: FeedbackKind;
  status: ReportStatus;
  /** The team's reply (plain text): why it was declined, or how to use what was added. */
  reply: string | null;
  /** The release that carries the fix or feature. */
  fixed_in: string | null;
  created_at: string;
  resolved_at: string | null;
  unseen: boolean;
  issue: number | null;
  url: string | null;
}

export async function listReports(): Promise<MyReport[]> {
  const { reports } = await api<{ reports: MyReport[] }>('/v1/feedback/reports');
  useFeedback.setState({ unseen: reports.filter((report) => report.unseen).length });
  return reports;
}

export async function markReportsSeen() {
  await api<null>('/v1/feedback/reports/seen', { method: 'POST' });
  useFeedback.setState({ unseen: 0 });
}

export function openMyReports() {
  set({ dialog: 'reports' });
}

/** One line for a resolved report, worded for a bug or a request. */
export function statusWords(report: Pick<MyReport, 'kind' | 'status'> & { fixed_in?: string | null }): string {
  const feature = report.kind === 'feature';
  const release = report.fixed_in;
  switch (report.status) {
    case 'fixed': return feature ? `Added${release ? ` in Steve ${release}` : ''}. It arrives with an update.` : `Fixed${release ? ` in Steve ${release}` : ''}. The fix arrives with an update.`;
    case 'declined': return feature ? 'Not planned for now. Thanks for the idea.' : 'Closed without a change.';
    case 'duplicate': return 'Already known: the team tracks it with an earlier report.';
    case 'in_progress': return feature ? 'The team is working on it.' : 'The team is working on a fix.';
    default: return 'Received. The team has it.';
  }
}

/** A reply short enough for a toast (the full text is in "My reports"). */
const brief = (reply: string | null) => !reply ? '' : reply.length > 180 ? `${reply.slice(0, 177).trimEnd()}…` : reply;

/** Tells the person once per tab when reports of theirs were resolved (checked with the update watch's rhythm). */
const announced = new Set<string>();
let checkingReports = false;

export async function checkReports() {
  if (!useFeedback.getState().canSend || checkingReports) return;
  checkingReports = true;
  let reports: MyReport[];
  try {
    reports = await listReports();
  } catch {
    return;
  } finally {
    checkingReports = false;
  }
  const fresh = reports.filter((report) => report.unseen && !announced.has(report.id));
  if (!fresh.length || get().dialog === 'reports' || !setting('notifications.reports')) return;  // Settings → Notifications
  fresh.forEach((report) => announced.add(report.id));
  const view = { label: 'View', run: openMyReports };
  if (fresh.length === 1) toast('info', `Update on “${fresh[0].title}”`, brief(fresh[0].reply) || statusWords(fresh[0]), { sticky: true, action: view });
  else toast('info', `${fresh.length} of your reports have updates`, 'See what became of them in Feedback › My reports.', { sticky: true, action: view });
}

export function installReportWatch(): () => void {
  const onFocus = () => { if (document.visibilityState === 'visible') void checkReports(); };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  const timer = window.setInterval(onFocus, 5 * 60_000);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.clearInterval(timer);
  };
}

export function sendBugReport(body: { client_report_id: string; kind: FeedbackKind; what: string; expected: string; log: string | null; screenshot: string | null }) {
  return api<FiledReport>('/v1/feedback/bug', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

/**
 * The app's own recent problems, for bug reports (dialogs/BugReportDialog.tsx): error and warning messages it showed
 * and API requests that failed. Not the browser console: only what the app itself reported, with no document content.
 */
const LIMIT = 20;
const entries: string[] = [];

const time = () => new Date().toISOString().slice(11, 19);

export function recordRecent(line: string) {
  entries.push(`${time()} ${line.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
  if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
}

/** A failed request: method, path (no query string, which can carry search terms) and what the server said. */
export function recordFailedRequest(method: string, url: string, status: number, message: string) {
  let path = url;
  try { path = new URL(url, location.origin).pathname; } catch { /* Keep it as given. */ }
  recordRecent(`HTTP ${status} ${method.toUpperCase()} ${path}${message ? ` — ${message}` : ''}`);
}

export const recentErrors = () => [...entries];

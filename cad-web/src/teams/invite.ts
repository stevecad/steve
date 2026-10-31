/**
 * Invitation links (docs/TEAMS.md "Invitations"): `https://<STEVE>/#team-invite=<code>`. The code rides in the fragment,
 * which browsers never send to a server. On load the app takes it out of the address at once; it waits in this tab's
 * sessionStorage only across a sign-in, and leaves it the moment the invitation dialog reads it (then it's in memory
 * only). Never in localStorage, a log or a request's address.
 */
const KEY = 'steve.teamInvite';
const CODE = /^[A-Za-z0-9_-]{43}$/;

/** The code in a fragment like `#team-invite=<code>`, or null (anything else, or not a code's shape). */
export function inviteFromHash(hash: string): string | null {
  if (!hash.startsWith('#team-invite=')) return null;
  const value = hash.slice('#team-invite='.length).trim();
  return CODE.test(value) ? value : null;
}

/** At startup, before sign-in: keeps a link's code for this tab and takes it out of the address. */
export function takeInviteFragment() {
  if (typeof location === 'undefined' || !location.hash.startsWith('#team-invite=')) return;
  const code = inviteFromHash(location.hash);
  try {
    if (code) sessionStorage.setItem(KEY, code);
  } catch { /* storage off: the person pastes the code in Settings → Teams instead */ }
  history.replaceState(history.state, '', location.pathname + location.search);
}

/** The waiting code, once: it leaves storage as it's read. */
export function pendingInvite(): string | null {
  try {
    const code = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return code && CODE.test(code) ? code : null;
  } catch { return null; }
}

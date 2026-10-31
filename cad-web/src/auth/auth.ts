/**
 * Accounts (docs/ACCOUNTS.md). Before the app renders, `bootstrapAuth` asks the server how people sign in:
 * - dev: one local person; nothing to do (labs, tests, a one-person install).
 * - oidc: sign in with the deployment's provider (Keycloak) through oidc-client-ts: Authorization Code + PKCE, with
 *   tokens renewed by the refresh token before they expire. Every same-origin request then carries the access token
 *   (the fetch wrapper below, and `bearer()` for the XHR upload), and the server sets an HttpOnly cookie from it for
 *   what can't send headers: EventSource streams, <img> attachments and download links (it accepts the cookie on
 *   GET/HEAD only, so it can't be used to change anything).
 * The provider redirects back to the page's own URL (`/` with ?code&state); the app routes by query string, so the
 * callback needs no route of its own, and the address the person was on comes back afterwards.
 */
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { create } from 'zustand';
import { useApp, type Workspace } from '@/state/store';
import { checkStaleWorkspace, HEADER as WORKSPACE_HEADER, isApi, loadWorkspaces, selectedWorkspace } from '@/teams/current';

export interface Account {
  mode: 'dev' | 'oidc';
  name: string;
  username: string;
  email: string;
  /** The workspace this tab works in: the person's own, or a team's (teams/current.ts). */
  workspace: string;
  /** The person's own workspace, whichever workspace they work in. */
  person?: string;
  /** Their role in the team whose workspace this is; null in their own. */
  team_role?: 'owner' | 'admin' | 'member' | 'viewer' | null;
  admin: boolean;
}

export const useAccount = create<{ account: Account | null }>(() => ({ account: null }));

let manager: UserManager | null = null;
let ready = false;  // Signed in and the session started: from then on a 401 means the session ended.
// globalThis is window in the browser; it also lets this module load where there's no window (Node tests).
const nativeFetch = globalThis.fetch.bind(globalThis);

const sameOrigin = (url: string) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};
const urlOf = (input: RequestInfo | URL) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/** The access token, renewed first when it's about to expire; null in dev mode or when signed out. */
async function accessToken(): Promise<string | null> {
  if (!manager) return null;
  let user = await manager.getUser();
  if (user && (user.expired || (user.expires_in ?? 60) < 20)) {
    try { user = await manager.signinSilent(); } catch { user = null; }
  }
  return user?.access_token ?? null;
}

/** The Authorization header value for requests fetch doesn't make (the XHR upload), or null. */
export async function bearer(): Promise<string | null> {
  const token = await accessToken();
  return token ? `Bearer ${token}` : null;
}

async function startSession(token: string) {
  // The cookie for GET-only resources (streams, images, downloads), refreshed with every new token.
  await nativeFetch('/v1/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
}

let fetchInstalled = false;
function installFetch() {
  if (fetchInstalled) return;
  fetchInstalled = true;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const workspace = selectedWorkspace();   // the team this tab works in (teams/current.ts), in every mode
    if (!sameOrigin(url) || (!manager && !(workspace && isApi(url)))) return nativeFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (workspace && isApi(url) && !headers.has(WORKSPACE_HEADER)) headers.set(WORKSPACE_HEADER, workspace);
    if (manager && !headers.has('Authorization')) {
      const token = await accessToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    const response = await nativeFetch(input, { ...init, headers });
    await checkStaleWorkspace(response, headers.get(WORKSPACE_HEADER));   // a team this tab can't reach any more: Personal
    // The provider ended the session (or the token can't be renewed): sign in again, then come back here. Not while
    // still signing in: a request that raced the callback mustn't start a second sign-in.
    if (manager && ready && response.status === 401 && new URL(url, location.href).pathname.startsWith('/v1/')) void signIn().catch(() => undefined);
    return response;
  };
}

// Where the person was, kept outside the OIDC state too: a callback that fails (a code that expired while Chrome froze
// the tab, a state already used by a page that was killed or reloaded mid-exchange) still brings them back there.
const RETURN_KEY = 'steve.auth.returnTo';
const OAUTH_REQUEST = 'steve.oauthRequest';   // the consent dialog's pending request (shell/OAuthConsent.tsx, main.tsx)
// oidc-client-ts keeps one sign-in state per sign-in started, in localStorage (shared by every tab), for 15 minutes.
// So a crafted link can't fill the storage and stop sign-in: what goes in a state is of ordinary size (measured as
// stored, JSON), the states together stay within a budget far below the storage's 5 MB (newest kept first: dozens of
// tabs signing in at once fit, as an ordinary state is under 1 kB), and a full storage drops them all and tries once more.
const STATE_PART_MAX = 4096;
const SIGNIN_STATES_BUDGET = 1_000_000;   // characters
const small = (value: string | null) => (value !== null && JSON.stringify(value).length <= STATE_PART_MAX ? value : null);
const returnTo = () => small(location.href) ?? `${location.origin}/`;

/** Removes the oldest sign-in states beyond `budget` characters in all (0: every one). */
function pruneSignInStates(budget: number) {
  try {
    const states: { key: string; created: number; size: number }[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith('oidc.')) continue;
      const value = localStorage.getItem(key) ?? '';
      let created = 0;
      try { created = Number((JSON.parse(value || '{}') as { created?: unknown }).created) || 0; } catch { /* unreadable: oldest */ }
      states.push({ key, created, size: key.length + value.length });
    }
    states.sort((a, b) => b.created - a.created);
    let used = 0;
    for (const { key, size } of states) {
      used += size;
      if (used > budget) localStorage.removeItem(key);
    }
  } catch { /* storage off */ }
}

async function redirectToSignIn(args: Parameters<UserManager['signinRedirect']>[0]) {
  pruneSignInStates(SIGNIN_STATES_BUDGET - 2 * STATE_PART_MAX - 1024);   // room for this one
  try {
    await manager!.signinRedirect(args);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'QuotaExceededError')) throw error;
    pruneSignInStates(0);
    await manager!.signinRedirect(args);
  }
}
// Failed callbacks in a row: one is recovered by signing in again (usually an instant bounce through the provider's
// live session); a second stops at a "try again" screen instead of looping.
const FAILURES_KEY = 'steve.auth.callbackFailures';
const CALLBACK_PARAMS = ['code', 'state', 'session_state', 'iss', 'error', 'error_description', 'error_uri'];

/** The page's address without the provider's callback parameters. */
function withoutCallback(href: string): string {
  const url = new URL(href, location.href);
  for (const name of CALLBACK_PARAMS) url.searchParams.delete(name);
  return url.pathname + url.search + url.hash;
}

/** Signing in could not finish: the app shows a screen to try again (main.tsx) rather than a blank page. */
export class SignInError extends Error {}

let leaving: Promise<never> | null = null;

/**
 * Leaves for the provider's sign-in page and back to this address. One redirect however many callers ask at once (a
 * burst of 401s, a renew error), and not from a hidden tab: a code fetched in the background could expire while the
 * browser freezes the tab, so the redirect waits until the person is looking at the page.
 */
function signIn(): Promise<never> {
  // Read now, before waiting for a hidden tab to be shown: the consent dialog drops its request when its own request
  // fails, and this sign-in must still carry it.
  const oauthRequest = leaving ? null : small(sessionStorage.getItem(OAUTH_REQUEST));
  leaving ??= (async (): Promise<never> => {
    if (!manager) throw new SignInError('no identity provider');
    if (document.visibilityState === 'hidden') {
      await new Promise<void>((resolve) => {
        const visible = () => {
          if (document.visibilityState !== 'visible') return;
          document.removeEventListener('visibilitychange', visible);
          resolve();
        };
        document.addEventListener('visibilitychange', visible);
      });
    }
    const back = returnTo();
    sessionStorage.setItem(RETURN_KEY, back);
    // A pending OAuth app request rides in the sign-in state too: sign-in may finish in another tab (an emailed link),
    // which can't see this tab's sessionStorage.
    await redirectToSignIn({ state: { returnTo: back, oauthRequest } });
    return new Promise<never>(() => {});  // The page is leaving for the sign-in page.
  })().catch((error: unknown): never => {
    leaving = null;
    throw error;
  });
  return leaving;
}

/** "Try again" on the sign-in problem screen: a fresh start, without the failures counted so far. */
export function retrySignIn() {
  sessionStorage.removeItem(FAILURES_KEY);
  if (manager) void signIn().catch(() => location.reload());
  else location.reload();
}

/**
 * A fresh sign-in with MFA (the deployment's assurance value `acr`), back to Settings → Teams: for a team whose owner
 * asked admin actions to need it (app/teams.py). The person reviews and repeats the change afterwards: nothing is
 * done automatically on return.
 */
export const TEAMS_RETURN = 'steve.teams.return';
export function verifyTeamIdentity(acr: string): boolean {
  if (!manager) return false;
  const back = returnTo();
  sessionStorage.setItem(RETURN_KEY, back);
  try { sessionStorage.setItem(TEAMS_RETURN, '1'); } catch { /* optional: Settings just doesn't reopen */ }
  void redirectToSignIn({ state: { returnTo: back }, acr_values: acr, prompt: 'login', max_age: 0 });
  return true;
}

/**
 * Sends the person through the provider's sign-in again, even with a live session (prompt=login, max_age=0), and back
 * to this page: a fresh sign-in, for actions the server only accepts right after one (sharing: app/shares.py).
 * False in dev mode (nothing to confirm with).
 */
export function reauthenticate(): boolean {
  if (!manager) return false;
  const back = returnTo();
  sessionStorage.setItem(RETURN_KEY, back);
  void redirectToSignIn({ state: { returnTo: back }, prompt: 'login', max_age: 0 });
  return true;
}

/**
 * After STEVE has deleted the account's data (Settings → Account): the identity provider's own account deletion
 * (Keycloak's application-initiated action delete_account), where the person confirms once more. False in dev mode
 * (no provider). The app never holds the power to delete sign-in accounts itself.
 */
export function deleteSignInAccount(): boolean {
  if (!manager) return false;
  void manager.removeUser().catch(() => undefined);
  void manager.signinRedirect({ extraQueryParams: { kc_action: 'delete_account' }, state: { returnTo: `${location.origin}/` } });
  return true;
}

export async function signOut() {
  await nativeFetch('/v1/auth/session', { method: 'DELETE' }).catch(() => undefined);
  if (manager) await manager.signoutRedirect({ post_logout_redirect_uri: `${location.origin}/` });
}

async function loadAccount() {
  const response = await fetch('/v1/me');
  if (response.ok) useAccount.setState({ account: (await response.json()) as Account });
}

/** Resolves once the person may use the app (signed in, or dev mode). In oidc mode it may navigate to sign-in. */
export async function bootstrapAuth(): Promise<void> {
  let config: ({ mode: 'dev' } | { mode: 'oidc'; issuer: string; client_id: string; scopes: string })
    & { workspaces?: Workspace[]; unavailable?: Partial<Record<Workspace, string>>; admin_only?: Workspace[]; blender_installed?: boolean };
  installFetch();   // the workspace header in every mode; the sign-in's token too in oidc mode
  try {
    const response = await nativeFetch('/v1/auth/config');
    config = response.ok ? await response.json() : { mode: 'dev' };
  } catch {
    config = { mode: 'dev' };  // A server from before accounts, or briefly unreachable: it will say so itself.
  }
  // Blender documents build on their own lane (compose.blender.yaml): new ones are offered only where it runs.
  useApp.setState({ blenderInstalled: !!config.blender_installed });
  if (config.workspaces?.length) {
    // A workspace previewed only to administrators (the server refuses it to everyone else) shows once the account
    // says the person is one; until then, and for everyone else, it's off with the server's reason.
    const offered = config.workspaces, previewed = config.admin_only ?? [];
    const apply = (admin: boolean) => {
      const workspaces = admin ? offered : offered.filter((name) => !previewed.includes(name));
      const unavailable = { ...(config.unavailable ?? {}), ...Object.fromEntries((admin ? [] : previewed).map((name) => [name, `${name.charAt(0).toUpperCase()}${name.slice(1)} is in preview for administrators on this server.`])) };
      useApp.setState((state) => ({ workspaces, unavailable, ...(workspaces.includes(state.workspace) ? {} : { workspace: 'design' as const }) }));
    };
    apply(!!useAccount.getState().account?.admin);
    if (previewed.length) useAccount.subscribe((state) => apply(!!state.account?.admin));
  }
  if (config.mode !== 'oidc') {
    await loadWorkspaces().catch(() => undefined);   // before the account: a team this tab left falls back to Personal
    await loadAccount().catch(() => undefined);
    return;
  }
  manager = new UserManager({
    authority: config.issuer,
    client_id: config.client_id,
    redirect_uri: `${location.origin}/`,
    post_logout_redirect_uri: `${location.origin}/`,
    response_type: 'code',
    scope: config.scopes,
    automaticSilentRenew: true,  // With the refresh token Keycloak issues to public clients.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
  const params = new URLSearchParams(location.search);
  if ((params.has('code') || params.has('error')) && params.has('state')) {
    const saved = sessionStorage.getItem(RETURN_KEY);
    try {
      const user = await manager.signinRedirectCallback();
      const state = user.state as { returnTo?: string; oauthRequest?: string | null } | undefined;
      const back = state?.returnTo ?? saved;
      if (state?.oauthRequest && !sessionStorage.getItem(OAUTH_REQUEST)) sessionStorage.setItem(OAUTH_REQUEST, state.oauthRequest);
      sessionStorage.removeItem(FAILURES_KEY);
      history.replaceState(null, '', back && sameOrigin(back) ? back : '/');
    } catch (error) {
      // An expired or already-used code, a state this tab no longer has, or the provider's own error: discard the
      // callback (never trusted) and fall through to signing in again, back to where the person was.
      const failures = Number(sessionStorage.getItem(FAILURES_KEY) ?? 0) + 1;
      sessionStorage.setItem(FAILURES_KEY, String(failures));
      await manager.clearStaleState().catch(() => undefined);
      history.replaceState(null, '', withoutCallback(saved && sameOrigin(saved) ? saved : location.href));
      if (failures >= 2) throw new SignInError(`sign-in callback failed: ${String(error)}`);
    }
  }
  const user = await manager.getUser();
  if (!user || user.expired) {
    try {
      if (user?.refresh_token) await manager.signinSilent();
      else await signIn();
    } catch {
      await signIn();
    }
  }
  const current = await manager.getUser();
  if (!current) await signIn();
  await startSession(current!.access_token);
  manager.events.addUserLoaded((renewed) => { void startSession(renewed.access_token); });
  manager.events.addSilentRenewError(() => { void signIn().catch(() => undefined); });
  ready = true;
  sessionStorage.removeItem(FAILURES_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  await loadWorkspaces().catch(() => undefined);
  await loadAccount();
}

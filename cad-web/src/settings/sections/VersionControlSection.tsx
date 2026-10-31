/**
 * Settings → Version control (app/git_sync.py, app/git_auth.py): the workspace's documents kept in the person's own git
 * repositories, both ways. Each connection is one repository and branch covering one document, a folder or everything;
 * a document syncs with one repository at most. STEVE signs in with its GitHub App or a GitLab sign-in (when the
 * server has them), an access token, or a deploy key it makes for the repository. Secrets are sent once and kept
 * encrypted: a token shows only its last four characters, a key only its public half.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, GitBranch, RefreshCw, TriangleAlert, Zap } from 'lucide-react';
import { Button, Segmented, Select, Spinner } from '@/ui';
import { api, json } from '@/lib/api';
import { settingsSections } from '../registry';
import { Card, Note, SettingsPage } from '../ui';
import own from './Developers.module.css';
import { askConfirm } from '@/ui/confirm';

type Provider = 'github' | 'gitlab' | 'other';
type ScopeKind = 'document' | 'folder' | 'workspace';
type Method = 'app' | 'token' | 'ssh';
interface Repository {
  id: string; provider: Provider; url: string; branch: string; token_hint: string | null;
  auth: { kind: 'token' | 'ssh' | 'github_app' | 'gitlab_oauth'; public_key?: string; host_keys?: string[]; account?: string | null };
  webhook: { set_up: boolean; last_call_at: string | null };
  scope: { kind: ScopeKind; id: string | null; name: string | null };
  status: 'active' | 'paused'; synced_commit: string | null; last_sync_at: string | null; last_error: string | null;
  documents: number; problems: { document: string; name: string | null; error: string | null; stopped: boolean }[];
  notices: { at: string; text: string }[];
}
interface Folder { id: string; name: string; parent_id: string | null }
interface Doc { id: string; name: string; kind: string }
interface Providers { github_app: boolean; gitlab_oauth: boolean }
interface Installation { id: string; provider: 'github' | 'gitlab'; account: string }
interface HostRepository { name: string; url: string; branch: string }
interface DeployKey { key_id: string; url: string; public_key: string; host: string; host_pinned: boolean; host_keys: string[] }
interface Hook { url: string; secret: string }
interface Start { provider: Provider; installation: string | null; note: string | null }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ago = (value: string | null) => {
  if (!value) return 'not yet';
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  return seconds < 90 ? 'just now' : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const short = (url: string) => url.replace(/^(https|ssh):\/\/([^@/]+@)?(www\.)?/, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '');
const HOSTS: Record<Provider, { label: string; help: string; link?: string; app?: string }> = {
  github: { label: 'GitHub', help: 'A fine-grained token with access to only this repository and Contents: Read and write.',
            link: 'https://github.com/settings/personal-access-tokens/new', app: 'GitHub app' },
  gitlab: { label: 'GitLab', help: 'A project access token with the Developer role and the write_repository scope.',
            link: 'https://docs.gitlab.com/user/project/settings/project_access_tokens/', app: 'Sign in with GitLab' },
  other: { label: 'Other', help: 'A token or app password that can read and push to this repository.' },
};
const NONE = 'none';   // the pickers' "Choose…" (an empty value can't be an option)
const COVERS: Record<ScopeKind, string> = { document: 'One document', folder: 'A folder', workspace: 'Everything' };
const SIGNED_IN: Record<Repository['auth']['kind'], string> = { token: 'token', ssh: 'deploy key', github_app: 'GitHub app', gitlab_oauth: 'GitLab sign-in' };

function folderLabels(folders: Folder[]): { value: string; label: string }[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path = (folder: Folder): string => {
    const parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
    return parent ? `${path(parent)} / ${folder.name}` : folder.name;
  };
  return folders.map((folder) => ({ value: folder.id, label: path(folder) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Where the person adds a deploy key on GitHub or GitLab (another host: its repository settings). */
function deployKeyPage(key: DeployKey): string | null {
  const path = key.url.replace(/^ssh:\/\/[^/]+\//, '').replace(/^[^@]+@[^:]+:/, '').replace(/\.git$/, '');
  if (key.host === 'github.com') return `https://github.com/${path}/settings/keys/new`;
  if (key.host === 'gitlab.com') return `https://gitlab.com/${path}/-/settings/repository#js-deploy-keys-settings`;
  return null;
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={own.secretValue}>
      <code aria-label={label}>{value}</code>
      <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}

/** Connecting a repository: where it is, how STEVE signs in, and what it covers (checked for overlaps as it's chosen). */
function Connect({ start, providers, onDone }: { start: Start; providers: Providers; onDone: () => void }) {
  const appFor = (host: Provider) => (host === 'github' && providers.github_app) || (host === 'gitlab' && providers.gitlab_oauth);
  const [provider, setProvider] = useState<Provider>(start.provider);
  const [method, setMethod] = useState<Method>(appFor(start.provider) ? 'app' : 'token');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installation, setInstallation] = useState(start.installation ?? '');
  const [hostRepositories, setHostRepositories] = useState<HostRepository[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [key, setKey] = useState<DeployKey | null>(null);
  const [kind, setKind] = useState<ScopeKind>('folder');
  const [target, setTarget] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [check, setCheck] = useState<{ documents: Doc[]; overlaps: { name: string; repository: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadInstallations = () => api<{ installations: Installation[] }>('/v1/git/installations').then((made) => setInstallations(made.installations), () => undefined);
  useEffect(() => {
    void api<{ folders: Folder[] }>('/v1/folders').then((made) => setFolders(made.folders), () => undefined);
    void api<{ documents: Doc[] }>('/v1/documents?limit=100').then((made) => setDocs(made.documents), () => undefined);
    void loadInstallations();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setCheck(null);
    if (kind !== 'workspace' && !target) return;
    void api<{ documents: Doc[]; overlaps: { name: string; repository: string }[] }>('/v1/git/scope-check',
      json('POST', { kind, id: kind === 'workspace' ? null : target })).then(setCheck, () => undefined);
  }, [kind, target]);
  const mine = installations.filter((item) => item.provider === provider);
  const signIn = method === 'app' ? (mine.find((item) => item.id === installation) ?? mine[0]) : undefined;
  useEffect(() => {
    setHostRepositories(null); setChosen('');
    if (!signIn) return;
    void api<{ repositories: HostRepository[] }>(`/v1/git/installations/${signIn.id}/repositories`)
      .then((made) => setHostRepositories(made.repositories), (failure) => { setError(message(failure)); void loadInstallations(); });   // an uninstalled app's sign-in is gone
  }, [signIn?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (value: string) => {
    setChosen(value);
    const found = hostRepositories?.find((item) => item.url === value);
    if (found) setBranch(found.branch);
  };
  const run = async (step: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await step(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const signInWithHost = () => run(async () => {
    const made = await api<{ url: string }>(`/v1/git/${provider}/start`, { method: 'POST' });
    window.location.assign(made.url);
  });
  const forget = (item: Installation) => run(async () => {
    await api(`/v1/git/installations/${item.id}`, { method: 'DELETE' });
    setInstallation(''); await loadInstallations();
  });
  const makeKey = () => run(async () => { setKey(await api<DeployKey>('/v1/git/ssh-keys', json('POST', { url: url.trim() }))); });
  const connect = () => run(async () => {
    const auth = method === 'app' ? { kind: provider === 'github' ? 'github_app' : 'gitlab_oauth', installation_id: signIn?.id }
      : method === 'ssh' ? { kind: 'ssh', key_id: key?.key_id } : { kind: 'token', token: token.trim(), username: username.trim() };
    await api('/v1/git/repositories', json('POST', { provider, url: method === 'app' ? chosen : method === 'ssh' ? key?.url : url.trim(),
                                                    branch: branch.trim() || 'main', auth, scope: { kind, id: kind === 'workspace' ? null : target } }));
    setToken(''); onDone();
  });
  const methods: { value: Method; label: string }[] = [
    ...(appFor(provider) ? [{ value: 'app' as Method, label: HOSTS[provider].app! }] : []),
    { value: 'token', label: 'Access token' }, { value: 'ssh', label: 'Deploy key (SSH)' }];
  const changeProvider = (value: Provider) => { setProvider(value); setMethod(appFor(value) ? 'app' : 'token'); setKey(null); setError(null); };
  const host = HOSTS[provider];
  const where = method === 'app' ? Boolean(chosen) : method === 'ssh' ? Boolean(key) : Boolean(url.trim()) && token.trim().length >= 8;
  const ready = where && (kind === 'workspace' || target) && !check?.overlaps.length;
  return (
    <div className={own.form} id="git-connect">
      {start.note && <Note>{start.note}</Note>}
      <Segmented className={own.fit} value={provider} onChange={changeProvider} options={(Object.keys(HOSTS) as Provider[]).map((value) => ({ value, label: HOSTS[value].label }))} />
      <Segmented className={own.fit} size="sm" value={method} onChange={(value: Method) => { setMethod(value); setKey(null); setError(null); }} options={methods} />
      {method === 'app' && (!signIn
        ? <div className={own.actions}>
            <Button variant="primary" icon={busy ? <Spinner size={12} /> : <GitBranch size={14} />} disabled={busy} onClick={() => void signInWithHost()} id="git-sign-in">
              {provider === 'github' ? 'Connect GitHub' : 'Connect GitLab'}</Button>
            <Note>{provider === 'github' ? 'Install STEVE on the repositories it should sync: it gets those, and only their contents.'
              : 'STEVE asks GitLab for access to your repositories, nothing else.'}</Note>
          </div>
        : <div>
            <span className={own.label}>Repository</span>
            <div className={own.actions}>
              {mine.length > 1 && <Select value={signIn.id} onChange={setInstallation} ariaLabel="Account" options={mine.map((item) => ({ value: item.id, label: item.account }))} />}
              <div style={{ flex: 1, minWidth: 220 }}>
                <Select value={chosen || NONE} onChange={(value) => pick(value === NONE ? '' : value)} ariaLabel="Repository" id="git-app-repository"
                        options={[{ value: NONE, label: hostRepositories === null ? 'Loading…' : hostRepositories.length ? 'Choose a repository…' : 'No repositories yet' },
                                  ...(hostRepositories ?? []).map((item) => ({ value: item.url, label: item.name }))]} />
              </div>
            </div>
            <Note>{mine.length === 1 ? `Signed in as ${signIn.account}. ` : ''}Missing one? <a href="#" onClick={(event) => { event.preventDefault(); void signInWithHost(); }}>
              {provider === 'github' ? 'Give STEVE access on GitHub' : 'Sign in to GitLab again'}</a>. <a href="#" id="git-forget" onClick={(event) => { event.preventDefault(); void forget(signIn); }}>
              Forget this sign-in</a>.</Note>
          </div>)}
      {method !== 'app' && (
        <div>
          <span className={own.label}>Repository</span>
          <input className={own.input} value={url} id="git-url" aria-label="Repository address"
                 placeholder={method === 'ssh' ? (provider === 'gitlab' ? 'git@gitlab.com:you/parts.git' : 'git@github.com:you/parts.git')
                   : provider === 'gitlab' ? 'https://gitlab.com/you/parts.git' : 'https://github.com/you/parts.git'}
                 onChange={(event) => { setUrl(event.target.value); setKey(null); }} />
        </div>
      )}
      <div className={own.actions}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <span className={own.label}>Branch</span>
          <input className={own.input} value={branch} onChange={(event) => setBranch(event.target.value)} aria-label="Branch" id="git-branch" />
        </div>
        {provider === 'other' && method === 'token' && (
          <div style={{ flex: 1, minWidth: 160 }}>
            <span className={own.label}>Username</span>
            <input className={own.input} value={username} placeholder="if your host needs one" onChange={(event) => setUsername(event.target.value)} aria-label="Username" />
          </div>
        )}
      </div>
      {method === 'token' && (
        <div>
          <span className={own.label}>Access token</span>
          <input className={own.input} type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} aria-label="Access token" id="git-token" />
          <Note>{host.help}{host.link && <> <a href={host.link} target="_blank" rel="noreferrer">Create one</a>.</>} STEVE keeps it encrypted and sends it only to this repository.</Note>
        </div>
      )}
      {method === 'ssh' && (!key
        ? <div className={own.actions}>
            <Button icon={busy ? <Spinner size={12} /> : undefined} disabled={!url.trim() || busy} onClick={() => void makeKey()} id="git-make-key">Make a deploy key</Button>
            <Note>STEVE makes a key for this repository only and keeps its private half encrypted.</Note>
          </div>
        : <div className={own.secret} id="git-deploy-key">
            <p>Add this key to the repository as a deploy key <b>with write access</b>{deployKeyPage(key) && <> (<a href={deployKeyPage(key)!} target="_blank" rel="noreferrer">open its deploy keys</a>)</>}, then connect.</p>
            <CopyValue value={key.public_key} label="Public key" />
            <p>{key.host_pinned ? `${key.host}'s published host key is checked on every sync.`
              : `${key.host}'s host key, held from now on: ${key.host_keys[0] ?? ''}. Check it with your host if you can.`}</p>
          </div>)}
      <div>
        <span className={own.label}>It covers</span>
        <Segmented value={kind} onChange={(value: ScopeKind) => { setKind(value); setTarget(''); }}
                   options={(['document', 'folder', 'workspace'] as ScopeKind[]).map((value) => ({ value, label: COVERS[value] }))} />
      </div>
      {kind === 'folder' && (
        <Select value={target || NONE} onChange={(value) => setTarget(value === NONE ? '' : value)} ariaLabel="Folder"
                options={[{ value: NONE, label: folders.length ? 'Choose a folder…' : 'No folders yet' }, ...folderLabels(folders)]} />
      )}
      {kind === 'document' && (
        <Select value={target || NONE} onChange={(value) => setTarget(value === NONE ? '' : value)} ariaLabel="Document"
                options={[{ value: NONE, label: 'Choose a document…' }, ...docs.map((doc) => ({ value: doc.id, label: doc.name }))]} />
      )}
      {check && (check.overlaps.length
        ? <Note tone="warning">Already synced with another repository: {[...new Set(check.overlaps.map((item) => item.name))].slice(0, 5).join(', ')}. A document syncs with one repository: disconnect it there first.</Note>
        : <Note>{check.documents.length === 1 ? '1 document' : `${check.documents.length} documents`}{kind === 'folder' ? ', and any you add to the folder later' : ''}.</Note>)}
      {error && <Note tone="warning">{error}</Note>}
      <div className={own.actions}>
        <Button variant="primary" icon={busy ? <Spinner size={12} /> : <GitBranch size={14} />} disabled={!ready || busy} onClick={() => void connect()} id="git-connect-button">Connect</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

/** A connection's webhook, for instant syncs: its address and secret to paste into the repository's webhook settings. */
function Webhook({ repository, onClose }: { repository: Repository; onClose: () => void }) {
  const [hook, setHook] = useState<Hook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (rotate = false) => api<Hook>(`/v1/git/repositories/${repository.id}/webhook${rotate ? '?rotate=true' : ''}`, { method: 'POST' })
    .then(setHook, (failure) => setError(message(failure)));
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Note tone="warning">{error}</Note>;
  if (!hook) return <Spinner size={12} />;
  return (
    <div className={own.secret} id="git-webhook">
      <p>Add a webhook to the repository so STEVE syncs as soon as you push: this address, this secret, push events only{repository.provider === 'github' ? ', content type application/json' : ''}.</p>
      <CopyValue value={hook.url} label="Webhook address" />
      <CopyValue value={hook.secret} label="Webhook secret" />
      <div className={own.actions}>
        <Button size="sm" onClick={onClose}>Done</Button>
        <Button size="sm" variant="ghost" onClick={() => void (async () => {
          if (await askConfirm({ title: 'Make a new secret?', detail: 'The webhook stops working until you paste the new secret into it.', action: 'New secret' })) void load(true);
        })()}>New secret</Button>
      </div>
    </div>
  );
}

/** One connected repository: what it covers, how the last sync went, what needs the person, and its controls. */
function RepositoryRow({ repository, onChange }: { repository: Repository; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [hook, setHook] = useState(false);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await run(); onChange(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const covers = repository.scope.kind === 'workspace' ? 'everything' : `${repository.scope.kind} ${repository.scope.name ?? '(gone)'}`;
  const state = repository.status === 'paused' ? 'Paused'
    : repository.last_error ? null : `Synced ${ago(repository.last_sync_at)}`;
  const instant = repository.auth.kind === 'github_app' || repository.webhook.last_call_at;
  const signedIn = SIGNED_IN[repository.auth.kind] + (repository.auth.account ? ` (${repository.auth.account})` : '');
  return (
    <div className={own.key} data-repository={repository.id}>
      <div>
        <b>{short(repository.url)}</b> <span>· {repository.branch} · {covers} · {repository.documents === 1 ? '1 document' : `${repository.documents} documents`}</span>
        {state && <p>{state}{repository.synced_commit ? ` · ${repository.synced_commit.slice(0, 7)}` : ''} · {signedIn}{instant ? ' · syncs on push' : ''}</p>}
        {repository.last_error && <Note tone="warning"><TriangleAlert size={12} /> {repository.last_error}</Note>}
        {repository.problems.map((problem) => (
          <Note key={problem.document} tone="warning">
            <b>{problem.name ?? 'A document'}</b>: {problem.stopped ? 'its folder was deleted in git, so it no longer syncs.' : problem.error}{' '}
            {problem.stopped && <Button size="sm" variant="ghost" onClick={() => void act(() => api(`/v1/git/documents/${problem.document}/resume`, { method: 'POST' }))}>Sync it again</Button>}
          </Note>
        ))}
        {token !== null && (
          <div className={own.actions}>
            <input className={own.input} type="password" autoComplete="off" value={token} placeholder="New access token" style={{ flex: 1, minWidth: 220 }}
                   onChange={(event) => setToken(event.target.value)} aria-label="New access token" />
            <Button size="sm" variant="primary" disabled={token.trim().length < 8 || busy}
                    onClick={() => void act(() => api(`/v1/git/repositories/${repository.id}`, json('PATCH', { token: token.trim() }))).then(() => setToken(null))}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => setToken(null)}>Cancel</Button>
          </div>
        )}
        {hook && <Webhook repository={repository} onClose={() => setHook(false)} />}
        {error && <Note tone="warning">{error}</Note>}
      </div>
      <div className={own.actions}>
        <Button size="sm" icon={busy ? <Spinner size={12} /> : <RefreshCw size={13} />} disabled={busy || repository.status === 'paused'}
                onClick={() => void act(() => api(`/v1/git/repositories/${repository.id}/sync`, { method: 'POST' }))}>Sync now</Button>
        {repository.auth.kind !== 'github_app' && !hook && <Button size="sm" variant="ghost" icon={<Zap size={13} />} onClick={() => setHook(true)}>Sync on push</Button>}
        {repository.auth.kind === 'token' && <Button size="sm" variant="ghost" onClick={() => setToken('')}>Change token</Button>}
        <Button size="sm" variant="ghost" onClick={() => void act(() => api(`/v1/git/repositories/${repository.id}`, json('PATCH', { paused: repository.status !== 'paused' })))}>
          {repository.status === 'paused' ? 'Resume' : 'Pause'}</Button>
        <Button size="sm" variant="ghost" onClick={() => void (async () => {
          if (await askConfirm({ title: `Disconnect ${short(repository.url)}?`, detail: 'STEVE stops syncing and forgets how it signed in. The repository and your documents stay as they are.',
                                 action: 'Disconnect' })) await act(() => api(`/v1/git/repositories/${repository.id}`, { method: 'DELETE' }));
        })()}>Disconnect</Button>
      </div>
    </div>
  );
}

/** Back from GitHub or GitLab (main.tsx kept their return): finishes the sign-in, signed in here. */
async function finishSignIn(): Promise<Start | null> {
  let kept: string | null = null;
  try { kept = sessionStorage.getItem('steve.gitConnect'); sessionStorage.removeItem('steve.gitConnect'); } catch { return null; }
  if (!kept) return null;
  const params = new URLSearchParams(kept);
  const provider = params.get('provider') === 'gitlab' ? 'gitlab' : 'github';
  if (params.get('error')) return { provider, installation: null, note: `${HOSTS[provider].label} didn't connect (${params.get('error')}). Try again.` };
  const made = await api<{ installation?: Installation; pending?: boolean; message?: string }>(`/v1/git/${provider}/finish`, json('POST', {
    state: params.get('state') ?? '', code: params.get('code'), installation_id: params.get('installation_id'), setup_action: params.get('setup_action') }));
  return { provider, installation: made.installation?.id ?? null, note: made.pending ? made.message ?? null : null };
}

export default function VersionControlSection() {
  const section = settingsSections().find((item) => item.id === 'version-control')!;
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);   // the form opens on the right method once known
  const [connecting, setConnecting] = useState<Start | null>(null);
  const [finishing, setFinishing] = useState(() => { try { return Boolean(sessionStorage.getItem('steve.gitConnect')); } catch { return false; } });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setRepositories((await api<{ repositories: Repository[] }>('/v1/git/repositories')).repositories); setError(null); }
    catch (failure) { setError(message(failure)); }
  }, []);
  useEffect(() => {
    void load();
    void api<Providers>('/v1/git/providers').then(setProviders, () => setProviders({ github_app: false, gitlab_oauth: false }));
    void finishSignIn().then((start) => { if (start) setConnecting(start); }, (failure) => setError(message(failure))).finally(() => setFinishing(false));
    const timer = window.setInterval(() => void load(), 10_000);   // syncs happen in the background: keep the status current
    return () => window.clearInterval(timer);
  }, [load]);
  const sorted = useMemo(() => repositories ?? [], [repositories]);
  return (
    <SettingsPage section={section} id="settings-version-control">
      <Card title="Repositories" description="Your documents as code in your own git repositories, kept in sync both ways."
            actions={!connecting && !finishing && <Button size="sm" variant="primary" icon={<GitBranch size={14} />} id="git-add"
                                            onClick={() => setConnecting({ provider: 'github', installation: null, note: null })}>Connect a repository</Button>}>
        {finishing && <Note><Spinner size={12} /> Finishing the sign-in…</Note>}
        {connecting && providers && <Connect key={JSON.stringify(connecting)} start={connecting} providers={providers} onDone={() => { setConnecting(null); void load(); }} />}
        {error && <Note tone="warning">{error}</Note>}
        {repositories === null ? <Spinner size={14} />
          : !sorted.length && !connecting ? <Note>No repositories yet. Connect one to keep a document, a folder or everything in git.</Note>
          : sorted.map((repository) => <RepositoryRow key={repository.id} repository={repository} onChange={() => void load()} />)}
      </Card>
    </SettingsPage>
  );
}

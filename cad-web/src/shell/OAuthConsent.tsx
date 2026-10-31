/**
 * The consent dialog of OAuth apps (app/oauth_api.py): /oauth/authorize sends the browser here as /#oauth?<request>;
 * main.tsx keeps the request across sign-in (sessionStorage), and this asks the person, once signed in, whether the
 * app may act in their workspace with the scopes it asks for. STEVE checks the request again on every call.
 */
import { useEffect, useState } from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { Button, Dialog } from '@/ui';
import { api, json } from '@/lib/api';

export const OAUTH_REQUEST = 'steve.oauthRequest';

interface Described {
  app: { id: string; name: string; description: string; homepage: string; reviewed: boolean; verified: boolean; new: boolean;
    developer: string; created_at: string; own: boolean };
  redirect_host: string;
  scopes: { name: string; description: string; sensitive: boolean }[];
  // The exact request the description is of: what Allow or Deny sends back, never the dialog's own copy.
  request: { client_id: string; redirect_uri: string; scope: string; code_challenge: string; code_challenge_method: string };
}

function pending(): URLSearchParams | null {
  try {
    const kept = sessionStorage.getItem(OAUTH_REQUEST);
    if (!kept) return null;
    const request = new URLSearchParams(kept);
    const keys = [...request.keys()];
    if (new Set(keys).size !== keys.length) {   // a parameter named twice: never shown, never approved
      sessionStorage.removeItem(OAUTH_REQUEST);
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

export default function OAuthConsent() {
  const [request] = useState(pending);
  const [described, setDescribed] = useState<Described | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!request) return;
    api<Described>(`/v1/oauth/request?${request.toString()}`).then(setDescribed, (failure) => {
      // A request STEVE refuses can't be completed: never keep it to reopen after a reload or a sign-in.
      try { sessionStorage.removeItem(OAUTH_REQUEST); } catch { /* nothing kept */ }
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [request]);
  if (!request) return null;
  const close = () => {
    try { sessionStorage.removeItem(OAUTH_REQUEST); } catch { /* nothing kept */ }
    history.replaceState(null, '', location.pathname + location.search);
  };
  const decide = async (allow: boolean) => {
    if (!described) return;   // the buttons show only with a description
    setBusy(true);
    try {
      const answer = await api<{ redirect: string }>('/v1/oauth/consent',
        json('POST', { ...described.request, state: request.get('state') ?? '', allow }));
      close();
      window.location.assign(answer.redirect);
    } catch (failure) {
      // Answered already (and used by the app): nothing more can be done with this request, so it isn't kept to reopen.
      if ((failure as { status?: number }).status === 409) {
        try { sessionStorage.removeItem(OAUTH_REQUEST); } catch { /* nothing kept */ }
      }
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }} width={460} icon={<ShieldCheck size={18} />}
            title={described ? `Connect ${described.app.name}?` : 'Connect an app'}
            description={described ? `It will act in your workspace with your designs, as allowed below.` : undefined}
            footer={described && !error ? (
              <>
                <Button onClick={() => void decide(false)} disabled={busy}>Don’t allow</Button>
                <Button variant="primary" onClick={() => void decide(true)} disabled={busy} id="oauth-allow">Allow</Button>
              </>
            ) : <Button onClick={close}>Close</Button>}>
      {error && <p role="alert" style={{ color: 'var(--warning)' }}>{error}</p>}
      {described && !error && (
        <div style={{ display: 'grid', gap: 12 }}>
          {!described.app.own && !described.app.verified && (
            <p role="note" data-new-app style={{ color: 'var(--warning)', display: 'flex', gap: 6, lineHeight: 1.5 }}><TriangleAlert size={14} style={{ flex: 'none', marginTop: 3 }} />
              {described.app.new ? 'This app is new' : 'STEVE hasn’t verified this app'}: made by {described.app.developer} on{' '}
              {new Date(described.app.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}. Allow it only if you know and trust who made it.
              It can do what’s listed below with your designs until you disconnect it (Settings → Connected apps).</p>
          )}
          {described.app.description && <p>{described.app.description}</p>}
          <div>
            <b>It will be able to:</b>
            <ul style={{ margin: '6px 0 0 18px', display: 'grid', gap: 4 }}>
              {described.scopes.map((scope) => (
                <li key={scope.name} data-scope={scope.name} style={scope.sensitive ? { color: 'var(--warning)' } : undefined}>
                  {scope.description}{scope.sensitive ? ': this can reach your machines' : ''}
                </li>
              ))}
            </ul>
          </div>
          <p style={{ color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>
            After you allow it, you go back to {described.redirect_host}. You can disconnect it at any time in Settings → Connected apps.
            {described.app.homepage && <> Developer’s site: <a href={described.app.homepage} target="_blank" rel="noreferrer noopener">{described.app.homepage}</a>.</>}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** Settings → Connected apps: the apps this person allowed to act in their workspace, and disconnecting them. */
import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@/ui';
import { api } from '@/lib/api';
import { settingsSections } from '../registry';
import { Card, Note, SettingsPage } from '../ui';
import own from './Developers.module.css';

interface Connection {
  app_id: string; name: string; homepage: string; scopes: string[]; since: string; developer: string; verified: boolean;
  requests_7d: number; recent: { at: string; method: string; route: string; status: number }[];
}

export default function ConnectedAppsSection() {
  const section = settingsSections().find((item) => item.id === 'connected-apps')!;
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<{ connections: Connection[] }>('/v1/oauth/connections').then((body) => setConnections(body.connections), (failure) => setError(failure instanceof Error ? failure.message : String(failure))), []);
  useEffect(() => { void load(); }, [load]);
  const disconnect = async (item: Connection) => {
    try { await api(`/v1/oauth/connections/${item.app_id}`, { method: 'DELETE' }); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return (
    <SettingsPage section={section}>
      <Card title="Connected apps" id="connected-apps" description="Apps you allowed to work in your workspace. Disconnecting one ends its access at once.">
        {error && <Note tone="warning">{error}</Note>}
        {!connections ? <Spinner /> : !connections.length ? <p className={own.empty}>No apps are connected.</p> : connections.map((item) => (
          <div key={item.app_id} className={own.key} data-connection={item.app_id}>
            <div>
              <b>{item.name}</b>
              <p>{item.verified ? 'Verified by STEVE' : `Made by ${item.developer || 'unknown'}`} · since {new Date(item.since).toLocaleDateString(undefined, { dateStyle: 'medium' })} · {item.scopes.join(', ')}{item.homepage ? ` · ${item.homepage}` : ''}</p>
              <p>{item.requests_7d ? `${item.requests_7d.toLocaleString()} requests on your account in the last 7 days` : 'No requests on your account in the last 7 days'}</p>
              {item.recent.length > 0 && (
                <details>
                  <summary>What it did lately</summary>
                  <ul className={own.recent}>
                    {item.recent.map((entry, index) => (
                      <li key={index}>{new Date(entry.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })} · {entry.method} {entry.route} · {entry.status}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <Button size="sm" onClick={() => void disconnect(item)}>Disconnect</Button>
          </div>
        ))}
      </Card>
    </SettingsPage>
  );
}

/**
 * Settings → RMFG (app/rmfg.py): the person's RMFG account (rmfg.com, sheet metal and tube made to order), by signing in
 * with RMFG or with an API key; whether STEVE and AI agents may buy (off, ask first, or automatically up to a limit per
 * order); where purchases go; and recent orders. Parts and designs are ordered with Order from RMFG (the Export menu).
 */
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, LogIn, Package, Trash2 } from 'lucide-react';
import { Button, Segmented, Spinner, Switch } from '@/ui';
import { api, json } from '@/lib/api';
import { askConfirm } from '@/ui/confirm';
import { acknowledged, NotAcknowledged } from '@/terms/terms';
import { money, orderState, removable, removeOrder, type RmfgOrder } from '@/dialogs/RmfgDialog';
import { openRmfgOrders, useRmfgOrders } from '@/lib/rmfgOrders';
import { settingsSections } from '../registry';
import { Card, Note, Row, SettingsPage } from '../ui';
import own from './Developers.module.css';

type Mode = 'off' | 'ask' | 'auto';
interface ShipTo { name: string; company?: string; street1: string; street2?: string; city: string; state: string; postal_code: string; phone: string }
interface Connection {
  auth: 'key' | 'oauth'; key_hint: string | null; scopes: string[]; status: 'active' | 'needs_sign_in' | 'error'; last_error: string | null;
  purchases: { mode: Mode; limit_cents?: number }; can_pay: boolean; ship_to: ShipTo | null; order_updates: boolean; last_call_at: string | null; card_url: string;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// What Clear finished removes (app/rmfg.py clear_route): cancelled, failed, and bought orders RMFG has finished with.
const finished = (order: RmfgOrder) => ['cancelled', 'failed'].includes(order.state)
  || (order.state === 'ordered' && (!!order.order?.delivered_at || ['delivered', 'cancelled', 'canceled', 'refunded'].includes(order.order?.status ?? '')));
const EMPTY: ShipTo ={ name: '', company: '', street1: '', street2: '', city: '', state: '', postal_code: '', phone: '' };

/** Back from RMFG's sign-in (main.tsx kept its return): finishes it, signed in. */
async function finishSignIn(): Promise<boolean> {
  let kept: string | null = null;
  try { kept = sessionStorage.getItem('steve.rmfgConnect'); sessionStorage.removeItem('steve.rmfgConnect'); } catch { return false; }
  if (!kept) return false;
  const params = new URLSearchParams(kept);
  await api('/v1/rmfg/finish', json('POST', { state: params.get('state') ?? '', code: params.get('code'), error: params.get('error'), iss: params.get('iss') }));
  return true;
}

async function signIn(purchases: boolean) {
  const made = await api<{ sign_in_url: string }>('/v1/rmfg/sign-in', json('POST', { purchases }));
  window.location.assign(made.sign_in_url);
}

function Connect() {
  const [purchases, setPurchases] = useState(false);
  const [useKey, setUseKey] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (step: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await step(); } catch (failure) { setError(message(failure)); setBusy(false); }
  };
  return (
    <div className={own.form} id="rmfg-connect">
      <div className={own.actions}>
        <Button variant="primary" icon={busy ? <Spinner size={12} /> : <LogIn size={14} />} disabled={busy} onClick={() => void run(() => signIn(purchases))} id="rmfg-sign-in">
          Sign in with RMFG</Button>
      </div>
      <Row label="Let STEVE pay for orders" hint="With the card saved on your RMFG account. You choose when after connecting: ask first, or automatically up to a limit.">
        <Switch checked={purchases} onCheckedChange={setPurchases} label="Let STEVE pay for orders" />
      </Row>
      <Note>STEVE asks RMFG to upload designs, quote, fill carts and follow orders{purchases ? ', and to pay: RMFG asks you separately' : ''}. You can change it later.</Note>
      {!useKey ? <div className={own.actions}><Button size="sm" variant="ghost" onClick={() => setUseKey(true)} id="rmfg-use-key">Use an API key instead</Button></div> : (
        <div>
          <span className={own.label}>API key</span>
          <input className={own.input} type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} placeholder="rmfg_…" aria-label="API key" id="rmfg-key" />
          <Note>Make one on rmfg.com (Account → API keys). A key can quote and fill carts; paying needs Sign in with RMFG.</Note>
          <Button disabled={busy || key.trim().length < 8} onClick={() => void run(async () => { await api('/v1/rmfg', json('PUT', { key: key.trim() })); window.location.reload(); })} id="rmfg-key-connect">Connect</Button>
        </div>
      )}
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

function Purchases({ connection, onChange }: { connection: Connection; onChange: (next: Connection) => void }) {
  const [mode, setMode] = useState<Mode>(connection.purchases.mode);
  const [limit, setLimit] = useState(String((connection.purchases.limit_cents ?? 50_000) / 100));
  const [error, setError] = useState<string | null>(null);
  const save = async (next: Mode, dollars = limit) => {
    setMode(next); setError(null);
    try {
      // Buying without asking: the person acknowledges what it means, once (app/terms.py).
      const made = await acknowledged(() => api<{ connection: Connection }>('/v1/rmfg/purchases', json('PUT', { mode: next, ...(next === 'auto' ? { limit_cents: Math.round(Number(dollars) * 100) } : {}) })));
      onChange(made.connection);
    } catch (failure) {
      if (failure instanceof NotAcknowledged) setMode(connection.purchases.mode);
      else setError(message(failure));
    }
  };
  return (
    <>
      <Row label="Purchases" hint="Off: you pay for carts on rmfg.com. Ask me first: STEVE and AI agents may ask to buy, and you confirm each one here. Automatic: they buy without asking up to the limit per order (above it, they ask).">
        <Segmented value={mode} onChange={(value: Mode) => void save(value)} options={[{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask me first' }, { value: 'auto', label: 'Automatic' }]} />
      </Row>
      {mode === 'auto' && (
        <Row label="Most an order may cost without asking" hint="Parts, delivery and tax together, in US dollars.">
          <input className={own.input} style={{ width: 120 }} inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value)}
                 onBlur={() => void save('auto', limit)} aria-label="Most an order may cost without asking" id="rmfg-limit" />
        </Row>
      )}
      {mode !== 'off' && !connection.can_pay && (
        <Note tone="warning">RMFG hasn’t allowed STEVE to pay yet. <Button size="sm" variant="ghost" onClick={() => void signIn(true)}>Sign in with RMFG to allow paying</Button></Note>
      )}
      {mode !== 'off' && connection.can_pay && <Note>Paid with the card saved on your RMFG account: <a href={connection.card_url} target="_blank" rel="noreferrer">save or change it</a>.</Note>}
      {error && <Note tone="warning">{error}</Note>}
    </>
  );
}

function Delivery({ connection, onChange }: { connection: Connection; onChange: (next: Connection) => void }) {
  const [address, setAddress] = useState<ShipTo>({ ...EMPTY, ...(connection.ship_to ?? {}) });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (key: keyof ShipTo, label: string, wide = false) => (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className={own.label}>{label}</span>
      <input className={own.input} value={address[key] ?? ''} aria-label={label} onChange={(event) => { setSaved(false); setAddress({ ...address, [key]: event.target.value }); }} />
    </div>
  );
  const save = async () => {
    setError(null);
    try {
      const made = await api<{ connection: Connection }>('/v1/rmfg/ship-to', json('PUT', Object.fromEntries(Object.entries(address).filter(([, value]) => value))));
      onChange(made.connection); setSaved(true);
    } catch (failure) { setError(message(failure)); }
  };
  return (
    <div id="rmfg-ship-to">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        {field('name', 'Name')}{field('company', 'Company')}{field('street1', 'Street', true)}{field('street2', 'Unit, suite', true)}
        {field('city', 'City')}{field('state', 'State')}{field('postal_code', 'ZIP code')}{field('phone', 'Phone (for delivery)')}
      </div>
      <div className={own.actions} style={{ marginTop: 10 }}>
        <Button size="sm" onClick={() => void save()} id="rmfg-ship-save">{saved ? 'Saved' : 'Save address'}</Button>
      </div>
      {error && <Note tone="warning">{error}</Note>}
    </div>
  );
}

export default function RmfgSection() {
  const section = settingsSections().find((item) => item.id === 'rmfg')!;
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined);
  const [orders, setOrders] = useState<RmfgOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const made = await api<{ connection: Connection | null; orders: RmfgOrder[] }>('/v1/rmfg');
      setConnection(made.connection); setOrders(made.orders); setError(null);
    } catch (failure) { setError(message(failure)); }
    void useRmfgOrders.getState().refresh(true);   // connected or disconnected here: the top bar's RMFG button follows
  }, []);
  useEffect(() => {
    void finishSignIn().catch((failure) => setError(message(failure))).finally(() => void load());
  }, [load]);
  const disconnect = async () => {
    if (!(await askConfirm({ title: 'Disconnect RMFG?', detail: 'STEVE forgets your sign-in or key and stops following orders. Your carts and orders stay on rmfg.com.', action: 'Disconnect' }))) return;
    await api('/v1/rmfg', { method: 'DELETE' }); await load();
  };
  const remove = async (order: RmfgOrder) => {
    try { if (await removeOrder(order)) await load(); } catch (failure) { setError(message(failure)); }
  };
  const clearFinished = async () => {
    try { await api('/v1/rmfg/orders/clear', { method: 'POST' }); await load(); } catch (failure) { setError(message(failure)); }
  };
  return (
    <SettingsPage section={section} id="settings-rmfg">
      <Card title="Account" description="Order parts and designs with Order from RMFG, in the Export menu.">
        {connection === undefined ? <Spinner size={14} /> : !connection ? <Connect /> : (
          <div className={own.form}>
            <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
              {connection.auth === 'oauth' ? 'Signed in with RMFG' : `API key …${connection.key_hint}`} · allows {connection.scopes.join(', ')}
              {connection.order_updates ? ' · RMFG tells STEVE when carts are paid and orders move.' : ''}
            </p>
            {connection.status !== 'active' && <Note tone="warning">{connection.last_error ?? 'Sign in with RMFG again.'}</Note>}
            <div className={own.actions}>
              <Button size="sm" variant="ghost" icon={<LogIn size={13} />} onClick={() => void signIn(connection.can_pay || connection.purchases.mode !== 'off')}>Sign in again</Button>
              <Button size="sm" variant="ghost" onClick={() => void disconnect()}>Disconnect</Button>
            </div>
          </div>
        )}
        {error && <Note tone="warning">{error}</Note>}
      </Card>
      {connection && (
        <Card title="Buying" description="Whether STEVE and AI agents may pay for orders, and where they go.">
          <Purchases connection={connection} onChange={setConnection} />
          {connection.purchases.mode !== 'off' && <Delivery connection={connection} onChange={setConnection} />}
        </Card>
      )}
      {orders.length > 0 && (
        <Card title="Orders" description="Quotes, carts and orders from you, STEVE and your AI agents, newest first. Open one to see what’s in it, change it or buy it; the RMFG button at the top shows the open ones. Remove takes one off these lists (carts and orders stay on rmfg.com)."
              actions={orders.some(finished) && <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={() => void clearFinished()} id="rmfg-clear-finished">Clear finished</Button>}>
          {orders.map((order) => (
            <div className={own.key} key={order.id}>
              <div>
                <b><Package size={13} /> {order.document_name}</b> <span>· {orderState(order)}</span>
                <p>{order.quote?.amount_cents != null ? `${money(order.quote.amount_cents)} for ${order.quote.quantity}` : order.error ?? ''}
                  {order.order?.tracking?.url ? <> · <a href={order.order.tracking.url} target="_blank" rel="noreferrer">tracking</a></> : null}</p>
              </div>
              <div className={own.actions}>
                {order.state !== 'cancelled' && <Button size="sm" variant="ghost" onClick={() => openRmfgOrders(order.id)} data-rmfg-open={order.id}>Open</Button>}
                {order.cart && order.state !== 'ordered' && <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => window.open(order.cart!.url, '_blank', 'noopener')}>Cart</Button>}
                {removable(order) && <Button size="sm" variant="ghost" onClick={() => void remove(order)} data-rmfg-remove={order.id}>Remove</Button>}
              </div>
            </div>
          ))}
        </Card>
      )}
    </SettingsPage>
  );
}

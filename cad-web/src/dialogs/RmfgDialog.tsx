/**
 * Order from RMFG (app/rmfg.py): this part or design, as saved on main, made by RMFG. STEVE uploads it, chooses RMFG's
 * sheet for each part's material and thickness and taps the holes modelled as threaded; RMFG quotes it at the quantities
 * asked, with its manufacturability findings and lead times. The person changes any choice and quotes again, reviews it
 * on rmfg.com, adds it to a cart, and pays there, or here with the card saved on RMFG once purchases are allowed
 * (Settings → RMFG). A purchase an agent asked for waits here for the person.
 * Opened from the top bar's RMFG button (or Settings → RMFG → Orders) it lists every open order, whoever asked for it
 * and whichever document it's for, and opens any of them here by its id: the open document isn't needed to buy one.
 * Remove takes an order off these lists (one not bought is cancelled, a bought one only hidden; carts and orders stay
 * on rmfg.com).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CircleAlert, ExternalLink, FolderOpen, Info, Package, Settings2, ShoppingCart, Trash2, TriangleAlert } from 'lucide-react';
import { Button, Dialog, Field, Select, Spinner } from '@/ui';
import { api, json } from '@/lib/api';
import { askConfirm } from '@/ui/confirm';
import { isDirty, set, useApp } from '@/state/store';
import { openTab } from '@/state/tabs';
import { useRmfgOrders } from '@/lib/rmfgOrders';
import { money } from '@/lib/rmfgSummary';
import { openSettings } from '@/settings/registry';
import styles from './Dialogs.module.css';
import own from './RmfgDialog.module.css';

interface Part { id: string; name: string; process: 'sheet_metal' | 'tube_laser'; instances: number; thickness_mm: number | null; bends: number; holes: number; ready: boolean }
interface Issue { part_id: string | null; code: string; severity: 'blocking' | 'warning' | 'info'; message: string; hole_id: number | null; accepted: boolean }
interface Quote {
  status: string; quantity: number; unit_cents: number | null; amount_cents: number | null; expires_at: string | null;
  options: { quantity: number; unit_cents: number; amount_cents: number }[];
  requirements: { code: string; message: string }[]; issues: Issue[]; review_url: string | null;
  production: { speed: string; days: number; ship_date: string; surcharge_cents: number }[];
}
interface ShippingOption { id: string; speed: string; carrier: string; service: string; amount_cents: number; delivery_date: string | null; days: number | null }
interface Cart { id: string; url: string; status: string; total_cents: number | null; subtotal_cents: number | null; shipping_cents: number | null; tax_cents: number | null; shipping_option_id: string | null; shipping_options: ShippingOption[] }
interface PartChoice { material_id?: string | null; tube_profile_id?: string | null; finish_id?: string | null; powder_coat_color_id?: string | null; taps?: { hole_id: number; tap_id: string }[] }
export interface RmfgOrder {
  id: string; document_id: string; document_name: string; document_revision: number | null; state: 'queued' | 'working' | 'needs_choice' | 'quoted' | 'carted' | 'awaiting_confirmation' | 'paying' | 'ordered' | 'failed' | 'cancelled';
  steps: { at: string; text: string }[]; error: string | null; notes: string[]; asked_by: string;
  design: { id: string; parts: Part[]; review_url: string | null } | null; quote: Quote | null; cart: Cart | null;
  choices: { quantity: number; quantity_options: number[]; shipping_option_id?: string }; configuration: { parts: ({ part_id: string } & PartChoice)[] } | null;
  order: { id: string; status: string; total_cents: number | null; estimated_ship_date: string | null; delivered_at?: string | null; tracking: { carrier: string; number: string; url: string | null } | null; url: string } | null;
  created_at: string;
}
interface Catalog { materials: { id: string; name: string }[]; tube_profiles: { id: string; name: string }[]; finishes: { id: string; name: string }[]; colors: { id: string; name: string }[]; taps: { id: string; name: string }[] }
interface Connection { can_pay: boolean; purchases: { mode: 'off' | 'ask' | 'auto'; limit_cents?: number }; ship_to: { city: string } | null; card_url: string }

const WORKING = new Set(['queued', 'working', 'paying']);
const NONE = 'none';
export { money };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const STATE: Record<RmfgOrder['state'], string> = { queued: 'Starting', working: 'Working', needs_choice: 'Needs a choice', quoted: 'Quoted',
  carted: 'In your RMFG cart', awaiting_confirmation: 'Waiting for you to buy', paying: 'Paying', ordered: 'Ordered', failed: 'Failed', cancelled: 'Cancelled' };
export const orderState = (order: RmfgOrder) => (order.state === 'ordered' && order.order ? `Ordered · ${order.order.status.replace(/_/g, ' ')}` : STATE[order.state]);

/** Removes an order from STEVE's lists (POST …/remove): one not bought is cancelled, a bought one only hidden. A cart or
 * a bought order asks first, saying it stays on rmfg.com. True when removed. */
export async function removeOrder(order: RmfgOrder): Promise<boolean> {
  const atRmfg = order.state === 'ordered' ? 'Your order stays on rmfg.com, where RMFG keeps making and shipping it'
    : order.cart && ['carted', 'awaiting_confirmation'].includes(order.state) ? 'Your cart stays on rmfg.com, unpaid' : null;
  if (atRmfg && !(await askConfirm({ title: `Remove “${order.document_name}” from STEVE?`, detail: `${atRmfg}; STEVE stops showing it here.`, action: 'Remove' }))) return false;
  await api(`/v1/rmfg/orders/${order.id}/remove`, { method: 'POST' });
  void useRmfgOrders.getState().refresh(true);   // the top bar's RMFG button follows
  return true;
}
export const removable = (order: RmfgOrder) => !WORKING.has(order.state);

/** RMFG's picture of a part (holes and bends labelled), read with the person's sign-in. */
function PartImage({ order, part }: { order: string; part: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    void fetch(`/v1/rmfg/orders/${order}/parts/${part}/image`).then((answer) => (answer.ok ? answer.blob() : null))
      .then((blob) => { if (blob) { url = URL.createObjectURL(blob); setSrc(url); } }, () => undefined);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [order, part]);
  return src ? <img className={own.image} src={src} alt="The part as RMFG sees it, holes and bends numbered" /> : <div className={own.image} />;
}

const ASKER: Record<string, string> = { person: 'you', assistant: 'STEVE' };
const asker = (kind: string) => ASKER[kind] ?? 'an AI agent';

/** What's in an order, in a line or two: its price (the cart's, with delivery and tax once chosen) and its parts. */
function OrderRow({ order, onOpen, onRemove }: { order: RmfgOrder; onOpen: () => void; onRemove: () => void }) {
  const { cart, quote } = order;
  const parts = order.design?.parts ?? [];
  const price = cart && ['carted', 'awaiting_confirmation'].includes(order.state)
    ? (cart.shipping_cents != null ? `In your cart: ${money(cart.subtotal_cents)} + delivery ${money(cart.shipping_cents)} + tax ${money(cart.tax_cents)} = ${money(cart.total_cents)}`
      : `In your cart: ${money(cart.subtotal_cents ?? cart.total_cents)}, before delivery and tax`)
    : quote?.amount_cents != null ? `${money(quote.amount_cents)} for ${quote.quantity} (${money(quote.unit_cents)} each)`
      : order.state === 'ordered' && order.order ? `${money(order.order.total_cents)}${order.order.estimated_ship_date ? ` · ships ${order.order.estimated_ship_date}` : ''}`
        : `${order.choices.quantity} asked`;
  const made = parts.slice(0, 6).map((part) => `${part.name}${part.instances > 1 ? ` ×${part.instances}` : ''} (${part.process === 'sheet_metal' ? 'sheet' : 'tube'}${part.thickness_mm ? `, ${part.thickness_mm} mm` : ''})`).join(', ')
    + (parts.length > 6 ? ` and ${parts.length - 6} more` : '');
  return (
    <div className={own.listRow} data-rmfg-order={order.id} data-waiting={order.state === 'awaiting_confirmation' || undefined}>
      <button type="button" className={own.listOpen} onClick={onOpen}>
        <b>{order.document_name}</b>
        <span>{orderState(order)} · asked by {asker(order.asked_by)}</span>
        <small>{price}</small>
        {made && <small>{made}</small>}
      </button>
      {cart && ['carted', 'awaiting_confirmation'].includes(order.state) && (
        <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => window.open(cart.url, '_blank', 'noopener')}>Open cart on RMFG</Button>)}
      {removable(order) && <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} onClick={onRemove} aria-label={`Remove ${order.document_name}`} data-rmfg-remove={order.id}>Remove</Button>}
    </div>
  );
}

export default function RmfgDialog({ open }: { open: boolean }) {
  const saved = useApp((state) => state.doc.saved);
  const branch = useApp((state) => state.doc.branch);
  const dirty = useApp((state) => isDirty(state));
  const name = useApp((state) => state.doc.name);
  const target = useApp((state) => state.rmfgOrder);   // null: this document's order; 'orders': every open one; or one order
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [order, setOrder] = useState<RmfgOrder | null>(null);
  const [list, setList] = useState<RmfgOrder[] | null>(null);   // the open orders, while they're shown
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [compare, setCompare] = useState('10, 25');
  const [picked, setPicked] = useState<Record<string, PartChoice>>({});
  const [option, setOption] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedId = saved?.id;
  const show = useCallback((item: RmfgOrder | null) => {
    setOrder(item); setPicked({}); setOption(null); setError(null);
    if (item) setQuantity(String(item.choices.quantity));
  }, []);
  const showAll = useCallback(() => {
    show(null);
    void api<{ connection: Connection | null; orders: RmfgOrder[] }>('/v1/rmfg/status').then((made) => {
      setConnected(!!made.connection); setConnection(made.connection); setList(made.orders);
    }, (failure) => setError(message(failure)));
  }, [show]);
  useEffect(() => {
    if (!open) return;
    show(null); setList(null); setConnected(null);
    const connectedThen = (yes: boolean) => {
      setConnected(yes);
      if (yes) void api<Catalog>('/v1/rmfg/catalog').then(setCatalog, () => undefined);
    };
    if (target === 'orders') {   // every open order, from the top bar or Settings
      showAll();
      void api<Catalog>('/v1/rmfg/catalog').then(setCatalog, () => undefined);
      return;
    }
    if (target) {   // one order, by its id: whichever document it's for
      void api<{ connection: Connection | null }>('/v1/rmfg/status').then((made) => { setConnection(made.connection); connectedThen(!!made.connection); }, () => undefined);
      void api<{ order: RmfgOrder }>(`/v1/rmfg/orders/${target}`).then((made) => show(made.order), (failure) => setError(message(failure)));
      return;
    }
    if (!savedId) return;
    void api<{ connected: boolean; orders: RmfgOrder[] }>(`/v1/rmfg/documents/${savedId}`).then((found) => {
      connectedThen(found.connected);
      const current = found.orders.find((item) => item.state !== 'cancelled');
      if (current) show(current);
      if (found.connected) void api<{ connection: Connection | null }>('/v1/rmfg/status').then((made) => setConnection(made.connection), () => undefined);
    }, (failure) => setError(message(failure)));
  }, [open, savedId, target, show, showAll]);
  const orderId = order?.id;
  const following = !!order && WORKING.has(order.state);
  useEffect(() => {   // The work runs on the server: its steps show as they happen.
    if (!following || !orderId) return;
    const timer = window.setInterval(() => {
      api<{ order: RmfgOrder }>(`/v1/rmfg/orders/${orderId}`).then((made) => setOrder(made.order), () => { /* next time */ });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [following, orderId]);
  const run = useCallback(async (step: () => Promise<{ order: RmfgOrder }>) => {
    setBusy(true); setError(null);
    try { setOrder((await step()).order); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
    void useRmfgOrders.getState().refresh(true);   // the top bar's RMFG button and "waiting" count follow
  }, []);
  const amounts = () => ({ quantity: Math.max(1, Math.round(Number(quantity) || 1)),
    quantity_options: compare.split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5) });
  const start = () => run(() => api('/v1/rmfg/orders', json('POST', { document_id: savedId, ...amounts() })));
  const requote = () => run(() => api(`/v1/rmfg/orders/${orderId}/quote`, json('POST', { ...amounts(), parts: chosen })));
  const configured = useMemo(() => Object.fromEntries((order?.configuration?.parts ?? []).map((part) => [part.part_id, part])), [order]);
  const chosen = useMemo(() => Object.fromEntries((order?.design?.parts ?? []).map((part) => [part.id, { ...(configured[part.id] ?? {}), ...(picked[part.id] ?? {}) }])), [order, configured, picked]);
  const changed = Object.keys(picked).length > 0 || (!!order && Math.max(1, Math.round(Number(quantity) || 1)) !== order.choices.quantity);
  const choose = (part: string, key: keyof PartChoice, value: string) => setPicked((now) => ({ ...now, [part]: { ...now[part], [key]: value === NONE ? null : value } }));
  const pickDelivery = (id: string) => { setOption(id); void run(() => api(`/v1/rmfg/orders/${orderId}/delivery`, json('POST', { shipping_option_id: id }))); };
  const buy = async () => {
    if (!order?.cart || !option) return;
    const total = order.cart.total_cents ?? 0;
    if (!(await askConfirm({ title: `Buy for ${money(total)}?`, detail: `RMFG charges the card saved on your RMFG account ${money(total)} (parts, delivery and tax) and starts making it.`, action: 'Buy' }))) return;
    await run(() => api(`/v1/rmfg/orders/${orderId}/buy`, json('POST', { shipping_option_id: option, total_cents: total })));
  };
  const remove = async (item: RmfgOrder) => {
    setBusy(true); setError(null);
    try {
      if (!(await removeOrder(item))) return;
      if (forDocument) show(null); else showAll();   // back to quoting this document afresh, or to the list
    } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  };
  const onBranch = branch !== 'main';
  const close = () => set({ dialog: null });
  const quote = order?.quote;
  const canBuy = !!connection?.can_pay && connection.purchases.mode !== 'off';
  const issuesOf = (part: string | null) => (quote?.issues ?? []).filter((issue) => issue.part_id === part);
  const delivering = order?.cart?.shipping_options ?? [];
  const forDocument = target === null;   // opened on the open document (Order from RMFG…)
  const listing = list !== null && !order;
  const elsewhere = !!order && order.document_id !== savedId;   // another document's order, opened by its id
  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()} width={720}
      title={listing ? 'RMFG quotes and carts' : `Order “${order?.document_name ?? name}” from RMFG`}
      icon={<div className={styles.itemIcon} style={{ color: 'var(--ws)' }}><Package size={17} /></div>}
      description={listing ? 'Open at RMFG, from you, STEVE and your AI agents. Choose one to see what’s in it, change it or buy it.'
        : elsewhere && order ? `From revision ${order.document_revision ?? '—'} as saved, asked by ${asker(order.asked_by)}.`
          : !forDocument && !order ? undefined
            : !saved ? 'Save it first.' : onBranch ? 'Only main is made: switch to main, or merge first.'
              : `Laser-cut, bent and tapped by RMFG in Fort Worth, TX, from revision ${saved.revision} as saved${dirty ? ' (your unsaved changes aren’t included)' : ''}.`}
      footer={<>
        {!forDocument && order && <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={showAll} id="rmfg-all">All quotes and carts</Button>}
        {elsewhere && order && <Button variant="ghost" icon={<FolderOpen size={14} />} onClick={() => { close(); openTab({ id: order.document_id }); }} id="rmfg-open-design">Open the design</Button>}
        {order && removable(order) && <Button variant="ghost" icon={<Trash2 size={14} />} disabled={busy} onClick={() => void remove(order)} id="rmfg-remove">Remove</Button>}
        <Button onClick={close}>Close</Button>
        {forDocument && connected && !order && !onBranch && <Button variant="primary" disabled={busy || !saved} onClick={() => void start()} id="rmfg-quote">Get a quote</Button>}
        {order && ['quoted', 'needs_choice', 'failed', 'carted'].includes(order.state) && changed && (
          <Button variant="primary" disabled={busy} onClick={() => void requote()} id="rmfg-requote">Quote again</Button>)}
        {order?.state === 'quoted' && !changed && (
          <Button variant="primary" icon={<ShoppingCart size={14} />} disabled={busy} onClick={() => void run(() => api(`/v1/rmfg/orders/${orderId}/cart`, { method: 'POST' }))} id="rmfg-cart">Add to cart</Button>)}
        {order?.cart && ['carted', 'awaiting_confirmation'].includes(order.state) && (
          <Button variant={canBuy ? 'ghost' : 'primary'} icon={<ExternalLink size={14} />} onClick={() => window.open(order.cart!.url, '_blank', 'noopener')} id="rmfg-open-cart">Open cart on RMFG</Button>)}
      </>}>
      {error && <div role="alert" className={styles.message}>{error}</div>}
      {connected === null && !error && <Spinner />}
      {connected === false && (
        <div className={styles.message} style={{ color: 'var(--text-3)' }}>
          RMFG isn’t connected. <Button size="sm" variant="ghost" icon={<Settings2 size={13} />} onClick={() => { close(); openSettings('rmfg'); }}>Connect RMFG</Button>
        </div>
      )}
      {listing && list && connected && (
        <div className={own.list} id="rmfg-orders">
          {!list.length && <div className={styles.message} style={{ color: 'var(--text-3)' }}>Nothing open at RMFG. Quote a part or design with Order from RMFG… in the Export menu, or ask STEVE.</div>}
          {list.map((item) => <OrderRow key={item.id} order={item} onOpen={() => show(item)} onRemove={() => void remove(item)} />)}
        </div>
      )}
      {forDocument && connected && !order && !onBranch && (
        <div className={own.row}>
          <Field label="Quantity"><input value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="numeric" aria-label="Quantity" id="rmfg-quantity" /></Field>
          <Field label="Also price" hint="Other quantities to compare."><input value={compare} onChange={(event) => setCompare(event.target.value)} aria-label="Also price" /></Field>
        </div>
      )}
      {order && (
        <div id="rmfg-order" className={own.order}>
          {(following || order.state === 'failed') && (
            <ul className={own.steps} role="status">
              {order.steps.map((step, index) => <li key={index}>{step.text}</li>)}
              {following && <li><Spinner size={11} /> {order.steps.length ? 'Working…' : 'Starting…'}</li>}
            </ul>
          )}
          {order.state === 'failed' && <div role="alert" className={styles.message}>{order.error}</div>}
          {order.state === 'ordered' && order.order && (
            <div className={own.done} id="rmfg-ordered">
              <b>Ordered from RMFG</b> · {order.order.status.replace(/_/g, ' ')}{order.order.total_cents != null ? ` · ${money(order.order.total_cents)}` : ''}
              {order.order.estimated_ship_date ? ` · ships ${order.order.estimated_ship_date}` : ''}
              {order.order.tracking?.url && <> · <a href={order.order.tracking.url} target="_blank" rel="noreferrer">track {order.order.tracking.carrier} {order.order.tracking.number}</a></>}
              {' · '}<a href={order.order.url} target="_blank" rel="noreferrer">your orders on RMFG</a>
            </div>
          )}
          {quote && quote.amount_cents != null && order.state !== 'ordered' && (
            <div className={own.price} id="rmfg-price">
              <div><b>{money(quote.amount_cents)}</b> for {quote.quantity} <span>({money(quote.unit_cents)} each)</span></div>
              {quote.options.length > 0 && <div className={own.options}>{quote.options.map((item) => (
                <button type="button" key={item.quantity} onClick={() => setQuantity(String(item.quantity))} data-active={String(item.quantity) === quantity || undefined}>
                  {item.quantity}: {money(item.amount_cents)} <span>({money(item.unit_cents)} each)</span></button>))}</div>}
              {quote.production.length > 0 && <small>{quote.production.map((item) => `${item.speed} ${item.days} days (ships ${item.ship_date}${item.surcharge_cents ? `, +${money(item.surcharge_cents)}` : ''})`).join(' · ')}. Delivery and tax at checkout.</small>}
            </div>
          )}
          {quote?.requirements.map((item) => <div key={item.code} className={own.finding} data-severity="blocking"><CircleAlert size={14} /> {item.message}</div>)}
          {issuesOf(null).map((issue) => <div key={issue.code} className={own.finding} data-severity={issue.severity}><TriangleAlert size={14} /> {issue.message}</div>)}
          {order.notes.length > 0 && <ul className={own.notes}>{order.notes.map((note) => <li key={note}><Info size={12} /> {note}</li>)}</ul>}
          {order.design && !following && order.state !== 'ordered' && order.design.parts.map((part) => {
            const mine = chosen[part.id] ?? {};
            const sheet = part.process === 'sheet_metal';
            const stock = sheet ? catalog?.materials ?? [] : catalog?.tube_profiles ?? [];
            const field = sheet ? 'material_id' : 'tube_profile_id';
            const current = (mine[field] as string | null | undefined) ?? NONE;
            const taps = (mine.taps ?? []).length;
            return (
              <div className={own.part} key={part.id} data-part={part.id}>
                <PartImage order={order.id} part={part.id} />
                <div className={own.partBody}>
                  <b>{part.name}{part.instances > 1 ? ` ×${part.instances}` : ''}</b>
                  <small>{sheet ? 'Sheet' : 'Tube'}{part.thickness_mm ? ` · ${part.thickness_mm} mm` : ''} · {part.bends} bend{part.bends === 1 ? '' : 's'} · {part.holes} hole{part.holes === 1 ? '' : 's'}{taps ? ` · ${taps} tapped` : ''}</small>
                  <div className={own.choices}>
                    <Select value={current} ariaLabel={`${sheet ? 'Material' : 'Tube profile'} of ${part.name}`} onChange={(value) => choose(part.id, field, value)}
                            options={[{ value: NONE, label: sheet ? 'Choose a material…' : 'Choose a profile…' }, ...stock.map((item) => ({ value: item.id, label: item.name }))]} />
                    <Select value={mine.finish_id ?? NONE} ariaLabel={`Finish of ${part.name}`} onChange={(value) => choose(part.id, 'finish_id', value)}
                            options={[{ value: NONE, label: 'No finish' }, ...(catalog?.finishes ?? []).map((item) => ({ value: item.id, label: item.name }))]} />
                    <Select value={mine.powder_coat_color_id ?? NONE} ariaLabel={`Powder coat of ${part.name}`} onChange={(value) => choose(part.id, 'powder_coat_color_id', value)}
                            options={[{ value: NONE, label: 'No powder coat' }, ...(catalog?.colors ?? []).map((item) => ({ value: item.id, label: `Powder coat: ${item.name}` }))]} />
                  </div>
                  {issuesOf(part.id).map((issue) => (
                    <div key={`${issue.code}-${issue.hole_id}`} className={own.finding} data-severity={issue.severity}>
                      {issue.severity === 'blocking' ? <CircleAlert size={14} /> : <TriangleAlert size={14} />} {issue.message}</div>))}
                </div>
              </div>
            );
          })}
          {quote?.review_url && order.state !== 'ordered' && !following && (
            <a className={own.review} href={quote.review_url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Review it on RMFG: holes, bends and finishes in 3D</a>)}
          {order.state === 'awaiting_confirmation' && (
            <div className={own.ask} id="rmfg-asked">
              {order.asked_by === 'person' ? 'You' : order.asked_by === 'assistant' ? 'STEVE' : 'An AI agent'} asked to buy this. Choose delivery and buy it, or decline.
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api(`/v1/rmfg/orders/${orderId}/cancel`, { method: 'POST' }))}>Decline</Button>
            </div>
          )}
          {order.cart && ['carted', 'awaiting_confirmation'].includes(order.state) && canBuy && (
            <div className={own.buy} id="rmfg-buy">
              <b>Buy it here</b>
              {!connection?.ship_to ? <small>Save a delivery address in <a href="#" onClick={(event) => { event.preventDefault(); close(); openSettings('rmfg'); }}>Settings → RMFG</a> first.</small>
                : !delivering.length ? <Button size="sm" disabled={busy} onClick={() => void run(() => api(`/v1/rmfg/orders/${orderId}/delivery`, json('POST', {})))} id="rmfg-delivery">Show delivery options</Button>
                  : <>
                      <div className={own.delivery} role="radiogroup" aria-label="Delivery">
                        {delivering.map((item) => (
                          <label key={item.id}><input type="radio" name="rmfg-delivery" checked={option === item.id} onChange={() => pickDelivery(item.id)} />
                            {item.carrier === 'RMFG' ? 'Pick up in Fort Worth' : `${item.carrier} ${item.service.replace(/_/g, ' ').toLowerCase()}`} ({item.speed})
                            {item.delivery_date ? ` · by ${item.delivery_date}` : ''} · {money(item.amount_cents)}</label>))}
                      </div>
                      {option && order.cart.shipping_option_id === option && (
                        <div className={own.total}>
                          {money(order.cart.subtotal_cents)} + delivery {money(order.cart.shipping_cents)} + tax {money(order.cart.tax_cents)} = <b>{money(order.cart.total_cents)}</b>
                          <Button variant="primary" size="sm" disabled={busy} onClick={() => void buy()} id="rmfg-buy-button">Buy for {money(order.cart.total_cents)}</Button>
                        </div>
                      )}
                    </>}
              <small>Paid with the card saved on your RMFG account (<a href={connection?.card_url} target="_blank" rel="noreferrer">save or change it</a>).</small>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

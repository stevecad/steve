/**
 * Words for RMFG's open orders (lib/rmfgOrders.ts, dialogs/RmfgDialog.tsx): what the top bar's RMFG button says, and
 * which orders are announced and how. No imports beyond types, so it's tested on its own (tests/rmfg_orders_test.mjs).
 */
import type { RmfgOrder } from '@/dialogs/RmfgDialog';

export const money = (cents: number | null | undefined) => (cents == null ? '—' : `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const WHO: Record<string, string> = { assistant: 'STEVE', agent: 'An AI agent', service_account: 'An API key', app: 'A connected app' };
const ANNOUNCED = new Set(['quoted', 'needs_choice', 'carted', 'awaiting_confirmation']);

/** What the RMFG button's tooltip says: "1 quoted · 1 in your cart". */
export function ordersSummary(orders: RmfgOrder[]): string {
  const count = (states: string[]) => orders.filter((order) => states.includes(order.state)).length;
  return ([
    [count(['queued', 'working']), 'being quoted'], [count(['needs_choice']), 'needing a choice'], [count(['quoted']), 'quoted'],
    [count(['carted']), 'in your cart'], [count(['awaiting_confirmation']), 'waiting for you to buy'], [count(['paying', 'ordered']), 'ordered'],
  ] as [number, string][]).filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ');
}

/** The moments worth telling the person about, one key each: what STEVE or an agent quoted or carted (their own quotes
 * they're watching already), and any purchase waiting for them. */
export function announced(orders: RmfgOrder[]): Map<string, RmfgOrder> {
  return new Map(orders.filter((order) => ANNOUNCED.has(order.state) && (order.asked_by !== 'person' || order.state === 'awaiting_confirmation'))
    .map((order) => [`${order.id}:${order.state}`, order]));
}

/** The message for one of them: a title and a line. */
export function announcement(order: RmfgOrder): { title: string; detail?: string } {
  const who = WHO[order.asked_by] ?? 'You';
  const name = `“${order.document_name}”`;
  const title = order.state === 'awaiting_confirmation' ? `${who} asked to buy ${name} from RMFG`
    : order.state === 'carted' ? `${who} put ${name} in an RMFG cart`
      : order.state === 'needs_choice' ? `${name} needs a choice to quote at RMFG`
        : `${who} quoted ${name} at RMFG`;
  const detail = order.state === 'awaiting_confirmation' ? 'It waits for you: choose delivery and buy it, or decline.'
    : order.state === 'carted' && order.cart ? `${money(order.cart.subtotal_cents ?? order.cart.total_cents)} in the cart, before delivery and tax.`
      : order.quote?.amount_cents != null ? `${money(order.quote.amount_cents)} for ${order.quote.quantity}.` : undefined;
  return { title, detail };
}

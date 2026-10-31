/**
 * This person's RMFG orders still in play (app/rmfg.py: being quoted, quoted, in a cart, waiting for them to buy, or
 * bought and not yet delivered), whoever asked for them: one shared list, looked at on the same light tick as the
 * waiting runs (lib/pendingRuns.ts), so the top bar's RMFG button and the "N waiting" count show the same ones. A quote
 * or cart STEVE or an AI agent made, and a purchase waiting for the person, are announced once (lib/rmfgSummary.ts).
 */
import { create } from 'zustand';
import { set as setApp, toast } from '@/state/store';
import { api } from '@/lib/api';
import type { RmfgOrder } from '@/dialogs/RmfgDialog';
import { announced, announcement } from '@/lib/rmfgSummary';

export { ordersSummary } from '@/lib/rmfgSummary';

interface Orders { connected: boolean; orders: RmfgOrder[]; refresh: (force?: boolean) => Promise<void> }

let seen: Set<string> | null = null;
let known = false;   // looked once: not connected, the tick stops looking until Settings → RMFG or the dialog looks again

/** Opens Order from RMFG on one order, or on every open order. */
export const openRmfgOrders = (order = 'orders') => setApp({ dialog: 'rmfg', rmfgOrder: order });

export const useRmfgOrders = create<Orders>((set, get) => ({
  connected: false,
  orders: [],
  refresh: async (force = false) => {
    if (known && !get().connected && !force) return;
    let made: { connection: unknown; orders: RmfgOrder[] };
    try {
      made = await api<{ connection: unknown; orders: RmfgOrder[] }>('/v1/rmfg/status');
    } catch {
      return;   // Not signed in yet, or RMFG unavailable: nothing shown.
    }
    known = true;
    const connected = !!made.connection;
    const orders = connected ? made.orders : [];
    const events = announced(orders);
    if (seen) {
      for (const [key, order] of events) {
        if (seen.has(key)) continue;
        const { title, detail } = announcement(order);
        toast('info', title, detail, { action: { label: 'Show', run: () => openRmfgOrders(order.id) } });
      }
    }
    seen = new Set(events.keys());
    set({ connected, orders });
  },
}));

import type { Liquidation, Trade } from '../core/types';
import { hub, Ring } from './hub';

/** Large prints and liquidations collected from app start, independent of panel mounts. */
export interface WhaleEvent {
  kind: 'trade' | 'liq';
  venue: Trade['venue'];
  side: 'buy' | 'sell';
  price: number;
  qty: number;
  usd: number;
  time: number;
}

export const WHALE_FLOOR_USD = 25_000;
export const whaleEvents = new Ring<WhaleEvent>(5000);
let started = false;
let lastBase = '';

export function startCollectors() {
  if (started) return;
  started = true;
  const h = hub();
  h.onChange(() => {
    if (h.primary.inst.base !== lastBase) {
      lastBase = h.primary.inst.base;
      whaleEvents.clear();
    }
  });
  h.onTrade((t: Trade) => {
    const usd = t.price * t.qty;
    if (usd >= WHALE_FLOOR_USD) whaleEvents.push({ kind: 'trade', venue: t.venue, side: t.side, price: t.price, qty: t.qty, usd, time: t.time });
  });
  h.onLiq((l: Liquidation) => {
    const usd = l.price * l.qty;
    // a long liquidation is a forced sell
    if (usd >= WHALE_FLOOR_USD) whaleEvents.push({ kind: 'liq', venue: l.venue, side: l.position === 'long' ? 'sell' : 'buy', price: l.price, qty: l.qty, usd, time: l.time });
  });
}

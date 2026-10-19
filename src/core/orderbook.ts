import type { BookLevel, BookUpdate } from './types';

/** Number of decimals needed to represent multiples of `step` exactly (0.25 → 2, 0.5 → 1, 10 → 0). */
export function decimalsOf(step: number): number {
  if (!isFinite(step) || step <= 0) return 2;
  for (let d = 0; d <= 10; d++) {
    const x = step * 10 ** d;
    if (Math.abs(x - Math.round(x)) < 1e-9 * Math.max(1, x)) return d;
  }
  return 10;
}

export function roundTo(value: number, step: number): number {
  const d = decimalsOf(step);
  return Number((Math.round(value / step) * step).toFixed(d));
}

/** Bucket a price onto a tick grid. Bids floor, asks ceil, trades floor. */
export function bucket(price: number, tick: number, mode: 'floor' | 'ceil' | 'round' = 'floor'): number {
  if (!(tick > 0)) return price;
  const r = price / tick;
  const k = mode === 'floor' ? Math.floor(r + 1e-9) : mode === 'ceil' ? Math.ceil(r - 1e-9) : Math.round(r);
  return Number((k * tick).toFixed(decimalsOf(tick)));
}

/** Full-depth L2 order book maintained from snapshots + deltas. */
export class OrderBook {
  readonly bids = new Map<number, number>();
  readonly asks = new Map<number, number>();
  time = 0;
  /** monotonically increasing change counter, used by consumers for caching */
  version = 0;
  private sortedBids: BookLevel[] | null = null;
  private sortedAsks: BookLevel[] | null = null;

  apply(u: BookUpdate) {
    if (u.snapshot) {
      this.bids.clear();
      this.asks.clear();
    }
    for (const [p, q] of u.bids) {
      if (q > 0) this.bids.set(p, q);
      else this.bids.delete(p);
    }
    for (const [p, q] of u.asks) {
      if (q > 0) this.asks.set(p, q);
      else this.asks.delete(p);
    }
    this.time = u.time;
    this.version++;
    this.sortedBids = null;
    this.sortedAsks = null;
    this.uncross(u);
  }

  /**
   * Venues occasionally leave a stale level behind while deltas are in flight,
   * which shows up as a crossed book. Levels on the side that was not touched
   * by this update are treated as stale and pruned.
   */
  private uncross(u: BookUpdate) {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (!bb || !ba || bb.price < ba.price) return;
    if (u.bids.length >= u.asks.length) {
      for (const p of [...this.asks.keys()]) if (p <= bb.price) this.asks.delete(p);
      this.sortedAsks = null;
    } else {
      for (const p of [...this.bids.keys()]) if (p >= ba.price) this.bids.delete(p);
      this.sortedBids = null;
    }
  }

  clear() {
    this.bids.clear();
    this.asks.clear();
    this.version++;
    this.sortedBids = null;
    this.sortedAsks = null;
  }

  get empty() {
    return this.bids.size === 0 && this.asks.size === 0;
  }

  /** Bids sorted descending (best first). Cached until next change. */
  getBids(): BookLevel[] {
    if (!this.sortedBids) {
      const arr: BookLevel[] = [];
      for (const [price, qty] of this.bids) arr.push({ price, qty });
      arr.sort((a, b) => b.price - a.price);
      this.sortedBids = arr;
    }
    return this.sortedBids;
  }

  /** Asks sorted ascending (best first). Cached until next change. */
  getAsks(): BookLevel[] {
    if (!this.sortedAsks) {
      const arr: BookLevel[] = [];
      for (const [price, qty] of this.asks) arr.push({ price, qty });
      arr.sort((a, b) => a.price - b.price);
      this.sortedAsks = arr;
    }
    return this.sortedAsks;
  }

  bestBid(): BookLevel | undefined {
    if (this.sortedBids) return this.sortedBids[0];
    let best: number | undefined;
    for (const p of this.bids.keys()) if (best === undefined || p > best) best = p;
    return best === undefined ? undefined : { price: best, qty: this.bids.get(best)! };
  }

  bestAsk(): BookLevel | undefined {
    if (this.sortedAsks) return this.sortedAsks[0];
    let best: number | undefined;
    for (const p of this.asks.keys()) if (best === undefined || p < best) best = p;
    return best === undefined ? undefined : { price: best, qty: this.asks.get(best)! };
  }

  mid(): number {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return NaN;
    return (b.price + a.price) / 2;
  }
}

/** Group sorted levels onto a tick grid. */
export function groupLevels(levels: BookLevel[], tick: number, side: 'bid' | 'ask'): BookLevel[] {
  if (!(tick > 0)) return levels;
  const out: BookLevel[] = [];
  const mode = side === 'bid' ? 'floor' : 'ceil';
  for (const l of levels) {
    const p = bucket(l.price, tick, mode);
    const last = out[out.length - 1];
    if (last && last.price === p) last.qty += l.qty;
    else out.push({ price: p, qty: l.qty });
  }
  return out;
}

export interface DepthStats {
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  spreadBps: number;
  bid05: number;
  ask05: number;
  bid2: number;
  ask2: number;
  bid10: number;
  ask10: number;
  totalBid: number;
  totalAsk: number;
}

export function depthStats(book: OrderBook): DepthStats | null {
  const bids = book.getBids();
  const asks = book.getAsks();
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const s: DepthStats = {
    bestBid,
    bestAsk,
    mid,
    spread: bestAsk - bestBid,
    spreadBps: ((bestAsk - bestBid) / mid) * 1e4,
    bid05: 0,
    ask05: 0,
    bid2: 0,
    ask2: 0,
    bid10: 0,
    ask10: 0,
    totalBid: 0,
    totalAsk: 0,
  };
  for (const l of bids) {
    const d = (mid - l.price) / mid;
    if (d <= 0.005) s.bid05 += l.qty;
    if (d <= 0.02) s.bid2 += l.qty;
    if (d <= 0.1) s.bid10 += l.qty;
    s.totalBid += l.qty;
  }
  for (const l of asks) {
    const d = (l.price - mid) / mid;
    if (d <= 0.005) s.ask05 += l.qty;
    if (d <= 0.02) s.ask2 += l.qty;
    if (d <= 0.1) s.ask10 += l.qty;
    s.totalAsk += l.qty;
  }
  return s;
}

import { bucket, type OrderBook } from './orderbook';

export interface HeatmapSnapshot {
  time: number;
  bestBid: number;
  bestAsk: number;
  /** price grid the levels were grouped onto */
  res: number;
  /** interleaved [price, qty, price, qty, ...] for bids (best first) */
  bids: Float32Array;
  asks: Float32Array;
}

/**
 * Records periodic order book snapshots for liquidity heatmaps. Levels are
 * grouped onto `resolution` and clipped to +/- `rangePct` around mid to bound
 * memory.
 */
export class HeatmapRecorder {
  snapshots: HeatmapSnapshot[] = [];
  version = 0;
  private lastTake = 0;

  constructor(
    public intervalMs = 500,
    public maxSnapshots = 7200,
    public rangePct = 0.04,
    public resolution = 0,
  ) {}

  clear() {
    this.snapshots = [];
    this.version++;
  }

  /** Take a snapshot if the interval elapsed. `books` are summed (composite). */
  maybeTake(now: number, books: OrderBook[]) {
    if (now - this.lastTake < this.intervalMs) return false;
    this.lastTake = now;
    return this.take(now, books);
  }

  take(now: number, books: OrderBook[]): boolean {
    let bestBid = -Infinity;
    let bestAsk = Infinity;
    for (const b of books) {
      const bb = b.bestBid();
      const ba = b.bestAsk();
      if (bb && bb.price > bestBid) bestBid = bb.price;
      if (ba && ba.price < bestAsk) bestAsk = ba.price;
    }
    if (!isFinite(bestBid) || !isFinite(bestAsk)) return false;
    const mid = (bestBid + bestAsk) / 2;
    const res = this.resolution > 0 ? this.resolution : autoResolution(mid);
    const lo = mid * (1 - this.rangePct);
    const hi = mid * (1 + this.rangePct);
    const bidMap = new Map<number, number>();
    const askMap = new Map<number, number>();
    for (const b of books) {
      for (const [p, q] of b.bids) if (p >= lo) {
        const k = bucket(p, res, 'floor');
        bidMap.set(k, (bidMap.get(k) ?? 0) + q);
      }
      for (const [p, q] of b.asks) if (p <= hi) {
        const k = bucket(p, res, 'floor');
        askMap.set(k, (askMap.get(k) ?? 0) + q);
      }
    }
    const pack = (m: Map<number, number>, desc: boolean) => {
      const keys = [...m.keys()].sort((a, b) => (desc ? b - a : a - b));
      const arr = new Float32Array(keys.length * 2);
      keys.forEach((k, i) => {
        arr[i * 2] = k;
        arr[i * 2 + 1] = m.get(k)!;
      });
      return arr;
    };
    this.snapshots.push({ time: now, bestBid, bestAsk, res, bids: pack(bidMap, true), asks: pack(askMap, false) });
    if (this.snapshots.length > this.maxSnapshots) this.snapshots.splice(0, this.snapshots.length - this.maxSnapshots);
    this.version++;
    return true;
  }

  /** Index of the last snapshot with time <= t (binary search). */
  indexAt(t: number): number {
    const s = this.snapshots;
    let lo = 0;
    let hi = s.length - 1;
    if (hi < 0 || s[0].time > t) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (s[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/** Roughly 1bp grid rounded to a 1/2/5 step. */
export function autoResolution(price: number): number {
  return niceStep(price * 0.0001);
}

export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nf = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return Number((nf * 10 ** exp).toPrecision(6));
}

/**
 * Quantity normaliser for colour scaling: returns the value at percentile `p`
 * of non-zero quantities across a set of snapshots (sampled).
 */
export function qtyPercentile(snaps: HeatmapSnapshot[], p = 0.97): number {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(snaps.length / 200));
  for (let i = 0; i < snaps.length; i += step) {
    const s = snaps[i];
    for (let j = 1; j < s.bids.length; j += 2) vals.push(s.bids[j]);
    for (let j = 1; j < s.asks.length; j += 2) vals.push(s.asks[j]);
  }
  if (!vals.length) return 1;
  vals.sort((a, b) => a - b);
  return vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] || 1;
}

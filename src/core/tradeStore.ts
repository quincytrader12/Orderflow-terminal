import type { Side, Trade } from './types';

/**
 * Columnar, append-mostly trade storage backed by typed arrays.
 *
 * Consumers process trades incrementally using absolute sequence numbers:
 * `start` is the absolute index of the first retained trade and `end` is one
 * past the last. When history is prepended (backfill) or the store is cleared,
 * `generation` changes and consumers must rebuild from scratch.
 */
export class TradeStore {
  private price: Float64Array;
  private qty: Float64Array;
  private time: Float64Array;
  private side: Uint8Array; // 1 = buy, 0 = sell
  private len = 0;
  /** absolute index of element 0 */
  private base = 0;
  generation = 0;

  constructor(
    private readonly maxTrades = 2_000_000,
    initialCapacity = 65_536,
  ) {
    this.price = new Float64Array(initialCapacity);
    this.qty = new Float64Array(initialCapacity);
    this.time = new Float64Array(initialCapacity);
    this.side = new Uint8Array(initialCapacity);
  }

  get start(): number {
    return this.base;
  }
  get end(): number {
    return this.base + this.len;
  }
  get length(): number {
    return this.len;
  }

  private grow(min: number) {
    let cap = this.price.length;
    while (cap < min) cap *= 2;
    if (cap === this.price.length) return;
    const p = new Float64Array(cap);
    p.set(this.price.subarray(0, this.len));
    const q = new Float64Array(cap);
    q.set(this.qty.subarray(0, this.len));
    const t = new Float64Array(cap);
    t.set(this.time.subarray(0, this.len));
    const s = new Uint8Array(cap);
    s.set(this.side.subarray(0, this.len));
    this.price = p;
    this.qty = q;
    this.time = t;
    this.side = s;
  }

  /** Drop the oldest quarter when over capacity, keeping absolute indices stable. */
  private trim() {
    if (this.len <= this.maxTrades) return;
    const drop = Math.floor(this.maxTrades / 4);
    this.price.copyWithin(0, drop, this.len);
    this.qty.copyWithin(0, drop, this.len);
    this.time.copyWithin(0, drop, this.len);
    this.side.copyWithin(0, drop, this.len);
    this.len -= drop;
    this.base += drop;
  }

  push(price: number, qty: number, side: Side, time: number) {
    if (!(price > 0) || !(qty > 0)) return;
    if (this.len >= this.price.length) this.grow(this.len + 1);
    const i = this.len++;
    // keep the store time-ordered even if a venue delivers slightly out of order
    const last = i > 0 ? this.time[i - 1] : 0;
    this.price[i] = price;
    this.qty[i] = qty;
    this.time[i] = time < last ? last : time;
    this.side[i] = side === 'buy' ? 1 : 0;
    this.trim();
  }

  pushTrade(t: Trade) {
    this.push(t.price, t.qty, t.side, t.time);
  }

  /**
   * Insert historical trades older than the current first trade. Trades that
   * overlap the live range are dropped. Bumps `generation`.
   */
  prepend(trades: { price: number; qty: number; side: Side; time: number }[]) {
    const firstLive = this.len > 0 ? this.time[0] : Infinity;
    const older = trades.filter((t) => t.time < firstLive && t.price > 0 && t.qty > 0);
    if (older.length === 0) return 0;
    older.sort((a, b) => a.time - b.time);
    const n = older.length;
    this.grow(this.len + n);
    this.price.copyWithin(n, 0, this.len);
    this.qty.copyWithin(n, 0, this.len);
    this.time.copyWithin(n, 0, this.len);
    this.side.copyWithin(n, 0, this.len);
    for (let i = 0; i < n; i++) {
      const t = older[i];
      this.price[i] = t.price;
      this.qty[i] = t.qty;
      this.time[i] = t.time;
      this.side[i] = t.side === 'buy' ? 1 : 0;
    }
    this.len += n;
    this.base = Math.max(0, this.base - n);
    this.generation++;
    this.trim();
    return n;
  }

  clear() {
    this.len = 0;
    this.base = 0;
    this.generation++;
  }

  // Accessors take absolute indices.
  p(abs: number) {
    return this.price[abs - this.base];
  }
  q(abs: number) {
    return this.qty[abs - this.base];
  }
  t(abs: number) {
    return this.time[abs - this.base];
  }
  isBuy(abs: number) {
    return this.side[abs - this.base] === 1;
  }

  firstTime(): number {
    return this.len ? this.time[0] : NaN;
  }
  lastTime(): number {
    return this.len ? this.time[this.len - 1] : NaN;
  }
  lastPrice(): number {
    return this.len ? this.price[this.len - 1] : NaN;
  }

  /** First absolute index with time >= ts. */
  indexAtTime(ts: number): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.time[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo + this.base;
  }

  /** Iterate trades in [fromAbs, toAbs). */
  forEach(fromAbs: number, toAbs: number, fn: (price: number, qty: number, buy: boolean, time: number) => void) {
    const a = Math.max(0, fromAbs - this.base);
    const b = Math.min(this.len, toAbs - this.base);
    for (let i = a; i < b; i++) fn(this.price[i], this.qty[i], this.side[i] === 1, this.time[i]);
  }
}

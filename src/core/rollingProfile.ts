import { bucket } from './orderbook';
import type { TradeStore } from './tradeStore';

export interface ProfileLevel {
  buy: number;
  sell: number;
  /** time of the last trade at this level */
  last: number;
}

/**
 * Traded volume per price level over a rolling time window (or the whole
 * session when windowMs = Infinity). Maintained incrementally: new trades are
 * added at the head and expired trades subtracted at the tail.
 */
export class RollingProfile {
  levels = new Map<number, ProfileLevel>();
  high = -Infinity;
  low = Infinity;
  dataStart = NaN;
  private head = 0;
  private tail = 0;
  private generation = -1;

  constructor(
    private store: TradeStore,
    public tick: number,
    public windowMs: number,
  ) {}

  configure(store: TradeStore, tick: number, windowMs: number) {
    if (store !== this.store || tick !== this.tick || windowMs !== this.windowMs) {
      this.store = store;
      this.tick = tick;
      this.windowMs = windowMs;
      this.generation = -1;
    }
  }

  private reset() {
    const s = this.store;
    this.levels.clear();
    this.high = -Infinity;
    this.low = Infinity;
    const from = isFinite(this.windowMs) && s.length ? s.lastTime() - this.windowMs : -Infinity;
    this.head = this.tail = isFinite(from) ? s.indexAtTime(from) : s.start;
    this.generation = s.generation;
  }

  update(now: number) {
    const s = this.store;
    if (this.generation !== s.generation) this.reset();
    if (this.tail < s.start) {
      // trades fell out of the store; rebuild to stay consistent
      this.generation = -1;
      this.reset();
    }
    const tick = this.tick;
    for (let i = this.head; i < s.end; i++) {
      const k = bucket(s.p(i), tick, 'floor');
      let l = this.levels.get(k);
      if (!l) {
        l = { buy: 0, sell: 0, last: 0 };
        this.levels.set(k, l);
      }
      if (s.isBuy(i)) l.buy += s.q(i);
      else l.sell += s.q(i);
      l.last = s.t(i);
      if (k > this.high) this.high = k;
      if (k < this.low) this.low = k;
    }
    this.head = s.end;
    let expired = false;
    if (isFinite(this.windowMs)) {
      const cutoff = now - this.windowMs;
      while (this.tail < this.head && s.t(this.tail) < cutoff) {
        const k = bucket(s.p(this.tail), tick, 'floor');
        const l = this.levels.get(k);
        if (l) {
          if (s.isBuy(this.tail)) l.buy -= s.q(this.tail);
          else l.sell -= s.q(this.tail);
          if (l.buy + l.sell <= 1e-12) this.levels.delete(k);
        }
        this.tail++;
        expired = true;
      }
    }
    if (expired) {
      this.high = -Infinity;
      this.low = Infinity;
      for (const k of this.levels.keys()) {
        if (k > this.high) this.high = k;
        if (k < this.low) this.low = k;
      }
    }
    this.dataStart = this.tail < this.head ? s.t(this.tail) : NaN;
  }
}

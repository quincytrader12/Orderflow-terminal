import { bucket } from './orderbook';
import type { TradeStore } from './tradeStore';

export type BarType = 'time' | 'tick' | 'volume' | 'range';

export interface FootprintOptions {
  barType: BarType;
  /** ms for time bars; trade count for tick bars; base volume for volume bars; ticks for range bars */
  size: number;
  tick: number;
  /** trades with notional >= this are recorded as bubbles */
  bubbleMinNotional: number;
  /** only build candles newer than this (ms) */
  lookbackMs: number;
}

export interface FootprintLevel {
  buy: number;
  sell: number;
}

export interface FootprintCandle {
  time: number;
  endTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVol: number;
  sellVol: number;
  /** running intra-bar delta extremes */
  maxDelta: number;
  minDelta: number;
  trades: number;
  levels: Map<number, FootprintLevel>;
  /** cumulative delta at the close of this bar (session = since first bar) */
  cvd: number;
}

export interface Bubble {
  time: number;
  price: number;
  qty: number;
  buy: boolean;
}

function newCandle(time: number, price: number, cvdBefore: number): FootprintCandle {
  return {
    time,
    endTime: time,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
    buyVol: 0,
    sellVol: 0,
    maxDelta: 0,
    minDelta: 0,
    trades: 0,
    levels: new Map(),
    cvd: cvdBefore,
  };
}

export function candleDelta(c: FootprintCandle) {
  return c.buyVol - c.sellVol;
}

/** Point of control: price level with the highest traded volume. */
export function candlePoc(c: FootprintCandle): number {
  let best = c.close;
  let bestV = -1;
  for (const [p, l] of c.levels) {
    const v = l.buy + l.sell;
    if (v > bestV) {
      bestV = v;
      best = p;
    }
  }
  return best;
}

/**
 * Diagonal imbalances: an ask-side (buy) imbalance at price P compares buys at
 * P against sells one tick lower; a bid-side (sell) imbalance compares sells at
 * P against buys one tick higher. Returns sets of flagged prices.
 */
export function imbalances(c: FootprintCandle, tick: number, ratio: number, minQty = 0) {
  const buyImb = new Set<number>();
  const sellImb = new Set<number>();
  const lowB = bucket(c.low, tick, 'floor');
  const highB = bucket(c.high, tick, 'floor');
  const eps = tick * 1e-6;
  for (const [p, l] of c.levels) {
    // a zero opposite side only counts when that price is inside the bar's range
    if (l.buy > 0 && l.buy >= minQty && p > lowB + eps) {
      const below = c.levels.get(bucket(p - tick, tick, 'round'))?.sell ?? 0;
      if (below === 0 || l.buy / below >= ratio) buyImb.add(p);
    }
    if (l.sell > 0 && l.sell >= minQty && p < highB - eps) {
      const above = c.levels.get(bucket(p + tick, tick, 'round'))?.buy ?? 0;
      if (above === 0 || l.sell / above >= ratio) sellImb.add(p);
    }
  }
  return { buyImb, sellImb };
}

/** Stacked imbalances: >= `count` consecutive flagged prices. Returns [low, high] zones. */
export function stackedZones(prices: Set<number>, tick: number, count: number): [number, number][] {
  const sorted = [...prices].sort((a, b) => a - b);
  const zones: [number, number][] = [];
  let runStart = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const contiguous = i < sorted.length && Math.abs(sorted[i] - sorted[i - 1] - tick) < tick * 1e-6;
    if (!contiguous) {
      if (i - runStart >= count) zones.push([sorted[runStart], sorted[i - 1]]);
      runStart = i;
    }
  }
  return zones;
}

/** Incrementally builds footprint candles from a TradeStore. */
export class FootprintBuilder {
  candles: FootprintCandle[] = [];
  bubbles: Bubble[] = [];
  private processed = 0;
  private generation = -1;
  private cvd = 0;
  version = 0;

  constructor(
    private store: TradeStore,
    public opts: FootprintOptions,
  ) {}

  setOptions(opts: FootprintOptions) {
    const o = this.opts;
    if (
      o.barType !== opts.barType ||
      o.size !== opts.size ||
      o.tick !== opts.tick ||
      o.bubbleMinNotional !== opts.bubbleMinNotional ||
      o.lookbackMs !== opts.lookbackMs
    ) {
      this.opts = opts;
      this.generation = -1;
    }
  }

  setStore(store: TradeStore) {
    if (store !== this.store) {
      this.store = store;
      this.generation = -1;
    }
  }

  private reset() {
    this.candles = [];
    this.bubbles = [];
    this.cvd = 0;
    const s = this.store;
    const from = s.length ? s.lastTime() - this.opts.lookbackMs : 0;
    this.processed = Math.max(s.start, s.indexAtTime(from));
    this.generation = s.generation;
  }

  /** Process new trades. Returns true when anything changed. */
  update(): boolean {
    const s = this.store;
    if (this.generation !== s.generation) this.reset();
    if (this.processed < s.start) this.processed = s.start;
    const end = s.end;
    if (this.processed >= end) return false;
    const { barType, size, tick, bubbleMinNotional } = this.opts;
    let cur = this.candles[this.candles.length - 1];
    for (let i = this.processed; i < end; i++) {
      const price = s.p(i);
      const qty = s.q(i);
      const buy = s.isBuy(i);
      const time = s.t(i);
      let needNew = !cur;
      if (cur) {
        switch (barType) {
          case 'time':
            needNew = Math.floor(time / size) * size !== cur.time;
            break;
          case 'tick':
            needNew = cur.trades >= size;
            break;
          case 'volume':
            needNew = cur.volume >= size;
            break;
          case 'range':
            needNew = Math.max(cur.high, price) - Math.min(cur.low, price) > size * tick + tick * 1e-6;
            break;
        }
      }
      if (needNew) {
        const t = barType === 'time' ? Math.floor(time / size) * size : time;
        cur = newCandle(t, price, this.cvd);
        this.candles.push(cur);
      }
      const c = cur!;
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
      c.endTime = time;
      c.volume += qty;
      c.trades++;
      if (buy) {
        c.buyVol += qty;
        this.cvd += qty;
      } else {
        c.sellVol += qty;
        this.cvd -= qty;
      }
      c.cvd = this.cvd;
      const d = c.buyVol - c.sellVol;
      if (d > c.maxDelta) c.maxDelta = d;
      if (d < c.minDelta) c.minDelta = d;
      const key = bucket(price, tick, 'floor');
      let lvl = c.levels.get(key);
      if (!lvl) {
        lvl = { buy: 0, sell: 0 };
        c.levels.set(key, lvl);
      }
      if (buy) lvl.buy += qty;
      else lvl.sell += qty;
      if (bubbleMinNotional > 0 && qty * price >= bubbleMinNotional) this.bubbles.push({ time, price, qty, buy });
    }
    this.processed = end;
    // bound memory: keep at most 5000 candles / 20000 bubbles
    if (this.candles.length > 5000) this.candles.splice(0, this.candles.length - 5000);
    if (this.bubbles.length > 20000) this.bubbles.splice(0, this.bubbles.length - 20000);
    this.version++;
    return true;
  }
}

/** Volume profile over [fromTime, toTime) from a TradeStore. */
export function volumeProfile(store: TradeStore, fromTime: number, toTime: number, tick: number) {
  const levels = new Map<number, FootprintLevel>();
  const a = store.indexAtTime(fromTime);
  const b = store.indexAtTime(toTime);
  store.forEach(a, b, (price, qty, buy) => {
    const k = bucket(price, tick, 'floor');
    let l = levels.get(k);
    if (!l) {
      l = { buy: 0, sell: 0 };
      levels.set(k, l);
    }
    if (buy) l.buy += qty;
    else l.sell += qty;
  });
  return levels;
}

export interface ValueArea {
  poc: number;
  vah: number;
  val: number;
  total: number;
}

/** Classic value-area expansion from the POC until `pct` of volume is enclosed. */
export function valueArea(levels: Map<number, number>, pct = 0.7): ValueArea | null {
  if (levels.size === 0) return null;
  const prices = [...levels.keys()].sort((a, b) => a - b);
  let total = 0;
  let poc = prices[0];
  let pocV = -1;
  for (const p of prices) {
    const v = levels.get(p)!;
    total += v;
    if (v > pocV) {
      pocV = v;
      poc = p;
    }
  }
  const idx = new Map(prices.map((p, i) => [p, i]));
  let lo = idx.get(poc)!;
  let hi = lo;
  let acc = pocV;
  const target = total * pct;
  while (acc < target && (lo > 0 || hi < prices.length - 1)) {
    const up = hi < prices.length - 1 ? levels.get(prices[hi + 1])! : -1;
    const dn = lo > 0 ? levels.get(prices[lo - 1])! : -1;
    if (up >= dn) {
      hi++;
      acc += up;
    } else {
      lo--;
      acc += dn;
    }
  }
  return { poc, vah: prices[hi], val: prices[lo], total };
}

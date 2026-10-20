import { bucket } from '../core/orderbook';
import { niceStep } from '../core/heatmap';
import type { BookUpdate, Kline, Liquidation, MarketStats, Trade } from '../core/types';
import { intervalMinutes, type HistTrade, type MarketHandlers, type VenueAdapter } from './adapter';

/**
 * Simulated venue. Produces a self-consistent synthetic market (random-walk
 * price, a resting book with walls, aggressive flow that consumes liquidity,
 * liquidations and funding) so the terminal can be explored offline and
 * exercised in automated tests. Everything it emits is labelled "SIM".
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Load multiplier for performance testing (?simLoad=8 ≈ several busy venues). */
let LOAD = 1;
export function setSimLoad(n: number) {
  LOAD = Math.max(1, Math.min(50, n || 1));
}

const START_PRICES: Record<string, number> = { BTC: 100_000, ETH: 3_500, SOL: 180, XRP: 2.4, DOGE: 0.25, BNB: 650 };

interface Listener {
  h: MarketHandlers;
}

class SimMarket {
  readonly rnd: () => number;
  price: number;
  readonly tick: number;
  bids = new Map<number, number>();
  asks = new Map<number, number>();
  listeners = new Set<Listener>();
  timer: ReturnType<typeof setInterval> | null = null;
  oi: number;
  funding = 0.0001;
  drift = 0;
  lastStats = 0;
  /** synthetic history generated once so klines and backfill agree */
  history: HistTrade[] = [];

  constructor(readonly base: string) {
    let seed = 0;
    for (const c of base) seed = seed * 31 + c.charCodeAt(0);
    this.rnd = mulberry32(seed || 1);
    this.price = START_PRICES[base] ?? 10;
    this.tick = niceStep(this.price * 0.00001);
    this.oi = (5e9 / this.price) * (0.8 + this.rnd() * 0.4);
    this.generateHistory(Date.now());
    this.seedBook();
  }

  private gauss() {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.rnd();
    while (v === 0) v = this.rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private tradeSize() {
    // log-normal sizes with a fat tail of whales
    const usd = Math.exp(7 + this.gauss() * 1.6) * (this.rnd() < 0.004 ? 40 : 1);
    return usd / this.price;
  }

  /** 3h of synthetic trades ending now; the live market continues from its last price. */
  private generateHistory(now: number) {
    const from = now - 3 * 3_600_000;
    let p = this.price * (0.99 + this.rnd() * 0.02);
    let t = from;
    const out: HistTrade[] = [];
    let trend = 0;
    while (t < now) {
      t += -Math.log(1 - this.rnd()) * 180; // ~5.5 trades/s
      if (this.rnd() < 0.0005) trend = (this.rnd() - 0.5) * 0.02;
      const buy = this.rnd() < 0.5 + trend;
      p = Math.max(this.tick, p * (1 + (buy ? 1 : -1) * Math.abs(this.gauss()) * 0.00005));
      out.push({ price: bucket(p, this.tick, 'round'), qty: this.tradeSize(), side: buy ? 'buy' : 'sell', time: Math.floor(t) });
    }
    this.history = out;
    if (out.length) this.price = out[out.length - 1].price;
  }

  private seedBook() {
    this.bids.clear();
    this.asks.clear();
    const mid = this.price;
    for (let i = 1; i <= 800; i++) {
      const bp = bucket(mid - i * this.tick, this.tick, 'round');
      const ap = bucket(mid + i * this.tick, this.tick, 'round');
      this.bids.set(bp, this.levelSize(bp, i));
      this.asks.set(ap, this.levelSize(ap, i));
    }
  }

  private levelSize(price: number, distTicks: number) {
    const baseUsd = 3_000 + distTicks * 120 + Math.exp(this.gauss()) * 4_000;
    // walls at round numbers
    const roundStep = niceStep(this.price * 0.0025);
    const wall = Math.abs(price / roundStep - Math.round(price / roundStep)) < 1e-6 ? 15 + this.rnd() * 30 : 1;
    return (baseUsd * wall) / this.price;
  }

  bestBid() {
    let b = -Infinity;
    for (const p of this.bids.keys()) if (p > b) b = p;
    return b;
  }
  bestAsk() {
    let a = Infinity;
    for (const p of this.asks.keys()) if (p < a) a = p;
    return a;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private emit(fn: (h: MarketHandlers) => void) {
    for (const l of this.listeners) fn(l.h);
  }

  private step() {
    const now = Date.now();
    if (this.rnd() < 0.01) this.drift = (this.rnd() - 0.5) * 0.4;
    const trades: Trade[] = [];
    const bookBids: [number, number][] = [];
    const bookAsks: [number, number][] = [];
    const burst = this.rnd() < 0.02 ? 6 : 1;
    const n = Math.floor(-Math.log(1 - this.rnd()) * 2.5 * burst * LOAD);
    for (let i = 0; i < n; i++) {
      const buy = this.rnd() < 0.5 + this.drift * 0.4;
      let remaining = this.tradeSize() * (burst > 1 ? 2 : 1);
      const book = buy ? this.asks : this.bids;
      // walk the book
      while (remaining > 0 && book.size) {
        const best = buy ? this.bestAsk() : this.bestBid();
        const avail = book.get(best)!;
        const fill = Math.min(avail, remaining);
        trades.push({ venue: 'sim', price: best, qty: fill, side: buy ? 'buy' : 'sell', time: now });
        remaining -= fill;
        if (fill >= avail - 1e-12) {
          book.delete(best);
          (buy ? bookAsks : bookBids).push([best, 0]);
        } else {
          book.set(best, avail - fill);
          (buy ? bookAsks : bookBids).push([best, avail - fill]);
        }
        this.price = best;
      }
    }
    // replenish and jitter resting liquidity
    const bb = this.bestBid();
    const ba = this.bestAsk();
    const mid = isFinite(bb) && isFinite(ba) ? (bb + ba) / 2 : this.price;
    for (let k = 0; k < 25 * LOAD; k++) {
      const dist = 1 + Math.floor(Math.abs(this.gauss()) * 40);
      const isBid = this.rnd() < 0.5;
      const p = bucket(isBid ? mid - dist * this.tick : mid + dist * this.tick, this.tick, isBid ? 'floor' : 'ceil');
      if (isBid ? p >= ba : p <= bb) continue;
      const q = this.rnd() < 0.15 ? 0 : this.levelSize(p, dist);
      const side = isBid ? this.bids : this.asks;
      if (q > 0) side.set(p, q);
      else side.delete(p);
      (isBid ? bookBids : bookAsks).push([p, q]);
    }
    // keep the book filled near the touch after sweeps
    for (let i = 1; i <= 3; i++) {
      const bp = bucket(mid - i * this.tick, this.tick, 'floor');
      const ap = bucket(mid + i * this.tick, this.tick, 'ceil');
      if (!this.bids.has(bp) && bp < ba) {
        const q = this.levelSize(bp, i);
        this.bids.set(bp, q);
        bookBids.push([bp, q]);
      }
      if (!this.asks.has(ap) && ap > bb) {
        const q = this.levelSize(ap, i);
        this.asks.set(ap, q);
        bookAsks.push([ap, q]);
      }
    }
    this.trimBook(mid, bookBids, bookAsks);
    if (trades.length) this.emit((h) => h.onTrades(trades));
    const u: BookUpdate = { snapshot: false, bids: bookBids, asks: bookAsks, time: now };
    this.emit((h) => {
      h.onFrame(now);
      h.onBook(u);
    });
    if (this.rnd() < 0.015) {
      const long = this.rnd() < 0.5 - this.drift * 0.5;
      const liq: Liquidation = {
        venue: 'sim',
        symbol: `${this.base}-SIM`,
        position: long ? 'long' : 'short',
        price: this.price,
        qty: (Math.exp(9 + this.gauss() * 1.5) / this.price) * (this.rnd() < 0.05 ? 20 : 1),
        time: now,
      };
      this.emit((h) => h.onLiquidation(liq));
    }
    if (now - this.lastStats > 1000) {
      this.lastStats = now;
      this.oi *= 1 + this.gauss() * 0.0004;
      this.funding += this.gauss() * 0.000002;
      const s: Partial<MarketStats> = {
        last: this.price,
        markPrice: this.price,
        indexPrice: this.price * (1 - this.funding),
        fundingRate: this.funding,
        fundingIntervalH: 8,
        nextFundingTime: Math.ceil(now / 28_800_000) * 28_800_000,
        openInterest: this.oi,
        openInterestUsd: this.oi * this.price,
        longShortRatio: 1 + this.drift,
        longAccount: (1 + this.drift) / (2 + this.drift),
        shortAccount: 1 / (2 + this.drift),
        volume24hUsd: 4.2e9,
        change24hPct: ((this.price - (this.history[0]?.price ?? this.price)) / this.price) * 100,
      };
      this.emit((h) => h.onStats(s));
    }
  }

  private trimBook(mid: number, b: [number, number][], a: [number, number][]) {
    const limit = 1000 * this.tick;
    for (const p of this.bids.keys()) if (mid - p > limit) {
      this.bids.delete(p);
      b.push([p, 0]);
    }
    for (const p of this.asks.keys()) if (p - mid > limit) {
      this.asks.delete(p);
      a.push([p, 0]);
    }
  }

  snapshot(): BookUpdate {
    return { snapshot: true, bids: [...this.bids.entries()], asks: [...this.asks.entries()], time: Date.now() };
  }
}

const markets = new Map<string, SimMarket>();
export function simMarket(symbol: string): SimMarket {
  const base = symbol.replace(/-SIM$/, '');
  let m = markets.get(base);
  if (!m) {
    m = new SimMarket(base);
    markets.set(base, m);
  }
  return m;
}

export const simulator: VenueAdapter = {
  id: 'sim',
  name: 'Simulator (synthetic data)',
  short: 'SIM',
  kind: 'perp',
  color: '#9575cd',
  hasLiquidations: true,
  symbolFor: (base) => `${base.toUpperCase()}-SIM`,

  connect(symbol, h) {
    const m = simMarket(symbol);
    const l: Listener = { h };
    h.onStatus('connecting');
    const t = setTimeout(() => {
      m.listeners.add(l);
      h.onStatus('open');
      h.onBook(m.snapshot());
      m.start();
    }, 50);
    return {
      close() {
        clearTimeout(t);
        m.listeners.delete(l);
        if (!m.listeners.size) m.stop();
        h.onStatus('closed');
      },
    };
  },

  async fetchKlines(symbol, interval, limit): Promise<Kline[]> {
    const m = simMarket(symbol);
    const iv = intervalMinutes(interval) * 60_000;
    const now = Date.now();
    const bars: Kline[] = [];
    // synthetic long history before the trade history, then exact bars from it
    const histStart = m.history[0]?.time ?? now;
    const first = Math.floor((now - iv * limit) / iv) * iv;
    const rnd = mulberry32(Math.floor(first / iv) ^ symbol.length);
    let p = m.history[0]?.price ?? m.price;
    const pre: Kline[] = [];
    for (let t = Math.floor(histStart / iv) * iv - iv; t >= first; t -= iv) {
      const close = p;
      const open = close * (1 + (rnd() - 0.5) * 0.004 * Math.sqrt(iv / 60_000));
      const high = Math.max(open, close) * (1 + rnd() * 0.0015 * Math.sqrt(iv / 60_000));
      const low = Math.min(open, close) * (1 - rnd() * 0.0015 * Math.sqrt(iv / 60_000));
      pre.push({ time: t, open, high, low, close, volume: (2e6 + rnd() * 6e6) * (iv / 60_000) / close });
      p = open;
    }
    bars.push(...pre.reverse());
    for (const tr of m.history) {
      const t = Math.floor(tr.time / iv) * iv;
      const last = bars[bars.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, tr.price);
        last.low = Math.min(last.low, tr.price);
        last.close = tr.price;
        last.volume += tr.qty;
        last.buyVolume = (last.buyVolume ?? 0) + (tr.side === 'buy' ? tr.qty : 0);
      } else if (!last || t > last.time) {
        bars.push({ time: t, open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: tr.qty, buyVolume: tr.side === 'buy' ? tr.qty : 0 });
      }
    }
    return bars.slice(-limit);
  },

  async pollStats() {
    return {};
  },

  async fetchOiHistory(symbol) {
    const m = simMarket(symbol);
    const now = Date.now();
    const out = [];
    let oi = m.oi;
    for (let i = 0; i < 288; i++) {
      out.push({ time: Math.floor(now / 300_000) * 300_000 - i * 300_000, oi, oiUsd: oi * m.price });
      oi *= 1 + (m.rnd() - 0.5) * 0.004;
    }
    return out.reverse();
  },

  async fetchTicker(symbol) {
    const m = simMarket(symbol);
    return { venue: 'sim', symbol, base: m.base, last: m.price, change24hPct: 0, volume24hUsd: 4.2e9 };
  },

  async fetchTickers() {
    return Object.keys(START_PRICES).map((b) => {
      const m = simMarket(b);
      return { venue: 'sim' as const, symbol: `${b}-SIM`, base: b, last: m.price, change24hPct: ((m.price - m.history[0].price) / m.history[0].price) * 100, volume24hUsd: 1e9 * (1 + b.length), fundingRate: m.funding, openInterestUsd: m.oi * m.price };
    });
  },

  async backfillTrades(symbol, fromMs, toMs) {
    return simMarket(symbol).history.filter((t) => t.time >= fromMs && t.time <= toMs);
  },
};

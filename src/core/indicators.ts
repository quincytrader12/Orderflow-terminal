import { bucket } from './orderbook';
import type { Kline } from './types';
import type { TradeStore } from './tradeStore';

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = isNaN(prev) ? v : v * k + prev * (1 - k);
    out[i] = i >= period - 1 ? prev : NaN;
  }
  return out;
}

const DAY = 86_400_000;

/**
 * Session VWAP (resets at UTC midnight, or every `anchorMs`) with standard
 * deviation bands. Uses typical price per bar.
 */
export function vwap(bars: Kline[], anchorMs = DAY) {
  const mid: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];
  let session = -1;
  let pv = 0;
  let vol = 0;
  let pv2 = 0;
  for (const b of bars) {
    const s = Math.floor(b.time / anchorMs);
    if (s !== session) {
      session = s;
      pv = 0;
      vol = 0;
      pv2 = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    pv2 += tp * tp * b.volume;
    vol += b.volume;
    const v = vol > 0 ? pv / vol : tp;
    const sd = vol > 0 ? Math.sqrt(Math.max(0, pv2 / vol - v * v)) : 0;
    mid.push(v);
    upper.push(v + sd);
    lower.push(v - sd);
  }
  return { mid, upper, lower };
}

/** ATR (Wilder) – used for auto tick sizing and range bars. */
export function atr(bars: Kline[], period = 14): number {
  if (bars.length < 2) return NaN;
  let a = NaN;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const pc = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    a = isNaN(a) ? tr : (a * (period - 1) + tr) / period;
  }
  return a;
}

export interface TpoSession {
  start: number;
  end: number;
  tick: number;
  /** price -> list of period letters indices */
  rows: Map<number, number[]>;
  periods: number;
  poc: number;
  vah: number;
  val: number;
  ibHigh: number;
  ibLow: number;
  open: number;
  close: number;
  high: number;
  low: number;
  /** single prints (price levels touched by a single period) */
  singles: Set<number>;
}

export const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnopqrstuvwx';

/**
 * Build TPO (market profile) sessions from bars of `periodMs` (typically 30m).
 * Each bar marks every tick between its low and high with the period index.
 */
export function buildTpo(bars: Kline[], tick: number, sessionMs = DAY, ibPeriods = 2, vaPct = 0.7): TpoSession[] {
  const sessions: TpoSession[] = [];
  let cur: TpoSession | null = null;
  for (const b of bars) {
    const sStart = Math.floor(b.time / sessionMs) * sessionMs;
    if (!cur || cur.start !== sStart) {
      cur = {
        start: sStart,
        end: sStart + sessionMs,
        tick,
        rows: new Map(),
        periods: 0,
        poc: b.close,
        vah: b.high,
        val: b.low,
        ibHigh: b.high,
        ibLow: b.low,
        open: b.open,
        close: b.close,
        high: b.high,
        low: b.low,
        singles: new Set(),
      };
      sessions.push(cur);
    }
    const period = cur.periods++;
    const lo = bucket(b.low, tick, 'floor');
    const hi = bucket(b.high, tick, 'floor');
    for (let p = lo; p <= hi + tick * 1e-6; p = bucket(p + tick, tick, 'round')) {
      let r = cur.rows.get(p);
      if (!r) {
        r = [];
        cur.rows.set(p, r);
      }
      r.push(period);
    }
    if (period < ibPeriods) {
      cur.ibHigh = period === 0 ? b.high : Math.max(cur.ibHigh, b.high);
      cur.ibLow = period === 0 ? b.low : Math.min(cur.ibLow, b.low);
    }
    cur.high = Math.max(cur.high, b.high);
    cur.low = Math.min(cur.low, b.low);
    cur.close = b.close;
  }
  for (const s of sessions) {
    const counts = new Map<number, number>();
    for (const [p, r] of s.rows) {
      counts.set(p, r.length);
      if (r.length === 1) s.singles.add(p);
    }
    const prices = [...counts.keys()].sort((a, b) => a - b);
    if (!prices.length) continue;
    // POC: most TPOs; ties resolved towards the session's centre
    const centre = (s.high + s.low) / 2;
    let poc = prices[0];
    for (const p of prices) {
      const c = counts.get(p)!;
      const best = counts.get(poc)!;
      if (c > best || (c === best && Math.abs(p - centre) < Math.abs(poc - centre))) poc = p;
    }
    let total = 0;
    for (const c of counts.values()) total += c;
    let lo = prices.indexOf(poc);
    let hi = lo;
    let acc = counts.get(poc)!;
    while (acc < total * vaPct && (lo > 0 || hi < prices.length - 1)) {
      const up = hi < prices.length - 1 ? counts.get(prices[hi + 1])! : -1;
      const dn = lo > 0 ? counts.get(prices[lo - 1])! : -1;
      if (up >= dn) acc += counts.get(prices[++hi])!;
      else acc += counts.get(prices[--lo])!;
    }
    s.poc = poc;
    s.vah = prices[hi];
    s.val = prices[lo];
  }
  return sessions;
}

export interface CvdPoint {
  time: number;
  cvd: number;
  price: number;
}

/** Bucketed CVD series from a TradeStore over the last `rangeMs`. */
export function cvdSeries(store: TradeStore, rangeMs: number, intervalMs: number, now = store.lastTime()): CvdPoint[] {
  if (!store.length) return [];
  const from = now - rangeMs;
  const a = store.indexAtTime(from);
  const out: CvdPoint[] = [];
  let cvd = 0;
  let bucketT = -1;
  store.forEach(a, store.end, (price, qty, buy, time) => {
    const bt = Math.floor(time / intervalMs) * intervalMs;
    cvd += buy ? qty : -qty;
    if (bt !== bucketT) {
      out.push({ time: bt, cvd, price });
      bucketT = bt;
    } else {
      const last = out[out.length - 1];
      last.cvd = cvd;
      last.price = price;
    }
  });
  return out;
}

export interface FlowWindow {
  buyNotional: number;
  sellNotional: number;
  buyQty: number;
  sellQty: number;
  trades: number;
}

/** Aggregate buy/sell flow over [now - windowMs, now]. */
export function flowWindow(store: TradeStore, windowMs: number, now: number): FlowWindow {
  const w: FlowWindow = { buyNotional: 0, sellNotional: 0, buyQty: 0, sellQty: 0, trades: 0 };
  const a = store.indexAtTime(now - windowMs);
  store.forEach(a, store.end, (price, qty, buy) => {
    w.trades++;
    if (buy) {
      w.buyQty += qty;
      w.buyNotional += qty * price;
    } else {
      w.sellQty += qty;
      w.sellNotional += qty * price;
    }
  });
  return w;
}

/** Aggregate klines into a coarser interval. */
export function resampleKlines(bars: Kline[], intervalMs: number): Kline[] {
  const out: Kline[] = [];
  for (const b of bars) {
    const t = Math.floor(b.time / intervalMs) * intervalMs;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      if (b.buyVolume !== undefined) last.buyVolume = (last.buyVolume ?? 0) + b.buyVolume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

/** Previous/current period reference levels for "period levels" overlays. */
export function periodLevels(daily: Kline[], now: number) {
  const dayStart = Math.floor(now / DAY) * DAY;
  const weekStart = startOfWeek(now);
  const prev = [...daily].reverse().find((k) => k.time < dayStart);
  const today = daily.find((k) => k.time === dayStart);
  const prevWeekBars = daily.filter((k) => k.time >= weekStart - 7 * DAY && k.time < weekStart);
  const levels: { label: string; price: number }[] = [];
  if (prev) {
    levels.push({ label: 'PDH', price: prev.high }, { label: 'PDL', price: prev.low }, { label: 'PDC', price: prev.close });
  }
  if (today) levels.push({ label: 'DO', price: today.open });
  if (prevWeekBars.length) {
    levels.push(
      { label: 'PWH', price: Math.max(...prevWeekBars.map((k) => k.high)) },
      { label: 'PWL', price: Math.min(...prevWeekBars.map((k) => k.low)) },
    );
  }
  const wk = daily.find((k) => k.time === weekStart);
  if (wk) levels.push({ label: 'WO', price: wk.open });
  return levels;
}

/** Monday 00:00 UTC of the week containing `t`. */
export function startOfWeek(t: number): number {
  const d = Math.floor(t / DAY) * DAY;
  const dow = (new Date(d).getUTCDay() + 6) % 7; // Monday = 0
  return d - dow * DAY;
}

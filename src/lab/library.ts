// The Strategy Lab's library: trading rules from the research in papers.ts,
// broken into parts the Lab can mix and match.
//
//   signals  say long (+1), short (−1) or nothing (0) at each bar's close.
//            A trade opens when a signal switches on; the next bar's open is
//            the entry, so no rule ever sees the bar it trades on.
//   filters  allow longs or shorts at a bar (trend, volatility regime, trend
//            strength, volume, session, funding crowding).
//   exits    an ATR stop, an optional target in R, a trailing stop, a time
//            limit, and whether an opposite signal closes the trade.
//
// Lookbacks are written in hours and converted to bars of the timeframe, so
// one rule runs on 1-hour, 4-hour or daily candles.
import { fitBest, garchVar, type GarchFit } from './garch';
import { fitForest, fitMLP, fitRidge, predictForest, predictMLP, predictRidge, type ForestModel, type MLP, type Ridge } from './ml';
import { fitHmm2, hmmFilter, hurstRS, kalmanTrend, ouRolling, varianceRatio, volEstimate, type Hmm2 } from './quant';
import { CANDLE_FEATURES, candleShape } from './shape';
import { ncdf } from './stats';
import { adx, atr, ema, hiPrev, loPrev, logRets, pctRank, retN, rsi, rstd, rvol, sma, volZ, type Bar } from './series';

export interface Market {
  coin: string;
  /** hours per bar: 1, 4 or 24 */
  tfH: number;
  bars: Bar[];
  /** funding paid by longs per bar (a fraction of notional), aligned with bars; null when unknown */
  funding?: Float64Array | null;
  /** the benchmark's close (bitcoin) at each bar, for a delta hedge; null for bitcoin itself or when unknown */
  bench?: Float64Array | null;
}
export type Params = Record<string, number>;
/** relative: the coin measured against bitcoin (pairs, lead and lag) */
export type Family = 'momentum' | 'trend' | 'breakout' | 'reversion' | 'carry' | 'seasonal' | 'volume' | 'ml' | 'relative';

export interface ExitSpec {
  /** stop distance in ATR(14) */
  stopAtr: number;
  /** target in R (multiples of the stop distance); 0 = no target */
  targetR: number;
  /** trailing stop in ATR once the trade is 1R up; 0 = none */
  trailAtr: number;
  /** close after this many bars */
  maxBars: number;
  /** an opposite signal closes the trade */
  onFlip: boolean;
  /** stop distance in GARCH volatility units instead of ATR (σ of the next bar's return); 0 = use the ATR stop */
  stopVol?: number;
}
export const EXIT_DEFAULT: ExitSpec = { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 240, onFlip: true, stopVol: 0 };

export interface Ctx {
  m: Market;
  cache: Map<string, unknown>;
  /** bars before this index are the training set (learned rules fit only on them) */
  trainEnd: number;
  seed: number;
}
export const ctxOf = (m: Market, trainEnd = m.bars.length, seed = 7): Ctx => ({ m, cache: new Map(), trainEnd, seed });

/** a lookback in hours as bars of the market's timeframe */
export const H = (c: Ctx, hours: number) => Math.max(2, Math.round(hours / c.m.tfH));
export const barsPerYear = (tfH: number) => (24 * 365) / tfH;

/**
 * The worked-out series each rule reuses (averages, ranges, gaps...) are kept on its
 * context. The edge finder breeds bots with ever new settings, so without a limit they pile
 * up for hours — gigabytes on 15-minute candles — until the computer runs short of memory and
 * the thread stalls. With a budget set (the edge finder's thread sets one), the least
 * recently used are let go first and simply worked out again if asked for. With none (every
 * other use), nothing changes.
 */
let cacheCap = 0;
let cacheBytes = 0;
const cacheOrder = new Map<string, { c: Ctx; key: string; bytes: number }>();
const ctxIds = new WeakMap<Ctx, number>();
let nextCtx = 1;
const idOf = (c: Ctx) => {
  let id = ctxIds.get(c);
  if (!id) ctxIds.set(c, (id = nextCtx++));
  return id;
};
const sizeOf = (v: unknown): number => {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) return v.length * 8 + (v.length && typeof v[0] === 'object' && v[0] ? v.length * 32 : 0);
  if (v && typeof v === 'object') {
    let n = 64;
    for (const x of Object.values(v)) if (ArrayBuffer.isView(x) || Array.isArray(x)) n += sizeOf(x);
    return n;
  }
  return 16;
};
/** limit the kept series to about `bytes` (0: no limit) */
export function setCacheCap(bytes: number) {
  cacheCap = bytes;
  if (!bytes) {
    cacheOrder.clear();
    cacheBytes = 0;
  }
}
/** a context that is no longer used: its kept series are let go at once */
export function releaseCtx(c: Ctx) {
  if (!cacheCap) return;
  const id = idOf(c);
  for (const key of c.cache.keys()) {
    const k = `${id}|${key}`;
    const e = cacheOrder.get(k);
    if (e) {
      cacheBytes -= e.bytes;
      cacheOrder.delete(k);
    }
  }
  c.cache.clear();
}
export const cacheUse = () => ({ bytes: cacheBytes, entries: cacheOrder.size });

function cached<T>(c: Ctx, key: string, f: () => T): T {
  if (c.cache.has(key)) {
    if (cacheCap) {
      const k = `${idOf(c)}|${key}`;
      const e = cacheOrder.get(k);
      if (e) {
        cacheOrder.delete(k);
        cacheOrder.set(k, e);
      }
    }
    return c.cache.get(key) as T;
  }
  const v = f();
  c.cache.set(key, v);
  if (cacheCap) {
    const bytes = sizeOf(v);
    cacheOrder.set(`${idOf(c)}|${key}`, { c, key, bytes });
    cacheBytes += bytes;
    // over budget: the least recently used go (never the one just made)
    for (const [k, e] of cacheOrder) {
      if (cacheBytes <= cacheCap || cacheOrder.size <= 1) break;
      if (e.c === c && e.key === key) continue;
      e.c.cache.delete(e.key);
      cacheBytes -= e.bytes;
      cacheOrder.delete(k);
    }
  }
  return v;
}
const close = (c: Ctx) => cached(c, 'close', () => Float64Array.from(c.m.bars, (b) => b.close));
const smaH = (c: Ctx, h: number) => cached(c, `sma${H(c, h)}`, () => sma(close(c), H(c, h)));
const sdH = (c: Ctx, h: number) => cached(c, `sd${H(c, h)}`, () => rstd(close(c), H(c, h)));
export const atr14 = (c: Ctx) => cached(c, 'atr14', () => atr(c.m.bars, 14));
const fundAnn = (c: Ctx, h: number) =>
  cached(c, `fund${H(c, h)}`, () => {
    const f = c.m.funding;
    if (!f) return null;
    const m = sma(f, H(c, h));
    const k = barsPerYear(c.m.tfH);
    return m.map((x) => x * k);
  });

// ---------- GARCH volatility, fitted on the training bars only ----------

/** the coin's GARCH model (the best of GARCH/GJR × normal/t by BIC), fitted on the bars before trainEnd */
export function garchOf(c: Ctx): GarchFit | null {
  return cached(c, 'garch', () => {
    const lr = logRets(close(c));
    const end = Math.min(c.trainEnd, lr.length);
    return end - 1 >= 300 ? trainedOnce(c, 'garch', () => fitBest(lr.slice(Math.max(1, end - 6000), end))) : null;
  });
}

/**
 * GARCH volatility (σ of the log return) of the bar AFTER each bar — known at
 * that bar's close, so value i never uses bar i + 1. Exponentially weighted
 * (RiskMetrics) when the history is too short to fit GARCH.
 */
export function garchSigma(c: Ctx): Float64Array {
  return cached(c, 'gsig', () => {
    const lr = logRets(close(c));
    const n = lr.length;
    const fit = garchOf(c);
    const out = new Float64Array(n);
    if (fit) {
      // shifted: element k is the return of bar k + 1, so h[k] is known at bar k's close
      const shifted = Float64Array.from({ length: n }, (_, k) => (k + 1 < n ? lr[k + 1] : 0));
      const h = garchVar(fit, shifted);
      for (let k = 0; k < n; k++) out[k] = Math.sqrt(h[k]);
      return out;
    }
    let v = NaN;
    for (let k = 0; k < n; k++) {
      v = Number.isFinite(v) ? 0.94 * v + 0.06 * lr[k] * lr[k] : lr[k] * lr[k] || 1e-6;
      out[k] = Math.sqrt(v);
    }
    return out;
  });
}

// ---------- quantitative models (quant.ts), cached per market ----------

const lrets = (c: Ctx) => cached(c, 'lr', () => logRets(close(c)));
const logp = (c: Ctx) => cached(c, 'logp', () => Float64Array.from(close(c), Math.log));

/** variance of the 1-bar log return over the training bars (the Kalman filter's observation noise) */
function trainVar(c: Ctx): number {
  return cached(c, 'trainVar', () => {
    const lr = lrets(c);
    const end = Math.min(c.trainEnd, lr.length);
    let s = 0;
    let q = 0;
    let k = 0;
    for (let i = Math.max(1, end - 6000); i < end; i++)
      if (Number.isFinite(lr[i])) {
        s += lr[i];
        q += lr[i] * lr[i];
        k++;
      }
    return k > 10 ? q / k - (s / k) ** 2 : 1e-4;
  });
}

/** the Kalman local-linear trend of log price; smooth 0 (smoothest) … 2 */
export const kalmanOf = (c: Ctx, smooth: number) =>
  cached(c, `kalman${smooth}`, () => kalmanTrend(logp(c), [1e-7, 1e-6, 1e-5][smooth] * c.m.tfH ** 2, trainVar(c)));
/** Ornstein–Uhlenbeck fit of log price over a rolling window (hours) */
export const ouOf = (c: Ctx, windowH: number) => cached(c, `ou${H(c, windowH)}`, () => ouRolling(logp(c), H(c, windowH)));
/** variance ratio of 1-day returns against 1-bar returns, over a rolling window (hours) */
export const vrOf = (c: Ctx, windowH: number) => cached(c, `vr${H(c, windowH)}`, () => varianceRatio(lrets(c), Math.max(2, H(c, 24)), H(c, windowH)).vr);
/** the rolling Hurst exponent (rescaled range) of 1-bar returns over ~500 bars, refreshed every day of bars, known at each bar's close */
export const hurstOf = (c: Ctx) =>
  cached(c, 'hurst', () => {
    const lr = lrets(c);
    const n = lr.length;
    const w = Math.min(500, Math.max(200, H(c, 720)));
    const every = Math.max(1, H(c, 24));
    const out = new Float64Array(n).fill(NaN);
    let last = NaN;
    for (let i = 0; i < n; i++) {
      if (i >= w && (i - w) % every === 0) {
        const seg: number[] = [];
        for (let k = i - w + 1; k <= i; k++) if (Number.isFinite(lr[k])) seg.push(lr[k]);
        last = seg.length > 100 ? hurstRS(seg) : NaN;
      }
      out[i] = last;
    }
    return out;
  });
/** the two-state regime model (Hamilton), fitted on the training bars */
export function hmmOf(c: Ctx): Hmm2 | null {
  return cached(c, 'hmm', () => {
    const lr = lrets(c);
    const end = Math.min(c.trainEnd, lr.length);
    return end > 400 ? trainedOnce(c, 'hmm', () => fitHmm2(lr.slice(Math.max(1, end - 6000), end))) : null;
  });
}
/** P(turbulent regime) at each bar, filtered forward (uses returns up to that bar only) */
export const hmmProb = (c: Ctx) =>
  cached(c, 'hmmP', () => {
    const m = hmmOf(c);
    return m ? hmmFilter(m, Float64Array.from(lrets(c), (x) => (Number.isFinite(x) ? x : 0))) : new Float64Array(c.m.bars.length).fill(NaN);
  });
/** rolling beta of the coin to the benchmark (bitcoin) over 30 days, from returns up to each bar */
export function benchBeta(c: Ctx): Float64Array | null {
  return cached(c, 'beta', () => {
    const bm = c.m.bench;
    if (!bm) return null;
    const n = c.m.bars.length;
    const w = H(c, 720);
    const y = lrets(c);
    const out = new Float64Array(n).fill(NaN);
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let k = 0;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const x = Math.log(bm[i] / bm[i - 1]);
      const ok = Number.isFinite(x) && Number.isFinite(y[i]);
      xs[i] = ok ? x : 0;
      ys[i] = ok ? y[i] : 0;
      sx += xs[i];
      sy += ys[i];
      sxx += xs[i] * xs[i];
      sxy += xs[i] * ys[i];
      k++;
      if (k > w) {
        const j = i - w;
        sx -= xs[j];
        sy -= ys[j];
        sxx -= xs[j] * xs[j];
        sxy -= xs[j] * ys[j];
        k = w;
      }
      const d = k * sxx - sx * sx;
      if (k >= w && d > 0) out[i] = (k * sxy - sx * sy) / d;
    }
    return out;
  });
}

/** the benchmark's (bitcoin's) close with gaps filled forward; null when there is none */
const benchFilled = (c: Ctx) =>
  cached(c, 'benchF', () => {
    const b = c.m.bench;
    if (!b) return null;
    const out = new Float64Array(b.length).fill(NaN);
    let last = NaN;
    for (let i = 0; i < b.length; i++) {
      if (Number.isFinite(b[i]) && b[i] > 0) last = b[i];
      out[i] = last;
    }
    return out;
  });

/** the highest (sign 1) or lowest (sign −1) of the n values BEFORE each one */
function extremePrev(x: ArrayLike<number>, n: number, sign: 1 | -1): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && dq[0] < i - n) dq.shift();
    if (i >= n && dq.length) out[i] = x[dq[0]];
    while (dq.length && (x[dq[dq.length - 1]] - x[i]) * sign <= 0) dq.pop();
    dq.push(i);
  }
  return out;
}

/**
 * The coin against bitcoin over a rolling window: regress log price on
 * bitcoin's log price and read where today's price sits against the line, in
 * standard deviations of the fit (z), with the fit's R². Each value uses the
 * window ending at that bar only.
 */
export function pairZ(c: Ctx, windowH: number): { z: Float64Array; r2: Float64Array; beta: Float64Array } | null {
  return cached(c, `pairZ${H(c, windowH)}`, () => {
    const bm = benchFilled(c);
    if (!bm) return null;
    const cl = close(c);
    const n = cl.length;
    const w = Math.max(20, H(c, windowH));
    const z = new Float64Array(n).fill(NaN);
    const r2 = new Float64Array(n).fill(NaN);
    const beta = new Float64Array(n).fill(NaN);
    // centred on the first usable pair, so the rolling sums stay well conditioned
    let x0 = NaN;
    let y0 = NaN;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const ok = new Uint8Array(n);
    let k = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(bm[i]) && bm[i] > 0 && cl[i] > 0) {
        if (!Number.isFinite(x0)) {
          x0 = Math.log(bm[i]);
          y0 = Math.log(cl[i]);
        }
        xs[i] = Math.log(bm[i]) - x0;
        ys[i] = Math.log(cl[i]) - y0;
        ok[i] = 1;
        k++;
        sx += xs[i];
        sy += ys[i];
        sxx += xs[i] * xs[i];
        sxy += xs[i] * ys[i];
        syy += ys[i] * ys[i];
      }
      const j = i - w;
      if (j >= 0 && ok[j]) {
        k--;
        sx -= xs[j];
        sy -= ys[j];
        sxx -= xs[j] * xs[j];
        sxy -= xs[j] * ys[j];
        syy -= ys[j] * ys[j];
      }
      if (k < w || !ok[i]) continue;
      const mx = sx / k;
      const my = sy / k;
      const vxx = sxx / k - mx * mx;
      const vxy = sxy / k - mx * my;
      const vyy = syy / k - my * my;
      if (!(vxx > 1e-12) || !(vyy > 1e-12)) continue;
      const b = vxy / vxx;
      const sse = Math.max(0, vyy - b * vxy) * k;
      const sd = Math.sqrt(sse / (k - 2));
      beta[i] = b;
      r2[i] = Math.min(1, (vxy * vxy) / (vxx * vyy));
      if (sd > 1e-9) z[i] = (ys[i] - my - b * (xs[i] - mx)) / sd;
    }
    return { z, r2, beta };
  });
}

/**
 * The trend composite's score in −1 … +1: one vote each from price and volume
 * indicators over several horizons (`unit` hours stand for one "day" of the
 * published daily indicators).
 */
export function trendScore(c: Ctx, unit: number): Float64Array {
  return cached(c, `ctrend${unit}:${c.m.tfH}`, () => {
    const b = c.m.bars;
    const n = b.length;
    const cl = close(c);
    const U = (d: number) => Math.max(2, Math.round((d * unit) / c.m.tfH));
    const votes: (Float64Array | Int8Array)[] = [];
    const push = (f: (i: number) => number) => {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) v[i] = f(i);
      votes.push(v);
    };
    // oscillators: RSI, stochastic %K, commodity channel index
    const rs = rsi(cl, U(14));
    push((i) => (Number.isFinite(rs[i]) ? sgn(rs[i] - 50) : NaN));
    const hh = extremePrev(Float64Array.from(b, (x) => x.high), U(14), 1);
    const ll = extremePrev(Float64Array.from(b, (x) => x.low), U(14), -1);
    push((i) => {
      const hi = Math.max(hh[i], b[i].high);
      const lo = Math.min(ll[i], b[i].low);
      return Number.isFinite(hi) && Number.isFinite(lo) && hi > lo ? sgn((cl[i] - lo) / (hi - lo) - 0.5) : NaN;
    });
    const tp = Float64Array.from(b, (x) => (x.high + x.low + x.close) / 3);
    const tpm = sma(tp, U(20));
    push((i) => (Number.isFinite(tpm[i]) ? sgn(tp[i] - tpm[i]) : NaN));
    // price against its averages over seven horizons
    for (const d of [3, 5, 10, 20, 50, 100, 200]) {
      const m = sma(cl, U(d));
      push((i) => (Number.isFinite(m[i]) ? sgn(cl[i] - m[i]) : NaN));
    }
    // MACD and its signal line
    const ef = ema(cl, U(12));
    const es = ema(cl, U(26));
    const macd = Float64Array.from(ef, (x, i) => x - es[i]);
    const sig = ema(Float64Array.from(macd, (x) => (Number.isFinite(x) ? x : 0)), U(9));
    push((i) => (Number.isFinite(macd[i]) ? sgn(macd[i]) : NaN));
    push((i) => (Number.isFinite(macd[i]) && Number.isFinite(sig[i]) ? sgn(macd[i] - sig[i]) : NaN));
    // volume: rising volume confirms the direction price took over the same stretch
    const vol = Float64Array.from(b, (x) => x.volume);
    for (const [a, l] of [[3, 20], [5, 50], [10, 100]] as const) {
      const va = sma(vol, U(a));
      const vl = sma(vol, U(l));
      const r = retN(cl, U(a));
      push((i) => (Number.isFinite(va[i]) && Number.isFinite(vl[i]) && Number.isFinite(r[i]) ? (va[i] > vl[i] ? sgn(r[i]) : 0) : NaN));
    }
    // Chaikin money flow: where closes sit in their ranges, weighted by volume
    const mfv = Float64Array.from(b, (x) => (x.high > x.low ? ((x.close - x.low - (x.high - x.close)) / (x.high - x.low)) * x.volume : 0));
    const mfS = sma(mfv, U(20));
    push((i) => (Number.isFinite(mfS[i]) ? sgn(mfS[i]) : NaN));
    // Bollinger bands: a close outside them
    const bm = sma(cl, U(20));
    const bs = rstd(cl, U(20));
    push((i) => (Number.isFinite(bm[i]) && Number.isFinite(bs[i]) ? (cl[i] > bm[i] + 2 * bs[i] ? 1 : cl[i] < bm[i] - 2 * bs[i] ? -1 : 0) : NaN));
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let k = 0;
      for (const v of votes)
        if (Number.isFinite(v[i])) {
          s += v[i];
          k++;
        }
      // every indicator must have its history: a score from the short ones alone is a different measure
      if (k === votes.length) out[i] = s / k;
    }
    return out;
  });
}
export const TREND_VOTES = 17;

/** the UTC hour a bar closes at, as a number (20.25 = 20:15); 0 at midnight */
const closeHour = (c: Ctx, time: number) => ((time + c.m.tfH * 3_600_000) % 86_400_000) / 3_600_000;
/** the hour a rule asks for, moved back to the last candle close at or before it (21:00 on 4-hour candles is 20:00) */
const onGrid = (c: Ctx, hour: number) => (Math.floor(hour / c.m.tfH + 1e-9) * c.m.tfH) % 24;

/**
 * The trading "day" a bar belongs to when days start at `anchor` (a UTC hour:
 * 0 for the daily candle's open, 13 for the US session), and how many bars
 * into that day it is.
 */
function sessionOf(c: Ctx, anchor: number): { day: Int32Array; k: Int32Array } {
  return cached(c, `sess${anchor}`, () => {
    const b = c.m.bars;
    const day = new Int32Array(b.length);
    const k = new Int32Array(b.length);
    let last = -1;
    let n = 0;
    for (let i = 0; i < b.length; i++) {
      const d = Math.floor((b[i].time - anchor * 3_600_000) / 86_400_000);
      n = d === last ? n + 1 : 0;
      last = d;
      day[i] = d;
      k[i] = n;
    }
    return { day, k };
  });
}

/** the volume-weighted average price since the day's start (`anchor`), known at each bar's close */
export function sessionVwap(c: Ctx, anchor: number): Float64Array {
  return cached(c, `vwap${anchor}`, () => {
    const b = c.m.bars;
    const { k } = sessionOf(c, anchor);
    const out = new Float64Array(b.length).fill(NaN);
    let pv = 0;
    let v = 0;
    for (let i = 0; i < b.length; i++) {
      if (k[i] === 0) {
        pv = 0;
        v = 0;
      }
      const w = b[i].volume > 0 ? b[i].volume : 0;
      pv += ((b[i].high + b[i].low + b[i].close) / 3) * w;
      v += w;
      if (v > 0) out[i] = pv / v;
    }
    return out;
  });
}

const state = (n: number) => new Int8Array(n);
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export interface SignalDef {
  id: string;
  name: string;
  family: Family;
  papers: string[];
  /** why it should work: the economic story */
  rationale: string;
  grid: Record<string, number[]>;
  needsFunding?: boolean;
  /** reads bitcoin's price beside the coin's: BTC must be among the coins tested (and it never trades BTC itself) */
  needsBench?: boolean;
  /** only meaningful on bars shorter than a day */
  intraday?: boolean;
  /** only meaningful on candles this short or shorter, in hours (a quarter-hour's first minute needs 1- or 5-minute candles) */
  maxTfH?: number;
  /** exits that suit the rule (the search varies them) */
  exit: Partial<ExitSpec>;
  compute: (c: Ctx, p: Params) => Int8Array;
  describe: (p: Params) => string;
}

export interface FilterDef {
  id: string;
  name: string;
  papers: string[];
  rationale: string;
  grid: Record<string, number[]>;
  needsFunding?: boolean;
  /** it reads bitcoin's price when the market has it (and the coin's own otherwise) */
  usesBench?: boolean;
  compute: (c: Ctx, p: Params) => { long: Uint8Array; short: Uint8Array };
  describe: (p: Params) => string;
}

const hrs = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24}-day` : `${h}-hour`);

// ---------- features for the learned rules and the meta-labeller ----------

export const FEATURES = ['ret 1h', 'ret 4h', 'ret 1d', 'ret 1w', 'price / 1w MA', 'RSI 14', 'ADX 14', 'vol 1d / vol 30d', 'volume z', 'hour (sin)', 'hour (cos)', 'weekday', 'funding (a year)', 'GARCH σ next bar', 'GARCH σ / long run', ...CANDLE_FEATURES, 'Kalman slope t', 'OU s-score (1w)', 'variance ratio (2w)', 'P(turbulent regime)', 'Yang–Zhang / GARCH σ'];

export function features(c: Ctx): Float64Array[] {
  return cached(c, 'features', () => {
    const cl = close(c);
    const r1 = retN(cl, H(c, 1));
    const r4 = retN(cl, H(c, 4));
    const r24 = retN(cl, H(c, 24));
    const r168 = retN(cl, H(c, 168));
    const ma = smaH(c, 168);
    const rs = rsi(cl, 14);
    const ad = adx(c.m.bars, 14);
    const v1 = rvol(cl, H(c, 24));
    const v30 = rvol(cl, H(c, 720));
    // until 30 days of bars exist (a short download), compare with the last week instead
    const v7 = rvol(cl, H(c, 168));
    const vz = volZ(c.m.bars, H(c, 168));
    const fa = fundAnn(c, 24);
    const gs = garchSigma(c);
    const g = garchOf(c);
    const lrun = g ? Math.sqrt(g.longRun) : NaN;
    const shape = candleShape(c.m.bars, atr14(c));
    const kf = kalmanOf(c, 1);
    const ou = ouOf(c, 168).s;
    const vr = vrOf(c, 336);
    const hp = hmmProb(c);
    const yz = cached(c, 'yz', () => volEstimate(c.m.bars, H(c, 24), 'yangZhang'));
    return c.m.bars.map((b, i) => {
      const d = new Date(b.time);
      const h = d.getUTCHours();
      return Float64Array.from([r1[i], r4[i], r24[i], r168[i], cl[i] / ma[i] - 1, rs[i] / 100, ad[i] / 100, v30[i] > 0 ? v1[i] / v30[i] : v7[i] > 0 ? v1[i] / v7[i] : NaN, vz[i], Math.sin((h / 24) * 2 * Math.PI), Math.cos((h / 24) * 2 * Math.PI), d.getUTCDay() / 6, fa ? fa[i] : 0, gs[i] * 100, Number.isFinite(lrun) && lrun > 0 ? gs[i] / lrun : 1, ...shape[i], kf.slopeSd[i] > 0 ? kf.slope[i] / kf.slopeSd[i] : NaN, Number.isFinite(ou[i]) ? ou[i] : 0, Number.isFinite(vr[i]) ? vr[i] : 1, hp[i], gs[i] > 0 ? yz[i] / gs[i] : NaN]);
    });
  });
}
const finiteRow = (r: Float64Array) => r.every(Number.isFinite);

/**
 * Models fitted on the same training bars are the same model: kept here so a
 * strategy re-run on a simulated continuation of the same history (the
 * GARCH worlds) predicts with its model instead of fitting it again.
 */
const trained = new Map<string, unknown>();
function trainedOnce<T>(c: Ctx, what: string, fit: () => T): T {
  const b = c.m.bars;
  const e = Math.min(c.trainEnd, b.length) - 1;
  if (e < 1) return fit();
  const key = `${what}|${c.m.coin}|${c.m.tfH}|${c.seed}|${c.trainEnd}|${b[0].time}|${b[e].time}|${b[e].close}|${b.length > c.trainEnd ? 'cut' : 'all'}`;
  if (!trained.has(key)) {
    if (trained.size > 200) trained.delete(trained.keys().next().value as string);
    trained.set(key, fit());
  }
  return trained.get(key) as T;
}

/** learned rules: fit on bars before trainEnd whose label is known by then */
function learnedSignal(c: Ctx, p: Params, kind: 'ols' | 'rf' | 'nn'): Int8Array {
  const n = c.m.bars.length;
  const out = state(n);
  const h = H(c, p.horizon);
  const X = features(c);
  const cl = close(c);
  // the network's size can be set (the Quant desk's NNET panel sends its own): two hidden layers
  const hidden: [number, number] = [p.h1 > 0 ? Math.round(p.h1) : 16, p.h2 > 0 ? Math.round(p.h2) : 8];
  const model = trainedOnce<{ ols: Ridge; sd: number } | { rf: ForestModel } | { nn: MLP } | null>(c, `${kind}:${h}${kind === 'nn' ? `:${hidden.join('x')}` : ''}`, () => {
    const rows: number[][] = [];
    const ys: number[] = [];
    const step = Math.max(1, Math.floor(c.trainEnd / 4000));
    for (let i = 0; i + h < c.trainEnd; i += step) {
      if (!finiteRow(X[i])) continue;
      rows.push(Array.from(X[i]));
      ys.push(cl[i + h] / cl[i] - 1);
    }
    if (rows.length < 200) return null;
    if (kind === 'ols') {
      const m = fitRidge(rows, ys, 0.01);
      const fit = rows.map((r) => predictRidge(m, r));
      return { ols: m, sd: Math.sqrt(fit.reduce((a, b) => a + b * b, 0) / fit.length) || 1e-9 };
    }
    if (kind === 'nn') return { nn: fitMLP(rows, ys.map((y) => (y > 0 ? 1 : 0)), { hidden, epochs: 40, seed: c.seed, patience: 6 }) };
    return { rf: fitForest(rows, ys.map((y) => (y > 0 ? 1 : 0)), { trees: 40, maxDepth: 5, minLeaf: 20, seed: c.seed }) };
  });
  if (!model) return out;
  if ('nn' in model) {
    const m = model.nn;
    for (let i = 0; i < n; i++) {
      if (!finiteRow(X[i])) continue;
      const pr = predictMLP(m, X[i]);
      out[i] = pr > 0.5 + p.edge ? 1 : pr < 0.5 - p.edge ? -1 : 0;
    }
    return out;
  }
  if (kind === 'ols' && 'ols' in model) {
    const m = model.ols;
    const sd = model.sd;
    for (let i = 0; i < n; i++) {
      if (!finiteRow(X[i])) continue;
      const f = predictRidge(m, Array.from(X[i]));
      out[i] = Math.abs(f) > p.q * sd ? sgn(f) : 0;
    }
    return out;
  }
  if (!('rf' in model)) return out;
  const m = model.rf;
  for (let i = 0; i < n; i++) {
    if (!finiteRow(X[i])) continue;
    const pr = predictForest(m, Array.from(X[i]));
    out[i] = pr > 0.5 + p.edge ? 1 : pr < 0.5 - p.edge ? -1 : 0;
  }
  return out;
}

// ---------- the signals ----------

// ---------- ICT and Candle Range Theory: helpers ----------

/** the n-th Sunday of a month (UTC day of the month) */
const nthSunday = (y: number, m: number, n: number) => {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + 7 * (n - 1);
};
/** New York's offset from UTC at a moment: −4 hours in US daylight saving (2nd Sunday of March to 1st Sunday of November), −5 otherwise */
export const nyOffset = (t: number) => {
  const y = new Date(t).getUTCFullYear();
  const start = Date.UTC(y, 2, nthSunday(y, 2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return t >= start && t < end ? -4 : -5;
};
/** the hour of the day in New York (fractional) */
export const nyHour = (t: number) => (((t / 3_600_000 + nyOffset(t)) % 24) + 24) % 24;
/** the bar's candle of a higher timeframe (`hours` long, aligned to UTC midnight) */
const htfOf = (t: number, hours: number) => Math.floor(t / (hours * 3_600_000));
/** fair value gaps: a three-candle imbalance — the first candle's high below the third's low (bullish), or its low above the third's high (bearish) — at least `k` ATR wide; marked on the third candle with the gap's far edge */
function fvgs(c: Ctx, k: number): { bull: Float64Array; bear: Float64Array } {
  return cached(c, `fvg${k}`, () => {
    const b = c.m.bars;
    const A = atr14(c);
    const bull = new Float64Array(b.length).fill(NaN);
    const bear = new Float64Array(b.length).fill(NaN);
    for (let i = 2; i < b.length; i++) {
      const a = A[i - 1];
      if (!(a > 0)) continue;
      if (b[i].low - b[i - 2].high >= k * a) bull[i] = b[i - 2].high;
      if (b[i - 2].low - b[i].high >= k * a) bear[i] = b[i - 2].low;
    }
    return { bull, bear };
  });
}
const ICT_NOTE = ' A practitioner method (ICT), not a peer-reviewed one: the Lab tests whether it holds on crypto, with costs, on data it never saw.';
const CRT_NOTE = ' A practitioner method (Candle Range Theory), not a peer-reviewed one: the Lab tests whether it holds on crypto, with costs, on data it never saw.';
/** a higher-timeframe candle: 168 hours is the week from Monday 00:00 UTC; `ny` aligns the candles to the New York clock (the 1am-5am-9am 4-hour candles) */
const htfKey = (t: number, hours: number, ny = 0) => {
  if (!ny) return hours === 168 ? Math.floor((t - 4 * 86_400_000) / (7 * 86_400_000)) : htfOf(t, hours);
  const h = t / 3_600_000 + nyOffset(t);
  // New York: the week from Monday 00:00, the day from midnight, 4-hour candles from 01:00
  return hours === 168 ? Math.floor((h - 96) / 168) : Math.floor((h - (hours === 4 ? 1 : 0)) / hours);
};
/** pivot highs and lows: a high above the `k` candles either side of it (known `k` candles later) */
function pivots(c: Ctx, k: number): { hi: Float64Array; lo: Float64Array } {
  return cached(c, `piv${k}`, () => {
    const b = c.m.bars;
    const hi = new Float64Array(b.length).fill(NaN);
    const lo = new Float64Array(b.length).fill(NaN);
    for (let i = 2 * k; i < b.length; i++) {
      const j = i - k;
      let isH = true;
      let isL = true;
      for (let d = 1; d <= k; d++) {
        if (!(b[j].high > b[j - d].high && b[j].high >= b[j + d].high)) isH = false;
        if (!(b[j].low < b[j - d].low && b[j].low <= b[j + d].low)) isL = false;
      }
      // marked on the bar where it becomes known
      if (isH) hi[i] = b[j].high;
      if (isL) lo[i] = b[j].low;
    }
    return { hi, lo };
  });
}
/**
 * Order blocks: a displacement candle (body at least `k` ATR) that closes beyond the highest high
 * (lowest low) of the last 12 hours breaks structure; the last opposite-coloured candle before it
 * is the order block. Marked on the displacement candle: the zone [low, high] of that candle.
 */
function orderBlocks(c: Ctx, k: number): { bull: ({ lo: number; hi: number } | null)[]; bear: ({ lo: number; hi: number } | null)[] } {
  return cached(c, `ob${k}`, () => {
    const b = c.m.bars;
    const A = atr14(c);
    const n = H(c, 12);
    const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
    const ll = cached(c, `lp${n}`, () => loPrev(b, n));
    const bull: ({ lo: number; hi: number } | null)[] = new Array(b.length).fill(null);
    const bear: ({ lo: number; hi: number } | null)[] = new Array(b.length).fill(null);
    for (let i = 1; i < b.length; i++) {
      const a = A[i - 1];
      if (!(a > 0)) continue;
      const body = b[i].close - b[i].open;
      if (body >= k * a && b[i].close > hh[i]) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--)
          if (b[j].close < b[j].open) {
            bull[i] = { lo: b[j].low, hi: b[j].high };
            break;
          }
      } else if (-body >= k * a && b[i].close < ll[i]) {
        for (let j = i - 1; j >= Math.max(0, i - 5); j--)
          if (b[j].close > b[j].open) {
            bear[i] = { lo: b[j].low, hi: b[j].high };
            break;
          }
      }
    }
    return { bull, bear };
  });
}
const WYCKOFF_NOTE = ' A practitioner method (Wyckoff), not a peer-reviewed one: the Lab tests whether it holds on crypto, with costs, on data it never saw.';
const SMC_NOTE = ' A practitioner method (Smart Money Concepts), not a peer-reviewed one: the Lab tests whether it holds on crypto, with costs, on data it never saw.';
const VSA_NOTE = ' A practitioner method (Wyckoff, and volume spread analysis after Tom Williams), not a peer-reviewed one — volume does carry information prices alone do not (Blume, Easley & O’Hara; Karpoff): the Lab tests whether this holds on crypto, with costs, on data it never saw.';
/**
 * Market structure the Smart Money Concepts way, from swing points (`k` candles either side):
 * a close beyond the last swing high is a break of structure (BOS) when the structure was
 * already up, a change of character (CHoCH) when it was down — and the mirror at swing lows.
 * Each swing level breaks once. `trend` is the structure after each candle (+1 up, −1 down, 0 not yet).
 */
function structureOf(c: Ctx, k: number): { trend: Int8Array; bos: Int8Array; choch: Int8Array } {
  return cached(c, `smc${k}`, () => {
    const b = c.m.bars;
    const { hi, lo } = pivots(c, k);
    const trend = new Int8Array(b.length);
    const bos = new Int8Array(b.length);
    const choch = new Int8Array(b.length);
    let swingH = NaN;
    let swingL = NaN;
    let t = 0;
    for (let i = 0; i < b.length; i++) {
      if (Number.isFinite(hi[i])) swingH = hi[i];
      if (Number.isFinite(lo[i])) swingL = lo[i];
      if (Number.isFinite(swingH) && b[i].close > swingH) {
        if (t === -1) choch[i] = 1;
        else bos[i] = 1;
        t = 1;
        swingH = NaN;
      } else if (Number.isFinite(swingL) && b[i].close < swingL) {
        if (t === 1) choch[i] = -1;
        else bos[i] = -1;
        t = -1;
        swingL = NaN;
      }
      trend[i] = t;
    }
    return { trend, bos, choch };
  });
}
const CANDLE_NOTE = ' Candlestick patterns are practitioner lore (Nison); tests of them are mixed (Caginalp & Laurent found some predictive power): the Lab tests whether this one holds on crypto, with costs, on data it never saw.';


export const SIGNALS: SignalDef[] = [
  {
    id: 'tsmom',
    name: 'Time-series momentum',
    family: 'momentum',
    papers: ['mop12', 'lt21', 'ks151'],
    rationale: 'Investors under-react to news and attention arrives slowly, so a coin that has risen over the past days to weeks tends to keep rising (and fallers keep falling).',
    grid: { lookback: [24, 72, 168, 336, 720] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const r = retN(close(c), H(c, p.lookback));
      return Int8Array.from(r, (x) => (Number.isFinite(x) ? sgn(x) : 0));
    },
    describe: (p) => `long when the last ${hrs(p.lookback)} return is positive, short when negative`,
  },
  {
    id: 'mac',
    name: 'Moving-average crossover',
    family: 'trend',
    papers: ['blr92', 'ks151', 'gas20', 'cels19'],
    rationale: 'A fast average above a slow one marks a trend the market is still pricing in; the rule rides it and steps aside when it turns.',
    grid: { fast: [12, 24, 50], slow: [100, 200, 400] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const f = smaH(c, p.fast);
      const s = smaH(c, p.slow);
      return Int8Array.from(f, (x, i) => (Number.isFinite(x) && Number.isFinite(s[i]) ? sgn(x - s[i]) : 0));
    },
    describe: (p) => `long while the ${hrs(p.fast)} average is above the ${hrs(p.slow)} average, short while below`,
  },
  {
    id: 'tma',
    name: 'Three moving averages',
    family: 'trend',
    papers: ['ks151'],
    rationale: 'Requiring three averages in order (fast > middle > slow) trades only established trends and filters the whipsaws of a single crossover.',
    grid: { set: [0, 1, 2] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const [a, b, d] = [
        [12, 48, 168],
        [24, 72, 240],
        [50, 100, 200],
      ][p.set];
      const f = smaH(c, a);
      const m = smaH(c, b);
      const s = smaH(c, d);
      return Int8Array.from(f, (x, i) => (x > m[i] && m[i] > s[i] ? 1 : x < m[i] && m[i] < s[i] ? -1 : 0));
    },
    describe: (p) => {
      const [a, b, d] = [
        [12, 48, 168],
        [24, 72, 240],
        [50, 100, 200],
      ][p.set];
      return `long when the ${hrs(a)} > ${hrs(b)} > ${hrs(d)} averages line up, short when they line up downward`;
    },
  },
  {
    id: 'maratio',
    name: 'Price-to-moving-average ratio',
    family: 'trend',
    papers: ['dlszz21'],
    rationale: 'With hard-to-value fundamentals, traders learn from price itself: the gap between price and its average carries information that is priced in slowly.',
    grid: { lookback: [168, 336, 720], band: [0, 0.02, 0.05] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => (!Number.isFinite(m[i]) ? 0 : x / m[i] - 1 > p.band ? 1 : x / m[i] - 1 < -p.band ? -1 : 0));
    },
    describe: (p) => `long when price is more than ${(p.band * 100).toFixed(0)}% above its ${hrs(p.lookback)} average, short when as far below`,
  },
  {
    id: 'donchian',
    name: 'Channel breakout',
    family: 'breakout',
    papers: ['blr92', 'faith07', 'ks151', 'hu21'],
    rationale: 'A close beyond the range of the last N bars shows new information or forced buying/selling that the range did not hold; breakouts in crypto tend to extend.',
    grid: { n: [20, 55, 120, 240] },
    exit: { stopAtr: 2, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.n);
      const hi = cached(c, `hi${n}`, () => hiPrev(c.m.bars, n));
      const lo = cached(c, `lo${n}`, () => loPrev(c.m.bars, n));
      const out = state(c.m.bars.length);
      let s = 0;
      c.m.bars.forEach((b, i) => {
        if (b.close > hi[i]) s = 1;
        else if (b.close < lo[i]) s = -1;
        out[i] = s;
      });
      return out;
    },
    describe: (p) => `long after a close above the prior ${hrs(p.n)} high, short after a close below the prior ${hrs(p.n)} low`,
  },
  {
    id: 'pivot',
    name: 'Support and resistance (pivot points)',
    family: 'breakout',
    papers: ['ks151'],
    rationale: "Floor traders' pivot levels from yesterday's high, low and close are watched by many; a close through resistance or support triggers follow-through.",
    grid: { level: [1, 2] },
    intraday: true,
    exit: { stopAtr: 1.5, maxBars: 24, onFlip: true },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      let day = -1;
      let dh = -Infinity;
      let dl = Infinity;
      let dc = NaN;
      let piv: [number, number] | null = null;
      c.m.bars.forEach((b, i) => {
        const d = Math.floor(b.time / 86_400_000);
        if (d !== day) {
          if (day >= 0 && Number.isFinite(dc)) {
            const P = (dh + dl + dc) / 3;
            piv = p.level === 1 ? [2 * P - dh, 2 * P - dl] : [P - (dh - dl), P + (dh - dl)];
          }
          day = d;
          dh = -Infinity;
          dl = Infinity;
        }
        if (piv) out[i] = b.close > piv[1] ? 1 : b.close < piv[0] ? -1 : 0;
        dh = Math.max(dh, b.high);
        dl = Math.min(dl, b.low);
        dc = b.close;
      });
      return out;
    },
    describe: (p) => `long on a close above yesterday's R${p.level} pivot resistance, short on a close below S${p.level} support`,
  },
  {
    id: 'zrev',
    name: 'Mean reversion (z-score)',
    family: 'reversion',
    papers: ['ks151', 'jeg90', 'lm90'],
    rationale: 'Short-horizon overreaction and liquidity demands push price too far from its average; liquidity providers are paid to take the other side as it reverts.',
    grid: { lookback: [24, 72, 168], k: [1.5, 2, 2.5] },
    exit: { stopAtr: 2, targetR: 1.5, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const s = sdH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => {
        const z = s[i] > 0 ? (x - m[i]) / s[i] : 0;
        return z < -p.k ? 1 : z > p.k ? -1 : 0;
      });
    },
    describe: (p) => `buy ${p.k} standard deviations below the ${hrs(p.lookback)} average, sell ${p.k} above`,
  },
  {
    id: 'rsi2',
    name: 'RSI extremes',
    family: 'reversion',
    papers: ['ca09', 'wil78'],
    rationale: 'Very short-term oversold readings mark capitulation by impatient sellers; the bounce rewards the buyer who supplies liquidity.',
    grid: { n: [2, 3, 14], band: [10, 20, 30] },
    exit: { stopAtr: 2, targetR: 1.5, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const r = cached(c, `rsi${p.n}`, () => rsi(close(c), p.n));
      return Int8Array.from(r, (x) => (x < p.band ? 1 : x > 100 - p.band ? -1 : 0));
    },
    describe: (p) => `buy when RSI(${p.n}) is under ${p.band}, sell when over ${100 - p.band}`,
  },
  {
    id: 'bbreak',
    name: 'Bollinger band breakout',
    family: 'breakout',
    papers: ['bol01', 'hu21'],
    rationale: 'A close outside two-sigma bands marks a volatility expansion; in trending crypto markets expansions tend to continue rather than revert.',
    grid: { lookback: [20, 50, 100], k: [2, 2.5] },
    exit: { stopAtr: 2, maxBars: 120, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const s = sdH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => (x > m[i] + p.k * s[i] ? 1 : x < m[i] - p.k * s[i] ? -1 : 0));
    },
    describe: (p) => `long on a close above the upper ${p.k}σ band of the ${hrs(p.lookback)} average, short below the lower band`,
  },
  {
    id: 'macd',
    name: 'MACD trend',
    family: 'trend',
    papers: ['app05', 'hu21'],
    rationale: 'The gap between fast and slow exponential averages measures trend acceleration; its sign against its own signal line times entries in the trend.',
    grid: { scale: [1, 4, 24] },
    exit: { stopAtr: 2.5, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const f = ema(cl, H(c, 12 * p.scale));
      const s = ema(cl, H(c, 26 * p.scale));
      const macd = f.map((x, i) => x - s[i]);
      const sig = ema(Float64Array.from(macd, (x) => (Number.isFinite(x) ? x : 0)), H(c, 9 * p.scale));
      return Int8Array.from(macd, (x, i) => (Number.isFinite(x) && Number.isFinite(sig[i]) ? sgn(x - sig[i]) : 0));
    },
    describe: (p) => `long while MACD(${12 * p.scale}, ${26 * p.scale}) is above its ${9 * p.scale}-hour signal line, short while below`,
  },
  {
    id: 'itsm',
    name: 'Intraday time-series momentum',
    family: 'momentum',
    papers: ['suw22', 'wbxz22'],
    rationale: "Late-day traders (and those hedging the day's move) trade in the direction of the day so far, so the day's return predicts its final hours.",
    grid: { hour: [20, 21, 22] },
    intraday: true,
    exit: { stopAtr: 2, maxBars: 3, onFlip: false },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      let open = NaN;
      c.m.bars.forEach((b, i) => {
        if (b.time % 86_400_000 === 0) open = b.open;
        // the bar that closes at hour p.hour (on 4-hour candles: the last one closing by then)
        if (closeHour(c, b.time) === onGrid(c, p.hour) && Number.isFinite(open)) out[i] = sgn(b.close / open - 1);
      });
      return out;
    },
    describe: (p) => `at ${p.hour}:00 UTC, trade the day's direction so far into the close`,
  },
  {
    id: 'dow',
    name: 'Monday effect',
    family: 'seasonal',
    papers: ['cp19', 'bcgl19'],
    rationale: "Bitcoin's returns were reported higher on Mondays as weekday flows return after the weekend; the Lab tests whether it survives.",
    grid: { day: [1] },
    intraday: true,
    exit: { stopAtr: 3, maxBars: 24, onFlip: false },
    compute: (c) => {
      const out = state(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        const t = b.time + c.m.tfH * 3_600_000;
        if (t % 86_400_000 === 0 && new Date(t).getUTCDay() === 1) out[i] = 1;
      });
      return out;
    },
    describe: () => 'long from Monday 00:00 UTC for the day',
  },
  {
    id: 'wrev',
    name: 'Weekly reversal',
    family: 'reversion',
    papers: ['dob23', 'jeg90'],
    rationale: "Last week's biggest moves partly reverse as overreaction fades, while two-to-four-week trends continue.",
    grid: { band: [0.05, 0.1, 0.15] },
    exit: { stopAtr: 3, targetR: 2, maxBars: 168, onFlip: false },
    compute: (c, p) => {
      const r = retN(close(c), H(c, 168));
      return Int8Array.from(r, (x) => (x > p.band ? -1 : x < -p.band ? 1 : 0));
    },
    describe: (p) => `fade a week's move of more than ${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'carry',
    name: 'Funding carry',
    family: 'carry',
    papers: ['hmrw22', 'crszj23'],
    rationale: 'When leveraged longs pay high funding, shorting the perpetual collects the payment and leans against a crowded trade; negative funding pays longs.',
    grid: { lookback: [24, 72], band: [0.1, 0.25] },
    needsFunding: true,
    exit: { stopAtr: 3, maxBars: 168, onFlip: true },
    compute: (c, p) => {
      const f = fundAnn(c, p.lookback);
      if (!f) return state(c.m.bars.length);
      return Int8Array.from(f, (x) => (x > p.band ? -1 : x < -p.band ? 1 : 0));
    },
    describe: (p) => `short when funding averages more than ${(p.band * 100).toFixed(0)}% a year over ${hrs(p.lookback)}, long when below −${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'volbrk',
    name: 'Volume-confirmed move',
    family: 'volume',
    papers: ['lmsw02', 'beo94'],
    rationale: 'A price move on unusually heavy volume is more likely informed and continues; the same move on light volume says little.',
    grid: { n: [1, 4, 24], k: [1.5, 2.5] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const r = retN(close(c), H(c, p.n));
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      return Int8Array.from(r, (x, i) => (vz[i] > p.k && Number.isFinite(x) ? sgn(x) : 0));
    },
    describe: (p) => `trade the ${hrs(p.n)} move when volume is ${p.k} standard deviations above normal`,
  },
  {
    id: 'vsmom',
    name: 'Volatility-scaled momentum (GARCH)',
    family: 'momentum',
    papers: ['mop12', 'boll86', 'lt21'],
    rationale: 'A move only says something when it is large against the volatility expected for it: scaling the trend by GARCH volatility trades significant moves and ignores noise in a storm.',
    grid: { lookback: [24, 72, 168], k: [0.5, 1, 1.5] },
    exit: { stopAtr: 3, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.lookback);
      const cl = close(c);
      const gs = garchSigma(c);
      const out = state(cl.length);
      for (let i = n; i < cl.length; i++) {
        // the GARCH volatility expected over those n bars, as of their start
        const z = Math.log(cl[i] / cl[i - n]) / (gs[i - n] * Math.sqrt(n));
        out[i] = Number.isFinite(z) ? (z > p.k ? 1 : z < -p.k ? -1 : 0) : 0;
      }
      return out;
    },
    describe: (p) => `long when the ${hrs(p.lookback)} return is more than ${p.k} GARCH standard deviations up, short when as far down`,
  },
  {
    id: 'kalman',
    name: 'Kalman-filter trend',
    family: 'trend',
    papers: ['kal60', 'har90'],
    rationale: 'A Kalman filter separates a trend from the noise around it and says how sure it is of the slope: trade only when the filtered slope is clearly away from zero, which ignores the whipsaws moving averages fall for.',
    grid: { smooth: [0, 1, 2], k: [1, 2, 3] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const kf = kalmanOf(c, p.smooth);
      return Int8Array.from(kf.slope, (s, i) => {
        const t = kf.slopeSd[i] > 0 ? s / kf.slopeSd[i] : 0;
        return t > p.k ? 1 : t < -p.k ? -1 : 0;
      });
    },
    describe: (p) => `long when the Kalman-filtered trend slope (${['smoothest', 'smooth', 'responsive'][p.smooth]}) is more than ${p.k} standard errors above zero, short when as far below`,
  },
  {
    id: 'ou',
    name: 'Ornstein–Uhlenbeck reversion',
    family: 'reversion',
    papers: ['uo30', 'al10', 'ber10'],
    rationale: 'Fit a mean-reverting (Ornstein–Uhlenbeck) process to the price over a window; when the process reverts quickly and price sits far from its equilibrium in its own standard deviations (the s-score), bet on the pull back.',
    grid: { window: [72, 168, 336], k: [1.5, 2] },
    exit: { stopAtr: 2, maxBars: 72, onFlip: false },
    compute: (c, p) => {
      const o = ouOf(c, p.window);
      const maxHL = H(c, p.window) / 4;
      return Int8Array.from(o.s, (s, i) => (Number.isFinite(s) && o.halfLife[i] < maxHL ? (s < -p.k ? 1 : s > p.k ? -1 : 0) : 0));
    },
    describe: (p) => `fit an Ornstein–Uhlenbeck process over ${hrs(p.window)}; when it reverts fast (half-life under a quarter of the window), long below −${p.k} s-score, short above +${p.k}`,
  },
  {
    id: 'vwmom',
    name: 'Volume-weighted momentum',
    family: 'momentum',
    papers: ['h24', 'mop12', 'lmsw02'],
    rationale: 'Momentum where each candle counts by its volume: a move made on heavy trading carries more information than the same move on a quiet market, and in crypto the volume-weighted trend has been the stronger predictor.',
    grid: { lookback: [24, 72, 168, 336] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.lookback);
      const lr = lrets(c);
      const b = c.m.bars;
      const out = state(b.length);
      let sv = 0;
      let s = 0;
      const w = (i: number) => (Number.isFinite(lr[i]) && b[i].volume > 0 ? b[i].volume : 0);
      for (let i = 1; i < b.length; i++) {
        sv += w(i) * (Number.isFinite(lr[i]) ? lr[i] : 0);
        s += w(i);
        if (i > n) {
          sv -= w(i - n) * (Number.isFinite(lr[i - n]) ? lr[i - n] : 0);
          s -= w(i - n);
        }
        if (i >= n && s > 0) out[i] = sgn(sv / s);
      }
      return out;
    },
    describe: (p) => `long when the volume-weighted return of the last ${hrs(p.lookback)} is positive, short when negative`,
  },
  {
    id: 'ctrend',
    name: 'Trend composite (17 indicators)',
    family: 'trend',
    papers: ['flpwz25', 'hu21', 'app05'],
    rationale: 'No single indicator is reliable, but together they are: RSI, stochastic, CCI, price against seven moving averages, MACD, volume trends, money flow and Bollinger bands each cast one vote. The published crypto trend factor weights such indicators by machine learning across thousands of coins; here each gets an equal vote on one coin.',
    grid: { unit: [24, 4], k: [0.3, 0.6] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => Int8Array.from(trendScore(c, p.unit), (x) => (Number.isFinite(x) ? (x > p.k ? 1 : x < -p.k ? -1 : 0) : 0)),
    describe: (p) => `${TREND_VOTES} price and volume indicators vote (${p.unit === 24 ? 'daily horizons, 3 to 200 days' : `horizons of ${3 * p.unit} to ${200 * p.unit} hours`}); long when the balance of votes is above ${Math.round(p.k * 100)} %, short below −${Math.round(p.k * 100)} %`,
  },
  {
    id: 'maxmin',
    name: 'New high / new low',
    family: 'breakout',
    papers: ['pv22', 'hu21'],
    rationale: 'In bitcoin, a close at a new 10-day high tended to be followed by more gains (trend), and a close at a new 10-day low by a bounce (panic selling exhausts itself). Both are buys — the rule never shorts.',
    grid: { n: [240, 480], mode: [0, 1, 2] },
    exit: { stopAtr: 3, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const n = H(c, p.n);
      const cl = close(c);
      const hi = cached(c, `chi${n}`, () => extremePrev(cl, n, 1));
      const lo = cached(c, `clo${n}`, () => extremePrev(cl, n, -1));
      return Int8Array.from(cl, (x, i) => ((p.mode !== 2 && x > hi[i]) || (p.mode !== 1 && x < lo[i]) ? 1 : 0));
    },
    describe: (p) => (p.mode === 1 ? `buy a close at a new ${hrs(p.n)} high` : p.mode === 2 ? `buy a close at a new ${hrs(p.n)} low (the bounce)` : `buy a close at a new ${hrs(p.n)} high (trend) or a new ${hrs(p.n)} low (bounce)`),
  },
  {
    id: 'jump',
    name: 'Big-day follow-through',
    family: 'momentum',
    papers: ['luwz21', 'cp19o'],
    rationale: 'In crypto an extreme day tends to be followed, not faded: coins with the biggest daily jumps went on to earn more, and fading abnormal days lost money. The published profit could not be told from luck after costs, so the Lab tests it on your coins before it is believed.',
    grid: { k: [2, 2.5, 3] },
    exit: { stopAtr: 2.5, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const d = H(c, 24);
      const cl = close(c);
      const r = retN(cl, d);
      const sd = cached(c, `jsd${d}`, () => rstd(Float64Array.from(r, (x) => (Number.isFinite(x) ? x : 0)), H(c, 720)));
      const out = state(cl.length);
      // the day's move against the spread of daily moves as it stood a day earlier
      for (let i = d + H(c, 720); i < cl.length; i++) {
        const z = sd[i - d] > 0 ? r[i] / sd[i - d] : 0;
        out[i] = z > p.k ? 1 : z < -p.k ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `after a 1-day move of more than ${p.k} standard deviations (of the last 30 days), trade in its direction for a day`,
  },
  {
    id: 'night',
    name: 'Late-evening hours (21:00–23:00 UTC)',
    family: 'seasonal',
    papers: ['pv22', 'bcgl19'],
    rationale: "Bitcoin's returns were concentrated in two hours late in the US day, 21:00 to 23:00 UTC, in 2015–2021 — and the pattern weakened afterwards. A calendar effect with no clear cause: the Lab tests whether it still holds.",
    grid: { hour: [21, 22] },
    intraday: true,
    exit: { stopAtr: 3, maxBars: 2, onFlip: false },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      const want = onGrid(c, p.hour);
      c.m.bars.forEach((b, i) => {
        if (closeHour(c, b.time) === want) out[i] = 1;
      });
      return out;
    },
    describe: (p) => `buy at ${p.hour}:00 UTC and hold for two hours`,
  },
  {
    id: 'vwap',
    name: 'VWAP trend',
    family: 'trend',
    papers: ['az23v', 'zab24n'],
    rationale: 'The day\'s volume-weighted average price is what the average participant paid today. Above it buyers are in profit and in control; below it sellers are. Long above, short below, a fresh start each day. Published on US index funds; crypto has no opening bell, so the day starts at 00:00 UTC or with the US session.',
    grid: { anchor: [0, 13], band: [0, 0.5] },
    intraday: true,
    exit: { stopAtr: 2, maxBars: 24, onFlip: true },
    compute: (c, p) => {
      const b = c.m.bars;
      const vw = sessionVwap(c, p.anchor);
      const { k } = sessionOf(c, p.anchor);
      const A = atr14(c);
      const out = state(b.length);
      // not in the first hour of the day: the average has too little behind it
      const warm = Math.max(1, Math.round(1 / c.m.tfH));
      for (let i = 0; i < b.length; i++) {
        if (k[i] < warm || !Number.isFinite(vw[i]) || !Number.isFinite(A[i])) continue;
        const d = b[i].close - vw[i];
        out[i] = d > p.band * A[i] ? 1 : d < -p.band * A[i] ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `long while price is above the day's volume-weighted average price${p.band > 0 ? ` by more than ${p.band} ATR` : ''}, short while below (the day starts at ${p.anchor}:00 UTC)`,
  },
  {
    id: 'orb',
    name: 'Opening range breakout',
    family: 'breakout',
    papers: ['za23o', 'zba24o', 'cra90'],
    rationale: 'The first hour or two of the day sets a range; a close beyond it shows which side has won the opening argument, and the day tends to follow. One trade a day, held for the rest of it at most. Published on US stocks, where it needs unusual volume behind it; in crypto the "open" is 00:00 UTC or the US session.',
    grid: { anchor: [0, 13], range: [1, 2] },
    intraday: true,
    exit: { stopAtr: 2, maxBars: 22, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { k } = sessionOf(c, p.anchor);
      const n = Math.max(1, Math.round(p.range / c.m.tfH));
      const perDay = Math.round(24 / c.m.tfH);
      const out = state(b.length);
      let hi = -Infinity;
      let lo = Infinity;
      let side = 0;
      for (let i = 0; i < b.length; i++) {
        if (k[i] === 0) {
          hi = -Infinity;
          lo = Infinity;
          side = 0;
        }
        if (k[i] < n) {
          hi = Math.max(hi, b[i].high);
          lo = Math.min(lo, b[i].low);
          continue;
        }
        // the first close beyond the range decides the day; nothing new in its last hours
        if (!side && k[i] < perDay - Math.max(1, Math.round(2 / c.m.tfH))) side = b[i].close > hi ? 1 : b[i].close < lo ? -1 : 0;
        out[i] = side;
      }
      return out;
    },
    describe: (p) => `the first ${p.range} hour${p.range > 1 ? 's' : ''} from ${p.anchor}:00 UTC set a range; trade the first close beyond it, in its direction, for the rest of the day`,
  },
  {
    id: 'noise',
    name: 'Intraday momentum beyond the noise',
    family: 'momentum',
    papers: ['zab24n', 'suw22'],
    rationale: 'By each time of day, price has usually moved some distance from the open — that is noise. A move bigger than the average for that time of day over the last two weeks is demand or supply the day has not absorbed, and it tends to run to the close. Exits when price falls back inside.',
    grid: { anchor: [0, 13], k: [1, 1.5] },
    intraday: true,
    exit: { stopAtr: 2.5, maxBars: 24, onFlip: true },
    compute: (c, p) => {
      const b = c.m.bars;
      const { k } = sessionOf(c, p.anchor);
      const perDay = Math.round(24 / c.m.tfH);
      const barMs = c.m.tfH * 3_600_000;
      const out = state(b.length);
      // the absolute move from the day's open at each slot, for the last 14 days
      const hist: number[][] = Array.from({ length: perDay }, () => []);
      let open = NaN;
      let pending: [number, number][] = [];
      for (let i = 0; i < b.length; i++) {
        // the time of day as a slot (by the clock, so a missing candle does not shift the rest)
        const since = (((b[i].time - p.anchor * 3_600_000) % 86_400_000) + 86_400_000) % 86_400_000;
        const slot = Math.min(perDay - 1, Math.floor(since / barMs));
        if (k[i] === 0) {
          // yesterday's moves join the history only once the day is over
          for (const [s, m] of pending) {
            hist[s].push(m);
            if (hist[s].length > 14) hist[s].shift();
          }
          pending = [];
          open = b[i].open;
        }
        if (!(open > 0)) continue;
        const move = b[i].close / open - 1;
        pending.push([slot, Math.abs(move)]);
        const h = hist[slot];
        if (h.length < 10) continue;
        const noise = h.reduce((a, x) => a + x, 0) / h.length;
        out[i] = move > p.k * noise ? 1 : move < -p.k * noise ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `long when the move from the day's open (${p.anchor}:00 UTC) is more than ${p.k}× the average move by that time of day over the last 14 days, short when as far below`,
  },
  {
    id: 'fade',
    name: 'Fade a stretched candle',
    family: 'reversion',
    papers: ['kw26', 'wbxz22', 'lm90'],
    rationale: 'On 15-minute candles a sharp move is partly taken back in the next candle, far more in crypto than in stocks: forced and impatient orders push price further than the news deserves, and those who take the other side are paid as it settles. The measured edge is a point or two before fees — the test shows whether anything is left after them.',
    grid: { k: [1.5, 2, 3], vol: [0, 1] },
    intraday: true,
    exit: { stopAtr: 1.5, targetR: 1, maxBars: 1, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      const out = state(b.length);
      for (let i = 1; i < b.length; i++) {
        const a = A[i - 1];
        if (!Number.isFinite(a) || a <= 0) continue;
        const m = (b[i].close - b[i].open) / a;
        // with vol = 1: only when the candle came on heavy volume (aggressive flow)
        if (p.vol && !(vz[i] > 1)) continue;
        out[i] = m > p.k ? -1 : m < -p.k ? 1 : 0;
      }
      return out;
    },
    describe: (p) => `after a candle that moves more than ${p.k} ATR${p.vol ? ' on heavy volume' : ''}, trade against it for the next candles`,
  },
  {
    id: 'pairs',
    name: 'Pairs: the coin against bitcoin',
    family: 'relative',
    papers: ['ggr06', 'fk20', 'al10'],
    rationale: 'Coins move with bitcoin. When a coin drifts unusually far from where bitcoin says it should be, the gap tends to close: buy the coin when it is cheap against bitcoin, sell when rich. With the bitcoin hedge this is a true pairs trade — the market’s direction cancels out. In crypto the effect showed on hourly and 5-minute candles, not daily ones.',
    grid: { window: [168, 336, 720], k: [1.5, 2] },
    needsBench: true,
    exit: { stopAtr: 2.5, targetR: 1.5, maxBars: 96, onFlip: false },
    compute: (c, p) => {
      const f = pairZ(c, p.window);
      if (!f) return state(c.m.bars.length);
      // only where the coin really tracks bitcoin: a positive slope and a fit that explains half the moves
      return Int8Array.from(f.z, (z, i) => (Number.isFinite(z) && f.beta[i] > 0 && f.r2[i] >= 0.5 ? (z < -p.k ? 1 : z > p.k ? -1 : 0) : 0));
    },
    describe: (p) => `fit the coin against bitcoin over ${hrs(p.window)}; buy when it is more than ${p.k} standard deviations cheap against bitcoin, sell when as rich (only while the two move together)`,
  },
  // ---------- high frequency: built for 1- and 5-minute candles ----------
  {
    id: 'ofi',
    name: 'Order-flow pressure (bulk volume)',
    family: 'volume',
    papers: ['elo16', 'cks14', 'wbxz22'],
    rationale: 'Over minutes, prices are pushed by order-flow imbalance — aggressive buying against aggressive selling. Candles do not say who was aggressive, but the bulk-volume method estimates it: each candle\'s volume is split into buys and sells by how big its move was against the usual size (a large up candle is mostly buying). When the last few candles\' volume leans hard one way, the flow is one-sided and the next minutes tend to follow it. Measured on stocks and futures; one test on crypto 1-minute flow found it did not survive costs — the test here decides, with costs.',
    grid: { n: [5, 15, 30], th: [0.25, 0.35, 0.5] },
    intraday: true,
    maxTfH: 1,
    exit: { stopAtr: 1.5, targetR: 1.5, maxBars: 15, onFlip: true },
    compute: (c, p) => {
      const b = c.m.bars;
      const r = lrets(c);
      const W = Math.max(20, H(c, 24));
      const sd = cached(c, `sdr${W}`, () => rstd(r, W));
      const n = Math.max(2, Math.round(p.n));
      const out = state(b.length);
      const sv = new Float64Array(b.length);
      let num = 0;
      let den = 0;
      for (let i = 1; i < b.length; i++) {
        const s = sd[i - 1];
        const v = b[i].volume > 0 ? b[i].volume : 0;
        // the buy share of this candle's volume: Φ(move / its usual size); signed volume is buys − sells
        sv[i] = s > 0 && Number.isFinite(r[i]) ? (2 * ncdf(r[i] / s) - 1) * v : 0;
        num += sv[i];
        den += v;
        if (i >= n) {
          num -= sv[i - n];
          den -= b[i - n].volume > 0 ? b[i - n].volume : 0;
        }
        if (i < W + n || den <= 0) continue;
        const imb = num / den;
        out[i] = imb > p.th ? 1 : imb < -p.th ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `long while the last ${p.n} candles' volume is more than ${Math.round(p.th * 100)}% net buying (estimated from each candle's move), short while as much net selling`,
  },
  {
    id: 'qhour',
    name: 'Quarter-hour opening flow',
    family: 'seasonal',
    papers: ['kh26', 'elo16'],
    rationale: 'Trading algorithms run on the clock: crypto futures volume and volatility burst at the minute, the five minutes and above all the quarter-hour (:00, :15, :30, :45). Kim & Hansen find that the order imbalance in a quarter-hour\'s first moments predicts the returns of the next hours. Here the first candle of each quarter-hour stands in for those moments (its move against the usual size, on 1- or 5-minute candles); a strong one sets the side for the hours after. An independent rebuild found the pattern real but hard to trade after costs — the test shows whether it is.',
    grid: { k: [1, 1.5, 2], hold: [1, 4], vol: [0, 1] },
    intraday: true,
    maxTfH: 1 / 12,
    exit: { stopAtr: 2, targetR: 0, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      if (c.m.tfH > 1 / 12 + 1e-9) return out;
      const r = lrets(c);
      const W = Math.max(20, H(c, 24));
      const sd = cached(c, `sdr${W}`, () => rstd(r, W));
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      const holdBars = Math.max(1, Math.round(p.hold / c.m.tfH));
      let side = 0;
      let until = -1;
      for (let i = W + 1; i < b.length; i++) {
        const minute = Math.round(b[i].time / 60_000) % 15;
        if (minute === 0 && sd[i - 1] > 0 && (!p.vol || vz[i] > 0)) {
          const z = r[i] / sd[i - 1];
          if (Math.abs(z) > p.k) {
            side = z > 0 ? 1 : -1;
            until = i + holdBars;
          }
        }
        if (i > until) side = 0;
        out[i] = side;
      }
      return out;
    },
    describe: (p) => `when a quarter-hour opens (:00, :15, :30, :45) with a move of more than ${p.k}× the usual size${p.vol ? ' on above-normal volume' : ''}, trade in its direction for up to ${p.hold} hour${p.hold > 1 ? 's' : ''}`,
  },
  {
    id: 'nyorb5',
    name: 'US-open range breakout (the first minutes)',
    family: 'breakout',
    papers: ['zba24o', 'za23o', 'emuw19'],
    rationale: 'Zarattini, Barbon & Aziz find the opening-range breakout pays most when the range is the first five minutes after the US stock market opens (9:30 New York), on stocks with unusual activity. Crypto\'s volume and volatility jump at that hour too, as US money arrives. The first close beyond the opening minutes\' high or low is traded in its direction, until the US close at the latest. On US stocks it was profitable after costs; a replication on index CFDs found nothing left after costs — the test here decides for crypto.',
    grid: { m: [5, 15, 30] },
    intraday: true,
    maxTfH: 0.25,
    exit: { stopAtr: 1.5, targetR: 0, maxBars: 78, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      const mins = c.m.tfH * 60;
      if (mins > p.m + 1e-9) return out;
      let day = -1;
      let hi = -Infinity;
      let lo = Infinity;
      let side = 0;
      for (let i = 0; i < b.length; i++) {
        const t = b[i].time;
        const local = t / 3_600_000 + nyOffset(t);
        const d = Math.floor(local / 24);
        const m = Math.round((((local % 24) + 24) % 24) * 60);
        const wd = new Date(d * 86_400_000).getUTCDay();
        if (d !== day) {
          day = d;
          hi = -Infinity;
          lo = Infinity;
          side = 0;
        }
        if (wd === 0 || wd === 6) continue;
        // the opening range: candles that open from 9:30 and close by 9:30 + m minutes
        if (m >= 570 && m + mins <= 570 + p.m + 1e-9) {
          hi = Math.max(hi, b[i].high);
          lo = Math.min(lo, b[i].low);
          continue;
        }
        if (m < 570 + p.m || m + mins > 960 || !Number.isFinite(hi)) {
          if (m + mins > 960) side = 0;
          continue;
        }
        if (!side) side = b[i].close > hi ? 1 : b[i].close < lo ? -1 : 0;
        out[i] = side;
      }
      return out;
    },
    describe: (p) => `on US trading days, the first ${p.m} minutes after 9:30 New York set a range; trade the first close beyond it, in its direction, until 16:00 New York at the latest`,
  },
  {
    id: 'vwapband',
    name: 'VWAP band snap-back',
    family: 'reversion',
    papers: ['bbd22', 'wbxz22', 'kw26'],
    rationale: 'The day\'s volume-weighted average price is where most of the day\'s business was done; its bands — the volume-weighted spread of prices around it — mark how far price usually strays. A close beyond a wide band is often impatient or forced flow, and those who take the other side are paid as price settles back (short-term reversal in crypto is mostly pay for providing liquidity, Bianchi et al.). With confirmation, it waits for a candle that already turns back.',
    grid: { k: [1.5, 2, 2.5], conf: [0, 1] },
    intraday: true,
    maxTfH: 1,
    exit: { stopAtr: 1.5, targetR: 1, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      const { k } = sessionOf(c, 0);
      const warm = Math.max(3, Math.round(1 / c.m.tfH));
      let w = 0;
      let pv = 0;
      let pv2 = 0;
      for (let i = 0; i < b.length; i++) {
        if (k[i] === 0) {
          w = 0;
          pv = 0;
          pv2 = 0;
        }
        const v = b[i].volume > 0 ? b[i].volume : 0;
        const tp = (b[i].high + b[i].low + b[i].close) / 3;
        w += v;
        pv += tp * v;
        pv2 += tp * tp * v;
        if (k[i] < warm || w <= 0) continue;
        const vw = pv / w;
        const sd = Math.sqrt(Math.max(0, pv2 / w - vw * vw));
        if (!(sd > 0)) continue;
        const z = (b[i].close - vw) / sd;
        const down = b[i].close < b[i].open;
        const up = b[i].close > b[i].open;
        if (z > p.k && (!p.conf || down)) out[i] = -1;
        else if (z < -p.k && (!p.conf || up)) out[i] = 1;
      }
      return out;
    },
    describe: (p) => `sell a close more than ${p.k} band-widths above the day's VWAP, buy one as far below${p.conf ? ' — only on a candle that has already turned back' : ''} (the day starts at 00:00 UTC)`,
  },
  {
    id: 'emapull',
    name: 'Pullback to the fast average (EMA)',
    family: 'trend',
    papers: ['blr92', 'lmw00'],
    rationale: 'The scalper\'s staple: with a fast exponential average above a rising slow one, the trend is up; a dip that touches the fast average and closes back above it is a cheap entry into that trend (and the mirror for downtrends). Moving-average rules have been studied for decades (Brock, Lakonishok & LeBaron) — whether this one leaves anything after costs at minute speed is what the test is for.',
    grid: { f: [9, 20], s: [21, 50] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 30, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      if (p.f >= p.s) return out;
      const cl = close(c);
      const ef = cached(c, `ema${p.f}`, () => ema(cl, p.f));
      const es = cached(c, `ema${p.s}`, () => ema(cl, p.s));
      const back = 5;
      for (let i = p.s + back; i < b.length; i++) {
        if (!Number.isFinite(ef[i]) || !Number.isFinite(es[i - back])) continue;
        const upTrend = ef[i] > es[i] && es[i] > es[i - back];
        const dnTrend = ef[i] < es[i] && es[i] < es[i - back];
        if (upTrend && b[i].low <= ef[i] && b[i].close > ef[i] && b[i].close > b[i].open) out[i] = 1;
        else if (dnTrend && b[i].high >= ef[i] && b[i].close < ef[i] && b[i].close < b[i].open) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `with the ${p.f}-candle average above a rising ${p.s}-candle one, buy a dip that touches the fast average and closes back above it (the mirror to sell)`,
  },
  {
    id: 'btclead',
    name: 'Bitcoin leads, the coin catches up',
    family: 'relative',
    papers: ['gstw24', 'ltw22'],
    rationale: 'News reaches bitcoin first; with limited attention, other coins react late. When bitcoin has moved and a coin has not yet done its share (its usual beta to bitcoin), trade the coin in bitcoin’s direction. Published at horizons of minutes — on hourly candles most of it may already be gone, which the test shows.',
    grid: { n: [1, 4, 24], k: [1, 1.5] },
    needsBench: true,
    exit: { stopAtr: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const bm = benchFilled(c);
      const out = state(c.m.bars.length);
      const beta = benchBeta(c);
      if (!bm || !beta) return out;
      // a one-candle look-back is allowed here: the lead is a short-lived thing
      const n = Math.max(1, Math.round(p.n / c.m.tfH));
      const cl = close(c);
      const gap = new Float64Array(cl.length);
      const lead = new Float64Array(cl.length);
      for (let i = n; i < cl.length; i++) {
        const b = Number.isFinite(beta[i - n]) ? beta[i - n] : NaN;
        lead[i] = Math.log(bm[i] / bm[i - n]);
        const g = b * lead[i] - Math.log(cl[i] / cl[i - n]);
        gap[i] = Number.isFinite(g) ? g : 0;
      }
      const sd = rstd(gap, H(c, 168));
      for (let i = n + H(c, 168); i < cl.length; i++) {
        const z = sd[i - 1] > 0 ? gap[i] / sd[i - 1] : 0;
        // bitcoin moved and the coin lagged it (not: the coin moved alone)
        out[i] = z > p.k && lead[i] > 0 ? 1 : z < -p.k && lead[i] < 0 ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `when bitcoin has moved over ${hrs(p.n)} and the coin is more than ${p.k} standard deviations behind its usual share of that move, trade the coin in bitcoin's direction`,
  },
  {
    id: 'candle',
    name: 'Next-candle forecast',
    family: 'ml',
    papers: ['nis91', 'myr06', 'lsl12', 'bre01'],
    rationale: 'Candle shapes (bodies, wicks, where the close sat in the range, engulfing and hammer patterns) with GARCH volatility and momentum feed a forest that forecasts the next candle; it trades only when its odds are clear.',
    grid: { edge: [0.03, 0.06] },
    exit: { stopAtr: 1.5, targetR: 1.5, maxBars: 6, onFlip: true },
    compute: (c, p) => cached(c, `candle${p.edge}:${c.trainEnd}`, () => learnedSignal(c, { horizon: c.m.tfH, edge: p.edge }, 'rf')),
    describe: (p) => `a random forest on candle shapes, GARCH volatility and momentum forecasts the next candle; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
  {
    id: 'ols',
    name: 'Linear forecast (ridge regression)',
    family: 'ml',
    papers: ['gkx20', 'ks151'],
    rationale: 'A regression of the next return on momentum, reversal, volatility, volume, seasonality and funding combines weak predictors into one forecast (the linear analogue of the 151-strategies bitcoin ANN).',
    grid: { horizon: [4, 24], q: [0.5, 1] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `ols${p.horizon}:${p.q}:${c.trainEnd}`, () => learnedSignal(c, p, 'ols')),
    describe: (p) => `ridge regression of the next ${hrs(p.horizon)} return on ${FEATURES.length} features (momentum, volatility, GARCH, candle shapes, seasonality, funding); trade forecasts beyond ${p.q} standard deviations`,
  },
  {
    id: 'rf',
    name: 'Random-forest direction',
    family: 'ml',
    papers: ['bre01', 'gkx20'],
    rationale: 'Trees find nonlinear interactions between the same features (e.g. momentum only when volatility is low) that a linear forecast misses.',
    grid: { horizon: [4, 24], edge: [0.03, 0.06] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `rf${p.horizon}:${p.edge}:${c.trainEnd}`, () => learnedSignal(c, p, 'rf')),
    describe: (p) => `random forest (40 trees) on ${FEATURES.length} features forecasting the ${hrs(p.horizon)} direction; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
  {
    id: 'nn',
    name: 'Neural-network direction',
    family: 'ml',
    papers: ['gkx20', 'ks151', 'kb15'],
    rationale: 'A small neural network (two hidden layers) learns smooth nonlinear combinations of the same features — the model class Gu, Kelly and Xiu found best for return prediction; early stopping on the latest training data keeps it from memorising.',
    grid: { horizon: [4, 24], edge: [0.03, 0.06] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `nn${p.horizon}:${p.edge}:${p.h1 ?? 16}:${p.h2 ?? 8}:${c.trainEnd}`, () => learnedSignal(c, p, 'nn')),
    describe: (p) => `a neural network (${FEATURES.length} inputs, ${p.h1 ?? 16} and ${p.h2 ?? 8} hidden units) forecasting the ${hrs(p.horizon)} direction; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
  {
    id: 'squeeze',
    name: 'Volatility squeeze breakout',
    family: 'breakout',
    papers: ['bol01', 'cra90', 'boll86'],
    rationale: 'Volatility clusters and cycles: the quietest stretches are followed by expansions. When the bands are among the narrowest they have been in a long while (the narrowest fifth), the first close outside them is the start of the expansion — trade it in its direction and hold until price falls back through the average.',
    grid: { lookback: [20, 50, 100], squeeze: [120, 240, 480], k: [2, 2.5] },
    exit: { stopAtr: 2, maxBars: 120, onFlip: true },
    compute: (c, p) =>
      cached(c, `squeeze${H(c, p.lookback)}:${H(c, p.squeeze)}:${p.k}`, () => {
        const cl = close(c);
        const m = smaH(c, p.lookback);
        const sd = sdH(c, p.lookback);
        const n = cl.length;
        const w = H(c, p.squeeze);
        const arm = H(c, p.lookback);
        const out = state(n);
        // the band width as a share of the price, ranked against the squeeze window: squeezed when it is in the
        // narrowest fifth of what the window has seen
        const bw = Float64Array.from(cl, (_, i) => (m[i] > 0 && Number.isFinite(sd[i]) ? sd[i] / m[i] : NaN));
        const rank = pctRank(bw, w);
        let armedAt = -Infinity;
        let st = 0;
        for (let i = 0; i < n; i++) {
          if (rank[i] <= 0.2) armedAt = i;
          if (!Number.isFinite(m[i]) || !Number.isFinite(sd[i])) continue;
          if (st === 0 && i - armedAt <= arm) {
            if (cl[i] > m[i] + p.k * sd[i]) st = 1;
            else if (cl[i] < m[i] - p.k * sd[i]) st = -1;
          } else if ((st === 1 && cl[i] < m[i]) || (st === -1 && cl[i] > m[i])) st = 0;
          out[i] = st;
        }
        return out;
      }),
    describe: (p) => `after the ${p.k}σ bands of the ${hrs(p.lookback)} average have been among their narrowest fifth of the last ${hrs(p.squeeze).replace('-', ' ')}s, go with the first close outside them; out when price falls back through the average`,
  },
  {
    id: 'atrtrend',
    name: 'ATR trend line (Supertrend)',
    family: 'trend',
    papers: ['wil78', 'faith07', 'hu21'],
    rationale: 'A trend is intact until price gives back more than a few average true ranges from where it has been: the line trails price at k ATRs, only ever tightening, and the side flips when a close crosses it. It sits through ordinary pullbacks and leaves on an unusual reversal — a trend rule whose patience scales with the market’s own volatility.',
    grid: { n: [10, 20, 40], k: [2, 3, 4] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) =>
      cached(c, `atrtrend${H(c, p.n)}:${p.k}`, () => {
        const b = c.m.bars;
        const A = cached(c, `atr${H(c, p.n)}`, () => atr(b, H(c, p.n)));
        const out = state(b.length);
        let up = NaN;
        let dn = NaN;
        let dir = 0;
        for (let i = 0; i < b.length; i++) {
          if (!Number.isFinite(A[i])) continue;
          const mid = (b[i].high + b[i].low) / 2;
          const u = mid + p.k * A[i];
          const d = mid - p.k * A[i];
          // each band only tightens while price stays on its side
          up = !Number.isFinite(up) || u < up || b[i - 1].close > up ? u : up;
          dn = !Number.isFinite(dn) || d > dn || b[i - 1].close < dn ? d : dn;
          if (dir === 0) dir = b[i].close >= mid ? 1 : -1;
          else if (dir === 1 && b[i].close < dn) dir = -1;
          else if (dir === -1 && b[i].close > up) dir = 1;
          out[i] = dir;
        }
        return out;
      }),
    describe: (p) => `long while price holds above a line trailing ${p.k} ATRs (${hrs(p.n)}) below it, short while it holds below the line above; the side flips when a close crosses the line`,
  },
  {
    id: 'rsbtc',
    name: 'Relative strength against bitcoin',
    family: 'relative',
    papers: ['ltw22', 'dob23', 'flpwz25'],
    rationale: 'Coins that have beaten the market keep beating it for weeks, and laggards keep lagging — momentum in the cross-section of coins, one of the three factors that price crypto. Measured here against bitcoin: buy the coin that has outrun bitcoin by more than its usual wobble, sell the one that has fallen behind.',
    grid: { lookback: [168, 336, 720], k: [0.5, 1] },
    needsBench: true,
    exit: { stopAtr: 3, maxBars: 240, onFlip: true },
    compute: (c, p) =>
      cached(c, `rsbtc${H(c, p.lookback)}:${p.k}`, () => {
        const bm = benchFilled(c);
        const cl = close(c);
        const out = state(cl.length);
        if (!bm) return out;
        const n = H(c, p.lookback);
        // the coin's return over bitcoin's, bar by bar, and how much that usually wobbles
        const rel = Float64Array.from(cl, (x, i) => (i > 0 ? Math.log(x / cl[i - 1]) - Math.log(bm[i] / bm[i - 1]) : 0)).map((x) => (Number.isFinite(x) ? x : 0));
        const sd = rstd(rel, H(c, 720));
        let acc = 0;
        for (let i = 0; i < cl.length; i++) {
          acc += rel[i];
          if (i >= n) acc -= rel[i - n];
          if (i < n + 1 || !(sd[i] > 0)) continue;
          const z = acc / (sd[i] * Math.sqrt(n));
          out[i] = z > p.k ? 1 : z < -p.k ? -1 : 0;
        }
        return out;
      }),
    describe: (p) => `long the coin when it has beaten bitcoin over ${hrs(p.lookback).replace('-', ' ')}s by more than ${p.k} standard deviations of its usual gap, short when it has lagged by as much`,
  },
  // ---------- Candle Range Theory ----------
  {
    id: 'crt',
    name: 'Candle Range Theory: sweep of the last candle',
    family: 'reversion',
    papers: ['crt', 'osler03', 'osler05'],
    rationale: 'A higher-timeframe candle (4-hour or daily) leaves a range. When the next one runs past its high or low and closes back inside, the stops resting beyond were taken and no new buyers (or sellers) followed — price tends to travel to the other side of the range. Stop orders do cluster just beyond highs and lows, and their triggering moves price (Osler).' + CRT_NOTE,
    grid: { htf: [4, 24, 168], depth: [0, 0.25], ny: [0, 1], mode: [0, 1] },
    intraday: true,
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const out = state(b.length);
      if (c.m.tfH >= p.htf) return out;
      let u = -1;
      let pH = NaN;
      let pL = NaN;
      let cH = -Infinity;
      let cL = Infinity;
      let done = false;
      for (let i = 0; i < b.length; i++) {
        const v = htfKey(b[i].time, p.htf, p.ny ?? 0);
        if (v !== u) {
          // a new higher-timeframe candle: the one just finished is the range
          pH = v === u + 1 ? cH : NaN;
          pL = v === u + 1 ? cL : NaN;
          u = v;
          cH = -Infinity;
          cL = Infinity;
          done = false;
        }
        cH = Math.max(cH, b[i].high);
        cL = Math.min(cL, b[i].low);
        const a = A[i];
        if (done || !Number.isFinite(pH) || !(a > 0)) continue;
        if (p.mode === 1) {
          // the other style: a close beyond the last candle's range is the expansion — follow it
          if (b[i].close > pH + p.depth * a) {
            out[i] = 1;
            done = true;
          } else if (b[i].close < pL - p.depth * a) {
            out[i] = -1;
            done = true;
          }
          continue;
        }
        // swept above and closed back inside: short toward the low (and the mirror)
        if (cH > pH + p.depth * a && b[i].close < pH && b[i].close > pL) {
          out[i] = -1;
          done = true;
        } else if (cL < pL - p.depth * a && b[i].close > pL && b[i].close < pH) {
          out[i] = 1;
          done = true;
        }
      }
      return out;
    },
    describe: (p) => {
      const k = p.htf === 168 ? 'week' : p.htf === 24 ? 'day' : `${p.htf}-hour candle`;
      const clock = p.ny ? (p.htf === 168 ? ' (weeks from Monday 00:00 New York)' : p.htf === 24 ? ' (days from midnight New York)' : ' (candles from 01:00, 05:00, 09:00 New York)') : '';
      return p.mode === 1
        ? `when a ${k}${clock} closes beyond the last one's high${p.depth ? ` by ${p.depth} ATR or more` : ''}, buy the expansion (sell a close below its low)`
        : `when a ${k}${clock} runs past the last one's high${p.depth ? ` (by ${p.depth} ATR or more)` : ''} and closes back inside its range, sell toward its low (buy after a run below its low)`;
    },
  },
  {
    id: 'monday',
    name: 'The Monday range',
    family: 'reversion',
    papers: ['crt', 'cp19', 'osler05'],
    rationale: "Monday's high and low frame the week for many traders. A run beyond one of them later in the week that closes back inside is a false move — price tends to return across the range; a close beyond that holds is a real one, and runs. Monday is special in crypto returns (Caporale & Plastun)." + CRT_NOTE,
    grid: { mode: [0, 1] },
    exit: { stopAtr: 2, targetR: 2.5, maxBars: 72, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      let wk = -1;
      let mH = -Infinity;
      let mL = Infinity;
      let up = false;
      let dn = false;
      let usedL = false;
      let usedS = false;
      for (let i = 0; i < b.length; i++) {
        const day = new Date(b[i].time).getUTCDay();
        // the week starts on Monday 00:00 UTC (1 Jan 1970 was a Thursday)
        const w = Math.floor((b[i].time - 4 * 86_400_000) / (7 * 86_400_000));
        if (w !== wk) {
          wk = w;
          mH = -Infinity;
          mL = Infinity;
          up = dn = usedL = usedS = false;
        }
        if (day === 1) {
          mH = Math.max(mH, b[i].high);
          mL = Math.min(mL, b[i].low);
          continue;
        }
        if (!Number.isFinite(mH) || day === 0 || day === 6) continue;
        if (b[i].high > mH) up = true;
        if (b[i].low < mL) dn = true;
        if (p.mode === 0) {
          if (up && !usedS && b[i].close < mH && b[i].close > mL) {
            out[i] = -1;
            usedS = true;
          } else if (dn && !usedL && b[i].close > mL && b[i].close < mH) {
            out[i] = 1;
            usedL = true;
          }
        } else if (!usedL && !usedS) {
          if (b[i].close > mH) {
            out[i] = 1;
            usedL = true;
          } else if (b[i].close < mL) {
            out[i] = -1;
            usedS = true;
          }
        }
      }
      return out;
    },
    describe: (p) => (p.mode === 0 ? "Monday sets the range: from Tuesday, after a run past Monday's high (low) that closes back inside, trade back across the range" : 'Monday sets the range: from Tuesday, trade the first close beyond it, in its direction'),
  },
  // ---------- ICT ----------
  {
    id: 'sweep',
    name: 'Liquidity sweep (turtle soup)',
    family: 'reversion',
    papers: ['ict', 'osler03', 'osler05'],
    rationale: 'Stops sit just beyond obvious highs and lows. A candle that takes out the highest high of recent days and closes back below it has run those stops and found no follow-through — the move was the liquidity grab, and price tends to reverse.' + ICT_NOTE,
    grid: { lookback: [24, 72, 168] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const out = state(b.length);
      for (let i = 1; i < b.length; i++) {
        if (!Number.isFinite(hh[i]) || !Number.isFinite(ll[i])) continue;
        if (b[i].high > hh[i] && b[i].close < hh[i]) out[i] = -1;
        else if (b[i].low < ll[i] && b[i].close > ll[i]) out[i] = 1;
      }
      return out;
    },
    describe: (p) => `after a candle takes out the highest high of the last ${hrs(p.lookback)} and closes back below it, sell (buy after a sweep of the lowest low)`,
  },
  {
    id: 'fvg',
    name: 'Fair value gap retrace',
    family: 'trend',
    papers: ['ict', 'cs04'],
    rationale: 'A displacement — a candle so strong it leaves a gap between the candles either side of it — shows one-sided order flow (order imbalance predicts short-term returns: Chordia & Subrahmanyam). Price often comes back to the gap before carrying on; enter in the displacement\'s direction on that first return.' + ICT_NOTE,
    grid: { k: [0.3, 0.6], age: [12, 48] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { bull, bear } = fvgs(c, p.k);
      const maxAge = H(c, p.age);
      const out = state(b.length);
      let bu: { lo: number; hi: number; at: number } | null = null;
      let be: { lo: number; hi: number; at: number } | null = null;
      for (let i = 2; i < b.length; i++) {
        if (Number.isFinite(bull[i])) bu = { lo: bull[i], hi: b[i].low, at: i };
        if (Number.isFinite(bear[i])) be = { lo: b[i].high, hi: bear[i], at: i };
        if (bu && i > bu.at) {
          if (i - bu.at > maxAge || b[i].close < bu.lo) bu = null;
          else if (b[i].low <= bu.hi) {
            out[i] = 1;
            bu = null;
          }
        }
        if (be && i > be.at) {
          if (i - be.at > maxAge || b[i].close > be.hi) be = null;
          else if (b[i].high >= be.lo) {
            out[i] = -1;
            be = null;
          }
        }
      }
      return out;
    },
    describe: (p) => `after a displacement leaves a fair value gap (${p.k} ATR or wider), buy (sell) its first retrace into the gap within ${hrs(p.age)}`,
  },
  {
    id: 'mss',
    name: 'Market structure shift',
    family: 'reversion',
    papers: ['ict', 'osler05'],
    rationale: 'First the sweep: price runs below the lowest low of recent days, taking the stops there. Then the shift: it closes above the last swing high made before the sweep. The sellers have been absorbed and structure has turned — buy (and the mirror for shorts).' + ICT_NOTE,
    grid: { lookback: [24, 72], window: [6, 12] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const n = H(c, p.lookback);
      const w = H(c, p.window);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const out = state(b.length);
      let sl = -1;
      let sh = -1;
      let swingH = NaN;
      let swingL = NaN;
      for (let i = w + 1; i < b.length; i++) {
        // a sweep of the low: the swing high to beat is the highest of the bars before it
        if (Number.isFinite(ll[i]) && b[i].low < ll[i]) {
          sl = i;
          swingH = -Infinity;
          for (let j = i - w; j < i; j++) swingH = Math.max(swingH, b[j].high);
        }
        if (Number.isFinite(hh[i]) && b[i].high > hh[i]) {
          sh = i;
          swingL = Infinity;
          for (let j = i - w; j < i; j++) swingL = Math.min(swingL, b[j].low);
        }
        if (sl >= 0 && i > sl && i - sl <= w && b[i].close > swingH) {
          out[i] = 1;
          sl = -1;
        } else if (sh >= 0 && i > sh && i - sh <= w && b[i].close < swingL) {
          out[i] = -1;
          sh = -1;
        }
        if (sl >= 0 && i - sl > w) sl = -1;
        if (sh >= 0 && i - sh > w) sh = -1;
      }
      return out;
    },
    describe: (p) => `after a sweep of the ${hrs(p.lookback)} low, buy the first close above the swing high before it within ${hrs(p.window)} (and the mirror for shorts)`,
  },
  {
    id: 'silver',
    name: 'Silver Bullet',
    family: 'seasonal',
    papers: ['ict', 'emuw19'],
    rationale: "ICT's Silver Bullet: in three one-hour windows of the New York clock — 03:00 (London), 10:00 and 14:00 — the first fair value gap to form shows where price is being delivered, and is traded in its direction. Crypto's volume and volatility do peak around the European and US sessions (Eross et al.)." + ICT_NOTE,
    grid: { win: [0, 1, 2], k: [0.1, 0.3] },
    intraday: true,
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 8, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { bull, bear } = fvgs(c, p.k);
      const start = [3, 10, 14][p.win] ?? 10;
      const out = state(b.length);
      let day = -1;
      for (let i = 2; i < b.length; i++) {
        const t = b[i].time;
        const h = nyHour(t);
        if (h < start || h >= start + 1) continue;
        const d = Math.floor((t / 3_600_000 + nyOffset(t)) / 24);
        if (d === day) continue;
        if (Number.isFinite(bull[i])) {
          out[i] = 1;
          day = d;
        } else if (Number.isFinite(bear[i])) {
          out[i] = -1;
          day = d;
        }
      }
      return out;
    },
    describe: (p) => `in the ${['03:00–04:00', '10:00–11:00', '14:00–15:00'][p.win]} New York window, trade the first fair value gap (${p.k} ATR or wider) in its direction, once a day`,
  },
  {
    id: 'judas',
    name: 'London Judas swing (power of three)',
    family: 'reversion',
    papers: ['ict', 'emuw19', 'osler05'],
    rationale: "Power of three: the Asian hours build a range (accumulation), London makes a false run beyond one side of it (the manipulation, or Judas swing) and the day's real move goes the other way (distribution). When the London run closes back inside the Asian range, trade against it into New York." + ICT_NOTE,
    grid: { depth: [0, 0.2], mode: [0, 1] },
    intraday: true,
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 14, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const out = state(b.length);
      let day = -1;
      let aH = -Infinity;
      let aL = Infinity;
      let up = false;
      let dn = false;
      let used = false;
      for (let i = 0; i < b.length; i++) {
        const t = b[i].time;
        const d = Math.floor(t / 86_400_000);
        const h = new Date(t).getUTCHours();
        if (d !== day) {
          day = d;
          aH = -Infinity;
          aL = Infinity;
          up = dn = used = false;
        }
        // the Asian range: 00:00–06:00 UTC
        if (h < 6) {
          aH = Math.max(aH, b[i].high);
          aL = Math.min(aL, b[i].low);
          continue;
        }
        // London's false run: 06:00–11:00 UTC
        if (h >= 11 || used || !Number.isFinite(aH)) continue;
        const a = A[i];
        if (!(a > 0)) continue;
        if (p.mode === 1) {
          // the London breakout: the first close beyond the Asian range, followed
          if (b[i].close > aH + p.depth * a) {
            out[i] = 1;
            used = true;
          } else if (b[i].close < aL - p.depth * a) {
            out[i] = -1;
            used = true;
          }
          continue;
        }
        if (b[i].high > aH + p.depth * a) up = true;
        if (b[i].low < aL - p.depth * a) dn = true;
        if (up && b[i].close < aH && b[i].close > aL) {
          out[i] = -1;
          used = true;
        } else if (dn && b[i].close > aL && b[i].close < aH) {
          out[i] = 1;
          used = true;
        }
      }
      return out;
    },
    describe: (p) =>
      p.mode === 1
        ? `the Asian hours (00–06 UTC) set a range; trade London's first close beyond it${p.depth ? ` by ${p.depth} ATR or more` : ''} (06–11 UTC), in its direction`
        : `the Asian hours (00–06 UTC) set a range; when London runs past one side${p.depth ? ` by ${p.depth} ATR or more` : ''} and closes back inside, trade the other way into New York`,
  },
  // ---------- ICT, more of it ----------
  {
    id: 'ob',
    name: 'Order block retest',
    family: 'trend',
    papers: ['ict', 'cs04'],
    rationale: "A displacement that breaks structure leaves its order block — the last opposite-coloured candle before the move, where the large orders were filled. When price comes back to that candle, the rest of the orders are expected to be there: trade in the displacement's direction." + ICT_NOTE,
    grid: { k: [1, 1.5], age: [24, 72] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { bull, bear } = orderBlocks(c, p.k);
      const maxAge = H(c, p.age);
      const out = state(b.length);
      let L: { lo: number; hi: number; at: number } | null = null;
      let S: { lo: number; hi: number; at: number } | null = null;
      for (let i = 1; i < b.length; i++) {
        if (bull[i]) L = { ...bull[i]!, at: i };
        if (bear[i]) S = { ...bear[i]!, at: i };
        if (L && i > L.at) {
          if (i - L.at > maxAge || b[i].close < L.lo) L = null;
          else if (b[i].low <= L.hi) {
            out[i] = 1;
            L = null;
          }
        }
        if (S && i > S.at) {
          if (i - S.at > maxAge || b[i].close > S.hi) S = null;
          else if (b[i].high >= S.lo) {
            out[i] = -1;
            S = null;
          }
        }
      }
      return out;
    },
    describe: (p) => `after a displacement (a body of ${p.k} ATR or more that breaks the 12-hour high or low), trade the first return to its order block within ${hrs(p.age)}`,
  },
  {
    id: 'breaker',
    name: 'Breaker block',
    family: 'reversion',
    papers: ['ict', 'osler05'],
    rationale: 'An order block that fails — price closes through it — becomes a breaker: those who bought there are trapped and sell into the first return to it. Short the first rally back into a failed bullish order block (and the mirror).' + ICT_NOTE,
    grid: { k: [1, 1.5], age: [24, 72] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { bull, bear } = orderBlocks(c, p.k);
      const maxAge = H(c, p.age);
      const out = state(b.length);
      let L: { lo: number; hi: number; at: number; broke: number } | null = null;
      let S: { lo: number; hi: number; at: number; broke: number } | null = null;
      for (let i = 1; i < b.length; i++) {
        if (bull[i]) L = { ...bull[i]!, at: i, broke: -1 };
        if (bear[i]) S = { ...bear[i]!, at: i, broke: -1 };
        if (L && i > L.at) {
          if (i - L.at > maxAge) L = null;
          else if (L.broke < 0) {
            if (b[i].close < L.lo) L.broke = i;
          } else if (i > L.broke && b[i].high >= L.lo && b[i].close < L.hi) {
            out[i] = -1;
            L = null;
          }
        }
        if (S && i > S.at) {
          if (i - S.at > maxAge) S = null;
          else if (S.broke < 0) {
            if (b[i].close > S.hi) S.broke = i;
          } else if (i > S.broke && b[i].low <= S.hi && b[i].close > S.lo) {
            out[i] = 1;
            S = null;
          }
        }
      }
      return out;
    },
    describe: (p) => `an order block (displacement of ${p.k} ATR) that price closes through becomes a breaker: trade against it on the first return, within ${hrs(p.age)}`,
  },
  {
    id: 'ifvg',
    name: 'Inversion fair value gap',
    family: 'reversion',
    papers: ['ict', 'cs04'],
    rationale: 'A fair value gap that price closes straight through has failed: the imbalance has been overwhelmed by the other side, and the gap now acts the other way round — support turned resistance. Trade the first retest of the inverted gap.' + ICT_NOTE,
    grid: { k: [0.3, 0.6], age: [12, 48] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { bull, bear } = fvgs(c, p.k);
      const maxAge = H(c, p.age);
      const out = state(b.length);
      // a bullish gap closed through becomes a bearish zone, and the mirror
      let up: { lo: number; hi: number; at: number; inv: number } | null = null;
      let dn: { lo: number; hi: number; at: number; inv: number } | null = null;
      for (let i = 2; i < b.length; i++) {
        if (Number.isFinite(bull[i])) up = { lo: bull[i], hi: b[i].low, at: i, inv: -1 };
        if (Number.isFinite(bear[i])) dn = { lo: b[i].high, hi: bear[i], at: i, inv: -1 };
        if (up && i > up.at) {
          if (i - up.at > maxAge) up = null;
          else if (up.inv < 0) {
            if (b[i].close < up.lo) up.inv = i;
          } else if (i > up.inv && b[i].high >= up.lo && b[i].close < up.hi) {
            out[i] = -1;
            up = null;
          }
        }
        if (dn && i > dn.at) {
          if (i - dn.at > maxAge) dn = null;
          else if (dn.inv < 0) {
            if (b[i].close > dn.hi) dn.inv = i;
          } else if (i > dn.inv && b[i].low <= dn.hi && b[i].close > dn.lo) {
            out[i] = 1;
            dn = null;
          }
        }
      }
      return out;
    },
    describe: (p) => `a fair value gap (${p.k} ATR or wider) that price closes through flips sides: trade the first retest of it the other way, within ${hrs(p.age)}`,
  },
  {
    id: 'ote',
    name: 'Optimal trade entry (62–79 % retracement)',
    family: 'trend',
    papers: ['ict', 'osler03'],
    rationale: "After an impulse to a new high, ICT buys the pullback into the 62–79 % retracement of the leg (the 'optimal trade entry', a Fibonacci zone) for the leg to resume; the mirror after a new low." + ICT_NOTE,
    grid: { lookback: [24, 72], k: [2, 4] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const out = state(b.length);
      let up: { hi: number; lo: number; at: number } | null = null;
      let dn: { hi: number; lo: number; at: number } | null = null;
      for (let i = n; i < b.length; i++) {
        const a = A[i];
        if (!(a > 0)) continue;
        // a new high: the leg runs from the lowest low of the look-back to it
        if (b[i].high > hh[i] && b[i].high - ll[i] >= p.k * a) up = { hi: b[i].high, lo: ll[i], at: i };
        if (b[i].low < ll[i] && hh[i] - b[i].low >= p.k * a) dn = { hi: hh[i], lo: b[i].low, at: i };
        if (up && i > up.at) {
          const leg = up.hi - up.lo;
          if (i - up.at > n || b[i].low < up.lo || b[i].high > up.hi) up = null;
          else if (b[i].low <= up.hi - 0.62 * leg && b[i].close >= up.hi - 0.79 * leg) {
            out[i] = 1;
            up = null;
          }
        }
        if (dn && i > dn.at) {
          const leg = dn.hi - dn.lo;
          if (i - dn.at > n || b[i].high > dn.hi || b[i].low < dn.lo) dn = null;
          else if (b[i].high >= dn.lo + 0.62 * leg && b[i].close <= dn.lo + 0.79 * leg) {
            out[i] = -1;
            dn = null;
          }
        }
      }
      return out;
    },
    describe: (p) => `after an impulse of ${p.k} ATR or more to a new ${hrs(p.lookback)} high, buy the pullback into its 62–79 % retracement (sell the mirror after a new low)`,
  },
  {
    id: 'eqhl',
    name: 'Equal highs and lows swept',
    family: 'reversion',
    papers: ['ict', 'osler03', 'osler05'],
    rationale: 'Two swing highs at (nearly) the same price are an obvious pool of stops — ICT calls them engineered liquidity. A run above both that closes back below took the stops and found nobody: trade the reversal (and the mirror at equal lows).' + ICT_NOTE,
    grid: { lookback: [24, 72], tol: [0.1, 0.25] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const n = H(c, p.lookback);
      const { hi, lo } = pivots(c, 2);
      const out = state(b.length);
      const hs: [number, number][] = [];
      const ls: [number, number][] = [];
      let sh: number[] = [];
      let sl: number[] = [];
      let dirty = false;
      for (let i = 0; i < b.length; i++) {
        const before = hs.length + ls.length;
        if (Number.isFinite(hi[i])) hs.push([i, hi[i]]);
        if (Number.isFinite(lo[i])) ls.push([i, lo[i]]);
        let gone = 0;
        while (hs.length && hs[0][0] < i - n) gone += hs.shift() ? 1 : 0;
        while (ls.length && ls[0][0] < i - n) gone += ls.shift() ? 1 : 0;
        if (gone || hs.length + ls.length !== before) dirty = true;
        const a = A[i];
        if (!(a > 0)) continue;
        // the highest pair of near-equal highs, and the lowest pair of near-equal lows, in the window:
        // sorted, the best pair is always two neighbours, so one pass finds it (fast on 15-minute candles)
        if (dirty) {
          sh = hs.map((x) => x[1]).sort((x, y) => x - y);
          sl = ls.map((x) => x[1]).sort((x, y) => x - y);
          dirty = false;
        }
        let poolH = NaN;
        for (let x = sh.length - 1; x > 0; x--)
          if (sh[x] - sh[x - 1] <= p.tol * a) {
            poolH = sh[x];
            break;
          }
        let poolL = NaN;
        for (let x = 0; x + 1 < sl.length; x++)
          if (sl[x + 1] - sl[x] <= p.tol * a) {
            poolL = sl[x];
            break;
          }
        if (Number.isFinite(poolH) && b[i].high > poolH && b[i].close < poolH) {
          out[i] = -1;
          hs.length = 0;
          dirty = true;
        } else if (Number.isFinite(poolL) && b[i].low < poolL && b[i].close > poolL) {
          out[i] = 1;
          ls.length = 0;
          dirty = true;
        }
      }
      return out;
    },
    describe: (p) => `two swing highs within ${p.tol} ATR of each other in the last ${hrs(p.lookback)} are a pool of stops: after a run above both that closes back below, sell (buy the mirror at equal lows)`,
  },
  {
    id: 'nyrev',
    name: 'New York reversal of the London range',
    family: 'reversion',
    papers: ['ict', 'emuw19', 'osler05'],
    rationale: "London (02:00–07:00 New York) sets the day's range; New York (08:00–11:00) often runs one side of it and turns — the London high or low is the liquidity it was after. Fade a New York run that closes back inside the London range, or (the other style) follow a close beyond it." + ICT_NOTE,
    grid: { mode: [0, 1] },
    intraday: true,
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 10, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      let day = NaN;
      let lH = -Infinity;
      let lL = Infinity;
      let up = false;
      let dn = false;
      let used = false;
      for (let i = 0; i < b.length; i++) {
        const t = b[i].time;
        const d = Math.floor((t / 3_600_000 + nyOffset(t)) / 24);
        const h = nyHour(t);
        if (d !== day) {
          day = d;
          lH = -Infinity;
          lL = Infinity;
          up = dn = used = false;
        }
        if (h >= 2 && h < 7) {
          lH = Math.max(lH, b[i].high);
          lL = Math.min(lL, b[i].low);
          continue;
        }
        if (h < 8 || h >= 11 || used || !Number.isFinite(lH)) continue;
        if (p.mode === 0) {
          if (b[i].high > lH) up = true;
          if (b[i].low < lL) dn = true;
          if (up && b[i].close < lH && b[i].close > lL) {
            out[i] = -1;
            used = true;
          } else if (dn && b[i].close > lL && b[i].close < lH) {
            out[i] = 1;
            used = true;
          }
        } else if (b[i].close > lH) {
          out[i] = 1;
          used = true;
        } else if (b[i].close < lL) {
          out[i] = -1;
          used = true;
        }
      }
      return out;
    },
    describe: (p) => (p.mode === 0 ? 'London (02:00–07:00 New York) sets a range; when New York (08:00–11:00) runs past one side and closes back inside, trade the other way' : 'London (02:00–07:00 New York) sets a range; trade the first New York close beyond it (08:00–11:00), in its direction'),
  },
  {
    id: 'smt',
    name: 'SMT divergence against bitcoin',
    family: 'relative',
    papers: ['ict', 'ltw22'],
    rationale: "ICT's smart money technique: correlated markets should make new highs and lows together. When the coin closes at a new low and bitcoin does not, the coin's low was a stop run that the market did not confirm — buy (and the mirror). Crypto returns are driven by a common market factor, so a split is informative." + ICT_NOTE,
    grid: { lookback: [24, 72] },
    needsBench: true,
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      const bm = benchFilled(c);
      if (!bm) return out;
      const n = H(c, p.lookback);
      const cl = close(c);
      const lo = cached(c, `clo${n}`, () => extremePrev(cl, n, -1));
      const hi = cached(c, `chi${n}`, () => extremePrev(cl, n, 1));
      const blo = cached(c, `blo${n}`, () => extremePrev(bm!, n, -1));
      const bhi = cached(c, `bhi${n}`, () => extremePrev(bm!, n, 1));
      for (let i = n; i < b.length; i++) {
        if (!Number.isFinite(bm[i]) || !Number.isFinite(lo[i]) || !Number.isFinite(blo[i])) continue;
        if (cl[i] < lo[i] && bm[i] > blo[i]) out[i] = 1;
        else if (cl[i] > hi[i] && bm[i] < bhi[i]) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `when the coin closes at a new ${hrs(p.lookback)} low and bitcoin does not, buy (sell when the coin makes a new high that bitcoin does not)`,
  },
  // ---------- price action ----------
  {
    id: 'insidebar',
    name: 'Inside bar breakout',
    family: 'breakout',
    papers: ['cra90', 'cl98'],
    rationale: 'A candle inside the one before it (lower high, higher low) is the market pausing; the break of the mother candle shows who won. Range contraction before expansion is the basis of Crabel’s short-term patterns.' + CANDLE_NOTE,
    grid: { n: [1, 2] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 12, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      for (let i = p.n + 1; i < b.length; i++) {
        const m = b[i - p.n - 1];
        let inside = true;
        for (let j = i - p.n; j < i; j++) if (!(b[j].high <= m.high && b[j].low >= m.low)) inside = false;
        if (!inside) continue;
        if (b[i].close > m.high) out[i] = 1;
        else if (b[i].close < m.low) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `after ${p.n === 1 ? 'an inside candle' : `${p.n} inside candles`}, trade the first close beyond the mother candle, in its direction`,
  },
  {
    id: 'engulf',
    name: 'Engulfing candle at an extreme',
    family: 'reversion',
    papers: ['cl98', 'nis91'],
    rationale: "A candle whose body swallows the one before it, at the lowest point of recent days, shows the sellers' push absorbed and reversed in one candle — a classic reversal (and the mirror at a high)." + CANDLE_NOTE,
    grid: { lookback: [24, 72] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const out = state(b.length);
      for (let i = 2; i < b.length; i++) {
        const a = b[i - 1];
        const x = b[i];
        const lowHere = Math.min(a.low, x.low) <= ll[i - 1];
        const highHere = Math.max(a.high, x.high) >= hh[i - 1];
        if (lowHere && a.close < a.open && x.close > x.open && x.close >= a.open && x.open <= a.close) out[i] = 1;
        else if (highHere && a.close > a.open && x.close < x.open && x.close <= a.open && x.open >= a.close) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `a candle whose body engulfs the one before, at the lowest low of the last ${hrs(p.lookback)}: buy (the mirror at the high: sell)`,
  },
  {
    id: 'pinbar',
    name: 'Pin bar rejection',
    family: 'reversion',
    papers: ['cl98', 'nis91', 'osler05'],
    rationale: 'A candle with a long tail through the recent low and a small body near its high (a hammer, or pin bar) shows price pushed into the stops and rejected in the same candle — buy (and the mirror at a high).' + CANDLE_NOTE,
    grid: { r: [2, 3], lookback: [24, 72] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const out = state(b.length);
      for (let i = 1; i < b.length; i++) {
        const x = b[i];
        const body = Math.abs(x.close - x.open);
        const range = x.high - x.low;
        if (!(range > 0)) continue;
        const lower = Math.min(x.open, x.close) - x.low;
        const upper = x.high - Math.max(x.open, x.close);
        if (x.low < ll[i] && lower >= p.r * Math.max(body, range * 0.05) && lower >= 0.6 * range) out[i] = 1;
        else if (x.high > hh[i] && upper >= p.r * Math.max(body, range * 0.05) && upper >= 0.6 * range) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `a candle that pokes below the ${hrs(p.lookback)} low with a tail ${p.r}× its body and closes near its high: buy (the mirror at the high)`,
  },
  {
    id: 'nr',
    name: 'Narrow range breakout (NR4 / NR7)',
    family: 'breakout',
    papers: ['cra90'],
    rationale: 'The narrowest candle of the last four (NR4) or seven (NR7) is volatility at its quietest — Crabel’s range-contraction setup. Quiet is followed by movement: trade the first close beyond the narrow candle.',
    grid: { n: [4, 7] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 12, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      let at = -1;
      for (let i = p.n; i < b.length; i++) {
        const r = b[i - 1].high - b[i - 1].low;
        let narrow = r > 0;
        for (let j = i - p.n; j < i - 1; j++) if (b[j].high - b[j].low <= r) narrow = false;
        if (narrow) at = i - 1;
        if (at >= 0 && i - at <= 3) {
          if (b[i].close > b[at].high) {
            out[i] = 1;
            at = -1;
          } else if (b[i].close < b[at].low) {
            out[i] = -1;
            at = -1;
          }
        }
      }
      return out;
    },
    describe: (p) => `after the narrowest candle of the last ${p.n} (NR${p.n}), trade the first close beyond it within three candles`,
  },
  {
    id: 'round',
    name: 'Round-number rejection',
    family: 'reversion',
    papers: ['osler03'],
    rationale: 'Take-profit orders cluster at round numbers, and trends tend to stall and reverse there (Osler, on currency order books). A candle that pokes through a round level and closes back on the near side is fading against that wall of orders.',
    grid: { m: [5, 10] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const out = state(b.length);
      for (let i = 0; i < b.length; i++) {
        const x = b[i];
        if (!(x.close > 0)) continue;
        // the round step for this price: e.g. 500 or 1,000 for bitcoin near 60,000
        const step = 10 ** (Math.floor(Math.log10(x.close)) - 2) * p.m;
        const above = Math.ceil(Math.max(x.open, x.close) / step) * step;
        const below = Math.floor(Math.min(x.open, x.close) / step) * step;
        if (x.high > above && x.close < above && x.open < above) out[i] = -1;
        else if (x.low < below && x.close > below && x.open > below) out[i] = 1;
      }
      return out;
    },
    describe: (p) => `a candle that pokes through a round number (steps of ${p.m} in the price's third digit) and closes back below it: sell (the mirror below: buy)`,
  },
  {
    id: 'spring',
    name: 'Wyckoff spring and upthrust',
    family: 'reversion',
    papers: ['wyck', 'osler05'],
    rationale: "Wyckoff's spring: after a tight trading range (accumulation), price dips below the range's low, takes the stops, and closes back inside — the last shake-out before the markup. The upthrust is its mirror at the top of a range (distribution)." + WYCKOFF_NOTE,
    grid: { lookback: [24, 72], w: [4, 8] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const out = state(b.length);
      for (let i = n; i < b.length; i++) {
        const a = A[i - 1];
        if (!(a > 0) || !Number.isFinite(hh[i])) continue;
        // a tight range first: no wider than w ATR
        if (hh[i] - ll[i] > p.w * a) continue;
        if (b[i].low < ll[i] && b[i].close > ll[i]) out[i] = 1;
        else if (b[i].high > hh[i] && b[i].close < hh[i]) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `after a range no wider than ${p.w} ATR over ${hrs(p.lookback)}, buy a dip below its low that closes back inside (a spring); sell the mirror at its high (an upthrust)`,
  },
  // ---------- Smart Money Concepts ----------
  {
    id: 'bos',
    name: 'SMC break of structure (continuation)',
    family: 'trend',
    papers: ['smc', 'lmw00'],
    rationale: 'Smart Money Concepts read the trend from swing points: higher highs and higher lows are an uptrend. A close beyond the last swing high while the structure is already up is a break of structure — the trend carrying on: follow it (the mirror in a downtrend).' + SMC_NOTE,
    grid: { k: [2, 3, 5] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const { bos, trend } = structureOf(c, p.k);
      const out = state(c.m.bars.length);
      // a continuation needs a trend that was already there before this candle
      for (let i = 1; i < out.length; i++) if (bos[i] && trend[i - 1] === bos[i]) out[i] = bos[i];
      return out;
    },
    describe: (p) => `swing points ${p.k} candles either side: when the structure is up and a candle closes above the last swing high (a break of structure), buy — the mirror in a downtrend`,
  },
  {
    id: 'choch',
    name: 'SMC change of character (reversal)',
    family: 'reversion',
    papers: ['smc', 'lmw00'],
    rationale: 'The first close beyond the last swing high while the structure was down is a change of character — the first sign the sellers have lost control. Smart Money traders take the new direction from there (the mirror at a swing low in an uptrend).' + SMC_NOTE,
    grid: { k: [2, 3, 5] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const { choch } = structureOf(c, p.k);
      return Int8Array.from(choch);
    },
    describe: (p) => `swing points ${p.k} candles either side: when the structure is down and a candle closes above the last swing high (a change of character), buy — the mirror when an uptrend breaks its last swing low`,
  },
  {
    id: 'idm',
    name: 'SMC inducement sweep',
    family: 'trend',
    papers: ['smc', 'osler05'],
    rationale: 'After a break of structure, the first pullback leaves a small swing low — the inducement, where early buyers put their stops. Smart Money teaches that price takes those stops before the trend resumes: buy the candle that runs below the inducement and closes back above it (the mirror in a downtrend).' + SMC_NOTE,
    grid: { k: [2, 3], age: [24, 72] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const { bos, choch } = structureOf(c, p.k + 1);
      const { hi, lo } = pivots(c, p.k);
      const maxAge = H(c, p.age);
      const out = state(b.length);
      let dir = 0;
      let at = -1;
      let level = NaN;
      for (let i = 0; i < b.length; i++) {
        const brk = bos[i] || choch[i];
        if (brk) {
          dir = brk;
          at = i;
          level = NaN;
          continue;
        }
        if (!dir) continue;
        if (i - at > maxAge) {
          dir = 0;
          continue;
        }
        // the first minor swing after the break is the inducement
        if (!Number.isFinite(level)) {
          if (dir === 1 && Number.isFinite(lo[i])) level = lo[i];
          if (dir === -1 && Number.isFinite(hi[i])) level = hi[i];
          continue;
        }
        if (dir === 1 && b[i].low < level && b[i].close > level) {
          out[i] = 1;
          dir = 0;
        } else if (dir === -1 && b[i].high > level && b[i].close < level) {
          out[i] = -1;
          dir = 0;
        }
      }
      return out;
    },
    describe: (p) => `after a break of structure, the first small swing low (${p.k} candles either side) is the inducement: buy a candle that runs below it and closes back above, within ${hrs(p.age)} (the mirror after a break down)`,
  },
  {
    id: 'sdzone',
    name: 'Supply and demand zone retest',
    family: 'trend',
    papers: ['smc', 'osler03'],
    rationale: 'A base of small candles followed by a strong move leaves a demand zone (rally from a base) or a supply zone (drop from a base): orders were filled there faster than price could print. The first return to the base is bought (or sold), expecting the unfilled orders still to be waiting.' + SMC_NOTE,
    grid: { k: [1.5, 2.5], age: [48, 168] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 36, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const maxAge = H(c, p.age);
      const out = state(b.length);
      let D: { lo: number; hi: number; at: number } | null = null;
      let S: { lo: number; hi: number; at: number } | null = null;
      for (let i = 4; i < b.length; i++) {
        const a = A[i - 1];
        if (!(a > 0)) continue;
        // the base: one to three small candles (range under 0.6 ATR) right before a strong candle
        const body = b[i].close - b[i].open;
        if (Math.abs(body) >= p.k * a) {
          let lo = Infinity;
          let hi = -Infinity;
          let n = 0;
          for (let j = i - 1; j >= i - 3 && b[j].high - b[j].low < 0.6 * a; j--) {
            lo = Math.min(lo, b[j].low);
            hi = Math.max(hi, b[j].high);
            n++;
          }
          if (n) {
            if (body > 0) D = { lo, hi, at: i };
            else S = { lo, hi, at: i };
          }
          continue;
        }
        if (D && i > D.at + 1) {
          if (i - D.at > maxAge || b[i].close < D.lo) D = null;
          else if (b[i].low <= D.hi) {
            out[i] = 1;
            D = null;
          }
        }
        if (S && i > S.at + 1) {
          if (i - S.at > maxAge || b[i].close > S.hi) S = null;
          else if (b[i].high >= S.lo) {
            out[i] = -1;
            S = null;
          }
        }
      }
      return out;
    },
    describe: (p) => `a base of one to three small candles followed by a move of ${p.k} ATR or more is a demand (or supply) zone: trade the first return to it within ${hrs(p.age)}`,
  },
  // ---------- Wyckoff and volume spread ----------
  {
    id: 'wysos',
    name: 'Wyckoff sign of strength and last point of support',
    family: 'breakout',
    papers: ['wyck', 'beo94', 'kar87'],
    rationale: "After a tight trading range (accumulation), Wyckoff's sign of strength is a wide candle on heavy volume closing above the range: demand has overcome supply. Buy it — or (the other style) wait for the last point of support, the first pullback to the top of the range that holds. The mirror after distribution: the sign of weakness and the last point of supply." + VSA_NOTE,
    grid: { lookback: [48, 120], w: [5, 8], mode: [0, 1] },
    exit: { stopAtr: 1.5, targetR: 2.5, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const vz = cached(c, `vz${H(c, 48)}`, () => volZ(b, H(c, 48)));
      const out = state(b.length);
      let up: { top: number; at: number } | null = null;
      let dn: { bot: number; at: number } | null = null;
      for (let i = n; i < b.length; i++) {
        const a = A[i - 1];
        if (!(a > 0) || !Number.isFinite(hh[i])) continue;
        const tight = hh[i] - ll[i] <= p.w * a;
        const wide = b[i].high - b[i].low >= 1.2 * a;
        const heavy = vz[i] >= 1.5;
        if (tight && wide && heavy && b[i].close > hh[i]) {
          if (p.mode === 0) out[i] = 1;
          else up = { top: hh[i], at: i };
          continue;
        }
        if (tight && wide && heavy && b[i].close < ll[i]) {
          if (p.mode === 0) out[i] = -1;
          else dn = { bot: ll[i], at: i };
          continue;
        }
        if (up && i > up.at) {
          if (i - up.at > n || b[i].close < up.top - 0.5 * a) up = null;
          else if (b[i].low <= up.top + 0.3 * a && b[i].close > up.top) {
            out[i] = 1;
            up = null;
          }
        }
        if (dn && i > dn.at) {
          if (i - dn.at > n || b[i].close > dn.bot + 0.5 * a) dn = null;
          else if (b[i].high >= dn.bot - 0.3 * a && b[i].close < dn.bot) {
            out[i] = -1;
            dn = null;
          }
        }
      }
      return out;
    },
    describe: (p) =>
      p.mode === 0
        ? `after a range no wider than ${p.w} ATR over ${hrs(p.lookback)}, buy a wide candle on heavy volume that closes above it (a sign of strength); sell the mirror (a sign of weakness)`
        : `after a sign of strength out of a range of ${p.w} ATR or less over ${hrs(p.lookback)}, buy the first pullback to the top of the range that closes back above it (the last point of support); the mirror after a sign of weakness`,
  },
  {
    id: 'climax',
    name: 'Wyckoff selling and buying climax',
    family: 'reversion',
    papers: ['wyck', 'beo94', 'kar87'],
    rationale: 'A selling climax: at the end of a fall, a very wide candle on extreme volume at a new low — panic selling absorbed by large buyers. When a candle soon after closes above the climax candle (the automatic rally), the fall is likely over: buy. The mirror at a top is a buying climax.' + VSA_NOTE,
    grid: { lookback: [72, 168], v: [2, 3] },
    exit: { stopAtr: 2, targetR: 2, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const vz = cached(c, `vz${H(c, 48)}`, () => volZ(b, H(c, 48)));
      const out = state(b.length);
      let sc: { hi: number; at: number } | null = null;
      let bc: { lo: number; at: number } | null = null;
      for (let i = n; i < b.length; i++) {
        const a = A[i - 1];
        if (!(a > 0)) continue;
        const wide = b[i].high - b[i].low >= 1.8 * a;
        if (wide && vz[i] >= p.v && b[i].low < ll[i] && b[i].close < b[i].open) sc = { hi: b[i].high, at: i };
        else if (wide && vz[i] >= p.v && b[i].high > hh[i] && b[i].close > b[i].open) bc = { lo: b[i].low, at: i };
        else {
          if (sc && i - sc.at <= 3 && b[i].close > sc.hi) {
            out[i] = 1;
            sc = null;
          } else if (sc && i - sc.at > 3) sc = null;
          if (bc && i - bc.at <= 3 && b[i].close < bc.lo) {
            out[i] = -1;
            bc = null;
          } else if (bc && i - bc.at > 3) bc = null;
        }
      }
      return out;
    },
    describe: (p) => `a candle at a new ${hrs(p.lookback)} low, at least 1.8 ATR wide on volume ${p.v} standard deviations above normal, is a selling climax: buy when one of the next three candles closes above it (the mirror at a top)`,
  },
  {
    id: 'effort',
    name: 'Effort without result (stopping volume)',
    family: 'reversion',
    papers: ['wyck', 'beo94', 'kar87'],
    rationale: "Wyckoff's law of effort and result: heavy volume should move price. At a new low, a narrow candle on very heavy volume that closes in its upper half is effort without result — the selling is being absorbed (stopping volume). Buy it; the mirror at a high." + VSA_NOTE,
    grid: { lookback: [24, 72], v: [1.5, 2.5] },
    exit: { stopAtr: 1.5, targetR: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const b = c.m.bars;
      const A = atr14(c);
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const vz = cached(c, `vz${H(c, 48)}`, () => volZ(b, H(c, 48)));
      const out = state(b.length);
      for (let i = n; i < b.length; i++) {
        const a = A[i - 1];
        const r = b[i].high - b[i].low;
        if (!(a > 0) || !(r > 0) || !(vz[i] >= p.v) || r > 0.8 * a) continue;
        const pos = (b[i].close - b[i].low) / r;
        if (b[i].low < ll[i] && pos >= 0.5) out[i] = 1;
        else if (b[i].high > hh[i] && pos <= 0.5) out[i] = -1;
      }
      return out;
    },
    describe: (p) => `at a new ${hrs(p.lookback)} low, a narrow candle (under 0.8 ATR) on volume ${p.v} standard deviations above normal that closes in its upper half: buy (the mirror at a high)`,
  },
];

// ---------- the filters ----------

const allow = (n: number) => ({ long: new Uint8Array(n), short: new Uint8Array(n) });

export const FILTERS: FilterDef[] = [
  {
    id: 'trend',
    name: 'Long-term trend',
    papers: ['fab07', 'blr92'],
    rationale: 'Trade only with the long-term trend: longs above the long average, shorts below — the side with the drift behind it.',
    grid: { lookback: [200, 1200, 4800] },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const a = allow(cl.length);
      cl.forEach((x, i) => {
        a.long[i] = Number.isFinite(m[i]) && x > m[i] ? 1 : 0;
        a.short[i] = Number.isFinite(m[i]) && x < m[i] ? 1 : 0;
      });
      return a;
    },
    describe: (p) => `with the ${hrs(p.lookback)} trend`,
  },
  {
    id: 'volreg',
    name: 'Volatility regime',
    papers: ['mm17', 'bsc15'],
    rationale: 'High volatility does not pay more but crashes trend strategies; calm regimes trade, storms wait (or the reverse for breakouts that need movement).',
    grid: { mode: [0, 1], pct: [0.5, 0.8] },
    compute: (c, p) => {
      const v = cached(c, 'vol24', () => rvol(close(c), H(c, 24)));
      const r = cached(c, 'volrank', () => pctRank(v, H(c, 720)));
      const a = allow(v.length);
      r.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x < p.pct : x > 1 - p.pct);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when 1-day volatility is in the calmest ${p.pct * 100}% of the month` : `only when 1-day volatility is in the busiest ${p.pct * 100}% of the month`),
  },
  {
    id: 'garch',
    name: 'GARCH volatility regime',
    papers: ['boll86', 'mm17', 'hl05'],
    rationale: 'GARCH volatility above its long-run level marks a storm that tends to persist (and mean-revert slowly); trend rules suffer in it, breakouts need it.',
    grid: { mode: [0, 1], ratio: [0.8, 1, 1.25] },
    compute: (c, p) => {
      const gs = garchSigma(c);
      const g = garchOf(c);
      const lr = g ? Math.sqrt(g.longRun) : NaN;
      const a = allow(gs.length);
      gs.forEach((x, i) => {
        const r = Number.isFinite(lr) && lr > 0 ? x / lr : NaN;
        const ok = Number.isFinite(r) && (p.mode === 0 ? r < p.ratio : r > p.ratio);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when GARCH volatility is under ${p.ratio}× its long-run level (calm)` : `only when GARCH volatility is over ${p.ratio}× its long-run level (a storm)`),
  },
  {
    id: 'adx',
    name: 'Trend strength (ADX)',
    papers: ['wil78'],
    rationale: 'Trend rules need a trend and reversion rules need a range; ADX separates the two.',
    grid: { mode: [0, 1], level: [20, 25] },
    compute: (c, p) => {
      const d = cached(c, 'adx14', () => adx(c.m.bars, 14));
      const a = allow(d.length);
      d.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > p.level : x < p.level);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when ADX is above ${p.level} (trending)` : `only when ADX is below ${p.level} (ranging)`),
  },
  {
    id: 'volume',
    name: 'Participation',
    papers: ['beo94'],
    rationale: 'Signals on above-normal volume carry more information than signals in a quiet market.',
    grid: { k: [0, 0.5] },
    compute: (c, p) => {
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      const a = allow(vz.length);
      vz.forEach((x, i) => (a.long[i] = a.short[i] = x > p.k ? 1 : 0));
      return a;
    },
    describe: (p) => `only on volume ${p.k} standard deviations or more above normal`,
  },
  {
    id: 'session',
    name: 'Trading session',
    papers: ['bcgl19', 'wbxz22'],
    rationale: 'Liquidity and informed flow concentrate when the US and European markets are open; signals then are more reliable.',
    grid: { s: [0, 1] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        const h = new Date(b.time).getUTCHours();
        const ok = p.s === 0 ? h >= 13 && h < 21 : h >= 7 && h < 16;
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.s === 0 ? 'only in US hours (13–21 UTC)' : 'only in European hours (7–16 UTC)'),
  },
  {
    id: 'crowd',
    name: 'Funding crowding',
    papers: ['hmrw22', 'crszj23'],
    rationale: 'When one side pays heavily to hold, it is crowded: do not join it.',
    grid: { band: [0.2, 0.5] },
    needsFunding: true,
    compute: (c, p) => {
      const f = fundAnn(c, 24);
      const n = c.m.bars.length;
      const a = allow(n);
      for (let i = 0; i < n; i++) {
        const x = f ? f[i] : 0;
        a.long[i] = !Number.isFinite(x) || x < p.band ? 1 : 0;
        a.short[i] = !Number.isFinite(x) || x > -p.band ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `no longs when funding is above ${(p.band * 100).toFixed(0)}% a year, no shorts below −${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'btctrend',
    name: 'Bitcoin market trend',
    papers: ['ltw22', 'fab07'],
    rationale: 'Most of a coin’s move is the crypto market’s move, and bitcoin is the market: longs only while bitcoin is above its long average, shorts only while below. (On bitcoin itself this is its own trend.)',
    grid: { lookback: [1200, 4800] },
    usesBench: true,
    compute: (c, p) => {
      const px = benchFilled(c) ?? close(c);
      const m = sma(Float64Array.from(px, (x) => (Number.isFinite(x) ? x : 0)), H(c, p.lookback));
      const a = allow(px.length);
      const from = H(c, p.lookback);
      // the average needs a full window of real prices
      let seen = 0;
      for (let i = 0; i < px.length; i++) {
        seen = Number.isFinite(px[i]) ? seen + 1 : 0;
        const ok = seen >= from && Number.isFinite(m[i]);
        a.long[i] = ok && px[i] > m[i] ? 1 : 0;
        a.short[i] = ok && px[i] < m[i] ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `longs only while bitcoin is above its ${hrs(p.lookback)} average, shorts only while below`,
  },
  {
    id: 'weekday',
    name: 'Weekdays or weekends',
    papers: ['kp21', 'aq19', 'bcgl19'],
    rationale: 'Crypto trades all week but the money does not: at weekends volume and risk are lower and moves follow through less; at the start of the week volatility returns. Trend rules tend to want weekdays, dip-buying the quiet weekend.',
    grid: { mode: [0, 1] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        // the day the signal's trade would open on: the bar after this one
        const d = new Date(b.time + c.m.tfH * 3_600_000).getUTCDay();
        const weekend = d === 0 || d === 6;
        a.long[i] = a.short[i] = (p.mode === 0 ? !weekend : weekend) ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? 'only on weekdays (Monday to Friday, UTC)' : 'only at weekends (Saturday and Sunday, UTC)'),
  },
  {
    id: 'vratio',
    name: 'Variance-ratio regime',
    papers: ['lm88', 'hur51'],
    rationale: 'When daily moves are bigger than the sum of hourly ones would suggest (variance ratio above 1), moves persist and trends pay; below 1 they reverse and fading pays. Match the rule to the regime.',
    grid: { mode: [0, 1], window: [336, 720] },
    compute: (c, p) => {
      const vr = vrOf(c, p.window);
      const a = allow(vr.length);
      vr.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > 1.05 : x < 0.95);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only while moves persist: the ${hrs(p.window)} variance ratio of daily to hourly returns is above 1.05 (trending)` : `only while moves reverse: the ${hrs(p.window)} variance ratio is below 0.95 (mean-reverting)`),
  },
  {
    id: 'agree',
    name: 'Forecast agrees',
    papers: ['kal60', 'bre01', 'gkx20', 'nis91'],
    rationale: 'A second opinion: trade only in the direction a forecasting model also expects — the Kalman trend, or a model trained on the in-sample years (next-candle forest, ridge regression, random forest, neural network).',
    grid: { model: [0, 1, 2, 3, 4] },
    compute: (c, p) => {
      const n = c.m.bars.length;
      const a = allow(n);
      let dir: Int8Array;
      if (p.model === 4) dir = SIGNAL_MAP.nn.compute(c, { horizon: p.horizon > 0 ? p.horizon : 24, edge: 0, ...(p.h1 > 0 ? { h1: p.h1, h2: p.h2 > 0 ? p.h2 : Math.max(2, Math.round(p.h1 / 2)) } : {}) });
      else if (p.model === 3) {
        const kf = kalmanOf(c, 1);
        dir = Int8Array.from(kf.slope, (s) => sgn(s));
      } else if (p.model === 0) dir = SIGNAL_MAP.candle.compute(c, { edge: 0 });
      else if (p.model === 1) dir = SIGNAL_MAP.ols.compute(c, { horizon: 24, q: 0 });
      else dir = SIGNAL_MAP.rf.compute(c, { horizon: 24, edge: 0 });
      for (let i = 0; i < n; i++) {
        a.long[i] = dir[i] > 0 ? 1 : 0;
        a.short[i] = dir[i] < 0 ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `only when ${['the next-candle forest', 'the ridge-regression forecast', 'the random-forest forecast', 'the Kalman trend', p.h1 > 0 ? `the neural-network forecast (${p.h1} and ${p.h2 > 0 ? p.h2 : Math.max(2, Math.round(p.h1 / 2))} hidden units${p.horizon > 0 ? `, ${hrs(p.horizon)} ahead` : ''})` : 'the neural-network forecast'][p.model]} points the same way`,
  },
  {
    id: 'hurst',
    name: 'Hurst exponent regime',
    papers: ['hur51', 'lo91'],
    rationale: 'The Hurst exponent measures memory in returns: above 0.5 moves tend to continue (trend rules pay), below 0.5 they tend to reverse (fading pays). Rolling over the last month or two of bars.',
    grid: { mode: [0, 1] },
    compute: (c, p) => {
      const hs = hurstOf(c);
      const a = allow(hs.length);
      hs.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > 0.55 : x < 0.45);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? 'only while returns have memory: the rolling Hurst exponent is above 0.55 (trending)' : 'only while returns reverse: the rolling Hurst exponent is below 0.45 (mean-reverting)'),
  },
  {
    id: 'hmm',
    name: 'Hidden-Markov regime',
    papers: ['ham89', 'at12'],
    rationale: 'A two-state Markov-switching model, fitted in sample, reads the odds that the market is in its calm or its turbulent regime from the returns so far; strategies behave differently in each.',
    grid: { mode: [0, 1] },
    compute: (c, p) => {
      const hp = hmmProb(c);
      const a = allow(hp.length);
      hp.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x < 0.5 : x > 0.5);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? 'only in the calm regime (the hidden-Markov odds of turbulence under 50 %)' : 'only in the turbulent regime (the hidden-Markov odds of turbulence over 50 %)'),
  },
  // ---------- ICT and Candle Range Theory ----------
  {
    id: 'killzone',
    name: 'ICT kill zone',
    papers: ['ict', 'emuw19'],
    rationale: "ICT's kill zones are the hours of the New York clock when the big sessions open and price is delivered: London 02:00–05:00, New York 07:00–10:00 and the afternoon 13:30–16:00. Outside them signals are more often noise. Crypto's volume does concentrate in the European and US hours (Eross et al.)." + ICT_NOTE,
    grid: { z: [0, 1, 2, 3, 4] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      const zones: [number, number][] = p.z === 0 ? [[2, 5]] : p.z === 1 ? [[7, 10]] : p.z === 2 ? [[13.5, 16]] : p.z === 4 ? [[20, 24]] : [[2, 5], [7, 10], [13.5, 16]];
      c.m.bars.forEach((b, i) => {
        const h = nyHour(b.time);
        const ok = zones.some(([x, y]) => h >= x && h < y);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.z === 0 ? 'only in the London kill zone (02:00–05:00 New York)' : p.z === 1 ? 'only in the New York kill zone (07:00–10:00 New York)' : p.z === 2 ? 'only in the afternoon kill zone (13:30–16:00 New York)' : p.z === 4 ? 'only in the Asian kill zone (20:00–24:00 New York)' : 'only in the ICT kill zones (London, New York morning and afternoon)'),
  },
  {
    id: 'macro',
    name: 'ICT macro windows',
    papers: ['ict', 'emuw19'],
    rationale: "ICT's macros are short windows on the New York clock when, he teaches, the algorithm seeks liquidity: 02:33–03:00, 04:03–04:30, 08:50–09:10, 09:50–10:10, 10:50–11:10, 11:50–12:10, 13:10–13:40 and 15:15–15:45. A candle that overlaps one of them is allowed; on hourly candles this is close to the whole hour." + ICT_NOTE,
    grid: { set: [0, 1] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      // 0: every macro; 1: only the New York morning ones (08:50 to 11:10)
      const all: [number, number][] = [[2 + 33 / 60, 3], [4 + 3 / 60, 4.5], [8 + 50 / 60, 9 + 10 / 60], [9 + 50 / 60, 10 + 10 / 60], [10 + 50 / 60, 11 + 10 / 60], [11 + 50 / 60, 12 + 10 / 60], [13 + 10 / 60, 13 + 40 / 60], [15.25, 15.75]];
      const ws = p.set === 1 ? all.slice(2, 5) : all;
      c.m.bars.forEach((b, i) => {
        const h0 = nyHour(b.time);
        const h1 = h0 + c.m.tfH;
        const ok = ws.some(([x, y]) => h0 < y && h1 > x);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.set === 1 ? 'only in the New York morning macros (08:50–09:10, 09:50–10:10, 10:50–11:10 New York)' : 'only in the ICT macro windows of the New York clock'),
  },
  {
    id: 'pd',
    name: 'Premium and discount',
    papers: ['ict', 'osler03'],
    rationale: "Split the recent dealing range at its midpoint (equilibrium): below it price is at a discount, above it at a premium. Buy only at a discount and sell only at a premium — ICT's rule for not chasing. Take-profit orders do cluster at levels where price then tends to turn (Osler)." + ICT_NOTE,
    grid: { lookback: [24, 120, 480] },
    compute: (c, p) => {
      const b = c.m.bars;
      const n = H(c, p.lookback);
      const hh = cached(c, `hp${n}`, () => hiPrev(b, n));
      const ll = cached(c, `lp${n}`, () => loPrev(b, n));
      const a = allow(b.length);
      for (let i = 0; i < b.length; i++) {
        if (!Number.isFinite(hh[i]) || !Number.isFinite(ll[i])) continue;
        const eq = (hh[i] + ll[i]) / 2;
        a.long[i] = b[i].close < eq ? 1 : 0;
        a.short[i] = b[i].close > eq ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `longs only below the middle of the last ${hrs(p.lookback)} range (discount), shorts only above it (premium)`,
  },
  {
    id: 'bias',
    name: 'Bias from the open (day or week)',
    papers: ['crt', 'ict', 'cp19'],
    rationale: "Where price stands against today's (or this week's) opening price is the simplest higher-timeframe bias in ICT and Candle Range Theory: above the open the candle is bullish so far, below it bearish. Trade only with the candle that is forming." + CRT_NOTE,
    grid: { anchor: [0, 1, 2, 3, 4] },
    compute: (c, p) => {
      const b = c.m.bars;
      const a = allow(b.length);
      let key = NaN;
      let open = NaN;
      // 3 and 4: the colour of the last finished day (week) — the candle Candle Range Theory reads its bias from
      let lastClose = NaN;
      let prevDir = 0;
      for (let i = 0; i < b.length; i++) {
        const t = b[i].time;
        // 0 and 3: the UTC day, 1 and 4: the week from Monday 00:00 UTC, 2: the day from midnight in New York
        const k = p.anchor === 1 || p.anchor === 4 ? Math.floor((t - 4 * 86_400_000) / (7 * 86_400_000)) : p.anchor === 2 ? Math.floor((t / 3_600_000 + nyOffset(t)) / 24) : Math.floor(t / 86_400_000);
        if (k !== key) {
          // the candle just finished: its direction (only if it was the one right before)
          prevDir = k === key + 1 && Number.isFinite(open) ? sgn(lastClose - open) : 0;
          key = k;
          open = b[i].open;
        }
        lastClose = b[i].close;
        if (p.anchor >= 3) {
          a.long[i] = prevDir > 0 ? 1 : 0;
          a.short[i] = prevDir < 0 ? 1 : 0;
        } else {
          a.long[i] = b[i].close > open ? 1 : 0;
          a.short[i] = b[i].close < open ? 1 : 0;
        }
      }
      return a;
    },
    describe: (p) =>
      p.anchor === 3
        ? "only with yesterday's candle: longs after a green day, shorts after a red one"
        : p.anchor === 4
          ? "only with last week's candle: longs after a green week, shorts after a red one"
          : p.anchor === 1
            ? "only with the week's candle: longs above the weekly open, shorts below"
            : p.anchor === 2
              ? "only with the day's candle from midnight New York: longs above that open, shorts below"
              : "only with the day's candle: longs above the daily open (00:00 UTC), shorts below",
  },
  {
    id: 'structure',
    name: 'SMC market structure',
    papers: ['smc', 'lmw00'],
    rationale: 'Trade only with the market structure: longs while the last break was up (higher highs and higher lows), shorts while it was down — the first rule of Smart Money Concepts.' + SMC_NOTE,
    grid: { k: [3, 5, 10] },
    compute: (c, p) => {
      const { trend } = structureOf(c, p.k);
      const a = allow(trend.length);
      for (let i = 0; i < trend.length; i++) {
        a.long[i] = trend[i] === 1 ? 1 : 0;
        a.short[i] = trend[i] === -1 ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `only with the market structure (swing points ${p.k} candles either side): longs while it is up, shorts while it is down`,
  },
];

export const SIGNAL_MAP = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));
export const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

/** every combination of a parameter grid */
export function gridOf(g: Record<string, number[]>): Params[] {
  let out: Params[] = [{}];
  for (const [k, vs] of Object.entries(g)) out = out.flatMap((p) => vs.map((v) => ({ ...p, [k]: v })));
  return out;
}

export const logRet = logRets;

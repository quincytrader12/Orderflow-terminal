// Trend: time-series momentum with volatility targeting, on daily candles.
//
// This is the crypto strategy with the most consistent statistical backing:
// returns over the past weeks and months tend to continue (time-series
// momentum; Moskowitz, Ooi & Pedersen 2012 across asset classes, and in
// crypto Liu & Tsyvinski 2021, and later studies that net out costs). It does
// not predict tops or bottoms. It holds the coin while its trends are up,
// steps aside while they are down, and sizes so the swings stay bearable.
//
//   signal   three lookbacks (default 20, 60 and 120 days) each vote: up if
//            the close is above the close that many days ago. The share of
//            up votes is the trend strength — 0, ⅓, ⅔ or all in. An ensemble
//            of lookbacks instead of one tuned number keeps it from being
//            fitted to the past.
//   size     volatility targeting: exposure × targetVol ÷ realised volatility
//            (30 days), capped at maxExposure (1 = no leverage). Calm trends
//            get more, violent ones less.
//   trading  once per daily close, and only when the target differs from the
//            holding by more than the rebalance band, so fees stay small.
//
// Parameters are fixed in advance, not optimised on the data the backtest
// reports — the backtest is then an honest out-of-sample check.

const DAY = 86_400_000;

export const TREND_DEFAULTS = {
  trendL1: 20,
  trendL2: 60,
  trendL3: 120,
  volDays: 30,
  /** annualised volatility to aim for, % */
  targetVol: 40,
  /** most of the balance ever held in the coin (1 = all of it, no leverage) */
  maxExposure: 1,
  /** trade only when the target moves this many % of the balance away from the holding */
  rebalanceBand: 10,
  /** down votes go short (futures only); off = long or flat */
  trendShort: false,
};

/** Signal for the last closed candle of `closes` (oldest first). */
export function trendSignal(closes, cfg) {
  const c = { ...TREND_DEFAULTS, ...cfg };
  const n = closes.length;
  const looks = [c.trendL1, c.trendL2, c.trendL3];
  const need = Math.max(...looks, c.volDays) + 1;
  if (n < need) return { ready: false, need, have: n };
  const last = closes[n - 1];
  const votes = looks.map((L) => {
    const ret = last / closes[n - 1 - L] - 1;
    return { L, ret, vote: ret > 0 ? 1 : c.trendShort ? -1 : 0 };
  });
  const strength = votes.reduce((a, v) => a + v.vote, 0) / votes.length;
  // realised volatility of daily log returns, annualised (crypto trades every day)
  let s = 0;
  let s2 = 0;
  for (let i = n - c.volDays; i < n; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    s += r;
    s2 += r * r;
  }
  const mean = s / c.volDays;
  const vol = Math.sqrt(Math.max(0, s2 / c.volDays - mean * mean)) * Math.sqrt(365);
  const scale = vol > 0 ? Math.min(c.maxExposure, c.targetVol / 100 / vol) : 0;
  const exposure = Math.max(-c.maxExposure, Math.min(c.maxExposure, strength * scale));
  return { ready: true, votes, strength, vol, scale, exposure };
}

/** Plain-words reason for a signal. */
export function explainSignal(sig, symbol = '') {
  if (!sig.ready) return `building history: ${sig.have} of ${sig.need} daily closes`;
  const v = sig.votes.map((x) => `${x.L}d ${x.ret >= 0 ? '+' : ''}${(x.ret * 100).toFixed(1)}% ${x.vote > 0 ? '↑' : x.vote < 0 ? '↓' : '·'}`).join(', ');
  const up = sig.votes.filter((x) => x.vote > 0).length;
  const what = sig.exposure === 0 ? `out of ${symbol || 'the coin'}` : `${(Math.abs(sig.exposure) * 100).toFixed(0)}% of the balance ${sig.exposure > 0 ? 'long' : 'short'}`;
  return `${up}/3 trends up (${v}); volatility ${(sig.vol * 100).toFixed(0)}% a year → size ${sig.scale.toFixed(2)}× → ${what}`;
}

/**
 * Backtest on daily candles {time, open, close}: the signal is taken at each
 * close and traded at the next day's open, with fees on every rebalance.
 * Returns stats for the strategy and for simply holding the coin.
 */
export function backtestTrend(candles, cfg, { startUsd = 1000, feeBps = 10 } = {}) {
  const c = { ...TREND_DEFAULTS, ...cfg };
  const closes = candles.map((k) => k.close);
  const need = Math.max(c.trendL1, c.trendL2, c.trendL3, c.volDays) + 1;
  if (candles.length < need + 30) throw new Error(`need at least ${need + 30} daily candles, got ${candles.length}`);
  let cash = startUsd;
  let units = 0;
  let fees = 0;
  let trades = 0;
  let inMarket = 0;
  const equity = [];
  const hold = [];
  const first = candles[need].open;
  for (let i = need; i < candles.length; i++) {
    const k = candles[i];
    // trade at today's open on yesterday's closing signal
    const sig = trendSignal(closes.slice(0, i), c);
    const eqOpen = cash + units * k.open;
    const target = sig.ready ? sig.exposure : 0;
    const held = eqOpen > 0 ? (units * k.open) / eqOpen : 0;
    if (Math.abs(target - held) * 100 > c.rebalanceBand || (target === 0 && units !== 0)) {
      const wantUnits = (target * eqOpen) / k.open;
      const delta = wantUnits - units;
      const fee = (Math.abs(delta) * k.open * feeBps) / 1e4;
      cash -= delta * k.open + fee;
      units = wantUnits;
      fees += fee;
      trades++;
    }
    if (units !== 0) inMarket++;
    equity.push([k.time, cash + units * k.close]);
    hold.push([k.time, (startUsd * k.close) / first]);
  }
  const strat = curveStats(equity, startUsd);
  const bh = curveStats(hold, startUsd);
  return {
    strategy: { ...strat, trades, fees, timeInMarket: inMarket / equity.length },
    hold: bh,
    years: yearly(equity, hold),
    equity,
    holdCurve: hold,
    from: equity[0][0],
    to: equity[equity.length - 1][0],
    days: equity.length,
    config: c,
    feeBps,
    startUsd,
  };
}

/** CAGR, max drawdown, Sharpe and volatility of an equity curve [[t, value]]. */
export function curveStats(curve, start) {
  const end = curve[curve.length - 1][1];
  const years = (curve[curve.length - 1][0] - curve[0][0]) / (365 * DAY) || 1 / 365;
  let peak = start;
  let dd = 0;
  let s = 0;
  let s2 = 0;
  let prev = start;
  for (const [, v] of curve) {
    peak = Math.max(peak, v);
    dd = Math.max(dd, (peak - v) / peak);
    const r = prev > 0 ? v / prev - 1 : 0;
    s += r;
    s2 += r * r;
    prev = v;
  }
  const n = curve.length;
  const mean = s / n;
  const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  return {
    end,
    totalPct: (end / start - 1) * 100,
    cagrPct: end > 0 ? (Math.pow(end / start, 1 / years) - 1) * 100 : -100,
    maxDrawdownPct: dd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    volPct: sd * Math.sqrt(365) * 100,
  };
}

/** Return per calendar year, strategy and holding. */
function yearly(eq, hold) {
  const out = [];
  let y = null;
  let s0 = 0;
  let h0 = 0;
  let sPrev = eq[0][1];
  let hPrev = hold[0][1];
  for (let i = 0; i < eq.length; i++) {
    const yr = new Date(eq[i][0]).getUTCFullYear();
    if (yr !== y) {
      if (y !== null) out.push({ year: y, strategyPct: (sPrev / s0 - 1) * 100, holdPct: (hPrev / h0 - 1) * 100 });
      y = yr;
      s0 = i ? eq[i - 1][1] : eq[0][1];
      h0 = i ? hold[i - 1][1] : hold[0][1];
    }
    sPrev = eq[i][1];
    hPrev = hold[i][1];
  }
  out.push({ year: y, strategyPct: (sPrev / s0 - 1) * 100, holdPct: (hPrev / h0 - 1) * 100, partial: true });
  return out;
}

/**
 * Paper or live portfolio step: given the signal, the current holding and
 * price, the order (in coin units, + buy / − sell) that brings the holding
 * to the target — or null inside the rebalance band.
 */
export function rebalanceOrder(sig, { cash, units, price }, cfg, minNotional = 0) {
  const c = { ...TREND_DEFAULTS, ...cfg };
  const eq = cash + units * price;
  if (!(eq > 0) || !(price > 0)) return null;
  const target = sig.ready ? sig.exposure : 0;
  const held = (units * price) / eq;
  const exitAll = target === 0 && units !== 0;
  if (!exitAll && Math.abs(target - held) * 100 <= c.rebalanceBand) return null;
  const delta = (target * eq) / price - units;
  if (Math.abs(delta) * price < minNotional && !exitAll) return null;
  return { delta, target, held, equity: eq };
}

export { DAY };

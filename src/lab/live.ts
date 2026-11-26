// A deployed Lab strategy, live: read its signal on the latest closed candles
// and manage its open trade by its own exit rules — the same code paths the
// backtest used, so what was tested is what trades.
import { signalOf, sizeWeights, type StrategySpec } from './backtest';
import { atr14, ctxOf, features, FILTER_MAP, garchOf, garchSigma, SIGNAL_MAP, type Market } from './library';
import type { Bar } from './series';
import { metaOdds } from './ml';
import { rulesOf } from './research';

export interface Deployed {
  id: string;
  spec: StrategySpec;
  /** the timeframe it was researched on, in hours */
  tfH: number;
  coins: string[];
  /** where it runs */
  targets: { crypto: boolean; meme: boolean };
  /** the out-of-sample numbers it was deployed on */
  stats: { sharpe: number; t: number; dsr: number; trades: number; verdict: string; winRate?: number; avgR?: number; perYear?: number; maxDD?: number };
  deployedAt: number;
  on: boolean;
  authority?: 'council' | 'tested';
}

/** what the strategy health checks compare its live trades with: its test's win rate, average trade and pace */
export function testedStats(oos: { winRate?: number; avgR?: number; trades: number; bars?: number; maxDD?: number }, tfH: number) {
  const years = oos.bars ? oos.bars / ((24 * 365) / tfH) : 0;
  return { winRate: oos.winRate, avgR: oos.avgR, perYear: years > 0 ? oos.trades / years : undefined, maxDD: oos.maxDD };
}

export interface LiveSignal {
  side: 'buy' | 'sell';
  price: number;
  stop: number;
  target: number;
  atr: number;
  bar: number;
  /** the meta-labeller's odds that this signal wins, when it has one */
  odds: number | null;
  setup: string;
  why: string;
  /**
   * the strategy's own sizing, relative to its usual size: a volatility target
   * or VaR budget takes less risk in a storm (0.5–1.5 here; the swarm's risk
   * manager only ever applies it to make a trade smaller — it decides the size)
   */
  sizeMult: number;
}

/** what a strategy reads beside the coin's own candles: bitcoin's price, the funding history */
/** the rules that learn from the feature table (which reads a 30-day volatility, among others) */
const LEARNED = new Set(['nn', 'rf', 'ols', 'candle']);

export function specNeeds(spec: StrategySpec): { bench: boolean; funding: boolean; features: boolean } {
  const rules = [spec.signal, ...(spec.also ?? [])];
  return {
    // it reads the feature table: a learned rule, or the learned skip-this-signal model
    features: rules.some((r) => LEARNED.has(r.id)) || !!(spec.meta?.model || spec.meta?.nn),
    bench: rules.some((r) => SIGNAL_MAP[r.id]?.needsBench) || spec.filters.some((f) => FILTER_MAP[f.id]?.usesBench),
    funding: rules.some((r) => SIGNAL_MAP[r.id]?.needsFunding) || spec.filters.some((f) => FILTER_MAP[f.id]?.needsFunding),
  };
}

/**
 * The market a deployed strategy reads live: the coin's closed candles, with
 * bitcoin's closes lined up beside them (for the rules that trade a coin
 * against bitcoin) and the funding paid per candle (for the funding rules) —
 * the same shape the backtest gave it.
 */
export function liveMarket(coin: string, tfH: number, bars: Bar[], extra: { btc?: Bar[] | null; funding?: ArrayLike<number> | null } = {}): Market {
  const m: Market = { coin, tfH, bars, funding: extra.funding && extra.funding.length === bars.length ? Float64Array.from(extra.funding) : null };
  if (extra.btc?.length && !/^BTC/i.test(coin)) {
    const at = new Map(extra.btc.map((b) => [b.time, b.close]));
    m.bench = Float64Array.from(bars, (b) => at.get(b.time) ?? NaN);
  }
  return m;
}

/**
 * The strategy's call on the last closed bar: a new signal (one that switched
 * on at this bar), or null. Bars must be closed candles, oldest first.
 */
export function liveSignal(spec: StrategySpec, m: Market): LiveSignal | null {
  const n = m.bars.length;
  if (n < 60) return null;
  const c = ctxOf(m);
  const sig = signalOf(c, spec);
  const i = n - 1;
  const d = sig[i];
  if (!d || d === sig[i - 1]) return null;
  const a = atr14(c)[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  let odds: number | null = null;
  if (spec.meta?.model || spec.meta?.nn) {
    const row = [...features(c)[i], d];
    // a meta-labeller trained on a different set of inputs (an older version) is skipped, not misread
    if (row.every(Number.isFinite) && (spec.meta.nf === undefined ? row.length === 14 : row.length === spec.meta.nf)) {
      odds = metaOdds(spec.meta, row);
      if (odds < spec.meta.threshold) return null;
    }
  }
  const px = m.bars[i].close;
  const gs = garchSigma(c)[i];
  const risk = spec.exit.stopVol && Number.isFinite(gs) ? spec.exit.stopVol * gs * px : spec.exit.stopAtr * a;
  const g = garchOf(c);
  const volNote = g ? ` · GARCH σ next bar ${(gs * 100).toFixed(2)}% (long-run ${(Math.sqrt(g.longRun) * 100).toFixed(2)}%)` : '';
  // no target in the rules: the trade is managed by trail, time and flip; the
  // swarm still needs a level for its reward-to-risk, so 4R stands in
  const tR = spec.exit.targetR > 0 ? spec.exit.targetR : 4;
  const rule = rulesOf(spec, m.tfH)[0].replace(/^Entry: /, '');
  // tested sizing: today's weight against the weight at the long-run volatility
  let sizeMult = 1;
  let sizeNote = '';
  // both sizings scale as 1/σ: against the long-run σ, today's forecast sets the multiple
  if (sizeWeights(c, spec) && g && g.longRun > 0 && gs > 0) {
    sizeMult = Math.max(0.5, Math.min(1.5, Math.sqrt(g.longRun) / gs));
    sizeNote = ` · ${spec.sizing?.mode === 'vol' ? 'volatility target' : spec.sizing?.mode === 'kelly' ? 'Kelly sizing' : 'VaR budget'}: ${sizeMult.toFixed(2)}× usual size`;
  }
  // the coin's share of the money, as tested (the split across coins): over-weight coins are only ever capped by the swarm
  const cw = spec.coinWeights?.[m.coin];
  const nCoins = spec.coinWeights ? Object.keys(spec.coinWeights).length : 0;
  if (cw !== undefined && nCoins > 1) {
    const k = Math.max(0.25, Math.min(1.5, cw * nCoins));
    sizeMult *= k;
    sizeNote += ` · ${(cw * 100).toFixed(0)}% of the money on ${m.coin} (${k.toFixed(2)}× an equal share)`;
  }
  const hedgeNote = spec.hedge === 'btc' ? ' · tested with a bitcoin delta hedge (short β × the position in BTC): the swarm does not place hedges — place it yourself with TKT if you want the tested result' : '';
  return {
    side: d > 0 ? 'buy' : 'sell',
    price: px,
    stop: px - d * risk,
    target: px + d * tR * risk,
    atr: a,
    bar: m.bars[i].time,
    odds,
    setup: spec.name,
    why: `${rule}${odds !== null ? ` — ${spec.meta?.model && spec.meta?.nn ? 'the forest and the neural network give' : spec.meta?.nn ? 'the neural network gives' : 'the forest gives'} it ${(odds * 100).toFixed(0)}%` : ''}${volNote}${sizeNote}${hedgeNote}`,
    sizeMult,
  };
}

/** the strategy's current direction on the last closed bar (for "an opposite signal closes it") */
export function liveDirection(spec: StrategySpec, m: Market): number {
  if (m.bars.length < 60) return 0;
  const sig = signalOf(ctxOf(m), spec);
  return sig[sig.length - 1];
}

export interface LivePos {
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  risk: number;
  atr?: number;
  openedAt: number;
  trailed?: boolean;
}

/**
 * Manage an open Lab trade on a price tick with the strategy's exits: stop,
 * target (only if the rules have one), trailing from +1R, time limit.
 * Mutates pos.stop when trailing. Returns { exit } | { note } | null.
 */
export function manageLab(pos: LivePos, spec: StrategySpec, tfH: number, price: number, now: number): { exit: string } | { note: string } | null {
  const dir = pos.side === 'buy' ? 1 : -1;
  if ((price - pos.stop) * dir <= 0) return { exit: pos.trailed ? 'trail' : 'stop' };
  if (spec.exit.targetR > 0 && (price - pos.target) * dir >= 0) return { exit: 'target' };
  if (now - pos.openedAt >= spec.exit.maxBars * tfH * 3_600_000) return { exit: 'time' };
  const R = ((price - pos.entry) * dir) / pos.risk;
  if (spec.exit.trailAtr > 0 && pos.atr && R >= 1) {
    const t = price - dir * spec.exit.trailAtr * pos.atr;
    if ((t - pos.stop) * dir > pos.atr * 0.25) {
      pos.stop = t;
      const first = !pos.trailed;
      pos.trailed = true;
      if (first) return { note: `up ${R.toFixed(1)}R — trailing the stop ${spec.exit.trailAtr} ATR behind price, as the strategy's rules say` };
    }
  }
  return null;
}

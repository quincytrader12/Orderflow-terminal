import { describe, expect, it } from 'vitest';
import { backtestTrend, curveStats, explainSignal, rebalanceOrder, TREND_DEFAULTS, trendSignal } from './trend.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2020, 0, 1);

function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** Daily closes from a list of [days, daily drift] legs, with noise of `noise` (daily sd). */
function series(legs, noise = 0.02, seed = 3, start = 100) {
  const r = rng(seed);
  const out = [];
  let p = start;
  for (const [days, drift] of legs) {
    for (let i = 0; i < days; i++) {
      const z = (r() + r() + r() - 1.5) * 2; // ~N(0,1)
      p *= Math.exp(drift + noise * z);
      out.push(p);
    }
  }
  return out;
}
const candles = (closes) => closes.map((c, i) => ({ time: T0 + i * DAY, open: i ? closes[i - 1] : c, close: c }));

describe('trend signal', () => {
  it('needs enough history', () => {
    expect(trendSignal([1, 2, 3], {})).toMatchObject({ ready: false, need: 121, have: 3 });
  });

  it('three lookbacks vote; volatility sets the size, capped at no leverage', () => {
    const up = series([[200, 0.004]], 0.01);
    const s = trendSignal(up, { targetVol: 60 });
    expect(s.votes.map((v) => v.vote)).toEqual([1, 1, 1]);
    expect(s.strength).toBe(1);
    // calm uptrend: 60 % target ÷ ~19 % volatility → capped at 1 (all in, no leverage)
    expect(s.vol).toBeGreaterThan(0.1);
    expect(s.exposure).toBe(1);
    // the same trend twice as volatile gets a smaller position
    const wild = trendSignal(series([[200, 0.004]], 0.06), { targetVol: 60 });
    expect(wild.exposure).toBeLessThan(1);
    expect(wild.exposure).toBeCloseTo(Math.min(1, 0.6 / wild.vol) * wild.strength, 9);
  });

  it('is out in a downtrend (long or flat), short only when asked', () => {
    const down = series([[200, -0.004]], 0.01);
    expect(trendSignal(down, {}).exposure).toBe(0);
    expect(trendSignal(down, { trendShort: true }).exposure).toBe(-1);
  });

  it('partial trends give partial positions', () => {
    // long up-leg, then a month down: the 20-day vote turns, the longer ones do not
    const s = trendSignal(series([[170, 0.006], [25, -0.006]], 0.005), { targetVol: 1000 });
    expect(s.votes.map((v) => v.vote)).toEqual([0, 1, 1]);
    expect(s.exposure).toBeCloseTo(2 / 3, 9);
    expect(explainSignal(s, 'BTC')).toMatch(/^2\/3 trends up \(20d -\d+\.\d% ·, 60d \+\d+\.\d% ↑, 120d \+\d+\.\d% ↑\); volatility \d+% a year → size 1\.00× → 67% of the balance long$/);
  });
});

describe('trend backtest', () => {
  it('rides a bull market and steps aside in the crash: far smaller drawdown than holding', () => {
    const closes = series([[150, 0], [300, 0.006], [250, -0.008], [200, 0.001]], 0.03);
    const r = backtestTrend(candles(closes), {}, { startUsd: 1000, feeBps: 10 });
    expect(r.hold.maxDrawdownPct).toBeGreaterThan(80);
    expect(r.strategy.maxDrawdownPct).toBeLessThan(r.hold.maxDrawdownPct / 2);
    expect(r.strategy.end).toBeGreaterThan(r.hold.end);
    expect(r.strategy.trades).toBeGreaterThan(0);
    expect(r.strategy.fees).toBeGreaterThan(0);
    expect(r.years.length).toBeGreaterThanOrEqual(2);
  });

  it('trades at the next open, never on the close it has just seen', () => {
    // flat, then one huge up day: holding gains it; the strategy only learns of it at that close
    const closes = [...Array(130).fill(100), ...Array(40).fill(200)];
    const r = backtestTrend(candles(closes), { targetVol: 1000 }, { startUsd: 1000, feeBps: 0 });
    const day = (i) => r.equity[i - 121][1];
    expect(day(129)).toBe(1000); // flat before the jump
    expect(day(130)).toBe(1000); // not in for the jump itself
    expect(day(135)).toBeCloseTo(1000, 6); // in at the next open (200), no gain after
  });

  it('stays out of the market inside the rebalance band, and pays fees only when it trades', () => {
    const closes = series([[400, 0.003]], 0.01);
    const tight = backtestTrend(candles(closes), { rebalanceBand: 0 }, { feeBps: 10 });
    const loose = backtestTrend(candles(closes), { rebalanceBand: 25 }, { feeBps: 10 });
    expect(loose.strategy.trades).toBeLessThan(tight.strategy.trades);
    expect(loose.strategy.fees).toBeLessThan(tight.strategy.fees);
  });

  it('curve statistics', () => {
    const s = curveStats(
      [
        [0, 100],
        [365 * DAY, 200],
        [730 * DAY, 100],
      ],
      100,
    );
    expect(s.totalPct).toBe(0);
    expect(s.maxDrawdownPct).toBe(50);
  });
});

describe('rebalancing', () => {
  const sig = { ready: true, exposure: 0.6 };
  it('orders the difference to the target, outside the band only', () => {
    expect(rebalanceOrder(sig, { cash: 1000, units: 0, price: 100 }, TREND_DEFAULTS)).toMatchObject({ delta: 6, target: 0.6, held: 0, equity: 1000 });
    // holding 55 % against a 60 % target: inside the 10 % band
    expect(rebalanceOrder(sig, { cash: 450, units: 5.5, price: 100 }, TREND_DEFAULTS)).toBeNull();
    // a trend that ends sells everything, however small
    expect(rebalanceOrder({ ready: true, exposure: 0 }, { cash: 950, units: 0.5, price: 100 }, TREND_DEFAULTS)).toMatchObject({ delta: -0.5 });
    // below the exchange minimum: no order
    expect(rebalanceOrder(sig, { cash: 10, units: 0, price: 100 }, TREND_DEFAULTS, 20)).toBeNull();
  });
});

import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { ADAPTIVE_PRESET, GROWTH_PRESET, mergeConfig, ORDERFLOW_PRESET } from './engine.mjs';
import { ADAPTIVE_SEARCH, candidates, ORDERFLOW_SEARCH, pick, SEARCH, searchFor, segmentMetrics, train } from './train.mjs';

/** Deterministic pseudo-random numbers. */
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

/**
 * Repeating auctions: 40 minutes of balance around 100, then buyers probe
 * above value and fail, sellers push back inside, and price either rotates
 * to the POC (the fade works) or rips higher (it does not).
 */
function auctions(cycles, seed = 3) {
  const r = rng(seed);
  const rows = [];
  let t = Date.UTC(2026, 0, 5);
  const add = (p, side, q) => rows.push({ time: (t += 500), price: Number(p.toFixed(2)), qty: q, side });
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < 40 * 120; i++) add(100 + (r() + r() - 1) * 0.5, r() < 0.5 ? 'buy' : 'sell', 0.1 + r() * 0.2);
    for (let i = 0; i < 40; i++) add(100.2 + (0.12 * i) / 40, 'buy', 0.3);
    for (let i = 0; i < 40; i++) add(100.32 - (0.15 * i) / 40, 'sell', 0.6);
    const works = r() < 0.6;
    for (let i = 0; i < 120; i++) add(works ? 100.17 - (0.2 * i) / 120 : 100.17 + (0.5 * i) / 120, works ? 'sell' : 'buy', 0.3);
  }
  return rows;
}

describe('training', () => {
  it('searches distinct variations of the base settings, reproducibly', () => {
    const base = { ...GROWTH_PRESET };
    const a = candidates(base, 30, 5);
    const b = candidates(base, 30, 5);
    expect(a).toHaveLength(30);
    expect(a[0]).toEqual(mergeConfig(base));
    expect(a).toEqual(b);
    const keys = new Set(a.map((c) => JSON.stringify(Object.keys(SEARCH).map((k) => c[k]))));
    expect(keys.size).toBe(30);
    // only the searched knobs change; risk settings stay the user's
    for (const c of a) expect([c.riskPct, c.sizing, c.accountUsd, c.maxDrawdownPct]).toEqual([2, 'balance', 30, 20]);
  });

  it('scores growth net of fees with a drawdown penalty', () => {
    const m = segmentMetrics(
      [
        { pnl: 3, fees: 0.1 },
        { pnl: -2, fees: 0.1 },
        { pnl: 4, fees: 0.1 },
      ],
      100,
      3,
    );
    expect(m.growthPct).toBeCloseTo(5);
    expect(m.maxDrawdownPct).toBeCloseTo((2 / 103) * 100);
    expect(m.score).toBeCloseTo(Math.log(1.05) - 0.5 * (2 / 103));
    expect(segmentMetrics([{ pnl: 1, fees: 0 }], 100, 3).score).toBe(-Infinity); // too few trades to judge
  });

  it('ranks on the training data and only accepts what also grew on unseen data', () => {
    const r = (train, test, testPnl) => ({ train: { score: train }, test: { score: test, pnl: testPnl } });
    // the best on training lost money afterwards; the runner-up held up
    const { leaders, best } = pick([r(0.1, 0.0, 0), r(0.5, -0.2, -3), r(0.4, 0.05, 2), r(-Infinity, 1, 9)]);
    expect(leaders.map((l) => l.i)).toEqual([1, 2, 0]);
    expect(best.i).toBe(2);
    expect(pick([r(0.5, -0.1, -1), r(0.3, -0.2, -2)]).best).toBeNull();
  });

  it('runs end to end, identically on worker threads and in-process', async () => {
    const rows = auctions(30);
    // balance sizing on default filters, so most candidates trade on this market
    const base = { sizing: 'balance', accountUsd: 30, riskPct: 2, warmupMinutes: 30, useBook: false, feeBps: 2, slippageBps: 0, cooldownSec: 0, setups: { fade: true, breakout: false, reentry: false } };
    const inline = await train({ base, rows, n: 8, workers: 1, minTrades: 1 });
    const progress = [];
    const pooled = await train({
      base,
      rows,
      n: 8,
      workers: 3,
      minTrades: 1,
      onProgress: (f) => progress.push(f),
      makeWorker: () => new Worker(new URL('./trainWorker.mjs', import.meta.url)),
    });
    expect(pooled.searched).toBe(8);
    expect(pooled.count).toBe(rows.length);
    // the search really traded: several candidates took trades in both parts
    const traded = pooled.leaders.filter((l) => l.train.trades > 0 && l.test.trades > 0);
    expect(traded.length).toBeGreaterThan(0);
    expect(traded[0].train.trades + traded[0].test.trades).toBeGreaterThan(5);
    expect(progress.at(-1)).toBe(1);
    expect(pooled.leaders.map((l) => [l.train.trades, l.test.trades, l.train.pnl.toFixed(6)])).toEqual(inline.leaders.map((l) => [l.train.trades, l.test.trades, l.train.pnl.toFixed(6)]));
    expect(['verified', 'no-edge']).toContain(pooled.verdict);
    if (pooled.verdict === 'verified') expect(pooled.best.test.pnl).toBeGreaterThan(0);
    else expect(pooled.params).toBeNull();
  }, 120_000);

  it('refuses to train on too little data', async () => {
    await expect(train({ base: {}, rows: auctions(30).slice(0, 500) })).rejects.toThrow(/only 500 recorded trades/);
  });
});

describe('order-flow training', () => {
  it('searches the order-flow thresholds for order-flow bots', () => {
    expect(searchFor(mergeConfig(ORDERFLOW_PRESET))).toBe(ORDERFLOW_SEARCH);
    expect(searchFor(mergeConfig(GROWTH_PRESET))).toBe(SEARCH);
    expect(searchFor(mergeConfig(ADAPTIVE_PRESET))).toBe(ADAPTIVE_SEARCH);
    const c = candidates(mergeConfig(ORDERFLOW_PRESET), 10, 2, ORDERFLOW_SEARCH);
    expect(c).toHaveLength(10);
    for (const x of c.slice(1)) {
      expect(x.style).toBe('orderflow');
      expect(ORDERFLOW_SEARCH.absorbX).toContain(x.absorbX);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { Brain } from './brain.mjs';
import { ADAPTIVE_PRESET, AmtEngine, mergeConfig, paperFill } from './engine.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 10);

function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

function balance(from, seconds, mid, width, rand, perSec = 2) {
  const out = [];
  for (let t = from; t < from + seconds * 1000; t += 1000 / perSec) {
    const p = mid + (rand() + rand() - 1) * width;
    out.push({ t, p: Number(p.toFixed(2)), q: 0.1 + rand() * 0.2, s: rand() < 0.5 ? 'buy' : 'sell' });
  }
  return out;
}

function path(from, seconds, p0, p1, side, q = 1, perSec = 2) {
  const out = [];
  const n = seconds * perSec;
  for (let i = 0; i < n; i++) out.push({ t: from + (i * 1000) / perSec, p: Number((p0 + ((p1 - p0) * i) / Math.max(1, n - 1)).toFixed(2)), q, s: side });
  return out;
}

function run(e, trades) {
  const intents = [];
  for (const tr of trades) {
    for (const i of e.onTrade(tr)) {
      intents.push(i);
      paperFill(e, i);
    }
  }
  return intents;
}

const cfg = (extra = {}) => ({ ...mergeConfig(ADAPTIVE_PRESET), warmupMinutes: 5, useBook: false, feeBps: 2, slippageBps: 0, cooldownSec: 0, sizing: 'fixed', riskUsd: 10, maxPositionUsd: 1e6, ...extra });

/** A warmed-up adaptive engine: 10 minutes of rotation around 100.2. */
function warm(extra) {
  const e = new AmtEngine(cfg(extra));
  run(e, balance(T0, 600, 100.2, 0.1, rng(3)));
  return e;
}

/** Put the engine in a long as if it had just filled. */
function long(e, entry, stop, target, setup = 'sweep') {
  e.pos = { side: 'buy', entry, qty: 1, stop, target, stop0: stop, target0: target, setup, why: 'test', wall: null, t: e.now, fees: 0, risk: entry - stop, be: false };
}

describe('adaptive scalper — entries', () => {
  it('scores the evidence and puts the stop beyond the one-minute noise', () => {
    const e = warm({ stopNoiseX: 1.5 });
    const t1 = T0 + 10 * MIN;
    run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
    const intents = run(e, path(t1 + 8000, 8, 99.9, 100.12, 'buy', 1));
    expect(intents).toHaveLength(1);
    const i = intents[0];
    expect(i).toMatchObject({ type: 'enter', side: 'buy', setup: 'sweep' });
    const noise = e.brain.cache.noise;
    expect(noise).toBeGreaterThan(0);
    // the structure stop (beyond the 99.90 wick) was inside 1.5× the noise: moved out
    expect(i.price - i.stop).toBeCloseTo(1.5 * noise, 6);
    expect(i.stop).toBeLessThan(99.88);
    expect(i.reason).toMatch(/score \d/);
    expect(i.reason).toMatch(/rotating market/);
    expect(i.reason).toMatch(/stop moved from .* beyond the noise/);
    expect((i.target - i.price) / (i.price - i.stop)).toBeGreaterThanOrEqual(1.5 - 1e-9);
  });

  it('passes when the evidence does not agree', () => {
    const e = warm({ minScore: 9 });
    const t1 = T0 + 10 * MIN;
    run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
    expect(run(e, path(t1 + 8000, 8, 99.9, 100.12, 'buy', 1))).toEqual([]);
    expect(e.lastSkip.reason).toMatch(/not enough agreement \(score .*need 9\)/);
  });

  it('passes when the market is too quiet for the fees', () => {
    const e = warm({ feeBps: 20, stopCostX: 4 });
    const t1 = T0 + 10 * MIN;
    run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
    expect(run(e, path(t1 + 8000, 8, 99.9, 100.12, 'buy', 1))).toEqual([]);
    expect(e.lastSkip.reason).toMatch(/market too quiet/);
  });
});

describe('adaptive scalper — in the trade', () => {
  it('cuts a trade when the flow turns against it, well before the stop', () => {
    const e = warm();
    const t1 = T0 + 10 * MIN;
    long(e, 100.2, 100.0, 100.6);
    const out = run(e, path(t1, 12, 100.19, 100.12, 'sell', 1));
    expect(out).toHaveLength(1);
    const tr = e.trades.at(-1);
    expect(tr.reason).toBe('flow turned');
    expect(tr.exit).toBeGreaterThan(100.05); // lost well under 1R
    expect(e.brain.thoughts.at(-1).text).toMatch(/flow turned against the trade/);
  });

  it('holds when sellers hit a long but cannot move price (absorption, not danger)', () => {
    const e = warm();
    const t1 = T0 + 10 * MIN;
    long(e, 100.2, 100.0, 100.6);
    const hits = [];
    for (let i = 0; i < 30; i++) hits.push({ t: t1 + i * 500, p: i % 2 ? 100.19 : 100.2, q: 1, s: 'sell' });
    expect(run(e, hits)).toEqual([]);
    expect(e.pos).not.toBeNull();
  });

  it('gets out of a trade that stalls', () => {
    const e = warm({ stallSec: 60 });
    const t1 = T0 + 10 * MIN;
    long(e, 100.2, 100.0, 100.6);
    run(e, balance(t1, 120, 100.2, 0.03, rng(8)));
    const tr = e.trades.at(-1);
    expect(tr.reason).toBe('stalled');
    expect(tr.closed - tr.opened).toBeGreaterThanOrEqual(60_000);
    expect(tr.closed - tr.opened).toBeLessThan(75_000);
  });

  it('lets a winner run past its target while momentum lasts, then trails it', () => {
    const e = warm();
    const t1 = T0 + 10 * MIN;
    long(e, 100.2, 100.1, 100.3);
    run(e, path(t1, 40, 100.21, 100.7, 'buy', 1));
    expect(e.pos).not.toBeNull();
    expect(e.pos.extended).toBeGreaterThan(0);
    expect(e.pos.target).toBeGreaterThan(100.3);
    expect(e.brain.thoughts.some((x) => /letting it run/.test(x.text))).toBe(true);
    run(e, path(t1 + 40_000, 30, 100.69, 100.3, 'sell', 1));
    const tr = e.trades.at(-1);
    expect(['trail', 'momentum faded']).toContain(tr.reason);
    expect((tr.exit - tr.entry) / (tr.entry - tr.stop0)).toBeGreaterThan(1); // beyond the original 1R target
  });

  it('does not snap the stop to breakeven at 1R, where a normal wick would take it', () => {
    const e = warm();
    const t1 = T0 + 10 * MIN;
    const risk = e.brain.readMarket(e, e.now).noise; // a stop one noise-width wide
    long(e, 100.2, 100.2 - risk, 101);
    // +1.1R, a pause, then a normal wick back toward the entry
    run(e, path(t1, 10, 100.2, Number((100.2 + 1.1 * risk).toFixed(2)), 'buy', 0.3));
    run(e, balance(t1 + 10_000, 10, Number((100.2 + 1.05 * risk).toFixed(2)), 0.01, rng(4)));
    run(e, path(t1 + 20_000, 6, Number((100.2 + risk).toFixed(2)), 100.23, 'sell', 0.1));
    expect(e.pos).not.toBeNull();
    expect(e.pos.stop).toBeCloseTo(100.2 - risk, 6);
  });

  it('trails a trade that is well in profit, locking part of it in', () => {
    const e = warm();
    const t1 = T0 + 10 * MIN;
    long(e, 100.2, 100.0, 101);
    run(e, path(t1, 20, 100.2, 100.6, 'buy', 0.3));
    expect(e.pos.trailed).toBe(true);
    expect(e.pos.stop).toBeGreaterThan(100.25);
  });
});

describe('adaptive scalper — learning from exits', () => {
  const c = mergeConfig(ADAPTIVE_PRESET);
  const stopTrade = (t, setup = 'fade') => ({ side: 'buy', setup, entry: 100, exit: 99.8, qty: 1, pnl: -0.2, risk: 0.2, stop0: 99.8, target0: 100.4, reason: 'stop', opened: t - 30_000, closed: t });

  it('widens its stops after stop-outs that came straight back', () => {
    const b = new Brain(c);
    expect(b.noiseX).toBe(1);
    for (let k = 0; k < 2; k++) {
      const t = T0 + k * 10 * MIN;
      b.closed(stopTrade(t));
      b.afterExits(99.85, t + 10_000);
      b.afterExits(100.01, t + 40_000); // back to the entry: the stop was noise
    }
    expect(b.noiseX).toBe(1.25);
    expect(b.thoughts.at(-1).text).toMatch(/2 of the last 2 stop-outs were wicks/);
    // a real loss eases it back
    b.closed(stopTrade(T0 + 30 * MIN));
    b.afterExits(99.6, T0 + 40 * MIN);
    expect(b.noiseX).toBeCloseTo(1.15, 6);
  });

  it('becomes more patient when early exits keep missing the target', () => {
    const b = new Brain(c);
    for (let k = 0; k < 2; k++) {
      const t = T0 + k * 10 * MIN;
      b.closed({ ...stopTrade(t, 'breakout'), reason: 'stalled', exit: 99.98, pnl: -0.02 });
      b.afterExits(100.41, t + 60_000);
    }
    expect(b.patience).toBe(1.25);
    expect(b.thoughts.at(-1).text).toMatch(/went on to the target — cutting too soon/);
    b.closed({ ...stopTrade(T0 + 30 * MIN, 'breakout'), reason: 'flow turned', exit: 99.94, pnl: -0.06 });
    b.afterExits(99.79, T0 + 31 * MIN);
    expect(b.thoughts.at(-1).text).toMatch(/exit was right .* saved ~0.70R/);
  });

  it('benches a setup that keeps losing, and says why', () => {
    const e = warm();
    for (let k = 0; k < 4; k++) e.brain.closed({ ...stopTrade(T0 + k * MIN, 'sweep'), pnl: -0.21 });
    expect(e.brain.bench.get('sweep')).toBeTruthy();
    const v = e.brain.review(e, { side: 'buy', setup: 'sweep', stop: 100, target: 101, why: 'x' }, 100.2, T0 + 5 * MIN, null);
    expect(v.skip).toMatch(/sweep benched for \d+ more min — -4.20R over its last 4 trades/);
  });
});

describe('adaptive scalper — the bot', () => {
  it('runs every trigger over a long random market and reports its reasoning', () => {
    const rand = rng(11);
    const e = new AmtEngine({ ...mergeConfig(ADAPTIVE_PRESET), warmupMinutes: 5 });
    let mid = 100;
    const trades = [];
    for (let k = 0; k < 120; k++) {
      trades.push(...balance(T0 + k * MIN, 60, mid, 0.15, rand, 4));
      mid += (rand() - 0.5) * 0.3;
    }
    expect(() => run(e, trades)).not.toThrow();
    const s = e.snapshot();
    expect(s.style).toBe('adaptive');
    expect(s.brain).toMatchObject({ noiseX: 1, patience: 1 });
    expect(s.brain.noise).toBeGreaterThan(0);
    expect(['rotation', 'mixed', 'trend']).toContain(s.brain.regime.kind);
  });
});

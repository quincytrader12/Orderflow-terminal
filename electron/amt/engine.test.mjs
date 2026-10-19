import { describe, expect, it } from 'vitest';
import { AmtEngine, backtest, mergeConfig, niceBin, paperFill, valueArea } from './engine.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 10);

/** Deterministic pseudo-random numbers. */
function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** Balanced auction: prices peaked around `mid` (sum of two uniforms), two-sided flow. */
function balance(from, minutes, mid, width, rand, perSec = 2) {
  const out = [];
  for (let t = from; t < from + minutes * MIN; t += 1000 / perSec) {
    const p = mid + (rand() + rand() - 1) * width;
    out.push({ t, p: Number(p.toFixed(2)), q: 0.1 + rand() * 0.2, s: rand() < 0.5 ? 'buy' : 'sell' });
  }
  return out;
}

/** Straight path of prices with one aggressor side. */
function path(from, seconds, p0, p1, side, perSec = 2, q = 0.3) {
  const out = [];
  const n = seconds * perSec;
  for (let i = 0; i < n; i++) out.push({ t: from + (i * 1000) / perSec, p: Number((p0 + ((p1 - p0) * i) / n).toFixed(2)), q, s: side });
  return out;
}

/** Feed trades with instant paper fills; returns every intent. */
function run(engine, trades) {
  const intents = [];
  for (const tr of trades) {
    for (const i of engine.onTrade(tr)) {
      intents.push(i);
      paperFill(engine, i);
    }
  }
  return intents;
}

const base = { warmupMinutes: 30, useBook: false, feeBps: 2, slippageBps: 0, cooldownSec: 0 };

describe('profile maths', () => {
  it('rounds bins to 1/2/5 steps', () => {
    expect(niceBin(100, 2)).toBe(0.02);
    expect(niceBin(98_000, 2)).toBe(20);
    expect(niceBin(3_400, 1)).toBe(0.2);
    expect(niceBin(3_400, 1.5)).toBe(0.5);
  });

  it('finds POC and the 70% value area', () => {
    const bins = new Map([
      [1, 5],
      [2, 10],
      [3, 30],
      [4, 20],
      [5, 25],
      [6, 10],
    ]);
    // 100 total: POC 3, then 4 (20) vs 2 (10) → 4, then 5 (25) vs 2 → 5 → 75%
    expect(valueArea(bins, 70)).toEqual({ poc: 3, vah: 5, val: 3, total: 100 });
    expect(valueArea(new Map(), 70)).toBeNull();
  });

  it('accepts partial configs and ignores unknown or mistyped keys', () => {
    const c = mergeConfig({ riskUsd: 25, setups: { reentry: false }, bogus: 1, minRR: '3' });
    expect(c.riskUsd).toBe(25);
    expect(c.setups).toEqual({ fade: true, breakout: true, reentry: false });
    expect(c.minRR).toBe(1.5);
    expect('bogus' in c).toBe(false);
  });
});

describe('AMT setups', () => {
  it('warms up, then fades a rejected VAH probe back to POC', () => {
    const rand = rng(1);
    const e = new AmtEngine({ ...base, setups: { fade: true, breakout: false, reentry: false } });
    const warm = balance(T0, 40, 100, 0.5, rand);
    run(e, warm.slice(0, 100));
    expect(e.snapshot().state).toBe('warmup');
    expect(e.snapshot().warmupSec).toBeGreaterThan(29 * 60);
    run(e, warm.slice(100));
    expect(e.snapshot().position).toBeNull();
    const { va } = e.snapshot();
    expect(va.poc).toBeGreaterThan(99.9);
    expect(va.poc).toBeLessThan(100.1);
    expect(va.vah).toBeGreaterThan(100.15);
    let t = warm.at(-1).t + 500;
    // buyers probe above value and fail; sellers push back inside quickly
    const probe = path(t, 20, va.vah, va.vah + 0.12, 'buy');
    t += 20_000;
    const back = path(t, 20, va.vah + 0.12, va.vah - 0.03, 'sell', 2, 0.6);
    t += 20_000;
    const intents = run(e, [...probe, ...back]);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ type: 'enter', side: 'sell', setup: 'fade' });
    expect(intents[0].target).toBeCloseTo(va.poc, 6);
    expect(intents[0].stop).toBeGreaterThan(va.vah + 0.12);
    expect(e.snapshot().position.side).toBe('sell');
    // rotation back to POC takes profit
    const exit = run(e, path(t, 60, va.vah - 0.03, va.poc - 0.02, 'sell'));
    expect(exit).toEqual([expect.objectContaining({ type: 'exit', side: 'buy', reason: 'target' })]);
    const s = e.snapshot().stats;
    expect(s.trades).toBe(1);
    expect(s.wins).toBe(1);
    expect(s.pnl).toBeGreaterThan(0);
  });

  it('skips a fade when order flow does not confirm', () => {
    const rand = rng(2);
    const e = new AmtEngine({ ...base, setups: { fade: true, breakout: false, reentry: false } });
    run(e, balance(T0, 40, 100, 0.5, rand));
    const { va } = e.snapshot();
    let t = T0 + 40 * MIN;
    // price drifts back inside but buyers stay the aggressors
    const intents = run(e, [...path(t, 20, va.vah, va.vah + 0.12, 'buy'), ...path((t += 20_000), 20, va.vah + 0.12, va.vah - 0.03, 'buy')]);
    expect(intents).toEqual([]);
    expect(e.snapshot().lastSkip.reason).toMatch(/delta .* does not confirm/);
  });

  it('trades an accepted breakout with initiative volume and stops back inside value', () => {
    const rand = rng(3);
    const e = new AmtEngine({ ...base, setups: { fade: false, breakout: true, reentry: false }, acceptSec: 60 });
    run(e, balance(T0, 40, 100, 0.5, rand));
    const { va } = e.snapshot();
    let t = T0 + 40 * MIN;
    // heavy buying lifts price out of value and holds it there
    const intents = run(e, path(t, 90, va.vah + 0.05, va.vah + 0.25, 'buy', 6, 0.8));
    t += 90_000;
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ type: 'enter', side: 'buy', setup: 'breakout' });
    expect(intents[0].stop).toBeLessThan(va.vah);
    expect(intents[0].reason).toMatch(/accepted above VAH/);
    // the breakout fails: back into value hits the stop
    const out = run(e, path(t, 30, va.vah + 0.2, va.vah - 0.1, 'sell'));
    expect(out[0]).toMatchObject({ type: 'exit', reason: 'stop' });
    expect(e.snapshot().stats.losses).toBe(1);
  });

  it('applies the 80% rule after a session opens outside prior value', () => {
    const rand = rng(4);
    const e = new AmtEngine({ ...base, sessionHours: 1, warmupMinutes: 10, reentrySec: 300, setups: { fade: false, breakout: false, reentry: true } });
    const h = 3_600_000;
    const s1 = Math.floor(T0 / h) * h;
    // partial first session, then a full balanced session around 100
    run(e, balance(T0, 50, 100, 0.5, rand));
    run(e, balance(s1 + h, 60, 100, 0.5, rand));
    // next session opens above prior value, then falls back in and holds
    const s3 = s1 + 2 * h;
    run(e, path(s3, 60, 101, 100.9, 'buy'));
    const prior = e.snapshot().prior;
    expect(prior.vah).toBeGreaterThan(100.15);
    const intents = run(e, [...path(s3 + 60_000, 60, 100.9, prior.vah - 0.05, 'sell'), ...balance(s3 + 120_000, 7, prior.vah - 0.1, 0.03, rand)]);
    const entry = intents.find((i) => i.type === 'enter');
    expect(entry).toMatchObject({ side: 'sell', setup: 'reentry' });
    expect(entry.target).toBeCloseTo(prior.val, 6);
    expect(entry.reason).toMatch(/80% rule/);
  });
});

describe('risk controls', () => {
  it('sizes by risk, honours max position, cooldown and the hourly cap', () => {
    const e = new AmtEngine({ ...base, riskUsd: 10, maxPositionUsd: 50, maxTradesPerHour: 1 });
    e.now = T0;
    e.last = 100;
    e.bin = 0.02;
    e.t0 = T0 - 3_600_000;
    e.va = { vah: 100.3, val: 99.7, poc: 100 };
    e.probe = { dir: 1, ref: e.va, extreme: 100.5, outside: 120_000, lastT: T0, accepted: true, start: T0 - 120_000 };
    e.flow.add(T0 - 300_000, 10, true);
    e.flow.add(T0 - 500, 1000, true);
    const i = e.setup('accept-up', 100.5, T0);
    expect(i.qty).toBeCloseTo(50 / 100.5, 6); // $50 cap beats $10 risk / 0.34 stop
    paperFill(e, i);
    e.pending = { kind: 'exit', reason: 'test' };
    e.filled({ price: 100.4, qty: i.qty, fee: 0, t: T0 + 1 });
    e.now = T0 + 2;
    expect(e.setup('accept-up', 100.5, T0 + 2)).toBeNull();
    expect(e.lastSkip.reason).toMatch(/1 trades this hour/);
  });

  it('halts new entries after the daily loss limit', () => {
    const e = new AmtEngine({ ...base, maxDailyLossUsd: 20 });
    e.now = T0;
    e.pending = { kind: 'entry', side: 'buy', stop: 99, target: 103, setup: 'fade' };
    e.filled({ price: 100, qty: 20, fee: 0, t: T0 });
    expect(e.manage(98.5, T0 + 1000)).toMatchObject({ type: 'exit', reason: 'stop' });
    e.filled({ price: 98.5, qty: 20, fee: 0, t: T0 + 1000 });
    expect(e.halted).toMatch(/daily loss limit/);
    expect(e.gate('buy', null)).toMatch(/daily loss/);
  });

  it('moves the stop to breakeven after 1R and exits on time', () => {
    const e = new AmtEngine({ ...base, maxHoldSec: 60 });
    e.pending = { kind: 'entry', side: 'sell', stop: 101, target: 97, setup: 'fade' };
    e.filled({ price: 100, qty: 1, t: T0 });
    expect(e.manage(98.9, T0 + 1000)).toBeNull();
    expect(e.pos.be).toBe(true);
    expect(e.pos.stop).toBeLessThan(100);
    expect(e.manage(99.5, T0 + 2000)).toBeNull();
    expect(e.manage(100, T0 + 3000)).toMatchObject({ reason: 'breakeven' });
    e.pending = null;
    expect(e.manage(99.5, T0 + 61_000)).toMatchObject({ reason: 'time' });
  });

  it('blocks shorts when disabled and wide spreads when the book is used', () => {
    const e = new AmtEngine({ ...base, allowShort: false, useBook: true, maxSpreadBps: 3 });
    e.now = T0;
    expect(e.gate('sell', null)).toBe('shorts disabled');
    e.onBook([[99.9, 5]], [[100.1, 5]]);
    expect(e.gate('buy', e.bookStats())).toMatch(/spread 20.0 bps/);
  });

  it('backtests recorded trades end to end', () => {
    const rand = rng(9);
    const trades = [...balance(T0, 40, 100, 0.5, rand)];
    const va = { vah: 100.2 };
    let t = T0 + 40 * MIN;
    trades.push(...path(t, 90, 100.25, 100.5, 'buy', 6, 0.8));
    t += 90_000;
    trades.push(...path(t, 120, 100.5, 101.3, 'buy'));
    const r = backtest({ ...base, setups: { fade: false, breakout: true, reentry: false } }, trades);
    expect(r.count).toBe(trades.length);
    expect(r.stats.trades).toBeGreaterThanOrEqual(1);
    expect(r.trades[0]).toMatchObject({ side: 'buy', setup: 'breakout' });
    expect(r.equity.length).toBe(r.stats.trades);
    expect(va.vah).toBeLessThan(r.trades[0].entry);
  });
});

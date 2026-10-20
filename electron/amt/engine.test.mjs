import { describe, expect, it } from 'vitest';
import { AmtEngine, backtest, INTRADAY_PRESET, mergeConfig, niceBin, paperFill, valueArea } from './engine.mjs';

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
    expect(c.setups).toMatchObject({ fade: true, breakout: true, reentry: false, ibBreakout: true });
    expect(c.style).toBe('scalp');
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

describe('intraday style', () => {
  const H = 3_600_000;
  // 4-hour sessions keep the scenarios short; the defaults use 24 h
  const intra = { ...INTRADAY_PRESET, ...base, sessionHours: 4, ibMinutes: 30, ibAcceptMin: 10, priorAcceptMin: 20, priorRejectMin: 20, warmupMinutes: 20, minRR: 1.5, useBook: false, cooldownSec: 0 };
  const S0 = Math.ceil(T0 / (4 * H)) * 4 * H; // a session boundary

  it('starts from the preset: hours-long holds and session setups only', () => {
    const c = mergeConfig(INTRADAY_PRESET);
    expect(c).toMatchObject({ style: 'intraday', maxHoldSec: 28_800, minRR: 2 });
    expect(c.setups).toMatchObject({ fade: false, breakout: false, ibBreakout: true, priorAccept: true, priorReject: true });
  });

  it('trades an initial-balance extension and holds it to the IB-range target', () => {
    const rand = rng(21);
    const e = new AmtEngine({ ...intra, setups: { ...INTRADAY_PRESET.setups, priorAccept: false, priorReject: false, reentry: false } });
    // the IB forms in the first 30 minutes between ~99.5 and ~100.5
    run(e, balance(S0, 30, 100, 0.5, rand));
    const ib = e.snapshot().session.ib;
    expect(ib.done).toBe(false);
    expect(e.snapshot().state).toBe('ib-forming');
    // buyers extend above the IB high and hold there
    let t = S0 + 30 * MIN;
    const intents = run(e, path(t, 900, ib.high + 0.05, ib.high + 0.3, 'buy', 2, 0.4));
    t += 900_000;
    const entry = intents.find((i) => i.type === 'enter');
    expect(entry).toMatchObject({ side: 'buy', setup: 'ibBreakout' });
    expect(entry.target).toBeCloseTo(ib.high + (ib.high - ib.low), 6);
    expect(entry.stop).toBeLessThan(ib.high);
    expect(entry.reason).toMatch(/initial balance high extended/);
    // an hour later the extension reaches its target
    const out = run(e, path(t, 3600, ib.high + 0.3, ib.high + (ib.high - ib.low) + 0.1, 'buy', 1, 0.3));
    expect(out.find((i) => i.type === 'exit')).toMatchObject({ reason: expect.stringMatching(/target|trail/) });
    const tr = e.snapshot().trades[0];
    expect(tr.closed - tr.opened).toBeGreaterThan(30 * MIN);
    expect(tr.pnl).toBeGreaterThan(0);
  });

  it('goes with acceptance outside prior-day value and is flat before the session closes', () => {
    const rand = rng(22);
    const e = new AmtEngine({ ...intra, setups: { ...INTRADAY_PRESET.setups, ibBreakout: false, priorReject: false, reentry: false }, maxHoldSec: 24 * 3600 });
    // a partial session, then a full balanced session that becomes prior value
    run(e, balance(S0 - 2 * H, 120, 100, 0.5, rand));
    run(e, balance(S0, 240, 100, 0.5, rand, 1));
    const S1 = S0 + 4 * H;
    run(e, balance(S1, 10, 100, 0.3, rand, 1));
    const prior = e.snapshot().prior;
    expect(prior.vah).toBeGreaterThan(100);
    // price moves above prior VAH and is accepted there for 20+ minutes
    // held just above prior VAH (entering late after a big run would fail the R:R filter)
    const intents = run(e, path(S1 + 10 * MIN, 1800, prior.vah + 0.02, prior.vah + 0.08, 'buy', 1, 0.4));
    const entry = intents.find((i) => i.type === 'enter');
    expect(entry).toMatchObject({ side: 'buy', setup: 'priorAccept' });
    expect(entry.stop).toBeLessThan(prior.vah);
    expect(entry.target).toBeGreaterThanOrEqual(prior.vah + (prior.vah - prior.val) - 1e-9);
    // price drifts sideways for hours: the position is closed 15 min before the session ends
    const quiet = [];
    for (let t = S1 + 41 * MIN; t < S1 + 4 * H; t += 2000) quiet.push({ t, p: Number((prior.vah + 0.2 + rand() * 0.04).toFixed(2)), q: 0.2, s: rand() < 0.5 ? 'buy' : 'sell' });
    const out = run(e, quiet);
    const exit = out.find((i) => i.type === 'exit');
    expect(exit.reason).toBe('session close');
    const tr = e.snapshot().trades.at(-1);
    expect(tr.closed).toBeLessThan(S1 + 4 * H - 14 * MIN);
    expect(tr.closed - tr.opened).toBeGreaterThan(2 * H);
  });

  it('fades a failed probe of prior value back to the prior POC', () => {
    const rand = rng(23);
    const e = new AmtEngine({ ...intra, setups: { ...INTRADAY_PRESET.setups, ibBreakout: false, priorAccept: false, reentry: false } });
    run(e, balance(S0 - 2 * H, 120, 100, 0.5, rand));
    // a wider prior value area leaves room back to its POC
    run(e, balance(S0, 240, 100, 1.2, rand, 1));
    const S1 = S0 + 4 * H;
    run(e, balance(S1, 40, 100, 0.2, rand, 1));
    const prior = e.snapshot().prior;
    const t = S1 + 40 * MIN;
    const intents = run(e, [...path(t, 300, prior.vah, prior.vah + 0.1, 'buy', 1), ...path(t + 300_000, 300, prior.vah + 0.1, prior.vah - 0.02, 'sell', 1, 0.6)]);
    const entry = intents.find((i) => i.type === 'enter');
    expect(entry).toMatchObject({ side: 'sell', setup: 'priorReject' });
    expect(entry.target).toBeCloseTo(prior.poc, 6);
  });

  it('trails the stop to the developing session POC after 2R', () => {
    const e = new AmtEngine({ ...intra });
    e.now = S0 + H;
    e.rollSession(e.now, 100);
    e.sessionVa = { poc: 100.6, vah: 100.8, val: 100.2 };
    e.pending = { kind: 'entry', side: 'buy', stop: 99.5, target: 105, setup: 'ibBreakout' };
    e.filled({ price: 100, qty: 1, t: S0 + H });
    expect(e.manage(101.2, S0 + H + 1000)).toBeNull();
    expect(e.pos.stop).toBe(100.6);
    expect(e.manage(100.55, S0 + H + 2000)).toMatchObject({ reason: 'trail' });
  });
});

describe('audit regressions', () => {
  it('never moves the breakeven stop past the current price', () => {
    const e = new AmtEngine({ ...base, feeBps: 6, slippageBps: 1 });
    e.pending = { kind: 'entry', side: 'buy', stop: 99.92, target: 101, setup: 'fade' };
    e.filled({ price: 100, qty: 1, t: T0 });
    // +1R (0.08) is less than round-trip costs (14 bps = 0.14): keep the original stop
    expect(e.manage(100.08, T0 + 1000)).toBeNull();
    expect(e.pos.stop).toBe(99.92);
    expect(e.pos.be).toBe(false);
  });

  it('refuses setups whose stop is inside round-trip costs', () => {
    const e = new AmtEngine({ ...base, feeBps: 6, slippageBps: 1, minRR: 1 });
    Object.assign(e, { now: T0, last: 100, bin: 0.01, t0: T0 - 3_600_000, lastTradeT: T0 });
    e.probe = { dir: 1, ref: { vah: 99.99, val: 99.5, poc: 99.8 }, extreme: 100.01, outside: 120_000, lastT: T0, accepted: true, start: T0 };
    e.flow.add(T0 - 300_000, 10, true);
    e.flow.add(T0 - 500, 1000, true);
    expect(e.setup('accept-up', 100, T0)).toBeNull();
    expect(e.lastSkip.reason).toMatch(/inside round-trip costs/);
  });

  it('does not enter on a frozen price when trades stop arriving', () => {
    const rand = rng(31);
    const e = new AmtEngine({ ...base, setups: { fade: false, breakout: false, reentry: true }, sessionHours: 1, warmupMinutes: 10, reentrySec: 60 });
    const h = 3_600_000;
    const s1 = Math.floor(T0 / h) * h;
    run(e, balance(T0, 50, 100, 0.5, rand));
    run(e, balance(s1 + h, 60, 100, 0.5, rand));
    run(e, path(s1 + 2 * h, 30, 101, 100.1, 'sell'));
    // the feed dies inside prior value; only the wall clock moves
    const out = [];
    for (let k = 1; k <= 120; k++) out.push(...e.tick(s1 + 2 * h + 30_000 + k * 1000));
    expect(out.find((i) => i.type === 'enter')).toBeUndefined();
    expect(e.lastSkip.reason).toMatch(/market data stale/);
  });

  it('lifts the daily loss halt on the next UTC day', () => {
    const e = new AmtEngine({ ...base, maxDailyLossUsd: 5 });
    e.now = T0;
    e.pending = { kind: 'entry', side: 'buy', stop: 99, target: 103, setup: 'fade' };
    e.filled({ price: 100, qty: 10, t: T0 });
    e.pending = { kind: 'exit', reason: 'stop' };
    e.filled({ price: 99, qty: 10, t: T0 + 1000 });
    expect(e.gate('buy', null)).toMatch(/daily loss/);
    e.now = T0 + 86_400_000;
    expect(e.gate('buy', null)).toBeNull();
    expect(e.snapshot().stats.pnlToday).toBe(0);
  });
});

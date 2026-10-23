import { describe, expect, it } from 'vitest';
import { ADAPTIVE_PRESET, AmtEngine, backtest, mergeConfig, paperFill } from './engine.mjs';
import { roundTripBps } from './brain.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 10);

function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function balance(from, seconds, mid, width, rand, perSec = 2) {
  const out = [];
  for (let t = from; t < from + seconds * 1000; t += 1000 / perSec) out.push({ t, p: Number((mid + (rand() + rand() - 1) * width).toFixed(2)), q: 0.1 + rand() * 0.2, s: rand() < 0.5 ? 'buy' : 'sell' });
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
  for (const tr of trades) for (const i of e.onTrade(tr)) {
    intents.push(i);
    paperFill(e, i);
  }
  return intents;
}

/** A sweep & reclaim long, the same market as the order-flow tests. */
const cfg = (extra = {}) => ({ style: 'orderflow', warmupMinutes: 5, useBook: false, feeBps: 5, makerFeeBps: 2, slippageBps: 1, cooldownSec: 0, sizing: 'fixed', riskUsd: 10, maxPositionUsd: 1e6, targetCostX: 1, setups: { sweep: true, absorption: false, continuation: false, fade: false, breakout: false, reentry: false }, orderMode: 'maker', ...extra });
function toSignal(extra) {
  const e = new AmtEngine(cfg(extra));
  const t1 = T0 + 10 * MIN;
  run(e, balance(T0, 600, 100.2, 0.1, rng(3)));
  run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
  const intents = run(e, path(t1 + 8000, 5, 99.9, 100.06, 'buy', 1));
  return { e, intents, t: t1 + 13_000 };
}

describe('maker (limit) execution', () => {
  it('costs: maker entry + taker exit instead of taker both ways', () => {
    expect(roundTripBps(mergeConfig({ feeBps: 5, slippageBps: 1 }))).toBe(12);
    expect(roundTripBps(mergeConfig({ feeBps: 5, slippageBps: 1, orderMode: 'maker', makerFeeBps: 2 }))).toBe(8);
    expect(mergeConfig(ADAPTIVE_PRESET).orderMode).toBe('maker');
    expect(mergeConfig({}).orderMode).toBe('market');
  });

  it('rests a post-only limit on its own side and fills it when price trades through, at the maker fee', () => {
    const { e, intents, t } = toSignal();
    expect(intents).toHaveLength(1);
    const lim = intents[0];
    expect(lim).toMatchObject({ type: 'enter', order: 'limit', side: 'buy' });
    expect(e.snapshot().working).toMatchObject({ kind: 'entry', side: 'buy', price: lim.price });
    // a print at the limit is not enough (back of the queue); one through it is
    expect(run(e, [{ t: t + 500, p: lim.price, q: 1, s: 'sell' }])).toEqual([]);
    const out = run(e, [{ t: t + 1000, p: Number((lim.price - 0.01).toFixed(2)), q: 1, s: 'sell' }]);
    expect(out[0]).toMatchObject({ type: 'filled', kind: 'entry', price: lim.price });
    expect(e.pos).toMatchObject({ side: 'buy', entry: lim.price });
    expect(e.pos.fees).toBeCloseTo((lim.price * lim.qty * 2) / 1e4, 9);
  });

  it('takes it at market when the limit is missed but the trade still pays', () => {
    const { e, intents, t } = toSignal();
    const lim = intents[0];
    // price lifts away from the bid without trading back through it
    const out = run(e, path(t, 6, lim.price + 0.02, lim.price + 0.09, 'buy', 1));
    const c = out.find((i) => i.type === 'cancel');
    expect(c.reason).toMatch(/ran .*R away from the limit; still .*R to the target — taking it at market/);
    expect(c.then).toMatchObject({ type: 'enter', side: 'buy' });
    expect(e.pos).not.toBeNull();
    expect(e.pos.entry).toBeGreaterThan(lim.price);
  });

  it('lets it go rather than chase when the trade no longer pays at market', () => {
    const { e, intents, t } = toSignal({ minRR: 1.9, ofTargetR: 2 });
    const lim = intents[0];
    const out = run(e, path(t, 6, lim.price + 0.03, lim.price + 0.12, 'buy', 1));
    const c = out.find((i) => i.type === 'cancel');
    expect(c.then).toBeNull();
    expect(c.reason).toMatch(/letting it go, no chasing/);
    expect(e.pos).toBeNull();
    expect(e.pending).toBeNull();
  });

  it('a gap through the limit to the stop fills it and stops out — the stop is part of the plan', () => {
    const { e, intents, t } = toSignal({ makerChaseR: 9, makerWaitSec: 600 });
    const lim = intents[0];
    const out = run(e, [{ t: t + 1000, p: Number((lim.stop - 0.01).toFixed(2)), q: 1, s: 'sell' }]);
    expect(out[0]).toMatchObject({ type: 'filled', kind: 'entry' });
    expect(out[1]).toMatchObject({ type: 'exit', reason: 'stop' });
    expect(e.pos).toBeNull();
  });

  it('offers a target exit as a limit for a few seconds, then market; a stop is always market', () => {
    const { e, intents, t } = toSignal();
    const lim = intents[0];
    run(e, [{ t: t + 500, p: Number((lim.price - 0.01).toFixed(2)), q: 1, s: 'sell' }]);
    const target = e.pos.target;
    const atTarget = run(e, [{ t: t + 1000, p: Number((target + 0.01).toFixed(2)), q: 1, s: 'buy' }]);
    expect(atTarget[0]).toMatchObject({ type: 'exit', order: 'limit', reason: 'target' });
    // nobody lifts it: after exitMakerSec it goes at market
    const out = run(e, balance(t + 1500, 8, target, 0.001, rng(2)).map((x) => ({ ...x, p: Number(target.toFixed(2)) })));
    expect(out.find((i) => i.type === 'cancel').reason).toMatch(/target limit not filled in 6 s — out at market/);
    expect(e.pos).toBeNull();
    expect(e.trades.at(-1).reason).toBe('target');
    // stops never rest
    const s = toSignal();
    run(s.e, [{ t: s.t + 500, p: Number((s.intents[0].price - 0.01).toFixed(2)), q: 1, s: 'sell' }]);
    const stop = run(s.e, [{ t: s.t + 1000, p: Number((s.e.pos.stop - 0.01).toFixed(2)), q: 1, s: 'sell' }]);
    expect(stop[0]).toMatchObject({ type: 'exit', reason: 'stop' });
    expect(stop[0].order).toBeUndefined();
  });

  it('a filled target limit pays the maker fee on both sides', () => {
    const { e, intents, t } = toSignal();
    const lim = intents[0];
    run(e, [{ t: t + 500, p: Number((lim.price - 0.01).toFixed(2)), q: 1, s: 'sell' }]);
    const target = e.pos.target;
    const ex = run(e, [{ t: t + 1000, p: Number((target + 0.01).toFixed(2)), q: 1, s: 'buy' }])[0];
    run(e, [{ t: t + 1500, p: Number((ex.price + 0.01).toFixed(2)), q: 1, s: 'buy' }]);
    const tr = e.trades.at(-1);
    expect(tr.exit).toBe(ex.price);
    expect(tr.fees).toBeCloseTo(((lim.price + ex.price) * lim.qty * 2) / 1e4, 9);
  });

  it('breakout-type entries go at market unless limits are asked for on them too', () => {
    const e = new AmtEngine(cfg());
    e.last = 100;
    e.now = T0;
    const plan = { side: 'buy', stop: 99.5, target: 101.5, setup: 'breakout', why: 'x' };
    expect(e.enter('accept-up', plan, 100, T0, null)).toMatchObject({ type: 'enter', price: 100 });
    expect(e.pending.order).toBeUndefined();
    const f = new AmtEngine(cfg({ makerInitiative: true }));
    expect(f.enter('accept-up', plan, 100, T0, null)).toMatchObject({ type: 'enter', order: 'limit' });
    const g = new AmtEngine(cfg());
    expect(g.enter('reject-up', { ...plan, setup: 'fade' }, 100, T0, null)).toMatchObject({ order: 'limit' });
  });

  it('backtests and training run with maker execution end to end', () => {
    const rand = rng(11);
    const trades = [];
    let mid = 100;
    for (let k = 0; k < 90; k++) {
      trades.push(...balance(T0 + k * MIN, 60, mid, 0.15, rand, 4));
      mid += (rand() - 0.5) * 0.3;
    }
    const r = backtest({ ...mergeConfig(ADAPTIVE_PRESET), warmupMinutes: 5 }, trades);
    expect(r.stats.trades).toBeGreaterThanOrEqual(0);
  });
});

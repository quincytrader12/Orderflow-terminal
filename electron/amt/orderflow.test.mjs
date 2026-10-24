import { describe, expect, it } from 'vitest';
import { AmtEngine, mergeConfig, ORDERFLOW_PRESET, paperFill } from './engine.mjs';
import { BookTracker, stackedImbalances, Tape } from './orderflow.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 10);

function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** Two-sided rotation around `mid`. */
function balance(from, minutes, mid, width, rand, perSec = 2) {
  const out = [];
  for (let t = from; t < from + minutes * MIN; t += 1000 / perSec) {
    const p = mid + (rand() + rand() - 1) * width;
    out.push({ t, p: Number(p.toFixed(2)), q: 0.1 + rand() * 0.2, s: rand() < 0.5 ? 'buy' : 'sell' });
  }
  return out;
}

/** Straight line of prints from one aggressor side. */
function path(from, seconds, p0, p1, side, q = 1, perSec = 2) {
  const out = [];
  const n = seconds * perSec;
  for (let i = 0; i < n; i++) out.push({ t: from + (i * 1000) / perSec, p: Number((p0 + ((p1 - p0) * i) / Math.max(1, n - 1)).toFixed(2)), q, s: side });
  return out;
}

function run(e, trades, onEach) {
  const intents = [];
  for (const tr of trades) {
    onEach?.(tr);
    for (const i of e.onTrade(tr)) {
      intents.push(i);
      paperFill(e, i);
    }
  }
  return intents;
}

const only = (k) => ({ fade: false, breakout: false, reentry: false, ibBreakout: false, priorAccept: false, priorReject: false, absorption: k === 'absorption', continuation: k === 'continuation', sweep: k === 'sweep' });
const base = (setup, extra = {}) => ({ style: 'orderflow', warmupMinutes: 5, useBook: false, feeBps: 2, slippageBps: 0, cooldownSec: 0, sizing: 'fixed', riskUsd: 10, maxPositionUsd: 1e6, setups: only(setup), ...extra });

describe('order-flow building blocks', () => {
  it('finds stacked diagonal imbalances in a footprint bar', () => {
    // rows 10..14: buyers lift each row with sellers thin one row below
    const cells = new Map([
      [9, [2, 1]],
      [10, [1, 9]],
      [11, [1, 8]],
      [12, [1, 9]],
      [13, [4, 2]],
    ]);
    const runs = stackedImbalances(cells, 3, 3, 2);
    expect(runs).toEqual([{ dir: 1, lo: 10, hi: 12, n: 3 }]);
    // sellers: bid at k against ask at k+1
    const sells = new Map([
      [20, [9, 1]],
      [21, [9, 1]],
      [22, [9, 1]],
      [23, [1, 1]],
    ]);
    expect(stackedImbalances(sells, 3, 3, 2)).toEqual([{ dir: -1, lo: 20, hi: 22, n: 3 }]);
    expect(stackedImbalances(sells, 3, 4, 2)).toEqual([]);
  });

  it('keeps a per-second tape with a baseline and windows', () => {
    const tape = new Tape(600);
    for (let s = 0; s < 120; s++) tape.add(T0 + s * 1000, 100, 50, s % 2 === 0);
    tape.add(T0 + 120_000, 101, 500, true);
    tape.liquidation(T0 + 120_000, 101, 1000, 'buy');
    expect(tape.baseline()).toBeCloseTo((120 * 50 + 500) / 121, 6);
    const w = tape.window(T0 + 120_000, 1);
    expect(w).toMatchObject({ buy: 500, sell: 0, hi: 101, liqBuy: 1000, delta: 1 });
    const before = tape.window(T0 + 120_000, 11, 1);
    expect(before.n).toBe(10);
    expect(before.delta).toBe(0);
  });

  it('measures order-flow imbalance at the best bid/ask', () => {
    const b = new BookTracker();
    const cfg = mergeConfig(ORDERFLOW_PRESET);
    const book = (bq, aq) => [
      [
        [99.99, bq],
        [99.98, 1],
      ],
      [
        [100.01, aq],
        [100.02, 1],
      ],
    ];
    b.update(...book(1, 1), T0, cfg);
    b.update(...book(3, 1), T0 + 200, cfg); // bids join: +2
    b.update(...book(5, 1), T0 + 400, cfg); // +2
    expect(b.ofiRatio(T0 + 400, 10)).toBe(1);
    b.update(...book(5, 4), T0 + 600, cfg); // asks join: −3
    expect(b.ofiRatio(T0 + 600, 10)).toBeCloseTo(1 / 7, 6);
    expect(b.queue).toBeCloseTo((6 - 5) / 11, 6);
  });

  it('tracks walls: age, iceberg refills and pulls before contact', () => {
    const b = new BookTracker();
    const cfg = mergeConfig(ORDERFLOW_PRESET);
    const levels = (from, step, wallAt) => Array.from({ length: 15 }, (_, i) => [Number((from + step * i).toFixed(2)), Number((from + step * i).toFixed(2)) === wallAt ? 20 : 1]);
    const at = (t, wall) => b.update(levels(99.99, -0.01, wall), levels(100.01, 0.01, null), t, cfg);
    for (let s = 0; s <= 40; s++) at(T0 + s * 1000, 99.95);
    const w = b.wallNear('bid', 99.96, 0.03, T0 + 40_000, 30);
    expect(w).toMatchObject({ side: 'bid', price: 99.95, q: 20 });
    expect(b.wallNear('bid', 99.96, 0.03, T0 + 20_000, 30)).toBeNull(); // too young then
    // sellers hit it for more than it showed, and it is still there: iceberg
    for (let i = 0; i < 25; i++) b.onTrade(99.95, 1, false);
    at(T0 + 41_000, 99.95);
    expect(b.walls.get('bid99.95').hit).toBe(25);
    // pulled with price still above it
    b.onTrade(99.99, 1, false);
    at(T0 + 42_000, null);
    expect(b.standing({ side: 'bid', price: 99.95 })).toBe(false);
    expect(b.pulls.length).toBe(0); // it had traded more than it showed: consumed, not spoofed
    for (let s = 43; s <= 80; s++) at(T0 + s * 1000, 99.93);
    b.onTrade(99.99, 1, false);
    at(T0 + 81_000, null);
    expect(b.pulledSince({ side: 'bid', price: 99.93 }, T0 + 50_000)).toBe(true);
  });
});

describe('order-flow hybrid setups', () => {
  it('starts from the preset with only the three order-flow setups and balance sizing', () => {
    const c = mergeConfig(ORDERFLOW_PRESET);
    expect(c.style).toBe('orderflow');
    expect(c.sizing).toBe('balance');
    expect(c.setups).toMatchObject({ absorption: true, continuation: true, sweep: true, fade: false, breakout: false, reentry: false });
    expect(new AmtEngine(c).of).not.toBeNull();
    expect(new AmtEngine({}).of).toBeNull();
  });

  it('sweep & reclaim: a round number run on a burst, then reclaimed → long', () => {
    const rand = rng(3);
    const e = new AmtEngine(base('sweep'));
    const t1 = T0 + 10 * MIN;
    expect(run(e, balance(T0, 10, 100.2, 0.1, rand))).toEqual([]);
    // sellers run the 100.00 round number on a burst
    expect(run(e, path(t1, 8, 100.15, 99.9, 'sell', 2))).toEqual([]);
    expect(e.of.sweep).toMatchObject({ dir: -1, level: { price: 100, kind: 'round number' } });
    // and price is back above it within seconds, buyers in control
    // a poke back above the level is not enough: the reclaim has to hold
    expect(run(e, path(t1 + 8000, 8, 99.9, 100.12, 'buy', 1))).toEqual([]);
    expect(e.of.sweep.backSince).not.toBeNull();
    const intents = run(e, path(t1 + 16_000, 12, 100.12, 100.14, 'buy', 0.5));
    expect(intents).toHaveLength(1);
    const i = intents[0];
    expect(i).toMatchObject({ type: 'enter', side: 'buy', setup: 'sweep' });
    // beyond the wick by at least half the one-minute range
    expect(i.stop).toBeLessThanOrEqual(99.9 - Math.max(2 * e.bin, 0.5 * e.of.noise()) + 1e-9);
    expect(i.target).toBeGreaterThan(i.price);
    expect(i.reason).toMatch(/swept the round number 100 .*reclaim held 1\d s, selling back to 0\.\d× normal, no liquidations for 10 s/);
  });

  describe('sweep: the run has to be over before it is faded (the Oct 23–24 trades)', () => {
    const setUp = (extra = {}) => {
      const e = new AmtEngine(base('sweep', extra));
      run(e, balance(T0, 10, 100.2, 0.1, rng(3)));
      return { e, t1: T0 + 10 * MIN };
    };
    /** run trades, with forced sells (long liquidations) of `liqUsd` every second */
    const runWithLiqs = (e, trades, liqUsd) => {
      const out = [];
      let lastLiq = 0;
      for (const tr of trades) {
        if (liqUsd && tr.t - lastLiq >= 1000) {
          lastLiq = tr.t;
          e.now = Math.max(e.now, tr.t);
          e.onLiquidations([{ t: tr.t, p: tr.p, q: liqUsd / tr.p, side: 'sell' }]);
        }
        out.push(...run(e, [tr]));
      }
      return out;
    };

    it('does not buy while longs are still being liquidated (the 00:48 long)', () => {
      const { e, t1 } = setUp();
      run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
      // price pokes back above 100 and holds, but the cascade keeps going
      const out = runWithLiqs(e, [...path(t1 + 8000, 8, 99.9, 100.12, 'buy', 1), ...path(t1 + 16_000, 12, 100.12, 100.14, 'buy', 0.5)], 5000);
      expect(out).toEqual([]);
      expect(e.of.sweep.why).toMatch(/longs still being liquidated — the cascade is not over/);
      // once it stops, and the reclaim still holds, it is a trade
      const later = run(e, path(t1 + 28_000, 14, 100.13, 100.15, 'buy', 0.5));
      expect(later).toHaveLength(1);
      expect(later[0]).toMatchObject({ side: 'buy', setup: 'sweep' });
    });

    it('a brief poke back over the level is not a reclaim', () => {
      const { e, t1 } = setUp();
      run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
      run(e, path(t1 + 8000, 4, 99.9, 100.06, 'buy', 1));
      expect(run(e, path(t1 + 12_000, 6, 100.05, 99.95, 'sell', 0.5))).toEqual([]);
      expect(e.of.sweep.backSince).toBeNull();
    });

    it('needs real force behind the run: a $271 liquidation with no tape burst does not count (the 14:26 short)', () => {
      const { e, t1 } = setUp();
      // drifts through the round number on ordinary volume
      const drift = path(t1, 10, 100.12, 99.95, 'sell', 0.15);
      e.now = t1;
      // $271 next to ETH's ~$100k a second of normal volume; this test market trades ~$40 a second
      const liqUsd = 271 * (e.of.tape.baseline() / 100_000);
      e.onLiquidations([{ t: t1 + 9000, p: 99.96, q: liqUsd / 99.96, side: 'sell' }]);
      run(e, drift);
      expect(e.of.sweep).toBeNull();
    });

    it('does not fade a run that goes with a falling market (the 11:32 long)', () => {
      const e = new AmtEngine(base('sweep'));
      const rand = rng(5);
      // 20 minutes of steady selling, one step lower every minute
      const trend = [];
      for (let k = 0; k < 20; k++) trend.push(...balance(T0 + k * MIN, 1, 101 - k * 0.05, 0.02, rand).map((x) => ({ ...x, s: rand() < 0.7 ? 'sell' : 'buy' })));
      run(e, trend);
      const t1 = T0 + 20 * MIN;
      run(e, path(t1, 8, 100.08, 99.9, 'sell', 2));
      expect(e.of.sweep).toBeNull();
      expect(e.lastSkip.reason).toMatch(/run in the direction of a falling market .* continuation is more likely than a reversal/);
    });

    it('sits out sweeps the way the last losing sweep went', () => {
      const { e, t1 } = setUp();
      e.of.onClosed({ setup: 'sweep', side: 'buy', pnl: -0.85, closed: t1 - 4 * MIN });
      run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
      expect(e.of.sweep).toBeNull();
      expect(e.lastSkip.reason).toMatch(/the last long sweep trade lost 4 min ago/);
    });
  });

  it('sweep that keeps going is a breakout, not a stop run', () => {
    const rand = rng(3);
    const e = new AmtEngine(base('sweep'));
    const t1 = T0 + 10 * MIN;
    run(e, balance(T0, 10, 100.2, 0.1, rand));
    run(e, path(t1, 8, 100.15, 99.9, 'sell', 2));
    expect(e.of.sweep).not.toBeNull();
    expect(run(e, path(t1 + 8000, 10, 99.9, 99.6, 'sell', 2))).toEqual([]);
    expect(e.of.sweep).toBeNull();
    expect(e.lastSkip.reason).toMatch(/breakout, not a sweep/);
  });

  it('absorption: heavy selling into value low that will not go lower, then buyers → long', () => {
    const rand = rng(5);
    const e = new AmtEngine(base('absorption'));
    const t1 = T0 + 10 * MIN;
    run(e, balance(T0, 10, 100.2, 0.1, rand));
    const val = e.va.val;
    // 20 s of market selling that cannot push price through the value low
    const hits = [];
    for (let i = 0; i < 40; i++) hits.push({ t: t1 + i * 500, p: Number((val + (i % 2) * 0.01).toFixed(2)), q: 1, s: 'sell' });
    expect(run(e, hits)).toEqual([]);
    expect(e.of.absorb).toMatchObject({ dir: 1 });
    expect(e.of.absorb.level).toMatch(/VAL/);
    const intents = run(e, path(t1 + 20_000, 6, val + 0.01, val + 0.06, 'buy', 1));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ side: 'buy', setup: 'absorption' });
    expect(intents[0].stop).toBeLessThan(val);
    expect(intents[0].reason).toMatch(/sellers absorbed at VAL/);
  });

  it('does not fade aggression that is moving price', () => {
    const rand = rng(5);
    const e = new AmtEngine(base('absorption'));
    const t1 = T0 + 10 * MIN;
    run(e, balance(T0, 10, 100.2, 0.1, rand));
    run(e, path(t1, 20, 100.15, 99.85, 'sell', 1));
    expect(e.of.absorb).toBeNull();
  });

  it('continuation: stacked buy imbalances, retested and held → long', () => {
    const rand = rng(9);
    const e = new AmtEngine(base('continuation', { roundBps: 0 }));
    const t1 = T0 + 10 * MIN; // a bar boundary
    run(e, balance(T0, 10, 100.2, 0.1, rand));
    // one minute bar of initiative buying up through 100.25 → 100.45
    run(e, path(t1, 60, 100.25, 100.45, 'buy', 1));
    // the next bar opens higher: the bar above closes and the stack registers
    expect(run(e, path(t1 + 60_000, 4, 100.47, 100.5, 'buy', 0.5))).toEqual([]);
    expect(e.of.zone).toMatchObject({ dir: 1 });
    expect(e.of.zone.lo).toBeLessThan(100.3);
    // light pullback into the stack, holding above its low
    expect(run(e, path(t1 + 64_000, 6, 100.49, 100.42, 'sell', 0.3))).toEqual([]);
    expect(e.of.zone.touched).toBeTruthy();
    const intents = run(e, path(t1 + 70_000, 6, 100.42, 100.45, 'buy', 1));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ side: 'buy', setup: 'continuation' });
    expect(intents[0].stop).toBeLessThan(e.of.fpBin * 10_026);
    expect(intents[0].reason).toMatch(/stacked buy imbalances/);
  });

  it('continuation zone is dropped when price breaks back through the stack', () => {
    const rand = rng(9);
    const e = new AmtEngine(base('continuation', { roundBps: 0 }));
    const t1 = T0 + 10 * MIN;
    run(e, balance(T0, 10, 100.2, 0.1, rand));
    run(e, path(t1, 60, 100.25, 100.45, 'buy', 1));
    run(e, path(t1 + 60_000, 4, 100.47, 100.5, 'buy', 0.5));
    expect(e.of.zone).not.toBeNull();
    expect(run(e, path(t1 + 64_000, 10, 100.49, 100.15, 'sell', 0.5))).toEqual([]);
    expect(e.of.zone).toBeNull();
  });

  it('absorption at a standing bid wall exits when the wall is pulled', () => {
    const rand = rng(5);
    const e = new AmtEngine(base('absorption', { useBook: true, maxSpreadBps: 5 }));
    const t1 = T0 + 10 * MIN;
    let wall = null;
    let bidQ = 1;
    let lastBook = -Infinity;
    const feedBook = (tr) => {
      if (tr.t - lastBook < 500) return;
      lastBook = tr.t;
      const bb = Number((tr.p - 0.01).toFixed(2));
      const bids = Array.from({ length: 20 }, (_, i) => {
        const p = Number((bb - i * 0.01).toFixed(2));
        return [p, p === wall ? 15 : i === 0 ? bidQ : 1];
      });
      const asks = Array.from({ length: 20 }, (_, i) => [Number((tr.p + 0.01 + i * 0.01).toFixed(2)), 1]);
      e.now = Math.max(e.now, tr.t);
      e.onBook(bids, asks);
    };
    run(e, balance(T0, 10, 100.2, 0.1, rand));
    const val = e.va.val;
    wall = Number((val - 0.01).toFixed(2));
    // the wall stands for a minute under value low
    run(e, balance(t1, 1, val + 0.06, 0.03, rand), feedBook);
    const t2 = t1 + MIN;
    const hits = [];
    for (let i = 0; i < 40; i++) hits.push({ t: t2 + i * 500, p: Number((val + (i % 2) * 0.01).toFixed(2)), q: 1, s: 'sell' });
    run(e, hits, feedBook);
    expect(e.of.absorb?.wall?.price).toBe(wall);
    // buyers step in and join the bid: order-flow imbalance turns up
    const lift = path(t2 + 20_000, 6, val + 0.01, val + 0.06, 'buy', 1);
    const intents = run(e, lift, (tr) => {
      bidQ += 0.5;
      feedBook(tr);
    });
    expect(intents).toHaveLength(1);
    expect(e.pos).toMatchObject({ setup: 'absorption', wall: { side: 'bid', price: wall } });
    // the wall vanishes without being traded: the trade's reason is gone
    wall = null;
    const exits = run(e, path(t2 + 26_000, 3, val + 0.06, val + 0.05, 'buy', 0.2), feedBook);
    expect(exits).toHaveLength(1);
    expect(e.trades[e.trades.length - 1].reason).toBe('wall pulled');
  });

  it('runs all three together over a long random market without errors', () => {
    const rand = rng(11);
    const e = new AmtEngine({ ...mergeConfig(ORDERFLOW_PRESET), warmupMinutes: 5, accountUsd: 1000 });
    let t = T0;
    let mid = 100;
    const trades = [];
    for (let k = 0; k < 120; k++) {
      trades.push(...balance(t, 1, mid, 0.15, rand, 4));
      t += MIN;
      mid += (rand() - 0.5) * 0.3;
    }
    expect(() => run(e, trades)).not.toThrow();
    const s = e.snapshot();
    expect(s.orderflow).toMatchObject({ ofi: null, walls: [] });
    expect(s.orderflow.pools).toBeGreaterThan(0);
  });
});

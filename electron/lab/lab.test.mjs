import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoSwarm } from '../cswarm/cswarm.mjs';
import { evaluate, research, scoreVariants } from '../../src/lab/research.ts';
import { alignFunding, LabService } from './lab.mjs';
import { createFarmRunner } from './farmLoop.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** hourly candles: a random walk ending at `now` */
function walk(n, now, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= Math.exp((rnd() - 0.5) * 0.02);
    return { time: now - (n - i) * HOUR, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, volume: 10 + rnd() * 10 };
  });
}

/** a worker that runs in-process, as labWorker.mjs does */
function inlineWorker() {
  const w = new EventEmitter();
  w.terminate = async () => {};
  w.postMessage = async (msg) => {
    try {
      const result =
        msg.type === 'score'
          ? scoreVariants(msg.markets, msg.specs, msg.isShare, msg.costs, (done, total) => w.emit('message', { type: 'progress', progress: { stage: 'Trying changes', done, total } }))
          : msg.type === 'evaluate'
            ? evaluate(msg.markets, msg.spec, msg.isShare, msg.costs)
            : await research(msg.markets, msg.cfg, (progress) => w.emit('message', { type: 'progress', progress }));
      w.emit('message', { type: 'result', result });
    } catch (err) {
      w.emit('message', { type: 'error', error: String(err.message) });
    }
  };
  return w;
}

/** the edge finder's thread, run in-process: the same loop farmWorker.mjs runs */
function inlineFarmWorker() {
  const w = new EventEmitter();
  const runner = createFarmRunner((m) => setImmediate(() => w.emit('message', m)), { sleep: () => new Promise((r) => setImmediate(r)) });
  w.postMessage = (msg) => void runner.onMessage(msg);
  w.terminate = async () => {};
  w.runner = runner;
  return w;
}

/** hourly candles with slow trends a trend rule can ride */
function trendWalk(n, now, seed) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  let p = 100;
  let mu = 0;
  return Array.from({ length: n }, (_, i) => {
    mu = 0.997 * mu + 0.00045 * g();
    const o = p;
    p *= Math.exp(mu + 0.005 * g());
    return { time: now - (n - i) * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 + ((i * 37) % 11) * 20 };
  });
}

describe('the edge finder service', () => {
  it('starts, runs by itself, finds and keeps survivors, stops, and carries on after a restart', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, sym, _tf, since) => trendWalk(6000, now, sym.startsWith('BTC') ? 3 : 4).filter((b) => b.time >= since)), fundingHistory: vi.fn(async () => []) };
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    const pushed = [];
    let worker;
    const lab = new LabService({ ccxt, dir, emit: (ch, m) => ch === 'lab:farm' && pushed.push(m), makeWorker: inlineWorker, makeFarmWorker: () => (worker = inlineFarmWorker()), now: () => now });
    // never started: wanted by default, nothing found yet
    expect(lab.farmState()).toMatchObject({ running: false, wanted: true, tried: 0, top: [] });
    await expect(lab.farmStart({ coins: [], styles: ['intraday'] })).rejects.toThrow(/at least one coin/);
    const st = await lab.farmStart({ coins: ['btc', 'ETH'], styles: ['intraday'] });
    expect(st.running).toBe(true);
    expect(st.cfg.coins).toEqual(['BTC', 'ETH']);
    expect(ccxt.history.mock.calls.every((c) => c[2] === '1h')).toBe(true);
    // it runs on its own until it has survivors
    for (let i = 0; i < 20000 && !(worker.runner.farm?.survivors.length >= 1 && worker.runner.farm?.tried > 10); i++) await new Promise((r) => setImmediate(r));
    expect(worker.runner.farm.tried).toBeGreaterThan(10);
    expect(worker.runner.farm.survivors.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1600));
    expect(pushed.length).toBeGreaterThan(1);
    expect(lab.farmState().tried).toBeGreaterThan(0);
    // stop: it saves, and stays stopped when the terminal opens again
    const stopped = await lab.farmStop();
    expect(stopped).toMatchObject({ running: false, wanted: false });
    const tried = stopped.tried;
    expect(tried).toBeGreaterThan(10);
    const lab2 = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, makeFarmWorker: () => (worker = inlineFarmWorker()), now: () => now });
    expect(lab2.farmState()).toMatchObject({ running: false, wanted: false });
    expect(lab2.farmState().tried).toBe(tried);
    expect(lab2.farmState().survivors).toBeGreaterThan(0);
    // started again, it carries on from where it was
    await lab2.farmStart();
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.runner.farm.tried).toBeGreaterThanOrEqual(tried);
    expect(worker.runner.farm.survivors.length).toBeGreaterThan(0);
    // a strategy deployed is watched on fresh data
    const s = worker.runner.farm.survivors[0];
    const { buildSpec } = await import('../../src/lab/flow.ts');
    lab2.deploy({ spec: buildSpec(s.flow).spec, tfH: 1, stats: { sharpe: 1, t: 2, dsr: 0.9, trades: 30, verdict: 'edge finder' } }, { crypto: true, meme: false }, ['BTC', 'ETH']);
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.runner.farm.fleet.length).toBe(1);
    await lab2.farmStop();
  }, 120_000);
});

describe('the edge finder heals itself', () => {
  const T0 = Date.UTC(2026, 10, 6, 12);
  /** fixed markets that run on past the clock: what an exchange would return for candles from `since` up to now */
  const exchange = (clock, state) => {
    const all = { BTC: trendWalk(7000, T0 + 500 * HOUR, 3), ETH: trendWalk(7000, T0 + 500 * HOUR, 4) };
    return {
      history: vi.fn(async (id, sym, _tf, since) => {
        if (state.down === true || state.down === id) throw new Error(`${id} GET https://api.${id}.com/api/v3/klines?interval=1h fetch failed`);
        if (state.hang) return new Promise(() => {});
        const rows = all[sym.split('/')[0]];
        if (!rows) throw new Error(`${sym} is not listed on ${id}`);
        return rows.filter((b) => b.time >= since && b.time <= clock());
      }),
      fundingHistory: vi.fn(async () => []),
    };
  };
  const until = async (ok, ms = 4000) => {
    const t0 = Date.now();
    while (!ok() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
    return ok();
  };

  it('when no exchange answers, the candles already on disk are used; another exchange is tried; a hung download is cut off', async () => {
    let now = T0;
    const state = { down: false, hang: false };
    const ccxt = exchange(() => now, state);
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now, retryPause: 1 });
    const a = await lab.candles('BTC', '1h', 0.2, 'auto');
    expect(a).toMatchObject({ source: 'binance' });
    expect(a.stale).toBeUndefined();
    // every exchange down: the candles on disk, marked stale, with what went wrong
    state.down = true;
    now += 5 * HOUR;
    const calls = ccxt.history.mock.calls.length;
    const b = await lab.candles('BTC', '1h', 0.2, 'auto');
    expect(b.stale).toBe(true);
    expect(b.source).toBe('binance');
    expect(b.bars[b.bars.length - 1].time).toBe(a.bars[a.bars.length - 1].time);
    expect(b.error).toMatch(/binance: binance GET/);
    // each exchange got a quick second try
    expect(ccxt.history.mock.calls.length - calls).toBe(8);
    // nothing on disk and nothing to download: that is an error
    await expect(lab.candles('ETH', '1h', 0.2, 'auto')).rejects.toThrow(/no history for ETH/);
    // one exchange down: the next one answers, with fresh candles
    state.down = 'binance';
    const c = await lab.candles('BTC', '1h', 0.2, 'auto');
    expect(c).toMatchObject({ source: 'okx' });
    expect(c.stale).toBeUndefined();
    expect(c.bars[c.bars.length - 1].time).toBeGreaterThan(a.bars[a.bars.length - 1].time);
    // the Lab's chosen exchange alone when asked for it; every exchange, that one first, for the edge finder
    await expect(lab.candles('ETH', '1h', 0.2, 'binance')).rejects.toThrow(/no history/);
    expect(await lab.candles('ETH', '1h', 0.2, 'binance', { any: true })).toMatchObject({ source: 'okx' });
    // a download that never answers is cut off, and the disk is used
    state.down = false;
    state.hang = true;
    lab.fetchTimeout = 15;
    now += 3 * HOUR;
    const d = await lab.candles('BTC', '1h', 0.2, 'auto');
    expect(d.stale).toBe(true);
    expect(d.error).toMatch(/did not answer/);
    // a coin no exchange lists is not retried
    state.hang = false;
    const before = ccxt.history.mock.calls.length;
    await expect(lab.candles('NOPE', '1h', 0.2, 'auto')).rejects.toThrow(/not listed/);
    expect(ccxt.history.mock.calls.length - before).toBe(4);
  });

  it('an outage does not stop it or drop a coin: it keeps its candles, tries again sooner and sooner-spaced, and heals when the exchange is back', async () => {
    let now = T0;
    const state = { down: false };
    const ccxt = exchange(() => now, state);
    let worker;
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, makeFarmWorker: () => (worker = inlineFarmWorker()), now: () => now, retryPause: 1 });
    const st = await lab.farmStart({ coins: ['BTC', 'ETH'], styles: ['intraday'] });
    expect(st.data).toMatchObject({ ok: true, stale: [], missing: [], tries: 0 });
    expect(st.data.nextTryAt).toBe(now + 30 * 60_000);
    await until(() => worker.runner.farm?.dataTo > 0);
    const to0 = worker.runner.farm.dataTo;
    // the exchanges go down for hours
    state.down = true;
    now += 3 * HOUR;
    await lab.farmRefresh();
    let s1 = lab.farmState();
    expect(s1.running).toBe(true);
    expect(s1.error).toBe('');
    expect(s1.data).toMatchObject({ ok: false, stale: ['BTC 1h', 'ETH 1h'], missing: [], tries: 1 });
    expect(s1.data.error).toMatch(/fetch failed/);
    expect(s1.data.nextTryAt).toBe(now + 60_000);
    // both coins are still there, on the candles it had
    expect(lab.farmLast['1h'].map((m) => m.coin)).toEqual(['BTC', 'ETH']);
    expect(worker.runner.farm.dataTo).toBe(to0);
    // it keeps trying: 1, 2, 5, 10 minutes, then every 15 — for as long as it takes
    const waits = [];
    for (let i = 0; i < 6; i++) {
      now += 60_000;
      await lab.farmRefresh();
      waits.push((lab.farmState().data.nextTryAt - now) / 60_000);
    }
    expect(waits).toEqual([2, 5, 10, 15, 15, 15]);
    expect(lab.farmState().data.tries).toBe(7);
    expect(lab.farmState().data.lastOkAt).toBe(T0);
    // the exchange is back: fresh candles reach the farm, the problem is gone
    state.down = false;
    now += HOUR;
    await lab.farmRefresh();
    s1 = lab.farmState();
    expect(s1.data).toMatchObject({ ok: true, stale: [], tries: 0, error: '' });
    expect(s1.data.lastOkAt).toBe(now);
    expect(await until(() => worker.runner.farm.dataTo > to0)).toBe(true);
    expect(worker.runner.farm.dataTo).toBeGreaterThanOrEqual(to0 + 3 * HOUR);
    // one coin fails for good while the farm runs: it stays in, on its old candles
    state.down = false;
    ccxt.history.mockImplementationOnce(async () => {
      throw new Error('binance rate limit');
    });
    now += HOUR;
    await lab.farmRefresh();
    expect(lab.farmLast['1h'].map((m) => m.coin)).toEqual(['BTC', 'ETH']);
    await lab.farmStop();
    expect(lab.farmState().running).toBe(false);
  }, 60_000);

  it('if its thread dies or goes silent it is started again by itself, from what was saved — unless you stopped it', async () => {
    let now = T0;
    const ccxt = exchange(() => now, { down: false });
    let worker;
    const made = [];
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, makeFarmWorker: () => (made.push((worker = inlineFarmWorker())), worker), now: () => now, retryPause: 1, reviveDelays: [5, 5], farmSilence: 60_000, dogEvery: 5 });
    await lab.farmStart({ coins: ['BTC', 'ETH'], styles: ['intraday'] });
    await until(() => worker.runner.farm?.tried > 3);
    const first = worker;
    const stopLoop = (w) => w.runner.onMessage({ type: 'stop' });
    // the thread crashes
    first.emit('error', new Error('out of memory'));
    await stopLoop(first);
    expect(lab.farmState().running).toBe(false);
    expect(lab.farmState().error).toMatch(/restarts by itself in/);
    expect(await until(() => made.length === 2 && lab.farmState().running)).toBe(true);
    expect(lab.farmState().error).toBe('');
    // the thread hangs: nothing heard for longer than allowed
    const second = worker;
    await until(() => second.runner.farm?.tried > 0);
    second.emit = () => false;
    // a real hang: its loop no longer runs, so its heartbeat stops too
    await stopLoop(second);
    for (let i = 0; i < 14 && made.length < 3; i++) {
      now += 10_000;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(await until(() => made.length === 3 && lab.farmState().running)).toBe(true);
    // stopped by hand while a restart is pending: it stays stopped
    const third = worker;
    third.emit('exit', 1);
    await stopLoop(third);
    expect(lab.farmState().error).toMatch(/stopped unexpectedly/);
    await lab.farmStop();
    await new Promise((r) => setTimeout(r, 60));
    expect(made.length).toBe(3);
    expect(lab.farmState()).toMatchObject({ running: false, wanted: false });
  }, 60_000);

  it('a thread that is busy (its heartbeat moving) is never taken for a hang, and a computer that slept is not either', async () => {
    let now = T0;
    const ccxt = exchange(() => now, { down: false });
    let worker;
    const made = [];
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, makeFarmWorker: () => (made.push((worker = inlineFarmWorker())), worker), now: () => now, retryPause: 1, reviveDelays: [5, 5], farmSilence: 60_000, dogEvery: 5 });
    await lab.farmStart({ coins: ['BTC', 'ETH'], styles: ['intraday'] });
    await until(() => worker.runner.farm?.tried > 3);
    // it sends nothing for three minutes, but keeps working
    worker.emit = () => false;
    for (let i = 0; i < 18; i++) {
      now += 10_000;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(made.length).toBe(1);
    // the laptop sleeps for an hour with the thread stopped: on waking it is not restarted for it
    await worker.runner.onMessage({ type: 'stop' });
    now += 3_600_000;
    await new Promise((r) => setTimeout(r, 30));
    expect(made.length).toBe(1);
    await lab.farmStop();
  }, 60_000);
});

describe('the optimizer and 15-minute history', () => {
  it('scores versions of a strategy in the worker and leaves no progress behind', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, _sym, _tf, since) => walk(3000, now, 7).filter((b) => b.time >= since)), fundingHistory: vi.fn(async () => []) };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const exit = { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 24, onFlip: true, stopVol: 0 };
    const spec = { name: 'mom', signal: { id: 'tsmom', p: { lookback: 24 } }, filters: [], exit, sides: 'both' };
    const scores = await lab.optimize([{ id: 'base', spec }, { id: 'side:long', spec: { ...spec, sides: 'long' } }, { id: 'stop:wide', spec: { ...spec, exit: { ...exit, stopAtr: 3 } } }], { coins: ['BTC'], years: 0.33, timeframe: '1h', funding: false });
    expect(scores.map((s) => s.id)).toEqual(['base', 'side:long', 'stop:wide']);
    expect(scores[0].trades).toBeGreaterThan(3);
    expect(Number.isFinite(scores[0].sharpe)).toBe(true);
    expect(lab.status().progress).toBeNull();
    await expect(lab.optimize([], {})).rejects.toThrow(/nothing to try/);
  });

  it('a coin younger than the history asked for: what it has is used, and later refreshes only top it up', async () => {
    let now = Date.UTC(2026, 10, 6, 12);
    const t0 = now;
    // listed 1,000 hours ago: an exchange answers from its listing, whatever the start asked for
    const listedAt = now - 1000 * HOUR;
    const ccxt = { history: vi.fn(async (_id, _sym, _tf, since) => walk(1010, t0 + 10 * HOUR, 5).filter((b) => b.time >= Math.max(since, listedAt) && b.time <= now)) };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const first = await lab.candles('SOL', '1h', 6, 'binance');
    expect(first.bars.length).toBeGreaterThan(900);
    expect(first.stale).toBeUndefined();
    const since0 = ccxt.history.mock.calls[0][3];
    now += 6 * HOUR;
    await lab.candles('SOL', '1h', 6, 'binance');
    // the second time it asks only for what is new, not for six years again
    expect(ccxt.history.mock.calls[1][3]).toBeGreaterThan(since0 + 900 * HOUR);
  });

  it('Hyperliquid: its own recent candles joined onto the long history, scaled at the seam; its hourly funding after Binance\'s', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const long = walk(3000, now, 4);
    // Hyperliquid keeps its last 800 candles here, at prices 1 % above the spot exchange's
    const hlBars = long.slice(-800).map((b) => ({ ...b, open: b.open * 1.01, high: b.high * 1.01, low: b.low * 1.01, close: b.close * 1.01, volume: b.volume * 3 }));
    const ccxt = {
      history: vi.fn(async (id, _sym, _tf, since) => (id === 'hyperliquid' ? hlBars.filter((b) => b.time >= since) : long.filter((b) => b.time >= since))),
      fundingHistory: vi.fn(async (id) => (id === 'hyperliquid' ? Array.from({ length: 200 }, (_, i) => ({ time: now - (200 - i) * HOUR, rate: 0.0001 })) : Array.from({ length: 300 }, (_, i) => ({ time: now - 3000 * HOUR + i * 8 * HOUR, rate: 0.0008 })))),
    };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const got = await lab.hlCandles('BTC', '1h', 0.4);
    expect(got.hl).toBe(hlBars[0].time);
    expect(got.source).toMatch(/\+ hyperliquid/);
    const seam = got.bars.findIndex((b) => b.time === got.hl);
    // the recent stretch is Hyperliquid's own; the older candles are scaled to it, so the seam is no jump
    expect(got.bars[seam].close).toBeCloseTo(hlBars[0].close, 8);
    expect(got.bars[seam - 1].close / long[long.length - 801].close).toBeCloseTo(1.01, 6);
    expect(got.bars[seam - 1].volume / long[long.length - 801].volume).toBeCloseTo(3, 6);
    // the funding: 8-hourly before Hyperliquid's first record, hourly after, each counted at its own interval
    const rows = await lab.hlFunding('BTC', now - 3000 * HOUR);
    const f = alignFunding(got.bars, rows, 1);
    expect(f[f.length - 1]).toBeCloseTo(0.0001, 10);
    expect(f[seam - 300]).toBeCloseTo(0.0001, 10);
    // Hyperliquid unreachable: the long history alone, and why
    const down = new LabService({ ccxt: { history: vi.fn(async (id, _s, _t, since) => { if (id === 'hyperliquid') throw new Error('hyperliquid down'); return long.filter((b) => b.time >= since); }) }, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const alone = await down.hlCandles('BTC', '1h', 0.4);
    expect(alone.hl).toBeNull();
    expect(alone.hlError).toMatch(/hyperliquid down/);
  });

  it('a shorter request keeps the longer history in the cache', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, _sym, _tf, since) => walk(Math.floor((now - since) / HOUR), now, 3)) };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const two = await lab.candles('BTC', '1h', 2, 'binance');
    expect(ccxt.history).toHaveBeenCalledTimes(1);
    const one = await lab.candles('BTC', '1h', 1, 'binance');
    expect(one.bars.length).toBeLessThan(two.bars.length);
    // two years again: served from the cache, nothing downloaded again
    const again = await lab.candles('BTC', '1h', 2, 'binance');
    expect(ccxt.history).toHaveBeenCalledTimes(1);
    expect(again.bars.length).toBe(two.bars.length);
  });

  it('downloads 15-minute candles, a year at most', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const M15 = HOUR / 4;
    const ccxt = {
      history: vi.fn(async (_id, _sym, tf, since) => {
        const n = Math.floor((now - since) / M15);
        return Array.from({ length: n }, (_, i) => ({ time: since + i * M15, open: 100, high: 101, low: 99, close: 100 + (i % 7), volume: 5 }));
      }),
    };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const { bars } = await lab.candles('BTC', '15m', 3, 'binance');
    expect(ccxt.history.mock.calls[0][2]).toBe('15m');
    // asked for three years, given one
    expect(now - ccxt.history.mock.calls[0][3]).toBe(365 * DAY);
    expect(bars.length).toBeGreaterThan(34_000);
    expect(bars.length).toBeLessThanOrEqual(35_040);
    expect(bars[1].time - bars[0].time).toBe(M15);
  });
});

describe('the Strategy Lab service', () => {
  it('turns funding per interval into funding per bar', () => {
    const bars = Array.from({ length: 24 }, (_, i) => ({ time: i * HOUR }));
    const rows = [0, 8, 16].map((h) => ({ time: h * HOUR, rate: 0.0008 }));
    const f = alignFunding(bars, rows, 1);
    expect(f[0]).toBeCloseTo(0.0001, 8);
    expect(f[23]).toBeCloseTo(0.0001, 8);
    expect(alignFunding(bars, [], 1)).toBeNull();
  });

  it('downloads history, researches in a worker, keeps the result and deploys a strategy', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = {
      history: vi.fn(async (_id, _sym, _tf, since) => walk(3000, now, Math.round(since / 1e9) % 97).filter((b) => b.time >= since)),
      fundingHistory: vi.fn(async () => {
        throw new Error('no funding here');
      }),
    };
    const events = [];
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: (ch, m) => events.push([ch, m]), makeWorker: inlineWorker, now: () => now });
    const last = await lab.run({ coins: ['BTC', 'ETH'], years: 0.35, combos: 20, meta: false });
    expect(last.top).toBeGreaterThan(0);
    expect(ccxt.history).toHaveBeenCalled();
    const r = lab.result();
    expect(r.top[0].rules[0]).toMatch(/^Entry: /);
    expect(r.notes.some((n) => /funding/.test(n))).toBe(true);
    expect(events.some(([ch, m]) => ch === 'lab:event' && m.kind === 'done')).toBe(true);
    // the cache: a second download fetches only what is new
    ccxt.history.mockClear();
    await lab.candles('BTC', '1h', 0.35, 'binance');
    expect(ccxt.history.mock.calls.every((c) => c[3] > now - 2 * HOUR)).toBe(true);
    // deploy the best into the crypto swarm, then switch it off
    const id = lab.deploy({ rank: 1 }, { crypto: true, meme: false });
    expect(lab.deployed('crypto').map((d) => d.id)).toEqual([id]);
    expect(lab.status().deployed[0].stats.verdict).toBe(r.top[0].verdict);
    lab.toggle(id, false);
    expect(lab.deployed('crypto')).toHaveLength(0);
    lab.undeploy(id);
    expect(lab.status().deployed).toHaveLength(0);
  }, 120_000);
});

let sw;
afterEach(async () => {
  await sw?.stop();
  sw = null;
});

describe('the Lab agent in the crypto swarm', () => {
  it('proposes a deployed strategy’s new signal and manages the trade by its rules', async () => {
    let now = Date.UTC(2026, 10, 6, 12);
    // a quiet range, then a breakout on the last closed hour
    const hourly = Array.from({ length: 300 }, (_, i) => {
      const c = i === 299 ? 306 : 300 + Math.sin(i / 3);
      return { time: now - (300 - i) * HOUR, open: i === 299 ? 300.5 : c - 0.1, high: c + 0.4, low: (i === 299 ? 300.3 : c) - 0.4, close: c, volume: 1 };
    });
    const daily = Array.from({ length: 200 }, (_, i) => ({ time: now - (200 - i) * DAY, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
    const subs = new Map();
    const ccxt = {
      subscribe: vi.fn((sid, ex, symbol, cb) => subs.set(symbol, cb)),
      unsubscribe: vi.fn(),
      ohlcv: vi.fn(async (_ex, _s, tf) => (tf === '1d' ? daily : hourly.slice(-10))),
      history: vi.fn(async () => hourly),
    };
    const deployed = [
      {
        id: 'd1',
        spec: { name: 'Channel breakout', signal: { id: 'donchian', p: { n: 20 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 24, onFlip: true }, sides: 'both' },
        tfH: 1,
        coins: ['BTC'],
        targets: { crypto: true, meme: false },
        stats: { sharpe: 1.2, t: 2.4, dsr: 0.9, trades: 60, verdict: 'promising' },
        on: true,
      },
    ];
    const db = { m: new Map(), get(k) { return this.m.get(k); }, set(k, v) { this.m.set(k, JSON.parse(JSON.stringify(v))); } };
    sw = new CryptoSwarm({ ccxt, db, now: () => now, labDeployed: () => deployed });
    sw.setConfig({ coins: ['BTC'], agents: { scalper: false, auction: false, trend: false, lab: true } });
    await sw.start();
    subs.get('BTC/USDC:USDC')?.({ kind: 'trades', trades: [{ p: 306, q: 1, s: 'buy', t: now }] });
    await sw.slow();
    const pos = sw.open()[0];
    expect(pos).toMatchObject({ coin: 'BTC', agent: 'lab', side: 'buy', labId: 'd1', owner: 'swarm' });
    expect(sw.lines.some((l) => /Lab · Channel breakout/.test(l.text))).toBe(true);
    // the same signal is not proposed twice
    await sw.slow();
    expect(sw.lines.filter((l) => /proposes a LONG/.test(l.text))).toHaveLength(1);
    // its time limit (24 bars of 1 hour) closes it
    now += 25 * HOUR;
    subs.get('BTC/USDC:USDC')?.({ kind: 'trades', trades: [{ p: 306.5, q: 1, s: 'buy', t: now }] });
    await vi.waitFor(() => expect(pos.closedAt).toBeTruthy());
    expect(pos.reason).toBe('time');
  });
});

describe('the desktop process stays free while the edge finder runs', () => {
  it('candles go to the thread packed, and come out the same', async () => {
    const { packMarkets } = await import('./lab.mjs');
    const bars = walk(500, Date.UTC(2026, 10, 1), 9);
    const { markets, transfer } = packMarkets({ '1h': [{ coin: 'BTC', tfH: 1, bars, funding: bars.map((_, i) => i * 1e-6) }] });
    expect(transfer.length).toBe(2);
    expect(markets['1h'][0].packed).toBeInstanceOf(Float64Array);
    const runner = createFarmRunner(() => {}, { sleep: () => new Promise((r) => setImmediate(r)) });
    await runner.onMessage({ type: 'start', cfg: { coins: ['BTC'], styles: ['intraday'] }, markets });
    await runner.onMessage({ type: 'stop' });
    const got = runner.farm.markets?.['1h']?.[0] ?? null;
    if (got) expect(got.bars).toEqual(bars);
  });

  it('candle files are read once, rewritten only when they change, and new candles appended', async () => {
    const { readFileSync, statSync } = await import('node:fs');
    let now = Date.UTC(2026, 10, 6, 12);
    const all = walk(3000, now + 50 * HOUR, 5);
    const ccxt = { history: vi.fn(async (_id, _sym, _tf, since) => all.filter((b) => b.time >= since && b.time + HOUR <= now)), fundingHistory: vi.fn(async () => []) };
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    const lab = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const a = await lab.candles('BTC', '1h', 0.2, 'binance');
    const file = join(dir, 'cache/binance-BTC-1h.json');
    const before = statSync(file).mtimeMs;
    // asked again within the hour: nothing new, nothing written
    await new Promise((r) => setTimeout(r, 20));
    const b = await lab.candles('BTC', '1h', 0.2, 'binance');
    expect(b.bars.length).toBe(a.bars.length);
    expect(statSync(file).mtimeMs).toBe(before);
    // three hours on: three new candles, appended to the file, which still reads back whole
    now += 3 * HOUR;
    const c = await lab.candles('BTC', '1h', 0.2, 'binance');
    expect(c.bars[c.bars.length - 1].time).toBe(a.bars[a.bars.length - 1].time + 3 * HOUR);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    // the file keeps older candles too (a longer request will want them)
    expect(disk.length).toBeGreaterThanOrEqual(c.bars.length);
    expect(disk[disk.length - 1].time).toBe(c.bars[c.bars.length - 1].time);
    expect(new Set(disk.map((x) => x.time)).size).toBe(disk.length);
    // a new service reads the appended file as the old one left it
    const lab2 = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, now: () => now });
    ccxt.history.mockClear();
    const d = await lab2.candles('BTC', '1h', 0.2, 'binance');
    expect(d.bars.map((x) => x.time)).toEqual(c.bars.map((x) => x.time));
  });

  it('the screen is sent only what changed; saves are written as text and read back', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, sym, _tf, since) => trendWalk(6000, now, sym.startsWith('BTC') ? 3 : 4).filter((b) => b.time >= since)), fundingHistory: vi.fn(async () => []) };
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    const pushed = [];
    let worker;
    const lab = new LabService({ ccxt, dir, emit: (ch, m) => ch === 'lab:farm' && pushed.push(m), makeWorker: inlineWorker, makeFarmWorker: () => (worker = inlineFarmWorker()), now: () => now });
    await lab.farmStart({ coins: ['BTC'], styles: ['intraday'] });
    for (let i = 0; i < 4000 && !(worker.runner.farm?.tried > 5 && pushed.length > 6); i++) await new Promise((r) => setImmediate(r));
    // later updates carry the counters but not lists that did not change
    const later = pushed.slice(-3);
    expect(later.some((m) => 'tried' in m && !('cfg' in m && 'tops' in m && 'teams' in m && 'blocks' in m && 'top' in m && 'kept' in m && 'fleet' in m))).toBe(true);
    // what the screen holds after merging is the whole picture
    const merged = pushed.reduce((a, m) => ({ ...a, ...m }), {});
    expect(merged.tried).toBe(lab.farmState().tried);
    await lab.farmStop();
    const lab2 = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, now: () => now });
    expect(lab2.farmState().tried).toBe(lab.farmState().tried);
    expect(lab2.farmSavedObj()?.tried).toBe(lab.farmState().tried);
  });
});

describe('funding history is light on the exchanges', () => {
  it('is kept on disk, topped up at most every half hour, extended backwards only when asked for more, and Hyperliquid is asked only where its prices are', async () => {
    let now = Date.UTC(2026, 10, 10);
    const rows = (from, to, h) => Array.from({ length: Math.floor((to - from) / (h * HOUR)) }, (_, i) => ({ time: from + i * h * HOUR, rate: 0.0001 }));
    const calls = [];
    const ccxt = {
      history: vi.fn(async () => []),
      fundingHistory: vi.fn(async (id, _sym, since, _max, until = Infinity) => {
        calls.push({ id, since });
        return rows(Math.max(since, Date.UTC(2023, 4, 1)), Math.min(now, until), id === 'hyperliquid' ? 1 : 8);
      }),
    };
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    const lab = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const since = now - 365 * DAY;
    const a = await lab.fundingRows('binanceusdm', 'BTC/USDT:USDT', since);
    expect(a.length).toBeGreaterThan(1000);
    // asked again soon after: nothing is downloaded
    await lab.fundingRows('binanceusdm', 'BTC/USDT:USDT', since);
    expect(calls.length).toBe(1);
    // a longer stretch: only the older part is downloaded
    const b = await lab.fundingRows('binanceusdm', 'BTC/USDT:USDT', since - 365 * DAY);
    expect(calls.length).toBe(2);
    expect(calls[1].since).toBe(since - 365 * DAY);
    expect(b[0].time).toBeLessThan(a[0].time);
    expect(new Set(b.map((r) => r.time)).size).toBe(b.length);
    // a new start reads it from disk, and after half an hour only the newest rows are asked for
    now += 31 * 60_000;
    const lab2 = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, now: () => now });
    await lab2.fundingRows('binanceusdm', 'BTC/USDT:USDT', since);
    expect(calls.length).toBe(3);
    expect(calls[2].since).toBeGreaterThan(now - 9 * HOUR);
    // Hyperliquid's own funding: from where its prices start, not years back
    const hlFrom = now - 200 * DAY;
    await lab2.hlFunding('ETH', now - 5 * 365 * DAY, hlFrom);
    const hl = calls.filter((c) => c.id === 'hyperliquid');
    expect(hl.length).toBe(1);
    expect(hl[0].since).toBe(hlFrom - 2 * DAY);
  });

  it('a market that only missed a refresh, with recent candles, is noted but not an alarm', () => {
    const lab = new LabService({ ccxt: {}, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker });
    const d = lab.farmHealth({ markets: { '1h': [] }, stale: [], missing: [], late: ['BTC 1h'], error: 'hyperliquid 429 Too Many Requests' });
    expect(d).toMatchObject({ ok: true, late: ['BTC 1h'], limited: true });
    const e = lab.farmHealth({ markets: { '1h': [] }, stale: ['BTC 1h'], missing: [], late: [], error: 'hyperliquid 429 Too Many Requests' });
    expect(e).toMatchObject({ ok: false, limited: true });
  });
});

describe('the high-frequency paces join saved settings', () => {
  const saved = (cfg) => {
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    writeFileSync(join(dir, 'farm.json'), JSON.stringify({ cfg, wanted: false }));
    return new LabService({ ccxt: {}, dir, emit: () => {}, makeWorker: inlineWorker, now: () => Date.UTC(2026, 10, 26) });
  };
  it('a farm that scalps also breeds on 1- and 5-minute candles; one that does not scalp is left as it is', () => {
    const a = saved({ v: 3, coins: ['BTC', 'ETH'], styles: ['scalp15', 'intraday', 'swing'] });
    expect(a.farmCfg.styles).toEqual(['scalp5', 'scalp1', 'scalp15', 'intraday', 'swing']);
    expect(a.farmCfg.v).toBe(4);
    const b = saved({ v: 3, coins: ['BTC'], styles: ['swing', 'position'] });
    expect(b.farmCfg.styles).toEqual(['swing', 'position']);
    // once saved under the new version, taking them off again sticks
    const c = saved({ v: 4, coins: ['BTC'], styles: ['scalp15'] });
    expect(c.farmCfg.styles).toEqual(['scalp15']);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../db.mjs';
import { BotManager } from './bots.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 10);

function rng(seed = 7) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/** 40 min balance around 100, then an accepted breakout and a rally. */
function breakoutTape() {
  const rand = rng(3);
  const out = [];
  for (let t = T0; t < T0 + 40 * MIN; t += 500) out.push({ t, p: Number((100 + (rand() + rand() - 1) * 0.5).toFixed(2)), q: 0.1 + rand() * 0.2, s: rand() < 0.5 ? 'buy' : 'sell' });
  let t = T0 + 40 * MIN;
  for (let i = 0; i < 540; i++, t += 1000 / 6) out.push({ t, p: Number((100.3 + 0.2 * (i / 540)).toFixed(2)), q: 0.8, s: 'buy' });
  for (let i = 0; i < 240; i++, t += 500) out.push({ t, p: Number((100.5 + 0.8 * (i / 240)).toFixed(2)), q: 0.3, s: 'buy' });
  return out;
}

const params = { warmupMinutes: 30, useBook: false, feeBps: 2, slippageBps: 0, setups: { fade: false, breakout: true, reentry: false } };

function fakeCcxt() {
  const streams = new Map();
  const orders = [];
  return {
    streams,
    orders,
    subscribe: vi.fn((sid, ex, sym, emit, opts) => streams.set(sid, { emit, ex, sym, opts })),
    unsubscribe: vi.fn((sid) => streams.delete(sid)),
    marketInfo: vi.fn(async () => ({ exchangeId: 'bybit', trading: true, sandbox: true, contract: true, taker: 0.00055, limits: { maxOrderUsd: 300 }, freeBase: null })),
    placeOrder: vi.fn(async (_id, req) => {
      orders.push(req);
      return { id: `o${orders.length}`, price: null, baseQty: req.size };
    }),
    cancelOrder: vi.fn(async () => true),
  };
}

let dir;
let db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novus-bots-'));
  db = new Db(join(dir, 'b.sqlite'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const feed = (ccxt, sid, trades) => {
  const s = ccxt.streams.get(sid);
  s.emit({ kind: 'status', state: 'open' });
  for (let i = 0; i < trades.length; i += 50) s.emit({ kind: 'trades', trades: trades.slice(i, i + 50) });
};

describe('BotManager', () => {
  it('validates and persists bot configs, never auto-running them', () => {
    const m = new BotManager({ ccxt: fakeCcxt(), db, emit: () => {} });
    expect(() => m.save({ mode: 'paper', exchangeId: 'binance' })).toThrow(/symbol/);
    expect(() => m.save({ mode: 'live', symbol: 'BTC/USDT' })).toThrow(/exchange key/);
    const id = m.save({ mode: 'paper', exchangeId: 'Binance', symbol: 'BTC/USDT', params: { riskUsd: 5 } });
    const again = new BotManager({ ccxt: fakeCcxt(), db, emit: () => {} });
    expect(again.list()).toEqual([expect.objectContaining({ id, exchangeId: 'binance', name: 'AMT BTC/USDT', running: false, params: expect.objectContaining({ riskUsd: 5, minRR: 1.5 }) })]);
  });

  it('paper-trades a live stream and reports entries and exits', async () => {
    const ccxt = fakeCcxt();
    const sent = [];
    const m = new BotManager({ ccxt, db, emit: (ch, p) => sent.push([ch, p]), now: () => T0 });
    const id = m.save({ mode: 'paper', exchangeId: 'binance', symbol: 'BTC/USDT', params });
    await m.start(id);
    expect(ccxt.subscribe).toHaveBeenCalledWith(`amt-${id}`, 'binance', 'BTC/USDT', expect.any(Function), { sandbox: false });
    expect(() => m.save({ id, mode: 'paper', exchangeId: 'binance', symbol: 'ETH/USDT' })).toThrow(/stop the bot/);
    feed(ccxt, `amt-${id}`, breakoutTape());
    const kinds = m.eventsFor(id).map((e) => e.kind);
    expect(kinds).toContain('entry');
    expect(kinds).toContain('exit');
    expect(ccxt.placeOrder).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    const status = sent.filter(([ch]) => ch === 'status').at(-1)[1];
    expect(status).toMatchObject({ running: true, mode: 'paper', feed: 'open' });
    expect(status.stats.trades).toBeGreaterThanOrEqual(1);
    // closed trades are kept in the database for reports
    expect(db.amtTrades(0, Number.MAX_SAFE_INTEGER)[0]).toMatchObject({ bot_id: id, bot_name: 'AMT BTC/USDT', mode: 'paper', setup: 'breakout' });
    await m.stop(id, { reason: 'test' });
    expect(ccxt.unsubscribe).toHaveBeenCalled();
    expect(m.list()[0].running).toBe(false);
  });

  it('trades live through placeOrder with a protective exchange stop, inside the terminal cap', async () => {
    const ccxt = fakeCcxt();
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params: { ...params, riskUsd: 1000, maxPositionUsd: 5000 } });
    await m.start(id);
    expect(ccxt.subscribe.mock.calls[0][4]).toEqual({ sandbox: true });
    const tape = breakoutTape();
    feed(ccxt, `amt-${id}`, tape);
    await vi.waitFor(() => expect(ccxt.orders.length).toBe(2));
    // the market keeps trading after the fill and runs into the target
    const t1 = tape.at(-1).t;
    feed(ccxt, `amt-${id}`, Array.from({ length: 120 }, (_, i) => ({ t: t1 + 500 * (i + 1), p: Number((101.3 + i * 0.02).toFixed(2)), q: 0.3, s: 'buy' })));
    await vi.waitFor(() => expect(ccxt.orders.length).toBe(3));
    const [entry, stop, exit] = ccxt.orders;
    expect(entry).toMatchObject({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', sizeMode: 'base' });
    // capped by the terminal-wide $300 order limit, not the bot's $5000
    expect(entry.size * 100.3).toBeLessThanOrEqual(300.5);
    expect(stop).toMatchObject({ side: 'sell', type: 'stop-market', reduceOnly: true, size: entry.size });
    expect(stop.triggerPrice).toBeLessThan(100.3);
    expect(exit).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true });
    expect(ccxt.cancelOrder).toHaveBeenCalledWith('k1', 'o2', 'BTC/USDT:USDT');
    await m.stopAll();
  });

  it('stops itself when a live order fails, and refuses keys without trading', async () => {
    const ccxt = fakeCcxt();
    ccxt.placeOrder.mockRejectedValueOnce(new Error('insufficient margin'));
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params });
    await m.start(id);
    feed(ccxt, `amt-${id}`, breakoutTape());
    await vi.waitFor(() => expect(m.list()[0].running).toBe(false));
    expect(m.eventsFor(id).map((e) => e.text).join('\n')).toMatch(/entry order failed: insufficient margin[\s\S]*Stopped/);

    ccxt.marketInfo.mockResolvedValueOnce({ trading: false });
    await expect(m.start(id)).rejects.toThrow(/Allow trading/);
  });

  it('kill switch stops every bot; flatten closes paper positions', async () => {
    const ccxt = fakeCcxt();
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const a = m.save({ mode: 'paper', exchangeId: 'binance', symbol: 'BTC/USDT', params });
    const b = m.save({ mode: 'paper', exchangeId: 'okx', symbol: 'ETH/USDT', params });
    await m.start(a);
    await m.start(b);
    // stop the tape right after the entry
    const tape = breakoutTape();
    feed(ccxt, `amt-${a}`, tape.slice(0, 4800 + 400));
    expect(m.snapshot(a).position).not.toBeNull();
    await m.stop(a, { flatten: true, reason: 'test' });
    expect(m.eventsFor(a).find((e) => e.kind === 'exit').text).toMatch(/flatten/);
    expect(await m.stopAll()).toBe(1);
    expect(m.list().every((x) => !x.running)).toBe(true);
  });

  it('backtests trades recorded in the database', async () => {
    vi.useRealTimers();
    const m = new BotManager({ ccxt: fakeCcxt(), db, emit: () => {} });
    await expect(m.backtest(params, 'binancef', 'BTCUSDT')).rejects.toThrow(/only 0 recorded trades/);
    db.recordTrades('binancef', 'BTCUSDT', breakoutTape());
    const r = await m.backtest(params, 'binancef', 'BTCUSDT');
    expect(r.count).toBe(breakoutTape().length);
    expect(r.stats.trades).toBeGreaterThanOrEqual(1);
    expect(r.trades[0].setup).toBe('breakout');
  });
});

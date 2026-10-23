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
    // contracts of 0.01 BTC, like OKX: base size → contracts, fills report both
    placeOrder: vi.fn(async (_id, req) => {
      orders.push(req);
      const amount = req.sizeMode === 'contracts' ? req.size : Math.floor(req.size / 0.01);
      return { id: `o${orders.length}`, price: null, amount, baseQty: amount * 0.01 };
    }),
    cancelOrder: vi.fn(async (...args) => {
      orders.push({ cancel: args[1] });
      return true;
    }),
    positionContracts: vi.fn(async () => null),
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

  it('upgrades configs saved before the intraday style existed', () => {
    db.set('amtBots', [{ id: 'old', name: 'Old', mode: 'paper', exchangeId: 'binance', symbol: 'BTC/USDT', params: { riskUsd: 7, setups: { fade: true, breakout: false, reentry: true } } }]);
    const m = new BotManager({ ccxt: fakeCcxt(), db, emit: () => {} });
    expect(m.list()[0].params).toMatchObject({ style: 'scalp', riskUsd: 7, setups: { breakout: false, ibBreakout: true } });
    expect(m.presets().intraday).toMatchObject({ style: 'intraday', maxHoldSec: 28_800 });
  });

  it('paper-trades a live stream and reports entries and exits', async () => {
    const ccxt = fakeCcxt();
    const sent = [];
    const m = new BotManager({ ccxt, db, emit: (ch, p) => sent.push([ch, p]), now: () => T0 });
    const id = m.save({ mode: 'paper', exchangeId: 'binance', symbol: 'BTC/USDT', params });
    await m.start(id);
    expect(ccxt.subscribe).toHaveBeenCalledWith(`amt-${id}`, 'binance', 'BTC/USDT', expect.any(Function), { sandbox: false, liquidations: false });
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

  it('order-flow bots stream liquidations and book into the hybrid', async () => {
    const ccxt = fakeCcxt();
    const m = new BotManager({ ccxt, db, emit: () => undefined, now: () => T0 });
    expect(m.presets().orderflow).toMatchObject({ style: 'orderflow', sizing: 'balance' });
    const id = m.save({ mode: 'paper', exchangeId: 'binance', symbol: 'BTC/USDT:USDT', params: m.presets().orderflow });
    await m.start(id);
    expect(ccxt.subscribe.mock.calls[0][4]).toEqual({ sandbox: false, liquidations: true });
    const s = ccxt.streams.get(`amt-${id}`);
    s.emit({ kind: 'trades', trades: [{ t: T0, p: 100, q: 1, s: 'buy' }] });
    s.emit({ kind: 'liquidations', items: [{ t: T0, p: 100, q: 2, side: 'sell' }] });
    s.emit({ kind: 'book', bids: [[99.99, 1]], asks: [[100.01, 1]] });
    const e = m.running.get(id).engine;
    expect(e.of.tape.window(T0, 1).liqSell).toBe(200);
    expect(e.of.book.mid).toBeCloseTo(100, 6);
    expect(m.snapshot(id).orderflow).not.toBeNull();
    await m.stop(id, { reason: 'test' });
  });

  it('adaptive bots log their reasoning as think events', async () => {
    const ccxt = fakeCcxt();
    const m = new BotManager({ ccxt, db, emit: () => undefined, now: () => T0 });
    expect(m.presets().adaptive).toMatchObject({ style: 'adaptive', sizing: 'balance', breakevenAtR: 0 });
    const id = m.save({ mode: 'paper', exchangeId: 'binance', symbol: 'BTC/USDT:USDT', params: m.presets().adaptive });
    await m.start(id);
    expect(ccxt.subscribe.mock.calls[0][4]).toEqual({ sandbox: false, liquidations: true });
    const e = m.running.get(id).engine;
    e.brain.think(T0, 'widening stops: test thought');
    ccxt.streams.get(`amt-${id}`).emit({ kind: 'trades', trades: [{ t: T0, p: 100, q: 1, s: 'buy' }] });
    expect(m.eventsFor(id).filter((x) => x.kind === 'think').map((x) => x.text)).toEqual(['widening stops: test thought']);
    expect(m.snapshot(id).brain).toMatchObject({ noiseX: 1, patience: 1 });
    await m.stop(id, { reason: 'test' });
  });

  it('trades live through placeOrder with a protective exchange stop, inside the terminal cap', async () => {
    const ccxt = fakeCcxt();
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params: { ...params, riskUsd: 1000, maxPositionUsd: 5000 } });
    await m.start(id);
    expect(ccxt.subscribe.mock.calls[0][4]).toEqual({ sandbox: true, liquidations: false });
    const tape = breakoutTape();
    feed(ccxt, `amt-${id}`, tape);
    await vi.waitFor(() => expect(ccxt.orders.length).toBe(2));
    expect(ccxt.orders[1].triggerPrice).toBeLessThan(m.snapshot(id).position.stop);
    // the market keeps trading after the fill and runs into the target
    const t1 = tape.at(-1).t;
    feed(ccxt, `amt-${id}`, Array.from({ length: 120 }, (_, i) => ({ t: t1 + 500 * (i + 1), p: Number((101.3 + i * 0.02).toFixed(2)), q: 0.3, s: 'buy' })));
    await vi.waitFor(() => expect(ccxt.orders.length).toBe(4));
    const [entry, stop, exit, cancel] = ccxt.orders;
    expect(entry).toMatchObject({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', sizeMode: 'base' });
    // capped by the terminal-wide $300 order limit (with 2 % headroom), not the bot's $5000
    expect(entry.size * 100.3).toBeLessThanOrEqual(300 * 0.98 + 0.5);
    const contracts = Math.floor(entry.size / 0.01);
    // stop and exit close exactly the contracts that were filled
    expect(stop).toMatchObject({ side: 'sell', type: 'stop-market', reduceOnly: true, sizeMode: 'contracts', size: contracts });
    expect(stop.triggerPrice).toBeLessThan(100.3);
    expect(exit).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true, sizeMode: 'contracts', size: contracts });
    // the disaster stop is cancelled only after the exit went through
    expect(cancel).toEqual({ cancel: 'o2' });
    await m.stopAll();
  });

  describe('maker (limit) execution, live', () => {
    const makerParams = { ...params, riskUsd: 1000, maxPositionUsd: 5000, orderMode: 'maker', makerWaitSec: 30 };
    /** Feed trade by trade until the bot rests its entry limit; returns the rest of the tape. */
    const flush = async () => {
      for (let k = 0; k < 8; k++) await Promise.resolve();
    };
    const toLimit = async (ccxt, id, tape) => {
      const s = ccxt.streams.get(`amt-${id}`);
      s.emit({ kind: 'status', state: 'open' });
      for (let i = 0; i < tape.length; i++) {
        s.emit({ kind: 'trades', trades: [tape[i]] });
        await flush();
        if (ccxt.orders.length) return tape.slice(i + 1);
      }
      throw new Error('no limit order');
    };

    it('rests a post-only entry, books the fill at the maker fee and then protects it', async () => {
      const ccxt = fakeCcxt();
      ccxt.marketInfo = vi.fn(async () => ({ exchangeId: 'bybit', trading: true, sandbox: true, contract: true, taker: 0.00055, maker: 0.0002, limits: { maxOrderUsd: 300 }, freeBase: null }));
      ccxt.orderStatus = vi.fn(async () => ({ status: 'open', filled: 0 }));
      const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
      const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params: makerParams });
      await m.start(id);
      await toLimit(ccxt, id, breakoutTape());
      const [limit] = ccxt.orders;
      expect(limit).toMatchObject({ type: 'limit', postOnly: true, side: 'buy', sizeMode: 'base' });
      const contracts = Math.floor(limit.size / 0.01);
      // the exchange fills it
      ccxt.orderStatus = vi.fn(async () => ({ status: 'closed', filled: contracts, average: limit.price }));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(ccxt.orders.length).toBe(2));
      expect(ccxt.orders[1]).toMatchObject({ type: 'stop-market', reduceOnly: true, size: contracts });
      const e = m.running.get(id).engine;
      expect(e.pos).toMatchObject({ side: 'buy', entry: limit.price });
      expect(e.pos.fees).toBeCloseTo((limit.price * contracts * 0.01 * 2) / 1e4, 9);
      expect(m.eventsFor(id).some((x) => /resting \(post-only, maker fee\)/.test(x.text))).toBe(true);
      await m.stopAll();
    });

    it('a fill that races the cancel is kept, and no market order is sent', async () => {
      const ccxt = fakeCcxt();
      ccxt.orderStatus = vi.fn(async () => ({ status: 'open', filled: 0 }));
      const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
      const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params: makerParams });
      await m.start(id);
      const rest = await toLimit(ccxt, id, breakoutTape());
      const [limit] = ccxt.orders;
      const contracts = Math.floor(limit.size / 0.01);
      // by the time the engine gives up on it, the exchange had filled it
      ccxt.orderStatus = vi.fn(async () => ({ status: 'closed', filled: contracts, average: limit.price }));
      ccxt.streams.get(`amt-${id}`).emit({ kind: 'trades', trades: rest.slice(0, 400) });
      await vi.waitFor(() => expect(m.running.get(id).engine.pos).not.toBeNull());
      expect(ccxt.orders.filter((o) => o.type === 'market')).toEqual([]);
      expect(ccxt.cancelOrder).toHaveBeenCalled();
      await m.stopAll();
    });

    it('a post-only refusal falls back to the market only while the trade still pays', async () => {
      const ccxt = fakeCcxt();
      const place = ccxt.placeOrder;
      ccxt.placeOrder = vi.fn(async (sid, req) => {
        if (req.postOnly) {
          ccxt.orders.push(req);
          throw new Error('binanceusdm {"code":-5022,"msg":"Due to the order could not be executed as maker, the Post Only order will be rejected."}');
        }
        return place(sid, req);
      });
      ccxt.orderStatus = vi.fn(async () => ({ status: 'open', filled: 0 }));
      const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
      const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params: makerParams });
      await m.start(id);
      await toLimit(ccxt, id, breakoutTape());
      await vi.waitFor(() => expect(m.eventsFor(id).some((x) => /entry limit not placed .*-5022/.test(x.text))).toBe(true));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(ccxt.orders.some((o) => o.type === 'market')).toBe(true));
      expect(m.eventsFor(id).some((x) => /taking it at market/.test(x.text))).toBe(true);
      await m.stopAll();
    });
  });

  it('live balance sizing: real account balance, exchange minimum, isolated margin', async () => {
    const ccxt = fakeCcxt();
    ccxt.marketInfo = vi.fn(async () => ({ exchangeId: 'binanceusdm', trading: true, sandbox: false, contract: true, contractSize: 1, minAmount: 0.001, minCost: 5, last: 100, taker: 0.0005, settle: 'USDT', limits: { maxOrderUsd: 300 } }));
    ccxt.accountBalance = vi.fn(async () => 27);
    ccxt.prepareMargin = vi.fn(async () => []);
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'ETH/USDT:USDT', params: { ...params, sizing: 'balance', riskPct: 2, maxLeverage: 5, accountUsd: 1000 } });
    await m.start(id);
    expect(ccxt.prepareMargin).toHaveBeenCalledWith('k1', 'ETH/USDT:USDT', 5);
    const e = m.running.get(id).engine;
    // sizes from the $27 on the exchange, not the $1000 paper balance
    expect(e.balance()).toBe(27);
    expect(e.cfg.accountUsd).toBe(27);
    expect(e.cfg.minNotionalUsd).toBe(5);
    expect(m.eventsFor(id).some((ev) => /Sizing from a 27\.00 balance: 2% risk/.test(ev.text))).toBe(true);
    feed(ccxt, `amt-${id}`, breakoutTape());
    await vi.waitFor(() => expect(ccxt.orders.length).toBeGreaterThan(0));
    // at most 5 × $27 of position, whatever the stop distance
    expect(ccxt.orders[0].size * 100.5).toBeLessThanOrEqual(27 * 5 + 0.5);
    await m.stop(id, { flatten: false });
  });

  it('closes an entry that fills after "Stop & close position"', async () => {
    const ccxt = fakeCcxt();
    let release;
    const gate = new Promise((r) => (release = r));
    const place = ccxt.placeOrder.getMockImplementation();
    ccxt.placeOrder.mockImplementationOnce(async (...a) => {
      await gate;
      return place(...a);
    });
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params });
    await m.start(id);
    feed(ccxt, `amt-${id}`, breakoutTape());
    await vi.waitFor(() => expect(ccxt.placeOrder).toHaveBeenCalledTimes(1));
    await m.stop(id, { flatten: true, reason: 'test' });
    release();
    await vi.waitFor(() => expect(ccxt.orders.some((o) => o.reduceOnly && o.type === 'market')).toBe(true));
    const exit = ccxt.orders.find((o) => o.reduceOnly && o.type === 'market');
    expect(exit).toMatchObject({ side: 'sell', sizeMode: 'contracts' });
    expect(ccxt.orders.some((o) => o.type === 'stop-market')).toBe(false);
    expect(m.eventsFor(id).map((e) => e.text).join('\n')).toMatch(/in flight — it will be closed[\s\S]*EXIT flatten/);
  });

  it('records a position the exchange stop already closed instead of failing', async () => {
    const ccxt = fakeCcxt();
    const m = new BotManager({ ccxt, db, emit: () => {}, now: () => T0 });
    const id = m.save({ mode: 'live', secretId: 'k1', symbol: 'BTC/USDT:USDT', params });
    await m.start(id);
    const tape = breakoutTape();
    feed(ccxt, `amt-${id}`, tape);
    await vi.waitFor(() => expect(ccxt.orders.length).toBe(2));
    // the exit is rejected because the exchange stop fired first
    ccxt.placeOrder.mockRejectedValueOnce(new Error('reduce-only order would increase position'));
    ccxt.positionContracts.mockResolvedValueOnce(0);
    const t1 = tape.at(-1).t;
    feed(ccxt, `amt-${id}`, Array.from({ length: 200 }, (_, i) => ({ t: t1 + 500 * (i + 1), p: Number((101.3 - i * 0.01).toFixed(2)), q: 0.3, s: 'sell' })));
    await vi.waitFor(() => expect(m.eventsFor(id).some((e) => /already closed by the exchange stop/.test(e.text))).toBe(true));
    expect(m.list()[0].running).toBe(true);
    expect(m.snapshot(id).position).toBeNull();
    expect(db.amtTrades(0, Number.MAX_SAFE_INTEGER).at(-1)).toMatchObject({ reason: 'exchange stop' });
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoSwarm, labBarsFor, mergeCfg, symbolFor } from './cswarm.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function memDb(init = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), m };
}

/** A fake exchange: a long daily uptrend, hourly bars ending in a breakout, a stream we drive by hand. */
function fakeExchange(now, { live = false } = {}) {
  const subs = new Map();
  const orders = [];
  const daily = Array.from({ length: 200 }, (_, i) => ({ time: now - (200 - i) * DAY, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
  const hourly = Array.from({ length: 40 }, (_, i) => {
    const c = 300 + i * 0.1 + (i === 39 ? 3 : 0);
    return { time: now - (40 - i) * HOUR, open: c - 0.1, high: c + 0.2, low: c - 0.4, close: c, volume: 1 };
  });
  let contracts = 0;
  const ccxt = {
    subscribe: vi.fn((sid, ex, symbol, cb) => subs.set(symbol, cb)),
    unsubscribe: vi.fn(),
    ohlcv: vi.fn(async (_ex, _s, tf) => (tf === '1d' ? daily : hourly)),
    marketInfo: vi.fn(async () => ({ trading: true, contract: true, sandbox: false, exchangeId: 'hyperliquid' })),
    accountBalance: vi.fn(async () => 50),
    prepareMargin: vi.fn(async () => []),
    positionContracts: vi.fn(async () => contracts),
    cancelOrder: vi.fn(async () => true),
    placeOrder: vi.fn(async (_id, req) => {
      orders.push(req);
      if (req.type === 'market' && !req.reduceOnly) contracts = req.size;
      if (req.type === 'market' && req.reduceOnly) contracts = 0;
      return { id: `o${orders.length}`, price: req.type === 'market' ? 303.9 : undefined, amount: req.size, baseQty: req.size };
    }),
  };
  const feed = (symbol, p, t) => subs.get(symbol)?.({ kind: 'trades', trades: [{ p, q: 1, s: 'buy', t }] });
  return { ccxt, feed, orders, subs, live };
}

let sw;
afterEach(async () => {
  await sw?.stop();
  sw = null;
});

describe('the Lab agent, live', () => {
  it('gives a deployed strategy bitcoin\'s candles and the funding history when its rules read them', async () => {
    const now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now);
    const bars = (base) => Array.from({ length: 400 }, (_, i) => ({ time: now - (400 - i) * HOUR, open: base + i * 0.01, high: base + i * 0.01 + 0.2, low: base + i * 0.01 - 0.2, close: base + i * 0.01, volume: 5 + (i % 7) }));
    ex.ccxt.history = vi.fn(async (_ex, symbol) => bars(symbol.startsWith('BTC') ? 60_000 : 3000));
    // funding is flat until the last closed hour, when longs suddenly pay 0.1 % an hour
    ex.ccxt.fundingHistory = vi.fn(async () => Array.from({ length: 300 }, (_, i) => ({ time: now - (300 - i) * HOUR, rate: i === 299 ? 0.001 : 0 })));
    const exit = { stopAtr: 2, targetR: 1.5, trailAtr: 0, maxBars: 24, onFlip: false, stopVol: 0 };
    const deployed = [
      { id: 'p', on: true, tfH: 1, coins: ['ETH'], spec: { name: 'pairs', signal: { id: 'pairs', p: { window: 168, k: 2 } }, filters: [], exit, sides: 'both' } },
      { id: 'c', on: true, tfH: 1, coins: ['ETH'], spec: { name: 'carry', signal: { id: 'carry', p: { lookback: 24, band: 0.1 } }, filters: [], exit, sides: 'both' } },
    ];
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now, labDeployed: () => deployed });
    sw.setConfig({ coins: ['ETH'], agents: { auction: false, trend: false, lab: true } });
    await sw.start();
    await sw.slow();
    const asked = ex.ccxt.history.mock.calls.map((c) => c[1]);
    expect(asked).toContain('ETH/USDC:USDC');
    expect(asked).toContain('BTC/USDC:USDC');
    expect(ex.ccxt.fundingHistory).toHaveBeenCalledTimes(1);
    expect(ex.ccxt.fundingHistory.mock.calls[0][1]).toBe('ETH/USDC:USDC');
    // the carry rule sees the funding (a day's average far above 10 % a year) and proposes a short — it could not before
    expect(sw.lines.map((l) => l.text).filter((t) => /proposes a SHORT/.test(t)).join(' | ')).toMatch(/carry/i);
    // a second look within the hour does not download the funding again
    await sw.slow();
    expect(ex.ccxt.fundingHistory).toHaveBeenCalledTimes(1);
  });

  it('a strategy that reads neither is not given them (no extra downloads)', async () => {
    const now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now);
    ex.ccxt.history = vi.fn(async () => Array.from({ length: 400 }, (_, i) => ({ time: now - (400 - i) * HOUR, open: 100, high: 101, low: 99, close: 100 + (i % 5), volume: 5 })));
    ex.ccxt.fundingHistory = vi.fn(async () => []);
    const deployed = [{ id: 't', on: true, tfH: 1, coins: ['ETH'], spec: { name: 'mom', signal: { id: 'tsmom', p: { lookback: 24 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 24, onFlip: true, stopVol: 0 }, sides: 'both' } }];
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now, labDeployed: () => deployed });
    sw.setConfig({ coins: ['ETH'], agents: { auction: false, trend: false, lab: true } });
    await sw.start();
    await sw.slow();
    expect(ex.ccxt.history.mock.calls.map((c) => c[1])).toEqual(['ETH/USDC:USDC']);
    expect(ex.ccxt.fundingHistory).not.toHaveBeenCalled();
  });

  it("a 1-minute strategy is warmed up on eight days of candles: Hyperliquid's last 5,000, the older ones from Binance scaled to its price", async () => {
    const now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now);
    const M1 = HOUR / 60;
    ex.ccxt.history = vi.fn(async (id, _sym, _tf, _from, max) => {
      const n = id === 'hyperliquid' ? 5000 : max;
      const px = id === 'hyperliquid' ? 101 : 100;
      return Array.from({ length: n }, (_, i) => ({ time: now - (n - i) * M1, open: px, high: px + 1, low: px - 1, close: px, volume: 5 }));
    });
    const deployed = [{ id: 'm', on: true, tfH: 1 / 60, coins: ['ETH'], spec: { name: 'mom', signal: { id: 'tsmom', p: { lookback: 15 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 30, onFlip: true, stopVol: 0 }, sides: 'both' } }];
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now, labDeployed: () => deployed });
    sw.setConfig({ coins: ['ETH'], agents: { auction: false, trend: false, lab: true } });
    await sw.start();
    await sw.slow();
    const calls = ex.ccxt.history.mock.calls;
    expect(calls.map((c) => [c[0], c[1], c[2]])).toEqual([['hyperliquid', 'ETH/USDC:USDC', '1m'], ['binance', 'ETH/USDT', '1m']]);
    expect(labBarsFor(1 / 60)).toBe(11_520);
    const L = sw.coins.get('ETH').lab[1 / 60].bars;
    expect(L).toHaveLength(11_520);
    // the older candles are scaled to Hyperliquid's price: no jump at the seam
    expect(L[0].close).toBeCloseTo(101, 6);
    expect(L[L.length - 1].close).toBe(101);
    // 5-minute and slower candles fit in Hyperliquid's own history: no Binance download
    expect(labBarsFor(1 / 12)).toBe(3000);
    expect(labBarsFor(0.25)).toBe(3000);
  });

  it('a strategy tested on 15-minute candles reads 15-minute candles live, and looks every minute', async () => {
    let now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now);
    const M15 = HOUR / 4;
    ex.ccxt.history = vi.fn(async () => Array.from({ length: 400 }, (_, i) => ({ time: now - (400 - i) * M15, open: 100, high: 101, low: 99, close: 100 + (i % 5), volume: 5 })));
    const deployed = [{ id: 'q', on: true, tfH: 0.25, coins: ['ETH'], spec: { name: 'mom', signal: { id: 'tsmom', p: { lookback: 3 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 8, onFlip: true, stopVol: 0 }, sides: 'both' } }];
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now, labDeployed: () => deployed });
    sw.setConfig({ coins: ['ETH'], agents: { auction: false, trend: false, lab: true } });
    await sw.start();
    await sw.slow();
    expect(ex.ccxt.history.mock.calls[0][2]).toBe('15m');
    const before = ex.ccxt.ohlcv.mock.calls.filter((c) => c[2] === '15m').length;
    now += 61_000;
    await sw.slow();
    expect(ex.ccxt.ohlcv.mock.calls.filter((c) => c[2] === '15m').length).toBe(before + 1);
  });
});

describe('crypto swarm', () => {
  it('keeps settings within bounds', () => {
    const c = mergeCfg({ coins: ['btc', ' eth '], risk: { riskPct: 2 } });
    expect(c.coins).toEqual(['BTC', 'ETH']);
    expect(c.risk.riskPct).toBe(2);
    expect(c.risk.maxOpen).toBe(2);
    expect(symbolFor('SOL')).toBe('SOL/USDC:USDC');
  });

  it('paper: the Trend agent proposes a breakout, the council takes it, the stop closes it, the record learns', async () => {
    const now0 = Date.UTC(2026, 10, 5, 12);
    let now = now0;
    const ex = fakeExchange(now);
    const events = [];
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), emit: (ch, p) => ch === 'event' && events.push(p), now: () => now });
    sw.setConfig({ coins: ['BTC'], agents: { auction: false, trend: true } });
    await sw.start();
    ex.feed('BTC/USDC:USDC', 303.9, now);
    await sw.slow();
    const pos = sw.open()[0];
    expect(pos).toMatchObject({ coin: 'BTC', agent: 'trend', side: 'buy', mode: 'paper', owner: 'swarm' });
    expect(pos.riskUsd).toBeCloseTo(0.3, 1); // 1% of the $30 paper account
    const lines = sw.lines.map((l) => l.text);
    expect(lines.some((t) => /proposes a LONG/.test(t))).toBe(true);
    expect(lines.some((t) => /^BTC: TRADE —/.test(t))).toBe(true);
    expect(events.find((e) => e.kind === 'notify')).toMatchObject({ stage: 'setup', position: { coin: 'BTC', agentName: 'Trend' } });
    // one position per coin: another proposal on BTC is turned away
    sw.propose('BTC', 'trend', { side: 'buy', price: 304, stop: 302, target: 308, setup: 'x', why: 'y' });
    expect(sw.open()).toHaveLength(1);
    // the price runs 1R: stop to break-even, and the phone hears about it
    now += 60_000;
    ex.feed('BTC/USDC:USDC', pos.entry + pos.risk * 1.1, now);
    expect(pos.be).toBe(true);
    expect(events.find((e) => e.kind === 'notify' && e.stage === 'manage')).toBeTruthy();
    // and falls back through it: closed at break-even (a scratch, fees out)
    now += 60_000;
    ex.feed('BTC/USDC:USDC', pos.entry - 0.01, now);
    await vi.waitFor(() => expect(pos.closedAt).toBeTruthy());
    expect(pos.reason).toBe('breakeven');
    expect(pos.pnl).toBeLessThan(0);
    expect(pos.pnl).toBeGreaterThan(-0.1);
    const res = events.find((e) => e.kind === 'notify' && e.stage === 'result');
    expect(res.position).toMatchObject({ reason: 'breakeven' });
    expect(sw.samples.at(-1)).toMatchObject({ src: 'paper', agent: 'trend', y: 1 });
    expect(sw.state().totals.trades).toBe(1);
  });

  it('the risk manager stops it after the daily limit', async () => {
    let now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now);
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now });
    sw.setConfig({ coins: ['BTC'], agents: { auction: false, trend: true } });
    await sw.start();
    sw.paper.cash = 28; // down 2 of 30 → under the 5% daily limit? 6.7%: over it
    ex.feed('BTC/USDC:USDC', 303.9, now);
    await sw.slow();
    expect(sw.open()).toHaveLength(0);
    expect(sw.lines.some((l) => /vetoed by Risk/.test(l.text))).toBe(true);
    expect(sw.lines.some((l) => /today — the daily limit/.test(l.text))).toBe(true);
    expect(sw.shadow.open).toHaveLength(1);
  });

  it('live: a market entry with an exchange-side stop; the close is reduce-only and removes the stop', async () => {
    let now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now, { live: true });
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now });
    sw.setConfig({ coins: ['BTC'], agents: { auction: false, trend: true } });
    sw.setMode('live', 'key1');
    await sw.start();
    expect(ex.ccxt.prepareMargin).toHaveBeenCalledWith('key1', 'BTC/USDC:USDC', 3);
    ex.feed('BTC/USDC:USDC', 303.9, now);
    await sw.slow();
    await vi.waitFor(() => expect(sw.open()).toHaveLength(1));
    const pos = sw.open()[0];
    expect(ex.orders[0]).toMatchObject({ symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', sizeMode: 'base' });
    expect(ex.orders[1]).toMatchObject({ side: 'sell', type: 'stop-market', reduceOnly: true });
    expect(ex.orders[1].triggerPrice).toBeLessThan(pos.stop);
    expect(pos.riskUsd).toBeCloseTo(0.5, 1); // 1% of the $50 account
    await sw.close(pos, 'test', 305);
    expect(ex.orders[2]).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true });
    expect(ex.ccxt.cancelOrder).toHaveBeenCalledWith('key1', 'o2', 'BTC/USDC:USDC');
    expect(pos.closedAt).toBeTruthy();
  });

  it('an engine’s proposal goes through the council, and the engine manages the trade it was given', async () => {
    let now = Date.UTC(2026, 10, 5, 12);
    const ex = fakeExchange(now);
    sw = new CryptoSwarm({ ccxt: ex.ccxt, db: memDb(), now: () => now });
    sw.setConfig({ coins: ['ETH'], agents: { auction: true, trend: false } });
    await sw.start();
    const e = sw.coins.get('ETH').engines.auction;
    ex.feed('ETH/USDC:USDC', 3000, now);
    // the engine signals a long, as it does in its own step
    e.pending = { kind: 'entry', side: 'buy', stop: 2985, target: 3030, setup: 'absorption', why: 'sellers absorbed at the low', t: now };
    sw.handle('ETH', 'auction', [{ type: 'enter', side: 'buy', qty: 1, price: 3000, stop: 2985, target: 3030, setup: 'absorption', reason: 'sellers absorbed at the low' }]);
    await vi.waitFor(() => expect(sw.open()).toHaveLength(1));
    expect(e.pos).toMatchObject({ side: 'buy', stop: 2985 });
    expect(sw.open()[0]).toMatchObject({ owner: 'engine', agent: 'auction' });
    // the engine's stop is hit: it exits, the swarm closes and records it
    now += 30_000;
    ex.feed('ETH/USDC:USDC', 2980, now);
    await vi.waitFor(() => expect(sw.positions[0].closedAt).toBeTruthy());
    expect(sw.positions[0].reason).toBe('stop');
    expect(sw.positions[0].r).toBeLessThan(-0.9);
    expect(e.pos).toBeNull();
  });

  it('the Scalper agent is retired: a saved setting for it is dropped, and no coin starts a scalper engine', () => {
    const c = mergeCfg({ agents: { scalper: true, auction: true, trend: true } });
    expect(c.agents.scalper).toBeUndefined();
    expect(Object.keys(c.agents)).toEqual(['auction', 'trend', 'lab']);
  });
});

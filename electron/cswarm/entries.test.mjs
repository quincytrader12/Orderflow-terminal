// Smarter entries: the swarm rests at the best bid (offer) for a maker fill, timed by the order
// book; not filled in time it takes the price if it has not run away, and skips the trade if it
// has. Paper mode fills a resting order only when trades print through its price.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoSwarm } from './cswarm.mjs';

const HOUR = 3_600_000;
const SYM = 'BTC/USDC:USDC';
const memDb = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))) };
};
const levels = (from, step, qty) => Array.from({ length: 5 }, (_, i) => [from + i * step, qty]);

function setup({ live = false, status = null } = {}) {
  const now = Date.UTC(2026, 10, 20, 12);
  const subs = new Map();
  const orders = [];
  const ccxt = {
    subscribe: vi.fn((_sid, _ex, symbol, cb) => subs.set(symbol, cb)),
    unsubscribe: vi.fn(),
    ohlcv: vi.fn(async () => []),
    history: vi.fn(async () => []),
    marketInfo: vi.fn(async () => ({ trading: true, contract: true, sandbox: false, exchangeId: 'hyperliquid' })),
    accountBalance: vi.fn(async () => 60),
    prepareMargin: vi.fn(async () => []),
    positionContracts: vi.fn(async () => 0),
    cancelOrder: vi.fn(async () => true),
    orderStatus: vi.fn(async () => status ?? { status: 'open', filled: 0, amount: 1, average: null }),
    placeOrder: vi.fn(async (_id, req) => {
      orders.push(req);
      return { id: `o${orders.length}`, price: req.type === 'market' ? 100.05 : req.price, amount: req.size, baseQty: req.size, average: req.type === 'market' ? 100.05 : null };
    }),
  };
  let onSleep = () => {};
  const sw = new CryptoSwarm({ ccxt, db: memDb(), now: () => now, sleep: async () => onSleep() });
  sw.setConfig({ coins: ['BTC'], agents: { auction: false, trend: false, lab: false } });
  if (live) {
    sw.mode = 'live';
    sw.secretId = 'k';
    sw.liveEquity = 60;
  }
  const send = (m) => subs.get(SYM)?.(m);
  const trade = (p, t = now, s = 'buy', q = 1) => send({ kind: 'trades', trades: [{ p, q, s, t }] });
  const book = (bidQty, askQty) => send({ kind: 'book', bids: levels(99.99, -0.01, bidQty), asks: levels(100.01, 0.01, askQty) });
  return { sw, ccxt, orders, now, trade, book, setSleep: (f) => (onSleep = f) };
}
const buy = { side: 'buy', price: 100, stop: 99, target: 102, setup: 'test', why: 'test', authority: 'tested' };

let current;
afterEach(async () => {
  await current?.stop().catch(() => undefined);
  current = null;
});

describe('smarter entries', () => {
  it('paper: rests at the bid and is filled when trades print through it — at the maker fee', async () => {
    const x = setup();
    current = x.sw;
    await x.sw.start();
    x.trade(100, x.now);
    x.book(10, 10);
    x.setSleep(() => x.trade(99.98, x.now + 2000, 'sell'));
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.open()).toHaveLength(1));
    const p = x.sw.open()[0];
    expect(p.entry).toBe(99.99);
    expect(p.fees).toBeCloseTo((p.notional * 1.5) / 1e4, 9);
    expect(p.entryHow).toMatch(/filled resting at the bid \(maker\) — about 5\.0 bps cheaper/);
    expect(x.sw.lines.some((l) => /LONG .* · filled resting at the bid/.test(l.text))).toBe(true);
  });

  it('paper: not filled, the price barely moved — taken at the price (taker)', async () => {
    const x = setup();
    current = x.sw;
    await x.sw.start();
    x.trade(100, x.now);
    x.book(10, 10);
    x.setSleep(() => x.trade(100.02, x.now + 2000));
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.open()).toHaveLength(1));
    const p = x.sw.open()[0];
    expect(p.entry).toBeCloseTo(100.02 * (1 + 2 / 1e4), 6);
    expect(p.entryHow).toMatch(/not filled resting at 99\.99 within 5 s — taken at the price/);
  });

  it('paper: the price ran away while it waited — the entry is skipped, not chased', async () => {
    const x = setup();
    current = x.sw;
    await x.sw.start();
    x.trade(100, x.now);
    x.book(10, 10);
    x.setSleep(() => x.trade(100.2, x.now + 2000));
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.lines.some((l) => /entry skipped — the price moved 21\.\d bps away/.test(l.text))).toBe(true));
    expect(x.sw.open()).toHaveLength(0);
    expect(x.sw.coins.get('BTC').busy).toBe(false);
  });

  it('takes the price at once when the book and the tape push hard its way (a resting order would be left behind)', async () => {
    const x = setup();
    current = x.sw;
    await x.sw.start();
    for (let i = 0; i < 10; i++) x.trade(100 + i * 0.001, x.now + i * 300, 'buy', 5);
    x.book(40, 5);
    const slept = vi.fn();
    x.setSleep(slept);
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.open()).toHaveLength(1));
    expect(slept).not.toHaveBeenCalled();
    expect(x.sw.open()[0].entryHow).toMatch(/taking the price now/);
  });

  it('with no order book read yet it enters as before (at the price)', async () => {
    const x = setup();
    current = x.sw;
    await x.sw.start();
    x.trade(100, x.now);
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.open()).toHaveLength(1));
    expect(x.sw.open()[0].entryHow).toBeUndefined();
  });

  it('live: a post-only limit at the bid, filled — no market order, the maker fee', async () => {
    const x = setup({ live: true, status: { status: 'closed', filled: 0, amount: 0, average: 99.99 } });
    current = x.sw;
    x.ccxt.orderStatus.mockImplementation(async () => ({ status: 'closed', filled: x.orders[0].size, amount: x.orders[0].size, average: 99.99 }));
    await x.sw.start();
    x.trade(100, x.now);
    x.book(10, 10);
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.open()).toHaveLength(1));
    const entry = x.orders.filter((o) => !o.reduceOnly);
    expect(entry).toHaveLength(1);
    expect(entry[0]).toMatchObject({ type: 'limit', postOnly: true, price: 99.99, side: 'buy' });
    expect(x.orders.some((o) => o.type === 'stop-market' && o.reduceOnly)).toBe(true);
    const p = x.sw.open()[0];
    expect(p.entry).toBe(99.99);
    expect(p.fees).toBeCloseTo((p.notional * 1.5) / 1e4, 9);
  });

  it('live: not filled and the price ran away — cancelled and skipped, nothing left open', async () => {
    const x = setup({ live: true });
    current = x.sw;
    await x.sw.start();
    x.trade(100, x.now);
    x.book(10, 10);
    x.setSleep(() => x.trade(100.3, x.now + 2000));
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.lines.some((l) => /entry skipped/.test(l.text))).toBe(true));
    expect(x.ccxt.cancelOrder).toHaveBeenCalled();
    expect(x.orders.filter((o) => o.type === 'market')).toHaveLength(0);
    expect(x.sw.open()).toHaveLength(0);
  });

  it('live: not filled, the price close — the limit is cancelled and the price taken', async () => {
    const x = setup({ live: true });
    current = x.sw;
    await x.sw.start();
    x.trade(100, x.now);
    x.book(10, 10);
    x.setSleep(() => x.trade(100.02, x.now + 2000));
    x.sw.propose('BTC', 'trend', buy);
    await vi.waitFor(() => expect(x.sw.open()).toHaveLength(1));
    expect(x.ccxt.cancelOrder).toHaveBeenCalled();
    expect(x.orders.filter((o) => o.type === 'market' && !o.reduceOnly)).toHaveLength(1);
    expect(x.sw.open()[0].entryHow).toMatch(/taken at the price/);
  });
});

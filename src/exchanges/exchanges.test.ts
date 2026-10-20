import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookUpdate, Liquidation, MarketStats, Trade } from '../core/types';
import type { MarketHandlers, VenueAdapter } from './adapter';
import { BinanceDepthSync, binanceFutures } from './binance';
import { bitfinex, bitfinexSymbol } from './bitfinex';
import { bitget } from './bitget';
import { bybit } from './bybit';
import { coinbase } from './coinbase';
import { parseOptionName, toOptionTrade } from './deribit';
import { hyperliquid } from './hyperliquid';
import { kraken } from './kraken';
import { toNewsItem } from './news';
import { okx } from './okx';

/** Minimal browser-like WebSocket double. */
class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 0);
  }
  send(d: string) {
    this.sent.push(d.startsWith('{') || d.startsWith('[') ? JSON.parse(d) : d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  emit(msg: unknown) {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
}

function collect() {
  const out = { trades: [] as Trade[], books: [] as BookUpdate[], liqs: [] as Liquidation[], stats: {} as Partial<MarketStats>, states: [] as string[] };
  const h: MarketHandlers = {
    onTrades: (t) => out.trades.push(...t),
    onBook: (b) => out.books.push(b),
    onLiquidation: (l) => out.liqs.push(l),
    onStats: (s) => Object.assign(out.stats, s),
    onStatus: (s) => out.states.push(s),
    onFrame: () => undefined,
  };
  return { out, h };
}

async function open(adapter: VenueAdapter, symbol: string) {
  const c = collect();
  const conn = adapter.connect(symbol, c.h);
  await vi.waitFor(() => expect(FakeWS.instances.at(-1)?.readyState).toBe(1));
  const ws = FakeWS.instances.at(-1)!;
  return { ...c, ws, conn };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.stubGlobal('WebSocket', FakeWS);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('BinanceDepthSync', () => {
  const ev = (U: number, u: number, pu: number, b: [string, string][] = [], a: [string, string][] = []) => ({ U, u, pu, b, a, E: u });

  it('futures: buffers, applies the bridging event and validates pu continuity', () => {
    const out: BookUpdate[] = [];
    const resync = vi.fn();
    const s = new BinanceDepthSync(true, (u) => out.push(u), resync);
    s.onEvent(ev(90, 95, 89));
    s.onEvent(ev(96, 105, 95, [['100', '1']]));
    s.onEvent(ev(106, 110, 105, [], [['101', '2']]));
    s.onSnapshot({ lastUpdateId: 100, bids: [['99', '5']], asks: [['102', '1']] });
    expect(out.map((o) => o.snapshot)).toEqual([true, false, false]);
    expect(out[1].bids).toEqual([[100, 1]]);
    s.onEvent(ev(111, 120, 110));
    expect(out).toHaveLength(4);
    s.onEvent(ev(130, 140, 125)); // gap
    expect(resync).toHaveBeenCalledTimes(1);
    expect(s.isSynced).toBe(false);
  });

  it('spot: requires U <= lastUpdateId+1 <= u and U = prev u + 1', () => {
    const out: BookUpdate[] = [];
    const resync = vi.fn();
    const s = new BinanceDepthSync(false, (u) => out.push(u), resync);
    s.onEvent(ev(95, 100, 0)); // dropped: u <= lastUpdateId
    s.onEvent(ev(101, 103, 0));
    s.onSnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(out).toHaveLength(2);
    s.onEvent(ev(104, 106, 0));
    expect(out).toHaveLength(3);
    s.onEvent(ev(108, 109, 0));
    expect(resync).toHaveBeenCalled();
  });

  it('resyncs when the first buffered event does not bridge the snapshot', () => {
    const resync = vi.fn();
    const s = new BinanceDepthSync(true, () => undefined, resync);
    s.onEvent(ev(150, 160, 149));
    s.onSnapshot({ lastUpdateId: 100, bids: [], asks: [] });
    expect(resync).toHaveBeenCalled();
  });
});

describe('Binance futures adapter', () => {
  it('parses aggTrade, forceOrder, markPrice and 24h ticker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ lastUpdateId: 1, bids: [['100', '1']], asks: [['101', '1']] }) })),
    );
    const { out, conn } = await open(binanceFutures, 'BTCUSDT');
    // routed endpoints (the bare /stream URL stopped delivering trades on 2026-04-23)
    const sockets = FakeWS.instances.slice(-2);
    const pub = sockets.find((x) => x.url.includes('/public/'))!;
    const ws = sockets.find((x) => x.url.includes('/market/'))!;
    expect(pub.url).toBe('wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms');
    expect(ws.url).toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@ticker/btcusdt@forceOrder/btcusdt@markPrice@1s');
    await vi.waitFor(() => expect(sockets.every((x) => x.readyState === 1)).toBe(true));
    await vi.waitFor(() => expect(out.states.at(-1)).toBe('open'));
    ws.emit({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: 1, s: 'BTCUSDT', a: 5, p: '100.5', q: '0.2', T: 1000, m: true } });
    ws.emit({ stream: 'btcusdt@forceOrder', data: { e: 'forceOrder', E: 2, o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', p: '99', ap: '99.5', z: '0.5', T: 2000 } } });
    ws.emit({ stream: 'btcusdt@markPrice', data: { e: 'markPriceUpdate', E: 3, s: 'BTCUSDT', p: '100.1', i: '100', r: '0.0001', T: 9999 } });
    ws.emit({ stream: 'btcusdt@ticker', data: { e: '24hrTicker', E: 4, c: '100.4', P: '-1.5', h: '105', l: '95', q: '123456' } });
    expect(out.trades).toEqual([{ venue: 'binancef', price: 100.5, qty: 0.2, side: 'sell', time: 1000 }]);
    expect(out.liqs[0]).toMatchObject({ position: 'long', price: 99.5, qty: 0.5 });
    expect(out.stats).toMatchObject({ markPrice: 100.1, indexPrice: 100, fundingRate: 0.0001, last: 100.4, change24hPct: -1.5, volume24hUsd: 123456 });
    await vi.waitFor(() => expect(out.books.some((b) => b.snapshot)).toBe(true), { timeout: 3000 });
    // either route dropping marks the feed as not open
    ws.close();
    expect(out.states.at(-1)).toBe('error');
    conn.close();
  });
});

describe('Bybit adapter', () => {
  it('subscribes and parses trades, book, tickers and liquidations', async () => {
    const { out, ws, conn } = await open(bybit, 'BTCUSDT');
    expect((ws.sent[0] as any).args).toEqual(['publicTrade.BTCUSDT', 'orderbook.200.BTCUSDT', 'tickers.BTCUSDT', 'allLiquidation.BTCUSDT']);
    ws.emit({ topic: 'publicTrade.BTCUSDT', type: 'snapshot', ts: 1, data: [{ T: 10, s: 'BTCUSDT', S: 'Buy', v: '0.3', p: '100' }] });
    ws.emit({ topic: 'orderbook.200.BTCUSDT', type: 'snapshot', ts: 2, data: { s: 'BTCUSDT', b: [['99', '1']], a: [['101', '2']], u: 5, seq: 10 } });
    ws.emit({ topic: 'orderbook.200.BTCUSDT', type: 'delta', ts: 3, data: { s: 'BTCUSDT', b: [['99', '0']], a: [], u: 6, seq: 11 } });
    ws.emit({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: 4, data: { lastPrice: '100', fundingRate: '0.0002', openInterest: '50000', openInterestValue: '5000000', price24hPcnt: '0.012' } });
    ws.emit({ topic: 'allLiquidation.BTCUSDT', ts: 5, data: [{ T: 20, s: 'BTCUSDT', S: 'Sell', v: '1', p: '98' }] });
    expect(out.trades[0]).toMatchObject({ side: 'buy', qty: 0.3, price: 100 });
    expect(out.books.map((b) => b.snapshot)).toEqual([true, false]);
    expect(out.books[1].bids).toEqual([[99, 0]]);
    expect(out.stats).toMatchObject({ fundingRate: 0.0002, openInterest: 50000, openInterestUsd: 5_000_000, change24hPct: 1.2 });
    expect(out.liqs[0].position).toBe('short');
    conn.close();
  });
});

describe('OKX adapter', () => {
  it('converts contracts to base units and detects book sequence gaps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ ctVal: '0.01' }] }) })));
    const { out, ws, conn } = await open(okx, 'BTC-USDT-SWAP');
    ws.emit({ arg: { channel: 'trades', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', px: '100', sz: '50', side: 'buy', ts: '1000' }] });
    ws.emit({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'snapshot', data: [{ bids: [['99', '200', '0', '3']], asks: [['101', '100', '0', '1']], ts: '1', seqId: 10, prevSeqId: -1 }] });
    ws.emit({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'update', data: [{ bids: [['99', '0', '0', '0']], asks: [], ts: '2', seqId: 11, prevSeqId: 10 }] });
    ws.emit({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'update', data: [{ bids: [], asks: [], ts: '3', seqId: 20, prevSeqId: 15 }] });
    ws.emit({ arg: { channel: 'liquidation-orders', instType: 'SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', details: [{ side: 'sell', posSide: 'long', bkPx: '98', sz: '10', ts: '5' }] }, { instId: 'ETH-USDT-SWAP', details: [{ side: 'buy', posSide: 'short', bkPx: '1', sz: '1', ts: '5' }] }] });
    ws.emit('pong');
    expect(out.trades[0]).toMatchObject({ qty: 0.5, side: 'buy' });
    expect(out.books[0].bids).toEqual([[99, 2]]);
    expect(out.books).toHaveLength(2); // gap update dropped
    expect(ws.sent.slice(-2).map((m: any) => m.op)).toEqual(['unsubscribe', 'subscribe']);
    expect(out.liqs).toHaveLength(1);
    expect(out.liqs[0]).toMatchObject({ position: 'long', qty: 0.1 });
    conn.close();
  });
});

describe('Hyperliquid adapter', () => {
  it('maps aggressor side and full-book snapshots', async () => {
    const { out, ws, conn } = await open(hyperliquid, 'BTC');
    expect(ws.sent.map((m: any) => m.subscription.type)).toEqual(['trades', 'l2Book', 'activeAssetCtx']);
    ws.emit({ channel: 'trades', data: [{ coin: 'BTC', side: 'A', px: '100', sz: '2', time: 5, tid: 1 }] });
    ws.emit({ channel: 'l2Book', data: { coin: 'BTC', time: 6, levels: [[{ px: '99', sz: '1', n: 1 }], [{ px: '101', sz: '3', n: 2 }]] } });
    ws.emit({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { funding: '0.00001', openInterest: '1000', markPx: '100', oraclePx: '99.9', dayNtlVlm: '5000000', prevDayPx: '95', midPx: '100' } } });
    expect(out.trades[0].side).toBe('sell');
    expect(out.books[0]).toMatchObject({ snapshot: true, bids: [[99, 1]], asks: [[101, 3]] });
    expect(out.stats).toMatchObject({ fundingIntervalH: 1, openInterestUsd: 100_000 });
    expect(out.stats.change24hPct).toBeCloseTo(5.263, 2);
    conn.close();
  });
});

describe('Coinbase adapter', () => {
  it('treats reported side as maker side and skips replayed snapshots', async () => {
    const { out, ws, conn } = await open(coinbase, 'BTC-USD');
    expect(ws.sent.map((m: any) => m.channel)).toEqual(['heartbeats', 'level2', 'market_trades', 'ticker']);
    ws.emit({ channel: 'market_trades', timestamp: '2026-01-01T00:00:00Z', events: [{ type: 'snapshot', trades: [{ price: '1', size: '1', side: 'BUY', time: '2026-01-01T00:00:00Z' }] }] });
    ws.emit({ channel: 'market_trades', timestamp: '2026-01-01T00:00:01Z', events: [{ type: 'update', trades: [{ price: '100', size: '0.5', side: 'SELL', time: '2026-01-01T00:00:01Z' }] }] });
    ws.emit({ channel: 'l2_data', timestamp: '2026-01-01T00:00:01Z', events: [{ type: 'snapshot', updates: [{ side: 'bid', price_level: '99', new_quantity: '2' }, { side: 'offer', price_level: '101', new_quantity: '1' }] }] });
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].side).toBe('buy');
    expect(out.books[0]).toMatchObject({ snapshot: true, bids: [[99, 2]], asks: [[101, 1]] });
    conn.close();
  });
});

describe('Kraken adapter', () => {
  it('parses v2 trades and truncates the book to subscribed depth', async () => {
    const { out, ws, conn } = await open(kraken, 'BTC/USD');
    expect(ws.sent.map((m: any) => m.params.channel)).toEqual(['trade', 'book', 'ticker']);
    ws.emit({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: 'sell', price: 100, qty: 0.1, timestamp: '2026-01-01T00:00:00.000Z' }] });
    ws.emit({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: [{ price: 99, qty: 1 }], asks: [{ price: 101, qty: 1 }], timestamp: '2026-01-01T00:00:00.000Z' }] });
    expect(out.trades[0]).toMatchObject({ side: 'sell', price: 100 });
    expect(out.books[0].snapshot).toBe(true);
    conn.close();
  });
});

describe('Bitget adapter', () => {
  it('ignores the trade snapshot and parses updates/books/ticker', async () => {
    const { out, ws, conn } = await open(bitget, 'BTCUSDT');
    ws.emit({ action: 'snapshot', arg: { channel: 'trade', instId: 'BTCUSDT' }, data: [{ ts: '1', price: '1', size: '1', side: 'buy' }], ts: 1 });
    ws.emit({ action: 'update', arg: { channel: 'trade', instId: 'BTCUSDT' }, data: [{ ts: '3', price: '101', size: '1', side: 'sell' }, { ts: '2', price: '100', size: '2', side: 'buy' }], ts: 3 });
    ws.emit({ action: 'snapshot', arg: { channel: 'books', instId: 'BTCUSDT' }, data: [{ bids: [['99', '1']], asks: [['101', '2']], ts: '4' }], ts: 4 });
    ws.emit({ action: 'snapshot', arg: { channel: 'ticker', instId: 'BTCUSDT' }, data: [{ lastPr: '100', holdingAmount: '10', fundingRate: '0.0001', change24h: '0.02' }], ts: 5 });
    expect(out.trades.map((t) => t.time)).toEqual([2, 3]);
    expect(out.books[0].asks).toEqual([[101, 2]]);
    expect(out.stats).toMatchObject({ openInterestUsd: 1000, change24hPct: 2 });
    conn.close();
  });
});

describe('Bitfinex adapter', () => {
  it('routes channel ids and decodes trades and book entries', async () => {
    const { out, ws, conn } = await open(bitfinex, 'tBTCUSD');
    ws.emit({ event: 'subscribed', channel: 'trades', chanId: 7 });
    ws.emit({ event: 'subscribed', channel: 'book', chanId: 8 });
    ws.emit([7, 'te', [1, 1000, -0.5, 100]]);
    ws.emit([7, 'tu', [1, 1000, -0.5, 100]]);
    ws.emit([7, 'hb']);
    ws.emit([8, [[99, 1, 2], [101, 2, -3]]]);
    ws.emit([8, [99, 0, 1]]);
    expect(out.trades).toEqual([{ venue: 'bitfinex', price: 100, qty: 0.5, side: 'sell', time: 1000 }]);
    expect(out.books[0]).toMatchObject({ snapshot: true, bids: [[99, 2]], asks: [[101, 3]] });
    expect(out.books[1]).toMatchObject({ snapshot: false, bids: [[99, 0]] });
    expect(bitfinexSymbol('DOGE')).toBe('tDOGE:USD');
    conn.close();
  });
});

describe('Deribit & news parsing', () => {
  it('parses option instrument names and premiums', () => {
    expect(parseOptionName('BTC-27DEC24-100000-C')).toEqual({ underlying: 'BTC', expiry: Date.UTC(2024, 11, 27, 8), strike: 100000, kind: 'C' });
    expect(parseOptionName('XRP_USDC-7MAR25-2d5-P')?.strike).toBe(2.5);
    expect(parseOptionName('BTC-PERPETUAL')).toBeNull();
    const t = toOptionTrade({ trade_id: 'x', timestamp: 1, instrument_name: 'BTC-27DEC24-100000-C', direction: 'buy', amount: 10, price: 0.05, index_price: 90000, iv: 55, block_trade_id: 'b' })!;
    expect(t.premiumUsd).toBeCloseTo(45000);
    expect(t.block).toBe(true);
  });

  it('normalises news items', () => {
    const n = toNewsItem({ _id: 'a', title: 'Hello', source: 'Blog', time: 5, symbols: ['BTCUSDT', 'ETH_USDT'], suggestions: [{ coin: 'SOL' }] })!;
    expect(n.coins.sort()).toEqual(['BTC', 'ETH', 'SOL']);
    expect(toNewsItem({})).toBeNull();
  });
});

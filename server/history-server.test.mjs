import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHandler, parseArgs } from './history-server.mjs';
import { binanceBackfill } from './ingest.mjs';
import { MarketStore } from './store.mjs';
import { byodInfo, byodLiquidations, byodTrades } from '../src/history/byod';

const T0 = 1_700_000_000_000;

function seeded() {
  const s = new MarketStore('binancef', 'BTCUSDT');
  for (let i = 0; i < 1000; i++) s.addTrade(i + 1, T0 + i * 1000, 50_000 + i, 0.01 * (i % 7 + 1), i % 2 === 0);
  s.addLiquidation(T0 + 5000, 50_005, 2, 'long');
  s.addLiquidation(T0 + 9000, 50_009, 1, 'short');
  return s;
}

describe('MarketStore', () => {
  it('rejects invalid and duplicate trades and keeps time order', () => {
    const s = new MarketStore('binancef', 'BTCUSDT');
    expect(s.addTrade(1, T0, 100, 1, false)).toBe(true);
    expect(s.addTrade(1, T0 + 1, 100, 1, false)).toBe(false);
    expect(s.addTrade(2, T0 + 1, 0, 1, false)).toBe(false);
    expect(s.addTrade(3, T0 + 1, 100, -1, false)).toBe(false);
    expect(s.addTrade(4, T0 - 50, 101, 1, true)).toBe(true);
    expect(s.trades.at(1, 1)).toBe(T0);
  });

  it('queries ranges and truncates to the most recent rows', () => {
    const s = seeded();
    const all = s.queryTrades(T0, T0 + 999_000, 10_000);
    expect(all.trades).toHaveLength(1000);
    expect(all.truncated).toBe(false);
    const r = s.queryTrades(T0 + 10_000, T0 + 19_000, 5);
    expect(r.truncated).toBe(true);
    expect(r.trades.map((t) => t.trade_id)).toEqual([16, 17, 18, 19, 20]);
    expect(r.actual_start_ms).toBe(T0 + 15_000);
    expect(r.trades[0]).toEqual({ trade_id: 16, price: 50_015, quantity: 0.02, timestamp_ms: T0 + 15_000, is_buyer_maker: false });
  });

  it('prunes by time and prepends older trades', () => {
    const s = seeded();
    s.prune(T0 + 500_000);
    expect(s.trades.len).toBe(500);
    expect(s.liqs.len).toBe(0);
    const s2 = new MarketStore('binancef', 'BTCUSDT');
    s2.addTrade(100, T0 + 100, 1, 1, false);
    expect(s2.prependTrades([{ id: 99, time: T0 + 99, price: 1, qty: 1, isBuyerMaker: true }, { id: 100, time: T0 + 100, price: 1, qty: 1, isBuyerMaker: true }])).toBe(1);
    expect(s2.trades.at(0, 0)).toBe(99);
    expect(s2.trades.len).toBe(2);
  });

  it('persists and reloads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oft-'));
    try {
      const s = seeded();
      s.save(dir);
      const r = new MarketStore('binancef', 'BTCUSDT');
      expect(r.load(dir)).toBe(1000);
      expect(r.liqs.len).toBe(2);
      expect(r.lastTradeId).toBe(1000);
      expect(r.queryTrades(T0, T0 + 2000, 10).trades).toEqual(s.queryTrades(T0, T0 + 2000, 10).trades);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseArgs', () => {
  it('parses flags and validates', () => {
    const o = parseArgs(['--port', '9000', '--symbols', 'btcusdt,ethusdt', '--auth-token', 'x', '--exchange', 'bybit']);
    expect(o.port).toBe(9000);
    expect(o.symbols).toEqual(['btcusdt', 'ethusdt']);
    expect(o.exchange).toBe('bybit');
    expect(() => parseArgs(['--exchange', 'ftx'])).toThrow();
    expect(() => parseArgs(['--port'])).toThrow();
    expect(() => parseArgs(['--wat'])).toThrow();
  });
});

describe('binanceBackfill', () => {
  it('paginates by id until a short page', async () => {
    const calls = [];
    const page = (from, n) => Array.from({ length: n }, (_, i) => ({ a: from + i, T: T0 + from + i, p: '1', q: '2', m: i % 2 === 0 }));
    const fetchImpl = async (url) => {
      calls.push(url);
      const rows = calls.length === 1 ? page(0, 1000) : page(1000, 10);
      return { ok: true, json: async () => rows };
    };
    const rows = await binanceBackfill(true, 'BTCUSDT', { fromMs: T0, fetchImpl });
    expect(rows).toHaveLength(1010);
    expect(calls[0]).toContain('startTime=');
    expect(calls[1]).toContain('fromId=1000');
  });
});

describe('HTTP API + terminal BYOD client', () => {
  let server;
  let url;
  beforeAll(async () => {
    const stores = new Map([['BTCUSDT', seeded()]]);
    server = createServer(createHandler({ exchange: 'binancef', stores, authToken: 'secret' }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => server.close());

  it('serves health without auth and enforces auth on /v1', async () => {
    expect(await (await fetch(`${url}/health`)).text()).toBe('ok');
    const r = await fetch(`${url}/v1/info`);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('unauthorized');
  });

  it('validates parameters', async () => {
    const h = { Authorization: 'Bearer secret' };
    expect((await fetch(`${url}/v1/trades?exchange=binancef&symbol=BTCUSDT&start_ms=5&end_ms=1`, { headers: h })).status).toBe(400);
    expect((await fetch(`${url}/v1/trades?exchange=bybit&symbol=BTCUSDT&start_ms=1&end_ms=5`, { headers: h })).status).toBe(404);
    expect((await fetch(`${url}/v1/trades?exchange=binancef&symbol=DOGE&start_ms=1&end_ms=5`, { headers: h })).status).toBe(404);
    const pre = await fetch(`${url}/v1/info`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('works end-to-end with the terminal client', async () => {
    const info = await byodInfo(url, 'secret');
    expect(info.protocol_version).toBe(1);
    expect(info.exchanges[0].symbols[0]).toMatchObject({ symbol: 'BTCUSDT', has_trades: true, has_liquidations: true, data_start_ms: T0 });
    const trades = await byodTrades(url, 'secret', 'binancef', 'BTCUSDT', T0, T0 + 3_600_000);
    expect(trades).toHaveLength(1000);
    expect(trades[0]).toEqual({ price: 50_000, qty: 0.01, side: 'sell', time: T0 });
    expect(trades[1].side).toBe('buy');
    const liqs = await byodLiquidations(url, 'secret', 'binancef', 'BTCUSDT', T0, T0 + 3_600_000);
    expect(liqs.map((l) => l.position)).toEqual(['long', 'short']);
    await expect(byodInfo(url, 'wrong')).rejects.toThrow(/401/);
    await expect(byodInfo('', '')).rejects.toThrow(/not configured/);
  });
});

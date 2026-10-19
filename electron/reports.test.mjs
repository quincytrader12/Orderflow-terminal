import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from './db.mjs';
import { DAY, profileLevels, reportData, summarizeBots, volumeNodes } from './reports.mjs';

let dir;
let db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'novus-rep-'));
  db = new Db(join(dir, 'r.sqlite'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 9, 19, 14);

/** Two-humped day: heavy trade near 100 and 104, thin in between. */
function recordDay(start, center = 100) {
  const rows = [];
  let s = 11;
  const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = 0; i < 4000; i++) {
    const hump = i % 3 === 0 ? center + 4 : center;
    rows.push({ t: start + i * 20_000, p: Number((hump + (r() + r() - 1) * 0.8).toFixed(2)), q: 1, s: r() < 0.5 ? 'buy' : 'sell' });
  }
  db.recordTrades('binancef', 'BTCUSDT', rows);
}

describe('report data', () => {
  it('computes value area and volume nodes in SQL', () => {
    recordDay(NOW - DAY);
    const v = profileLevels(db, 'binancef', 'BTCUSDT', NOW - DAY, NOW);
    expect(v.n).toBe(4000);
    expect(v.poc).toBeGreaterThan(99.5);
    expect(v.poc).toBeLessThan(100.5);
    expect(v.val).toBeLessThan(v.poc);
    expect(v.vah).toBeGreaterThan(v.poc);
    expect(v.hvn.some((p) => Math.abs(p - 104) < 0.6)).toBe(true);
    expect(v.lvn.some((p) => p > 101 && p < 103)).toBe(true);
    expect(v.profile.length).toBeLessThanOrEqual(91);
    expect(profileLevels(db, 'binancef', 'ETHUSDT', 0, NOW)).toBeNull();
  });

  it('finds nodes on a simple profile', () => {
    const rows = [];
    for (let k = 0; k < 40; k++) rows.push([k, k === 10 ? 100 : k === 30 ? 80 : k > 17 && k < 23 ? 1 : 30]);
    const n = volumeNodes(rows, 10);
    expect(n.hvn).toContain(30);
    expect(n.lvn.some((k) => k >= 18 && k <= 22)).toBe(true);
  });

  it('summarises bot trades with equity and drawdown', () => {
    const t = (pnl, setup, i) => ({ bot_id: 'a', bot_name: 'A', symbol: 'BTC', mode: 'paper', setup, side: 'buy', pnl, fees: 0.1, closed: i });
    const s = summarizeBots([t(5, 'fade', 1), t(-8, 'breakout', 2), t(4, 'fade', 3)]);
    expect(s).toMatchObject({ trades: 3, wins: 2, pnl: 1, maxDrawdown: 8 });
    expect(s.fees).toBeCloseTo(0.3);
    expect(s.setups.find((x) => x.setup === 'fade')).toMatchObject({ trades: 2, wins: 2, pnl: 9 });
    expect(s.best.pnl).toBe(5);
    expect(s.worst.pnl).toBe(-8);
    expect(s.equity.map((p) => p[1])).toEqual([5, -3, 1]);
  });

  it('gathers bots, orders, value, accounts and wallets for a daily report', async () => {
    recordDay(NOW - 2 * DAY + 3_600_000, 95);
    recordDay(NOW - DAY + 1000);
    db.recordAmtTrade({ botId: 'b1', botName: 'BTC perp', symbol: 'BTC/USDT:USDT', mode: 'paper', setup: 'breakout', side: 'buy', entry: 100, exit: 101, qty: 1, pnl: 0.9, fees: 0.1, opened: NOW - 5000, closed: NOW - 1000, reason: 'target' });
    db.recordAmtTrade({ botId: 'b1', botName: 'BTC perp', symbol: 'BTC/USDT:USDT', mode: 'paper', setup: 'fade', side: 'sell', entry: 100, exit: 101, qty: 1, pnl: -1.1, fees: 0.1, opened: NOW - 3 * DAY, closed: NOW - 3 * DAY, reason: 'stop' });
    db.logOrder({ action: 'place', status: 'placed' });
    db.logOrder({ action: 'place', status: 'rejected' });
    db.db.prepare('UPDATE orders_log SET t = ?').run(NOW - 1000);
    db.putWallet('Addr111', 'solana', true);
    const deps = {
      db,
      vault: { list: () => [{ id: 'k1', kind: 'exchange', label: 'Main', exchange: 'bybit' }, { id: 'k2', kind: 'exchange', label: 'Broken', exchange: 'okx' }], reveal: () => ({ fields: {} }) },
      ccxt: {
        account: async (id) => {
          if (id === 'k2') throw new Error('invalid api key');
          return { exchange: 'Bybit', balances: [{ currency: 'BTC', total: 0.1 }, { currency: 'USDT', total: 500 }], positions: [], errors: {} };
        },
      },
      wallets: {
        balances: async () => ({ address: 'Addr111', sol: 2, tokens: [{ mint: 'M1', amount: 10, decimals: 6 }, { mint: 'DUST', amount: 1, decimals: 6 }] }),
        tokenInfo: async () => ({ prices: { SOL: 150, M1: 2, DUST: 0.001 }, meta: { M1: { symbol: 'JUP', name: 'Jupiter' } } }),
      },
      defaultRpc: 'https://rpc.test',
      solMint: 'SOL',
    };
    const d = await reportData(deps, 'daily', { venue: 'binancef', symbol: 'BTCUSDT', now: NOW });
    expect(d.value.poc).toBeGreaterThan(99);
    expect(d.priorDay.poc).toBeLessThan(97);
    expect(d.today.n).toBeGreaterThan(0);
    expect(d.bots).toMatchObject({ trades: 1, pnl: 0.9 });
    expect(d.orders).toMatchObject({ placed: 1, rejected: 1 });
    expect(d.recorded).toMatchObject({ instruments: 1, trades: 8000 });
    expect(d.accounts[0].balances.map((b) => b.currency)).toEqual(['USDT', 'BTC']);
    expect(d.accounts[1]).toMatchObject({ label: 'Broken', error: 'invalid api key' });
    expect(d.wallets[0]).toMatchObject({ address: 'Addr111', sol: 2, usd: 320, tokens: [{ symbol: 'JUP', amount: 10, usd: 20 }] });

    const w = await reportData(deps, 'weekly', { venue: 'binancef', symbol: 'BTCUSDT', now: NOW });
    expect(w.bots.trades).toBe(2);
    expect(w.priorWeek).toBeNull();
  });
});

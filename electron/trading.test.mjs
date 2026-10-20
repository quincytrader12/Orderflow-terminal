import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CcxtService } from './ccxt-service.mjs';
import { Db } from './db.mjs';
import { buildOrder, closeOrderFor, DEFAULT_LIMITS, RateGate, sanitizeLimits } from './trading.mjs';
import { Vault } from './vault.mjs';

const spot = { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', contract: false, limits: { amount: { min: 0.0001 }, cost: { min: 10 } } };
const perp = { symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT', contract: true, linear: true, contractSize: 0.001, limits: { amount: { min: 1 } } };
const inverse = { symbol: 'BTC/USD:BTC', base: 'BTC', quote: 'USD', contract: true, inverse: true, contractSize: 100, limits: {} };
const ctx = { refPrice: 50_000, quoteUsd: 1, limits: DEFAULT_LIMITS };

describe('buildOrder', () => {
  it('sizes a USD spot market order in base units', () => {
    const o = buildOrder({ symbol: 'BTC/USDT', side: 'buy', type: 'market', sizeMode: 'quote', size: 500 }, spot, ctx);
    expect(o).toMatchObject({ type: 'market', side: 'buy', amount: 0.01, price: undefined, params: {} });
    expect(o.notionalUsd).toBeCloseTo(500);
  });

  it('converts base size to contracts and applies precision', () => {
    const o = buildOrder({ symbol: 'BTC/USDT:USDT', side: 'sell', type: 'limit', sizeMode: 'base', size: 0.0123, price: 51_000, tif: 'IOC' }, perp, {
      ...ctx,
      amountToPrecision: (x) => Math.floor(x),
    });
    expect(o.amount).toBe(12);
    expect(o.price).toBe(51_000);
    expect(o.params).toEqual({ timeInForce: 'IOC' });
    expect(o.notionalUsd).toBeCloseTo(12 * 0.001 * 51_000);
  });

  it('sizes inverse contracts in USD', () => {
    const o = buildOrder({ symbol: 'BTC/USD:BTC', side: 'buy', type: 'market', sizeMode: 'quote', size: 800 }, inverse, ctx);
    expect(o.amount).toBe(8);
    expect(o.notionalUsd).toBe(800);
  });

  it('builds stop orders with a trigger price and rejects stops that would fire at once', () => {
    const stop = buildOrder({ symbol: 'BTC/USDT:USDT', side: 'sell', type: 'stop-market', sizeMode: 'base', size: 0.01, triggerPrice: 48_000, reduceOnly: true }, perp, ctx);
    expect(stop).toMatchObject({ type: 'market', amount: 10, params: { triggerPrice: 48_000, reduceOnly: true } });
    const sl = buildOrder({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'stop-limit', sizeMode: 'base', size: 0.01, triggerPrice: 52_000, price: 52_100 }, perp, ctx);
    expect(sl).toMatchObject({ type: 'limit', price: 52_100, params: { triggerPrice: 52_000 } });
    expect(() => buildOrder({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'stop-market', sizeMode: 'base', size: 0.01, triggerPrice: 49_000 }, perp, ctx)).toThrow(/above the current price/);
  });

  it('enforces the USD cap except for reduce-only orders', () => {
    const big = { symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', sizeMode: 'quote', size: 5_000 };
    expect(() => buildOrder(big, perp, ctx)).toThrow(/above your cap of \$1000/);
    expect(buildOrder({ ...big, side: 'sell', reduceOnly: true }, perp, ctx).amount).toBe(100);
  });

  it('values non-dollar quotes through quoteUsd and refuses when it cannot', () => {
    const ethbtc = { symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', contract: false, limits: {} };
    const r = { symbol: 'ETH/BTC', side: 'buy', type: 'market', sizeMode: 'base', size: 0.2 };
    const o = buildOrder(r, ethbtc, { ...ctx, refPrice: 0.05, quoteUsd: 60_000 });
    expect(o.notionalUsd).toBeCloseTo(600, 6);
    expect(() => buildOrder({ ...r, size: 1 }, ethbtc, { ...ctx, refPrice: 0.05, quoteUsd: 60_000 })).toThrow(/\$3000.00 is above/);
    expect(() => buildOrder({ ...r, size: 0.1 }, ethbtc, { ...ctx, refPrice: 0.05, quoteUsd: NaN })).toThrow(/cannot value BTC/);
  });

  it('catches fat fingers and malformed tickets', () => {
    const r = { symbol: 'BTC/USDT', side: 'buy', type: 'limit', sizeMode: 'base', size: 0.001 };
    expect(() => buildOrder({ ...r, price: 5_000 }, spot, ctx)).toThrow(/90.0% away/);
    expect(() => buildOrder(r, spot, ctx)).toThrow(/need a price/);
    expect(() => buildOrder({ ...r, price: 50_000, size: 0 }, spot, ctx)).toThrow(/size/);
    expect(() => buildOrder({ ...r, price: 50_000, reduceOnly: true }, spot, ctx)).toThrow(/spot market/);
    expect(() => buildOrder({ ...r, type: 'market', postOnly: true }, spot, ctx)).toThrow(/post-only/);
    expect(() => buildOrder({ ...r, price: 50_000, size: 0.00001 }, spot, ctx)).toThrow(/minimum size/);
    expect(() => buildOrder({ ...r, price: 50_000, size: 0.0001 }, spot, ctx)).toThrow(/minimum order value is 10/);
    expect(() => buildOrder({ ...r, side: 'hold', price: 50_000 }, spot, ctx)).toThrow(/side/);
    expect(() => buildOrder(r, undefined, ctx)).toThrow(/not listed/);
    expect(buildOrder({ ...r, price: 49_000, postOnly: true, tif: 'GTC' }, spot, ctx).params).toEqual({ postOnly: true });
  });

  it('sizes exits in exact contracts and exempts verified spot closes from the cap', () => {
    const okx = { ...perp, contractSize: 0.01 };
    const o = buildOrder({ symbol: 'BTC/USDT:USDT', side: 'sell', type: 'market', sizeMode: 'contracts', size: 58, reduceOnly: true }, okx, { ...ctx, amountToPrecision: (x) => Math.floor(x) });
    expect(o.amount).toBe(58);
    const big = { symbol: 'BTC/USDT', side: 'sell', type: 'market', sizeMode: 'contracts', size: 0.1 };
    expect(() => buildOrder(big, spot, ctx)).toThrow(/above your cap/);
    expect(buildOrder(big, spot, { ...ctx, capExempt: true }).amount).toBe(0.1);
  });

  it('clamps limits and rate-limits orders per minute', () => {
    expect(sanitizeLimits({ maxOrderUsd: -5, maxOrdersPerMinute: 'x' })).toEqual({ maxOrderUsd: 1, maxOrdersPerMinute: 10, maxPriceDeviationPct: 50 });
    const g = new RateGate();
    g.take(2, 0);
    g.take(2, 1);
    expect(() => g.take(2, 2)).toThrow(/2 per minute/);
    g.take(2, 60_001);
  });

  it('closes positions with an opposite reduce-only market order', () => {
    expect(closeOrderFor({ symbol: 'ETH/USDT:USDT', side: 'short', contracts: 3 })).toEqual({ symbol: 'ETH/USDT:USDT', type: 'market', side: 'buy', amount: 3, price: undefined, params: { reduceOnly: true } });
    expect(() => closeOrderFor(undefined)).toThrow(/no open position/);
  });
});

/** Minimal CCXT double: one exchange class with a perp market. */
function fakeLib() {
  const created = [];
  class FakeEx {
    constructor(cfg) {
      this.cfg = cfg;
      this.name = 'FakeEx';
      this.has = { setLeverage: true, fetchPositions: true, cancelAllOrders: true };
      this.options = {};
      this.sandbox = false;
      this.markets = { 'BTC/USDT:USDT': perp, 'BTC/USDT': spot };
      this.leverage = null;
    }
    setSandboxMode(v) {
      this.sandbox = v;
    }
    async loadMarkets() {
      return this.markets;
    }
    async fetchTicker() {
      return { last: 50_000, bid: 49_990, ask: 50_010 };
    }
    async fetchBalance() {
      return { free: { USDT: 1234, BTC: 0.5 } };
    }
    amountToPrecision(s, x) {
      // perps trade whole contracts, spot to 4 decimals
      return String(this.markets[s].contract ? Math.floor(x) : Math.floor(x * 1e4) / 1e4);
    }
    priceToPrecision(_s, x) {
      return String(Math.round(x * 10) / 10);
    }
    async setLeverage(l) {
      if (this.leverage === l) throw new Error('leverage not modified');
      this.leverage = l;
    }
    async createOrder(symbol, type, side, amount, price, params) {
      created.push({ symbol, type, side, amount, price, params, sandbox: this.sandbox, leverage: this.leverage, apiKey: this.cfg.apiKey });
      return { id: `o${created.length}`, status: 'open' };
    }
    async cancelOrder(id, symbol) {
      created.push({ cancel: id, symbol });
    }
    async cancelAllOrders() {
      return [{}, {}];
    }
    async fetchPositions() {
      return [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 7 }];
    }
  }
  return { lib: { fakeex: FakeEx, pro: {} }, created };
}

describe('CcxtService trading', () => {
  let dir;
  let db;
  let vault;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'novus-trade-'));
    db = new Db(join(dir, 't.sqlite'));
    vault = new Vault(db, { isEncryptionAvailable: () => false }, join(dir, 'vault.key'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const order = { symbol: 'BTC/USDT:USDT', side: 'buy', type: 'limit', sizeMode: 'quote', size: 500, price: 49_900, leverage: 3 };

  it('refuses to trade until the key allows it, and logs the attempt', async () => {
    const { lib, created } = fakeLib();
    const svc = new CcxtService(vault, { db, lib });
    const id = vault.save({ label: 'Main', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k', secret: 's' } });
    await expect(svc.placeOrder(id, order)).rejects.toThrow(/Trading is off/);
    expect(created).toHaveLength(0);
    expect(db.orderLog()[0]).toMatchObject({ action: 'place', status: 'rejected', exchange: null });
    // the vault never lists the trading flag as a secret
    vault.save({ id, label: 'Main', kind: 'exchange', exchange: 'fakeex', fields: { trading: 'enabled', sandbox: 'true' } });
    expect(vault.list()[0].meta.fields).toMatchObject({ trading: 'enabled', sandbox: 'true' });
  });

  it('places, cancels and closes on the testnet with the configured limits', async () => {
    const { lib, created } = fakeLib();
    const svc = new CcxtService(vault, { db, lib });
    const id = vault.save({ label: 'Test', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k', secret: 's', trading: 'enabled', sandbox: 'true' } });

    const r = await svc.placeOrder(id, order);
    expect(r).toMatchObject({ id: 'o1', side: 'buy', amount: 10, price: 49_900, sandbox: true });
    expect(created[0]).toMatchObject({ symbol: 'BTC/USDT:USDT', type: 'limit', amount: 10, price: 49_900, sandbox: true, leverage: 3, apiKey: 'k' });
    // same leverage again: the exchange's "not modified" error is not fatal
    await svc.placeOrder(id, order);

    svc.setLimits({ maxOrderUsd: 100 });
    await expect(svc.placeOrder(id, order)).rejects.toThrow(/cap of \$100/);

    expect(await svc.cancelOrder(id, 'o1', 'BTC/USDT:USDT')).toBe(true);
    expect(await svc.cancelAll(id, 'BTC/USDT:USDT')).toBe(2);
    const close = await svc.closePosition(id, 'BTC/USDT:USDT', 'long');
    expect(close).toMatchObject({ side: 'sell', amount: 7 });
    expect(created.at(-1)).toMatchObject({ type: 'market', side: 'sell', amount: 7, params: { reduceOnly: true } });

    const log = db.orderLog();
    expect(log.map((l) => `${l.action}:${l.status}`)).toEqual(['close:placed', 'cancel-all:cancelled', 'cancel:cancelled', 'place:rejected', 'place:placed', 'place:placed']);
    expect(log.at(-1)).toMatchObject({ exchange: 'fakeex', sandbox: 1, symbol: 'BTC/USDT:USDT', side: 'buy', amount: 10, price: 49_900, order_id: 'o1' });
    expect(JSON.stringify(log)).not.toContain('"k"');
  });

  it('rate-limits bursts and drops the cached client when a key changes', async () => {
    const { lib } = fakeLib();
    const svc = new CcxtService(vault, { db, lib });
    const id = vault.save({ label: 'Test', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k1', secret: 's', trading: 'enabled' } });
    svc.setLimits({ maxOrdersPerMinute: 1 });
    const small = { ...order, size: 50, leverage: undefined };
    await svc.placeOrder(id, small);
    await expect(svc.placeOrder(id, small)).rejects.toThrow(/1 per minute/);
    const before = svc.privateExchange(id);
    vault.save({ id, label: 'Test', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k2' } });
    expect(svc.privateExchange(id)).toBe(before);
    svc.invalidate(id);
    expect(svc.privateExchange(id).cfg.apiKey).toBe('k2');
  });

  it('never silently trades live when the exchange has no testnet', async () => {
    const { lib } = fakeLib();
    lib.fakeex.prototype.setSandboxMode = () => {
      throw new Error('no sandbox');
    };
    const svc = new CcxtService(vault, { db, lib });
    const id = vault.save({ label: 'Test', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k', trading: 'enabled', sandbox: 'true' } });
    await expect(svc.placeOrder(id, order)).rejects.toThrow(/has no testnet/);
  });

  it('checks spot closes against holdings and clamps reduce-only to the position', async () => {
    const { lib, created } = fakeLib();
    const svc = new CcxtService(vault, { db, lib });
    const id = vault.save({ label: 'T', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k', trading: 'enabled' } });
    await expect(svc.placeOrder(id, { symbol: 'BTC/USDT', side: 'sell', type: 'market', sizeMode: 'contracts', size: 0.6, closeSpot: true })).rejects.toThrow(/only 0.5 held/);
    // 0.5 BTC ≈ $25k: far above the $1000 cap, but it only sells what is held
    await svc.placeOrder(id, { symbol: 'BTC/USDT', side: 'sell', type: 'market', sizeMode: 'contracts', size: 0.5, closeSpot: true });
    expect(created.at(-1)).toMatchObject({ symbol: 'BTC/USDT', side: 'sell', amount: 0.5 });
    // the fake account holds a 7-contract long: a 9-contract reduce-only sell is trimmed to 7
    await svc.placeOrder(id, { symbol: 'BTC/USDT:USDT', side: 'sell', type: 'market', sizeMode: 'contracts', size: 9, reduceOnly: true });
    expect(created.at(-1)).toMatchObject({ amount: 7, params: { reduceOnly: true } });
    await expect(svc.placeOrder(id, { symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', sizeMode: 'contracts', size: 1, reduceOnly: true })).rejects.toThrow(/no short position/);
  });

  it('reports market info for the ticket', async () => {
    const { lib } = fakeLib();
    const svc = new CcxtService(vault, { db, lib });
    const id = vault.save({ label: 'Main', kind: 'exchange', exchange: 'fakeex', fields: { apiKey: 'k' } });
    const info = await svc.marketInfo(id, 'BTC/USDT:USDT');
    expect(info).toMatchObject({ trading: false, sandbox: false, contract: true, contractSize: 0.001, last: 50_000, bid: 49_990, ask: 50_010, freeQuote: 1234, canLeverage: true, limits: DEFAULT_LIMITS });
  });
});

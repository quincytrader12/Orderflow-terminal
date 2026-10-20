import { describe, expect, it, vi } from 'vitest';
import { clockSafe, isClockError } from './clock.mjs';

class FakeBinance {
  constructor() {
    this.id = 'binance';
    this.has = { fetchTime: true };
    this.options = { recvWindow: 5000 };
    this.calls = 0;
    this.offsetFixed = false;
  }
  async loadTimeDifference() {
    this.options.timeDifference = 4321;
    this.offsetFixed = true;
  }
  async request() {
    this.calls++;
    if (!this.offsetFixed) throw new Error('binance {"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}');
    return { ok: true };
  }
}

describe('clock-safe signing', () => {
  it('recognises clock errors from several exchanges, and nothing else', () => {
    expect(isClockError(new Error('binance {"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}'))).toBe(true);
    expect(isClockError(new Error('bybit {"retCode":10002,"retMsg":"invalid request, please check your server timestamp or recv_window param"}'))).toBe(true);
    expect(isClockError(new Error('okx {"code":"50102","msg":"Timestamp request expired"}'))).toBe(true);
    expect(isClockError(new Error('binance {"code":-2010,"msg":"Account has insufficient balance"}'))).toBe(false);
    expect(isClockError(new Error('binance {"code":-2015,"msg":"Invalid API-key, IP, or permissions for action."}'))).toBe(false);
  });

  it('turns on server-time signing with a 10 s window', () => {
    const ex = clockSafe(new FakeBinance());
    expect(ex.options).toMatchObject({ adjustForTimeDifference: true, recvWindow: 10_000 });
  });

  it('re-syncs to the exchange clock and retries a rejected request once', async () => {
    const onSync = vi.fn();
    const ex = clockSafe(new FakeBinance(), onSync);
    await expect(ex.request('account')).resolves.toEqual({ ok: true });
    expect(ex.calls).toBe(2);
    expect(onSync).toHaveBeenCalledWith(4321);
  });

  it('does not retry other errors', async () => {
    const ex = new FakeBinance();
    ex.request = async () => {
      ex.calls++;
      throw new Error('binance {"code":-2010,"msg":"insufficient balance"}');
    };
    clockSafe(ex);
    await expect(ex.request()).rejects.toThrow(/insufficient/);
    expect(ex.calls).toBe(1);
  });

  it('Coinbase tokens are stamped with exchange time', () => {
    const ex = clockSafe(Object.assign(new FakeBinance(), { id: 'coinbase' }));
    ex.options.timeDifference = 90_000; // PC 90 s fast
    expect(Math.abs(ex.seconds() - (Math.floor(Date.now() / 1000) - 90))).toBeLessThanOrEqual(1);
  });
});

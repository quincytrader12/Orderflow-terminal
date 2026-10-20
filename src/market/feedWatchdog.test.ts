import { describe, expect, it } from 'vitest';
import { Feed, type MarketHub } from './hub';

describe('trade-stream watchdog', () => {
  const make = () => {
    let bumps = 0;
    const hubStub = { bump: () => bumps++, emitTrade: () => undefined, emitLiq: () => undefined } as unknown as MarketHub;
    const f = new Feed({ venue: 'binancef', symbol: 'BTCUSDT' } as never, hubStub);
    const priv = f as unknown as { openedAt: number; lastBookAt: number; lastTradeAt: number };
    f.status = { ...f.status, state: 'open' };
    return { f, priv, bumps: () => bumps };
  };

  it('flags a live book whose trades stopped for 2 minutes', () => {
    const { f, priv, bumps } = make();
    const now = 1_000_000_000_000;
    priv.openedAt = now - 300_000;
    priv.lastTradeAt = now - 130_000;
    priv.lastBookAt = now - 1_000;
    f.sample(now);
    expect(f.status.tradesSilentS).toBe(130);
    expect(bumps()).toBe(1);
    // trades resume: the flag clears
    priv.lastTradeAt = now + 500;
    f.sample(now + 1_000);
    expect(f.status.tradesSilentS).toBeUndefined();
  });

  it('stays quiet for a fresh connection, a dead book or a merely slow market', () => {
    const { f, priv } = make();
    const now = 1_000_000_000_000;
    priv.openedAt = now - 60_000; // connected a minute ago, no trades yet
    priv.lastBookAt = now;
    f.sample(now);
    expect(f.status.tradesSilentS).toBeUndefined();
    priv.openedAt = now - 600_000;
    priv.lastBookAt = now - 60_000; // the whole socket is quiet: the stale-socket reconnect handles that
    f.sample(now);
    expect(f.status.tradesSilentS).toBeUndefined();
  });
});

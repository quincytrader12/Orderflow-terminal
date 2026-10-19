import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookUpdate, MarketStats, Trade } from '../core/types';

/** Load the adapter with a fake `window.novus` desktop bridge installed. */
async function withBridge() {
  const listeners = new Set<(e: any) => void>();
  const bridge = {
    desktop: true,
    ccxt: {
      subscribe: vi.fn(async () => true),
      unsubscribe: vi.fn(async () => undefined),
      onEvent: (fn: (e: any) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      ohlcv: vi.fn(async () => [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]),
      tickers: vi.fn(async () => [
        { symbol: 'BTC/USDT', last: 100, change24hPct: 1, volume24hUsd: 5 },
        { symbol: 'BTC/USDT:USDT', last: 101, change24hPct: 1, volume24hUsd: 9 },
        { symbol: 'ETH/BTC', last: 0.05, change24hPct: 0, volume24hUsd: 1 },
      ]),
    },
  };
  vi.stubGlobal('window', { novus: bridge });
  vi.resetModules();
  const mod = await import('./ccxt');
  const { useSettings } = await import('../store/settings');
  return { mod, bridge, emit: (e: any) => listeners.forEach((l) => l(e)), useSettings };
}

afterEach(() => vi.unstubAllGlobals());

describe('CCXT venue', () => {
  it('builds unified symbols from settings', async () => {
    const { mod, useSettings } = await withBridge();
    useSettings.setState({ ccxtExchange: 'kucoin', ccxtType: 'spot', ccxtQuote: 'USDT' });
    expect(mod.ccxtVenue.symbolFor('btc')).toBe('kucoin::BTC/USDT');
    useSettings.setState({ ccxtType: 'swap' });
    expect(mod.ccxtVenue.symbolFor('ETH')).toBe('kucoin::ETH/USDT:USDT');
    expect(mod.ccxtVenue.kind).toBe('perp');
    expect(mod.splitCcxtSymbol('bybit::BTC/USDT:USDT')).toEqual({ exchange: 'bybit', market: 'BTC/USDT:USDT' });
  });

  it('streams bridge events into the market handlers and unsubscribes on close', async () => {
    const { mod, bridge, emit } = await withBridge();
    const trades: Trade[] = [];
    const books: BookUpdate[] = [];
    const stats: Partial<MarketStats>[] = [];
    const states: string[] = [];
    const conn = mod.ccxtVenue.connect('kucoin::BTC/USDT', {
      onTrades: (t) => trades.push(...t),
      onBook: (b) => books.push(b),
      onLiquidation: () => undefined,
      onStats: (s) => stats.push(s),
      onStatus: (s) => states.push(s),
      onFrame: () => undefined,
    });
    expect(bridge.ccxt.subscribe).toHaveBeenCalledWith(expect.any(String), 'kucoin', 'BTC/USDT');
    const sid = (bridge.ccxt.subscribe.mock.calls[0] as unknown as [string])[0];
    emit({ sid, kind: 'status', state: 'open' });
    emit({ sid, kind: 'trades', trades: [{ p: 100, q: 2, s: 'sell', t: 5 }] });
    emit({ sid: 'other', kind: 'trades', trades: [{ p: 1, q: 1, s: 'buy', t: 1 }] });
    emit({ sid, kind: 'book', bids: [[99, 1]], asks: [[101, 1]], t: 6 });
    emit({ sid, kind: 'stats', stats: { fundingRate: 0.0001 } });
    expect(trades).toEqual([{ venue: 'ccxt', price: 100, qty: 2, side: 'sell', time: 5 }]);
    expect(books[0]).toMatchObject({ snapshot: true, bids: [[99, 1]] });
    expect(stats[0].fundingRate).toBe(0.0001);
    conn.close();
    expect(bridge.ccxt.unsubscribe).toHaveBeenCalledWith(sid);
    expect(states).toEqual(['connecting', 'open', 'closed']);
  });

  it('filters tickers to the configured quote and market type', async () => {
    const { mod, useSettings } = await withBridge();
    useSettings.setState({ ccxtExchange: 'kucoin', ccxtType: 'swap', ccxtQuote: 'USDT' });
    const t = await mod.ccxtVenue.fetchTickers!();
    expect(t.map((x) => x.symbol)).toEqual(['kucoin::BTC/USDT:USDT']);
    expect(t[0].base).toBe('BTC');
  });
});

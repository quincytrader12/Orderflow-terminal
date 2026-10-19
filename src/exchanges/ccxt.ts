import type { Kline, Ticker } from '../core/types';
import { desktop, DesktopOnlyError, type CcxtEvent } from '../desktop/bridge';
import { getSettings } from '../store/settings';
import type { MarketHandlers, VenueAdapter } from './adapter';

/**
 * CCXT venue: any of CCXT's exchanges, chosen in settings (ccxtExchange,
 * ccxtType, ccxtQuote). Streams run in the desktop main process through
 * ccxt.pro WebSockets (REST polling where an exchange has no stream).
 *
 * Venue symbols are "<exchangeId>::<unified symbol>", e.g.
 * "kucoin::BTC/USDT" or "bybit::BTC/USDT:USDT".
 */

export function splitCcxtSymbol(symbol: string): { exchange: string; market: string } {
  const i = symbol.indexOf('::');
  if (i < 0) throw new Error(`not a CCXT symbol: ${symbol}`);
  return { exchange: symbol.slice(0, i), market: symbol.slice(i + 2) };
}

export function ccxtSymbolFor(base: string, exchange: string, type: 'spot' | 'swap', quote: string): string {
  const q = quote.toUpperCase();
  return `${exchange}::${base.toUpperCase()}/${q}${type === 'swap' ? `:${q}` : ''}`;
}

let seq = 0;

export const ccxtVenue: VenueAdapter = {
  id: 'ccxt',
  get name() {
    return `CCXT · ${getSettings().ccxtExchange}`;
  },
  short: 'CCXT',
  get kind() {
    return getSettings().ccxtType === 'swap' ? 'perp' : 'spot';
  },
  color: '#7f8cff',
  hasLiquidations: false,
  symbolFor(base) {
    const s = getSettings();
    return ccxtSymbolFor(base, s.ccxtExchange, s.ccxtType, s.ccxtQuote);
  },

  connect(symbol, h: MarketHandlers) {
    if (!desktop) {
      h.onStatus('error', new DesktopOnlyError('CCXT').message);
      return { close() {} };
    }
    const { exchange, market } = splitCcxtSymbol(symbol);
    const sid = `ccxt-${Date.now().toString(36)}-${seq++}`;
    const off = desktop.ccxt.onEvent((e: CcxtEvent) => {
      if (e.sid !== sid) return;
      switch (e.kind) {
        case 'status':
          h.onStatus(e.state, e.error);
          break;
        case 'trades':
          h.onFrame(e.trades[e.trades.length - 1]?.t);
          h.onTrades(e.trades.map((t) => ({ venue: 'ccxt', price: t.p, qty: t.q, side: t.s, time: t.t })));
          break;
        case 'book':
          h.onFrame(e.t);
          h.onBook({ snapshot: true, bids: e.bids, asks: e.asks, time: e.t });
          break;
        case 'stats':
          h.onFrame();
          h.onStats(e.stats);
          break;
      }
    });
    h.onStatus('connecting');
    desktop.ccxt.subscribe(sid, exchange, market).catch((err) => h.onStatus('error', String(err?.message ?? err)));
    return {
      close() {
        off();
        void desktop!.ccxt.unsubscribe(sid);
        h.onStatus('closed');
      },
    };
  },

  async fetchKlines(symbol, interval, limit): Promise<Kline[]> {
    if (!desktop) throw new DesktopOnlyError('CCXT');
    const { exchange, market } = splitCcxtSymbol(symbol);
    return desktop.ccxt.ohlcv(exchange, market, interval, limit);
  },

  async fetchTicker(symbol): Promise<Ticker | null> {
    if (!desktop) throw new DesktopOnlyError('CCXT');
    const { exchange, market } = splitCcxtSymbol(symbol);
    const t = await desktop.ccxt.ticker(exchange, market);
    return { venue: 'ccxt', symbol, base: market.split('/')[0], last: t.last, change24hPct: t.change24hPct, volume24hUsd: t.volume24hUsd, high24h: t.high24h, low24h: t.low24h };
  },

  async fetchTickers(): Promise<Ticker[]> {
    if (!desktop) throw new DesktopOnlyError('CCXT');
    const s = getSettings();
    const rows = await desktop.ccxt.tickers(s.ccxtExchange);
    const swap = s.ccxtType === 'swap';
    return rows
      .filter((t) => {
        const [, rest = ''] = t.symbol.split('/');
        const [quote, settle] = rest.split(':');
        return quote === s.ccxtQuote && (swap ? Boolean(settle) : !settle);
      })
      .map((t) => ({
        venue: 'ccxt' as const,
        symbol: `${s.ccxtExchange}::${t.symbol}`,
        base: t.symbol.split('/')[0],
        last: t.last,
        change24hPct: t.change24hPct ?? 0,
        volume24hUsd: t.volume24hUsd ?? 0,
        high24h: t.high24h,
        low24h: t.low24h,
      }));
  },
};

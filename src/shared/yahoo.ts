import type { Kline } from '../core/types';

/**
 * Yahoo Finance (unofficial public endpoints): chart/quote and symbol search.
 * Works for stocks, ETFs, indices (^GSPC), futures (NQ=F), FX (EURUSD=X) and
 * crypto (BTC-USD). Yahoo does not send CORS headers, so the desktop app
 * fetches through its main process; data may be delayed depending on the
 * exchange.
 */

export type JsonFetcher = (url: string, init?: { headers?: Record<string, string> }) => Promise<any>;

const BASE = 'https://query1.finance.yahoo.com';
export const YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'application/json' };

export interface YahooQuote {
  symbol: string;
  name: string;
  currency: string;
  exchange: string;
  price: number;
  prevClose: number;
  change: number;
  changePct: number;
  dayHigh?: number;
  dayLow?: number;
  volume?: number;
  time: number;
}

export interface YahooChart {
  quote: YahooQuote;
  bars: Kline[];
}

export const RANGE_INTERVAL: Record<string, string> = { '1d': '5m', '5d': '15m', '1mo': '60m', '6mo': '1d', '1y': '1d', '5y': '1wk' };

export function parseChart(json: any): YahooChart {
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description ?? 'symbol not found');
  const m = r.meta ?? {};
  const q = r.indicators?.quote?.[0] ?? {};
  const ts: number[] = r.timestamp ?? [];
  const bars: Kline[] = [];
  ts.forEach((t, i) => {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if ([o, h, l, c].some((v) => v === null || v === undefined)) return;
    bars.push({ time: t * 1000, open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  });
  const price = m.regularMarketPrice ?? bars[bars.length - 1]?.close ?? NaN;
  const prevClose = m.chartPreviousClose ?? m.previousClose ?? bars[0]?.open ?? NaN;
  return {
    bars,
    quote: {
      symbol: m.symbol,
      name: m.shortName ?? m.longName ?? m.symbol,
      currency: m.currency ?? '',
      exchange: m.fullExchangeName ?? m.exchangeName ?? '',
      price,
      prevClose,
      change: price - prevClose,
      changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
      dayHigh: m.regularMarketDayHigh,
      dayLow: m.regularMarketDayLow,
      volume: m.regularMarketVolume,
      time: (m.regularMarketTime ?? Date.now() / 1000) * 1000,
    },
  };
}

export async function yahooChart(fetchJson: JsonFetcher, symbol: string, range = '1d'): Promise<YahooChart> {
  const interval = RANGE_INTERVAL[range] ?? '1d';
  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  return parseChart(await fetchJson(url, { headers: YAHOO_HEADERS }));
}

export interface YahooSearchHit {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

export async function yahooSearch(fetchJson: JsonFetcher, q: string): Promise<YahooSearchHit[]> {
  const j = await fetchJson(`${BASE}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { headers: YAHOO_HEADERS });
  return ((j?.quotes ?? []) as any[])
    .filter((x) => x.symbol)
    .map((x) => ({ symbol: x.symbol, name: x.shortname ?? x.longname ?? x.symbol, type: x.quoteType ?? '', exchange: x.exchDisp ?? x.exchange ?? '' }));
}

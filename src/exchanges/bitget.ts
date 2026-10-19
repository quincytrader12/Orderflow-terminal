import type { Kline, Ticker } from '../core/types';
import type { MarketHandlers, VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

const REST = 'https://api.bitget.com/api/v2/mix/market';
const INST_TYPE = 'USDT-FUTURES';
const GRAN: Record<string, string> = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W' };

const lv = (rows: string[][]): [number, number][] => rows.map((r) => [num(r[0]), num(r[1])]);

export const bitget: VenueAdapter = {
  id: 'bitget',
  name: 'Bitget Perp',
  short: 'BG',
  kind: 'perp',
  color: '#00f0ff',
  hasLiquidations: false,
  symbolFor: (base) => `${base.toUpperCase()}USDT`,

  connect(symbol, h: MarketHandlers) {
    const sock = new ManagedSocket({
      url: 'wss://ws.bitget.com/v2/ws/public',
      staleMs: 40_000,
      ping: { intervalMs: 25_000, payload: () => 'ping' },
      isPong: (raw) => raw === 'pong',
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        ws.send({
          op: 'subscribe',
          args: ['trade', 'books', 'ticker'].map((channel) => ({ instType: INST_TYPE, channel, instId: symbol })),
        });
      },
      onMessage: (m: any) => {
        if (m.event) {
          if (m.event === 'error') h.onStatus('error', m.msg);
          return;
        }
        const ch = m.arg?.channel;
        const data = m.data as any[];
        if (!ch || !data) return;
        h.onFrame(num(m.ts));
        switch (ch) {
          case 'trade':
            if (m.action === 'snapshot') return; // recent history replayed on subscribe
            h.onTrades(
              data
                .map((t) => ({ venue: 'bitget' as const, price: num(t.price), qty: num(t.size), side: t.side as 'buy' | 'sell', time: num(t.ts) }))
                .sort((a, b) => a.time - b.time),
            );
            break;
          case 'books': {
            const d = data[0];
            h.onBook({ snapshot: m.action === 'snapshot', bids: lv(d.bids), asks: lv(d.asks), time: num(d.ts) });
            break;
          }
          case 'ticker': {
            const t = data[0];
            const last = num(t.lastPr);
            h.onStats({
              last,
              markPrice: num(t.markPrice),
              indexPrice: num(t.indexPrice),
              fundingRate: num(t.fundingRate),
              nextFundingTime: num(t.nextFundingTime),
              fundingIntervalH: 8,
              openInterest: num(t.holdingAmount),
              openInterestUsd: num(t.holdingAmount) * last,
              change24hPct: num(t.change24h) * 100,
              high24h: num(t.high24h),
              low24h: num(t.low24h),
              volume24hUsd: num(t.quoteVolume),
            });
            break;
          }
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(symbol, interval, limit): Promise<Kline[]> {
    const r = await fetchJson(`${REST}/candles?symbol=${symbol}&productType=usdt-futures&granularity=${GRAN[interval] ?? '1m'}&limit=${Math.min(limit, 1000)}`);
    return (r.data as any[])
      .map((k) => ({ time: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume: num(k[5]) }))
      .sort((a, b) => a.time - b.time);
  },

  async fetchTicker(symbol) {
    const r = await fetchJson(`${REST}/ticker?symbol=${symbol}&productType=usdt-futures`);
    return r.data?.[0] ? tickerFrom(r.data[0]) : null;
  },

  async fetchTickers() {
    const r = await fetchJson(`${REST}/tickers?productType=usdt-futures`);
    return (r.data as any[]).map(tickerFrom);
  },
};

function tickerFrom(t: any): Ticker {
  const last = num(t.lastPr);
  return {
    venue: 'bitget',
    symbol: t.symbol,
    base: t.symbol.replace(/USDT$/, ''),
    last,
    change24hPct: num(t.change24h) * 100,
    volume24hUsd: num(t.quoteVolume),
    fundingRate: num(t.fundingRate),
    openInterestUsd: num(t.holdingAmount) * last,
    high24h: num(t.high24h),
    low24h: num(t.low24h),
  };
}

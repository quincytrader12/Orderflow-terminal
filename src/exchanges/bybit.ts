import type { Kline, MarketStats, Ticker } from '../core/types';
import type { MarketHandlers, OiPoint, VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

const REST = 'https://api.bybit.com/v5/market';
const KLINE: Record<string, string> = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W' };

const lv = (l: [string, string][]): [number, number][] => l.map(([p, q]) => [num(p), num(q)]);

export const bybit: VenueAdapter = {
  id: 'bybit',
  name: 'Bybit Perp',
  short: 'BYB',
  kind: 'perp',
  color: '#f7a600',
  hasLiquidations: true,
  symbolFor: (base) => `${base.toUpperCase()}USDT`,

  connect(symbol, h: MarketHandlers) {
    let lastSeq = -1;
    const sock: ManagedSocket = new ManagedSocket({
      url: 'wss://stream.bybit.com/v5/public/linear',
      staleMs: 30_000,
      ping: { intervalMs: 20_000, payload: () => JSON.stringify({ op: 'ping' }) },
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        lastSeq = -1;
        ws.send({
          op: 'subscribe',
          args: [`publicTrade.${symbol}`, `orderbook.200.${symbol}`, `tickers.${symbol}`, `allLiquidation.${symbol}`],
        });
      },
      onMessage: (m: any) => {
        if (!m.topic) return;
        h.onFrame(m.ts);
        const topic: string = m.topic;
        if (topic.startsWith('publicTrade.')) {
          h.onTrades(
            (m.data as any[]).map((t) => ({ venue: 'bybit', price: num(t.p), qty: num(t.v), side: t.S === 'Buy' ? 'buy' : 'sell', time: t.T })),
          );
        } else if (topic.startsWith('orderbook.')) {
          const d = m.data;
          const snapshot = m.type === 'snapshot' || d.u === 1;
          if (!snapshot && lastSeq >= 0 && d.seq !== undefined && d.seq < lastSeq) return;
          lastSeq = d.seq ?? lastSeq;
          h.onBook({ snapshot, bids: lv(d.b), asks: lv(d.a), time: m.ts });
        } else if (topic.startsWith('tickers.')) {
          const d = m.data;
          const s: Partial<MarketStats> = {};
          if (d.lastPrice) s.last = num(d.lastPrice);
          if (d.markPrice) s.markPrice = num(d.markPrice);
          if (d.indexPrice) s.indexPrice = num(d.indexPrice);
          if (d.fundingRate) s.fundingRate = num(d.fundingRate);
          if (d.nextFundingTime) s.nextFundingTime = num(d.nextFundingTime);
          if (d.openInterest) s.openInterest = num(d.openInterest);
          if (d.openInterestValue) s.openInterestUsd = num(d.openInterestValue);
          if (d.turnover24h) s.volume24hUsd = num(d.turnover24h);
          if (d.price24hPcnt) s.change24hPct = num(d.price24hPcnt) * 100;
          if (d.highPrice24h) s.high24h = num(d.highPrice24h);
          if (d.lowPrice24h) s.low24h = num(d.lowPrice24h);
          s.fundingIntervalH = 8;
          h.onStats(s);
        } else if (topic.startsWith('allLiquidation.')) {
          for (const l of m.data as any[]) {
            // Bybit reports the side of the liquidated position: Buy = long
            h.onLiquidation({ venue: 'bybit', symbol: l.s, position: l.S === 'Buy' ? 'long' : 'short', price: num(l.p), qty: num(l.v), time: l.T });
          }
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(symbol, interval, limit): Promise<Kline[]> {
    const r = await fetchJson(`${REST}/kline?category=linear&symbol=${symbol}&interval=${KLINE[interval] ?? '1'}&limit=${Math.min(limit, 1000)}`);
    return (r.result.list as any[])
      .map((k) => ({ time: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume: num(k[5]) }))
      .reverse();
  },

  async pollStats(symbol) {
    const r = await fetchJson(`${REST}/account-ratio?category=linear&symbol=${symbol}&period=5min&limit=1`);
    const x = r.result?.list?.[0];
    if (!x) return {};
    const buy = num(x.buyRatio);
    const sell = num(x.sellRatio);
    return { longAccount: buy, shortAccount: sell, longShortRatio: sell > 0 ? buy / sell : undefined };
  },

  async fetchOiHistory(symbol): Promise<OiPoint[]> {
    const [oi, k] = await Promise.all([
      fetchJson(`${REST}/open-interest?category=linear&symbol=${symbol}&intervalTime=5min&limit=200`),
      fetchJson(`${REST}/kline?category=linear&symbol=${symbol}&interval=5&limit=200`),
    ]);
    const px = new Map<number, number>((k.result.list as any[]).map((r) => [num(r[0]), num(r[4])]));
    return (oi.result.list as any[])
      .map((r) => {
        const t = num(r.timestamp);
        const o = num(r.openInterest);
        return { time: t, oi: o, oiUsd: o * (px.get(t) ?? 0) };
      })
      .filter((p) => p.oiUsd > 0)
      .reverse();
  },

  async fetchTicker(symbol) {
    const r = await fetchJson(`${REST}/tickers?category=linear&symbol=${symbol}`);
    const t = r.result.list[0];
    return t ? tickerFrom(t) : null;
  },

  async fetchTickers() {
    const r = await fetchJson(`${REST}/tickers?category=linear`);
    return (r.result.list as any[]).filter((t) => t.symbol.endsWith('USDT')).map(tickerFrom);
  },
};

function tickerFrom(t: any): Ticker {
  return {
    venue: 'bybit',
    symbol: t.symbol,
    base: t.symbol.replace(/USDT$/, ''),
    last: num(t.lastPrice),
    change24hPct: num(t.price24hPcnt) * 100,
    volume24hUsd: num(t.turnover24h),
    fundingRate: num(t.fundingRate),
    openInterestUsd: num(t.openInterestValue),
    high24h: num(t.highPrice24h),
    low24h: num(t.lowPrice24h),
  };
}

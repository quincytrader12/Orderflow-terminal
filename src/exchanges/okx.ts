import type { Kline, MarketStats, Ticker } from '../core/types';
import type { MarketHandlers, OiPoint, VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

const REST = 'https://www.okx.com/api/v5';
const BAR: Record<string, string> = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '1w': '1Wutc' };

/** contract value in base units per instrument; fetched lazily and cached */
const ctValCache = new Map<string, number>();
const FALLBACK_CTVAL: Record<string, number> = { BTC: 0.01, ETH: 0.1, SOL: 1, XRP: 100, DOGE: 1000, BNB: 0.01 };

export async function okxCtVal(instId: string): Promise<number> {
  const cached = ctValCache.get(instId);
  if (cached) return cached;
  try {
    const r = await fetchJson(`${REST}/public/instruments?instType=SWAP&instId=${instId}`);
    const v = num(r.data?.[0]?.ctVal);
    if (v > 0) {
      ctValCache.set(instId, v);
      return v;
    }
  } catch {
    /* fall through */
  }
  return FALLBACK_CTVAL[instId.split('-')[0]] ?? 1;
}

/** OKX books rows are [price, size(contracts), deprecated, orderCount] */
const lv = (rows: string[][], ct: number): [number, number][] => rows.map((r) => [num(r[0]), num(r[1]) * ct]);

export const okx: VenueAdapter = {
  id: 'okx',
  name: 'OKX Perp',
  short: 'OKX',
  kind: 'perp',
  color: '#cfd3dc',
  hasLiquidations: true,
  symbolFor: (base) => `${base.toUpperCase()}-USDT-SWAP`,

  connect(instId, h: MarketHandlers) {
    let ct = FALLBACK_CTVAL[instId.split('-')[0]] ?? 1;
    let lastSeq = -1;
    const uly = instId.replace(/-SWAP$/, '');
    const sock: ManagedSocket = new ManagedSocket({
      url: async () => {
        ct = await okxCtVal(instId);
        return 'wss://ws.okx.com:8443/ws/v5/public';
      },
      staleMs: 30_000,
      ping: { intervalMs: 20_000, payload: () => 'ping' },
      isPong: (raw) => raw === 'pong',
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        lastSeq = -1;
        ws.send({
          op: 'subscribe',
          args: [
            { channel: 'trades', instId },
            { channel: 'books', instId },
            { channel: 'funding-rate', instId },
            { channel: 'open-interest', instId },
            { channel: 'mark-price', instId },
            { channel: 'index-tickers', instId: uly },
            { channel: 'tickers', instId },
            { channel: 'liquidation-orders', instType: 'SWAP' },
          ],
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
        h.onFrame(num(data[0]?.ts));
        switch (ch) {
          case 'trades':
            h.onTrades(data.map((t) => ({ venue: 'okx', price: num(t.px), qty: num(t.sz) * ct, side: t.side, time: num(t.ts) })));
            break;
          case 'books': {
            const d = data[0];
            const snapshot = m.action === 'snapshot';
            if (!snapshot && lastSeq >= 0 && d.prevSeqId !== lastSeq) {
              // sequence gap: resubscribe to receive a fresh snapshot
              lastSeq = -1;
              sock.send({ op: 'unsubscribe', args: [{ channel: 'books', instId }] });
              sock.send({ op: 'subscribe', args: [{ channel: 'books', instId }] });
              return;
            }
            lastSeq = d.seqId;
            h.onBook({ snapshot, bids: lv(d.bids, ct), asks: lv(d.asks, ct), time: num(d.ts) });
            break;
          }
          case 'funding-rate':
            h.onStats({ fundingRate: num(data[0].fundingRate), nextFundingTime: num(data[0].fundingTime), fundingIntervalH: 8 });
            break;
          case 'open-interest': {
            const s: Partial<MarketStats> = { openInterest: num(data[0].oiCcy) };
            if (data[0].oiUsd) s.openInterestUsd = num(data[0].oiUsd);
            h.onStats(s);
            break;
          }
          case 'mark-price':
            h.onStats({ markPrice: num(data[0].markPx) });
            break;
          case 'index-tickers':
            h.onStats({ indexPrice: num(data[0].idxPx) });
            break;
          case 'tickers': {
            const t = data[0];
            const last = num(t.last);
            const open = num(t.open24h);
            h.onStats({
              last,
              change24hPct: open ? ((last - open) / open) * 100 : undefined,
              high24h: num(t.high24h),
              low24h: num(t.low24h),
              volume24hUsd: num(t.volCcy24h) * last,
            });
            break;
          }
          case 'liquidation-orders':
            for (const o of data) {
              if (o.instId !== instId) continue;
              for (const d of o.details ?? []) {
                const position = d.posSide === 'long' || d.posSide === 'short' ? d.posSide : d.side === 'sell' ? 'long' : 'short';
                h.onLiquidation({ venue: 'okx', symbol: instId, position, price: num(d.bkPx), qty: num(d.sz) * ct, time: num(d.ts) });
              }
            }
            break;
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(instId, interval, limit): Promise<Kline[]> {
    const r = await fetchJson(`${REST}/market/candles?instId=${instId}&bar=${BAR[interval] ?? '1m'}&limit=${Math.min(limit, 300)}`);
    return (r.data as any[])
      .map((k) => ({ time: num(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume: num(k[6]) }))
      .reverse();
  },

  async pollStats(instId) {
    const ccy = instId.split('-')[0];
    const r = await fetchJson(`${REST}/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=5m`);
    const row = r.data?.[0];
    if (!row) return {};
    const ratio = num(row[1]);
    return { longShortRatio: ratio, longAccount: ratio / (1 + ratio), shortAccount: 1 / (1 + ratio) };
  },

  async fetchOiHistory(): Promise<OiPoint[]> {
    // OKX only publishes OI history aggregated across all its contracts, which
    // would not line up with the per-instrument live value; accumulate live.
    return [];
  },

  async fetchTicker(instId) {
    const r = await fetchJson(`${REST}/market/ticker?instId=${instId}`);
    return r.data?.[0] ? tickerFrom(r.data[0]) : null;
  },

  async fetchTickers() {
    const r = await fetchJson(`${REST}/market/tickers?instType=SWAP`);
    return (r.data as any[]).filter((t) => t.instId.endsWith('-USDT-SWAP')).map(tickerFrom);
  },
};

function tickerFrom(t: any): Ticker {
  const last = num(t.last);
  const open = num(t.open24h);
  return {
    venue: 'okx',
    symbol: t.instId,
    base: t.instId.split('-')[0],
    last,
    change24hPct: open ? ((last - open) / open) * 100 : 0,
    volume24hUsd: num(t.volCcy24h) * last,
    high24h: num(t.high24h),
    low24h: num(t.low24h),
  };
}

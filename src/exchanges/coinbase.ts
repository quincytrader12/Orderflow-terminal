import type { Kline } from '../core/types';
import type { MarketHandlers, VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

const REST = 'https://api.coinbase.com/api/v3/brokerage/market/products';
const GRAN: Record<string, [string, number]> = {
  '1m': ['ONE_MINUTE', 60],
  '5m': ['FIVE_MINUTE', 300],
  '15m': ['FIFTEEN_MINUTE', 900],
  '30m': ['THIRTY_MINUTE', 1800],
  '1h': ['ONE_HOUR', 3600],
  '2h': ['TWO_HOUR', 7200],
  '6h': ['SIX_HOUR', 21600],
  '1d': ['ONE_DAY', 86400],
};

/**
 * Coinbase reports the maker order's side on market trades (same convention
 * as the legacy Exchange "match" feed), so the aggressor is the opposite side.
 */
export const COINBASE_SIDE_IS_MAKER = true;

export const coinbase: VenueAdapter = {
  id: 'coinbase',
  name: 'Coinbase',
  short: 'CB',
  kind: 'spot',
  color: '#0052ff',
  hasLiquidations: false,
  symbolFor: (base) => `${base.toUpperCase()}-USD`,

  connect(product, h: MarketHandlers) {
    const sock = new ManagedSocket({
      url: 'wss://advanced-trade-ws.coinbase.com',
      staleMs: 30_000,
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        for (const channel of ['heartbeats', 'level2', 'market_trades', 'ticker']) ws.send({ type: 'subscribe', product_ids: [product], channel });
      },
      onMessage: (m: any) => {
        const t = m.timestamp ? Date.parse(m.timestamp) : undefined;
        h.onFrame(t);
        if (m.type === 'error') {
          h.onStatus('error', m.message);
          return;
        }
        switch (m.channel) {
          case 'l2_data':
            for (const ev of m.events ?? []) {
              const bids: [number, number][] = [];
              const asks: [number, number][] = [];
              for (const u of ev.updates ?? []) {
                (u.side === 'bid' ? bids : asks).push([num(u.price_level), num(u.new_quantity)]);
              }
              h.onBook({ snapshot: ev.type === 'snapshot', bids, asks, time: t ?? Date.now() });
            }
            break;
          case 'market_trades':
            for (const ev of m.events ?? []) {
              if (ev.type === 'snapshot') continue; // historical trades replayed on subscribe
              const trades = (ev.trades as any[]).map((x) => {
                const reported = x.side === 'BUY' ? 'buy' : 'sell';
                const side = COINBASE_SIDE_IS_MAKER ? (reported === 'buy' ? 'sell' : 'buy') : reported;
                return { venue: 'coinbase' as const, price: num(x.price), qty: num(x.size), side: side as 'buy' | 'sell', time: Date.parse(x.time) };
              });
              trades.reverse(); // newest first on the wire
              h.onTrades(trades);
            }
            break;
          case 'ticker':
            for (const ev of m.events ?? []) {
              const x = ev.tickers?.[0];
              if (!x) continue;
              const last = num(x.price);
              h.onStats({
                last,
                change24hPct: num(x.price_percent_chg_24_h),
                high24h: num(x.high_24_h),
                low24h: num(x.low_24_h),
                volume24hUsd: num(x.volume_24_h) * last,
              });
            }
            break;
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(product, interval, limit): Promise<Kline[]> {
    const [g, sec] = GRAN[interval] ?? GRAN['1m'];
    const end = Math.floor(Date.now() / 1000);
    const start = end - sec * Math.min(limit, 350);
    const r = await fetchJson(`${REST}/${product}/candles?start=${start}&end=${end}&granularity=${g}`);
    return (r.candles as any[])
      .map((k) => ({ time: num(k.start) * 1000, open: num(k.open), high: num(k.high), low: num(k.low), close: num(k.close), volume: num(k.volume) }))
      .reverse();
  },

  async fetchTicker(product) {
    const p = await fetchJson(`${REST}/${product}`);
    const last = num(p.price);
    return {
      venue: 'coinbase',
      symbol: product,
      base: product.split('-')[0],
      last,
      change24hPct: num(p.price_percentage_change_24h),
      volume24hUsd: num(p.volume_24h) * last,
    };
  },
};

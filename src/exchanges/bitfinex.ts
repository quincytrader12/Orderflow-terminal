import type { Kline } from '../core/types';
import type { MarketHandlers, VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket } from './ws';

const TF: Record<string, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '3h': '3h', '6h': '6h', '12h': '12h', '1d': '1D', '1w': '1W' };

export const bitfinexSymbol = (base: string) => {
  const b = base.toUpperCase();
  return b.length > 3 ? `t${b}:USD` : `t${b}USD`;
};

export const bitfinex: VenueAdapter = {
  id: 'bitfinex',
  name: 'Bitfinex',
  short: 'BFX',
  kind: 'spot',
  color: '#16b157',
  hasLiquidations: false,
  symbolFor: bitfinexSymbol,

  connect(symbol, h: MarketHandlers) {
    const channels = new Map<number, 'trades' | 'book' | 'ticker'>();
    const sock = new ManagedSocket({
      url: 'wss://api-pub.bitfinex.com/ws/2',
      staleMs: 40_000,
      ping: { intervalMs: 20_000, payload: () => JSON.stringify({ event: 'ping', cid: Date.now() }) },
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        channels.clear();
        ws.send({ event: 'subscribe', channel: 'trades', symbol });
        ws.send({ event: 'subscribe', channel: 'book', symbol, prec: 'P0', freq: 'F0', len: '250' });
        ws.send({ event: 'subscribe', channel: 'ticker', symbol });
      },
      onMessage: (m: any) => {
        if (!Array.isArray(m)) {
          if (m.event === 'subscribed') channels.set(m.chanId, m.channel);
          else if (m.event === 'error') h.onStatus('error', m.msg);
          return;
        }
        const kind = channels.get(m[0]);
        if (!kind || m[1] === 'hb') return;
        h.onFrame();
        if (kind === 'trades') {
          if (m[1] !== 'te') return; // ignore snapshot and 'tu' duplicates
          const [, mts, amount, price] = m[2] as number[];
          h.onTrades([{ venue: 'bitfinex', price, qty: Math.abs(amount), side: amount > 0 ? 'buy' : 'sell', time: mts }]);
        } else if (kind === 'book') {
          const payload = m[1] as any[];
          const rows: number[][] = Array.isArray(payload[0]) ? payload : [payload];
          const snapshot = Array.isArray(payload[0]);
          const bids: [number, number][] = [];
          const asks: [number, number][] = [];
          for (const [price, count, amount] of rows) {
            const qty = count === 0 ? 0 : Math.abs(amount);
            (amount > 0 ? bids : asks).push([price, qty]);
          }
          h.onBook({ snapshot, bids, asks, time: Date.now() });
        } else if (kind === 'ticker') {
          const t = m[1] as number[];
          const last = t[6];
          h.onStats({ last, change24hPct: t[5] * 100, volume24hUsd: t[7] * last, high24h: t[8], low24h: t[9] });
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(symbol, interval, limit): Promise<Kline[]> {
    const rows = await fetchJson<number[][]>(`https://api-pub.bitfinex.com/v2/candles/trade:${TF[interval] ?? '1m'}:${symbol}/hist?limit=${Math.min(limit, 10000)}`);
    // [MTS, OPEN, CLOSE, HIGH, LOW, VOLUME], newest first
    return rows.map((k) => ({ time: k[0], open: k[1], close: k[2], high: k[3], low: k[4], volume: k[5] })).reverse();
  },

  async fetchTicker(symbol) {
    const t = await fetchJson<number[]>(`https://api-pub.bitfinex.com/v2/ticker/${symbol}`);
    const last = t[6];
    return {
      venue: 'bitfinex',
      symbol,
      base: symbol.replace(/^t/, '').replace(/:?USD$/, ''),
      last,
      change24hPct: t[5] * 100,
      volume24hUsd: t[7] * last,
      high24h: t[8],
      low24h: t[9],
    };
  },
};

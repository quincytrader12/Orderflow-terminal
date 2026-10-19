import type { Kline } from '../core/types';
import { intervalMinutes, type MarketHandlers, type VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

const DEPTH = 1000;

/** Kraken v2 books must be truncated to the subscribed depth after updates. */
function truncate(book: Map<number, number>, desc: boolean, depth: number): [number, number][] {
  if (book.size <= depth) return [];
  const keys = [...book.keys()].sort((a, b) => (desc ? b - a : a - b));
  const removed: [number, number][] = [];
  for (const k of keys.slice(depth)) {
    book.delete(k);
    removed.push([k, 0]);
  }
  return removed;
}

export const kraken: VenueAdapter = {
  id: 'kraken',
  name: 'Kraken',
  short: 'KRK',
  kind: 'spot',
  color: '#7132f5',
  hasLiquidations: false,
  symbolFor: (base) => `${base.toUpperCase()}/USD`,

  connect(symbol, h: MarketHandlers) {
    const bids = new Map<number, number>();
    const asks = new Map<number, number>();
    const sock = new ManagedSocket({
      url: 'wss://ws.kraken.com/v2',
      staleMs: 30_000,
      ping: { intervalMs: 20_000, payload: () => JSON.stringify({ method: 'ping' }) },
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        ws.send({ method: 'subscribe', params: { channel: 'trade', symbol: [symbol], snapshot: false } });
        ws.send({ method: 'subscribe', params: { channel: 'book', symbol: [symbol], depth: DEPTH } });
        ws.send({ method: 'subscribe', params: { channel: 'ticker', symbol: [symbol] } });
      },
      onMessage: (m: any) => {
        if (!m.channel || !m.data) return;
        switch (m.channel) {
          case 'trade': {
            const rows = m.data as any[];
            const trades = rows.map((t) => ({ venue: 'kraken' as const, price: num(t.price), qty: num(t.qty), side: t.side as 'buy' | 'sell', time: Date.parse(t.timestamp) }));
            h.onFrame(trades[trades.length - 1]?.time);
            h.onTrades(trades);
            break;
          }
          case 'book': {
            const d = m.data[0];
            const time = d.timestamp ? Date.parse(d.timestamp) : Date.now();
            h.onFrame(time);
            const snapshot = m.type === 'snapshot';
            if (snapshot) {
              bids.clear();
              asks.clear();
            }
            const b: [number, number][] = (d.bids ?? []).map((l: any) => [num(l.price), num(l.qty)]);
            const a: [number, number][] = (d.asks ?? []).map((l: any) => [num(l.price), num(l.qty)]);
            for (const [p, q] of b) q > 0 ? bids.set(p, q) : bids.delete(p);
            for (const [p, q] of a) q > 0 ? asks.set(p, q) : asks.delete(p);
            b.push(...truncate(bids, true, DEPTH));
            a.push(...truncate(asks, false, DEPTH));
            h.onBook({ snapshot, bids: b, asks: a, time });
            break;
          }
          case 'ticker': {
            h.onFrame();
            const t = m.data[0];
            h.onStats({ last: num(t.last), change24hPct: num(t.change_pct), high24h: num(t.high), low24h: num(t.low), volume24hUsd: num(t.volume) * num(t.vwap || t.last) });
            break;
          }
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(symbol, interval, limit): Promise<Kline[]> {
    const pair = symbol.replace('/', '');
    const r = await fetchJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMinutes(interval)}`);
    if (r.error?.length) throw new Error(r.error.join(', '));
    const key = Object.keys(r.result).find((k) => k !== 'last')!;
    return (r.result[key] as any[])
      .slice(-limit)
      .map((k) => ({ time: k[0] * 1000, open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]), volume: num(k[6]) }));
  },

  async fetchTicker(symbol) {
    const pair = symbol.replace('/', '');
    const r = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    const t: any = Object.values(r.result ?? {})[0];
    if (!t) return null;
    const last = num(t.c[0]);
    const open = num(t.o);
    return {
      venue: 'kraken',
      symbol,
      base: symbol.split('/')[0],
      last,
      change24hPct: open ? ((last - open) / open) * 100 : 0,
      volume24hUsd: num(t.v[1]) * num(t.p[1]),
      high24h: num(t.h[1]),
      low24h: num(t.l[1]),
    };
  },
};

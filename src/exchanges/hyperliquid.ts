import type { Kline, Ticker } from '../core/types';
import { intervalMinutes, type MarketHandlers, type OiPoint, type VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

const INFO = 'https://api.hyperliquid.xyz/info';
const post = (body: unknown) => fetchJson(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const hyperliquid: VenueAdapter = {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  short: 'HL',
  kind: 'perp',
  color: '#50e3c2',
  hasLiquidations: false,
  symbolFor: (base) => base.toUpperCase(),

  connect(coin, h: MarketHandlers) {
    const sock = new ManagedSocket({
      url: 'wss://api.hyperliquid.xyz/ws',
      staleMs: 60_000,
      ping: { intervalMs: 30_000, payload: () => JSON.stringify({ method: 'ping' }) },
      onState: (s, e) => h.onStatus(s, e),
      onOpen: (ws) => {
        for (const type of ['trades', 'l2Book', 'activeAssetCtx']) ws.send({ method: 'subscribe', subscription: { type, coin } });
      },
      onMessage: (m: any) => {
        switch (m.channel) {
          case 'trades': {
            const rows = m.data as any[];
            h.onFrame(rows[rows.length - 1]?.time);
            // side is the aggressor: B = buy, A = sell
            h.onTrades(rows.map((t) => ({ venue: 'hyperliquid', price: num(t.px), qty: num(t.sz), side: t.side === 'B' ? 'buy' : 'sell', time: t.time })));
            break;
          }
          case 'l2Book': {
            const d = m.data;
            h.onFrame(d.time);
            const [bids, asks] = d.levels as { px: string; sz: string }[][];
            h.onBook({
              snapshot: true,
              bids: bids.map((l) => [num(l.px), num(l.sz)]),
              asks: asks.map((l) => [num(l.px), num(l.sz)]),
              time: d.time,
            });
            break;
          }
          case 'activeAssetCtx': {
            h.onFrame();
            const c = m.data.ctx;
            const mark = num(c.markPx);
            const prev = num(c.prevDayPx);
            const oi = num(c.openInterest);
            const now = Date.now();
            h.onStats({
              markPrice: mark,
              indexPrice: num(c.oraclePx),
              fundingRate: num(c.funding),
              fundingIntervalH: 1,
              nextFundingTime: Math.ceil(now / 3_600_000) * 3_600_000,
              openInterest: oi,
              openInterestUsd: oi * mark,
              volume24hUsd: num(c.dayNtlVlm),
              change24hPct: prev ? ((mark - prev) / prev) * 100 : undefined,
              last: num(c.midPx) || mark,
            });
            break;
          }
        }
      },
    });
    void sock.connect();
    return { close: () => sock.close() };
  },

  async fetchKlines(coin, interval, limit): Promise<Kline[]> {
    const endTime = Date.now();
    const startTime = endTime - intervalMinutes(interval) * 60_000 * Math.min(limit, 5000);
    const rows = await post({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } });
    return (rows as any[]).map((k) => ({ time: k.t, open: num(k.o), high: num(k.h), low: num(k.l), close: num(k.c), volume: num(k.v) }));
  },

  async fetchOiHistory(): Promise<OiPoint[]> {
    return []; // not exposed publicly; the panel accumulates live points instead
  },

  async fetchTicker(coin) {
    const all = await hyperliquid.fetchTickers!();
    return all.find((t) => t.symbol === coin) ?? null;
  },

  async fetchTickers(): Promise<Ticker[]> {
    const [meta, ctxs] = (await post({ type: 'metaAndAssetCtxs' })) as [any, any[]];
    return (meta.universe as any[])
      .map((u, i) => {
        const c = ctxs[i];
        const mark = num(c.markPx);
        const prev = num(c.prevDayPx);
        return {
          venue: 'hyperliquid' as const,
          symbol: u.name,
          base: u.name,
          last: mark,
          change24hPct: prev ? ((mark - prev) / prev) * 100 : 0,
          volume24hUsd: num(c.dayNtlVlm),
          fundingRate: num(c.funding),
          openInterestUsd: num(c.openInterest) * mark,
        };
      })
      .filter((t, i) => !meta.universe[i].isDelisted && t.last > 0);
  },
};

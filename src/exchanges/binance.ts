import type { BookUpdate, Kline, MarketStats, Ticker } from '../core/types';
import { sleep, type HistTrade, type MarketHandlers, type OiPoint, type VenueAdapter } from './adapter';
import { fetchJson, ManagedSocket, num } from './ws';

interface DepthEvent {
  U: number;
  u: number;
  pu?: number;
  b: [string, string][];
  a: [string, string][];
  E: number;
}

const toLevels = (l: [string, string][]): [number, number][] => l.map(([p, q]) => [num(p), num(q)]);

/**
 * Binance diff-depth synchronisation (snapshot + buffered deltas).
 * Futures validates continuity via `pu === previous u`; spot via `U === previous u + 1`.
 */
export class BinanceDepthSync {
  private buffer: DepthEvent[] = [];
  private lastU = -1;
  private synced = false;

  constructor(
    private futures: boolean,
    private emit: (u: BookUpdate) => void,
    private resync: () => void,
  ) {}

  get isSynced() {
    return this.synced;
  }

  reset() {
    this.buffer = [];
    this.lastU = -1;
    this.synced = false;
  }

  onEvent(ev: DepthEvent) {
    if (!this.synced) {
      this.buffer.push(ev);
      if (this.buffer.length > 5000) this.buffer.shift();
      return;
    }
    const continuous = this.futures ? ev.pu === this.lastU : ev.U === this.lastU + 1;
    if (!continuous) {
      this.reset();
      this.resync();
      return;
    }
    this.lastU = ev.u;
    this.emit({ snapshot: false, bids: toLevels(ev.b), asks: toLevels(ev.a), time: ev.E });
  }

  onSnapshot(snap: { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }, time = Date.now()) {
    const id = snap.lastUpdateId;
    this.emit({ snapshot: true, bids: toLevels(snap.bids), asks: toLevels(snap.asks), time });
    const pending = this.buffer.filter((e) => e.u >= (this.futures ? id : id + 1));
    this.buffer = [];
    this.lastU = id;
    this.synced = true;
    let first = true;
    for (const ev of pending) {
      if (first) {
        const ok = this.futures ? ev.U <= id && ev.u >= id : ev.U <= id + 1 && ev.u >= id + 1;
        if (!ok) {
          this.reset();
          this.resync();
          return;
        }
        first = false;
        this.lastU = ev.u;
        this.emit({ snapshot: false, bids: toLevels(ev.b), asks: toLevels(ev.a), time: ev.E });
        continue;
      }
      this.onEvent(ev);
      if (!this.synced) return;
    }
  }
}

const KLINE_INTERVALS = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w']);

function parseKlines(rows: any[]): Kline[] {
  return rows.map((r) => ({
    time: r[0],
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
    buyVolume: num(r[9]),
  }));
}

function makeBinance(futures: boolean): VenueAdapter {
  const rest = futures ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
  const wsBase = futures ? 'wss://fstream.binance.com/stream?streams=' : 'wss://stream.binance.com:9443/stream?streams=';
  const id = futures ? 'binancef' : 'binance';

  return {
    id,
    name: futures ? 'Binance Futures' : 'Binance Spot',
    short: futures ? 'BNF' : 'BN',
    kind: futures ? 'perp' : 'spot',
    color: '#f0b90b',
    hasLiquidations: futures,
    symbolFor: (base) => `${base.toUpperCase()}USDT`,

    connect(symbol, h: MarketHandlers) {
      const s = symbol.toLowerCase();
      const streams = [`${s}@aggTrade`, `${s}@depth@100ms`, `${s}@ticker`];
      if (futures) streams.push(`${s}@forceOrder`, `${s}@markPrice@1s`);
      let snapshotAbort: AbortController | null = null;
      const sync = new BinanceDepthSync(futures, (u) => h.onBook(u), () => void loadSnapshot());

      async function loadSnapshot() {
        snapshotAbort?.abort();
        const ctrl = new AbortController();
        snapshotAbort = ctrl;
        // give the socket a moment to buffer events that straddle the snapshot
        await sleep(400);
        for (let attempt = 0; attempt < 5 && !ctrl.signal.aborted; attempt++) {
          try {
            const snap = await fetchJson(`${rest}/depth?symbol=${symbol}&limit=${futures ? 1000 : 5000}`, { signal: ctrl.signal });
            if (ctrl.signal.aborted) return;
            sync.onSnapshot(snap);
            return;
          } catch (e) {
            if (ctrl.signal.aborted) return;
            h.onStatus('error', `depth snapshot: ${String(e)}`);
            await sleep(1000 * (attempt + 1));
          }
        }
      }

      const sock = new ManagedSocket({
        url: wsBase + streams.join('/'),
        staleMs: 30_000,
        onState: (st, err) => h.onStatus(st, err),
        onOpen: () => {
          sync.reset();
          void loadSnapshot();
        },
        onMessage: (msg: any) => {
          const d = msg?.data;
          if (!d) return;
          h.onFrame(d.E);
          switch (d.e) {
            case 'aggTrade':
              h.onTrades([{ venue: id, price: num(d.p), qty: num(d.q), side: d.m ? 'sell' : 'buy', time: d.T }]);
              break;
            case 'depthUpdate':
              sync.onEvent(d);
              break;
            case 'forceOrder': {
              const o = d.o;
              h.onLiquidation({
                venue: id,
                symbol: o.s,
                // a SELL liquidation order closes a long position
                position: o.S === 'SELL' ? 'long' : 'short',
                price: num(o.ap) || num(o.p),
                qty: num(o.z) || num(o.q),
                time: o.T,
              });
              break;
            }
            case 'markPriceUpdate':
              h.onStats({
                markPrice: num(d.p),
                indexPrice: num(d.i),
                fundingRate: num(d.r),
                nextFundingTime: d.T,
                fundingIntervalH: 8,
              });
              break;
            case '24hrTicker':
              h.onStats({
                last: num(d.c),
                change24hPct: num(d.P),
                high24h: num(d.h),
                low24h: num(d.l),
                volume24hUsd: num(d.q),
              });
              break;
          }
        },
      });
      void sock.connect();
      return {
        close() {
          snapshotAbort?.abort();
          sock.close();
        },
      };
    },

    async fetchKlines(symbol, interval, limit) {
      const iv = KLINE_INTERVALS.has(interval) ? interval : '1m';
      const rows = await fetchJson<any[]>(`${rest}/klines?symbol=${symbol}&interval=${iv}&limit=${Math.min(limit, futures ? 1500 : 1000)}`);
      return parseKlines(rows);
    },

    pollStats: futures
      ? async (symbol) => {
          const [oi, ls] = await Promise.allSettled([
            fetchJson(`${rest}/openInterest?symbol=${symbol}`),
            fetchJson<any[]>(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`),
          ]);
          const out: Partial<MarketStats> = {};
          if (oi.status === 'fulfilled') out.openInterest = num(oi.value.openInterest);
          if (ls.status === 'fulfilled' && ls.value[0]) {
            out.longShortRatio = num(ls.value[0].longShortRatio);
            out.longAccount = num(ls.value[0].longAccount);
            out.shortAccount = num(ls.value[0].shortAccount);
          }
          return out;
        }
      : undefined,

    fetchOiHistory: futures
      ? async (symbol): Promise<OiPoint[]> => {
          const rows = await fetchJson<any[]>(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=288`);
          return rows.map((r) => ({ time: r.timestamp, oi: num(r.sumOpenInterest), oiUsd: num(r.sumOpenInterestValue) }));
        }
      : undefined,

    async fetchTicker(symbol) {
      const t = await fetchJson(`${rest}/ticker/24hr?symbol=${symbol}`);
      return {
        venue: id,
        symbol,
        base: symbol.replace(/USDT$/, ''),
        last: num(t.lastPrice),
        change24hPct: num(t.priceChangePercent),
        volume24hUsd: num(t.quoteVolume),
        high24h: num(t.highPrice),
        low24h: num(t.lowPrice),
      };
    },

    async fetchTickers(): Promise<Ticker[]> {
      const [tickers, premium] = await Promise.all([
        fetchJson<any[]>(`${rest}/ticker/24hr`),
        futures ? fetchJson<any[]>(`${rest}/premiumIndex`) : Promise.resolve([]),
      ]);
      const funding = new Map(premium.map((p: any) => [p.symbol, num(p.lastFundingRate)]));
      return tickers
        .filter((t) => t.symbol.endsWith('USDT'))
        .map((t) => ({
          venue: id,
          symbol: t.symbol,
          base: t.symbol.replace(/USDT$/, ''),
          last: num(t.lastPrice),
          change24hPct: num(t.priceChangePercent),
          volume24hUsd: num(t.quoteVolume),
          high24h: num(t.highPrice),
          low24h: num(t.lowPrice),
          fundingRate: funding.get(t.symbol),
        }));
    },

    async backfillTrades(symbol, fromMs, toMs, onProgress, signal) {
      const out: HistTrade[] = [];
      let fromId: number | null = null;
      // first request is anchored by time (window must be < 1h), then paginate by id
      for (let i = 0; i < 400 && !signal?.aborted; i++) {
        const url: string =
          fromId === null
            ? `${rest}/aggTrades?symbol=${symbol}&startTime=${fromMs}&endTime=${Math.min(toMs, fromMs + 3_599_000)}&limit=1000`
            : `${rest}/aggTrades?symbol=${symbol}&fromId=${fromId}&limit=1000`;
        const rows: any[] = await fetchJson<any[]>(url, { signal });
        if (!rows.length) break;
        let done = false;
        for (const r of rows) {
          if (r.T > toMs) {
            done = true;
            break;
          }
          out.push({ price: num(r.p), qty: num(r.q), side: r.m ? 'sell' : 'buy', time: r.T });
        }
        const last = rows[rows.length - 1];
        onProgress?.(Math.min(1, (last.T - fromMs) / (toMs - fromMs)));
        if (done || rows.length < 1000) break;
        fromId = last.a + 1;
        await sleep(futures ? 260 : 120); // stay well inside request-weight limits
      }
      return out;
    },
  };
}

export const binanceFutures = makeBinance(true);
export const binanceSpot = makeBinance(false);

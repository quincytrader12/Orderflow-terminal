import type { BookUpdate, ConnState, Kline, Liquidation, MarketStats, Side, Ticker, Trade, VenueId } from '../core/types';

export interface MarketHandlers {
  onTrades(trades: Trade[]): void;
  onBook(update: BookUpdate): void;
  onLiquidation(liq: Liquidation): void;
  onStats(stats: Partial<MarketStats>): void;
  onStatus(state: ConnState, error?: string): void;
  /** called for every inbound frame (message rate / latency accounting) */
  onFrame(exchangeTime?: number): void;
}

export interface Connection {
  close(): void;
}

export interface HistTrade {
  price: number;
  qty: number;
  side: Side;
  time: number;
}

export interface OiPoint {
  time: number;
  oi: number;
  oiUsd: number;
}

export interface VenueAdapter {
  id: VenueId;
  name: string;
  /** short label used in chips/tape */
  short: string;
  kind: 'perp' | 'spot';
  color: string;
  hasLiquidations: boolean;
  /** venue symbol for a base asset, or null if unsupported */
  symbolFor(base: string): string | null;
  connect(symbol: string, h: MarketHandlers): Connection;
  fetchKlines(symbol: string, interval: string, limit: number): Promise<Kline[]>;
  /** REST-polled stats that are not on the socket (OI, long/short ratio) */
  pollStats?(symbol: string): Promise<Partial<MarketStats>>;
  fetchOiHistory?(symbol: string): Promise<OiPoint[]>;
  fetchTicker?(symbol: string): Promise<Ticker | null>;
  fetchTickers?(): Promise<Ticker[]>;
  backfillTrades?(symbol: string, fromMs: number, toMs: number, onProgress?: (pct: number) => void, signal?: AbortSignal): Promise<HistTrade[]>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalise an interval label (1m, 5m, 1h, 1d …) to minutes. */
export function intervalMinutes(interval: string): number {
  const m = /^(\d+)([smhdw])$/.exec(interval);
  if (!m) return 1;
  const n = Number(m[1]);
  return m[2] === 's' ? n / 60 : m[2] === 'm' ? n : m[2] === 'h' ? n * 60 : m[2] === 'd' ? n * 1440 : n * 10080;
}

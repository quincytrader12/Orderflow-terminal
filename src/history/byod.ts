import type { HistTrade } from '../exchanges/adapter';
import type { Liquidation, VenueId } from '../core/types';

/**
 * Client for the "bring your own data" history protocol (v1):
 *   GET /v1/info, /v1/trades, /v1/liquidations with optional Bearer auth.
 * Compatible with cryexc-history and with server/history-server.mjs.
 */

export interface ByodSymbolInfo {
  symbol: string;
  has_trades: boolean;
  has_liquidations: boolean;
  data_start_ms: number;
  data_end_ms: number;
}

export interface ByodInfo {
  protocol_version: number;
  server: string;
  server_time_ms: number;
  exchanges: { id: string; display_name: string; symbols: ByodSymbolInfo[] }[];
}

export class ByodError extends Error {}

export function normaliseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//.test(u)) u = `http://${u}`;
  return u;
}

async function get<T>(base: string, path: string, token: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${normaliseUrl(base)}${path}`, { headers, signal });
  } catch (e) {
    throw new ByodError(`Cannot reach history server: ${String(e)}`);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg += ` — ${body.error.message}`;
    } catch {
      /* not json */
    }
    throw new ByodError(`Remote server: ${msg}`);
  }
  return (await res.json()) as T;
}

export async function byodInfo(url: string, token: string): Promise<ByodInfo> {
  if (!url.trim()) throw new ByodError('BYOD URL not configured');
  const info = await get<ByodInfo>(url, '/v1/info', token);
  if (info.protocol_version !== 1) throw new ByodError(`Unsupported protocol version ${info.protocol_version}`);
  return info;
}

const CHUNK_MS = 15 * 60_000;

export async function byodTrades(
  url: string,
  token: string,
  exchange: VenueId,
  symbol: string,
  fromMs: number,
  toMs: number,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<HistTrade[]> {
  const out: HistTrade[] = [];
  // end_ms is inclusive on the server, so chunks are [start, start + CHUNK - 1]
  for (let start = fromMs; start <= toMs && !signal?.aborted; start += CHUNK_MS) {
    const end = Math.min(toMs, start + CHUNK_MS - 1);
    const r = await get<{ trades: { price: number; quantity: number; timestamp_ms: number; is_buyer_maker: boolean }[]; truncated: boolean }>(
      url,
      `/v1/trades?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&start_ms=${start}&end_ms=${end}`,
      token,
      signal,
    );
    for (const t of r.trades) out.push({ price: t.price, qty: t.quantity, side: t.is_buyer_maker ? 'sell' : 'buy', time: t.timestamp_ms });
    onProgress?.((end - fromMs) / (toMs - fromMs));
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export async function byodLiquidations(url: string, token: string, exchange: VenueId, symbol: string, fromMs: number, toMs: number): Promise<Liquidation[]> {
  const r = await get<{ liquidations: { side: string; price: number; quantity: number; timestamp_ms: number }[] }>(
    url,
    `/v1/liquidations?exchange=${exchange}&symbol=${encodeURIComponent(symbol)}&start_ms=${fromMs}&end_ms=${toMs}`,
    token,
  );
  return r.liquidations.map((l) => ({
    venue: exchange,
    symbol,
    position: l.side === 'short' ? 'short' : 'long',
    price: l.price,
    qty: l.quantity,
    time: l.timestamp_ms,
  }));
}

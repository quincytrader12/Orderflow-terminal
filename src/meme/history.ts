// Price history for coins that trade on a pool (migrated from pump.fun, or
// listed on DexScreener), where the terminal sees no trade-by-trade feed:
// GeckoTerminal's public minute candles for the pool, plus a sample at every
// DexScreener refresh. Charts (the Focus chart, the Telegram coin cards) use
// the coin's own trades when it has them, this otherwise.
import type { MemeToken } from './token';

type JsonGet = (url: string) => Promise<any>;

export interface PricePoint {
  t: number;
  mcapSol: number;
}

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana/pools';
const REFRESH_MS = 120_000;
const RETRY_MS = 30_000;
const MAX_POINTS = 400;

/** Minute closes for a pool, oldest first: [{ t, priceUsd }]. */
export async function poolCandles(get: JsonGet, pool: string, limit = 180): Promise<{ t: number; priceUsd: number }[]> {
  const j = await get(`${GECKO}/${pool}/ohlcv/minute?aggregate=1&limit=${limit}&currency=usd`);
  const rows: unknown[] = j?.data?.attributes?.ohlcv_list ?? [];
  return rows
    .map((r) => (Array.isArray(r) ? { t: Number(r[0]) * 1000, priceUsd: Number(r[4]) } : null))
    .filter((p): p is { t: number; priceUsd: number } => !!p && p.t > 0 && p.priceUsd > 0)
    .sort((a, b) => a.t - b.t);
}

/** Add a sample (the market cap now) to a coin's history. */
export function addSample(tok: MemeToken, t: number, mcapSol: number) {
  if (!(mcapSol > 0)) return;
  const h = (tok.history ??= []);
  if (h.length && t - h[h.length - 1].t < 5_000) h[h.length - 1] = { t, mcapSol };
  else h.push({ t, mcapSol });
  if (h.length > MAX_POINTS) h.splice(0, h.length - MAX_POINTS);
}

/** Fill a pool coin's history from its candles (at most every two minutes). */
export async function ensureHistory(tok: MemeToken, solUsd: number, get: JsonGet): Promise<void> {
  const pool = tok.dex?.pairAddress;
  if (!pool || tok.trades.length >= 2 || !(solUsd > 0) || !(tok.dex!.priceUsd > 0)) return;
  if (tok.historyAt && Date.now() - tok.historyAt < REFRESH_MS) return;
  // a failed fetch (rate limit, network) is tried again after half a minute, not two
  tok.historyAt = Date.now() - REFRESH_MS + RETRY_MS;
  // market cap from price: the supply is the pool's market cap over its price
  const supply = tok.dex!.mcapUsd / tok.dex!.priceUsd;
  const candles = await poolCandles(get, pool);
  tok.historyAt = Date.now();
  const merged = new Map<number, number>();
  for (const c of candles) merged.set(c.t, (c.priceUsd * supply) / solUsd);
  for (const p of tok.history ?? []) merged.set(p.t, p.mcapSol);
  tok.history = [...merged].sort((a, b) => a[0] - b[0]).slice(-MAX_POINTS).map(([t, mcapSol]) => ({ t, mcapSol }));
}

/**
 * A rough line from what is known before any history arrives: for a pool coin,
 * DexScreener's price changes over 24 h, 6 h, 1 h and 5 min worked back from
 * the market cap now; for a coin on the curve, its market cap at launch (or when
 * first seen) and now.
 */
export function sketchSeries(tok: MemeToken, now = Date.now()): PricePoint[] {
  const pts: PricePoint[] = [];
  const d = tok.dex;
  // a pool coin's market cap now: its latest sample (refreshed with DexScreener), else what the scanner holds
  const nowMcap = tok.history?.at(-1)?.mcapSol ?? tok.mcapSol;
  if (d && d.mcapUsd > 0 && d.priceUsd > 0 && nowMcap > 0) {
    const steps: [number, number][] = [
      [24 * 3600_000, d.change.h24],
      [6 * 3600_000, d.change.h6],
      [3600_000, d.change.h1],
      [300_000, d.change.m5],
    ];
    const born = d.pairCreatedAt ?? tok.createdAt;
    for (const [ago, pct] of steps) {
      if (!Number.isFinite(pct) || pct <= -100 || now - ago < born) continue;
      pts.push({ t: now - ago, mcapSol: nowMcap / (1 + pct / 100) });
    }
  } else if (tok.firstMcapSol > 0 && tok.createdAt < now - 1000) {
    pts.push({ t: tok.createdAt, mcapSol: tok.firstMcapSol });
  }
  for (const tr of tok.trades) pts.push({ t: tr.t, mcapSol: tr.mcapSol });
  const last = tok.trades.length ? tok.mcapSol : nowMcap;
  if (last > 0 && (!pts.length || pts[pts.length - 1].t < now - 1000)) pts.push({ t: now, mcapSol: last });
  return pts.length >= 2 ? pts.sort((a, b) => a.t - b.t) : [];
}

/** What to chart: the coin's trades when it has them, its pool history next, a sketch from what is known otherwise. */
export function priceSeries(tok: MemeToken, now = Date.now()): PricePoint[] {
  if (tok.trades.length >= 2) return tok.trades;
  if ((tok.history?.length ?? 0) >= 2) return tok.history!;
  return sketchSeries(tok, now);
}

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
  tok.historyAt = Date.now();
  // market cap from price: the supply is the pool's market cap over its price
  const supply = tok.dex!.mcapUsd / tok.dex!.priceUsd;
  const candles = await poolCandles(get, pool);
  const merged = new Map<number, number>();
  for (const c of candles) merged.set(c.t, (c.priceUsd * supply) / solUsd);
  for (const p of tok.history ?? []) merged.set(p.t, p.mcapSol);
  tok.history = [...merged].sort((a, b) => a[0] - b[0]).slice(-MAX_POINTS).map(([t, mcapSol]) => ({ t, mcapSol }));
}

/** What to chart: the coin's trades when it has them, its pool history otherwise. */
export function priceSeries(tok: MemeToken): PricePoint[] {
  return tok.trades.length >= 2 ? tok.trades : (tok.history ?? []);
}

// DexScreener's public API (no key): boosted and newly profiled Solana coins,
// and pair data — price, market cap, liquidity, volume, buys/sells, change.
// Limits: profiles and boosts 60 requests a minute, pairs 300 a minute.
import type { DexInfo } from './token';

export const DEX_API = 'https://api.dexscreener.com';
export type JsonGet = (url: string) => Promise<any>;

export interface DexListing {
  mint: string;
  /** boosted (paid promotion) rather than just a new profile */
  boosted: boolean;
  boostAmount: number;
  icon?: string;
  links: { type: string; url: string }[];
}

/** Solana coins from the latest profiles and boosts, newest first, one per mint. */
export async function dexListings(get: JsonGet): Promise<DexListing[]> {
  const [profiles, boosts] = await Promise.all([get(`${DEX_API}/token-profiles/latest/v1`).catch(() => []), get(`${DEX_API}/token-boosts/latest/v1`).catch(() => [])]);
  const out = new Map<string, DexListing>();
  const add = (r: any, boosted: boolean) => {
    if (!r || r.chainId !== 'solana' || typeof r.tokenAddress !== 'string') return;
    const prev = out.get(r.tokenAddress);
    const links = Array.isArray(r.links) ? r.links.filter((l: any) => typeof l?.url === 'string').map((l: any) => ({ type: String(l.type ?? l.label ?? 'website').toLowerCase(), url: l.url })) : [];
    out.set(r.tokenAddress, {
      mint: r.tokenAddress,
      boosted: boosted || Boolean(prev?.boosted),
      boostAmount: Math.max(prev?.boostAmount ?? 0, Number(r.totalAmount ?? r.amount ?? 0) || 0),
      icon: r.icon ?? prev?.icon,
      links: prev?.links.length ? prev.links : links,
    });
  };
  for (const r of Array.isArray(boosts) ? boosts : []) add(r, true);
  for (const r of Array.isArray(profiles) ? profiles : []) add(r, false);
  return [...out.values()];
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const tx = (o: any) => ({ buys: n(o?.buys), sells: n(o?.sells) });

/** One DexScreener pair → DexInfo. */
export function parsePair(p: any): DexInfo {
  const socials: { type: string; url: string }[] = [];
  for (const w of p?.info?.websites ?? []) if (w?.url) socials.push({ type: 'website', url: w.url });
  for (const s of p?.info?.socials ?? []) {
    const url = s?.url ?? (s?.platform === 'twitter' && s?.handle ? `https://x.com/${s.handle}` : null);
    if (url) socials.push({ type: String(s.type ?? s.platform ?? 'social').toLowerCase(), url });
  }
  return {
    pairAddress: String(p?.pairAddress ?? ''),
    dexId: String(p?.dexId ?? ''),
    url: String(p?.url ?? ''),
    priceUsd: n(p?.priceUsd),
    mcapUsd: n(p?.marketCap ?? p?.fdv),
    liquidityUsd: n(p?.liquidity?.usd),
    volume: { m5: n(p?.volume?.m5), h1: n(p?.volume?.h1), h6: n(p?.volume?.h6), h24: n(p?.volume?.h24) },
    txns: { m5: tx(p?.txns?.m5), h1: tx(p?.txns?.h1), h24: tx(p?.txns?.h24) },
    change: { m5: n(p?.priceChange?.m5), h1: n(p?.priceChange?.h1), h6: n(p?.priceChange?.h6), h24: n(p?.priceChange?.h24) },
    pairCreatedAt: Number.isFinite(Number(p?.pairCreatedAt)) ? Number(p.pairCreatedAt) : null,
    boosts: n(p?.boosts?.active),
    socials,
    imageUrl: p?.info?.imageUrl,
  };
}

export interface DexToken {
  mint: string;
  name: string;
  symbol: string;
  pair: DexInfo;
}

/**
 * Pair data for up to 30 mints per request; for each mint the pair with the
 * most liquidity (its main pool).
 */
export async function dexTokens(get: JsonGet, mints: string[]): Promise<DexToken[]> {
  const out = new Map<string, { tok: DexToken; liq: number }>();
  for (let i = 0; i < mints.length; i += 30) {
    const rows = await get(`${DEX_API}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`);
    for (const p of Array.isArray(rows) ? rows : []) {
      const mint = p?.baseToken?.address;
      if (typeof mint !== 'string') continue;
      const pair = parsePair(p);
      const prev = out.get(mint);
      if (!prev || pair.liquidityUsd > prev.liq) out.set(mint, { tok: { mint, name: String(p.baseToken.name ?? ''), symbol: String(p.baseToken.symbol ?? ''), pair }, liq: pair.liquidityUsd });
    }
  }
  return [...out.values()].map((v) => v.tok);
}

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** SOL in USD from its deepest stablecoin pool. */
export async function solPriceUsd(get: JsonGet): Promise<number> {
  const rows = await get(`${DEX_API}/tokens/v1/solana/${SOL_MINT}`);
  let best = 0;
  let px = NaN;
  for (const p of Array.isArray(rows) ? rows : []) {
    if (p?.baseToken?.address !== SOL_MINT || !/^(USDC|USDT)$/.test(p?.quoteToken?.symbol ?? '')) continue;
    const liq = n(p?.liquidity?.usd);
    if (liq > best && n(p.priceUsd) > 0) {
      best = liq;
      px = n(p.priceUsd);
    }
  }
  if (!(px > 0)) throw new Error('no SOL price');
  return px;
}

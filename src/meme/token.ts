// One meme coin as the scanner knows it: where it came from, its live trades
// on the curve or pool, and the order-flow read-out computed from them.
import { curveProgress, multipleToGraduate, type PumpCreate, type PumpTrade } from './pump';

export type MemeStage = 'new' | 'final' | 'migrated';

export interface MemeTrade {
  t: number;
  side: 'buy' | 'sell';
  wallet: string;
  sol: number;
  tokens: number;
  mcapSol: number;
  signature: string;
  /** the wallet is the coin's creator */
  dev: boolean;
}

/** What DexScreener says about a coin with a pool (migrated, or not from pump.fun). */
export interface DexInfo {
  pairAddress: string;
  dexId: string;
  url: string;
  priceUsd: number;
  mcapUsd: number;
  liquidityUsd: number;
  volume: { m5: number; h1: number; h6: number; h24: number };
  txns: { m5: { buys: number; sells: number }; h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  change: { m5: number; h1: number; h6: number; h24: number };
  pairCreatedAt: number | null;
  boosts: number;
  socials: { type: string; url: string }[];
  imageUrl?: string;
}

/** On-chain checks (Solana RPC). */
export interface Safety {
  checkedAt: number;
  mintRevoked: boolean | null;
  freezeRevoked: boolean | null;
  /** share of supply in the ten largest holders, curve and pool excluded, 0…1 */
  top10: number | null;
  /** share of the single largest holder, curve and pool excluded */
  top1: number | null;
  error?: string;
}

export interface MemeToken {
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  image?: string;
  creator?: string;
  bondingCurve?: string;
  /** launch time (pump.fun create) or pool creation (DexScreener) */
  createdAt: number;
  source: 'pump' | 'dex';
  pool: string;
  /** virtual reserves on the curve (pump.fun) */
  vTokens: number;
  vSol: number;
  mcapSol: number;
  /** market cap when the scanner first saw it */
  firstMcapSol: number;
  migrated: boolean;
  migratedAt?: number;
  devInitialSol: number;
  devInitialTokens: number;
  trades: MemeTrade[];
  lastTradeAt: number;
  dex?: DexInfo;
  safety?: Safety;
  /** curve progress five minutes ago, for its speed */
  progressMarks: { t: number; p: number }[];
}

const MAX_TRADES = 600;

export function tokenFromCreate(c: PumpCreate): MemeToken {
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    uri: c.uri,
    creator: c.creator,
    bondingCurve: c.bondingCurve || undefined,
    createdAt: c.t,
    source: 'pump',
    pool: c.pool,
    vTokens: c.vTokens,
    vSol: c.vSol,
    mcapSol: c.mcapSol,
    firstMcapSol: c.mcapSol,
    migrated: false,
    devInitialSol: c.initialBuySol,
    devInitialTokens: c.initialBuyTokens,
    trades: [],
    lastTradeAt: c.t,
    progressMarks: [{ t: c.t, p: curveProgress(c.vTokens) }],
  };
}

/** Apply one trade (mutates; the store copies the token before it renders). */
export function applyTrade(tok: MemeToken, tr: PumpTrade) {
  tok.trades.push({ t: tr.t, side: tr.side, wallet: tr.wallet, sol: tr.sol, tokens: tr.tokens, mcapSol: tr.mcapSol, signature: tr.signature, dev: Boolean(tok.creator) && tr.wallet === tok.creator });
  if (tok.trades.length > MAX_TRADES) tok.trades.splice(0, tok.trades.length - MAX_TRADES);
  tok.lastTradeAt = Math.max(tok.lastTradeAt, tr.t);
  if (Number.isFinite(tr.mcapSol) && tr.mcapSol > 0) tok.mcapSol = tr.mcapSol;
  if (Number.isFinite(tr.vTokens) && tr.vTokens > 0) {
    tok.vTokens = tr.vTokens;
    tok.vSol = tr.vSol;
  }
  if (tr.pool && tr.pool !== 'pump') tok.pool = tr.pool;
  // a mark at most every 20 s, an hour of them
  const last = tok.progressMarks[tok.progressMarks.length - 1];
  if (!last || tr.t - last.t >= 20_000) {
    tok.progressMarks.push({ t: tr.t, p: curveProgress(tok.vTokens) });
    if (tok.progressMarks.length > 180) tok.progressMarks.shift();
  }
}

export function stageOf(tok: MemeToken, finalAt = 0.7): MemeStage {
  if (tok.migrated || tok.source === 'dex') return 'migrated';
  return curveProgress(tok.vTokens) >= finalAt ? 'final' : 'new';
}

export interface Flow {
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  netSol: number;
  /** distinct buying wallets */
  buyers: number;
  /** largest single wallet's share of the buy volume, 0…1 */
  topBuyerShare: number;
  /** wallets that both bought and sold in the window (churn, often bots or wash) */
  churners: number;
}

/** Order flow over the last `sec` seconds of the coin's trades. */
export function flow(tok: MemeToken, now: number, sec: number): Flow {
  const from = now - sec * 1000;
  const f: Flow = { buys: 0, sells: 0, buySol: 0, sellSol: 0, netSol: 0, buyers: 0, topBuyerShare: 0, churners: 0 };
  const byBuyer = new Map<string, number>();
  const sellers = new Set<string>();
  for (let i = tok.trades.length - 1; i >= 0; i--) {
    const tr = tok.trades[i];
    if (tr.t < from) break;
    if (tr.side === 'buy') {
      f.buys++;
      f.buySol += tr.sol;
      byBuyer.set(tr.wallet, (byBuyer.get(tr.wallet) ?? 0) + tr.sol);
    } else {
      f.sells++;
      f.sellSol += tr.sol;
      sellers.add(tr.wallet);
    }
  }
  f.netSol = f.buySol - f.sellSol;
  f.buyers = byBuyer.size;
  let top = 0;
  for (const [w, v] of byBuyer) {
    top = Math.max(top, v);
    if (sellers.has(w)) f.churners++;
  }
  f.topBuyerShare = f.buySol > 0 ? top / f.buySol : 0;
  return f;
}

/** Curve progress gained over the last `sec` seconds (0…1). */
export function progressGain(tok: MemeToken, now: number, sec: number): number {
  const p = curveProgress(tok.vTokens);
  const from = now - sec * 1000;
  let base = tok.progressMarks[0]?.p ?? p;
  for (const m of tok.progressMarks) {
    if (m.t <= from) base = m.p;
    else break;
  }
  return Math.max(0, p - base);
}

export interface DevActivity {
  sold: boolean;
  /** share of the creator's launch tokens sold, 0…1 (null without a launch buy) */
  soldShare: number | null;
  sellCount: number;
}

export function devActivity(tok: MemeToken): DevActivity {
  let sold = 0;
  let sells = 0;
  for (const tr of tok.trades) if (tr.dev && tr.side === 'sell') (sold += tr.tokens), sells++;
  return { sold: sells > 0, soldShare: tok.devInitialTokens > 0 ? Math.min(1, sold / tok.devInitialTokens) : null, sellCount: sells };
}

export const multipleSinceFirst = (tok: MemeToken) => (tok.firstMcapSol > 0 && tok.mcapSol > 0 ? tok.mcapSol / tok.firstMcapSol : 1);
export const toGraduate = (tok: MemeToken) => (tok.migrated || tok.source === 'dex' ? null : multipleToGraduate(tok.mcapSol));

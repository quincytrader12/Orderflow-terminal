// The swarm's judges. Each reads a coin and answers one question:
//
//   Sentinel   — is it viable, or is it built to rug?
//   Herald     — is it catching on (virality)?
//   Strategist — given both and the buying, is it worth a trade now?
//
// What the research says, and where each rule comes from:
//  - Under 1 % of pump.fun coins ever graduate (0.6–0.9 % in 2025); about four
//    in five stop trading on their first day. Saying no is most of the job.
//  - Insiders win: dev-linked wallets buy in the launch block of about one
//    coin in five (median ~10 % of supply), and bundlers took far more profit
//    than snipers (Bitquery 2025–26). → early-bundle and creator-bag checks.
//  - High-risk launches: fewer buyers buying more each, concentrated holdings,
//    bundled early accounts (MemeTrans / MELT, arXiv 2602.13480). → buyer
//    breadth, top-buyer share, holder concentration.
//  - Rugs show up within minutes as long idle gaps between trades; on pools,
//    as liquidity pulled ("Catching the Rug", arXiv 2608.20271). → idle-time
//    and liquidity checks.
//  - Wash trading: the same wallet buying and selling against one curve
//    (arXiv 2609.10246). → churn.
//  - About a quarter of coins launch off a tweet or a trend; many copy the
//    same name. → narrative clusters: how many coins share the meme right now.
import { flow, devActivity, type MemeToken } from '../token';
import { curveProgress } from '../pump';
import type { Assessment } from '../score';

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const log = (x: number, full: number) => clamp(Math.log10(1 + Math.max(0, x)) / Math.log10(1 + full));
const pct = (x: number) => `${Math.round(x * 100)}%`;

// ---------- Sentinel: viability ----------

export interface Viability {
  verdict: 'pass' | 'watch' | 'reject';
  /** 0–100, after penalties */
  score: number;
  reasons: string[];
  /** wallets (not the creator) that bought within seconds of launch, and their share of supply */
  early: { wallets: number; share: number };
}

/** What the swarm remembers about a creator across launches it has seen. */
export interface CreatorRecord {
  launches: number;
  rugs: number;
}

/** Buys by other wallets in the first `sec` seconds after launch — snipers and bundles. */
export function earlyBuys(tok: MemeToken, sec = 3) {
  const end = tok.createdAt + sec * 1000;
  const wallets = new Set<string>();
  let tokens = 0;
  for (const tr of tok.trades) {
    if (tr.t > end) break;
    if (tr.side === 'buy' && !tr.dev) {
      wallets.add(tr.wallet);
      tokens += tr.tokens;
    }
  }
  return { wallets: wallets.size, share: tokens / 1e9 };
}

export function sentinel(tok: MemeToken, now: number, creator?: CreatorRecord): Viability {
  const reasons: string[] = [];
  let score = 100;
  let reject = false;
  let watch = false;
  const no = (why: string) => {
    reject = true;
    reasons.push(why);
  };
  const hm = (why: string, pts: number) => {
    score -= pts;
    reasons.push(why);
  };
  const s = tok.safety;
  if (!s) {
    watch = true;
    reasons.push('waiting for the on-chain check');
  } else {
    if (s.mintRevoked === false) no('mint authority live — supply can be printed');
    if (s.freezeRevoked === false) no('freeze authority live — holders can be frozen');
    if (s.top10 !== null && s.top10 > 0.5) no(`top 10 wallets hold ${pct(s.top10)}`);
    else if (s.top10 !== null && s.top10 > 0.3) hm(`top 10 wallets hold ${pct(s.top10)}`, 20);
    if (s.top1 !== null && s.top1 > 0.15) hm(`one wallet holds ${pct(s.top1)}`, 15);
  }
  const early = tok.source === 'pump' ? earlyBuys(tok) : { wallets: 0, share: 0 };
  if (tok.source === 'pump') {
    const devShare = tok.devInitialTokens / 1e9;
    if (devShare >= 0.2) no(`creator bought ${pct(devShare)} of the supply at launch`);
    else if (devShare >= 0.08) hm(`creator bought ${pct(devShare)} at launch`, 15);
    if (early.wallets >= 4 && early.share >= 0.1) no(`${early.wallets} wallets bought ${pct(early.share)} within 3 s of launch — bundled or sniped`);
    else if (early.wallets >= 3 && early.share >= 0.05) hm(`${early.wallets} wallets bought ${pct(early.share)} in the first seconds`, 15);
    const dev = devActivity(tok);
    if (dev.sold && (dev.soldShare ?? 0) >= 0.5) no(`creator sold ${pct(dev.soldShare ?? 1)} of the launch bag`);
    else if (dev.sold) hm(`creator sold ${pct(dev.soldShare ?? 0)} of the launch bag`, 20);
  }
  const f5 = flow(tok, now, 300);
  if (f5.buys >= 6 && f5.topBuyerShare > 0.5) hm(`one wallet is ${pct(f5.topBuyerShare)} of the buying`, 15);
  if (f5.buyers >= 5 && f5.churners / f5.buyers > 0.5) no(`${f5.churners} of ${f5.buyers} buyers also sold within minutes — wash trading`);
  if (tok.trades.length >= 5 && now - tok.lastTradeAt > 180_000 && !tok.dex) no('no trades for 3 minutes — gone idle');
  if (tok.dex && tok.dex.liquidityUsd < 5_000 && (tok.migrated || tok.source === 'dex')) no('pool liquidity under $5k');
  if (creator && creator.rugs > 0) no(`this creator's earlier coin${creator.rugs > 1 ? 's' : ''} rugged (${creator.rugs})`);
  else if (creator && creator.launches >= 3) hm(`serial launcher — ${creator.launches} coins seen from this creator`, 15);
  score = Math.max(0, Math.round(score));
  const verdict = reject ? 'reject' : watch || score < 50 ? 'watch' : 'pass';
  return { verdict, score: reject ? 0 : score, reasons, early };
}

// ---------- Herald: virality ----------

const STOP = new Set(['the', 'coin', 'token', 'sol', 'solana', 'pump', 'fun', 'official', 'meme', 'new', 'first', 'real', 'and', 'for', 'of', 'on', 'inu', 'ai', 'cto']);

/** The words a coin's name and ticker are made of (what copycats share). */
export function memeWords(name: string, symbol: string): string[] {
  const out = new Set<string>();
  for (const w of `${name} ${symbol}`.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
  return [...out];
}

/** How many coins share each meme word over the last hour: the narratives running hot. */
export class Narratives {
  private seen: { t: number; mint: string; words: string[] }[] = [];
  private known = new Set<string>();
  add(mint: string, name: string, symbol: string, t: number) {
    if (this.known.has(mint)) return;
    this.known.add(mint);
    this.seen.push({ t, mint, words: memeWords(name, symbol) });
  }
  prune(now: number) {
    const from = now - 3_600_000;
    while (this.seen.length && this.seen[0].t < from) this.known.delete(this.seen.shift()!.mint);
  }
  /** The coin's hottest word, how many launches share it, and the mints in that cluster. */
  cluster(name: string, symbol: string): { word: string; count: number; mints: string[] } | null {
    let best: { word: string; count: number; mints: string[] } | null = null;
    for (const w of memeWords(name, symbol)) {
      const mints = this.seen.filter((x) => x.words.includes(w)).map((x) => x.mint);
      if (!best || mints.length > best.count) best = { word: w, count: mints.length, mints };
    }
    return best;
  }
  /** The hottest narratives right now. */
  top(n = 8): { word: string; count: number }[] {
    const c = new Map<string, number>();
    for (const x of this.seen) for (const w of x.words) c.set(w, (c.get(w) ?? 0) + 1);
    return [...c.entries()]
      .filter(([, k]) => k >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, n)
      .map(([word, count]) => ({ word, count }));
  }
}

export interface Virality {
  /** 0–100 */
  score: number;
  reasons: string[];
  narrative: { word: string; count: number; leader: boolean } | null;
}

/** Distinct new buyers per minute over the last two minutes, and against the two before. */
export function buyerGrowth(tok: MemeToken, now: number) {
  const seenBefore = new Set<string>();
  const a = now - 120_000;
  const b = now - 240_000;
  let recent = 0;
  let prior = 0;
  for (const tr of tok.trades) {
    if (tr.side !== 'buy' || tr.t > now) continue;
    if (seenBefore.has(tr.wallet)) continue;
    seenBefore.add(tr.wallet);
    if (tr.t >= a) recent++;
    else if (tr.t >= b) prior++;
  }
  return { perMin: recent / 2, accel: (recent + 1) / (prior + 1), total: seenBefore.size };
}

export function herald(tok: MemeToken, now: number, narratives: Narratives, leaderOf: (mints: string[]) => string | null): Virality {
  const reasons: string[] = [];
  let score = 0;
  // 1. new wallets arriving, and arriving faster
  const g = buyerGrowth(tok, now);
  const growth = log(g.perMin, 20) * 25 + clamp((g.accel - 1) / 2) * 10;
  score += growth;
  if (g.perMin >= 3) reasons.push(`${g.perMin.toFixed(1)} new buyers a minute${g.accel >= 1.5 ? `, ${g.accel.toFixed(1)}× faster than before` : ''}`);
  // pools: DexScreener's trade counts stand in for wallets
  if (tok.dex && (tok.source === 'dex' || tok.migrated) && !tok.trades.length) {
    const t5 = tok.dex.txns.m5.buys + tok.dex.txns.m5.sells;
    score += log(t5, 200) * 25;
    if (t5 >= 50) reasons.push(`${t5} trades in 5 min`);
  }
  // 2. the meme: how many coins are copying it this hour, and is this the leader
  const c = narratives.cluster(tok.name, tok.symbol);
  let narrative: Virality['narrative'] = null;
  if (c && c.count >= 2) {
    const leader = leaderOf(c.mints) === tok.mint;
    narrative = { word: c.word, count: c.count, leader };
    score += (c.count >= 15 ? 22 : c.count >= 8 ? 17 : c.count >= 4 ? 10 : 5) + (leader ? 8 : 0);
    reasons.push(`"${c.word}" is running — ${c.count} coins on it this hour${leader ? ', and this one leads' : ''}`);
  }
  // 3. a real community behind it: linked socials, paid promotion
  const socials = new Set<string>();
  if (tok.meta?.twitter) socials.add('x');
  if (tok.meta?.telegram) socials.add('telegram');
  if (tok.meta?.website) socials.add('website');
  for (const x of tok.dex?.socials ?? []) socials.add(/twitter|x\.com/.test(x.type + x.url) ? 'x' : /telegram|t\.me/.test(x.type + x.url) ? 'telegram' : 'website');
  score += Math.min(3, socials.size) * 5;
  if (socials.size) reasons.push(`links ${[...socials].join(', ')}`);
  if (tok.dex && (tok.dex.boosts > 0 || tok.dex.socials.length)) {
    score += tok.dex.boosts > 0 ? 10 : 5;
    reasons.push(tok.dex.boosts > 0 ? 'team is paying for DexScreener boosts' : 'DexScreener profile set up');
  }
  // 4. breadth: how many wallets have bought in at all
  score += log(g.total, 300) * 15;
  if (g.total >= 50) reasons.push(`${g.total} wallets have bought in`);
  return { score: Math.round(clamp(score, 0, 100)), reasons, narrative };
}

// ---------- Strategist: entry ----------

export interface StrategyConfig {
  minHeat: number;
  minVirality: number;
  /** viability score needed (verdict must be pass) */
  minViability: number;
  maxAgeMin: number;
  /** pump curve: enter between these shares sold (not the first seconds, not the very top) */
  minCurve: number;
  maxCurve: number;
  /** most market cap to enter at, USD (room to run) */
  maxMcapUsd: number;
  /** pools: least liquidity, USD */
  minLiquidityUsd: number;
  /** conviction needed to buy (0–100) */
  minConviction: number;
  /** room needed: the target market cap ÷ the market cap now */
  minRoom: number;
  targetMcapUsd: number;
  /** no buying straight after a vertical run. Pools: most the price may have risen in the last 5 min (0.6 = +60 %) */
  maxRun5m: number;
  /** on the curve: most the price may stand above its 5-minute average (1.5 = 50 % above) — a steady climb passes, a spike does not */
  maxExtension: number;
  /** buyers must outweigh sellers over the last 5 min: least share of the buying (SOL on the curve, trades on a pool) */
  minBuyShare: number;
}

export const STRATEGY_DEFAULTS: StrategyConfig = {
  minHeat: 55,
  minVirality: 45,
  minViability: 60,
  maxAgeMin: 45,
  minCurve: 0.12,
  maxCurve: 0.85,
  maxMcapUsd: 200_000,
  minLiquidityUsd: 20_000,
  minConviction: 80,
  minRoom: 5,
  targetMcapUsd: 1_000_000,
  maxRun5m: 0.6,
  maxExtension: 1.5,
  minBuyShare: 0.58,
};

/** How far the price ran over the last 5 minutes (0.6 = +60 %), or null when it cannot be told. */
export function run5m(tok: MemeToken, now: number): number | null {
  if (tok.source === 'pump' && !tok.migrated && tok.trades.length) {
    const from = now - 300_000;
    let before = null as number | null;
    for (const tr of tok.trades) {
      if (tr.t > from) break;
      before = tr.mcapSol;
    }
    // younger than 5 minutes: measured from the first trade
    const base = before ?? tok.trades[0].mcapSol;
    return base > 0 ? tok.mcapSol / base - 1 : null;
  }
  const c = tok.dex?.change.m5;
  return Number.isFinite(c) ? c! / 100 : null;
}

/** On the curve: the price now over its trade-weighted average of the last 5 minutes (1 = flat), or null. */
export function extension5m(tok: MemeToken, now: number): number | null {
  if (tok.source !== 'pump' || tok.migrated) return null;
  const from = now - 300_000;
  let sum = 0;
  let w = 0;
  for (let i = tok.trades.length - 1; i >= 0; i--) {
    const tr = tok.trades[i];
    if (tr.t < from) break;
    sum += tr.mcapSol * tr.sol;
    w += tr.sol;
  }
  return w > 0 && sum > 0 ? tok.mcapSol / (sum / w) : null;
}

/** The buying's share over the last 5 minutes (SOL on the curve, trade count on a pool), or null. */
export function buyShare5m(tok: MemeToken, now: number): number | null {
  if (tok.source === 'pump' && !tok.migrated) {
    const f = flow(tok, now, 300);
    return f.buySol + f.sellSol > 0 ? f.buySol / (f.buySol + f.sellSol) : null;
  }
  const t = tok.dex?.txns.m5;
  return t && t.buys + t.sells > 0 ? t.buys / (t.buys + t.sells) : null;
}

export interface Decision {
  enter: boolean;
  conviction: number;
  why: string;
}

export function strategist(tok: MemeToken, a: Assessment, v: Viability, x: Virality, cfg: StrategyConfig): Decision {
  const conviction = Math.round(0.4 * a.heat + 0.35 * x.score + 0.25 * v.score);
  const skip = (why: string): Decision => ({ enter: false, conviction, why });
  if (v.verdict !== 'pass') return skip(v.verdict === 'reject' ? `rejected: ${v.reasons[0]}` : `watching: ${v.reasons[0] ?? 'checks pending'}`);
  if (v.score < cfg.minViability) return skip(`viability ${v.score} < ${cfg.minViability}`);
  if (a.heat < cfg.minHeat) return skip(`heat ${a.heat} < ${cfg.minHeat}`);
  if (x.score < cfg.minVirality) return skip(`virality ${x.score} < ${cfg.minVirality}`);
  if (a.ageSec > cfg.maxAgeMin * 60) return skip(`older than ${cfg.maxAgeMin} min`);
  if (Number.isFinite(a.mcapUsd) && a.mcapUsd > cfg.maxMcapUsd) return skip(`market cap above $${Math.round(cfg.maxMcapUsd / 1000)}k — little room`);
  // room for the multiple worth the risk: a 5× needs the target to be 5× the market cap now
  if (Number.isFinite(a.mcapUsd) && a.mcapUsd > 0 && cfg.targetMcapUsd / a.mcapUsd < cfg.minRoom) return skip(`only ${(cfg.targetMcapUsd / a.mcapUsd).toFixed(1)}× of room to $${Math.round(cfg.targetMcapUsd / 1000)}k — needs ${cfg.minRoom}×`);
  const onCurve = tok.source === 'pump' && !tok.migrated;
  if (onCurve) {
    const p = curveProgress(tok.vTokens);
    if (p < cfg.minCurve) return skip(`curve ${pct(p)} — too early to tell`);
    if (p > cfg.maxCurve) return skip(`curve ${pct(p)} — late, graduation sells into it`);
  } else if (!tok.dex || tok.dex.liquidityUsd < cfg.minLiquidityUsd) return skip('pool too thin');
  // not straight after a vertical candle: those mostly give it back (the buyer is the exit liquidity)
  const now = tok.lastTradeAt || Date.now();
  if (onCurve) {
    const ext = extension5m(tok, now);
    if (ext !== null && ext > cfg.maxExtension) return skip(`price ${Math.round((ext - 1) * 100)}% above its 5-min average — not chasing the spike, waiting for it to settle`);
  } else {
    const run = run5m(tok, now);
    if (run !== null && run > cfg.maxRun5m) return skip(`up ${Math.round(run * 100)}% in 5 min — not chasing the spike, waiting for it to settle`);
  }
  // net buying, not a churn of buys and sells
  const share = buyShare5m(tok, now);
  if (share !== null && share < cfg.minBuyShare) return skip(`buyers only ${Math.round(share * 100)}% of the flow — needs ${Math.round(cfg.minBuyShare * 100)}%`);
  if (conviction < cfg.minConviction) return skip(`conviction ${conviction} < ${cfg.minConviction}`);
  const lead = [`heat ${a.heat}`, `virality ${x.score}`, `viability ${v.score}`];
  const room = Number.isFinite(a.mcapUsd) && a.mcapUsd > 0 ? ` · ${(cfg.targetMcapUsd / a.mcapUsd).toFixed(0)}× room to $${Math.round(cfg.targetMcapUsd / 1000)}k` : '';
  const flowNote = share !== null ? ` · ${Math.round(share * 100)}% buys` : '';
  return { enter: true, conviction, why: `${lead.join(' · ')}${room}${flowNote} — ${[...x.reasons.slice(0, 2), a.summary].filter(Boolean).join('; ')}` };
}

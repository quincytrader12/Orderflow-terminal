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
//  - A few wallets take most of the gains: 15 insider wallets netted ~$20M on
//    FOCAI after buying on pump.fun for a few SOL (Lookonchain, 2025); whale
//    and cluster wallets drive Solana meme trading (White Whale Labs, 384M
//    swaps); smart money rotates out fast (Nansen). Early buyers are not always
//    smart — bots and insiders who dump look the same at first. → the insider
//    tracker: learn which wallets really sell at 3×+, follow them and quiet big
//    buyers in early, and leave the moment they start selling.
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

// ---------- Insider tracker: smart money and quiet accumulation ----------

/** A wallet the swarm has seen trade: coins it sold at 3×+ of its buy (hits) out of the coins it was seen in since. */
export interface SmartWallet {
  hits: number;
  tries: number;
  at: number;
}
export type SmartBook = Record<string, SmartWallet>;

/** Proven: at least two coins sold at 3×+ and right on at least 30 % of the coins since. */
export const isSmart = (w?: SmartWallet) => Boolean(w && w.hits >= 2 && w.hits / Math.max(1, w.tries) >= 0.3);

const SMART_MULT = 3;
const SMART_MAX = 1500;

/**
 * Learn from what the swarm watches: a wallet that bought a coin and sold it
 * at 3× its average buy (or better) scores a hit; a known wallet's other coins
 * count once they are 30 minutes old. Mutates `book`; `done` holds the
 * wallet:coin pairs already counted. Returns the new hits.
 */
export function learnSmart(book: SmartBook, tokens: MemeToken[], now: number, done: Set<string>, skip?: string): number {
  let fresh = 0;
  for (const tok of tokens) {
    if (tok.trades.length < 10) continue;
    const by = new Map<string, { buy: number; buyW: number; sell: number; sellW: number }>();
    for (const tr of tok.trades) {
      if (tr.dev || tr.wallet === skip || !(tr.mcapSol > 0)) continue;
      const w = by.get(tr.wallet) ?? { buy: 0, buyW: 0, sell: 0, sellW: 0 };
      if (tr.side === 'buy') {
        w.buy += tr.sol;
        w.buyW += tr.sol * tr.mcapSol;
      } else {
        w.sell += tr.sol;
        w.sellW += tr.sol * tr.mcapSol;
      }
      by.set(tr.wallet, w);
    }
    const settled = now - tok.createdAt > 30 * 60_000;
    for (const [wallet, w] of by) {
      if (w.buy < 0.1) continue;
      const key = `${wallet}:${tok.mint}`;
      if (done.has(key)) continue;
      const hit = w.sell >= 0.1 && w.sellW / w.sell >= SMART_MULT * (w.buyW / w.buy);
      const rec = book[wallet];
      if (hit) {
        book[wallet] = { hits: (rec?.hits ?? 0) + 1, tries: (rec?.tries ?? 0) + 1, at: now };
        done.add(key);
        fresh++;
      } else if (rec && settled) {
        rec.tries++;
        done.add(key);
      }
    }
  }
  // keep the best wallets when the book is full
  const keys = Object.keys(book);
  if (keys.length > SMART_MAX) {
    keys.sort((a, b) => book[a].hits - book[b].hits || book[a].at - book[b].at);
    for (const k of keys.slice(0, keys.length - SMART_MAX)) delete book[k];
  }
  return fresh;
}

export interface InsiderRead {
  /** 0–100 */
  score: number;
  reasons: string[];
  /** the wallets behind it, followed for the exit */
  wallets: string[];
}

/**
 * Signs that people who know are buying, before the crowd: proven wallets
 * (see learnSmart) holding it, several wallets each buying 1 SOL+ in the last
 * 3 minutes without selling, the buying one-sided, few wallets but big sizes,
 * and the creator adding to the launch bag. Proven wallets already selling
 * count against it. Launch-second buys are the Sentinel's (bundles, snipers).
 */
export function insiderRead(tok: MemeToken, now: number, book: SmartBook): InsiderRead {
  const none: InsiderRead = { score: 0, reasons: [], wallets: [] };
  if (tok.trades.length < 5) return none;
  const launchEnd = tok.createdAt + 3000;
  const from10 = now - 600_000;
  const from3 = now - 180_000;
  const by = new Map<string, { buy: number; sell: number; buy3: number; sell3: number }>();
  let buy3 = 0;
  let sell3 = 0;
  let devAdded = false;
  for (const tr of tok.trades) {
    if (tr.t < from10 || tr.t > now) continue;
    if (tr.dev) {
      if (tr.side === 'buy' && tr.t > tok.createdAt + 60_000) devAdded = true;
      continue;
    }
    if (tr.t <= launchEnd) continue;
    const w = by.get(tr.wallet) ?? { buy: 0, sell: 0, buy3: 0, sell3: 0 };
    const recent = tr.t >= from3;
    if (tr.side === 'buy') {
      w.buy += tr.sol;
      if (recent) (w.buy3 += tr.sol), (buy3 += tr.sol);
    } else {
      w.sell += tr.sol;
      if (recent) (w.sell3 += tr.sol), (sell3 += tr.sol);
    }
    by.set(tr.wallet, w);
  }
  const reasons: string[] = [];
  const wallets: string[] = [];
  let score = 0;
  // 1. proven wallets in and holding; proven wallets already out
  const holding: string[] = [];
  let leaving = 0;
  for (const [wallet, w] of by) {
    if (!isSmart(book[wallet])) continue;
    if (w.buy >= 0.1 && w.sell < w.buy * 0.5) holding.push(wallet);
    else if (w.sell >= w.buy * 0.5 && w.sell > 0) leaving++;
  }
  if (holding.length) {
    score += Math.min(60, holding.length * 35);
    const wins = holding.reduce((a, w) => a + book[w].hits, 0);
    reasons.push(`${holding.length} proven wallet${holding.length > 1 ? 's' : ''} buying (${wins} earlier coins sold at ${SMART_MULT}×+)`);
    wallets.push(...holding);
  }
  // 2. quiet accumulation: several 1 SOL+ buyers in 3 minutes, none selling
  const whales = [...by].filter(([, w]) => w.buy3 >= 1 && w.sell3 < w.buy3 * 0.1);
  const whaleSol = whales.reduce((a, [, w]) => a + w.buy3, 0);
  if (whales.length >= 5 && whaleSol >= 8) score += 45;
  else if (whales.length >= 3 && whaleSol >= 4) score += 30;
  if (whales.length >= 3 && whaleSol >= 4) {
    reasons.push(`${whales.length} wallets bought ${whaleSol.toFixed(1)} SOL in 3 min and sold nothing`);
    for (const [w] of whales) if (!wallets.includes(w)) wallets.push(w);
  }
  const strong = holding.length > 0 || (whales.length >= 3 && whaleSol >= 4);
  // 3. the buying one-sided
  if (strong && buy3 + sell3 > 0 && buy3 / (buy3 + sell3) >= 0.8) {
    score += 10;
    reasons.push(`${Math.round((buy3 / (buy3 + sell3)) * 100)}% of the last 3 min is buying`);
  }
  // 4. before the crowd: few wallets, big sizes
  if (strong && by.size < 25) {
    score += 10;
    reasons.push(`only ${by.size} wallets so far — before the crowd`);
  }
  // 5. the creator adding to the bag, not selling it
  if (devAdded && !devActivity(tok).sold) {
    score += 10;
    reasons.push('creator bought more after launch');
  }
  if (leaving) {
    score -= 30 * leaving;
    reasons.push(`${leaving} proven wallet${leaving > 1 ? 's' : ''} already selling`);
  }
  return { score: Math.round(clamp(score, 0, 100)), reasons, wallets: wallets.slice(0, 12) };
}

/** Of the wallets a trade followed in, how many have since sold at least half of what they bought. */
export function insidersOut(tok: MemeToken, wallets: string[], since: number): number {
  const want = new Set(wallets);
  const by = new Map<string, { buy: number; sell: number; soldAfter: boolean }>();
  for (const tr of tok.trades) {
    if (!want.has(tr.wallet)) continue;
    const w = by.get(tr.wallet) ?? { buy: 0, sell: 0, soldAfter: false };
    if (tr.side === 'buy') w.buy += tr.sol;
    else {
      w.sell += tr.sol;
      if (tr.t >= since) w.soldAfter = true;
    }
    by.set(tr.wallet, w);
  }
  let n = 0;
  for (const w of by.values()) if (w.soldAfter && w.sell >= w.buy * 0.5) n++;
  return n;
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
  /** the insider lane: insider score that buys on its own, without waiting for heat and virality (0 = off) */
  insiderMin: number;
  /** insider lane, on the curve: most the price may stand above its 5-minute average (insiders buying lift it) */
  insiderMaxExtension: number;
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
  insiderMin: 65,
  insiderMaxExtension: 2.5,
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
  /** the insider lane: the wallets it followed in (sold when they sell) */
  insiders?: string[];
}

/**
 * The insider lane: proven wallets or quiet big buyers are in early, so buy
 * before the heat and virality show — the same safety checks, the same 5× room,
 * a looser spike limit (their buying lifts the price), and out when they sell.
 */
function insiderEntry(tok: MemeToken, a: Assessment, ins: InsiderRead, cfg: StrategyConfig): Decision | null {
  if (!(cfg.insiderMin > 0) || ins.score < cfg.insiderMin || !ins.wallets.length) return null;
  if (a.ageSec > cfg.maxAgeMin * 60) return null;
  if (!Number.isFinite(a.mcapUsd) || a.mcapUsd <= 0 || a.mcapUsd > cfg.maxMcapUsd || cfg.targetMcapUsd / a.mcapUsd < cfg.minRoom) return null;
  const onCurve = tok.source === 'pump' && !tok.migrated;
  const now = tok.lastTradeAt || Date.now();
  if (onCurve) {
    const p = curveProgress(tok.vTokens);
    if (p < 0.03 || p > cfg.maxCurve) return null;
    const ext = extension5m(tok, now);
    if (ext !== null && ext > cfg.insiderMaxExtension) return null;
  } else if (!tok.dex || tok.dex.liquidityUsd < cfg.minLiquidityUsd) return null;
  const share = buyShare5m(tok, now);
  if (share !== null && share < 0.6) return null;
  const room = (cfg.targetMcapUsd / a.mcapUsd).toFixed(0);
  return { enter: true, conviction: ins.score, insiders: ins.wallets, why: `INSIDER ${ins.score} · ${room}× room to $${Math.round(cfg.targetMcapUsd / 1000)}k — ${ins.reasons.slice(0, 3).join('; ')}; out when they sell` };
}

export function strategist(tok: MemeToken, a: Assessment, v: Viability, x: Virality, cfg: StrategyConfig, ins?: InsiderRead): Decision {
  const conviction = Math.round(0.4 * a.heat + 0.35 * x.score + 0.25 * v.score);
  const skip = (why: string): Decision => ({ enter: false, conviction, why });
  if (v.verdict !== 'pass') return skip(v.verdict === 'reject' ? `rejected: ${v.reasons[0]}` : `watching: ${v.reasons[0] ?? 'checks pending'}`);
  // insiders in early: the same safety, without waiting for the crowd
  const inside = ins ? insiderEntry(tok, a, ins, cfg) : null;
  if (inside) return inside;
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

// Reading a meme coin: how hot the buying is (heat 0–100), what could go wrong
// (flags), what it is doing (tags), and a one-line summary in plain words.
//
// Heat measures what early runners have in common — strong net buying, many
// different wallets, buys outnumbering sells, the curve filling fast, volume
// surging on a pool. It says nothing certain about where price goes next:
// most new coins fail, and the flags are there to rule out the worst of them.
import { curveProgress } from './pump';
import { devActivity, flow, multipleSinceFirst, progressGain, stageOf, toGraduate, type MemeToken } from './token';

export interface Flag {
  level: 'danger' | 'warn' | 'info';
  text: string;
}

export interface Assessment {
  heat: number;
  flags: Flag[];
  tags: string[];
  summary: string;
  /** market cap in USD (NaN without a SOL price or pool data) */
  mcapUsd: number;
  ageSec: number;
}

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const log = (x: number, full: number) => clamp(Math.log10(1 + Math.max(0, x)) / Math.log10(1 + full));

export function assess(tok: MemeToken, now: number, solUsd: number): Assessment {
  const flags: Flag[] = [];
  const tags: string[] = [];
  const parts: string[] = [];
  const created = tok.dex?.pairCreatedAt && tok.source === 'dex' ? tok.dex.pairCreatedAt : tok.createdAt;
  const ageSec = Math.max(0, (now - created) / 1000);
  const mcapUsd = tok.dex && tok.dex.mcapUsd > 0 && (tok.source === 'dex' || tok.migrated) ? tok.dex.mcapUsd : solUsd > 0 ? tok.mcapSol * solUsd : NaN;
  let heat = 0;

  const recent = tok.trades.length > 0 && now - tok.lastTradeAt < 120_000;
  if (tok.dex && (tok.source === 'dex' || (tok.migrated && !recent))) {
    // a pool: DexScreener's windows
    const d = tok.dex;
    const surge = (d.volume.m5 * 12) / Math.max(d.volume.h1, 1);
    const t5 = d.txns.m5.buys + d.txns.m5.sells;
    const buyShare = t5 ? d.txns.m5.buys / t5 : 0.5;
    heat += clamp((surge - 0.5) / 1.5) * 25;
    heat += clamp((buyShare - 0.5) / 0.25) * 15;
    heat += clamp(d.change.m5 / 20) * 15 + clamp(d.change.h1 / 100) * 10;
    heat += log(t5, 150) * 15;
    heat += clamp(d.mcapUsd > 0 ? d.liquidityUsd / d.mcapUsd / 0.08 : 0) * 10;
    if (d.socials.length) heat += 10;
    if (surge >= 2) tags.push('Volume surge');
    if (d.boosts > 0) tags.push('Boosted');
    if (d.liquidityUsd < 5_000) flags.push({ level: 'danger', text: 'Very thin liquidity — a small sell moves the price a lot' });
    if (!d.socials.length) flags.push({ level: 'info', text: 'No website or socials listed' });
    parts.push(`${t5} trades in 5 min (${pct(buyShare)} buys)`, `volume ${surge.toFixed(1)}× its hourly pace`, `${d.change.m5 >= 0 ? '+' : ''}${d.change.m5.toFixed(0)}% in 5 min`);
  } else {
    // the bonding curve (or a migrated coin's live trades)
    const f5 = flow(tok, now, 300);
    const f1 = flow(tok, now, 60);
    const gain = progressGain(tok, now, 300);
    heat += log(f5.netSol, 20) * 25;
    heat += log(f5.buyers, 60) * 20;
    if (f1.buys + f1.sells >= 3) heat += clamp((f1.buys / (f1.buys + f1.sells) - 0.5) / 0.3) * 15;
    if (!tok.migrated) heat += clamp(gain / 0.15) * 15;
    if (f5.buys >= 3) heat += (1 - f5.topBuyerShare) * 10;
    heat += 15 * clamp(f5.buys / 30);
    const quiet = now - tok.lastTradeAt;
    if (quiet > 300_000) heat *= 0.1;
    else if (quiet > 60_000) heat *= 0.5;
    if (f5.buys >= 5 && f5.topBuyerShare > 0.5) {
      heat -= 10;
      flags.push({ level: 'warn', text: `One wallet is ${pct(f5.topBuyerShare)} of the buying` });
    }
    if (f5.churners >= 3 && f5.churners / Math.max(1, f5.buyers) > 0.4) {
      heat -= 10;
      flags.push({ level: 'warn', text: `${f5.churners} wallets bought and sold within minutes — bots or wash trading` });
    }
    if (quiet > 300_000 && tok.trades.length) flags.push({ level: 'info', text: 'Gone quiet — no trades for 5 minutes' });
    if (!tok.migrated && gain >= 0.1) tags.push('Graduating');
    if (f5.netSol >= 10) tags.push('Volume surge');
    parts.push(`${f5.buyers} wallets bought in 5 min`, `${f5.netSol >= 0 ? '+' : ''}${f5.netSol.toFixed(1)} SOL net`);
    if (!tok.migrated) parts.push(`curve ${pct(curveProgress(tok.vTokens))}`);
  }

  // the creator
  if (tok.source === 'pump') {
    const dev = devActivity(tok);
    if (dev.sold && (dev.soldShare ?? 0) >= 0.9) {
      heat *= 0.3;
      flags.push({ level: 'danger', text: 'The creator sold their whole launch bag' });
    } else if (dev.sold) {
      heat *= 0.7;
      flags.push({ level: 'warn', text: `The creator sold ${dev.soldShare !== null ? pct(dev.soldShare) : 'some'} of their launch bag` });
    } else if (tok.trades.length) parts.push('creator still holding');
    if (tok.devInitialSol >= 3) flags.push({ level: 'warn', text: `The creator bought ${tok.devInitialSol.toFixed(1)} SOL at launch — a big bag to sell into you` });
  }

  // on-chain checks
  const s = tok.safety;
  if (s) {
    if (s.mintRevoked === false) flags.push({ level: 'danger', text: 'Mint authority not revoked — more tokens can be printed' });
    if (s.freezeRevoked === false) flags.push({ level: 'danger', text: 'Freeze authority not revoked — your tokens could be frozen (honeypot risk)' });
    if (s.top10 !== null && s.top10 > 0.5) flags.push({ level: 'danger', text: `Top 10 wallets hold ${pct(s.top10)} of the supply` });
    else if (s.top10 !== null && s.top10 > 0.3) flags.push({ level: 'warn', text: `Top 10 wallets hold ${pct(s.top10)} of the supply` });
    if (s.top1 !== null && s.top1 > 0.15) flags.push({ level: 'warn', text: `One wallet holds ${pct(s.top1)} of the supply` });
  }

  if (ageSec < 60) flags.push({ level: 'info', text: 'Just launched — too early to judge' });
  heat = Math.round(clamp(heat, 0, 100));
  const danger = flags.some((f) => f.level === 'danger');
  if (ageSec < 300) tags.unshift('Fresh');
  if (heat >= 60 && ageSec < 20 * 60 && !danger) tags.unshift('Early runner');
  const stage = stageOf(tok);
  const toGrad = toGraduate(tok);
  if (stage !== 'migrated' && toGrad !== null && Number.isFinite(toGrad)) parts.push(`${toGrad.toFixed(1)}× to graduate`);
  const sinceFirst = multipleSinceFirst(tok);
  if (sinceFirst >= 1.5) parts.push(`${sinceFirst.toFixed(1)}× since spotted`);

  return { heat, flags: flags.sort((a, b) => rank(a) - rank(b)), tags, summary: parts.join(' · '), mcapUsd, ageSec };
}

const rank = (f: Flag) => (f.level === 'danger' ? 0 : f.level === 'warn' ? 1 : 2);

/** How many times the market cap could grow before reaching `targetUsd` (the user's own target). */
export const roomTo = (mcapUsd: number, targetUsd: number) => (mcapUsd > 0 && targetUsd > 0 ? targetUsd / mcapUsd : NaN);

// The crypto swarm's brain: what it knows about a candidate trade (features),
// what the statistics expect of it (the decision forest, starting from a prior
// drawn from the research), and the council that decides.
//
// Strategy agents propose; the others vote:
//
//   Auctioneer   intraday auction market theory: value area, initial-balance
//                breakouts, the 80 % rule back into prior value (Steidlmayer;
//                Dalton) — intraday momentum and reversal are both documented
//                in crypto (Wen, Bouri, Xu & Zhao 2022).
//   Trend        time-series momentum: the 20/60/120-day trend votes, entries on
//                hourly Donchian breakouts with ATR stops (Moskowitz, Ooi &
//                Pedersen 2012; Liu & Tsyvinski 2021; Hurst, Ooi & Pedersen 2017).
//   Lab          the strategies deployed from the Strategy Lab (they took over
//                the retired Scalper's job).
//   Tape         reads the last seconds of aggressive flow and the book.
//   Crowd        funding on Hyperliquid: when one side pays a lot to hold, it is
//                crowded (He, Manela, Ross & von Wachter 2022 on perpetuals).
//   Guardian     market conditions: a wide spread or a volatility spike is a veto.
//   Forest       the statistics, learned from every paper, live and shadow trade.
//   Risk         the compounding risk manager (risk.mjs): a gate is a veto.
import { microVote } from './micro.mjs';
import { Forest } from '../../src/cswarm/forest.ts';

export const PROPOSERS = ['auction', 'trend', 'lab'];
/** each proposer's number as the forest reads it — fixed for good (the retired Scalper keeps 0), so what the forest learned keeps its meaning */
export const AGENT_INDEX = { scalper: 0, auction: 1, trend: 2, lab: 3 };
export const COUNCIL = ['auction', 'trend', 'tape', 'micro', 'crowd', 'guardian', 'forest', 'risk'];
export const AGENT_NAME = { scalper: 'Scalper', auction: 'Auctioneer', trend: 'Trend', lab: 'Lab', tape: 'Tape', micro: 'Micro', crowd: 'Crowd', guardian: 'Guardian', forest: 'Forest', risk: 'Risk' };
const COINS = ['BTC', 'ETH', 'SOL'];

export const dirOf = (side) => (side === 'buy' ? 1 : -1);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** The numbers a decision is taken on (and the forest learns from). */
export const CFEATURES = ['agent', 'side', 'rr', 'stopBps', 'trendAlign', 'trendUp', 'flowAligned', 'bookAligned', 'spreadBps', 'volBps', 'fundingPaid', 'hourUTC', 'vaPos', 'agentWin', 'coin'];

/**
 * @param c candidate { agent, coin, side, price, stop, target, t, ctx: { daily, flow, book, funding, volBps, va, agentWin } }
 */
export function features(c) {
  const dir = dirOf(c.side);
  const risk = Math.abs(c.price - c.stop);
  const reward = Math.abs(c.target - c.price);
  const x = c.ctx ?? {};
  const va = x.va && x.va.vah > x.va.val ? ((c.price - x.va.poc) / (x.va.vah - x.va.val)) * dir : 0;
  return [
    AGENT_INDEX[c.agent] ?? -1,
    dir,
    risk > 0 ? reward / risk : 0,
    c.price > 0 ? (risk / c.price) * 1e4 : 0,
    x.daily ? x.daily.dir * dir : 0,
    x.daily ? x.daily.up : 1.5,
    x.flow ? clamp(x.flow.deltaRatio * dir, -1, 1) : 0,
    x.book ? clamp(x.book.imbalance * dir, -1, 1) : 0,
    x.book?.spreadBps ?? 2,
    x.volBps ?? 10,
    Number.isFinite(x.funding) ? x.funding * dir * 1e4 : 0,
    new Date(c.t).getUTCHours(),
    clamp(va, -3, 3),
    x.agentWin ?? 0.5,
    COINS.includes(c.coin) ? COINS.indexOf(c.coin) : 3,
  ];
}

// ---------- outcomes in R (one R = what the trade risked) ----------

export const RCLASSES = ['loss', 'scratch', 'win', 'big win'];
/** what a class pays in R, roughly: a stop, a scratch, a 0.5–2R win, a 2R+ run */
export const PAYOFF_R = [-1, 0, 1.1, 2.6];
export function rClass(r) {
  if (r <= -0.5) return 0;
  if (r < 0.5) return 1;
  if (r < 2) return 2;
  return 3;
}

/**
 * The prior: before the swarm has its own record, a starting guess shaped by
 * the research — trend-followers win less often but bigger; trades with the
 * daily trend and with the tape do better than against them. A guess, not a
 * finding: the learned forest replaces it as trades close.
 */
export function priorR(x) {
  const [agent, , rr, , trendAlign, , flowAligned] = x;
  let p = agent === 2 ? [0.5, 0.1, 0.22, 0.18] : agent === 1 ? [0.4, 0.18, 0.3, 0.12] : [0.42, 0.22, 0.28, 0.08];
  const shift = (from, to, k) => {
    const m = Math.min(k, p[from]);
    p = p.map((v, i) => (i === from ? v - m : i === to ? v + m : v));
  };
  if (trendAlign > 0) shift(0, 2, 0.05);
  if (trendAlign < 0) shift(2, 0, 0.08);
  if (flowAligned >= 0.2) shift(0, 2, 0.04);
  if (flowAligned <= -0.25) shift(2, 0, 0.06);
  // a target under 1.5R rarely becomes a big win
  if (rr < 1.5) shift(3, 2, 0.05);
  if (rr >= 3) shift(2, 3, 0.04);
  return p;
}

/** how many closed trades it takes for the learned forest to count as much as the prior */
export const PRIOR_WEIGHT_R = 40;

/**
 * The odds of a candidate: probabilities of loss / scratch / win / big win,
 * and the expected result in R after costs (round-trip costs in bps over the
 * stop distance in bps).
 */
export function oddsR(x, forest, costBps = 11) {
  const prior = priorR(x);
  const trust = forest && forest.size ? forest.stats.n / (forest.stats.n + PRIOR_WEIGHT_R) : 0;
  const learned = forest && forest.size ? forest.predict(x) : prior;
  const probs = prior.map((p, j) => (1 - trust) * p + trust * learned[j]);
  const stopBps = x[3] > 0 ? x[3] : 30;
  const costR = costBps / stopBps;
  const expR = probs.reduce((a, p, j) => a + p * PAYOFF_R[j], 0) - costR;
  return { probs, pWin: probs[2] + probs[3], pLoss: probs[0], expR, costR, trust };
}

export async function trainForest(samples, now = Date.now()) {
  return Forest.train(samples.map((s) => ({ x: s.x, y: s.y })), undefined, now, 5);
}

// ---------- the council ----------

export const CCOUNCIL_DEFAULTS = {
  /** weighted votes for minus against needed to trade */
  minScore: 2,
  /** the forest's trust from which its veto counts, and the expected R under which it vetoes */
  forestVetoTrust: 0.3,
  forestVetoR: -0.05,
  /** Tape: aggressive flow this far with the trade is a vote for, this far against a vote against */
  tapeFor: 0.15,
  tapeAgainst: -0.25,
  /** Crowd: our side paying more than this in funding (bps an hour) is crowded */
  crowdedBpsH: 0.5,
  /** Guardian: no trade with the spread wider than this, or 1-minute volatility above this */
  maxSpreadBps: 8,
  maxVolBps: 80,
};

const pct = (v) => `${Math.round(v * 100)}%`;
const r2 = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;

/**
 * @param inp { cand, x, odds, riskGate: string|null, sizeNote: string }
 * @returns {{ trade: boolean, score: number, votes: {bot, stance, weight, why}[], summary: string }}
 */
export function councilR(inp, cfg = CCOUNCIL_DEFAULTS) {
  const { cand: c, odds: o } = inp;
  const x = c.ctx ?? {};
  const dir = dirOf(c.side);
  const votes = [];
  const side = c.side === 'buy' ? 'long' : 'short';
  // the proposer
  votes.push({ bot: c.agent, stance: 'for', weight: 1.5, why: `${side} ${c.coin} — ${c.setup}: ${c.why}` });
  // the daily trend (the Trend agent speaks for it unless it proposed)
  if (c.agent !== 'trend') {
    if (!x.daily) votes.push({ bot: 'trend', stance: 'abstain', weight: 0, why: 'no daily history yet' });
    else if (x.daily.dir === dir) votes.push({ bot: 'trend', stance: 'for', weight: 1, why: `with the daily trend (${x.daily.dir > 0 ? x.daily.up : 3 - x.daily.up}/3 lookbacks ${x.daily.dir > 0 ? 'up' : 'down'})` });
    else votes.push({ bot: 'trend', stance: 'against', weight: 1, why: `against the daily trend (${x.daily.dir > 0 ? `${x.daily.up}/3 up` : `${3 - x.daily.up}/3 down`})` });
  }
  // the tape
  const flow = x.flow ? x.flow.deltaRatio * dir : null;
  const bookTxt = x.book ? `, book ${x.book.imbalance * dir >= 0 ? 'behind it' : 'leaning against it'} (${(x.book.imbalance * dir).toFixed(2)})` : '';
  if (flow === null) votes.push({ bot: 'tape', stance: 'abstain', weight: 0, why: 'no flow read yet' });
  else if (flow >= cfg.tapeFor) votes.push({ bot: 'tape', stance: 'for', weight: 1, why: `aggressive flow with it (delta ${flow.toFixed(2)})${bookTxt}` });
  else if (flow <= cfg.tapeAgainst) votes.push({ bot: 'tape', stance: 'against', weight: 1, why: `aggressive flow against it (delta ${flow.toFixed(2)})${bookTxt}` });
  else votes.push({ bot: 'tape', stance: 'abstain', weight: 0, why: `flow mixed (delta ${flow.toFixed(2)})${bookTxt}` });
  // the microstructure: the last seconds of the book, the tape and the forced orders — on timing only
  votes.push({ bot: 'micro', ...microVote(x.micro, dir) });
  // the crowd
  if (!Number.isFinite(x.funding)) votes.push({ bot: 'crowd', stance: 'abstain', weight: 0, why: 'no funding read' });
  else {
    const paid = x.funding * dir * 1e4;
    const apr = Math.abs(x.funding) * 24 * 365 * 100;
    if (paid > cfg.crowdedBpsH) votes.push({ bot: 'crowd', stance: 'against', weight: 1, why: `crowded: ${side}s pay ${apr.toFixed(0)}% a year in funding` });
    else if (paid < -cfg.crowdedBpsH * 0.6) votes.push({ bot: 'crowd', stance: 'for', weight: 0.5, why: `the other side is crowded (it pays ${apr.toFixed(0)}% a year) — we are paid to hold` });
    else votes.push({ bot: 'crowd', stance: 'abstain', weight: 0, why: `funding neutral (${apr.toFixed(0)}% a year)` });
  }
  // the guardian
  if (x.book && x.book.spreadBps > cfg.maxSpreadBps) votes.push({ bot: 'guardian', stance: 'veto', weight: 0, why: `spread ${x.book.spreadBps.toFixed(1)} bps — too thin to trade` });
  else if (Number.isFinite(x.volBps) && x.volBps > cfg.maxVolBps) votes.push({ bot: 'guardian', stance: 'veto', weight: 0, why: `1-minute moves of ${x.volBps.toFixed(0)} bps — a volatility spike, stops would not hold` });
  // the guardian only clears or vetoes: it never adds weight to a trade
  else votes.push({ bot: 'guardian', stance: 'for', weight: 0, why: `conditions fine${x.book ? ` (spread ${x.book.spreadBps.toFixed(1)} bps)` : ''}` });
  // the forest
  const oddsTxt = `P(win) ${pct(o.pWin)} · P(loss) ${pct(o.pLoss)} · expects ${r2(o.expR)} after costs · trust ${pct(o.trust)}`;
  const learning = o.trust < 0.15 ? ' (mostly the prior: still learning)' : '';
  if (o.expR < cfg.forestVetoR && o.trust >= cfg.forestVetoTrust) votes.push({ bot: 'forest', stance: 'veto', weight: 0, why: `${oddsTxt} — the numbers say no` });
  else if (o.expR < 0) votes.push({ bot: 'forest', stance: 'against', weight: 0.5 + o.trust, why: `${oddsTxt}${learning}` });
  else if (o.expR >= 0.15) votes.push({ bot: 'forest', stance: 'for', weight: 0.5 + o.trust, why: `${oddsTxt}${learning}` });
  else votes.push({ bot: 'forest', stance: 'abstain', weight: 0, why: `${oddsTxt} — on the fence` });
  // the risk manager
  votes.push(inp.riskGate ? { bot: 'risk', stance: 'veto', weight: 0, why: inp.riskGate } : { bot: 'risk', stance: 'for', weight: 1, why: inp.sizeNote });

  const score = votes.reduce((a, v) => a + (v.stance === 'for' ? v.weight : v.stance === 'against' ? -v.weight : 0), 0);
  const fors = votes.filter((v) => v.stance === 'for').length;
  const against = votes.filter((v) => v.stance === 'against').length;
  // a strategy deployed "as tested": its statistics were proven on years of data the opinion bots were not part of,
  // so their votes are advice (recorded, never binding); only the safety bots — Guardian and Risk — can stop it
  if (c.authority === 'tested') {
    const hard = votes.find((v) => v.stance === 'veto' && SAFETY.includes(v.bot));
    for (const v of votes) if (v.stance === 'veto' && !SAFETY.includes(v.bot)) v.stance = 'against';
    const advice = votes.filter((v) => v.stance === 'against').length;
    const timing = votes.find((v) => v.bot === 'micro' && v.stance === 'against') ? ' · Micro times the entry' : '';
    const summary = hard ? `vetoed by ${AGENT_NAME[hard.bot]} (safety)` : `TRADE — a tested strategy: only Guardian and Risk can stop it (the council advises ${fors} for, ${advice} against, score ${score.toFixed(1)})${timing}`;
    return { trade: !hard, score, votes, summary, advisory: true };
  }
  const veto = votes.find((v) => v.stance === 'veto');
  const trade = !veto && score >= cfg.minScore - 1e-9;
  const summary = veto ? `vetoed by ${AGENT_NAME[veto.bot]}` : trade ? `TRADE — ${fors} for, ${against} against (score ${score.toFixed(1)})` : `no — ${fors} for, ${against} against (score ${score.toFixed(1)}, needs ${cfg.minScore})`;
  return { trade, score, votes, summary };
}

export const MARK = { for: '✓', against: '✗', abstain: '–', veto: '⛔' };

/** the bots that keep the account safe: they can stop any trade, a tested strategy's included */
export const SAFETY = ['guardian', 'risk'];

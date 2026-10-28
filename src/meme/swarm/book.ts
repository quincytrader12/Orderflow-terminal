// The Manager: the swarm's positions, on paper first. Fills are priced as a
// real swap would be — exactly on the bonding curve (fee and price impact
// included), or against the pool's price with an impact estimate from its
// liquidity — so paper results are not flattered.
//
// Exits, in the order they are checked (meme coins move in minutes, and most
// die on day one, so profits are taken early and losers cut fast):
//  1. rug: the creator dumps, a danger flag appears, or trading stops
//  2. stop loss: price down `stopLoss` from what was paid
//  3. take profits: sell a share at each price multiple (default half at 2×
//     — the cost is back — and half the rest at 5×)
//  4. trailing: once the price is up `trailFrom`×, give back at most `trail`
//     from its peak (on the price, so it still guards the bag left after
//     profits were taken)
//  5. time: no new high for `staleMin` minutes while under `staleBelow`×
// Multiples are the price against the price paid (fee and impact included).
import { curveBuyTokens, curveSellSol, PUMP_FEE } from '../pump';
import { devActivity, type MemeToken } from '../token';

export interface ManagerConfig {
  /** SOL per trade */
  sizeSol: number;
  maxOpen: number;
  /** take profit: sell `sell` of what is left when the value reaches `at`× cost */
  takeProfits: { at: number; sell: number }[];
  stopLoss: number;
  trailFrom: number;
  trail: number;
  staleMin: number;
  staleBelow: number;
  /** stop opening new trades for the day after losing this much SOL */
  dailyLossSol: number;
}

export const MANAGER_DEFAULTS: ManagerConfig = {
  sizeSol: 0.1,
  maxOpen: 4,
  takeProfits: [
    { at: 2, sell: 0.5 },
    { at: 5, sell: 0.5 },
  ],
  stopLoss: 0.35,
  trailFrom: 1.5,
  trail: 0.4,
  staleMin: 20,
  staleBelow: 1.3,
  dailyLossSol: 0.5,
};

export interface Fill {
  t: number;
  side: 'buy' | 'sell';
  sol: number;
  tokens: number;
  mult: number;
  why: string;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  openedAt: number;
  costSol: number;
  /** SOL paid per token, fee and impact included */
  entryPx: number;
  tokens: number;
  /** tokens still held */
  left: number;
  /** SOL taken out so far */
  realizedSol: number;
  peakMult: number;
  peakAt: number;
  tpDone: number;
  fills: Fill[];
  why: string;
  conviction: number;
  closedAt?: number;
  closeReason?: string;
}

const POOL_FEE = 0.0025;

/** SOL per token now (mark price), or NaN. */
export function markPrice(tok: MemeToken, solUsd: number): number {
  if (tok.source === 'pump' && !tok.migrated && tok.vTokens > 0) return tok.vSol / tok.vTokens;
  if (tok.dex && tok.dex.priceUsd > 0 && solUsd > 0) return tok.dex.priceUsd / solUsd;
  if (tok.trades.length && tok.mcapSol > 0) return tok.mcapSol / 1e9;
  return NaN;
}

/** Pool price impact for a trade of `sol` SOL (constant product, half the liquidity each side). */
function poolImpact(tok: MemeToken, sol: number, solUsd: number) {
  const sideSol = tok.dex && solUsd > 0 ? tok.dex.liquidityUsd / 2 / solUsd : 0;
  return sideSol > 0 ? sol / (sideSol + sol) : 0.05;
}

/** Tokens a buy of `sol` gets now. */
export function quoteBuy(tok: MemeToken, sol: number, solUsd: number): number {
  if (tok.source === 'pump' && !tok.migrated && tok.vTokens > 0) return curveBuyTokens(tok.vSol, tok.vTokens, sol);
  const px = markPrice(tok, solUsd);
  return px > 0 ? (sol * (1 - POOL_FEE) * (1 - poolImpact(tok, sol, solUsd))) / px : 0;
}

/** SOL a sell of `tokens` gets now. */
export function quoteSell(tok: MemeToken, tokens: number, solUsd: number): number {
  if (tokens <= 0) return 0;
  if (tok.source === 'pump' && !tok.migrated && tok.vTokens > 0) return curveSellSol(tok.vSol, tok.vTokens, tokens);
  const px = markPrice(tok, solUsd);
  if (!(px > 0)) return 0;
  const gross = tokens * px;
  return gross * (1 - POOL_FEE) * (1 - poolImpact(tok, gross, solUsd));
}

/** The price now as a multiple of the price paid. */
export function multiple(p: Position, tok: MemeToken, solUsd: number) {
  const px = markPrice(tok, solUsd);
  return p.entryPx > 0 && px > 0 ? px / p.entryPx : NaN;
}

export function openPosition(tok: MemeToken, sizeSol: number, now: number, solUsd: number, why: string, conviction: number): Position | null {
  const tokens = quoteBuy(tok, sizeSol, solUsd);
  if (!(tokens > 0)) return null;
  return {
    id: `${tok.mint}-${now}`,
    mint: tok.mint,
    symbol: tok.symbol,
    openedAt: now,
    costSol: sizeSol,
    entryPx: sizeSol / tokens,
    tokens,
    left: tokens,
    realizedSol: 0,
    peakMult: 1,
    peakAt: now,
    tpDone: 0,
    fills: [{ t: now, side: 'buy', sol: sizeSol, tokens, mult: 1, why }],
    why,
    conviction,
  };
}

function sell(p: Position, tok: MemeToken, share: number, now: number, solUsd: number, why: string, mult: number) {
  const tokens = share >= 1 ? p.left : p.left * share;
  const sol = quoteSell(tok, tokens, solUsd);
  p.left -= tokens;
  p.realizedSol += sol;
  p.fills.push({ t: now, side: 'sell', sol, tokens, mult, why });
  if (p.left <= p.tokens * 1e-6) {
    p.left = 0;
    p.closedAt = now;
    p.closeReason = why;
  }
}

/** Has the trade's reason gone: creator dumping, a danger flag, or trading stopped. */
export function rugReason(tok: MemeToken, now: number, dangers: string[]): string | null {
  const dev = devActivity(tok);
  if (tok.source === 'pump' && dev.sold && (dev.soldShare ?? 0) >= 0.5) return 'creator dumped — out';
  if (dangers.length) return `danger: ${dangers[0]} — out`;
  if (tok.trades.length && now - tok.lastTradeAt > 5 * 60_000 && !(tok.dex && (tok.migrated || tok.source === 'dex'))) return 'no trades for 5 min — out';
  return null;
}

/** Manage one open position; mutates it and returns the fills it made. */
export function managePosition(p: Position, tok: MemeToken, now: number, solUsd: number, cfg: ManagerConfig, dangers: string[]): Fill[] {
  if (p.closedAt) return [];
  const before = p.fills.length;
  const m = multiple(p, tok, solUsd);
  if (!Number.isFinite(m)) return [];
  if (m > p.peakMult) {
    p.peakMult = m;
    p.peakAt = now;
  }
  const rug = rugReason(tok, now, dangers);
  if (rug) sell(p, tok, 1, now, solUsd, rug, m);
  else if (m <= 1 - cfg.stopLoss) sell(p, tok, 1, now, solUsd, `stop loss at ${m.toFixed(2)}×`, m);
  else {
    while (p.tpDone < cfg.takeProfits.length && m >= cfg.takeProfits[p.tpDone].at && !p.closedAt) {
      const tp = cfg.takeProfits[p.tpDone];
      sell(p, tok, tp.sell, now, solUsd, `take profit at ${tp.at}× (sold ${Math.round(tp.sell * 100)}% of what was left)`, m);
      p.tpDone++;
    }
    if (!p.closedAt && p.peakMult >= cfg.trailFrom && m <= p.peakMult * (1 - cfg.trail)) sell(p, tok, 1, now, solUsd, `trailing stop: ${m.toFixed(2)}× after a ${p.peakMult.toFixed(2)}× peak`, m);
    else if (!p.closedAt && now - p.peakAt >= cfg.staleMin * 60_000 && m < cfg.staleBelow) sell(p, tok, 1, now, solUsd, `no new high for ${cfg.staleMin} min at ${m.toFixed(2)}× — out`, m);
  }
  return p.fills.slice(before);
}

/** Profit in SOL of a closed position (or so far, at mark, for an open one). */
export function pnlSol(p: Position, tok: MemeToken | undefined, solUsd: number) {
  const px = tok ? markPrice(tok, solUsd) : NaN;
  return p.realizedSol + (p.left > 0 && px > 0 ? p.left * px : 0) - p.costSol;
}

export { PUMP_FEE };

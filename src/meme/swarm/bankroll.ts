// Sizing the swarm to the SOL actually in its wallet, built to keep a small
// account alive long enough to catch the big runners:
//  - a trade is about a fifth of the account, and at most about two thirds of
//    it is ever in coins at once — even if every open coin rugs together, a
//    third is left to trade on;
//  - trades follow the account: sizes are a share of what the account is worth
//    now, so they shrink after losses and grow after wins (the wallet's
//    per-trade cap is set at twice today's size to leave room to compound);
//  - stop for the day after losing a quarter of the account; stop buying for
//    good below half of what it started with (the floor), until you decide;
//    pause for an hour after three losses in a row;
//  - a little kept back for fees, each new coin locking ~0.002 SOL of
//    token-account rent until it is sold and closed, and priority fees small
//    next to the trade.
import type { Position } from './book';

/** rent locked in each coin's token account while it is held */
export const RENT_PER_COIN = 0.0021;
/** below this a trade's fees and rent eat too much of it */
export const MIN_TRADE_SOL = 0.03;
/** above this a single buy moves a fresh pump.fun curve too much */
export const MAX_TRADE_SOL = 1;
/** a trade is this share of the account */
export const TRADE_SHARE = 0.2;
/** at most this share of the account in coins at once */
export const MAX_DEPLOYED = 0.65;
/** stop buying below this share of the starting account */
export const FLOOR_SHARE = 0.5;
/** stop for the day after losing this share of the account */
export const DAILY_LOSS_SHARE = 0.25;

export interface BankrollPlan {
  balanceSol: number;
  reserveSol: number;
  maxOpen: number;
  sizeSol: number;
  /** the share of the account each trade takes (sizes follow the account) */
  tradeShare: number;
  /** the wallet's hard cap per trade: twice today's size, room to compound */
  maxBuySol: number;
  dailySpendSol: number;
  dailyLossSol: number;
  /** below this the swarm stops buying */
  floorSol: number;
  priorityLamports: number;
  /** SOL the plan puts to work at most (positions + their rent) */
  deployedSol: number;
}

const floorTo = (x: number, step: number) => Math.floor(x / step + 1e-9) * step;
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** The size of one trade for an account worth `equitySol`. */
export function tradeSize(equitySol: number, share = TRADE_SHARE) {
  return round(Math.min(MAX_TRADE_SOL, floorTo(equitySol * share, 0.005)));
}

/** The swarm's settings for `balanceSol` in its wallet, or an error saying why it is too small. */
export function bankrollPlan(balanceSol: number): BankrollPlan | { error: string } {
  if (!(balanceSol > 0)) return { error: 'the swarm wallet is empty — send it some SOL from Phantom first' };
  const reserveSol = balanceSol < 0.5 ? 0.02 : 0.03;
  const tradable = balanceSol - reserveSol;
  if (tradable < MIN_TRADE_SOL + RENT_PER_COIN) return { error: `too small to trade: at least ${round(MIN_TRADE_SOL + RENT_PER_COIN + reserveSol, 2)} SOL is needed (fees and rent would eat a smaller trade)` };
  // what may be in coins at once; a tiny account still gets one trade
  const budget = Math.min(tradable, Math.max(balanceSol * MAX_DEPLOYED, MIN_TRADE_SOL + RENT_PER_COIN));
  const want = Math.max(MIN_TRADE_SOL, Math.min(MAX_TRADE_SOL, balanceSol * TRADE_SHARE));
  let maxOpen = balanceSol < 0.5 ? 3 : 4;
  while (maxOpen > 1 && maxOpen * (want + RENT_PER_COIN) > budget + 1e-9) maxOpen--;
  const sizeSol = round(Math.max(MIN_TRADE_SOL, floorTo(Math.min(want, budget / maxOpen - RENT_PER_COIN), 0.005)));
  return {
    balanceSol,
    reserveSol,
    maxOpen,
    sizeSol,
    tradeShare: TRADE_SHARE,
    maxBuySol: round(Math.min(MAX_TRADE_SOL, sizeSol * 2)),
    // about three rounds of positions a day, at sizes that may have grown
    dailySpendSol: round(3 * sizeSol * maxOpen, 2),
    dailyLossSol: round(Math.max(0.01, balanceSol * DAILY_LOSS_SHARE), 3),
    floorSol: round(balanceSol * FLOOR_SHARE, 3),
    // the most a trade pays to land fast: about 0.15 % of the trade, between 0.00005 and 0.0003 SOL
    priorityLamports: Math.round(Math.min(300_000, Math.max(50_000, sizeSol * 1e9 * 0.0015))),
    deployedSol: round(maxOpen * (sizeSol + RENT_PER_COIN), 4),
  };
}

export interface RiskRules {
  /** losing closes in a row that pause buying (0 = off) */
  lossStreak: number;
  /** how long the pause lasts, minutes */
  cooldownMin: number;
  /** stop buying when the account is worth less than this, SOL (0 = off) */
  floorSol: number;
}

/**
 * Why no new trade may open now, or null: the account is under its floor, or
 * the last `lossStreak` closes all lost and the pause has not run out.
 * `equitySol` is the account's worth now (null when not known: paper).
 */
export function riskGate(positions: Position[], now: number, r: RiskRules, equitySol: number | null): string | null {
  if (r.floorSol > 0 && equitySol !== null && equitySol < r.floorSol) return `the account (${equitySol.toFixed(3)} SOL) is under its floor of ${r.floorSol} SOL — buying stopped to keep it alive; open trades are still managed (Rules → Account floor)`;
  if (r.lossStreak > 0) {
    const closed = positions.filter((p) => p.closedAt).sort((a, b) => b.closedAt! - a.closedAt!);
    let streak = 0;
    for (const p of closed) {
      if (p.realizedSol >= p.costSol) break;
      streak++;
    }
    const left = closed.length ? closed[0].closedAt! + r.cooldownMin * 60_000 - now : 0;
    if (streak >= r.lossStreak && left > 0) return `${streak} losses in a row — pausing new trades for ${Math.ceil(left / 60_000)} more min`;
  }
  return null;
}

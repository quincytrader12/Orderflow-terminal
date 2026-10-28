// Sizing the swarm to the SOL actually in its wallet, so a small account can
// use all of it: a little kept back for fees, the rest split across a few
// positions (each new coin also locks ~0.002 SOL of token-account rent until it
// is sold and closed), a daily loss limit that is a share of the account rather
// than a fixed 0.5 SOL, and priority fees that stay small next to the trade.

/** rent locked in each coin's token account while it is held */
export const RENT_PER_COIN = 0.0021;
/** below this a trade's fees and rent eat too much of it */
export const MIN_TRADE_SOL = 0.03;
/** above this a single buy moves a fresh pump.fun curve too much */
export const MAX_TRADE_SOL = 1;

export interface BankrollPlan {
  balanceSol: number;
  reserveSol: number;
  maxOpen: number;
  sizeSol: number;
  dailySpendSol: number;
  dailyLossSol: number;
  priorityLamports: number;
  /** SOL the plan puts to work (positions + their rent) */
  deployedSol: number;
}

const floorTo = (x: number, step: number) => Math.floor(x / step + 1e-9) * step;
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** The swarm's settings for `balanceSol` in its wallet, or an error saying why it is too small. */
export function bankrollPlan(balanceSol: number): BankrollPlan | { error: string } {
  if (!(balanceSol > 0)) return { error: 'the swarm wallet is empty — send it some SOL from Phantom first' };
  const reserveSol = balanceSol < 0.5 ? 0.02 : 0.03;
  const tradable = balanceSol - reserveSol;
  if (tradable < MIN_TRADE_SOL + RENT_PER_COIN) return { error: `too small to trade: at least ${round(MIN_TRADE_SOL + RENT_PER_COIN + reserveSol, 2)} SOL is needed (fees and rent would eat a smaller trade)` };
  // as many positions as fit at a sensible size, at most four
  let maxOpen = 4;
  while (maxOpen > 1 && (tradable - RENT_PER_COIN * maxOpen) / maxOpen < MIN_TRADE_SOL) maxOpen--;
  const sizeSol = round(Math.min(MAX_TRADE_SOL, floorTo((tradable - RENT_PER_COIN * maxOpen) / maxOpen, 0.005)));
  return {
    balanceSol,
    reserveSol,
    maxOpen,
    sizeSol,
    // room to recycle the account about twice a day as positions close
    dailySpendSol: round(Math.max(sizeSol, 2 * sizeSol * maxOpen), 2),
    // stop for the day after losing a third of the account
    dailyLossSol: round(Math.max(0.01, balanceSol / 3), 2),
    // the most a trade pays to land fast: about 0.1 % of a small trade, never above 0.0003 SOL
    priorityLamports: Math.round(Math.min(300_000, Math.max(50_000, sizeSol * 1e9 * 0.0015))),
    deployedSol: round(maxOpen * (sizeSol + RENT_PER_COIN), 4),
  };
}

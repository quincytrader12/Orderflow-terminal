// pump.fun: the bonding-curve maths and the PumpPortal data feed's messages.
//
// Every pump.fun coin starts on a bonding curve (constant product, virtual
// reserves of 30 SOL × 1,073,000,000 tokens, 1,000,000,000 supply). 793.1 M
// tokens are sold on the curve; when they are gone the coin "graduates" and
// migrates to an AMM pool (PumpSwap). Launch is about 28 SOL of market cap and
// graduation about 411 SOL — roughly 14.7× along the curve — so where a coin
// sits on its curve says how much room the curve itself has left.

export const PUMP_SUPPLY = 1_000_000_000;
export const PUMP_V_TOKENS0 = 1_073_000_000;
export const PUMP_V_SOL0 = 30;
export const PUMP_CURVE_TOKENS = 793_100_000;
const K = PUMP_V_SOL0 * PUMP_V_TOKENS0;
/** virtual tokens left in the curve at graduation */
export const PUMP_V_TOKENS_END = PUMP_V_TOKENS0 - PUMP_CURVE_TOKENS;
/** market cap in SOL along the curve, from the virtual token reserve */
export const mcapSolAt = (vTokens: number) => ((K / vTokens / vTokens) * PUMP_SUPPLY);
export const PUMP_MCAP_SOL_START = mcapSolAt(PUMP_V_TOKENS0);
export const PUMP_MCAP_SOL_END = mcapSolAt(PUMP_V_TOKENS_END);

/** The curve's virtual token reserve at a market cap (inverse of mcapSolAt). */
export const vTokensAtMcap = (mcapSol: number) => (mcapSol > 0 ? Math.sqrt((K * PUMP_SUPPLY) / mcapSol) : PUMP_V_TOKENS0);

/** Share of the curve sold, 0…1. */
export function curveProgress(vTokensInBondingCurve: number): number {
  if (!(vTokensInBondingCurve > 0)) return 0;
  return Math.min(1, Math.max(0, (PUMP_V_TOKENS0 - vTokensInBondingCurve) / PUMP_CURVE_TOKENS));
}

/** How many times the market cap still has to grow for the coin to graduate (1 = there). */
export function multipleToGraduate(mcapSol: number): number {
  return mcapSol > 0 ? Math.max(1, PUMP_MCAP_SOL_END / mcapSol) : NaN;
}

export const PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data';

export interface PumpCreate {
  kind: 'create';
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  signature: string;
  /** the curve's account: its token holdings are the unsold supply, not a holder */
  bondingCurve: string;
  /** SOL the creator bought at launch */
  initialBuySol: number;
  /** tokens the creator bought at launch */
  initialBuyTokens: number;
  vTokens: number;
  vSol: number;
  mcapSol: number;
  pool: string;
  t: number;
}

export interface PumpTrade {
  kind: 'trade';
  mint: string;
  side: 'buy' | 'sell';
  wallet: string;
  sol: number;
  tokens: number;
  /** the wallet's token balance after the trade */
  balanceAfter: number | null;
  vTokens: number;
  vSol: number;
  mcapSol: number;
  pool: string;
  signature: string;
  t: number;
}

export interface PumpMigrate {
  kind: 'migrate';
  mint: string;
  pool: string;
  signature: string;
  t: number;
}

export type PumpEvent = PumpCreate | PumpTrade | PumpMigrate;

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);

/** One PumpPortal message → an event, or null (acknowledgements, errors, unknown kinds). */
export function parsePumpMessage(m: any, now = Date.now()): PumpEvent | null {
  if (!m || typeof m !== 'object' || typeof m.mint !== 'string') return null;
  const t = Number.isFinite(num(m.timestamp)) ? num(m.timestamp) : now;
  const pool = typeof m.pool === 'string' ? m.pool : 'pump';
  switch (m.txType) {
    case 'create':
      return {
        kind: 'create',
        mint: m.mint,
        name: String(m.name ?? ''),
        symbol: String(m.symbol ?? ''),
        uri: String(m.uri ?? ''),
        creator: String(m.traderPublicKey ?? ''),
        signature: String(m.signature ?? ''),
        bondingCurve: String(m.bondingCurveKey ?? ''),
        initialBuySol: num(m.solAmount) || 0,
        initialBuyTokens: num(m.initialBuy) || 0,
        vTokens: num(m.vTokensInBondingCurve),
        vSol: num(m.vSolInBondingCurve),
        mcapSol: num(m.marketCapSol),
        pool,
        t,
      };
    case 'buy':
    case 'sell':
      return {
        kind: 'trade',
        mint: m.mint,
        side: m.txType,
        wallet: String(m.traderPublicKey ?? ''),
        sol: num(m.solAmount) || 0,
        tokens: num(m.tokenAmount) || 0,
        balanceAfter: Number.isFinite(num(m.newTokenBalance)) ? num(m.newTokenBalance) : null,
        vTokens: num(m.vTokensInBondingCurve),
        vSol: num(m.vSolInBondingCurve),
        mcapSol: num(m.marketCapSol),
        pool,
        signature: String(m.signature ?? ''),
        t,
      };
    case 'migrate':
      return { kind: 'migrate', mint: m.mint, pool, signature: String(m.signature ?? ''), t };
    default:
      return null;
  }
}

/** Subscription messages (one socket for everything, as PumpPortal asks). */
export const pumpSub = {
  newTokens: () => JSON.stringify({ method: 'subscribeNewToken' }),
  migrations: () => JSON.stringify({ method: 'subscribeMigration' }),
  trades: (mints: string[]) => JSON.stringify({ method: 'subscribeTokenTrade', keys: mints }),
  untrades: (mints: string[]) => JSON.stringify({ method: 'unsubscribeTokenTrade', keys: mints }),
};

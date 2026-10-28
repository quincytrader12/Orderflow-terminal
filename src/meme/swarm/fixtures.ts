// Test coins for the swarm's tests: a pump.fun launch, trades on its curve, and
// a clean runner with broad, steady buying.
import { parsePumpMessage, type PumpCreate, type PumpTrade } from '../pump';
import { applyTrade, tokenFromCreate, type MemeToken } from '../token';

export const T0 = 1_800_000_000_000;
export const DEV = 'Dev1111111111111111111111111111111111111111';
let n = 0;

export function coin(over: Partial<Record<string, unknown>> = {}, t = T0): MemeToken {
  n++;
  const m = { signature: `c${n}`, mint: `Mint${n}`.padEnd(40, 'x') + 'pump', traderPublicKey: DEV, txType: 'create', initialBuy: 30_000_000, solAmount: 0.9, bondingCurveKey: 'Curve', vTokensInBondingCurve: 1_043_000_000, vSolInBondingCurve: 30.86, marketCapSol: 28.4, name: 'Frog Coin', symbol: 'FROG', uri: '', pool: 'pump', ...over };
  return tokenFromCreate(parsePumpMessage(m, t) as PumpCreate);
}

export function trade(tok: MemeToken, side: 'buy' | 'sell', wallet: string, sol: number, t: number, tokens?: number): PumpTrade {
  const k = tok.vSol * tok.vTokens;
  const vSol = tok.vSol + (side === 'buy' ? sol : -sol);
  const vTokens = k / vSol;
  return { kind: 'trade', mint: tok.mint, side, wallet, sol, tokens: tokens ?? Math.abs(tok.vTokens - vTokens), balanceAfter: null, vTokens, vSol, mcapSol: (vSol / vTokens) * 1e9, pool: 'pump', signature: `s${t}${wallet}`, t };
}

/** A coin with broad, steady buying for `min` minutes and clean on-chain checks. */
export function runner(min = 6, start = T0): { tok: MemeToken; now: number } {
  const tok = coin({}, start);
  let t = start + 20_000;
  let w = 0;
  const end = start + min * 60_000;
  while (t < end) {
    applyTrade(tok, trade(tok, 'buy', `W${w++}`, 0.12 + (w % 4) * 0.05, (t += 3_000)));
    if (w % 7 === 0) applyTrade(tok, trade(tok, 'sell', `S${w}`, 0.15, (t += 1_000)));
  }
  tok.safety = { checkedAt: t, mintRevoked: true, freezeRevoked: true, top10: 0.17, top1: 0.04 };
  return { tok, now: t + 1_000 };
}

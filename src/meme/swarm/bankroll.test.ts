import { describe, expect, it } from 'vitest';
import { bankrollPlan, RENT_PER_COIN, riskGate, tradeSize, type BankrollPlan } from './bankroll';
import type { Position } from './book';

const ok = (b: number) => bankrollPlan(b) as BankrollPlan;

describe('sizing the swarm to its wallet', () => {
  it('R480–R500 (about 0.28–0.30 SOL): three coins at a fifth each, a third never in coins, a floor at half', () => {
    const p = ok(0.28);
    expect(p).toMatchObject({ reserveSol: 0.02, maxOpen: 3, sizeSol: 0.055, tradeShare: 0.2, maxBuySol: 0.11, dailyLossSol: 0.07, floorSol: 0.14 });
    // even if every open coin went to zero, about a third of the account is left
    expect(0.28 - p.deployedSol).toBeGreaterThan(0.28 * 0.35);
    expect(ok(0.3)).toMatchObject({ maxOpen: 3, sizeSol: 0.06, floorSol: 0.15 });
    expect(p.priorityLamports).toBeLessThanOrEqual(300_000);
  });

  it('still trades if the SOL price means less SOL lands (R480 at a dearer SOL)', () => {
    expect(ok(0.16)).toMatchObject({ maxOpen: 3, sizeSol: 0.03 });
    expect(ok(0.12)).toMatchObject({ maxOpen: 2, sizeSol: 0.03 });
    expect(ok(0.06)).toMatchObject({ maxOpen: 1, sizeSol: 0.03 });
    expect(bankrollPlan(0.04)).toHaveProperty('error');
    expect(bankrollPlan(0)).toHaveProperty('error');
  });

  it('caps a single buy for big accounts', () => {
    const p = ok(10);
    expect(p.sizeSol).toBe(1);
    expect(p.maxOpen).toBe(4);
    expect(p.deployedSol).toBeCloseTo(4 * (1 + RENT_PER_COIN), 6);
  });

  it('trades follow the account: smaller after losses, bigger after wins', () => {
    expect(tradeSize(0.28)).toBe(0.055);
    expect(tradeSize(0.18)).toBe(0.035);
    expect(tradeSize(0.6)).toBe(0.12);
    expect(tradeSize(50)).toBe(1);
  });
});

describe('keeping the account alive', () => {
  const closed = (t: number, win: boolean) => ({ closedAt: t, costSol: 0.05, realizedSol: win ? 0.15 : 0.03 }) as Position;
  const rules = { lossStreak: 3, cooldownMin: 60, floorSol: 0.14 };
  const T = 1_800_000_000_000;

  it('stops buying under the floor', () => {
    expect(riskGate([], T, rules, 0.13)).toMatch(/^the account \(0\.130 SOL\) is under its floor of 0\.14 SOL — buying stopped/);
    expect(riskGate([], T, rules, 0.2)).toBeNull();
    expect(riskGate([], T, rules, null)).toBeNull();
    expect(riskGate([], T, { ...rules, floorSol: 0 }, 0.01)).toBeNull();
  });

  it('pauses for an hour after three losses in a row; a win in between resets it', () => {
    const three = [closed(T - 30 * 60_000, false), closed(T - 20 * 60_000, false), closed(T - 10 * 60_000, false)];
    expect(riskGate(three, T, rules, null)).toBe('3 losses in a row — pausing new trades for 50 more min');
    expect(riskGate(three, T + 51 * 60_000, rules, null)).toBeNull();
    expect(riskGate([three[0], closed(T - 15 * 60_000, true), three[2]], T, rules, null)).toBeNull();
    expect(riskGate(three, T, { ...rules, lossStreak: 0 }, null)).toBeNull();
  });
});

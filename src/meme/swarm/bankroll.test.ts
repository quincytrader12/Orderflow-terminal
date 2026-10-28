import { describe, expect, it } from 'vitest';
import { bankrollPlan, RENT_PER_COIN, type BankrollPlan } from './bankroll';

const ok = (b: number) => bankrollPlan(b) as BankrollPlan;

describe('sizing the swarm to its wallet', () => {
  it('puts about R500 (0.30 SOL) to work: four positions, a fee reserve, a loss limit a third of the account', () => {
    const p = ok(0.3);
    expect(p).toMatchObject({ reserveSol: 0.02, maxOpen: 4, sizeSol: 0.065, dailyLossSol: 0.1, dailySpendSol: 0.52 });
    expect(p.deployedSol + p.reserveSol).toBeLessThanOrEqual(0.3);
    expect(p.deployedSol + p.reserveSol).toBeGreaterThan(0.28);
    expect(p.priorityLamports).toBeLessThanOrEqual(300_000);
  });

  it('uses fewer positions as the account shrinks, and refuses one too small to trade', () => {
    expect(ok(0.12)).toMatchObject({ maxOpen: 3, sizeSol: 0.03 });
    expect(ok(0.06)).toMatchObject({ maxOpen: 1 });
    expect(bankrollPlan(0.04)).toHaveProperty('error');
    expect(bankrollPlan(0)).toHaveProperty('error');
  });

  it('caps a single buy for big accounts', () => {
    const p = ok(10);
    expect(p.sizeSol).toBe(1);
    expect(p.maxOpen).toBe(4);
    expect(p.deployedSol).toBeCloseTo(4 * (1 + RENT_PER_COIN), 6);
  });
});

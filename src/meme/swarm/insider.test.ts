import { describe, expect, it } from 'vitest';
import { assess } from '../score';
import { applyTrade, type MemeToken } from '../token';
import { insiderRead, insidersOut, isSmart, learnSmart, strategist, STRATEGY_DEFAULTS, type SmartBook } from './agents';
import { decideExit, MANAGER_DEFAULTS, openPosition } from './book';
import { coin, T0, trade } from './fixtures';

const pass = { verdict: 'pass', score: 70, reasons: [], early: { wallets: 0, share: 0 } } as Parameters<typeof strategist>[2];
const quiet = { score: 10, reasons: [], narrative: null } as Parameters<typeof strategist>[3];
const clean = (tok: MemeToken, t: number) => (tok.safety = { checkedAt: t, mintRevoked: true, freezeRevoked: true, top10: 0.2, top1: 0.05 });

/** A coin `wallet` buys early and sells at 3×+ (a hit), or at the same price (no hit). */
function round(wallet: string, win: boolean, start: number) {
  const tok = coin({}, start);
  let t = start + 10_000;
  applyTrade(tok, trade(tok, 'buy', wallet, 0.5, (t += 1_000)));
  if (win) for (let i = 0; i < 40; i++) applyTrade(tok, trade(tok, 'buy', `crowd${start}-${i}`, 2, (t += 2_000)));
  else for (let i = 0; i < 10; i++) applyTrade(tok, trade(tok, 'buy', `crowd${start}-${i}`, 0.01, (t += 2_000)));
  applyTrade(tok, trade(tok, 'sell', wallet, 0.5, (t += 1_000)));
  return { tok, t };
}

describe('Insider tracker — learning who wins', () => {
  it('a wallet that sold two coins at 3×+ is proven; one that broke even is not remembered', () => {
    const book: SmartBook = {};
    const done = new Set<string>();
    const a = round('Ace', true, T0);
    const b = round('Ace', true, T0 + 3_600_000);
    const c = round('Meh', false, T0);
    expect(learnSmart(book, [a.tok, c.tok], a.t, done)).toBe(1);
    expect(isSmart(book.Ace)).toBe(false);
    expect(learnSmart(book, [a.tok, b.tok, c.tok], b.t, done)).toBe(1);
    expect(book.Ace).toMatchObject({ hits: 2, tries: 2 });
    expect(isSmart(book.Ace)).toBe(true);
    expect(book.Meh).toBeUndefined();
    // counted once per coin
    expect(learnSmart(book, [a.tok, b.tok], b.t + 1, done)).toBe(0);
  });
});

describe('Insider tracker — reading a coin', () => {
  it('quiet accumulation: five wallets buying 2 SOL each in three minutes and selling nothing', () => {
    const tok = coin();
    let t = T0 + 30_000;
    for (let i = 0; i < 5; i++) applyTrade(tok, trade(tok, 'buy', `Whale${i}`, 2, (t += 20_000)));
    const r = insiderRead(tok, t + 1_000, {});
    expect(r.score).toBe(65);
    expect(r.wallets).toHaveLength(5);
    expect(r.reasons[0]).toBe('5 wallets bought 10.0 SOL in 3 min and sold nothing');
  });

  it('proven wallets buying count most; proven wallets selling count against', () => {
    const book: SmartBook = { Ace: { hits: 4, tries: 6, at: T0 }, Pro: { hits: 3, tries: 5, at: T0 }, Lucky: { hits: 1, tries: 9, at: T0 } };
    const tok = coin();
    let t = T0 + 30_000;
    for (const w of ['Ace', 'Pro', 'Lucky', 'Anon1', 'Anon2']) applyTrade(tok, trade(tok, 'buy', w, 0.4, (t += 5_000)));
    const r = insiderRead(tok, t + 1_000, book);
    expect(r.wallets).toEqual(['Ace', 'Pro']);
    expect(r.reasons[0]).toBe('2 proven wallets buying (7 earlier coins sold at 3×+)');
    expect(r.score).toBeGreaterThanOrEqual(70);
    applyTrade(tok, trade(tok, 'sell', 'Pro', 0.4, (t += 5_000)));
    const later = insiderRead(tok, t + 1_000, book);
    expect(later.score).toBeLessThan(r.score);
    expect(later.reasons).toContain('1 proven wallet already selling');
  });

  it('launch-second buys are not insider signals (bundles are the Sentinel’s)', () => {
    const tok = coin();
    for (let i = 0; i < 5; i++) applyTrade(tok, trade(tok, 'buy', `Sniper${i}`, 2, T0 + 500 + i * 100));
    expect(insiderRead(tok, T0 + 60_000, {}).score).toBe(0);
  });
});

describe('Insider lane', () => {
  it('buys before the crowd shows, keeps the 5× room rule, and sells when the insiders sell', () => {
    const tok = coin();
    let t = T0 + 30_000;
    for (let i = 0; i < 5; i++) applyTrade(tok, trade(tok, 'buy', `Whale${i}`, 2, (t += 20_000)));
    for (let i = 0; i < 4; i++) applyTrade(tok, trade(tok, 'buy', `Small${i}`, 0.1, (t += 2_000)));
    clean(tok, t);
    const now = t + 1_000;
    const a = assess(tok, now, 150);
    const ins = insiderRead(tok, now, {});
    // the crowd lane says no: virality is low
    expect(strategist(tok, a, pass, quiet, STRATEGY_DEFAULTS).enter).toBe(false);
    const d = strategist(tok, a, pass, quiet, STRATEGY_DEFAULTS, ins);
    expect(d.enter).toBe(true);
    expect(d.why).toMatch(/^INSIDER 65 · \d+× room to \$1000k — 5 wallets bought 10\.0 SOL in 3 min and sold nothing; .*; out when they sell$/);
    expect(d.insiders).toHaveLength(5);
    // switched off, or not enough room, it does not buy
    expect(strategist(tok, a, pass, quiet, { ...STRATEGY_DEFAULTS, insiderMin: 0 }, ins).enter).toBe(false);
    expect(strategist(tok, { ...a, mcapUsd: 250_000 }, pass, quiet, STRATEGY_DEFAULTS, ins).enter).toBe(false);
    // a rejected coin is never bought, whoever is in it
    expect(strategist(tok, a, { ...pass, verdict: 'reject', reasons: ['mint authority live'] }, quiet, STRATEGY_DEFAULTS, ins).enter).toBe(false);

    const p = openPosition(tok, 0.065, now, 150, d.why, d.conviction)!;
    p.insiders = d.insiders;
    t = now;
    applyTrade(tok, trade(tok, 'sell', 'Whale0', 1.5, (t += 2_000)));
    applyTrade(tok, trade(tok, 'sell', 'Whale1', 1.5, (t += 2_000)));
    expect(insidersOut(tok, p.insiders!, p.openedAt)).toBe(2);
    expect(decideExit(p, tok, t, 150, MANAGER_DEFAULTS, [])).toBeNull();
    applyTrade(tok, trade(tok, 'sell', 'Whale2', 1.5, (t += 2_000)));
    expect(decideExit(p, tok, t, 150, MANAGER_DEFAULTS, [])).toMatchObject({ share: 1, why: '3 of the 5 insider wallets it followed are selling — out with them' });
  });
});

import { describe, expect, it } from 'vitest';
import { curveBuyTokens, curveSellSol, PUMP_FEE } from '../pump';
import { useMeme } from '../scanner';
import { assess } from '../score';
import { applyTrade } from '../token';
import { buyerGrowth, earlyBuys, herald, memeWords, Narratives, sentinel, strategist, STRATEGY_DEFAULTS } from './agents';
import { managePosition, MANAGER_DEFAULTS, multiple, openPosition, pnlSol, quoteSell } from './book';
import { coin, DEV, runner, T0, trade } from './fixtures';
import { calibrate, follow, newOutcome } from './outcomes';
import { swarm, useSwarm } from './swarm';

describe('Sentinel — viability', () => {
  it('passes a clean coin with broad buying', () => {
    const { tok, now } = runner();
    const v = sentinel(tok, now);
    expect(v).toMatchObject({ verdict: 'pass', score: 100, reasons: [] });
  });

  it('waits for the on-chain check before passing anything', () => {
    const { tok, now } = runner();
    tok.safety = undefined;
    expect(sentinel(tok, now)).toMatchObject({ verdict: 'watch', reasons: ['waiting for the on-chain check'] });
  });

  it('rejects bundled launches: several wallets taking a big share within seconds', () => {
    const tok = coin();
    for (let i = 0; i < 5; i++) applyTrade(tok, trade(tok, 'buy', `B${i}`, 3, T0 + 500 + i * 100));
    expect(earlyBuys(tok)).toMatchObject({ wallets: 5 });
    expect(earlyBuys(tok).share).toBeGreaterThan(0.1);
    tok.safety = { checkedAt: T0, mintRevoked: true, freezeRevoked: true, top10: 0.2, top1: 0.05 };
    const v = sentinel(tok, T0 + 5_000);
    expect(v.verdict).toBe('reject');
    expect(v.reasons[0]).toMatch(/^5 wallets bought \d+% within 3 s of launch — bundled or sniped$/);
  });

  it('rejects live authorities, a big creator bag, a dumping creator, wash trading, and creators who rugged before', () => {
    const { tok, now } = runner();
    tok.safety = { checkedAt: now, mintRevoked: false, freezeRevoked: false, top10: 0.55, top1: 0.2 };
    expect(sentinel(tok, now).reasons).toEqual(expect.arrayContaining(['mint authority live — supply can be printed', 'freeze authority live — holders can be frozen', 'top 10 wallets hold 55%']));
    const fat = coin({ initialBuy: 250_000_000 });
    fat.safety = { checkedAt: T0, mintRevoked: true, freezeRevoked: true, top10: 0.1, top1: 0.05 };
    expect(sentinel(fat, T0).reasons).toContain('creator bought 25% of the supply at launch');
    const { tok: dumped, now: n2 } = runner();
    applyTrade(dumped, trade(dumped, 'sell', DEV, 1, n2, 30_000_000));
    expect(sentinel(dumped, n2 + 1).reasons).toContain('creator sold 100% of the launch bag');
    const { tok: clean, now: n3 } = runner();
    expect(sentinel(clean, n3, { launches: 2, rugs: 1 })).toMatchObject({ verdict: 'reject', reasons: ["this creator's earlier coin rugged (1)"] });
    const washed = coin();
    washed.safety = { checkedAt: T0, mintRevoked: true, freezeRevoked: true, top10: 0.1, top1: 0.05 };
    let t = T0 + 10_000;
    for (let i = 0; i < 8; i++) {
      applyTrade(washed, trade(washed, 'buy', `X${i}`, 0.5, (t += 2_000)));
      applyTrade(washed, trade(washed, 'sell', `X${i}`, 0.45, (t += 2_000)));
    }
    expect(sentinel(washed, t).reasons).toContain('8 of 8 buyers also sold within minutes — wash trading');
  });
});

describe('Herald — virality', () => {
  it('finds the meme words and the narratives running hot, and the leader of a cluster', () => {
    expect(memeWords('The Official Frog Coin', 'FROG2')).toEqual(['frog', 'frog2']);
    const nar = new Narratives();
    for (let i = 0; i < 9; i++) nar.add(`m${i}`, i % 3 ? `Frog ${i}` : 'Baby Frog', 'FRG', T0 + i);
    nar.add('other', 'Cat Hat', 'CAT', T0);
    expect(nar.cluster('Frog Coin', 'FROG')).toMatchObject({ word: 'frog', count: 9 });
    expect(nar.top(2)).toEqual([
      { word: 'frg', count: 9 },
      { word: 'frog', count: 9 },
    ]);
    nar.prune(T0 + 3_600_000 + 10);
    expect(nar.cluster('Frog', 'FROG')).toMatchObject({ count: 0 });
  });

  it('scores new wallets arriving faster, the narrative, socials and breadth', () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'https://x.com/frog', telegram: 'https://t.me/frog', fetchedAt: now };
    const g = buyerGrowth(tok, now);
    expect(g.perMin).toBeGreaterThan(10);
    const nar = new Narratives();
    for (let i = 0; i < 9; i++) nar.add(i ? `m${i}` : tok.mint, 'Frog Coin', 'FROG', now);
    const x = herald(tok, now, nar, () => tok.mint);
    expect(x.score).toBeGreaterThanOrEqual(60);
    expect(x.narrative).toEqual({ word: 'frog', count: 9, leader: true });
    expect(x.reasons).toEqual(expect.arrayContaining(['"frog" is running — 9 coins on it this hour, and this one leads', 'links x, telegram']));
    // a coin nobody is joining scores low
    const quiet = coin();
    applyTrade(quiet, trade(quiet, 'buy', 'A', 0.2, T0 + 30_000));
    expect(herald(quiet, T0 + 40_000, new Narratives(), () => null).score).toBeLessThan(20);
  });
});

describe('Strategist — entries', () => {
  it('enters when heat, virality and viability all line up, within the curve window', () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    const a = assess(tok, now, 150);
    const v = sentinel(tok, now);
    const nar = new Narratives();
    for (let i = 0; i < 9; i++) nar.add(i ? `m${i}` : tok.mint, 'Frog', 'FROG', now);
    const x = herald(tok, now, nar, () => tok.mint);
    const d = strategist(tok, a, v, x, STRATEGY_DEFAULTS);
    expect(d.enter).toBe(true);
    expect(d.conviction).toBe(Math.round(0.4 * a.heat + 0.35 * x.score + 0.25 * v.score));
    expect(d.why).toMatch(/^heat \d+ · virality \d+ · viability 100 · \d+× room to \$1000k · \d+% buys — /);
    // the 5× rules: conviction floor, room to the target, net buying
    expect(strategist(tok, a, v, x, { ...STRATEGY_DEFAULTS, minConviction: 99 }).why).toMatch(/^conviction \d+ < 99$/);
    expect(strategist(tok, a, v, x, { ...STRATEGY_DEFAULTS, targetMcapUsd: a.mcapUsd * 3 }).why).toMatch(/^only 3\.0× of room to \$\d+k — needs 5×$/);
    expect(strategist(tok, a, v, x, { ...STRATEGY_DEFAULTS, minBuyShare: 0.99 }).why).toMatch(/^buyers only \d+% of the flow — needs 99%$/);
    // the same coin, but the window has passed
    expect(strategist(tok, a, v, x, { ...STRATEGY_DEFAULTS, maxAgeMin: 5 }).why).toBe('older than 5 min');
    expect(strategist(tok, a, v, x, { ...STRATEGY_DEFAULTS, maxCurve: 0.1 }).why).toMatch(/^curve \d+% — late, graduation sells into it$/);
    expect(strategist(tok, a, { ...v, verdict: 'reject', reasons: ['bundled'] }, x, STRATEGY_DEFAULTS)).toMatchObject({ enter: false, why: 'rejected: bundled' });
  });
});

describe('Strategist — not chasing spikes', () => {
  const pass = { verdict: 'pass', score: 100, reasons: [] } as unknown as Parameters<typeof strategist>[2];
  const strong = { score: 80, reasons: [] } as unknown as ReturnType<typeof herald>;

  it('on the curve: a steady climb passes, a vertical last minute does not', () => {
    const { tok, now } = runner(8);
    const a = { ...assess(tok, now, 150), heat: 90 };
    expect(strategist(tok, a, pass, strong, STRATEGY_DEFAULTS).enter).toBe(true);
    // a spike: the price doubles in the last half minute
    let t = now;
    const top = tok.mcapSol * 2;
    let w = 0;
    while (tok.mcapSol < top) applyTrade(tok, trade(tok, 'buy', `SP${w++}`, 3, (t += 1_000)));
    const b = { ...assess(tok, t, 150), heat: 90 };
    expect(strategist(tok, b, pass, strong, STRATEGY_DEFAULTS).why).toMatch(/^price \d+% above its 5-min average — not chasing the spike/);
  });

  it('on a pool: up 111 % in 5 min with half the trades sells is skipped (the HYPERTAG trade)', () => {
    const { tok, now } = runner(8);
    tok.source = 'dex';
    tok.migrated = true;
    const pool = (m5: number, buys: number, sells: number) => ({ pairAddress: 'P', dexId: 'pumpswap', url: '', priceUsd: 0.0001, mcapUsd: 89_581, liquidityUsd: 60_000, volume: { m5: 50_000, h1: 100_000, h6: 0, h24: 0 }, txns: { m5: { buys, sells }, h1: { buys, sells }, h24: { buys, sells } }, change: { m5, h1: m5, h6: m5, h24: m5 }, createdAt: now - 3_600_000, boosts: 0, socials: 2 }) as unknown as NonNullable<typeof tok.dex>;
    const a = { ...assess(tok, now, 150), heat: 85, mcapUsd: 89_581, ageSec: 600 };
    tok.dex = pool(111, 484, 484);
    expect(strategist(tok, a, pass, strong, STRATEGY_DEFAULTS).why).toBe('up 111% in 5 min — not chasing the spike, waiting for it to settle');
    tok.dex = pool(20, 484, 484);
    expect(strategist(tok, a, pass, strong, STRATEGY_DEFAULTS).why).toBe('buyers only 50% of the flow — needs 58%');
    tok.dex = pool(20, 700, 300);
    expect(strategist(tok, a, pass, strong, STRATEGY_DEFAULTS).enter).toBe(true);
    // and conviction 73, as it had, is below the floor
    expect(strategist(tok, { ...a, heat: 85 }, { ...pass, score: 100 }, { score: 40, reasons: [] } as unknown as ReturnType<typeof herald>, { ...STRATEGY_DEFAULTS, minVirality: 0 }).why).toBe('conviction 73 < 80');
  });
});

describe('Manager — paper trades', () => {
  it('prices fills exactly on the curve: a round trip costs the fee both ways', () => {
    const tok = coin();
    const tokens = curveBuyTokens(tok.vSol, tok.vTokens, 1);
    const back = curveSellSol(tok.vSol + 1 * (1 - PUMP_FEE), tok.vTokens - tokens, tokens);
    expect(back).toBeCloseTo((1 - PUMP_FEE) ** 2, 6);
  });

  it('takes profits up the ladder, trails, and closes', () => {
    const { tok, now } = runner(4);
    const p = openPosition(tok, 0.1, now, 150, 'test', 80)!;
    expect(p.tokens).toBeGreaterThan(0);
    let t = now;
    let w = 0;
    const pump = (sol: number) => {
      while (multiple(p, tok, 150) < sol) applyTrade(tok, trade(tok, 'buy', `P${w++}`, 2, (t += 1_000)));
      return managePosition(p, tok, t, 150, MANAGER_DEFAULTS, []);
    };
    expect(pump(2.05)).toEqual([]);
    expect(pump(3.05).map((f) => f.why)).toEqual(['take profit at 3× (sold 34% of what was left)']);
    expect(p.realizedSol).toBeGreaterThan(0.09);
    expect(pump(5.1).map((f) => f.why)).toEqual(['take profit at 5× (sold 50% of what was left)']);
    expect(p.tpDone).toBe(2);
    // the top: price falls 45 % from the peak → trailing stop
    while (multiple(p, tok, 150) > p.peakMult * 0.58) applyTrade(tok, trade(tok, 'sell', `D${w++}`, 2, (t += 1_000)));
    const f = managePosition(p, tok, t, 150, MANAGER_DEFAULTS, []);
    expect(f[0].why).toMatch(/^trailing stop: [\d.]+× after a [\d.]+× peak$/);
    expect(p.closedAt).toBe(t);
    expect(p.left).toBe(0);
    expect(pnlSol(p, tok, 150)).toBeGreaterThan(0.1);
  });

  it('stop loss, stale exit, and rug exits', () => {
    const a = runner(4);
    const p = openPosition(a.tok, 0.1, a.now, 150, 'test', 70)!;
    let t = a.now;
    while (multiple(p, a.tok, 150) > 0.6) applyTrade(a.tok, trade(a.tok, 'sell', `D${t}`, 1, (t += 1_000)));
    expect(managePosition(p, a.tok, t, 150, MANAGER_DEFAULTS, [])[0].why).toMatch(/^stop loss at 0\.\d+×$/);

    const b = runner(4);
    const q = openPosition(b.tok, 0.1, b.now, 150, 'test', 70)!;
    expect(managePosition(q, b.tok, b.now + 21 * 60_000, 150, { ...MANAGER_DEFAULTS }, [])[0].why).toBe('no trades for 5 min — out');

    const c = runner(4);
    const r = openPosition(c.tok, 0.1, c.now, 150, 'test', 70)!;
    applyTrade(c.tok, trade(c.tok, 'sell', DEV, 0.5, c.now + 1_000, 30_000_000));
    expect(managePosition(r, c.tok, c.now + 2_000, 150, MANAGER_DEFAULTS, [])[0].why).toBe('creator dumped — out');

    const d = runner(4);
    const s = openPosition(d.tok, 0.1, d.now, 150, 'test', 70)!;
    expect(managePosition(s, d.tok, d.now + 1_000, 150, MANAGER_DEFAULTS, ['Freeze authority not revoked'])[0].why).toBe('danger: Freeze authority not revoked — out');
    expect(quoteSell(d.tok, 0, 150)).toBe(0);
  });
});

describe('Outcomes', () => {
  it('follows each call for an hour and reports hit rates by conviction against the passed-not-picked sample', () => {
    const rows = [
      [85, 'pick', 12],
      [82, 'pick', 2.5],
      [70, 'pick', 0.1],
      [60, 'pick', 1.2],
      [50, 'control', 1.1],
      [50, 'control', 0.1],
    ].map(([conv, kind, peak], i) => {
      const o = newOutcome({ mint: `m${i}`, symbol: 'X', t0: T0, mcap0: 100, kind: kind as 'pick', conviction: conv as number, heat: 0, virality: 0, viability: 0 });
      follow(o, 100 * (peak as number), false, T0 + 1000);
      if ((peak as number) > 1) follow(o, 100 * Math.min(1, peak as number), false, T0 + 2000);
      follow(o, 100 * (peak as number), false, T0 + 3_600_001);
      return o;
    });
    expect(rows.every((o) => o.done)).toBe(true);
    const b = calibrate(rows);
    expect(b[0]).toMatchObject({ label: 'Conviction 80+', n: 2, x2: 1, x5: 0.5, x10: 0.5, dead: 0 });
    expect(b[1]).toMatchObject({ label: 'Conviction 65–79', n: 1, x2: 0, dead: 1 });
    expect(b[3]).toMatchObject({ label: 'All picks', n: 4, x2: 0.5 });
    expect(b[4]).toMatchObject({ label: 'Passed, not picked', n: 2, x2: 0, dead: 0.5 });
  });
});

describe('the swarm, end to end', () => {
  it('picks a clean runner, buys it on paper, and starts following the call; rejects a bundled launch', () => {
    const { tok, now } = runner(8);
    tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    const bundled = coin({ name: 'Bundle', symbol: 'BNDL' });
    for (let i = 0; i < 6; i++) applyTrade(bundled, trade(bundled, 'buy', `B${i}`, 3, bundled.createdAt + 300 + i * 50));
    bundled.safety = { checkedAt: now, mintRevoked: true, freezeRevoked: true, top10: 0.25, top1: 0.05 };
    for (let i = 0; i < 8; i++) {
      const c = coin({ name: `Frog ${i}`, symbol: 'FRG' }, now - 60_000);
      useMeme.getState().tokens[c.mint] = c;
    }
    useMeme.setState({ tokens: { ...useMeme.getState().tokens, [tok.mint]: tok, [bundled.mint]: bundled }, solUsd: 150 });
    useSwarm.setState({ positions: [], outcomes: [], log: [] });
    swarm.tick(now);
    const s = useSwarm.getState();
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]).toMatchObject({ mint: tok.mint, costSol: MANAGER_DEFAULTS.sizeSol });
    expect(s.outcomes.find((o) => o.mint === tok.mint)).toMatchObject({ kind: 'pick', done: false });
    expect(sentinel(bundled, now).verdict).toBe('reject');
    expect(s.positions.some((p) => p.mint === bundled.mint)).toBe(false);
    expect(s.log.map((l) => `${l.agent}: ${l.text.split(' — ')[0]}`)).toEqual(expect.arrayContaining([`strategist: FROG: PICK (conviction ${s.positions[0].conviction})`, 'manager: FROG: bought 0.1 SOL (paper) at $' + Math.round(tok.mcapSol * 150).toLocaleString('en-US') + ' market cap']));
    expect(s.stats.sentinel.reject).toBeGreaterThanOrEqual(1);
    // a second tick does not buy the same coin twice
    swarm.tick(now + 2_000);
    expect(useSwarm.getState().positions).toHaveLength(1);
  });
});

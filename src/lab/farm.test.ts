// The edge finder: bots bred from the bot builder's blocks, trained on the
// first 70 %, and only kept if they survive the holdout, the steadiness and
// double-cost checks, 100 random bots, their settings nudged and 1,000
// shuffles — then ranked for significance allowing for every bot tried,
// forward-tested on fresh data, and put together as a team.
import { describe, expect, it } from 'vitest';
import { checkFlow, buildSpec, FLOW_DEFAULT, type Flow } from './flow';
import { dailyOf, Farm, farmKey, farmKind, farmNiche, ladderOf, paceIdOf, PACES, scoreOf, STAGES, VAULT, type FarmSave, type Survivor } from './farm';
import { COSTS } from './backtest';
import { ctxOf, type Market } from './library';
import { runAll, withBench } from './research';
import { perf } from './stats';
import { rngOf } from './ml';

const HOUR = 3_600_000;
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
/** hourly candles; with trend > 0, slow drifts that a trend rule can ride */
function market(coin: string, n: number, seed: number, trend = 0, t0 = Date.UTC(2024, 0, 1)): Market {
  const g = gauss(rngOf(seed));
  let p = 100;
  let mu = 0;
  const bars = Array.from({ length: n }, (_, i) => {
    mu = 0.997 * mu + trend * 0.00045 * g();
    const o = p;
    p *= Math.exp(mu + 0.005 * g());
    return { time: t0 + i * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 + ((i * 37) % 11) * 20 };
  });
  return { coin, tfH: 1, bars, funding: null };
}
const trending = () => ({ '1h': [market('BTC', 6000, 3, 1), market('ETH', 6000, 4, 1)] });
const noise = () => ({ '1h': [market('BTC', 6000, 5, 0), market('ETH', 6000, 6, 0)] });
const flow = (p: Partial<Flow>): Flow => ({ ...FLOW_DEFAULT, style: 'intraday', coins: 'BTC ETH', models: [], risks: [], ...p });

describe('breeding', () => {
  const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 3 });
  farm.setMarkets(trending());
  it('random bots are built from the blocks, never clash, and use only the paces and coins it has', () => {
    for (let i = 0; i < 60; i++) {
      const f = farm.randomFlow()!;
      expect(f).toBeTruthy();
      expect(f.style).toBe('intraday');
      expect(f.coins).toBe('BTC ETH');
      expect(f.decider).toBe('none');
      expect(checkFlow(f).some((x) => x.tone === 'clash'), JSON.stringify(f)).toBe(false);
      expect(f.risks).not.toContain('kelly');
      expect(buildSpec(f).timeframe).toBe('1h');
    }
  });
  it('a mutation changes one thing; a child takes blocks from both parents', () => {
    const a = flow({ strategies: ['tsmom'], stopWidth: 'normal' });
    const b = flow({ strategies: ['donchian'], models: ['trend'], stopWidth: 'wide', takeProfit: 'r2' });
    for (let i = 0; i < 30; i++) {
      const m = farm.mutate(a);
      expect(farmKey(m)).not.toBe(farmKey(a));
      expect(checkFlow(m).some((x) => x.tone === 'clash')).toBe(false);
      const c = farm.cross(a, b);
      for (const k of ['stopWidth', 'takeProfit'] as const) expect([a[k], b[k]]).toContain(c[k]);
      expect([a.strategies.join(), b.strategies.join()]).toContain(c.strategies.join());
    }
  });
  it('a mutation never empties a bot, and merging two bots joins the strategies of both', () => {
    const a = flow({ strategies: ['tsmom', 'donchian'], combine: 'all' });
    for (let i = 0; i < 80; i++) {
      const m = farm.mutate(a);
      expect(m.strategies.length).toBeGreaterThanOrEqual(1);
      expect(m.strategies.length).toBeLessThanOrEqual(3);
      expect(new Set(m.strategies).size).toBe(m.strategies.length);
    }
    const x = flow({ strategies: ['tsmom'], models: ['trend'] });
    const y = flow({ strategies: ['volbrk'], tunes: { 'strategy:volbrk': { n: 4 } } });
    let merged = 0;
    for (let i = 0; i < 20; i++) {
      const m = farm.merge(x, y);
      expect(checkFlow(m).some((f) => f.tone === 'clash')).toBe(false);
      if (m.strategies.length === 2) {
        merged++;
        expect([...m.strategies].sort()).toEqual(['tsmom', 'volbrk']);
        expect(m.tunes?.['strategy:volbrk']).toEqual({ n: 4 });
        expect([x.models.join(), y.models.join()]).toContain(m.models.join());
      }
    }
    expect(merged).toBeGreaterThan(10);
    // a trend rule merged with a dip rule is joined by the regime switch or by “all must agree” — never a clash
    const z = farm.merge(flow({ strategies: ['tma'] }), flow({ strategies: ['rsi2'] }));
    if (z.strategies.length === 2) expect(['switch', 'all']).toContain(z.combine);
  });
  it('the order of the strategies only matters for “setup, then trigger”; the kind of a bot is its pace, families and sides', () => {
    const ab = flow({ strategies: ['donchian', 'volbrk'], combine: 'all' });
    const ba = flow({ strategies: ['volbrk', 'donchian'], combine: 'all' });
    expect(farmKey(ab)).toBe(farmKey(ba));
    expect(farmKey({ ...ab, combine: 'then' })).not.toBe(farmKey({ ...ba, combine: 'then' }));
    // one strategy: how it would be joined is no difference
    expect(farmKey(flow({ strategies: ['tsmom'], combine: 'all' }))).toBe(farmKey(flow({ strategies: ['tsmom'], combine: 'any' })));
    expect(farmNiche(flow({ strategies: ['tsmom'] }))).toBe(farmNiche(flow({ strategies: ['vsmom'], stopWidth: 'wide' })));
    expect(farmNiche(flow({ strategies: ['tsmom'] }))).not.toBe(farmNiche(flow({ strategies: ['zrev'] })));
    expect(farmNiche(flow({ strategies: ['tsmom'] }))).not.toBe(farmNiche(flow({ strategies: ['tsmom'], sides: 'long' })));
  });
  it('nudges every setting one step each way', () => {
    const n = farm.neighbours(flow({ strategies: ['tsmom'], stopWidth: 'normal', hold: 'normal', takeProfit: 'r2', tunes: { 'strategy:tsmom': { lookback: 72 } } }));
    const looks = n.map((x) => buildSpec(x).spec.signal.p.lookback).filter((v) => v !== 72);
    expect(looks.sort((x, y) => x - y)).toEqual([24, 168]);
    expect(n.some((x) => x.stopWidth === 'tight') && n.some((x) => x.stopWidth === 'wide')).toBe(true);
    expect(n.some((x) => x.hold === 'half') && n.some((x) => x.hold === 'long')).toBe(true);
    expect(n.some((x) => x.takeProfit === 'r15') && n.some((x) => x.takeProfit === 'r3')).toBe(true);
  });
});

describe('training never reads the unseen data', () => {
  it('another future gives the same training score', () => {
    const m = trending();
    const cut = Math.floor(6000 * 0.7);
    const other = { '1h': m['1h'].map((x) => ({ ...x, bars: x.bars.map((b, i) => (i >= cut ? { ...b, close: b.close * 0.6, open: b.open * 0.6, high: b.high * 0.6, low: b.low * 0.5 } : b)) })) };
    const a = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 1 });
    const b = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 1 });
    a.setMarkets(m);
    b.setMarkets(other);
    for (const f of [flow({ strategies: ['tsmom'] }), flow({ strategies: ['donchian'], models: ['trend'] }), flow({ strategies: ['zrev'] })]) expect(a.train(f).fit).toBe(b.train(f).fit);
  });
});

describe('the training score', () => {
  it('a bot carried by one half of the training years scores well below its Sharpe ratio', () => {
    // a trend through the first 2,000 hours only; the training bars are the first 4,200
    const g = gauss(rngOf(17));
    const mk = (coin: string, seed: number): Market => {
      const h = gauss(rngOf(seed));
      let p = 100;
      let mu = 0;
      const bars = Array.from({ length: 6000 }, (_, i) => {
        mu = i < 2000 ? 0.997 * mu + 3 * 0.00045 * h() : 0;
        const o = p;
        p *= Math.exp(mu + 0.005 * h());
        return { time: Date.UTC(2024, 0, 1) + i * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 };
      });
      return { coin, tfH: 1, bars, funding: null };
    };
    void g;
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets({ '1h': [mk('BTC', 3), mk('ETH', 4)] });
    const half = farm.train(flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } } }));
    const whole = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    whole.setMarkets(trending());
    const all = whole.train(flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } } }));
    expect(half.is!.sharpe).toBeGreaterThan(0.5);
    expect(half.fit).toBeLessThan(0.7 * half.is!.sharpe);
    // steady through the whole of training: the score stays close to the Sharpe ratio
    expect(all.fit).toBeGreaterThan(0.6 * all.is!.sharpe);
    // and it reports the eight stretches the overfit meter reads
    expect(all.blocks!.length).toBe(8);
    expect(all.tf).toBe('1h');
  });
  it('a learned rule is scored on training bars its model never saw — not on the ones it learned from', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(noise());
    const f = flow({ strategies: ['rf'], takeProfit: 'r2' });
    const honest = farm.train(f);
    // on the bars the forest learned from it looks like an edge; there is none in this market
    const x = buildSpec(f);
    const ctxs = withBench(noise()['1h']).map((m, k) => ctxOf(m, Math.floor(m.bars.length * 0.7), 42 + k));
    const flattered = runAll(ctxs, x.spec, 'is', COSTS);
    const inSample = perf(flattered.rets, flattered.trades, 24 * 365).sharpe;
    expect(inSample).toBeGreaterThan(1.5);
    expect(honest.is ? honest.is.sharpe : -1).toBeLessThan(inSample - 1);
    expect(honest.fit).toBeLessThan(0.7);
    // no part of its score reads the unseen 30 %: another future, the same score
    const cut = Math.floor(6000 * 0.7);
    const other = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    other.setMarkets({ '1h': noise()['1h'].map((m) => ({ ...m, bars: m.bars.map((b, i) => (i >= cut ? { ...b, close: b.close * 0.6, open: b.open * 0.6, high: b.high * 0.6, low: b.low * 0.5 } : b)) })) });
    expect(other.train(f).fit).toBe(honest.fit);
  }, 60_000);
  it('more blocks for the same result score lower', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const lean = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } } });
    // the same rule twice over: the second copy changes nothing about the trades
    const fat = { ...lean, strategies: ['tsmom', 'vsmom'], combine: 'any' as const, risks: ['garchstop'], models: ['weekdays', 'hmm-calm'] };
    const a = farm.train(lean);
    const b = farm.train(fat);
    if (b.is && Math.abs(b.is.sharpe - a.is!.sharpe) < 0.05) expect(b.fit).toBeLessThan(a.fit);
    expect(a.fit).toBeGreaterThan(0.7);
  });
});

describe('the gauntlet', () => {
  it('a trend rule in a trending market survives every check, with the numbers to show it', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail', sides: 'both' });
    const t = farm.train(f);
    expect(t.fit).toBeGreaterThan(0.7);
    const g = farm.gauntlet(f, t.is!);
    expect(g.ok, g.ok ? '' : `${g.at}: ${g.why}`).toBe(true);
    if (!g.ok) return;
    expect(g.s.beat).toBeGreaterThanOrEqual(75);
    expect(g.s.nudge.kept / g.s.nudge.tried).toBeGreaterThanOrEqual(0.5);
    expect(g.s.mc.dd95).toBeLessThanOrEqual(0.2);
    expect(g.s.oos.sharpe).toBeGreaterThan(0.5);
    expect(g.s.summary.length).toBeGreaterThan(3);
    expect(g.s.curve.length).toBeGreaterThan(50);
    // found on the history before the vault (its last 15 %), then tested on the vault at once
    const cut = Math.floor(6000 * (1 - VAULT));
    expect(g.s.seenTo).toBe(trending()['1h'][0].bars[cut - 1].time);
    expect(g.s.vault!.bars).toBe(6000 - cut);
    expect(g.s.vault!.trades).toBeGreaterThan(0);
    expect(g.s.vault!.ret).toBeGreaterThan(0);
    expect(g.s.forward).toMatchObject({ bars: 6000 - cut, trades: g.s.vault!.trades });
    // it is on the ladder at once: fewer than 5 trades in the vault is incubating, 5 to 14 proving, more proven
    expect(g.s.stage).toBe(g.s.vault!.trades < 5 ? 'incubating' : g.s.vault!.trades < 15 ? 'proving' : 'proven');
    // the steadiness and cost checks, with their numbers
    expect(g.s.checks!.thirds).toBeGreaterThanOrEqual(2);
    expect(g.s.checks!.coinsUp).toBeGreaterThanOrEqual(1);
    expect(g.s.checks!.noBest).toBeGreaterThan(0);
    expect(g.s.checks!.cost2).toBeGreaterThan(0);
    expect(g.s.checks!.cost2).toBeLessThan(g.s.oos.sharpe);
    expect(g.s.p!).toBeLessThan(0.05);
    // a return for every day of the unseen stretch (30 % of the 5,100 hours before the vault: 63 days)
    expect(g.s.daily!.r.length).toBeGreaterThanOrEqual(63);
    expect(Math.abs(g.s.daily!.r.reduce((a, b) => a + b, 0) - Math.log(1 + g.s.oos.totalReturn))).toBeLessThan(0.15);
  });

  it('an edge thinner than its costs is thrown out at the cost check, after it has passed the holdout and the steadiness check', () => {
    const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail', sides: 'both' });
    // the same bot and the same fees; only the multiple of the costs it must survive differs
    const at = (stress: number) => {
      const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2, stress });
      farm.setMarkets(trending());
      const g = farm.gauntlet(f, farm.train(f).is!);
      return g.ok ? 'ok' : `${g.at}: ${g.why}`;
    };
    expect(at(2)).toBe('ok');
    expect(at(40)).toMatch(/^costs: loses at double the fees and slippage/);
  }, 60_000);

  it('a result carried by one stretch of the unseen data is thrown out as not steady', () => {
    // trending through training and the first third of the unseen stretch (bars 3,570 to 5,100), then a choppy market with no trend
    const mk = (coin: string, seed: number): Market => {
      const h = gauss(rngOf(seed));
      let p = 100;
      let mu = 0;
      const bars = Array.from({ length: 6000 }, (_, i) => {
        mu = i < 4050 ? 0.997 * mu + 0.00045 * h() : 0;
        const o = p;
        p *= Math.exp(mu + (i < 4050 ? 0.005 : 0.007) * h());
        return { time: Date.UTC(2024, 0, 1) + i * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 };
      });
      return { coin, tfH: 1, bars, funding: null };
    };
    const stages: string[] = [];
    for (const [a, b] of [[3, 4], [13, 14], [23, 24], [33, 34], [43, 44], [53, 54]]) {
      const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
      farm.setMarkets({ '1h': [mk('BTC', a), mk('ETH', b)] });
      const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail' });
      const t = farm.train(f);
      if (!t.is) continue;
      const g = farm.gauntlet(f, t.is);
      stages.push(g.ok ? 'ok' : g.at);
    }
    // it never survives; it is stopped at the holdout or — when the early run was big enough to pass that — at the steadiness check
    expect(stages).not.toContain('ok');
    expect(stages.every((x) => x === 'holdout' || x === 'steady')).toBe(true);
  }, 60_000);

  it('in a market with no edge, almost nothing gets through — and where they fail is recorded', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 9 });
    farm.setMarkets(noise());
    for (let i = 0; i < 200; i++) farm.step();
    const st = farm.state(true);
    expect(st.tried).toBeGreaterThan(120);
    expect(st.funnel.bred).toBe(st.tried);
    // each stage holds no more than the one before
    const counts = STAGES.map((s) => st.funnel[s.id]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    // the checks let a few lucky ones through when hundreds are tried; significance — allowing for all of them — stops them reaching the top five
    expect(st.funnel.shuffle).toBeLessThanOrEqual(Math.max(3, st.tried * 0.05));
    expect(st.funnel.proof).toBe(0);
    // whatever is listed is a candidate, never called significant
    for (const w of st.top) expect(w.sig).toBe(false);
    expect(st.watch).toEqual([]);
    expect(st.gen).toBeGreaterThan(2);
    for (const r of st.recent) expect(r.why.length).toBeGreaterThan(10);
    // the overfit meter: with no edge to find, the best bot in training is no better than the rest on other data
    expect(st.entrants).toBe(st.funnel.trained);
    expect(st.pbo === null || (st.pbo! > 0.3 && st.pbo! <= 1), `pbo ${st.pbo}`).toBe(true);
    expect(st.niches!).toBeGreaterThan(3);
  }, 60_000);

  it('in a trending market the loop finds survivors and keeps a top five of different families', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 4 });
    farm.setMarkets(trending());
    for (let i = 0; i < 700 && farm.state(true).survivors < 3; i++) farm.step();
    const st = farm.state(true);
    expect(st.survivors).toBeGreaterThan(0);
    expect(st.top.length).toBeGreaterThan(0);
    expect(st.top.length).toBeLessThanOrEqual(5);
    const fams = st.top.map((s) => JSON.stringify([s.style, [...s.flow.strategies].sort(), [...s.flow.models].sort()]));
    expect(new Set(fams).size).toBe(fams.length);
    for (const s of st.top) expect(s.beat).toBeGreaterThanOrEqual(75);
    // every survivor made money in the vault, and stands on the ladder for it
    for (const s of st.top) {
      expect(s.vault!.trades).toBeGreaterThan(0);
      expect(s.stage).not.toBe('faded');
    }
    // the same five, as the intraday pace's board
    const board = st.tops!.find((b) => b.id === 'intraday')!;
    expect(board.rows.map((r) => r.id)).toEqual(st.top.map((r) => r.id));
    expect(st.tops!.map((b) => b.id)).toEqual(['intraday']);
  }, 120_000);
});

describe('fresh data: forward tests, the ladder and the fleet', () => {
  it('a survivor is forward-tested on candles that arrive after it was found', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail' });
    const t = farm.train(f);
    const g = farm.gauntlet(f, t.is!);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    farm.survivors.push(g.s);
    const inVault = g.s.forward!.bars;
    expect(inVault).toBe(900);
    // a thousand more hours of the same markets (the same seeds: the first 6,000 hours are the same)
    farm.setMarkets({ '1h': [market('BTC', 7000, 3, 1), market('ETH', 7000, 4, 1)] });
    const s = farm.survivors[0];
    expect(s.forward).toBeTruthy();
    // its record carries on from the vault into the new candles
    expect(s.forward!.bars).toBeGreaterThan(inVault + 900);
    expect(s.forward!.bars).toBeLessThanOrEqual(inVault + 1001);
    expect(s.vault!.bars).toBe(inVault);
    expect(['incubating', 'proving', 'proven', 'faded']).toContain(s.stage);
  });

  it('the ladder: new, incubating, proving, proven — or faded', () => {
    const oos = { maxDD: 0.08 } as Survivor['oos'];
    const fw = (trades: number, ret: number, maxDD = 0.02) => ({ forward: { bars: 100, trades, ret, sharpe: ret > 0 ? 1 : -1, maxDD, days: 30 }, oos });
    expect(ladderOf({ forward: null, oos })).toBe('new');
    expect(ladderOf(fw(2, 0.01))).toBe('incubating');
    expect(ladderOf(fw(8, 0.02))).toBe('proving');
    expect(ladderOf(fw(20, 0.05))).toBe('proven');
    expect(ladderOf(fw(20, -0.02))).toBe('faded');
    expect(ladderOf(fw(6, 0.01, 0.2))).toBe('faded');
    // fresh-data results move the score
    const base = { oos: { sharpe: 1.5, trades: 40 } as Survivor['oos'], nudge: { kept: 8, tried: 10 }, beat: 90 };
    expect(scoreOf({ ...base, forward: { bars: 100, trades: 10, ret: 0.05, sharpe: 2, maxDD: 0.02, days: 30 } })).toBeGreaterThan(scoreOf({ ...base, forward: null }));
    expect(scoreOf({ ...base, forward: { bars: 100, trades: 10, ret: -0.05, sharpe: -1.5, maxDD: 0.05, days: 30 } })).toBeLessThan(scoreOf({ ...base, forward: null }));
  });

  it('deployed strategies are watched on fresh data; a fading one is flagged', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const at = trending()['1h'][0].bars[3000].time;
    const good = buildSpec(flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail' })).spec;
    const bad = { ...good, sides: 'short' as const };
    farm.checkFleet([
      { id: 'a', name: 'trend', spec: good, tfH: 1, coins: ['BTC', 'ETH'], deployedAt: at, stats: { sharpe: 1 } },
      { id: 'b', name: 'short only', spec: { ...good, signal: { id: 'tsmom', p: { lookback: 72 } }, sides: 'both', filters: [], exit: { ...good.exit } }, tfH: 1, coins: ['BTC'], deployedAt: trending()['1h'][0].bars[5995].time },
      { id: 'c', name: 'elsewhere', spec: good, tfH: 4, coins: ['BTC'], deployedAt: at },
    ]);
    const [a, b, c] = farm.fleet;
    expect(a.forward!.trades).toBeGreaterThan(5);
    expect(['healthy', 'slipping', 'fading']).toContain(a.status);
    expect(b.status).toBe('watching');
    expect(c.status).toBe('no data');
    void bad;
  });
});

describe('it survives a restart', () => {
  it('saves and restores its survivors, counters and population', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 4 });
    farm.setMarkets(trending());
    for (let i = 0; i < 60; i++) farm.step();
    const saved = JSON.parse(JSON.stringify(farm.save()));
    const again = new Farm(saved.cfg, { seed: 5, save: saved });
    again.setMarkets(trending());
    expect(again.tried).toBe(farm.tried);
    expect(again.gen).toBe(farm.gen);
    expect(again.survivors.length).toBe(farm.survivors.length);
    expect(again.state(false).funnel).toEqual(farm.state(false).funnel);
    // and carries on
    for (let i = 0; i < 20; i++) again.step();
    expect(again.tried).toBeGreaterThan(farm.tried);
  }, 60_000);
});

describe('significance allows for every bot tried', () => {
  const fake = (id: string, t: number, strategies: string[], extra: Partial<Survivor> = {}): Survivor =>
    ({ id, key: id, flow: flow({ strategies }), name: id, style: 'intraday', tfH: 1, coins: ['BTC'], foundAt: 0, seenTo: 0, is: { sharpe: 2 }, oos: { sharpe: 2, trades: 40, t, maxDD: 0.05 }, beat: 90, nudge: { kept: 8, tried: 10 }, mc: { dd95: 0.1, pLoss: 0.1 }, periods: { unit: 'month', list: [], up: 1, worst: 0, avg: 0 }, dsr: 0.9, tried: 1, score: 1, forward: null, stage: 'new', summary: [], sig: true, curve: [], split: 0, ...extra }) as unknown as Survivor;

  /** a farm that has had `kinds` kinds of bot reach the unseen data */
  const after = (kinds: number, survivors: Survivor[]) => {
    const save: FarmSave = { v: 3, cfg: { coins: ['BTC'], styles: ['intraday'], sides: 'both', pace: 'gentle', maxDD: 0.2 }, gen: 1, tried: 9000, funnel: { bred: 9000, trained: 5000, holdout: 0, steady: 0, costs: 0, random: 0, nudge: 0, shuffle: 0, vault: 0, proof: 0 }, survivors, population: [], seen: [], startedAt: 1, recent: [], entered: Array.from({ length: kinds }, (_, i) => `kind${i}`) };
    return new Farm(save.cfg, { seed: 1, save });
  };
  // t of 3.3, 3.0, 2.1 and 0.8: one-sided p of about 0.0005, 0.0013, 0.018 and 0.21
  const four = () => [fake('a', 3.3, ['tsmom']), fake('b', 3.0, ['donchian']), fake('c', 2.1, ['zrev']), fake('d', 0.8, ['macd'])];

  it('the bar rises with the number of KINDS of bot that reached the unseen data — copies of a kind are one idea', () => {
    // 5,000 bots faced the gauntlet, but they were 100 kinds: the bar is set by the 100
    const farm = after(100, four());
    expect(farm.survivors.map((s) => s.sig)).toEqual([true, true, false, false]);
    // q: the false-discovery rate at which each would be called significant
    expect(farm.survivors[0].q!).toBeCloseTo(0.0484, 2);
    expect(farm.survivors[1].q!).toBeGreaterThan(farm.survivors[0].q!);
    expect(farm.survivors[3].q!).toBe(1);
    const st = farm.state(false);
    expect(st.kinds).toBe(100);
    expect(st.funnel.proof).toBe(2);
    // the top five lists every survivor still standing, the significant ones first; the rest are candidates
    expect(farm.top().map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(farm.watch()).toEqual([]);
    // ten times as many kinds tried: what was significant no longer is — and one proven on fresh data leads the list
    const more = four();
    more[1].stage = 'proven';
    const farm2 = after(1000, more);
    expect(farm2.survivors.map((s) => s.sig)).toEqual([false, false, false, false]);
    expect(farm2.top()[0].id).toBe('b');
    // with only a handful tried, t = 2.1 is enough
    expect(after(4, four()).survivors.map((s) => s.sig)).toEqual([true, true, true, false]);
  });

  it('a save from before (significant at t ≥ 2) is ranked again when restored', () => {
    const save: FarmSave = { v: 1, cfg: { coins: ['BTC'], styles: ['intraday'], sides: 'both', pace: 'gentle', maxDD: 0.2 }, gen: 9, tried: 4000, funnel: { bred: 4000, trained: 600, holdout: 30, random: 20, nudge: 12, shuffle: 10, proof: 6 } as FarmSave['funnel'], survivors: [fake('old', 2.2, ['tsmom'])], population: [], seen: [], startedAt: 1, recent: [] };
    const farm = new Farm(save.cfg, { seed: 1, save: JSON.parse(JSON.stringify(save)) });
    expect(farm.survivors[0].sig).toBe(false);
    expect(farm.survivors[0].p!).toBeCloseTo(0.0139, 3);
    const st = farm.state(false);
    expect(st.funnel.steady).toBe(0);
    expect(st.funnel.proof).toBe(0);
    // (that save did not count kinds: its 600 gauntlet entrants stand in for them)
    expect(st.kinds).toBe(600);
    expect(st.top.map((s) => s.id)).toEqual(['old']);
    expect(st.top[0].sig).toBe(false);
    expect(farm.save().v).toBe(3);
  });

  it('the team: survivors that fit together, weighted by risk — never two of a kind, never two that move as one', () => {
    const g = gauss(rngOf(5));
    // noise with exactly the mean asked for (the draws' own average is taken out)
    const series = (mu: number, sd: number) => {
      const e = Array.from({ length: 120 }, () => g());
      const m = e.reduce((a, b) => a + b, 0) / e.length;
      return e.map((x) => mu + sd * (x - m));
    };
    const A = series(0.002, 0.01);
    const B = series(0.004, 0.02);
    const C = A.map((x) => x * 1.01 + 0.00001 * g());
    const D = series(-0.001, 0.01);
    const farm = new Farm({ coins: ['BTC'], styles: ['intraday'] }, { seed: 1 });
    const d = (r: number[], d0 = 20_000) => ({ daily: { d0, r } });
    farm.survivors = [
      fake('a', 3, ['tsmom'], { ...d(A), score: 3 }),
      fake('b', 3, ['zrev'], { ...d(B, 20_010), score: 2 }),
      fake('c', 3, ['donchian'], { ...d(C), score: 2.5 }),
      fake('d', 3, ['macd'], { ...d(D), score: 1 }),
      fake('twin', 3, ['tsmom'], { ...d(series(0.0003, 0.01)), score: 1.5, flow: flow({ strategies: ['tsmom'], stopWidth: 'wide' }) }),
      fake('gone', 3, ['rsi2'], { ...d(series(0.004, 0.01)), score: 9, stage: 'faded' }),
    ];
    const t = farm.team()!;
    const ids = t.members.map((m) => m.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    // c moves with a; d loses; the twin is the same family as a; the faded one is out
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
    expect(ids).not.toContain('twin');
    expect(ids).not.toContain('gone');
    // inverse volatility: a (half as volatile) carries about two thirds
    const wa = t.members.find((m) => m.id === 'a')!.weight;
    expect(wa).toBeGreaterThan(0.55);
    expect(wa).toBeLessThan(0.75);
    expect(t.members.reduce((x, m) => x + m.weight, 0)).toBeCloseTo(1, 6);
    // together they beat the best of them alone, on the days both have
    expect(t.sharpe).toBeGreaterThan(t.solo.sharpe);
    expect(t.days).toBe(110);
    expect(Math.abs(t.corr)).toBeLessThan(0.4);
    expect(farm.state(false).team!.members.length).toBe(t.members.length);
    // one survivor is no team
    farm.survivors = farm.survivors.slice(0, 1);
    // (the team is worked out once a minute; asked for afresh here)
    expect(farm.team()).not.toBeNull();
    expect(farm.team(true)).toBeNull();
  });

  it('daily returns from bar returns', () => {
    const t0 = Date.UTC(2025, 0, 1);
    const times = Array.from({ length: 72 }, (_, i) => t0 + i * HOUR);
    const d = dailyOf(times.map(() => 0.001), times)!;
    expect(d.d0).toBe(Math.floor(t0 / 86_400_000));
    expect(d.r).toEqual([0.024, 0.024, 0.024]);
    expect(dailyOf([], [])).toBeUndefined();
  });
});

describe('the farm learns which blocks work', () => {
  it('blocks that keep passing are drawn more often, ones that never do less — but never dropped', () => {
    const save: FarmSave = { v: 2, cfg: { coins: ['BTC', 'ETH'], styles: ['intraday'], sides: 'both', pace: 'gentle', maxDD: 0.2 }, gen: 1, tried: 400, funnel: { bred: 400, trained: 60, holdout: 0, steady: 0, costs: 0, random: 0, nudge: 0, shuffle: 0, vault: 0, proof: 0 }, survivors: [], population: [], seen: [], startedAt: 1, recent: [], stats: { 'strategy:tsmom': [120, 50, 4], 'strategy:zrev': [120, 0, 0], 'strategy:donchian': [3, 1, 0] } };
    const farm = new Farm(save.cfg, { seed: 11, save });
    farm.setMarkets(trending());
    const count: Record<string, number> = {};
    for (let i = 0; i < 600; i++) for (const id of farm.randomFlow()!.strategies) count[id] = (count[id] ?? 0) + 1;
    expect(count.tsmom).toBeGreaterThan(4 * count.zrev);
    expect(count.zrev).toBeGreaterThan(0);
    const blocks = farm.blocks();
    expect(blocks[0]).toMatchObject({ id: 'tsmom', kind: 'strategy', tried: 120, passed: 50, survived: 4 });
    // too few tries, or nothing passed: not listed yet
    expect(blocks.some((b) => b.id === 'zrev' || b.id === 'donchian')).toBe(false);
  });

  it('running it fills the block table, the niches and the overfit meter, and all of it survives a restart', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 4 });
    farm.setMarkets(trending());
    for (let i = 0; i < 260; i++) farm.step();
    const st = farm.state(true);
    expect(st.blocks!.length).toBeGreaterThan(2);
    for (const b of st.blocks!) expect(b.passed).toBeLessThanOrEqual(b.tried);
    expect(st.niches!).toBeGreaterThan(5);
    expect(st.pbo).not.toBeNull();
    // where there IS an edge to find, the best bot in training usually stays ahead on other data
    expect(st.pbo!, `pbo ${st.pbo}`).toBeLessThan(0.4);
    const again = new Farm(st.cfg, { seed: 5, save: JSON.parse(JSON.stringify(farm.save())) });
    again.setMarkets(trending());
    const st2 = again.state(false);
    expect(st2.blocks).toEqual(st.blocks);
    expect(st2.niches).toBe(Math.min(80, st.niches!));
    expect(st2.pbo).toBeCloseTo(st.pbo!, 9);
  }, 120_000);
});

describe('the vault: the most recent candles, which nothing is bred or checked on', () => {
  const tsmom = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail' });
  /** the same markets with the vault's candles (the last 15 %) replaced by something else entirely */
  const otherVault = (): Record<string, Market[]> => {
    const cut = Math.floor(6000 * (1 - VAULT));
    return { '1h': trending()['1h'].map((m) => ({ ...m, bars: m.bars.map((b, i) => (i >= cut ? { ...b, open: b.open * 0.5, high: b.high * 0.55, low: b.low * 0.45, close: b.close * 0.5 } : b)) })) };
  };

  it('training and every check of the gauntlet read nothing from the vault: another vault, the same results', () => {
    const a = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    const b = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    a.setMarkets(trending());
    b.setMarkets(otherVault());
    const ta = a.train(tsmom);
    const tb = b.train(tsmom);
    expect(tb.fit).toBe(ta.fit);
    const ga = a.gauntlet(tsmom, ta.is!);
    const gb = b.gauntlet(tsmom, tb.is!);
    expect(ga.ok).toBe(true);
    // the unseen 30 %, the random bots, the nudges and the shuffles came out the same …
    const part = (g: typeof ga) => (g.ok ? { oos: g.s.oos, beat: g.s.beat, nudge: g.s.nudge, mc: g.s.mc, checks: g.s.checks, seenTo: g.s.seenTo } : null);
    if (gb.ok) expect(part(gb)).toEqual(part(ga));
    // … only the vault's own verdict can differ
    if (!gb.ok) expect(gb.at).toBe('vault');
    else expect(gb.s.vault!.ret).not.toBe(ga.ok ? ga.s.vault!.ret : NaN);
  });

  it('a bot that loses in the vault is out, and its kind has had its one look', () => {
    // the trend the bot rides ends where the vault begins: after it, a choppy market
    const mk = (coin: string, seed: number): Market => {
      const h = gauss(rngOf(seed));
      let p = 100;
      let mu = 0;
      const bars = Array.from({ length: 6000 }, (_, i) => {
        mu = i < 5100 ? 0.997 * mu + 0.00045 * h() : 0;
        const o = p;
        p *= Math.exp(mu + (i < 5100 ? 0.005 : 0.009) * h());
        return { time: Date.UTC(2024, 0, 1) + i * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 };
      });
      return { coin, tfH: 1, bars, funding: null };
    };
    let out = 0;
    for (const [x, y] of [[13, 14], [23, 24]]) {
      const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
      farm.setMarkets({ '1h': [mk('BTC', x), mk('ETH', y)] });
      const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'r15', hold: 'half' });
      const t = farm.train(f);
      expect(t.fit).toBeGreaterThan(0.7);
      const g = farm.gauntlet(f, t.is!);
      expect(g.ok).toBe(false);
      if (g.ok) continue;
      expect(g.at).toBe('vault');
      expect(g.why).toMatch(/lost [\d.]+ % over \d+ trades in the vault/);
      out++;
      // through the farm's own loop the kind is ruled out: a copy with another stop is not tested again
      expect(farm.taken(f)).toBe(false);
      (farm as unknown as { runGauntlet: (g: unknown) => unknown }).runGauntlet({ flow: f, key: farmKey(f), fit: t.fit, done: true, is: t.is });
      expect(farm.taken(f)).toBe(true);
      expect(farm.taken({ ...f, stopWidth: 'wide' })).toBe(true);
      expect(farm.taken({ ...f, strategies: ['donchian'] })).toBe(false);
      const st = farm.state(false);
      // it passed everything before the vault, and is counted there
      expect(st.funnel.shuffle).toBe(1);
      expect(st.funnel.vault).toBe(0);
      expect(st.survivors).toBe(0);
      expect(st.recent[0]).toMatchObject({ at: 'vault' });
      // and the ruling survives a restart
      expect(new Farm(st.cfg, { seed: 3, save: JSON.parse(JSON.stringify(farm.save())) }).taken(f)).toBe(true);
    }
    expect(out).toBe(2);
  }, 60_000);
});

describe('one survivor of a kind, and steady lists', () => {
  it('copies of a kind that already holds its place are not tested again; every survivor is a different kind', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 4 });
    farm.setMarkets(trending());
    for (let i = 0; i < 600; i++) farm.step();
    const st = farm.state(true);
    expect(st.survivors).toBeGreaterThan(3);
    const kinds = farm.survivors.map((s) => farmKind(s.flow));
    expect(new Set(kinds).size).toBe(kinds.length);
    // in this market most bots that train well are copies of a kind already held: they are skipped, not put through the gauntlet
    expect(st.dupes!).toBeGreaterThan(0);
    expect(st.kinds!).toBeLessThanOrEqual(st.funnel.trained);
    for (const s of farm.survivors) expect(farm.taken(s.flow)).toBe(true);
    expect(farm.taken({ ...farm.survivors[0].flow, stopWidth: farm.survivors[0].flow.stopWidth === 'wide' ? 'normal' : 'wide' })).toBe(true);
    // far more of the work now goes into new ideas: the gauntlet ran for at most a bot of each kind that survived, plus those that failed
    expect(st.funnel.vault).toBeGreaterThanOrEqual(farm.survivors.length);
    expect(farm.survivors.filter((x) => x.stage !== 'faded').length).toBeLessThanOrEqual(40);
  }, 120_000);

  it('each pace has its own population and its own top five', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['scalp', 'intraday'] }, { seed: 6 });
    farm.setMarkets(trending());
    for (let i = 0; i < 700; i++) farm.step();
    const st = farm.state(true);
    expect(st.tops!.map((b) => b.id)).toEqual(['scalp', 'intraday']);
    for (const b of st.tops!) {
      expect(b.rows.length).toBeGreaterThan(0);
      expect(b.rows.length).toBeLessThanOrEqual(5);
      for (const r of b.rows) expect(paceIdOf(r.style)).toBe(b.id);
      expect(b.live).toBeGreaterThanOrEqual(b.rows.length);
    }
    // two populations of forty, bred side by side
    expect(st.population).toBe(80);
    expect(PACES.map((p) => p.id)).toEqual(['scalp', 'intraday', 'swing', 'position']);
    // the overall five are drawn from the paces' own
    const ids = new Set(st.tops!.flatMap((b) => b.rows.map((r) => r.id)));
    for (const s of st.top) expect(ids.has(s.id)).toBe(true);
  }, 120_000);

  it('the lists hold still: they are worked out on a clock, and a listed strategy keeps its place unless a newcomer is clearly better', () => {
    let now = 1_000_000;
    const farm = new Farm({ coins: ['BTC'], styles: ['intraday'] }, { seed: 1, now: () => now });
    const fake = (id: string, score: number, strategies: string[], extra: Partial<Survivor> = {}): Survivor =>
      ({ id, key: id, flow: flow({ strategies }), name: id, style: 'intraday', tfH: 1, coins: ['BTC'], foundAt: 0, seenTo: 0, is: { sharpe: 2 }, oos: { sharpe: 2, trades: 40, t: 1, maxDD: 0.05 }, beat: 90, nudge: { kept: 8, tried: 10 }, mc: { dd95: 0.1, pLoss: 0.1 }, periods: { unit: 'month', list: [], up: 1, worst: 0, avg: 0 }, dsr: 0.9, tried: 1, score, forward: null, stage: 'incubating', summary: [], sig: false, curve: [], split: 0, ...extra }) as unknown as Survivor;
    const five = ['tsmom', 'donchian', 'zrev', 'macd', 'rsi2'].map((x, i) => fake(`s${i}`, 2 - i * 0.1, [x]));
    farm.survivors = [...five];
    const ids = () => farm.tops()[0].rows.map((r) => r.id);
    expect(ids()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    // a newcomer a little better than the fifth arrives: nothing moves, however often the screen asks
    farm.survivors.push(fake('n1', 1.65, ['tma']));
    for (let i = 0; i < 20; i++) {
      now += 1000;
      expect(ids()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    }
    // after the clock comes round it is still not enough: 1.65 against 1.6 is within the listed one's margin
    now += 20_000;
    expect(ids()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    // one that is clearly better does take a place, at the next round
    farm.survivors.push(fake('n2', 2.6, ['vsmom']));
    expect(ids()).toEqual(['s0', 's1', 's2', 's3', 's4']);
    now += 20_000;
    expect(ids()).toEqual(['n2', 's0', 's1', 's2', 's3']);
    // one further up the ladder goes first, whatever its score — and fresh candles are shown at once
    farm.survivors.push(fake('p', 0.5, ['kalman'], { stage: 'proven' }));
    farm.setMarkets({});
    expect(ids()[0]).toBe('p');
    // a listed strategy that fades leaves at once
    farm.survivors.find((s) => s.id === 'n2')!.stage = 'faded';
    expect(ids()).not.toContain('n2');
    expect(ids().length).toBe(5);
  });

  it('a pace keeps forty standing at most: those with the most behind them stay', () => {
    const farm = new Farm({ coins: ['BTC'], styles: ['intraday'] }, { seed: 1 });
    const names = ['tsmom', 'donchian', 'zrev', 'macd', 'rsi2', 'tma', 'vsmom', 'kalman', 'bbreak', 'ou'];
    const save: FarmSave = { v: 3, cfg: farm.cfg, gen: 1, tried: 1, funnel: farm.funnel, survivors: [], population: [], seen: [], startedAt: 1, recent: [], entered: [] };
    // 50 kinds: every pair of two strategies
    let k = 0;
    for (let i = 0; i < names.length && k < 50; i++)
      for (let j = i + 1; j < names.length && k < 50; j++, k++)
        save.survivors.push({ id: `s${k}`, key: `s${k}`, flow: flow({ strategies: [names[i], names[j]] }), name: `s${k}`, style: 'intraday', tfH: 1, coins: ['BTC'], foundAt: k, seenTo: 0, is: { sharpe: 2 }, oos: { sharpe: 2, trades: 40, t: 1, maxDD: 0.05 }, beat: 90, nudge: { kept: 8, tried: 10 }, mc: { dd95: 0.1, pLoss: 0.1 }, periods: { unit: 'month', list: [], up: 1, worst: 0, avg: 0 }, dsr: 0.9, tried: 1, score: k, forward: null, stage: k < 3 ? 'proving' : 'incubating', summary: [], sig: false, curve: [], split: 0 } as unknown as Survivor);
    // and a copy of a kind already there, from a save made before kinds were kept one each
    save.survivors.push({ ...save.survivors[0], id: 'copy', score: -5, stage: 'new' });
    const again = new Farm(save.cfg, { seed: 1, save });
    expect(again.survivors.some((s) => s.id === 'copy')).toBe(false);
    again.setMarkets({});
    expect(again.survivors.length).toBe(40);
    // the three that are proving stay, though their scores are the lowest
    for (const id of ['s0', 's1', 's2']) expect(again.survivors.some((s) => s.id === id)).toBe(true);
    expect(again.survivors.some((s) => s.id === 's3')).toBe(false);
  });
});

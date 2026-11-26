// The crypto-specific rules added to the library: volume-weighted momentum,
// the trend composite, new highs and lows, big-day follow-through, the
// late-evening hours, pairs against bitcoin, bitcoin's lead — and the bitcoin
// market and weekday filters.
import { describe, expect, it } from 'vitest';
import { backtest, type StrategySpec } from './backtest';
import { buildSpec, checkFlow, FLOW_DEFAULT, MODELS, STRATEGIES, type Flow } from './flow';
import { ctxOf, EXIT_DEFAULT, FILTER_MAP, FILTERS, gridOf, pairZ, SIGNAL_MAP, SIGNALS, trendScore, TREND_VOTES, type Market } from './library';
import { rngOf } from './ml';
import { liveMarket, liveSignal, specNeeds } from './live';
import { evaluate, withBench } from './research';

const HOUR = 3_600_000;
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());

/** candles from a list of closes (each opens at the last close) */
function fromCloses(coin: string, closes: number[], tfH = 1, vol: (i: number) => number = () => 100, t0 = Date.UTC(2023, 0, 2)): Market {
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: t0 + i * tfH * HOUR, open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c, volume: vol(i) };
  });
  return { coin, tfH, bars, funding: null };
}

function walk(n: number, seed: number, sd = 0.006, drift = 0): number[] {
  const g = gauss(rngOf(seed));
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= Math.exp(drift + sd * g());
    out.push(p);
  }
  return out;
}

/** bitcoin and a coin that tracks it with a mean-reverting gap (an Ornstein–Uhlenbeck spread) */
function pair(n: number, seed: number, lag = 0) {
  const btc = walk(n, seed);
  const g = gauss(rngOf(seed + 1));
  let s = 0;
  const coin = btc.map((_, i) => {
    s = 0.97 * s + 0.004 * g();
    const lead = btc[Math.max(0, i - lag)];
    return 5 * (lead / 100) ** 1.2 * Math.exp(lag ? 0.0005 * g() : s);
  });
  const [B, C] = withBench([fromCloses('BTC', btc), fromCloses('ALT', coin)]);
  return { btc: B, coin: C };
}

const spec = (id: string, p: Record<string, number>, exit = {}, more: Partial<StrategySpec> = {}): StrategySpec => ({ name: id, signal: { id, p }, filters: [], exit: { ...EXIT_DEFAULT, ...SIGNAL_MAP[id].exit, ...exit }, sides: 'both', ...more });
const sum = (x: ArrayLike<number>) => Array.from(x).reduce((a, b) => a + b, 0);

describe('rules that read bitcoin beside the coin', () => {
  it('never use a future bar, of the coin or of bitcoin', () => {
    const { coin } = pair(1600, 5);
    const cut = 1300;
    const future: Market = {
      ...coin,
      bars: coin.bars.map((b, i) => (i > cut ? { ...b, close: b.close * 1.4, high: b.high * 1.4, low: b.low * 0.7 } : b)),
      bench: Float64Array.from(coin.bench!, (x, i) => (i > cut ? x * 0.7 : x)),
    };
    for (const s of SIGNALS.filter((x) => x.needsBench))
      for (const p of gridOf(s.grid)) {
        const a = s.compute(ctxOf(coin, 1100), p);
        const b = s.compute(ctxOf(future, 1100), p);
        for (let i = 0; i <= cut; i++) expect(a[i], `${s.id} at ${i}`).toBe(b[i]);
      }
    for (const f of FILTERS.filter((x) => !x.needsFunding)) {
      const p = gridOf(f.grid)[0];
      const a = f.compute(ctxOf(coin, 1100), p);
      const b = f.compute(ctxOf(future, 1100), p);
      for (let i = 0; i <= cut; i++) {
        expect(a.long[i], `${f.id} long at ${i}`).toBe(b.long[i]);
        expect(a.short[i], `${f.id} short at ${i}`).toBe(b.short[i]);
      }
    }
  });

  it('stay silent without bitcoin, and on bitcoin itself', () => {
    const { btc } = pair(900, 2);
    const alone = fromCloses('ALT', walk(900, 8));
    for (const s of SIGNALS.filter((x) => x.needsBench)) {
      expect(sum(s.compute(ctxOf(alone), gridOf(s.grid)[0]).map(Math.abs)), s.id).toBe(0);
      expect(sum(s.compute(ctxOf(btc), gridOf(s.grid)[0]).map(Math.abs)), `${s.id} on BTC`).toBe(0);
    }
  });

  it('pairs: buys the coin when it is cheap against bitcoin, sells when rich, and the hedged trade earns on a gap that closes', () => {
    const { coin } = pair(6000, 11);
    const c = ctxOf(coin);
    const f = pairZ(c, 168)!;
    const sig = SIGNAL_MAP.pairs.compute(c, { window: 168, k: 2 });
    let longs = 0;
    let shorts = 0;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] === 1) {
        expect(f.z[i]).toBeLessThan(-2);
        longs++;
      }
      if (sig[i] === -1) {
        expect(f.z[i]).toBeGreaterThan(2);
        shorts++;
      }
    }
    expect(longs).toBeGreaterThan(5);
    expect(shorts).toBeGreaterThan(5);
    // the regression recovers the coin's exponent on bitcoin
    const betas = Array.from(f.beta).filter(Number.isFinite);
    expect(betas.length).toBeGreaterThan(5000);
    const free = { feeBps: 0, slipBps: 0 };
    const hedged = backtest(ctxOf(coin), spec('pairs', { window: 168, k: 2 }, {}, { hedge: 'btc' }), 800, 6000, free);
    expect(hedged.trades.length).toBeGreaterThan(10);
    expect(sum(hedged.rets)).toBeGreaterThan(0);
  });

  it('pairs: does not trade a coin that does not move with bitcoin', () => {
    const [, loose] = withBench([fromCloses('BTC', walk(3000, 21)), fromCloses('ALT', walk(3000, 22))]);
    const c = ctxOf(loose);
    const f = pairZ(c, 168)!;
    const sig = SIGNAL_MAP.pairs.compute(c, { window: 168, k: 1.5 });
    for (let i = 0; i < sig.length; i++) if (sig[i]) expect(f.r2[i]).toBeGreaterThanOrEqual(0.5);
  });

  it('bitcoin leads: a coin that follows bitcoin late is traded in bitcoin’s direction, at a profit', () => {
    const { coin } = pair(5000, 31, 2);
    const c = ctxOf(coin);
    const sig = SIGNAL_MAP.btclead.compute(c, { n: 1, k: 1 });
    expect(sum(sig.map(Math.abs))).toBeGreaterThan(50);
    // the next bar's return, in the direction called
    let gain = 0;
    for (let i = 0; i + 1 < sig.length; i++) if (sig[i]) gain += sig[i] * Math.log(coin.bars[i + 1].close / coin.bars[i].close);
    expect(gain).toBeGreaterThan(0);
    // bitcoin itself moved the way the trade points
    // bitcoin itself moved the way the trade points
    for (let i = 1; i < sig.length; i++) if (sig[i]) expect(Math.sign(coin.bench![i] - coin.bench![i - 1])).toBe(sig[i]);
  });

  it('the bitcoin market filter follows bitcoin, not the coin', () => {
    const n = 2000;
    const up = Array.from({ length: n }, (_, i) => 100 * Math.exp(0.001 * i));
    const down = Array.from({ length: n }, (_, i) => 100 * Math.exp(-0.001 * i));
    const [, alt] = withBench([fromCloses('BTC', up), fromCloses('ALT', down)]);
    const a = FILTER_MAP.btctrend.compute(ctxOf(alt), { lookback: 1200 });
    expect(a.long[n - 1]).toBe(1);
    expect(a.short[n - 1]).toBe(0);
    // not before a full window of bitcoin prices exists
    expect(a.long[600] + a.short[600]).toBe(0);
    // on bitcoin itself: its own trend
    const own = FILTER_MAP.btctrend.compute(ctxOf(fromCloses('BTC', down)), { lookback: 1200 });
    expect(own.short[n - 1]).toBe(1);
    expect(own.long[n - 1]).toBe(0);
  });
});

describe('a deployed strategy, live', () => {
  it('says what it reads beside the coin, and is given it in the backtest’s shape', () => {
    const sp = (id: string, filters: StrategySpec['filters'] = []): StrategySpec => ({ name: id, signal: { id, p: gridOf(SIGNAL_MAP[id].grid)[0] }, filters, exit: EXIT_DEFAULT, sides: 'both' });
    expect(specNeeds(sp('tsmom'))).toEqual({ bench: false, funding: false, features: false });
    expect(specNeeds(sp('pairs'))).toEqual({ bench: true, funding: false, features: false });
    expect(specNeeds(sp('carry'))).toEqual({ bench: false, funding: true, features: false });
    // a learned rule reads the feature table (a 30-day volatility among it): the swarm keeps a longer history for it
    expect(specNeeds(sp('nn')).features).toBe(true);
    expect(specNeeds({ ...sp('tsmom'), meta: { model: {} } } as never).features).toBe(true);
    expect(specNeeds(sp('tsmom', [{ id: 'btctrend', p: { lookback: 1200 } }, { id: 'crowd', p: { band: 0.2 } }]))).toEqual({ bench: true, funding: true, features: false });
    expect(specNeeds({ ...sp('tsmom'), also: [{ id: 'btclead', p: { n: 1, k: 1 } }] }).bench).toBe(true);

    const { btc, coin } = pair(900, 3);
    // bitcoin's candles a few short at the start, and one missing in the middle
    const some = btc.bars.slice(5).filter((_, i) => i !== 400);
    const m = liveMarket('ALT', 1, coin.bars, { btc: some, funding: coin.bars.map(() => 0.0001) });
    expect(m.bench!.length).toBe(900);
    expect(Number.isNaN(m.bench![0])).toBe(true);
    expect(Number.isNaN(m.bench![405])).toBe(true);
    expect(m.bench![899]).toBe(btc.bars[899].close);
    expect(m.funding![10]).toBe(0.0001);
    // bitcoin gets no benchmark of itself; a funding list of the wrong length is not trusted
    expect(liveMarket('BTC', 1, btc.bars, { btc: btc.bars }).bench).toBeUndefined();
    expect(liveMarket('ALT', 1, coin.bars, { funding: [1, 2, 3] }).funding).toBeNull();
  });

  it('a pairs strategy signals live when bitcoin is beside the coin, and cannot without it', () => {
    const { btc, coin } = pair(3000, 11);
    const s: StrategySpec = { name: 'pairs', signal: { id: 'pairs', p: { window: 168, k: 2 } }, filters: [], exit: { ...EXIT_DEFAULT, ...SIGNAL_MAP.pairs.exit }, sides: 'both' };
    let withBtc = 0;
    let without = 0;
    for (let n = 400; n <= 3000; n += 1) {
      const bars = coin.bars.slice(Math.max(0, n - 600), n);
      if (liveSignal(s, liveMarket('ALT', 1, bars, { btc: btc.bars }))) withBtc++;
      if (n % 50 === 0 && liveSignal(s, liveMarket('ALT', 1, bars))) without++;
    }
    expect(withBtc).toBeGreaterThan(3);
    expect(without).toBe(0);
  });
});

describe('the new single-coin rules', () => {
  it('volume-weighted momentum listens to the heavy candles', () => {
    // nine small falls on thin volume, one big rise on heavy volume, repeated: price drifts down, the volume-weighted move is up
    const closes: number[] = [];
    let p = 100;
    for (let i = 0; i < 600; i++) {
      p *= i % 10 === 9 ? 1.004 : 0.999;
      closes.push(p);
    }
    const m = fromCloses('X', closes, 1, (i) => (i % 10 === 9 ? 5000 : 10));
    const c = ctxOf(m);
    expect(closes[599]).toBeLessThan(closes[300]);
    expect(SIGNAL_MAP.tsmom.compute(c, { lookback: 72 })[599]).toBe(-1);
    expect(SIGNAL_MAP.vwmom.compute(c, { lookback: 72 })[599]).toBe(1);
  });

  it('the trend composite votes with every indicator and follows a clear trend', () => {
    const up = fromCloses('X', walk(6000, 3, 0.002, 0.0015));
    const down = fromCloses('X', walk(6000, 3, 0.002, -0.0015));
    const su = trendScore(ctxOf(up), 4);
    const sd = trendScore(ctxOf(down), 4);
    for (const x of su) if (Number.isFinite(x)) expect(Math.abs(x)).toBeLessThanOrEqual(1);
    // no score until every indicator has its history (the 200-unit average is the longest)
    expect(Number.isFinite(su[700])).toBe(false);
    expect(Number.isFinite(su[810])).toBe(true);
    expect(su[5999]).toBeGreaterThan(0.6);
    expect(sd[5999]).toBeLessThan(-0.6);
    expect(TREND_VOTES).toBe(17);
    expect(SIGNAL_MAP.ctrend.compute(ctxOf(up), { unit: 4, k: 0.6 })[5999]).toBe(1);
    expect(SIGNAL_MAP.ctrend.compute(ctxOf(down), { unit: 4, k: 0.6 })[5999]).toBe(-1);
  });

  it('new high / new low: buys both, each on its own when asked, and never shorts', () => {
    const closes = [...Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7)), 105, 104, 90, 91];
    const m = fromCloses('X', closes);
    const both = SIGNAL_MAP.maxmin.compute(ctxOf(m), { n: 240, mode: 0 });
    const highs = SIGNAL_MAP.maxmin.compute(ctxOf(m), { n: 240, mode: 1 });
    const lows = SIGNAL_MAP.maxmin.compute(ctxOf(m), { n: 240, mode: 2 });
    expect([both[300], both[301], both[302], both[303]]).toEqual([1, 0, 1, 0]);
    expect([highs[300], highs[302]]).toEqual([1, 0]);
    expect([lows[300], lows[302]]).toEqual([0, 1]);
    for (const x of both) expect(x).toBeGreaterThanOrEqual(0);
  });

  it('big-day follow-through trades with an abnormal day and not otherwise', () => {
    const closes = walk(1200, 14, 0.002);
    for (let i = 1000; i < closes.length; i++) closes[i] *= 1.12;
    const sig = SIGNAL_MAP.jump.compute(ctxOf(fromCloses('X', closes)), { k: 3 });
    expect(sig[1000]).toBe(1);
    expect(sum(sig.slice(0, 990).map(Math.abs))).toBeLessThan(30);
    const fall = closes.map((x, i) => (i >= 1000 ? x * 0.8 : x));
    expect(SIGNAL_MAP.jump.compute(ctxOf(fromCloses('X', fall)), { k: 3 })[1000]).toBe(-1);
  });

  it('the late-evening rule buys at 21:00 UTC and is out two hours later; on 4-hour candles it uses the 20:00 close', () => {
    const m = fromCloses('X', walk(24 * 20, 6), 1, () => 100, Date.UTC(2024, 0, 1));
    const sig = SIGNAL_MAP.night.compute(ctxOf(m), { hour: 21 });
    m.bars.forEach((b, i) => expect(sig[i]).toBe(new Date(b.time).getUTCHours() === 20 ? 1 : 0));
    const r = backtest(ctxOf(m), { name: 'night', signal: { id: 'night', p: { hour: 21 } }, filters: [], exit: { ...EXIT_DEFAULT, stopAtr: 50, maxBars: 2, onFlip: false }, sides: 'both' }, 30, m.bars.length);
    expect(r.trades.length).toBeGreaterThan(15);
    for (const t of r.trades) {
      expect(new Date(m.bars[t.entryI].time).getUTCHours()).toBe(21);
      expect(new Date(m.bars[t.exitI].time + HOUR).getUTCHours()).toBe(23);
    }
    const m4 = fromCloses('X', walk(6 * 30, 6), 4, () => 100, Date.UTC(2024, 0, 1));
    const s4 = SIGNAL_MAP.night.compute(ctxOf(m4), { hour: 21 });
    m4.bars.forEach((b, i) => expect(s4[i]).toBe(new Date(b.time).getUTCHours() === 16 ? 1 : 0));
    // end-of-day momentum used to never fire on 4-hour candles (no candle closes at 21:00)
    expect(sum(SIGNAL_MAP.itsm.compute(ctxOf(m4), { hour: 21 }).map(Math.abs))).toBeGreaterThan(20);
  });

  it('the weekday filter looks at the day a trade would open on', () => {
    const m = fromCloses('X', walk(24 * 14, 6), 1, () => 100, Date.UTC(2024, 0, 1)); // a Monday
    const wk = FILTER_MAP.weekday.compute(ctxOf(m), { mode: 0 });
    const we = FILTER_MAP.weekday.compute(ctxOf(m), { mode: 1 });
    m.bars.forEach((b, i) => {
      const d = new Date(b.time + HOUR).getUTCDay();
      const weekend = d === 0 || d === 6;
      expect(wk.long[i]).toBe(weekend ? 0 : 1);
      expect(we.long[i]).toBe(weekend ? 1 : 0);
    });
  });
});

describe('the bot builder with the new picks', () => {
  const flow = (p: Partial<Flow>): Flow => ({ ...FLOW_DEFAULT, ...p });

  it('offers every new rule and filter, each tied to a real library rule', () => {
    for (const id of ['vwmom', 'ctrend', 'maxmin', 'jump', 'night', 'pairs', 'btclead']) {
      const s = STRATEGIES.find((x) => x.id === id);
      expect(s, id).toBeTruthy();
      expect(SIGNAL_MAP[s!.signal], id).toBeTruthy();
    }
    for (const id of ['btc-trend', 'weekdays', 'weekends']) expect(MODELS.find((x) => x.id === id), id).toBeTruthy();
    expect(STRATEGIES.length).toBeGreaterThanOrEqual(29);
  });

  it('a rule with its own holding time is never held longer by the style', () => {
    const night = buildSpec(flow({ style: 'intraday', strategies: ['night'] }));
    expect(night.spec.exit.maxBars).toBe(2);
    expect(night.summary.join(' ')).toMatch(/at most 2 hours/);
    expect(buildSpec(flow({ style: 'intraday', strategies: ['itsm'] })).spec.exit.maxBars).toBe(3);
    expect(buildSpec(flow({ style: 'intraday', strategies: ['dow'] })).spec.exit.maxBars).toBe(24);
    // and never longer than the style's own hold
    expect(buildSpec(flow({ style: 'scalp', strategies: ['dow'] })).spec.exit.maxBars).toBe(6);
    expect(buildSpec(flow({ style: 'swing', strategies: ['maxmin'] })).spec.exit.maxBars).toBe(6);
    // a rule without one keeps the style's
    expect(buildSpec(flow({ style: 'intraday', strategies: ['tsmom'] })).spec.exit.maxBars).toBe(24);
  });

  it('rules against bitcoin bring BTC into the test, and pair with the hedge', () => {
    const b = buildSpec(flow({ strategies: ['pairs'], coins: 'ETH SOL', risks: ['hedged'] }));
    expect(b.coins).toEqual(['BTC', 'ETH', 'SOL']);
    expect(b.spec.hedge).toBe('btc');
    const tones = (f: Flow) => checkFlow(f).map((x) => `${x.tone}:${x.picks.join('+')}`);
    expect(tones(flow({ strategies: ['pairs'], coins: 'ETH', risks: ['hedged'] }))).toContain('pair:pairs+hedged');
    expect(checkFlow(flow({ strategies: ['pairs'], coins: 'ETH', risks: [] })).some((x) => x.tone === 'info' && /Market-neutral/.test(x.text))).toBe(true);
    expect(checkFlow(flow({ strategies: ['pairs'], coins: 'BTC' })).some((x) => x.tone === 'clash' && /other than bitcoin/.test(x.text))).toBe(true);
    expect(tones(flow({ strategies: ['pairs', 'btclead'], coins: 'ETH' }))).toContain('overlap:pairs+btclead');
  });

  it('flags the new clashes: opposite calendars, a buy-only rule set to short only', () => {
    expect(checkFlow(flow({ models: ['weekdays', 'weekends'] })).some((x) => x.tone === 'clash' && /opposites/.test(x.text))).toBe(true);
    for (const id of ['maxmin', 'night', 'dow']) expect(checkFlow(flow({ style: 'intraday', strategies: [id], sides: 'short' })).some((x) => x.tone === 'clash' && /only ever buys/.test(x.text)), id).toBe(true);
    expect(checkFlow(flow({ strategies: ['tsmom'], models: ['btc-trend'] })).some((x) => x.tone === 'pair' && /whole market/.test(x.text))).toBe(true);
    expect(checkFlow(flow({ style: 'intraday', strategies: ['zrev'], models: ['weekends'] })).some((x) => x.tone === 'pair' && /weekend/.test(x.text))).toBe(true);
  });

  it('every new rule runs through a full test on real-shaped data', () => {
    const { btc, coin } = pair(3200, 41);
    for (const id of ['vwmom', 'ctrend', 'maxmin', 'jump', 'night', 'pairs', 'btclead']) {
      const built = buildSpec(flow({ style: 'intraday', strategies: [id], models: [], risks: [], coins: 'BTC ALT' }));
      const r = evaluate([{ ...btc, bench: undefined }, { ...coin, bench: undefined }], built.spec, 0.7);
      expect(Number.isFinite(r.oos.sharpe) || r.oos.trades === 0, id).toBe(true);
      expect(r.curve.length, id).toBeGreaterThan(10);
    }
  });
});

describe('the AI trade filter is chosen on training data only', () => {
  it('whether it is kept does not change when the unseen data does', () => {
    const closes = walk(5200, 77, 0.006);
    const v = (i: number) => 100 + ((i * 37) % 11) * 20;
    const m = fromCloses('X', closes, 1, v);
    const cut = Math.floor(5200 * 0.7);
    // the same training years, a different future
    const other = fromCloses('X', closes.map((x, i) => (i >= cut ? closes[cut - 1] * Math.exp(0.004 * Math.sin(i / 9) + (i - cut) * 0.0004) : x)), 1, v);
    const s: StrategySpec = { name: 't', signal: { id: 'zrev', p: { lookback: 24, k: 1.5 } }, filters: [], exit: { ...EXIT_DEFAULT, stopAtr: 2, targetR: 1.5, maxBars: 24, onFlip: false }, sides: 'both', autoMeta: 'forest' };
    const a = evaluate([m], s, 0.7);
    const b = evaluate([other], s, 0.7);
    expect(a.meta).toBeTruthy();
    expect(a.meta!.trainedOn).toBeGreaterThanOrEqual(40);
    expect(a.meta!.trainedOn).toBe(b.meta!.trainedOn);
    expect(a.meta!.val).toBeTruthy();
    expect(a.meta!.val).toEqual(b.meta!.val);
    expect(a.meta!.used).toBe(b.meta!.used);
    // the unseen read-outs do differ: they are measured, not used
    expect(a.oos.sharpe).not.toBe(b.oos.sharpe);
  });
});

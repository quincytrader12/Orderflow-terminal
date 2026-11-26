// The high-frequency rules and the 5-minute pace: rules built for 1- and 5-minute candles
// (order-flow pressure, the quarter-hour opening, the US-open range, VWAP bands, the EMA
// pullback), each tested like every other rule — honest costs, no look at future candles.
import { describe, expect, it } from 'vitest';
import { backtest, COSTS, costsFor, type StrategySpec } from './backtest';
import { buildSpec, FLOW_DEFAULT, STRATEGIES, STYLE_MAP, type Flow } from './flow';
import { FARM_DEFAULTS, PACES, paceIdOf } from './farm';
import { ctxOf, nyHour, SIGNAL_MAP, type Market } from './library';
import { PAPERS } from './papers';
import { rngOf } from './ml';

const MIN = 60_000;
const NEW = ['ofi', 'qhour', 'nyorb5', 'vwapband', 'emapull'];
// Monday 2 November 2026, 00:00 UTC
const T0 = Date.UTC(2026, 10, 2);

/** a market of `n` candles of `mins` minutes: drifting regimes, volume heavier on bigger moves */
function mkt(n: number, mins: number, seed = 5, coin = 'ETH'): Market {
  const r = rngOf(seed);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
  let p = 2000;
  let mu = 0;
  const s = 0.0009 * Math.sqrt(mins);
  const bars = Array.from({ length: n }, (_, i) => {
    mu = 0.99 * mu + 0.00012 * Math.sqrt(mins) * g();
    const o = p;
    const ret = mu + s * g();
    p *= Math.exp(ret);
    const w = Math.abs(ret) / s;
    return { time: T0 + i * mins * MIN, open: o, high: Math.max(o, p) * (1 + 0.3 * s * r()), low: Math.min(o, p) * (1 - 0.3 * s * r()), close: p, volume: 50 * (0.5 + w + r()) };
  });
  return { coin, tfH: mins / 60, bars, funding: null };
}

/** cutting the future off must not change the past */
function noLookAhead(m: Market, id: string, p: Record<string, number>, cut: number) {
  const full = SIGNAL_MAP[id].compute(ctxOf(m), p);
  const part = SIGNAL_MAP[id].compute(ctxOf({ ...m, bars: m.bars.slice(0, cut) }), p);
  for (let i = 0; i < cut; i++) if (part[i] !== full[i]) throw new Error(`${id} looks ahead at candle ${i}`);
}
const onsets = (x: Int8Array) => Array.from(x, (v, i) => (v !== 0 && v !== (x[i - 1] ?? 0) ? i : -1)).filter((i) => i >= 0);

describe('the high-frequency rules', () => {
  const m1 = mkt(14 * 1440, 1);
  const m5 = mkt(30 * 288, 5, 8);

  it('are in the library with their research, in the bot builder, and suit the scalping paces', () => {
    for (const id of NEW) {
      const sig = SIGNAL_MAP[id];
      expect(sig, id).toBeDefined();
      for (const pid of sig.papers) expect(PAPERS[pid], `${id} cites ${pid}`).toBeDefined();
      const opt = STRATEGIES.find((s) => s.id === id)!;
      expect(opt.signal).toBe(id);
      expect(opt.suits).toContain('scalp15');
    }
    expect(PAPERS.kh26.cite).toBe('Kim & Hansen (2026)');
  });

  it('never look at a future candle, on 1- or 5-minute candles', () => {
    for (const id of NEW) {
      const p = STRATEGIES.find((s) => s.id === id)!.params(STYLE_MAP.scalp1);
      noLookAhead(m1, id, p, 9000);
      noLookAhead(m5, id, STRATEGIES.find((s) => s.id === id)!.params(STYLE_MAP.scalp5), 6000);
    }
  });

  it('each one trades — and every test on 1- and 5-minute candles pays double slippage', () => {
    expect(costsFor(1 / 12, COSTS).slipBps).toBe(COSTS.slipBps * 2);
    for (const [style, m] of [['scalp1', m1], ['scalp5', m5]] as const) {
      for (const id of NEW) {
        const b = buildSpec({ ...FLOW_DEFAULT, style, coins: 'ETH', strategies: [id], models: [], risks: [] } as Flow);
        const r = backtest(ctxOf(m), b.spec as StrategySpec, 0, m.bars.length, COSTS);
        expect(r.trades.length, `${id} on ${style}`).toBeGreaterThan(id === 'nyorb5' ? 3 : 20);
        expect(r.trades.every((t) => Number.isFinite(t.ret)), id).toBe(true);
      }
    }
  });

  it('order-flow pressure follows a run of one-sided volume', () => {
    const m = mkt(3000, 1, 3);
    // twenty minutes of heavy buying: every candle up, on big volume
    for (let i = 2000; i < 2020; i++) {
      const b = m.bars[i];
      const o = m.bars[i - 1].close;
      const c = o * 1.002;
      m.bars[i] = { ...b, open: o, close: c, high: c * 1.0002, low: o * 0.9998, volume: 400 };
    }
    const s = SIGNAL_MAP.ofi.compute(ctxOf(m), { n: 15, th: 0.35 });
    expect(Array.from(s.slice(2010, 2020)).every((x) => x === 1)).toBe(true);
  });

  it('the quarter-hour rule only ever starts a trade at :00, :15, :30 or :45 — and has nothing to say on 15-minute or slower candles', () => {
    for (const m of [m1, m5]) {
      const s = SIGNAL_MAP.qhour.compute(ctxOf(m), { k: 1.5, hold: 4, vol: 0 });
      const on = onsets(s);
      expect(on.length).toBeGreaterThan(10);
      for (const i of on) expect(Math.round(m.bars[i].time / MIN) % 15).toBe(0);
    }
    const m15 = mkt(4000, 15);
    expect(Array.from(SIGNAL_MAP.qhour.compute(ctxOf(m15), { k: 1, hold: 4, vol: 0 })).every((x) => x === 0)).toBe(true);
    expect(SIGNAL_MAP.qhour.maxTfH).toBeCloseTo(1 / 12, 9);
  });

  it('the US-open range: trades start only after the opening minutes, before the US close, on weekdays', () => {
    for (const [m, mins] of [[m1, 5], [m5, 5], [m5, 15]] as const) {
      const s = SIGNAL_MAP.nyorb5.compute(ctxOf(m), { m: mins });
      const on = onsets(s);
      expect(on.length).toBeGreaterThan(3);
      for (const i of on) {
        const t = m.bars[i].time;
        const h = nyHour(t);
        expect(h * 60).toBeGreaterThanOrEqual(570 + mins - 1e-6);
        expect(h).toBeLessThan(16);
        const wd = new Date(t - 5 * 3_600_000).getUTCDay();
        expect(wd === 0 || wd === 6).toBe(false);
      }
      // at most one trade a day
      const days = on.map((i) => Math.floor((m.bars[i].time - 5 * 3_600_000) / 86_400_000));
      expect(new Set(days).size).toBe(days.length);
    }
    // a 5-minute range cannot be read off 15-minute candles
    expect(Array.from(SIGNAL_MAP.nyorb5.compute(ctxOf(mkt(3000, 15)), { m: 5 })).every((x) => x === 0)).toBe(true);
  });

  it('the VWAP band sells above the bands and buys below them, on a candle already turning back', () => {
    const s = SIGNAL_MAP.vwapband.compute(ctxOf(m1), { k: 2, conf: 1 });
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      if (!s[i]) continue;
      n++;
      const b = m1.bars[i];
      if (s[i] < 0) expect(b.close).toBeLessThan(b.open);
      else expect(b.close).toBeGreaterThan(b.open);
    }
    expect(n).toBeGreaterThan(20);
  });

  it('the EMA pullback only buys in an uptrend and sells in a downtrend', () => {
    const s = SIGNAL_MAP.emapull.compute(ctxOf(m1), { f: 9, s: 21 });
    const longs = Array.from(s).filter((x) => x === 1).length;
    const shorts = Array.from(s).filter((x) => x === -1).length;
    expect(longs).toBeGreaterThan(20);
    expect(shorts).toBeGreaterThan(20);
    expect(Array.from(SIGNAL_MAP.emapull.compute(ctxOf(m1), { f: 21, s: 21 })).every((x) => x === 0)).toBe(true);
  });
});

describe('the 5-minute pace', () => {
  it('is a scalping pace on 5-minute candles, four months of them, its picks like the 15-minute ones', () => {
    const s = STYLE_MAP.scalp5;
    expect(s.timeframe).toBe('5m');
    expect(s.tfH).toBeCloseTo(1 / 12, 9);
    expect(Math.round(s.years * 365)).toBe(120);
    expect(s.like).toBe('scalp15');
    expect(paceIdOf('scalp5')).toBe('scalp');
    expect(PACES.find((p) => p.id === 'scalp')!.styles).toEqual(['scalp1', 'scalp5', 'scalp15', 'scalp']);
  });

  it('the edge finder breeds on 1- and 5-minute candles unless told not to', () => {
    expect(FARM_DEFAULTS.styles).toContain('scalp1');
    expect(FARM_DEFAULTS.styles).toContain('scalp5');
  });
});

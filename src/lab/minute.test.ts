// The 1-minute pace: strategies bred and tested on 1-minute candles like every other pace, with
// costs that are honest at that speed (double slippage), and nothing in the pipeline that
// assumes hourly or 15-minute candles.
import { describe, expect, it } from 'vitest';
import { backtest, COSTS, costsFor, type StrategySpec } from './backtest';
import { buildSpec, FLOW_DEFAULT, STRATEGIES, STYLE_MAP, type Flow } from './flow';
import { Farm, PACES, paceIdOf } from './farm';
import { ctxOf, type Market } from './library';
import { rngOf } from './ml';

const MIN = 60_000;
function minuteMarket(coin: string, n: number, seed: number): Market {
  const r = rngOf(seed);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
  let p = 100;
  let mu = 0;
  const bars = Array.from({ length: n }, (_, i) => {
    mu = 0.995 * mu + 0.00008 * g();
    const o = p;
    p *= Math.exp(mu + 0.0008 * g());
    return { time: Date.UTC(2026, 9, 1) + i * MIN, open: o, high: Math.max(o, p) * 1.0003, low: Math.min(o, p) * 0.9997, close: p, volume: 10 + ((i * 7) % 13) };
  });
  return { coin, tfH: 1 / 60, bars, funding: null };
}

describe('the 1-minute pace', () => {
  it('is a scalping pace on 1-minute candles, thirty days of them, its picks like the 15-minute scalping ones', () => {
    const s = STYLE_MAP.scalp1;
    expect(s.timeframe).toBe('1m');
    expect(s.tfH).toBeCloseTo(1 / 60, 9);
    expect(Math.round(s.years * 365)).toBe(30);
    expect(s.like).toBe('scalp15');
    expect(paceIdOf('scalp1')).toBe('scalp');
    expect(PACES.find((p) => p.id === 'scalp')!.styles).toContain('scalp1');
  });

  it('charges double slippage on 1-minute candles, and only there', () => {
    expect(costsFor(1 / 60, COSTS)).toEqual({ feeBps: COSTS.feeBps, slipBps: COSTS.slipBps * 2 });
    expect(costsFor(0.25, COSTS)).toBe(COSTS);
    expect(costsFor(1, COSTS)).toBe(COSTS);
    // and it is what every test on 1-minute candles charges: the same trades, worse results than with plain costs
    const m = minuteMarket('BTC', 4000, 3);
    const ctx = ctxOf(m, 3000, 1);
    const run = (id: string, slipBps: number) => {
      const spec = buildSpec({ ...FLOW_DEFAULT, style: 'scalp1', coins: 'BTC', strategies: [id], models: [], risks: [] } as Flow).spec as StrategySpec;
      return backtest(ctx, spec, 0, m.bars.length, { feeBps: COSTS.feeBps, slipBps });
    };
    const id = ['bbreak', 'donchian', 'rsi2', 'fade', 'mac', 'vwap'].find((x) => run(x, COSTS.slipBps).trades.length > 5)!;
    const doubled = run(id, COSTS.slipBps);
    const asIfDoubledTwice = run(id, COSTS.slipBps * 2);
    const plainHalf = run(id, COSTS.slipBps / 2);
    const total = (r: { trades: { ret: number }[] }) => r.trades.reduce((a, x) => a + x.ret, 0);
    // a 2 bps setting is charged as 4: it lands between "1 bps doubled" (2) and "4 bps doubled" (8)
    expect(total(doubled)).toBeLessThan(total(plainHalf));
    expect(total(doubled)).toBeGreaterThan(total(asIfDoubledTwice));
  });

  it('every entry rule builds on it, and the edge finder breeds and tests on 1-minute candles', () => {
    for (const st of STRATEGIES) {
      const b = buildSpec({ ...FLOW_DEFAULT, style: 'scalp1', coins: 'BTC', strategies: [st.id], models: [], risks: [] });
      expect(b.timeframe, st.id).toBe('1m');
    }
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['scalp1'] }, { seed: 5 });
    farm.setMarkets({ '1m': [minuteMarket('BTC', 12_000, 7), minuteMarket('ETH', 12_000, 8)] });
    for (let i = 0; i < 40; i++) farm.step();
    const st = farm.state(true, '', '');
    expect(st.tried).toBeGreaterThan(0);
    expect(st.funnel.bred).toBeGreaterThan(0);
    expect(st.error).toBeFalsy();
  }, 120_000);
});

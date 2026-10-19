import { describe, expect, it } from 'vitest';
import { candleDelta, candlePoc, FootprintBuilder, imbalances, stackedZones, valueArea, volumeProfile } from './footprint';
import { fmtNum, fmtPct, fmtPrice, fmtUsd, fmtVol } from './format';
import { HeatmapRecorder, niceStep, qtyPercentile } from './heatmap';
import { buildTpo, cvdSeries, ema, flowWindow, periodLevels, resampleKlines, sma, startOfWeek, vwap } from './indicators';
import { bucket, decimalsOf, depthStats, groupLevels, OrderBook } from './orderbook';
import { RollingProfile } from './rollingProfile';
import { TradeStore } from './tradeStore';
import type { Kline } from './types';

const T0 = Date.UTC(2026, 9, 19, 0, 0, 0); // Monday

describe('TradeStore', () => {
  it('appends, searches by time and keeps order', () => {
    const s = new TradeStore(100, 4);
    for (let i = 0; i < 10; i++) s.push(100 + i, 1, i % 2 ? 'buy' : 'sell', T0 + i * 1000);
    expect(s.length).toBe(10);
    expect(s.indexAtTime(T0 + 3500)).toBe(4);
    expect(s.lastPrice()).toBe(109);
    s.push(1, 1, 'buy', T0); // out of order time is clamped
    expect(s.lastTime()).toBe(T0 + 9000);
    s.push(0, 1, 'buy', T0 + 10_000); // invalid ignored
    expect(s.length).toBe(11);
  });

  it('trims oldest trades but keeps absolute indices stable', () => {
    const s = new TradeStore(8, 4);
    for (let i = 0; i < 9; i++) s.push(100 + i, 1, 'buy', T0 + i);
    expect(s.length).toBe(7);
    expect(s.start).toBe(2);
    expect(s.p(2)).toBe(102);
    expect(s.end).toBe(9);
  });

  it('prepends history and bumps generation', () => {
    const s = new TradeStore();
    s.push(105, 1, 'buy', T0 + 5000);
    const g = s.generation;
    const n = s.prepend([
      { price: 101, qty: 1, side: 'sell', time: T0 + 1000 },
      { price: 100, qty: 1, side: 'buy', time: T0 },
      { price: 106, qty: 1, side: 'buy', time: T0 + 6000 }, // overlaps live, dropped
    ]);
    expect(n).toBe(2);
    expect(s.generation).toBe(g + 1);
    const prices: number[] = [];
    s.forEach(s.start, s.end, (p) => prices.push(p));
    expect(prices).toEqual([100, 101, 105]);
  });
});

describe('OrderBook', () => {
  it('applies snapshots and deltas', () => {
    const b = new OrderBook();
    b.apply({ snapshot: true, bids: [[99, 1], [98, 2]], asks: [[101, 1], [102, 3]], time: 1 });
    b.apply({ snapshot: false, bids: [[99, 0], [97, 5]], asks: [[101, 4]], time: 2 });
    expect(b.getBids()).toEqual([{ price: 98, qty: 2 }, { price: 97, qty: 5 }]);
    expect(b.bestAsk()).toEqual({ price: 101, qty: 4 });
    expect(b.mid()).toBe(99.5);
  });

  it('prunes stale crossed levels on the untouched side', () => {
    const b = new OrderBook();
    b.apply({ snapshot: true, bids: [[99, 1]], asks: [[100, 1], [101, 1]], time: 1 });
    b.apply({ snapshot: false, bids: [[100.5, 2]], asks: [], time: 2 });
    expect(b.bestAsk()?.price).toBe(101);
    expect(b.bestBid()?.price).toBe(100.5);
  });

  it('groups and computes depth stats', () => {
    expect(groupLevels([{ price: 99.9, qty: 1 }, { price: 99.1, qty: 1 }, { price: 98.5, qty: 2 }], 1, 'bid')).toEqual([{ price: 99, qty: 2 }, { price: 98, qty: 2 }]);
    const b = new OrderBook();
    b.apply({ snapshot: true, bids: [[99.9, 1], [99, 2], [80, 5]], asks: [[100.1, 1], [101, 2], [130, 9]], time: 1 });
    const s = depthStats(b)!;
    expect(s.mid).toBe(100);
    expect(s.bid05).toBe(1);
    expect(s.bid2).toBe(3);
    expect(s.ask10).toBe(3);
    expect(s.totalAsk).toBe(12);
  });

  it('buckets prices without float noise', () => {
    expect(bucket(0.30000000000000004, 0.1)).toBe(0.3);
    expect(bucket(101.7, 0.5, 'floor')).toBe(101.5);
    expect(bucket(101.2, 0.5, 'ceil')).toBe(101.5);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(10)).toBe(0);
    expect(decimalsOf(0.00005)).toBe(5);
    expect(bucket(101.3, 0.25, 'floor')).toBe(101.25);
  });
});

function storeFrom(trades: [number, number, 'buy' | 'sell', number][]) {
  const s = new TradeStore();
  for (const [p, q, side, t] of trades) s.push(p, q, side, t);
  return s;
}

describe('FootprintBuilder', () => {
  const trades: [number, number, 'buy' | 'sell', number][] = [
    [100, 1, 'buy', T0],
    [101, 2, 'buy', T0 + 10_000],
    [100, 3, 'sell', T0 + 20_000],
    [102, 1, 'buy', T0 + 65_000],
    [99, 4, 'sell', T0 + 70_000],
  ];

  it('builds time bars with per-level bid/ask volume and CVD', () => {
    const s = storeFrom(trades);
    const b = new FootprintBuilder(s, { barType: 'time', size: 60_000, tick: 1, bubbleMinNotional: 300, lookbackMs: 3_600_000 });
    b.update();
    expect(b.candles).toHaveLength(2);
    const [c1, c2] = b.candles;
    expect(c1).toMatchObject({ time: T0, open: 100, high: 101, low: 100, close: 100, volume: 6, buyVol: 3, sellVol: 3, trades: 3 });
    expect(c1.levels.get(100)).toEqual({ buy: 1, sell: 3 });
    expect(candleDelta(c1)).toBe(0);
    expect(c1.maxDelta).toBe(3);
    expect(candlePoc(c1)).toBe(100);
    expect(c2.cvd).toBe(-3);
    expect(b.bubbles.map((x) => x.price)).toEqual([100, 99]);
  });

  it('updates incrementally and rebuilds on option change', () => {
    const s = storeFrom(trades.slice(0, 2));
    const b = new FootprintBuilder(s, { barType: 'time', size: 60_000, tick: 1, bubbleMinNotional: 0, lookbackMs: 3_600_000 });
    b.update();
    expect(b.candles[0].volume).toBe(3);
    s.push(100, 3, 'sell', T0 + 20_000);
    expect(b.update()).toBe(true);
    expect(b.candles[0].volume).toBe(6);
    expect(b.update()).toBe(false);
    b.setOptions({ ...b.opts, tick: 5 });
    b.update();
    expect([...b.candles[0].levels.keys()]).toEqual([100]);
  });

  it('supports tick, volume and range bars', () => {
    const s = storeFrom(trades);
    const tick = new FootprintBuilder(s, { barType: 'tick', size: 2, tick: 1, bubbleMinNotional: 0, lookbackMs: 3_600_000 });
    tick.update();
    expect(tick.candles.map((c) => c.trades)).toEqual([2, 2, 1]);
    const vol = new FootprintBuilder(s, { barType: 'volume', size: 3, tick: 1, bubbleMinNotional: 0, lookbackMs: 3_600_000 });
    vol.update();
    expect(vol.candles.map((c) => c.volume)).toEqual([3, 3, 5]);
    const range = new FootprintBuilder(s, { barType: 'range', size: 2, tick: 1, bubbleMinNotional: 0, lookbackMs: 3_600_000 });
    range.update();
    // 100,101,100,102 fit in a 2-tick range; 99 breaks it
    expect(range.candles.map((c) => [c.low, c.high])).toEqual([[100, 102], [99, 99]]);
  });

  it('flags diagonal and stacked imbalances', () => {
    const s = storeFrom([
      [100, 1, 'sell', T0],
      [101, 10, 'buy', T0 + 1],
      [101, 1, 'sell', T0 + 2],
      [102, 9, 'buy', T0 + 3],
      [102, 1, 'sell', T0 + 4],
      [103, 8, 'buy', T0 + 5],
    ]);
    const b = new FootprintBuilder(s, { barType: 'time', size: 60_000, tick: 1, bubbleMinNotional: 0, lookbackMs: 3_600_000 });
    b.update();
    const { buyImb, sellImb } = imbalances(b.candles[0], 1, 3);
    expect([...buyImb].sort()).toEqual([101, 102, 103]);
    expect(sellImb.size).toBe(0);
    expect(stackedZones(buyImb, 1, 3)).toEqual([[101, 103]]);
    expect(stackedZones(buyImb, 1, 4)).toEqual([]);
  });

  it('computes volume profile and value area', () => {
    const s = storeFrom(trades);
    const vp = volumeProfile(s, T0, T0 + 120_000, 1);
    expect(vp.get(100)).toEqual({ buy: 1, sell: 3 });
    const va = valueArea(new Map([[98, 1], [99, 2], [100, 10], [101, 3], [102, 1]]), 0.7)!;
    expect(va.poc).toBe(100);
    expect(va.val).toBe(100);
    expect(va.vah).toBe(101);
    expect(va.total).toBe(17);
  });
});

describe('RollingProfile', () => {
  it('adds new trades and expires old ones', () => {
    const s = storeFrom([
      [100, 1, 'buy', T0],
      [101, 2, 'sell', T0 + 30_000],
    ]);
    const r = new RollingProfile(s, 1, 60_000);
    r.update(T0 + 30_000);
    expect(r.levels.get(100)?.buy).toBe(1);
    expect(r.high).toBe(101);
    s.push(102, 1, 'buy', T0 + 70_000);
    r.update(T0 + 70_000);
    expect(r.levels.has(100)).toBe(false);
    expect(r.low).toBe(101);
    expect(r.levels.get(102)?.buy).toBe(1);
    expect(r.dataStart).toBe(T0 + 30_000);
  });
});

describe('HeatmapRecorder', () => {
  it('records grouped, clipped snapshots on an interval', () => {
    const b = new OrderBook();
    b.apply({ snapshot: true, bids: [[99.4, 1], [99.6, 2], [50, 9]], asks: [[100.4, 3], [200, 9]], time: 1 });
    const r = new HeatmapRecorder(500, 3, 0.05, 1);
    expect(r.maybeTake(1000, [b])).toBe(true);
    expect(r.maybeTake(1200, [b])).toBe(false);
    const s = r.snapshots[0];
    expect(Array.from(s.bids)).toEqual([99, 3]);
    expect(Array.from(s.asks)).toEqual([100, 3]);
    r.take(2000, [b]);
    r.take(3000, [b]);
    r.take(4000, [b]);
    expect(r.snapshots).toHaveLength(3);
    expect(r.indexAt(2500)).toBe(0);
    expect(r.indexAt(500)).toBe(-1);
    expect(qtyPercentile(r.snapshots, 0.5)).toBe(3);
  });

  it('niceStep rounds to 1/2/5', () => {
    expect(niceStep(7)).toBe(5);
    expect(niceStep(8)).toBe(10);
    expect(niceStep(0.03)).toBe(0.02);
    expect(niceStep(4.1)).toBe(5);
  });
});

const bar = (t: number, o: number, h: number, l: number, c: number, v = 1): Kline => ({ time: t, open: o, high: h, low: l, close: c, volume: v });

describe('indicators', () => {
  it('sma / ema', () => {
    expect(sma([1, 2, 3, 4], 2).slice(1)).toEqual([1.5, 2.5, 3.5]);
    const e = ema([1, 1, 1, 10], 3);
    expect(e[2]).toBe(1);
    expect(e[3]).toBeCloseTo(5.5);
  });

  it('vwap resets each session', () => {
    const v = vwap([bar(T0, 10, 10, 10, 10, 1), bar(T0 + 60_000, 20, 20, 20, 20, 1), bar(T0 + 86_400_000, 5, 5, 5, 5, 2)]);
    expect(v.mid).toEqual([10, 15, 5]);
    expect(v.upper[1]).toBeCloseTo(20);
  });

  it('builds TPO sessions with POC, value area and IB', () => {
    const half = 1_800_000;
    const bars = [bar(T0, 100, 103, 100, 102), bar(T0 + half, 102, 104, 101, 101), bar(T0 + 2 * half, 101, 102, 101, 102), bar(T0 + 86_400_000, 50, 51, 50, 51)];
    const [s, s2] = buildTpo(bars, 1);
    expect(s.periods).toBe(3);
    expect(s.rows.get(101)).toEqual([0, 1, 2]);
    expect(s.poc).toBe(102); // 101 and 102 have 3 TPOs; 102 is closer to the 102 centre
    expect(s.ibHigh).toBe(104);
    expect(s.ibLow).toBe(100);
    expect(s.singles.has(104)).toBe(true);
    expect(s.val).toBeLessThanOrEqual(101);
    expect(s2.start).toBe(T0 + 86_400_000);
  });

  it('cvd series and flow windows', () => {
    const s = storeFrom([
      [100, 1, 'buy', T0],
      [100, 2, 'sell', T0 + 500],
      [101, 4, 'buy', T0 + 1500],
    ]);
    expect(cvdSeries(s, 10_000, 1000, T0 + 2000)).toEqual([
      { time: T0, cvd: -1, price: 100 },
      { time: T0 + 1000, cvd: 3, price: 101 },
    ]);
    const w = flowWindow(s, 1000, T0 + 1500);
    expect(w).toEqual({ buyNotional: 404, sellNotional: 200, buyQty: 4, sellQty: 2, trades: 2 });
  });

  it('resamples and derives period levels', () => {
    const day = 86_400_000;
    const daily = [bar(T0 - 8 * day, 1, 9, 1, 5), bar(T0 - 7 * day, 5, 20, 4, 6), bar(T0 - day, 6, 12, 3, 7), bar(T0, 7, 8, 6, 7)];
    const lv = Object.fromEntries(periodLevels(daily, T0 + 1000).map((l) => [l.label, l.price]));
    expect(lv).toMatchObject({ PDH: 12, PDL: 3, PDC: 7, DO: 7, PWH: 20, PWL: 3, WO: 7 });
    expect(startOfWeek(T0 + 3 * day)).toBe(T0);
    const r = resampleKlines([bar(T0, 1, 2, 1, 2), bar(T0 + 60_000, 2, 5, 2, 3)], 300_000);
    expect(r).toEqual([{ time: T0, open: 1, high: 5, low: 1, close: 3, volume: 2 }]);
  });
});

describe('format', () => {
  it('formats numbers compactly', () => {
    expect(fmtNum(1234)).toBe('1.23K');
    expect(fmtUsd(-2_500_000)).toBe('-$2.50M');
    expect(fmtVol(12345)).toBe('12K');
    expect(fmtVol(0.123)).toBe('0.12');
    expect(fmtPct(1.234)).toBe('+1.23%');
    expect(fmtPrice(1234.5, 0.5)).toBe('1,234.5');
    expect(fmtPrice(NaN)).toBe('—');
  });
});

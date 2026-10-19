import { describe, expect, it } from 'vitest';
import { TradeStore } from '../core/tradeStore';
import { OrderBook } from '../core/orderbook';
import type { Feed } from '../market/hub';
import { liquidationPrice, positionSize } from './Calculator';
import { withLiveBars } from './HistoricalChart';
import { toMarkdown } from './Journal';
import { aggregateSeries } from './OpenInterest';
import { compositeBook } from './Orderbook';
import { PANELS } from './registry';
import { aggregateTrades } from './TradesTape';

describe('tape aggregation', () => {
  it('merges same venue/side/ms prints at VWAP', () => {
    const rows = aggregateTrades([
      { venue: 'binancef', price: 100, qty: 1, side: 'buy', time: 1 },
      { venue: 'binancef', price: 101, qty: 3, side: 'buy', time: 1 },
      { venue: 'bybit', price: 101, qty: 1, side: 'buy', time: 1 },
      { venue: 'binancef', price: 101, qty: 1, side: 'sell', time: 1 },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ qty: 4, price: 100.75, count: 2 });
  });
});

describe('composite book', () => {
  it('sums venues on a common grid', () => {
    const mk = (venue: string, bids: [number, number][], asks: [number, number][]) => {
      const book = new OrderBook();
      book.apply({ snapshot: true, bids, asks, time: 1 });
      return { inst: { venue, symbol: 'X', base: 'X' }, book } as unknown as Feed;
    };
    const { bids, asks } = compositeBook([mk('binancef', [[99.5, 1], [98.2, 1]], [[100.2, 2]]), mk('bybit', [[99.1, 3]], [[100.9, 1]])], 1, 10);
    expect(bids.map((l) => [l.price, l.total])).toEqual([[99, 4], [98, 1]]);
    expect(bids[0].byVenue.get('bybit' as never)).toBe(3);
    expect(asks.map((l) => [l.price, l.total])).toEqual([[101, 3]]);
  });
});

describe('series aggregation', () => {
  it('forward-fills and sums venues once each has data', () => {
    const a = [
      { time: 0, value: 10 },
      { time: 20, value: 12 },
    ];
    const b = [{ time: 10, value: 5 }];
    expect(aggregateSeries([a, b], 0, 30, 10)).toEqual([
      { time: 0, value: 10 },
      { time: 10, value: 15 },
      { time: 20, value: 17 },
      { time: 30, value: 17 },
    ]);
  });
});

describe('calculator', () => {
  it('sizes positions from risk including fees', () => {
    const r = positionSize(10_000, 1, 100, 95, 115, 0)!;
    expect(r.qty).toBeCloseTo(20);
    expect(r.notional).toBeCloseTo(2000);
    expect(r.rr).toBeCloseTo(3);
    const withFees = positionSize(10_000, 1, 100, 95, 0, 10)!;
    expect(withFees.qty).toBeLessThan(20);
    expect(withFees.qty * 5 + withFees.feesUsd).toBeCloseTo(100);
    expect(positionSize(10_000, 1, 100, 100, 0, 0)).toBeNull();
  });

  it('estimates isolated liquidation prices', () => {
    expect(liquidationPrice(100, 10, 'long', 0.5)).toBeCloseTo(90.5);
    expect(liquidationPrice(100, 10, 'short', 0.5)).toBeCloseTo(109.5);
  });
});

describe('historical live bars', () => {
  it('extends REST bars with trades without double counting', () => {
    const s = new TradeStore();
    s.push(105, 1, 'buy', 60_500); // inside the last REST bar, store does not cover the bar start
    s.push(110, 2, 'sell', 120_100); // new bar
    const bars = withLiveBars(
      [
        { time: 0, open: 1, high: 2, low: 1, close: 2, volume: 10 },
        { time: 60_000, open: 2, high: 3, low: 2, close: 3, volume: 5 },
      ],
      s,
      60_000,
    );
    expect(bars).toHaveLength(3);
    expect(bars[1]).toMatchObject({ high: 105, close: 105, volume: 5 });
    expect(bars[2]).toMatchObject({ time: 120_000, open: 110, volume: 2, buyVolume: 0 });
  });
});

describe('journal export', () => {
  it('renders markdown', () => {
    const md = toMarkdown([{ id: '1', time: Date.UTC(2026, 0, 1), base: 'BTC', price: 100, text: 'absorption at lows', tags: ['setup'] }]);
    expect(md).toContain('BTC @ 100');
    expect(md).toContain('#setup');
  });
});

describe('registry', () => {
  it('has unique ids and 20+ panels with defaults', () => {
    const ids = PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
    for (const p of PANELS) expect(typeof p.component).toBe('function');
  });
});

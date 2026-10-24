import { describe, expect, it } from 'vitest';
import { AmtEngine, mergeConfig, ORDERFLOW_PRESET } from './engine.mjs';
import { botParams, coinOf } from './bots.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 10);

/** 200 daily candles ending yesterday, drifting by `drift` a day; then today's (unfinished) candle. */
function daily(drift, today = null) {
  const first = Math.floor(NOW / DAY) * DAY - 200 * DAY;
  let p = 100;
  const rows = [];
  for (let i = 0; i < 200; i++) {
    p *= Math.exp(drift + (i % 2 ? 0.01 : -0.01));
    rows.push({ time: first + i * DAY, close: p });
  }
  if (today !== null) rows.push({ time: first + 200 * DAY, close: p * today });
  return rows;
}

function engineAt(extra = {}) {
  const e = new AmtEngine({ ...mergeConfig(ORDERFLOW_PRESET), sizing: 'fixed', riskUsd: 10, maxPositionUsd: 1e6, feeBps: 2, orderMode: 'market', manageTrades: false, ...extra });
  e.now = NOW;
  e.last = 100;
  return e;
}
const plan = (side) => ({ side, setup: 'sweep', stop: side === 'buy' ? 99 : 101, target: side === 'buy' ? 103 : 97, why: 'test', targetKind: 'r' });

describe('daily-trend filter', () => {
  it('in a daily uptrend: longs only, and says why', () => {
    const e = engineAt();
    e.setDaily(daily(0.004));
    expect(e.dailyTrend()).toMatchObject({ dir: 1, up: 3 });
    expect(e.enter('sweep-short', plan('sell'), 100, NOW, null)).toBeNull();
    expect(e.lastSkip.reason).toMatch(/^against the daily trend \(3\/3 up: 20d \+\d+\.\d%, 60d \+\d+\.\d%, 120d \+\d+\.\d%\) — longs only for now$/);
    expect(e.enter('sweep-long', plan('buy'), 100, NOW, null)).toMatchObject({ type: 'enter', side: 'buy' });
  });

  it('in a daily downtrend: shorts only', () => {
    const e = engineAt();
    e.setDaily(daily(-0.004));
    expect(e.dailyTrend().dir).toBe(-1);
    expect(e.enter('sweep-long', plan('buy'), 100, NOW, null)).toBeNull();
    expect(e.lastSkip.reason).toMatch(/3\/3 down.*shorts only for now/);
  });

  it('never looks at today’s unfinished candle', () => {
    const e = engineAt();
    // today's candle so far is a crash to a tenth: it has not closed, so it does not count
    e.setDaily(daily(0.004, 0.1));
    expect(e.dailyTrend().dir).toBe(1);
  });

  it('trades both sides without daily history, or when switched off', () => {
    const e = engineAt();
    expect(e.enter('sweep-short', plan('sell'), 100, NOW, null)).toMatchObject({ side: 'sell' });
    const off = engineAt({ trendFilter: false });
    off.setDaily(daily(0.004));
    expect(off.enter('sweep-short', plan('sell'), 100, NOW, null)).toMatchObject({ side: 'sell' });
  });

  it('is on for bots saved before it existed, and in every preset but trend', () => {
    expect(botParams({ style: 'scalp' }).trendFilter).toBe(true);
    expect(botParams({ style: 'scalp', trendFilter: false }).trendFilter).toBe(false);
    expect(mergeConfig(ORDERFLOW_PRESET).trendFilter).toBe(true);
  });

  it('finds the coin in any symbol format', () => {
    expect(coinOf('ETHUSDT')).toBe('ETH');
    expect(coinOf('ETH/USDT:USDT')).toBe('ETH');
    expect(coinOf('binance::BTC/USDT')).toBe('BTC');
    expect(coinOf('BTC-USD')).toBe('BTC');
    expect(coinOf('SOLUSDC')).toBe('SOL');
  });
});

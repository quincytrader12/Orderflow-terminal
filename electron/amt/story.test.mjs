import { describe, expect, it } from 'vitest';
import { coinName, exitWords, Narrator, passWords, stoppedWords } from './story.mjs';

const MIN = 60_000;
const engine = (over = {}) => ({ cfg: { style: 'adaptive', trendFilter: false }, of: { sweep: null, absorb: null }, pos: null, pending: null, lastSkip: null, last: 100, ...over });
const noNumbers = (lines) => lines.forEach((l) => expect(l.text).not.toMatch(/\d/));

describe('the bot story', () => {
  it('names the coin', () => {
    expect(coinName('BTC/USDT:USDT')).toBe('BTC');
    expect(coinName('ETHUSDT')).toBe('ETH');
  });

  it('watches a stop run, then reports the entry in plain words', () => {
    const n = new Narrator({ symbol: 'BTC/USDT:USDT', mode: 'live' });
    const e = engine();
    e.of.sweep = { dir: -1, level: { kind: 'swing low', price: 99 }, extreme: 98.5, why: '' };
    const w = n.step(e, 1000);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ kind: 'watch' });
    expect(w[0].text).toMatch(/^👀 Watching BTC for a long\. Price just ran below a recent low/);
    // it confirms: the plan becomes a pending entry in the same step
    e.of.sweep = null;
    e.pending = { kind: 'entry' };
    expect(n.step(e, 2000)).toEqual([]);
    const en = n.entry({ side: 'buy', setup: 'sweep' });
    expect(en.text).toMatch(/^✅ Bought BTC — went long\. Why: sellers drove price below a recent low/);
    noNumbers([...w, en]);
  });

  it('closes every watch it announced: a stop run that never confirms is let go, with the reason', () => {
    const n = new Narrator({ symbol: 'BTCUSDT' });
    const e = engine();
    e.of.sweep = { dir: 1, level: { kind: 'prior high' }, extreme: 101, why: 'reclaim held 3 of 10 s' };
    expect(n.step(e, 0)[0].text).toMatch(/Watching BTC for a short \(paper\)\. Price just ran above the previous session's high/);
    e.of.sweep = null;
    const p = n.step(e, 1000);
    expect(p).toEqual([{ kind: 'pass', text: '✋ Let the BTC short go (paper) — price never settled back on the other side of the level.' }]);
  });

  it('a watched setup turned down at the last check says why', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const e = engine();
    e.of.sweep = { dir: -1, level: { kind: 'round number' }, extreme: 99 };
    n.step(e, 0);
    e.of.sweep = null;
    e.lastSkip = { t: 1000, event: 'sweep-long', reason: 'not enough agreement (score 0.5: Δ10s +0.1 ·; need 1.5)' };
    expect(n.step(e, 1000)).toEqual([{ kind: 'pass', text: '✋ Let the BTC long go — the overall order flow did not agree strongly enough.' }]);
  });

  it('keeps the phone quiet: the same setup is announced once per quiet period, and its let-go only when announced', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live', quietMin: 5 });
    const e = engine();
    const run = (t) => {
      e.of.sweep = { dir: -1, level: { kind: 'swing low' }, extreme: 99, why: 'delta −0.10 has not turned' };
      const a = n.step(e, t);
      e.of.sweep = null;
      return [...a, ...n.step(e, t + 1000)];
    };
    expect(run(0).map((l) => l.kind)).toEqual(['watch', 'pass']);
    expect(run(2 * MIN)).toEqual([]);
    expect(run(6 * MIN).map((l) => l.kind)).toEqual(['watch', 'pass']);
  });

  it('does not watch trades the daily trend would refuse', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const e = engine({ cfg: { style: 'adaptive', trendFilter: true }, dailyTrend: () => ({ dir: -1 }) });
    e.of.sweep = { dir: -1, level: { kind: 'swing low' }, extreme: 99 }; // would be a long
    expect(n.step(e, 0)).toEqual([]);
    e.of.sweep = { dir: 1, level: { kind: 'swing high' }, extreme: 101 }; // a short: allowed
    expect(n.step(e, 1000)[0].text).toMatch(/for a short/);
  });

  it('absorption: watched, then let go when the level breaks', () => {
    const n = new Narrator({ symbol: 'ETHUSDT', mode: 'live' });
    const e = engine();
    e.of.absorb = { dir: 1, extreme: 100, level: 'a 40s bid wall 100.00' };
    expect(n.step(e, 0)[0].text).toBe("👀 Watching ETH for a long. Sellers are hitting a large buy order sitting in the book hard, but price is not dropping — someone is soaking it all up. If buyers take over from here, I'll buy.");
    e.of.absorb = null;
    e.last = 99.5;
    expect(n.step(e, 1000)[0].text).toBe('✋ Let the ETH long go — price broke through the level after all — the defence failed.');
  });

  it('says once when a trade is safe', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const e = engine({ pos: { side: 'sell', entry: 100, stop: 101 } });
    expect(n.step(e, 0)).toEqual([]);
    e.pos.stop = 99.9;
    const l = n.step(e, 1000);
    expect(l[0].text).toMatch(/^🔒 The BTC short is working\. I've moved the stop past my entry/);
    expect(n.step(e, 2000)).toEqual([]);
    noNumbers(l);
  });

  it('exits: profit, breakeven or loss, and why — in words', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const tr = (pnl, reason) => n.exit({ side: 'buy', qty: 1, risk: 10, pnl, reason });
    expect(tr(12, 'losing steam')).toEqual({ kind: 'exit', outcome: 'profit', text: '💰 Closed the BTC long in profit — the move was running out of steam, so I took what it had given instead of letting it slip back.' });
    expect(tr(0.5, 'stalled').text).toBe('➖ Closed the BTC long at about breakeven — it went nowhere for too long — quick trades that stall usually fail, so I stepped aside.');
    expect(tr(-4, 'flow turned').text).toBe('🔻 Closed the BTC long at a small loss — the order flow turned against it, so I cut it early instead of waiting for the stop.');
    expect(tr(-10.4, 'stop').text).toMatch(/^🔻 Closed the BTC long at a loss — price went through the level that should have held/);
    expect(exitWords('trail', true)).toMatch(/locked in profit/);
    expect(exitWords('target')).toBe('it reached the profit target I set');
  });

  it('every reason maps to plain words without numbers', () => {
    for (const r of ['breakout, not a sweep', 'R:R 1.1 < 1.5', 'market too quiet: the one-minute range is 2 bps', 'setup benched for 12 more min', '$40,000 of longs still being liquidated', 'whatever else']) expect(passWords(r)).not.toMatch(/\d/);
    expect(stoppedWords('drawdown limit (20% below the peak balance) reached')).toMatch(/safety limit/);
    expect(stoppedWords('stopped by you')).toBe('you stopped it');
    expect(stoppedWords('entry order failed: binance {"code":-2019,"msg":"Margin is insufficient."}')).toMatch(/not enough margin/);
  });
});

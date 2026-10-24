import { describe, expect, it } from 'vitest';
import { coinName, exitWords, Narrator, passWords, px, stoppedWords } from './story.mjs';

const MIN = 60_000;
const engine = (over = {}) => ({ cfg: { style: 'adaptive', trendFilter: false }, of: { sweep: null, absorb: null }, pos: null, pending: null, lastSkip: null, last: 100, ...over });

describe('the bot story', () => {
  it('names the coin and reads prices like people do', () => {
    expect(coinName('BTC/USDT:USDT')).toBe('BTC');
    expect(coinName('ETHUSDT')).toBe('ETH');
    expect(px(98950.4)).toBe('98,950.4');
    expect(px(2.345678)).toBe('2.3457');
  });

  it('watches a stop run — the reasoning, then the level and the force behind the run', () => {
    const n = new Narrator({ symbol: 'BTC/USDT:USDT', mode: 'live' });
    const e = engine({ last: 98_930 });
    e.of.sweep = { dir: -1, level: { kind: 'swing low', price: 98_900 }, extreme: 98_860, burst: 2.4, liq: 40_000, why: '' };
    const w = n.step(e, 1000);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('watch');
    expect(w[0].text).toBe(
      "👀 Watching BTC for a long\nPrice just ran below a recent low and knocked out the stops parked there. If it climbs back over that level, stays there, and the selling dries up, I'll buy — the traders who chased it would be trapped.\nLevel: swing low 98,900 · ran to 98,860 (4.0 bps through) on 2.4× normal selling, $40000.00 of longs liquidated\nNow: 98,930",
    );
  });

  it('enters with the why, the plan in numbers, and the bot’s own notes', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const e = engine();
    e.of.sweep = { dir: -1, level: { kind: 'swing low', price: 98_900 }, extreme: 98_860 };
    n.step(e, 0);
    // it confirms: the plan becomes a pending entry in the same step — no "let go"
    e.of.sweep = null;
    e.pending = { kind: 'entry' };
    expect(n.step(e, 1000)).toEqual([]);
    const en = n.entry({ side: 'buy', setup: 'sweep', qty: 0.0015, stop: 98_800, target: 99_250, reason: 'swept the swing low 98,900 by 4.0 bps · score 2.5' }, 98_950, { balance: 30 });
    expect(en.text).toBe(
      "✅ Entered BTC long at 98,950\nWhy: sellers drove price below a recent low to grab the stops parked there, then buyers took it straight back and the selling dried up — the traders who chased the move are now trapped.\nStop: just beyond the far end of the stop run. From here I read the order flow every second and get out early if it turns.\nPlan: stop 98,800 (−0.15%, risking $0.23 = 0.8% of $30.00) · target 99,250 (+0.30%, 2.0R) · size $148.43 (4.9× the balance)\nBot's notes: swept the swing low 98,900 by 4.0 bps · score 2.5",
    );
  });

  it('closes every watch it announced: a stop run that never confirms is let go, with the reason and the measurement', () => {
    const n = new Narrator({ symbol: 'BTCUSDT' });
    const e = engine();
    e.of.sweep = { dir: 1, level: { kind: 'prior high', price: 101 }, extreme: 101.2, why: 'reclaim held 3 of 10 s' };
    expect(n.step(e, 0)[0].text).toMatch(/^👀 Watching BTC for a short \(paper\)\nPrice just ran above the previous session's high/);
    e.of.sweep = null;
    expect(n.step(e, 1000)).toEqual([{ kind: 'pass', text: '✋ Let the BTC short go (paper) — price never settled back on the other side of the level.\nDetail: reclaim held 3 of 10 s' }]);
  });

  it('a watched setup turned down at the last check says why', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const e = engine();
    e.of.sweep = { dir: -1, level: { kind: 'round number', price: 99_000 }, extreme: 98_990 };
    n.step(e, 0);
    e.of.sweep = null;
    e.lastSkip = { t: 1000, event: 'sweep-long', reason: 'not enough agreement (score 0.5: Δ10s +0.1 ·; need 1.5)' };
    expect(n.step(e, 1000)).toEqual([{ kind: 'pass', text: '✋ Let the BTC long go — the overall order flow did not agree strongly enough.\nDetail: not enough agreement (score 0.5: Δ10s +0.1 ·; need 1.5)' }]);
  });

  it('keeps the phone quiet: the same setup is announced once per quiet period, and its let-go only when announced', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live', quietMin: 5 });
    const e = engine();
    const run = (t) => {
      e.of.sweep = { dir: -1, level: { kind: 'swing low', price: 99 }, extreme: 98.9, why: 'delta −0.10 has not turned' };
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
    e.of.sweep = { dir: -1, level: { kind: 'swing low', price: 99 }, extreme: 98.9 }; // would be a long
    expect(n.step(e, 0)).toEqual([]);
    e.of.sweep = { dir: 1, level: { kind: 'swing high', price: 101 }, extreme: 101.1 }; // a short: allowed
    expect(n.step(e, 1000)[0].text).toMatch(/for a short/);
  });

  it('absorption: watched with the level and the volume, then let go when the level breaks', () => {
    const n = new Narrator({ symbol: 'ETHUSDT', mode: 'live' });
    const e = engine();
    e.of.absorb = { dir: 1, extreme: 100, x: 2.4, level: 'a 40s bid wall 100.00' };
    expect(n.step(e, 0)[0].text).toBe(
      "👀 Watching ETH for a long\nSellers are hitting a large buy order sitting in the book hard, but price is not dropping — someone is soaking it all up. If buyers take over from here, I'll buy.\nLevel: a 40s bid wall 100.00 · 2.4× normal selling into it, price holding at 100\nNow: 100",
    );
    e.of.absorb = null;
    e.last = 99.5;
    expect(n.step(e, 1000)[0].text).toBe('✋ Let the ETH long go — price broke through the level after all — the defence failed.\nDetail: price 99.5 went through 100');
  });

  it('says once when a trade is safe, with the stop move', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const e = engine({ last: 99.5, pos: { side: 'sell', entry: 100, stop: 101, stop0: 101, risk: 1, qty: 2 } });
    expect(n.step(e, 0)).toEqual([]);
    e.pos.stop = 99.9;
    expect(n.step(e, 1000)[0].text).toBe(
      "🔒 The BTC short is working\nI've moved the stop past my entry, so it should not turn into a loss now. Still reading the order flow every second — I'll trail it while the push lasts and take it if it stalls.\nStop: 101 → 99.9 (entry 100, locks about $0.20 before fees) · price 99.5, +0.5R",
    );
    expect(n.step(e, 2000)).toEqual([]);
  });

  it('exits: the result in dollars and R, why it closed, the trade and the manager’s notes', () => {
    const n = new Narrator({ symbol: 'BTCUSDT', mode: 'live' });
    const tr = (pnl, reason) => ({ side: 'buy', qty: 1, risk: 10, pnl, fees: 0.06, entry: 100, exit: 100 + pnl, opened: 0, closed: 6 * MIN, reason });
    expect(n.exit(tr(12, 'losing steam'), 'losing steam', { balance: 42, notes: 'sweep: was up +1.6R, now losing steam' })).toEqual({
      kind: 'exit',
      outcome: 'profit',
      text: '💰 Closed in profit: BTC long +$12.00 (+1.2R) after 6 min\nWhy I closed: the move was running out of steam, so I took what it had given instead of letting it slip back.\nTrade: entry 100 → exit 112 · fees $0.06 · balance now $42.00\nBot’s notes: sweep: was up +1.6R, now losing steam'.replace('Bot’s', "Bot's"),
    });
    expect(n.exit(tr(0.5, 'stalled')).text).toMatch(/^➖ Closed at about breakeven: BTC long \+\$0\.50 \(\+0\.1R\) after 6 min\nWhy I closed: it went nowhere for too long/);
    expect(n.exit(tr(-4, 'flow turned')).text).toMatch(/^🔻 Closed at a small loss: BTC long −\$4\.00 \(−0\.4R\) after 6 min\nWhy I closed: the order flow turned against it, so I cut it early/);
    expect(n.exit(tr(-10.4, 'stop')).text).toMatch(/^🔻 Closed at a loss: BTC long −\$10\.40 \(−1\.0R\)/);
    expect(exitWords('trail', true)).toMatch(/locked in profit/);
    expect(exitWords('target')).toBe('it reached the profit target I set');
  });

  it('maps every reason to words, and stop reasons too', () => {
    expect(passWords('R:R 1.1 < 1.5')).toBe('the profit on offer was not worth the risk once fees are counted');
    expect(passWords('whatever else')).toBe('the conditions I wanted did not all line up');
    expect(stoppedWords('drawdown limit (20% below the peak balance) reached')).toMatch(/safety limit/);
    expect(stoppedWords('stopped by you')).toBe('you stopped it');
    expect(stoppedWords('entry order failed: binance {"code":-2019,"msg":"Margin is insufficient."}')).toMatch(/not enough margin/);
  });
});

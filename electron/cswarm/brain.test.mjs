import { describe, expect, it } from 'vitest';
import { AGENT_INDEX, CCOUNCIL_DEFAULTS, CFEATURES, councilR, features, oddsR, PROPOSERS, priorR, rClass, trainForest } from './brain.mjs';
import { kellyOf, newBook, recordClose, RISK_DEFAULTS, riskGate, shiftBook, sizeTrade, updateBook } from './risk.mjs';
import { atrOf, dailyTrendOf, manageTrend, Shadow, trendCandidate } from './agents.mjs';

const T = Date.UTC(2026, 10, 5, 14);
const cand = (over = {}) => ({
  agent: 'auction',
  coin: 'BTC',
  side: 'buy',
  price: 100_000,
  stop: 99_600,
  target: 100_900,
  setup: 'ibBreakout',
  why: 'first-hour range broken and held',
  t: T,
  ctx: { daily: { dir: 1, up: 3 }, flow: { deltaRatio: 0.3 }, book: { imbalance: 0.2, spreadBps: 0.5 }, funding: 0.0000125, volBps: 12, va: { vah: 100_200, val: 99_400, poc: 99_800 }, agentWin: 0.5 },
  ...over,
});
const oddsOk = { probs: [0.35, 0.2, 0.33, 0.12], pWin: 0.45, pLoss: 0.35, expR: 0.2, costR: 0.27, trust: 0 };

describe('crypto swarm brain', () => {
  it('describes a candidate in numbers the forest can learn from', () => {
    const x = features(cand());
    expect(x).toHaveLength(CFEATURES.length);
    expect(x[0]).toBe(1); // auction
    expect(x[2]).toBeCloseTo(2.25); // reward/risk
    expect(x[3]).toBeCloseTo(40); // stop 40 bps
    expect(x[4]).toBe(1); // with the daily trend
    expect(x[6]).toBeCloseTo(0.3); // flow with it
    expect(x[10]).toBeCloseTo(0.125); // longs pay 0.125 bps an hour
    expect(x[14]).toBe(0);
    expect(features(cand({ side: 'sell', stop: 100_400, target: 99_100 }))[4]).toBe(-1);
  });

  it('the forest reads each proposer by a fixed number (the retired Scalper keeps 0), so what it learned keeps its meaning', () => {
    expect(PROPOSERS).toEqual(['auction', 'trend', 'lab']);
    expect(AGENT_INDEX).toEqual({ scalper: 0, auction: 1, trend: 2, lab: 3 });
    expect(features(cand({ agent: 'trend' }))[0]).toBe(2);
    expect(features(cand({ agent: 'lab' }))[0]).toBe(3);
  });

  it('the prior favours trades with the trend and the tape, and charges costs in R', () => {
    const withIt = oddsR(features(cand()), null, 11);
    const against = oddsR(features(cand({ ctx: { ...cand().ctx, daily: { dir: -1, up: 0 }, flow: { deltaRatio: -0.4 } } })), null, 11);
    expect(withIt.expR).toBeGreaterThan(against.expR);
    expect(withIt.trust).toBe(0);
    for (const p of [priorR(features(cand())), priorR(features(cand({ agent: 'trend' })))]) expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    // a tight stop pays the same fees for a smaller R
    const tight = oddsR(features(cand({ stop: 99_900, target: 100_200 })), null, 11);
    expect(tight.costR).toBeGreaterThan(withIt.costR);
    expect(rClass(-1)).toBe(0);
    expect(rClass(0.2)).toBe(1);
    expect(rClass(1.4)).toBe(2);
    expect(rClass(3)).toBe(3);
  });

  it('a deployed Lab strategy only proposes: the forest, the guardian and the risk manager still veto it, and its sizing can only shrink a trade', () => {
    const lab = cand({ agent: 'lab', setup: 'Lab · Kalman-filter trend' });
    expect(councilR({ cand: lab, odds: oddsOk, riskGate: null, sizeNote: '' }).trade).toBe(true);
    expect(councilR({ cand: lab, odds: { ...oddsOk, expR: -0.3, trust: 0.5 }, riskGate: null, sizeNote: '' }).summary).toBe('vetoed by Forest');
    expect(councilR({ cand: lab, odds: oddsOk, riskGate: 'paused after 3 losses', sizeNote: '' }).summary).toBe('vetoed by Risk');
    expect(councilR({ cand: cand({ agent: 'lab', ctx: { ...cand().ctx, book: { imbalance: 0, spreadBps: 20 } } }), odds: oddsOk, riskGate: null, sizeNote: '' }).summary).toBe('vetoed by Guardian');
    const book = newBook(1000, Date.now());
    const base = sizeTrade({ price: 100_000, stop: 99_000, side: 'buy', equity: 1000, book, openNotional: 0 });
    const bigger = sizeTrade({ price: 100_000, stop: 99_000, side: 'buy', equity: 1000, book, openNotional: 0, sizeMult: 1.5 });
    const smaller = sizeTrade({ price: 100_000, stop: 99_000, side: 'buy', equity: 1000, book, openNotional: 0, sizeMult: 0.6 });
    expect(bigger.riskUsd).toBeCloseTo(base.riskUsd, 9);
    expect(smaller.riskUsd).toBeLessThan(base.riskUsd);
    // a strategy on probation: a quarter of the size, said in the sizing note — never below the account's minimum risk
    const prob = sizeTrade({ price: 100_000, stop: 99_000, side: 'buy', equity: 1000, book, openNotional: 0, probation: 0.25 });
    expect(prob.riskUsd).toBeLessThan(base.riskUsd * 0.6);
    expect(prob.why).toMatch(/on probation: ¼ size/);
  });

  it('a Lab strategy deployed "as tested": the opinion bots only advise; Guardian and Risk still stop it', () => {
    const lab = cand({ agent: 'lab', setup: 'Lab · RSI dip in the trend', authority: 'tested', ctx: { ...cand().ctx, flow: { deltaRatio: -0.6 }, daily: { dir: -1, up: 0 } } });
    // the tape and the trend against it and the forest vetoing would stop it under the council…
    const odds = { ...oddsOk, expR: -0.3, trust: 0.5 };
    expect(councilR({ cand: { ...lab, authority: 'council' }, odds, riskGate: null, sizeNote: '' }).trade).toBe(false);
    // …as tested, they are advice: it trades, and the advice is on the record
    const v = councilR({ cand: lab, odds, riskGate: null, sizeNote: '' });
    expect(v.trade).toBe(true);
    expect(v.advisory).toBe(true);
    expect(v.votes.find((q) => q.bot === 'forest').stance).toBe('against');
    expect(v.summary).toMatch(/only Guardian and Risk can stop it/);
    // the safety bots still stop it
    expect(councilR({ cand: lab, odds, riskGate: 'down 5% today', sizeNote: '' }).summary).toBe('vetoed by Risk (safety)');
    expect(councilR({ cand: { ...lab, ctx: { ...lab.ctx, book: { imbalance: 0, spreadBps: 20 } } }, odds, riskGate: null, sizeNote: '' }).trade).toBe(false);
  });

  it('the council: proposer and risk carry a clean trade; the tape against it or a veto stops it', () => {
    const go = councilR({ cand: cand(), odds: oddsOk, riskGate: null, sizeNote: 'risking 1% ($0.30)' });
    expect(go.trade).toBe(true);
    expect(go.votes.map((v) => v.bot)).toEqual(['auction', 'trend', 'tape', 'micro', 'crowd', 'guardian', 'forest', 'risk']);
    const tapeAgainst = councilR({ cand: cand({ ctx: { ...cand().ctx, flow: { deltaRatio: -0.5 }, daily: null } }), odds: { ...oddsOk, expR: 0.05 }, riskGate: null, sizeNote: '' });
    expect(tapeAgainst.trade).toBe(false);
    expect(councilR({ cand: cand({ ctx: { ...cand().ctx, book: { imbalance: 0, spreadBps: 20 } } }), odds: oddsOk, riskGate: null, sizeNote: '' }).summary).toBe('vetoed by Guardian');
    expect(councilR({ cand: cand(), odds: oddsOk, riskGate: 'down 5% today', sizeNote: '' }).summary).toBe('vetoed by Risk');
    // a learned forest that expects a loss vetoes; the prior alone never does
    expect(councilR({ cand: cand(), odds: { ...oddsOk, expR: -0.3, trust: 0.5 }, riskGate: null, sizeNote: '' }).summary).toBe('vetoed by Forest');
    expect(councilR({ cand: cand(), odds: { ...oddsOk, expR: -0.3, trust: 0 }, riskGate: null, sizeNote: '' }).votes.find((v) => v.bot === 'forest').stance).toBe('against');
    // crowded: longs paying a lot of funding
    expect(councilR({ cand: cand({ ctx: { ...cand().ctx, funding: 0.0001 } }), odds: oddsOk, riskGate: null, sizeNote: '' }).votes.find((v) => v.bot === 'crowd')).toMatchObject({ stance: 'against', why: expect.stringMatching(/crowded/) });
  });

  it('the prior alone never vetoes a candidate the rules passed, whatever its numbers', () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 1000; i++) {
      const c = cand({ agent: ['auction', 'trend', 'lab'][i % 3], stop: 100_000 - 50 - rnd() * 900, target: 100_000 + 100 + rnd() * 3000, ctx: { ...cand().ctx, flow: { deltaRatio: rnd() * 2 - 1 }, daily: { dir: rnd() > 0.5 ? 1 : -1, up: Math.floor(rnd() * 4) } } });
      const v = councilR({ cand: c, odds: oddsR(features(c), null, 11), riskGate: null, sizeNote: '' }, CCOUNCIL_DEFAULTS);
      expect(v.votes.find((x) => x.bot === 'forest').stance).not.toBe('veto');
    }
  });

  it('the forest learns from closed trades', async () => {
    const samples = Array.from({ length: 80 }, (_, i) => {
      const c = cand({ side: i % 2 ? 'buy' : 'sell', ctx: { ...cand().ctx, flow: { deltaRatio: i % 2 ? 0.5 : -0.5 } } });
      return { x: features(c), y: i % 2 ? 2 : 0 };
    });
    const f = await trainForest(samples, T);
    expect(f.size).toBeGreaterThan(0);
    expect(oddsR(samples[1].x, f).trust).toBeCloseTo(80 / 120);
  });
});

describe('crypto swarm risk', () => {
  it('compounds: the same trade is bigger after the account grows and smaller after it shrinks', () => {
    const book = newBook(30, T);
    const at = (equity) => sizeTrade({ price: 100_000, stop: 99_500, side: 'buy', equity, book: { ...book, peak: Math.max(30, equity) }, openNotional: 0 });
    const a = at(30);
    const b = at(60);
    expect(a.riskUsd).toBeCloseTo(0.3);
    expect(b.riskUsd).toBeCloseTo(0.6);
    expect(b.qty).toBeCloseTo(a.qty * 2);
  });

  it('caps leverage, takes the $10 minimum only when its risk is acceptable', () => {
    const book = newBook(30, T);
    // a very tight stop would need a huge position: capped at 3× the account
    const tight = sizeTrade({ price: 100_000, stop: 99_990, side: 'buy', equity: 30, book, openNotional: 0 });
    expect(tight.notional).toBeCloseTo(90);
    expect(tight.why).toMatch(/capped/);
    // a wide stop on a small account: the $10 minimum risks 5% → refused
    const wide = sizeTrade({ price: 100_000, stop: 95_000, side: 'buy', equity: 10, book: newBook(10, T), openNotional: 0 });
    expect(wide.skip).toMatch(/smallest order/);
    // room left after open positions
    expect(sizeTrade({ price: 100_000, stop: 99_990, side: 'buy', equity: 30, book, openNotional: 85 }).skip).toMatch(/more leverage/);
  });

  it('cuts size in a drawdown and follows the edge once there is a record', () => {
    const book = { ...newBook(100, T), peak: 115 };
    const dd = sizeTrade({ price: 100, stop: 99, side: 'buy', equity: 100, book, openNotional: 0 });
    expect(dd.riskPct).toBeCloseTo(0.75);
    expect(kellyOf([2, -1, 2, -1])).toBeCloseTo(0.25);
    const winner = { ...newBook(100, T), closedR: Array.from({ length: 20 }, (_, i) => (i % 2 ? 2 : -1)) };
    expect(sizeTrade({ price: 100, stop: 99, side: 'buy', equity: 100, book: winner, openNotional: 0 }).mult).toBeGreaterThan(1);
    const loser = { ...newBook(100, T), closedR: Array.from({ length: 20 }, (_, i) => (i % 4 ? -1 : 1)) };
    expect(sizeTrade({ price: 100, stop: 99, side: 'buy', equity: 100, book: loser, openNotional: 0 }).mult).toBe(0.5);
  });

  it('keeps the account alive: daily limit, losing streak, a floor that rises with profits', () => {
    let book = updateBook(newBook(30, T), 30, RISK_DEFAULTS, T);
    expect(book.floor).toBeCloseTo(21);
    expect(riskGate(book, 30, 0, RISK_DEFAULTS, T)).toBeNull();
    expect(riskGate(book, 28.4, 0, RISK_DEFAULTS, T)).toMatch(/today/);
    expect(riskGate(book, 30, 2, RISK_DEFAULTS, T)).toMatch(/positions open/);
    for (let i = 0; i < 3; i++) book = recordClose(book, -1, RISK_DEFAULTS, T);
    expect(riskGate(book, 30, 0, RISK_DEFAULTS, T)).toMatch(/3 losses in a row/);
    expect(riskGate(book, 30, 0, RISK_DEFAULTS, T + 61 * 60_000)).toBeNull();
    // the account runs to 40: the floor locks in profit at 0.8 × 40 = 32, above the start
    book = updateBook(book, 40, RISK_DEFAULTS, T + 3_600_000);
    expect(book.floor).toBeCloseTo(32);
    book = updateBook(book, 33, RISK_DEFAULTS, T + 7_200_000);
    expect(book.floor).toBeCloseTo(32);
    expect(riskGate({ ...book, dayStart: 33 }, 31.5, 0, RISK_DEFAULTS, T + 7_200_000)).toMatch(/under its floor/);
    // a deposit is not a gain
    expect(shiftBook(book, 20).start).toBeCloseTo(50);
  });
});

describe('Trend agent and shadow book', () => {
  const hourly = (n, drift, now) =>
    Array.from({ length: n }, (_, i) => {
      const c = 100 + i * drift + (i === n - 1 ? 3 : 0);
      return { time: now - (n - i) * 3_600_000, open: c - drift, high: c + 0.2, low: c - 0.4, close: c };
    });

  it('buys a close above the 20-hour high only with the daily trend up', () => {
    const now = T;
    const rows = hourly(40, 0.1, now);
    const atr = atrOf(rows.slice(0, -1));
    expect(atr).toBeGreaterThan(0);
    const c = trendCandidate(rows, { dir: 1, up: 3 }, undefined, now);
    expect(c).toMatchObject({ side: 'buy', setup: 'trend breakout' });
    expect(c.target - c.price).toBeCloseTo(2 * (c.price - c.stop));
    expect(trendCandidate(rows, { dir: -1, up: 0 }, undefined, now)).toBeNull();
    expect(trendCandidate(rows, null, undefined, now)).toBeNull();
    const daily = Array.from({ length: 130 }, (_, i) => ({ time: i, close: 100 + i }));
    expect(dailyTrendOf(daily)).toMatchObject({ dir: 1, up: 3 });
  });

  it('manages a trend trade: break-even at 1R, trailing from 2R, out at the stop', () => {
    const pos = { side: 'buy', entry: 100, stop: 98, target: 108, risk: 2, atr: 1, openedAt: T, be: false, trailed: false };
    expect(manageTrend(pos, 101, T)).toBeNull();
    expect(manageTrend(pos, 102.1, T).note).toMatch(/break-even/);
    expect(pos.stop).toBe(100);
    expect(manageTrend(pos, 104.5, T).note).toMatch(/trailing/);
    expect(pos.stop).toBeCloseTo(102.5);
    expect(manageTrend(pos, 102.4, T)).toEqual({ exit: 'trail' });
  });

  it('follows refused trades to their stop or target, costs out', () => {
    const s = new Shadow();
    s.add({ coin: 'BTC', side: 'buy', entry: 100, stop: 99, target: 102, t: T, maxHoldMs: 3_600_000, x: [1], agent: 'scalper', costR: 0.1 });
    s.add({ coin: 'ETH', side: 'sell', entry: 10, stop: 11, target: 8, t: T, maxHoldMs: 3_600_000, x: [2], agent: 'trend', costR: 0 });
    expect(s.onPrice('BTC', 101, T + 1000)).toEqual([]);
    expect(s.onPrice('BTC', 102.1, T + 2000)).toEqual([{ x: [1], r: 1.9, agent: 'scalper' }]);
    expect(s.onPrice('ETH', 10.5, T + 3_600_001)).toEqual([{ x: [2], r: -0.5, agent: 'trend' }]);
    expect(s.open).toHaveLength(0);
  });
});

// The Microstructure agent: it reads the last seconds of the book, the tape and the forced
// orders, votes on the timing of a trade in the council, and tells the entries whether to rest
// at the best price or take it now.
import { describe, expect, it } from 'vitest';
import { councilR } from './brain.mjs';
import { entryStyle, MicroWatch, microVote } from './micro.mjs';

const T0 = 1_800_000_000_000;
/** a book with `bid` and `ask` sizes on the top five levels around 100 */
const book = (bidQty, askQty) => [Array.from({ length: 5 }, (_, i) => [99.99 - i * 0.01, bidQty]), Array.from({ length: 5 }, (_, i) => [100.01 + i * 0.01, askQty])];
/** a calm minute of two-sided trading, then `extra` */
function feed(w, { from = T0, secs = 60, extra = [] } = {}) {
  for (let s = 0; s < secs; s++) {
    w.onTrade({ t: from + s * 1000, p: 100, q: 1, s: 'buy' });
    w.onTrade({ t: from + s * 1000 + 500, p: 100, q: 1, s: 'sell' });
  }
  for (const t of extra) w.onTrade(t);
}

describe('the Microstructure agent', () => {
  it('reads book pressure and the microprice: a heavy bid leans the next trade up', () => {
    const w = new MicroWatch();
    const [b, a] = book(30, 10);
    w.onBook(b, a, T0);
    const r = w.read(T0);
    expect(r.book).toBeCloseTo(0.5, 6);
    expect(r.microBps).toBeGreaterThan(0);
    expect(r.spreadBps).toBeCloseTo(2, 1);
    expect(microVote(r, 1).stance).toBe('for');
    expect(microVote(r, -1).stance).toBe('against');
  });

  it('votes against a trade into a burst of aggressive flow the other way', () => {
    const w = new MicroWatch();
    feed(w);
    const t = T0 + 60_000;
    // five seconds of heavy market selling that pushes the price down
    for (let i = 0; i < 20; i++) w.onTrade({ t: t + i * 250, p: 100 - i * 0.005, q: 8, s: 'sell' });
    const r = w.read(t + 5000);
    expect(r.flow).toBeLessThan(-0.8);
    expect(r.burst).toBeGreaterThan(3);
    const v = microVote(r, 1);
    expect(v.stance).toBe('against');
    expect(v.why).toMatch(/burst of aggressive selling/);
    // the same burst is no reason against a short
    expect(microVote(r, -1).stance).not.toBe('against');
  });

  it('sees absorption: heavy selling that did not move the price is a vote for the long', () => {
    const w = new MicroWatch();
    feed(w);
    const t = T0 + 60_000;
    for (let i = 0; i < 20; i++) w.onTrade({ t: t + i * 250, p: 100, q: 4, s: 'sell' });
    const v = microVote(w.read(t + 5000), 1);
    expect(v.stance).toBe('for');
    expect(v.why).toMatch(/absorbed/);
  });

  it('waits out a liquidation cascade against the trade, then likes the snap-back', () => {
    const w = new MicroWatch();
    feed(w);
    const t = T0 + 60_000;
    w.onLiquidations([{ t, p: 100, q: 2000, side: 'sell' }]);
    const during = microVote(w.read(t + 3000), 1);
    expect(during.stance).toBe('against');
    expect(during.why).toMatch(/cascade against it is still running \(\$200k/);
    const after = microVote(w.read(t + 30_000), 1);
    expect(after.stance).toBe('for');
    expect(after.why).toMatch(/just ended/);
  });

  it('says nothing before it has read anything', () => {
    expect(microVote(new MicroWatch().read(T0), 1)).toEqual({ stance: 'abstain', weight: 0, why: 'no order book or tape read yet' });
  });

  it('a vote against tips a borderline trade, but never vetoes (and a tested strategy only hears it as advice)', () => {
    const w = new MicroWatch();
    const [b, a] = book(5, 40);
    w.onBook(b, a, T0);
    const micro = w.read(T0);
    const base = { agent: 'auction', coin: 'BTC', side: 'buy', price: 100, stop: 99, target: 102, setup: 'test', why: 'test', ctx: { daily: null, flow: { deltaRatio: 0 }, book: { imbalance: 0, spreadBps: 2 }, funding: 0, volBps: 10 } };
    const odds = { pWin: 0.5, pLoss: 0.4, expR: 0.05, trust: 0, costR: 0.1 };
    const without = councilR({ cand: base, odds, riskGate: null, sizeNote: 'ok' });
    const withMicro = councilR({ cand: { ...base, ctx: { ...base.ctx, micro } }, odds, riskGate: null, sizeNote: 'ok' });
    expect(without.trade).toBe(true);
    expect(withMicro.trade).toBe(false);
    expect(withMicro.votes.find((v) => v.bot === 'micro').stance).toBe('against');
    expect(withMicro.votes.some((v) => v.stance === 'veto')).toBe(false);
    const tested = councilR({ cand: { ...base, authority: 'tested', ctx: { ...base.ctx, micro } }, odds, riskGate: null, sizeNote: 'ok' });
    expect(tested.trade).toBe(true);
  });

  it('tells the entries when to take the price instead of resting: only when book and tape push hard its way', () => {
    const w = new MicroWatch();
    feed(w);
    const [b, a] = book(40, 5);
    w.onBook(b, a, T0 + 60_000);
    for (let i = 0; i < 10; i++) w.onTrade({ t: T0 + 60_000 + i * 300, p: 100 + i * 0.002, q: 5, s: 'buy' });
    expect(entryStyle(w.read(T0 + 63_000), 1).take).toBe(true);
    expect(entryStyle(w.read(T0 + 63_000), -1).take).toBe(false);
    expect(entryStyle(new MicroWatch().read(T0), 1).take).toBe(false);
  });

  it('knows the price range since a moment (a resting order there would have filled)', () => {
    const w = new MicroWatch();
    feed(w, { secs: 5 });
    w.onTrade({ t: T0 + 6000, p: 99.9, q: 1, s: 'sell' });
    w.onTrade({ t: T0 + 7000, p: 100.2, q: 1, s: 'buy' });
    expect(w.rangeSince(T0 + 5500)).toEqual({ lo: 99.9, hi: 100.2 });
    expect(w.top()).toBeNull();
  });
});

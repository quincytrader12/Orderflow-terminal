// The Microstructure agent's eyes: the last seconds of the order book, the tape and the forced
// orders, per coin. It never proposes a trade; it votes in the council on the timing of one —
// against a trade the market is about to run over, for one the seconds behind it support —
// and tells the smarter entries (cswarm.openLive) whether to wait at the bid or take the offer.
//
// What it reads (all from the feed the swarm already has):
//   book pressure   the size waiting on each side near the price (top levels), in −1 … +1
//   microprice      the price the next trade leans toward: the mid weighted by the opposite side's
//                   size (a heavy bid pulls it up), in bps from the mid
//   flow            aggressive buying minus selling over the last seconds, in −1 … +1
//   burst           that flow's size against its usual pace (3× = a burst)
//   liquidations    forced orders in the last minute: a cascade still running, or one that has
//                   just ended (they overshoot, then snap back)
//   absorption      heavy aggressive selling that did not move the price: someone is soaking it up

export const MICRO_DEFAULTS = {
  /** book levels read on each side */
  levels: 5,
  /** the window the tape is read over, seconds */
  flowSec: 10,
  /** how much the window's volume must exceed its usual pace to count as a burst */
  burstX: 3,
  /** liquidations are read over this window, seconds; a cascade has ended once none came for endSec */
  liqSec: 60,
  liqEndSec: 15,
  /** book pressure this far with the trade (and the microprice too) is a vote for; this far against a vote against */
  bookFor: 0.25,
  bookAgainst: -0.3,
  /** flow this far against the trade, in a burst, is a vote against */
  flowAgainst: -0.4,
  /** absorbed: flow this far against yet the price moved less than this many bps against */
  absorbFlow: -0.35,
  absorbBps: 2,
};

const SEC = 1000;

export class MicroWatch {
  constructor(cfg = {}) {
    this.cfg = { ...MICRO_DEFAULTS, ...cfg };
    this.book = null;
    this.bookT = 0;
    /** recent trades: [t, price, notional, +1 buy / −1 sell]; those before `head` have expired */
    this.trades = [];
    this.head = 0;
    /** recent forced orders: [t, notional, +1 shorts squeezed (buy) / −1 longs liquidated (sell)] */
    this.liqs = [];
    /** the usual notional per window (slow average), for bursts */
    this.pace = 0;
    this.paceAt = 0;
    this.lastT = 0;
  }

  onBook(bids, asks, t = this.lastT) {
    if (!bids?.length || !asks?.length) return;
    this.book = { bids, asks };
    this.bookT = t;
  }

  onTrade(tr) {
    const { t, p, q } = tr ?? {};
    if (!(p > 0) || !(q > 0) || !Number.isFinite(t)) return;
    this.lastT = Math.max(this.lastT, t);
    this.trades.push([t, p, p * q, tr.s === 'buy' ? 1 : -1]);
    this.trim(t);
  }

  onLiquidations(items) {
    for (const l of items ?? []) {
      if (!(l.p > 0) || !(l.q > 0)) continue;
      const t = Number.isFinite(l.t) ? l.t : this.lastT;
      this.lastT = Math.max(this.lastT, t);
      this.liqs.push([t, l.p * l.q, l.side === 'buy' ? 1 : -1]);
    }
    this.trim(this.lastT);
  }

  trim(now) {
    const keep = Math.max(this.cfg.flowSec * 6, this.cfg.liqSec) * SEC;
    // expired trades are skipped by moving a bookmark (shifting a long list for every trade is slow
    // in a busy market); the list is compacted only once the expired part is large
    const tr = this.trades;
    while (this.head < tr.length && tr[this.head][0] < now - keep) this.head++;
    if (this.head > 4096 && this.head * 2 > tr.length) {
      tr.splice(0, this.head);
      this.head = 0;
    }
    while (this.liqs.length && this.liqs[0][0] < now - this.cfg.liqSec * SEC) this.liqs.shift();
    // the usual pace: once a window, a slow average of each window's notional
    if (now - this.paceAt >= this.cfg.flowSec * SEC) {
      const w = this.window(now, this.cfg.flowSec);
      this.pace = this.pace ? 0.9 * this.pace + 0.1 * w.notional : w.notional;
      this.paceAt = now;
    }
  }

  /** the tape over the last `sec` seconds */
  window(now, sec) {
    let buy = 0;
    let sell = 0;
    let first = null;
    let last = null;
    for (let i = this.trades.length - 1; i >= this.head; i--) {
      const [t, p, n, s] = this.trades[i];
      if (t < now - sec * SEC) break;
      if (s > 0) buy += n;
      else sell += n;
      first = p;
      if (last === null) last = p;
    }
    return { buy, sell, notional: buy + sell, first, last };
  }

  /** the lowest and highest trade price since `t0` (a resting order there would have been filled) */
  rangeSince(t0) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = this.trades.length - 1; i >= this.head && this.trades[i][0] >= t0; i--) {
      lo = Math.min(lo, this.trades[i][1]);
      hi = Math.max(hi, this.trades[i][1]);
    }
    return { lo, hi };
  }

  /** the best bid and ask now, or null */
  top() {
    const b = this.book;
    return b ? { bid: b.bids[0][0], ask: b.asks[0][0], bidQty: b.bids[0][1], askQty: b.asks[0][1] } : null;
  }

  /** what the last seconds say, now */
  read(now = this.lastT) {
    const c = this.cfg;
    const out = { ready: false, book: null, microBps: null, spreadBps: null, flow: null, burst: null, moveBps: null, liq: { longs: 0, shorts: 0, running: false, endedAgo: null } };
    const b = this.book;
    if (b && b.bids.length && b.asks.length) {
      const bid = b.bids[0][0];
      const ask = b.asks[0][0];
      const mid = (bid + ask) / 2;
      let bv = 0;
      let av = 0;
      for (const [, q] of b.bids.slice(0, c.levels)) bv += q;
      for (const [, q] of b.asks.slice(0, c.levels)) av += q;
      out.book = bv + av > 0 ? (bv - av) / (bv + av) : 0;
      const bq = b.bids[0][1];
      const aq = b.asks[0][1];
      const micro = bq + aq > 0 ? (bid * aq + ask * bq) / (bq + aq) : mid;
      out.microBps = ((micro - mid) / mid) * 1e4;
      out.spreadBps = ((ask - bid) / mid) * 1e4;
    }
    const w = this.window(now, c.flowSec);
    if (w.notional > 0) {
      out.flow = (w.buy - w.sell) / w.notional;
      out.burst = this.pace > 0 ? w.notional / this.pace : null;
      out.moveBps = w.first && w.last ? ((w.last - w.first) / w.first) * 1e4 : 0;
    }
    let lastLiq = null;
    for (const [t, n, s] of this.liqs) {
      if (t < now - c.liqSec * SEC) continue;
      if (s > 0) out.liq.shorts += n;
      else out.liq.longs += n;
      lastLiq = Math.max(lastLiq ?? 0, t);
    }
    if (lastLiq !== null) {
      out.liq.endedAgo = (now - lastLiq) / SEC;
      out.liq.running = out.liq.endedAgo < c.liqEndSec;
    }
    out.ready = out.book !== null || out.flow !== null || lastLiq !== null;
    return out;
  }
}

const n2 = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
const usdK = (x) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}k` : `$${Math.round(x)}`);

/**
 * The Microstructure agent's vote on a trade in direction `dir` (+1 long, −1 short).
 * Against counts fully (bad timing costs the most); for counts half (it only helps).
 * @returns {{ stance: 'for'|'against'|'abstain', weight: number, why: string }}
 */
export function microVote(r, dir, cfg = MICRO_DEFAULTS) {
  if (!r?.ready) return { stance: 'abstain', weight: 0, why: 'no order book or tape read yet' };
  r = { ...r, liq: r.liq ?? { longs: 0, shorts: 0, running: false, endedAgo: null } };
  const book = r.book === null ? null : r.book * dir;
  const micro = r.microBps === null ? null : r.microBps * dir;
  const flow = r.flow === null ? null : r.flow * dir;
  const burst = r.burst ?? 0;
  const move = (r.moveBps ?? 0) * dir;
  // forced orders: our side being liquidated right now is a falling knife; just after, a snap-back
  const against = dir > 0 ? r.liq.longs : r.liq.shorts;
  const withUs = dir > 0 ? r.liq.shorts : r.liq.longs;
  if (against > 0 && r.liq.running) return { stance: 'against', weight: 1, why: `a liquidation cascade against it is still running (${usdK(against)} forced ${dir > 0 ? 'selling' : 'buying'} in the last minute) — wait for it to end` };
  if (flow !== null && flow <= cfg.flowAgainst && burst >= cfg.burstX && move < -cfg.absorbBps) return { stance: 'against', weight: 1, why: `a burst of aggressive ${dir > 0 ? 'selling' : 'buying'} against it (flow ${n2(flow)}, ${burst.toFixed(1)}× the usual pace, price ${move.toFixed(1)} bps)` };
  if (book !== null && book <= cfg.bookAgainst && (micro === null || micro < 0)) return { stance: 'against', weight: 1, why: `the order book leans against it (pressure ${n2(book)}${micro !== null ? `, next trade leaning ${micro.toFixed(1)} bps the other way` : ''})` };
  // the good kinds of timing
  if (against > 0 && !r.liq.running && r.liq.endedAgo !== null) return { stance: 'for', weight: 0.5, why: `a liquidation cascade against it has just ended (${usdK(against)} forced, none for ${Math.round(r.liq.endedAgo)} s) — these overshoot, then snap back` };
  if (flow !== null && flow <= cfg.absorbFlow && burst >= 1.5 && move >= -cfg.absorbBps) return { stance: 'for', weight: 0.5, why: `aggressive ${dir > 0 ? 'selling' : 'buying'} absorbed (flow ${n2(flow)}, ${burst.toFixed(1)}× pace, price held within ${cfg.absorbBps} bps) — someone is soaking it up` };
  if (book !== null && book >= cfg.bookFor && (micro === null || micro > 0) && (flow === null || flow >= 0)) return { stance: 'for', weight: 0.5, why: `the order book is behind it (pressure ${n2(book)}${micro !== null ? `, next trade leaning ${micro.toFixed(1)} bps its way` : ''})${withUs > 0 && r.liq.running ? ` and the other side is being liquidated (${usdK(withUs)})` : ''}` };
  return { stance: 'abstain', weight: 0, why: `timing neutral (book ${book === null ? '—' : n2(book)}, flow ${flow === null ? '—' : n2(flow)})` };
}

/**
 * How to enter (the smarter entries): wait at the bid (or offer) for a cheaper maker fill, or take
 * the price now when the seconds behind the trade say it is about to run away from a resting order.
 */
export function entryStyle(r, dir) {
  if (!r?.ready || r.book === null) return { take: false, why: 'resting at the best price (no book read to time it)' };
  const book = r.book * dir;
  const micro = (r.microBps ?? 0) * dir;
  const flow = (r.flow ?? 0) * dir;
  if (book >= 0.4 && micro > 0 && flow >= 0.3) return { take: true, why: `taking the price now: the book (${n2(book)}) and the tape (${n2(flow)}) are pushing its way — a resting order would be left behind` };
  return { take: false, why: `resting at the best price for a maker fill (book ${n2(book)}, tape ${n2(flow)})` };
}

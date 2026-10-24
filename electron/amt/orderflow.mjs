// Order-flow hybrid: three setups read from the tape, the footprint, the
// order book and the liquidity map, the way order-flow traders read them.
//
//   absorption    aggressive selling (buying) hits a liquidity level — a
//                 resting wall, a value edge, a swing or a round number — and
//                 price will not go through. Once the aggressors fade and
//                 delta flips, trade the reversal. A wall that is pulled
//                 (spoofed) ends the trade.
//   continuation  a footprint bar prints stacked diagonal imbalances with
//                 initiative delta and volume; when price comes back into
//                 the stack and it holds (delta and order-flow imbalance turn
//                 back with the move), join it toward the next liquidity.
//   sweep         price runs a liquidity pool (swing high/low, prior session
//                 extreme, round number) on a tape or liquidation burst, then
//                 reclaims the level within seconds: fade the stop run.
//
// One bot runs all three and the market decides which one fires: fades of
// absorption are blocked while value is being accepted against them, and
// continuation only joins moves on the initiative side of the POC.
//
// Book-based confirmation (order-flow imbalance, queue imbalance, walls)
// applies whenever the bot has seen the live order book in the last few
// seconds. Backtests and training replay recorded trades only, so they test
// the trade-based core (tape, footprint, pools) of each setup.
//
// Research behind it: order-flow imbalance at the best bid/ask explains
// short-horizon price changes (Cont, Kukanov & Stoikov 2014); queue
// imbalance predicts the next mid-price move (Gould & Bonart 2016).

import { niceBin } from './engine.mjs';

const SEC = 1000;
const MIN = 60_000;
/** book confirmation only counts when the book is this fresh */
const BOOK_FRESH_MS = 5000;

const sumOf = (a) => a.buy + a.sell;
const ratio = (buy, sell) => (buy + sell > 0 ? (buy - sell) / (buy + sell) : 0);
const fx = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const px = (p) => Number(p.toPrecision(7));

/** Per-second tape: aggressor notional, price range and liquidations. */
export class Tape {
  constructor(keepSec = 600) {
    this.keepSec = keepSec;
    this.secs = [];
    this.total = 0;
  }
  bucket(t, p) {
    const s = Math.floor(t / SEC);
    let b = this.secs[this.secs.length - 1];
    // late prints fold into the current second
    if (b && s <= b.s) return b;
    b = { s, buy: 0, sell: 0, hi: p, lo: p, open: p, close: p, liqBuy: 0, liqSell: 0 };
    this.secs.push(b);
    while (this.secs[0].s <= s - this.keepSec) this.total -= sumOf(this.secs.shift());
    return b;
  }
  add(t, p, notional, buy) {
    const b = this.bucket(t, p);
    if (buy) b.buy += notional;
    else b.sell += notional;
    this.total += notional;
    if (p > b.hi) b.hi = p;
    if (p < b.lo) b.lo = p;
    b.close = p;
  }
  /** Forced orders: side 'sell' means longs were liquidated. */
  liquidation(t, p, notional, side) {
    const b = this.bucket(t, p);
    if (side === 'buy') b.liqBuy += notional;
    else b.liqSell += notional;
  }
  /** Normal notional per second over the kept window. */
  baseline() {
    const n = this.secs.length;
    if (n < 2) return NaN;
    const span = Math.min(this.keepSec, this.secs[n - 1].s - this.secs[0].s + 1);
    return span >= 60 ? this.total / span : NaN;
  }
  /** Aggregate over the seconds (now − from, now − to]; from > to ≥ 0. */
  window(now, from, to = 0) {
    const end = Math.floor(now / SEC);
    const out = { buy: 0, sell: 0, hi: -Infinity, lo: Infinity, open: NaN, close: NaN, liqBuy: 0, liqSell: 0, n: 0 };
    for (let i = this.secs.length - 1; i >= 0; i--) {
      const b = this.secs[i];
      if (b.s <= end - from) break;
      if (b.s > end - to) continue;
      out.buy += b.buy;
      out.sell += b.sell;
      out.liqBuy += b.liqBuy;
      out.liqSell += b.liqSell;
      if (b.hi > out.hi) out.hi = b.hi;
      if (b.lo < out.lo) out.lo = b.lo;
      if (Number.isNaN(out.close)) out.close = b.close;
      out.open = b.open;
      out.n++;
    }
    out.delta = ratio(out.buy, out.sell);
    return out;
  }
}

/** Diagonal imbalances: ask at k against bid at k−1 (buyers), bid at k against ask at k+1 (sellers). */
export function stackedImbalances(cells, imbalanceRatio, minRun, minVol) {
  if (!cells.size) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of cells.keys()) {
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  const runs = [];
  for (const dir of [1, -1]) {
    let start = null;
    for (let k = lo; k <= hi + 1; k++) {
      const c = k <= hi ? cells.get(k) : null;
      let imb = false;
      if (c) {
        if (dir > 0) imb = c[1] >= minVol && c[1] >= imbalanceRatio * (cells.get(k - 1)?.[0] ?? 0);
        else imb = c[0] >= minVol && c[0] >= imbalanceRatio * (cells.get(k + 1)?.[1] ?? 0);
      }
      if (imb) start ??= k;
      else {
        if (start !== null && k - start >= minRun) runs.push({ dir, lo: start, hi: k - 1, n: k - start });
        start = null;
      }
    }
  }
  return runs;
}

/** Footprint bars: bid × ask volume per price row. */
export class Footprint {
  constructor(barMs, keep = 360) {
    this.barMs = barMs;
    this.keep = keep;
    this.bars = [];
  }
  /** Adds a print; returns the bar that just closed, if any. */
  add(t, p, row, q, buy) {
    const start = Math.floor(t / this.barMs) * this.barMs;
    let b = this.bars[this.bars.length - 1];
    let closed = null;
    if (!b || start > b.start) {
      closed = b ?? null;
      b = { start, open: p, hi: p, lo: p, close: p, vol: 0, notional: 0, delta: 0, cells: new Map() };
      this.bars.push(b);
      if (this.bars.length > this.keep) this.bars.shift();
    }
    if (p > b.hi) b.hi = p;
    if (p < b.lo) b.lo = p;
    b.close = p;
    b.vol += q;
    b.notional += p * q;
    b.delta += buy ? q : -q;
    let c = b.cells.get(row);
    if (!c) b.cells.set(row, (c = [0, 0]));
    c[buy ? 1 : 0] += q;
    return closed;
  }
}

/**
 * Order book reader: order-flow imbalance at the best bid/ask, queue
 * imbalance at the top levels, and a wall tracker — how long each large
 * resting order has stood, whether it refills as it trades (iceberg) and
 * whether it was pulled before price reached it (spoof).
 */
export class BookTracker {
  constructor() {
    this.prev = null;
    this.ofi = [];
    this.walls = new Map();
    this.pulls = [];
    this.t = -Infinity;
    this.queue = 0;
    this.mid = NaN;
    // trade range since the last book update: tells consumed from pulled
    this.tradeLo = Infinity;
    this.tradeHi = -Infinity;
  }

  fresh(now) {
    return now - this.t <= BOOK_FRESH_MS;
  }

  onTrade(p, q, buy) {
    if (p < this.tradeLo) this.tradeLo = p;
    if (p > this.tradeHi) this.tradeHi = p;
    // prints into a standing wall: buyers lift ask walls, sellers hit bid walls
    for (const w of this.walls.values()) if (w.price === p && (w.side === 'ask') === buy) w.hit += q;
  }

  update(bids, asks, t, cfg) {
    if (!bids?.length || !asks?.length) return;
    const [bid, bq] = bids[0];
    const [ask, aq] = asks[0];
    const pv = this.prev;
    if (pv) {
      // Cont–Kukanov–Stoikov order-flow imbalance between two snapshots
      let e = 0;
      if (bid >= pv.bid) e += bq;
      if (bid <= pv.bid) e -= pv.bq;
      if (ask <= pv.ask) e -= aq;
      if (ask >= pv.ask) e += pv.aq;
      this.ofi.push([t, e]);
      while (this.ofi.length && this.ofi[0][0] < t - 120 * SEC) this.ofi.shift();
    }
    this.prev = { bid, bq, ask, aq };
    let qb = 0;
    let qa = 0;
    for (let i = 0; i < 3; i++) {
      qb += bids[i]?.[1] ?? 0;
      qa += asks[i]?.[1] ?? 0;
    }
    this.queue = ratio(qb, qa);
    this.mid = (bid + ask) / 2;
    this.t = t;
    this.trackWalls(bids, asks, t, cfg);
    this.tradeLo = Infinity;
    this.tradeHi = -Infinity;
  }

  /** OFI over the last `sec` seconds as a −1…+1 ratio (net over gross). */
  ofiRatio(now, sec) {
    let net = 0;
    let gross = 0;
    for (let i = this.ofi.length - 1; i >= 0; i--) {
      const [t, e] = this.ofi[i];
      if (t <= now - sec * SEC) break;
      net += e;
      gross += Math.abs(e);
    }
    return gross > 0 ? net / gross : 0;
  }

  trackWalls(bids, asks, t, cfg) {
    const mid = this.mid;
    const band = (mid * cfg.wallBandBps) / 1e4;
    const sizes = [];
    for (const [p, q] of bids) {
      if (p < mid - band) break;
      sizes.push(q);
    }
    for (const [p, q] of asks) {
      if (p > mid + band) break;
      sizes.push(q);
    }
    if (sizes.length < 6) return;
    sizes.sort((a, b) => a - b);
    const median = sizes[sizes.length >> 1];
    const min = median * cfg.wallX;
    const seen = new Set();
    const scan = (levels, side) => {
      let found = 0;
      for (const [p, q] of levels) {
        if (Math.abs(p - mid) > band) break;
        if (q < min) continue;
        const key = `${side}${p}`;
        seen.add(key);
        const w = this.walls.get(key);
        if (w) {
          w.q = q;
          w.last = t;
          if (q > w.peak) w.peak = q;
          // shrinking as price comes close: spoof signature
          if (q < w.peak * 0.5 && Math.abs(p - mid) / mid < 0.001) w.fading = true;
        } else if (found < 8) this.walls.set(key, { side, price: p, q, peak: q, first: t, last: t, hit: 0, fading: false });
        found++;
      }
    };
    scan(bids, 'bid');
    scan(asks, 'ask');
    for (const [key, w] of this.walls) {
      if (seen.has(key)) continue;
      this.walls.delete(key);
      if (Math.abs(w.price - mid) > band) continue; // drifted out of view
      // traded away (at least half of what it showed): consumed, not spoofed
      if (w.hit >= w.peak * 0.5) continue;
      // gone without trading: pulled (spoofed), whether or not price had reached it
      const touched = w.hit > 0 || (w.side === 'bid' ? this.tradeLo <= w.price : this.tradeHi >= w.price);
      this.pulls.push({ t, side: w.side, price: w.price, q: w.peak, touched });
      if (this.pulls.length > 50) this.pulls.shift();
    }
  }

  /** The strongest standing wall on `side` within `dist` of `price`. */
  wallNear(side, price, dist, now, minAgeSec) {
    let best = null;
    for (const w of this.walls.values()) {
      if (w.side !== side || w.fading || Math.abs(w.price - price) > dist) continue;
      if (now - w.first < minAgeSec * SEC) continue;
      if (!best || w.q > best.q) best = w;
    }
    return best;
  }

  /** Was this wall pulled (gone without trading) since `since`? */
  pulledSince(wall, since) {
    return this.pulls.some((x) => x.t >= since && x.side === wall.side && x.price === wall.price);
  }

  /** Is the wall still standing? */
  standing(wall) {
    return this.walls.has(`${wall.side}${wall.price}`);
  }
}

/** Where stops and resting liquidity collect: swings, prior extremes, round numbers. */
export class Pools {
  constructor() {
    this.levels = [];
    this.version = 0;
    this.cache = null;
    this.cacheKey = '';
  }
  /** Swing pivots from closed footprint bars (k bars either side). */
  onBar(bars, k, t, keepMs) {
    const n = bars.length;
    const i = n - 1 - k;
    if (i < k) return;
    const b = bars[i];
    let high = true;
    let low = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].hi >= b.hi) high = false;
      if (bars[j].lo <= b.lo) low = false;
    }
    if (high) this.add(b.hi, 'high', 'swing high', b.start);
    if (low) this.add(b.lo, 'low', 'swing low', b.start);
    const n0 = this.levels.length;
    this.levels = this.levels.filter((l) => t - l.t <= keepMs);
    if (this.levels.length !== n0) this.version++;
  }
  add(price, side, kind, t) {
    if (this.levels.some((l) => l.side === side && l.price === price)) return;
    this.levels.push({ price, side, kind, t });
    if (this.levels.length > 60) this.levels.shift();
    this.version++;
  }
  remove(level) {
    this.levels = this.levels.filter((l) => l !== level);
    this.version++;
  }
  /** Pools plus the prior session extremes and the round numbers either side of p. */
  all(p, prior, roundStep) {
    // the list only changes with the pools, the prior session or the round bucket
    const key = `${this.version}|${prior?.start}|${roundStep > 0 ? Math.floor(p / roundStep) : 0}`;
    if (key === this.cacheKey) return this.cache;
    const out = [...this.levels];
    if (prior) {
      out.push({ price: prior.high, side: 'high', kind: 'prior high', t: prior.start, fixed: true });
      out.push({ price: prior.low, side: 'low', kind: 'prior low', t: prior.start, fixed: true });
    }
    if (roundStep > 0) {
      // round numbers hold stops on both sides: price may sit on either side of them
      const dn = Math.floor(p / roundStep);
      for (let k = dn - 1; k <= dn + 2; k++) {
        const price = Number((k * roundStep).toPrecision(12));
        out.push({ price, side: 'high', kind: 'round number', t: 0, fixed: true }, { price, side: 'low', kind: 'round number', t: 0, fixed: true });
      }
    }
    this.cacheKey = key;
    this.cache = out;
    return out;
  }
}

/** The order-flow hybrid's state and its three detectors. */
export class OrderFlow {
  constructor(cfg) {
    this.cfg = cfg;
    this.tape = new Tape(600);
    this.fp = new Footprint(cfg.barSec * SEC);
    this.book = new BookTracker();
    this.pools = new Pools();
    this.fpBin = 0;
    this.roundStep = 0;
    this.slot = -1;
    this.absorb = null;
    this.zone = null;
    this.sweep = null;
    /** levels swept recently, so the same level does not sweep twice */
    this.used = [];
    /** when a losing sweep trade last closed, per direction (+1 long, −1 short) */
    this.sweepLoss = new Map();
  }

  /** A trade closed: a losing sweep makes the bot sit out sweeps that way for a while. */
  onClosed(trade) {
    if (trade.setup === 'sweep' && trade.pnl < 0) this.sweepLoss.set(trade.side === 'buy' ? 1 : -1, trade.closed);
  }

  /** Median range of the last 20 closed footprint bars (the one-minute noise). */
  noise() {
    const bars = this.fp.bars;
    const closed = bars.slice(Math.max(0, bars.length - 21), -1);
    if (closed.length < 5) return NaN;
    const r = closed.map((b) => b.hi - b.lo).sort((a, b) => a - b);
    return r[r.length >> 1];
  }

  /** Kaufman efficiency ratio of the last 15 closed bars, with its direction: {er, dir}. */
  trend() {
    const bars = this.fp.bars.slice(Math.max(0, this.fp.bars.length - 16), -1);
    if (bars.length < 8) return { er: 0, dir: 0 };
    let path = 0;
    for (let i = 1; i < bars.length; i++) path += Math.abs(bars[i].close - bars[i - 1].close);
    const net = bars[bars.length - 1].close - bars[0].close;
    return { er: path > 0 ? Math.abs(net) / path : 0, dir: Math.sign(net) };
  }

  onTrade(t, p, q, buy) {
    if (!this.fpBin) {
      this.fpBin = niceBin(p, this.cfg.fpBinBps);
      this.roundStep = this.cfg.roundBps > 0 ? niceBin(p, this.cfg.roundBps) : 0;
    }
    this.tape.add(t, p, p * q, buy);
    this.book.onTrade(p, q, buy);
    const closed = this.fp.add(t, p, Math.round(p / this.fpBin), q, buy);
    if (closed) this.onBar(closed, t);
  }

  onBook(bids, asks, t) {
    this.book.update(bids, asks, t, this.cfg);
  }

  onLiquidation(t, p, notional, side) {
    this.tape.liquidation(t, p, notional, side);
  }

  onBar(bar, t) {
    const c = this.cfg;
    const bars = this.fp.bars;
    this.pools.onBar(bars.slice(0, -1), c.swingBars, t, c.poolHours * 3_600_000);
    const z = this.zone;
    if (z) {
      // a new extreme on opposite delta: the initiative is fading
      if (z.dir > 0 ? bar.hi > z.extreme && bar.delta < 0 : bar.lo < z.extreme && bar.delta > 0) this.zone = null;
      else z.extreme = z.dir > 0 ? Math.max(z.extreme, bar.hi) : Math.min(z.extreme, bar.lo);
    }
    // new stacked imbalances with initiative behind them
    const cells = bar.cells.size;
    if (!c.setups.continuation || cells < c.stackMin) return;
    const minVol = (bar.vol / cells) * 0.5;
    const runs = stackedImbalances(bar.cells, c.imbalanceRatio, c.stackMin, minVol);
    const base = this.tape.baseline();
    const dRatio = bar.vol > 0 ? bar.delta / bar.vol : 0;
    const intensity = base > 0 ? bar.notional / (base * c.barSec) : NaN;
    let best = null;
    for (const r of runs) if (r.dir * dRatio >= c.deltaThreshold && (!best || r.n > best.n)) best = r;
    if (!best || !(intensity >= c.intensityMin)) return;
    this.zone = {
      dir: best.dir,
      lo: (best.lo - 0.5) * this.fpBin,
      hi: (best.hi + 0.5) * this.fpBin,
      n: best.n,
      t: bar.start + c.barSec * SEC,
      extreme: best.dir > 0 ? bar.hi : bar.lo,
      away: false,
      touched: false,
      delta: dRatio,
      intensity,
    };
  }

  /**
   * Runs the detectors (at most four times a second of market time).
   * @returns a trade plan {event, setup, side, stop, target, why, wall} or null
   */
  detect(e, p, t) {
    const slot = Math.floor(t / 250);
    if (slot === this.slot) return null;
    this.slot = slot;
    const c = this.cfg;
    const base = this.tape.baseline();
    if (!(base > 0)) return null;
    const pools = this.pools;
    const round = this.roundStep;
    let levels = null;
    const ctx = {
      e,
      p,
      t,
      base,
      buf: c.stopBufferBins * e.bin,
      bookOn: c.useBook && this.book.fresh(t),
      // built only when a detector needs it
      get levels() {
        return (levels ??= pools.all(p, e.prior, round));
      },
    };
    return (c.setups.sweep && this.detectSweep(ctx)) || (c.setups.absorption && this.detectAbsorption(ctx)) || (c.setups.continuation && this.detectContinuation(ctx)) || null;
  }

  /** Book confirmation in the trade's direction, or why not. */
  bookAgrees(ctx, dir) {
    if (!ctx.bookOn) return null;
    const c = this.cfg;
    const ofi = this.book.ofiRatio(ctx.t, c.ofiSec);
    if (dir * ofi < c.ofiMin) return `order-flow imbalance ${fx(ofi)} does not confirm`;
    if (dir * this.book.queue < -c.queueMin) return `queue imbalance ${fx(this.book.queue)} leans against the trade`;
    return null;
  }

  /** Target: the structure level (POC, pool) when it is far enough, else a fixed multiple of the risk. */
  targetFor(ctx, dir, entry, stop, pick) {
    const c = this.cfg;
    const risk = Math.abs(entry - stop);
    const min = entry + dir * c.minRR * risk;
    if (pick !== undefined && (pick - min) * dir >= 0 && Math.abs(pick - entry) <= 6 * risk) return { price: pick, kind: 'structure' };
    return { price: entry + dir * c.ofTargetR * risk, kind: 'r' };
  }

  // ---------- 1. sweep & reclaim ----------

  detectSweep(ctx) {
    const c = this.cfg;
    const { t, p, e } = ctx;
    if (this.used.length && t - this.used[0].t >= 30 * MIN) this.used = this.used.filter((u) => t - u.t < 30 * MIN);
    const s = this.sweep;
    if (s) {
      const w = this.tape.window(t, 2);
      s.extreme = s.dir > 0 ? Math.max(s.extreme, w.hi) : Math.min(s.extreme, w.lo);
      const run = (Math.abs(s.extreme - s.level.price) / s.level.price) * 1e4;
      if (run > c.sweepMaxBps) {
        // kept going: a breakout, not a stop run
        this.sweep = null;
        e.skip('sweep', `${s.level.kind} ${px(s.level.price)} broke ${fx(run, 1)} bps — breakout, not a sweep`);
        return null;
      }
      if (t - s.t > c.sweepReclaimSec * SEC) {
        this.sweep = null;
        if (s.why) e.skip('sweep', `${s.level.kind} ${px(s.level.price)}: never confirmed in ${c.sweepReclaimSec} s — ${s.why}`);
        return null;
      }
      const back = s.dir > 0 ? p < s.level.price - e.bin : p > s.level.price + e.bin;
      if (!back) {
        // a poke back over the level is not a reclaim: the clock restarts
        s.backSince = null;
        return null;
      }
      s.backSince ??= t;
      const dir = -s.dir;
      // the run has to be over before it is faded:
      // 1. the reclaim holds
      const held = (t - s.backSince) / SEC;
      if (held < c.sweepHoldSec) return this.waitSweep(s, `reclaim held ${fx(held, 0)} of ${c.sweepHoldSec} s`);
      // 2. the cascade has stopped: no forced orders in the sweep's direction lately
      const quiet = this.tape.window(t, c.sweepQuietSec);
      const liqNow = s.dir > 0 ? quiet.liqBuy : quiet.liqSell;
      if (liqNow > 0.02 * ctx.base * c.sweepQuietSec) return this.waitSweep(s, `$${Math.round(liqNow).toLocaleString('en-US')} of ${s.dir > 0 ? 'shorts' : 'longs'} still being liquidated — the cascade is not over`);
      // 3. the aggression that drove the run has dried up
      const fl = this.tape.window(t, c.flipSec);
      const pushRate = (s.dir > 0 ? fl.buy : fl.sell) / c.flipSec;
      if (pushRate > Math.max(0.5 * s.burstRate, ctx.base)) return this.waitSweep(s, `${s.dir > 0 ? 'buyers' : 'sellers'} still pushing at ${fx(pushRate / ctx.base, 1)}× normal`);
      // 4. the other side has taken over
      const flip = fl;
      if (dir * flip.delta < c.flipDelta) return this.waitSweep(s, `delta ${fx(flip.delta)} has not turned`);
      const no = this.bookAgrees(ctx, dir);
      if (no) return this.waitSweep(s, no);
      this.sweep = null;
      // beyond the wick by part of the one-minute range: the second test of a low should not take it out
      const nz = this.noise();
      const stop = s.extreme + s.dir * Math.max(ctx.buf, Number.isFinite(nz) ? 0.5 * nz : 0);
      const poc = e.va?.poc;
      const { price: target, kind: targetKind } = this.targetFor(ctx, dir, p, stop, poc);
      const liq = s.liq;
      return {
        event: dir > 0 ? 'sweep-long' : 'sweep-short',
        setup: 'sweep',
        side: dir > 0 ? 'buy' : 'sell',
        stop,
        target,
        targetKind,
        why: `swept the ${s.level.kind} ${px(s.level.price)} by ${fx(run, 1)} bps on a ${fx(s.burst, 1)}× tape burst${liq > 0 ? ` with $${Math.round(liq).toLocaleString('en-US')} liquidations` : ''}; reclaim held ${fx(held, 0)} s, ${s.dir > 0 ? 'buying' : 'selling'} back to ${fx(pushRate / ctx.base, 1)}× normal, no liquidations for ${c.sweepQuietSec} s — ${dir > 0 ? 'sellers' : 'buyers'} trapped (Δ ${fx(flip.delta)})`,
      };
    }
    const recent = this.tape.window(t, 2);
    // the level stood untouched for the minute before the run began
    const before = this.tape.window(t, 70, 10);
    // no new extreme beyond that minute: nothing can have been swept
    if (!before.n || (recent.hi <= before.hi && recent.lo >= before.lo)) return null;
    const burstW = this.tape.window(t, c.flipSec * 2);
    for (const lv of ctx.levels) {
      if (this.used.some((u) => u.side === lv.side && u.price === lv.price)) continue;
      const up = lv.side === 'high';
      const min = (lv.price * c.sweepMinBps) / 1e4;
      const through = up ? recent.hi > lv.price + min && before.hi < lv.price : recent.lo < lv.price - min && before.lo > lv.price;
      if (!through) continue;
      // the run needs force behind it: a tape burst or forced orders
      const aggr = up ? burstW.buy : burstW.sell;
      const burst = aggr / (ctx.base * c.flipSec * 2);
      const liq = up ? burstW.liqBuy : burstW.liqSell;
      // liquidations alone only count when they are a real share of normal volume
      if (burst < c.sweepBurstX && liq < c.sweepLiqShare * ctx.base * c.flipSec * 2) continue;
      const sdir = up ? 1 : -1;
      this.used.push({ side: lv.side, price: lv.price, t });
      if (!lv.fixed) this.pools.remove(lv);
      // do not fade a run that goes with the market's direction
      const tr = this.trend();
      if (c.ofRegime && tr.dir === sdir && tr.er >= c.erTrend) {
        e.skip('sweep', `${lv.kind} ${px(lv.price)} run in the direction of a ${sdir > 0 ? 'rising' : 'falling'} market (efficiency ${fx(tr.er)}) — continuation is more likely than a reversal`);
        break;
      }
      if (c.ofRegime && e.state === (sdir > 0 ? 'accepted-up' : 'accepted-down')) {
        e.skip('sweep', `${lv.kind} ${px(lv.price)} run while value is being accepted ${sdir > 0 ? 'higher' : 'lower'} — not fading it`);
        break;
      }
      const lost = this.sweepLoss.get(-sdir);
      if (lost !== undefined && t - lost < c.sweepCooloffMin * MIN) {
        e.skip('sweep', `the last ${sdir > 0 ? 'short' : 'long'} sweep trade lost ${Math.round((t - lost) / MIN)} min ago — stop runs that way are not reversing right now`);
        break;
      }
      this.sweep = { dir: sdir, level: lv, extreme: up ? recent.hi : recent.lo, t, burst, liq, burstRate: aggr / (c.flipSec * 2), backSince: null, why: '' };
      break;
    }
    return null;
  }

  /** Still waiting on a sweep: remember why (reported if it never confirms). */
  waitSweep(s, why) {
    s.why = why;
    return null;
  }

  // ---------- 2. absorption at a level ----------

  detectAbsorption(ctx) {
    const c = this.cfg;
    const { t, p, e } = ctx;
    const a = this.absorb;
    if (a) {
      const failed = a.dir > 0 ? p < a.extreme - ctx.buf : p > a.extreme + ctx.buf;
      if (failed || t - a.t > c.absorbConfirmSec * SEC) {
        this.absorb = null;
        return null;
      }
      if (a.wall && !this.book.standing(a.wall) && this.book.pulledSince(a.wall, a.t)) {
        this.absorb = null;
        e.skip('absorption', `${a.wall.side} wall ${px(a.wall.price)} was pulled — not real liquidity`);
        return null;
      }
      const flip = this.tape.window(t, c.flipSec);
      const lifted = a.dir > 0 ? p >= a.extreme + e.bin : p <= a.extreme - e.bin;
      if (!lifted || a.dir * flip.delta < c.flipDelta) return null;
      if (this.bookAgrees(ctx, a.dir)) return null;
      this.absorb = null;
      const stop = (a.dir > 0 ? Math.min(a.extreme, a.wall?.price ?? Infinity) : Math.max(a.extreme, a.wall?.price ?? -Infinity)) - a.dir * ctx.buf;
      const { price: target, kind: targetKind } = this.targetFor(ctx, a.dir, p, stop, e.va?.poc);
      return {
        event: a.dir > 0 ? 'absorb-long' : 'absorb-short',
        setup: 'absorption',
        side: a.dir > 0 ? 'buy' : 'sell',
        stop,
        target,
        targetKind,
        wall: a.wall ? { side: a.wall.side, price: a.wall.price } : null,
        why: `${a.dir > 0 ? 'sellers' : 'buyers'} absorbed at ${a.level} (${fx(a.x, 1)}× volume, Δ ${fx(a.delta)}, price held) — ${a.dir > 0 ? 'buyers' : 'sellers'} took over (Δ ${fx(flip.delta)})`,
      };
    }
    const w = this.tape.window(t, c.absorbSec);
    const prev = this.tape.window(t, c.absorbSec + 60, c.absorbSec);
    if (!prev.n || w.n < c.absorbSec / 3) return null;
    for (const dir of [1, -1]) {
      // dir +1: sellers hitting support that holds → long
      const aggr = dir > 0 ? w.sell : w.buy;
      const x = aggr / (ctx.base * c.absorbSec);
      if (x < c.absorbX || -dir * w.delta < c.absorbDelta) continue;
      const extreme = dir > 0 ? w.lo : w.hi;
      // aggression made (almost) no new extreme beyond the minute before
      const progress = dir > 0 ? prev.lo - w.lo : w.hi - prev.hi;
      if (progress > c.absorbMaxBins * e.bin) continue;
      // and price is still at the extreme being defended
      if (Math.abs(p - extreme) > 2 * e.bin) continue;
      // never fade a market that is accepting value in the aggressors' direction
      if (c.ofRegime && e.state === (dir > 0 ? 'accepted-down' : 'accepted-up')) continue;
      const loc = this.levelAt(ctx, dir, extreme);
      if (!loc) continue;
      this.absorb = { dir, extreme, t, x, delta: w.delta, level: loc.name, wall: loc.wall };
      return null;
    }
    return null;
  }

  /** A liquidity level within reach of `price` on the defending side. */
  levelAt(ctx, dir, price) {
    const c = this.cfg;
    const { e, t } = ctx;
    const near = c.levelBins * e.bin;
    if (ctx.bookOn) {
      const wall = this.book.wallNear(dir > 0 ? 'bid' : 'ask', price, near, t, c.wallMinSec);
      if (wall) return { name: `a ${Math.round((t - wall.first) / SEC)}s ${wall.side} wall ${px(wall.price)}${wall.hit > wall.peak ? ' (refilling — iceberg)' : ''}`, wall };
    }
    const va = e.va;
    const cand = [];
    if (va) cand.push([dir > 0 ? va.val : va.vah, dir > 0 ? 'VAL' : 'VAH']);
    if (e.prior) cand.push([dir > 0 ? e.prior.val : e.prior.vah, dir > 0 ? 'prior VAL' : 'prior VAH']);
    for (const lv of ctx.levels) if (lv.side === (dir > 0 ? 'low' : 'high')) cand.push([lv.price, lv.kind]);
    for (const [lp, name] of cand) if (Number.isFinite(lp) && Math.abs(lp - price) <= near) return { name: `${name} ${px(lp)}`, wall: null };
    return null;
  }

  // ---------- 3. imbalance continuation ----------

  detectContinuation(ctx) {
    const c = this.cfg;
    const { t, p, e } = ctx;
    const z = this.zone;
    if (!z) return null;
    const dir = z.dir;
    if (t - z.t > c.contRetestSec * SEC || (dir > 0 ? p < z.lo - ctx.buf : p > z.hi + ctx.buf)) {
      this.zone = null;
      return null;
    }
    if (!z.touched) {
      // the retest: price moves away from the stack, then comes back into it
      if (dir > 0 ? p > z.hi + e.bin : p < z.lo - e.bin) z.away = true;
      if (z.away && (dir > 0 ? p <= z.hi : p >= z.lo)) {
        z.touched = t;
        z.low = p;
      }
      return null;
    }
    z.low = dir > 0 ? Math.min(z.low, p) : Math.max(z.low, p);
    // the defence: flow measured only since the retest, and price lifting off its low
    const since = Math.min(c.flipSec, Math.floor((t - z.touched) / SEC));
    if (since < 2) return null;
    const flip = this.tape.window(t, since);
    if (dir * flip.delta < c.flipDelta) return null;
    if ((p - z.low) * dir < e.bin) return null;
    if (dir > 0 ? z.low < z.lo : z.low > z.hi) return null;
    if (this.bookAgrees(ctx, dir)) return null;
    this.zone = null;
    if (c.ofRegime && e.va && (p - e.va.poc) * dir < 0) {
      e.skip('continuation', `${dir > 0 ? 'below' : 'above'} the POC — no initiative side to join`);
      return null;
    }
    const stop = (dir > 0 ? z.lo : z.hi) - dir * ctx.buf;
    const risk = Math.abs(p - stop);
    if (ctx.bookOn) {
      // a big wall in the way that is absorbing, not being pulled: skip
      const wall = this.book.wallNear(dir > 0 ? 'ask' : 'bid', p + dir * c.minRR * risk * 0.5, c.minRR * risk * 0.5, t, c.wallMinSec);
      if (wall && wall.hit > 0) {
        e.skip('continuation', `${wall.side} wall ${px(wall.price)} is absorbing in the way`);
        return null;
      }
    }
    // target: the nearest untouched liquidity in the direction of the move
    let pool;
    for (const lv of ctx.levels) {
      const d = (lv.price - p) * dir;
      if (lv.side !== (dir > 0 ? 'high' : 'low') || d < c.minRR * risk) continue;
      if (pool === undefined || d < (pool - p) * dir) pool = lv.price;
    }
    const { price: target, kind: targetKind } = this.targetFor(ctx, dir, p, stop, pool);
    return {
      event: dir > 0 ? 'cont-long' : 'cont-short',
      setup: 'continuation',
      side: dir > 0 ? 'buy' : 'sell',
      stop,
      target,
      targetKind,
      why: `${z.n} stacked ${dir > 0 ? 'buy' : 'sell'} imbalances (${c.imbalanceRatio}:1) on ${fx(z.intensity, 1)}× volume, retested and held — ${dir > 0 ? 'buyers' : 'sellers'} defending (Δ ${fx(flip.delta)})`,
    };
  }

  snapshot(now) {
    const b = this.book;
    const on = b.fresh(now);
    return {
      ofi: on ? b.ofiRatio(now, this.cfg.ofiSec) : null,
      queue: on ? b.queue : null,
      walls: on ? [...b.walls.values()].filter((w) => !w.fading).sort((x, y) => y.q - x.q).slice(0, 6).map((w) => ({ side: w.side, price: w.price, q: w.q, ageSec: Math.round((now - w.first) / SEC), iceberg: w.hit > w.peak })) : [],
      pulls: b.pulls.filter((x) => now - x.t < 5 * MIN).length,
      zone: this.zone && { dir: this.zone.dir, lo: this.zone.lo, hi: this.zone.hi, touched: Boolean(this.zone.touched) },
      sweep: this.sweep && { dir: this.sweep.dir, level: this.sweep.level.price, kind: this.sweep.level.kind },
      absorb: this.absorb && { dir: this.absorb.dir, at: this.absorb.extreme, level: this.absorb.level },
      pools: this.pools.levels.length,
    };
  }
}

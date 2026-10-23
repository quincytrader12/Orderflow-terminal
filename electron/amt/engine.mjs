// Auction Market Theory scalping engine. Pure and clock-free: time comes from
// trade timestamps, so the same code runs live, on paper and in backtests.
//
// The market is read the way AMT describes it:
//   value      — a rolling volume profile; POC and the 70% value area (VAH/VAL)
//   balance    — price rotating inside value
//   probe      — price leaves value by a few bins
//   acceptance — price keeps trading outside value (time beyond the edge)
//   rejection  — the probe fails and price returns inside value quickly
//   prior value / 80% rule — a session that opens outside the prior session's
//                value and then holds back inside it tends to cross that value
// Order flow (aggressor delta, volume intensity, book imbalance) has to agree
// before any setup fires. Two styles:
//
// scalp (seconds to minutes, rolling value):
//   fade      responsive: rejected probe → trade back toward POC
//   breakout  initiative: accepted move with strong delta → trade the extension
//   reentry   80% rule: re-accepted prior value → trade to the far edge
//
// intraday (hours, session structure; flat before the session closes):
//   ibBreakout   initial balance (first hour) extended and held → IB-range target
//   priorAccept  accepted outside prior-day value → trend one value-area width
//   priorReject  failed probe beyond prior-day value → back to prior POC
//   reentry      80% rule, as above
//
// orderflow (seconds to minutes; see orderflow.mjs): the order-flow hybrid —
//   absorption    aggression absorbed at a wall / value edge / swing → reversal
//   continuation  stacked footprint imbalances retested and held → join
//   sweep         liquidity pool swept on a burst, then reclaimed → fade
//
// adaptive (seconds to minutes; see brain.mjs): every scalp and order-flow
// trigger above, judged by a confluence score; stops beyond the noise;
// trades managed on momentum (cut, stall, trail, bank, run); and it learns
// from what price did after each exit.

import { Brain, INITIATIVE, roundTripBps } from './brain.mjs';
import { OrderFlow } from './orderflow.mjs';

const MIN = 60_000;

export const DEFAULT_AMT = {
  // value
  profileMinutes: 240,
  valueAreaPct: 70,
  binBps: 2,
  sessionHours: 24,
  warmupMinutes: 30,
  // order flow
  flowSec: 20,
  deltaThreshold: 0.25,
  intensityMin: 1.5,
  useBook: true,
  bookBandBps: 10,
  bookImbalanceMin: 0.1,
  maxSpreadBps: 5,
  // auction states
  probeBins: 2,
  acceptSec: 60,
  rejectSec: 120,
  reentrySec: 300,
  // setups
  style: 'scalp',
  setups: { fade: true, breakout: true, reentry: true, ibBreakout: true, priorAccept: true, priorReject: true, absorption: true, continuation: true, sweep: true },
  // intraday style (session structure)
  ibMinutes: 60,
  ibAcceptMin: 15,
  priorAcceptMin: 30,
  priorRejectMin: 30,
  intradayFlowSec: 300,
  intradayDelta: 0.1,
  ibTargetX: 1,
  maxTradesPerSession: 3,
  flatBeforeCloseMin: 15,
  trailAtR: 2,
  // order-flow style (footprint, book, liquidity pools, tape)
  barSec: 60,
  fpBinBps: 1,
  imbalanceRatio: 3,
  stackMin: 3,
  contRetestSec: 600,
  absorbSec: 20,
  absorbX: 2,
  absorbDelta: 0.3,
  absorbMaxBins: 1,
  absorbConfirmSec: 30,
  flipSec: 5,
  flipDelta: 0.2,
  levelBins: 3,
  swingBars: 5,
  poolHours: 12,
  roundBps: 50,
  sweepMinBps: 3,
  sweepMaxBps: 25,
  sweepReclaimSec: 90,
  sweepBurstX: 2,
  ofiSec: 10,
  ofiMin: 0.1,
  queueMin: 0.3,
  wallX: 4,
  wallMinSec: 30,
  wallBandBps: 50,
  ofTargetR: 2,
  ofRegime: true,
  // trade manager (every style but intraday; always on for adaptive): stops
  // beyond the noise, cut losers early, take a fading winner, exit stalls,
  // trail without a reflex breakeven, learn from the exits
  manageTrades: false,
  steamAtR: 0.5,
  steamMomentum: 0.25,
  // adaptive style (the judgement layer)
  minScore: 1.5,
  stopNoiseX: 1,
  stopCostX: 3,
  maxStopNoise: 4,
  stallSec: 120,
  exitMomentum: 0.5,
  extendMomentum: 0.4,
  trailNoiseX: 1,
  watchSec: 180,
  benchMin: 30,
  erChop: 0.25,
  erTrend: 0.5,
  // trade management
  stopBufferBins: 2,
  minRR: 1.5,
  maxHoldSec: 900,
  breakevenAtR: 1,
  cooldownSec: 60,
  // risk
  riskUsd: 10,
  maxPositionUsd: 500,
  maxDailyLossUsd: 50,
  maxTradesPerHour: 12,
  allowShort: true,
  // sizing: 'fixed' risks riskUsd per trade; 'balance' risks riskPct of the
  // current balance, so position sizes compound up with gains and shrink
  // after losses (and the loss limits below scale with the balance too)
  sizing: 'fixed',
  /** starting balance for paper trading and backtests (live uses the exchange balance) */
  accountUsd: 1000,
  riskPct: 1,
  /** position value at most balance × this */
  maxLeverage: 5,
  dailyLossPct: 6,
  /** stop the bot for good once the balance is this far below its peak */
  maxDrawdownPct: 25,
  /** after this many losses in a row, sit out pauseMin minutes (0 = off) */
  lossStreak: 0,
  pauseMin: 60,
  /** smallest order the exchange accepts (USD value), filled in from the market */
  minNotionalUsd: 0,
  /** the target must be at least this many times the round-trip fees + slippage */
  targetCostX: 1.5,
  // paper/backtest fill model
  feeBps: 5,
  slippageBps: 1,
  // execution: 'maker' rests post-only limit orders (maker fee) and only
  // falls back to market when the trade is still worth it at market
  orderMode: 'market',
  makerFeeBps: 2,
  makerWaitSec: 10,
  // chase early: once price has run ~0.2R from the limit a 2R trade no longer
  // pays 1.5R at market, and missing the trades that leave at once is how
  // limit entries hurt quality (filled on the losers, missed on the runners)
  makerChaseR: 0.15,
  // breakouts rarely come back to a resting bid: by default they enter at market
  makerInitiative: false,
  exitMakerSec: 6,
};

/** Exits that are not protecting capital may wait a few seconds for a maker fill. */
const PATIENT_EXITS = new Set(['target', 'stalled', 'time']);

/** The Scalp chip: the defaults, with the trade manager and limit-first execution. */
export const SCALP_PRESET = { style: 'scalp', manageTrades: true, orderMode: 'maker' };

/** Starting values when a bot is switched to the intraday style. */
export const INTRADAY_PRESET = {
  style: 'intraday',
  profileMinutes: 1440,
  warmupMinutes: 60,
  setups: { fade: false, breakout: false, reentry: true, ibBreakout: true, priorAccept: true, priorReject: true },
  stopBufferBins: 4,
  minRR: 2,
  maxHoldSec: 8 * 3600,
  cooldownSec: 900,
  maxTradesPerHour: 2,
  breakevenAtR: 1,
};

/**
 * Small account growth: compounds a balance-based risk on A+ scalps only.
 * Stricter order-flow confirmation, wider targets that clear fees several
 * times, a 2R minimum, breakeven at 1R, a pause after a losing streak and a
 * hard stop at a 20 % drawdown. Fees, not setups, decide whether a small
 * account grows, so fewer and larger-edge trades beat many small ones.
 */
export const GROWTH_PRESET = {
  style: 'scalp',
  sizing: 'balance',
  accountUsd: 30,
  riskPct: 2,
  maxLeverage: 5,
  dailyLossPct: 6,
  maxDrawdownPct: 20,
  lossStreak: 3,
  pauseMin: 120,
  setups: { fade: true, breakout: true, reentry: true, ibBreakout: false, priorAccept: false, priorReject: false },
  deltaThreshold: 0.35,
  intensityMin: 2,
  bookImbalanceMin: 0.15,
  minRR: 2,
  targetCostX: 4,
  breakevenAtR: 1,
  maxHoldSec: 1800,
  cooldownSec: 300,
  maxTradesPerHour: 4,
  maxSpreadBps: 3,
  orderMode: 'maker',
  manageTrades: true,
};

/**
 * The order-flow hybrid with small-account growth sizing: absorption,
 * imbalance continuation and sweep & reclaim in one bot, a % of the balance
 * at risk, targets that clear fees 3×, breakeven at 1R, a pause after three
 * losses in a row and a hard stop at a 20 % drawdown.
 */
export const ORDERFLOW_PRESET = {
  style: 'orderflow',
  sizing: 'balance',
  accountUsd: 55,
  riskPct: 1.5,
  maxLeverage: 5,
  dailyLossPct: 6,
  maxDrawdownPct: 20,
  lossStreak: 3,
  pauseMin: 120,
  warmupMinutes: 15,
  setups: { fade: false, breakout: false, reentry: false, ibBreakout: false, priorAccept: false, priorReject: false, absorption: true, continuation: true, sweep: true },
  deltaThreshold: 0.3,
  intensityMin: 1.5,
  stopBufferBins: 1,
  minRR: 1.5,
  targetCostX: 3,
  breakevenAtR: 1,
  maxHoldSec: 1200,
  cooldownSec: 180,
  maxTradesPerHour: 6,
  maxSpreadBps: 3,
  orderMode: 'maker',
  manageTrades: true,
};

/**
 * The adaptive scalper: every trigger in the terminal, judged before entry,
 * managed on momentum while in the trade, learning from its exits. Sizes
 * from the balance like Growth. The fixed breakeven is off: the judgement
 * layer trails by the noise instead.
 */
export const ADAPTIVE_PRESET = {
  style: 'adaptive',
  sizing: 'balance',
  accountUsd: 55,
  riskPct: 1.5,
  maxLeverage: 5,
  dailyLossPct: 6,
  maxDrawdownPct: 20,
  lossStreak: 4,
  pauseMin: 60,
  warmupMinutes: 20,
  setups: { fade: true, breakout: true, reentry: true, ibBreakout: false, priorAccept: false, priorReject: false, absorption: true, continuation: true, sweep: true },
  deltaThreshold: 0.3,
  intensityMin: 1.5,
  stopBufferBins: 1,
  minRR: 1.5,
  targetCostX: 3,
  breakevenAtR: 0,
  trailAtR: 1,
  maxHoldSec: 900,
  cooldownSec: 60,
  maxTradesPerHour: 8,
  maxSpreadBps: 3,
  orderMode: 'maker',
  manageTrades: true,
};

export function mergeConfig(cfg = {}) {
  const out = { ...DEFAULT_AMT };
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'setups') out.setups = { ...DEFAULT_AMT.setups, ...v };
    else if (k in DEFAULT_AMT && typeof v === typeof DEFAULT_AMT[k]) out[k] = v;
  }
  return out;
}

/** Round bin width (1/2/5 × 10^n) close to `bps` of the price. */
export function niceBin(price, bps) {
  const raw = (price * bps) / 1e4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return Number(((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p).toPrecision(6));
}

/**
 * Value area from a bin → volume map: start at the POC and add the heavier
 * neighbouring bin until `pct` of the volume is inside.
 */
export function valueArea(bins, pct) {
  if (!bins.size) return null;
  let poc = 0;
  let max = -1;
  let total = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [k, v] of bins) {
    total += v;
    if (v > max || (v === max && k < poc)) {
      max = v;
      poc = k;
    }
    if (k < lo) lo = k;
    if (k > hi) hi = k;
  }
  if (!(total > 0)) return null;
  let val = poc;
  let vah = poc;
  let acc = max;
  const target = (total * pct) / 100;
  while (acc < target && (val > lo || vah < hi)) {
    const up = vah < hi ? bins.get(vah + 1) ?? 0 : -1;
    const dn = val > lo ? bins.get(val - 1) ?? 0 : -1;
    if (up >= dn) {
      vah++;
      acc += up;
    } else {
      val--;
      acc += dn;
    }
  }
  return { poc, vah, val, total };
}

/** Volume profile over a sliding time window, kept in one-minute buckets. */
class RollingProfile {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.buckets = [];
    this.vol = new Map();
    this.delta = new Map();
  }
  add(t, idx, q, buy) {
    const start = Math.floor(t / MIN) * MIN;
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.start !== start) {
      b = { start, vol: new Map(), delta: new Map() };
      this.buckets.push(b);
    }
    const d = buy ? q : -q;
    b.vol.set(idx, (b.vol.get(idx) ?? 0) + q);
    b.delta.set(idx, (b.delta.get(idx) ?? 0) + d);
    this.vol.set(idx, (this.vol.get(idx) ?? 0) + q);
    this.delta.set(idx, (this.delta.get(idx) ?? 0) + d);
  }
  evict(now) {
    while (this.buckets.length && this.buckets[0].start + MIN <= now - this.windowMs) {
      const b = this.buckets.shift();
      for (const [k, v] of b.vol) {
        const left = (this.vol.get(k) ?? 0) - v;
        if (left > 1e-12) this.vol.set(k, left);
        else this.vol.delete(k);
      }
      for (const [k, v] of b.delta) {
        if (this.vol.has(k)) this.delta.set(k, (this.delta.get(k) ?? 0) - v);
        else this.delta.delete(k);
      }
    }
  }
}

/** Per-second aggressor volume (quote notional) for the last few minutes. */
class FlowWindow {
  constructor(keepSec = 600) {
    this.keepSec = keepSec;
    this.secs = [];
  }
  add(t, notional, buy) {
    const s = Math.floor(t / 1000);
    let b = this.secs[this.secs.length - 1];
    if (!b || b.s !== s) {
      b = { s, buy: 0, sell: 0 };
      this.secs.push(b);
      while (this.secs[0].s <= s - this.keepSec) this.secs.shift();
    }
    if (buy) b.buy += notional;
    else b.sell += notional;
  }
  stats(now, flowSec) {
    const end = Math.floor(now / 1000);
    let buy = 0;
    let sell = 0;
    let all = 0;
    for (let i = this.secs.length - 1; i >= 0; i--) {
      const b = this.secs[i];
      if (b.s <= end - this.keepSec) break;
      all += b.buy + b.sell;
      if (b.s > end - flowSec) {
        buy += b.buy;
        sell += b.sell;
      }
    }
    const span = this.secs.length ? Math.min(this.keepSec, end - this.secs[0].s + 1) : 0;
    const recent = buy + sell;
    const baseline = span > flowSec ? (all / span) * flowSec : NaN;
    return { buy, sell, deltaRatio: recent > 0 ? (buy - sell) / recent : 0, intensity: baseline > 0 ? recent / baseline : NaN };
  }
}

const fmt = (p) => Number(p.toPrecision(7));
const dirOf = (side) => (side === 'buy' ? 1 : -1);
const dayOf = (t) => Math.floor(t / 86_400_000);

export class AmtEngine {
  constructor(cfg = {}) {
    this.cfg = mergeConfig(cfg);
    this.bin = 0;
    this.profile = new RollingProfile(this.cfg.profileMinutes * MIN);
    this.flow = new FlowWindow(600);
    /** order-flow hybrid state (footprint, book, pools), orderflow style only */
    const st = this.cfg.style;
    /** trade manager: adaptive always; every other style but intraday when switched on */
    const managed = st === 'adaptive' || (this.cfg.manageTrades && st !== 'intraday');
    // the manager reads the tape and footprint bars, so managed bots keep them too
    this.of = st === 'orderflow' || st === 'adaptive' || managed ? new OrderFlow(this.cfg) : null;
    this.brain = managed ? new Brain(this.cfg) : null;
    this.session = null;
    this.prior = null;
    this.va = null;
    this.vaAt = -Infinity;
    this.state = 'warmup';
    this.probe = null;
    this.lastProbe = null;
    this.book = null;
    this.last = NaN;
    this.t0 = NaN;
    this.now = 0;
    this.lastTradeT = -Infinity;
    this.pos = null;
    this.pending = null;
    this.halted = null;
    this.haltedForGood = false;
    this.streak = 0;
    /** live balance from the exchange; paper and backtests use accountUsd + P&L */
    this.liveBalance = NaN;
    /** paper/backtest: the engine fills its own resting limits; live bots turn this off */
    this.simulateLimits = true;
    this.cooldownUntil = 0;
    this.entryTimes = [];
    this.lastSignal = null;
    this.lastSkip = null;
    this.trades = [];
    this.equity = [];
    this.stats = { trades: 0, wins: 0, losses: 0, pnl: 0, fees: 0, grossWin: 0, grossLoss: 0, peak: 0, maxDrawdown: 0, day: -1, pnlToday: 0 };
  }

  // ---------- inputs ----------

  /** One trade {t, p, q, s: 'buy'|'sell'} → order intents. */
  onTrade(tr) {
    const { t, p, q } = tr;
    if (!(p > 0) || !(q > 0) || !Number.isFinite(t)) return [];
    if (!this.bin) this.bin = niceBin(p, this.cfg.binBps);
    if (!Number.isFinite(this.t0)) this.t0 = t;
    const buy = tr.s === 'buy';
    const idx = Math.round(p / this.bin);
    this.now = Math.max(this.now, t);
    this.last = p;
    this.lastTradeT = this.now;
    this.rollSession(this.now, p);
    this.trackSession(this.now, p);
    this.profile.add(t, idx, q, buy);
    this.session.bins.set(idx, (this.session.bins.get(idx) ?? 0) + q);
    this.flow.add(t, p * q, buy);
    this.of?.onTrade(t, p, q, buy);
    // paper and backtests: a resting limit fills when a trade prints through it
    const fill = this.simulateLimits ? this.simulateLimitFill(p) : null;
    const out = this.step();
    if (fill) out.unshift(fill);
    return out;
  }

  onBook(bids, asks) {
    this.book = { bids, asks };
    // stamped with market time, so a skewed local clock cannot make it look stale
    this.of?.onBook(bids, asks, this.now);
  }

  /** Forced orders {t, p, q, side}; side 'sell' = longs liquidated. */
  onLiquidations(items) {
    if (!this.of) return;
    for (const l of items) if (l.p > 0 && l.q > 0) this.of.onLiquidation(Math.max(l.t ?? 0, this.now), l.p, l.p * l.q, l.side);
  }

  /** Clock tick without trades (time exits, state timers). */
  tick(now) {
    if (!Number.isFinite(this.last)) return [];
    this.now = Math.max(this.now, now);
    return this.step();
  }

  // ---------- derived market state ----------

  rollSession(t, p) {
    const len = this.cfg.sessionHours * 3_600_000;
    const start = Math.floor(t / len) * len;
    if (this.session?.start === start) return;
    if (this.session) {
      const va = valueArea(this.session.bins, this.cfg.valueAreaPct);
      if (va && this.session.full) this.prior = { vah: va.vah * this.bin, val: va.val * this.bin, poc: va.poc * this.bin, high: this.session.high, low: this.session.low, start: this.session.start };
    }
    // a session counts for the 80% rule only when it was seen from its open
    const fromOpen = Boolean(this.session) || this.t0 <= start + MIN;
    this.session = {
      start,
      end: start + len,
      open: p,
      high: p,
      low: p,
      bins: new Map(),
      full: Boolean(this.session),
      fromOpen,
      inSince: null,
      done: false,
      // initial balance: range of the first ibMinutes
      ibEnd: start + this.cfg.ibMinutes * MIN,
      ibHigh: p,
      ibLow: p,
      ibUp: 0,
      ibDn: 0,
      ibLastT: start,
      ibFired: false,
      pv: null,
      paFired: false,
      prFired: false,
      trades: 0,
    };
  }

  /** Session high/low and initial balance (intraday style). */
  trackSession(t, p) {
    const s = this.session;
    s.high = Math.max(s.high, p);
    s.low = Math.min(s.low, p);
    if (t < s.ibEnd) {
      s.ibHigh = Math.max(s.ibHigh, p);
      s.ibLow = Math.min(s.ibLow, p);
    }
  }

  flowStats(sec = this.cfg.style === 'intraday' ? this.cfg.intradayFlowSec : this.cfg.flowSec) {
    return this.flow.stats(this.now, Math.min(sec, 590));
  }

  bookStats() {
    const b = this.book;
    if (!b?.bids?.length || !b?.asks?.length) return null;
    const bid = b.bids[0][0];
    const ask = b.asks[0][0];
    const mid = (bid + ask) / 2;
    const band = (mid * this.cfg.bookBandBps) / 1e4;
    let bv = 0;
    let av = 0;
    for (const [p, q] of b.bids) {
      if (p < mid - band) break;
      bv += q;
    }
    for (const [p, q] of b.asks) {
      if (p > mid + band) break;
      av += q;
    }
    return { imbalance: bv + av > 0 ? (bv - av) / (bv + av) : 0, spreadBps: ((ask - bid) / mid) * 1e4, bid, ask };
  }

  // ---------- main loop ----------

  step() {
    const c = this.cfg;
    const t = this.now;
    const p = this.last;
    if (t - this.vaAt >= 1000) {
      this.profile.evict(t);
      const va = valueArea(this.profile.vol, c.valueAreaPct);
      this.va = va && { vah: va.vah * this.bin, val: va.val * this.bin, poc: va.poc * this.bin };
      this.vaAt = t;
    }
    const intraday = c.style === 'intraday';
    if (intraday && t - (this.sessionVaAt ?? -Infinity) >= 5000) {
      const sv = valueArea(this.session.bins, c.valueAreaPct);
      this.sessionVa = sv && { vah: sv.vah * this.bin, val: sv.val * this.bin, poc: sv.poc * this.bin };
      this.sessionVaAt = t;
    }
    const out = [];
    this.brain?.afterExits(p, t);
    if (this.pending?.order === 'limit') out.push(...this.work(p, t));
    if (this.pos && !this.pending) {
      const x = this.manage(p, t);
      if (x) out.push(x);
    }
    if (t - this.t0 < c.warmupMinutes * MIN || !this.va) {
      this.state = 'warmup';
      return out;
    }
    if (c.style === 'orderflow' || c.style === 'adaptive') {
      // the auction state still runs: it is the regime filter for the hybrid,
      // and the adaptive style also trades its scalp events
      const ev = c.style === 'adaptive' ? (this.reentryEvent(p, t) ?? this.auction(p, t)) : (this.auction(p, t), null);
      const plan = this.of.detect(this, p, t);
      if ((ev || plan) && !this.pos && !this.pending) {
        const stale = t - this.lastTradeT > Math.max(c.flowSec * 1000, 30_000);
        const e = stale ? this.skip(ev ?? plan.event, 'market data stale') : ev ? this.setup(ev, p, t) : this.enter(plan.event, plan, p, t, c.useBook ? this.bookStats() : null);
        if (e) out.push(e);
      }
      return out;
    }
    const ev = this.reentryEvent(p, t) ?? (intraday ? this.sessionAuction(p, t) : this.auction(p, t));
    if (ev && !this.pos && !this.pending) {
      // never enter on a frozen price (feed outage while the clock keeps ticking)
      const staleMs = Math.max(c.flowSec * 1000, 30_000);
      const e = t - this.lastTradeT > staleMs ? this.skip(ev, `no trades for ${Math.round((t - this.lastTradeT) / 1000)}s — market data stale`) : this.setup(ev, p, t);
      if (e) out.push(e);
    }
    return out;
  }

  /** Probe / acceptance / rejection relative to value frozen when the probe began. */
  auction(p, t) {
    const c = this.cfg;
    const va = this.va;
    const pb = c.probeBins * this.bin;
    if (!this.probe) {
      if (p > va.vah + pb) this.probe = { dir: 1, start: t, ref: { ...va }, extreme: p, outside: 0, lastT: t, accepted: false };
      else if (p < va.val - pb) this.probe = { dir: -1, start: t, ref: { ...va }, extreme: p, outside: 0, lastT: t, accepted: false };
      this.state = this.probe ? (this.probe.dir > 0 ? 'probe-up' : 'probe-down') : 'balance';
      return null;
    }
    const pr = this.probe;
    const up = pr.dir > 0;
    const beyond = up ? p > pr.ref.vah : p < pr.ref.val;
    if (beyond) pr.outside += t - pr.lastT;
    pr.lastT = t;
    pr.extreme = up ? Math.max(pr.extreme, p) : Math.min(pr.extreme, p);
    if (!pr.accepted && pr.outside >= c.acceptSec * 1000) {
      pr.accepted = true;
      this.state = up ? 'accepted-up' : 'accepted-down';
      return up ? 'accept-up' : 'accept-down';
    }
    const inside = up ? p < pr.ref.vah : p > pr.ref.val;
    if (inside) {
      const rejected = !pr.accepted && t - pr.start <= c.rejectSec * 1000;
      this.probe = null;
      this.state = 'balance';
      if (rejected) {
        this.lastProbe = pr;
        return up ? 'reject-up' : 'reject-down';
      }
    }
    return null;
  }

  /** Intraday auction: initial-balance extension and prior-day value acceptance/rejection. */
  sessionAuction(p, t) {
    const c = this.cfg;
    const s = this.session;
    const pr = this.prior;
    let ev = null;
    // initial balance extension, only when the IB was seen from the session open
    if (s.fromOpen && t >= s.ibEnd && s.ibHigh > s.ibLow && !s.ibFired) {
      const dt = Math.max(0, t - Math.max(s.ibLastT, s.ibEnd));
      if (p > s.ibHigh) s.ibUp += dt;
      else if (p < s.ibLow) s.ibDn += dt;
      if (c.setups.ibBreakout && s.ibUp >= c.ibAcceptMin * MIN) ev = 'ib-up';
      else if (c.setups.ibBreakout && s.ibDn >= c.ibAcceptMin * MIN) ev = 'ib-down';
      if (ev) s.ibFired = true;
    }
    s.ibLastT = t;
    // probes of the prior session's value
    if (pr) {
      if (!s.pv) {
        if (p > pr.vah) s.pv = { dir: 1, start: t, outside: 0, lastT: t, extreme: p, accepted: false };
        else if (p < pr.val) s.pv = { dir: -1, start: t, outside: 0, lastT: t, extreme: p, accepted: false };
      } else {
        const pv = s.pv;
        const up = pv.dir > 0;
        if (up ? p > pr.vah : p < pr.val) pv.outside += t - pv.lastT;
        pv.lastT = t;
        pv.extreme = up ? Math.max(pv.extreme, p) : Math.min(pv.extreme, p);
        if (!pv.accepted && pv.outside >= c.priorAcceptMin * MIN) {
          pv.accepted = true;
          if (!ev && c.setups.priorAccept && !s.paFired) {
            s.paFired = true;
            ev = up ? 'prior-accept-up' : 'prior-accept-down';
          }
        }
        if (up ? p < pr.vah : p > pr.val) {
          const deep = Math.abs(pv.extreme - (up ? pr.vah : pr.val)) >= c.probeBins * this.bin;
          const rejected = !pv.accepted && deep && t - pv.start <= c.priorRejectMin * MIN;
          this.lastProbe = { extreme: pv.extreme, ref: pr };
          s.pv = null;
          if (!ev && rejected && c.setups.priorReject && !s.prFired) {
            s.prFired = true;
            ev = up ? 'prior-reject-up' : 'prior-reject-down';
          }
        }
      }
    }
    const pv = s.pv;
    this.state =
      t < s.ibEnd && s.fromOpen
        ? 'ib-forming'
        : pv?.accepted
          ? pv.dir > 0
            ? 'accepted-up'
            : 'accepted-down'
          : pv
            ? pv.dir > 0
              ? 'probe-up'
              : 'probe-down'
            : !pr
              ? 'awaiting-prior'
              : 'balance';
    return ev;
  }

  /** 80% rule: opened outside prior value, then held back inside it. */
  reentryEvent(p, t) {
    const s = this.session;
    const pr = this.prior;
    if (!this.cfg.setups.reentry || !pr || !s.full || s.done) return null;
    const above = s.open > pr.vah;
    const below = s.open < pr.val;
    if (!above && !below) return null;
    if (p <= pr.vah && p >= pr.val) {
      s.inSince ??= t;
      if (t - s.inSince >= this.cfg.reentrySec * 1000) {
        s.done = true;
        return above ? 'reentry-short' : 'reentry-long';
      }
    } else s.inSince = null;
    return null;
  }

  skip(ev, reason) {
    this.lastSkip = { t: this.now, event: ev, reason };
    return null;
  }

  setup(ev, p, t) {
    const c = this.cfg;
    const f = this.flowStats();
    const book = c.useBook ? this.bookStats() : null;
    const buf = c.stopBufferBins * this.bin;
    let side;
    let stop;
    let target;
    let setup;
    let why;
    if (ev === 'reject-up' || ev === 'reject-down') {
      if (!c.setups.fade) return null;
      const up = ev === 'reject-up';
      side = up ? 'sell' : 'buy';
      setup = 'fade';
      const { extreme, ref } = this.lastProbe;
      if (dirOf(side) * f.deltaRatio < c.deltaThreshold) return this.skip(ev, `delta ${f.deltaRatio.toFixed(2)} does not confirm`);
      if (book && dirOf(side) * book.imbalance < c.bookImbalanceMin) return this.skip(ev, `book imbalance ${book.imbalance.toFixed(2)} does not confirm`);
      stop = up ? extreme + buf : extreme - buf;
      target = ref.poc;
      why = `${up ? 'VAH' : 'VAL'} probe rejected, responsive ${up ? 'sellers' : 'buyers'} (Δ ${f.deltaRatio.toFixed(2)})`;
    } else if (ev === 'accept-up' || ev === 'accept-down') {
      if (!c.setups.breakout) return null;
      const up = ev === 'accept-up';
      side = up ? 'buy' : 'sell';
      setup = 'breakout';
      if (dirOf(side) * f.deltaRatio < c.deltaThreshold) return this.skip(ev, `delta ${f.deltaRatio.toFixed(2)} does not confirm`);
      if (!(f.intensity >= c.intensityMin)) return this.skip(ev, `volume ${Number.isFinite(f.intensity) ? f.intensity.toFixed(1) : '—'}× < ${c.intensityMin}×`);
      if (book && dirOf(side) * book.imbalance < c.bookImbalanceMin) return this.skip(ev, `book imbalance ${book.imbalance.toFixed(2)} does not confirm`);
      const ref = this.probe.ref;
      stop = up ? ref.vah - buf : ref.val + buf;
      target = up ? p + (ref.vah - ref.val) : p - (ref.vah - ref.val);
      why = `accepted ${up ? 'above VAH' : 'below VAL'}, initiative ${up ? 'buyers' : 'sellers'} (Δ ${f.deltaRatio.toFixed(2)}, ${f.intensity.toFixed(1)}× volume)`;
    } else if (ev === 'ib-up' || ev === 'ib-down') {
      const up = ev === 'ib-up';
      const s = this.session;
      side = up ? 'buy' : 'sell';
      setup = 'ibBreakout';
      if (dirOf(side) * f.deltaRatio < c.intradayDelta) return this.skip(ev, `${c.intradayFlowSec}s delta ${f.deltaRatio.toFixed(2)} does not confirm`);
      // do not buy an IB break while still below prior value (or sell one above it)
      if (this.prior && (up ? p < this.prior.val : p > this.prior.vah)) return this.skip(ev, `IB break against prior value (${up ? 'below VAL' : 'above VAH'})`);
      const range = s.ibHigh - s.ibLow;
      const room = Math.max(range * 0.25, buf);
      stop = up ? s.ibHigh - room : s.ibLow + room;
      target = up ? s.ibHigh + c.ibTargetX * range : s.ibLow - c.ibTargetX * range;
      why = `initial balance ${up ? 'high' : 'low'} extended and held ${c.ibAcceptMin} min — range extension (IB ${fmt(s.ibLow)}–${fmt(s.ibHigh)}, Δ ${f.deltaRatio.toFixed(2)})`;
    } else if (ev === 'prior-accept-up' || ev === 'prior-accept-down') {
      const up = ev === 'prior-accept-up';
      const pr = this.prior;
      side = up ? 'buy' : 'sell';
      setup = 'priorAccept';
      if (dirOf(side) * f.deltaRatio < c.intradayDelta) return this.skip(ev, `${c.intradayFlowSec}s delta ${f.deltaRatio.toFixed(2)} does not confirm`);
      if (book && dirOf(side) * book.imbalance < -c.bookImbalanceMin) return this.skip(ev, `book leans against the trade (${book.imbalance.toFixed(2)})`);
      const width = pr.vah - pr.val;
      stop = up ? pr.vah - buf : pr.val + buf;
      target = up ? Math.max(pr.vah + width, pr.high ?? 0) : Math.min(pr.val - width, pr.low ?? Infinity);
      why = `accepted ${up ? 'above' : 'below'} prior-day value for ${c.priorAcceptMin} min — value migrating ${up ? 'higher' : 'lower'}`;
    } else if (ev === 'prior-reject-up' || ev === 'prior-reject-down') {
      const up = ev === 'prior-reject-up';
      const { extreme, ref } = this.lastProbe;
      side = up ? 'sell' : 'buy';
      setup = 'priorReject';
      if (dirOf(side) * f.deltaRatio < c.intradayDelta) return this.skip(ev, `${c.intradayFlowSec}s delta ${f.deltaRatio.toFixed(2)} does not confirm`);
      stop = up ? extreme + buf : extreme - buf;
      target = ref.poc;
      why = `probe ${up ? 'above prior VAH' : 'below prior VAL'} failed inside ${c.priorRejectMin} min — responsive return to prior POC`;
    } else {
      const short = ev === 'reentry-short';
      side = short ? 'sell' : 'buy';
      setup = 'reentry';
      if (dirOf(side) * f.deltaRatio <= -c.deltaThreshold) return this.skip(ev, `delta ${f.deltaRatio.toFixed(2)} is against the trade`);
      stop = short ? this.prior.vah + buf : this.prior.val - buf;
      target = short ? this.prior.val : this.prior.vah;
      why = `opened ${short ? 'above' : 'below'} prior value and re-accepted it (80% rule)`;
    }
    // breakout targets are projections (a measured move), the others are levels price has to reach
    return this.enter(ev, { side, stop, target, setup, why, targetKind: INITIATIVE.has(setup) ? 'projection' : 'structure' }, p, t, book);
  }

  /** Common entry checks (risk gates, costs, R:R, size) → an entry intent. */
  enter(ev, plan, p, t, book) {
    const c = this.cfg;
    let { side, stop, target, setup, why } = plan;
    const wall = plan.wall ?? null;
    const gate = this.gate(side, book);
    if (gate) return this.skip(ev, gate);
    if (this.brain) {
      // the trade manager: stop beyond the noise, target that still pays (adaptive: plus the evidence score)
      const v = this.brain.review(this, plan, p, t, book);
      if (v.skip) return this.skip(ev, v.skip);
      ({ stop, target, why } = v);
    }
    const dir = dirOf(side);
    const risk = (p - stop) * dir;
    const reward = (target - p) * dir;
    if (!(risk > 0) || !(reward > 0)) return this.skip(ev, 'price already past stop or target');
    const costBps = this.costBps();
    if ((risk / p) * 1e4 <= costBps) return this.skip(ev, `stop ${((risk / p) * 1e4).toFixed(1)} bps is inside round-trip costs (${costBps} bps)`);
    if (reward / risk < c.minRR) return this.skip(ev, `R:R ${(reward / risk).toFixed(2)} < ${c.minRR}`);
    if ((reward / p) * 1e4 <= costBps * 1.5) return this.skip(ev, `target ${((reward / p) * 1e4).toFixed(1)} bps does not clear fees`);
    if ((reward / p) * 1e4 < costBps * c.targetCostX) return this.skip(ev, `target ${((reward / p) * 1e4).toFixed(1)} bps is under ${c.targetCostX}× round-trip costs`);
    const size = this.size(p, risk);
    if (size.skip) return this.skip(ev, size.skip);
    const qty = size.qty;
    this.lastSignal = { t, event: ev, setup, side, price: p, stop, target, why };
    if (c.orderMode === 'maker' && (c.makerInitiative || !INITIATIVE.has(setup))) {
      // join the queue on our own side of the book: post-only, maker fee
      // (responsive trades — fades, absorption, sweeps — usually trade back to it)
      const limit = this.makerPrice(side, p);
      this.pending = { kind: 'entry', order: 'limit', limit, qty, until: t + c.makerWaitSec * 1000, side, stop, target, setup, why, wall, t };
      return { type: 'enter', order: 'limit', side, qty, price: limit, stop, target, setup, reason: why };
    }
    this.pending = { kind: 'entry', side, stop, target, setup, why, wall, t };
    return { type: 'enter', side, qty, price: p, stop, target, setup, reason: why };
  }

  /** Round-trip cost in bps: maker entry + taker exit with maker orders, taker both ways otherwise. */
  costBps() {
    return roundTripBps(this.cfg);
  }

  /** Best price on our own side of the book (never crossing), or the last trade without a book. */
  makerPrice(side, p) {
    const b = this.bookStats();
    const fresh = b && (!this.of || this.of.book.fresh(this.now));
    if (side === 'buy') return fresh ? Math.min(b.bid, p) : p;
    return fresh ? Math.max(b.ask, p) : p;
  }

  /** Paper/backtest fill of a resting limit: only when a trade prints through it (we are at the back of the queue). */
  simulateLimitFill(p) {
    const pd = this.pending;
    if (pd?.order !== 'limit') return null;
    const buying = pd.kind === 'entry' ? pd.side === 'buy' : this.pos?.side === 'sell';
    if (buying ? !(p < pd.limit) : !(p > pd.limit)) return null;
    const qty = pd.kind === 'entry' ? pd.qty : this.pos.qty;
    const fee = (pd.limit * qty * this.cfg.makerFeeBps) / 1e4;
    const side = buying ? 'buy' : 'sell';
    const kind = pd.kind;
    const info = { type: 'filled', kind, order: 'limit', side, qty, price: pd.limit, fee, setup: pd.setup ?? this.pos?.setup, stop: pd.stop, target: pd.target, reason: kind === 'entry' ? pd.why : pd.reason };
    this.filled({ price: pd.limit, qty, fee });
    return info;
  }

  /**
   * A resting limit is being worked: decide whether to keep waiting, take it
   * at market (only while the trade is still worth it there) or let it go.
   */
  work(p, t) {
    const c = this.cfg;
    const pd = this.pending;
    if (pd.kind === 'exit') {
      const pos = this.pos;
      const dir = dirOf(pos.side);
      const stopped = (p - pos.stop) * dir <= 0;
      if (!stopped && t < pd.until) return [];
      // the stop always wins, and an exit never waits past its few seconds
      const reason = stopped ? 'stop' : pd.reason;
      this.pending = { kind: 'exit', reason, t };
      const then = { type: 'exit', side: pos.side === 'buy' ? 'sell' : 'buy', qty: pos.qty, price: p, reason };
      return [{ type: 'cancel', kind: 'exit', reason: stopped ? `stop hit while the ${pd.reason} limit rested — out at market` : `${pd.reason} limit not filled in ${c.exitMakerSec} s — out at market`, then }];
    }
    const dir = dirOf(pd.side);
    const risk0 = Math.abs(pd.limit - pd.stop);
    const ran = ((p - pd.limit) * dir) / risk0;
    const atStop = (p - pd.stop) * dir <= 0;
    const expired = t >= pd.until;
    if (!atStop && !expired && ran < c.makerChaseR) return [];
    const missed = atStop ? 'price reached the stop before the limit filled' : expired ? `limit ${fmt(pd.limit)} not filled in ${Math.round((t - pd.t) / 1000)} s` : `price ran ${ran.toFixed(2)}R away from the limit`;
    // take it at market only if, from here, it still meets every entry rule
    const risk = (p - pd.stop) * dir;
    const reward = (pd.target - p) * dir;
    const takerCost = 2 * (c.feeBps + c.slippageBps);
    let no = null;
    if (atStop || !(risk > 0) || !(reward > 0)) no = 'nothing left of the trade';
    else if (reward / risk < c.minRR) no = `only ${(reward / risk).toFixed(2)}R left at market`;
    else if ((reward / p) * 1e4 < takerCost * c.targetCostX) no = `target ${((reward / p) * 1e4).toFixed(1)} bps does not clear market fees ${c.targetCostX}×`;
    else if ((risk / p) * 1e4 <= takerCost) no = 'stop inside market fees';
    const size = no ? null : this.size(p, risk);
    if (size?.skip) no = size.skip;
    if (no) {
      this.pending = { ...pd, order: 'cancelling' };
      this.lastSkip = { t, event: `${pd.setup} limit`, reason: `${missed}; ${no} — letting it go, no chasing` };
      return [{ type: 'cancel', kind: 'entry', reason: this.lastSkip.reason, then: null }];
    }
    this.pending = { kind: 'entry', side: pd.side, stop: pd.stop, target: pd.target, setup: pd.setup, why: pd.why, wall: pd.wall, t };
    const note = `${missed}; still ${(reward / risk).toFixed(2)}R to the target — taking it at market`;
    const then = { type: 'enter', side: pd.side, qty: size.qty, price: p, stop: pd.stop, target: pd.target, setup: pd.setup, reason: `${pd.why} · ${note}` };
    return [{ type: 'cancel', kind: 'entry', reason: note, then }];
  }

  /** The exchange refused or dropped a resting limit (e.g. post-only would have crossed): decide now. */
  limitMissed() {
    if (this.pending?.order === 'limit') this.pending.until = -Infinity;
  }

  /** The executor confirmed a cancel with nothing filled. */
  cancelled() {
    if (this.pending?.order === 'cancelling') this.pending = null;
  }

  /** Balance the sizing works from: live balance when known, else start + realised P&L. */
  balance() {
    return Number.isFinite(this.liveBalance) ? this.liveBalance : this.cfg.accountUsd + this.stats.pnl;
  }

  /** Position size for an entry at p with a stop `risk` away (price units). */
  size(p, risk) {
    const c = this.cfg;
    if (c.sizing !== 'balance') return { qty: Math.min(c.riskUsd / risk, c.maxPositionUsd / p) };
    const bal = this.balance();
    if (!(bal > 0)) return { skip: 'no balance to trade' };
    const riskUsd = (bal * c.riskPct) / 100;
    const cap = Math.min(bal * c.maxLeverage, c.maxPositionUsd);
    let qty = Math.min(riskUsd / risk, cap / p);
    if (qty * p < c.minNotionalUsd) {
      // round up to the exchange minimum only if that still fits the leverage
      // cap and does not more than double the intended risk
      const minQty = c.minNotionalUsd / p;
      if (c.minNotionalUsd > cap) return { skip: `exchange minimum $${c.minNotionalUsd} is above ${c.maxLeverage}× the $${bal.toFixed(2)} balance` };
      if (minQty * risk > riskUsd * 2) return { skip: `exchange minimum $${c.minNotionalUsd} would risk $${(minQty * risk).toFixed(2)} (> 2× the ${c.riskPct}% plan) — stop too wide for this balance` };
      qty = minQty;
    }
    return { qty };
  }

  gate(side, book) {
    const c = this.cfg;
    const t = this.now;
    // the daily loss limit lasts until the next UTC day
    if (this.halted && !this.haltedForGood && dayOf(t) !== this.haltedDay) this.halted = null;
    if (this.halted) return this.halted;
    if (side === 'sell' && !c.allowShort) return 'shorts disabled';
    if (t < this.cooldownUntil) return 'cooling down after a loss';
    this.entryTimes = this.entryTimes.filter((x) => t - x < 3_600_000);
    if (this.entryTimes.length >= c.maxTradesPerHour) return `${c.maxTradesPerHour} trades this hour`;
    if (book && book.spreadBps > c.maxSpreadBps) return `spread ${book.spreadBps.toFixed(1)} bps`;
    if (c.style === 'intraday' && this.session.trades >= c.maxTradesPerSession) return `${c.maxTradesPerSession} trades this session`;
    if (c.style === 'intraday' && t >= this.session.end - c.flatBeforeCloseMin * MIN * 4) return 'too close to the session close';
    return null;
  }

  manage(p, t) {
    const c = this.cfg;
    const pos = this.pos;
    const dir = dirOf(pos.side);
    if (!this.brain && c.breakevenAtR > 0 && !pos.be && (p - pos.entry) * dir >= c.breakevenAtR * pos.risk) {
      // move the stop to entry plus round-trip costs — only once price is beyond that level
      const be = pos.entry * (1 + (dir * this.costBps()) / 1e4);
      if ((p - be) * dir > 0 && (be - pos.stop) * dir > 0) {
        pos.stop = be;
        pos.be = true;
      }
    }
    // intraday: once well in profit, trail the stop to the developing session POC
    const sv = this.sessionVa;
    if (c.style === 'intraday' && c.trailAtR > 0 && sv && (p - pos.entry) * dir >= c.trailAtR * pos.risk && (sv.poc - pos.stop) * dir > 0 && (p - sv.poc) * dir > 0) {
      pos.stop = sv.poc;
      pos.trailed = true;
    }
    let reason = null;
    // the judgement layer reads momentum: cut, stall, trail, bank, or run past the target
    if (this.brain) reason = this.brain.manage(this, pos, p, t);
    // the wall the trade leaned on was pulled: the reason for the trade is gone
    if (reason) {
      /* decided above */
    } else if (pos.wall && this.of && this.of.book.pulledSince(pos.wall, pos.t)) reason = 'wall pulled';
    else if ((p - pos.stop) * dir <= 0) reason = pos.trailed ? 'trail' : pos.be ? 'breakeven' : 'stop';
    else if ((p - pos.target) * dir >= 0) reason = 'target';
    else if (t - pos.t >= c.maxHoldSec * 1000) reason = 'time';
    else if (c.style === 'intraday' && t >= this.session.end - c.flatBeforeCloseMin * MIN) reason = 'session close';
    if (!reason) return null;
    const side = pos.side === 'buy' ? 'sell' : 'buy';
    if (c.orderMode === 'maker' && PATIENT_EXITS.has(reason)) {
      // nothing to protect against: offer it on our side of the book for a few seconds
      const limit = this.makerPrice(side, p);
      this.pending = { kind: 'exit', order: 'limit', limit, reason, until: t + c.exitMakerSec * 1000, t };
      return { type: 'exit', order: 'limit', side, qty: pos.qty, price: limit, reason };
    }
    this.pending = { kind: 'exit', reason, t };
    return { type: 'exit', side, qty: pos.qty, price: p, reason };
  }

  // ---------- executor feedback ----------

  /** The executor reports a fill for the pending intent. */
  filled({ price, qty, fee = 0, t = this.now }) {
    const pd = this.pending;
    if (!pd) return;
    this.pending = null;
    if (pd.kind === 'entry') {
      // stop/target keep their distance if the fill slipped
      this.pos = { side: pd.side, entry: price, qty, stop: pd.stop, target: pd.target, stop0: pd.stop, target0: pd.target, setup: pd.setup, why: pd.why, wall: pd.wall ?? null, t, fees: fee, risk: Math.abs(price - pd.stop), be: false };
      this.entryTimes.push(t);
      if (this.session) this.session.trades++;
      return;
    }
    const pos = this.pos;
    if (!pos) return;
    const dir = dirOf(pos.side);
    const fees = pos.fees + fee;
    const pnl = (price - pos.entry) * pos.qty * dir - fees;
    const trade = { side: pos.side, setup: pos.setup, entry: pos.entry, exit: price, qty: pos.qty, pnl, fees, opened: pos.t, closed: t, reason: pd.reason, why: pos.why, risk: pos.risk, stop0: pos.stop0, target0: pos.target0 };
    this.pos = null;
    this.record(trade);
    this.brain?.closed(trade);
  }

  /** The executor could not fill the pending intent. */
  failed(error) {
    const pd = this.pending;
    this.pending = null;
    this.lastSkip = { t: this.now, event: pd?.kind ?? 'order', reason: String(error?.message ?? error) };
  }

  record(trade) {
    const s = this.stats;
    const c = this.cfg;
    this.trades.push(trade);
    if (this.trades.length > 500) this.trades.shift();
    s.trades++;
    s.pnl += trade.pnl;
    s.fees += trade.fees;
    if (trade.pnl >= 0) {
      s.wins++;
      s.grossWin += trade.pnl;
      this.streak = 0;
    } else {
      s.losses++;
      s.grossLoss -= trade.pnl;
      this.cooldownUntil = trade.closed + c.cooldownSec * 1000;
      this.streak = (this.streak ?? 0) + 1;
      if (c.lossStreak > 0 && this.streak >= c.lossStreak) {
        // a losing streak usually means the market changed character: sit out
        this.cooldownUntil = Math.max(this.cooldownUntil, trade.closed + c.pauseMin * MIN);
        this.streak = 0;
      }
    }
    s.peak = Math.max(s.peak, s.pnl);
    s.maxDrawdown = Math.max(s.maxDrawdown, s.peak - s.pnl);
    const d = dayOf(trade.closed);
    if (d !== s.day) {
      s.day = d;
      s.pnlToday = 0;
      s.dayStartBalance = this.balance() - trade.pnl;
    }
    s.pnlToday += trade.pnl;
    this.equity.push([trade.closed, s.pnl]);
    const balanceMode = c.sizing === 'balance';
    const dayLimit = balanceMode ? ((s.dayStartBalance ?? c.accountUsd) * c.dailyLossPct) / 100 : c.maxDailyLossUsd;
    if (s.pnlToday <= -dayLimit) {
      this.halted = balanceMode ? `daily loss limit (${c.dailyLossPct}% of the balance) reached` : `daily loss limit ($${c.maxDailyLossUsd}) reached`;
      this.haltedDay = d;
    }
    if (balanceMode && c.maxDrawdownPct > 0) {
      const peakBal = c.accountUsd + s.peak;
      if (peakBal > 0 && (s.peak - s.pnl) / peakBal >= c.maxDrawdownPct / 100) {
        this.halted = `drawdown limit (${c.maxDrawdownPct}% below the peak balance) reached — review before restarting`;
        this.haltedForGood = true;
      }
    }
  }

  // ---------- reporting ----------

  snapshot(bins = 60) {
    const f = Number.isFinite(this.last) ? this.flowStats() : null;
    const book = this.bookStats();
    const pos = this.pos && { ...this.pos, upnl: (this.last - this.pos.entry) * this.pos.qty * dirOf(this.pos.side) - this.pos.fees };
    let profile = [];
    if (this.bin && Number.isFinite(this.last)) {
      const mid = Math.round(this.last / this.bin);
      for (let k = mid - bins / 2; k <= mid + bins / 2; k++) profile.push([k * this.bin, this.profile.vol.get(k) ?? 0, this.profile.delta.get(k) ?? 0]);
    }
    const warm = Number.isFinite(this.t0) ? Math.max(0, this.cfg.warmupMinutes * 60 - (this.now - this.t0) / 1000) : this.cfg.warmupMinutes * 60;
    const se = this.session;
    return {
      style: this.cfg.style,
      session: se && {
        start: se.start,
        end: se.end,
        open: se.open,
        high: se.high,
        low: se.low,
        ib: se.fromOpen ? { high: se.ibHigh, low: se.ibLow, done: this.now >= se.ibEnd } : null,
        trades: se.trades,
        value: this.sessionVa ?? null,
      },
      state: this.state,
      t: this.now,
      last: this.last,
      bin: this.bin,
      va: this.va,
      prior: this.prior,
      probe: this.probe && { dir: this.probe.dir, extreme: this.probe.extreme, outsideSec: this.probe.outside / 1000, accepted: this.probe.accepted },
      flow: f && { deltaRatio: f.deltaRatio, intensity: Number.isFinite(f.intensity) ? f.intensity : null },
      book: book && { imbalance: book.imbalance, spreadBps: book.spreadBps },
      position: pos,
      pending: this.pending?.kind ?? null,
      working: this.pending?.order === 'limit' ? { kind: this.pending.kind, side: this.pending.kind === 'entry' ? this.pending.side : this.pos?.side === 'buy' ? 'sell' : 'buy', price: this.pending.limit, ageSec: Math.round((this.now - this.pending.t) / 1000) } : null,
      balance: this.cfg.sizing === 'balance' ? this.balance() : null,
      stats: { ...this.stats, pnlToday: this.stats.day === dayOf(this.now) ? this.stats.pnlToday : 0, winRate: this.stats.trades ? this.stats.wins / this.stats.trades : null, profitFactor: this.stats.grossLoss > 0 ? this.stats.grossWin / this.stats.grossLoss : null },
      halted: this.halted,
      warmupSec: Math.round(warm),
      lastSignal: this.lastSignal,
      lastSkip: this.lastSkip,
      trades: this.trades.slice(-20),
      profile,
      orderflow: this.of ? this.of.snapshot(this.now) : null,
      brain: this.brain ? this.brain.snapshot(this, this.now, this.pos) : null,
    };
  }
}

/**
 * Paper fill: market orders fill at the last trade price plus slippage.
 * Resting limits are filled by the engine itself when price trades through
 * them; a cancel goes on to its market order, if it has one.
 */
export function paperFill(engine, intent) {
  if (intent.type === 'filled') return { price: intent.price, fee: intent.fee };
  if (intent.type === 'cancel') {
    if (intent.then) return paperFill(engine, intent.then);
    engine.cancelled();
    return null;
  }
  if (intent.order === 'limit') return null;
  const c = engine.cfg;
  const price = intent.price * (1 + (dirOf(intent.side) * c.slippageBps) / 1e4);
  const fee = (price * intent.qty * c.feeBps) / 1e4;
  engine.filled({ price, qty: intent.qty, fee, t: engine.now });
  return { price, fee };
}

/** Close anything still open and summarise a replay. */
export function finishBacktest(e, trades) {
  if (e.pending?.kind === 'entry') e.pending = null;
  if (e.pos) {
    e.pending = { kind: 'exit', reason: 'end of data' };
    paperFill(e, { side: e.pos.side === 'buy' ? 'sell' : 'buy', qty: e.pos.qty, price: e.last });
  }
  const n = trades.length;
  return { stats: e.snapshot().stats, trades: e.trades, equity: e.equity, from: trades[0]?.t ?? null, to: trades[n - 1]?.t ?? null, count: n, bin: e.bin, config: e.cfg };
}

/** Feed trades [i0, i1) with instant paper fills. */
export function replay(e, trades, i0 = 0, i1 = trades.length) {
  for (let i = i0; i < i1; i++) for (const intent of e.onTrade(trades[i])) paperFill(e, intent);
}

/** Replay recorded trades through the engine with paper fills. */
export function backtest(cfg, trades) {
  const e = new AmtEngine(cfg);
  replay(e, trades);
  return finishBacktest(e, trades);
}

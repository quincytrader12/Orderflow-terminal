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
  setups: { fade: true, breakout: true, reentry: true, ibBreakout: true, priorAccept: true, priorReject: true },
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
  // paper/backtest fill model
  feeBps: 5,
  slippageBps: 1,
};

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
    return this.step();
  }

  onBook(bids, asks) {
    this.book = { bids, asks };
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
    if (this.pos && !this.pending) {
      const x = this.manage(p, t);
      if (x) out.push(x);
    }
    if (t - this.t0 < c.warmupMinutes * MIN || !this.va) {
      this.state = 'warmup';
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
    const gate = this.gate(side, book);
    if (gate) return this.skip(ev, gate);
    const dir = dirOf(side);
    const risk = (p - stop) * dir;
    const reward = (target - p) * dir;
    if (!(risk > 0) || !(reward > 0)) return this.skip(ev, 'price already past stop or target');
    const costBps = 2 * (c.feeBps + c.slippageBps);
    if ((risk / p) * 1e4 <= costBps) return this.skip(ev, `stop ${((risk / p) * 1e4).toFixed(1)} bps is inside round-trip costs (${costBps} bps)`);
    if (reward / risk < c.minRR) return this.skip(ev, `R:R ${(reward / risk).toFixed(2)} < ${c.minRR}`);
    if ((reward / p) * 1e4 <= costBps * 1.5) return this.skip(ev, `target ${((reward / p) * 1e4).toFixed(1)} bps does not clear fees`);
    const qty = Math.min(c.riskUsd / risk, c.maxPositionUsd / p);
    this.pending = { kind: 'entry', side, stop, target, setup, why, t };
    this.lastSignal = { t, event: ev, setup, side, price: p, stop, target, why };
    return { type: 'enter', side, qty, price: p, stop, target, setup, reason: why };
  }

  gate(side, book) {
    const c = this.cfg;
    const t = this.now;
    // the daily loss limit lasts until the next UTC day
    if (this.halted && dayOf(t) !== this.haltedDay) this.halted = null;
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
    if (c.breakevenAtR > 0 && !pos.be && (p - pos.entry) * dir >= c.breakevenAtR * pos.risk) {
      // move the stop to entry plus round-trip costs — only once price is beyond that level
      const be = pos.entry * (1 + (dir * 2 * (c.feeBps + c.slippageBps)) / 1e4);
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
    if ((p - pos.stop) * dir <= 0) reason = pos.trailed ? 'trail' : pos.be ? 'breakeven' : 'stop';
    else if ((p - pos.target) * dir >= 0) reason = 'target';
    else if (t - pos.t >= c.maxHoldSec * 1000) reason = 'time';
    else if (c.style === 'intraday' && t >= this.session.end - c.flatBeforeCloseMin * MIN) reason = 'session close';
    if (!reason) return null;
    this.pending = { kind: 'exit', reason, t };
    return { type: 'exit', side: pos.side === 'buy' ? 'sell' : 'buy', qty: pos.qty, price: p, reason };
  }

  // ---------- executor feedback ----------

  /** The executor reports a fill for the pending intent. */
  filled({ price, qty, fee = 0, t = this.now }) {
    const pd = this.pending;
    if (!pd) return;
    this.pending = null;
    if (pd.kind === 'entry') {
      // stop/target keep their distance if the fill slipped
      this.pos = { side: pd.side, entry: price, qty, stop: pd.stop, target: pd.target, setup: pd.setup, why: pd.why, t, fees: fee, risk: Math.abs(price - pd.stop), be: false };
      this.entryTimes.push(t);
      if (this.session) this.session.trades++;
      return;
    }
    const pos = this.pos;
    if (!pos) return;
    const dir = dirOf(pos.side);
    const fees = pos.fees + fee;
    const pnl = (price - pos.entry) * pos.qty * dir - fees;
    const trade = { side: pos.side, setup: pos.setup, entry: pos.entry, exit: price, qty: pos.qty, pnl, fees, opened: pos.t, closed: t, reason: pd.reason, why: pos.why };
    this.pos = null;
    this.record(trade);
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
    } else {
      s.losses++;
      s.grossLoss -= trade.pnl;
      this.cooldownUntil = trade.closed + c.cooldownSec * 1000;
    }
    s.peak = Math.max(s.peak, s.pnl);
    s.maxDrawdown = Math.max(s.maxDrawdown, s.peak - s.pnl);
    const d = dayOf(trade.closed);
    if (d !== s.day) {
      s.day = d;
      s.pnlToday = 0;
    }
    s.pnlToday += trade.pnl;
    this.equity.push([trade.closed, s.pnl]);
    if (s.pnlToday <= -c.maxDailyLossUsd) {
      this.halted = `daily loss limit ($${c.maxDailyLossUsd}) reached`;
      this.haltedDay = d;
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
      stats: { ...this.stats, pnlToday: this.stats.day === dayOf(this.now) ? this.stats.pnlToday : 0, winRate: this.stats.trades ? this.stats.wins / this.stats.trades : null, profitFactor: this.stats.grossLoss > 0 ? this.stats.grossWin / this.stats.grossLoss : null },
      halted: this.halted,
      warmupSec: Math.round(warm),
      lastSignal: this.lastSignal,
      lastSkip: this.lastSkip,
      trades: this.trades.slice(-20),
      profile,
    };
  }
}

/** Paper fill: market order at the last trade price plus slippage. */
export function paperFill(engine, intent) {
  const c = engine.cfg;
  const price = intent.price * (1 + (dirOf(intent.side) * c.slippageBps) / 1e4);
  const fee = (price * intent.qty * c.feeBps) / 1e4;
  engine.filled({ price, qty: intent.qty, fee, t: engine.now });
  return { price, fee };
}

/** Close anything still open and summarise a replay. */
export function finishBacktest(e, trades) {
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

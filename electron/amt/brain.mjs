// The adaptive scalper's judgement: every trigger the terminal knows (AMT
// fade / breakout / 80% rule, absorption, imbalance continuation, sweep &
// reclaim) has to get past it, and once in a trade it decides — second by
// second, from the tape, the book and price progress — whether the trade is
// still working. It explains every decision in plain words.
//
// Entry: a confluence score. Each piece of evidence counts for or against
// the trade — delta, volume, order-flow and queue imbalance, whether the
// market is rotating or trending (Kaufman efficiency ratio), where price is
// against value, and how the setup has done lately. Below the bar, no trade.
//
// Stop: beyond the structure AND beyond the noise. A stop inside the normal
// one-minute range gets hit by noise, and one narrower than a few times the
// round-trip fees makes fees eat the edge. The stop is widened to clear both
// and the size shrinks to keep the same money at risk. If that pushes the
// stop too far for a scalp, or the structure target too close, it passes.
//
// In the trade: momentum (delta, order-flow imbalance, price velocity, all
// in the trade's direction) is read every second.
//   flow turned   momentum strongly against before +0.5R for 3 s → cut it
//                 at a fraction of the stop
//   stalled       no follow-through within the stall time → out; scalps
//                 that need minutes rarely work
//   trailing      from +1R the stop follows the best price at a noise
//                 distance (never a reflex breakeven that a wick takes out);
//                 breakeven plus fees only from +1.5R
//   faded         from +1R, momentum turning against → bank it
//   extended      at the target with momentum still strong → let it run,
//                 the trail protects it
//
// After the trade it keeps watching price for a few minutes and learns:
//   a stop-out that came back to entry was noise → wider stops
//   an early exit that went on to the target was impatience → more room
//   an early exit that went on to the stop was a save → keep cutting
//   a setup that lost 2.5R over its last 4 trades → benched for a while

const SEC = 1000;
const MIN = 60_000;
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '—');
const f1 = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const sgn = (n) => (n >= 0 ? `+${f2(n)}` : f2(n));
const px = (p) => Number(Number(p).toPrecision(7));
const bps = (d, p) => `${f1((d / p) * 1e4)} bps`;

/** Responsive setups fade the edge; initiative setups go with the move. */
export const RESPONSIVE = new Set(['fade', 'reentry', 'absorption', 'sweep']);
export const INITIATIVE = new Set(['breakout', 'continuation']);

const EARLY = new Set(['flow turned', 'stalled']);
/** seconds of adverse momentum before a losing trade is cut */
const CUT_SEC = 5;
/** the trailing stop only engages once it locks in this much (R, after fees) */
const LOCK_R = 0.25;

export class Brain {
  constructor(cfg) {
    this.cfg = cfg;
    /** stop distance in units of the one-minute noise; adapts to stop-outs */
    this.noiseX = cfg.stopNoiseX;
    /** multiplies the stall time and the momentum needed to cut a trade */
    this.patience = 1;
    this.bench = new Map();
    this.history = [];
    this.watch = [];
    this.thoughts = [];
    this.outbox = [];
    this.lastEval = -Infinity;
    this.velocity = 0;
    this.cache = { t: -Infinity, noise: NaN, regime: null };
  }

  think(t, text) {
    const th = { t, text };
    this.thoughts.push(th);
    if (this.thoughts.length > 40) this.thoughts.shift();
    this.outbox.push(th);
  }

  /** New thoughts since the last call (the bot manager logs them). */
  drain() {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  // ---------- reading the market ----------

  /** Typical one-minute range (median of the last 20 closed bars), refreshed once a second. */
  readMarket(e, t) {
    if (t - this.cache.t < SEC) return this.cache;
    const bars = e.of.fp.bars;
    const closed = bars.slice(Math.max(0, bars.length - 21), -1);
    let noise = NaN;
    if (closed.length >= 5) {
      const r = closed.map((b) => b.hi - b.lo).sort((a, b) => a - b);
      noise = r[r.length >> 1];
    } else {
      const w = e.of.tape.window(t, 60);
      if (w.n) noise = w.hi - w.lo;
    }
    // efficiency ratio over the last 15 bars: net move ÷ path travelled
    let regime = { kind: 'unknown', er: NaN, dir: 0 };
    const last = bars.slice(Math.max(0, bars.length - 16), -1);
    if (last.length >= 8) {
      let path = 0;
      for (let i = 1; i < last.length; i++) path += Math.abs(last[i].close - last[i - 1].close);
      const net = last[last.length - 1].close - last[0].close;
      const er = path > 0 ? Math.abs(net) / path : 0;
      const c = this.cfg;
      regime = { kind: er <= c.erChop ? 'rotation' : er >= c.erTrend ? 'trend' : 'mixed', er, dir: Math.sign(net) };
    }
    this.cache = { t, noise, regime };
    return this.cache;
  }

  /** Momentum in the trade's direction, −1…+1: delta, order-flow imbalance, velocity. */
  momentum(e, dir, t, noise) {
    const c = this.cfg;
    const parts = [];
    const w = e.of.tape.window(t, 10);
    if (w.buy + w.sell > 0) parts.push(clamp((dir * w.delta) / 0.5));
    if (c.useBook && e.of.book.fresh(t)) parts.push(clamp((dir * e.of.book.ofiRatio(t, c.ofiSec)) / 0.5));
    const v = e.of.tape.window(t, 15);
    // price velocity, kept apart too: flow against a price that will not move is absorption, not danger
    this.velocity = v.n && noise > 0 && Number.isFinite(v.open) ? clamp((dir * (v.close - v.open)) / (0.5 * noise)) : 0;
    if (v.n && noise > 0) parts.push(this.velocity);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  }

  // ---------- before the trade ----------

  /**
   * Judge an entry plan. Returns {skip} or the plan's final {stop, target, why}.
   */
  review(e, plan, p, t, book) {
    const c = this.cfg;
    const dir = plan.side === 'buy' ? 1 : -1;
    const setup = plan.setup;
    const benched = this.bench.get(setup);
    if (benched && t < benched.until) return { skip: `${setup} benched for ${Math.ceil((benched.until - t) / MIN)} more min — ${benched.why}` };
    const { noise, regime } = this.readMarket(e, t);

    // evidence for and against
    const ev = [];
    let score = 0;
    const add = (pts, text) => {
      score += pts;
      ev.push(`${text} ${pts > 0 ? '✓' : pts < 0 ? '✗' : '·'}`);
    };
    // reversals are judged on the last seconds (the flip), not on the aggression they fade
    const win = setup === 'absorption' || setup === 'sweep' ? c.flipSec : c.flowSec;
    const f = e.flowStats(win);
    const d = dir * f.deltaRatio;
    add(d >= c.deltaThreshold ? 1 : d <= -c.deltaThreshold ? -1 : 0, `Δ${win}s ${sgn(f.deltaRatio)}`);
    if (Number.isFinite(f.intensity)) add(f.intensity >= c.intensityMin ? 0.5 : f.intensity < 0.6 ? -0.5 : 0, `volume ${f1(f.intensity)}×`);
    if (c.useBook && e.of.book.fresh(t)) {
      const ofi = dir * e.of.book.ofiRatio(t, c.ofiSec);
      add(ofi >= c.ofiMin ? 1 : ofi <= -c.ofiMin ? -1 : 0, `OFI ${sgn(dir * ofi)}`);
      const q = dir * e.of.book.queue;
      add(q >= c.queueMin ? 0.5 : q <= -c.queueMin ? -0.5 : 0, `queue ${sgn(dir * q)}`);
    }
    if (regime.kind === 'rotation') add(RESPONSIVE.has(setup) ? 1 : -1, `rotating market (efficiency ${f2(regime.er)})`);
    else if (regime.kind === 'trend') add(regime.dir === dir ? (INITIATIVE.has(setup) ? 1 : 0.5) : -1, `trending ${regime.dir > 0 ? 'up' : 'down'} (efficiency ${f2(regime.er)})`);
    if (RESPONSIVE.has(setup) && e.va) add((e.va.poc - p) * dir > 0 ? 0.5 : 0, `${dir > 0 ? 'below' : 'above'} the POC`);
    const form = this.history.filter((h) => h.setup === setup).slice(-6);
    if (form.length >= 3) {
      const avg = form.reduce((a, h) => a + h.R, 0) / form.length;
      add(avg > 0.2 ? 0.5 : avg < -0.3 ? -0.5 : 0, `${setup} lately ${sgn(avg)}R/trade`);
    }
    const evidence = `score ${f1(score)}: ${ev.join(', ')}`;
    if (score < c.minScore) return { skip: `not enough agreement (${evidence}; need ${c.minScore})` };

    // stop: beyond the structure, the noise and the fees
    const costs = (2 * (c.feeBps + c.slippageBps) * p) / 1e4;
    let stop = plan.stop;
    let risk = (p - stop) * dir;
    const noiseFloor = Number.isFinite(noise) ? this.noiseX * noise : 0;
    const feeFloor = c.stopCostX * costs;
    const floor = Math.max(noiseFloor, feeFloor);
    let note = '';
    if (risk < floor) {
      stop = p - dir * floor;
      note = ` · stop moved from ${px(plan.stop)} to ${px(stop)}: ${noiseFloor >= feeFloor ? `beyond the noise (${f2(this.noiseX)}× the ${bps(noise, p)} one-minute range)` : `wide enough that fees are under 1/${c.stopCostX} of the risk`}`;
      risk = floor;
    }
    if (noise > 0 && risk > c.maxStopNoise * noise) {
      const why = feeFloor > c.maxStopNoise * noise ? `market too quiet: the one-minute range is ${bps(noise, p)}, and a stop that clears ${bps(costs, p)} of fees ${c.stopCostX}× would be ${f1(risk / noise)}× it` : `the stop would be ${f1(risk / noise)}× the one-minute range — too far for a scalp`;
      return { skip: why };
    }
    // target: keep a structure target only if it still pays enough
    let target = plan.target;
    const rr = ((target - p) * dir) / risk;
    if (rr < c.minRR) {
      if (plan.targetKind !== 'r' && plan.targetKind !== undefined) return { skip: `only ${f2(rr)}R to the ${px(target)} target once the stop is outside the noise — not worth it` };
      target = p + dir * c.ofTargetR * risk;
    }
    return { stop, target, why: `${plan.why} · ${evidence}${note}`, score };
  }

  // ---------- in the trade ----------

  /** Manage an open position; may move its stop/target. Returns an exit reason or null. */
  manage(e, pos, p, t) {
    const c = this.cfg;
    const dir = pos.side === 'buy' ? 1 : -1;
    const r = ((p - pos.entry) * dir) / pos.risk;
    if (!(r <= pos.peakR)) {
      pos.peakR = r;
      pos.peak = p;
    }
    const { noise } = this.readMarket(e, t);
    // at the target: run it if momentum is still strong
    if ((p - pos.target) * dir >= 0) {
      const m = this.momentum(e, dir, t, noise);
      if (m >= c.extendMomentum) {
        const old = pos.target;
        pos.target += dir * pos.risk;
        pos.extended = (pos.extended ?? 0) + 1;
        this.trail(pos, p, noise, dir, t, 0.5);
        this.think(t, `${pos.setup}: reached ${px(old)} with momentum ${sgn(m)} still behind it — letting it run to ${px(pos.target)}, stop trailed to ${px(pos.stop)}`);
      }
      return null;
    }
    if (t - this.lastEval < SEC) return null;
    this.lastEval = t;
    const m = this.momentum(e, dir, t, noise);
    pos.mom = m;
    const held = (t - pos.t) / SEC;
    // 1. losing, flow against it and price moving against it for several seconds: not noise
    if (r < 0 && held >= 5 && m <= -c.exitMomentum / this.patience && this.velocity < -0.25) pos.against = (pos.against ?? 0) + 1;
    else pos.against = 0;
    if (pos.against >= CUT_SEC && r > -0.9) {
      this.think(t, `${pos.setup}: flow turned against the trade (momentum ${sgn(m)} for ${CUT_SEC} s) at ${sgn(r)}R — cutting it before the stop`);
      return 'flow turned';
    }
    // 2. no follow-through
    if (held >= c.stallSec * this.patience && pos.peakR < 0.5 && m < 0.15) {
      this.think(t, `${pos.setup}: no follow-through in ${Math.round(held)} s (best ${sgn(pos.peakR)}R, momentum ${sgn(m)}) — a scalp that stalls usually fails, out at ${sgn(r)}R`);
      return 'stalled';
    }
    // 3. in profit: trail by the noise, bank it when momentum fades
    if (pos.peakR >= c.trailAtR) {
      this.trail(pos, p, noise, dir, t, c.trailNoiseX);
      if (r >= 1 && m <= -0.2) {
        this.think(t, `${pos.setup}: momentum faded (${sgn(m)}) at ${sgn(r)}R — banking it`);
        return 'momentum faded';
      }
    }
    return null;
  }

  /**
   * Move the stop behind the best price by `x` × noise, never loosening it,
   * and only once that locks in at least LOCK_R after fees — a stop parked at
   * breakeven is exactly where a normal wick takes a good trade out.
   */
  trail(pos, p, noise, dir, t, x) {
    const c = this.cfg;
    if (!(noise > 0)) return;
    const tr = pos.peak - dir * x * noise;
    const costs = (pos.entry * 2 * (c.feeBps + c.slippageBps)) / 1e4;
    const locked = ((tr - pos.entry) * dir - costs) / pos.risk;
    if (locked < LOCK_R || (tr - pos.stop) * dir <= 0 || (p - tr) * dir <= 0) return;
    const ns = tr;
    if (!pos.trailed) this.think(t, `${pos.setup}: ${sgn(pos.peakR)}R in — trailing the stop ${f2(x)}× the one-minute range behind the best price (${px(ns)})`);
    pos.stop = ns;
    pos.trailed = true;
  }

  // ---------- after the trade ----------

  /** A trade closed: remember it and keep watching price to judge the exit. */
  closed(tr) {
    const R = tr.risk > 0 && tr.qty > 0 ? tr.pnl / (tr.risk * tr.qty) : 0;
    const h = { setup: tr.setup, R, reason: tr.reason, t: tr.closed, verdict: null };
    this.history.push(h);
    if (this.history.length > 60) this.history.shift();
    if (tr.reason === 'stop' || EARLY.has(tr.reason)) {
      this.watch.push({ h, dir: tr.side === 'buy' ? 1 : -1, entry: tr.entry, stop: tr.stop0, target: tr.target0, risk: tr.risk, until: tr.closed + this.cfg.watchSec * SEC });
    }
    this.benchCheck(tr.setup, tr.closed);
  }

  /** Follow price after recent exits and learn from what it did. */
  afterExits(p, t) {
    if (!this.watch.length) return;
    const keep = [];
    for (const w of this.watch) {
      const h = w.h;
      if (h.reason === 'stop') {
        if ((p - w.entry) * w.dir >= 0) this.verdict(w, 'noise', t);
        else if (t >= w.until) this.verdict(w, 'real', t);
        else keep.push(w);
      } else if ((p - w.target) * w.dir >= 0) this.verdict(w, 'early', t);
      else if ((p - w.stop) * w.dir <= 0) this.verdict(w, 'saved', t);
      else if (t >= w.until) this.verdict(w, 'neutral', t);
      else keep.push(w);
    }
    this.watch = keep;
  }

  verdict(w, v, t) {
    const c = this.cfg;
    w.h.verdict = v;
    const recent = (kinds) => this.history.filter((h) => kinds.includes(h.verdict)).slice(-5);
    if (v === 'noise' || v === 'real') {
      const stops = recent(['noise', 'real']);
      const noisy = stops.filter((h) => h.verdict === 'noise').length;
      if (v === 'noise' && noisy >= 2 && this.noiseX < 2.5) {
        this.noiseX = Math.min(2.5, this.noiseX + 0.25);
        this.think(t, `${noisy} of the last ${stops.length} stop-outs were wicks that came back to the entry — the stops sat inside the noise. Widening them to ${f2(this.noiseX)}× the one-minute range (smaller size, same money at risk)`);
      } else if (v === 'noise') this.think(t, `${w.h.setup}: the stop-out came straight back to the entry — noting it (stops at ${f2(this.noiseX)}× the noise)`);
      else if (this.noiseX > c.stopNoiseX) {
        this.noiseX = Math.max(c.stopNoiseX, this.noiseX - 0.1);
        this.think(t, `${w.h.setup}: that stop-out was a real move, not noise — easing the stop width back to ${f2(this.noiseX)}×`);
      }
    } else if (v === 'early' || v === 'saved') {
      const exits = recent(['early', 'saved', 'neutral']);
      const early = exits.filter((h) => h.verdict === 'early').length;
      if (v === 'early' && early >= 2 && this.patience < 2) {
        this.patience = Math.min(2, this.patience + 0.25);
        this.think(t, `${early} of the last ${exits.length} early exits went on to the target — cutting too soon. Giving trades more room (patience ${f2(this.patience)}×)`);
      } else if (v === 'early') this.think(t, `${w.h.setup}: after the ${w.h.reason} exit price went on to the target — noting it`);
      else {
        if (this.patience > 0.75) this.patience = Math.max(0.75, this.patience - 0.1);
        this.think(t, `${w.h.setup}: the ${w.h.reason} exit was right — price went on to the stop; saved ~${f2(1 + w.h.R)}R`);
      }
    }
  }

  benchCheck(setup, t) {
    const last = this.history.filter((h) => h.setup === setup).slice(-4);
    if (last.length < 4) return;
    const sum = last.reduce((a, h) => a + h.R, 0);
    if (sum > -2.5) return;
    const why = `${sgn(sum)}R over its last 4 trades`;
    this.bench.set(setup, { until: t + this.cfg.benchMin * MIN, why });
    // the record restarts after the bench
    for (const h of last) h.setup = `${setup} (benched)`;
    this.think(t, `${setup}: ${why} — not working in this market, benched for ${this.cfg.benchMin} min`);
  }

  snapshot(e, t, pos) {
    const { noise, regime } = this.cache;
    return {
      noise: Number.isFinite(noise) ? noise : null,
      noiseX: this.noiseX,
      patience: this.patience,
      regime: regime ? { kind: regime.kind, er: Number.isFinite(regime.er) ? regime.er : null, dir: regime.dir } : null,
      momentum: pos && Number.isFinite(pos.mom) ? pos.mom : null,
      benched: [...this.bench].filter(([, b]) => b.until > t).map(([setup, b]) => ({ setup, minutes: Math.ceil((b.until - t) / MIN), why: b.why })),
      thoughts: this.thoughts.slice(-12),
    };
  }
}

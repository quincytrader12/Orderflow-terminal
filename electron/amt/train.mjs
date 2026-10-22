// Training: a walk-forward parameter search over recorded trades.
//
// The data is split in time. Every candidate parameter set replays the whole
// series (the engine is causal, so the later part never leaks into earlier
// decisions), but candidates are RANKED only on the earlier "training" part.
// The best few are then judged on the later "unseen" part, and a result is
// only offered when it also grew the balance there, after fees. Searching
// many settings on one stretch of data always finds something that looks
// good on that stretch; the unseen part is what says whether it was real.
import { cpus } from 'node:os';
import { AmtEngine, mergeConfig, paperFill } from './engine.mjs';

/** What the search varies: the order-flow bar, the auction timers, and trade geometry. */
export const SEARCH = {
  deltaThreshold: [0.2, 0.3, 0.4, 0.5],
  intensityMin: [1.2, 1.6, 2, 2.5],
  minRR: [1.5, 2, 2.5, 3],
  stopBufferBins: [1, 2, 3, 4],
  profileMinutes: [120, 240, 480],
  acceptSec: [30, 60, 120],
  breakevenAtR: [0, 1, 1.5],
  targetCostX: [3, 4, 6],
};

/** The order-flow hybrid's search: how strong the aggression, imbalance and sweep must be, and trade geometry. */
export const ORDERFLOW_SEARCH = {
  absorbX: [1.5, 2, 3],
  absorbDelta: [0.2, 0.3, 0.45],
  flipDelta: [0.1, 0.2, 0.35],
  imbalanceRatio: [2.5, 3, 4],
  stackMin: [2, 3, 4],
  sweepMinBps: [2, 3, 5],
  sweepBurstX: [1.5, 2, 3],
  stopBufferBins: [1, 2, 3],
  ofTargetR: [1.5, 2, 3],
  breakevenAtR: [0, 1, 1.5],
};

/** What to search for these settings. */
export const searchFor = (base) => (base?.style === 'orderflow' ? ORDERFLOW_SEARCH : SEARCH);

/** Deterministic pseudo-random numbers (Park–Miller). */
function rng(seed) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** The base settings first, then up to n−1 distinct random variations of it. */
export function candidates(base, n, seed = 1, space = SEARCH) {
  const r = rng(seed);
  const out = [mergeConfig(base)];
  const seen = new Set([JSON.stringify(Object.keys(space).map((k) => out[0][k]))]);
  for (let tries = 0; out.length < n && tries < n * 50; tries++) {
    const c = { ...out[0], setups: { ...out[0].setups } };
    for (const [k, vals] of Object.entries(space)) c[k] = vals[Math.floor(r() * vals.length)];
    const key = JSON.stringify(Object.keys(space).map((k) => c[k]));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Trades as columns (compact, transferable to workers). */
export function toColumns(rows) {
  const n = rows.length;
  const cols = { t: new Float64Array(n), p: new Float64Array(n), q: new Float64Array(n), s: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    cols.t[i] = r.t ?? r.time;
    cols.p[i] = r.p ?? r.price;
    cols.q[i] = r.q ?? r.qty;
    cols.s[i] = (r.s ?? r.side) === 'buy' ? 1 : 0;
  }
  return cols;
}

/** Feed columns [i0, i1) through the engine with paper fills. */
export function replayColumns(e, cols, i0, i1, fill) {
  const tr = { t: 0, p: 0, q: 0, s: 'buy' };
  for (let i = i0; i < i1; i++) {
    tr.t = cols.t[i];
    tr.p = cols.p[i];
    tr.q = cols.q[i];
    tr.s = cols.s[i] ? 'buy' : 'sell';
    for (const intent of e.onTrade(tr)) fill(e, intent);
  }
}

/** Growth, drawdown and a score for the bot trades in one segment. */
export function segmentMetrics(trades, startBalance, minTrades) {
  let pnl = 0;
  let fees = 0;
  let wins = 0;
  let gw = 0;
  let gl = 0;
  let peak = startBalance;
  let bal = startBalance;
  let dd = 0;
  for (const t of trades) {
    pnl += t.pnl;
    fees += t.fees;
    if (t.pnl >= 0) (wins++, (gw += t.pnl));
    else gl -= t.pnl;
    bal += t.pnl;
    peak = Math.max(peak, bal);
    if (peak > 0) dd = Math.max(dd, (peak - bal) / peak);
  }
  const n = trades.length;
  const growth = startBalance > 0 ? pnl / startBalance : 0;
  // log growth rewards compounding; drawdown is penalised so a lucky,
  // violent equity curve does not beat a steady one
  const score = n < minTrades || 1 + growth <= 0 ? -Infinity : Math.log(1 + growth) - 0.5 * dd;
  return { trades: n, wins, winRate: n ? wins / n : null, pnl, fees, growthPct: growth * 100, maxDrawdownPct: dd * 100, profitFactor: gl > 0 ? gw / gl : null, score, startBalance };
}

/** Replay one candidate over all the data and score the two segments. */
export async function evaluate(params, cols, splitT, { fill, minTrades = 8, yieldEvery = 0 } = {}) {
  const e = new AmtEngine(params);
  // the engine keeps only its last 500 trades for display: collect them all
  const all = [];
  const record = e.record.bind(e);
  e.record = (t) => {
    all.push(t);
    record(t);
  };
  const n = cols.t.length;
  const step = yieldEvery || n;
  for (let i = 0; i < n; i += step) {
    replayColumns(e, cols, i, Math.min(n, i + step), fill);
    if (yieldEvery) await new Promise((r) => setImmediate(r));
  }
  if (e.pos) {
    e.pending = { kind: 'exit', reason: 'end of data' };
    fill(e, { side: e.pos.side === 'buy' ? 'sell' : 'buy', qty: e.pos.qty, price: e.last });
  }
  const start = e.cfg.accountUsd;
  const train = all.filter((t) => t.opened < splitT);
  const test = all.filter((t) => t.opened >= splitT);
  const trainM = segmentMetrics(train, start, minTrades);
  const testM = segmentMetrics(test, start + trainM.pnl, Math.max(3, Math.round(minTrades / 3)));
  return { train: trainM, test: testM };
}

/** Rank on the training part; judge the leaders on the unseen part. */
export function pick(results, top = 5) {
  const ranked = results.map((r, i) => ({ ...r, i })).sort((a, b) => b.train.score - a.train.score);
  const leaders = ranked.filter((r) => Number.isFinite(r.train.score)).slice(0, top);
  const verified = leaders.filter((r) => Number.isFinite(r.test.score) && r.test.pnl > 0).sort((a, b) => b.test.score - a.test.score);
  return { leaders, best: verified[0] ?? null };
}

/** Run candidates on a small pool of worker threads; fall back to this thread. */
async function runAll(cands, cols, splitT, opts, onProgress, makeWorker) {
  const results = new Array(cands.length);
  let done = 0;
  const report = () => onProgress?.(++done / cands.length);
  const size = Math.max(1, Math.min(opts.workers ?? Math.min(4, cpus().length - 1), cands.length));
  let pool = [];
  if (makeWorker && size > 1) {
    try {
      pool = Array.from({ length: size }, () => makeWorker());
    } catch {
      pool = [];
    }
  }
  if (pool.length) {
    let next = 0;
    const work = (w) =>
      new Promise((resolve, reject) => {
        const go = () => {
          if (next >= cands.length) return resolve();
          const i = next++;
          w.once('message', (m) => {
            if (m.error) return reject(new Error(m.error));
            results[i] = m.result;
            report();
            go();
          });
          w.postMessage({ type: 'eval', params: cands[i], splitT, minTrades: opts.minTrades });
        };
        w.once('error', reject);
        w.postMessage({ type: 'data', cols });
        go();
      });
    try {
      await Promise.all(pool.map(work));
      return results;
    } catch {
      // a worker failed (e.g. could not load): finish in this thread
    } finally {
      for (const w of pool) void w.terminate();
    }
  }
  for (let i = 0; i < cands.length; i++) {
    if (results[i]) continue;
    results[i] = await evaluate(cands[i], cols, splitT, { fill: paperFill, minTrades: opts.minTrades, yieldEvery: 50_000 });
    report();
  }
  return results;
}

/**
 * Train a bot's settings on recorded trades.
 * @returns verdict 'verified' with the parameters to apply, or 'no-edge'
 */
export async function train({ base, rows, cols, n = 40, split = 0.7, seed = 1, minTrades = 8, workers, onProgress, makeWorker }) {
  cols ??= toColumns(rows);
  const len = cols.t.length;
  if (len < 10_000) throw new Error(`only ${len} recorded trades — training needs a few hours of data (let the terminal record first)`);
  const splitT = cols.t[Math.floor(len * split)];
  const space = searchFor(base);
  const cands = candidates(base, n, seed, space);
  const results = await runAll(cands, cols, splitT, { workers, minTrades }, onProgress, makeWorker);
  const { leaders, best } = pick(results);
  const baseline = results[0];
  const row = (r) => ({ params: Object.fromEntries(Object.keys(space).map((k) => [k, cands[r.i][k]])), train: r.train, test: r.test, base: r.i === 0 });
  return {
    verdict: best ? 'verified' : 'no-edge',
    params: best ? cands[best.i] : null,
    best: best ? row(best) : null,
    baseline: { train: baseline.train, test: baseline.test },
    leaders: leaders.map(row),
    searched: cands.length,
    count: len,
    from: cols.t[0],
    to: cols.t[len - 1],
    splitT,
  };
}

// Data for the Telegram daily report and weekly overview, gathered in the
// desktop process: AMT bot trades and orders from the database, value areas
// from recorded trades, exchange balances/positions and Phantom wallets.
// Live market data (price, funding, liquidations, charts) is added by the UI.
import { niceBin, valueArea } from './amt/engine.mjs';

export const DAY = 86_400_000;

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms))]);

/** High/low volume nodes: local maxima and minima of the profile. */
export function volumeNodes(rows, poc) {
  if (rows.length < 5) return { hvn: [], lvn: [] };
  const sorted = [...rows].sort((a, b) => a[0] - b[0]);
  const lo = sorted[0][0];
  const hi = sorted[sorted.length - 1][0];
  const dense = new Map(sorted);
  const ks = [];
  for (let k = lo; k <= hi; k++) ks.push(k);
  // 3-bin smoothing keeps single-bin noise from looking like a node
  const v = ks.map((k, i) => ((dense.get(ks[i - 1]) ?? 0) + (dense.get(k) ?? 0) * 2 + (dense.get(ks[i + 1]) ?? 0)) / 4);
  const max = Math.max(...v);
  const W = 3;
  const pocI = ks.indexOf(poc);
  const hiIdx = [];
  const loIdx = [];
  for (let i = W; i < ks.length - W; i++) {
    const win = v.slice(i - W, i + W + 1);
    if (v[i] === Math.max(...win) && v[i] >= max * 0.4 && Math.abs(i - pocI) > W) hiIdx.push(i);
    if (v[i] === Math.min(...win) && v[i] <= max * 0.25) loIdx.push(i);
  }
  // a flat stretch gives many equal extremes: keep the middle of each run
  const runs = (idx) => {
    const out = [];
    let run = [];
    for (const i of idx) {
      if (run.length && i - run[run.length - 1] > 1) {
        out.push(run[Math.floor(run.length / 2)]);
        run = [];
      }
      run.push(i);
    }
    if (run.length) out.push(run[Math.floor(run.length / 2)]);
    return out;
  };
  const hvn = runs(hiIdx).map((i) => [ks[i], v[i]]);
  const lvn = runs(loIdx).map((i) => [ks[i], v[i]]);
  hvn.sort((a, b) => b[1] - a[1]);
  lvn.sort((a, b) => a[1] - b[1]);
  return { hvn: hvn.slice(0, 3).map((x) => x[0]), lvn: lvn.slice(0, 3).map((x) => x[0]) };
}

/** POC, value area and volume nodes of recorded trades in [from, to]. */
export function profileLevels(db, venue, symbol, from, to, pct = 70) {
  const r = db.tradeRange(venue, symbol, from, to);
  if (!r || r.n < 200) return null;
  const bin = niceBin((r.high + r.low) / 2, 5);
  const rows = db.volumeProfile(venue, symbol, from, to, bin);
  const va = valueArea(new Map(rows), pct);
  if (!va) return null;
  const nodes = volumeNodes(rows, va.poc);
  // at most ~90 rows for charts
  const step = Math.max(1, Math.ceil(rows.length / 90));
  const grouped = new Map();
  for (const [k, vol] of rows) {
    const g = Math.floor(k / step) * step;
    grouped.set(g, (grouped.get(g) ?? 0) + vol);
  }
  return {
    ...r,
    bin,
    poc: va.poc * bin,
    vah: va.vah * bin,
    val: va.val * bin,
    hvn: nodes.hvn.map((k) => k * bin),
    lvn: nodes.lvn.map((k) => k * bin),
    profile: [...grouped].sort((a, b) => a[0] - b[0]).map(([k, vol]) => [(k + step / 2) * bin, vol]),
  };
}

export function summarizeBots(rows) {
  const bots = new Map();
  const setups = new Map();
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity = [];
  for (const r of rows) {
    const b = bots.get(r.bot_id) ?? { name: r.bot_name, symbol: r.symbol, mode: r.mode, trades: 0, wins: 0, pnl: 0, fees: 0 };
    b.trades++;
    if (r.pnl >= 0) b.wins++;
    b.pnl += r.pnl;
    b.fees += r.fees ?? 0;
    bots.set(r.bot_id, b);
    const s = setups.get(r.setup) ?? { setup: r.setup, trades: 0, wins: 0, pnl: 0 };
    s.trades++;
    if (r.pnl >= 0) s.wins++;
    s.pnl += r.pnl;
    setups.set(r.setup, s);
    cum += r.pnl;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
    equity.push([r.closed, cum]);
  }
  const byPnl = [...rows].sort((a, b) => b.pnl - a.pnl);
  const pick = (r) => r && { bot: r.bot_name, symbol: r.symbol, setup: r.setup, side: r.side, pnl: r.pnl, closed: r.closed };
  return {
    trades: rows.length,
    wins: rows.filter((r) => r.pnl >= 0).length,
    pnl: cum,
    fees: rows.reduce((a, r) => a + (r.fees ?? 0), 0),
    maxDrawdown,
    bots: [...bots.values()],
    setups: [...setups.values()],
    best: pick(byPnl[0]),
    worst: pick(byPnl.length > 1 ? byPnl[byPnl.length - 1] : undefined),
    equity,
  };
}

export function summarizeOrders(rows) {
  const out = { placed: 0, rejected: 0, error: 0, cancelled: 0 };
  for (const r of rows) if (r.status in out) out[r.status]++;
  return out;
}

const STABLES = new Set(['USDT', 'USDC', 'USD', 'FDUSD', 'DAI', 'BUSD', 'TUSD', 'USDE']);

/**
 * @param deps { db, vault, ccxt, wallets: { balances(addr, rpc), tokenInfo(mints) }, defaultRpc }
 * @param kind 'daily' | 'weekly'
 */
export async function reportData(deps, kind, { venue, symbol, now = Date.now() } = {}) {
  const { db } = deps;
  const span = kind === 'weekly' ? 7 * DAY : DAY;
  const from = now - span;
  const out = { kind, from, to: now };
  if (venue && symbol) {
    out.value = profileLevels(db, venue, symbol, from, now);
    if (kind === 'daily') {
      const dayStart = Math.floor(now / DAY) * DAY;
      out.priorDay = profileLevels(db, venue, symbol, dayStart - DAY, dayStart - 1);
      out.today = db.tradeRange(venue, symbol, dayStart, now);
    } else out.priorWeek = profileLevels(db, venue, symbol, from - 7 * DAY, from - 1);
  }
  out.bots = summarizeBots(db.amtTrades(from, now));
  out.orders = summarizeOrders(db.orderLogBetween(from, now));
  const stats = db.tradeStats();
  out.recorded = { instruments: stats.length, trades: stats.reduce((a, s) => a + Number(s.n), 0), size: db.info().size };

  const keys = deps.vault.list();
  out.accounts = await Promise.all(
    keys
      .filter((k) => k.kind === 'exchange')
      .map(async (k) => {
        try {
          const a = await withTimeout(deps.ccxt.account(k.id), 20_000, k.label);
          const balances = [...a.balances].sort((x, y) => Number(STABLES.has(y.currency)) - Number(STABLES.has(x.currency))).slice(0, 8);
          return { label: k.label, exchange: a.exchange, balances, positions: a.positions, error: a.errors.balances ?? null };
        } catch (e) {
          return { label: k.label, exchange: k.exchange, balances: [], positions: [], error: String(e?.message ?? e) };
        }
      }),
  );

  const rpcKey = keys.find((k) => k.kind === 'solana-rpc');
  const rpc = rpcKey ? deps.vault.reveal(rpcKey.id).fields.url ?? deps.defaultRpc : deps.defaultRpc;
  out.wallets = await Promise.all(
    db.listWallets().map(async (w) => {
      try {
        const b = await withTimeout(deps.wallets.balances(w.address, rpc), 20_000, 'wallet');
        const mints = [deps.solMint, ...b.tokens.map((t) => t.mint)];
        const info = await withTimeout(deps.wallets.tokenInfo(mints), 20_000, 'prices').catch(() => ({ prices: {}, meta: {} }));
        const solUsd = b.sol * (info.prices[deps.solMint] ?? 0);
        const tokens = b.tokens
          .map((t) => ({ symbol: info.meta[t.mint]?.symbol ?? `${t.mint.slice(0, 4)}…`, amount: t.amount, usd: info.prices[t.mint] !== undefined ? info.prices[t.mint] * t.amount : null }))
          .filter((t) => t.usd === null || t.usd >= 1)
          .sort((a, b2) => (b2.usd ?? 0) - (a.usd ?? 0));
        return { address: w.address, sol: b.sol, usd: solUsd + tokens.reduce((a, t) => a + (t.usd ?? 0), 0), tokens: tokens.slice(0, 5) };
      } catch (e) {
        return { address: w.address, error: String(e?.message ?? e) };
      }
    }),
  );
  return out;
}

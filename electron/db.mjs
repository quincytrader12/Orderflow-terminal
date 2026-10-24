// Local SQLite database (Node's built-in node:sqlite, no native modules).
// Holds encrypted secrets, recorded trades for history backfill, connected
// wallets and a small key/value store.
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  exchange TEXT,
  meta TEXT NOT NULL,
  enc BLOB NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  t INTEGER NOT NULL,
  price REAL NOT NULL,
  qty REAL NOT NULL,
  side INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_vst ON trades(venue, symbol, t);
CREATE TABLE IF NOT EXISTS trade_stats (
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  n INTEGER NOT NULL,
  first INTEGER,
  last INTEGER,
  PRIMARY KEY (venue, symbol)
);
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  label TEXT,
  verified INTEGER NOT NULL,
  connected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  t INTEGER NOT NULL,
  action TEXT NOT NULL,
  secret_id TEXT,
  exchange TEXT,
  sandbox INTEGER NOT NULL DEFAULT 0,
  symbol TEXT,
  side TEXT,
  type TEXT,
  amount REAL,
  price REAL,
  trigger_price REAL,
  notional_usd REAL,
  status TEXT NOT NULL,
  order_id TEXT,
  message TEXT
);
CREATE INDEX IF NOT EXISTS orders_log_t ON orders_log(t);
CREATE TABLE IF NOT EXISTS amt_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  bot_name TEXT,
  symbol TEXT,
  mode TEXT,
  setup TEXT,
  side TEXT,
  entry REAL,
  exit REAL,
  qty REAL,
  pnl REAL,
  fees REAL,
  opened INTEGER,
  closed INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS amt_trades_closed ON amt_trades(closed);
`;

/**
 * Trades as typed columns in shared memory, read a page at a time with a
 * yield between pages, so no thread holds millions of row objects or stalls
 * for seconds, and training workers all read the same memory. Takes a raw
 * DatabaseSync so a worker can run it on its own read-only connection.
 */
export async function readColumns(sql, venue, symbol, from, to, limit = 3_000_000, page = 20_000) {
  const stmt = sql.prepare(
    'SELECT rowid AS id, t, price, qty, side FROM trades WHERE venue = ? AND symbol = ? AND (t > ? OR (t = ? AND rowid > ?)) AND t <= ? ORDER BY t, rowid LIMIT ?',
  );
  const chunks = [];
  let n = 0;
  // start just before `from`: (t = from − 1, any rowid) is never matched
  let lastT = from - 1;
  let lastId = Number.MAX_SAFE_INTEGER;
  while (n < limit) {
    const rows = stmt.all(venue, symbol, lastT, lastT, lastId, to, Math.min(page, limit - n));
    if (!rows.length) break;
    const c = { t: new Float64Array(rows.length), p: new Float64Array(rows.length), q: new Float64Array(rows.length), s: new Uint8Array(rows.length) };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      c.t[i] = r.t;
      c.p[i] = r.price;
      c.q[i] = r.qty;
      c.s[i] = r.side;
    }
    chunks.push(c);
    n += rows.length;
    lastT = rows[rows.length - 1].t;
    lastId = rows[rows.length - 1].id;
    if (rows.length < page) break;
    await new Promise((r) => setImmediate(r));
  }
  const shared = (Ctor) => new Ctor(new SharedArrayBuffer(Math.max(1, n) * Ctor.BYTES_PER_ELEMENT), 0, n);
  const cols = { t: shared(Float64Array), p: shared(Float64Array), q: shared(Float64Array), s: shared(Uint8Array) };
  let at = 0;
  for (const c of chunks) {
    for (const k of ['t', 'p', 'q', 's']) cols[k].set(c[k], at);
    at += c.t.length;
  }
  return cols;
}

/** Read trade columns from the database file on a read-only connection of this thread's own. */
export async function readColumnsFromFile(file, venue, symbol, from, to, limit) {
  const sql = new DatabaseSync(file, { readOnly: true });
  try {
    return await readColumns(sql, venue, symbol, from, to, limit, 100_000);
  } finally {
    sql.close();
  }
}

export class Db {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.insertTrade = this.db.prepare('INSERT INTO trades (venue, symbol, t, price, qty, side) VALUES (?, ?, ?, ?, ?, ?)');
    this.bumpStats = this.db.prepare(
      `INSERT INTO trade_stats (venue, symbol, n, first, last) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(venue, symbol) DO UPDATE SET n = n + excluded.n, first = MIN(COALESCE(first, excluded.first), excluded.first), last = MAX(COALESCE(last, excluded.last), excluded.last)`,
    );
    // counts kept per market so the Database panel and the trainer never count
    // millions of rows on the main thread; databases from before are counted once,
    // a slice at a time, in the background (see countBacklog)
    this.backlog = this.get('tradeStatsReady') ? [] : this.seedStats();
  }

  close() {
    this.db.close();
  }

  // ---- key/value ----
  get(k) {
    const r = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return r ? JSON.parse(r.v) : undefined;
  }
  set(k, v) {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  // ---- secrets (ciphertext only; see vault.mjs) ----
  listSecrets() {
    return this.db.prepare('SELECT id, label, kind, exchange, meta, created, updated FROM secrets ORDER BY updated DESC').all();
  }
  getSecret(id) {
    return this.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id);
  }
  putSecret({ id, label, kind, exchange, meta, enc }) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO secrets (id, label, kind, exchange, meta, enc, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, kind = excluded.kind, exchange = excluded.exchange,
           meta = excluded.meta, enc = excluded.enc, updated = excluded.updated`,
      )
      .run(id, label, kind, exchange ?? null, meta, enc, now, now);
  }
  deleteSecret(id) {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
  }

  // ---- recorded trades ----
  recordTrades(venue, symbol, rows) {
    if (!rows.length) return 0;
    this.db.exec('BEGIN');
    try {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of rows) {
        const t = Math.round(r.t);
        if (t < lo) lo = t;
        if (t > hi) hi = t;
        this.insertTrade.run(venue, symbol, t, r.p, r.q, r.s === 'buy' ? 1 : 0);
      }
      this.bumpStats.run(venue, symbol, rows.length, lo, hi);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rows.length;
  }
  /** Trades as typed columns in shared memory (see readColumns). */
  tradeColumns(venue, symbol, from, to, limit = 3_000_000, page = 20_000) {
    return readColumns(this.db, venue, symbol, from, to, limit, page);
  }
  queryTrades(venue, symbol, from, to, limit = 2_000_000) {
    return this.db
      .prepare('SELECT t, price, qty, side FROM trades WHERE venue = ? AND symbol = ? AND t >= ? AND t <= ? ORDER BY t LIMIT ?')
      .all(venue, symbol, from, to, limit)
      .map((r) => ({ time: r.t, price: r.price, qty: r.qty, side: r.side === 1 ? 'buy' : 'sell' }));
  }
  tradeStats() {
    return this.db
      .prepare('SELECT venue, symbol, n, first, last FROM trade_stats WHERE n > 0 ORDER BY n DESC, venue, symbol')
      .all()
      .map((r) => ({ ...r, n: Number(r.n) }));
  }
  /** Every recorded market, found by hopping along the index (no full scan). */
  instruments() {
    const next = this.db.prepare('SELECT venue, symbol FROM trades WHERE (venue, symbol) > (?, ?) ORDER BY venue, symbol LIMIT 1');
    const out = [];
    for (let r = next.get('', ''); r; r = next.get(r.venue, r.symbol)) out.push({ venue: r.venue, symbol: r.symbol });
    return out;
  }
  /**
   * First run on a database recorded before trade_stats existed: one row per
   * market with its first and last time (index lookups, instant) and n = 0,
   * plus a list of hour slices still to count. New trades count from now on.
   */
  seedStats() {
    const work = [];
    const range = this.db.prepare('SELECT MIN(t) AS first, MAX(t) AS last FROM trades WHERE venue = ? AND symbol = ?');
    const put = this.db.prepare('INSERT OR REPLACE INTO trade_stats (venue, symbol, n, first, last) VALUES (?, ?, 0, ?, ?)');
    for (const { venue, symbol } of this.instruments()) {
      const { first, last } = range.get(venue, symbol);
      if (first == null) continue;
      put.run(venue, symbol, first, last);
      for (let a = first; a <= last; a += 3_600_000) work.push({ venue, symbol, a, b: Math.min(last, a + 3_600_000 - 1) });
    }
    if (!work.length) this.set('tradeStatsReady', true);
    return work;
  }
  /** Count a few hour slices of the backlog; true while there is more. Call it from a timer. */
  countBacklog(slices = 4) {
    if (!this.backlog.length) return false;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE venue = ? AND symbol = ? AND t >= ? AND t <= ?');
    const add = this.db.prepare('UPDATE trade_stats SET n = n + ? WHERE venue = ? AND symbol = ?');
    for (let i = 0; i < slices && this.backlog.length; i++) {
      const w = this.backlog.shift();
      add.run(Number(count.get(w.venue, w.symbol, w.a, w.b).n), w.venue, w.symbol);
    }
    if (!this.backlog.length) this.set('tradeStatsReady', true);
    return this.backlog.length > 0;
  }
  /** Delete trades older than a time, market by market along the index; the counts follow. */
  pruneTrades(olderThan) {
    let total = 0;
    const del = this.db.prepare('DELETE FROM trades WHERE venue = ? AND symbol = ? AND t < ?');
    const first = this.db.prepare('SELECT MIN(t) AS t FROM trades WHERE venue = ? AND symbol = ?');
    const upd = this.db.prepare('UPDATE trade_stats SET n = MAX(0, n - ?), first = ? WHERE venue = ? AND symbol = ?');
    const counted = this.db.prepare('SELECT COUNT(*) AS n FROM trades WHERE venue = ? AND symbol = ? AND t < ?');
    for (const { venue, symbol } of this.instruments()) {
      // while a market is still being counted (oldest hours first), only the
      // deleted trades it has already counted come off its total
      const pending = this.backlog.find((w) => w.venue === venue && w.symbol === symbol);
      const kc = pending ? Number(counted.get(venue, symbol, Math.min(olderThan, pending.a)).n) : null;
      const k = Number(del.run(venue, symbol, olderThan).changes);
      if (!k) continue;
      total += k;
      upd.run(kc ?? k, first.get(venue, symbol).t, venue, symbol);
    }
    this.backlog = this.backlog.filter((w) => w.b >= olderThan);
    this.db.prepare('DELETE FROM trade_stats WHERE first IS NULL').run();
    return total;
  }
  deleteInstrument(venue, symbol) {
    this.backlog = this.backlog.filter((w) => w.venue !== venue || w.symbol !== symbol);
    this.db.prepare('DELETE FROM trade_stats WHERE venue = ? AND symbol = ?').run(venue, symbol);
    return Number(this.db.prepare('DELETE FROM trades WHERE venue = ? AND symbol = ?').run(venue, symbol).changes);
  }
  vacuum() {
    this.db.exec('VACUUM');
  }

  // ---- wallets ----
  listWallets() {
    return this.db.prepare('SELECT * FROM wallets ORDER BY connected_at DESC').all();
  }
  putWallet(address, chain, verified, label = null) {
    this.db
      .prepare(
        `INSERT INTO wallets (address, chain, label, verified, connected_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET verified = MAX(verified, excluded.verified), connected_at = excluded.connected_at`,
      )
      .run(address, chain, label, verified ? 1 : 0, Date.now());
  }
  deleteWallet(address) {
    this.db.prepare('DELETE FROM wallets WHERE address = ?').run(address);
  }

  // ---- order audit log (every attempt, accepted or not) ----
  logOrder(r) {
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    this.db
      .prepare(
        `INSERT INTO orders_log (t, action, secret_id, exchange, sandbox, symbol, side, type, amount, price, trigger_price, notional_usd, status, order_id, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(Date.now(), r.action, r.secretId ?? null, r.exchange ?? null, r.sandbox ? 1 : 0, r.symbol ?? null, r.side ?? null, r.type ?? null, n(r.amount), n(r.price), n(r.triggerPrice), n(r.notionalUsd), r.status, r.orderId ?? null, r.message ?? null);
  }
  orderLog(limit = 100) {
    return this.db.prepare('SELECT * FROM orders_log ORDER BY id DESC LIMIT ?').all(limit);
  }

  // ---- AMT bot trades (kept for reports after a bot stops) ----
  recordAmtTrade(r) {
    this.db
      .prepare('INSERT INTO amt_trades (bot_id, bot_name, symbol, mode, setup, side, entry, exit, qty, pnl, fees, opened, closed, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.botId, r.botName ?? null, r.symbol ?? null, r.mode ?? null, r.setup ?? null, r.side ?? null, r.entry, r.exit, r.qty, r.pnl, r.fees ?? 0, r.opened ?? null, r.closed, r.reason ?? null);
  }
  amtTrades(from, to) {
    return this.db.prepare('SELECT * FROM amt_trades WHERE closed >= ? AND closed <= ? ORDER BY closed').all(from, to);
  }
  orderLogBetween(from, to) {
    return this.db.prepare('SELECT * FROM orders_log WHERE t >= ? AND t <= ? ORDER BY id').all(from, to);
  }

  /** Open/high/low/close and count of recorded trades in a window. */
  tradeRange(venue, symbol, from, to) {
    const r = this.db.prepare('SELECT COUNT(*) AS n, MIN(price) AS low, MAX(price) AS high, MIN(t) AS first, MAX(t) AS last FROM trades WHERE venue = ? AND symbol = ? AND t >= ? AND t <= ?').get(venue, symbol, from, to);
    if (!r || !r.n) return null;
    const px = (t) => this.db.prepare('SELECT price FROM trades WHERE venue = ? AND symbol = ? AND t = ? LIMIT 1').get(venue, symbol, t).price;
    return { n: Number(r.n), low: r.low, high: r.high, first: r.first, last: r.last, open: px(r.first), close: px(r.last) };
  }

  /** Volume per price bin, aggregated in SQL so long windows stay cheap. */
  volumeProfile(venue, symbol, from, to, bin) {
    return this.db
      .prepare('SELECT CAST(ROUND(price / ?) AS INTEGER) AS k, SUM(qty) AS v FROM trades WHERE venue = ? AND symbol = ? AND t >= ? AND t <= ? GROUP BY k')
      .all(bin, venue, symbol, from, to)
      .map((r) => [Number(r.k), r.v]);
  }

  info() {
    let size = 0;
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        size += statSync(f).size;
      } catch {
        /* missing wal */
      }
    }
    const count = (t) => Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
    // trades from the kept counts: COUNT(*) over millions of rows would stall the app
    const trades = Number(this.db.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM trade_stats').get().n);
    return { file: this.file, size, trades, secrets: count('secrets'), wallets: count('wallets') };
  }
}

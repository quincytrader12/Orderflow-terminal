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
`;

export class Db {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this.insertTrade = this.db.prepare('INSERT INTO trades (venue, symbol, t, price, qty, side) VALUES (?, ?, ?, ?, ?, ?)');
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
      for (const r of rows) this.insertTrade.run(venue, symbol, Math.round(r.t), r.p, r.q, r.s === 'buy' ? 1 : 0);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rows.length;
  }
  queryTrades(venue, symbol, from, to, limit = 2_000_000) {
    return this.db
      .prepare('SELECT t, price, qty, side FROM trades WHERE venue = ? AND symbol = ? AND t >= ? AND t <= ? ORDER BY t LIMIT ?')
      .all(venue, symbol, from, to, limit)
      .map((r) => ({ time: r.t, price: r.price, qty: r.qty, side: r.side === 1 ? 'buy' : 'sell' }));
  }
  tradeStats() {
    return this.db
      .prepare('SELECT venue, symbol, COUNT(*) AS n, MIN(t) AS first, MAX(t) AS last FROM trades GROUP BY venue, symbol ORDER BY n DESC')
      .all();
  }
  pruneTrades(olderThan) {
    return Number(this.db.prepare('DELETE FROM trades WHERE t < ?').run(olderThan).changes);
  }
  deleteInstrument(venue, symbol) {
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
    return { file: this.file, size, trades: count('trades'), secrets: count('secrets'), wallets: count('wallets') };
  }
}

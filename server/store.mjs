// Columnar in-memory store for trades and liquidations with time-based
// retention and optional binary persistence. Zero dependencies.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TRADE_COLS = 5; // id, time, price, qty, isBuyerMaker(0/1)
const LIQ_COLS = 4; // time, price, qty, side(1 = long, 0 = short)

class Column {
  constructor(cols, cap = 65536) {
    this.cols = cols;
    this.data = new Float64Array(cap * cols);
    this.len = 0;
  }
  push(...vals) {
    if ((this.len + 1) * this.cols > this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const o = this.len * this.cols;
    for (let i = 0; i < this.cols; i++) this.data[o + i] = vals[i];
    this.len++;
  }
  /** value of column c in row r */
  at(r, c) {
    return this.data[r * this.cols + c];
  }
  /** first row with column-0-or-1 time >= t; rows are time ordered */
  lowerBound(t, timeCol) {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.at(mid, timeCol) < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  dropBefore(t, timeCol) {
    const n = this.lowerBound(t, timeCol);
    if (n === 0) return 0;
    this.data.copyWithin(0, n * this.cols, this.len * this.cols);
    this.len -= n;
    return n;
  }
}

export class MarketStore {
  constructor(exchange, symbol) {
    this.exchange = exchange;
    this.symbol = symbol;
    this.trades = new Column(TRADE_COLS);
    this.liqs = new Column(LIQ_COLS, 1024);
    this.lastTradeId = -Infinity;
  }

  /** Append a trade; out-of-order or duplicate ids are ignored. */
  addTrade(id, time, price, qty, isBuyerMaker) {
    if (!(price > 0) || !(qty > 0) || !isFinite(time)) return false;
    if (id <= this.lastTradeId) return false;
    const n = this.trades.len;
    if (n && time < this.trades.at(n - 1, 1)) time = this.trades.at(n - 1, 1);
    this.trades.push(id, time, price, qty, isBuyerMaker ? 1 : 0);
    this.lastTradeId = id;
    return true;
  }

  /** Insert older trades in front (REST gap fill before live data). */
  prependTrades(rows) {
    const firstId = this.trades.len ? this.trades.at(0, 0) : Infinity;
    const older = rows.filter((r) => r.id < firstId && r.price > 0 && r.qty > 0).sort((a, b) => a.id - b.id);
    if (!older.length) return 0;
    const next = new Column(TRADE_COLS, older.length + this.trades.len + 1024);
    for (const r of older) next.push(r.id, r.time, r.price, r.qty, r.isBuyerMaker ? 1 : 0);
    for (let i = 0; i < this.trades.len; i++) next.push(...this.trades.data.subarray(i * TRADE_COLS, (i + 1) * TRADE_COLS));
    this.trades = next;
    if (!isFinite(this.lastTradeId)) this.lastTradeId = older[older.length - 1].id;
    return older.length;
  }

  addLiquidation(time, price, qty, side) {
    if (!(price > 0) || !(qty > 0)) return false;
    this.liqs.push(time, price, qty, side === 'long' ? 1 : 0);
    return true;
  }

  prune(olderThanMs) {
    return this.trades.dropBefore(olderThanMs, 1) + this.liqs.dropBefore(olderThanMs, 0);
  }

  span() {
    const t = this.trades;
    return t.len ? { start: t.at(0, 1), end: t.at(t.len - 1, 1) } : null;
  }

  /** Trades in [start, end]; when more than `limit`, the most recent `limit` are returned. */
  queryTrades(start, end, limit) {
    const a = this.trades.lowerBound(start, 1);
    let b = this.trades.lowerBound(end + 1, 1);
    let from = a;
    const truncated = b - a > limit;
    if (truncated) from = b - limit;
    const out = [];
    for (let i = from; i < b; i++) {
      out.push({
        trade_id: this.trades.at(i, 0),
        price: this.trades.at(i, 2),
        quantity: this.trades.at(i, 3),
        timestamp_ms: this.trades.at(i, 1),
        is_buyer_maker: this.trades.at(i, 4) === 1,
      });
    }
    return { trades: out, truncated, actual_start_ms: out.length ? out[0].timestamp_ms : start, actual_end_ms: out.length ? out[out.length - 1].timestamp_ms : end };
  }

  queryLiquidations(start, end, limit) {
    const a = this.liqs.lowerBound(start, 0);
    const b = this.liqs.lowerBound(end + 1, 0);
    const from = b - a > limit ? b - limit : a;
    const out = [];
    for (let i = from; i < b; i++) {
      const price = this.liqs.at(i, 1);
      const quantity = this.liqs.at(i, 2);
      out.push({ side: this.liqs.at(i, 3) === 1 ? 'long' : 'short', price, quantity, timestamp_ms: this.liqs.at(i, 0), notional_usd: price * quantity });
    }
    return { liquidations: out, truncated: b - a > limit, actual_start_ms: out.length ? out[0].timestamp_ms : start, actual_end_ms: out.length ? out[out.length - 1].timestamp_ms : end };
  }

  // ---- persistence: raw Float64 columns ----
  save(dir) {
    mkdirSync(dir, { recursive: true });
    const base = join(dir, `${this.exchange}-${this.symbol}`);
    for (const [name, col] of [
      ['trades', this.trades],
      ['liqs', this.liqs],
    ]) {
      const tmp = `${base}.${name}.bin.tmp`;
      writeFileSync(tmp, Buffer.from(col.data.buffer, 0, col.len * col.cols * 8));
      renameSync(tmp, `${base}.${name}.bin`);
    }
  }

  load(dir) {
    const base = join(dir, `${this.exchange}-${this.symbol}`);
    let n = 0;
    for (const [name, cols] of [
      ['trades', TRADE_COLS],
      ['liqs', LIQ_COLS],
    ]) {
      const f = `${base}.${name}.bin`;
      if (!existsSync(f)) continue;
      const buf = readFileSync(f);
      const arr = new Float64Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 8));
      const col = new Column(cols, Math.max(1024, arr.length / cols + 1024));
      col.data.set(arr);
      col.len = Math.floor(arr.length / cols);
      if (name === 'trades') {
        this.trades = col;
        if (col.len) this.lastTradeId = col.at(col.len - 1, 0);
        n = col.len;
      } else this.liqs = col;
    }
    return n;
  }
}

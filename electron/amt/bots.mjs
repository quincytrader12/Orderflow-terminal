// AMT scalper bots in the desktop process. Each bot streams one market from
// its exchange (ccxt.pro), feeds the AMT engine and executes its intents:
// paper bots fill instantly at the last price plus slippage; live bots send
// market orders through CcxtService.placeOrder, so every trading rule
// (Allow-trading switch, value cap, rate limit) still applies.
//
// Bots never start on their own: after a restart every bot is off.
import { randomUUID } from 'node:crypto';
import { AmtEngine, DEFAULT_AMT, finishBacktest, mergeConfig, paperFill, replay } from './engine.mjs';

const KEY = 'amtBots';
const MAX_EVENTS = 200;
const tidy = (n) => Number(Number(n).toPrecision(8));

export class BotManager {
  /**
   * @param ccxt  CcxtService (subscribe/unsubscribe/placeOrder/cancelOrder/marketInfo)
   * @param db    Db (bot configs in kv, recorded trades for backtests)
   * @param emit  (channel: 'status'|'event', payload) → sends to the UI
   */
  constructor({ ccxt, db, emit, now = Date.now }) {
    this.ccxt = ccxt;
    this.db = db;
    this.emit = emit;
    this.now = now;
    this.running = new Map();
    this.events = new Map();
  }

  configs() {
    return this.db.get(KEY) ?? [];
  }

  list() {
    return this.configs().map((c) => {
      const b = this.running.get(c.id);
      return { ...c, running: Boolean(b), feed: b?.feed ?? null };
    });
  }

  defaults() {
    return DEFAULT_AMT;
  }

  save(input) {
    const id = input.id ?? randomUUID();
    if (this.running.has(id)) throw new Error('stop the bot before changing its settings');
    const mode = input.mode === 'live' ? 'live' : 'paper';
    const symbol = String(input.symbol ?? '').trim();
    const exchangeId = String(input.exchangeId ?? '').trim().toLowerCase();
    if (!symbol) throw new Error('choose a symbol');
    if (mode === 'paper' && !exchangeId) throw new Error('choose an exchange');
    if (mode === 'live' && !input.secretId) throw new Error('live bots need an exchange key');
    const cfg = {
      id,
      name: String(input.name ?? '').trim() || `AMT ${symbol}`,
      mode,
      exchangeId,
      symbol,
      secretId: input.secretId ?? null,
      exchangeStop: input.exchangeStop !== false,
      params: mergeConfig(input.params),
      updated: this.now(),
    };
    const all = this.configs().filter((c) => c.id !== id);
    this.db.set(KEY, [...all, cfg]);
    return id;
  }

  async remove(id) {
    if (this.running.has(id)) await this.stop(id, { reason: 'deleted' });
    this.db.set(
      KEY,
      this.configs().filter((c) => c.id !== id),
    );
    this.events.delete(id);
  }

  event(id, kind, text, data) {
    const e = { id, t: this.now(), kind, text, data };
    const list = this.events.get(id) ?? [];
    list.push(e);
    if (list.length > MAX_EVENTS) list.shift();
    this.events.set(id, list);
    this.emit('event', e);
    return e;
  }

  eventsFor(id) {
    return this.events.get(id) ?? [];
  }

  snapshot(id) {
    const b = this.running.get(id);
    if (!b) return null;
    return { id, running: true, mode: b.cfg.mode, symbol: b.cfg.symbol, exchange: b.exchangeId, sandbox: b.sandbox, feed: b.feed, feedError: b.feedError, startedAt: b.startedAt, ...b.engine.snapshot() };
  }

  async start(id) {
    if (this.running.has(id)) return true;
    const cfg = this.configs().find((c) => c.id === id);
    if (!cfg) throw new Error('bot not found');
    const params = { ...cfg.params };
    let exchangeId = cfg.exchangeId;
    let sandbox = false;
    let live = null;
    if (cfg.mode === 'live') {
      const info = await this.ccxt.marketInfo(cfg.secretId, cfg.symbol);
      if (!info.trading) throw new Error('Trading is off for this key — tick “Allow trading” in 🔑 Keys first');
      exchangeId = info.exchangeId;
      sandbox = info.sandbox;
      live = { secretId: cfg.secretId, contract: info.contract };
      // the bot plays inside the terminal-wide limits, never against them
      params.maxPositionUsd = Math.min(params.maxPositionUsd, info.limits.maxOrderUsd);
      if (!info.contract) params.allowShort = false;
      if (info.taker) params.feeBps = Math.max(params.feeBps, info.taker * 1e4);
    }
    const b = {
      cfg,
      exchangeId,
      sandbox,
      live,
      engine: new AmtEngine(params),
      sid: `amt-${id}`,
      feed: 'connecting',
      feedError: null,
      startedAt: this.now(),
      stopOrderId: null,
      lastSkip: null,
      stopping: false,
    };
    this.running.set(id, b);
    this.ccxt.subscribe(b.sid, exchangeId, cfg.symbol, (m) => this.onMessage(id, m), { sandbox });
    b.timer = setInterval(() => {
      this.handle(id, b.engine.tick(this.now()));
      this.emit('status', this.snapshot(id));
    }, 1000);
    const where = `${cfg.symbol} on ${exchangeId}${sandbox ? ' (testnet)' : ''}`;
    this.event(id, 'started', cfg.mode === 'live' ? `LIVE trading started: ${where}` : `Paper trading started: ${where}`);
    return true;
  }

  onMessage(id, m) {
    const b = this.running.get(id);
    if (!b) return;
    if (m.kind === 'status') {
      b.feed = m.state;
      b.feedError = m.error ?? null;
      if (m.state === 'error') this.event(id, 'warn', `market data: ${m.error}`);
    } else if (m.kind === 'book') b.engine.onBook(m.bids, m.asks);
    else if (m.kind === 'trades') for (const t of m.trades) this.handle(id, b.engine.onTrade(t));
  }

  handle(id, intents) {
    const b = this.running.get(id);
    if (!b) return;
    const e = b.engine;
    if (e.lastSkip && e.lastSkip !== b.lastSkip) {
      b.lastSkip = e.lastSkip;
      this.event(id, 'skip', `${e.lastSkip.event}: ${e.lastSkip.reason}`);
    }
    for (const intent of intents) {
      if (b.cfg.mode === 'paper') {
        const fill = paperFill(e, intent);
        this.report(id, intent, fill.price);
      } else void this.executeLive(id, intent);
    }
    if (e.halted && !e.pos && !e.pending && !b.stopping) void this.stop(id, { reason: e.halted });
  }

  report(id, intent, price) {
    const e = this.running.get(id)?.engine;
    if (intent.type === 'enter') {
      this.event(id, 'entry', `${intent.side === 'buy' ? 'LONG' : 'SHORT'} ${tidy(intent.qty)} @ ${tidy(price)} · ${intent.setup} · stop ${tidy(intent.stop)} · target ${tidy(intent.target)} — ${intent.reason}`, { ...intent, price });
    } else {
      const last = e?.trades[e.trades.length - 1];
      const pnl = last ? last.pnl : 0;
      this.event(id, 'exit', `EXIT ${intent.reason} @ ${tidy(price)} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`, { ...intent, price, pnl });
    }
  }

  async executeLive(id, intent) {
    const b = this.running.get(id);
    if (!b) return;
    const e = b.engine;
    const { secretId, contract } = b.live;
    const symbol = b.cfg.symbol;
    const feeOf = (price, qty) => (price * qty * e.cfg.feeBps) / 1e4;
    try {
      if (intent.type === 'enter') {
        const r = await this.ccxt.placeOrder(secretId, { symbol, side: intent.side, type: 'market', sizeMode: 'base', size: intent.qty });
        const qty = r.baseQty ?? intent.qty;
        const price = r.price ?? e.last;
        e.filled({ price, qty, fee: feeOf(price, qty) });
        this.report(id, { ...intent, qty }, price);
        if (contract && b.cfg.exchangeStop) {
          // disaster stop on the exchange in case the app or connection dies
          try {
            const s = await this.ccxt.placeOrder(secretId, { symbol, side: intent.side === 'buy' ? 'sell' : 'buy', type: 'stop-market', sizeMode: 'base', size: qty, triggerPrice: intent.stop, reduceOnly: true });
            b.stopOrderId = s.id;
          } catch (err) {
            this.event(id, 'warn', `protective stop not placed (${err.message}); the bot's own stop still applies`);
          }
        }
      } else {
        if (b.stopOrderId) {
          await this.ccxt.cancelOrder(secretId, b.stopOrderId, symbol).catch(() => undefined);
          b.stopOrderId = null;
        }
        let size = intent.qty;
        if (!contract) {
          // spot fees may be taken from the bought coin: sell what is actually there
          const info = await this.ccxt.marketInfo(secretId, symbol);
          if (info.freeBase !== null) size = Math.min(size, info.freeBase);
        }
        const r = await this.ccxt.placeOrder(secretId, { symbol, side: intent.side, type: 'market', sizeMode: 'base', size, reduceOnly: contract || undefined });
        const price = r.price ?? e.last;
        e.filled({ price, qty: size, fee: feeOf(price, size) });
        this.report(id, intent, price);
      }
      if (e.halted && !e.pos && !b.stopping) await this.stop(id, { reason: e.halted });
    } catch (err) {
      e.failed(err);
      const msg = String(err?.message ?? err);
      const text = intent.type === 'enter' ? `entry order failed: ${msg}` : `EXIT FAILED: ${msg} — check your position on the exchange`;
      this.event(id, 'error', text);
      // any live order problem stops the bot so a person can look
      if (!b.stopping) await this.stop(id, { reason: text, flatten: false });
    }
  }

  /** Stop streaming and trading; optionally close the open position at market. */
  async stop(id, { flatten = false, reason = 'stopped' } = {}) {
    const b = this.running.get(id);
    if (!b) return false;
    b.stopping = true;
    clearInterval(b.timer);
    this.ccxt.unsubscribe(b.sid);
    const e = b.engine;
    if (flatten && e.pos && !e.pending) {
      const intent = { type: 'exit', side: e.pos.side === 'buy' ? 'sell' : 'buy', qty: e.pos.qty, price: e.last, reason: 'flatten' };
      e.pending = { kind: 'exit', reason: 'flatten' };
      if (b.cfg.mode === 'paper') this.report(id, intent, paperFill(e, intent).price);
      else await this.executeLive(id, intent);
    } else if (e.pos && b.cfg.mode === 'live') {
      this.event(id, 'warn', `position left open: ${e.pos.side} ${tidy(e.pos.qty)} ${b.cfg.symbol}${b.stopOrderId ? ' (exchange stop in place)' : ''}`);
    }
    const final = this.snapshot(id);
    this.running.delete(id);
    this.event(id, 'stopped', `Stopped: ${reason}`);
    this.emit('status', { ...final, running: false });
    return true;
  }

  async stopAll(reason = 'kill switch') {
    const ids = [...this.running.keys()];
    for (const id of ids) await this.stop(id, { reason, flatten: false });
    return ids.length;
  }

  /** Replay trades recorded in the database through a fresh engine. */
  async backtest(params, venue, symbol, from = 0, to = this.now()) {
    const rows = this.db.queryTrades(venue, symbol, from, to);
    if (rows.length < 1000) throw new Error(`only ${rows.length} recorded trades for ${venue} ${symbol} — let the terminal record for a while first`);
    const trades = rows.map((r) => ({ t: r.time, p: r.price, q: r.qty, s: r.side }));
    const e = new AmtEngine(params);
    // yield between chunks so the app stays responsive on long histories
    for (let i = 0; i < trades.length; i += 50_000) {
      replay(e, trades, i, Math.min(trades.length, i + 50_000));
      await new Promise((r) => setImmediate(r));
    }
    return finishBacktest(e, trades);
  }
}

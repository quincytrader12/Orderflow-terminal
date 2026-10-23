// AMT scalper bots in the desktop process. Each bot streams one market from
// its exchange (ccxt.pro), feeds the AMT engine and executes its intents:
// paper bots fill instantly at the last price plus slippage; live bots send
// market orders through CcxtService.placeOrder, so every trading rule
// (Allow-trading switch, value cap, rate limit) still applies.
//
// Bots never start on their own: after a restart every bot is off.
import { randomUUID } from 'node:crypto';
import { ADAPTIVE_PRESET, AmtEngine, DEFAULT_AMT, finishBacktest, GROWTH_PRESET, INTRADAY_PRESET, mergeConfig, ORDERFLOW_PRESET, paperFill, replay } from './engine.mjs';
import { train } from './train.mjs';

const KEY = 'amtBots';
const MAX_EVENTS = 200;
const tidy = (n) => Number(Number(n).toPrecision(8));

export class BotManager {
  /**
   * @param ccxt  CcxtService (subscribe/unsubscribe/placeOrder/cancelOrder/marketInfo)
   * @param db    Db (bot configs in kv, recorded trades for backtests)
   * @param emit  (channel: 'status'|'event', payload) → sends to the UI
   */
  constructor({ ccxt, db, emit, now = Date.now, makeWorker }) {
    this.ccxt = ccxt;
    this.db = db;
    this.emit = emit;
    this.now = now;
    /** worker threads for training (falls back to this thread without) */
    this.makeWorker = makeWorker;
    this.training = false;
    this.running = new Map();
    this.events = new Map();
  }

  configs() {
    return this.db.get(KEY) ?? [];
  }

  list() {
    return this.configs().map((c) => {
      const b = this.running.get(c.id);
      // configs saved by older versions get any new parameters filled in
      return { ...c, params: mergeConfig(c.params), running: Boolean(b), feed: b?.feed ?? null };
    });
  }

  defaults() {
    return DEFAULT_AMT;
  }

  presets() {
    return { scalp: mergeConfig({}), intraday: mergeConfig(INTRADAY_PRESET), growth: mergeConfig(GROWTH_PRESET), orderflow: mergeConfig(ORDERFLOW_PRESET), adaptive: mergeConfig(ADAPTIVE_PRESET) };
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
    const params = mergeConfig(cfg.params);
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
      // 2 % headroom: the order is re-valued at the ticker price, which may have ticked up
      params.maxPositionUsd = Math.min(params.maxPositionUsd, info.limits.maxOrderUsd * 0.98);
      if (!info.contract) params.allowShort = false;
      if (info.taker) params.feeBps = Math.max(params.feeBps, info.taker * 1e4);
      if (params.sizing === 'balance') {
        // size from the real account, within the market's minimum order
        const bal = await this.ccxt.accountBalance(cfg.secretId, cfg.symbol);
        if (!(bal > 0)) throw new Error(`no ${info.settle ?? info.quote} balance on this account to trade ${cfg.symbol}`);
        params.accountUsd = bal;
        params.minNotionalUsd = Math.max(info.minCost ?? 0, (info.minAmount ?? 0) * (info.contractSize ?? 1) * (info.last ?? 0));
        // spot cannot borrow: a position is at most what the account holds
        if (!info.contract) params.maxLeverage = Math.min(params.maxLeverage, 0.98);
        live.balance = bal;
        live.notes = info.contract ? await this.ccxt.prepareMargin(cfg.secretId, cfg.symbol, Math.max(1, Math.ceil(params.maxLeverage))) : [];
      }
    }
    const b = {
      cfg,
      exchangeId,
      sandbox,
      live,
      engine: Object.assign(new AmtEngine(params), live?.balance ? { liveBalance: live.balance } : {}),
      sid: `amt-${id}`,
      feed: 'connecting',
      feedError: null,
      startedAt: this.now(),
      stopOrderId: null,
      lastSkip: null,
      stopping: false,
    };
    this.running.set(id, b);
    this.ccxt.subscribe(b.sid, exchangeId, cfg.symbol, (m) => this.onMessage(id, m), { sandbox, liquidations: params.style === 'orderflow' || params.style === 'adaptive' });
    b.timer = setInterval(() => {
      this.handle(id, b.engine.tick(this.now()));
      this.emit('status', this.snapshot(id));
    }, 1000);
    const where = `${cfg.symbol} on ${exchangeId}${sandbox ? ' (testnet)' : ''}`;
    this.event(id, 'started', cfg.mode === 'live' ? `LIVE trading started: ${where}` : `Paper trading started: ${where}`);
    if (params.sizing === 'balance') {
      const bal = b.engine.balance();
      this.event(id, 'info', `Sizing from a ${bal.toFixed(2)} balance: ${params.riskPct}% risk per trade, positions up to ${params.maxLeverage}× ($${(bal * params.maxLeverage).toFixed(2)})${params.minNotionalUsd ? `, exchange minimum $${params.minNotionalUsd.toFixed(2)}` : ''}`);
      for (const n of live?.notes ?? []) this.event(id, 'warn', n);
      if (live) b.balanceTimer = setInterval(() => void this.refreshBalance(b), 5 * 60_000);
    }
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
    else if (m.kind === 'liquidations') b.engine.onLiquidations(m.items);
  }

  handle(id, intents) {
    const b = this.running.get(id);
    if (!b) return;
    const e = b.engine;
    if (e.lastSkip && e.lastSkip !== b.lastSkip) {
      b.lastSkip = e.lastSkip;
      this.event(id, 'skip', `${e.lastSkip.event}: ${e.lastSkip.reason}`);
    }
    // the adaptive bot's reasoning: stop moves, cuts, lessons from its exits
    if (e.brain) for (const th of e.brain.drain()) this.event(id, 'think', th.text);
    for (const intent of intents) {
      if (b.cfg.mode === 'paper') {
        const fill = paperFill(e, intent);
        this.report(b, intent, fill.price);
      } else void this.executeLive(b, intent);
    }
    if (e.halted && !e.pos && !e.pending && !b.stopping) void this.stop(id, { reason: e.halted });
  }

  /** Live balance-sized bots re-read the account after each trade and every few minutes. */
  async refreshBalance(b) {
    if (!b.live || b.engine.cfg.sizing !== 'balance') return;
    try {
      const bal = await this.ccxt.accountBalance(b.live.secretId, b.cfg.symbol);
      if (bal > 0) b.engine.liveBalance = bal;
    } catch {
      /* keep the last known balance */
    }
  }

  report(b, intent, price) {
    const id = b.cfg.id;
    const e = b.engine;
    if (intent.type === 'enter') {
      this.event(id, 'entry', `${intent.side === 'buy' ? 'LONG' : 'SHORT'} ${tidy(intent.qty)} @ ${tidy(price)} · ${intent.setup} · stop ${tidy(intent.stop)} · target ${tidy(intent.target)} — ${intent.reason}`, { ...intent, price });
      return;
    }
    const last = e.trades[e.trades.length - 1];
    const pnl = last ? last.pnl : 0;
    if (last) {
      try {
        this.db.recordAmtTrade({ ...last, botId: id, botName: b.cfg.name, symbol: b.cfg.symbol, mode: b.cfg.mode });
      } catch (err) {
        console.warn('amt trade log', err?.message ?? err);
      }
    }
    this.event(id, 'exit', `EXIT ${intent.reason} @ ${tidy(price)} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD`, { ...intent, price, pnl });
    void this.refreshBalance(b);
  }

  /**
   * Live orders. Positions are tracked in exchange units (contracts, or coins
   * on spot) exactly as filled, so exits and the protective stop close what
   * was opened. The bot object is passed in because a stop can remove it from
   * `running` while an order is still in flight.
   */
  async executeLive(b, intent) {
    const id = b.cfg.id;
    const e = b.engine;
    const { secretId, contract } = b.live;
    const symbol = b.cfg.symbol;
    const opposite = (side) => (side === 'buy' ? 'sell' : 'buy');
    const feeOf = (price, qty) => (price * qty * e.cfg.feeBps) / 1e4;
    try {
      if (intent.type === 'enter') {
        const r = await this.ccxt.placeOrder(secretId, { symbol, side: intent.side, type: 'market', sizeMode: 'base', size: intent.qty });
        b.amount = r.amount;
        const qty = r.baseQty ?? intent.qty;
        const price = r.price ?? e.last;
        e.filled({ price, qty, fee: feeOf(price, qty) });
        this.report(b, { ...intent, qty }, price);
        if (b.stopping) {
          // the bot was switched off while this entry was in flight
          if (b.flattenOnFill) {
            e.pending = { kind: 'exit', reason: 'flatten' };
            await this.executeLive(b, { type: 'exit', side: opposite(intent.side), qty, price: e.last, reason: 'flatten' });
          } else this.event(id, 'warn', `entry filled after the bot was stopped — position left open: ${intent.side} ${tidy(qty)} ${symbol}`);
          return;
        }
        if (contract && b.cfg.exchangeStop) {
          // disaster stop half a risk unit beyond the bot's own stop, so the bot normally exits first
          const dir = intent.side === 'buy' ? 1 : -1;
          b.stopTrigger = intent.stop - dir * 0.5 * Math.abs(price - intent.stop);
          try {
            const s = await this.ccxt.placeOrder(secretId, { symbol, side: opposite(intent.side), type: 'stop-market', sizeMode: 'contracts', size: b.amount, triggerPrice: b.stopTrigger, reduceOnly: true });
            b.stopOrderId = s.id;
          } catch (err) {
            this.event(id, 'warn', `protective stop not placed (${err.message}); the bot's own stop still applies`);
          }
        }
      } else {
        const posQty = e.pos?.qty ?? intent.qty;
        let req;
        if (contract) req = { symbol, side: intent.side, type: 'market', sizeMode: 'contracts', size: b.amount, reduceOnly: true };
        else {
          // spot fees may be taken from the bought coin: sell what is actually held
          const info = await this.ccxt.marketInfo(secretId, symbol);
          const held = info.freeBase ?? b.amount;
          req = { symbol, side: intent.side, type: 'market', sizeMode: 'contracts', size: Math.min(b.amount, held), closeSpot: true };
        }
        let r;
        try {
          r = await this.ccxt.placeOrder(secretId, req);
        } catch (err) {
          // the exchange stop may already have closed the position
          const left = contract ? await this.ccxt.positionContracts(secretId, symbol).catch(() => null) : null;
          if (left !== 0) throw err;
          const price = b.stopTrigger ?? e.last;
          if (e.pending) e.pending.reason = 'exchange stop';
          e.filled({ price, qty: posQty, fee: feeOf(price, posQty) });
          b.amount = 0;
          b.stopOrderId = null;
          this.report(b, { ...intent, reason: 'exchange stop' }, price);
          this.event(id, 'warn', 'position was already closed by the exchange stop; exit price estimated at its trigger');
          return;
        }
        // only once the position is closed, remove the disaster stop
        if (b.stopOrderId) {
          await this.ccxt.cancelOrder(secretId, b.stopOrderId, symbol).catch((err) => this.event(id, 'warn', `could not cancel the exchange stop ${b.stopOrderId}: ${err.message}`));
          b.stopOrderId = null;
        }
        const price = r.price ?? e.last;
        e.filled({ price, qty: posQty, fee: feeOf(price, posQty) });
        b.amount = 0;
        this.report(b, intent, price);
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

  /** Is this vault key driving a running live bot? */
  usesKey(secretId) {
    return [...this.running.values()].some((b) => b.live?.secretId === secretId);
  }

  /** Stop streaming and trading; optionally close the open position at market. */
  async stop(id, { flatten = false, reason = 'stopped' } = {}) {
    const b = this.running.get(id);
    if (!b) return false;
    b.stopping = true;
    clearInterval(b.timer);
    if (b.balanceTimer) clearInterval(b.balanceTimer);
    this.ccxt.unsubscribe(b.sid);
    const e = b.engine;
    if (e.pending?.kind === 'entry' && b.cfg.mode === 'live') {
      // an entry is in flight: deal with it when it fills
      b.flattenOnFill = flatten;
      this.event(id, 'warn', flatten ? 'entry order in flight — it will be closed as soon as it fills' : 'entry order in flight — the position will stay open when it fills');
    } else if (flatten && e.pos && !e.pending) {
      const intent = { type: 'exit', side: e.pos.side === 'buy' ? 'sell' : 'buy', qty: e.pos.qty, price: e.last, reason: 'flatten' };
      e.pending = { kind: 'exit', reason: 'flatten' };
      if (b.cfg.mode === 'paper') this.report(b, intent, paperFill(e, intent).price);
      else await this.executeLive(b, intent);
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

  /**
   * Walk-forward training on the last `days` of recorded trades: ranks
   * variations of `params` on the earlier 70 % and accepts one only if it
   * also grew the balance on the unseen 30 %. Progress goes out as 'train'.
   */
  async train(params, venue, symbol, { days = 3, n = 40 } = {}) {
    if (this.training) throw new Error('a training run is already in progress');
    this.training = true;
    try {
      const to = this.now();
      const rows = this.db.queryTrades(venue, symbol, to - days * 86_400_000, to, 3_000_000);
      const res = await train({
        base: params,
        rows,
        n,
        makeWorker: this.makeWorker,
        onProgress: (f) => this.emit('train', { progress: f }),
      });
      return { ...res, venue, symbol };
    } finally {
      this.training = false;
    }
  }
}

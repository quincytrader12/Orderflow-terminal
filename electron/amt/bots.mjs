// AMT scalper bots in the desktop process. Each bot streams one market from
// its exchange (ccxt.pro), feeds the AMT engine and executes its intents:
// paper bots fill instantly at the last price plus slippage; live bots send
// market orders through CcxtService.placeOrder, so every trading rule
// (Allow-trading switch, value cap, rate limit) still applies.
//
// Bots never start on their own: after a restart every bot is off.
import { randomUUID } from 'node:crypto';
import { ADAPTIVE_PRESET, AmtEngine, DEFAULT_AMT, finishBacktest, GROWTH_PRESET, INTRADAY_PRESET, mergeConfig, ORDERFLOW_PRESET, paperFill, replay, SCALP_PRESET, TREND_PRESET } from './engine.mjs';
import { backtestTrend, DAY, explainSignal, rebalanceOrder, trendSignal } from './trend.mjs';
import { Narrator, stoppedWords } from './story.mjs';
import { train } from './train.mjs';

const KEY = 'amtBots';

/**
 * Settings saved before the trade manager existed get it switched on: every
 * style but intraday (which ignores it). A bot whose owner switched it off
 * keeps it off.
 */
export const botParams = (p) => {
  if (!p) return mergeConfig(p);
  const up = { ...p };
  if (up.manageTrades === undefined) up.manageTrades = true;
  // and the daily-trend filter (only trades that go with the coin's daily trend)
  if (up.trendFilter === undefined) up.trendFilter = true;
  return mergeConfig(up);
};

/** The coin of a recorded or exchange symbol: ETHUSDT, ETH/USDT:USDT, ccxt 'binance::ETH/USDT', ETH-USD → ETH. */
export function coinOf(symbol) {
  const s = String(symbol).split('::').pop();
  const head = s.split(/[/:\-_ ]/)[0].toUpperCase();
  return head.replace(/(USDT|USDC|FDUSD|BUSD|USD|PERP)$/, '') || head;
}
/** A post-only order the exchange refused because it would have taken liquidity. */
const POST_ONLY_REJECT = /post.?only|-5022|GTX|would (immediately )?(match|trigger|take)|as maker|maker only/i;
const MAX_EVENTS = 200;
const tidy = (n) => Number(Number(n).toPrecision(8));
const restingText = (i, qty = i.qty) => `${i.type === 'exit' ? `${i.reason} exit` : i.setup} — limit ${i.side} ${tidy(qty)} @ ${tidy(i.price)} resting (post-only, maker fee)`;

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
      return { ...c, params: botParams(c.params), running: Boolean(b), feed: b?.feed ?? null };
    });
  }

  defaults() {
    return DEFAULT_AMT;
  }

  presets() {
    return { scalp: mergeConfig(SCALP_PRESET), intraday: mergeConfig(INTRADAY_PRESET), growth: mergeConfig(GROWTH_PRESET), orderflow: mergeConfig(ORDERFLOW_PRESET), adaptive: mergeConfig(ADAPTIVE_PRESET), trend: mergeConfig(TREND_PRESET) };
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
      params: botParams(input.params),
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
    if (b.trend) return this.trendSnapshot(b);
    return { id, running: true, mode: b.cfg.mode, symbol: b.cfg.symbol, exchange: b.exchangeId, sandbox: b.sandbox, feed: b.feed, feedError: b.feedError, startedAt: b.startedAt, ...b.engine.snapshot() };
  }

  async start(id) {
    if (this.running.has(id)) return true;
    const cfg = this.configs().find((c) => c.id === id);
    if (!cfg) throw new Error('bot not found');
    const params = botParams(cfg.params);
    if (params.style === 'trend') return this.startTrend(cfg, params);
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
      if (Number.isFinite(info.maker)) params.makerFeeBps = info.maker * 1e4;
      if (params.sizing === 'balance') {
        // size from the real account, within the market's minimum order
        const bal = await this.ccxt.accountBalance(cfg.secretId, cfg.symbol);
        const coin = info.settle ?? info.quote;
        if (!(bal > 0))
          throw new Error(
            `no ${coin} balance on this account to trade ${cfg.symbol}${info.contract && String(exchangeId).startsWith('binance') ? ` — Binance keeps spot and futures in separate wallets: convert your deposit to ${coin}, then move it from Spot to the USDⓈ-M Futures wallet (Wallet → Transfer)` : ''}`,
          );
        params.accountUsd = bal;
        params.minNotionalUsd = Math.max(info.minCost ?? 0, (info.minAmount ?? 0) * (info.contractSize ?? 1) * (info.last ?? 0));
        // a small balance: refuse a market whose smallest order the bot could never place,
        // rather than run and skip every setup
        const cap = Math.min(bal * params.maxLeverage, params.maxPositionUsd);
        if (params.minNotionalUsd > cap)
          throw new Error(
            `the smallest order ${exchangeId} accepts on ${cfg.symbol} is $${params.minNotionalUsd.toFixed(2)}, more than this bot may hold with a $${bal.toFixed(2)} balance (${params.maxLeverage}× = $${cap.toFixed(2)}) — pick a market with a smaller minimum, or add to the balance`,
          );
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
      // live bots: the exchange fills resting limits, not the engine's simulation
      engine: Object.assign(new AmtEngine(params), live?.balance ? { liveBalance: live.balance } : {}, { simulateLimits: cfg.mode !== 'live' }),
      working: null,
      sid: `amt-${id}`,
      feed: 'connecting',
      feedError: null,
      startedAt: this.now(),
      stopOrderId: null,
      lastSkip: null,
      stopping: false,
      // the plain-English story for Telegram: watching, in, safe, out
      narrator: new Narrator({ symbol: cfg.symbol, mode: cfg.mode }),
    };
    this.running.set(id, b);
    this.ccxt.subscribe(b.sid, exchangeId, cfg.symbol, (m) => this.onMessage(id, m), { sandbox, liquidations: params.style === 'orderflow' || params.style === 'adaptive' });
    b.timer = setInterval(() => {
      if (b.working) void this.pollWorking(b);
      this.handle(id, b.engine.tick(this.now()));
      this.emit('status', this.snapshot(id));
    }, 1000);
    const where = `${cfg.symbol} on ${exchangeId}${sandbox ? ' (testnet)' : ''}`;
    this.event(id, 'started', cfg.mode === 'live' ? `LIVE trading started: ${where}` : `Paper trading started: ${where}`);
    if (params.trendFilter) {
      // the daily trend decides which side the bot may trade; refreshed every 6 hours
      void this.loadDaily(b, exchangeId);
      b.dailyTimer = setInterval(() => void this.loadDaily(b, exchangeId), 6 * 3_600_000);
    }
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
      if (b.cfg.mode !== 'paper') {
        // one order action at a time per bot: a cancel must never overtake the placement it cancels
        b.chain = (b.chain ?? Promise.resolve()).then(() => this.executeLive(b, intent)).catch((err) => this.event(id, 'error', String(err?.message ?? err)));
      }
      else if (intent.type === 'filled') this.report(b, { ...intent, type: intent.kind === 'entry' ? 'enter' : 'exit' }, intent.price);
      else if (intent.type === 'cancel') {
        this.event(id, 'info', intent.reason);
        const fill = paperFill(e, intent);
        if (fill && intent.then) this.report(b, intent.then, fill.price);
      } else if (intent.order === 'limit') this.event(id, 'info', restingText(intent));
      else this.report(b, intent, paperFill(e, intent).price);
    }
    for (const l of b.narrator?.step(e, e.now) ?? []) this.story(id, l);
    if (e.halted && !e.pos && !e.pending && !b.stopping) void this.stop(id, { reason: e.halted });
  }

  /** One plain-English line of the bot's story (what goes to Telegram). */
  story(id, line) {
    this.event(id, 'story', line.text, { story: line.kind, outcome: line.outcome });
  }

  /** Daily candles for the daily-trend filter (public data on the bot's own market). */
  async loadDaily(b, exchangeId) {
    const id = b.cfg.id;
    try {
      const rows = await this.ccxt.ohlcv(exchangeId, b.cfg.symbol, '1d', 200);
      b.engine.setDaily(rows);
      const h = b.engine.dailyTrend(this.now());
      const first = !b.dailyLoaded;
      b.dailyLoaded = true;
      if (!h) this.event(id, 'info', `daily trend: only ${rows.length} days of history — trading both sides until there is enough`);
      else if (first || h.dir !== b.dailyDir) {
        const v = h.votes.map((x) => `${x.L}d ${x.ret >= 0 ? '+' : ''}${(x.ret * 100).toFixed(1)}%`).join(', ');
        this.event(id, 'info', `Daily trend ${h.dir > 0 ? 'UP' : 'DOWN'} (${h.dir > 0 ? h.up : 3 - h.up}/3: ${v}) — taking ${h.dir > 0 ? 'longs' : 'shorts'} only`);
      }
      b.dailyDir = h?.dir ?? 0;
    } catch (err) {
      if (!b.dailyLoaded) this.event(id, 'warn', `daily trend unavailable (${err?.message ?? err}) — trading both sides until it loads`);
    }
  }

  /** Daily candles of the coin around a recorded period (Binance spot has the longest history). */
  async dailyFor(symbol, from) {
    return this.ccxt.history('binance', `${coinOf(symbol)}/USDT`, '1d', from - 200 * 86_400_000);
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
      if (b.narrator) this.story(id, b.narrator.entry(intent, price, { balance: e.balance() }));
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
    // the trade manager's reason for this exit, when it made the call (it thinks just before it exits)
    const th = e.brain?.thoughts.at(-1);
    const why = th && e.now - th.t <= 2000 && /cutting|losing steam|follow-through|banking|trailing/.test(th.text) ? ` — ${th.text}` : '';
    this.event(id, 'exit', `EXIT ${intent.reason} @ ${tidy(price)} · ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD${why}`, { ...intent, price, pnl });
    if (b.narrator && last) this.story(id, b.narrator.exit(last, intent.reason, { balance: e.balance(), notes: why ? th.text : null }));
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
    if (intent.type === 'cancel') return this.cancelWorking(b, intent);
    // spot exits sell what is actually held (fees may come out of the coin): market only
    if (intent.order === 'limit' && (intent.type === 'enter' || contract)) return this.placeLimit(b, intent);
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
        let price = r.price ?? e.last;
        let fee = feeOf(price, posQty);
        const pe = b.partialExit;
        if (pe) {
          // part of it already went at the maker limit
          const rest = Math.max(0, posQty - pe.base);
          price = (pe.base * pe.price + rest * price) / Math.max(posQty, 1e-12);
          fee = (pe.base * pe.price * e.cfg.makerFeeBps) / 1e4 + feeOf(r.price ?? e.last, rest);
          b.partialExit = null;
        }
        e.filled({ price, qty: posQty, fee });
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

  /** Live: rest a post-only limit; the 1 s timer follows it until it fills or the engine cancels it. */
  async placeLimit(b, intent) {
    const id = b.cfg.id;
    const e = b.engine;
    const { secretId, contract } = b.live;
    const symbol = b.cfg.symbol;
    const exit = intent.type === 'exit';
    const req = exit
      ? { symbol, side: intent.side, type: 'limit', price: intent.price, postOnly: true, sizeMode: 'contracts', size: b.amount, reduceOnly: true }
      : { symbol, side: intent.side, type: 'limit', price: intent.price, postOnly: true, sizeMode: 'base', size: intent.qty };
    try {
      const r = await this.ccxt.placeOrder(secretId, req);
      const amount = r.amount ?? req.size;
      b.working = { id: r.id, kind: exit ? 'exit' : 'entry', intent, amount, unit: amount > 0 && r.baseQty ? r.baseQty / amount : 1 };
      if (b.stopping) {
        // switched off while it was being placed: withdraw it at once
        const w = b.working;
        b.working = null;
        await this.ccxt.cancelOrder(secretId, w.id, symbol).catch(() => undefined);
        const o = await this.ccxt.orderStatus(secretId, w.id, symbol).catch(() => null);
        if (!o || o.status === 'open') this.event(id, 'error', `could not confirm the cancel of resting order ${w.id} — check ${symbol} on the exchange`);
        else if (o.filled > 0 && !exit) this.event(id, 'warn', `limit entry partly filled before it was withdrawn — position left open: ${intent.side} ${tidy(o.filled * w.unit)} ${symbol}`);
        return;
      }
      this.event(id, 'info', restingText(intent, r.baseQty));
      if (r.status === 'closed') {
        const w = b.working;
        b.working = null;
        await this.workingFilled(b, w, amount, r.price);
      }
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (POST_ONLY_REJECT.test(msg) || exit) {
        // refused as maker (it would have crossed), or an exit limit failed: the engine decides at market
        this.event(id, 'info', `${exit ? 'exit' : 'entry'} limit not placed (${msg}) — deciding at market`);
        e.limitMissed();
        return;
      }
      e.failed(err);
      this.event(id, 'error', `entry order failed: ${msg}`);
      if (!b.stopping) await this.stop(id, { reason: `entry order failed: ${msg}`, flatten: false });
    }
  }

  /** Follow a resting limit (every second). */
  async pollWorking(b) {
    const w = b.working;
    if (!w || b.polling) return;
    b.polling = true;
    try {
      const o = await this.ccxt.orderStatus(b.live.secretId, w.id, b.cfg.symbol);
      if (b.working !== w) return; // cancelled meanwhile
      if (o.status === 'closed' || o.filled >= w.amount * 0.9999) {
        b.working = null;
        await this.workingFilled(b, w, o.filled || w.amount, o.average);
      } else if (['canceled', 'cancelled', 'expired', 'rejected'].includes(o.status)) {
        b.working = null;
        if (o.filled > 0 && w.kind === 'entry') await this.workingFilled(b, w, o.filled, o.average);
        else {
          if (o.filled > 0) this.notePartialExit(b, w, o);
          this.event(b.cfg.id, 'info', 'the exchange dropped the resting limit — deciding at market');
          b.engine.limitMissed();
        }
      }
    } catch {
      /* try again next second */
    } finally {
      b.polling = false;
    }
  }

  notePartialExit(b, w, o) {
    b.partialExit = { base: o.filled * w.unit, price: o.average ?? w.intent.price };
    b.amount = Math.max(0, b.amount - o.filled);
  }

  /** A resting limit filled (wholly, or partly before it was cancelled): book it at the maker fee. */
  async workingFilled(b, w, filledAmount, average) {
    const id = b.cfg.id;
    const e = b.engine;
    const price = average ?? w.intent.price;
    if (w.kind === 'entry') {
      const qty = filledAmount * w.unit;
      b.amount = filledAmount;
      e.filled({ price, qty, fee: (price * qty * e.cfg.makerFeeBps) / 1e4 });
      this.report(b, { ...w.intent, type: 'enter', qty }, price);
      await this.protect(b, w.intent, price);
      return;
    }
    const posQty = e.pos?.qty ?? w.intent.qty;
    if (b.stopOrderId) {
      await this.ccxt.cancelOrder(b.live.secretId, b.stopOrderId, b.cfg.symbol).catch((err) => this.event(id, 'warn', `could not cancel the exchange stop ${b.stopOrderId}: ${err.message}`));
      b.stopOrderId = null;
    }
    e.filled({ price, qty: posQty, fee: (price * posQty * e.cfg.makerFeeBps) / 1e4 });
    b.amount = 0;
    this.report(b, { ...w.intent, type: 'exit' }, price);
    if (e.halted && !e.pos && !b.stopping) await this.stop(id, { reason: e.halted });
  }

  /** After an entry fills: the exchange-side disaster stop, or flatten if the bot was switched off meanwhile. */
  async protect(b, intent, price) {
    const id = b.cfg.id;
    const e = b.engine;
    const { secretId, contract } = b.live;
    const opposite = intent.side === 'buy' ? 'sell' : 'buy';
    if (b.stopping) {
      if (b.flattenOnFill) {
        e.pending = { kind: 'exit', reason: 'flatten' };
        await this.executeLive(b, { type: 'exit', side: opposite, qty: e.pos?.qty ?? 0, price: e.last, reason: 'flatten' });
      } else this.event(id, 'warn', `entry filled after the bot was stopped — position left open: ${intent.side} ${tidy(e.pos?.qty ?? 0)} ${b.cfg.symbol}`);
      return;
    }
    if (!contract || !b.cfg.exchangeStop) return;
    const dir = intent.side === 'buy' ? 1 : -1;
    b.stopTrigger = intent.stop - dir * 0.5 * Math.abs(price - intent.stop);
    try {
      const s = await this.ccxt.placeOrder(secretId, { symbol: b.cfg.symbol, side: opposite, type: 'stop-market', sizeMode: 'contracts', size: b.amount, triggerPrice: b.stopTrigger, reduceOnly: true });
      b.stopOrderId = s.id;
    } catch (err) {
      this.event(id, 'warn', `protective stop not placed (${err.message}); the bot's own stop still applies`);
    }
  }

  /**
   * The engine gave up on a resting limit: cancel it, then follow its market
   * order if it has one. A fill that raced the cancel is kept, and then no
   * market order is sent — the bot never doubles a position.
   */
  async cancelWorking(b, intent) {
    const id = b.cfg.id;
    const e = b.engine;
    const { secretId } = b.live;
    const symbol = b.cfg.symbol;
    const w = b.working;
    b.working = null;
    this.event(id, 'info', intent.reason);
    let o = null;
    if (w) {
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.ccxt.cancelOrder(secretId, w.id, symbol).catch(() => undefined);
        o = await this.ccxt.orderStatus(secretId, w.id, symbol).catch(() => null);
        if (o && o.status !== 'open') break;
      }
      if (!o || o.status === 'open') {
        if (w.kind === 'exit' && intent.then) return this.executeLive(b, intent.then); // reduce-only: cannot overshoot
        e.cancelled();
        const msg = `could not confirm the cancel of resting order ${w.id} — check ${symbol} on the exchange`;
        this.event(id, 'error', msg);
        if (!b.stopping) await this.stop(id, { reason: msg, flatten: false });
        return;
      }
      if (o.filled > 0) {
        if (w.kind === 'entry' || o.filled >= w.amount * 0.9999) return this.workingFilled(b, w, o.filled, o.average);
        this.notePartialExit(b, w, o);
      }
    }
    if (intent.then) return this.executeLive(b, intent.then);
    e.cancelled();
  }

  // ---------- trend bot (daily time-series momentum, spot) ----------

  async startTrend(cfg, params) {
    const id = cfg.id;
    let exchangeId = cfg.exchangeId;
    let live = null;
    if (cfg.mode === 'live') {
      const info = await this.ccxt.marketInfo(cfg.secretId, cfg.symbol);
      if (!info.trading) throw new Error('Trading is off for this key — tick “Allow trading” in 🔑 Keys first');
      if (info.contract) throw new Error('The trend bot trades spot — no leverage, no liquidation, no funding. Choose a spot market such as BTC/USDT.');
      exchangeId = info.exchangeId;
      live = { secretId: cfg.secretId };
      if (info.taker) params.feeBps = Math.max(params.feeBps, info.taker * 1e4);
    }
    const key = `trendPaper:${id}`;
    // a paper portfolio lives across restarts: a trend trade lasts weeks
    const paper = cfg.mode === 'paper' ? this.db.get(key) ?? { cash: params.accountUsd, units: 0, start: params.accountUsd, since: this.now(), trades: 0, fees: 0 } : null;
    const b = {
      cfg,
      trend: true,
      mode: cfg.mode,
      params,
      exchangeId,
      live,
      paper,
      paperKey: key,
      base: cfg.symbol.split('/')[0],
      feed: 'connecting',
      feedError: null,
      startedAt: this.now(),
      sig: null,
      why: '',
      price: NaN,
      lastDay: null,
      checking: false,
      stopping: false,
    };
    this.running.set(id, b);
    const where = `${cfg.symbol} on ${exchangeId}`;
    this.event(id, 'started', `${cfg.mode === 'live' ? 'LIVE' : 'Paper'} trend bot started: ${where} — checks the daily close once a day, trades only when the target moves more than ${params.rebalanceBand}% of the balance`);
    b.timer = setInterval(() => void this.trendCheck(b), 60_000);
    void this.trendCheck(b);
    return true;
  }

  /** Every minute: the price; once per new daily close: the signal and, if needed, a rebalance. */
  async trendCheck(b) {
    if (b.checking || b.stopping) return;
    b.checking = true;
    const id = b.cfg.id;
    const p = b.params;
    try {
      const tk = await this.ccxt.ticker(b.exchangeId, b.cfg.symbol);
      b.price = tk.last;
      b.feed = 'open';
      b.feedError = null;
      const day = Math.floor(this.now() / DAY);
      if (b.lastDay === day) return;
      const need = Math.max(p.trendL1, p.trendL2, p.trendL3, p.volDays) + 3;
      const rows = await this.ccxt.ohlcv(b.exchangeId, b.cfg.symbol, '1d', Math.min(1000, need + 2));
      // only candles that have closed
      const closed = rows.filter((r) => r.time + DAY <= this.now());
      const sig = trendSignal(
        closed.map((r) => r.close),
        p,
      );
      b.sig = sig;
      b.closeT = closed.at(-1)?.time ?? null;
      b.why = explainSignal(sig, b.base);
      b.lastDay = day;
      if (!sig.ready) {
        this.event(id, 'info', `Daily check: ${b.why}`);
        return;
      }
      const pf = await this.trendPortfolio(b);
      const order = rebalanceOrder(sig, { cash: pf.cash, units: pf.units, price: b.price }, p, pf.minNotional);
      if (!order) {
        const held = pf.cash + pf.units * b.price > 0 ? (pf.units * b.price) / (pf.cash + pf.units * b.price) : 0;
        this.event(id, 'info', `Daily check: ${b.why}. Holding ${(held * 100).toFixed(0)}% — within the ${p.rebalanceBand}% band, no trade.`);
        return;
      }
      await this.trendTrade(b, order, pf);
    } catch (err) {
      b.feed = 'error';
      b.feedError = String(err?.message ?? err);
      this.event(id, 'warn', `trend check: ${b.feedError}`);
    } finally {
      b.checking = false;
      if (this.running.get(id) === b) this.emit('status', this.snapshot(id));
    }
  }

  /** What the bot holds: the paper book, or the spot balances on the exchange. */
  async trendPortfolio(b) {
    if (b.mode === 'paper') return { cash: b.paper.cash, units: b.paper.units, minNotional: 0 };
    const info = await this.ccxt.marketInfo(b.live.secretId, b.cfg.symbol);
    const cash = Number(info.freeQuote ?? 0);
    const units = Number(info.freeBase ?? 0);
    b.liveUnits = units;
    b.liveEquity = cash + units * b.price;
    return { cash, units, minNotional: Math.max(info.minCost ?? 0, (info.minAmount ?? 0) * b.price) };
  }

  async trendTrade(b, order, pf) {
    const id = b.cfg.id;
    const p = b.params;
    const buy = order.delta > 0;
    const units = Math.abs(order.delta);
    const notional = units * b.price;
    const head = `${buy ? 'BUY' : 'SELL'} ${tidy(units)} ${b.base} ≈ $${notional.toFixed(2)} @ ${tidy(b.price)} → ${(order.target * 100).toFixed(0)}% of the balance in ${b.base} (was ${(order.held * 100).toFixed(0)}%)`;
    if (b.mode === 'paper') {
      const fee = (notional * p.feeBps) / 1e4;
      b.paper.cash -= order.delta * b.price + fee;
      b.paper.units += order.delta;
      if (Math.abs(b.paper.units) * b.price < 1e-9) b.paper.units = 0;
      b.paper.trades++;
      b.paper.fees += fee;
      this.db.set(b.paperKey, b.paper);
      this.event(id, 'trade', `${head} — ${b.why}`);
      return;
    }
    const req = buy
      ? { symbol: b.cfg.symbol, side: 'buy', type: 'market', sizeMode: 'quote', size: notional }
      : // sells only what is held (fees may have come out of the coin)
        { symbol: b.cfg.symbol, side: 'sell', type: 'market', sizeMode: 'contracts', size: Math.min(units, pf.units), closeSpot: true };
    try {
      const r = await this.ccxt.placeOrder(b.live.secretId, req);
      this.event(id, 'trade', `${head}${r.price ? ` (filled ${tidy(r.price)})` : ''} — ${b.why}`);
      await this.trendPortfolio(b).catch(() => undefined);
    } catch (err) {
      const msg = String(err?.message ?? err);
      this.event(id, 'error', `${buy ? 'buy' : 'sell'} not placed: ${msg}${/cap/.test(msg) ? ' — raise the order cap in the ticket ⚙ limits, or it will retry tomorrow' : ''}`);
      // try again at the next daily check
      b.lastDay = null;
    }
  }

  trendSnapshot(b) {
    const pf = b.mode === 'paper' ? b.paper : { cash: NaN, units: b.liveUnits ?? NaN };
    const equity = b.mode === 'paper' ? b.paper.cash + b.paper.units * (Number.isFinite(b.price) ? b.price : 0) : b.liveEquity ?? NaN;
    const start = b.mode === 'paper' ? b.paper.start : b.params.accountUsd;
    const held = equity > 0 && Number.isFinite(b.price) ? (pf.units * b.price) / equity : 0;
    const sig = b.sig;
    return {
      id: b.cfg.id,
      running: true,
      mode: b.mode,
      symbol: b.cfg.symbol,
      exchange: b.exchangeId,
      sandbox: false,
      feed: b.feed,
      feedError: b.feedError,
      startedAt: b.startedAt,
      style: 'trend',
      session: null,
      state: 'trend',
      t: this.now(),
      last: b.price,
      bin: 0,
      va: null,
      prior: null,
      probe: null,
      flow: null,
      book: null,
      position: null,
      pending: null,
      working: null,
      stats: { trades: b.paper?.trades ?? 0, wins: 0, losses: 0, pnl: b.mode === 'paper' && Number.isFinite(equity) ? equity - start : 0, fees: b.paper?.fees ?? 0, grossWin: 0, grossLoss: 0, maxDrawdown: 0, pnlToday: 0, winRate: null, profitFactor: null },
      halted: null,
      balance: Number.isFinite(equity) ? equity : null,
      warmupSec: 0,
      lastSignal: null,
      lastSkip: null,
      trades: [],
      profile: [],
      orderflow: null,
      brain: null,
      trend: {
        ready: Boolean(sig?.ready),
        explain: b.why,
        votes: sig?.ready ? sig.votes : [],
        vol: sig?.ready ? sig.vol : null,
        scale: sig?.ready ? sig.scale : null,
        target: sig?.ready ? sig.exposure : null,
        held,
        equity: Number.isFinite(equity) ? equity : null,
        start,
        cash: Number.isFinite(pf.cash) ? pf.cash : null,
        units: Number.isFinite(pf.units) ? pf.units : null,
        base: b.base,
        closeT: b.closeT ?? null,
        nextCheck: (Math.floor(this.now() / DAY) + 1) * DAY,
      },
    };
  }

  /** Backtest the trend strategy on the exchange's daily history (public data). */
  async trendBacktest(params, exchangeId, symbol, fromYear = 2018) {
    const p = mergeConfig(params);
    const need = Math.max(p.trendL1, p.trendL2, p.trendL3, p.volDays) + 2;
    const since = Date.UTC(fromYear, 0, 1) - need * DAY;
    const candles = await this.ccxt.history(exchangeId, symbol, '1d', since);
    if (candles.length < need + 60) throw new Error(`only ${candles.length} daily candles of ${symbol} on ${exchangeId} — pick an earlier market or year`);
    const r = backtestTrend(candles, p, { startUsd: p.accountUsd, feeBps: p.feeBps });
    // a lighter curve for the screen: one point every 3 days
    const thin = (c) => c.filter((_, i) => i % 3 === 0 || i === c.length - 1);
    return { ...r, equity: thin(r.equity), holdCurve: thin(r.holdCurve), exchangeId, symbol };
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
    if (b.dailyTimer) clearInterval(b.dailyTimer);
    if (b.trend) {
      // a trend bot holds coins for weeks: stopping it leaves them where they are
      const final = this.snapshot(id);
      this.running.delete(id);
      const held = b.mode === 'paper' ? b.paper.units : b.liveUnits ?? 0;
      this.event(id, 'stopped', `Stopped: ${reason}${held > 0 ? ` — ${tidy(held)} ${b.base} stays in the ${b.cfg.mode === 'paper' ? 'paper' : 'exchange'} account` : ''}`);
      this.emit('status', { ...final, running: false });
      return true;
    }
    this.ccxt.unsubscribe(b.sid);
    const e = b.engine;
    // a resting limit is withdrawn first
    if (b.working) {
      const w = b.working;
      b.working = null;
      await this.ccxt.cancelOrder(b.live.secretId, w.id, b.cfg.symbol).catch(() => undefined);
      const o = await this.ccxt.orderStatus(b.live.secretId, w.id, b.cfg.symbol).catch(() => null);
      if (o?.filled > 0 && w.kind === 'entry') {
        b.amount = o.filled;
        e.pending = { kind: 'entry', side: w.intent.side, stop: w.intent.stop, target: w.intent.target, setup: w.intent.setup, why: w.intent.reason };
        e.filled({ price: o.average ?? w.intent.price, qty: o.filled * w.unit });
      } else if (o?.filled > 0) this.notePartialExit(b, w, o);
      this.event(id, 'info', `resting ${w.kind} limit cancelled`);
    }
    if (e.pending?.order === 'limit' || e.pending?.order === 'cancelling') e.pending = null;
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
    if (b.narrator) {
      const st = b.engine.stats;
      const tally = st?.trades ? `${st.trades} trade${st.trades === 1 ? '' : 's'}, ${st.pnl >= 0 ? '+' : '−'}$${Math.abs(st.pnl).toFixed(2)} this run · balance $${b.engine.balance().toFixed(2)}` : '';
      this.story(id, { kind: 'stopped', text: `⏸ The ${b.narrator.coin} bot has stopped — ${stoppedWords(reason)}.\nDetail: ${reason}${tally ? `\n${tally}` : ''}` });
    }
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
    // the same daily-trend filter as live (without the history, both sides trade)
    let daily = null;
    if (e.cfg.trendFilter) daily = await this.dailyFor(symbol, trades[0].t).catch(() => null);
    if (daily?.length) e.setDaily(daily);
    // yield between chunks so the app stays responsive on long histories
    for (let i = 0; i < trades.length; i += 50_000) {
      replay(e, trades, i, Math.min(trades.length, i + 50_000));
      await new Promise((r) => setImmediate(r));
    }
    return { ...finishBacktest(e, trades), dailyTrend: !e.cfg.trendFilter ? 'off' : daily?.length ? 'on' : 'unavailable' };
  }

  /** Recorded trades as shared columns, read in a worker when there is one. */
  async loadColumns(venue, symbol, from, to, limit) {
    if (this.makeWorker && this.db.file) {
      let w;
      try {
        w = this.makeWorker();
        const m = await new Promise((resolve, reject) => {
          w.once('message', resolve);
          w.once('error', reject);
          w.postMessage({ type: 'load', file: this.db.file, venue, symbol, from, to, limit });
        });
        if (m.cols) return m.cols;
      } catch {
        /* no worker: read on this thread, page by page */
      } finally {
        void w?.terminate();
      }
    }
    return this.db.tradeColumns ? this.db.tradeColumns(venue, symbol, from, to, limit) : undefined;
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
      // typed columns in shared memory, read page by page: no millions of row
      // objects on the main thread, and the workers share one copy
      const cols = await this.loadColumns(venue, symbol, to - days * 86_400_000, to, 3_000_000);
      const rows = cols ? undefined : this.db.queryTrades(venue, symbol, to - days * 86_400_000, to, 3_000_000);
      const firstT = cols ? cols.t[0] : rows[0]?.time;
      const daily = mergeConfig(params).trendFilter && firstT !== undefined ? await this.dailyFor(symbol, firstT).catch(() => null) : null;
      // progress a few times a second at most, however many workers report
      let sent = 0;
      const res = await train({
        base: params,
        rows,
        cols,
        daily,
        n,
        makeWorker: this.makeWorker,
        onProgress: (f) => {
          const now = Date.now();
          if (f < 1 && now - sent < 250) return;
          sent = now;
          this.emit('train', { progress: f });
        },
      });
      return { ...res, venue, symbol };
    } finally {
      this.training = false;
    }
  }
}

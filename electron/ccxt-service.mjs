// CCXT bridge: public market data streams for any CCXT exchange (ccxt.pro
// WebSockets with REST polling fallback) and private account endpoints that
// use API keys from the vault. Runs in the Electron main process so there are
// no CORS limits and keys never reach the renderer.
import { buildOrder, closeOrderFor, RateGate, sanitizeLimits, USD_QUOTES } from './trading.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOOK_DEPTH = 500;

// CCXT is large (100+ exchanges, ~1,000 files): load it after the window is up
let ccxt = null;
export async function loadCcxt() {
  ccxt ??= (await import('ccxt')).default;
  return ccxt;
}

/**
 * Name, websocket support and required credentials for every exchange.
 * Building it constructs each exchange once, so it yields between them to
 * keep the app responsive, and is cached per CCXT version.
 */
export async function listExchanges(cache) {
  const lib = await loadCcxt();
  const hit = cache?.get();
  if (hit?.version === lib.version && Array.isArray(hit.list)) return hit.list;
  const out = [];
  for (const id of lib.exchanges) {
    let name = id;
    let pro = false;
    let requiredCredentials = {};
    try {
      const ex = new lib[id]();
      name = ex.name ?? id;
      requiredCredentials = ex.requiredCredentials ?? {};
      pro = Boolean(lib.pro[id]);
    } catch {
      /* exchange failed to construct */
    }
    const creds = Object.entries(requiredCredentials)
      .filter(([, v]) => v)
      .map(([k]) => k);
    out.push({ id, name, pro, credentials: creds });
    if (out.length % 8 === 0) await new Promise((r) => setImmediate(r));
  }
  cache?.set({ version: lib.version, list: out });
  return out;
}

/** CCXT credential field names come straight from the vault record. */
function credentialsFrom(fields) {
  const out = {};
  for (const k of ['apiKey', 'secret', 'password', 'uid', 'login', 'twofa', 'privateKey', 'walletAddress', 'token']) if (fields[k]) out[k] = fields[k];
  return out;
}

export class CcxtService {
  /**
   * @param vault Vault (reveal() gives plaintext key fields)
   * @param opts.db Db for trading limits and the order audit log
   * @param opts.lib CCXT module (tests pass a fake)
   */
  constructor(vault, opts = {}) {
    this.vault = vault;
    this.db = opts.db ?? null;
    // call loadCcxt() before constructing (tests pass a fake lib)
    this.lib = opts.lib ?? ccxt;
    if (!this.lib) throw new Error('CCXT not loaded yet');
    this.publicCache = new Map();
    this.privateCache = new Map();
    this.streams = new Map();
    this.gate = new RateGate();
  }

  publicExchange(id, pro = false) {
    const key = `${id}|${pro}`;
    let ex = this.publicCache.get(key);
    if (!ex) {
      const Cls = pro ? this.lib.pro[id] : this.lib[id];
      if (!Cls) throw new Error(`unknown exchange ${id}`);
      ex = new Cls({ enableRateLimit: true });
      this.publicCache.set(key, ex);
    }
    return ex;
  }

  /** Authenticated exchange for a vault key, cached until the key changes. */
  privateExchange(secretId) {
    const hit = this.privateCache.get(secretId);
    if (hit) return hit;
    const s = this.vault.reveal(secretId);
    if (s.kind !== 'exchange' || !s.exchange) throw new Error('this key is not an exchange key');
    const Cls = this.lib[s.exchange];
    if (!Cls) throw new Error(`unknown exchange ${s.exchange}`);
    const ex = new Cls({ enableRateLimit: true, ...credentialsFrom(s.fields) });
    if (s.fields.sandbox === 'true') {
      // never fall back to the live exchange when a testnet key was asked for
      try {
        ex.setSandboxMode(true);
      } catch {
        throw new Error(`${ex.name ?? s.exchange} has no testnet in CCXT — untick “testnet / sandbox” to use the live exchange`);
      }
    }
    this.privateCache.set(secretId, ex);
    return ex;
  }

  /** Drop the cached client after a key is edited or deleted. */
  invalidate(secretId) {
    const ex = this.privateCache.get(secretId);
    this.privateCache.delete(secretId);
    void ex?.close?.()?.catch?.(() => undefined);
  }

  async markets(id) {
    const ex = this.publicExchange(id);
    const m = await ex.loadMarkets();
    return Object.values(m)
      .filter((x) => x.active !== false)
      .map((x) => ({ symbol: x.symbol, base: x.base, quote: x.quote, type: x.type, contract: Boolean(x.contract), linear: x.linear }));
  }

  async ohlcv(id, symbol, timeframe, limit) {
    const ex = this.publicExchange(id);
    await ex.loadMarkets();
    const tf = ex.timeframes && !ex.timeframes[timeframe] ? Object.keys(ex.timeframes)[0] : timeframe;
    const rows = await ex.fetchOHLCV(symbol, tf, undefined, limit);
    return rows.map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }));
  }

  async tickers(id) {
    const ex = this.publicExchange(id);
    await ex.loadMarkets();
    if (!ex.has.fetchTickers) return [];
    const t = await ex.fetchTickers();
    return Object.values(t).map((x) => ({
      symbol: x.symbol,
      last: x.last ?? x.close,
      change24hPct: x.percentage ?? 0,
      volume24hUsd: x.quoteVolume ?? (x.baseVolume ?? 0) * (x.last ?? 0),
      high24h: x.high,
      low24h: x.low,
    }));
  }

  async ticker(id, symbol) {
    const ex = this.publicExchange(id);
    await ex.loadMarkets();
    const x = await ex.fetchTicker(symbol);
    return { symbol, last: x.last ?? x.close, change24hPct: x.percentage ?? 0, volume24hUsd: x.quoteVolume ?? 0, high24h: x.high, low24h: x.low };
  }

  // ---------- streaming ----------

  /**
   * Start streaming trades, book and stats for one market. `emit` receives
   * {kind:'status'|'trades'|'book'|'stats', ...}.
   */
  subscribe(sid, exchangeId, symbol, emit, opts = {}) {
    this.unsubscribe(sid);
    const state = { stop: false, ex: null };
    this.streams.set(sid, state);
    const status = (state_, error) => emit({ kind: 'status', state: state_, error });
    (async () => {
      status('connecting');
      let ex;
      try {
        const pro = Boolean(this.lib.pro[exchangeId]);
        const Cls = pro ? this.lib.pro[exchangeId] : this.lib[exchangeId];
        if (!Cls) throw new Error(`unknown exchange ${exchangeId}`);
        ex = new Cls({ enableRateLimit: true, newUpdates: true });
        // testnet bots must read testnet prices, not the live market
        if (opts.sandbox) ex.setSandboxMode(true);
        state.ex = ex;
        await ex.loadMarkets();
        if (!ex.markets[symbol]) throw new Error(`${symbol} not listed on ${ex.name}`);
      } catch (e) {
        status('error', String(e?.message ?? e));
        return;
      }
      status('open');
      const loops = [this.tradeLoop(state, ex, symbol, emit, status), this.bookLoop(state, ex, symbol, emit), this.statsLoop(state, ex, symbol, emit)];
      await Promise.allSettled(loops);
    })();
  }

  async tradeLoop(state, ex, symbol, emit, status) {
    const seen = new Set();
    let lastT = 0;
    const push = (trades) => {
      const out = [];
      for (const t of trades) {
        const key = t.id ?? `${t.timestamp}-${t.price}-${t.amount}`;
        if (t.timestamp < lastT || seen.has(key)) continue;
        seen.add(key);
        out.push({ p: t.price, q: t.amount, s: t.side === 'sell' ? 'sell' : 'buy', t: t.timestamp });
        lastT = Math.max(lastT, t.timestamp);
      }
      if (seen.size > 5000) seen.clear();
      if (out.length) emit({ kind: 'trades', trades: out });
    };
    let failing = false;
    while (!state.stop) {
      try {
        if (ex.has.watchTrades) push(await ex.watchTrades(symbol));
        else {
          push(await ex.fetchTrades(symbol, lastT ? lastT : undefined));
          await sleep(1500);
        }
        // report the feed as open again only once trades actually arrive
        if (failing) {
          failing = false;
          status('open');
        }
      } catch (e) {
        if (state.stop) return;
        failing = true;
        status('error', String(e?.message ?? e));
        await sleep(3000);
      }
    }
  }

  async bookLoop(state, ex, symbol, emit) {
    let last = 0;
    while (!state.stop) {
      try {
        const ob = ex.has.watchOrderBook ? await ex.watchOrderBook(symbol) : await ex.fetchOrderBook(symbol, 100);
        const now = Date.now();
        // full-book snapshots, throttled to 5/s to keep IPC light
        if (now - last >= 200) {
          last = now;
          emit({ kind: 'book', bids: ob.bids.slice(0, BOOK_DEPTH).map((l) => [l[0], l[1]]), asks: ob.asks.slice(0, BOOK_DEPTH).map((l) => [l[0], l[1]]), t: ob.timestamp ?? now });
        }
        if (!ex.has.watchOrderBook) await sleep(1000);
      } catch {
        if (state.stop) return;
        await sleep(3000);
      }
    }
  }

  async statsLoop(state, ex, symbol, emit) {
    const market = ex.markets[symbol];
    let n = 0;
    while (!state.stop) {
      const stats = {};
      try {
        const t = await ex.fetchTicker(symbol);
        Object.assign(stats, { last: t.last, change24hPct: t.percentage, high24h: t.high, low24h: t.low, volume24hUsd: t.quoteVolume, markPrice: t.markPrice, indexPrice: t.indexPrice });
      } catch {
        /* ticker optional */
      }
      if (market?.contract && n % 6 === 0) {
        try {
          if (ex.has.fetchFundingRate) {
            const f = await ex.fetchFundingRate(symbol);
            Object.assign(stats, { fundingRate: f.fundingRate, nextFundingTime: f.fundingTimestamp ?? f.nextFundingTimestamp, markPrice: f.markPrice ?? stats.markPrice, indexPrice: f.indexPrice ?? stats.indexPrice });
          }
        } catch {
          /* optional */
        }
        try {
          if (ex.has.fetchOpenInterest) {
            const oi = await ex.fetchOpenInterest(symbol);
            Object.assign(stats, { openInterest: oi.openInterestAmount, openInterestUsd: oi.openInterestValue });
          }
        } catch {
          /* optional */
        }
      }
      for (const k of Object.keys(stats)) if (stats[k] === undefined || stats[k] === null) delete stats[k];
      emit({ kind: 'stats', stats });
      n++;
      for (let i = 0; i < 10 && !state.stop; i++) await sleep(500);
    }
  }

  unsubscribe(sid) {
    const s = this.streams.get(sid);
    if (!s) return;
    s.stop = true;
    this.streams.delete(sid);
    void s.ex?.close?.().catch(() => undefined);
  }

  closeAll() {
    for (const sid of [...this.streams.keys()]) this.unsubscribe(sid);
  }

  // ---------- private (API keys from the vault) ----------

  async testKey(secretId) {
    const ex = this.privateExchange(secretId);
    const bal = await ex.fetchBalance();
    const assets = Object.entries(bal.total ?? {}).filter(([, v]) => v).length;
    return { ok: true, exchange: ex.name, assets };
  }

  async account(secretId, symbol) {
    const ex = this.privateExchange(secretId);
    await ex.loadMarkets();
    const out = { exchange: ex.name, balances: [], positions: [], openOrders: [], myTrades: [], errors: {} };
    try {
      const bal = await ex.fetchBalance();
      out.balances = Object.keys(bal.total ?? {})
        .filter((c) => bal.total[c])
        .map((c) => ({ currency: c, total: bal.total[c], free: bal.free?.[c] ?? null, used: bal.used?.[c] ?? null }));
    } catch (e) {
      out.errors.balances = String(e?.message ?? e);
    }
    if (ex.has.fetchPositions) {
      try {
        const ps = await ex.fetchPositions();
        out.positions = ps
          .filter((p) => p.contracts || p.notional)
          .map((p) => ({ symbol: p.symbol, side: p.side, contracts: p.contracts, notional: p.notional, entryPrice: p.entryPrice, markPrice: p.markPrice, unrealizedPnl: p.unrealizedPnl, leverage: p.leverage, liquidationPrice: p.liquidationPrice }));
      } catch (e) {
        out.errors.positions = String(e?.message ?? e);
      }
    }
    if (ex.has.fetchOpenOrders) {
      try {
        // all symbols when the venue allows it (CCXT warns by throwing unless told not to)
        ex.options.warnOnFetchOpenOrdersWithoutSymbol = false;
        let os;
        try {
          os = await ex.fetchOpenOrders();
        } catch (e) {
          if (!symbol || !ex.markets[symbol]) throw e;
          os = await ex.fetchOpenOrders(symbol);
        }
        out.openOrders = os.map((o) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, price: o.price, amount: o.amount, filled: o.filled, status: o.status, time: o.timestamp }));
      } catch (e) {
        out.errors.openOrders = String(e?.message ?? e);
      }
    }
    if (ex.has.fetchMyTrades && symbol && ex.markets[symbol]) {
      try {
        const ts = await ex.fetchMyTrades(symbol, undefined, 50);
        out.myTrades = ts.map((t) => ({ id: t.id, symbol: t.symbol, side: t.side, price: t.price, amount: t.amount, cost: t.cost, fee: t.fee?.cost ?? null, feeCurrency: t.fee?.currency ?? null, time: t.timestamp }));
      } catch (e) {
        out.errors.myTrades = String(e?.message ?? e);
      }
    }
    return out;
  }

  // ---------- trading ----------

  /** The key's plaintext record, only when trading was switched on for it. */
  tradingKey(secretId) {
    const s = this.vault.reveal(secretId);
    if (s.kind !== 'exchange') throw new Error('this key is not an exchange key');
    if (s.fields.trading !== 'enabled') throw new Error('Trading is off for this key. Edit it in 🔑 Keys and tick “Allow trading”.');
    return s;
  }

  limits() {
    return sanitizeLimits(this.db?.get('tradingLimits'));
  }

  setLimits(l) {
    const v = sanitizeLimits(l);
    this.db?.set('tradingLimits', v);
    return v;
  }

  log(row) {
    try {
      this.db?.logOrder(row);
    } catch (e) {
      console.warn('order log', e?.message ?? e);
    }
  }

  async refPrice(ex, symbol) {
    const t = await ex.fetchTicker(symbol);
    const mid = t.bid && t.ask ? (t.bid + t.ask) / 2 : undefined;
    const p = t.last ?? t.close ?? mid;
    if (!(p > 0)) throw new Error(`no price for ${symbol}`);
    return { price: p, bid: t.bid ?? null, ask: t.ask ?? null };
  }

  /** USD value of one unit of a non-dollar quote currency (e.g. BTC, EUR). */
  async quoteUsd(ex, quote) {
    for (const s of [`${quote}/USDT`, `${quote}/USD`, `${quote}/USDC`]) {
      if (!ex.markets[s]) continue;
      try {
        return (await this.refPrice(ex, s)).price;
      } catch {
        /* try the next pair */
      }
    }
    const inv = [`USDT/${quote}`, `USD/${quote}`].find((s) => ex.markets[s]);
    if (inv) return 1 / (await this.refPrice(ex, inv)).price;
    return NaN;
  }

  /** Everything the order ticket needs for one market on one key. */
  async marketInfo(secretId, symbol) {
    const s = this.vault.reveal(secretId);
    const ex = this.privateExchange(secretId);
    await ex.loadMarkets();
    const m = ex.markets[symbol];
    if (!m) throw new Error(`${symbol} is not listed on ${ex.name}`);
    const px = await this.refPrice(ex, symbol);
    const out = {
      exchange: ex.name,
      exchangeId: s.exchange,
      label: s.label,
      sandbox: s.fields.sandbox === 'true',
      trading: s.fields.trading === 'enabled',
      symbol,
      base: m.base,
      quote: m.quote,
      settle: m.settle ?? null,
      type: m.type,
      contract: Boolean(m.contract),
      inverse: Boolean(m.inverse),
      contractSize: m.contractSize ?? 1,
      minAmount: m.limits?.amount?.min ?? null,
      minCost: m.limits?.cost?.min ?? null,
      last: px.price,
      bid: px.bid,
      ask: px.ask,
      maker: m.maker ?? null,
      taker: m.taker ?? null,
      canLeverage: Boolean(m.contract && ex.has.setLeverage),
      stops: Boolean(ex.has.createTriggerOrder ?? ex.has.createStopOrder ?? true),
      freeBase: null,
      freeQuote: null,
      limits: this.limits(),
    };
    try {
      const bal = await ex.fetchBalance();
      out.freeBase = bal.free?.[m.base] ?? null;
      out.freeQuote = bal.free?.[m.settle ?? m.quote] ?? null;
    } catch {
      /* balances optional here */
    }
    return out;
  }

  async applyLeverage(ex, leverage, market) {
    const lev = Math.round(Number(leverage));
    if (!(lev >= 1 && lev <= 200)) throw new Error('leverage must be between 1 and 200');
    if (!market.contract) throw new Error('leverage applies to derivatives; this is a spot market');
    if (!ex.has.setLeverage) throw new Error(`${ex.name} does not support setting leverage through its API — set it on the exchange, then clear the leverage field`);
    try {
      await ex.setLeverage(lev, market.symbol);
    } catch (e) {
      const msg = String(e?.message ?? e);
      // exchanges report "already at this leverage" as an error
      if (!/not modified|no need|same|unchanged|not changed/i.test(msg)) throw new Error(`could not set leverage: ${msg}`);
    }
  }

  async placeOrder(secretId, req) {
    const row = { action: 'place', secretId, symbol: req?.symbol, side: req?.side, type: req?.type, status: 'rejected' };
    try {
      const s = this.tradingKey(secretId);
      row.exchange = s.exchange;
      row.sandbox = s.fields.sandbox === 'true';
      const limits = this.limits();
      const ex = this.privateExchange(secretId);
      await ex.loadMarkets();
      const market = ex.markets[req.symbol];
      const { price } = await this.refPrice(ex, req.symbol);
      const quoteUsd = market && !USD_QUOTES.has(market.quote) ? await this.quoteUsd(ex, market.quote) : 1;
      // a spot close sells coins you hold: it may exceed the cap, but never what is held
      let capExempt = false;
      if (req.closeSpot) {
        if (!market || market.contract || req.side !== 'sell') throw new Error('closeSpot is only for selling a spot holding');
        const bal = await ex.fetchBalance();
        const held = bal.free?.[market.base] ?? 0;
        if (!(req.size <= held * 1.000001)) throw new Error(`cannot sell ${req.size} ${market.base}: only ${held} held`);
        capExempt = true;
      }
      const o = buildOrder(req, market, {
        refPrice: price,
        quoteUsd,
        limits,
        capExempt,
        amountToPrecision: (x) => Number(ex.amountToPrecision(req.symbol, x)),
        priceToPrecision: (x) => Number(ex.priceToPrecision(req.symbol, x)),
      });
      // reduce-only can never be larger than the position it reduces
      if (o.params.reduceOnly && market.contract && ex.has.fetchPositions) {
        const open = await this.positionContracts(ex, req.symbol, req.side === 'sell' ? 'long' : 'short').catch(() => null);
        if (open === 0) throw new Error(`no ${req.side === 'sell' ? 'long' : 'short'} position in ${req.symbol} to reduce`);
        if (open !== null && o.amount > open) o.amount = Number(ex.amountToPrecision(req.symbol, open));
      }
      Object.assign(row, { amount: o.amount, price: o.price, triggerPrice: o.params.triggerPrice, notionalUsd: o.notionalUsd });
      // orders that only reduce risk are never held back by the rate limit
      if (!o.params.reduceOnly && !capExempt) this.gate.take(limits.maxOrdersPerMinute);
      if (req.leverage) await this.applyLeverage(ex, req.leverage, market);
      row.status = 'error';
      const res = await ex.createOrder(o.symbol, o.type, o.side, o.amount, o.price, o.params);
      row.status = 'placed';
      row.orderId = res?.id ?? null;
      return {
        id: res?.id ?? null,
        status: res?.status ?? 'open',
        symbol: o.symbol,
        side: o.side,
        type: req.type,
        amount: o.amount,
        baseQty: o.baseQty,
        price: res?.average ?? o.price ?? res?.price ?? null,
        filled: res?.filled ?? null,
        notionalUsd: o.notionalUsd,
        exchange: ex.name,
        sandbox: row.sandbox,
      };
    } catch (e) {
      row.message = String(e?.message ?? e);
      throw e;
    } finally {
      this.log(row);
    }
  }

  /** Cancelling only removes risk, so it works even with trading switched off. */
  async cancelOrder(secretId, orderId, symbol) {
    const row = { action: 'cancel', secretId, symbol, orderId, status: 'error' };
    try {
      const s = this.vault.reveal(secretId);
      row.exchange = s.exchange;
      row.sandbox = s.fields.sandbox === 'true';
      const ex = this.privateExchange(secretId);
      await ex.loadMarkets();
      await ex.cancelOrder(orderId, symbol);
      row.status = 'cancelled';
      return true;
    } catch (e) {
      row.message = String(e?.message ?? e);
      throw e;
    } finally {
      this.log(row);
    }
  }

  async cancelAll(secretId, symbol) {
    const row = { action: 'cancel-all', secretId, symbol: symbol ?? null, status: 'error' };
    try {
      const s = this.vault.reveal(secretId);
      row.exchange = s.exchange;
      row.sandbox = s.fields.sandbox === 'true';
      const ex = this.privateExchange(secretId);
      await ex.loadMarkets();
      let n = 0;
      if (ex.has.cancelAllOrders && symbol) {
        const r = await ex.cancelAllOrders(symbol);
        n = Array.isArray(r) ? r.length : 0;
      } else {
        ex.options.warnOnFetchOpenOrdersWithoutSymbol = false;
        const open = await ex.fetchOpenOrders(symbol);
        for (const o of open) {
          await ex.cancelOrder(o.id, o.symbol);
          n++;
        }
      }
      row.status = 'cancelled';
      row.message = `${n} orders`;
      return n;
    } catch (e) {
      row.message = String(e?.message ?? e);
      throw e;
    } finally {
      this.log(row);
    }
  }

  /** Open contracts in a symbol (optionally one side); null when the venue can't say. */
  async positionContracts(exOrSecret, symbol, side) {
    const ex = typeof exOrSecret === 'string' ? this.privateExchange(exOrSecret) : exOrSecret;
    await ex.loadMarkets();
    if (!ex.has.fetchPositions) return null;
    const ps = await ex.fetchPositions([symbol]);
    return ps.filter((p) => p.symbol === symbol && (!side || p.side === side)).reduce((a, p) => a + Math.abs(p.contracts ?? 0), 0);
  }

  /** Flatten a derivatives position with a reduce-only market order. */
  async closePosition(secretId, symbol, side) {
    const row = { action: 'close', secretId, symbol, type: 'market', status: 'rejected' };
    try {
      const s = this.tradingKey(secretId);
      row.exchange = s.exchange;
      row.sandbox = s.fields.sandbox === 'true';
      const ex = this.privateExchange(secretId);
      await ex.loadMarkets();
      if (!ex.has.fetchPositions) throw new Error(`${ex.name} does not report positions through CCXT`);
      const ps = await ex.fetchPositions([symbol]);
      const p = ps.find((x) => x.symbol === symbol && Math.abs(x.contracts ?? 0) > 0 && (!side || x.side === side));
      const o = closeOrderFor(p);
      o.amount = Number(ex.amountToPrecision(symbol, o.amount));
      Object.assign(row, { side: o.side, amount: o.amount });
      row.status = 'error';
      const res = await ex.createOrder(o.symbol, o.type, o.side, o.amount, undefined, o.params);
      row.status = 'placed';
      row.orderId = res?.id ?? null;
      return { id: res?.id ?? null, side: o.side, amount: o.amount };
    } catch (e) {
      row.message = String(e?.message ?? e);
      throw e;
    } finally {
      this.log(row);
    }
  }
}

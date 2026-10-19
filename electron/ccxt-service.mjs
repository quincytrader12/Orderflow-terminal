// CCXT bridge: public market data streams for any CCXT exchange (ccxt.pro
// WebSockets with REST polling fallback) and private account endpoints that
// use API keys from the vault. Runs in the Electron main process so there are
// no CORS limits and keys never reach the renderer.
import ccxt from 'ccxt';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BOOK_DEPTH = 500;

export function listExchanges() {
  return ccxt.exchanges.map((id) => {
    let name = id;
    let pro = false;
    let requiredCredentials = {};
    try {
      const ex = new ccxt[id]();
      name = ex.name ?? id;
      requiredCredentials = ex.requiredCredentials ?? {};
      pro = Boolean(ccxt.pro[id]);
    } catch {
      /* exchange failed to construct */
    }
    const creds = Object.entries(requiredCredentials)
      .filter(([, v]) => v)
      .map(([k]) => k);
    return { id, name, pro, credentials: creds };
  });
}

/** CCXT credential field names come straight from the vault record. */
function credentialsFrom(fields) {
  const out = {};
  for (const k of ['apiKey', 'secret', 'password', 'uid', 'login', 'twofa', 'privateKey', 'walletAddress', 'token']) if (fields[k]) out[k] = fields[k];
  return out;
}

export class CcxtService {
  constructor(vault) {
    this.vault = vault;
    this.publicCache = new Map();
    this.streams = new Map();
  }

  publicExchange(id, pro = false) {
    const key = `${id}|${pro}`;
    let ex = this.publicCache.get(key);
    if (!ex) {
      const Cls = pro ? ccxt.pro[id] : ccxt[id];
      if (!Cls) throw new Error(`unknown exchange ${id}`);
      ex = new Cls({ enableRateLimit: true });
      this.publicCache.set(key, ex);
    }
    return ex;
  }

  privateExchange(secretId) {
    const s = this.vault.reveal(secretId);
    if (s.kind !== 'exchange' || !s.exchange) throw new Error('this key is not an exchange key');
    const Cls = ccxt[s.exchange];
    if (!Cls) throw new Error(`unknown exchange ${s.exchange}`);
    const ex = new Cls({ enableRateLimit: true, ...credentialsFrom(s.fields) });
    if (s.fields.sandbox === 'true' && ex.has.sandbox !== false) ex.setSandboxMode(true);
    return ex;
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
  subscribe(sid, exchangeId, symbol, emit) {
    this.unsubscribe(sid);
    const state = { stop: false, ex: null };
    this.streams.set(sid, state);
    const status = (state_, error) => emit({ kind: 'status', state: state_, error });
    (async () => {
      status('connecting');
      let ex;
      try {
        const pro = Boolean(ccxt.pro[exchangeId]);
        const Cls = pro ? ccxt.pro[exchangeId] : ccxt[exchangeId];
        if (!Cls) throw new Error(`unknown exchange ${exchangeId}`);
        ex = new Cls({ enableRateLimit: true, newUpdates: true });
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
    while (!state.stop) {
      try {
        if (ex.has.watchTrades) push(await ex.watchTrades(symbol));
        else {
          push(await ex.fetchTrades(symbol, lastT ? lastT : undefined));
          await sleep(1500);
        }
      } catch (e) {
        if (state.stop) return;
        status('error', String(e?.message ?? e));
        await sleep(3000);
        status('open');
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
}

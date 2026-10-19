// Live ingestion from exchange WebSockets (Node 22 global WebSocket) with
// reconnect and, for Binance, REST gap-fill after reconnects.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const EXCHANGES = {
  binancef: { name: 'Binance Futures', liquidations: true },
  binance: { name: 'Binance Spot', liquidations: false },
  bybit: { name: 'Bybit Perp', liquidations: true },
  hyperliquid: { name: 'Hyperliquid', liquidations: false },
};

function socket(url, { onOpen, onMessage, log, pingMs, ping }) {
  let ws;
  let closed = false;
  let attempts = 0;
  let pingTimer;
  let staleTimer;
  let last = Date.now();
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempts = 0;
      last = Date.now();
      log(`connected ${url}`);
      if (pingMs) pingTimer = setInterval(() => ws.readyState === 1 && ws.send(ping()), pingMs);
      staleTimer = setInterval(() => {
        if (Date.now() - last > 60_000) {
          log('stale feed, reconnecting');
          ws.close();
        }
      }, 10_000);
      onOpen?.(ws);
    };
    ws.onmessage = (ev) => {
      last = Date.now();
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      try {
        onMessage(msg);
      } catch (e) {
        log(`handler error: ${e.message}`);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearInterval(pingTimer);
      clearInterval(staleTimer);
      if (closed) return;
      const delay = Math.min(30_000, 500 * 2 ** attempts++);
      log(`disconnected, retry in ${delay}ms`);
      setTimeout(connect, delay);
    };
  };
  connect();
  return { close: () => ((closed = true), ws?.close()) };
}

/** Fetch Binance aggTrades from `fromMs` (or after `fromId`) up to now. */
export async function binanceBackfill(futures, symbol, { fromMs, fromId, maxRequests = 300, fetchImpl = fetch, log = () => {} }) {
  const rest = futures ? 'https://fapi.binance.com/fapi/v1' : 'https://api.binance.com/api/v3';
  const out = [];
  let cursor = fromId ?? null;
  for (let i = 0; i < maxRequests; i++) {
    const url =
      cursor === null
        ? `${rest}/aggTrades?symbol=${symbol}&startTime=${fromMs}&endTime=${fromMs + 3_599_000}&limit=1000`
        : `${rest}/aggTrades?symbol=${symbol}&fromId=${cursor}&limit=1000`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push({ id: r.a, time: r.T, price: Number(r.p), qty: Number(r.q), isBuyerMaker: r.m });
    if (rows.length < 1000) break;
    cursor = rows[rows.length - 1].a + 1;
    await sleep(futures ? 250 : 120);
  }
  log(`backfilled ${out.length} trades`);
  return out;
}

export function startIngest(exchange, symbol, store, log) {
  switch (exchange) {
    case 'binancef':
    case 'binance': {
      const futures = exchange === 'binancef';
      const s = symbol.toLowerCase();
      const streams = [`${s}@aggTrade`];
      if (futures) streams.push(`${s}@forceOrder`);
      const base = futures ? 'wss://fstream.binance.com/stream?streams=' : 'wss://stream.binance.com:9443/stream?streams=';
      // After a reconnect, live trades are buffered until the REST gap fill has
      // inserted everything missed, so ids stay strictly increasing.
      let buffer = null;
      const addAgg = (d) => store.addTrade(d.a, d.T, Number(d.p), Number(d.q), d.m);
      return socket(base + streams.join('/'), {
        log,
        onOpen: () => {
          if (buffer || !isFinite(store.lastTradeId)) return;
          buffer = [];
          binanceBackfill(futures, symbol, { fromId: store.lastTradeId + 1, log })
            .then((rows) => {
              let n = 0;
              for (const r of rows) if (store.addTrade(r.id, r.time, r.price, r.qty, r.isBuyerMaker)) n++;
              if (n) log(`gap-filled ${n} trades`);
            })
            .catch((e) => log(`gap fill failed: ${e.message}`))
            .finally(() => {
              const pending = buffer ?? [];
              buffer = null;
              for (const d of pending) addAgg(d);
            });
        },
        onMessage: (m) => {
          const d = m.data;
          if (!d) return;
          if (d.e === 'aggTrade') {
            if (buffer) buffer.push(d);
            else addAgg(d);
          } else if (d.e === 'forceOrder') {
            const o = d.o;
            store.addLiquidation(o.T, Number(o.ap) || Number(o.p), Number(o.z) || Number(o.q), o.S === 'SELL' ? 'long' : 'short');
          }
        },
      });
    }
    case 'bybit': {
      let seq = 0;
      return socket('wss://stream.bybit.com/v5/public/linear', {
        log,
        pingMs: 20_000,
        ping: () => JSON.stringify({ op: 'ping' }),
        onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}`, `allLiquidation.${symbol}`] })),
        onMessage: (m) => {
          if (m.topic?.startsWith('publicTrade.')) {
            for (const t of m.data) store.addTrade(t.T * 1000 + (seq++ % 1000), t.T, Number(t.p), Number(t.v), t.S === 'Sell');
          } else if (m.topic?.startsWith('allLiquidation.')) {
            for (const l of m.data) store.addLiquidation(l.T, Number(l.p), Number(l.v), l.S === 'Buy' ? 'long' : 'short');
          }
        },
      });
    }
    case 'hyperliquid':
      return socket('wss://api.hyperliquid.xyz/ws', {
        log,
        pingMs: 30_000,
        ping: () => JSON.stringify({ method: 'ping' }),
        onOpen: (ws) => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: symbol } })),
        onMessage: (m) => {
          if (m.channel !== 'trades') return;
          for (const t of m.data) store.addTrade(t.tid, t.time, Number(t.px), Number(t.sz), t.side === 'A');
        },
      });
    default:
      throw new Error(`unsupported exchange ${exchange}`);
  }
}

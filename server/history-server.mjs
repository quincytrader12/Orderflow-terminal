#!/usr/bin/env node
// Self-hosted history server for Orderflow Terminal (BYOD protocol v1).
//
//   node server/history-server.mjs --exchange binancef --symbols BTCUSDT
//
// GET /health                      liveness, returns "ok"
// GET /v1/info                     exchanges/symbols and the span of stored data
// GET /v1/trades?exchange&symbol&start_ms&end_ms[&limit]
// GET /v1/liquidations?exchange&symbol&start_ms&end_ms[&limit]
//
// Response field names match the cryexc-history protocol so either server can
// back the terminal's "Custom (BYOD)" history source.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { EXCHANGES, binanceBackfill, startIngest } from './ingest.mjs';
import { MarketStore } from './store.mjs';

export const VERSION = '1.0.0';
const DEFAULT_LIMIT = 500_000;

export function parseArgs(argv) {
  const opts = {
    bind: '127.0.0.1',
    port: 8080,
    exchange: 'binancef',
    symbols: ['BTCUSDT'],
    authToken: '',
    retentionHours: 24,
    backfillMinutes: 60,
    dataDir: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`missing value for ${a}`);
      return x;
    };
    switch (a) {
      case '--bind':
        opts.bind = v();
        break;
      case '--port':
        opts.port = Number(v());
        break;
      case '--exchange':
        opts.exchange = v();
        break;
      case '--symbols':
        opts.symbols = v()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--auth-token':
        opts.authToken = v();
        break;
      case '--retention-hours':
        opts.retentionHours = Number(v());
        break;
      case '--backfill-minutes':
        opts.backfillMinutes = Number(v());
        break;
      case '--data-dir':
        opts.dataDir = v();
        break;
      case '--version':
        opts.version = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (!EXCHANGES[opts.exchange]) throw new Error(`--exchange must be one of ${Object.keys(EXCHANGES).join(', ')}`);
  if (!(opts.port > 0 && opts.port < 65536)) throw new Error('--port must be 1-65535');
  return opts;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const err = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

/** Build the HTTP handler around a set of stores. Exported for tests. */
export function createHandler({ exchange, stores, authToken = '', serverName = `orderflow-history/${VERSION}` }) {
  return (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') return err(res, 405, 'method_not_allowed', 'only GET is supported');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (!url.pathname.startsWith('/v1/')) return err(res, 404, 'not_found', `no route ${url.pathname}`);
    if (authToken && req.headers.authorization !== `Bearer ${authToken}`) return err(res, 401, 'unauthorized', 'missing or invalid bearer token');

    if (url.pathname === '/v1/info') {
      return sendJson(res, 200, {
        protocol_version: 1,
        server: serverName,
        server_time_ms: Date.now(),
        exchanges: [
          {
            id: exchange,
            display_name: EXCHANGES[exchange]?.name ?? exchange,
            symbols: [...stores.values()].map((s) => {
              const span = s.span();
              return {
                symbol: s.symbol,
                has_trades: s.trades.len > 0,
                has_liquidations: s.liqs.len > 0,
                data_start_ms: span?.start ?? 0,
                data_end_ms: span?.end ?? 0,
              };
            }),
          },
        ],
      });
    }
    if (url.pathname === '/v1/trades' || url.pathname === '/v1/liquidations') {
      const q = url.searchParams;
      const ex = q.get('exchange');
      const sym = q.get('symbol');
      const start = Number(q.get('start_ms'));
      const end = Number(q.get('end_ms'));
      const limit = Math.min(DEFAULT_LIMIT, Math.max(1, Number(q.get('limit') ?? DEFAULT_LIMIT)));
      if (!ex || !sym) return err(res, 400, 'bad_request', 'exchange and symbol are required');
      if (!isFinite(start) || !isFinite(end) || end < start) return err(res, 400, 'bad_request', 'start_ms and end_ms must be numbers with end_ms >= start_ms');
      if (ex !== exchange) return err(res, 404, 'unknown_exchange', `this server ingests ${exchange}`);
      const store = stores.get(sym.toUpperCase()) ?? stores.get(sym);
      if (!store) return err(res, 404, 'unknown_symbol', `symbol ${sym} is not ingested`);
      return sendJson(res, 200, url.pathname === '/v1/trades' ? store.queryTrades(start, end, limit) : store.queryLiquidations(start, end, limit));
    }
    return err(res, 404, 'not_found', `no route ${url.pathname}`);
  };
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(String(e.message));
    process.exit(2);
  }
  if (opts.version) {
    console.log(VERSION);
    return;
  }
  if (opts.help) {
    console.log(`orderflow history server ${VERSION}

  --bind <addr>              interface (default 127.0.0.1)
  --port <n>                 port (default 8080)
  --exchange <id>            ${Object.keys(EXCHANGES).join(' | ')} (default binancef)
  --symbols <a,b>            venue symbols, e.g. BTCUSDT or BTC for hyperliquid
  --auth-token <token>       require Authorization: Bearer <token> on /v1/*
  --retention-hours <n>      keep this much history (default 24)
  --backfill-minutes <n>     REST backfill on start, Binance only (default 60)
  --data-dir <path>          persist to disk and reload on restart`);
    return;
  }
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
  const stores = new Map();
  for (const sym of opts.symbols) {
    const s = new MarketStore(opts.exchange, sym.toUpperCase());
    if (opts.dataDir) {
      const n = s.load(opts.dataDir);
      if (n) log(`${sym}: loaded ${n} trades from ${opts.dataDir}`);
    }
    stores.set(s.symbol, s);
  }
  const ingests = [];
  for (const s of stores.values()) {
    const sublog = (m) => log(`${opts.exchange}:${s.symbol} ${m}`);
    if ((opts.exchange === 'binancef' || opts.exchange === 'binance') && opts.backfillMinutes > 0 && !s.trades.len) {
      binanceBackfill(opts.exchange === 'binancef', s.symbol, { fromMs: Date.now() - opts.backfillMinutes * 60_000, log: sublog })
        .then((rows) => sublog(`startup backfill inserted ${s.prependTrades(rows)} trades`))
        .catch((e) => sublog(`startup backfill failed: ${e.message}`));
    }
    ingests.push(startIngest(opts.exchange, s.symbol, s, sublog));
  }
  const prune = setInterval(() => {
    const cutoff = Date.now() - opts.retentionHours * 3_600_000;
    for (const s of stores.values()) s.prune(cutoff);
  }, 5 * 60_000);
  const persist = opts.dataDir
    ? setInterval(() => {
        for (const s of stores.values()) s.save(opts.dataDir);
      }, 5 * 60_000)
    : null;

  const server = createServer(createHandler({ exchange: opts.exchange, stores, authToken: opts.authToken }));
  server.listen(opts.port, opts.bind, () => {
    log(`listening on http://${opts.bind}:${opts.port} (${opts.exchange}: ${[...stores.keys()].join(', ')})`);
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(opts.bind);
    if (!loopback && !opts.authToken) log('WARNING: public bind without auth token — anyone on the network can read this data');
  });
  const shutdown = () => {
    log('shutting down');
    clearInterval(prune);
    if (persist) clearInterval(persist);
    for (const i of ingests) i.close();
    if (opts.dataDir) for (const s of stores.values()) s.save(opts.dataDir);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();

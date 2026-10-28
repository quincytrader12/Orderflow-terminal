// Multi-venue e2e: mocks every exchange's public WebSocket + REST endpoints
// inside Chromium (Playwright routeWebSocket/route) with protocol-shaped
// messages, then checks that each real adapter streams trades and a book into
// the hub and that the aggregated panels render.
//
//   node e2e/venues.mjs
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { seedWebLedger, unlock } from './unlock.mjs';

const PORT = Number(process.env.E2E_PORT ?? 5196);
const OUT = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // undefined lets playwright-core use its own installed browser (npx playwright-core install chromium)
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse())
    for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (existsSync(join(root, d, p))) return join(root, d, p);
  return undefined;
}

// ---------- synthetic market shared by all mocks ----------
const VENUE_OFFSET = { binancef: 0, bybit: 4, okx: -3, hyperliquid: 6, coinbase: 12, kraken: 9, bitget: -6, bitfinex: 15 };
let mid = 100_000;
setInterval(() => (mid += (Math.random() - 0.5) * 20), 100);
const rnd = (a, b) => a + Math.random() * (b - a);
const px = (v, d = 0) => (Math.round((mid + VENUE_OFFSET[v] + d) * 10) / 10).toFixed(1);
const levels = (v, side, n = 50, step = 1) => Array.from({ length: n }, (_, i) => [px(v, side === 'bid' ? -(i + 1) * step : (i + 1) * step), rnd(0.1, 5).toFixed(3)]);

function every(ms, fn, timers) {
  timers.push(setInterval(fn, ms));
}

const handlers = {
  // Binance futures: combined stream, depth sync via REST snapshot lastUpdateId=1000
  binancef(ws, timers) {
    let u = 1000;
    let a = 1;
    every(100, () => {
      const U = u - 2;
      const ev = { e: 'depthUpdate', E: Date.now(), T: Date.now(), s: 'BTCUSDT', U, u: u + 1, pu: u - 3, b: levels('binancef', 'bid', 5), a: levels('binancef', 'ask', 5) };
      // keep pu continuity: first event straddles 1000, then pu = previous u
      ev.pu = u === 1000 ? 990 : u;
      ev.U = u === 1000 ? 995 : u + 1;
      ev.u = u === 1000 ? 1001 : u + 2;
      u = ev.u;
      ws.send(JSON.stringify({ stream: 'btcusdt@depth@100ms', data: ev }));
      const buy = Math.random() < 0.5;
      ws.send(JSON.stringify({ stream: 'btcusdt@aggTrade', data: { e: 'aggTrade', E: Date.now(), s: 'BTCUSDT', a: a++, p: px('binancef', buy ? 0.5 : -0.5), q: rnd(0.001, 3).toFixed(3), T: Date.now(), m: !buy } }));
    }, timers);
    every(1000, () => {
      ws.send(JSON.stringify({ stream: 'btcusdt@markPrice@1s', data: { e: 'markPriceUpdate', E: Date.now(), s: 'BTCUSDT', p: px('binancef'), i: px('binancef', -5), r: '0.00010000', T: Date.now() + 3_600_000 } }));
      ws.send(JSON.stringify({ stream: 'btcusdt@ticker', data: { e: '24hrTicker', E: Date.now(), c: px('binancef'), P: '1.23', h: px('binancef', 900), l: px('binancef', -1200), q: '15000000000' } }));
    }, timers);
    every(1500, () => ws.send(JSON.stringify({ stream: 'btcusdt@forceOrder', data: { e: 'forceOrder', E: Date.now(), o: { s: 'BTCUSDT', S: Math.random() < 0.5 ? 'SELL' : 'BUY', q: '1.2', p: px('binancef'), ap: px('binancef'), z: '1.2', T: Date.now() } } })), timers);
  },
  bybit(ws, timers) {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.op !== 'subscribe') return;
      ws.send(JSON.stringify({ topic: 'orderbook.200.BTCUSDT', type: 'snapshot', ts: Date.now(), data: { s: 'BTCUSDT', b: levels('bybit', 'bid', 200), a: levels('bybit', 'ask', 200), u: 1, seq: 1 } }));
      let seq = 2;
      every(100, () => {
        ws.send(JSON.stringify({ topic: 'orderbook.200.BTCUSDT', type: 'delta', ts: Date.now(), data: { s: 'BTCUSDT', b: levels('bybit', 'bid', 3), a: levels('bybit', 'ask', 3), u: seq, seq: seq++ } }));
        ws.send(JSON.stringify({ topic: 'publicTrade.BTCUSDT', type: 'snapshot', ts: Date.now(), data: [{ T: Date.now(), s: 'BTCUSDT', S: Math.random() < 0.5 ? 'Buy' : 'Sell', v: rnd(0.001, 2).toFixed(3), p: px('bybit') }] }));
      }, timers);
      every(1000, () => {
        ws.send(JSON.stringify({ topic: 'tickers.BTCUSDT', type: 'snapshot', ts: Date.now(), data: { symbol: 'BTCUSDT', lastPrice: px('bybit'), markPrice: px('bybit'), indexPrice: px('bybit', -4), fundingRate: '0.00008', nextFundingTime: String(Date.now() + 7_200_000), openInterest: '52000', openInterestValue: String(52000 * mid), turnover24h: '8000000000', price24hPcnt: '0.011' } }));
        ws.send(JSON.stringify({ topic: 'allLiquidation.BTCUSDT', ts: Date.now(), data: [{ T: Date.now(), s: 'BTCUSDT', S: 'Buy', v: '0.8', p: px('bybit') }] }));
      }, timers);
    });
  },
  okx(ws, timers) {
    ws.onMessage((m) => {
      if (String(m) === 'ping') return ws.send('pong');
      const msg = JSON.parse(String(m));
      if (msg.op !== 'subscribe' || !msg.args.some((x) => x.channel === 'books')) return;
      const row = ([p, q]) => [p, String(Math.round(Number(q) * 100)), '0', '3'];
      let seq = 1;
      ws.send(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'snapshot', data: [{ bids: levels('okx', 'bid', 100).map(row), asks: levels('okx', 'ask', 100).map(row), ts: String(Date.now()), seqId: seq, prevSeqId: -1 }] }));
      every(100, () => {
        ws.send(JSON.stringify({ arg: { channel: 'books', instId: 'BTC-USDT-SWAP' }, action: 'update', data: [{ bids: levels('okx', 'bid', 3).map(row), asks: levels('okx', 'ask', 3).map(row), ts: String(Date.now()), seqId: seq + 1, prevSeqId: seq }] }));
        seq++;
        ws.send(JSON.stringify({ arg: { channel: 'trades', instId: 'BTC-USDT-SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', px: px('okx'), sz: String(Math.ceil(rnd(1, 200))), side: Math.random() < 0.5 ? 'buy' : 'sell', ts: String(Date.now()) }] }));
      }, timers);
      every(1000, () => {
        ws.send(JSON.stringify({ arg: { channel: 'open-interest', instId: 'BTC-USDT-SWAP' }, data: [{ oi: '3000000', oiCcy: '30000', ts: String(Date.now()) }] }));
        ws.send(JSON.stringify({ arg: { channel: 'funding-rate', instId: 'BTC-USDT-SWAP' }, data: [{ fundingRate: '0.00012', fundingTime: String(Date.now() + 5_000_000) }] }));
        ws.send(JSON.stringify({ arg: { channel: 'mark-price', instId: 'BTC-USDT-SWAP' }, data: [{ markPx: px('okx') }] }));
        ws.send(JSON.stringify({ arg: { channel: 'liquidation-orders', instType: 'SWAP' }, data: [{ instId: 'BTC-USDT-SWAP', details: [{ side: 'buy', posSide: 'short', bkPx: px('okx'), sz: '40', ts: String(Date.now()) }] }] }));
      }, timers);
    });
  },
  hyperliquid(ws, timers) {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.method === 'ping') return ws.send(JSON.stringify({ channel: 'pong' }));
      if (msg.subscription?.type !== 'l2Book') return;
      every(250, () => {
        const lv = (side) => levels('hyperliquid', side, 20, 2).map(([p, q]) => ({ px: p, sz: q, n: 3 }));
        ws.send(JSON.stringify({ channel: 'l2Book', data: { coin: 'BTC', time: Date.now(), levels: [lv('bid'), lv('ask')] } }));
        ws.send(JSON.stringify({ channel: 'trades', data: [{ coin: 'BTC', side: Math.random() < 0.5 ? 'B' : 'A', px: px('hyperliquid'), sz: rnd(0.001, 1).toFixed(4), time: Date.now(), tid: Date.now() }] }));
      }, timers);
      every(1000, () => ws.send(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: 'BTC', ctx: { funding: '0.0000125', openInterest: '25000', markPx: px('hyperliquid'), oraclePx: px('hyperliquid', -3), dayNtlVlm: '3000000000', prevDayPx: String(mid * 0.99), midPx: px('hyperliquid') } } })), timers);
    });
  },
  coinbase(ws, timers) {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.channel !== 'level2') return;
      const up = (side, lv) => lv.map(([p, q]) => ({ side, event_time: new Date().toISOString(), price_level: p, new_quantity: q }));
      ws.send(JSON.stringify({ channel: 'l2_data', timestamp: new Date().toISOString(), events: [{ type: 'snapshot', product_id: 'BTC-USD', updates: [...up('bid', levels('coinbase', 'bid', 100, 0.5)), ...up('offer', levels('coinbase', 'ask', 100, 0.5))] }] }));
      every(150, () => {
        ws.send(JSON.stringify({ channel: 'l2_data', timestamp: new Date().toISOString(), events: [{ type: 'update', product_id: 'BTC-USD', updates: [...up('bid', levels('coinbase', 'bid', 2, 0.5)), ...up('offer', levels('coinbase', 'ask', 2, 0.5))] }] }));
        ws.send(JSON.stringify({ channel: 'market_trades', timestamp: new Date().toISOString(), events: [{ type: 'update', trades: [{ trade_id: '1', product_id: 'BTC-USD', price: px('coinbase'), size: rnd(0.001, 1).toFixed(4), side: Math.random() < 0.5 ? 'BUY' : 'SELL', time: new Date().toISOString() }] }] }));
      }, timers);
    });
  },
  kraken(ws, timers) {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.params?.channel !== 'book') return;
      const lv = (side, n) => levels('kraken', side, n).map(([p, q]) => ({ price: Number(p), qty: Number(q) }));
      ws.send(JSON.stringify({ channel: 'book', type: 'snapshot', data: [{ symbol: 'BTC/USD', bids: lv('bid', 100), asks: lv('ask', 100), checksum: 0, timestamp: new Date().toISOString() }] }));
      every(200, () => {
        ws.send(JSON.stringify({ channel: 'book', type: 'update', data: [{ symbol: 'BTC/USD', bids: lv('bid', 2), asks: lv('ask', 2), checksum: 0, timestamp: new Date().toISOString() }] }));
        ws.send(JSON.stringify({ channel: 'trade', type: 'update', data: [{ symbol: 'BTC/USD', side: Math.random() < 0.5 ? 'buy' : 'sell', price: Number(px('kraken')), qty: rnd(0.001, 1), ord_type: 'market', trade_id: 1, timestamp: new Date().toISOString() }] }));
      }, timers);
    });
  },
  bitget(ws, timers) {
    ws.onMessage((m) => {
      if (String(m) === 'ping') return ws.send('pong');
      const msg = JSON.parse(String(m));
      if (msg.op !== 'subscribe') return;
      ws.send(JSON.stringify({ action: 'snapshot', arg: { instType: 'USDT-FUTURES', channel: 'books', instId: 'BTCUSDT' }, data: [{ bids: levels('bitget', 'bid', 150), asks: levels('bitget', 'ask', 150), ts: String(Date.now()) }], ts: Date.now() }));
      every(150, () => {
        ws.send(JSON.stringify({ action: 'update', arg: { instType: 'USDT-FUTURES', channel: 'books', instId: 'BTCUSDT' }, data: [{ bids: levels('bitget', 'bid', 2), asks: levels('bitget', 'ask', 2), ts: String(Date.now()) }], ts: Date.now() }));
        ws.send(JSON.stringify({ action: 'update', arg: { instType: 'USDT-FUTURES', channel: 'trade', instId: 'BTCUSDT' }, data: [{ ts: String(Date.now()), price: px('bitget'), size: rnd(0.001, 2).toFixed(3), side: Math.random() < 0.5 ? 'buy' : 'sell', tradeId: '1' }], ts: Date.now() }));
      }, timers);
      every(1000, () => ws.send(JSON.stringify({ action: 'snapshot', arg: { instType: 'USDT-FUTURES', channel: 'ticker', instId: 'BTCUSDT' }, data: [{ lastPr: px('bitget'), markPrice: px('bitget'), indexPrice: px('bitget', -2), fundingRate: '0.00005', nextFundingTime: String(Date.now() + 1_000_000), holdingAmount: '20000', change24h: '0.009', quoteVolume: '2000000000' }], ts: Date.now() })), timers);
    });
  },
  bitfinex(ws, timers) {
    ws.onMessage((m) => {
      const msg = JSON.parse(String(m));
      if (msg.event !== 'subscribe') return;
      const chanId = { trades: 11, book: 12, ticker: 13 }[msg.channel];
      ws.send(JSON.stringify({ event: 'subscribed', channel: msg.channel, chanId, symbol: msg.symbol }));
      if (msg.channel === 'book') {
        const rows = [...levels('bitfinex', 'bid', 100).map(([p, q]) => [Number(p), 2, Number(q)]), ...levels('bitfinex', 'ask', 100).map(([p, q]) => [Number(p), 2, -Number(q)])];
        ws.send(JSON.stringify([12, rows]));
        every(200, () => {
          // both sides, as the real feed does (bids alone would cross the stale asks as the price drifts)
          const [p, q] = levels('bitfinex', 'bid', 1)[0];
          ws.send(JSON.stringify([12, [Number(p), 1, Number(q)]]));
          const [pa, qa] = levels('bitfinex', 'ask', 1)[0];
          ws.send(JSON.stringify([12, [Number(pa), 1, -Number(qa)]]));
          const amt = rnd(-1, 1);
          ws.send(JSON.stringify([11, 'te', [Date.now(), Date.now(), amt, Number(px('bitfinex'))]]));
        }, timers);
      }
    });
  },
};

const WS_ROUTES = [
  [/fstream\.binance\.com/, 'binancef'],
  [/stream\.bybit\.com/, 'bybit'],
  [/ws\.okx\.com/, 'okx'],
  [/api\.hyperliquid\.xyz\/ws/, 'hyperliquid'],
  [/advanced-trade-ws\.coinbase\.com/, 'coinbase'],
  [/ws\.kraken\.com/, 'kraken'],
  [/ws\.bitget\.com/, 'bitget'],
  [/api-pub\.bitfinex\.com\/ws/, 'bitfinex'],
];

function klines(n, iv) {
  const now = Math.floor(Date.now() / iv) * iv;
  let p = mid;
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const o = p;
    const c = o + rnd(-60, 60);
    rows.push([now - i * iv, o.toFixed(1), (Math.max(o, c) + rnd(0, 40)).toFixed(1), (Math.min(o, c) - rnd(0, 40)).toFixed(1), c.toFixed(1), rnd(50, 400).toFixed(3), 0, 0, 0, rnd(20, 200).toFixed(3)]);
    p = c;
  }
  return rows;
}

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 30_000);
  server.stdout.on('data', (d) => String(d).includes('Local') && (clearTimeout(t), resolve()));
});

const errors = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
let ok = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  await seedWebLedger(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const timers = [];
  for (const [re, venue] of WS_ROUTES) {
    await page.routeWebSocket(re, (ws) => {
      const own = [];
      handlers[venue](ws, own);
      timers.push(...own);
      ws.onClose(() => own.forEach(clearInterval));
    });
  }
  await page.route(/fapi\.binance\.com\/fapi\/v1\/depth/, (r) =>
    r.fulfill({ json: { lastUpdateId: 1000, bids: levels('binancef', 'bid', 500), asks: levels('binancef', 'ask', 500) } }),
  );
  await page.route(/fapi\.binance\.com\/fapi\/v1\/klines/, (r) => {
    const iv = { '1m': 60e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '1d': 86400e3 }[new URL(r.request().url()).searchParams.get('interval')] ?? 60e3;
    return r.fulfill({ json: klines(500, iv) });
  });
  await page.route(/okx\.com\/api\/v5\/public\/instruments/, (r) => r.fulfill({ json: { data: [{ ctVal: '0.01' }] } }));
  await page.route(/fapi\.binance\.com\/(fapi\/v1\/openInterest|futures\/data)/, (r) => {
    const u = r.request().url();
    if (u.includes('openInterestHist')) return r.fulfill({ json: Array.from({ length: 100 }, (_, i) => ({ timestamp: Date.now() - (100 - i) * 300_000, sumOpenInterest: '80000', sumOpenInterestValue: String(80000 * mid * (1 + i / 2000)) })) });
    if (u.includes('LongShort')) return r.fulfill({ json: [{ longShortRatio: '1.8', longAccount: '0.64', shortAccount: '0.36' }] });
    return r.fulfill({ json: { openInterest: '80000' } });
  });

  const venues = Object.keys(VENUE_OFFSET);
  await page.goto(`http://localhost:${PORT}/?base=BTC&venue=binancef&agg=${venues.join(',')}&history=none`);
  await unlock(page);
  await page.waitForSelector('.topbar');
  await page.waitForTimeout(8000);

  const state = await page.evaluate(async () => {
    const { hub } = await import('/src/market/hub.ts');
    return hub().aggregate.map((f) => ({ venue: f.inst.venue, state: f.status.state, trades: f.store.length, bids: f.book.bids.size, asks: f.book.asks.size, mid: f.book.mid(), oi: f.stats.openInterestUsd ?? null, liqs: f.liqs.items.length }));
  });
  console.table(state);
  for (const s of state) {
    if (s.state !== 'open' || s.trades < 3 || s.bids < 1 || s.asks < 1 || !(s.mid > 0)) {
      ok = false;
      console.error(`venue ${s.venue} did not stream correctly`);
    }
    if (s.mid && Math.abs(s.mid - 100_000) > 5000) {
      ok = false;
      console.error(`venue ${s.venue} mid ${s.mid} looks mis-scaled`);
    }
  }
  const liqVenues = state.filter((s) => s.liqs > 0).map((s) => s.venue).sort();
  console.error(`liquidations from: ${liqVenues.join(', ')}`);
  if (liqVenues.join() !== 'binancef,bybit,okx') {
    ok = false;
    console.error('expected liquidations from binancef, bybit and okx');
  }
  await page.screenshot({ path: `${OUT}venues-terminal.png` });
  for (const preset of ['liquidity', 'derivs', 'flow']) {
    await page.click('button[title="Layout gallery & saved layouts"]');
    const ids = await page.evaluate(async () => (await import('/src/app/layouts.ts')).PRESETS.map((p) => p.id));
    await page.locator('.gallery-card').nth(ids.indexOf(preset)).click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${OUT}venues-${preset}.png` });
  }
  const crashed = await page.locator('text=crashed').count();
  if (crashed) errors.push(`${crashed} panel(s) crashed`);
  timers.forEach(clearInterval);
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  await browser.close();
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
}
if (errors.length) console.error(errors.join('\n'));
if (!ok || errors.length) process.exit(1);
console.log('Multi-venue e2e passed.');
process.exit(0);

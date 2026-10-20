// Live data check against real exchanges: the primary feed keeps receiving
// trades and the footprint keeps forming new candles with the latest price.
//   npm run build && node e2e/live-chart.mjs [venue=binancef] [seconds=75]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { seedWebLedger, unlock } from './unlock.mjs';

const VENUE = process.argv[2] ?? 'binancef';
const SECONDS = Number(process.argv[3] ?? 75);
const PORT = 5197;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 } });
  await seedWebLedger(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('console', m.text().slice(0, 200)));
  await page.goto(`http://localhost:${PORT}/?venue=${VENUE}&history=exchange&embed=footprint`);
  await unlock(page);
  const sample = () =>
    page.evaluate(() => {
      const H = window.__hub;
      const f = H.primary;
      const s = f.store;
      return { now: Date.now(), status: f.status.state, trades: s.length, end: s.end, gen: s.generation, first: s.firstTime(), last: s.lastTime(), price: f.lastPrice(), backfill: H.backfill.state + ' ' + H.backfill.count };
    });
  const rows = [];
  for (let t = 0; t <= SECONDS; t += 15) {
    const r = await sample();
    rows.push(r);
    console.log(`${String(t).padStart(3)}s ${r.status} trades=${r.trades} gen=${r.gen} lastAge=${((r.now - r.last) / 1000).toFixed(1)}s span=${((r.last - r.first) / 60000).toFixed(1)}m price=${r.price} backfill=${r.backfill}`);
    if (t === 0) await page.screenshot({ path: new URL(`./screenshots/live-${VENUE}-a.png`, import.meta.url).pathname });
    await page.waitForTimeout(15_000);
  }
  await page.screenshot({ path: new URL(`./screenshots/live-${VENUE}-b.png`, import.meta.url).pathname });
  const a = rows[1];
  const b = rows[rows.length - 1];
  if (!(b.end > a.end)) (ok = false), console.log('✗ no new trades arrived');
  if (!(b.now - b.last < 10_000)) (ok = false), console.log(`✗ newest trade is ${((b.now - b.last) / 1000).toFixed(0)} s old`);
} finally {
  await browser.close();
  process.kill(-server.pid);
}
console.log(ok ? 'Live chart check passed.' : 'Live chart check FAILED.');
process.exit(ok ? 0 : 1);

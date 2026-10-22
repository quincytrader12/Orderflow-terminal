// Live follow: the footprint keeps a sudden move in view, pauses when the
// owner pans, and returns to live by itself once left alone.
//   npm run build && node e2e/follow.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { seedWebLedger, unlock } from './unlock.mjs';

const PORT = 5198;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = true;
const expect = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) ok = false;
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await seedWebLedger(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/?venue=sim&agg=sim&history=exchange&embed=footprint`);
  await unlock(page);
  await page.waitForFunction(() => window.__footprintView?.plotH > 0, null, { timeout: 20_000 });
  await page.waitForTimeout(3000);
  const where = () => page.evaluate(() => ({ y: window.__footprintView.yLast / window.__footprintView.plotH, live: window.__footprintView.follow.live, offset: window.__footprintView.offset }));
  const chip = () => page.locator('.live-chip').innerText();

  // a sudden move: trades 1.5 % above the market
  await page.evaluate(() => {
    const f = window.__hub.primary;
    const p = f.lastPrice() * 1.015;
    for (let i = 0; i < 40; i++) f.store.push(p + i, 0.5, 'buy', Date.now());
  });
  await page.waitForTimeout(1200);
  const spike = await where();
  expect(spike.live && spike.y > 0.15 && spike.y < 0.85, `a 1.5 % spike stays on screen (price at ${(spike.y * 100).toFixed(0)} % of the chart)`);
  expect((await chip()).includes('LIVE'), 'chip shows LIVE');

  // the owner drags the chart away: following pauses
  const box = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 300, box.y + box.height / 2 + 250, { steps: 10 });
  await page.mouse.up();
  await page.mouse.move(2, 2); // leave the chart
  const panned = await where();
  expect(!panned.live && panned.offset > 1, `panning pauses follow (${panned.offset.toFixed(1)} bars back)`);
  // the chip refreshes four times a second
  await page.waitForFunction(() => /⏸ \d+s/.test(document.querySelector('.live-chip')?.textContent ?? ''), null, { timeout: 2000 }).catch(() => undefined);
  expect(/⏸ \d+s/.test(await chip()), `chip counts down (${await chip()})`);

  // keeps waiting while the pointer moves over the chart
  await page.waitForTimeout(8000);
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(box.x + 200 + i * 20, box.y + 200);
    await page.waitForTimeout(500);
  }
  expect(!(await where()).live, 'still paused while the owner is reading the chart');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(4500);
  const back = await where();
  expect(back.live && Math.abs(back.offset) < 0.05 && back.y > 0.3 && back.y < 0.7, `returns to live by itself (offset ${back.offset.toFixed(2)}, price at ${(back.y * 100).toFixed(0)} %)`);
  await page.screenshot({ path: new URL('./screenshots/follow-live.png', import.meta.url).pathname });
} finally {
  await browser.close();
  process.kill(-server.pid);
}
console.log(ok ? 'Follow check passed.' : 'Follow check FAILED.');
process.exit(ok ? 0 : 1);

// Screenshot the footprint chart on its own (design review):
//   npm run build && node e2e/footprint-shot.mjs [name]
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { seedWebLedger, unlock } from './unlock.mjs';

const NAME = process.argv[2] ?? 'footprint';
const PORT = 5196;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1.5 });
  await seedWebLedger(ctx);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/?venue=sim&agg=sim&history=exchange&embed=footprint`);
  await unlock(page);
  await page.waitForTimeout(9000);
  const out = new URL(`./screenshots/${NAME}.png`, import.meta.url).pathname;
  await page.screenshot({ path: out });
  // zoomed in: the bid × ask numbers
  const c = await page.locator('canvas').first().boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -120);
  await page.mouse.move(c.x + c.width * 0.8, c.y + 40);
  await page.waitForTimeout(800);
  await page.screenshot({ path: out.replace('.png', '-zoom.png') });
  console.log(out);
} finally {
  await browser.close();
  process.kill(-server.pid);
}

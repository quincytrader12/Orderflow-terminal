// Performance check: unlock the terminal under synthetic exchange load and
// measure how fast the panels draw and how smooth the app stays.
//
//   npm run build && node e2e/perf.mjs [simLoad=8] [seconds=10]
//
// Headless Chromium renders in software, so these numbers are a pessimistic
// bound for a laptop with a GPU.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { seedWebLedger, TEST_KEY } from './unlock.mjs';

const LOAD = Number(process.argv[2] ?? 8);
const SECONDS = Number(process.argv[3] ?? 10);
const PORT = 5195;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore', detached: true });
await new Promise((r) => setTimeout(r, 3000));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let ok = true;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1.5 });
  await seedWebLedger(ctx);
  await ctx.addInitScript(() => {
    const w = window;
    w.__long = { n: 0, ms: 0, max: 0 };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        w.__long.n++;
        w.__long.ms += e.duration;
        w.__long.max = Math.max(w.__long.max, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
    w.__raf = 0;
    const loop = () => {
      w.__raf++;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/?venue=sim&agg=sim&history=exchange&simLoad=${LOAD}`);
  await page.waitForSelector('.lock-key input');
  // a user typically unlocks within a few seconds of the lock screen appearing
  await page.waitForTimeout(3000);
  const before = await page.evaluate(() => ({ long: { ...window.__long }, raf: window.__raf, stats: { ...window.__canvasStats, firstFrameAt: [...window.__canvasStats.firstFrameAt] } }));
  const tUnlock = await page.evaluate(() => performance.now());
  // the terminal mounts under the lock screen as soon as the key is accepted
  await page.locator('.lock-key input').fill(TEST_KEY);
  await page.waitForSelector('.topbar');
  const tShell = (await page.evaluate(() => performance.now())) - tUnlock;
  await page.waitForTimeout(1500);
  const settle = await page.evaluate(() => ({ raf: window.__raf, frames: window.__canvasStats.frames, drawMs: window.__canvasStats.drawMs, long: { ...window.__long }, t: performance.now() }));
  await page.waitForTimeout(SECONDS * 1000);
  const after = await page.evaluate(() => ({ raf: window.__raf, frames: window.__canvasStats.frames, drawMs: window.__canvasStats.drawMs, long: { ...window.__long }, t: performance.now(), stats: window.__canvasStats }));
  const firsts = after.stats.firstFrameAt.slice(before.stats.firstFrameAt.length).map((t) => t - tUnlock).sort((a, b) => a - b);
  const span = (after.t - settle.t) / 1000;
  const result = {
    load: LOAD,
    shellMs: Math.round(tShell),
    canvases: firsts.length,
    firstPanelMs: Math.round(firsts[0] ?? NaN),
    allPanelsMs: Math.round(firsts[firsts.length - 1] ?? NaN),
    fps: +((after.raf - settle.raf) / span).toFixed(1),
    panelFramesPerSec: +((after.frames - settle.frames) / span).toFixed(0),
    drawMsPerSec: +((after.drawMs - settle.drawMs) / span).toFixed(0),
    longTasksDuringUnlock: { n: settle.long.n - before.long.n, ms: Math.round(settle.long.ms - before.long.ms) },
    longTasksSteady: { n: after.long.n - settle.long.n, ms: Math.round(after.long.ms - settle.long.ms), maxMs: Math.round(after.long.max) },
  };
  console.log(JSON.stringify(result, null, 1));
  await page.screenshot({ path: new URL(`./screenshots/perf-load${LOAD}.png`, import.meta.url).pathname });
  // budgets for a professional feel (software rendering, so generous)
  if (!(result.allPanelsMs < 1500)) (ok = false), console.log(`✗ panels took ${result.allPanelsMs} ms to draw after unlock`);
  if (!(result.fps >= 30)) (ok = false), console.log(`✗ ${result.fps} fps`);
} finally {
  await browser.close();
  process.kill(-server.pid);
}
console.log(ok ? 'Perf check passed.' : 'Perf check FAILED.');
process.exit(ok ? 0 : 1);

// End-to-end smoke test: starts Vite, opens the terminal on the simulator
// venue, loads every layout preset and panel, screenshots them and fails on
// uncaught page errors or console errors.
//
//   node e2e/smoke.mjs            (uses PLAYWRIGHT chromium or CHROMIUM_PATH)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = Number(process.env.E2E_PORT ?? 5199);
const OUT = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // undefined lets playwright-core use its own installed browser (npx playwright-core install chromium)
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((x) => x.startsWith('chromium-')).sort().reverse()) {
    for (const p of ['chrome-linux/chrome', 'chrome-linux64/chrome']) if (existsSync(join(root, d, p))) return join(root, d, p);
  }
  return undefined;
}

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
};
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('vite did not start')), 30_000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('Local')) {
      clearTimeout(t);
      resolve();
    }
  });
});

const errors = [];
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // network failures to real exchanges are expected in sandboxes without egress
    if (/WebSocket|net::ERR|Failed to load resource|fonts\.googleapis/i.test(text)) return;
    errors.push(`console: ${text}`);
  });
  const base = `http://localhost:${PORT}/?venue=sim&agg=sim&history=exchange`;
  await page.goto(base);
  await page.waitForSelector('.topbar');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}00-terminal.png` });

  const presets = await page.evaluate(async () => (await import('/src/app/layouts.ts')).PRESETS.map((p) => p.id));
  for (const id of presets) {
    await page.click('button[title="Layout gallery & saved layouts"]');
    const card = page.locator('.gallery-card').nth(presets.indexOf(id));
    await card.click();
    await page.waitForTimeout(3500);
    await page.screenshot({ path: `${OUT}preset-${id}.png` });
    console.error(`preset ${id}: ok`);
  }

  // every panel in isolation via embed mode
  const panels = await page.evaluate(async () => (await import('/src/panels/registry.tsx')).PANELS.map((p) => p.id));
  for (const id of panels) {
    await page.goto(`http://localhost:${PORT}/?embed=${id}&venue=sim&agg=sim&history=exchange`);
    await page.waitForTimeout(2500);
    const crashed = await page.locator('text=crashed').count();
    if (crashed) errors.push(`panel ${id} crashed`);
    await page.screenshot({ path: `${OUT}panel-${id}.png` });
    console.error(`panel ${id}: ${crashed ? "CRASHED" : "ok"}`);
  }

  // interaction: footprint styles + zoom
  await page.goto(`http://localhost:${PORT}/?embed=footprint&venue=sim&agg=sim&style=delta&ovHeatmap=true&interval=15s`);
  await page.waitForTimeout(4000);
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}footprint-delta-heatmap.png` });

  // every theme, every filter, and the settings modal
  for (const theme of ['grey', 'white', 'black', 'neon-green', 'neon-orange']) {
    await page.goto(`${base}&theme=${theme}&filter=none`);
    await page.waitForTimeout(3000);
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    if (applied !== theme) errors.push(`theme ${theme} not applied (got ${applied})`);
    await page.screenshot({ path: `${OUT}theme-${theme}.png` });
    console.error(`theme ${theme}: ok`);
  }
  for (const filter of ['vivid', 'soft', 'mono', 'warm', 'cool', 'night', 'crt']) {
    await page.goto(`${base}&theme=grey&filter=${filter}`);
    await page.waitForTimeout(1500);
    const f = await page.evaluate(() => getComputedStyle(document.querySelector('.app')).filter);
    if (f === 'none') errors.push(`filter ${filter} not applied`);
    await page.screenshot({ path: `${OUT}filter-${filter}.png` });
  }
  await page.goto(`${base}&theme=grey&filter=none`);
  await page.waitForTimeout(1500);
  await page.click('button[title="Settings"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}settings-appearance.png` });
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  stopServer();
}

if (errors.length) {
  console.error(`\n${errors.length} error(s):\n` + [...new Set(errors)].join('\n'));
  process.exit(1);
}
if (failed) process.exit(1);
console.log(`\nSmoke test passed. Screenshots in ${OUT}`);
process.exit(0);

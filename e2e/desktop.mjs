// Desktop e2e: launches the real Electron app (built renderer + bundled main)
// and drives it: chart-centred layout, key vault through the UI, database
// recording, CCXT bridge, wallet panel, layout lock/focus. Afterwards it
// inspects the SQLite file to confirm keys are only stored encrypted.
//
//   npm run build && npm run build:main && xvfb-run -a node e2e/desktop.mjs
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { seedDesktopLedger, TEST_KEY, unlock } from './unlock.mjs';

const require = createRequire(import.meta.url);
const OUT = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const userData = mkdtempSync(join(tmpdir(), 'novus-e2e-'));
const SECRET = 'e2e-secret-ABCDEF-1234567890';
const errors = [];
const step = (m) => console.error(`• ${m}`);
let ok = true;
const expect = (cond, msg) => {
  if (!cond) {
    ok = false;
    console.error(`  ✗ ${msg}`);
  } else console.error(`  ✓ ${msg}`);
};

// a throwaway ledger key for this run (the owner's key is never used in tests)
await seedDesktopLedger(userData);
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox'],
  env: { ...process.env, NOVUS_USER_DATA: userData },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1600, height: 950 }).catch(() => undefined);
  step('secure boot: lock screen, sealed vault, ledger key');
  await page.waitForSelector('.lock-key input', { timeout: 30_000 });
  const lockText = await page.locator('.lock').innerText();
  expect(/WELCOME TO NOVUS ORDO/.test(lockText) && /Quincy Gininda/.test(lockText) && /ENTER LEDGER KEY/.test(lockText), 'emblem screen shows welcome, author and ENTER LEDGER KEY');
  expect(await page.locator('.lock-emblem img').evaluate((img) => img.complete && img.naturalWidth > 500), 'emblem image loaded');
  await page.waitForFunction(() => document.querySelectorAll('.lock-loader li').length >= 3, null, { timeout: 20_000 });
  expect(true, 'loader lists assets as they load');
  const sealed = await page.evaluate(() => window.novus.vault.list().then(() => 'open', (e) => e.message));
  expect(/sealed/.test(sealed), `vault sealed in the desktop process before unlock (${sealed})`);
  const early = Number((await page.locator('.boot-ring .ring-btn').getAttribute('aria-valuenow')) ?? 0);
  await page.waitForFunction(() => /ALL SYSTEMS READY/.test(document.querySelector('.lock-loader')?.textContent ?? ''), null, { timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('.boot-ring .ring-btn')?.getAttribute('aria-valuenow') === '100', null, { timeout: 10_000 });
  expect(early < 100, `boot ring climbs from ${early}% to 100%`);
  await page.hover('.boot-ring .ring-btn');
  await page.waitForSelector('.ring-pop');
  expect((await page.locator('.ring-pop .ring-phase').count()) === 3, 'ring breakdown shows the three phases');
  await page.screenshot({ path: `${OUT}desktop-lock-screen-ring.png` });
  await page.mouse.move(800, 400);
  await page.waitForSelector('.ring-pop', { state: 'detached' });
  await page.screenshot({ path: `${OUT}desktop-lock-screen.png` });
  await page.locator('.lock-key input').fill('12345678');
  await page.waitForSelector('.lock-key.denied');
  expect((await page.locator('.lock-msg').innerText()).includes('ACCESS DENIED'), 'wrong key denied');
  await unlock(page);
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  expect(await page.evaluate(() => window.novus.vault.list().then(() => true, () => false)), 'vault opens after the ledger key');

  step('desktop bridge and database');
  const info = await page.evaluate(() => window.novus.app.info());
  expect(info.db.file.startsWith(userData), `database lives in user data (${info.db.file})`);
  expect(['os', 'local'].includes(info.vaultBackend), `vault backend: ${info.vaultBackend}`);
  expect((await app.evaluate(({ app }) => app.getName())).length > 0, 'electron app name');

  step('chart-centred default layout');
  const tabs = await page.$$eval('.flexlayout__tab_button_content', (els) => els.map((e) => e.textContent));
  expect(tabs.includes('Footprint Chart') && tabs.includes('DOM Ladder') && tabs.includes('Phantom Wallet'), 'default layout has chart, DOM and wallet');

  step('switch primary to simulator for live data');
  await page.selectOption('select[title="Primary venue"]', 'sim');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}desktop-chart-center.png` });

  step('CCXT bridge');
  const exchanges = await page.evaluate(() => window.novus.ccxt.exchanges());
  expect(exchanges.length >= 100, `${exchanges.length} CCXT exchanges listed`);
  expect(exchanges.some((e) => e.id === 'binance' && e.pro), 'binance has a websocket (pro) client');
  await page.selectOption('select[title="Primary venue"]', 'ccxt');
  await page.waitForTimeout(4000);
  const ccxtState = await page.evaluate(() => document.querySelector('.topbar .status-dot')?.className);
  expect(Boolean(ccxtState), `CCXT feed reports status (${ccxtState}) without crashing`);
  await page.screenshot({ path: `${OUT}desktop-ccxt.png` });
  await page.selectOption('select[title="Primary venue"]', 'sim');

  step('key vault through the UI');
  await page.click('button[title^="Connections"]');
  expect((await page.locator('.quick-tile').count()) >= 10, 'quick-connect tiles for exchanges and Telegram');
  await page.screenshot({ path: `${OUT}desktop-connections.png` });
  await page.click('.quick-tile[title="Connect Binance"]');
  expect(/API Management/.test(await page.locator('.key-guide').innerText()), 'Binance key guide shown');
  const exInput = page.locator('input[list="ccxt-exchanges"]');
  await exInput.fill('binance');
  await exInput.blur();
  await page.locator('.vault-form input.ctl').nth(1).fill('Main (read-only)');
  const secrets = page.locator('.vault-form input[type="password"]');
  await secrets.nth(0).fill('AKIAEXAMPLEKEY000111');
  await secrets.nth(1).fill(SECRET);
  await page.click('text=Save encrypted');
  await page.waitForSelector('.vault-row');
  const rowText = await page.locator('.vault-row').first().innerText();
  expect(rowText.includes('Main (read-only)') && rowText.includes('binance'), 'saved key listed');
  expect(!rowText.includes(SECRET), 'secret not shown in the UI');
  const listed = await page.evaluate(() => window.novus.vault.list());
  expect(!JSON.stringify(listed).includes(SECRET), 'secret not returned to the renderer');
  expect((await page.locator('.quick-next button:has-text("Open Accounts")').count()) === 1, 'offers the Accounts panel after saving');
  expect(/read-only/.test(await page.locator('.quick-tile[title^="Edit Main"]').innerText()), 'Binance tile shows the saved key');
  await page.screenshot({ path: `${OUT}desktop-keys.png` });
  await page.click('.modal header .x');

  step('order ticket: read-only key is refused in the main process');
  const keyId = listed[0].id;
  const order = { symbol: 'BTC/USDT', side: 'buy', type: 'limit', sizeMode: 'quote', size: 20, price: 50000 };
  const refused = await page.evaluate((a) => window.novus.trade.place(a.id, a.order).then(() => 'placed', (e) => e.message), { id: keyId, order });
  expect(/Trading is off/.test(refused), `order refused while trading is off (${refused})`);
  const limits = await page.evaluate(() => window.novus.trade.setLimits({ maxOrderUsd: 250 }));
  expect(limits.maxOrderUsd === 250 && limits.maxOrdersPerMinute === 10, 'limits stored');
  await page.click('.flexlayout__tab_button_content:text-is("Order Ticket")');
  await page.waitForSelector('.ticket .side-toggle');
  const submit = page.locator('.ticket .btn.submit');
  expect(await submit.isDisabled(), 'submit disabled until a market, key and size are ready');
  // click a DOM level → price lands in the ticket
  const dom = page.locator('.flexlayout__tab:visible:has(button:text("centre")) canvas').first();
  const box = await dom.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.6);
  await page.waitForTimeout(300);
  const ticketPrice = await page.locator('.ticket input[placeholder="click a DOM level"]').inputValue();
  expect(Number(ticketPrice) > 0, `DOM click priced the ticket (${ticketPrice})`);
  const ticketText = await page.locator('.ticket').innerText();
  expect(/Buy/.test(ticketText) && /Sell/.test(ticketText) && /Stop limit/.test(ticketText), 'ticket shows sides and order types');
  await page.screenshot({ path: `${OUT}desktop-ticket.png` });

  step('allow trading on the key through the UI');
  await page.click('button[title^="Connections"]');
  await page.click('.vault-row button:text-is("Edit")');
  await page.check('.trade-switch input[type="checkbox"]');
  await page.click('text=Save encrypted');
  await page.waitForSelector('.vault-row .tag-live');
  const after = await page.evaluate((a) => window.novus.trade.place(a.id, a.order).then(() => 'placed', (e) => e.message), { id: keyId, order });
  expect(!/Trading is off/.test(after), `trading switch honoured; offline exchange error instead (${after.slice(0, 80)})`);
  await page.click('.modal header .x');
  const log = await page.evaluate(() => window.novus.trade.log(10));
  expect(log.length >= 2 && log.every((r) => r.action === 'place') && log[log.length - 1].status === 'rejected', `${log.length} order attempts audited`);
  expect(!JSON.stringify(log).includes(SECRET), 'order log holds no secrets');
  await page.waitForSelector('.ticket .log-row', { timeout: 15_000 });
  expect((await page.locator('.ticket .log-row').count()) >= 2, 'ticket shows the order log');
  await page.screenshot({ path: `${OUT}desktop-ticket-log.png` });

  step('database recording and panel');
  const n = await page.evaluate(() =>
    window.novus.db.record('binancef', 'BTCUSDT', Array.from({ length: 500 }, (_, i) => ({ p: 100000 + i, q: 0.01, s: i % 2 ? 'buy' : 'sell', t: Date.now() - (500 - i) * 1000 }))),
  );
  expect(n === 500, 'recorded 500 trades');
  const q = await page.evaluate(() => window.novus.db.query('binancef', 'BTCUSDT', 0, Date.now()));
  expect(q.length === 500 && q[0].price === 100000, 'queried them back');
  await page.click('.flexlayout__tab_button_content:text-is("Database")');
  await page.waitForTimeout(1500);
  const dbText = await page.locator('.flexlayout__tab:visible').filter({ hasText: 'Record trades' }).innerText();
  expect(dbText.includes('BTCUSDT'), 'database panel lists the instrument');

  step('wallet panel (watch-only; Phantom itself needs the browser extension)');
  await page.click('.flexlayout__tab_button_content:text-is("Phantom Wallet")');
  await page.waitForSelector('text=Connect Phantom');
  await page.fill('input[placeholder="…or watch any address"]', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
  await page.click('button:text-is("Watch")');
  await page.waitForTimeout(3000);
  const walletText = await page.locator('.flexlayout__tab:visible').filter({ hasText: 'Connect Phantom' }).innerText();
  expect(walletText.includes('vine'), 'watched address shown');
  await page.screenshot({ path: `${OUT}desktop-wallet-db.png` });

  step('new panels placed anywhere: Yahoo Finance (right column) and Telegram (bottom dock)');
  for (const [where, panel] of [
    ['New column — right', 'Yahoo Finance'],
    ['Bottom dock (collapsible)', 'Telegram Bot'],
  ]) {
    await page.click('button[title="Add a panel"]');
    await page.click(`.modal .chip:text-is("${where}")`);
    await page.click(`.panel-item:has(b:text-is("${panel}"))`);
    await page.waitForTimeout(1500);
  }
  expect((await page.locator('text=Detect chat').count()) === 1, 'Telegram setup steps rendered');
  expect((await page.locator('input[placeholder^="Search stocks"]').count()) === 1, 'Yahoo Finance search rendered');
  await page.screenshot({ path: `${OUT}desktop-yahoo-telegram.png` });

  step('Telegram reports: schedule and preview the daily report with its chart');
  expect((await page.locator('.report-when input[type="time"]').inputValue()) === '16:00', 'daily report scheduled for 16:00 local time');
  await page.click('button:text-is("Preview daily")');
  await page.waitForSelector('.report-preview', { timeout: 30_000 });
  const rep = await page.locator('.report-text').innerText();
  expect(/Daily report/.test(rep) && /Auction \(value\)/.test(rep) && /AMT bots/.test(rep) && /Alerts/.test(rep), 'daily report has its sections');
  expect(/VAH .* POC .* VAL/.test(rep), 'report includes value area levels');
  const imgs = await page.locator('.report-preview img').count();
  expect(imgs >= 1, `${imgs} chart image(s) rendered`);
  const imgSrc = await page.locator('.report-preview img').first().evaluate(async (img) => {
    await img.decode();
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  expect(imgSrc.w === 2560 && imgSrc.h === 1440, `chart is ${imgSrc.w}×${imgSrc.h}`);
  const chartB64 = await page.locator('.report-preview img').first().evaluate(async (img) => {
    const buf = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
    let s = '';
    for (const b of buf) s += String.fromCharCode(b);
    return btoa(s);
  });
  writeFileSync(`${OUT}report-daily-chart.png`, Buffer.from(chartB64, 'base64'));
  writeFileSync(`${OUT}report-daily.txt`, rep);
  await page.click('button:text-is("Preview weekly")');
  await page.waitForFunction(() => /Weekly overview/.test(document.querySelector('.report-text')?.textContent ?? ''), null, { timeout: 30_000 });
  expect(true, 'weekly overview preview built');

  step('AMT scalper: create, backtest on recorded trades, switch on/off, kill switch');
  page.on('dialog', (d) => void d.accept());
  const recorded = await page.evaluate(() => {
    // 40 min balance around 100, then an accepted breakout and a rally
    let s = 3;
    const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const t0 = Date.now() - 2 * 3_600_000;
    const out = [];
    for (let t = t0; t < t0 + 40 * 60_000; t += 500) out.push({ t, p: Number((100 + (r() + r() - 1) * 0.5).toFixed(2)), q: 0.1 + r() * 0.2, s: r() < 0.5 ? 'buy' : 'sell' });
    let t = t0 + 40 * 60_000;
    for (let i = 0; i < 540; i++, t += 1000 / 6) out.push({ t, p: Number((100.3 + 0.2 * (i / 540)).toFixed(2)), q: 0.8, s: 'buy' });
    for (let i = 0; i < 240; i++, t += 500) out.push({ t, p: Number((100.5 + 0.8 * (i / 240)).toFixed(2)), q: 0.3, s: 'buy' });
    return window.novus.db.record('binancef', 'AMTTEST', out);
  });
  expect(recorded > 5000, `recorded ${recorded} synthetic trades for the backtest`);
  await page.click('button[title="Add a panel"]');
  await page.click('.modal .chip:text-is("New column — right")');
  await page.click('.panel-item:has(b:text-is("AMT Bots"))');
  await page.waitForSelector('.amt-intro');
  await page.click('.amt-intro button:text-is("Create a bot")');
  await page.waitForSelector('.amt-settings');
  expect((await page.locator('.amt-settings input[type="number"]').count()) >= 25, 'all AMT parameters editable');
  await page.click('.amt-settings .seg button:text-is("Intraday")');
  await page.waitForSelector('.amt-settings :text("Initial-balance extension")');
  expect((await page.locator('.amt-settings input[type="number"]').count()) >= 35, 'intraday style shows its session parameters');
  await page.click('.amt-settings button:text-is("Save")');
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => window.novus.amt.list());
  expect(saved[0].params.style === 'intraday' && saved[0].params.maxHoldSec === 28_800, 'intraday bot saved with its preset');
  await page.screenshot({ path: `${OUT}desktop-amt-intraday-settings.png` });
  // back to scalp for the breakout backtest below
  await page.click('.amt-settings .seg button:text-is("Scalp")');
  await page.click('.amt-settings button:text-is("Save")');
  await page.click('.amt .toolbar button:text-is("Backtest")');
  await page.selectOption('.amt-backtest select', 'binancef|AMTTEST');
  await page.click('.amt-backtest button:text-is("Run backtest")');
  await page.waitForSelector('.amt-backtest .amt-cards', { timeout: 30_000 });
  const bt = await page.locator('.amt-backtest').innerText();
  expect(/Trades\s*[1-9]/.test(bt) && /breakout/.test(bt), 'backtest found the breakout trade');
  await page.screenshot({ path: `${OUT}desktop-amt-backtest.png` });
  await page.click('.amt .toolbar button:text-is("Monitor")');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch.on');
  await page.waitForSelector('.chip.algo-kill', { timeout: 5000 });
  expect((await page.locator('.amt-ev.ev-started').count()) === 1, 'bot started (paper)');
  await page.screenshot({ path: `${OUT}desktop-amt-monitor.png` });
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch:not(.on)');
  expect((await page.locator('.chip.algo-kill').count()) === 0, 'switched off from the panel');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.chip.algo-kill', { timeout: 5000 });
  await page.click('.chip.algo-kill');
  await page.waitForSelector('.amt .algo-switch:not(.on)');
  const bots = await page.evaluate(() => window.novus.amt.list());
  expect(bots.length === 1 && !bots[0].running, 'top-bar kill switch stopped the bot');

  step('layout edit mode and focus');
  await page.click('button[title^="Edit layout"]');
  await page.waitForSelector('.edit-bar');
  expect((await page.locator('.app.editing').count()) === 1, 'edit mode on');
  await page.screenshot({ path: `${OUT}desktop-edit-layout.png` });
  await page.click('.edit-bar button:text-is("Done")');
  expect((await page.locator('.edit-bar').count()) === 0, 'edit mode off');
  await page.click('button[title^="Maximise the main chart"]');
  await page.waitForTimeout(800);
  expect((await page.locator('.flexlayout__tabset-maximized').count()) === 1, 'chart maximised');
  await page.screenshot({ path: `${OUT}desktop-focus.png` });
  await page.click('button[title^="Maximise the main chart"]');

  step('ledger key: change it, seal, old key denied, new key opens');
  const NEW_KEY = '73914062';
  await page.click('button[title="Settings"]');
  const keyInputs = page.locator('.ledger-settings input');
  await keyInputs.nth(0).fill(TEST_KEY);
  await keyInputs.nth(1).fill(NEW_KEY);
  await keyInputs.nth(2).fill(NEW_KEY);
  await page.click('.ledger-settings button:text-is("Change key")');
  await page.waitForSelector('.ledger-settings .up');
  expect(true, 'ledger key changed');
  await page.click('.modal header .x');
  await page.click('button.chip.seal');
  await page.waitForSelector('.lock-key input', { timeout: 30_000 });
  const resealed = await page.evaluate(() => window.novus.vault.list().then(() => 'open', (e) => e.message));
  expect(/sealed/.test(resealed), 'seal re-locks the desktop process');
  await page.locator('.lock-key input').fill(TEST_KEY);
  await page.waitForSelector('.lock-key.denied');
  expect(true, 'old key denied after the change');
  await unlock(page, NEW_KEY);
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  expect(true, 'new key opens the terminal');

  expect((await page.locator('text=crashed').count()) === 0, 'no panel crashed');
} catch (e) {
  ok = false;
  console.error(e);
} finally {
  await app.close();
}

step('vault ciphertext on disk');
const dbFile = readFileSync(join(userData, 'novus-ordo.sqlite'));
let wal = Buffer.alloc(0);
try {
  wal = readFileSync(join(userData, 'novus-ordo.sqlite-wal'));
} catch {
  /* checkpointed */
}
expect(!dbFile.includes(Buffer.from(SECRET)) && !wal.includes(Buffer.from(SECRET)), 'secret absent from database files');
rmSync(userData, { recursive: true, force: true });

if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'));
  ok = false;
}
console.log(ok ? 'Desktop e2e passed.' : 'Desktop e2e FAILED.');
process.exit(ok ? 0 : 1);

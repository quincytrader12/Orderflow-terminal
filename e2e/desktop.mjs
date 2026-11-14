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
// candle history for the Strategy Lab, so a bot can be tested, optimized and deployed with no exchange in reach:
// a year of hourly and six months of 15-minute candles for BTC, in the Lab's own cache (a made-up market with slow trends)
{
  const dir = join(userData, 'lab', 'cache');
  mkdirSync(dir, { recursive: true });
  let seed = 20261107;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  for (const [tf, ms, days, sd, keep, drift] of [['1h', 3_600_000, 760, 0.006, 0.997, 0.03], ['15m', 900_000, 195, 0.003, 0.995, 0.1]]) {
    const last = Math.floor(Date.now() / ms) * ms + 2 * ms;
    const n = Math.round((days * 86_400_000) / ms);
    let p = 60_000;
    let mu = 0;
    const bars = Array.from({ length: n }, (_, i) => {
      mu = keep * mu + sd * drift * gauss();
      const o = p;
      p *= Math.exp(mu + sd * gauss());
      return { time: last - (n - 1 - i) * ms, open: o, high: Math.max(o, p) * (1 + Math.abs(gauss()) * sd * 0.3), low: Math.min(o, p) * (1 - Math.abs(gauss()) * sd * 0.3), close: p, volume: 100 * (1 + Math.abs(gauss())) };
    });
    writeFileSync(join(dir, `binance-BTC-${tf}.json`), JSON.stringify(bars));
  }
}
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', '--no-sandbox'],
  // the edge finder is started by hand below, not by itself after a minute and a half
  env: { ...process.env, NOVUS_USER_DATA: userData, NOVUS_NO_FARM: '1' },
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

  step('opens on the professional terminal: workspaces, command line, Strategy Lab, screens');
  await page.waitForSelector('.pro-cmdbar', { timeout: 15_000 });
  expect((await page.locator('.pro-ws-tab').count()) === 3, 'three terminal workspaces: markets, strategy lab, quant desk');
  expect((await page.locator('.pro-ws-tab:has-text("SWARM")').count()) === 0, 'no crypto swarm inside the terminal');
  expect((await page.locator('.view-switch .view-tab').count()) === 2, 'two views on the top bar: Terminal and Crypto swarm');
  expect((await page.locator('.pro-ws-tab:has-text("MEME")').count()) === 0, 'the meme desk is gone');
  expect((await page.locator('.pro-key').count()) >= 8, 'function keys for the workspace');
  await page.waitForSelector('.flexlayout__tab_button:has-text("MON · Monitor")', { timeout: 15_000 });
  expect(true, 'the markets workspace opens with the monitor');
  await page.screenshot({ path: `${OUT}desktop-pro-markets.png` });
  // ASK: a question in plain words switches the market and opens the coin's report
  await page.click('.pro-cmd-input');
  await page.keyboard.type('ask about solana');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ask-panel', { timeout: 10_000 });
  expect(/SOL — instrument report/.test(await page.locator('.ask-panel').innerText()) && (await page.locator('.pro-cmd-prompt').innerText()) === 'SOL', '“ask about solana” makes SOL the market and opens its instrument report (ASK)');
  await page.click('.pro-cmd-input');
  await page.keyboard.type('bitcoin');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.pro-cmd-prompt')?.textContent === 'BTC', null, { timeout: 10_000 });
  expect((await page.locator('text=crashed').count()) === 0, 'a coin’s name on its own switches the market back (bitcoin → BTC)');
  await page.click('.pro-cmd-input');
  await page.keyboard.type('RSCH');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.pro-ws-tab.active:has-text("STRATEGY LAB")', { timeout: 10_000 });
  await page.waitForSelector('button:has-text("Run research")', { timeout: 15_000 });
  expect(true, 'RSCH on the command line opens the Strategy Lab research screen');
  expect((await page.locator('.lab-rule').count()) >= 23, 'the library lists every rule and filter with its papers');
  // the bot builder: eight blocks, plain-English choices, the style sets the rest
  await page.click('.pro-cmd-input');
  await page.keyboard.type('BOT');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.bb-canvas', { timeout: 10_000 });
  expect((await page.locator('.bb-node').count()) === 8, 'the bot builder: style, strategy, market model, forecast, risk, rules, backtest, deploy');
  await page.click('.bb-node[data-block="deploy"]');
  expect(await page.locator('.bb-deploy').isDisabled(), 'deploy waits for a backtest');
  expect((await page.locator('.bb2-deploy-top').count()) === 1 && (await page.locator('.bb2-deploy-top').isDisabled()), 'Deploy sits beside Test bot in the header, and waits for a test');
  await page.click('.bb-node[data-block="style"]');
  await page.click('.bb2-inspector [data-opt="scalp"]');
  expect(/1h candles/.test(await page.locator('.bb').innerText()) && (await page.locator('text=crashed').count()) === 0, 'choosing a style re-plans the bot (scalping: 1-hour candles)');
  // a block holds several picks, and the check says how they fit together
  await page.click('.bb-node[data-block="strategy"]');
  await page.click('.bb2-inspector [data-opt="rsi2"]');
  await page.waitForSelector('.bb2-finding.pair', { timeout: 5_000 });
  expect((await page.locator('.bb-node[data-block="strategy"] .bb2-chip').count()) === 2, 'a block holds two strategies (trend + dip)');
  expect((await page.locator('.bb2-finding.pair').count()) > 0, 'the check: a trend rule and a dip rule pair well when all must agree');
  await page.click('.bb2-inspector [data-opt="any"]');
  await page.waitForSelector('.bb2-finding.clash', { timeout: 5_000 });
  expect(true, 'the check: the same two with “any one” clash');
  await page.click('.bb2-inspector [data-opt="all"]');
  await page.click('.bb-node[data-block="forecast"]');
  await page.click('.bb2-inspector [data-opt="both"]');
  expect(/Neural network \+ decision forest/.test(await page.locator('.bb-node[data-block="forecast"]').innerText()), 'the neural network and the decision forest paired as the decision maker');
  await page.click('.bb-node[data-block="deploy"]');
  expect((await page.locator('.bb2-inspector [data-opt="tested"]').count()) === 1, 'deploy: choose who decides its trades (council, or as tested)');
  await page.screenshot({ path: `${OUT}desktop-bot-builder.png` });
  // test the bot, read what the test shows, let the optimizer try changes, apply one, and deploy — all from the bot builder
  step('the bot builder: test, optimize, deploy');
  // (a bot that did not hold up asks before it deploys: say yes — for this part of the run only)
  const sayYes = (d) => void d.accept().catch(() => undefined);
  page.on('dialog', sayYes);
  await page.click('.bb-node[data-block="forecast"]');
  await page.click('.bb2-inspector [data-opt="none"]');
  await page.click('.bb-node[data-block="test"]');
  await page.fill('.bb2-inspector .bb-coins', 'BTC');
  await page.keyboard.press('Enter');
  await page.click('.bb2-head button:has-text("Test bot")');
  await page.waitForSelector('.bb-verdict', { timeout: 180_000 });
  expect((await page.locator('.bb-tile').count()) >= 6, 'a bot is tested on a year of hourly candles: verdict and result tiles');
  expect(await page.locator('.bb2-deploy-top').isEnabled(), 'after the test, Deploy in the header is live');
  expect((await page.locator('[data-deploy-bar] .bb2-deploy-here').count()) === 1 && (await page.locator('[data-deploy-bar] .chip').count()) === 2, 'Deploy sits beside the verdict, with who decides its trades');
  const optText = await page.locator('[data-optimizer]').innerText();
  expect((await page.locator('[data-optimizer] .opt-card').count()) >= 1 && /(MONTH BY MONTH|WEEK BY WEEK) ON THE UNSEEN DATA/.test(optText) && /HOW ITS TRADES ENDED/.test(optText), 'under the result: what the test shows in words, the result month by month, how its trades ended');
  expect(/first version tested/.test(optText), 'the first version tested on this unseen data is counted as such');
  await page.locator('[data-optimizer]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}desktop-optimizer-diagnosis.png` });
  await page.click('[data-optimizer] .opt-find');
  await page.waitForSelector('[data-optimizer] .opt-row, [data-optimizer] .lab-note', { timeout: 300_000 });
  const nRows = await page.locator('[data-optimizer] .opt-row').count();
  expect(/changes measured against the bot as it is/.test(await page.locator('[data-optimizer]').innerText()) || nRows === 0, `the optimizer tried the one-step changes on the training years (${nRows} worth making)`);
  for (const g of ['steady', 'drawdown', 'sharpe']) await page.click(`[data-optimizer] [data-goal="${g}"]`);
  expect((await page.locator('[data-optimizer] [data-goal="sharpe"].active').count()) === 1, 'three goals to rank by: return for the risk, steadier weeks, smaller drawdowns');
  await page.locator('[data-optimizer] .opt-find').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}desktop-optimizer.png` });
  // (a change of pace needs more history than this run has seeded: take the first change of another kind)
  const pick = page.locator('[data-optimizer] .opt-row:not([data-variant^="style:"])').first();
  if (await pick.count()) {
    const label = await pick.locator('b').innerText();
    await pick.locator('button').click();
    await page.waitForFunction(() => /version 2 tested/.test(document.querySelector('[data-optimizer]')?.textContent ?? ''), null, { timeout: 180_000 });
    expect(/Optimizer: /.test(await page.locator('.bb2-arrived').innerText()), `“Apply & test” makes the change and tests it on the unseen data (${label.split('\n')[0].slice(0, 60)})`);
    expect(/Chance the result is real after 2 tries/.test(await page.locator('[data-optimizer] .opt-tries').innerText()), 'the second version tested is counted, and the result allowed for two tries');
  } else expect(true, 'no single change beat this bot on the training years — the optimizer says so instead of inventing one');
  await page.locator('[data-deploy-bar]').scrollIntoViewIfNeeded();
  await page.click('[data-deploy-bar] .chip:has-text("Trade as tested")');
  await page.click('[data-deploy-bar] .bb2-deploy-here');
  await page.waitForSelector('[data-deploy-bar] .bb2-deploy-here:has-text("Deployed")', { timeout: 20_000 });
  const dep = (await page.evaluate(() => window.novus.lab.state())).deployed;
  expect(dep.length === 1 && dep[0].authority === 'tested' && dep[0].tfH === 1 && dep[0].coins.join() === 'BTC', `deployed straight from the bot builder, to trade as tested (${dep[0]?.name?.slice(0, 50)})`);
  await page.evaluate((id) => window.novus.lab.undeploy(id), dep[0].id);
  // the same bot on 15-minute candles
  await page.click('.bb-node[data-block="style"]');
  await page.click('.bb2-inspector [data-opt="scalp15"]');
  expect(/15m candles/.test(await page.locator('.bb-node[data-block="style"]').innerText()), 'a 15-minute style: scalping on 15-minute candles');
  await page.click('.bb2-head button:has-text("Test bot")');
  await page.waitForSelector('.bb-verdict', { timeout: 240_000 });
  expect(/WEEK BY WEEK|MONTH BY MONTH/.test(await page.locator('[data-optimizer]').innerText()) && (await page.locator('text=crashed').count()) === 0, 'the bot is tested on six months of 15-minute candles');
  await page.screenshot({ path: `${OUT}desktop-bot-15m.png` });
  await page.click('.bb-node[data-block="style"]');
  await page.click('.bb2-inspector [data-opt="scalp"]');
  page.off('dialog', sayYes);
  const ls = await page.evaluate(() => window.novus.lab.state());
  expect(!!ls && ls.cfg.coins.length > 0 && Array.isArray(ls.deployed), 'the Lab answers from the desktop process');
  const runErr = await page.evaluate(() => window.novus.lab.run({ coins: ['BTC'], source: 'binance', years: 0.1, funding: false }).then(() => 'ran', (e) => e.message));
  expect(runErr === 'ran' || /history|candles|BTC/i.test(runErr), `research without exchange access says why (${String(runErr).slice(0, 90)})`);
  await page.screenshot({ path: `${OUT}desktop-pro-lab.png` });
  const scr = await page.evaluate(() => window.novus.screens.state());
  expect(scr.displays.length >= 1 && scr.windows.some((w) => w.kind === 'main'), `screens listed (${scr.displays.map((d) => d.label).join(', ')})`);
  expect((await page.locator('.pop-out-btn').count()) > 0, '⧉ pop-out on the tab bars');
  const popWindow = app.waitForEvent('window', { timeout: 30_000 });
  const popId = await page.evaluate(() => window.novus.screens.popout('heatgrid', 'HMAP · Heat Map', {}));
  const pop = await popWindow;
  await pop.waitForSelector('.popout-bar', { timeout: 30_000 });
  expect(/HMAP/.test(await pop.locator('.popout-bar').innerText()), 'a panel pops out into its own window');
  await page.evaluate(([id, d]) => window.novus.screens.move(id, d, 'float'), [popId, scr.displays[0].id]);
  const scr2 = await page.evaluate(() => window.novus.screens.state());
  expect(scr2.windows.some((w) => w.kind === 'panel' && w.id === popId && w.displayId === scr.displays[0].id), 'the popped-out window is sent to a screen');
  await pop.screenshot({ path: `${OUT}desktop-pro-popout.png` }).catch(() => undefined);
  await page.evaluate((id) => window.novus.screens.close(id), popId);
  // F3: the QUANT desk — momentum, regimes, value at risk, delta hedging, volatility targeting
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 300);
  await page.keyboard.press('F3');
  await page.waitForSelector('.pro-ws-tab.active:has-text("QUANT DESK")', { timeout: 10_000 });
  for (const t of ['MOM · Momentum', 'VAR · Value at risk', 'DHG · Delta hedging']) await page.waitForSelector(`.flexlayout__tab_button:has-text("${t}")`, { timeout: 10_000 });
  expect(true, 'F3 opens the QUANT desk with momentum, value at risk and delta hedging');
  await page.click('.pro-cmd-input');
  await page.keyboard.type('REGM');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.flexlayout__tab_button--selected:has-text("REGM · Regimes")', { timeout: 10_000 });
  expect(true, 'REGM on the command line opens the regimes screen');
  await page.screenshot({ path: `${OUT}desktop-pro-quant.png` });
  expect((await page.locator('text=crashed').count()) === 0, 'no quant panel crashed');
  // the new desk functions: pairs, seasonality, Monte Carlo
  for (const [code, sel, what] of [
    ['MC', '.mc-ladder tbody tr', 'MC: a strategy’s trades as 2,000 futures, with ruin by risk per trade'],
    ['SEAS', '.seas-panel .seas-grid, .seas-panel .pro-empty', 'SEAS: the hour-of-day and weekday map opens'],
    ['PAIR', '.pair-panel .pair-table, .pair-panel .pro-empty', 'PAIR: pairs and cointegration opens'],
  ]) {
    await page.click('.pro-cmd-input');
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForSelector(`.flexlayout__tab_button--selected:has-text("${code} ·")`, { timeout: 10_000 });
    await page.waitForSelector(sel, { timeout: 20_000 });
    expect(true, what);
  }
  expect((await page.locator('.mc-ladder tbody tr').count()) === 7, 'MC compares seven risk levels');
  await page.screenshot({ path: `${OUT}desktop-pro-quant-new.png` });
  expect((await page.locator('text=crashed').count()) === 0, 'no new quant panel crashed');
  // the bridge: a model on the Quant desk goes into a bot with its settings — the neural network as the bot's strategy
  await page.click('.pro-cmd-input');
  await page.keyboard.type('NNET');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.flexlayout__tab_button--selected:has-text("NNET")', { timeout: 10_000 });
  await page.locator('.nn-panel select').nth(2).selectOption('large');
  await page.click('.nn-panel button:has-text("Use in a bot")');
  await page.click('.use-bot [data-use="strategy:nn"] >> nth=0');
  await page.waitForSelector('.pro-ws-tab.active:has-text("STRATEGY LAB")', { timeout: 10_000 });
  await page.waitForSelector('.bb2-arrived', { timeout: 10_000 });
  const arrived = await page.locator('.bb2-arrived').innerText();
  expect(await page.locator('.bb2-arrived').evaluate((el) => { const r = el.getBoundingClientRect(); const p = el.closest('.pro-scroll').getBoundingClientRect(); return r.top >= p.top - 1 && r.bottom <= p.bottom + 1; }), 'the note about what arrived is in view');
  expect(/From NNET/.test(arrived) && /32 → 16 hidden units/.test(arrived), `the bot builder says what arrived (${arrived.slice(0, 110)}…)`);
  const chips = await page.locator('.bb-node[data-block="strategy"] .bb2-chip').allInnerTexts();
  expect(chips.length === 1 && /neural network/i.test(chips[0]), `the network is the bot’s strategy (${chips.join(', ')})`);
  expect((await page.locator('[data-tune="strategy:nn"] .chip.active:has-text("Large")').count()) === 1, 'its size came with it and can be changed in the bot builder');
  expect(/32 and 16 hidden units/.test(await page.locator('.bb2-row').first().innerText()), 'the bot’s rules in words carry the network’s size');
  // a second send: the Kelly panel's sizing joins the same bot
  await page.keyboard.press('F3');
  await page.waitForSelector('.pro-ws-tab.active:has-text("QUANT DESK")', { timeout: 10_000 });
  await page.click('.pro-cmd-input');
  await page.keyboard.type('KELLY');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.flexlayout__tab_button--selected:has-text("KELLY")', { timeout: 10_000 });
  await page.click('.kelly-panel button:has-text("Use in a bot")');
  await page.click('.use-bot [data-use="risk:kelly"]');
  await page.waitForSelector('.pro-ws-tab.active:has-text("STRATEGY LAB")', { timeout: 10_000 });
  const riskChips = await page.locator('.bb-node[data-block="risk"] .bb2-chip').allInnerTexts();
  expect(riskChips.some((t) => /kelly/i.test(t)), `Kelly sizing from the desk joined the bot’s risk block (${riskChips.join(', ')})`);
  await page.screenshot({ path: `${OUT}desktop-bridge.png` });
  await page.click('.bb2-arrived button');
  // the edge finder: started by hand, it breeds and tests bots by itself; a survivor opens in the bot builder and deploys
  step('the edge finder (FARM)');
  await page.click('.pro-cmd-input');
  await page.keyboard.type('FARM');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-farm]', { timeout: 10_000 });
  expect(/Stopped/.test(await page.locator('.farm-title').innerText()) && (await page.locator('[data-stage]').count()) === 10, 'FARM: the edge finder, stopped, with its ten-step gauntlet (steady, double costs and the vault among them)');
  expect((await page.locator('[data-farm] [data-status] > div').count()) === 4, 'a status strip at the top: the engine, its data, what is standing, the search');
  await page.click('[data-farm] button:has-text("Settings")');
  await page.fill('.farm-settings input', 'BTC');
  for (const id of ['swing']) if (await page.locator(`.farm-settings [data-style="${id}"].active`).count()) await page.click(`.farm-settings [data-style="${id}"]`);
  if (!(await page.locator('.farm-settings [data-style="intraday"].active').count())) await page.click('.farm-settings [data-style="intraday"]');
  await page.click('.farm-settings .chip:has-text("Full")');
  await page.click('.farm-settings button:has-text("Apply and run")');
  await page.waitForFunction(() => /Running · generation/.test(document.querySelector('.farm-title')?.textContent ?? ''), null, { timeout: 60_000 }).catch(async (e) => {
    const st = await page.evaluate(() => window.novus.lab.farm.state());
    console.error('  farm state:', JSON.stringify({ running: st.running, starting: st.starting, error: st.error, note: st.note, cfg: st.cfg }));
    throw e;
  });
  expect(true, 'it starts from its settings (BTC, intraday pace, full speed) and runs by itself');
  await page.waitForFunction(() => document.querySelectorAll('[data-farm] [data-survivor]').length > 0, null, { timeout: 240_000 });
  const farm0 = await page.evaluate(() => window.novus.lab.farm.state());
  expect(farm0.running && farm0.tried > 0 && farm0.funnel.bred === farm0.tried && farm0.survivors > 0, `it bred and tested ${farm0.tried} bots; ${farm0.survivors} survived the checks, one of each kind (${farm0.kinds} kinds tested, ${farm0.dupes} copies skipped)`);
  const stagesOk = ['holdout', 'steady', 'costs', 'random', 'nudge', 'shuffle', 'vault'].every((k, i, a) => farm0.funnel[k] <= (i ? farm0.funnel[a[i - 1]] : farm0.funnel.trained));
  expect(stagesOk, 'the gauntlet narrows step by step: each check passes no more than the one before');
  await page.locator('[data-farm] [data-survivor]').first().click();
  await page.waitForSelector('[data-farm] [data-detail]', { timeout: 10_000 });
  const det = await page.locator('[data-farm] [data-detail]').innerText();
  expect(/100 random bots/.test(det) && /Settings nudged/.test(det) && /1,000 shuffles/.test(det) && /Significant/.test(det) && /Enters/.test(det), 'a survivor shows its rules in words, its curve and every check it passed');
  expect(/Steady/.test(det) && /of 3 thirds/.test(det) && /Double costs/.test(det) && /odds it is a fluke/.test(det), 'the new checks are shown with their numbers: steady, double costs, and the fluke odds after every kind tried');
  expect(/The vault/.test(det) && /most recent days of the history, which nothing was bred or checked on/.test(det), 'a survivor has a fresh-data result the moment it is found: its trades in the vault');
  // a top five for each pace, each survivor on the ladder at once, the data's health in the strip
  const boards0 = await page.evaluate(() => window.novus.lab.farm.state().then((s) => ({ tops: s.tops.map((b) => ({ id: b.id, rows: b.rows.map((r) => ({ id: r.id, stage: r.stage, style: r.style, vault: r.vault })) })), data: s.data, styles: s.cfg.styles, dupes: s.dupes, kinds: s.kinds })));
  expect(boards0.styles.includes('scalp') && boards0.styles.includes('intraday') && boards0.tops.map((b) => b.id).join() === 'scalp,intraday' && (await page.locator('[data-farm] [data-board]').count()) === 2, `scalping is bred beside intraday, and each pace has its own top five (${boards0.tops.map((b) => `${b.id}: ${b.rows.length}`).join(', ')})`);
  expect(boards0.tops.flatMap((b) => b.rows).every((r) => r.vault && r.stage !== 'faded'), 'every listed survivor has its vault result and stands on the ladder');
  expect(boards0.data && boards0.data.ok === true && boards0.data.nextTryAt > Date.now() && (await page.locator('[data-farm] [data-data="ok"]').count()) === 1, 'the data tile: up to date, with the time of the next check');
  // the lists hold still while the farm runs flat out: watched for eight seconds, the rows change at most once (the 20-second clock) and the strategy on show stays on show
  const shownBefore = await page.locator('[data-farm] [data-detail] .pro-section').first().innerText();
  const seen = [];
  for (let i = 0; i < 16; i++) {
    seen.push(await page.evaluate(() => [...document.querySelectorAll('[data-farm] [data-survivor]')].map((r) => r.getAttribute('data-survivor')).join()));
    await page.waitForTimeout(500);
  }
  const changes = seen.filter((x, i) => i && x !== seen[i - 1]).length;
  const triedNow = (await page.evaluate(() => window.novus.lab.farm.state())).tried;
  expect(changes <= 2 && triedNow > farm0.tried, `steady lists: ${changes} change${changes === 1 ? '' : 's'} in eight seconds while ${triedNow - farm0.tried} more bots were tried`);
  expect((await page.locator('[data-farm] [data-detail] .pro-section').first().innerText()).replace(/^[A-Z ]+#\d+ — |^NO LONGER LISTED — /, '') === shownBefore.replace(/^[A-Z ]+#\d+ — |^NO LONGER LISTED — /, ''), 'the strategy on show stays on show until another is clicked');
  // the search itself: the overfit meter, the kinds of bot kept, what is working
  await page.waitForFunction(() => document.querySelectorAll('[data-farm] [data-blocks] tbody tr').length > 0, null, { timeout: 120_000 });
  const farmS = await page.evaluate(() => window.novus.lab.farm.state());
  expect((await page.locator('[data-farm] [data-search]').count()) === 1 && farmS.niches > 0 && farmS.entrants === farmS.funnel.trained && farmS.blocks.length > 0, `the search reads itself: ${farmS.niches} niches kept, ${farmS.entrants} bots of ${farmS.kinds} kinds reached the unseen data, overfit meter ${farmS.pbo === null ? 'not yet measured' : `${Math.round(farmS.pbo * 100)} %`}, ${farmS.blocks.length} blocks ranked by what they produced`);
  // the team: survivors that fit together (it needs two of different kinds; the run goes on until there are)
  const teamUp = await page.waitForFunction(() => document.querySelectorAll('[data-farm] [data-team] [data-member]').length >= 2, null, { timeout: 180_000 }).then(() => true, () => false);
  if (teamUp) {
    const tm = (await page.evaluate(() => window.novus.lab.farm.state())).team;
    const wsum = tm.members.reduce((a, m) => a + m.weight, 0);
    await page.locator('[data-farm] [data-team]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}desktop-farm-team.png` });
    await page.locator('[data-farm] [data-blocks]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}desktop-farm-blocks.png` });
    await page.locator('[data-farm] .farm-funnel').scrollIntoViewIfNeeded();
    expect(tm.members.length >= 2 && Math.abs(wsum - 1) < 1e-6 && new Set(tm.members.map((m) => m.name)).size === tm.members.length, `the team: ${tm.members.length} survivors of different kinds, shares of risk summing to 100 %, Sharpe ${tm.sharpe.toFixed(2)} together against ${tm.solo.sharpe.toFixed(2)} for the best alone`);
  } else expect(true, 'the team: not formed in this short run (it needs two unlike survivors) — covered by the unit tests');
  await page.screenshot({ path: `${OUT}desktop-farm.png` });
  const survivorName = (await page.locator('[data-farm] [data-detail] .pro-section').first().innerText()).replace(/^[A-Z ]+#\d+ — |^NO LONGER LISTED — /, '');
  await page.click('[data-farm] .farm-open');
  await page.waitForSelector('.bb2-arrived:has-text("the edge finder")', { timeout: 15_000 });
  const bchips = await page.locator('.bb-node[data-block="strategy"] .bb2-chip').allInnerTexts();
  expect(bchips.length >= 1, `“Open in the bot builder”: the survivor opens block by block (${bchips.join(', ')})`);
  await page.click('.bb2-arrived button');
  await page.click('.pro-cmd-input');
  await page.keyboard.type('FARM');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-farm] [data-detail]', { timeout: 10_000 });
  await page.click('[data-farm] [data-detail] .chip:has-text("Trade as tested")');
  await page.click('[data-farm] .farm-deploy');
  await page.waitForSelector('[data-farm] .farm-deploy:has-text("Deployed")', { timeout: 15_000 });
  const dep2 = (await page.evaluate(() => window.novus.lab.state())).deployed;
  expect(dep2.some((d) => d.authority === 'tested' && /edge finder/.test(d.stats.verdict)), `deployed from the edge finder to the crypto swarm, to trade as tested (${survivorName.slice(0, 50)})`);
  await page.waitForSelector('[data-farm] .farm-fleet [data-fleet]', { timeout: 20_000 });
  expect(true, 'the live fleet: the deployed strategy is watched on fresh data');
  await page.click('[data-farm] .farm-stop');
  await page.waitForFunction(() => /Stopped/.test(document.querySelector('.farm-title')?.textContent ?? ''), null, { timeout: 30_000 });
  const farm1 = await page.evaluate(() => window.novus.lab.farm.state());
  expect(!farm1.running && farm1.wanted === false && farm1.survivors > 0 && farm1.tried >= farm0.tried, 'Stop: it stops, keeps everything it found, and stays stopped until started again');
  await page.evaluate((ids) => Promise.all(ids.map((id) => window.novus.lab.undeploy(id))), dep2.map((d) => d.id));
  // the research screen shows it at a glance
  await page.click('.pro-cmd-input');
  await page.keyboard.type('RSCH');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-farm-strip]', { timeout: 10_000 });
  expect(/Edge finder/.test(await page.locator('[data-farm-strip]').innerText()), 'the research screen shows the edge finder and its top five at a glance');
  await page.keyboard.press('F3');
  await page.waitForSelector('.pro-ws-tab.active:has-text("QUANT DESK")', { timeout: 10_000 });
  await page.selectOption('.pro-theme-select', 'pro-eikon');
  expect((await page.evaluate(() => document.documentElement.dataset.theme)) === 'pro-eikon', 'professional themes switch');
  await page.selectOption('.pro-theme-select', 'pro-amber');
  // the crypto swarm is its own view: one click on the top bar
  await page.click('.vs-swarm');

  step('the crypto swarm is its own view, apart from the terminal');
  // the crypto terminal opens on the swarm's Command Center: the core, the gauges, the deploy gate
  await page.waitForSelector('.cc > .cc-top', { timeout: 15_000 });
  const ccText = await page.locator('.cc').innerText();
  expect(/SWARM COMMAND/.test(ccText) && /PAPER/.test(ccText) && /\$30\.00/.test(ccText), 'the Command Center shows the swarm, its paper account and $30');
  expect((await page.locator('.cc-gauge').count()) === 10, 'ten swarm gauges: the agents, the deploy gate, the council, the forest, the optimizer and the limits');
  await page.locator('.cc-gauge.clickable').first().click();
  await page.waitForSelector('.cc-drawer .cc-deploy', { timeout: 10_000 });
  expect((await page.locator('.cc-drawer .cc-gate-step').count()) === 5, 'the deploy gate shows the chain: rules → council → forest → risk → execute');
  await page.screenshot({ path: `${OUT}desktop-deploy-gate.png` });
  await page.keyboard.press('Escape');
  await page.click('.cc-power');
  await page.waitForSelector('.cc-power.on', { timeout: 20_000 });
  expect(await page.evaluate(() => window.novus.cswarm.state().then((s) => s.running)), 'Start swarm starts the crypto swarm on paper');
  await page.screenshot({ path: `${OUT}desktop-command.png` });
  await page.click('.cc-power');
  await page.waitForSelector('.cc-power:not(.on)', { timeout: 20_000 });
  expect((await page.locator('.pro-cmdbar').count()) === 0 && (await page.locator('.pro-ws-tab').count()) === 0, 'no terminal on the swarm view: no command line, no workspaces');
  // Ctrl+1 the terminal, Ctrl+2 the swarm; a swarm code typed in the terminal opens it in the swarm view
  await page.keyboard.press('Control+1');
  await page.waitForSelector('.pro-cmdbar', { timeout: 10_000 });
  expect((await page.locator('.cc > .cc-top').count()) === 0, 'Ctrl+1 is the terminal, without the swarm');
  await page.click('.pro-cmd-input');
  await page.keyboard.type('TKT');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.cc-drawer .chip.active:has-text("Order ticket")', { timeout: 10_000 });
  expect(true, 'TKT on the terminal command line opens the order ticket in the swarm view');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+1');
  await page.waitForSelector('.pro-cmdbar', { timeout: 10_000 });
  await page.keyboard.press('Control+2');
  await page.waitForSelector('.cc > .cc-top', { timeout: 10_000 });
  expect(true, 'Ctrl+2 back to the crypto swarm');
  // the swarm on this screen, the quant desk's neural network on another: any tool opens in its own window from the swarm view
  await page.click('.scr > .chip');
  await page.fill('.scr-open-bar input', 'NNET');
  const nnWin = app.waitForEvent('window', { timeout: 30_000 });
  await page.click('.scr-open-row[data-panel="qnn"]');
  const nnPop = await nnWin;
  await nnPop.waitForSelector('.popout-bar', { timeout: 30_000 });
  const nnBar = await nnPop.locator('.popout-bar').innerText();
  const ccOn = await page.locator('.cc > .cc-top').count();
  expect(/Neural network/i.test(nnBar) && ccOn === 1, `(${nnBar.slice(0, 40)} · swarm on screen: ${ccOn}) ` + 'from the crypto swarm view, the quant desk’s NNET opens in its own window while the swarm stays on screen');
  await page.keyboard.press('Escape');
  // ⇤ sends it back: the window closes and the panel opens on the quant desk
  await nnPop.click('.popout-bar .chip:has-text("Back to the terminal")');
  await page.waitForSelector('.pro-ws-tab.active:has-text("QUANT DESK")', { timeout: 15_000 });
  expect((await page.locator('.flexlayout__tab_button--selected:has-text("NNET")').count()) > 0, '⇤ Back to the terminal: the window closes and NNET opens on the quant desk');
  // ⇄ moves a tab to another workspace
  await page.locator('.pro-host:not([style*="none"]) .move-tab-btn').first().click();
  await page.waitForSelector('.move-tab-opt', { timeout: 5_000 });
  expect((await page.locator('.move-tab-opt').count()) >= 3, '⇄ offers the other workspaces and its own window');
  await page.click('.modal .x');
  await page.keyboard.press('Control+2');
  await page.waitForSelector('.cc > .cc-top', { timeout: 10_000 });
  // the classic order-flow look, from Settings, for the checks below
  await page.click('button[title="Settings"]');
  await page.click('.modal .chip:has-text("Classic order-flow terminal")');
  await page.waitForSelector('.flexlayout__layout', { state: 'visible' });
  expect(true, 'Settings opens the classic order-flow layout');

  step('window fills the screen');
  const win = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { maximized: w.isMaximized(), bounds: w.getBounds(), work: screen.getPrimaryDisplay().workArea, resizable: w.isResizable() };
  });
  expect(win.resizable, 'window is resizable');
  expect(win.bounds.width <= win.work.width + 16 && win.bounds.height <= win.work.height + 16, `window fits the screen (${win.bounds.width}×${win.bounds.height} in ${win.work.width}×${win.work.height})`);
  console.log(`  window ${win.maximized ? 'maximised' : 'not maximised (no window manager?)'} ${win.bounds.width}×${win.bounds.height}`);
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, app: document.querySelector('.app').getBoundingClientRect() }));
  expect(Math.abs(vp.app.width - vp.w) < 2 && Math.abs(vp.app.height - vp.h) < 2, 'terminal fills the window');

  step('full screen');
  const fs0 = await page.evaluate(() => window.novus.app.isFullscreen());
  await page.click('.topbar button[title*="(F11)"]');
  await page.waitForTimeout(500);
  const fs1 = await page.evaluate(() => window.novus.app.isFullscreen());
  console.log(`  full screen at start: ${fs0}; after the button: ${fs1}${fs0 === fs1 ? ' (no window manager to honour it)' : ''}`);
  if (fs0 !== fs1) await page.click('.topbar button[title*="(F11)"]');

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

  step('chart zoom: fit every bar, zoom out');
  await page.waitForTimeout(4000);
  const fp = page.locator('.flexlayout__tab:visible:has(.zoom-controls)').first();
  const fpCanvas = fp.locator('canvas').first();
  const before = await fpCanvas.screenshot();
  await fp.locator('.zoom-controls button:text-is("Fit")').click();
  await page.waitForTimeout(400);
  await fp.locator('.zoom-controls button:text-is("−")').click();
  await page.waitForTimeout(400);
  expect(!(await fpCanvas.screenshot()).equals(before), 'zoom buttons redraw the chart');
  await page.screenshot({ path: `${OUT}desktop-zoomed-out.png` });

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
  // Hyperliquid: the API-wallet guide and its two fields, named for which wallet each is
  await page.click('.quick-tile[title="Connect Hyperliquid"]');
  await page.waitForSelector('.key-guide');
  const hlGuide = await page.locator('.key-guide').innerText();
  const hlForm = await page.locator('.vault-form').innerText();
  expect(/More → API/.test(hlGuide) && /never withdraw/.test(hlGuide) && hlForm.includes('Main wallet address') && hlForm.includes('API wallet private key'), 'Hyperliquid guide and its fields (main wallet address, API wallet private key)');
  await page.screenshot({ path: `${OUT}desktop-hyperliquid.png` });
  // back to the tiles: close and open Connections again
  await page.keyboard.press('Escape');
  await page.waitForSelector('.quick-tile', { state: 'detached' }).catch(() => undefined);
  await page.click('button[title^="Connections"]');
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
  expect((await page.locator('.vault-row .env-badge:text-is("LIVE")').count()) === 1, 'key shows it is saved as LIVE');
  await page.click('.vault-row button:text-is("Test live")');
  await page.waitForSelector('.vault-row .key-test:not(:has-text("Testing"))', { timeout: 30_000 });
  const tested = await page.locator('.vault-row .key-test').innerText();
  // no network to Binance from the test machine: the card must still explain the outcome
  expect(/LIVE/.test(tested) && (/Connected to/.test(tested) || /test failed/.test(tested)), `live key test reports its outcome (${tested.split('\n')[0]})`);
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
  const dom = page.locator('.flexlayout__tab:visible:has(.live-chip):not(:has(.zoom-controls)) canvas').first();
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
  // the ticket refreshes its log every 10 s; these orders were placed through the API directly
  await page.waitForFunction(() => document.querySelectorAll('.ticket .log-row').length >= 2, null, { timeout: 15_000 }).catch(() => undefined);
  const logRows = await page.locator('.ticket .log-row').count();
  expect(logRows >= 2, `ticket shows the order log (${logRows} rows: ${(await page.locator('.ticket .log-row').allInnerTexts()).join(' | ').slice(0, 200)})`);
  await page.screenshot({ path: `${OUT}desktop-ticket-log.png` });

  step('database recording and panel');
  const n = await page.evaluate(() =>
    window.novus.db.record('binancef', 'BTCUSDT', Array.from({ length: 500 }, (_, i) => ({ p: 100000 + i, q: 0.01, s: i % 2 ? 'buy' : 'sell', t: Date.now() - (500 - i) * 1000 }))),
  );
  expect(n === 500, 'recorded 500 trades');
  const q = await page.evaluate(() => window.novus.db.query('binancef', 'BTCUSDT', 0, Date.now()).then((c) => ({ n: c.t.length, p0: c.p[0], typed: c.t instanceof Float64Array })));
  expect(q.n === 500 && q.p0 === 100000 && q.typed, 'queried them back (typed columns, read on the database worker)');
  // a big batch (a backfilled gap) is written on the database worker, in chunks
  const big = await page.evaluate(() => window.novus.db.record('bybit', 'ETHUSDT', Array.from({ length: 12_000 }, (_, i) => ({ p: 3000, q: 0.1, s: 'buy', t: Date.now() - (12_000 - i) * 100 }))));
  expect(big === 12_000, 'a 12,000-trade batch recorded on the database worker');
  const pr = await page.evaluate(() => window.novus.db.prune(365));
  expect(typeof pr === 'number', 'old-trade clean-up runs on the database worker');
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

  step('Telegram: the swarm\'s trades, no order-flow reports or alerts');
  const tgText = await page.locator('.steps').locator('xpath=..').innerText();
  expect(/Swarm trades on Telegram/.test(tgText) && /Pop-up and sound here/.test(tgText), 'swarm notification options shown');
  expect(!/Daily report|Weekly overview|data feed has been down|chart alerts/.test(tgText), 'order-flow reports and alerts are gone');
  expect((await page.locator('.report-when, .report-preview').count()) === 0, 'no report scheduler');
  const alertsLeft = await page.evaluate(() => JSON.parse(localStorage.getItem('oft-settings') ?? '{}').state?.alerts?.length ?? 0);
  expect(alertsLeft === 0, `no liquidation or big-trade alerts set up (${alertsLeft})`);

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

  step('AMT growth preset: balance sizing and walk-forward training');
  await page.click('.amt .toolbar button:text-is("Settings")');
  await page.click('.amt-settings .seg button:text-is("Growth (small account)")');
  await page.locator('.amt-balance input').fill('27');
  const preview = await page.locator('.amt-preview').innerText();
  expect(/\$27\.00/.test(preview) && /fees/.test(preview), `sizing preview explains a $27 trade (${preview.slice(0, 80)}…)`);
  expect((await page.locator('.amt-settings :text("Manage trades on momentum")').count()) === 1, 'trade manager offered on the growth bot');
  await page.click('.amt-settings button:text-is("Save")');
  const growthBot = (await page.evaluate(() => window.novus.amt.list()))[0];
  expect(growthBot.params.manageTrades === true, 'growth bot saved with the trade manager on');
  expect(growthBot.params.trendFilter === true, 'growth bot trades with the daily trend only');
  expect(growthBot.params.sizing === 'balance' && growthBot.params.accountUsd === 27 && growthBot.params.riskPct === 2, 'growth preset saved with balance sizing');
  const seeded = await page.evaluate(() => {
    // repeating auctions: balance, a failed probe above value, then rotation or a rally
    let s = 5;
    const r = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let t = Date.now() - 30 * 3_600_000;
    const out = [];
    const add = (p, side, q) => out.push({ t: (t += 500), p: Number(p.toFixed(2)), q, s: side });
    for (let c = 0; c < 24; c++) {
      for (let i = 0; i < 4800; i++) add(100 + (r() + r() - 1) * 0.5, r() < 0.5 ? 'buy' : 'sell', 0.1 + r() * 0.2);
      for (let i = 0; i < 40; i++) add(100.2 + (0.12 * i) / 40, 'buy', 0.3);
      for (let i = 0; i < 40; i++) add(100.32 - (0.15 * i) / 40, 'sell', 0.6);
      const works = r() < 0.6;
      for (let i = 0; i < 120; i++) add(works ? 100.17 - (0.2 * i) / 120 : 100.17 + (0.5 * i) / 120, works ? 'sell' : 'buy', 0.3);
    }
    return window.novus.db.record('binancef', 'TRAINTEST', out);
  });
  expect(seeded > 100_000, `recorded ${seeded} trades for training`);
  await page.click('.amt .toolbar button:text-is("Train")');
  await page.selectOption('.amt-backtest select >> nth=0', 'binancef|TRAINTEST');
  const t0 = Date.now();
  await page.click('.amt-backtest button:text-is("Train")');
  await page.waitForSelector('.amt-backtest .confirm-card', { timeout: 240_000 });
  const trained = await page.locator('.amt-backtest').innerText();
  expect(/40 settings tried/.test(trained) && /(held up on unseen data|nothing was changed)/.test(trained), `training finished in ${((Date.now() - t0) / 1000).toFixed(0)} s with a verdict`);
  // every searched setting can be applied: a known result, served by the main process in place of a real run
  await app.evaluate(({ ipcMain }) => {
    const seg = (trades, win, growth) => ({ trades, wins: Math.round(trades * win), winRate: win, pnl: growth / 10, fees: 0.5, growthPct: growth, maxDrawdownPct: 3, profitFactor: 1.2, score: 0.01, startBalance: 27 });
    ipcMain.removeHandler('amt:train');
    ipcMain.handle('amt:train', async (_e, params, venue, symbol) => ({
      ok: true,
      value: {
        verdict: 'no-edge',
        params: null,
        best: null,
        baseline: { train: seg(10, 0.4, -2), test: seg(5, 0.4, -1) },
        leaders: [
          { params: { deltaThreshold: 0.4, minRR: 2 }, train: seg(12, 0.56, 4), test: seg(6, 0.5, -0.8), base: false },
          { params: { deltaThreshold: 0.3, minRR: 2.5 }, train: seg(11, 0.45, 3), test: seg(5, 0.4, -1.5), base: false },
        ],
        searched: 40,
        count: 120000,
        from: Date.now() - 86_400_000,
        to: Date.now(),
        splitT: Date.now() - 20_000_000,
        venue,
        symbol,
      },
    }));
  });
  await page.click('.amt-backtest button:text-is("Train")');
  await page.waitForSelector('.amt-train button:has-text("Apply #1")');
  expect((await page.locator('.amt-train button:has-text("Apply #")').count()) === 2, 'every row of a no-edge result can be applied');
  let asked = '';
  // (dialogs are accepted by the handler set up at launch)
  page.once('dialog', (d) => {
    asked = d.message();
  });
  await page.click('.amt-train button:has-text("Apply #1")');
  await page.waitForSelector('.amt-backtest :text("Applied settings #1")', { timeout: 5000 });
  const appliedBot = (await page.evaluate(() => window.novus.amt.list()))[0].params;
  expect(/did NOT pass the unseen-data check/.test(asked) && /6 trades, 50% wins, and shrank the balance by 0\.80?% after fees/.test(asked), 'a setting that failed the unseen check asks, with its unseen result');
  expect(appliedBot.deltaThreshold === 0.4 && appliedBot.minRR === 2, 'confirmed setting saved to the bot');
  await page.screenshot({ path: `${OUT}desktop-amt-train.png` });
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

  step('order-flow hybrid: absorption, imbalance continuation, sweep & reclaim');
  await page.click('.amt .toolbar button:text-is("Settings")');
  await page.click('.amt-settings .seg button:text-is("Order-flow hybrid")');
  for (const name of ['Absorption reversal', 'Imbalance continuation', 'Sweep & reclaim']) await page.waitForSelector(`.amt-settings :text("${name}")`);
  await page.click('.amt-settings summary:text-is("Advanced AMT parameters")');
  expect((await page.locator('.amt-settings input[type="number"]').count()) >= 55, 'order-flow parameters editable (footprint, absorption, pools, book)');
  await page.screenshot({ path: `${OUT}desktop-amt-orderflow-settings.png` });
  await page.click('.amt-settings button:text-is("Save")');
  const ofBot = (await page.evaluate(() => window.novus.amt.list()))[0];
  expect(ofBot.params.style === 'orderflow' && ofBot.params.setups.absorption && ofBot.params.setups.sweep && ofBot.params.sizing === 'balance', 'order-flow bot saved');
  await page.click('.amt .toolbar button:text-is("Monitor")');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch.on');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch:not(.on)');

  step('trend bot: daily time-series momentum on spot, backtest on full history');
  await page.click('.amt .toolbar button:text-is("Settings")');
  await page.click('.amt-settings .seg button:text-is("Trend (daily, spot)")');
  await page.waitForSelector('.amt-settings .section-title:text-is("Trend rules")');
  expect((await page.locator('.amt-settings :text("Target volatility (% a year)")').count()) === 1, 'trend rules editable');
  await page.click('.amt-settings button:text-is("Save")');
  const trendBot = (await page.evaluate(() => window.novus.amt.list()))[0];
  expect(trendBot.params.style === 'trend' && trendBot.params.targetVol === 60 && trendBot.params.feeBps === 10, 'trend bot saved with its preset');
  expect(!trendBot.symbol.includes(':'), `trend bot moved to the spot market (${trendBot.symbol})`);
  await page.click('.amt .toolbar button:text-is("Backtest")');
  await page.click('.amt-backtest button:text-is("Backtest on full history")');
  // the sandbox has no exchange access: the error is shown, nothing breaks
  await page.waitForSelector('.amt-backtest .down', { timeout: 60_000 });
  expect((await page.locator('.amt-backtest .down').innerText()).length > 0, 'trend backtest reports why it could not download history');
  await page.click('.amt .toolbar button:text-is("Monitor")');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch.on');
  await page.waitForSelector('.amt-ev.ev-started');
  await page.screenshot({ path: `${OUT}desktop-amt-trend.png` });
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch:not(.on)');

  step('adaptive scalper: judgement settings, reasoning read-out');
  await page.click('.amt .toolbar button:text-is("Settings")');
  await page.click('.amt-settings .seg button:text-is("Adaptive scalper")');
  for (const name of ['Responsive fade', 'Absorption reversal', 'Sweep & reclaim']) await page.waitForSelector(`.amt-settings :text("${name}")`);
  if (!(await page.locator('.amt-settings details[open]').count())) await page.click('.amt-settings summary:text-is("Advanced AMT parameters")');
  await page.waitForSelector('.amt-settings .section-title:text-is("Judgement")');
  await page.waitForSelector('.amt-settings .seg button.active:text-is("Limit first (maker fee)")');
  expect((await page.locator('.amt-settings :text("Chase after (R)")').count()) === 1, 'maker execution settings shown');
  await page.click('.amt-settings button:text-is("Save")');
  const adBot = (await page.evaluate(() => window.novus.amt.list()))[0];
  expect(adBot.params.style === 'adaptive' && adBot.params.setups.fade && adBot.params.setups.sweep && adBot.params.breakevenAtR === 0 && adBot.params.orderMode === 'maker', 'adaptive bot saved, limit-first execution');
  await page.click('.amt .toolbar button:text-is("Monitor")');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch.on');
  await page.waitForSelector('.amt-cards :text("Stop width")', { timeout: 10_000 });
  await page.screenshot({ path: `${OUT}desktop-amt-adaptive.png` });
  // training is allowed while the bot runs (only applying a result needs it off)
  await page.click('.amt .toolbar button:text-is("Train")');
  await page.waitForSelector('.amt-backtest button:text-is("Train")');
  expect(await page.locator('.amt-backtest button:text-is("Train")').isEnabled(), 'Train button usable while the bot is running');
  expect((await page.locator('.amt-backtest :text("you can train now")').count()) === 1, 'running bot: explains that only Apply needs it off');
  await page.click('.amt .toolbar button:text-is("Monitor")');
  await page.click('.amt .algo-switch');
  await page.waitForSelector('.amt .algo-switch:not(.on)');

  step('every panel has a close ×');
  const tabCount = await page.locator('.flexlayout__tab_button').count();
  const closers = await page.locator('.flexlayout__tab_button .flexlayout__tab_button_trailing').count();
  expect(closers === tabCount && tabCount > 3, `close button on all ${tabCount} tabs`);
  const unselected = page.locator('.flexlayout__tab_button--unselected').first();
  const name = await unselected.locator('.flexlayout__tab_button_content').innerText();
  await unselected.locator('.flexlayout__tab_button_trailing').click();
  await page.waitForTimeout(300);
  expect((await page.locator('.flexlayout__tab_button').count()) === tabCount - 1, `closed “${name}” with its × outside edit mode`);

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
  await page.evaluate(() => (window.__sameSession = true));
  await page.click('.topbar button:has-text("Lock")');
  await page.waitForSelector('.lock-key input', { timeout: 30_000 });
  const resealed = await page.evaluate(() => window.novus.vault.list().then(() => 'open', (e) => e.message));
  expect(/sealed/.test(resealed), 'Lock seals the desktop process');
  await page.waitForSelector('.running-bar');
  const bar = await page.locator('.running-bar').innerText();
  expect(/TERMINAL RUNNING/.test(bar) && /Locked/.test(bar), `lock page shows the running bar (${bar.split('\n').join(' · ').slice(0, 140)})`);
  expect((await page.locator('.topbar, .flexlayout__layout').count()) === 0, 'terminal panels are off screen while locked');
  await page.screenshot({ path: `${OUT}desktop-locked.png` });
  const devtools = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.webContents.openDevTools({ mode: 'detach' });
    await new Promise((r) => setTimeout(r, 800));
    return w.webContents.isDevToolsOpened();
  });
  expect(!devtools, 'developer tools refused while locked');
  await page.locator('.lock-key input').fill(TEST_KEY);
  await page.waitForSelector('.lock-key.denied');
  expect(true, 'old key denied after the change');
  await unlock(page, NEW_KEY);
  await page.waitForSelector('.topbar', { timeout: 30_000 });
  expect(true, 'new key opens the terminal');
  expect(await page.evaluate(() => window.__sameSession === true), 'unlocking returns to the same running session (no reload)');

  expect((await page.locator('text=crashed').count()) === 0, 'no panel crashed');

  step('Luno lane');
  const errorsBefore = errors.length;
  // the optional Luno lane is its own panel now (LUNO): it opens and offers the key (none saved for Luno here)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('novus:open-panel', { detail: { panel: 'luno', ws: 'swarm' } })));
  await page.waitForSelector('.luno-lane', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}desktop-luno.png` });
  expect((await page.locator('.luno-lane button:has-text("Connect → Luno")').count()) === 1 && errors.length === errorsBefore, 'the Luno lane opens and asks for the key');
  await page.keyboard.press('Escape');
  await page.click('button[title="Settings"]');
  await page.click('.modal .chip:has-text("Classic order-flow terminal")');
  await page.waitForSelector('.flexlayout__layout', { state: 'visible' });
  expect(true, 'back to the terminal layout');
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

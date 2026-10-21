// Novus Ordo desktop shell (Electron main process).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, screen, shell } from 'electron';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from './amt/bots.mjs';
import { Db } from './db.mjs';
import { connectPhantom } from './phantom.mjs';
import { DEFAULT_RPC, recentActivity, SOL_MINT, tokenInfo, walletBalances } from '../src/shared/solana.ts';
import { TelegramCommands, tgDetectChat, tgMe, tgSendLong, tgSendPhoto } from '../src/shared/telegram.ts';
import { reportData } from './reports.mjs';
import { AttemptGate, isLedgerRecord, ledgerMatches, makeLedger, PUBLIC_CHANNELS } from '../src/shared/ledger.ts';
import { createHash, randomBytes } from 'node:crypto';
import { Vault } from './vault.mjs';
import { Worker } from 'node:worker_threads';
import { initLog, log, logFile } from './log.mjs';
import { initialWindow, loadWindowState, MIN_H, MIN_W, saveWindowState } from './windowState.mjs';

// bundled to dist-electron/main.mjs; app root is one level up
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// training worker: bundled next to main.mjs and kept outside the asar archive
const trainWorkerPath = join(here, 'trainWorker.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const DAY = 86_400_000;

// NOVUS_USER_DATA relocates the database, vault and settings (tests, portable installs)
if (process.env.NOVUS_USER_DATA) app.setPath('userData', process.env.NOVUS_USER_DATA);

const userDataDir = app.getPath('userData');
initLog(join(userDataDir, 'logs'));
log('info', `starting Novus Ordo ${app.getVersion()} on ${process.platform} ${process.arch}, electron ${process.versions.electron}`);
process.on('uncaughtException', (e) => log('error', 'uncaught exception', e));
process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', e instanceof Error ? e : String(e)));

// Safe mode: no GPU acceleration. Turned on automatically when the GPU process
// crashes or the window stays blank, or by starting with --safe-mode.
const SAFE_FLAG = join(userDataDir, 'safe-mode.json');
// earlier builds could mistake an empty screenshot of a hidden window for a
// blank one and pin the app in software rendering; drop those flags once
try {
  const f = existsSync(SAFE_FLAG) && JSON.parse(readFileSync(SAFE_FLAG, 'utf8'));
  if (f && !f.v && f.reason === 'window stayed blank') {
    rmSync(SAFE_FLAG, { force: true });
    log('info', 'cleared a safe-mode flag set by the old blank-window check');
  }
} catch {
  rmSync(SAFE_FLAG, { force: true });
}
const safeMode = process.argv.includes('--safe-mode') || process.env.NOVUS_SAFE_MODE === '1' || existsSync(SAFE_FLAG);
if (safeMode) {
  app.disableHardwareAcceleration();
  log('warn', 'safe mode: hardware acceleration disabled');
}

/** Restart once in safe mode (portable builds relaunch the portable exe itself). */
function relaunchSafe(reason) {
  if (safeMode) return;
  log('warn', `relaunching in safe mode: ${reason}`);
  try {
    writeFileSync(SAFE_FLAG, JSON.stringify({ v: 2, reason, at: new Date().toISOString() }));
  } catch (e) {
    log('error', 'could not write safe-mode flag', e);
  }
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portable ? { execPath: portable, args: [] } : undefined);
  app.exit(0);
}

/** Back to GPU rendering on the next start, which happens now. */
function leaveSafeMode() {
  rmSync(SAFE_FLAG, { force: true });
  log('info', 'leaving safe mode');
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portable ? { execPath: portable, args: [] } : { args: process.argv.slice(1).filter((a) => a !== '--safe-mode') });
  app.exit(0);
}

if (!app.requestSingleInstanceLock()) {
  log('info', 'another instance is already running — handing over to it');
  app.quit();
}

let win = null;
let db;
let vault;
let ccxtSvc;
let bots;
let services = null;

function createWindow() {
  // opens maximised (or where it was last left), always within the screen:
  // a fixed 1600×1000 with a 960×600 minimum did not fit scaled laptop screens
  const stateFile = join(userDataDir, 'window-state.json');
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const placed = initialWindow(loadWindowState(stateFile), displays);
  win = new BrowserWindow({
    ...placed.bounds,
    minWidth: Math.min(MIN_W, displays[0].width),
    minHeight: Math.min(MIN_H, displays[0].height),
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    title: 'Novus Ordo — by Quincy Gininda',
    // black like the lock screen, and only shown once the first frame is painted
    backgroundColor: '#000000',
    show: false,
    icon: join(root, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // external links open in the default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\0')) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  const w = win;
  const reveal = () => {
    if (!w.isDestroyed() && !w.isVisible()) {
      if (placed.maximized) w.maximize();
      if (placed.fullScreen) w.setFullScreen(true);
      w.show();
      log('info', 'window shown');
    }
  };
  w.once('ready-to-show', reveal);
  setTimeout(reveal, 5000);
  const wc = w.webContents;
  wc.on('did-finish-load', () => {
    log('info', 'page loaded');
    // a window that is still one flat colour after 15 s is not rendering: retry without the GPU
    setTimeout(() => void checkBlank(w), 15_000);
  });
  wc.on('did-fail-load', (_e, code, desc, url) => log('error', `page failed to load (${code} ${desc}) ${url}`));
  wc.on('render-process-gone', (_e, d) => {
    log('error', `window renderer gone: ${d.reason} (exit ${d.exitCode})`);
    if (d.reason !== 'clean-exit' && !w.isDestroyed()) {
      if ((w.__crashes = (w.__crashes ?? 0) + 1) <= 1) wc.reload();
      else relaunchSafe(`renderer ${d.reason}`);
    }
  });
  wc.on('unresponsive', () => log('warn', 'window unresponsive'));
  wc.on('responsive', () => log('info', 'window responsive again'));
  wc.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    if (level === 'error' || level === 3) log('error', `renderer: ${e.message ?? e.params?.message} (${e.sourceId ?? ''}:${e.lineNumber ?? ''})`);
  });
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void win.loadFile(join(root, 'dist', 'index.html')).catch((e) => log('error', 'loadFile failed', e));
  win.on('close', () => saveWindowState(stateFile, w));
  // tell the top bar so its full-screen button shows the right state
  const sendFs = () => !w.isDestroyed() && w.webContents.send('app:fullscreen', w.isFullScreen());
  win.on('enter-full-screen', sendFs);
  win.on('leave-full-screen', sendFs);
  win.on('closed', () => {
    win = null;
    ccxtSvc?.closeAll();
  });
}

/**
 * Sample the window; a uniform image means nothing is being drawn. Only a
 * window the user can see is judged (an occluded or unfocused window can
 * capture empty or stale), an empty capture never counts as blank, and two
 * flat captures a few seconds apart are needed before giving up on the GPU.
 */
async function checkBlank(w, strikes = 0) {
  if (safeMode || w.isDestroyed()) return;
  if (!w.isVisible() || w.isMinimized() || !w.isFocused()) {
    // try again later; give up after a few minutes rather than guess
    if (strikes > -20) setTimeout(() => void checkBlank(w, strikes - 1), 10_000);
    return;
  }
  try {
    const img = await w.webContents.capturePage();
    if (img.isEmpty()) {
      log('info', 'render check: empty capture (ignored)');
      return;
    }
    const small = img.resize({ width: 48, height: 30 }).toBitmap();
    const seen = new Set();
    for (let i = 0; i < small.length; i += 4) seen.add((small[i] << 16) | (small[i + 1] << 8) | small[i + 2]);
    log('info', `render check: ${seen.size} colours`);
    if (seen.size > 2) return;
    if (strikes > 0) relaunchSafe('window stayed blank');
    else setTimeout(() => void checkBlank(w, 1), 5000);
  } catch (e) {
    log('warn', 'render check failed', e);
  }
}

const httpsOnly = (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https URLs are allowed');
  return u.toString();
};

function retentionDays() {
  return db.get('retentionDays') ?? 3;
}

// sealed until the ledger key is entered; only public market data flows before that
let unlocked = false;
const attempts = new AttemptGate();
const sha256Hex = (x) => createHash('sha256').update(x).digest('hex');
/** The owner's own key (salted digest in the database), else the built-in one. */
const ledgerRecord = () => {
  const r = db.get('ledger');
  return isLedgerRecord(r) ? r : undefined;
};

// channels that need the exchange services, which load after the window is up
const NEEDS_SERVICES = /^(ccxt|trade|amt|report):|^vault:test$/;

function registerIpc() {
  const handle = (ch, fn) =>
    ipcMain.handle(ch, async (e, ...args) => {
      try {
        if (!unlocked && !PUBLIC_CHANNELS.has(ch)) throw new Error('Terminal is sealed — enter the ledger key');
        if (NEEDS_SERVICES.test(ch)) await services;
        return { ok: true, value: await fn(e, ...args) };
      } catch (err) {
        // market-data requests retry on their own; log the rest
        if (!/sealed|ACCESS DENIED|LOCKED OUT/.test(String(err?.message)) && !/^net:|^ccxt:(ohlcv|ticker|tickers|markets)$/.test(ch)) log('warn', `${ch}: ${err?.message ?? err}`);
        // signed request URLs in errors carry a signature: show the path only
        return { ok: false, error: String(err?.message ?? err).replace(/(https?:\/\/[^\s?]+)\?\S+/g, '$1') };
      }
    });

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    db: db.info(),
    vaultBackend: vault.backend,
    retentionDays: retentionDays(),
    safeMode,
  }));
  handle('app:leaveSafeMode', () => leaveSafeMode());
  handle('app:locked', () => !unlocked);
  // full screen hides the taskbar; F11 or the top-bar button toggles it
  handle('app:fullscreen', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    w.setFullScreen(typeof on === 'boolean' ? on : !w.isFullScreen());
    return w.isFullScreen();
  });
  handle('app:isFullscreen', (e) => Boolean(BrowserWindow.fromWebContents(e.sender)?.isFullScreen()));
  handle('app:log', () => logFile());
  handle('app:unlock', async (_e, code) => {
    attempts.check();
    const ok = await ledgerMatches(String(code ?? ''), sha256Hex, ledgerRecord());
    if (!ok) {
      attempts.fail();
      throw new Error(attempts.waitMs() ? `ACCESS DENIED — locked for ${Math.ceil(attempts.waitMs() / 1000)}s` : 'ACCESS DENIED');
    }
    attempts.success();
    unlocked = true;
    return true;
  });
  // lock again (renderer shows the lock screen); bots keep running in this process
  handle('app:seal', () => {
    unlocked = false;
    return true;
  });
  handle('app:changeKey', async (_e, current, next) => {
    attempts.check();
    if (!(await ledgerMatches(String(current ?? ''), sha256Hex, ledgerRecord()))) {
      attempts.fail();
      throw new Error('Current ledger key is wrong');
    }
    attempts.success();
    db.set('ledger', await makeLedger(String(next ?? ''), sha256Hex, randomBytes(16).toString('hex')));
    return true;
  });
  handle('shell:open', (_e, url) => shell.openExternal(httpsOnly(url)));

  // generic HTTPS JSON proxy: exchange REST calls from the main process avoid CORS
  handle('net:fetchJson', async (_e, url, init) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(httpsOnly(url), { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body, signal: ctrl.signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  });

  // vault
  handle('vault:list', () => vault.list());
  // a key that drives a running live bot cannot change under it (e.g. testnet → live)
  const guardKey = (id) => {
    if (id && bots?.usesKey(id)) throw new Error('A live AMT bot is using this key — stop the bot before editing or deleting it');
  };
  handle('vault:save', (_e, rec) => {
    guardKey(rec?.id);
    const id = vault.save(rec);
    ccxtSvc?.invalidate(id);
    return id;
  });
  handle('vault:remove', (_e, id) => {
    guardKey(id);
    ccxtSvc?.invalidate(id);
    return vault.remove(id);
  });
  handle('vault:copy', (_e, id, field) => {
    const v = vault.reveal(id).fields[field];
    if (v === undefined) throw new Error(`no field ${field}`);
    clipboard.writeText(v);
    // clear the clipboard after 30s if it still holds the secret
    setTimeout(() => clipboard.readText() === v && clipboard.clear(), 30_000);
    return true;
  });
  handle('vault:test', (_e, id, opts) => ccxtSvc.testKey(id, opts));

  // ccxt
  let exchangesCache = null;
  handle('ccxt:exchanges', async () => {
    const { listExchanges } = await import('./ccxt-service.mjs');
    exchangesCache ??= listExchanges({ get: () => db.get('ccxtExchanges'), set: (v) => db.set('ccxtExchanges', v) });
    return exchangesCache;
  });
  handle('ccxt:markets', (_e, id) => ccxtSvc.markets(id));
  handle('ccxt:ohlcv', (_e, id, symbol, tf, limit) => ccxtSvc.ohlcv(id, symbol, tf, limit));
  handle('ccxt:tickers', (_e, id) => ccxtSvc.tickers(id));
  handle('ccxt:ticker', (_e, id, symbol) => ccxtSvc.ticker(id, symbol));
  handle('ccxt:account', (_e, secretId, symbol) => ccxtSvc.account(secretId, symbol));
  // trading: every rule (trading switch, value cap, rate limit) is enforced here, not in the UI
  handle('trade:marketInfo', (_e, secretId, symbol) => ccxtSvc.marketInfo(secretId, symbol));
  handle('trade:place', (_e, secretId, req) => ccxtSvc.placeOrder(secretId, req));
  handle('trade:cancel', (_e, secretId, orderId, symbol) => ccxtSvc.cancelOrder(secretId, orderId, symbol));
  handle('trade:cancelAll', (_e, secretId, symbol) => ccxtSvc.cancelAll(secretId, symbol));
  handle('trade:close', (_e, secretId, symbol, side) => ccxtSvc.closePosition(secretId, symbol, side));
  handle('trade:limits', () => ccxtSvc.limits());
  handle('trade:setLimits', (_e, l) => ccxtSvc.setLimits(l));
  handle('trade:log', (_e, limit) => db.orderLog(Math.min(500, Number(limit) || 100)));
  // AMT scalper bots
  handle('amt:list', () => bots.list());
  handle('amt:defaults', () => bots.defaults());
  handle('amt:presets', () => bots.presets());
  handle('amt:save', (_e, cfg) => bots.save(cfg));
  handle('amt:remove', (_e, id) => bots.remove(id));
  handle('amt:start', (_e, id) => bots.start(id));
  handle('amt:stop', (_e, id, flatten) => bots.stop(id, { flatten: Boolean(flatten), reason: flatten ? 'stopped and flattened by you' : 'stopped by you' }));
  handle('amt:stopAll', () => bots.stopAll('kill switch'));
  handle('amt:snapshot', (_e, id) => bots.snapshot(id));
  handle('amt:events', (_e, id) => bots.eventsFor(id));
  handle('amt:backtest', (_e, params, venue, symbol, from) => bots.backtest(params, venue, symbol, from));
  handle('amt:train', (_e, params, venue, symbol, opts) => bots.train(params, venue, symbol, opts));
  handle('ccxt:subscribe', (e, sid, id, symbol) => {
    const wc = e.sender;
    ccxtSvc.subscribe(sid, id, symbol, (msg) => {
      if (!wc.isDestroyed()) wc.send('ccxt:event', { sid, ...msg });
      else ccxtSvc.unsubscribe(sid);
    });
    return true;
  });
  handle('ccxt:unsubscribe', (_e, sid) => ccxtSvc.unsubscribe(sid));

  // database
  handle('db:info', () => ({ ...db.info(), retentionDays: retentionDays() }));
  handle('db:record', (_e, venue, symbol, rows) => db.recordTrades(venue, symbol, rows));
  handle('db:query', (_e, venue, symbol, from, to) => db.queryTrades(venue, symbol, from, to));
  handle('db:stats', () => db.tradeStats());
  handle('db:prune', (_e, days) => db.pruneTrades(Date.now() - (days ?? retentionDays()) * DAY));
  handle('db:deleteInstrument', (_e, venue, symbol) => db.deleteInstrument(venue, symbol));
  handle('db:vacuum', () => db.vacuum());
  handle('db:setRetention', (_e, days) => db.set('retentionDays', Math.max(1, Math.min(365, Number(days) || 3))));
  handle('db:exportCsv', async (_e, venue, symbol) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: `${venue}-${symbol.replace(/[^\w.-]+/g, '_')}-trades.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    const rows = db.queryTrades(venue, symbol, 0, Date.now());
    writeFileSync(r.filePath, 'timestamp_ms,price,quantity,side\n' + rows.map((t) => `${t.time},${t.price},${t.qty},${t.side}`).join('\n'));
    return { path: r.filePath, rows: rows.length };
  });

  // wallets
  handle('wallet:connectPhantom', async () => {
    const r = await connectPhantom((url) => shell.openExternal(url));
    db.putWallet(r.address, 'solana', true);
    return r;
  });
  handle('wallet:watch', (_e, address) => {
    db.putWallet(address, 'solana', false);
    return true;
  });
  handle('wallet:list', () => db.listWallets());
  handle('wallet:remove', (_e, address) => db.deleteWallet(address));
  handle('wallet:balances', (_e, address, rpcSecretId) => {
    const url = rpcSecretId ? vault.reveal(rpcSecretId).fields.url : DEFAULT_RPC;
    return walletBalances(address, httpsOnly(url ?? DEFAULT_RPC));
  });
  handle('wallet:tokenInfo', (_e, mints) => tokenInfo(mints));
  handle('wallet:activity', (_e, address, rpcSecretId) => {
    const url = rpcSecretId ? vault.reveal(rpcSecretId).fields.url : DEFAULT_RPC;
    return recentActivity(address, httpsOnly(url ?? DEFAULT_RPC));
  });

  // telegram: the bot token never leaves the main process
  const tg = (id) => {
    const s = vault.reveal(id);
    if (s.kind !== 'telegram' || !s.fields.token) throw new Error('choose a Telegram bot key');
    return s;
  };
  let commands = null;
  let tgStatus = { price: 'No data yet', status: 'No data yet' };
  handle('telegram:me', (_e, id) => tgMe(tg(id).fields.token));
  handle('telegram:detect', async (_e, id) => {
    const s = tg(id);
    const wasRunning = commands;
    commands?.stop();
    try {
      const chat = await tgDetectChat(s.fields.token);
      vault.save({ id, label: s.label, kind: s.kind, exchange: null, fields: { chatId: chat.id } });
      return chat;
    } finally {
      if (wasRunning) startCommands(id);
    }
  });
  handle('telegram:send', (_e, id, html) => {
    const s = tg(id);
    return tgSendLong(s.fields.token, s.fields.chatId, html);
  });
  handle('telegram:sendPhoto', (_e, id, png, caption) => {
    const s = tg(id);
    return tgSendPhoto(s.fields.token, s.fields.chatId, new Uint8Array(png), caption);
  });
  handle('report:data', (_e, kind, venue, symbol) =>
    reportData({ db, vault, ccxt: ccxtSvc, wallets: { balances: walletBalances, tokenInfo }, defaultRpc: DEFAULT_RPC, solMint: SOL_MINT }, kind === 'weekly' ? 'weekly' : 'daily', { venue, symbol }),
  );
  function startCommands(id) {
    const s = tg(id);
    if (!s.fields.chatId) throw new Error('detect the chat first');
    commands = new TelegramCommands(s.fields.token, s.fields.chatId, () => tgStatus, fetch, (e) => console.warn('telegram', e?.message ?? e));
    void commands.run();
  }
  handle('telegram:commands', (_e, id) => {
    commands?.stop();
    commands = null;
    if (id) startCommands(id);
    return Boolean(commands);
  });
  handle('telegram:setStatus', (_e, snap) => {
    tgStatus = snap;
  });
}

app.whenReady().then(() => {
  log('info', 'electron ready');
  try {
    db = new Db(join(userDataDir, 'novus-ordo.sqlite'));
    vault = new Vault(db, safeStorage, join(userDataDir, 'vault.key'));
  } catch (e) {
    log('error', 'could not open the database', e);
    dialog.showErrorBox('Novus Ordo could not start', `The database in ${userDataDir} could not be opened:\n\n${e?.message ?? e}\n\nLog: ${logFile()}`);
    app.exit(1);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen', accelerator: 'F11' }] },
      { role: 'windowMenu' },
      {
        label: 'Help',
        submenu: [
          { label: 'Open log folder', click: () => void shell.openPath(join(userDataDir, 'logs')) },
          {
            label: safeMode ? 'Leave safe mode (use the GPU again)' : 'Restart in safe mode (no GPU)',
            click: () => {
              if (safeMode) leaveSafeMode();
              else relaunchSafe('chosen in the Help menu');
            },
          },
        ],
      },
    ]),
  );
  registerIpc();
  // the window first, everything heavy after it
  createWindow();
  log('info', 'window created');
  services = import('./ccxt-service.mjs')
    .then(async (m) => {
      await m.loadCcxt();
      ccxtSvc = new m.CcxtService(vault, { db, onClock: (name, diff) => log('warn', `${name}: PC clock is ${Math.round(diff)} ms off the exchange — signing with exchange time`) });
      bots = new BotManager({
        ccxt: ccxtSvc,
        db,
        makeWorker: () => new Worker(trainWorkerPath),
        emit: (ch, payload) => {
          for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(`amt:${ch}`, payload);
        },
      });
      log('info', 'exchange services ready');
    })
    .catch((e) => {
      log('error', 'exchange services failed to load', e);
      throw e;
    });
  // housekeeping once the app is up
  const prune = () => {
    try {
      const n = db.pruneTrades(Date.now() - retentionDays() * DAY);
      if (n) log('info', `pruned ${n} old trades`);
    } catch (e) {
      log('warn', 'prune failed', e);
    }
  };
  setTimeout(prune, 20_000);
  setInterval(prune, 3_600_000);
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('child-process-gone', (_e, d) => {
  log('error', `${d.type} process gone: ${d.reason} (exit ${d.exitCode})`);
  if (d.type === 'GPU' && d.reason !== 'clean-exit') relaunchSafe(`GPU process ${d.reason}`);
});

app.on('second-instance', () => {
  log('info', 'second launch — focusing the open window');
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  // bots need the app open; stop them before their streams go away
  void bots?.stopAll('app closed');
  ccxtSvc?.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => db?.close());

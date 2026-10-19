// Novus Ordo desktop shell (Electron main process).
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from './amt/bots.mjs';
import { CcxtService, listExchanges } from './ccxt-service.mjs';
import { Db } from './db.mjs';
import { connectPhantom } from './phantom.mjs';
import { DEFAULT_RPC, recentActivity, SOL_MINT, tokenInfo, walletBalances } from '../src/shared/solana.ts';
import { TelegramCommands, tgDetectChat, tgMe, tgSendLong, tgSendPhoto } from '../src/shared/telegram.ts';
import { reportData } from './reports.mjs';
import { AttemptGate, ledgerMatches, PUBLIC_CHANNELS } from '../src/shared/ledger.ts';
import { createHash } from 'node:crypto';
import { Vault } from './vault.mjs';

// bundled to dist-electron/main.mjs; app root is one level up
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const DAY = 86_400_000;

// NOVUS_USER_DATA relocates the database, vault and settings (tests, portable installs)
if (process.env.NOVUS_USER_DATA) app.setPath('userData', process.env.NOVUS_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let db;
let vault;
let ccxtSvc;
let bots;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    title: 'Novus Ordo — by Quincy Gininda',
    backgroundColor: '#4b5058',
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
  if (process.env.VITE_DEV_SERVER_URL) void win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void win.loadFile(join(root, 'dist', 'index.html'));
  win.on('closed', () => {
    win = null;
    ccxtSvc?.closeAll();
  });
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

function registerIpc() {
  const handle = (ch, fn) =>
    ipcMain.handle(ch, async (e, ...args) => {
      try {
        if (!unlocked && !PUBLIC_CHANNELS.has(ch)) throw new Error('Terminal is sealed — enter the ledger key');
        return { ok: true, value: await fn(e, ...args) };
      } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
      }
    });

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
    db: db.info(),
    vaultBackend: vault.backend,
    retentionDays: retentionDays(),
  }));
  handle('app:locked', () => !unlocked);
  handle('app:unlock', async (_e, code) => {
    attempts.check();
    const ok = await ledgerMatches(String(code ?? ''), (x) => createHash('sha256').update(x).digest('hex'));
    if (!ok) {
      attempts.fail();
      throw new Error(attempts.waitMs() ? `ACCESS DENIED — locked for ${Math.ceil(attempts.waitMs() / 1000)}s` : 'ACCESS DENIED');
    }
    attempts.success();
    unlocked = true;
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
  handle('vault:save', (_e, rec) => {
    const id = vault.save(rec);
    ccxtSvc.invalidate(id);
    return id;
  });
  handle('vault:remove', (_e, id) => {
    ccxtSvc.invalidate(id);
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
  handle('vault:test', (_e, id) => ccxtSvc.testKey(id));

  // ccxt
  let exchangesCache = null;
  handle('ccxt:exchanges', () => (exchangesCache ??= listExchanges()));
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
  handle('amt:save', (_e, cfg) => bots.save(cfg));
  handle('amt:remove', (_e, id) => bots.remove(id));
  handle('amt:start', (_e, id) => bots.start(id));
  handle('amt:stop', (_e, id, flatten) => bots.stop(id, { flatten: Boolean(flatten), reason: flatten ? 'stopped and flattened by you' : 'stopped by you' }));
  handle('amt:stopAll', () => bots.stopAll('kill switch'));
  handle('amt:snapshot', (_e, id) => bots.snapshot(id));
  handle('amt:events', (_e, id) => bots.eventsFor(id));
  handle('amt:backtest', (_e, params, venue, symbol, from) => bots.backtest(params, venue, symbol, from));
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
  const userData = app.getPath('userData');
  db = new Db(join(userData, 'novus-ordo.sqlite'));
  vault = new Vault(db, safeStorage, join(userData, 'vault.key'));
  ccxtSvc = new CcxtService(vault, { db });
  bots = new BotManager({
    ccxt: ccxtSvc,
    db,
    emit: (ch, payload) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(`amt:${ch}`, payload);
    },
  });
  db.pruneTrades(Date.now() - retentionDays() * DAY);
  setInterval(() => db.pruneTrades(Date.now() - retentionDays() * DAY), 3_600_000);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
      { role: 'windowMenu' },
    ]),
  );
  registerIpc();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
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

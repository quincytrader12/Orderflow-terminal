// Novus Ordo desktop shell (Electron main process).
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, powerMonitor, powerSaveBlocker, safeStorage, screen, shell } from 'electron';
import { card as tgCard, head as tgHead, note as tgNote } from '../src/shared/tgcard.ts';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotManager } from './amt/bots.mjs';
import { CryptoSwarm } from './cswarm/cswarm.mjs';
import { LabService } from './lab/lab.mjs';
import { CELLS, displayOf, Screens } from './windows.mjs';
import { Db, isLocked, openWithRetry } from './db.mjs';
import { connectPhantom } from './phantom.mjs';
import { DepositVerifier, proofAmount, proofSol } from './depositProof.mjs';
import { DEFAULT_RPC, recentActivity, SOL_MINT, tokenInfo, walletBalances } from '../src/shared/solana.ts';
import { TelegramCommands, tgDetectChat, tgMe, tgSendKeyboard as rawKeyboard, tgSendLong as rawLong, tgSendPhoto as rawPhoto } from '../src/shared/telegram.ts';
import { Delivery } from './care/delivery.mjs';

/** every Telegram message, recorded: did it arrive? (care/delivery.mjs) */
const delivery = new Delivery();
const tgSendLong = (token, chat, html) => delivery.track(html, () => rawLong(token, chat, html));
const tgSendPhoto = (token, chat, png, caption) => delivery.track(caption, () => rawPhoto(token, chat, png, caption));
const tgSendKeyboard = (token, chat, html, keyboard) => delivery.track(html, () => rawKeyboard(token, chat, html, keyboard));
import { parseSearch, searchUrl } from '../src/shared/xapi.ts';
import { AttemptGate, isLedgerRecord, ledgerMatches, makeLedger, PUBLIC_CHANNELS } from '../src/shared/ledger.ts';
import { createHash, randomBytes } from 'node:crypto';
import { fromBot, fromSwarm, TradeJournal } from './care/journal.mjs';
import { Care } from './care/care.mjs';
import { Approvals } from './care/approve.mjs';
import { Probation } from './care/probation.mjs';
import { Retuner } from './care/retune.mjs';
import { Remote } from './care/remote.mjs';
import { crashText, lastErrors, markRunning, markRestart, markStopped, wakeText } from './care/crash.mjs';
import { endStuck, onScreen, runningPid, waitForAck, writeAck } from './handover.mjs';
import { handleOf, startTopmostWatch } from './topmostWatch.mjs';
import { extrasFailedBefore, failedBefore, lastStart, splashHtml, startStartup } from './startup.mjs';
import { buildSpec } from '../src/lab/flow.ts';
import { testedStats } from '../src/lab/live.ts';
import { costsForTests, measureCosts } from './care/costs.mjs';
import { journalCsv, ratesFromChart, taxCsv, taxYearOf, taxYearRange } from './care/tax.mjs';
import { collectBackup, openBackup, passwordProblem, peekBackup, restoreBackup, sealBackup } from './care/backup.mjs';
import { YAHOO_HEADERS } from '../src/shared/yahoo.ts';
import { Vault } from './vault.mjs';
import { LIMIT_DEFAULTS, MemeTrader, MIN_SWEEP, rpcWithFallback } from './memetrade.mjs';
import { exportSecret, newKeypair, parseSecret } from './solana-tx.mjs';
import { Worker } from 'node:worker_threads';
import { initLog, log, logFile } from './log.mjs';
import { initialWindow, loadWindowState, MIN_H, MIN_W, saveWindowState } from './windowState.mjs';

// bundled to dist-electron/main.mjs; app root is one level up
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// training worker: bundled next to main.mjs and kept outside the asar archive
const trainWorkerPath = join(here, 'trainWorker.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const labWorkerPath = join(here, 'labWorker.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const farmWorkerPath = join(here, 'farmWorker.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
const dbWorkerPath = join(here, 'dbWorker.mjs').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);

// ---------- the database's heavy work, on a thread of its own ----------
// Deleting old trades and reading a chart's history can touch millions of rows: done on the main
// process they froze the whole app (and kept the database locked while it closed). They run on a
// worker with its own connection; the main process only does the small, quick reads and writes.
let dbw = null;
let dbwSeq = 0;
const dbwWaiting = new Map();
function dbTask(msg, timeoutMs = 10 * 60_000) {
  if (!dbw) {
    dbw = new Worker(dbWorkerPath, { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    dbw.on('message', (m) => {
      const w = dbwWaiting.get(m.id);
      if (!w) return;
      dbwWaiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error));
      else w.resolve(m);
    });
    const fail = (e) => {
      for (const w of dbwWaiting.values()) w.reject(e instanceof Error ? e : new Error(`database worker stopped (${e})`));
      dbwWaiting.clear();
      dbw = null;
    };
    dbw.on('error', fail);
    dbw.on('exit', (code) => code !== 0 && fail(code));
  }
  const id = ++dbwSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      dbwWaiting.delete(id);
      reject(new Error(`database task ${msg.type} timed out`));
    }, timeoutMs);
    dbwWaiting.set(id, { resolve, reject, timer });
    dbw.postMessage({ ...msg, id, file: db.file });
  });
}
/** a market's recorded trades as typed columns, read on the worker (on this thread, a page at a time, if the worker is unavailable) */
async function tradeColumns(venue, symbol, from, to, limit) {
  try {
    return (await dbTask({ type: 'columns', venue, symbol, from, to, limit })).cols;
  } catch (e) {
    log('warn', 'database worker unavailable — reading history on the main thread', e);
    return db.tradeColumns(venue, symbol, from, to, limit);
  }
}
let pruning = null;
/** delete trades older than the retention, in small chunks on the worker; one run at a time */
function pruneOld(days) {
  if (pruning) return pruning;
  const t0 = Date.now();
  pruning = dbTask({ type: 'prune', olderThan: Date.now() - days * DAY, skip: db.pendingMarkets() })
    .then((m) => {
      if (m.deleted) log('info', `pruned ${m.deleted} old trades in ${((Date.now() - t0) / 1000).toFixed(1)} s (on the database worker)`);
      return m.deleted;
    })
    .finally(() => (pruning = null));
  return pruning;
}
const DAY = 86_400_000;

// NOVUS_USER_DATA relocates the database, vault and settings (tests, portable installs)
if (process.env.NOVUS_USER_DATA) app.setPath('userData', process.env.NOVUS_USER_DATA);

const userDataDir = app.getPath('userData');
initLog(join(userDataDir, 'logs'));
log('info', `starting Novus Ordo ${app.getVersion()} on ${process.platform} ${process.arch}, electron ${process.versions.electron}`);
process.on('uncaughtException', (e) => {
  log('error', 'uncaught exception', e);
  try {
    care?.error('main', `An error in Novus Ordo's background engine: ${String(e?.message ?? e).slice(0, 200)} — it carries on.`);
  } catch {
    /* too early for messages */
  }
});
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
// the last start never got its window up (it froze or was closed on the way): this one runs without the graphics card
const prevStart = lastStart(userDataDir);
const autoSafe = failedBefore(prevStart) && !existsSync(SAFE_FLAG) && process.env.NOVUS_SAFE_MODE !== '0';
if (autoSafe) log('warn', `the last start never showed its window (it stopped at: ${prevStart.step}) — this start runs without the graphics card`);
// the last start froze while starting the extras: they are left off this time (tried again next time)
const skipExtras = extrasFailedBefore(prevStart);
if (skipExtras) log('warn', 'the last start froze while starting the extras (stay awake, sleep tracking, the topmost watcher) — they are left off this time');
const safeMode = process.argv.includes('--safe-mode') || process.env.NOVUS_SAFE_MODE === '1' || existsSync(SAFE_FLAG) || autoSafe;
if (safeMode) {
  app.disableHardwareAcceleration();
  log('warn', 'safe mode: hardware acceleration disabled');
}

/**
 * The graphics card keeps failing: you are asked (once a session) whether to restart without
 * it. Nothing is closed until you say so — an automatic restart closed every window, on every
 * screen, in the middle of whatever you were doing.
 */
let askedSafe = false;
function askSafeRestart(why) {
  if (safeMode || askedSafe) return;
  askedSafe = true;
  log('warn', `graphics trouble: ${why} — asking about a restart without the graphics card`);
  void dialog
    .showMessageBox({
      type: 'warning',
      title: 'Novus Ordo — graphics trouble',
      message: 'The graphics card keeps failing to draw Novus Ordo’s windows.',
      detail: 'Restart now without the graphics card (safe mode)? Everything is saved, the swarm and the bots carry on where they were, and open trades are not touched. Safe mode can be left again from the Help menu.\n\nNot now: Novus Ordo keeps going as it is, and starts in safe mode next time.',
      buttons: ['Restart now in safe mode', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then((r) => r.response === 0 && relaunchSafe(why))
    .catch(() => undefined);
}

/** after the graphics process came back: every window is drawn again, and one still blank is checked */
function repaintAll() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.invalidate();
    } catch {
      /* gone */
    }
  }
  setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.isVisible() && !w.isMinimized()) void checkBlank(w);
  }, 6000);
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
  markRestart(userDataDir, `safe mode: ${reason}`);
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portable ? { execPath: portable, args: [] } : undefined);
  app.exit(0);
}

/** Back to GPU rendering on the next start, which happens now. */
function leaveSafeMode() {
  rmSync(SAFE_FLAG, { force: true });
  log('info', 'leaving safe mode');
  markRestart(userDataDir, 'leaving safe mode');
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portable ? { execPath: portable, args: [] } : { args: process.argv.slice(1).filter((a) => a !== '--safe-mode') });
  app.exit(0);
}

/** the last session did not close properly (its marker was still there): told once the terminal is unlocked */
let unclean = null;
// when this copy asked (before the lock: the open copy may answer at once)
const askedAt = Date.now();
const primary = app.requestSingleInstanceLock();
if (!primary) {
  log('info', 'another copy is already running — asking it to show its window');
  void handOver();
} else {
  unclean = markRunning(userDataDir);
  // it restarted itself on purpose (safe mode, a restore): not a crash to report
  if (unclean?.restart) {
    log('info', `restarted by itself: ${unclean.restart}`);
    unclean = null;
  }
  if (unclean) log('warn', `the last session did not close properly (started ${new Date(unclean.t || 0).toISOString()})`);
}

let win = null;
/** start-up steps, the watchdog and the small "starting" window (startup.mjs) */
let boot = null;
let splash = null;
/** the extras that wait for the window to be on screen (stay awake, the topmost watcher, sleep tracking, the escape key) */
let afterShown = () => {};
let topWatch = { setHandles() {}, beat() {}, stop() {} };
/** a second copy asked for the window before it was on screen: answered once it is */
let pendingAck = false;
let db;
let vault;
let ccxtSvc;
let bots;
let cswarm;
let lab;
let screens = null;
let services = null;
/** every finished trade, kept for good (care/journal.mjs) */
let journal = null;
/** Novus Ordo looking after itself while you are away (care/care.mjs) */
let care = null;
/** how the main window is doing, for the "still alive" checks */
let screenState = 'ok';
/** ready teams offered on Telegram with Deploy buttons (care/approve.mjs) */
let approvals = null;
let probation = null;
let retuner = null;
/** the swarm from the phone: /positions, /pause, /resume, /stop, /start (care/remote.mjs) */
let remote = null;
/** start (or restart) the Telegram poller for the chosen bot: set once the IPC handlers exist */
let ensurePoller = () => {};

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
      // the crypto swarm's Telegram cards and alerts are drawn and sent from this window: keep its timers at full speed when minimised or covered
      backgroundThrottling: false,
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
  // no developer tools while the terminal is sealed
  w.webContents.on('devtools-opened', () => {
    if (!unlocked) w.webContents.closeDevTools();
  });
  const reveal = () => {
    if (!w.isDestroyed() && !w.isVisible()) {
      if (placed.maximized) w.maximize();
      if (placed.fullScreen) w.setFullScreen(true);
      w.show();
      log('info', 'window shown');
    }
    if (!w.isDestroyed() && w.isVisible() && boot && !boot.done) {
      boot.done = true;
      boot.shown();
      // a start without the graphics card that worked after one that did not: kept that way (Help menu to leave it)
      if (autoSafe)
        try {
          writeFileSync(SAFE_FLAG, JSON.stringify({ v: 2, reason: 'the window did not show with the graphics card', at: new Date().toISOString() }));
        } catch {
          /* the next start notices again */
        }
      if (splash && !splash.isDestroyed()) splash.destroy();
      splash = null;
      setTimeout(() => {
        try {
          afterShown();
        } catch (e) {
          log('warn', 'an extra could not start', e);
        }
      }, 500);
    }
    if (!w.isDestroyed() && pendingAck && w.isVisible()) {
      pendingAck = false;
      writeAck(userDataDir);
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
  wc.on('did-fail-load', (_e, code, desc, url, mainFrame) => {
    log('error', `page failed to load (${code} ${desc}) ${url}`);
    // the page itself (not a picture in it) failed: tried again once, a second later
    if (mainFrame !== false && code !== -3 && !w.__retried && !w.isDestroyed()) {
      w.__retried = true;
      setTimeout(() => {
        if (w.isDestroyed()) return;
        if (process.env.VITE_DEV_SERVER_URL) void w.loadURL(process.env.VITE_DEV_SERVER_URL);
        else void w.loadFile(join(root, 'dist', 'index.html')).catch((e) => log('error', 'loadFile failed again', e));
      }, 1000);
    }
  });
  wc.on('render-process-gone', (_e, d) => {
    log('error', `window renderer gone: ${d.reason} (exit ${d.exitCode})`);
    if (d.reason !== 'clean-exit') {
      screenState = 'gone';
      care?.error('renderer', `The terminal's window crashed (${d.reason}). It reloads by itself; trading carries on in the background.`);
    }
    if (d.reason !== 'clean-exit' && !w.isDestroyed()) {
      if ((w.__crashes = (w.__crashes ?? 0) + 1) <= 1) wc.reload();
      else relaunchSafe(`renderer ${d.reason}`);
    }
  });
  wc.on('unresponsive', () => {
    log('warn', 'window unresponsive');
    screenState = 'frozen';
    screens?.safety(30_000);
  });
  wc.on('responsive', () => {
    log('info', 'window responsive again');
    screenState = 'ok';
  });
  wc.on('did-finish-load', () => (screenState = 'ok'));
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
    screenState = 'gone';
    ccxtSvc?.closeAll();
    // the popped-out panels go with the terminal (and come back next time)
    if (screens) {
      screens.quitting = true;
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.close();
    }
  });
}

/**
 * The Telegram bot the background engine sends with (check-ins, warnings, health, offers): the
 * one you chose on the Telegram panel — and if that one is gone or has no chat, a Telegram key
 * that has one. It used to be set only when "Answer /price, /status, /help" was ticked, so with
 * that box off (the default) the background engine had no bot and sent nothing at all.
 */
function careBot(preferred) {
  const ok = (id) => {
    if (!id) return false;
    try {
      const s = vault.reveal(id);
      return s.kind === 'telegram' && !!s.fields.token && !!s.fields.chatId;
    } catch {
      return false;
    }
  };
  if (ok(preferred)) return preferred;
  if (ok(care?.cfg.secretId)) return care.cfg.secretId;
  const any = vault.list().find((r) => r.kind === 'telegram' && ok(r.id));
  return any?.id ?? preferred ?? care?.cfg.secretId ?? '';
}

/** point the background engine at the right bot (said in the log when it changes) */
function syncCareBot(preferred) {
  if (!care || !vault) return;
  const id = careBot(preferred);
  if (id && id !== care.cfg.secretId) {
    care.setConfig({ secretId: id });
    log('info', `background messages: sent with the Telegram bot "${(() => {
      try {
        return vault.reveal(id).label;
      } catch {
        return id;
      }
    })()}"`);
  }
  ensurePoller();
}

/**
 * Stay awake: while Novus Ordo is open the screen stays on and the computer does not sleep or
 * lock itself for being idle — it is left running for hours (the swarm, the bots, the edge
 * finder, the data). A plugged-in laptop can still sleep or switch its screen off and lock after
 * a few idle hours, and everything stopped with it. Closing Novus Ordo (the X) gives the
 * computer back its usual habits at once: Windows lets go of the request with the app.
 * On by default; the ☀ button in the top bar and Ctrl + Alt + A switch it off and on.
 */
let awakeId = null;
function stayAwake(on) {
  if (on && awakeId === null) {
    awakeId = powerSaveBlocker.start('prevent-display-sleep');
    log('info', 'stay awake: on — the screen stays on and the computer does not sleep while Novus Ordo is open');
  } else if (!on && awakeId !== null) {
    powerSaveBlocker.stop(awakeId);
    awakeId = null;
    log('info', 'stay awake: off — the computer sleeps and locks as usual');
  }
  const now = awakeId !== null;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('app:awake', now);
  return now;
}

/** the computer went to sleep (or woke): said in the log, and on the phone once it is back */
function sleptText(from, to) {
  const h = (to - from) / 3_600_000;
  const t = (x) => new Date(x).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return tgCard([
    tgHead('💤', 'The computer was asleep', `${t(from)} → ${t(to)} · ${h >= 1 ? `${h.toFixed(1)} hours` : `${Math.round(h * 60)} minutes`}`),
    'Novus Ordo was paused meanwhile: no trades taken, no data recorded, no strategies tested. It carries on now.',
    tgNote(awakeId !== null ? 'Stay awake was on, so something else put it to sleep: the lid closed, the battery ran low, or a Windows update or setting.' : 'Stay awake was off (☀ in the top bar, or Ctrl + Alt + A, turns it on).'),
  ]);
}

/** A window for one popped-out panel: the terminal's safety settings, its own page. */
function panelWindow(query, bounds) {
  const w = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 200,
    title: `${query.title} — Novus Ordo`,
    backgroundColor: '#000000',
    icon: join(root, 'build', 'icon.png'),
    autoHideMenuBar: true,
    // no Windows title bar: the panel's own slim bar (it hides itself while the window is tiled or full screen)
    // drags, minimises and closes it; Windows' own snapping still works
    frame: false,
    thickFrame: true,
    webPreferences: {
      preload: join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.VITE_DEV_SERVER_URL ?? '\0')) e.preventDefault();
  });
  w.webContents.on('devtools-opened', () => {
    if (!unlocked) w.webContents.closeDevTools();
  });
  if (process.env.VITE_DEV_SERVER_URL) void w.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${new URLSearchParams(query)}`);
  else void w.loadFile(join(root, 'dist', 'index.html'), { query }).catch((e) => log('error', 'panel window failed to load', e));
  // hung for 10 seconds (a graphics hiccup, a stuck page): its page is loaded again by itself
  let hung = null;
  w.webContents.on('unresponsive', () => {
    screens?.safety(30_000);
    clearTimeout(hung);
    hung = setTimeout(() => {
      if (w.isDestroyed()) return;
      log('warn', `a popped-out window (${query.title}) hung for 10 s: reloading it`);
      try {
        w.webContents.forcefullyCrashRenderer();
      } catch {
        /* already gone */
      }
      w.webContents.reload();
    }, 10_000);
  });
  w.webContents.on('responsive', () => clearTimeout(hung));
  w.on('closed', () => clearTimeout(hung));
  return w;
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
    if (strikes === 0) return void setTimeout(() => void checkBlank(w, 1), 5000);
    // still blank: its page is loaded again (never the whole app: that closed every window under you);
    // blank even after that: you are asked whether to restart without the graphics card
    if (strikes === 1 && !w.isDestroyed()) {
      log('warn', 'a window stayed blank: reloading its page');
      w.webContents.reload();
      setTimeout(() => void checkBlank(w, 2), 8000);
    } else askSafeRestart('a window stayed blank after reloading');
  } catch (e) {
    log('warn', 'render check failed', e);
  }
}

const httpsOnly = (url) => {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https URLs are allowed');
  return u.toString();
};

/** open Novus Ordo when you sign in to Windows (the portable copy starts itself from where it is, not from its temporary folder) */
function setAutoStart(on) {
  try {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: [] });
  } catch (err) {
    log('warn', 'could not change start with Windows', err);
  }
}

/** the exchange a key belongs to (the swarm's live venue) */
function venueOf(secretId) {
  try {
    return (secretId && db.getSecret(secretId)?.exchange) || 'hyperliquid';
  } catch {
    return 'hyperliquid';
  }
}

/**
 * Once unlocked: the crash report (if the last session did not close properly), and the crypto
 * swarm picks up where it left off — started again if it was running when Novus Ordo closed.
 */
let resumedOnce = false;
async function afterUnlockCare() {
  if (resumedOnce) return;
  resumedOnce = true;
  if (unclean) {
    const report = crashText({ lastSeen: db.get('care:lastSeenBefore') ?? null, errors: lastErrors(logFile()).filter((x) => x.t <= Date.now() && (!unclean.t || x.t >= unclean.t - 60_000)) });
    setTimeout(() => void care?.send(report, 'crash report'), 25_000).unref?.();
  }
  try {
    await services;
    if (care?.wanted.swarm && cswarm && !cswarm.running) {
      await cswarm.start();
      log('info', 'crypto swarm resumed after the restart');
      void care.send(`▶️ <b>The crypto swarm has resumed</b>\n${cswarm.mode === 'live' ? '<b>LIVE</b>' : 'paper'} · it was running when Novus Ordo closed${cswarm.holding ? '\n\n<i>Paused for new trades — /resume to trade.</i>' : ''}`, 'resumed');
    }
  } catch (err) {
    log('warn', 'could not resume the crypto swarm', err);
    care?.error('resume', `The crypto swarm was running before the restart but could not start again: ${String(err?.message ?? err).slice(0, 160)}. Start it from Novus Ordo or send /startswarm.`);
  }
}

function retentionDays() {
  return db.get('retentionDays') ?? 3;
}

// sealed until the ledger key is entered; only public market data flows before that
let unlocked = false;
let sealedAt = null;

/**
 * Seal the terminal: keys, trading and bot control are refused until the
 * ledger key is entered again; open windows go back to the lock screen and
 * developer tools close. Bots and market data keep running.
 */
function seal(reason) {
  if (!unlocked) return;
  unlocked = false;
  sealedAt = Date.now();
  log('info', `terminal sealed: ${reason}`);
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.closeDevTools();
    w.webContents.send('app:sealed', reason);
  }
  screens?.setVisible(false);
}
const attempts = new AttemptGate();
const sha256Hex = (x) => createHash('sha256').update(x).digest('hex');
/** The owner's own key (salted digest in the database), else the built-in one. */
const ledgerRecord = () => {
  const r = db.get('ledger');
  return isLedgerRecord(r) ? r : undefined;
};

// channels that need the exchange services, which load after the window is up
const NEEDS_SERVICES = /^(ccxt|trade|amt|cswarm|lab):|^vault:test$/;

function registerIpc() {
  // the swarm keeps trading behind the lock screen: its own trades, balances and Telegram updates only
  const SWARM_WHILE_SEALED = new Set(['swarm:buy', 'swarm:sell', 'swarm:sweep', 'swarm:balance', 'swarm:notify', 'swarm:notifyPhoto', 'solana:rpc', 'net:fetchImage']);
  const handle = (ch, fn) =>
    ipcMain.handle(ch, async (e, ...args) => {
      try {
        if (!unlocked && !PUBLIC_CHANNELS.has(ch) && !SWARM_WHILE_SEALED.has(ch)) throw new Error('Terminal is sealed — enter the ledger key');
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
    // the daily message, the warnings and the weekly report start once the ledger key has been entered —
    // with a bot that exists and has a chat (a key replaced or removed since is not left pointing nowhere)
    syncCareBot();
    care?.start();
    ensurePoller();
    void afterUnlockCare();
    // popped-out panels come back (and, the first time, the ones left open last session)
    if (screens) {
      screens.setVisible(true);
      setTimeout(() => screens?.restore(), 1500);
    }
    return true;
  });
  // lock again (renderer shows the lock screen); bots keep running in this process
  handle('app:seal', () => {
    seal('locked from the terminal');
    unlocked = false;
    return true;
  });
  // what the lock screen may show while sealed: counts only, nothing private
  handle('app:status', () => {
    const running = bots ? [...bots.running.values()] : [];
    return { locked: !unlocked, sealedAt, botsRunning: running.length, botsLive: running.filter((b) => b.cfg.mode === 'live').length };
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
  handle('amt:stopAll', async () => {
    // the kill switch stops the crypto swarm too (its positions keep their exchange stops)
    care?.setWanted('swarm', false);
    await cswarm?.stop().catch(() => undefined);
    return bots.stopAll('kill switch');
  });
  // the crypto swarm: agents trading perpetuals on Hyperliquid, its own account and record
  // windows and screens: pop panels out, send windows to any screen
  handle('screens:state', () => screens.state());
  handle('screens:popout', (_e, panel, title, config, displayId) => screens.popout(String(panel), String(title ?? panel), config ?? {}, displayId ?? null));
  handle('screens:move', (_e, id, displayId, mode) => screens.move(Number(id), Number(displayId), mode === 'full' || mode === 'float' ? mode : 'fill'));
  handle('screens:focus', (_e, id) => screens.focus(Number(id)));
  handle('screens:tile', (e, id, cell) => screens.tile(id === 'self' ? BrowserWindow.fromWebContents(e.sender)?.id : Number(id), ['full', ...CELLS].includes(cell) ? cell : 'full'));
  handle('screens:arrange', (e, displayId) => screens.arrange(displayId === 'self' ? displayOf(screen.getAllDisplays(), BrowserWindow.fromWebContents(e.sender).getBounds()).id : Number(displayId)));
  handle('screens:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  handle('screens:close', (_e, id) => screens.close(Number(id)));
  // a popped-out panel goes back to the terminal: its window closes and the main window opens the panel where it lives
  handle('screens:dock', (e, panel, title, config) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.send('screens:dock', { panel: String(panel), title: String(title ?? panel), config: config ?? {} });
      win.show();
      win.focus();
    }
    if (w && w !== win) w.close();
    return true;
  });
  handle('screens:self', (e) => BrowserWindow.fromWebContents(e.sender)?.id ?? null);
  // a popped-out window asks for the order-book history the terminal has recorded (relayed from the main window)
  const heatAsks = new Map();
  let heatSeq = 0;
  handle(
    'screens:heat-history',
    (e) =>
      new Promise((resolve) => {
        const w = win;
        if (!w || w.isDestroyed() || e.sender === w.webContents) return resolve(null);
        const id = ++heatSeq;
        const t = setTimeout(() => {
          heatAsks.delete(id);
          resolve(null);
        }, 4000);
        heatAsks.set(id, (d) => {
          clearTimeout(t);
          resolve(d);
        });
        w.webContents.send('screens:heat-ask', id);
      }),
  );
  ipcMain.on('screens:heat-reply', (e, id, d) => {
    if (win && e.sender !== win.webContents) return;
    heatAsks.get(id)?.(d);
    heatAsks.delete(id);
  });
  // the Strategy Lab: research runs, results, backtests and deployment
  handle('lab:state', () => lab.status());
  handle('lab:result', () => lab.result());
  handle('lab:config', (_e, patch) => lab.setConfig(patch ?? {}));
  handle('lab:run', (_e, patch) => lab.run(patch ?? {}));
  handle('lab:cancel', () => lab.cancel());
  handle('lab:test', (_e, spec, patch) => lab.test(spec, patch ?? {}));
  handle('lab:optimize', (_e, specs, patch) => lab.optimize(specs, patch ?? {}));
  handle('lab:farm-state', () => lab.farmState());
  handle('lab:farm-start', (_e, patch) => lab.farmStart(patch ?? {}));
  handle('lab:farm-stop', () => lab.farmStop(true));
  handle('lab:farm-pin', (_e, id, on) => lab.farmPin(String(id), Boolean(on)));
  handle('lab:farm-account', (_e, usd, zar) => lab.farmAccount(usd, zar));
  // candles from the Lab's own history cache (a year of hourly bars for the Quant desk's seasonality map)
  handle('lab:bars', async (_e, coin, tf, years) => {
    const c = String(coin ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    const t = ['1m', '5m', '15m', '1h', '4h', '1d'].includes(tf) ? tf : '1h';
    if (!c) throw new Error('no coin');
    return lab.candles(c, t, Math.max(0.1, Math.min(3, Number(years) || 1)), 'auto');
  });
  handle('lab:deploy', (_e, args, targets, coins) => lab.deploy(args ?? {}, targets, coins));
  handle('lab:undeploy', (_e, id) => lab.undeploy(String(id)));
  handle('lab:toggle', (_e, id, on) => lab.toggle(String(id), Boolean(on)));
  handle('lab:authority', (_e, id, a) => lab.setAuthority(String(id), a === 'tested' ? 'tested' : 'council'));
  handle('cswarm:state', () => cswarm.state());
  handle('cswarm:start', async () => {
    const r = await cswarm.start();
    care?.setWanted('swarm', true);
    return r;
  });
  handle('cswarm:stop', (_e, flatten) => {
    // stopped by you: not a warning
    care?.setWanted('swarm', false);
    return cswarm.stop({ flatten: Boolean(flatten) });
  });
  handle('cswarm:hold', (_e, on) => cswarm.hold(Boolean(on)));
  handle('cswarm:config', (_e, patch) => cswarm.setConfig(patch ?? {}));
  handle('cswarm:resetPaper', () => cswarm.resetPaper());
  handle('cswarm:mode', async (_e, mode, secretId) => {
    if (mode === 'live' && cswarm.mode !== 'live') {
      const c = cswarm.cfg;
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Trade live'],
        defaultId: 0,
        cancelId: 0,
        title: 'Crypto swarm — live',
        message: 'Let the crypto swarm trade futures on Hyperliquid on its own, with real USDC?',
        detail: `${c.coins.join(', ')} — each trade risks about ${c.risk.riskPct}% of the account (at most ${c.risk.maxRiskPct}%), at most ${c.risk.maxOpen} positions and ${c.risk.maxLeverage}× the account in all, isolated margin. It stops for the day after losing ${c.risk.dailyLossPct}%, and for good under its floor.\n\nFutures can be liquidated. Orders are placed without asking you each time, within the order cap in the ticket's ⚙ limits.`,
      });
      if (r.response !== 1) return cswarm.mode;
    }
    cswarm.setMode(mode, secretId ?? null);
    return cswarm.mode;
  });
  handle('amt:snapshot', (_e, id) => bots.snapshot(id));
  handle('amt:events', (_e, id) => bots.eventsFor(id));
  handle('amt:backtest', (_e, params, venue, symbol, from) => bots.backtest(params, venue, symbol, from));
  handle('amt:train', (_e, params, venue, symbol, opts) => bots.train(params, venue, symbol, opts));
  handle('amt:trendBacktest', (_e, params, exchangeId, symbol, fromYear) => bots.trendBacktest(params, exchangeId, symbol, fromYear));
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
  // live batches are small and quick here; a big one (a backfilled gap) is written on the database worker in chunks
  handle('db:record', (_e, venue, symbol, rows) => {
    if (!Array.isArray(rows) || rows.length <= 3000) return db.recordTrades(venue, symbol, rows ?? []);
    return dbTask({ type: 'record', venue, symbol, rows }).then(
      (m) => m.n,
      (e) => {
        log('warn', 'database worker unavailable — recording the batch here', e);
        return db.recordTrades(venue, symbol, rows);
      },
    );
  });
  // a chart's history: typed columns read on the database worker (no millions of objects on this thread or in the message)
  handle('db:query', (_e, venue, symbol, from, to) => tradeColumns(venue, symbol, from, to, 1_000_000));
  handle('db:stats', () => db.tradeStats());
  handle('db:prune', (_e, days) => pruneOld(days ?? retentionDays()));
  handle('db:deleteInstrument', (_e, venue, symbol) => db.deleteInstrument(venue, symbol));
  handle('db:vacuum', () => db.vacuum());
  handle('db:setRetention', (_e, days) => db.set('retentionDays', Math.max(1, Math.min(365, Number(days) || 3))));
  handle('db:exportCsv', async (_e, venue, symbol) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: `${venue}-${symbol.replace(/[^\w.-]+/g, '_')}-trades.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    const c = await tradeColumns(venue, symbol, 0, Date.now(), 20_000_000);
    const lines = ['timestamp_ms,price,quantity,side'];
    for (let i = 0; i < c.t.length; i++) lines.push(`${c.t[i]},${c.p[i]},${c.q[i]},${c.s[i] === 1 ? 'buy' : 'sell'}`);
    await writeFile(r.filePath, lines.join('\n'));
    return { path: r.filePath, rows: c.t.length };
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

  // meme scanner: read-only Solana RPC (the RPC url may hold an API key, so it stays here)
  const READ_RPC = new Set(['getAccountInfo', 'getTokenLargestAccounts', 'getMultipleAccounts', 'getTokenSupply', 'getBalance', 'getSignaturesForAddress', 'getSlot']);
  handle('solana:rpc', async (_e, method, params, rpcSecretId) => {
    if (!READ_RPC.has(method)) throw new Error(`RPC method not allowed: ${method}`);
    const url = httpsOnly((rpcSecretId ? vault.reveal(rpcSecretId).fields.url : DEFAULT_RPC) ?? DEFAULT_RPC);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: Array.isArray(params) ? params : [] }), signal: ctrl.signal });
      if (!res.ok) throw new Error(`RPC ${res.status} ${res.statusText}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error.message ?? 'RPC error');
      return j.result;
    } finally {
      clearTimeout(t);
    }
  });

  // meme swarm: its own trading wallet. The key lives in the vault and never
  // leaves this process; trades need the wallet armed, and stay inside the
  // limits kept here (per trade, per day, SOL kept for fees).
  /** JSON-RPC to one URL; failures to reach it, or refusals, are marked `transport` */
  const rpcAt = (url) => async (method, params) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    let res;
    try {
      res = await fetch(httpsOnly(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error(`RPC ${res.status} ${res.statusText}`), { transport: true });
      const j = await res.json();
      if (j.error) throw new Error(j.error.message ?? 'RPC error');
      return j.result;
    } catch (e) {
      if (!res) e.transport = true; // never reached it
      throw e;
    } finally {
      clearTimeout(t);
    }
  };
  let lastFallbackLog = 0;
  // the private RPC first (Helius, QuickNode…); when it refuses or cannot be reached, the public one
  const swarmRpc = (rpcSecretId) => {
    const own = rpcSecretId ? vault.reveal(rpcSecretId).fields.url : null;
    if (!own) return rpcAt(DEFAULT_RPC);
    return rpcWithFallback(rpcAt(own), rpcAt(DEFAULT_RPC), (e, method) => {
      if (Date.now() - lastFallbackLog < 60_000) return;
      lastFallbackLog = Date.now();
      log('warn', `swarm: your RPC refused ${method} (${e.message}) — using the public RPC meanwhile`);
    });
  };
  const swarmWalletId = () => db.get('swarmWallet') ?? null;
  const swarmKeypair = () => {
    const id = swarmWalletId();
    if (!id) throw new Error('no swarm trading wallet — create or import one first');
    return parseSecret(vault.reveal(id).fields.secret);
  };
  const swarmLimits = () => ({ ...LIMIT_DEFAULTS, ...(db.get('swarmLimits') ?? {}) });
  // the local calendar day, like the swarm's daily loss limit
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const swarmSpent = () => {
    const s = db.get('swarmSpent');
    return s?.day === today() ? Number(s.sol) || 0 : 0;
  };
  const swarmFlight = { sol: 0 };
  const trader = (rpcSecretId) =>
    new MemeTrader({
      flight: swarmFlight,
      wallet: swarmKeypair,
      rpc: swarmRpc(rpcSecretId),
      // quotes and swap transactions (Jupiter, PumpPortal): a hung request must not hold a buy — and its slot — forever
      http: (url, init) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20_000);
        return fetch(httpsOnly(url), { ...init, signal: ctrl.signal }).finally(() => clearTimeout(t));
      },
      limits: swarmLimits,
      spent: swarmSpent,
      addSpend: (sol) => db.set('swarmSpent', { day: today(), sol: swarmSpent() + sol }),
      log: (m) => log('info', `swarm: ${m}`),
    });
  /** The owner's Phantom wallet: the only address the swarm wallet ever sends SOL to. */
  const swarmHome = () => {
    const a = db.get('swarmHome');
    return a && db.listWallets().some((w) => w.address === a && w.verified) ? a : null;
  };
  handle('swarm:setHome', async (_e, address) => {
    if (address === null) {
      db.set('swarmHome', null);
      db.set('swarmLimits', { ...swarmLimits(), sweepAboveSol: 0 });
      return null;
    }
    if (!db.listWallets().some((w) => w.address === address && w.verified)) throw new Error('connect and verify this Phantom wallet first (Wallet panel → Connect Phantom)');
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'Use as home'],
      defaultId: 0,
      cancelId: 0,
      title: 'Home wallet',
      message: 'Send the swarm wallet’s withdrawals and profits to this Phantom wallet?',
      detail: `${address}\n\nThe swarm wallet can send SOL to this address only.`,
    });
    if (r.response !== 1) return swarmHome();
    db.set('swarmHome', address);
    return address;
  });
  // Phantom verified from the phone: a small exact deposit from it proves the address.
  // Started here (the computer asks to confirm), checked every 15 s for 30 minutes.
  const swarmAddress = () => {
    const id = swarmWalletId();
    if (!id) throw new Error('no swarm trading wallet — create or import one first');
    return vault.reveal(id).fields.address;
  };
  let proof = null;
  let proofTimer = null;
  const proofEvent = (msg) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('swarm:verified', msg);
  };
  const stopProof = () => {
    clearInterval(proofTimer);
    proofTimer = null;
    proof = null;
  };
  handle('swarm:verifyPhone', async (_e, rpcSecretId) => {
    const address = swarmAddress();
    const lamports = proofAmount((() => {
      const b = randomBytes(4);
      return () => b.readUInt32BE(0) / 2 ** 32;
    })());
    const sol = proofSol(lamports);
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Cancel', 'Start'],
      defaultId: 0,
      cancelId: 0,
      title: 'Verify Phantom from your phone',
      message: `From Phantom on your phone, send exactly ${sol} SOL to the swarm wallet within 30 minutes.`,
      detail: `${address}\n\nThe Phantom wallet that sends it becomes the swarm's home — the only address the swarm wallet ever sends SOL to. Send it from Phantom, not from Luno or another exchange. The ${sol} SOL stays in the swarm wallet.`,
    });
    if (r.response !== 1) return null;
    stopProof();
    proof = new DepositVerifier({ rpc: swarmRpc(rpcSecretId), address: swarmAddress });
    const p = proof.start(lamports);
    let busy = false;
    proofTimer = setInterval(async () => {
      if (busy || !proof) return;
      busy = true;
      try {
        const res = await proof.poll();
        if (!res) return;
        if (res.address) {
          db.putWallet(res.address, 'solana', true);
          db.set('swarmHome', res.address);
          log('info', `swarm: Phantom ${res.address} verified by a ${sol} SOL deposit — now home`);
        }
        stopProof();
        proofEvent(res);
      } catch (e) {
        log('warn', `swarm: phone verification check failed: ${e?.message ?? e}`);
      } finally {
        busy = false;
      }
    }, 15_000);
    return { sol, address, until: p.until };
  });
  handle('swarm:verifyCancel', () => {
    stopProof();
    return true;
  });
  handle('swarm:verifyState', () => (proof?.pending ? { sol: proofSol(proof.pending.lamports), address: swarmAddress(), until: proof.pending.until } : null));
  // by hand: an amount, or 'all' (the wallet emptied, fee reserve included)
  handle('swarm:withdraw', async (_e, sol, rpcSecretId) => {
    const home = swarmHome();
    if (!home) throw new Error('choose your Phantom wallet as home first');
    const what = sol === 'all' ? 'everything' : `${Number(sol)} SOL`;
    const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Send'], defaultId: 0, cancelId: 0, title: 'Send to Phantom', message: `Send ${what} from the swarm wallet to your Phantom?`, detail: home });
    if (r.response !== 1) return null;
    const res = await trader(rpcSecretId).send(home, sol === 'all' ? 'all' : Number(sol));
    log('info', `swarm sent ${res.sol} SOL home: ${res.signature}`);
    return res;
  });
  // automatic: profits over the amount kept, when switched on (works behind the lock screen)
  handle('swarm:sweep', async (_e, rpcSecretId) => {
    const home = swarmHome();
    if (!home) return null;
    const res = await trader(rpcSecretId).sweep(home);
    if (res) log('info', `swarm swept ${res.sol} SOL home: ${res.signature}`);
    return res;
  });
  const saveSwarmWallet = (kp, label) => {
    const id = vault.save({ id: swarmWalletId() ?? undefined, label, kind: 'solana-hot', exchange: null, fields: { secret: exportSecret(kp), address: kp.address } });
    db.set('swarmWallet', id);
    return kp.address;
  };
  handle('swarm:wallet', () => {
    const id = swarmWalletId();
    if (!id) return null;
    try {
      return { address: vault.reveal(id).fields.address, limits: swarmLimits(), spentToday: swarmSpent(), home: swarmHome() };
    } catch {
      return null;
    }
  });
  handle('swarm:walletCreate', () => {
    if (swarmWalletId()) throw new Error('a swarm wallet already exists');
    return saveSwarmWallet(newKeypair(), 'Swarm trading wallet');
  });
  handle('swarm:walletImport', (_e, secret) => {
    if (swarmWalletId()) throw new Error('remove the current swarm wallet first');
    return saveSwarmWallet(parseSecret(secret), 'Swarm trading wallet (imported)');
  });
  handle('swarm:walletExport', async () => {
    const kp = swarmKeypair();
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Copy private key'],
      defaultId: 0,
      cancelId: 0,
      title: 'Export the swarm wallet',
      message: 'Copy the swarm wallet’s private key to the clipboard?',
      detail: 'Anyone with this key controls the wallet. Paste it straight into Phantom (Add account → Import private key); the clipboard is cleared after 60 seconds.',
    });
    if (r.response !== 1) return false;
    const secret = exportSecret(kp);
    clipboard.writeText(secret);
    setTimeout(() => clipboard.readText() === secret && clipboard.clear(), 60_000);
    return true;
  });
  handle('swarm:walletRemove', async () => {
    const id = swarmWalletId();
    if (!id) return true;
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      title: 'Remove the swarm wallet',
      message: 'Remove the swarm wallet from this computer?',
      detail: 'Export its private key first if it still holds funds — without the key they cannot be recovered.',
    });
    if (r.response !== 1) return false;
    vault.remove(id);
    db.set('swarmWallet', null);
    db.set('swarmLimits', { ...swarmLimits(), armed: false });
    return true;
  });
  handle('swarm:setLimits', async (_e, p) => {
    const cur = swarmLimits();
    const next = { ...cur };
    for (const k of ['maxBuySol', 'dailySpendSol', 'reserveSol', 'slippageBps', 'priorityLamports']) if (Number.isFinite(Number(p?.[k])) && Number(p[k]) >= 0) next[k] = Number(p[k]);
    // profits home: off at 0; switching it on (or raising nothing to something) asks first
    if (p && 'sweepAboveSol' in p) {
      const v = Number(p.sweepAboveSol);
      if (!(v > 0)) next.sweepAboveSol = 0;
      else {
        const home = swarmHome();
        if (!home) throw new Error('choose your Phantom wallet as home first');
        const keep = Math.max(v, next.reserveSol);
        if (!(cur.sweepAboveSol > 0)) {
          const r = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Cancel', 'Send profits home'],
            defaultId: 0,
            cancelId: 0,
            title: 'Profits to Phantom',
            message: `Send everything over ${keep} SOL in the swarm wallet to your Phantom automatically?`,
            detail: `To ${home} only — your Phantom wallet, verified when you connected it. Checked every half minute; at least ${MIN_SWEEP} SOL at a time.`,
          });
          if (r.response !== 1) return cur;
        }
        next.sweepAboveSol = keep;
      }
    }
    if (p?.armed === false) next.armed = false;
    if (p?.armed === true && !cur.armed) {
      const address = swarmKeypair().address;
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Trade live'],
        defaultId: 0,
        cancelId: 0,
        title: 'Live trading',
        message: 'Let the swarm buy and sell meme coins on its own, with real SOL?',
        detail: `Wallet ${address}
Up to ${next.maxBuySol} SOL a trade and ${next.dailySpendSol} SOL a day; ${next.reserveSol} SOL kept for fees.

Trades are signed here without asking you each time. Most meme coins go to zero — only fund this wallet with what you can afford to lose.`,
      });
      if (r.response !== 1) return cur;
      next.armed = true;
    }
    db.set('swarmLimits', next);
    log('info', `swarm limits: ${JSON.stringify(next)}`);
    return next;
  });
  handle('swarm:balance', async (_e, rpcSecretId) => ({ sol: await trader(rpcSecretId).solBalance(), spentToday: swarmSpent(), limits: swarmLimits() }));
  handle('swarm:buy', async (_e, mint, sol, rpcSecretId) => {
    const r = await trader(rpcSecretId).buy(String(mint), Number(sol));
    log('info', `swarm bought ${mint} for ${sol} SOL via ${r.via}: ${r.signature}`);
    return r;
  });
  handle('swarm:sell', async (_e, mint, raw, rpcSecretId) => {
    const r = await trader(rpcSecretId).sell(String(mint), raw === 'all' ? 'all' : String(raw));
    log('info', `swarm sold ${mint} via ${r.via}: ${r.signature}`);
    return r;
  });
  handle('swarm:notify', (_e, id, html) => {
    const s = tg(id);
    return tgSendLong(s.fields.token, s.fields.chatId, html);
  });
  handle('swarm:notifyPhoto', (_e, id, png, caption) => {
    const s = tg(id);
    return tgSendPhoto(s.fields.token, s.fields.chatId, new Uint8Array(png), caption);
  });
  // coin logos for the Telegram pictures (as data, so drawing them keeps the canvas exportable)
  handle('net:fetchImage', async (_e, url) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(httpsOnly(url), { signal: ctrl.signal });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !/^image\//.test(type)) throw new Error('not an image');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 3_000_000) throw new Error('image too large');
      return `data:${type};base64,${buf.toString('base64')}`;
    } finally {
      clearTimeout(t);
    }
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

  // X (Twitter) recent search for the Herald: the bearer token never leaves the main process
  handle('x:search', async (_e, id, query, max) => {
    const s = vault.reveal(id);
    if (s.kind !== 'x-api' || !s.fields.token) throw new Error('choose an X API key (Connect → X)');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(searchUrl(String(query).slice(0, 500), Number(max) || 10), { headers: { Authorization: `Bearer ${s.fields.token}` }, signal: ctrl.signal });
      if (res.status === 429) throw new Error('X rate limit reached — the Herald waits');
      if (res.status === 401) throw new Error('X rejected the key — check it under Connect → X');
      if (res.status === 402 || res.status === 403) throw new Error(`X refused the search (${res.status}) — the X developer account may be out of credits`);
      if (!res.ok) throw new Error(`X search failed (${res.status})`);
      return parseSearch(await res.json());
    } finally {
      clearTimeout(t);
    }
  });
  handle('telegram:detect', async (_e, id) => {
    const s = tg(id);
    // one reader of the bot's messages at a time: the poller pauses while the chat is detected
    commands?.stop();
    commands = null;
    commandsFor = '';
    try {
      const chat = await tgDetectChat(s.fields.token);
      vault.save({ id, label: s.label, kind: s.kind, exchange: null, fields: { chatId: chat.id } });
      return chat;
    } finally {
      ensurePoller();
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
  // /wallet: the swarm wallet's address, to paste into Phantom (answered in the configured chat only)
  const walletReply = () => {
    try {
      const a = swarmAddress();
      const home = swarmHome();
      return `<b>Swarm wallet</b> — tap the address to copy it, then in Phantom: Send → Solana → paste.\n\n<code>${a}</code>\n\nSolana network only. Send a small test first.${home ? `\nProfits go home to ${home.slice(0, 4)}…${home.slice(-4)}.` : ''}`;
    } catch {
      return 'No swarm wallet yet — create one in Novus Ordo (Wallet).';
    }
  };
  // one poller reads the bot's messages: it answers /teams and the Deploy buttons always (from your chat only),
  // and /price, /status and /wallet when the Telegram panel's tick-box says so
  let basicsOn = false;
  let commandsFor = '';
  ensurePoller = () => {
    const id = care?.running ? care.cfg.secretId : '';
    let s = null;
    try {
      if (id) s = tg(id);
    } catch {
      s = null;
    }
    const chat = s?.fields.chatId;
    if (!chat) {
      commands?.stop();
      commands = null;
      commandsFor = '';
      return;
    }
    const sig = `${id}:${chat}`;
    if (commands && commandsFor === sig) return;
    commands?.stop();
    commandsFor = sig;
    commands = new TelegramCommands(s.fields.token, chat, () => ({ ...tgStatus, wallet: walletReply() }), fetch, (e) => console.warn('telegram', e?.message ?? e), {
      answerBasics: () => basicsOn,
      command: async (cmd) => (cmd === '/teams' ? approvals.pool() : cmd === '/stars' ? approvals.starPool() : remote.command(cmd)),
      callback: (data) => (String(data).startsWith('rc:') ? remote.tap(data) : String(data).startsWith('pb:') ? probation.tap(data) : String(data).startsWith('rt:') ? retuner.tap(data) : approvals.tap(data)),
    });
    void commands.run();
  };
  // every three hours: the monthly re-tuner checks one overdue deployed strategy in the Lab's worker (only while the Lab is idle)
  setInterval(async () => {
    if (!care?.running || !lab || !retuner) return;
    try {
      const r = await retuner.check();
      if (!r) return;
      const s = vault.reveal(care.cfg.secretId);
      if (s.kind === 'telegram' && s.fields.token && s.fields.chatId) await tgSendKeyboard(s.fields.token, s.fields.chatId, r.html, r.keyboard);
    } catch (err) {
      log('warn', `re-tuner: ${err?.message ?? err}`);
    }
  }, 3 * 3_600_000).unref?.();
  // every five minutes: a team that has become ready is offered on the phone, with its Deploy buttons
  setInterval(async () => {
    if (!care?.running || care.cfg.offers === false || !commands || !lab) return;
    try {
      const s = tg(care.cfg.secretId);
      for (const r of approvals.check()) await (r.keyboard?.length ? tgSendKeyboard(s.fields.token, s.fields.chatId, r.html, r.keyboard) : tgSendLong(s.fields.token, s.fields.chatId, r.html));
    } catch (err) {
      log('warn', `team offer: ${err?.message ?? err}`);
    }
  }, 5 * 60_000).unref?.();
  handle('telegram:commands', (_e, id) => {
    basicsOn = Boolean(id);
    if (id) syncCareBot(id);
    else ensurePoller();
    return basicsOn;
  });
  // the bot chosen on the Telegram panel: the background engine sends with it too
  handle('care:bot', (_e, id) => {
    syncCareBot(id ? String(id) : null);
    return care.status();
  });
  handle('telegram:setStatus', (_e, snap) => {
    tgStatus = snap;
  });

  // ---- while you are away: the daily message, warnings, the weekly report, strategy health, real costs ----
  handle('care:status', () => care.status());
  // stay awake: on, off, or asked
  handle('app:stayAwake', (_e, on) => {
    if (typeof on === 'boolean') {
      db.set('stayAwake', on);
      return stayAwake(on);
    }
    return awakeId !== null;
  });
  handle('app:autoStart', (_e, on) => {
    if (typeof on === 'boolean') {
      db.set('autoStart', on);
      setAutoStart(on);
    }
    return { on: db.get('autoStart') === true, supported: process.platform !== 'linux', packaged: app.isPackaged };
  });
  handle('care:config', (_e, patch) => {
    const { secretId, ...rest } = patch ?? {};
    const st = care.setConfig(rest);
    if (secretId !== undefined) syncCareBot(secretId);
    else ensurePoller();
    return secretId !== undefined ? care.status() : st;
  });
  handle('care:sendNow', async (_e, kind) => {
    if (!care.cfg.secretId) throw new Error('choose the Telegram bot first (Telegram panel)');
    if (!(await care.sendNow(kind === 'weekly' ? 'weekly' : 'daily'))) throw new Error('could not send — check the Telegram bot and its chat on the Telegram panel');
    return true;
  });
  handle('care:health', async () => {
    await services;
    return care.health();
  });
  handle('care:costs', () => care.costs());

  // ---- the trade journal and the tax export ----
  handle('journal:list', (_e, q) => journal.list({ ...(q ?? {}), limit: Math.min(5000, Number(q?.limit) || 2000) }));
  handle('journal:note', (_e, id, note) => journal.setNote(id, note));
  handle('journal:taxYears', () => {
    const rows = journal.list({ mode: 'live', limit: 1e6 });
    const ys = new Set(rows.map((r) => taxYearOf(r.closed)));
    ys.add(taxYearOf(Date.now()));
    return [...ys].sort((a, b) => b - a);
  });
  handle('journal:export', async (e) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? win;
    const r = await dialog.showSaveDialog(parent, { title: 'Save the trade journal', defaultPath: `novus-ordo-journal-${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'Spreadsheet (CSV)', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, journalCsv(journal.list({ limit: 1e6 })));
    return r.filePath;
  });
  handle('journal:tax', async (e, year0) => {
    const year = Math.round(Number(year0)) || taxYearOf(Date.now());
    const [from, to] = taxYearRange(year);
    // the dollar in rands, day by day, from Yahoo Finance (kept, so a second export needs no download)
    const rates = db.get('fx:USDZAR') ?? {};
    let fxError = '';
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/ZAR=X?period1=${Math.floor(from / 1000) - 14 * 86400}&period2=${Math.min(Math.floor(to / 1000), Math.floor(Date.now() / 1000)) + 86400}&interval=1d`, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Yahoo Finance answered ${res.status}`);
      Object.assign(rates, ratesFromChart(await res.json()));
      db.set('fx:USDZAR', rates);
    } catch (err) {
      fxError = String(err?.message ?? err);
    }
    const out = taxCsv(journal.list({ mode: 'live', from, to, limit: 1e6 }), rates, year);
    const parent = BrowserWindow.fromWebContents(e.sender) ?? win;
    const r = await dialog.showSaveDialog(parent, { title: `Save the ${year - 1}/${String(year).slice(2)} tax-year export`, defaultPath: `novus-ordo-tax-${year - 1}-${String(year).slice(2)}.csv`, filters: [{ name: 'Spreadsheet (CSV)', extensions: ['csv'] }] });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, out.csv);
    return { path: r.filePath, trades: out.trades, totals: out.totals, missingRates: out.missingRates, fxError };
  });

  // ---- backups ----
  const labDir = () => join(app.getPath('userData'), 'lab');
  handle('backup:create', async (e, password, storage) => {
    const why = passwordProblem(password);
    if (why) throw new Error(why);
    await services;
    const files = {};
    try {
      for (const f of readdirSync(labDir())) if (f.endsWith('.json')) files[f] = JSON.parse(readFileSync(join(labDir(), f), 'utf8'));
    } catch {
      /* no Lab files yet */
    }
    // the swarm's latest book, written before it is read
    cswarm?.persist();
    const { contents, summary } = collectBackup({ sql: db.db, vault, journal, labFiles: files, storage: storage && typeof storage === 'object' ? storage : {} });
    const parent = BrowserWindow.fromWebContents(e.sender) ?? win;
    const r = await dialog.showSaveDialog(parent, { title: 'Save the backup', defaultPath: `novus-ordo-backup-${new Date().toISOString().slice(0, 10)}.novus`, filters: [{ name: 'Novus Ordo backup', extensions: ['novus'] }] });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, sealBackup(contents, password, { app: app.getVersion(), summary }));
    log('info', `backup saved (${summary.keys} keys, ${summary.trades} trades)`);
    return { path: r.filePath, summary };
  });
  handle('backup:restore', async (e, password) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? win;
    const pick = await dialog.showOpenDialog(parent, { title: 'Choose a backup to restore', properties: ['openFile'], filters: [{ name: 'Novus Ordo backup', extensions: ['novus'] }] });
    if (pick.canceled || !pick.filePaths[0]) return null;
    const text = readFileSync(pick.filePaths[0], 'utf8');
    const head = peekBackup(text);
    const { contents } = openBackup(text, password);
    const sum = head.summary ?? {};
    const ok = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['Cancel', 'Restore and restart'],
      defaultId: 0,
      cancelId: 0,
      title: 'Restore a backup',
      message: `Restore the backup from ${new Date(head.created).toLocaleString()}?`,
      detail: `It holds ${sum.keys ?? '?'} keys, ${sum.trades ?? '?'} journal trades and ${sum.strategies ?? '?'} deployed strategies.\n\nThe crypto swarm, the bots and the edge finder stop first (open live trades keep their exchange stops). Your settings, keys, strategies and the swarm's book are replaced by the backup's; trades in the journal are added to. Novus Ordo then restarts — the ledger key is the one in the backup.`,
    });
    if (ok.response !== 1) return null;
    care?.stop();
    care?.setWanted('swarm', false);
    await cswarm?.stop().catch(() => undefined);
    await bots?.stopAll('restoring a backup').catch?.(() => undefined);
    lab?.shutdownFarm();
    const r = restoreBackup(contents, { sql: db.db, vault, journal, writeLab: (name, v) => writeFileSync(join(labDir(), name), JSON.stringify(v)) });
    // the swarm is stopped now: after the restart that is not a warning (start it again when you are ready)
    care?.setWanted('swarm', false);
    log('info', `backup restored (${r.keys} keys, ${r.kv} settings, ${r.trades} trades added, ${r.files} Lab files)`);
    return { storage: r.storage, keys: r.keys, trades: r.trades };
  });
  handle('app:restart', () => {
    markRestart(userDataDir, 'restart asked for');
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    app.relaunch(portable ? { execPath: portable, args: [] } : { args: process.argv.slice(1) });
    setTimeout(() => app.exit(0), 300);
    return true;
  });
}

app.whenReady().then(async () => {
  if (!primary) return;
  log('info', 'electron ready');
  boot = startStartup(userDataDir, logFile(), log);
  try {
    splash = new BrowserWindow({ width: 460, height: 170, frame: false, resizable: false, movable: true, show: true, center: true, backgroundColor: '#050505', title: 'Novus Ordo — starting', icon: join(root, 'build', 'icon.png'), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
    void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml('opening your data', safeMode))}`).catch(() => undefined);
  } catch (e) {
    log('warn', 'could not show the starting window', e);
  }
  const say = (name, words) => {
    boot.step(name);
    if (splash && !splash.isDestroyed()) void splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(words, safeMode))}`).catch(() => undefined);
  };
  say('database', 'opening your data');
  // checks only: the main thread held up here for a while, as a frozen start would be (e2e/startup.mjs)
  if (Number(process.env.NOVUS_TEST_FREEZE_MS) > 0) {
    const until = Date.now() + Number(process.env.NOVUS_TEST_FREEZE_MS);
    await new Promise((r) => setTimeout(r, 1500));
    while (Date.now() < until) {
      /* frozen on purpose */
    }
  }
  try {
    // a previous session still closing (or a backup / antivirus scan) can hold the file for a moment: wait it out
    db = await openWithRetry(() => new Db(join(userDataDir, 'novus-ordo.sqlite')), { onWait: (n) => n === 1 && log('warn', 'the database is busy — waiting for the previous session (or a scan) to let go of it') });
    vault = new Vault(db, safeStorage, join(userDataDir, 'vault.key'));
  } catch (e) {
    log('error', 'could not open the database', e);
    if (isLocked(e)) {
      // still locked after 30 s: another copy is running (or stuck); say what to do, and offer to try again
      const pick = dialog.showMessageBoxSync({
        type: 'warning',
        title: 'Novus Ordo is already open',
        message: 'Another copy of Novus Ordo is still running, or still closing.',
        detail: `Your data is safe — nothing has been changed.\n\nTo fix it:\n1. Press Ctrl + Shift + Esc to open Task Manager.\n2. End every task called "Novus Ordo".\n3. Press Try again.\n\nIf that does not help, restart the computer.\n\nLog: ${logFile()}`,
        buttons: ['Try again', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (pick === 0) {
        markRestart(userDataDir, 'database busy — trying again');
        const portable = process.env.PORTABLE_EXECUTABLE_FILE;
        app.relaunch(portable ? { execPath: portable, args: [] } : { args: process.argv.slice(1) });
      } else markStopped(userDataDir);
      app.exit(0);
      return;
    }
    dialog.showErrorBox('Novus Ordo could not start', `The database in ${userDataDir} could not be opened:\n\n${e?.message ?? e}\n\nLog: ${logFile()}`);
    app.exit(1);
    return;
  }
  say('background engine', 'starting the background engine');
  journal = new TradeJournal(db.db);
  delivery.attach(db);
  care = new Care({
    db,
    journal,
    send: (id, html) => {
      const s = vault.reveal(id);
      if (s.kind !== 'telegram' || !s.fields.token) return delivery.track(html, () => Promise.reject(new Error('choose a Telegram bot key')));
      if (!s.fields.chatId) return delivery.track(html, () => Promise.reject(new Error('No chat id yet — the Telegram bot has no chat; detect it on the Telegram panel')));
      return tgSendLong(s.fields.token, s.fields.chatId, html);
    },
    swarm: () => cswarm?.state() ?? null,
    lab: () => (lab ? { farm: lab.farmState(), deployed: lab.deployedList.map((d) => ({ id: d.id, name: d.spec.name, stats: d.stats, deployedAt: d.deployedAt, on: d.on })), labBook: cswarm?.labBook ?? {} } : null),
    bots: () => (bots ? bots.list().map((b) => ({ name: b.name, mode: b.mode, running: b.running, feed: b.feed })) : []),
    screen: () => screenState,
    delivery: () => delivery.state(),
    assumedCosts: () => ({ feeBps: lab?.cfg.feeBps ?? 4.5, slipBps: lab?.cfg.slipBps ?? 2 }),
    log,
    // probation and the automatic pause, after each 30-minute health check
    onHealth: async (hs) => {
      if (!probation) return [];
      const { messages, handled } = probation.review(hs);
      for (const m of messages) {
        try {
          const s = vault.reveal(care.cfg.secretId);
          if (m.keyboard && s.kind === 'telegram' && s.fields.token && s.fields.chatId) await tgSendKeyboard(s.fields.token, s.fields.chatId, m.html, m.keyboard);
          else await care.send(m.html, 'probation');
        } catch (err) {
          log('warn', `probation message: ${err?.message ?? err}`);
        }
      }
      return handled;
    },
  });
  probation = new Probation({ db, lab: () => lab });
  retuner = new Retuner({ db, lab: () => lab, log });
  approvals = new Approvals({
    db,
    teams: () => lab?.farmState().teams ?? [],
    deployed: () => (lab ? lab.deployedList.map((d) => d.spec.name) : []),
    // deploying from the phone: the same as the edge finder's Deploy the team, one member at a time
    deploy: async (m, authority) => {
      await services;
      const built = buildSpec(m.flow);
      lab.deploy({ spec: { ...built.spec, name: m.name }, tfH: m.tfH, stats: { sharpe: m.oos.sharpe, t: m.oos.t, dsr: m.dsr, trades: m.oos.trades, ...testedStats(m.oos, m.tfH), verdict: `edge finder · ${m.via === 'star' ? 'star (over 200 % a year)' : 'team'} · ${m.stage} · from your phone` }, authority }, { crypto: true, meme: false }, m.coins);
      log('info', `deployed "${m.name}" from Telegram (${authority})`);
    },
    swarm: () => (cswarm ? { running: cswarm.running, mode: cswarm.mode } : null),
    waiting: () => lab?.farmState().teamWait ?? [],
    // proven on fresh data and over 200 % a year: offered one by one
    stars: () => lab?.farmState().stars ?? [],
    // too wide for your account: told about once, never offered
    held: () => lab?.farmState().starsHeld ?? [],
  });
  remote = new Remote({ db, swarm: () => cswarm, bots: () => bots, wanted: (on) => care?.setWanted('swarm', on) });
  // when this computer last saw Novus Ordo running (for the crash report), and — if you asked for it —
  // a fixed message that it has started and waits for the ledger key (nothing private in it)
  {
    const lastSeen = db.get('care:lastSeen') ?? null;
    db.set('care:lastSeenBefore', lastSeen);
    const off = lastSeen ? Date.now() - lastSeen : 0;
    if (care.cfg.wakeNotice !== false && care.cfg.secretId && (unclean || off > 10 * 60_000))
      setTimeout(() => {
        if (!unlocked) void care.send(wakeText({ unclean: !!unclean, offSince: lastSeen }), 'waiting for the key');
      }, 20_000).unref?.();
  }
  // start with Windows (a setting; on by default the first time, for the installed app)
  if (app.isPackaged && process.platform !== 'linux' && db.get('autoStart') === undefined) {
    db.set('autoStart', true);
    setAutoStart(true);
  } else if (app.isPackaged && process.platform !== 'linux' && db.get('autoStart')) {
    // pointed at this copy each start: moving from the portable file to the installed app must not leave
    // Windows starting the slow portable one (it unpacks itself on every start)
    setAutoStart(true);
  }
  say('menus and messages', 'getting the menus ready');
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen', accelerator: 'F11' }] },
      { role: 'windowMenu' },
      {
        label: 'Power',
        submenu: [
          {
            label: 'Keep the computer awake while Novus Ordo is open',
            accelerator: 'CommandOrControl+Alt+A',
            click: () => {
              const on = awakeId === null;
              db.set('stayAwake', on);
              stayAwake(on);
            },
          },
        ],
      },
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
  say('main window', 'opening the terminal');
  createWindow();
  say('page', 'drawing the terminal');
  // the extras wait for the window to be on screen: if one of them ever held the app up, the terminal is already there
  afterShown = () => {
    // a way out that always works while Novus Ordo is alive, whatever its windows look like (blank, on every screen):
    // Ctrl + Alt + Shift + Q closes it at once (open trades stay on the exchange with their stops) — set up first
    try {
      globalShortcut.register('CommandOrControl+Alt+Shift+Q', () => {
        log('warn', 'closed at once with Ctrl + Alt + Shift + Q');
        markStopped(userDataDir);
        app.exit(0);
      });
    } catch (e) {
      log('warn', 'could not set up Ctrl + Alt + Shift + Q', e);
    }
    if (skipExtras) {
      boot.step('running');
      return;
    }
    boot.step('extras');
    try {
      stayAwake(db.get('stayAwake') !== false);
    } catch (e) {
      log('warn', 'stay awake could not start', e);
    }
    try {
      watchPower();
    } catch (e) {
      log('warn', 'sleep tracking could not start', e);
    }
    try {
      // tiles above the taskbar are watched from outside: if Novus Ordo ever stops answering, they are taken down for it
      topWatch = startTopmostWatch(log);
    } catch (e) {
      log('warn', 'the topmost watcher could not start', e);
    }
    log('info', 'start-up: extras running (stay awake, sleep tracking, topmost watcher, Ctrl + Alt + Shift + Q)');
    // a few seconds later, still answering: the extras are fine (a start that froze here is noticed by the next one)
    setTimeout(() => boot.step('running'), 5000);
  };
  let sleptAt = 0;
  const watchPower = () => {
    powerMonitor.on('suspend', () => {
      sleptAt = Date.now();
      log('warn', `the computer is going to sleep${awakeId !== null ? ' (stay awake was on: the lid, the battery or Windows put it to sleep)' : ''}`);
    });
    powerMonitor.on('resume', () => {
      const from = sleptAt;
      sleptAt = 0;
      log('info', `the computer woke up${from ? ` after ${((Date.now() - from) / 60_000).toFixed(0)} minutes asleep` : ''}`);
      if (from && Date.now() - from > 5 * 60_000 && care?.running) void care.send(sleptText(from, Date.now()), 'slept');
      // screens may have changed while asleep (a monitor unplugged): the window is put on one that is there, and drawn again
      setTimeout(() => {
        if (win && !win.isDestroyed()) rescueWindow(win, 'after sleep');
        repaintAll();
      }, 2500);
    });
    powerMonitor.on('lock-screen', () => log('info', 'Windows locked the screen'));
    powerMonitor.on('unlock-screen', () => log('info', 'Windows screen unlocked'));
    powerMonitor.on('shutdown', () => log('warn', 'Windows is shutting down or restarting'));
  };
  screens = new Screens({ screen, BrowserWindow, file: join(userDataDir, 'panel-windows.json'), mainWindow: () => win, newWindow: panelWindow, changed: () => screensChanged(), onTopmost: (ws) => topWatch.setHandles(ws.map(handleOf).filter(Boolean)) });
  const screensChanged = () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('screens:changed', screens.state());
  };
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'])
    screen.on(ev, () => {
      screens.retile();
      screensChanged();
      // a monitor unplugged with the terminal on it: the terminal comes over to a screen that is there
      if (ev === 'display-removed' && win && !win.isDestroyed()) setTimeout(() => win && !win.isDestroyed() && rescueWindow(win, 'a screen was unplugged'), 800);
    });
  // tiles sit above the taskbar while Novus Ordo is the app in use, and step back when you switch away
  app.on('browser-window-focus', () => screens?.cover(true));
  app.on('browser-window-blur', () => setTimeout(() => !BrowserWindow.getFocusedWindow() && screens?.cover(false), 80));
  app.on('before-quit', () => {
    if (screens) screens.quitting = true;
    // closing never hangs: a copy stuck half-closed would hold on to the database and block the next start
    setTimeout(() => {
      log('warn', 'closing took over 10 s — forcing it');
      app.exit(0);
    }, 10_000);
  });
  log('info', 'window created');
  // the heavy part (the exchange library, the Lab, the swarm, the bots) starts once the window has drawn
  // its first screen: loading it first kept the page from loading — a blank window for seconds, longer
  // from a cold start — and anything that needs it waits on this promise
  let startServices;
  const go = new Promise((resolve) => (startServices = resolve));
  {
    const kick = () => setTimeout(() => startServices(), 150);
    win?.webContents.once('did-finish-load', kick);
    setTimeout(() => startServices(), 8000).unref?.();
  }
  services = go
    .then(() => {
      log('info', 'starting exchange services');
      return import('./ccxt-service.mjs');
    })
    .then(async (m) => {
      await m.loadCcxt();
      ccxtSvc = new m.CcxtService(vault, { db, onClock: (name, diff) => log('warn', `${name}: PC clock is ${Math.round(diff)} ms off the exchange — signing with exchange time`) });
      bots = new BotManager({
        ccxt: ccxtSvc,
        db,
        makeWorker: () => new Worker(trainWorkerPath, { resourceLimits: { maxOldGenerationSizeMb: 768 } }),
        emit: (ch, payload) => {
          for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(`amt:${ch}`, payload);
        },
        onClosed: (t, b) => journal.record(fromBot(t, b)),
      });
      lab = new LabService({
        ccxt: ccxtSvc,
        dir: join(app.getPath('userData'), 'lab'),
        makeWorker: () => new Worker(labWorkerPath, { resourceLimits: { maxOldGenerationSizeMb: 1536 } }),
        makeFarmWorker: () => new Worker(farmWorkerPath, { resourceLimits: { maxOldGenerationSizeMb: 1536 } }),
        // the smoothness check loads fresh candles every few seconds, to catch any hold-up it causes
        farmEvery: Number(process.env.NOVUS_FARM_EVERY) || null,
        // the edge finder's engine died: said on the phone (it restarts by itself)
        onTrouble: (why) => care?.error('farm-died', `The edge finder's engine stopped (${String(why).slice(0, 140)}). It restarts by itself from what it last saved.`),
        // tests charge what your live trades really cost, once there are enough of them (never less than assumed)
        costs: (assumed) => costsForTests(measureCosts(journal.list({ mode: 'live' }), { assumedFeeBps: assumed.feeBps }), assumed),
        emit: (ch, payload) => {
          for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(ch, payload);
        },
      });
      cswarm = new CryptoSwarm({
        ccxt: ccxtSvc,
        db,
        labDeployed: () => lab.deployed('crypto'),
        emit: (ch, payload) => {
          for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send(`cswarm:${ch}`, payload);
          // a failed exit or entry is told at once, even with the window closed
          if (ch === 'event' && payload?.kind === 'line' && payload.line?.kind === 'error') care?.error(`${payload.line.agent}:${payload.line.text.slice(0, 40)}`, `Crypto swarm: ${payload.line.text}`);
        },
        log: (level, msg) => (level === 'warn' ? log('warn', msg) : undefined),
        onClosed: (p) => journal.record(fromSwarm(p, { labName: p.labId ? lab.deployedList.find((d) => d.id === p.labId)?.spec.name : null, venue: venueOf(cswarm.secretId) })),
      });
      // the trades from before the journal existed join it, once
      if (!db.get('journal:imported')) {
        try {
          const cfgs = new Map(bots.configs().map((c) => [c.id, c]));
          const n = journal.importOld({
            positions: cswarm.positions,
            amtRows: db.amtTrades(0, 8.64e15),
            labName: (id) => lab.deployedList.find((d) => d.id === id)?.spec.name ?? null,
            venueOf: (p) => (p.mode === 'live' ? venueOf(cswarm.secretId) : 'paper'),
            botOf: (a) => {
              const c = cfgs.get(a.bot_id);
              return c ? { exchangeId: c.exchangeId, lane: c.exchangeId === 'luno' && String(c.name).startsWith('Luno lane · ') } : null;
            },
          });
          db.set('journal:imported', Date.now());
          if (n) log('info', `trade journal: ${n} earlier trades added`);
        } catch (e) {
          log('warn', 'trade journal import failed', e);
        }
      }
      // the edge finder carries on by itself a while after the terminal opens (unless it was stopped)
      if (process.env.NOVUS_NO_FARM !== '1') lab.farmAuto(90_000);
      log('info', 'exchange services ready');
    })
    .catch((e) => {
      log('error', 'exchange services failed to load', e);
      throw e;
    });
  // housekeeping once the app is up
  // old trades go in small chunks on the database worker, well after start-up, never in one long freeze
  const prune = () => void pruneOld(retentionDays()).catch((e) => log('warn', 'prune failed', e));
  setTimeout(prune, 90_000);
  // and the write-ahead log is folded back into the database regularly, so it never grows large
  setInterval(() => void dbTask({ type: 'checkpoint' }).catch(() => undefined), 10 * 60_000);
  // a freeze of the main process is logged with its length, so a slow start or a stutter shows in the log
  let beat = Date.now();
  setInterval(() => {
    const now = Date.now();
    const late = now - beat - 1000;
    if (late > 750) log('warn', `the main process was busy for ${late} ms`);
    beat = now;
  }, 1000);
  // a database from an older version: count its recorded trades in small slices
  const backlog = setInterval(() => {
    try {
      if (!db.countBacklog(2)) clearInterval(backlog);
    } catch (e) {
      log('warn', 'trade count failed', e);
      clearInterval(backlog);
    }
  }, 250);
  setInterval(prune, 3_600_000);
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

let gpuCrashes = 0;
app.on('child-process-gone', (_e, d) => {
  log('error', `${d.type} process gone: ${d.reason} (exit ${d.exitCode})`);
  // the windows may go blank for a moment: none of them stays above the taskbar meanwhile
  if (d.type === 'GPU' && d.reason !== 'clean-exit') screens?.safety(60_000);
  if (d.reason !== 'clean-exit' && d.reason !== 'killed') care?.error(`proc:${d.type}`, `A part of Novus Ordo stopped (${d.type}: ${d.reason}). ${d.type === 'GPU' ? 'It carried on; from the next start it draws without the graphics card (safe mode — Help menu to change).' : 'It carries on.'}`);
  if (d.type === 'GPU' && d.reason !== 'clean-exit' && d.reason !== 'killed' && !safeMode) {
    // the graphics process restarts by itself and the window usually carries on: no restart of the whole app
    // (that cut the page off mid-load and looked like a crash). The next start draws without the graphics card;
    // this one is restarted that way only if the window really stays blank, or the graphics crash again.
    gpuCrashes++;
    try {
      writeFileSync(SAFE_FLAG, JSON.stringify({ v: 2, reason: `GPU process ${d.reason}`, at: new Date().toISOString() }));
    } catch (e) {
      log('error', 'could not write safe-mode flag', e);
    }
    // the graphics process restarts by itself: every window is drawn again; the app is not restarted under you
    setTimeout(repaintAll, 1500);
    if (gpuCrashes >= 2) askSafeRestart(`GPU process ${d.reason} ${gpuCrashes} times`);
  }
});

app.on('second-instance', () => {
  log('info', 'second launch — bringing the open window to the front');
  // the answer (handover.mjs) is written once the window is really on screen
  pendingAck = true;
  if (!app.isReady()) return;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  rescueWindow(win, 'second launch', true);
  if (win.isVisible()) {
    pendingAck = false;
    writeAck(userDataDir);
  }
});

/**
 * The terminal's window back where you can see it: un-minimised, on a screen that is plugged in
 * (a window left on — or full screen on — a monitor that is gone is moved to the screen the
 * mouse is on), drawn again, and (when `front`) brought to the front.
 */
function rescueWindow(w, why, front = false) {
  try {
    if (w.isMinimized()) w.restore();
    const ds = screen.getAllDisplays();
    const b = w.getBounds();
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    // its middle is on no screen that is there now (Windows can leave a full-screen window on a monitor that has gone)
    const lost = !ds.some((d) => cx >= d.bounds.x && cx < d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy < d.bounds.y + d.bounds.height) || !!onScreen(b, ds.map((d) => d.workArea));
    if (lost) {
      const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) ?? screen.getPrimaryDisplay();
      const full = w.isFullScreen();
      const max = w.isMaximized();
      if (full) w.setFullScreen(false);
      if (max) w.unmaximize();
      const a = here.workArea;
      const width = Math.min(Math.max(b.width, 1000), a.width);
      const height = Math.min(Math.max(b.height, 650), a.height);
      w.setBounds({ x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height });
      w.maximize();
      log('info', `${why}: the window was on a screen that is not there — moved to the one in use`);
    }
    if (!w.isVisible()) w.show();
    try {
      w.webContents.invalidate();
    } catch {
      /* drawn as usual */
    }
    if (front) {
      w.moveTop();
      // Windows only lets the app in front take focus: on top for a moment, so it comes to the front
      w.setAlwaysOnTop(true);
      w.focus();
      w.setAlwaysOnTop(false);
    }
  } catch (e) {
    log('warn', `could not bring the window back (${why})`, e);
  }
}

/**
 * This is a second copy: the open one is asked to show its window (above) and answers once it
 * has. No answer: the open copy is stuck — running in Task Manager with no window — and every
 * click would hand over to it for nothing. You are offered to close it and start again.
 */
async function handOver() {
  if (await waitForAck(userDataDir, askedAt, 8000)) {
    log('info', 'the open copy is showing its window');
    app.exit(0);
    return;
  }
  log('warn', 'the open copy did not show its window within 8 s — it looks stuck');
  await app.whenReady();
  const auto = process.env.NOVUS_HANDOVER;
  const pick =
    auto === 'restart'
      ? 0
      : auto === 'leave'
        ? 2
        : dialog.showMessageBoxSync({
            type: 'warning',
            title: 'Novus Ordo is stuck',
            message: 'Novus Ordo is already running, but its window is not showing.',
            detail: 'It may have got stuck while starting or closing. Your keys, strategies and trades are safe on disk, and open trades on the exchange are not touched — the swarm picks up where it left off.\n\nClose the stuck copy and start again?',
            buttons: ['Close it and start again', 'Open the log folder', 'Leave it'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
          });
  if (pick === 1) {
    await shell.openPath(join(userDataDir, 'logs'));
    app.exit(0);
    return;
  }
  if (pick !== 0) {
    app.exit(0);
    return;
  }
  const pid = runningPid(userDataDir);
  if (pid) {
    log('warn', `closing the stuck copy (process ${pid})`);
    const gone = await endStuck(pid);
    log(gone ? 'info' : 'warn', gone ? 'the stuck copy is closed' : 'the stuck copy is still there');
  } else log('warn', 'the stuck copy left no process number — starting again anyway');
  markRestart(userDataDir, 'a stuck copy was closed');
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  app.relaunch(portable ? { execPath: portable, args: [] } : { args: process.argv.slice(1) });
  app.exit(0);
}

app.on('window-all-closed', () => {
  // bots need the app open; stop them before their streams go away
  void bots?.stopAll('app closed');
  void cswarm?.stop().catch(() => undefined);
  ccxtSvc?.closeAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // the computer gets its usual sleep back with the app closed (Windows lets go of it anyway)
  if (awakeId !== null) powerSaveBlocker.stop(awakeId);
  // closed properly: no crash report next time
  if (primary) markStopped(userDataDir);
  lab?.shutdownFarm();
  void dbw?.terminate();
  db?.close();
});

// The Strategy Lab in the desktop process: candle history, research runs (in
// a worker thread so the terminal never freezes), the latest result, and the
// strategies deployed into the swarms.
//
// History comes from public exchange data through CCXT — Binance spot first
// (the longest history), then OKX, Bybit and Hyperliquid — and is cached on
// disk so the next run only fetches what is new. Funding history (for the
// carry rule and the crowding filter) is best-effort: Binance USDⓈ-M, then
// Hyperliquid.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { STYLE_MAP } from '../../src/lab/flow.ts';
import { FARM_DEFAULTS } from '../../src/lab/farm.ts';

export const LAB_DEFAULTS = {
  coins: ['BTC', 'ETH', 'SOL'],
  timeframe: '1h',
  years: 3,
  source: 'auto',
  isShare: 0.7,
  combos: 400,
  sides: 'both',
  feeBps: 4.5,
  slipBps: 2,
  meta: true,
  funding: true,
};
export const TF_H = { '1m': 1 / 60, '5m': 1 / 12, '15m': 0.25, '1h': 1, '4h': 4, '1d': 24 };
/** the most history worth downloading per timeframe, in years (a year of 15-minute candles is 35,000 of them) */
export const MAX_YEARS = { '1m': 30 / 365, '5m': 120 / 365, '15m': 1 };
/**
 * The edge finder reads more history for its slow paces than a single test needs: a swing or
 * position strategy trades a few times a month, and only years of candles give it enough trades
 * to pass the checks — so their top fives fill instead of waiting. (Five years of 4-hour candles
 * is 11,000 of them; six years of daily ones, 2,200.) A coin younger than that gives what it has.
 */
export const FARM_YEARS = { '4h': 5, '1d': 6 };
/** the most coins the edge finder breeds on at once (each coin and pace costs memory: more than this can run a laptop out of it) */
export const FARM_MAX_COINS = 8;
/** liquid coins kept apart to confirm what the edge finder finds: the first three not among the coins it breeds on */
export const CONFIRM_POOL = ['LINK', 'LTC', 'ADA', 'AVAX', 'DOT', 'BCH', 'TRX', 'NEAR', 'ATOM', 'UNI'];
export const confirmCoins = (coins) => CONFIRM_POOL.filter((c) => !coins.includes(c)).slice(0, 3);
const SOURCES = ['binance', 'okx', 'bybit', 'hyperliquid'];
const HOUR = 3_600_000;

export const spotSymbol = (id, coin) => (id === 'hyperliquid' ? `${coin}/USDC:USDC` : `${coin}/USDT`);

/** funding per interval → funding per bar, aligned with the bars (the last known rate, scaled to the bar length) */
export function alignFunding(bars, rows, tfH) {
  if (!rows.length) return null;
  const out = new Array(bars.length).fill(0);
  let j = 0;
  // each exchange's funding interval, from the data itself
  const gaps = rows.slice(1, 50).map((r, i) => r.time - rows[i].time).filter((g) => g > 0).sort((a, b) => a - b);
  const intervalH = gaps.length ? Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / HOUR)) : 8;
  for (let i = 0; i < bars.length; i++) {
    while (j + 1 < rows.length && rows[j + 1].time <= bars[i].time) j++;
    // (a row may carry its own interval: funding joined from two exchanges, 8-hourly then hourly)
    if (rows[j].time <= bars[i].time) out[i] = (rows[j].rate * tfH) / (rows[j].h ?? intervalH);
  }
  return out;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
};

/**
 * One history from two: the long one (another exchange's spot candles, years of them) and
 * Hyperliquid's own recent candles in its place from the first of them on — Hyperliquid
 * keeps only its last 5,000 candles of each size. The older candles are scaled to
 * Hyperliquid's price and volume where the two overlap, so the seam does not look like a
 * move. The recent stretch — the vault and the fresh data that decide what is proven — is
 * Hyperliquid's real prices: the market the swarm trades.
 */
export function spliceCandles(long, recent) {
  if (!recent?.length) return { bars: long, from: null };
  const t0 = recent[0].time;
  const before = long.filter((b) => b.time < t0);
  if (!before.length) return { bars: recent, from: t0 };
  const byT = new Map(long.map((b) => [b.time, b]));
  const pr = [];
  const vr = [];
  for (const b of recent.slice(0, 500)) {
    const a = byT.get(b.time);
    if (!a || !(a.close > 0) || !(b.close > 0)) continue;
    pr.push(b.close / a.close);
    if (a.volume > 0 && b.volume > 0) vr.push(b.volume / a.volume);
  }
  const kp = pr.length ? median(pr) : recent[0].open / before[before.length - 1].close;
  const kv = vr.length ? median(vr) : 1;
  const scaled = before.map((b) => ({ time: b.time, open: b.open * kp, high: b.high * kp, low: b.low * kp, close: b.close * kp, volume: b.volume * kv }));
  return { bars: [...scaled, ...recent], from: t0 };
}

/** the funding interval of a list of rows, in hours, from the rows themselves */
const intervalOf = (rows) => {
  const gaps = rows.slice(1, 50).map((r, i) => r.time - rows[i].time).filter((g) => g > 0);
  return gaps.length ? Math.max(1, Math.round(median(gaps) / HOUR)) : 8;
};

/** markets as plain arrays, for a worker */
const plainMarkets = (byTf) => Object.fromEntries(Object.entries(byTf).map(([tf, ms]) => [tf, ms.map((m) => ({ ...m, funding: m.funding ? Array.from(m.funding) : null }))]));

/**
 * Candles for a worker thread, packed: six numbers a candle in one block of memory that is
 * handed over, not copied. Copying hundreds of thousands of candle objects to a thread
 * holds up the desktop process — and with it every click and scroll in every window —
 * for a quarter of a second or more; packed, it takes a few milliseconds.
 */
export function packMarkets(byTf) {
  const transfer = [];
  const markets = Object.fromEntries(
    Object.entries(byTf).map(([tf, ms]) => [
      tf,
      ms.map((m) => {
        const n = m.bars.length;
        const packed = new Float64Array(n * 6);
        for (let i = 0, k = 0; i < n; i++, k += 6) {
          const b = m.bars[i];
          packed[k] = b.time;
          packed[k + 1] = b.open;
          packed[k + 2] = b.high;
          packed[k + 3] = b.low;
          packed[k + 4] = b.close;
          packed[k + 5] = b.volume;
        }
        const funding = m.funding ? Float64Array.from(m.funding) : null;
        transfer.push(packed.buffer);
        if (funding) transfer.push(funding.buffer);
        return { coin: m.coin, tfH: m.tfH, packed, funding };
      }),
    ]),
  );
  return { markets, transfer };
}

/** the fields of the edge finder's state the desktop process owns (the rest comes from its thread) */
const FARM_OWN = ['running', 'starting', 'wanted', 'cfg', 'note', 'error', 'data'];

export class LabService {
  /**
   * @param o {{ ccxt, dir: string, emit: (ch, msg) => void, makeWorker: () => import('node:worker_threads').Worker, makeFarmWorker?: () => import('node:worker_threads').Worker, now?: () => number, fetchTimeout?: number, retryPause?: number, farmSilence?: number, reviveDelays?: number[], dogEvery?: number }}
   */
  constructor(o) {
    this.ccxt = o.ccxt;
    this.dir = o.dir;
    this.emit = o.emit;
    this.makeWorker = o.makeWorker;
    this.now = o.now ?? Date.now;
    /** the costs measured on your live trades (assumed costs in, the costs to test with out) */
    this.costsFn = o.costs ?? null;
    /** told when the edge finder's engine dies (it restarts by itself) */
    this.onTrouble = o.onTrouble ?? (() => {});
    mkdirSync(join(this.dir, 'cache'), { recursive: true });
    this.cfg = { ...LAB_DEFAULTS, ...this.read('config.json', {}) };
    this.deployedList = this.read('deployed.json', []);
    this.worker = null;
    this.progress = null;
    this.error = null;
    // the edge finder: its own long-lived thread, its last state, and whether it should be running
    this.makeFarmWorker = o.makeFarmWorker ?? null;
    // how often fresh candles are loaded (tests set it shorter)
    this.farmEvery = o.farmEvery ?? null;
    const farm = this.read('farm.json', null);
    this.farmSaved = farm?.save ?? null;
    this.farmWanted = farm ? farm.wanted !== false : true;
    this.farmCfg = { ...FARM_DEFAULTS, ...(farm?.cfg ?? {}) };
    // settings saved before each pace had its own top five: scalping joins intraday and swing (it trades the same 1-hour candles as intraday)
    if (farm?.cfg && !(farm.cfg.v >= 2) && !this.farmCfg.styles.some((x) => x === 'scalp' || x === 'scalp15')) this.farmCfg.styles = ['scalp', ...this.farmCfg.styles];
    // settings from before the slow paces had their own history: the position pace joins, and the
    // three default coins become six (more coins, more trades, top fives that fill faster)
    if (farm?.cfg && !(farm.cfg.v >= 3)) {
      if (!this.farmCfg.styles.includes('position')) this.farmCfg.styles = [...this.farmCfg.styles, 'position'];
      if (this.farmCfg.coins.join() === 'BTC,ETH,SOL') this.farmCfg.coins = [...FARM_DEFAULTS.coins];
    }
    // settings from before the high-frequency paces: a farm that scalps also breeds on 1- and 5-minute candles
    if (farm?.cfg && !(farm.cfg.v >= 4) && this.farmCfg.styles.some((x) => x === 'scalp' || x === 'scalp15'))
      for (const id of ['scalp1', 'scalp5']) if (!this.farmCfg.styles.includes(id)) this.farmCfg.styles = [id, ...this.farmCfg.styles];
    this.farmCfg.v = 4;
    this.farmCfg.coins = this.farmCfg.coins.slice(0, FARM_MAX_COINS);
    this.farmSnap = farm?.state ? { ...farm.state, running: false } : null;
    this.farmW = null;
    this.farmTimer = null;
    this.farmNote = '';
    this.farmErr = '';
    this.farmData = null;
    this.farmRestarts = 0;
    // how long a download may take, the pause before its second try, and how long the farm may be silent before it is restarted
    this.fetchTimeout = o.fetchTimeout ?? 90_000;
    this.retryPause = o.retryPause ?? 1500;
    this.farmSilence = o.farmSilence ?? 5 * 60_000;
    this.reviveDelays = o.reviveDelays ?? [15_000, 60_000, 300_000];
    this.dogEvery = o.dogEvery ?? 30_000;
  }

  // ---------- the edge finder ----------

  /** what the edge finder shows when asked: its live state, or the last one saved */
  farmState() {
    const base = this.farmSnap ?? { running: false, cfg: this.farmCfg, startedAt: 0, gen: 0, tried: 0, rate: 0, population: 0, funnel: { bred: 0, trained: 0, holdout: 0, steady: 0, costs: 0, random: 0, nudge: 0, shuffle: 0, vault: 0, proof: 0 }, ladder: { new: 0, incubating: 0, proving: 0, proven: 0, faded: 0 }, top: [], watch: [], survivors: 0, recent: [], fleet: [], dataTo: 0, dataAt: 0, note: '', error: '' };
    return { ...base, running: !!this.farmW, starting: this.farmStarting ?? false, wanted: this.farmWanted, cfg: this.farmCfg, note: this.farmNote || base.note, error: this.farmErr || (this.farmW ? '' : base.error), data: this.farmData ?? null };
  }

  /**
   * The screen is told what changed: with `delta` (from the thread), those fields and the
   * ones this process owns; with nothing, this process's own fields only (a note, the data
   * tile). Lists that did not change are not sent again, so the screen does not redraw them.
   * A window that opens asks for the whole picture (lab:farm-state).
   */
  farmPush(delta) {
    const st = this.farmState();
    if (delta === null || !this.farmSnap) return this.emit('lab:farm', st);
    const out = Object.fromEntries(FARM_OWN.map((k) => [k, st[k]]));
    if (delta) for (const k of Object.keys(delta)) if (!FARM_OWN.includes(k)) out[k] = st[k];
    this.emit('lab:farm', out);
  }

  /** the save, as text (it is kept as the thread wrote it: never parsed here unless needed) */
  farmSavedText() {
    if (this.farmSaveText == null && this.farmSaved) this.farmSaveText = JSON.stringify(this.farmSaved);
    return this.farmSaveText ?? null;
  }

  /** the save, as an object (only when it is to be changed while the farm is stopped) */
  farmSavedObj() {
    if (!this.farmSaved && this.farmSaveText) {
      try {
        this.farmSaved = JSON.parse(this.farmSaveText);
      } catch {
        this.farmSaved = null;
      }
    }
    return this.farmSaved;
  }

  /**
   * farm.json: the settings, the last picture and the save. The save arrives as text from
   * the thread and is written as it is, by a file write that runs off this process's
   * thread — a save of several megabytes used to be turned into text and written here,
   * holding every window up each minute. Writes go one after another (farmWriting).
   */
  farmPersist(saveText) {
    if (typeof saveText === 'string') {
      this.farmSaveText = saveText;
      this.farmSaved = null;
    }
    const head = JSON.stringify({ wanted: this.farmWanted, cfg: this.farmCfg, state: this.farmSnap });
    const save = this.farmSavedText();
    const text = save ? `${head.slice(0, -1)},"save":${save}}` : head;
    const path = join(this.dir, 'farm.json');
    this.farmWriting = (this.farmWriting ?? Promise.resolve())
      .then(() => fsp.writeFile(`${path}.tmp`, text))
      .then(() => fsp.rename(`${path}.tmp`, path))
      .catch(() => {
        /* the Lab keeps going without its cache */
      });
    return this.farmWriting;
  }

  /**
   * The candles the edge finder breeds on: for each pace's timeframe, the
   * longest history any of its paces wants. Every exchange is tried (the
   * Lab's chosen one first); a coin whose download fails keeps the candles it
   * had (from disk, or from the last load) — a coin is never dropped from a
   * running farm because of an outage. Returns the markets and what went
   * wrong: `stale` (old candles in use) and `missing` (no candles at all).
   */
  async farmMarkets(cfg) {
    const years = {};
    for (const id of cfg.styles) {
      const st = STYLE_MAP[id];
      if (st) years[st.timeframe] = Math.max(years[st.timeframe] ?? 0, st.years, FARM_YEARS[st.timeframe] ?? 0);
    }
    const out = {};
    const stale = [];
    const missing = [];
    // coins tested on Hyperliquid's own recent prices, and those it could not give
    const hlOn = [];
    const hlOff = [];
    let hlError = '';
    const useHl = cfg.hl !== false;
    let error = '';
    const longest = Math.max(0, ...Object.entries(years).filter(([tf]) => tf !== '1d').map(([, y]) => y));
    const fundSince = (_coin, first) => Math.min(first, this.now() - longest * 365 * 24 * HOUR);
    // candles a little behind (a missed refresh, under two candles or two hours old) are not a problem to retry fast for
    const late = [];
    const behind = (tf, bars) => this.now() - (bars[bars.length - 1].time + TF_H[tf] * HOUR);
    const isLate = (tf, bars) => behind(tf, bars) < Math.max(2 * TF_H[tf], 2) * HOUR;
    for (const [tf, yrs] of Object.entries(years)) {
      const ms = [];
      for (const coin of cfg.coins) {
        this.farmNote = `Loading ${coin} ${tf} history…`;
        this.farmPush();
        const last = this.farmLast?.[tf]?.find((m) => m.coin === coin);
        try {
          const got = useHl ? await this.hlCandles(coin, tf, yrs) : await this.candles(coin, tf, yrs, this.cfg.source, { any: true });
          if (useHl) {
            if (got.hl) hlOn.push(`${coin} ${tf}`);
            else {
              hlOff.push(`${coin} ${tf}`);
              hlError ||= got.hlError ?? '';
            }
          }
          if (got.stale) {
            (isLate(tf, got.bars) ? late : stale).push(`${coin} ${tf}`);
            error ||= got.error;
          }
          // candles already in the farm that are fresher than what could be had now are kept
          if (last && last.bars[last.bars.length - 1].time >= got.bars[got.bars.length - 1].time) {
            ms.push(last);
            continue;
          }
          // Hyperliquid did not answer this time: the candles with its prices are kept for up to a day
          // (switching the recent stretch to another exchange's prices would move every fresh-data record,
          // and a strategy could lose its proven badge for no reason of its own)
          if (useHl && last?.hl && !got.hl && got.bars[got.bars.length - 1].time - last.bars[last.bars.length - 1].time < 24 * HOUR) {
            ms.push(last);
            continue;
          }
          let funding = null;
          if (this.cfg.funding && tf !== '1d') {
            try {
              // funding is asked once per coin for the longest stretch any pace needs (the other sizes reuse it)
              const fSince = fundSince(coin, got.bars[0].time);
              funding = alignFunding(got.bars, await (useHl ? this.hlFunding(coin, fSince, got.hl || null) : this.funding(coin, fSince)), TF_H[tf]);
            } catch {
              /* the funding rules sit this one out */
            }
          }
          ms.push({ coin, tfH: TF_H[tf], bars: got.bars, funding, hl: useHl && !!got.hl });
        } catch (err) {
          error ||= String(err?.message ?? err);
          if (last) {
            ms.push(last);
            (isLate(tf, last.bars) ? late : stale).push(`${coin} ${tf}`);
          } else missing.push(`${coin} ${tf}`);
        }
      }
      if (ms.length) out[tf] = ms;
    }
    // the confirmation coins: the long history alone (no Hyperliquid join, no funding); a coin that cannot be had is left out
    const confirm = {};
    for (const [tf, yrs] of Object.entries(years)) {
      const ms = [];
      for (const coin of confirmCoins(cfg.coins)) {
        const last = this.farmConfirm?.[tf]?.find((m) => m.coin === coin);
        try {
          const got = await this.candles(coin, tf, yrs, 'binance', { any: true, skip: 'hyperliquid' });
          ms.push(last && last.bars[last.bars.length - 1].time >= got.bars[got.bars.length - 1].time ? last : { coin, tfH: TF_H[tf], bars: got.bars, funding: null });
        } catch {
          if (last) ms.push(last);
        }
      }
      if (ms.length) confirm[tf] = ms;
    }
    this.farmConfirm = confirm;
    this.farmNote = '';
    this.farmLast = out;
    return { markets: out, confirm, stale, missing, late, error: error.slice(0, 300), hl: useHl ? { on: hlOn, off: hlOff, error: hlError.slice(0, 200) } : null };
  }

  /** how the edge finder's data is doing, for the screen */
  farmHealth(r) {
    const prev = this.farmData ?? { tries: 0, lastOkAt: 0 };
    const ok = !r.stale.length && !r.missing.length;
    this.farmData = {
      ok,
      stale: r.stale,
      missing: r.missing,
      // a refresh missed but the candles are still recent (under three candles old): retried on the usual clock
      late: r.late ?? [],
      lateError: r.late?.length ? r.error : '',
      error: ok ? '' : r.error,
      // the exchange asked us to slow down: the next try waits longer
      limited: /429|rate.?limit|too many|ddos|exceeded/i.test(r.error ?? ''),
      // how many loads in a row have had a problem
      tries: ok ? 0 : prev.tries + 1,
      lastOkAt: ok ? this.now() : prev.lastOkAt,
      checkedAt: this.now(),
      nextTryAt: 0,
      // Hyperliquid's own prices: on for which coins, and why not for the others
      hl: r.hl ?? null,
    };
    // the banner is for what stops the farm; a problem it is working around is shown with the data
    if (ok || Object.keys(r.markets).length) this.farmErr = '';
    return this.farmData;
  }

  /** when the candles are loaded next: on the usual clock, or sooner and sooner-spaced while something is wrong (1, 2, 5, 10, then every 15 minutes — for as long as it takes) */
  farmSchedule() {
    clearTimeout(this.farmTimer);
    if (!this.farmW && !this.farmHealing) return;
    const fast = this.farmCfg.styles.some((s) => STYLE_MAP[s]?.tfH < 1);
    const usual = this.farmEvery ?? (fast ? 15 * 60_000 : 30 * 60_000);
    const d = this.farmData;
    const ms = d && !d.ok ? Math.min(usual, Math.max(d.limited ? 300_000 : 0, [60_000, 120_000, 300_000, 600_000][d.tries - 1] ?? 900_000)) : usual;
    if (d) d.nextTryAt = this.now() + ms;
    this.farmTimer = setTimeout(() => void this.farmRefresh(), ms);
    this.farmTimer.unref?.();
  }

  fleetOf() {
    return this.deployedList.map((d) => ({ id: d.id, name: d.spec.name, spec: d.spec, tfH: d.tfH, coins: d.coins, deployedAt: d.deployedAt, stats: d.stats }));
  }

  /** start the edge finder (it carries on from where it was); settings that change its candles start it over on them */
  async farmStart(patch = {}) {
    const next = { ...this.farmCfg, ...patch };
    if (Array.isArray(next.coins)) next.coins = [...new Set(next.coins.map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))].slice(0, FARM_MAX_COINS);
    next.styles = (next.styles ?? []).filter((s) => STYLE_MAP[s]);
    if (!next.coins.length || !next.styles.length) throw new Error('choose at least one coin and one pace');
    if (this.farmW || this.farmStarting) await this.farmStop(false);
    // other coins or paces: the old survivors were tested on other candles — they are kept, the counters too
    this.farmCfg = next;
    this.farmWanted = true;
    this.farmErr = '';
    this.farmStarting = true;
    this.farmPersist();
    this.farmPush();
    try {
      this.farmLast = null;
      const r = await this.farmMarkets(next);
      this.farmHealth(r);
      if (!Object.keys(r.markets).length) throw new Error(r.error || 'no history for these coins');
      if (!this.makeFarmWorker) throw new Error('the edge finder needs the desktop app');
      const w = this.makeFarmWorker();
      this.farmW = w;
      this.farmSeenAt = this.now();
      w.on('message', (m) => {
        if (this.farmW !== w) return;
        this.farmSeenAt = this.now();
        // it has run for ten minutes: whatever stopped it before is behind it
        if (this.farmRestarts && this.now() - this.farmBegan > 600_000) this.farmRestarts = 0;
        if (m.type === 'state' || m.type === 'save') {
          // only what changed comes over (the lists change at most every 20 seconds): merged into the last picture
          this.farmSnap = m.full || !this.farmSnap ? m.state : { ...this.farmSnap, ...m.state };
          if (m.type === 'save') this.farmPersist(m.saveText ?? (m.save ? JSON.stringify(m.save) : undefined));
          this.farmPush(m.full ? null : m.state);
        } else if (m.type === 'stopped') {
          this.farmDone?.();
        } else if (m.type === 'error') {
          this.farmErr = m.error;
          this.farmPush();
        }
      });
      // the thread died (out of memory, a crash): it is started again by itself, from what was last saved
      const died = (why) => {
        if (this.farmW !== w || this.farmStopping) return;
        this.farmW = null;
        clearTimeout(this.farmTimer);
        this.farmRevive(why);
      };
      w.on('error', (err) => died(String(err?.message ?? err)));
      w.on('exit', (code) => died(`its thread stopped (code ${code})`));
      const packed = packMarkets(r.markets);
      // the heartbeat: the thread counts up as it works, so a long stretch of work is not taken for a hang
      const beat = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(4) : null;
      this.farmBeat = beat ? { arr: new Int32Array(beat), last: 0 } : null;
      const packedC = packMarkets(r.confirm ?? {});
      w.postMessage({ type: 'start', cfg: next, saveText: this.farmSavedText(), markets: packed.markets, confirm: packedC.markets, deployed: this.fleetOf(), costs: this.testCosts(), beat }, [...packed.transfer, ...packedC.transfer]);
      this.farmBegan = this.now();
      // fresher candles every so often: the survivors' and the fleet's forward tests move on
      this.farmSchedule();
      this.farmWatch();
    } catch (err) {
      this.farmErr = String(err?.message ?? err).slice(0, 300);
      throw err;
    } finally {
      this.farmStarting = false;
      this.farmPush();
    }
    return this.farmState();
  }

  /** keep a strategy for good, or let it go: the running farm is told; a stopped one has it written into its save */
  /** the account the edge finder judges strategies for (Hyperliquid's $10 smallest order), in dollars and the rand it was given in */
  farmAccount(usd0, zar0) {
    const usd = Math.round(Number(usd0) * 100) / 100;
    if (!(usd >= 1 && usd <= 1e9)) throw new Error('the account must be at least $1');
    const zar = Number(zar0) > 0 ? Math.round(Number(zar0)) : null;
    this.farmCfg = { ...this.farmCfg, accountUsd: usd, accountZar: zar };
    if (this.farmW) this.farmW.postMessage({ type: 'account', usd, zar });
    if (this.farmSnap) this.farmSnap = { ...this.farmSnap, cfg: this.farmCfg };
    this.farmPersist();
    this.farmPush(null);
    return this.farmState();
  }

  farmPin(id, on) {
    if (this.farmW) this.farmW.postMessage({ type: 'pin', id, on });
    else if (this.farmSavedObj()) {
      const pinned = new Set(this.farmSaved.pinned ?? []);
      if (on) pinned.add(id);
      else pinned.delete(id);
      this.farmSaved = { ...this.farmSaved, pinned: [...pinned] };
      this.farmSaveText = null;
      if (this.farmSnap) this.farmSnap = { ...this.farmSnap, kept: (this.farmSaved.survivors ?? []).filter((s) => pinned.has(s.id)).map((s) => ({ ...s, daily: undefined, forward: s.forward ? { ...s.forward, daily: undefined } : null })) };
      this.farmPersist();
      this.farmPush(null);
    }
    return this.farmState();
  }

  /** fresher candles for the running farm; whatever goes wrong, the next try is already scheduled */
  async farmRefresh() {
    if (!this.farmW || this.farmRefreshing) return;
    this.farmRefreshing = true;
    try {
      const before = this.farmNewest();
      const r = await this.farmMarkets(this.farmCfg);
      const was = this.farmData && !this.farmData.ok;
      const d = this.farmHealth(r);
      const due = !this.farmSentAt || this.now() - this.farmSentAt >= 10 * 60_000 || (was && d.ok);
      if (this.farmW && Object.keys(r.markets).length && (this.farmNewest() > (this.farmSentTo ?? before) || (was && d.ok)) && due) {
        const packed = packMarkets(r.markets);
        const packedC = packMarkets(r.confirm ?? {});
        this.farmW.postMessage({ type: 'markets', markets: packed.markets, confirm: packedC.markets }, [...packed.transfer, ...packedC.transfer]);
        this.farmSentAt = this.now();
        this.farmSentTo = this.farmNewest();
      }
    } catch (err) {
      this.farmHealth({ markets: {}, stale: ['every market'], missing: [], error: String(err?.message ?? err).slice(0, 300) });
    } finally {
      this.farmRefreshing = false;
      this.farmSchedule();
      this.farmPush();
    }
  }

  /** the newest candle the farm holds */
  farmNewest() {
    let t = 0;
    for (const ms of Object.values(this.farmLast ?? {})) for (const m of ms) t = Math.max(t, m.bars[m.bars.length - 1]?.time ?? 0);
    return t;
  }

  /** the farm's thread died or went silent: start it again from what was last saved — 15 seconds, a minute, then every five minutes, for as long as it takes */
  farmRevive(why) {
    if (!this.farmWanted) return;
    this.farmRestarts = (this.farmRestarts ?? 0) + 1;
    try {
      this.onTrouble(why);
    } catch {
      /* the restart matters more than the message */
    }
    const ms = this.reviveDelays[Math.min(this.farmRestarts, this.reviveDelays.length) - 1];
    this.farmErr = `The edge finder stopped unexpectedly (${String(why).slice(0, 120)}). It restarts by itself in ${ms < 60_000 ? `${ms / 1000} seconds` : `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`} — everything it found is kept.`;
    this.farmPush();
    this.farmHealing = true;
    clearTimeout(this.farmReviveTimer);
    this.farmReviveTimer = setTimeout(() => {
      this.farmHealing = false;
      if (!this.farmWanted || this.farmW || this.farmStarting) return;
      this.farmStart().catch((err) => this.farmRevive(String(err?.message ?? err)));
    }, ms);
    this.farmReviveTimer.unref?.();
  }

  /** a watchdog: a farm that has said nothing for five minutes is stuck — it is stopped and started again */
  farmWatch() {
    clearInterval(this.farmDog);
    this.farmDog = setInterval(() => {
      const w = this.farmW;
      // the computer slept (this check itself is far behind its clock): the silence was the sleep, not the farm
      const t = this.now();
      if (this.farmDogAt && t - this.farmDogAt > Math.max(3 * this.dogEvery, 90_000)) this.farmSeenAt = t;
      this.farmDogAt = t;
      // its heartbeat moved: it is working (a long piece of work), not stuck
      const b = this.farmBeat;
      if (b) {
        const n = Atomics.load(b.arr, 0);
        if (n !== b.last) {
          b.last = n;
          this.farmSeenAt = this.now();
        }
      }
      if (!w || this.farmStarting || this.now() - (this.farmSeenAt ?? this.now()) < this.farmSilence) return;
      this.farmW = null;
      clearTimeout(this.farmTimer);
      void Promise.resolve(w.terminate?.()).catch(() => {});
      this.farmRevive(`it had not answered for ${Math.round(this.farmSilence / 60_000)} minutes`);
    }, this.dogEvery);
    this.farmDog.unref?.();
  }

  /** stop the edge finder; its survivors and counters are kept for next time (wanted = false: it stays stopped when the terminal opens) */
  async farmStop(user = true) {
    if (user) this.farmWanted = false;
    clearTimeout(this.farmTimer);
    clearTimeout(this.farmReviveTimer);
    clearInterval(this.farmDog);
    this.farmTimer = null;
    this.farmHealing = false;
    const w = this.farmW;
    // (its end now is not a crash to recover from)
    this.farmStopping = true;
    if (w) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 15_000);
        this.farmDone = () => {
          clearTimeout(t);
          resolve();
        };
        w.postMessage({ type: 'stop' });
      });
      this.farmDone = null;
      void w.terminate();
      this.farmW = null;
    }
    this.farmStopping = false;
    await this.farmPersist();
    this.farmPush(null);
    return this.farmState();
  }

  /** when the terminal opens: carry on, unless it was stopped */
  farmAuto(delayMs = 90_000) {
    if (!this.farmWanted || !this.makeFarmWorker) return;
    const t = setTimeout(() => {
      if (this.farmWanted && !this.farmW && !this.farmStarting) this.farmStart().catch(() => {
        // no history yet (no connection): try again — after a minute, two, five, then every ten
        this.farmAutoTries = (this.farmAutoTries ?? 0) + 1;
        const again = setTimeout(() => this.farmAuto(0), [60_000, 120_000, 300_000][this.farmAutoTries - 1] ?? 600_000);
        again.unref?.();
      });
    }, delayMs);
    t.unref?.();
  }

  /** the swarm's deployed strategies changed: the edge finder watches them */
  farmFleet() {
    this.farmW?.postMessage({ type: 'fleet', deployed: this.fleetOf() });
  }

  shutdownFarm() {
    clearTimeout(this.farmTimer);
    clearTimeout(this.farmReviveTimer);
    clearInterval(this.farmDog);
    const w = this.farmW;
    this.farmW = null;
    if (w) void w.terminate();
  }

  /** when each coin was first listed on each exchange (read once) */
  listedOf() {
    this.listedMem ??= this.read('cache/listed.json', {});
    return this.listedMem;
  }

  /**
   * A candle cache file, kept in memory once read: the edge finder asks for every coin and
   * every candle size every 15 minutes, and reading and decoding megabytes of candles each
   * time held the desktop process (and every window) up again and again. The last few
   * dozen files are kept; the read itself runs off this thread.
   */
  async cachedBars(key) {
    this.barMem ??= new Map();
    const got = this.barMem.get(key);
    if (got) {
      this.barMem.delete(key);
      this.barMem.set(key, got);
      return got;
    }
    let bars = [];
    try {
      bars = JSON.parse(await fsp.readFile(join(this.dir, key), 'utf8'));
      if (!Array.isArray(bars)) bars = [];
    } catch {
      bars = [];
    }
    this.remember(key, bars);
    return bars;
  }

  remember(key, bars) {
    this.barMem ??= new Map();
    this.barMem.delete(key);
    this.barMem.set(key, bars);
    while (this.barMem.size > 80) this.barMem.delete(this.barMem.keys().next().value);
  }

  /**
   * Writes a cache file only when it changed. When only newer candles were added (the usual
   * top-up) they are appended to the end of the file; the whole file is written only the
   * first time or when its history changed. Writes to one file go one after another.
   */
  async storeBars(key, before, after) {
    this.remember(key, after);
    const n = before.length;
    const same = after.length === n && (n === 0 || after[n - 1] === before[n - 1]) && after[0] === before[0];
    if (same) return;
    const grown = n > 0 && after.length > n && after[0] === before[0] && after[n - 1] === before[n - 1];
    const path = join(this.dir, key);
    this.writing ??= new Map();
    const job = (this.writing.get(key) ?? Promise.resolve()).then(async () => {
      try {
        if (grown) {
          const fh = await fsp.open(path, 'r+');
          try {
            const { size } = await fh.stat();
            const last = Buffer.alloc(1);
            if (size >= 2) await fh.read(last, 0, 1, size - 1);
            if (size >= 2 && last.toString() === ']') {
              await fh.write(`,${JSON.stringify(after.slice(n)).slice(1)}`, size - 1);
              return;
            }
          } finally {
            await fh.close();
          }
        }
        await fsp.mkdir(join(this.dir, 'cache'), { recursive: true });
        await fsp.writeFile(`${path}.tmp`, JSON.stringify(after));
        await fsp.rename(`${path}.tmp`, path);
      } catch {
        /* the Lab keeps going without its cache */
      }
    });
    this.writing.set(key, job);
    await job;
  }

  read(name, fallback) {
    try {
      const p = join(this.dir, name);
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback;
    } catch {
      return fallback;
    }
  }
  write(name, v) {
    try {
      writeFileSync(join(this.dir, name), JSON.stringify(v));
    } catch {
      /* the Lab keeps going without its cache */
    }
  }

  /** what a test charges for fees and slippage: the assumed costs, raised to what your live trades measured once there are enough */
  testCosts(cfg = this.cfg) {
    const c = this.costInfo(cfg);
    return { feeBps: c.feeBps, slipBps: c.slipBps };
  }
  costInfo(cfg = this.cfg) {
    const assumed = { feeBps: cfg.feeBps, slipBps: cfg.slipBps };
    try {
      const m = this.costsFn?.(assumed);
      if (m && m.measured) return m;
      return { ...assumed, measured: false, n: m?.n ?? 0, why: m?.why ?? 'the assumed costs' };
    } catch {
      return { ...assumed, measured: false, n: 0, why: 'the assumed costs' };
    }
  }

  status() {
    const last = this.read('result.json', null);
    return {
      costs: this.costInfo(),
      running: !!this.worker,
      progress: this.progress,
      error: this.error,
      cfg: this.cfg,
      deployed: this.deployedList.map(({ spec, ...d }) => ({ ...d, name: spec.name, spec: { ...spec, meta: spec.meta ? { threshold: spec.meta.threshold, trees: spec.meta.model?.trees.length ?? 0, nn: !!spec.meta.nn } : undefined } })),
      last: last ? { at: last.at, trials: last.trials, top: last.top.length, verdicts: last.top.map((t) => t.verdict) } : null,
    };
  }

  /** the full last result (without the trained models, which stay here) */
  result() {
    const r = this.read('result.json', null);
    if (!r) return null;
    return { ...r, top: r.top.map((t) => ({ ...t, spec: { ...t.spec, meta: t.spec.meta ? { threshold: t.spec.meta.threshold, trees: t.spec.meta.model?.trees.length ?? 0, nn: !!t.spec.meta.nn } : undefined } })) };
  }

  setConfig(patch) {
    this.cfg = { ...this.cfg, ...patch };
    this.write('config.json', this.cfg);
    this.push();
    return this.cfg;
  }

  push() {
    this.emit('lab:state', this.status());
  }

  note(text) {
    this.progress = { ...(this.progress ?? { done: 0, total: 1 }), stage: text };
    this.push();
  }

  /**
   * Candles for one coin: from the cache, topped up from the exchange. When no
   * exchange answers (no connection, an outage, a rate limit), the candles
   * already on disk are returned with `stale: true` — old data is better than
   * none, and the caller can try again later. `o.any`: try every exchange,
   * the chosen one first.
   */
  async candles(coin, tf, years0, source, o = {}) {
    const tfH = TF_H[tf];
    const years = Math.min(years0, MAX_YEARS[tf] ?? years0);
    const since = this.now() - years * 365 * 24 * HOUR;
    const need = Math.ceil((years * 365 * 24) / tfH);
    const tried = [];
    let stale = null;
    const order = (source === 'auto' ? SOURCES : o.any ? [source, ...SOURCES.filter((x) => x !== source)] : [source]).filter((x) => x !== o.skip);
    for (const id of order) {
      const key = `cache/${id}-${coin}-${tf}.json`;
      const cached = await this.cachedBars(key);
      const have = cached.filter((b) => b.time >= since);
      // a coin younger than the history asked for (SOL, DOGE on eight years): its first candle on this exchange, once known
      const listed = this.listedOf()[`${id}-${coin}-${tf}`] ?? 0;
      try {
        const from = have.length && have[0].time <= Math.max(since, listed) + 7 * 24 * HOUR ? have[have.length - 1].time + tfH * HOUR : since;
        const fresh = from < this.now() - tfH * HOUR ? await this.fetchHistory(id, spotSymbol(id, coin), tf, from, need + 50) : [];
        const bars = [...(from === since ? [] : have), ...fresh.filter((b) => !have.length || b.time > have[have.length - 1].time)];
        // only closed candles
        const closed = bars.filter((b) => b.time + tfH * HOUR <= this.now());
        if (closed.length < (o.min ?? 600)) throw new Error(`only ${closed.length} candles`);
        // the whole history was asked for and it starts later: that is when the coin was listed here (later refreshes only top it up)
        if (from === since && closed[0].time > since + 7 * 24 * HOUR && this.listedOf()[`${id}-${coin}-${tf}`] !== closed[0].time) {
          const all = this.listedOf();
          all[`${id}-${coin}-${tf}`] = closed[0].time;
          this.write('cache/listed.json', all);
        }
        // the cache keeps the older candles too: a shorter request must not throw away history a longer one will want
        const older = cached.filter((b) => b.time < closed[0].time);
        await this.storeBars(key, cached, older.length ? [...older, ...closed] : closed);
        return { bars: closed, source: id };
      } catch (err) {
        tried.push(`${id}: ${err?.message ?? err}`);
        // what is on disk from this exchange: kept as a fallback (the freshest of them wins)
        const closed = have.filter((b) => b.time + tfH * HOUR <= this.now());
        if (closed.length >= (o.min ?? 600) && (!stale || closed[closed.length - 1].time > stale.bars[stale.bars.length - 1].time)) stale = { bars: closed, source: id, stale: true };
      }
    }
    if (stale && o.stale !== false) return { ...stale, error: tried.join('; ') };
    throw new Error(`no history for ${coin} — ${tried.join('; ')}`);
  }

  /** one download, with a time limit (a hung connection must not hang the Lab) and one quick second try */
  async fetchHistory(id, symbol, tf, from, max) {
    const once = () =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${id} did not answer in ${Math.round(this.fetchTimeout / 1000)} s`)), this.fetchTimeout);
        t.unref?.();
        this.ccxt.history(id, symbol, tf, from, max).then(
          (v) => (clearTimeout(t), resolve(v)),
          (e) => (clearTimeout(t), reject(e)),
        );
      });
    try {
      return await once();
    } catch (err) {
      // a coin the exchange does not list will not appear on a second try
      if (/not listed|does not have|BadSymbol/i.test(String(err?.message ?? err))) throw err;
      // asked to slow down (Hyperliquid allows so many requests a minute): wait it out before the second try
      const limited = /429|rate.?limit|too many|ddos|exceeded/i.test(String(err?.message ?? err) + (err?.constructor?.name ?? ''));
      await new Promise((r) => setTimeout(r, limited ? this.retryPause * 12 : this.retryPause));
      return once();
    }
  }

  /**
   * Candles for testing what the swarm trades (Hyperliquid perpetuals): the long history
   * from the other exchanges, with Hyperliquid's own recent candles joined on (see
   * spliceCandles). If Hyperliquid cannot be reached, the long history alone, said so.
   */
  async hlCandles(coin, tf, years) {
    const long = await this.candles(coin, tf, years, 'binance', { any: true, skip: 'hyperliquid' }).catch(() => null);
    let hl = null;
    let hlError = '';
    try {
      hl = await this.candles(coin, tf, years, 'hyperliquid', { min: 100 });
    } catch (err) {
      hlError = String(err?.message ?? err).slice(0, 200);
    }
    if (!long && !hl) throw new Error(`no history for ${coin} — ${hlError}`);
    if (!hl) return { ...long, hl: null, hlError };
    if (!long) return { ...hl, hl: hl.bars[0].time, source: 'hyperliquid' };
    const sp = spliceCandles(long.bars, hl.bars);
    return { bars: sp.bars, source: `${long.source} + hyperliquid`, hl: sp.from, stale: long.stale || hl.stale, error: long.error || hl.error };
  }

  /** funding the swarm pays: Binance's for the long past, Hyperliquid's own (hourly) from its first record on */
  async hlFunding(coin, since, hlFrom = null) {
    // Hyperliquid's own funding is needed only where its own prices are (its last 5,000 candles): asking it for years
    // of hourly rows was dozens of requests a coin, enough to hit its limit and have the candles refused too
    const hlSince = hlFrom ? Math.max(since, hlFrom - 2 * 24 * HOUR) : since;
    const [bin, hl] = await Promise.all([
      this.fundingRows('binanceusdm', `${coin}/USDT:USDT`, since).catch(() => []),
      this.fundingRows('hyperliquid', `${coin}/USDC:USDC`, hlSince).catch(() => []),
    ]);
    if (hl.length < 20) return bin;
    const hB = intervalOf(bin);
    const hH = intervalOf(hl);
    return [...bin.filter((r) => r.time < hl[0].time).map((r) => ({ ...r, h: hB })), ...hl.map((r) => ({ ...r, h: hH }))];
  }

  /**
   * Funding history, kept on disk and in memory: the first time the stretch is downloaded,
   * after that only the rows since the last one (once every half hour at most — funding is
   * paid every hour or eight), and only the older rows when a longer stretch is wanted.
   * Years of rows used to be downloaded again for every coin and candle size every 15
   * minutes and at every start.
   */
  async fundingRows(id, sym, since) {
    this.fundMem ??= new Map();
    const key = `${id}|${sym}`;
    const file = `cache/funding-${id}-${sym.replace(/[^A-Za-z0-9]+/g, '_')}.json`;
    let m = this.fundMem.get(key);
    if (!m) {
      try {
        const d = JSON.parse(await fsp.readFile(join(this.dir, file), 'utf8'));
        if (Array.isArray(d?.rows) && d.rows.length) m = { rows: d.rows, from: d.from ?? d.rows[0].time, at: 0 };
      } catch {
        /* none yet */
      }
    }
    const cut = (rows) => rows.filter((r) => r.time >= since);
    const keep = async (next) => {
      this.fundMem.set(key, next);
      try {
        await fsp.mkdir(join(this.dir, 'cache'), { recursive: true });
        await fsp.writeFile(join(this.dir, `${file}.tmp`), JSON.stringify({ from: next.from, rows: next.rows }));
        await fsp.rename(join(this.dir, `${file}.tmp`), join(this.dir, file));
      } catch {
        /* the Lab keeps going without its cache */
      }
    };
    if (!m || !m.rows.length) {
      const rows = await this.ccxt.fundingHistory(id, sym, since);
      if (rows.length) await keep({ rows, at: this.now(), from: since });
      return rows;
    }
    let rows = m.rows;
    let changed = false;
    // a longer stretch than held: the older rows, in front
    if (since < m.from && since < rows[0].time - 9 * HOUR) {
      const older = (await this.ccxt.fundingHistory(id, sym, since, 20_000, rows[0].time)).filter((r) => r.time < rows[0].time);
      rows = [...older, ...rows];
      changed = true;
    }
    // the newest rows, at most every half hour
    if (this.now() - m.at >= 30 * 60_000) {
      const last = rows[rows.length - 1].time;
      const more = await this.ccxt.fundingHistory(id, sym, last + 1);
      const add = more.filter((r) => r.time > last);
      if (add.length) {
        rows = [...rows, ...add];
        changed = true;
      }
      m = { ...m, at: this.now() };
    }
    const next = { rows, at: m.at, from: Math.min(m.from, since) };
    if (changed) await keep(next);
    else this.fundMem.set(key, next);
    return cut(rows);
  }

  async funding(coin, since) {
    for (const [id, sym] of [
      ['binanceusdm', `${coin}/USDT:USDT`],
      ['hyperliquid', `${coin}/USDC:USDC`],
    ]) {
      try {
        const rows = await this.fundingRows(id, sym, since);
        if (rows.length > 20) return rows;
      } catch {
        /* next source */
      }
    }
    return [];
  }

  async markets(cfg) {
    const tfH = TF_H[cfg.timeframe] ?? 1;
    const out = [];
    const notes = [];
    for (const coin of cfg.coins) {
      this.note(`Downloading ${coin} history (${cfg.years} years of ${cfg.timeframe} candles)…`);
      try {
        // Hyperliquid keeps only its last 5,000 candles: its own recent prices are joined onto the long history
        const hl = cfg.source === 'hyperliquid';
        const got = hl ? await this.hlCandles(coin, cfg.timeframe, cfg.years) : await this.candles(coin, cfg.timeframe, cfg.years, cfg.source);
        const { bars, source, stale } = got;
        if (hl) notes.push(got.hl ? `${coin}: Hyperliquid's own prices from ${new Date(got.hl).toISOString().slice(0, 10)}, the years before from ${String(source).split(' ')[0]} (scaled to Hyperliquid's)` : `${coin}: Hyperliquid's candles could not be had (${got.hlError || 'no answer'}) — tested on ${source}`);
        if (stale) notes.push(`${coin}: no exchange answered — tested on the candles already on this computer (to ${new Date(bars[bars.length - 1].time).toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
        let funding = null;
        if (cfg.funding) {
          this.note(`Downloading ${coin} funding history…`);
          const rows = await (hl ? this.hlFunding(coin, bars[0].time) : this.funding(coin, bars[0].time));
          funding = alignFunding(bars, rows, tfH);
          if (!funding) notes.push(`${coin}: no funding history`);
        }
        out.push({ coin, tfH, bars, funding, source });
      } catch (err) {
        notes.push(String(err?.message ?? err));
      }
    }
    return { markets: out, notes };
  }

  /** run the research in a worker; resolves with the result summary */
  async run(patch = {}) {
    if (this.worker) throw new Error('a research run is already going');
    const cfg = this.setConfig(patch);
    this.error = null;
    this.progress = { stage: 'Starting…', done: 0, total: 1 };
    this.push();
    try {
      const { markets, notes } = await this.markets(cfg);
      if (!markets.length) throw new Error(notes.join(' · ') || 'no history downloaded');
      const result = await this.inWorker({
        type: 'research',
        markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })),
        cfg: { isShare: cfg.isShare, combos: cfg.combos, sides: cfg.sides, meta: cfg.meta, costs: this.testCosts(cfg) },
      });
      result.notes = [...notes, ...result.notes];
      result.sources = markets.map((m) => ({ coin: m.coin, source: m.source }));
      this.write('result.json', result);
      this.progress = null;
      this.push();
      this.emit('lab:event', { kind: 'done', at: result.at });
      return this.status().last;
    } catch (err) {
      this.error = String(err?.message ?? err);
      this.progress = null;
      this.push();
      throw err;
    }
  }

  /** backtest one strategy (built by hand in the Lab) on the configured coins */
  async test(spec, patch = {}) {
    const cfg = { ...this.cfg, ...patch };
    const { markets } = await this.markets(cfg);
    if (!markets.length) throw new Error('no history downloaded');
    this.progress = null;
    this.push();
    return this.inWorker({ type: 'evaluate', markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })), spec, isShare: cfg.isShare, costs: this.testCosts(cfg) });
  }

  /**
   * The optimizer: measure versions of a strategy (the bot as it is, and each one-step change) on the
   * validation stretch inside the training years — the unseen data is not read.
   */
  async optimize(specs, patch = {}) {
    if (!Array.isArray(specs) || !specs.length) throw new Error('nothing to try');
    const cfg = { ...this.cfg, ...patch };
    const { markets } = await this.markets(cfg);
    if (!markets.length) throw new Error('no history downloaded');
    try {
      return await this.inWorker({ type: 'score', markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })), specs: specs.slice(0, 120), isShare: cfg.isShare, costs: this.testCosts(cfg) });
    } finally {
      this.progress = null;
      this.push();
    }
  }

  /** is the Lab's worker free (no research, test or optimisation of yours running)? */
  idle() {
    return !this.worker && !this.retuning;
  }

  /**
   * The re-tuner, for one deployed strategy: its settings checked again on the latest candles,
   * in the Lab's worker (never on the desktop process's thread). Only when the Lab is idle.
   */
  async retune(d) {
    if (!this.idle()) throw new Error('the Lab is busy');
    this.retuning = true;
    try {
      return await this.retuneNow(d);
    } finally {
      this.retuning = false;
    }
  }

  async retuneNow(d) {
    const tf = d.tfH === 24 ? '1d' : d.tfH < 1 ? `${Math.round(d.tfH * 60)}m` : `${d.tfH}h`;
    const years = d.tfH >= 24 ? 6 : d.tfH >= 4 ? 4 : d.tfH >= 1 ? 2 : 1;
    const { markets } = await this.markets({ ...this.cfg, coins: d.coins, timeframe: tf, years });
    if (!markets.length) throw new Error('no history downloaded');
    if (this.worker) throw new Error('the Lab is busy');
    try {
      return await this.inWorker({ type: 'retune', markets: markets.map((m) => ({ ...m, funding: m.funding ? Float64Array.from(m.funding) : null })), spec: d.spec, costs: this.testCosts() });
    } finally {
      this.progress = null;
      this.push();
    }
  }

  inWorker(msg) {
    return new Promise((resolve, reject) => {
      const w = this.makeWorker();
      this.worker = w;
      const done = (fn, v) => {
        this.worker = null;
        void w.terminate();
        fn(v);
      };
      w.on('message', (m) => {
        if (m.type === 'progress') {
          this.progress = m.progress;
          const t = this.now();
          if (!this.lastPush || t - this.lastPush > 250) {
            this.lastPush = t;
            this.push();
          }
        } else if (m.type === 'result') done(resolve, m.result);
        else if (m.type === 'error') done(reject, new Error(m.error));
      });
      w.on('error', (e) => done(reject, e));
      w.on('exit', (code) => {
        if (this.worker === w) done(reject, new Error(code ? `the research stopped (code ${code})` : 'cancelled'));
      });
      w.postMessage(msg);
    });
  }

  cancel() {
    if (this.worker) void this.worker.terminate();
  }

  // ---------- deployment ----------

  /** deploy one of the last result's top five (by rank), or a hand-built spec */
  deploy({ rank, spec, tfH, stats, authority }, targets = { crypto: true, meme: false }, coins) {
    let s = spec;
    let st = stats;
    let tf = tfH;
    if (rank) {
      const r = this.read('result.json', null);
      const t = r?.top.find((x) => x.rank === rank);
      if (!t) throw new Error('no such strategy in the last research');
      s = t.spec;
      tf = r.tfH;
      const yrs = t.oos.bars / ((24 * 365) / (r.tfH ?? 1));
      st = { sharpe: t.oos.sharpe, t: t.oos.t, dsr: t.dsr, trades: t.oos.trades, verdict: t.verdict, winRate: t.oos.winRate, avgR: t.oos.avgR, perYear: yrs > 0 ? t.oos.trades / yrs : undefined, maxDD: t.oos.maxDD };
    }
    if (!s) throw new Error('nothing to deploy');
    // every new deployment starts on probation: a quarter of the size until its first live trades match its test
    const d = { id: randomUUID(), spec: s, tfH: tf ?? 1, coins: coins ?? this.cfg.coins, targets, stats: st ?? { sharpe: 0, t: 0, dsr: 0, trades: 0, verdict: 'untested' }, deployedAt: this.now(), on: true, authority: authority === 'tested' ? 'tested' : 'council', scale: 0.25, probation: { since: this.now() } };
    this.deployedList = [...this.deployedList, d];
    this.write('deployed.json', this.deployedList);
    this.push();
    this.farmFleet();
    this.emit('lab:event', { kind: 'deployed', id: d.id, name: s.name });
    return d.id;
  }

  undeploy(id) {
    this.deployedList = this.deployedList.filter((d) => d.id !== id);
    this.write('deployed.json', this.deployedList);
    this.push();
    this.farmFleet();
  }

  /** who decides a deployed strategy's trades: the swarm's council (it can block a signal), or the strategy as tested (only the safety bots can) */
  setAuthority(id, authority) {
    this.deployedList = this.deployedList.map((d) => (d.id === id ? { ...d, authority: authority === 'tested' ? 'tested' : 'council' } : d));
    this.write('deployed.json', this.deployedList);
    this.push();
  }

  /** a deployed strategy's size: ¼ on probation, 1 once it has earned it (and the reason, for the screen) */
  setScale(id, scale, why = '') {
    this.deployedList = this.deployedList.map((d) => (d.id === id ? { ...d, scale, probation: scale < 1 ? { since: this.now(), why } : null, graduatedAt: scale >= 1 ? this.now() : d.graduatedAt } : d));
    this.write('deployed.json', this.deployedList);
    this.push();
  }

  /** a strategy's settings changed (the re-tuner, with your tap): the same deployment, new rules */
  setSpec(id, spec, note = '') {
    this.deployedList = this.deployedList.map((d) => (d.id === id ? { ...d, spec, retunedAt: this.now(), retuneNote: note } : d));
    this.write('deployed.json', this.deployedList);
    this.push();
    this.farmFleet();
  }

  toggle(id, on, by = 'you') {
    this.deployedList = this.deployedList.map((d) => (d.id === id ? { ...d, on, pausedBy: on ? null : by } : d));
    this.write('deployed.json', this.deployedList);
    this.push();
  }

  /** the strategies live in a swarm */
  deployed(target = 'crypto') {
    return this.deployedList.filter((d) => d.on && d.targets[target]);
  }
}

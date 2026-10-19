import { HeatmapRecorder } from '../core/heatmap';
import { OrderBook } from '../core/orderbook';
import { TradeStore } from '../core/tradeStore';
import type { Instrument, Kline, Liquidation, MarketStats, Trade, VenueId, VenueStatus } from '../core/types';
import type { Connection, VenueAdapter } from '../exchanges/adapter';
import { ADAPTERS } from '../exchanges';
import { byodLiquidations, byodTrades } from '../history/byod';
import { getSettings, useSettings } from '../store/settings';
import { desktop, DesktopOnlyError } from '../desktop/bridge';

export interface SeriesPoint {
  time: number;
  value: number;
}

/** Fixed-capacity ring of objects (newest last). */
export class Ring<T> {
  items: T[] = [];
  constructor(public cap: number) {}
  push(x: T) {
    this.items.push(x);
    if (this.items.length > this.cap * 1.2) this.items.splice(0, this.items.length - this.cap);
  }
  clear() {
    this.items = [];
  }
  get last(): T | undefined {
    return this.items[this.items.length - 1];
  }
}

/** One live market (venue + symbol): trades, book, liquidations, stats. */
export class Feed {
  readonly key: string;
  readonly adapter: VenueAdapter;
  readonly store = new TradeStore(2_000_000);
  readonly book = new OrderBook();
  readonly liqs = new Ring<Liquidation>(2000);
  readonly oi = new Ring<SeriesPoint>(2000);
  readonly mids = new Ring<SeriesPoint>(3600);
  stats: MarketStats;
  status: VenueStatus = { state: 'idle', msgs: 0, lastMsg: 0 };
  /** messages per second (EMA) */
  rate = 0;
  private frames = 0;
  private conn: Connection | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  refs = 0;

  constructor(
    readonly inst: Instrument,
    private hub: MarketHub,
  ) {
    this.key = feedKey(inst.venue, inst.symbol);
    this.adapter = ADAPTERS[inst.venue];
    this.stats = { venue: inst.venue, time: 0 };
  }

  start() {
    if (this.conn) return;
    this.conn = this.adapter.connect(this.inst.symbol, {
      onTrades: (trades) => {
        for (const t of trades) {
          this.store.pushTrade(t);
          this.hub.emitTrade(t, this);
        }
      },
      onBook: (u) => this.book.apply(u),
      onLiquidation: (l) => {
        this.liqs.push(l);
        this.hub.emitLiq(l, this);
      },
      onStats: (s) => this.mergeStats(s),
      onStatus: (state, error) => {
        this.status = { ...this.status, state, error: state === 'open' ? undefined : error ?? this.status.error };
        if (state === 'open' && this.inst.venue !== 'sim') this.book.clear();
        this.hub.bump();
      },
      onFrame: (t) => {
        this.frames++;
        this.status.msgs++;
        const now = Date.now();
        this.status.lastMsg = now;
        if (t && isFinite(t) && t > 1e12) {
          const lat = now - t;
          if (lat > -5000 && lat < 60_000) this.status.latencyMs = this.status.latencyMs === undefined ? lat : this.status.latencyMs * 0.9 + lat * 0.1;
        }
      },
    });
    if (this.adapter.pollStats) {
      const poll = () =>
        this.adapter
          .pollStats!(this.inst.symbol)
          .then((s) => this.mergeStats(s))
          .catch(() => undefined);
      poll();
      this.pollTimer = setInterval(poll, 60_000);
    }
    if (this.adapter.fetchOiHistory) {
      this.adapter
        .fetchOiHistory(this.inst.symbol)
        .then((pts) => {
          const live = this.oi.items;
          this.oi.items = [...pts.map((p) => ({ time: p.time, value: p.oiUsd })).filter((p) => !live.length || p.time < live[0].time), ...live];
          this.hub.bump();
        })
        .catch(() => undefined);
    }
  }

  stop() {
    this.conn?.close();
    this.conn = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private mergeStats(s: Partial<MarketStats>) {
    const clean: Partial<MarketStats> = {};
    for (const [k, v] of Object.entries(s)) if (v !== undefined && !(typeof v === 'number' && !isFinite(v))) (clean as any)[k] = v;
    this.stats = { ...this.stats, ...clean, time: Date.now() };
    const px = this.stats.markPrice ?? this.stats.last ?? this.lastPrice();
    if (clean.openInterest !== undefined && clean.openInterestUsd === undefined && px) this.stats.openInterestUsd = this.stats.openInterest! * px;
  }

  lastPrice(): number {
    const p = this.store.lastPrice();
    if (isFinite(p)) return p;
    const m = this.book.mid();
    return isFinite(m) ? m : this.stats.last ?? NaN;
  }

  /** called by the hub at ~1Hz */
  sample(now: number) {
    this.rate = this.rate * 0.7 + this.frames * 0.3;
    this.frames = 0;
    const mid = this.book.mid();
    if (isFinite(mid)) this.mids.push({ time: now, value: mid });
    const oiUsd = this.stats.openInterestUsd;
    const last = this.oi.last;
    if (oiUsd && (!last || now - last.time >= 15_000)) this.oi.push({ time: now, value: oiUsd });
  }
}

export const feedKey = (venue: VenueId, symbol: string) => `${venue}:${symbol}`;

export interface BackfillState {
  state: 'idle' | 'loading' | 'done' | 'error';
  progress: number;
  message: string;
  count: number;
}

type TradeListener = (t: Trade, feed: Feed) => void;
type LiqListener = (l: Liquidation, feed: Feed) => void;

/**
 * Owns all live feeds. The primary instrument drives single-venue panels
 * (footprint, DOM, historical); the aggregate set feeds composite panels.
 */
export class MarketHub {
  feeds = new Map<string, Feed>();
  primary!: Feed;
  aggregate: Feed[] = [];
  /** merged tape across the aggregate set (newest last) */
  tape = new Ring<Trade>(5000);
  heatmap = new HeatmapRecorder(500, 7200, 0.04);
  compositeHeatmap = new HeatmapRecorder(500, 7200, 0.04);
  backfill: BackfillState = { state: 'idle', progress: 0, message: '', count: 0 };
  /** bumps whenever topology/state changes (React re-render trigger) */
  version = 0;
  private tradeListeners = new Set<TradeListener>();
  private liqListeners = new Set<LiqListener>();
  private changeListeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSample = 0;
  private backfillAbort: AbortController | null = null;
  /** externally-held feeds (watchlist, extra panels) */
  private pinned = new Map<string, number>();

  constructor() {
    this.syncFromSettings();
    useSettings.subscribe((s, prev) => {
      const ccxtChanged = s.ccxtExchange !== prev.ccxtExchange || s.ccxtType !== prev.ccxtType || s.ccxtQuote !== prev.ccxtQuote;
      if (s.base !== prev.base || s.primaryVenue !== prev.primaryVenue || s.aggregateVenues.join() !== prev.aggregateVenues.join() || ccxtChanged) this.syncFromSettings();
      else if (s.historySource !== prev.historySource || s.byodUrl !== prev.byodUrl || s.byodToken !== prev.byodToken || s.backfillMinutes !== prev.backfillMinutes)
        void this.runBackfill();
    });
    this.timer = setInterval(() => this.tick(), 100);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => this.flushRecords());
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    for (const f of this.feeds.values()) f.stop();
    this.feeds.clear();
  }

  private getFeed(inst: Instrument): Feed {
    const key = feedKey(inst.venue, inst.symbol);
    let f = this.feeds.get(key);
    if (!f) {
      f = new Feed(inst, this);
      this.feeds.set(key, f);
    }
    return f;
  }

  instrumentFor(base: string, venue: VenueId): Instrument | null {
    const symbol = ADAPTERS[venue].symbolFor(base);
    return symbol ? { venue, symbol, base: base.toUpperCase() } : null;
  }

  private syncFromSettings() {
    const s = getSettings();
    const prevPrimary = this.primary;
    const primaryInst = this.instrumentFor(s.base, s.primaryVenue)!;
    const venues = Array.from(new Set([s.primaryVenue, ...s.aggregateVenues]));
    const wanted = new Set<string>();
    const agg: Feed[] = [];
    for (const v of venues) {
      const inst = this.instrumentFor(s.base, v);
      if (!inst) continue;
      const f = this.getFeed(inst);
      wanted.add(f.key);
      agg.push(f);
    }
    for (const k of this.pinned.keys()) wanted.add(k);
    for (const [k, f] of this.feeds) {
      if (!wanted.has(k)) {
        f.stop();
        this.feeds.delete(k);
      }
    }
    this.primary = this.getFeed(primaryInst);
    this.aggregate = agg;
    for (const f of agg) f.start();
    if (prevPrimary !== this.primary) {
      this.heatmap.clear();
      this.compositeHeatmap.clear();
      this.tape.clear();
      void this.runBackfill();
    }
    this.bump();
  }

  /** Keep an arbitrary feed alive (e.g. spread chart against another symbol). */
  pin(inst: Instrument): Feed {
    const f = this.getFeed(inst);
    this.pinned.set(f.key, (this.pinned.get(f.key) ?? 0) + 1);
    f.start();
    return f;
  }

  unpin(inst: Instrument) {
    const key = feedKey(inst.venue, inst.symbol);
    const n = (this.pinned.get(key) ?? 0) - 1;
    if (n > 0) this.pinned.set(key, n);
    else {
      this.pinned.delete(key);
      if (!this.aggregate.some((f) => f.key === key)) {
        this.feeds.get(key)?.stop();
        this.feeds.delete(key);
      }
    }
  }

  emitTrade(t: Trade, feed: Feed) {
    if (!this.aggregate.includes(feed)) return;
    this.tape.push(t);
    this.record(t, feed);
    for (const l of this.tradeListeners) l(t, feed);
  }

  emitLiq(l: Liquidation, feed: Feed) {
    if (!this.aggregate.includes(feed)) return;
    for (const fn of this.liqListeners) fn(l, feed);
  }

  onTrade(fn: TradeListener) {
    this.tradeListeners.add(fn);
    return () => void this.tradeListeners.delete(fn);
  }

  onLiq(fn: LiqListener) {
    this.liqListeners.add(fn);
    return () => void this.liqListeners.delete(fn);
  }

  onChange(fn: () => void) {
    this.changeListeners.add(fn);
    return () => void this.changeListeners.delete(fn);
  }

  bump() {
    this.version++;
    for (const fn of this.changeListeners) fn();
  }

  visible(hidden: VenueId[] | undefined): Feed[] {
    if (!hidden?.length) return this.aggregate;
    return this.aggregate.filter((f) => !hidden.includes(f.inst.venue));
  }

  private tick() {
    const now = Date.now();
    if (this.primary && !this.primary.book.empty) this.heatmap.maybeTake(now, [this.primary.book]);
    const books = this.aggregate.filter((f) => !f.book.empty).map((f) => f.book);
    if (books.length) this.compositeHeatmap.maybeTake(now, books);
    if (now - this.lastSample >= 1000) {
      this.lastSample = now;
      for (const f of this.feeds.values()) f.sample(now);
      this.bump();
    }
  }

  // ---- local database recorder (desktop) ----
  private recordBuf = new Map<string, { venue: string; symbol: string; rows: { p: number; q: number; s: 'buy' | 'sell'; t: number }[] }>();
  private recordTimer: ReturnType<typeof setInterval> | null = null;

  private record(t: Trade, feed: Feed) {
    if (!desktop) return;
    const s = getSettings();
    if (!s.recordTrades || feed.inst.venue === 'sim') return;
    if (s.recordScope === 'primary' && feed !== this.primary) return;
    let b = this.recordBuf.get(feed.key);
    if (!b) {
      b = { venue: feed.inst.venue, symbol: feed.inst.symbol, rows: [] };
      this.recordBuf.set(feed.key, b);
    }
    b.rows.push({ p: t.price, q: t.qty, s: t.side, t: t.time });
    this.recordTimer ??= setInterval(() => this.flushRecords(), 2000);
  }

  flushRecords() {
    if (!desktop) return;
    for (const b of this.recordBuf.values()) {
      if (!b.rows.length) continue;
      const rows = b.rows;
      b.rows = [];
      desktop.db.record(b.venue, b.symbol, rows).catch((e) => console.warn('record failed', e));
    }
  }

  async runBackfill() {
    this.backfillAbort?.abort();
    const ctrl = new AbortController();
    this.backfillAbort = ctrl;
    const s = getSettings();
    const feed = this.primary;
    const set = (p: Partial<BackfillState>) => {
      if (ctrl.signal.aborted) return;
      this.backfill = { ...this.backfill, ...p };
      this.bump();
    };
    if (s.historySource === 'none') {
      set({ state: 'idle', progress: 0, message: 'History disabled — live data only', count: 0 });
      return;
    }
    const to = Date.now();
    const from = to - s.backfillMinutes * 60_000;
    set({ state: 'loading', progress: 0, message: 'Loading history…', count: 0 });
    try {
      let trades;
      if (s.historySource === 'local') {
        if (!desktop) throw new DesktopOnlyError('The local database');
        const local = await desktop.db.query(feed.inst.venue, feed.inst.symbol, from, to);
        set({ progress: 0.5, message: `Loaded ${local.length.toLocaleString()} trades from the local database` });
        trades = local;
        // fill the gap between the last recorded trade and now from the exchange
        const lastLocal = local.length ? local[local.length - 1].time : from;
        if (feed.adapter.backfillTrades && to - lastLocal > 60_000) {
          const gap = await feed.adapter.backfillTrades(feed.inst.symbol, lastLocal + 1, to, (p) => set({ progress: 0.5 + p / 2 }), ctrl.signal);
          trades = [...local, ...gap];
          if (gap.length && s.recordTrades && feed.inst.venue !== 'sim') void desktop.db.record(feed.inst.venue, feed.inst.symbol, gap.map((g) => ({ p: g.price, q: g.qty, s: g.side, t: g.time })));
        }
      } else if (s.historySource === 'byod') {
        trades = await byodTrades(s.byodUrl, s.byodToken, feed.inst.venue, feed.inst.symbol, from, to, (p) => set({ progress: p }), ctrl.signal);
        byodLiquidations(s.byodUrl, s.byodToken, feed.inst.venue, feed.inst.symbol, from, to)
          .then((liqs) => {
            if (ctrl.signal.aborted) return;
            feed.liqs.items = [...liqs, ...feed.liqs.items].sort((a, b) => a.time - b.time);
          })
          .catch(() => undefined);
      } else {
        if (!feed.adapter.backfillTrades) {
          set({ state: 'idle', progress: 0, message: `${feed.adapter.name} has no public trade history — live only`, count: 0 });
          return;
        }
        trades = await feed.adapter.backfillTrades(feed.inst.symbol, from, to, (p) => set({ progress: p }), ctrl.signal);
      }
      if (ctrl.signal.aborted) return;
      const n = feed.store.prepend(trades);
      set({ state: 'done', progress: 1, message: `Loaded ${n.toLocaleString()} historical trades`, count: n });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      set({ state: 'error', progress: 0, message: String(e instanceof Error ? e.message : e) });
    }
  }

  async klines(interval: string, limit: number, feed = this.primary): Promise<Kline[]> {
    return feed.adapter.fetchKlines(feed.inst.symbol, interval, limit);
  }
}

let hubInstance: MarketHub | null = null;
export function hub(): MarketHub {
  if (!hubInstance) hubInstance = new MarketHub();
  return hubInstance;
}

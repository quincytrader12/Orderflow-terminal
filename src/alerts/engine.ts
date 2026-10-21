import { create } from 'zustand';
import { volumeProfile } from '../core/footprint';
import { autoResolution } from '../core/heatmap';
import { cvdSeries, flowWindow } from '../core/indicators';
import { fmtPrice, fmtUsd } from '../core/format';
import type { Liquidation, Trade } from '../core/types';
import { forwardAlert } from '../desktop/telegram';
import { hub, type Feed } from '../market/hub';
import { getSettings, uid, useSettings, type AlertRule, type AlertType } from '../store/settings';

export const ALERT_TYPES: { type: AlertType; label: string; valueLabel: string; defaultValue: number; defaultWindow: number; help: string }[] = [
  { type: 'price_above', label: 'Price crosses above', valueLabel: 'Price', defaultValue: 0, defaultWindow: 0, help: 'Last price of the primary crosses above the level.' },
  { type: 'price_below', label: 'Price crosses below', valueLabel: 'Price', defaultValue: 0, defaultWindow: 0, help: 'Last price of the primary crosses below the level.' },
  { type: 'large_trade', label: 'Large trade', valueLabel: 'Min notional $', defaultValue: 1_000_000, defaultWindow: 0, help: 'A single print at or above the notional.' },
  { type: 'liquidation', label: 'Liquidation', valueLabel: 'Min notional $', defaultValue: 250_000, defaultWindow: 0, help: 'A single forced order at or above the notional.' },
  { type: 'liq_cascade', label: 'Liquidation cascade', valueLabel: 'Total notional $', defaultValue: 5_000_000, defaultWindow: 60, help: 'Sum of liquidations inside the window.' },
  { type: 'cvd_divergence', label: 'CVD divergence', valueLabel: 'Min price move %', defaultValue: 0.2, defaultWindow: 600, help: 'Price makes a higher high (lower low) while CVD makes a lower high (higher low).' },
  { type: 'absorption', label: 'Absorption', valueLabel: 'Min notional at level $', defaultValue: 2_000_000, defaultWindow: 30, help: 'Heavy aggression into one level while price holds within 3 ticks.' },
  { type: 'wall_appear', label: 'Wall appears', valueLabel: 'Min resting $', defaultValue: 5_000_000, defaultWindow: 0, help: 'Resting size above threshold appears within 1% of mid.' },
  { type: 'wall_pulled', label: 'Wall pulled', valueLabel: 'Min resting $', defaultValue: 5_000_000, defaultWindow: 0, help: 'A tracked wall disappears without price trading through it.' },
  { type: 'volume_spike', label: 'Volume spike', valueLabel: 'Multiple of average ×', defaultValue: 4, defaultWindow: 60, help: 'Window volume versus the average of the previous 10 windows.' },
  { type: 'delta_spike', label: 'Delta spike', valueLabel: 'Min |delta| $', defaultValue: 3_000_000, defaultWindow: 60, help: 'Net aggressive buying or selling inside the window.' },
  { type: 'oi_change', label: 'Open interest change', valueLabel: 'Min change %', defaultValue: 1, defaultWindow: 300, help: 'Primary open interest change over the window.' },
];

export function newRule(type: AlertType): AlertRule {
  const meta = ALERT_TYPES.find((a) => a.type === type)!;
  let value = meta.defaultValue;
  if (type === 'price_above' || type === 'price_below') {
    const p = hub().primary.lastPrice();
    value = isFinite(p) ? Number(p.toPrecision(5)) : 0;
  }
  // alerts follow the market on the chart unless the owner widens them
  return { id: uid(), type, enabled: true, scope: 'primary', value, windowSec: meta.defaultWindow, cooldownSec: 30, sound: true, notify: false };
}

export interface Toast {
  id: string;
  time: number;
  title: string;
  message: string;
  tone: 'info' | 'buy' | 'sell' | 'warn';
}

export const useToasts = create<{ toasts: Toast[]; push(t: Omit<Toast, 'id' | 'time'>): void; dismiss(id: string): void }>((set) => ({
  toasts: [],
  push: (t) => {
    const toast = { ...t, id: uid(), time: Date.now() };
    set((s) => ({ toasts: [...s.toasts.slice(-4), toast] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== toast.id) })), 7000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

let audioCtx: AudioContext | null = null;
export function beep(freq = 880, ms = 140) {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.type = 'sine';
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + ms / 1000);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + ms / 1000);
  } catch {
    /* audio unavailable */
  }
}

/** Evaluates alert rules against the live feed. Runs only while the tab is open. */
export class AlertEngine {
  private lastFired = new Map<string, number>();
  private prevPrice = new Map<string, number>();
  private liqWindow: { time: number; usd: number; feed: Feed }[] = [];
  private walls = new Map<string, Map<number, { usd: number; side: 'bid' | 'ask' }>>();
  private lastSlow = 0;
  private timer: ReturnType<typeof setInterval>;
  private offs: (() => void)[] = [];

  constructor() {
    const h = hub();
    this.offs.push(h.onTrade((t, f) => this.onTrade(t, f)));
    this.offs.push(h.onLiq((l, f) => this.onLiq(l, f)));
    this.timer = setInterval(() => this.evaluate(), 500);
  }

  dispose() {
    clearInterval(this.timer);
    for (const o of this.offs) o();
  }

  private rules(type?: AlertType) {
    return getSettings().alerts.filter((r) => r.enabled && (!type || r.type === type));
  }

  private inScope(r: AlertRule, f: Feed) {
    return r.scope === 'aggregate' || f === hub().primary;
  }

  fire(r: AlertRule, message: string, tone: Toast['tone'] = 'info', price?: number) {
    const now = Date.now();
    const last = this.lastFired.get(r.id) ?? 0;
    if (now - last < r.cooldownSec * 1000) return;
    this.lastFired.set(r.id, now);
    const meta = ALERT_TYPES.find((a) => a.type === r.type)!;
    useSettings.getState().pushFired({ id: uid(), ruleId: r.id, type: r.type, time: now, message, price });
    useToasts.getState().push({ title: meta.label + (r.note ? ` — ${r.note}` : ''), message, tone });
    forwardAlert(meta.label + (r.note ? ` — ${r.note}` : ''), message);
    if (r.sound && getSettings().soundEnabled) beep(tone === 'sell' ? 520 : tone === 'buy' ? 980 : 760);
    if (r.notify && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(meta.label, { body: message, tag: r.id });
      } catch {
        /* ignore */
      }
    }
  }

  private onTrade(t: Trade, f: Feed) {
    for (const r of this.rules('large_trade')) {
      const usd = t.price * t.qty;
      if (usd >= r.value && this.inScope(r, f)) this.fire(r, `${f.adapter.short} ${f.inst.symbol} ${t.side.toUpperCase()} ${fmtUsd(usd)} @ ${fmtPrice(t.price)}`, t.side, t.price);
    }
  }

  private onLiq(l: Liquidation, f: Feed) {
    const usd = l.price * l.qty;
    this.liqWindow.push({ time: l.time, usd, feed: f });
    for (const r of this.rules('liquidation')) {
      if (usd >= r.value && this.inScope(r, f)) this.fire(r, `${f.adapter.short} ${f.inst.symbol} ${l.position.toUpperCase()} liquidated ${fmtUsd(usd)} @ ${fmtPrice(l.price)}`, l.position === 'long' ? 'sell' : 'buy', l.price);
    }
  }

  private evaluate() {
    const h = hub();
    const now = Date.now();
    const primary = h.primary;
    const price = primary.lastPrice();

    for (const r of this.rules()) {
      switch (r.type) {
        case 'price_above':
        case 'price_below': {
          if (!isFinite(price)) break;
          const prev = this.prevPrice.get(r.id);
          this.prevPrice.set(r.id, price);
          if (prev === undefined) break;
          if (r.type === 'price_above' && prev < r.value && price >= r.value) this.fire(r, `${primary.inst.symbol} crossed above ${fmtPrice(r.value)}`, 'buy', price);
          if (r.type === 'price_below' && prev > r.value && price <= r.value) this.fire(r, `${primary.inst.symbol} crossed below ${fmtPrice(r.value)}`, 'sell', price);
          break;
        }
        case 'liq_cascade': {
          const cutoff = now - r.windowSec * 1000;
          const sum = this.liqWindow.filter((x) => x.time >= cutoff && this.inScope(r, x.feed)).reduce((a, x) => a + x.usd, 0);
          const where = r.scope === 'primary' ? `${primary.adapter.short} ${primary.inst.symbol}` : `${primary.inst.base} (all venues)`;
          if (sum >= r.value) this.fire(r, `${where}: ${fmtUsd(sum)} liquidated in ${r.windowSec}s`, 'warn');
          break;
        }
      }
    }
    this.liqWindow = this.liqWindow.filter((x) => x.time >= now - 3_600_000);
    this.evaluateWalls();

    // heavier checks at 0.5Hz
    if (now - this.lastSlow < 2000) return;
    this.lastSlow = now;
    for (const r of this.rules()) {
      const feeds = r.scope === 'primary' ? [primary] : h.aggregate;
      switch (r.type) {
        case 'volume_spike': {
          const w = r.windowSec * 1000;
          let cur = 0;
          let prev = 0;
          for (const f of feeds) {
            const a = flowWindow(f.store, w, now);
            const b = flowWindow(f.store, w * 11, now);
            cur += a.buyNotional + a.sellNotional;
            prev += b.buyNotional + b.sellNotional - (a.buyNotional + a.sellNotional);
          }
          const avg = prev / 10;
          if (avg > 0 && cur >= avg * r.value) this.fire(r, `${fmtUsd(cur)} traded in ${r.windowSec}s (${(cur / avg).toFixed(1)}× avg)`, 'warn');
          break;
        }
        case 'delta_spike': {
          let delta = 0;
          for (const f of feeds) {
            const a = flowWindow(f.store, r.windowSec * 1000, now);
            delta += a.buyNotional - a.sellNotional;
          }
          if (Math.abs(delta) >= r.value) this.fire(r, `Net ${delta > 0 ? 'buying' : 'selling'} ${fmtUsd(Math.abs(delta))} in ${r.windowSec}s`, delta > 0 ? 'buy' : 'sell');
          break;
        }
        case 'absorption': {
          if (!isFinite(price)) break;
          const tick = autoResolution(price);
          const from = now - r.windowSec * 1000;
          const levels = volumeProfile(primary.store, from, now + 1, tick);
          if (!levels.size) break;
          const prices = [...levels.keys()];
          const range = Math.max(...prices) - Math.min(...prices);
          if (range > tick * 3 + 1e-9) break;
          for (const [p, l] of levels) {
            const usd = (l.buy + l.sell) * p;
            if (usd >= r.value) {
              const sellerHit = l.sell > l.buy;
              this.fire(r, `${fmtUsd(usd)} ${sellerHit ? 'sold into bids' : 'bought into offers'} at ${fmtPrice(p)} — price held`, sellerHit ? 'buy' : 'sell', p);
              break;
            }
          }
          break;
        }
        case 'cvd_divergence': {
          const w = r.windowSec * 1000;
          const pts = cvdSeries(primary.store, w, Math.max(1000, w / 40), now);
          if (pts.length < 10) break;
          const half = Math.floor(pts.length / 2);
          const a = pts.slice(0, half);
          const b = pts.slice(half);
          const maxP = (x: typeof pts) => Math.max(...x.map((p) => p.price));
          const minP = (x: typeof pts) => Math.min(...x.map((p) => p.price));
          const maxC = (x: typeof pts) => Math.max(...x.map((p) => p.cvd));
          const minC = (x: typeof pts) => Math.min(...x.map((p) => p.cvd));
          const move = r.value / 100;
          if (maxP(b) > maxP(a) * (1 + move) && maxC(b) < maxC(a)) this.fire(r, `Bearish: price higher high ${fmtPrice(maxP(b))} while CVD lower high`, 'sell', maxP(b));
          else if (minP(b) < minP(a) * (1 - move) && minC(b) > minC(a)) this.fire(r, `Bullish: price lower low ${fmtPrice(minP(b))} while CVD higher low`, 'buy', minP(b));
          break;
        }
        case 'oi_change': {
          const pts = primary.oi.items;
          if (pts.length < 2) break;
          const lastPt = pts[pts.length - 1];
          const ref = [...pts].reverse().find((p) => p.time <= lastPt.time - r.windowSec * 1000);
          if (!ref || !ref.value) break;
          const pct = ((lastPt.value - ref.value) / ref.value) * 100;
          if (Math.abs(pct) >= r.value) this.fire(r, `OI ${pct > 0 ? '+' : ''}${pct.toFixed(2)}% in ${Math.round(r.windowSec / 60)}m (${fmtUsd(lastPt.value)})`, pct > 0 ? 'buy' : 'sell');
          break;
        }
      }
    }
  }

  private evaluateWalls() {
    const rules = this.rules().filter((r) => r.type === 'wall_appear' || r.type === 'wall_pulled');
    if (!rules.length) return;
    const h = hub();
    for (const r of rules) {
      const feeds = r.scope === 'primary' ? [h.primary] : h.aggregate;
      for (const f of feeds) {
        const mid = f.book.mid();
        if (!isFinite(mid)) continue;
        const key = `${r.id}:${f.key}`;
        const prev = this.walls.get(key);
        const cur = new Map<number, { usd: number; side: 'bid' | 'ask' }>();
        for (const [p, q] of f.book.bids) if (p >= mid * 0.99 && p * q >= r.value) cur.set(p, { usd: p * q, side: 'bid' });
        for (const [p, q] of f.book.asks) if (p <= mid * 1.01 && p * q >= r.value) cur.set(p, { usd: p * q, side: 'ask' });
        this.walls.set(key, cur);
        if (!prev) continue; // first observation primes the tracker
        if (r.type === 'wall_appear') {
          for (const [p, w] of cur) if (!prev.has(p)) this.fire(r, `${f.adapter.short} ${w.side} wall ${fmtUsd(w.usd)} at ${fmtPrice(p)}`, w.side === 'bid' ? 'buy' : 'sell', p);
        } else {
          const last = f.lastPrice();
          for (const [p, w] of prev) {
            if (cur.has(p)) continue;
            const tradedThrough = w.side === 'bid' ? last <= p : last >= p;
            const stillOnBook = (w.side === 'bid' ? f.book.bids.get(p) : f.book.asks.get(p)) ?? 0;
            if (!tradedThrough && stillOnBook * p < r.value * 0.3) this.fire(r, `${f.adapter.short} ${w.side} wall ${fmtUsd(w.usd)} pulled at ${fmtPrice(p)}`, 'warn', p);
          }
        }
      }
    }
  }
}

let engine: AlertEngine | null = null;
export function startAlerts() {
  engine ??= new AlertEngine();
  return engine;
}

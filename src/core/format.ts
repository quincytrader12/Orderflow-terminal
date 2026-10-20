import { decimalsOf } from './orderbook';

// Creating an Intl formatter is slow; prices are formatted thousands of times a second
const priceFormats = new Map<number, Intl.NumberFormat>();
function priceFormat(d: number): Intl.NumberFormat {
  let f = priceFormats.get(d);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    priceFormats.set(d, f);
  }
  return f;
}

export function fmtPrice(p: number, tick?: number): string {
  if (!isFinite(p)) return '—';
  const d = tick ? decimalsOf(tick) : p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 4 : 6;
  return priceFormat(Math.min(12, d)).format(p);
}

/** HH:MM:SS.mmm in local time, without Intl. */
export function fmtTimeMs(t: number): string {
  const d = new Date(t);
  const two = (n: number) => (n < 10 ? '0' : '') + n;
  const ms = d.getMilliseconds();
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}`;
}

/** Compact number: 1.23K, 4.5M, 7.8B */
export function fmtNum(v: number, digits = 2): string {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e12) return sign + (a / 1e12).toFixed(digits) + 'T';
  if (a >= 1e9) return sign + (a / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return sign + (a / 1e6).toFixed(digits) + 'M';
  if (a >= 1e3) return sign + (a / 1e3).toFixed(digits) + 'K';
  if (a >= 100) return sign + a.toFixed(0);
  if (a >= 1) return sign + a.toFixed(digits);
  if (a === 0) return '0';
  return sign + a.toPrecision(digits + 1);
}

export function fmtUsd(v: number, digits = 2): string {
  if (!isFinite(v)) return '—';
  return (v < 0 ? '-$' : '$') + fmtNum(Math.abs(v), digits);
}

/** Footprint cell volumes: integers when large, otherwise up to 2 decimals. */
export function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'K';
  if (a >= 1000) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a === 0) return '0';
  return v.toFixed(2);
}

export function fmtPct(v: number, digits = 2): string {
  if (!isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

export function fmtTime(t: number, seconds = true): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!seconds) return `${hh}:${mm}`;
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function fmtDateTime(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(t, false)}`;
}

export function fmtAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

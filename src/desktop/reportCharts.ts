import { fmtPrice } from '../core/format';
import type { Kline } from '../core/types';
import type { ValueLevels } from '../shared/report';
import { font, line } from '../ui/canvas';
import { palette, rgba, type Palette } from '../ui/theme';
import type { AmtSnapshot } from './bridge';

/** Report images: drawn off-screen in the current theme and encoded as PNG. */

function surface(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w * 2;
  c.height = h * 2;
  const ctx = c.getContext('2d')!;
  ctx.scale(2, 2);
  const pal = palette();
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, w, h);
  return { c, ctx, pal };
}

async function png(c: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('could not encode chart image');
  return new Uint8Array(await blob.arrayBuffer());
}

function header(ctx: CanvasRenderingContext2D, pal: Palette, w: number, title: string, subtitle: string) {
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = pal.text;
  ctx.font = font(20, 700, false);
  ctx.fillText(title, 24, 30);
  ctx.textAlign = 'right';
  ctx.fillStyle = pal.muted;
  ctx.font = font(13, 400, false);
  ctx.fillText(subtitle, w - 24, 30);
}

function watermark(ctx: CanvasRenderingContext2D, pal: Palette, h: number) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = pal.muted;
  ctx.font = font(11, 600, false);
  ctx.fillText('NOVUS ORDO · by Quincy Gininda', 24, h - 10);
}

/** Candles with volume, value area (VAH/POC/VAL), prior value and the profile. */
export async function priceChart(opts: { title: string; subtitle: string; klines: Kline[]; value: ValueLevels | null; prior?: ValueLevels | null; last: number; weekly: boolean }): Promise<Uint8Array> {
  const W = 1280;
  const H = 720;
  const { c, ctx, pal } = surface(W, H);
  header(ctx, pal, W, opts.title, opts.subtitle);
  const ks = opts.klines;
  const v = opts.value;
  const left = 24;
  const profW = 170;
  const axisW = 78;
  const right = W - profW - axisW - 24;
  const top = 64;
  const volH = 90;
  const bottom = H - 34 - volH;
  const prices = ks.flatMap((k) => [k.high, k.low]);
  if (v) prices.push(v.vah, v.val, v.poc);
  if (opts.prior) prices.push(opts.prior.vah, opts.prior.val);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.05 || hi * 0.001;
  lo -= pad;
  hi += pad;
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);

  // grid and price axis
  ctx.font = font(11);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 6; i++) {
    const p = lo + ((hi - lo) * i) / 6;
    line(ctx, left, y(p), right + profW, y(p), pal.grid);
    ctx.fillStyle = pal.muted;
    ctx.fillText(fmtPrice(p), right + profW + 8, y(p));
  }

  // value area band and prior value
  if (v) {
    ctx.fillStyle = rgba(pal.buyRgb, 0.07);
    ctx.fillRect(left, y(v.vah), right + profW - left, y(v.val) - y(v.vah));
  }
  if (opts.prior) {
    line(ctx, left, y(opts.prior.vah), right, y(opts.prior.vah), pal.warn, 1, [2, 4]);
    line(ctx, left, y(opts.prior.val), right, y(opts.prior.val), pal.warn, 1, [2, 4]);
  }

  // candles + volume
  const n = ks.length || 1;
  const cw = (right - left) / n;
  const maxVol = Math.max(...ks.map((k) => k.volume), 1e-12);
  ks.forEach((k, i) => {
    const x = left + i * cw + cw / 2;
    const up = k.close >= k.open;
    ctx.strokeStyle = ctx.fillStyle = up ? pal.buy : pal.sell;
    line(ctx, x, y(k.high), x, y(k.low), up ? pal.buy : pal.sell);
    const bh = Math.max(1, Math.abs(y(k.open) - y(k.close)));
    ctx.fillRect(x - cw * 0.35, Math.min(y(k.open), y(k.close)), Math.max(1, cw * 0.7), bh);
    ctx.fillStyle = rgba(up ? pal.buyRgb : pal.sellRgb, 0.45);
    const vh = (k.volume / maxVol) * (volH - 10);
    ctx.fillRect(x - cw * 0.35, H - 34 - vh, Math.max(1, cw * 0.7), vh);
  });

  // time axis
  ctx.fillStyle = pal.muted;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const every = Math.max(1, Math.round(n / 8));
  for (let i = 0; i < n; i += every) {
    const d = new Date(ks[i].time);
    const label = opts.weekly ? d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, left + i * cw + cw / 2, H - 30);
  }

  // volume profile on the right
  if (v?.profile.length) {
    const maxP = Math.max(...v.profile.map((r) => r[1]), 1e-12);
    const rowH = Math.max(1, ((bottom - top) / v.profile.length) * ((v.high - v.low) / (hi - lo || 1)) - 1);
    for (const [p, vol] of v.profile) {
      const inVa = p <= v.vah && p >= v.val;
      ctx.fillStyle = inVa ? rgba(pal.buyRgb, 0.55) : rgba(pal.buyRgb, 0.25);
      const bw = (vol / maxP) * (profW - 12);
      ctx.fillRect(right + 6, y(p) - rowH / 2, bw, rowH);
    }
  }

  // levels
  const level = (p: number, color: string, label: string, dash?: number[]) => {
    line(ctx, left, y(p), right + profW, y(p), color, 1.2, dash);
    ctx.font = font(11, 700);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const text = `${label} ${fmtPrice(p)}`;
    ctx.fillStyle = pal.bg;
    ctx.fillRect(left + 2, y(p) - 16, ctx.measureText(text).width + 6, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, left + 5, y(p) - 2);
  };
  if (v) {
    level(v.vah, pal.muted, 'VAH', [5, 4]);
    level(v.val, pal.muted, 'VAL', [5, 4]);
    level(v.poc, pal.poc, 'POC');
  }
  if (opts.prior) {
    ctx.fillStyle = pal.warn;
    ctx.font = font(10);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`prior VAH ${fmtPrice(opts.prior.vah)}`, right - 4, y(opts.prior.vah) - 2);
    ctx.fillText(`prior VAL ${fmtPrice(opts.prior.val)}`, right - 4, y(opts.prior.val) - 2);
  }
  // last price tag
  if (isFinite(opts.last)) {
    const yy = y(opts.last);
    line(ctx, left, yy, right + profW, yy, pal.accent, 1, [1, 3]);
    ctx.fillStyle = pal.accent;
    ctx.fillRect(right + profW + 2, yy - 10, axisW, 20);
    ctx.fillStyle = pal.dark ? '#000' : '#fff';
    ctx.font = font(12, 700);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtPrice(opts.last), right + profW + 7, yy);
  }
  watermark(ctx, pal, H);
  return png(c);
}

/** Cumulative bot PnL. */
export async function equityChart(opts: { title: string; subtitle: string; points: [number, number][] }): Promise<Uint8Array> {
  const W = 1280;
  const H = 560;
  const { c, ctx, pal } = surface(W, H);
  header(ctx, pal, W, opts.title, opts.subtitle);
  const pts: [number, number][] = [[opts.points[0]?.[0] ?? 0, 0], ...opts.points];
  const left = 24;
  const right = W - 110;
  const top = 70;
  const bottom = H - 40;
  const vals = pts.map((p) => p[1]);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const x = (i: number) => left + (i / Math.max(1, pts.length - 1)) * (right - left);
  const y = (v: number) => bottom - ((v - lo) / span) * (bottom - top);
  ctx.font = font(11);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span * i) / 4;
    line(ctx, left, y(v), right, y(v), pal.grid);
    ctx.fillStyle = pal.muted;
    ctx.fillText(`${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`, right + 10, y(v));
  }
  line(ctx, left, y(0), right, y(0), pal.muted, 1, [4, 4]);
  const final = vals[vals.length - 1];
  const col = final >= 0 ? pal.buy : pal.sell;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))));
  ctx.strokeStyle = col;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.lineTo(x(pts.length - 1), y(0));
  ctx.lineTo(x(0), y(0));
  ctx.closePath();
  ctx.fillStyle = rgba(final >= 0 ? pal.buyRgb : pal.sellRgb, 0.12);
  ctx.fill();
  ctx.fillStyle = pal.muted;
  ctx.textAlign = 'center';
  ctx.fillText(`${pts.length - 1} trades`, (left + right) / 2, H - 22);
  watermark(ctx, pal, H);
  return png(c);
}

/** A bot's entry: profile around price with value area, entry, stop and target. */
export async function botEntryChart(s: AmtSnapshot, title: string): Promise<Uint8Array> {
  const W = 960;
  const H = 540;
  const { c, ctx, pal } = surface(W, H);
  header(ctx, pal, W, title, `${s.symbol} · ${s.exchange}${s.sandbox ? ' (testnet)' : ''}`);
  const rows = s.profile;
  const levels = [s.last, s.va?.vah, s.va?.val, s.position?.stop, s.position?.target].filter((p): p is number => p !== undefined && isFinite(p));
  const lo = Math.min(rows[0]?.[0] ?? s.last, ...levels);
  const hi = Math.max(rows[rows.length - 1]?.[0] ?? s.last, ...levels);
  const pad = (hi - lo) * 0.06 || 1;
  const top = 64;
  const bottom = H - 40;
  const y = (p: number) => bottom - ((p - (lo - pad)) / (hi - lo + 2 * pad)) * (bottom - top);
  const left = 150;
  const right = W - 24;
  if (s.va) {
    ctx.fillStyle = rgba(pal.buyRgb, 0.07);
    ctx.fillRect(left, y(s.va.vah), right - left, y(s.va.val) - y(s.va.vah));
  }
  const max = Math.max(...rows.map((r) => r[1]), 1e-12);
  const rowH = Math.max(1, (bottom - top) / Math.max(rows.length, 1) - 1);
  for (const [p, v, d] of rows) {
    ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, s.va && p <= s.va.vah && p >= s.va.val ? 0.65 : 0.3);
    ctx.fillRect(left, y(p) - rowH / 2, (v / max) * (right - left) * 0.85, rowH);
  }
  const mark = (p: number | undefined, color: string, label: string, dash?: number[]) => {
    if (p === undefined || !isFinite(p)) return;
    line(ctx, left - 4, y(p), right, y(p), color, 1.5, dash);
    ctx.fillStyle = color;
    ctx.font = font(13, 700);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${label} ${fmtPrice(p)}`, left - 10, y(p));
  };
  if (s.va) {
    mark(s.va.vah, pal.muted, 'VAH', [5, 4]);
    mark(s.va.val, pal.muted, 'VAL', [5, 4]);
    mark(s.va.poc, pal.poc, 'POC');
  }
  if (s.position) {
    mark(s.position.target, pal.buy, 'TP', [3, 3]);
    mark(s.position.stop, pal.sell, 'SL', [3, 3]);
    mark(s.position.entry, pal.accent, 'IN');
  }
  watermark(ctx, pal, H);
  return png(c);
}

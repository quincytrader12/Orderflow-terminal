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
/**
 * The picture sent with a bot entry: the last hour of one-minute candles
 * with the entry marked, the risk (to the stop) and the reward (to the
 * target) shaded from the entry on, the value area and POC, and the volume
 * profile beside it. Before any candles exist, the profile alone.
 */
export async function botEntryChart(s: AmtSnapshot, title: string): Promise<Uint8Array> {
  const W = 960;
  const H = 600;
  const { c, ctx, pal } = surface(W, H);
  header(ctx, pal, W, title, `${s.symbol} · ${s.exchange}${s.sandbox ? ' (testnet)' : ''}`);
  const ks = s.candles ?? [];
  const pos = s.position;
  const rows = s.profile;
  const axisW = 92;
  const profW = ks.length ? 150 : 0;
  const left = 24;
  const right = W - axisW - profW - 16;
  const top = 64;
  const bottom = H - 64;
  const levels = [s.last, s.va?.vah, s.va?.val, s.va?.poc, pos?.stop, pos?.target, pos?.entry].filter((p): p is number => p !== undefined && isFinite(p));
  const prices = [...levels, ...ks.flatMap((k) => [k[2], k[3]])];
  if (!ks.length) prices.push(...rows.filter((r) => r[1] > 0).map((r) => r[0]));
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = (hi - lo) * 0.06 || hi * 0.001 || 1;
  lo -= pad;
  hi += pad;
  const y = (p: number) => bottom - ((p - lo) / (hi - lo)) * (bottom - top);
  const chartR = ks.length ? right : W - axisW - 16;

  // the levels labelled on the axis; grid labels keep clear of them
  const tags: { p: number; color: string; label: string; dash?: number[] }[] = [];
  if (s.va) tags.push({ p: s.va.vah, color: pal.muted, label: 'VAH', dash: [5, 4] }, { p: s.va.val, color: pal.muted, label: 'VAL', dash: [5, 4] }, { p: s.va.poc, color: pal.poc, label: 'POC', dash: [2, 3] });
  if (pos) tags.push({ p: pos.target, color: pal.buy, label: 'TP', dash: [4, 3] }, { p: pos.stop, color: pal.sell, label: 'SL', dash: [4, 3] }, { p: pos.entry, color: pal.accent, label: 'IN' });

  // grid and price axis
  ctx.font = font(11);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 6; i++) {
    const p = lo + ((hi - lo) * i) / 6;
    line(ctx, left, y(p), W - axisW - 8, y(p), pal.grid);
    if (tags.some((g) => Math.abs(y(g.p) - y(p)) < 14)) continue;
    ctx.fillStyle = pal.muted;
    ctx.fillText(fmtPrice(p), W - axisW, y(p));
  }
  if (s.va) {
    ctx.fillStyle = rgba(pal.buyRgb, 0.06);
    ctx.fillRect(left, y(s.va.vah), W - axisW - 8 - left, y(s.va.val) - y(s.va.vah));
  }

  // candles, with the entry candle found by time
  const n = Math.max(ks.length, 1);
  const cw = (chartR - left) / (n + 4); // room on the right for the plan zones
  const xAt = (i: number) => left + i * cw + cw / 2;
  let entryX = chartR - 4 * cw;
  ks.forEach((k, i) => {
    const [t, o, h, l, cl] = k;
    const up = cl >= o;
    const col = up ? pal.buy : pal.sell;
    const x = xAt(i);
    line(ctx, x, y(h), x, y(l), col);
    ctx.fillStyle = col;
    ctx.fillRect(x - cw * 0.35, Math.min(y(o), y(cl)), Math.max(1, cw * 0.7), Math.max(1, Math.abs(y(o) - y(cl))));
    if (pos && t <= pos.t && pos.t < t + 60_000) entryX = x;
  });

  // the plan: risk and reward shaded from the entry on
  if (pos) {
    const zoneR = W - axisW - profW - 16;
    ctx.fillStyle = rgba(pal.sellRgb, 0.14);
    ctx.fillRect(entryX, Math.min(y(pos.entry), y(pos.stop)), zoneR - entryX, Math.abs(y(pos.entry) - y(pos.stop)));
    ctx.fillStyle = rgba(pal.buyRgb, 0.14);
    ctx.fillRect(entryX, Math.min(y(pos.entry), y(pos.target)), zoneR - entryX, Math.abs(y(pos.entry) - y(pos.target)));
    // entry marker
    const up = pos.side === 'buy';
    const ey = y(pos.entry);
    ctx.fillStyle = pal.accent;
    ctx.beginPath();
    ctx.moveTo(entryX, ey + (up ? 6 : -6));
    ctx.lineTo(entryX - 7, ey + (up ? 18 : -18));
    ctx.lineTo(entryX + 7, ey + (up ? 18 : -18));
    ctx.closePath();
    ctx.fill();
  }

  // volume profile beside the candles (or alone, before there are any)
  if (rows.length) {
    const pl = ks.length ? right + 8 : left;
    const pw = ks.length ? profW - 8 : chartR - left;
    const max = Math.max(...rows.map((r) => r[1]), 1e-12);
    const rowH = Math.max(1, Math.abs(y(rows[0][0]) - y(rows[Math.min(1, rows.length - 1)][0])) - 1);
    for (const [p, v, d] of rows) {
      if (p < lo || p > hi) continue;
      ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, s.va && p <= s.va.vah && p >= s.va.val ? 0.55 : 0.25);
      ctx.fillRect(pl, y(p) - rowH / 2, (v / max) * pw * 0.9, rowH);
    }
  }

  // levels: lines across, labels on the axis pushed apart so none hides another
  for (const g of tags) if (isFinite(g.p)) line(ctx, left, y(g.p), W - axisW - 8, y(g.p), g.color, 1.4, g.dash);
  const placed = tags.filter((g) => isFinite(g.p)).map((g) => ({ ...g, ly: y(g.p) })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < placed.length; i++) placed[i].ly = Math.max(placed[i].ly, placed[i - 1].ly + 20);
  ctx.font = font(11, 700);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const g of placed) {
    const text = `${g.label} ${fmtPrice(g.p)}`;
    if (Math.abs(g.ly - y(g.p)) > 1) line(ctx, W - axisW - 8, y(g.p), W - axisW - 6, g.ly, g.color, 1);
    ctx.fillStyle = g.color;
    ctx.fillRect(W - axisW - 6, g.ly - 9, Math.min(axisW + 4, ctx.measureText(text).width + 8), 18);
    ctx.fillStyle = pal.bg;
    ctx.fillText(text, W - axisW - 2, g.ly);
  }

  // time axis
  ctx.fillStyle = pal.muted;
  ctx.font = font(11);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const every = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < ks.length; i += every) ctx.fillText(new Date(ks[i][0]).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), xAt(i), bottom + 8);

  // the plan in one line
  if (pos) {
    const dir = pos.side === 'buy' ? 1 : -1;
    const risk = Math.abs(pos.entry - pos.stop);
    const rr = risk > 0 ? ((pos.target - pos.entry) * dir) / risk : NaN;
    const pct = (p: number) => `${p >= pos.entry ? '+' : '−'}${((Math.abs(p - pos.entry) / pos.entry) * 100).toFixed(2)}%`;
    ctx.font = font(13, 600, false);
    ctx.fillStyle = pal.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`Entry ${fmtPrice(pos.entry)} · stop ${pct(pos.stop)} · target ${pct(pos.target)}${isFinite(rr) ? ` · ${rr.toFixed(1)}R` : ''}`, W - 24, H - 12);
  }
  watermark(ctx, pal, H);
  return png(c);
}

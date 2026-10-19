import { useRef } from 'react';
import { fmtPrice, fmtUsd, fmtVol } from '../core/format';
import { niceStep } from '../core/heatmap';
import { buildTpo, ema, sma, TPO_LETTERS, vwap } from '../core/indicators';
import { bucket } from '../core/orderbook';
import type { Kline } from '../core/types';
import type { TradeStore } from '../core/tradeStore';
import { intervalMinutes } from '../exchanges/adapter';
import { hub } from '../market/hub';
import { axisTicks, Canvas, font, label, line, type DrawContext, type PointerState, mask } from '../ui/canvas';
import { Check, Chip, Empty, NumberInput, Popover, Select, Spacer, Toolbar, useHubVersion, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';
import { baseTick, drawTooltip } from './FootprintChart';
import { useKlines } from './shared/useKlines';

export interface HistoricalConfig {
  mode: 'candles' | 'tpo';
  interval: string;
  volume: boolean;
  vwap: boolean;
  svp: boolean;
  ma: boolean;
  emaCloud: boolean;
  tpoTickMult: number;
  tpoSessions: number;
}

export const HISTORICAL_DEFAULTS: HistoricalConfig = {
  mode: 'candles',
  interval: '15m',
  volume: true,
  vwap: true,
  svp: false,
  ma: true,
  emaCloud: false,
  tpoTickMult: 50,
  tpoSessions: 5,
};

const AXIS_W = 74;
const TIME_H = 18;
const DAY = 86400e3;

/** Extend REST klines with live trades from the store so the last bar ticks in real time. */
export function withLiveBars(bars: Kline[], store: TradeStore, intervalMs: number): Kline[] {
  if (!bars.length || !store.length) return bars;
  const out = bars.slice();
  const last = out[out.length - 1];
  const from = last.time;
  const start = store.indexAtTime(from);
  if (start >= store.end) return out;
  // rebuild the last REST bar from trades only if the store covers its full span
  const coversLast = store.firstTime() <= from;
  let cur: Kline | null = coversLast ? null : { ...last };
  if (!coversLast) out[out.length - 1] = cur!;
  else out.pop();
  store.forEach(start, store.end, (p, q, buy, t) => {
    const bt = Math.floor(t / intervalMs) * intervalMs;
    if (!cur || bt > cur.time) {
      cur = { time: bt, open: p, high: p, low: p, close: p, volume: 0, buyVolume: 0 };
      out.push(cur);
    }
    if (p > cur.high) cur.high = p;
    if (p < cur.low) cur.low = p;
    cur.close = p;
    // the REST bar already contains part of this volume when trades only partly cover it
    if (!coversLast && cur.time === from) return;
    cur.volume += q;
    if (buy) cur.buyVolume = (cur.buyVolume ?? 0) + q;
  });
  return out;
}

export function HistoricalChart({ config: c, setConfig }: PanelProps<HistoricalConfig>) {
  useHubVersion();
  const feed = hub().primary;
  const k = useKlines(feed, c.mode === 'tpo' ? '30m' : c.interval, c.mode === 'tpo' ? Math.min(1000, 48 * (c.tpoSessions + 1)) : 1000, 60_000);
  const view = useRef({ barW: 8, offset: 0 });
  const pointer = useRef<PointerState | null>(null);

  const draw = (d: DrawContext) => {
    const ivMs = (c.mode === 'tpo' ? 30 : intervalMinutes(c.interval)) * 60_000;
    const bars = withLiveBars(k.bars, hub().primary.store, ivMs);
    if (!bars.length) return;
    if (c.mode === 'tpo') drawTpo(d, bars);
    else drawCandles(d, bars, ivMs);
  };

  const drawCandles = ({ ctx, w, h, pal }: DrawContext, bars: Kline[], ivMs: number) => {
    const v = view.current;
    const plotW = w - AXIS_W;
    const plotH = h - TIME_H;
    const volH = c.volume ? plotH * 0.16 : 0;
    const priceH = plotH - volH;
    const n = bars.length;
    const rightPad = 40;
    const slotX = (i: number) => plotW - rightPad - (n - i - v.offset) * v.barW;
    const first = Math.max(0, Math.floor(n - v.offset - (plotW - rightPad) / v.barW) - 1);
    const last = Math.min(n - 1, Math.ceil(n - v.offset + rightPad / v.barW));
    if (last < first) return;
    let lo = Infinity;
    let hi = -Infinity;
    let maxVol = 0;
    for (let i = first; i <= last; i++) {
      lo = Math.min(lo, bars[i].low);
      hi = Math.max(hi, bars[i].high);
      maxVol = Math.max(maxVol, bars[i].volume);
    }
    const pad = (hi - lo) * 0.06 || hi * 0.001;
    lo -= pad;
    hi += pad;
    const y = (p: number) => 6 + ((hi - p) / (hi - lo)) * (priceH - 12);
    for (const p of axisTicks(lo, hi, priceH / 44)) line(ctx, 0, Math.round(y(p)) + 0.5, plotW, Math.round(y(p)) + 0.5, pal.grid);

    const closes = bars.map((b) => b.close);
    const cx = (i: number) => slotX(i) + v.barW / 2;
    const path = (vals: number[], color: string, width = 1.3) => {
      ctx.beginPath();
      let started = false;
      for (let i = first; i <= last; i++) {
        if (!isFinite(vals[i])) continue;
        if (started) ctx.lineTo(cx(i), y(vals[i]));
        else ctx.moveTo(cx(i), y(vals[i]));
        started = true;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    // session volume profiles (volume spread evenly over each bar's range)
    if (c.svp) {
      const rowTick = niceStep((hi - lo) / 90);
      let sStart = Math.floor(bars[first].time / DAY) * DAY;
      while (sStart <= bars[last].time) {
        const sEnd = sStart + DAY;
        const prof = new Map<number, number>();
        let iFirst = -1;
        let iLast = -1;
        for (let i = first; i <= last; i++) {
          const b = bars[i];
          if (b.time < sStart || b.time >= sEnd) continue;
          if (iFirst < 0) iFirst = i;
          iLast = i;
          const rows = Math.max(1, Math.round((b.high - b.low) / rowTick) + 1);
          for (let r = 0; r < rows; r++) {
            const p = bucket(b.low + r * rowTick, rowTick, 'floor');
            prof.set(p, (prof.get(p) ?? 0) + b.volume / rows);
          }
        }
        if (iFirst >= 0) {
          const x0 = slotX(iFirst);
          const width = (iLast - iFirst + 1) * v.barW * 0.4;
          const mx = Math.max(...prof.values());
          let poc = 0;
          for (const [p, val] of prof) {
            if (val === mx) poc = p;
            ctx.fillStyle = 'rgba(79,140,255,0.16)';
            ctx.fillRect(x0, y(p + rowTick), (val / mx) * width, Math.max(1, y(p) - y(p + rowTick) - 0.5));
          }
          line(ctx, x0, y(poc + rowTick / 2), slotX(iLast) + v.barW, y(poc + rowTick / 2), pal.poc, 1, [4, 3]);
        }
        sStart = sEnd;
      }
    }

    if (c.emaCloud) {
      const e8 = ema(closes, 8);
      const e21 = ema(closes, 21);
      for (let i = Math.max(first, 1); i <= last; i++) {
        if (!isFinite(e8[i]) || !isFinite(e21[i]) || !isFinite(e8[i - 1]) || !isFinite(e21[i - 1])) continue;
        ctx.beginPath();
        ctx.moveTo(cx(i - 1), y(e8[i - 1]));
        ctx.lineTo(cx(i), y(e8[i]));
        ctx.lineTo(cx(i), y(e21[i]));
        ctx.lineTo(cx(i - 1), y(e21[i - 1]));
        ctx.closePath();
        ctx.fillStyle = e8[i] >= e21[i] ? rgba(pal.buyRgb, 0.16) : rgba(pal.sellRgb, 0.16);
        ctx.fill();
      }
      path(e8, rgba(pal.buyRgb, 0.8), 1);
      path(e21, rgba(pal.sellRgb, 0.8), 1);
    }

    // candles + volume
    const bodyW = Math.max(1, v.barW * 0.7);
    for (let i = first; i <= last; i++) {
      const b = bars[i];
      const up = b.close >= b.open;
      const col = up ? pal.buy : pal.sell;
      const xx = cx(i);
      line(ctx, Math.round(xx) + 0.5, y(b.high), Math.round(xx) + 0.5, y(b.low), col);
      ctx.fillStyle = col;
      const yo = y(b.open);
      const yc = y(b.close);
      ctx.fillRect(Math.round(xx - bodyW / 2), Math.min(yo, yc), Math.max(1, Math.round(bodyW)), Math.max(1, Math.abs(yc - yo)));
      if (c.volume) {
        const vh = (b.volume / (maxVol || 1)) * (volH - 4);
        const by = priceH + volH;
        if (b.buyVolume !== undefined && b.volume > 0) {
          const bh = (b.buyVolume / b.volume) * vh;
          ctx.fillStyle = rgba(pal.buyRgb, 0.5);
          ctx.fillRect(Math.round(xx - bodyW / 2), by - bh, Math.max(1, bodyW), bh);
          ctx.fillStyle = rgba(pal.sellRgb, 0.5);
          ctx.fillRect(Math.round(xx - bodyW / 2), by - vh, Math.max(1, bodyW), vh - bh);
        } else {
          ctx.fillStyle = up ? rgba(pal.buyRgb, 0.45) : rgba(pal.sellRgb, 0.45);
          ctx.fillRect(Math.round(xx - bodyW / 2), by - vh, Math.max(1, bodyW), vh);
        }
      }
    }

    if (c.vwap) {
      const vw = vwap(bars);
      path(vw.mid, pal.vwap, 1.6);
      path(vw.upper, rgba([171, 71, 188], 0.45), 1);
      path(vw.lower, rgba([171, 71, 188], 0.45), 1);
    }
    if (c.ma) {
      path(ema(closes, 20), '#42a5f5');
      path(sma(closes, 50), '#ff7043');
      path(sma(closes, 200), '#bdbdbd');
    }

    // axis
    mask(ctx, pal, plotW, 0, AXIS_W, h);
    line(ctx, plotW + 0.5, 0, plotW + 0.5, h, pal.border);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const p of axisTicks(lo, hi, priceH / 44)) ctx.fillText(fmtPrice(p), plotW + 6, y(p));
    const lb = bars[n - 1];
    label(ctx, fmtPrice(lb.close), plotW + 1, y(lb.close), lb.close >= lb.open ? pal.buy : pal.sell, '#fff');
    line(ctx, 0, plotH + 0.5, w, plotH + 0.5, pal.border);
    ctx.textAlign = 'center';
    const every = Math.max(1, Math.ceil(80 / v.barW));
    for (let i = first; i <= last; i++) {
      if (i % every) continue;
      const dt = new Date(bars[i].time);
      const txt = ivMs >= DAY ? `${dt.getMonth() + 1}/${dt.getDate()}` : dt.getHours() === 0 && dt.getMinutes() === 0 ? `${dt.getMonth() + 1}/${dt.getDate()}` : `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      ctx.fillStyle = pal.muted;
      ctx.fillText(txt, cx(i), plotH + TIME_H / 2);
    }
    const pt = pointer.current;
    if (pt?.inside && pt.x < plotW && pt.y < plotH) {
      line(ctx, 0, pt.y, plotW, pt.y, pal.crosshair, 1, [3, 3]);
      line(ctx, pt.x, 0, pt.x, plotH, pal.crosshair, 1, [3, 3]);
      if (pt.y < priceH) label(ctx, fmtPrice(hi - ((pt.y - 6) / (priceH - 12)) * (hi - lo)), plotW + 1, pt.y, pal.accent, '#fff');
      const i = Math.floor(n - v.offset - (plotW - rightPad - pt.x) / v.barW);
      const b = bars[i];
      if (b) {
        const ch = ((b.close - b.open) / b.open) * 100;
        const rows = [new Date(b.time).toLocaleString(), `O ${fmtPrice(b.open)}  H ${fmtPrice(b.high)}`, `L ${fmtPrice(b.low)}  C ${fmtPrice(b.close)}`, `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%  Vol ${fmtVol(b.volume)} (${fmtUsd(b.volume * b.close)})`];
        if (b.buyVolume !== undefined) rows.push(`Δ ${fmtVol(2 * b.buyVolume - b.volume)}`);
        drawTooltip(ctx, rows, pt.x, pt.y, plotW, plotH, pal);
      }
    }
  };

  const drawTpo = ({ ctx, w, h, pal }: DrawContext, bars: Kline[]) => {
    const lp = bars[bars.length - 1].close;
    const tick = Number((baseTick(lp) * c.tpoTickMult).toPrecision(10));
    const sessions = buildTpo(bars, tick).slice(-c.tpoSessions);
    if (!sessions.length) return;
    const plotW = w - AXIS_W;
    const plotH = h - TIME_H;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of sessions) {
      lo = Math.min(lo, s.low);
      hi = Math.max(hi, s.high);
    }
    lo = bucket(lo, tick, 'floor') - tick;
    hi = bucket(hi, tick, 'floor') + 2 * tick;
    const rows = Math.round((hi - lo) / tick);
    const rowH = (plotH - 8) / rows;
    const y = (p: number) => 4 + ((hi - p) / (hi - lo)) * (plotH - 8);
    const gap = 14;
    const letterW = Math.max(2, Math.min(9, (plotW - gap * (sessions.length + 1)) / sessions.reduce((a, s) => a + Math.max(...[...s.rows.values()].map((r) => r.length)) + 4, 0)));
    let x = gap;
    const letters = rowH >= 8 && letterW >= 6;
    ctx.font = font(Math.min(11, rowH - 1), 600);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const s of sessions) {
      const sMax = Math.max(...[...s.rows.values()].map((r) => r.length));
      // value area bracket and IB
      line(ctx, x - 6, y(s.vah + tick), x - 6, y(s.val), pal.accent, 2);
      line(ctx, x - 10, y(s.ibHigh + tick), x - 10, y(s.ibLow), pal.warn, 2);
      for (const [p, per] of s.rows) {
        const yt = y(p + tick);
        if (p === s.poc) {
          ctx.fillStyle = rgba([255, 213, 79], pal.dark ? 0.18 : 0.3);
          ctx.fillRect(x - 2, yt, sMax * letterW + 4, rowH);
        }
        per.forEach((period, j) => {
          const t = period / Math.max(1, s.periods - 1);
          const hue = 200 - t * 200;
          const col = `hsl(${hue}, 70%, ${pal.dark ? 60 : 40}%)`;
          const inVa = p >= s.val && p <= s.vah;
          if (letters) {
            ctx.fillStyle = s.singles.has(p) ? pal.poc : col;
            ctx.globalAlpha = inVa ? 1 : 0.55;
            ctx.fillText(TPO_LETTERS[period % TPO_LETTERS.length], x + j * letterW + letterW / 2, yt + rowH / 2);
          } else {
            ctx.fillStyle = col;
            ctx.globalAlpha = inVa ? 0.9 : 0.45;
            ctx.fillRect(x + j * letterW, yt + 0.5, Math.max(1, letterW - 0.5), Math.max(1, rowH - 1));
          }
          ctx.globalAlpha = 1;
        });
      }
      // open / close markers
      ctx.fillStyle = pal.text;
      ctx.fillText('◂', x + sMax * letterW + 8, y(bucket(s.close, tick, 'floor') + tick / 2));
      ctx.fillText('▸', x - 16, y(bucket(s.open, tick, 'floor') + tick / 2));
      ctx.font = font(10, 600);
      ctx.fillStyle = pal.muted;
      ctx.textAlign = 'left';
      const dt = new Date(s.start);
      ctx.fillText(`${dt.getUTCMonth() + 1}/${dt.getUTCDate()}  POC ${fmtPrice(s.poc, tick)}`, x - 10, plotH + TIME_H / 2);
      ctx.textAlign = 'center';
      ctx.font = font(Math.min(11, rowH - 1), 600);
      x += sMax * letterW + 4 * letterW + gap;
    }
    mask(ctx, pal, plotW, 0, AXIS_W, h);
    line(ctx, plotW + 0.5, 0, plotW + 0.5, h, pal.border);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    for (const p of axisTicks(lo, hi, plotH / 40)) ctx.fillText(fmtPrice(p), plotW + 6, y(p));
    label(ctx, fmtPrice(lp), plotW + 1, y(lp), pal.accent, '#fff');
    line(ctx, 0, y(lp), plotW, y(lp), pal.accent, 1, [2, 3]);
    line(ctx, 0, plotH + 0.5, w, plotH + 0.5, pal.border);
  };

  return (
    <div className="panel">
      <Toolbar>
        <Chip active={c.mode === 'candles'} onClick={() => setConfig({ mode: 'candles' })}>
          Candles
        </Chip>
        <Chip active={c.mode === 'tpo'} onClick={() => setConfig({ mode: 'tpo' })}>
          TPO
        </Chip>
        {c.mode === 'candles' ? (
          <>
            <Select value={c.interval} options={['1m', '5m', '15m', '30m', '1h', '4h', '1d']} onChange={(interval) => setConfig({ interval })} />
            <Popover label="Indicators">
              <Check checked={c.volume} onChange={(volume) => setConfig({ volume })}>Volume (buy/sell split)</Check>
              <Check checked={c.vwap} onChange={(vwap) => setConfig({ vwap })}>Session VWAP ±1σ</Check>
              <Check checked={c.svp} onChange={(svp) => setConfig({ svp })}>Session volume profiles</Check>
              <Check checked={c.ma} onChange={(ma) => setConfig({ ma })}>EMA 20 / SMA 50 / SMA 200</Check>
              <Check checked={c.emaCloud} onChange={(emaCloud) => setConfig({ emaCloud })}>EMA cloud 8/21</Check>
            </Popover>
          </>
        ) : (
          <>
            <Select
              value={c.tpoTickMult}
              options={[10, 25, 50, 100, 250, 500].map((m) => ({ value: m, label: isFinite(feed.lastPrice()) ? `row ${fmtPrice(baseTick(feed.lastPrice()) * m)}` : `×${m}` }))}
              onChange={(tpoTickMult) => setConfig({ tpoTickMult })}
            />
            <NumberInput value={c.tpoSessions} onChange={(tpoSessions) => setConfig({ tpoSessions: Math.max(1, Math.min(20, Math.round(tpoSessions))) })} width={44} suffix="sessions" />
            <span className="muted">30m periods · UTC sessions · ▌VA ▌IB</span>
          </>
        )}
        <Spacer />
        {k.loading && <span className="muted">loading…</span>}
      </Toolbar>
      {k.error && !k.bars.length ? (
        <Empty>
          Could not load {feed.adapter.name} candles: {k.error}
        </Empty>
      ) : (
        <Canvas
          draw={draw}
          fps={c.mode === 'tpo' ? 4 : 15}
          pointerRef={pointer}
          onWheel={(e) => {
            view.current.barW = Math.max(2, Math.min(40, view.current.barW * (e.deltaY > 0 ? 0.9 : 1.1)));
          }}
          onDrag={(dx) => {
            view.current.offset = Math.max(-5, view.current.offset + dx / view.current.barW);
          }}
          onDoubleClick={() => {
            view.current.offset = 0;
          }}
        />
      )}
    </div>
  );
}

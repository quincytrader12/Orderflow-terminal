import { useMemo, useRef } from 'react';
import { candleDelta, candlePoc, FootprintBuilder, imbalances, stackedZones, valueArea, type BarType, type FootprintCandle } from '../core/footprint';
import { fmtPrice, fmtTime, fmtUsd, fmtVol } from '../core/format';
import { niceStep, qtyPercentile } from '../core/heatmap';
import { ema, periodLevels, sma } from '../core/indicators';
import { bucket } from '../core/orderbook';
import { INTERVALS, TIME_RANGES } from '../core/types';
import { hub } from '../market/hub';
import { Canvas, font, label, line, type DrawContext, type PointerState } from '../ui/canvas';
import { Check, Chip, NumberInput, Popover, Select, Spacer, Toolbar, useHubVersion, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';
import { HeatmapRaster } from './shared/heatmapRender';
import { useKlines } from './shared/useKlines';

export interface FootprintConfig {
  barType: BarType;
  interval: string;
  /** trades per bar (tick), base volume per bar (volume) or ticks per bar (range) */
  barSize: number;
  tickMult: number;
  style: 'bidask' | 'delta' | 'volume' | 'profile';
  usd: boolean;
  lookback: string;
  imbalance: boolean;
  imbalanceRatio: number;
  stacked: number;
  poc: boolean;
  stats: boolean;
  ovHeatmap: boolean;
  ovCvd: boolean;
  ovVp: boolean;
  ovBubbles: boolean;
  bubbleMin: number;
  ovLevels: boolean;
  ovMa: boolean;
  maFast: number;
  maSlow: number;
  ovVwap: boolean;
}

export const FOOTPRINT_DEFAULTS: FootprintConfig = {
  barType: 'time',
  interval: '1m',
  barSize: 500,
  tickMult: 5,
  style: 'bidask',
  usd: false,
  lookback: '4h',
  imbalance: true,
  imbalanceRatio: 3,
  stacked: 3,
  poc: true,
  stats: true,
  ovHeatmap: false,
  ovCvd: true,
  ovVp: true,
  ovBubbles: true,
  bubbleMin: 100_000,
  ovLevels: true,
  ovMa: false,
  maFast: 21,
  maSlow: 50,
  ovVwap: true,
};

/** Base tick for a price: ~0.2bp rounded to 1/2/5; multiplied by the tick multiplier. */
export function baseTick(price: number) {
  return niceStep(price * 0.00002);
}

const TICK_MULTS = [1, 2, 4, 5, 10, 20, 25, 50, 100, 250];

interface View {
  colW: number;
  rowH: number;
  /** candles scrolled back from the live edge */
  offset: number;
  center: number;
  autoCenter: boolean;
}

const AXIS_W = 74;
const TIME_H = 18;
const RIGHT_PAD = 50;

export function FootprintChart({ config: c, setConfig }: PanelProps<FootprintConfig>) {
  const view = useRef<View>({ colW: 84, rowH: 16, offset: 0, center: NaN, autoCenter: true });
  const builderRef = useRef<FootprintBuilder | null>(null);
  const raster = useMemo(() => new HeatmapRaster(), []);
  const heatCache = useRef({ at: 0, img: null as HTMLCanvasElement | null, norm: 1, normAt: 0, key: '' });
  const pointer = useRef<PointerState | null>(null);
  useHubVersion();
  const h0 = hub();
  const daily = useKlines(c.ovLevels ? h0.primary : undefined, '1d', 30, 30 * 60_000);

  const draw = ({ ctx, w, h, pal, now }: DrawContext) => {
    const H = hub();
    const feed = H.primary;
    const lastPrice = feed.lastPrice();
    if (!isFinite(lastPrice)) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText(`Waiting for ${feed.adapter.name} ${feed.inst.symbol} trades…`, w / 2, h / 2);
      return;
    }
    const tick = Number((baseTick(lastPrice) * c.tickMult).toPrecision(10));
    const size = c.barType === 'time' ? INTERVALS[c.interval] ?? 60_000 : c.barType === 'range' ? Math.max(1, Math.round(c.barSize)) : c.barSize;
    if (!builderRef.current) builderRef.current = new FootprintBuilder(feed.store, { barType: c.barType, size, tick, bubbleMinNotional: c.bubbleMin, lookbackMs: TIME_RANGES[c.lookback] ?? 4 * 3_600_000 });
    const b = builderRef.current;
    b.setStore(feed.store);
    b.setOptions({ barType: c.barType, size, tick, bubbleMinNotional: c.ovBubbles ? c.bubbleMin : 0, lookbackMs: TIME_RANGES[c.lookback] ?? 4 * 3_600_000 });
    b.update();
    const candles = b.candles;
    const n = candles.length;
    const v = view.current;

    const statsH = c.stats ? 30 : 0;
    const cvdH = c.ovCvd ? Math.max(50, Math.min(110, h * 0.17)) : 0;
    const plotW = w - AXIS_W;
    const plotH = h - TIME_H - statsH - cvdH;
    if (plotH < 40) return;

    if (!isFinite(v.center)) v.center = lastPrice;
    if (v.autoCenter) {
      const yLast = plotH / 2 - ((lastPrice - v.center) / tick) * v.rowH;
      if (yLast < plotH * 0.2 || yLast > plotH * 0.8) v.center = lastPrice;
    }
    const y = (p: number) => plotH / 2 - ((p - v.center) / tick) * v.rowH;
    const priceAt = (yy: number) => v.center + ((plotH / 2 - yy) / v.rowH) * tick;
    const slotX = (i: number) => plotW - RIGHT_PAD - (n - i - v.offset) * v.colW;
    const indexAtX = (x: number) => n - v.offset - (plotW - RIGHT_PAD - x) / v.colW;
    const first = Math.max(0, Math.floor(indexAtX(0)));
    const last = Math.min(n - 1, Math.ceil(indexAtX(plotW)));
    const pTop = priceAt(0);
    const pBot = priceAt(plotH);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();

    // ---- liquidity heatmap underlay ----
    if (c.ovHeatmap && H.heatmap.snapshots.length) {
      const hc = heatCache.current;
      if (now - hc.normAt > 2000) {
        hc.norm = qtyPercentile(H.heatmap.snapshots, 0.985);
        hc.normAt = now;
      }
      const key = `${v.colW}|${v.rowH}|${v.offset}|${v.center}|${w}|${h}|${n}`;
      if (!hc.img || now - hc.at > 250 || key !== hc.key) {
        const intervalMs = c.barType === 'time' ? size : 0;
        hc.img = raster.render(H.heatmap, {
          width: plotW,
          height: plotH,
          priceTop: pTop,
          pricePerPx: tick / v.rowH,
          norm: hc.norm,
          xToTime: (x) => {
            const fi = indexAtX(x);
            const ci = Math.floor(fi);
            if (ci < 0) return NaN;
            if (ci >= n) return ci === n ? now : NaN;
            const cd = candles[ci];
            const end = intervalMs ? cd.time + intervalMs : ci < n - 1 ? candles[ci + 1].time : now;
            return cd.time + (fi - ci) * (end - cd.time);
          },
        });
        hc.at = now;
        hc.key = key;
      }
      ctx.globalAlpha = 0.75;
      ctx.drawImage(hc.img, 0, 0, plotW, plotH);
      ctx.globalAlpha = 1;
    }

    // ---- grid ----
    const labelEvery = Math.max(1, Math.ceil(16 / v.rowH));
    const gridStart = bucket(pBot, tick * labelEvery, 'floor');
    for (let p = gridStart; p <= pTop; p += tick * labelEvery) line(ctx, 0, Math.round(y(p)) + 0.5, plotW, Math.round(y(p)) + 0.5, pal.grid);

    // ---- candles ----
    const textMode = v.rowH >= 10 && v.colW >= 44;
    const barW = textMode ? 5 : Math.max(1, Math.floor(v.colW * 0.62));
    const fsize = Math.max(8, Math.min(12, v.rowH - 4));
    const scale = (vol: number, p: number) => (c.usd ? vol * p : vol);
    for (let i = first; i <= last; i++) {
      const cd = candles[i];
      const x0 = slotX(i);
      drawCandle(cd, x0);
    }

    function drawCandle(cd: FootprintCandle, x0: number) {
      const up = cd.close >= cd.open;
      const col = up ? pal.buy : pal.sell;
      if (!textMode) {
        const cx = Math.round(x0 + v.colW / 2) + 0.5;
        line(ctx, cx, y(cd.high + tick), cx, y(cd.low), col);
        const yo = y(cd.open + tick / 2);
        const yc = y(cd.close + tick / 2);
        ctx.fillStyle = col;
        ctx.fillRect(Math.round(cx - barW / 2), Math.min(yo, yc), barW, Math.max(1, Math.abs(yc - yo)));
        if (c.poc) {
          const pp = candlePoc(cd);
          ctx.fillStyle = pal.poc;
          ctx.fillRect(Math.round(cx - barW / 2) - 1, y(pp + tick / 2) - 1, barW + 2, 2);
        }
        return;
      }
      // mini OHLC bar on the left edge of the slot
      const bx = x0 + 2;
      line(ctx, bx + barW / 2, y(cd.high + tick), bx + barW / 2, y(cd.low), col);
      const yo = y(cd.open + tick / 2);
      const yc = y(cd.close + tick / 2);
      ctx.fillStyle = col;
      ctx.fillRect(bx, Math.min(yo, yc) - 1, barW, Math.max(2, Math.abs(yc - yo) + 2));

      const cellX = x0 + barW + 4;
      const cellW = v.colW - barW - 7;
      let maxLvl = 0;
      let maxSide = 0;
      let maxAbsDelta = 0;
      for (const l of cd.levels.values()) {
        maxLvl = Math.max(maxLvl, l.buy + l.sell);
        maxSide = Math.max(maxSide, l.buy, l.sell);
        maxAbsDelta = Math.max(maxAbsDelta, Math.abs(l.buy - l.sell));
      }
      const imb = c.imbalance ? imbalances(cd, tick, c.imbalanceRatio) : null;
      const pocP = c.poc ? candlePoc(cd) : NaN;
      ctx.font = font(fsize);
      ctx.textBaseline = 'middle';
      for (const [p, l] of cd.levels) {
        const yt = y(p + tick);
        if (yt > plotH || yt + v.rowH < 0) continue;
        const rh = Math.max(1, v.rowH - 1);
        const ym = yt + v.rowH / 2;
        switch (c.style) {
          case 'bidask': {
            const half = cellW / 2;
            ctx.fillStyle = rgba(pal.sellRgb, 0.08 + 0.55 * (l.sell / (maxSide || 1)));
            ctx.fillRect(cellX, yt, half - 0.5, rh);
            ctx.fillStyle = rgba(pal.buyRgb, 0.08 + 0.55 * (l.buy / (maxSide || 1)));
            ctx.fillRect(cellX + half + 0.5, yt, half - 0.5, rh);
            const sImb = imb?.sellImb.has(p);
            const bImb = imb?.buyImb.has(p);
            ctx.textAlign = 'right';
            ctx.font = font(fsize, sImb ? 700 : 400);
            ctx.fillStyle = sImb ? '#ff8a80' : pal.text;
            ctx.fillText(fmtVol(scale(l.sell, p)), cellX + half - 3, ym);
            ctx.textAlign = 'left';
            ctx.font = font(fsize, bImb ? 700 : 400);
            ctx.fillStyle = bImb ? '#69f0ae' : pal.text;
            ctx.fillText(fmtVol(scale(l.buy, p)), cellX + half + 3, ym);
            break;
          }
          case 'delta': {
            const d = l.buy - l.sell;
            ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, 0.1 + 0.6 * (Math.abs(d) / (maxAbsDelta || 1)));
            ctx.fillRect(cellX, yt, cellW, rh);
            ctx.textAlign = 'center';
            ctx.fillStyle = pal.text;
            ctx.font = font(fsize, imb && (imb.buyImb.has(p) || imb.sellImb.has(p)) ? 700 : 400);
            ctx.fillText((d > 0 ? '+' : '') + fmtVol(scale(d, p)), cellX + cellW / 2, ym);
            break;
          }
          case 'volume': {
            const t = (l.buy + l.sell) / (maxLvl || 1);
            ctx.fillStyle = `rgba(79,140,255,${(0.08 + 0.6 * t).toFixed(3)})`;
            ctx.fillRect(cellX, yt, cellW, rh);
            ctx.textAlign = 'center';
            ctx.fillStyle = pal.text;
            ctx.fillText(fmtVol(scale(l.buy + l.sell, p)), cellX + cellW / 2, ym);
            break;
          }
          case 'profile': {
            const tot = l.buy + l.sell;
            const wTot = (tot / (maxLvl || 1)) * cellW;
            const wSell = tot ? (l.sell / tot) * wTot : 0;
            ctx.fillStyle = rgba(pal.sellRgb, 0.75);
            ctx.fillRect(cellX, yt, wSell, rh);
            ctx.fillStyle = rgba(pal.buyRgb, 0.75);
            ctx.fillRect(cellX + wSell, yt, wTot - wSell, rh);
            if (v.colW >= 70) {
              ctx.textAlign = 'right';
              ctx.fillStyle = pal.text;
              ctx.fillText(fmtVol(scale(tot, p)), cellX + cellW - 2, ym);
            }
            break;
          }
        }
        if (p === pocP) {
          ctx.strokeStyle = pal.poc;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cellX + 0.5, yt + 0.5, cellW - 1, rh - 1);
        }
      }
      if (imb && c.stacked > 1) {
        for (const [lo, hi] of stackedZones(imb.buyImb, tick, c.stacked)) {
          ctx.fillStyle = pal.buy;
          ctx.fillRect(x0 + v.colW - 3, y(hi + tick), 2, y(lo) - y(hi + tick));
        }
        for (const [lo, hi] of stackedZones(imb.sellImb, tick, c.stacked)) {
          ctx.fillStyle = pal.sell;
          ctx.fillRect(x0 + v.colW - 3, y(hi + tick), 2, y(lo) - y(hi + tick));
        }
      }
    }

    // ---- moving averages / VWAP through candle closes ----
    const cx = (i: number) => slotX(i) + v.colW / 2;
    const drawLine = (vals: number[], color: string, width = 1.5) => {
      ctx.beginPath();
      let started = false;
      for (let i = Math.max(0, first - 1); i <= Math.min(n - 1, last + 1); i++) {
        if (!isFinite(vals[i])) continue;
        if (!started) ctx.moveTo(cx(i), y(vals[i]));
        else ctx.lineTo(cx(i), y(vals[i]));
        started = true;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    if (c.ovMa && n) {
      const closes = candles.map((k) => k.close);
      drawLine(ema(closes, c.maFast), '#42a5f5');
      drawLine(sma(closes, c.maSlow), '#ff7043');
    }
    if (c.ovVwap && n) {
      let pv = 0;
      let vol = 0;
      let day = -1;
      const vw = candles.map((k) => {
        const d = Math.floor(k.time / 86_400_000);
        if (d !== day) {
          day = d;
          pv = 0;
          vol = 0;
        }
        for (const [p, l] of k.levels) {
          pv += (p + tick / 2) * (l.buy + l.sell);
          vol += l.buy + l.sell;
        }
        return vol ? pv / vol : NaN;
      });
      drawLine(vw, pal.vwap, 1.5);
    }

    // ---- volume bubbles ----
    if (c.ovBubbles && b.bubbles.length && n) {
      const t0 = candles[first]?.time ?? 0;
      let maxQ = 0;
      for (const bb of b.bubbles) if (bb.time >= t0) maxQ = Math.max(maxQ, bb.qty * bb.price);
      for (const bb of b.bubbles) {
        if (bb.time < t0) continue;
        const ci = findCandle(candles, bb.time);
        if (ci < first || ci > last) continue;
        const cd = candles[ci];
        const end = c.barType === 'time' ? cd.time + size : ci < n - 1 ? candles[ci + 1].time : now;
        const fx = slotX(ci) + (textMode ? barW + 4 : 0) + Math.min(1, (bb.time - cd.time) / Math.max(1, end - cd.time)) * (v.colW - (textMode ? barW + 4 : 0));
        const r = 3 + 13 * Math.sqrt((bb.qty * bb.price) / (maxQ || 1));
        ctx.beginPath();
        ctx.arc(fx, y(bb.price), r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(bb.buy ? pal.buyRgb : pal.sellRgb, 0.35);
        ctx.fill();
        ctx.strokeStyle = bb.buy ? pal.buy : pal.sell;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ---- period levels ----
    if (c.ovLevels && daily.bars.length) {
      ctx.font = font(10, 600);
      for (const lv of periodLevels(daily.bars, now)) {
        if (lv.price < pBot || lv.price > pTop) continue;
        const yy = Math.round(y(lv.price)) + 0.5;
        line(ctx, 0, yy, plotW, yy, pal.warn, 1, [6, 4]);
        ctx.fillStyle = pal.warn;
        ctx.textAlign = 'left';
        ctx.fillText(lv.label, 4, yy - 7);
      }
    }

    // ---- visible-range volume profile ----
    if (c.ovVp && n) {
      const agg = new Map<number, { buy: number; sell: number }>();
      for (let i = first; i <= last; i++)
        for (const [p, l] of candles[i].levels) {
          const a = agg.get(p) ?? { buy: 0, sell: 0 };
          a.buy += l.buy;
          a.sell += l.sell;
          agg.set(p, a);
        }
      let maxV = 0;
      for (const a of agg.values()) maxV = Math.max(maxV, a.buy + a.sell);
      const vpW = Math.min(140, plotW * 0.18);
      const va = valueArea(new Map([...agg].map(([p, a]) => [p, a.buy + a.sell])), 0.7);
      for (const [p, a] of agg) {
        const yt = y(p + tick);
        if (yt > plotH || yt + v.rowH < 0) continue;
        const inVa = va && p >= va.val && p <= va.vah;
        const wT = ((a.buy + a.sell) / (maxV || 1)) * vpW;
        const wB = (a.buy / (a.buy + a.sell || 1)) * wT;
        ctx.fillStyle = rgba(pal.buyRgb, inVa ? 0.4 : 0.2);
        ctx.fillRect(plotW - wT, yt, wB, Math.max(1, v.rowH - 1));
        ctx.fillStyle = rgba(pal.sellRgb, inVa ? 0.4 : 0.2);
        ctx.fillRect(plotW - wT + wB, yt, wT - wB, Math.max(1, v.rowH - 1));
      }
      if (va) {
        line(ctx, plotW - vpW, y(va.poc + tick / 2), plotW, y(va.poc + tick / 2), pal.poc, 1.5);
        line(ctx, plotW - vpW, y(va.vah + tick), plotW, y(va.vah + tick), pal.muted, 1, [2, 3]);
        line(ctx, plotW - vpW, y(va.val), plotW, y(va.val), pal.muted, 1, [2, 3]);
      }
    }

    // ---- last price line ----
    const yl = Math.round(y(lastPrice + tick / 2)) + 0.5;
    const lastUp = n ? candles[n - 1].close >= candles[n - 1].open : true;
    line(ctx, 0, yl, plotW, yl, lastUp ? pal.buy : pal.sell, 1, [2, 2]);
    ctx.restore();

    // ---- price axis ----
    ctx.fillStyle = pal.panel;
    ctx.fillRect(plotW, 0, AXIS_W, plotH);
    line(ctx, plotW + 0.5, 0, plotW + 0.5, h, pal.border);
    ctx.font = font(10);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.muted;
    for (let p = gridStart; p <= pTop; p += tick * labelEvery) ctx.fillText(fmtPrice(p, tick), plotW + 6, y(p + tick / 2));
    label(ctx, fmtPrice(lastPrice), plotW + 1, yl, lastUp ? pal.buy : pal.sell, '#fff');

    // ---- stats strip ----
    let yCursor = plotH;
    if (c.stats) {
      line(ctx, 0, yCursor + 0.5, plotW, yCursor + 0.5, pal.border);
      ctx.font = font(9);
      let maxVol = 0;
      for (let i = first; i <= last; i++) maxVol = Math.max(maxVol, candles[i].volume);
      for (let i = first; i <= last; i++) {
        const cd = candles[i];
        const x0 = slotX(i);
        const d = candleDelta(cd);
        ctx.fillStyle = `rgba(79,140,255,${(0.08 + 0.45 * (cd.volume / (maxVol || 1))).toFixed(3)})`;
        ctx.fillRect(x0 + 1, yCursor + 1, v.colW - 2, 14);
        ctx.fillStyle = rgba(d >= 0 ? pal.buyRgb : pal.sellRgb, 0.12 + 0.5 * Math.min(1, Math.abs(d) / (cd.volume || 1) * 2));
        ctx.fillRect(x0 + 1, yCursor + 15, v.colW - 2, 14);
        if (v.colW >= 34) {
          ctx.textAlign = 'center';
          ctx.fillStyle = pal.text;
          ctx.fillText(fmtVol(c.usd ? cd.volume * cd.close : cd.volume), x0 + v.colW / 2, yCursor + 8);
          ctx.fillText((d > 0 ? '+' : '') + fmtVol(c.usd ? d * cd.close : d), x0 + v.colW / 2, yCursor + 22);
        }
      }
      ctx.fillStyle = pal.panel;
      ctx.fillRect(plotW, yCursor, AXIS_W, statsH);
      ctx.fillStyle = pal.muted;
      ctx.textAlign = 'left';
      ctx.fillText('Vol', plotW + 6, yCursor + 8);
      ctx.fillText('Δ', plotW + 6, yCursor + 22);
      yCursor += statsH;
    }

    // ---- CVD subplot ----
    if (c.ovCvd && n) {
      line(ctx, 0, yCursor + 0.5, w, yCursor + 0.5, pal.border);
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = first; i <= last; i++) {
        const prev = i > 0 ? candles[i - 1].cvd : candles[i].cvd - candleDelta(candles[i]);
        mn = Math.min(mn, candles[i].cvd, prev);
        mx = Math.max(mx, candles[i].cvd, prev);
      }
      if (isFinite(mn)) {
        if (mx === mn) mx = mn + 1;
        const pad = 6;
        const yc = (val: number) => yCursor + pad + (1 - (val - mn) / (mx - mn)) * (cvdH - pad * 2);
        for (let i = first; i <= last; i++) {
          const cd = candles[i];
          const open = cd.cvd - candleDelta(cd);
          const x0 = slotX(i);
          ctx.fillStyle = cd.cvd >= open ? pal.buy : pal.sell;
          const y1 = yc(open);
          const y2 = yc(cd.cvd);
          ctx.fillRect(x0 + v.colW * 0.2, Math.min(y1, y2), v.colW * 0.6, Math.max(1, Math.abs(y2 - y1)));
        }
        ctx.font = font(9);
        ctx.fillStyle = pal.muted;
        ctx.textAlign = 'left';
        ctx.fillText('CVD', plotW + 6, yCursor + 9);
        ctx.fillText(fmtVol(candles[n - 1].cvd), plotW + 6, yCursor + 22);
      }
      yCursor += cvdH;
    }

    // ---- time axis ----
    line(ctx, 0, yCursor + 0.5, w, yCursor + 0.5, pal.border);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'center';
    const every = Math.max(1, Math.ceil(70 / v.colW));
    for (let i = first; i <= last; i++) {
      if (i % every) continue;
      ctx.fillText(fmtTime(candles[i].time, c.barType !== 'time' || size < 60_000), slotX(i) + v.colW / 2, yCursor + TIME_H / 2);
    }

    // ---- crosshair + tooltip ----
    const pt = pointer.current;
    if (pt?.inside && pt.x < plotW && pt.y < plotH) {
      line(ctx, 0, Math.round(pt.y) + 0.5, plotW, Math.round(pt.y) + 0.5, pal.crosshair, 1, [3, 3]);
      line(ctx, Math.round(pt.x) + 0.5, 0, Math.round(pt.x) + 0.5, yCursor, pal.crosshair, 1, [3, 3]);
      label(ctx, fmtPrice(bucket(priceAt(pt.y), tick, 'floor'), tick), plotW + 1, pt.y, pal.accent, '#fff');
      const ci = Math.floor(indexAtX(pt.x));
      if (ci >= 0 && ci < n) {
        const cd = candles[ci];
        const d = candleDelta(cd);
        const lvl = cd.levels.get(bucket(priceAt(pt.y), tick, 'floor'));
        const rows = [
          `${fmtTime(cd.time)}${c.barType !== 'time' ? ' → ' + fmtTime(cd.endTime) : ''}`,
          `O ${fmtPrice(cd.open, tick)}  H ${fmtPrice(cd.high, tick)}`,
          `L ${fmtPrice(cd.low, tick)}  C ${fmtPrice(cd.close, tick)}`,
          `Vol ${fmtVol(cd.volume)} (${fmtUsd(cd.volume * cd.close)})`,
          `Buy ${fmtVol(cd.buyVol)}  Sell ${fmtVol(cd.sellVol)}`,
          `Δ ${d > 0 ? '+' : ''}${fmtVol(d)}  (${((d / (cd.volume || 1)) * 100).toFixed(1)}%)`,
          `Δ max ${fmtVol(cd.maxDelta)} min ${fmtVol(cd.minDelta)}`,
          `Trades ${cd.trades.toLocaleString()}  POC ${fmtPrice(candlePoc(cd), tick)}`,
        ];
        if (lvl) rows.push(`@level  S ${fmtVol(lvl.sell)} × B ${fmtVol(lvl.buy)}`);
        drawTooltip(ctx, rows, pt.x, pt.y, plotW, plotH, pal);
      }
    }
  };

  const onWheel = (e: WheelEvent, p: PointerState) => {
    const v = view.current;
    const k = e.deltaY > 0 ? 0.9 : 1.1;
    const overAxis = p.x > p.w - AXIS_W;
    if (e.shiftKey || e.altKey || overAxis) v.rowH = Math.max(3, Math.min(48, v.rowH * k));
    else v.colW = Math.max(3, Math.min(320, v.colW * k));
  };

  const onDrag = (dx: number, dy: number) => {
    const v = view.current;
    v.offset = Math.max(-2, v.offset + dx / v.colW);
    if (Math.abs(dy) > 0) {
      v.autoCenter = false;
      const H = hub();
      const lp = H.primary.lastPrice();
      const tick = baseTick(isFinite(lp) ? lp : 1) * c.tickMult;
      v.center += (dy / v.rowH) * tick;
    }
  };

  const reset = () => {
    view.current = { ...view.current, offset: 0, center: NaN, autoCenter: true };
  };

  return (
    <div className="panel">
      <Toolbar>
        <Select
          value={c.barType}
          options={[
            { value: 'time', label: 'Time' },
            { value: 'tick', label: 'Tick' },
            { value: 'volume', label: 'Volume' },
            { value: 'range', label: 'Range' },
          ]}
          onChange={(barType) => setConfig({ barType, barSize: barType === 'tick' ? 500 : barType === 'volume' ? 100 : barType === 'range' ? 10 : c.barSize })}
          title="Bar type"
        />
        {c.barType === 'time' ? (
          <Select value={c.interval} options={['5s', '15s', '30s', '1m', '3m', '5m', '15m', '30m', '1h', '4h']} onChange={(interval) => setConfig({ interval })} title="Bar interval" />
        ) : (
          <NumberInput value={c.barSize} onChange={(barSize) => setConfig({ barSize: Math.max(c.barType === 'volume' ? 0.0001 : 1, barSize) })} title={c.barType === 'tick' ? 'Trades per bar' : c.barType === 'volume' ? 'Base volume per bar' : 'Ticks per bar'} width={64} />
        )}
        <Select
          value={c.tickMult}
          options={TICK_MULTS.map((m) => {
            const lp = hub().primary.lastPrice();
            return { value: m, label: isFinite(lp) ? `tick ${fmtPrice(Number((baseTick(lp) * m).toPrecision(10)), baseTick(lp) * m)}` : `×${m}` };
          })}
          onChange={(tickMult) => setConfig({ tickMult })}
          title="Price grouping (tick size)"
        />
        <Select
          value={c.style}
          options={[
            { value: 'bidask', label: 'Bid × Ask' },
            { value: 'delta', label: 'Delta' },
            { value: 'volume', label: 'Volume' },
            { value: 'profile', label: 'Profile' },
          ]}
          onChange={(style) => setConfig({ style })}
          title="Cluster style"
        />
        <Select value={c.lookback} options={['1h', '4h', '12h', '24h']} onChange={(lookback) => setConfig({ lookback })} title="Lookback" />
        <Chip active={c.usd} onClick={() => setConfig({ usd: !c.usd })} title="Show volumes in USD notional">
          $
        </Chip>
        <Popover label="Indicators" title="Overlays and indicators">
          <div className="pop-title">Overlays</div>
          <Check checked={c.ovHeatmap} onChange={(ovHeatmap) => setConfig({ ovHeatmap })}>Orderbook heatmap</Check>
          <Check checked={c.ovCvd} onChange={(ovCvd) => setConfig({ ovCvd })}>CVD subplot</Check>
          <Check checked={c.ovVp} onChange={(ovVp) => setConfig({ ovVp })}>Volume profile (visible range)</Check>
          <Check checked={c.ovBubbles} onChange={(ovBubbles) => setConfig({ ovBubbles })}>Volume bubbles</Check>
          {c.ovBubbles && (
            <div className="row">
              Min bubble <NumberInput value={c.bubbleMin} onChange={(bubbleMin) => setConfig({ bubbleMin })} width={90} suffix="$" />
            </div>
          )}
          <Check checked={c.ovLevels} onChange={(ovLevels) => setConfig({ ovLevels })}>Period levels (PDH/PDL/PDC/DO/PWH/PWL/WO)</Check>
          <Check checked={c.ovVwap} onChange={(ovVwap) => setConfig({ ovVwap })}>Session VWAP</Check>
          <Check checked={c.ovMa} onChange={(ovMa) => setConfig({ ovMa })}>Moving averages</Check>
          {c.ovMa && (
            <div className="row">
              EMA <NumberInput value={c.maFast} onChange={(maFast) => setConfig({ maFast: Math.max(2, Math.round(maFast)) })} width={48} /> SMA{' '}
              <NumberInput value={c.maSlow} onChange={(maSlow) => setConfig({ maSlow: Math.max(2, Math.round(maSlow)) })} width={48} />
            </div>
          )}
          <div className="pop-title">Clusters</div>
          <Check checked={c.poc} onChange={(poc) => setConfig({ poc })}>Bar POC</Check>
          <Check checked={c.stats} onChange={(stats) => setConfig({ stats })}>Volume / delta strip</Check>
          <Check checked={c.imbalance} onChange={(imbalance) => setConfig({ imbalance })}>Diagonal imbalances</Check>
          {c.imbalance && (
            <div className="row">
              Ratio <NumberInput value={c.imbalanceRatio} step={0.5} onChange={(imbalanceRatio) => setConfig({ imbalanceRatio: Math.max(1.1, imbalanceRatio) })} width={48} suffix="×" /> Stacked{' '}
              <NumberInput value={c.stacked} onChange={(stacked) => setConfig({ stacked: Math.max(2, Math.round(stacked)) })} width={44} />
            </div>
          )}
        </Popover>
        <Spacer />
        <Chip onClick={reset} title="Reset view (or double-click the chart)">⟲</Chip>
      </Toolbar>
      <Canvas draw={draw} fps={30} onWheel={onWheel} onDrag={onDrag} onDoubleClick={reset} pointerRef={pointer} />
      <div className="hint">wheel: zoom bars · shift+wheel: zoom prices · drag: pan · dbl-click: reset</div>
    </div>
  );
}

function findCandle(candles: FootprintCandle[], t: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  if (hi < 0 || t < candles[0].time) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (candles[mid].time <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function drawTooltip(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, maxX: number, maxY: number, pal: DrawContext['pal']) {
  ctx.font = font(11);
  const w = Math.max(...rows.map((r) => ctx.measureText(r).width)) + 16;
  const h = rows.length * 15 + 10;
  let bx = x + 14;
  let by = y + 14;
  if (bx + w > maxX) bx = x - w - 14;
  if (by + h > maxY) by = Math.max(0, y - h - 14);
  ctx.fillStyle = pal.dark ? 'rgba(10,13,18,0.94)' : 'rgba(255,255,255,0.96)';
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.fillRect(bx, by, w, h);
  ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  ctx.fillStyle = pal.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  rows.forEach((r, i) => ctx.fillText(r, bx + 8, by + 12 + i * 15));
}

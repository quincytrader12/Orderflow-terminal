import { useMemo, useRef } from 'react';
import { fmtPrice, fmtUsd } from '../core/format';
import { qtyPercentile } from '../core/heatmap';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { axisTicks, Canvas, drawTimeAxis, font, label, line, type DrawContext, type PointerState, mask } from '../ui/canvas';
import { Chip, NumberInput, Select, Spacer, Toolbar, VenueMask, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';
import { drawTooltip } from './FootprintChart';
import { HeatmapRaster } from './shared/heatmapRender';

export interface HeatmapConfig {
  composite: boolean;
  hiddenVenues: VenueId[];
  span: string;
  showTrades: boolean;
  tradeMin: number;
  showBook: boolean;
  contrast: number;
}

export const HEATMAP_DEFAULTS: HeatmapConfig = { composite: false, hiddenVenues: [], span: '10m', showTrades: true, tradeMin: 10_000, showBook: true, contrast: 0.6 };

const SPANS: Record<string, number> = { '2m': 120e3, '5m': 300e3, '10m': 600e3, '30m': 1800e3, '1h': 3600e3 };
const AXIS_W = 74;
const TIME_H = 18;
const BOOK_W = 90;

export function LiquidityHeatmap({ config: c, setConfig }: PanelProps<HeatmapConfig>) {
  const raster = useMemo(() => new HeatmapRaster(), []);
  const view = useRef({ pctRange: 0.006, center: NaN, auto: true, offsetMs: 0 });
  const norm = useRef({ v: 1, at: 0, rec: null as unknown });
  const pointer = useRef<PointerState | null>(null);

  const draw = ({ ctx, w, h, pal, now }: DrawContext) => {
    const H = hub();
    const rec = c.composite ? H.compositeHeatmap : H.heatmap;
    const feeds = c.composite ? H.visible(c.hiddenVenues) : [H.primary];
    const mid = H.primary.book.mid();
    const lp = H.primary.lastPrice();
    const ref = isFinite(mid) ? mid : lp;
    if (!isFinite(ref) || !rec.snapshots.length) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('Recording order book snapshots…', w / 2, h / 2);
      return;
    }
    const v = view.current;
    const bookW = c.showBook ? BOOK_W : 0;
    const plotW = w - AXIS_W - bookW;
    const plotH = h - TIME_H;
    const span = SPANS[c.span] ?? 600e3;
    const tTo = now - v.offsetMs;
    const tFrom = tTo - span;
    if (!isFinite(v.center)) v.center = ref;
    const pRange = ref * v.pctRange;
    if (v.auto && Math.abs(ref - v.center) > pRange * 0.3) v.center = ref;
    const pTop = v.center + pRange;
    const pBot = v.center - pRange;
    const ppp = (pTop - pBot) / plotH;
    const y = (p: number) => (pTop - p) / ppp;
    const x = (t: number) => ((t - tFrom) / span) * plotW;

    if (now - norm.current.at > 2000 || norm.current.rec !== rec) {
      norm.current = { v: qtyPercentile(rec.snapshots.slice(-600), 0.985), at: now, rec };
    }
    const img = raster.render(rec, {
      width: plotW,
      height: plotH,
      xToTime: (px) => tFrom + (px / plotW) * span,
      priceTop: pTop,
      pricePerPx: ppp,
      norm: norm.current.v / (c.contrast * 1.6),
      ramp: pal.ramp,
      gamma: 0.55,
      baseAlpha: 255,
    });
    ctx.drawImage(img, 0, 0, plotW, plotH);

    // best bid / ask lines
    const snaps = rec.snapshots;
    const i0 = Math.max(0, rec.indexAt(tFrom));
    for (const [key, color] of [
      ['bestBid', pal.buy],
      ['bestAsk', pal.sell],
    ] as const) {
      ctx.beginPath();
      for (let i = i0; i < snaps.length; i++) {
        const s = snaps[i];
        const xx = x(s.time);
        if (i === i0) ctx.moveTo(xx, y(s[key]));
        else ctx.lineTo(xx, y(s[key]));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // trade bubbles
    if (c.showTrades) {
      let maxN = 0;
      const bubbles: { t: number; p: number; n: number; buy: boolean }[] = [];
      for (const f of feeds) {
        const s = f.store;
        s.forEach(s.indexAtTime(tFrom), s.end, (p, q, buy, t) => {
          const n = p * q;
          if (n < c.tradeMin || t > tTo) return;
          bubbles.push({ t, p, n, buy });
          if (n > maxN) maxN = n;
        });
      }
      for (const b of bubbles) {
        const r = 2 + 12 * Math.sqrt(b.n / (maxN || 1));
        ctx.beginPath();
        ctx.arc(x(b.t), y(b.p), r, 0, Math.PI * 2);
        ctx.fillStyle = rgba(b.buy ? pal.buyRgb : pal.sellRgb, 0.55);
        ctx.fill();
        ctx.strokeStyle = b.buy ? '#7dffe9' : '#ffb3b0';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }

    // live book profile
    if (c.showBook) {
      const bx = plotW;
      mask(ctx, pal, bx, 0, bookW, plotH);
      const rows = new Map<number, { b: number; a: number }>();
      const rowPx = 3;
      for (const f of feeds) {
        for (const [p, q] of f.book.bids) if (p >= pBot && p <= pTop) {
          const r = Math.floor(y(p) / rowPx);
          const e = rows.get(r) ?? { b: 0, a: 0 };
          e.b += q;
          rows.set(r, e);
        }
        for (const [p, q] of f.book.asks) if (p >= pBot && p <= pTop) {
          const r = Math.floor(y(p) / rowPx);
          const e = rows.get(r) ?? { b: 0, a: 0 };
          e.a += q;
          rows.set(r, e);
        }
      }
      let mx = 0;
      for (const e of rows.values()) mx = Math.max(mx, e.a + e.b);
      for (const [r, e] of rows) {
        const len = ((e.a + e.b) / (mx || 1)) * (bookW - 4);
        ctx.fillStyle = e.b >= e.a ? rgba(pal.buyRgb, 0.75) : rgba(pal.sellRgb, 0.75);
        ctx.fillRect(bx + 2, r * rowPx, len, rowPx - 0.5);
      }
      line(ctx, bx + 0.5, 0, bx + 0.5, plotH, pal.border);
    }

    // price axis
    const ax = plotW + bookW;
    mask(ctx, pal, ax, 0, AXIS_W, h);
    line(ctx, ax + 0.5, 0, ax + 0.5, h, pal.border);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const p of axisTicks(pBot, pTop, plotH / 36)) ctx.fillText(fmtPrice(p), ax + 6, y(p));
    if (isFinite(lp)) label(ctx, fmtPrice(lp), ax + 1, y(lp), pal.accent, '#fff');
    line(ctx, 0, plotH + 0.5, w, plotH + 0.5, pal.border);
    drawTimeAxis(ctx, tFrom, tTo, 0, plotW, plotH + TIME_H / 2, pal);

    const pt = pointer.current;
    if (pt?.inside && pt.x < plotW && pt.y < plotH) {
      line(ctx, 0, pt.y, plotW, pt.y, pal.crosshair, 1, [3, 3]);
      line(ctx, pt.x, 0, pt.x, plotH, pal.crosshair, 1, [3, 3]);
      const price = pTop - pt.y * ppp;
      const t = tFrom + (pt.x / plotW) * span;
      const s = snaps[rec.indexAt(t)];
      let q = 0;
      if (s) {
        for (const arr of [s.bids, s.asks])
          for (let i = 0; i < arr.length; i += 2) if (price >= arr[i] && price < arr[i] + s.res) q += arr[i + 1];
      }
      drawTooltip(ctx, [`${new Date(t).toLocaleTimeString()}`, `Price ${fmtPrice(price)}`, `Resting ${q.toFixed(3)} (${fmtUsd(q * price)})`], pt.x, pt.y, plotW, plotH, pal);
    }
  };

  return (
    <div className="panel">
      <Toolbar>
        <Chip active={!c.composite} onClick={() => setConfig({ composite: false })} title="Primary instrument book">
          Primary
        </Chip>
        <Chip active={c.composite} onClick={() => setConfig({ composite: true })} title="Composite of all visible venues">
          Composite
        </Chip>
        {c.composite && <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />}
        <Select value={c.span} options={Object.keys(SPANS)} onChange={(span) => setConfig({ span })} title="Time span" />
        <Chip active={c.showTrades} onClick={() => setConfig({ showTrades: !c.showTrades })}>
          Trades
        </Chip>
        {c.showTrades && <NumberInput value={c.tradeMin} onChange={(tradeMin) => setConfig({ tradeMin })} width={80} suffix="$" title="Minimum trade notional" />}
        <Chip active={c.showBook} onClick={() => setConfig({ showBook: !c.showBook })}>
          Book
        </Chip>
        <Select
          value={c.contrast}
          options={[
            { value: 0.3, label: 'Contrast low' },
            { value: 0.6, label: 'Contrast mid' },
            { value: 1, label: 'Contrast high' },
            { value: 2, label: 'Contrast max' },
          ]}
          onChange={(contrast) => setConfig({ contrast })}
        />
        <Spacer />
        <Chip
          onClick={() => {
            view.current = { ...view.current, center: NaN, auto: true, offsetMs: 0, pctRange: 0.006 };
          }}
        >
          ⟲
        </Chip>
      </Toolbar>
      <Canvas
        draw={draw}
        fps={24}
        pointerRef={pointer}
        onWheel={(e) => {
          const k = e.deltaY > 0 ? 1.12 : 0.89;
          view.current.pctRange = Math.max(0.0005, Math.min(0.04, view.current.pctRange * k));
        }}
        onDrag={(dx, dy, _e, p) => {
          const v = view.current;
          const lp = hub().primary.lastPrice();
          if (!isFinite(lp)) return;
          v.auto = false;
          v.center += (dy / Math.max(1, p.h - TIME_H)) * 2 * lp * v.pctRange;
          v.offsetMs = Math.max(0, v.offsetMs + (dx / Math.max(1, p.w - AXIS_W)) * (SPANS[c.span] ?? 600e3));
        }}
        onDoubleClick={() => {
          view.current = { ...view.current, center: NaN, auto: true, offsetMs: 0 };
        }}
      />
      <div className="hint">wheel: zoom price · drag: pan time/price · dbl-click: live</div>
    </div>
  );
}

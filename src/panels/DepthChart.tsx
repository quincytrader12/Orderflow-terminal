import { useRef } from 'react';
import { fmtPrice, fmtUsd } from '../core/format';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { axisTicks, Canvas, font, label, line, type DrawContext, type PointerState } from '../ui/canvas';
import { Chip, Select, Spacer, Toolbar, VenueMask, type PanelProps } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';

export interface DepthConfig {
  hiddenVenues: VenueId[];
  rangePct: number;
  perVenue: boolean;
}

export const DEPTH_DEFAULTS: DepthConfig = { hiddenVenues: [], rangePct: 1, perVenue: false };

export function DepthChart({ config: c, setConfig }: PanelProps<DepthConfig>) {
  const pointer = useRef<PointerState | null>(null);
  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const H = hub();
    const feeds = H.visible(c.hiddenVenues).filter((f) => !f.book.empty);
    const mid = H.primary.book.mid();
    if (!feeds.length || !isFinite(mid)) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for order books…', w / 2, h / 2);
      return;
    }
    const lo = mid * (1 - c.rangePct / 100);
    const hi = mid * (1 + c.rangePct / 100);
    const axisW = 64;
    const plotW = w - axisW;
    const plotH = h - 18;
    const x = (p: number) => ((p - lo) / (hi - lo)) * plotW;
    const curves: { venue: VenueId | 'all'; bids: [number, number][]; asks: [number, number][] }[] = [];
    const cum = (levels: { price: number; qty: number }[], inRange: (p: number) => boolean) => {
      let s = 0;
      const out: [number, number][] = [];
      for (const l of levels) {
        if (!inRange(l.price)) break;
        s += l.qty * l.price;
        out.push([l.price, s]);
      }
      return out;
    };
    const allBids = feeds.flatMap((f) => f.book.getBids()).sort((a, b) => b.price - a.price);
    const allAsks = feeds.flatMap((f) => f.book.getAsks()).sort((a, b) => a.price - b.price);
    curves.push({ venue: 'all', bids: cum(allBids, (p) => p >= lo), asks: cum(allAsks, (p) => p <= hi) });
    if (c.perVenue) for (const f of feeds) curves.push({ venue: f.inst.venue, bids: cum(f.book.getBids(), (p) => p >= lo), asks: cum(f.book.getAsks(), (p) => p <= hi) });
    const maxV = Math.max(1, ...curves.map((cv) => Math.max(cv.bids[cv.bids.length - 1]?.[1] ?? 0, cv.asks[cv.asks.length - 1]?.[1] ?? 0)));
    const y = (v: number) => plotH - (v / maxV) * (plotH - 10);
    for (const v of axisTicks(0, maxV, plotH / 40)) {
      line(ctx, 0, y(v), plotW, y(v), pal.grid);
      ctx.font = font(10);
      ctx.fillStyle = pal.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmtUsd(v, 1), plotW + 6, y(v));
    }
    for (const cv of curves) {
      const all = cv.venue === 'all';
      for (const [pts, col, rgb] of [
        [cv.bids, pal.buy, pal.buyRgb],
        [cv.asks, pal.sell, pal.sellRgb],
      ] as const) {
        if (!pts.length) continue;
        ctx.beginPath();
        ctx.moveTo(x(pts[0][0]), plotH);
        for (const [p, v] of pts) ctx.lineTo(x(p), y(v));
        ctx.strokeStyle = all ? col : VENUE_COLORS[cv.venue];
        ctx.lineWidth = all ? 2 : 1;
        ctx.stroke();
        if (all) {
          ctx.lineTo(x(pts[pts.length - 1][0]), plotH);
          ctx.closePath();
          ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.15)`;
          ctx.fill();
        }
      }
    }
    line(ctx, x(mid), 0, x(mid), plotH, pal.muted, 1, [3, 3]);
    line(ctx, 0, plotH + 0.5, w, plotH + 0.5, pal.border);
    ctx.font = font(10);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'center';
    for (const p of axisTicks(lo, hi, plotW / 110)) ctx.fillText(fmtPrice(p), x(p), plotH + 9);
    const pt = pointer.current;
    if (pt?.inside && pt.x < plotW) {
      const price = lo + (pt.x / plotW) * (hi - lo);
      const side = price < mid ? curves[0].bids : curves[0].asks;
      const hit = price < mid ? side.find(([p]) => p <= price) : side.find(([p]) => p >= price);
      line(ctx, pt.x, 0, pt.x, plotH, pal.crosshair, 1, [3, 3]);
      if (hit) label(ctx, `${fmtPrice(price)} · ${fmtUsd(hit[1])} · ${(((price - mid) / mid) * 100).toFixed(2)}%`, pt.x, 12, pal.accent, '#fff', 'center');
    }
  };
  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select value={c.rangePct} options={[0.25, 0.5, 1, 2, 5, 10].map((v) => ({ value: v, label: `±${v}%` }))} onChange={(rangePct) => setConfig({ rangePct })} />
        <Chip active={c.perVenue} onClick={() => setConfig({ perVenue: !c.perVenue })}>
          Per venue
        </Chip>
        <Spacer />
      </Toolbar>
      <Canvas draw={draw} fps={5} pointerRef={pointer} />
    </div>
  );
}

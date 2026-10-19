import { useRef } from 'react';
import { fmtNum, fmtPrice } from '../core/format';
import { cvdSeries } from '../core/indicators';
import { TIME_RANGES, type VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { hub } from '../market/hub';
import { Canvas, drawSeries, drawTimeAxis, font, line, type DrawContext, type PointerState } from '../ui/canvas';
import { Chip, Select, Spacer, Toolbar, VenueMask, type PanelProps } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';

export interface CvdConfig {
  hiddenVenues: VenueId[];
  range: string;
  mode: 'venues' | 'aggregate' | 'both';
  usd: boolean;
  showPrice: boolean;
}

export const CVD_DEFAULTS: CvdConfig = { hiddenVenues: [], range: '1h', mode: 'both', usd: true, showPrice: true };

export function CvdChart({ config: c, setConfig }: PanelProps<CvdConfig>) {
  const pointer = useRef<PointerState | null>(null);
  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const H = hub();
    const feeds = H.visible(c.hiddenVenues);
    const range = TIME_RANGES[c.range] ?? 3_600_000;
    const interval = Math.max(1000, range / 300);
    const now = Date.now();
    const from = now - range;
    const series: { points: { time: number; value: number }[]; color: string; width?: number }[] = [];
    const agg = new Map<number, number>();
    const perVenue: { venue: VenueId; pts: { time: number; value: number }[] }[] = [];
    for (const f of feeds) {
      const pts = cvdSeries(f.store, range, interval, now).map((p) => ({ time: p.time, value: c.usd ? p.cvd * p.price : p.cvd }));
      if (!pts.length) continue;
      perVenue.push({ venue: f.inst.venue, pts });
    }
    // aggregate with forward-fill on a common grid
    const grid: number[] = [];
    for (let t = Math.floor(from / interval) * interval; t <= now; t += interval) grid.push(t);
    for (const { pts } of perVenue) {
      let j = 0;
      let last = 0;
      for (const t of grid) {
        while (j < pts.length && pts[j].time <= t) last = pts[j++].value;
        agg.set(t, (agg.get(t) ?? 0) + last);
      }
    }
    if (c.mode !== 'aggregate') for (const v of perVenue) series.push({ points: v.pts, color: VENUE_COLORS[v.venue], width: 1.2 });
    if (c.mode !== 'venues' && perVenue.length) series.push({ points: grid.map((t) => ({ time: t, value: agg.get(t) ?? 0 })), color: pal.text, width: 2 });
    if (!series.length) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for trades…', w / 2, h / 2);
      return;
    }
    const timeH = 18;
    const priceH = c.showPrice ? Math.floor((h - timeH) * 0.35) : 0;
    const fmt = (v: number) => (c.usd ? '$' : '') + fmtNum(v, 1);
    if (c.showPrice) {
      const pts = H.primary.mids.items.filter((p) => p.time >= from);
      drawSeries(ctx, [{ points: pts, color: pal.accent, width: 1.2 }], { x: 0, y: 4, w, h: priceH - 8 }, { from, to: now }, pal, (v) => fmtPrice(v));
      line(ctx, 0, priceH + 0.5, w, priceH + 0.5, pal.border);
    }
    const r = drawSeries(ctx, series, { x: 0, y: priceH + 6, w, h: h - priceH - timeH - 10 }, { from, to: now }, pal, fmt, { zeroLine: true });
    line(ctx, 0, h - timeH + 0.5, w, h - timeH + 0.5, pal.border);
    drawTimeAxis(ctx, from, now, 0, w - 64, h - timeH / 2, pal);
    // legend
    ctx.font = font(10, 600);
    let lx = 6;
    for (const v of c.mode !== 'aggregate' ? perVenue : []) {
      ctx.fillStyle = VENUE_COLORS[v.venue];
      const name = ADAPTERS[v.venue].short;
      ctx.fillText(name, lx, priceH + 16);
      lx += ctx.measureText(name).width + 10;
    }
    if (c.mode !== 'venues') {
      ctx.fillStyle = pal.text;
      ctx.fillText('Σ', lx, priceH + 16);
    }
    const pt = pointer.current;
    if (r && pt?.inside && pt.x < r.plotW) line(ctx, pt.x, 0, pt.x, h - timeH, pal.crosshair, 1, [3, 3]);
  };
  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select value={c.range} options={['5m', '15m', '30m', '1h', '4h', '12h', '24h']} onChange={(range) => setConfig({ range })} />
        <Select
          value={c.mode}
          options={[
            { value: 'both', label: 'Venues + Σ' },
            { value: 'venues', label: 'Per venue' },
            { value: 'aggregate', label: 'Aggregated' },
          ]}
          onChange={(mode) => setConfig({ mode })}
        />
        <Chip active={c.usd} onClick={() => setConfig({ usd: !c.usd })}>
          $
        </Chip>
        <Chip active={c.showPrice} onClick={() => setConfig({ showPrice: !c.showPrice })}>
          Price
        </Chip>
        <Spacer />
      </Toolbar>
      <Canvas draw={draw} fps={4} pointerRef={pointer} />
    </div>
  );
}

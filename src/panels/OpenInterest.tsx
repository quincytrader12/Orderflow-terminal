import { fmtPct, fmtUsd } from '../core/format';
import type { VenueId } from '../core/types';
import { hub, type SeriesPoint } from '../market/hub';
import { Canvas, drawSeries, drawTimeAxis, font, line, type DrawContext } from '../ui/canvas';
import { Select, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';

export interface OiConfig {
  hiddenVenues: VenueId[];
  range: string;
  mode: 'aggregate' | 'venues';
}

export const OI_DEFAULTS: OiConfig = { hiddenVenues: [], range: '24h', mode: 'aggregate' };

const RANGES: Record<string, number> = { '1h': 3600e3, '4h': 14400e3, '12h': 43200e3, '24h': 86400e3 };

function changeOver(points: SeriesPoint[], ms: number): number {
  if (points.length < 2) return NaN;
  const last = points[points.length - 1];
  for (let i = points.length - 2; i >= 0; i--) if (points[i].time <= last.time - ms) return ((last.value - points[i].value) / points[i].value) * 100;
  return NaN;
}

/** Sum per-venue series on a common grid using forward fill (only after each venue has data). */
export function aggregateSeries(series: SeriesPoint[][], from: number, to: number, step: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const idx = series.map(() => 0);
  const last = series.map(() => NaN);
  for (let t = Math.floor(from / step) * step; t <= to; t += step) {
    let sum = 0;
    let any = false;
    series.forEach((s, k) => {
      while (idx[k] < s.length && s[idx[k]].time <= t) last[k] = s[idx[k]++].value;
      if (isFinite(last[k])) {
        sum += last[k];
        any = true;
      }
    });
    if (any) out.push({ time: t, value: sum });
  }
  return out;
}

export function OpenInterest({ config: c, setConfig }: PanelProps<OiConfig>) {
  useTicker(2000);
  const H = hub();
  const feeds = H.visible(c.hiddenVenues).filter((f) => f.adapter.kind === 'perp');
  const total = feeds.reduce((a, f) => a + (f.stats.openInterestUsd ?? 0), 0);

  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const span = RANGES[c.range] ?? 86400e3;
    const to = Date.now();
    const from = to - span;
    const per = feeds.map((f) => ({ venue: f.inst.venue, points: f.oi.items }));
    const series =
      c.mode === 'aggregate'
        ? [{ points: aggregateSeries(per.map((p) => p.points), from, to, Math.max(15e3, span / 400)), color: pal.accent, width: 2, fill: 'rgba(79,140,255,0.08)' }]
        : per.map((p) => ({ points: p.points, color: VENUE_COLORS[p.venue], width: 1.5 }));
    const r = drawSeries(ctx, series, { x: 0, y: 6, w, h: h - 30 }, { from, to }, pal, (v) => fmtUsd(v, 2));
    if (!r) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText('Collecting open interest…', w / 2, h / 2);
      return;
    }
    line(ctx, 0, h - 18.5, w, h - 18.5, pal.border);
    drawTimeAxis(ctx, from, to, 0, r.plotW, h - 9, pal);
  };

  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select value={c.range} options={Object.keys(RANGES)} onChange={(range) => setConfig({ range })} />
        <Select
          value={c.mode}
          options={[
            { value: 'aggregate', label: 'Aggregated' },
            { value: 'venues', label: 'Per venue' },
          ]}
          onChange={(mode) => setConfig({ mode })}
        />
        <Spacer />
        <span className="mono">Σ {fmtUsd(total)}</span>
      </Toolbar>
      <table className="grid" style={{ flexShrink: 0 }}>
        <thead>
          <tr>
            <th>Venue</th>
            <th>OI (USD)</th>
            <th>Share</th>
            <th>Δ 1h</th>
            <th>Δ 4h</th>
          </tr>
        </thead>
        <tbody>
          {feeds.map((f) => {
            const oi = f.stats.openInterestUsd ?? NaN;
            const d1 = changeOver(f.oi.items, 3600e3);
            const d4 = changeOver(f.oi.items, 14400e3);
            return (
              <tr key={f.key}>
                <td>
                  <VenueTag venue={f.inst.venue} />
                </td>
                <td>{fmtUsd(oi)}</td>
                <td className="muted">{total && isFinite(oi) ? ((oi / total) * 100).toFixed(1) + '%' : '—'}</td>
                <td className={d1 >= 0 ? 'up' : 'down'}>{fmtPct(d1)}</td>
                <td className={d4 >= 0 ? 'up' : 'down'}>{fmtPct(d4)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Canvas draw={draw} fps={1} cursor="default" />
    </div>
  );
}

import { fmtNum } from '../core/format';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { Canvas, drawSeries, drawTimeAxis, font, line, type DrawContext } from '../ui/canvas';
import { Select, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';

export interface SpreadConfig {
  hiddenVenues: VenueId[];
  unit: 'bps' | 'usd';
  range: string;
}

export const SPREAD_DEFAULTS: SpreadConfig = { hiddenVenues: [], unit: 'bps', range: '15m' };

const RANGES: Record<string, number> = { '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3 };

export function SpreadChart({ config: c, setConfig }: PanelProps<SpreadConfig>) {
  useTicker(1000);
  const H = hub();
  const primary = H.primary;
  const others = H.visible(c.hiddenVenues).filter((f) => f !== primary);
  const pm = primary.book.mid();
  const conv = (v: number, ref: number) => (c.unit === 'bps' ? (v / ref) * 1e4 : v);

  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const span = RANGES[c.range] ?? 900e3;
    const to = Date.now();
    const from = to - span;
    const pMap = new Map(primary.mids.items.map((p) => [Math.round(p.time / 1000), p.value]));
    const series = others.map((f) => ({
      color: VENUE_COLORS[f.inst.venue],
      width: 1.4,
      points: f.mids.items
        .filter((p) => p.time >= from)
        .map((p) => {
          const ref = pMap.get(Math.round(p.time / 1000));
          return { time: p.time, value: ref ? conv(p.value - ref, ref) : NaN };
        }),
    }));
    const hasData = series.some((x) => x.points.some((p) => isFinite(p.value)));
    const r = hasData && drawSeries(ctx, series, { x: 0, y: 6, w, h: h - 30 }, { from, to }, pal, (v) => (c.unit === 'bps' ? v.toFixed(1) + 'bp' : fmtNum(v, 2)), { zeroLine: true, yMin: 0, yMax: 0 });
    if (!r) {
      ctx.fillStyle = pal.muted;
      ctx.font = font(12, 400, false);
      ctx.textAlign = 'center';
      ctx.fillText(others.length ? 'Collecting mid prices…' : 'Add venues to the aggregate set to compare', w / 2, h / 2);
      return;
    }
    line(ctx, 0, h - 18.5, w, h - 18.5, pal.border);
    drawTimeAxis(ctx, from, to, 0, r.plotW, h - 9, pal);
  };

  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select
          value={c.unit}
          options={[
            { value: 'bps', label: 'bps' },
            { value: 'usd', label: 'price' },
          ]}
          onChange={(unit) => setConfig({ unit })}
        />
        <Select value={c.range} options={Object.keys(RANGES)} onChange={(range) => setConfig({ range })} />
        <Spacer />
        <span className="muted">vs {primary.adapter.short} {primary.inst.symbol}</span>
      </Toolbar>
      <div className="toolbar" style={{ gap: 12 }}>
        {others.map((f) => {
          const m = f.book.mid();
          const d = isFinite(m) && isFinite(pm) ? conv(m - pm, pm) : NaN;
          return (
            <span key={f.key} className="mono">
              <VenueTag venue={f.inst.venue} /> <span className={d >= 0 ? 'up' : 'down'}>{isFinite(d) ? (c.unit === 'bps' ? d.toFixed(1) + 'bp' : fmtNum(d, 2)) : '—'}</span>
            </span>
          );
        })}
      </div>
      <Canvas draw={draw} fps={1} cursor="default" />
    </div>
  );
}

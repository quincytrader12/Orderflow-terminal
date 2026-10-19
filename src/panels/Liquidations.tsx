import { fmtPrice, fmtTime, fmtUsd } from '../core/format';
import type { Liquidation, VenueId } from '../core/types';
import { hub } from '../market/hub';
import { Canvas, drawTimeAxis, font, line, type DrawContext } from '../ui/canvas';
import { Empty, NumberInput, Select, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';

export interface LiqConfig {
  hiddenVenues: VenueId[];
  minNotional: number;
  range: string;
}

export const LIQ_DEFAULTS: LiqConfig = { hiddenVenues: [], minNotional: 1000, range: '1h' };

const RANGES: Record<string, [number, number]> = {
  '15m': [900e3, 15e3],
  '1h': [3600e3, 60e3],
  '4h': [14400e3, 300e3],
  '12h': [43200e3, 900e3],
};

export function Liquidations({ config: c, setConfig }: PanelProps<LiqConfig>) {
  useTicker(1000);
  const H = hub();
  const feeds = H.visible(c.hiddenVenues);
  const liqVenues = feeds.filter((f) => f.adapter.hasLiquidations);
  const [span, bucket] = RANGES[c.range] ?? RANGES['1h'];
  const now = Date.now();
  const all: Liquidation[] = [];
  for (const f of liqVenues) for (const l of f.liqs.items) if (l.time >= now - span && l.price * l.qty >= c.minNotional) all.push(l);
  all.sort((a, b) => a.time - b.time);
  let longs = 0;
  let shorts = 0;
  for (const l of all) l.position === 'long' ? (longs += l.price * l.qty) : (shorts += l.price * l.qty);

  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const t1 = Date.now();
    const t0 = t1 - span;
    const n = Math.ceil(span / bucket);
    const L = new Float64Array(n);
    const S = new Float64Array(n);
    for (const l of all) {
      const i = Math.min(n - 1, Math.floor((l.time - t0) / bucket));
      if (i < 0) continue;
      if (l.position === 'long') L[i] += l.price * l.qty;
      else S[i] += l.price * l.qty;
    }
    const mx = Math.max(1, ...L, ...S);
    const plotH = h - 18;
    const mid = plotH / 2;
    const bw = w / n;
    for (let i = 0; i < n; i++) {
      const hs = (S[i] / mx) * (mid - 4);
      const hl = (L[i] / mx) * (mid - 4);
      ctx.fillStyle = pal.buy;
      ctx.fillRect(i * bw + 0.5, mid - hs, Math.max(1, bw - 1), hs);
      ctx.fillStyle = pal.sell;
      ctx.fillRect(i * bw + 0.5, mid, Math.max(1, bw - 1), hl);
    }
    line(ctx, 0, mid + 0.5, w, mid + 0.5, pal.border);
    ctx.font = font(9);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.fillText(`shorts liquidated ▲  max ${fmtUsd(mx)}/bar`, 4, 10);
    ctx.fillText('longs liquidated ▼', 4, plotH - 4);
    line(ctx, 0, plotH + 0.5, w, plotH + 0.5, pal.border);
    drawTimeAxis(ctx, t0, t1, 0, w, plotH + 9, pal);
  };

  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select value={c.range} options={Object.keys(RANGES)} onChange={(range) => setConfig({ range })} />
        <NumberInput value={c.minNotional} onChange={(minNotional) => setConfig({ minNotional: Math.max(0, minNotional) })} width={80} suffix="$ min" />
        <Spacer />
        <span className="muted">{liqVenues.map((f) => f.adapter.short).join(' · ') || 'no venue with public liquidations'}</span>
      </Toolbar>
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat">
          <div className="k">Longs liquidated</div>
          <div className="v down">{fmtUsd(longs)}</div>
        </div>
        <div className="stat">
          <div className="k">Shorts liquidated</div>
          <div className="v up">{fmtUsd(shorts)}</div>
        </div>
        <div className="stat">
          <div className="k">Long share</div>
          <div className="v">{longs + shorts ? ((longs / (longs + shorts)) * 100).toFixed(0) + '%' : '—'}</div>
          <div className="bar-split">
            <div style={{ width: `${longs + shorts ? (shorts / (longs + shorts)) * 100 : 50}%` }} />
            <div style={{ flex: 1 }} />
          </div>
        </div>
      </div>
      <div style={{ height: 120, position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Canvas draw={draw} fps={2} cursor="default" />
      </div>
      <div className="scroll">
        {all.length === 0 ? (
          <Empty>No liquidations ≥ {fmtUsd(c.minNotional)} in the last {c.range}. Hyperliquid, Coinbase, Kraken, Bitget and Bitfinex do not publish a public liquidation stream.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Time</th>
                <th>Venue</th>
                <th>Side</th>
                <th>Price</th>
                <th>Notional</th>
              </tr>
            </thead>
            <tbody>
              {all
                .slice(-200)
                .reverse()
                .map((l, i) => {
                  const usd = l.price * l.qty;
                  return (
                    <tr key={`${l.time}-${i}`} style={{ fontWeight: usd >= 100_000 ? 700 : 400 }}>
                      <td className="muted">{fmtTime(l.time)}</td>
                      <td>
                        <VenueTag venue={l.venue} />
                      </td>
                      <td className={l.position === 'long' ? 'down' : 'up'}>{l.position.toUpperCase()}</td>
                      <td>{fmtPrice(l.price)}</td>
                      <td className={l.position === 'long' ? 'down' : 'up'}>{fmtUsd(usd)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

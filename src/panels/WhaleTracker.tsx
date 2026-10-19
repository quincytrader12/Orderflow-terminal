import { fmtPrice, fmtTime, fmtUsd } from '../core/format';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { whaleEvents, WHALE_FLOOR_USD } from '../market/collectors';
import { Canvas, font, line, type DrawContext } from '../ui/canvas';
import { Chip, Empty, NumberInput, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';
import { rgba } from '../ui/theme';

export interface WhalesConfig {
  threshold: number;
  hiddenVenues: VenueId[];
  includeLiqs: boolean;
}

export const WHALES_DEFAULTS: WhalesConfig = { threshold: 250_000, hiddenVenues: [], includeLiqs: true };

export function WhaleTracker({ config: c, setConfig }: PanelProps<WhalesConfig>) {
  useTicker(1000);
  const now = Date.now();
  const events = whaleEvents.items.filter((e) => e.usd >= c.threshold && !c.hiddenVenues.includes(e.venue) && (c.includeLiqs || e.kind === 'trade'));
  const net = (ms: number) => {
    let b = 0;
    let s = 0;
    for (const e of events) if (e.time >= now - ms && e.kind === 'trade') e.side === 'buy' ? (b += e.usd) : (s += e.usd);
    return { b, s, d: b - s };
  };
  const windows: [string, number][] = [
    ['5m', 300e3],
    ['15m', 900e3],
    ['1h', 3600e3],
  ];

  const draw = ({ ctx, w, h, pal }: DrawContext) => {
    const span = 3600e3;
    const t0 = Date.now() - span;
    const H = hub();
    const pts = H.primary.mids.items.filter((p) => p.time >= t0);
    const evs = events.filter((e) => e.time >= t0);
    const prices = [...pts.map((p) => p.value), ...evs.map((e) => e.price)];
    if (!prices.length) return;
    let mn = Math.min(...prices);
    let mx = Math.max(...prices);
    if (mx === mn) mx = mn + 1;
    const pad = (mx - mn) * 0.1;
    mn -= pad;
    mx += pad;
    const x = (t: number) => ((t - t0) / span) * (w - 8) + 4;
    const y = (p: number) => 6 + (1 - (p - mn) / (mx - mn)) * (h - 12);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(p.time), y(p.value)) : ctx.moveTo(x(p.time), y(p.value))));
    ctx.strokeStyle = pal.muted;
    ctx.lineWidth = 1;
    ctx.stroke();
    const maxU = Math.max(...evs.map((e) => e.usd), 1);
    for (const e of evs) {
      const r = 2 + 10 * Math.sqrt(e.usd / maxU);
      ctx.beginPath();
      if (e.kind === 'liq') ctx.rect(x(e.time) - r / 1.4, y(e.price) - r / 1.4, r * 1.4, r * 1.4);
      else ctx.arc(x(e.time), y(e.price), r, 0, Math.PI * 2);
      ctx.fillStyle = rgba(e.side === 'buy' ? pal.buyRgb : pal.sellRgb, 0.5);
      ctx.fill();
    }
    ctx.font = font(9);
    ctx.fillStyle = pal.muted;
    ctx.textAlign = 'left';
    ctx.fillText('last 1h · ● prints ■ liquidations', 6, h - 6);
    line(ctx, 0, h - 0.5, w, h - 0.5, pal.border);
  };

  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <NumberInput value={c.threshold} onChange={(threshold) => setConfig({ threshold: Math.max(WHALE_FLOOR_USD, threshold) })} width={90} suffix="$ min" />
        <Chip active={c.includeLiqs} onClick={() => setConfig({ includeLiqs: !c.includeLiqs })}>
          Liquidations
        </Chip>
        <Spacer />
      </Toolbar>
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {windows.map(([label, ms]) => {
          const n = net(ms);
          return (
            <div className="stat" key={label}>
              <div className="k">Net whale flow {label}</div>
              <div className={`v ${n.d >= 0 ? 'up' : 'down'}`}>
                {n.d >= 0 ? '+' : '-'}
                {fmtUsd(Math.abs(n.d))}
              </div>
              <div className="bar-split">
                <div style={{ width: `${n.b + n.s ? (n.b / (n.b + n.s)) * 100 : 50}%` }} />
                <div style={{ flex: 1 }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ height: 110, position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <Canvas draw={draw} fps={2} cursor="default" />
      </div>
      <div className="scroll">
        {events.length === 0 ? (
          <Empty>No prints ≥ {fmtUsd(c.threshold)} yet. Whale events are collected from the moment the terminal opens.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Time</th>
                <th>Venue</th>
                <th>Type</th>
                <th>Price</th>
                <th>Notional</th>
              </tr>
            </thead>
            <tbody>
              {events
                .slice(-200)
                .reverse()
                .map((e, i) => (
                  <tr key={`${e.time}-${i}`}>
                    <td className="muted">{fmtTime(e.time)}</td>
                    <td>
                      <VenueTag venue={e.venue} />
                    </td>
                    <td className={e.side === 'buy' ? 'up' : 'down'}>{e.kind === 'liq' ? (e.side === 'sell' ? 'LONG LIQ' : 'SHORT LIQ') : e.side.toUpperCase()}</td>
                    <td>{fmtPrice(e.price)}</td>
                    <td className={e.side === 'buy' ? 'up' : 'down'} style={{ fontWeight: 700 }}>
                      {fmtUsd(e.usd)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { fmtPct, fmtUsd } from '../core/format';
import { flowWindow } from '../core/indicators';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';

export interface FlowConfig {
  hiddenVenues: VenueId[];
}

export const FLOW_DEFAULTS: FlowConfig = { hiddenVenues: [] };

const WINDOWS: [string, number][] = [
  ['30s', 30e3],
  ['1m', 60e3],
  ['5m', 300e3],
  ['15m', 900e3],
];

export function FlowPulse({ config: c, setConfig }: PanelProps<FlowConfig>) {
  useTicker(1000);
  const H = hub();
  const feeds = H.visible(c.hiddenVenues);
  const now = Date.now();
  const windows = WINDOWS.map(([label, ms]) => {
    let buy = 0;
    let sell = 0;
    let trades = 0;
    for (const f of feeds) {
      const w = flowWindow(f.store, ms, now);
      buy += w.buyNotional;
      sell += w.sellNotional;
      trades += w.trades;
    }
    return { label, buy, sell, trades };
  });
  const perVenue = feeds
    .map((f) => {
      const w = flowWindow(f.store, 60e3, now);
      return { f, vol: w.buyNotional + w.sellNotional, delta: w.buyNotional - w.sellNotional, trades: w.trades };
    })
    .sort((a, b) => b.vol - a.vol);
  const maxVol = Math.max(1, ...perVenue.map((v) => v.vol));

  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Spacer />
        <span className="muted">rolling aggressor flow · {H.primary.inst.base}</span>
      </Toolbar>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Window</th>
              <th>Bought</th>
              <th>Sold</th>
              <th>Delta</th>
              <th style={{ width: '32%' }}>Buy / Sell</th>
            </tr>
          </thead>
          <tbody>
            {windows.map((w) => {
              const tot = w.buy + w.sell;
              const d = w.buy - w.sell;
              return (
                <tr key={w.label}>
                  <td>{w.label}</td>
                  <td className="up">{fmtUsd(w.buy)}</td>
                  <td className="down">{fmtUsd(w.sell)}</td>
                  <td className={d >= 0 ? 'up' : 'down'}>
                    {d >= 0 ? '+' : '-'}
                    {fmtUsd(Math.abs(d))}
                    <span className="muted"> {tot ? fmtPct((d / tot) * 100, 0) : ''}</span>
                  </td>
                  <td>
                    <div className="bar-split" style={{ marginTop: 0 }}>
                      <div style={{ width: `${tot ? (w.buy / tot) * 100 : 50}%` }} />
                      <div style={{ flex: 1 }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="pop-title" style={{ padding: '10px 6px 0' }}>
          Last minute per venue
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Venue</th>
              <th>Volume</th>
              <th>Delta</th>
              <th>Trades</th>
              <th style={{ width: '30%' }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {perVenue.map(({ f, vol, delta, trades }) => (
              <tr key={f.key}>
                <td>
                  <VenueTag venue={f.inst.venue} /> <span className="muted">{f.inst.symbol}</span>
                </td>
                <td>{fmtUsd(vol)}</td>
                <td className={delta >= 0 ? 'up' : 'down'}>
                  {delta >= 0 ? '+' : '-'}
                  {fmtUsd(Math.abs(delta))}
                </td>
                <td className="muted">{trades}</td>
                <td>
                  <div style={{ height: 6, borderRadius: 3, background: 'var(--accent)', width: `${(vol / maxVol) * 100}%`, opacity: 0.7 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

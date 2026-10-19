import { fmtPrice, fmtUsd } from '../core/format';
import { depthStats, type DepthStats } from '../core/orderbook';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { Select, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';

export interface ObStatsConfig {
  hiddenVenues: VenueId[];
  band: '05' | '2' | '10';
}

export const OBSTATS_DEFAULTS: ObStatsConfig = { hiddenVenues: [], band: '2' };

function Imb({ bid, ask }: { bid: number; ask: number }) {
  const t = bid + ask;
  const pct = t ? (bid / t) * 100 : 50;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div className="bar-split" style={{ marginTop: 0, flex: 1, minWidth: 60 }}>
        <div style={{ width: `${pct}%` }} />
        <div style={{ flex: 1 }} />
      </div>
      <span className={pct >= 50 ? 'up' : 'down'} style={{ width: 34 }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

export function OrderbookStats({ config: c, setConfig }: PanelProps<ObStatsConfig>) {
  useTicker(500);
  const feeds = hub().visible(c.hiddenVenues);
  const rows = feeds.map((f) => ({ f, s: depthStats(f.book) })).filter((r): r is { f: typeof r.f; s: DepthStats } => r.s !== null);
  const sum = (k: keyof DepthStats) => rows.reduce((a, r) => a + (r.s[k] as number) * r.s.mid, 0);
  const bidKey = (`bid${c.band}`) as keyof DepthStats;
  const askKey = (`ask${c.band}`) as keyof DepthStats;
  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Select
          value={c.band}
          options={[
            { value: '05', label: 'within 0.5%' },
            { value: '2', label: 'within 2%' },
            { value: '10', label: 'within 10%' },
          ]}
          onChange={(band) => setConfig({ band })}
          title="Imbalance band"
        />
        <Spacer />
      </Toolbar>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Venue</th>
              <th>Mid</th>
              <th>Spread</th>
              <th>Bid 0.5%</th>
              <th>Ask 0.5%</th>
              <th>Bid 2%</th>
              <th>Ask 2%</th>
              <th>Bid 10%</th>
              <th>Ask 10%</th>
              <th style={{ minWidth: 110 }}>Imbalance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ f, s }) => (
              <tr key={f.key}>
                <td>
                  <VenueTag venue={f.inst.venue} />
                </td>
                <td>{fmtPrice(s.mid)}</td>
                <td className="muted">{s.spreadBps.toFixed(2)}bp</td>
                <td className="up">{fmtUsd(s.bid05 * s.mid)}</td>
                <td className="down">{fmtUsd(s.ask05 * s.mid)}</td>
                <td className="up">{fmtUsd(s.bid2 * s.mid)}</td>
                <td className="down">{fmtUsd(s.ask2 * s.mid)}</td>
                <td className="up">{fmtUsd(s.bid10 * s.mid)}</td>
                <td className="down">{fmtUsd(s.ask10 * s.mid)}</td>
                <td>
                  <Imb bid={s[bidKey] as number} ask={s[askKey] as number} />
                </td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr style={{ fontWeight: 700 }}>
                <td>Σ</td>
                <td />
                <td />
                <td className="up">{fmtUsd(sum('bid05'))}</td>
                <td className="down">{fmtUsd(sum('ask05'))}</td>
                <td className="up">{fmtUsd(sum('bid2'))}</td>
                <td className="down">{fmtUsd(sum('ask2'))}</td>
                <td className="up">{fmtUsd(sum('bid10'))}</td>
                <td className="down">{fmtUsd(sum('ask10'))}</td>
                <td>
                  <Imb bid={sum(bidKey)} ask={sum(askKey)} />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="empty" style={{ textAlign: 'left', padding: '8px 8px' }}>
          Depth is limited to what each venue publishes: Hyperliquid 20 levels, Bybit 200, OKX 400, Bitfinex 250, Binance/Kraken/Coinbase/Bitget full or 1000+.
        </div>
      </div>
    </div>
  );
}

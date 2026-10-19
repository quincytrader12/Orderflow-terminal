import { fmtDuration, fmtPrice, fmtUsd } from '../core/format';
import type { VenueId } from '../core/types';
import { hub } from '../market/hub';
import { Empty, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';

export interface FundingConfig {
  hiddenVenues: VenueId[];
}

export const FUNDING_DEFAULTS: FundingConfig = { hiddenVenues: [] };

export function FundingMonitor({ config: c, setConfig }: PanelProps<FundingConfig>) {
  useTicker(1000);
  const feeds = hub()
    .visible(c.hiddenVenues)
    .filter((f) => f.adapter.kind === 'perp');
  const now = Date.now();
  let wSum = 0;
  let w = 0;
  const rows = feeds.map((f) => {
    const s = f.stats;
    const ih = s.fundingIntervalH ?? 8;
    const rate = s.fundingRate;
    const per8h = rate !== undefined ? rate * (8 / ih) : NaN;
    const apr = rate !== undefined ? rate * (24 / ih) * 365 * 100 : NaN;
    const oi = s.openInterestUsd ?? 0;
    if (isFinite(per8h) && oi) {
      wSum += per8h * oi;
      w += oi;
    }
    const basisBps = s.markPrice && s.indexPrice ? ((s.markPrice - s.indexPrice) / s.indexPrice) * 1e4 : NaN;
    return { f, ih, rate, per8h, apr, oi, basisBps };
  });
  const oiWeighted = w ? (wSum / w) * 100 : NaN;
  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <Spacer />
        <span className="mono">
          OI-weighted 8h: <span className={oiWeighted >= 0 ? 'up' : 'down'}>{isFinite(oiWeighted) ? oiWeighted.toFixed(4) + '%' : '—'}</span>
        </span>
      </Toolbar>
      <div className="scroll">
        {rows.length === 0 ? (
          <Empty>No perpetual venues in the aggregate set.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Venue</th>
                <th>Rate</th>
                <th>Interval</th>
                <th>8h equiv.</th>
                <th>APR</th>
                <th>Next</th>
                <th>Mark</th>
                <th>Basis</th>
                <th>OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.f.key}>
                  <td>
                    <VenueTag venue={r.f.inst.venue} />
                  </td>
                  <td className={(r.rate ?? 0) >= 0 ? 'up' : 'down'}>{r.rate !== undefined ? (r.rate * 100).toFixed(4) + '%' : '—'}</td>
                  <td className="muted">{r.ih}h</td>
                  <td className={r.per8h >= 0 ? 'up' : 'down'}>{isFinite(r.per8h) ? (r.per8h * 100).toFixed(4) + '%' : '—'}</td>
                  <td className={r.apr >= 0 ? 'up' : 'down'}>{isFinite(r.apr) ? r.apr.toFixed(1) + '%' : '—'}</td>
                  <td className="muted">{r.f.stats.nextFundingTime ? fmtDuration(r.f.stats.nextFundingTime - now) : '—'}</td>
                  <td>{fmtPrice(r.f.stats.markPrice ?? NaN)}</td>
                  <td className={r.basisBps >= 0 ? 'up' : 'down'}>{isFinite(r.basisBps) ? r.basisBps.toFixed(1) + 'bp' : '—'}</td>
                  <td>{fmtUsd(r.oi || NaN)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

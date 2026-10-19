import type { ReactNode } from 'react';
import { fmtDuration, fmtNum, fmtPct, fmtPrice, fmtUsd } from '../core/format';
import { hub } from '../market/hub';
import { Spacer, Toolbar, useTicker, VenueTag, type PanelProps } from '../ui/controls';

export type SummaryConfig = Record<string, never>;
export const SUMMARY_DEFAULTS: SummaryConfig = {};

function Stat({ k, v, s, cls }: { k: string; v: ReactNode; s?: ReactNode; cls?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${cls ?? ''}`}>{v}</div>
      {s !== undefined && <div className="s">{s}</div>}
    </div>
  );
}

export function SymbolSummary(_: PanelProps<SummaryConfig>) {
  useTicker(1000);
  const H = hub();
  const f = H.primary;
  const s = f.stats;
  const last = f.lastPrice();
  const basis = s.markPrice !== undefined && s.indexPrice ? s.markPrice - s.indexPrice : NaN;
  const basisBps = isFinite(basis) && s.indexPrice ? (basis / s.indexPrice) * 1e4 : NaN;
  const fundingPct = s.fundingRate !== undefined ? s.fundingRate * 100 : NaN;
  const apr = isFinite(fundingPct) ? fundingPct * (24 / (s.fundingIntervalH ?? 8)) * 365 : NaN;
  const now = Date.now();
  const perps = H.aggregate.filter((x) => x.adapter.kind === 'perp');
  const aggOi = perps.reduce((a, x) => a + (x.stats.openInterestUsd ?? 0), 0);
  const aggVol = H.aggregate.reduce((a, x) => a + (x.stats.volume24hUsd ?? 0), 0);
  const range = s.high24h && s.low24h ? ((last - s.low24h) / (s.high24h - s.low24h)) * 100 : NaN;

  return (
    <div className="panel">
      <Toolbar>
        <VenueTag venue={f.inst.venue} />
        <b className="mono">{f.inst.symbol}</b>
        <span className="muted">{f.adapter.name}</span>
        <Spacer />
        <span className="muted mono">{f.rate.toFixed(0)} msg/s</span>
      </Toolbar>
      <div className="scroll">
        <div className="stat-grid">
          <Stat k="Last" v={fmtPrice(last)} s={s.change24hPct !== undefined ? fmtPct(s.change24hPct) + ' 24h' : undefined} cls={(s.change24hPct ?? 0) >= 0 ? 'up' : 'down'} />
          <Stat k="24h range" v={`${fmtPrice(s.low24h ?? NaN)} – ${fmtPrice(s.high24h ?? NaN)}`} s={isFinite(range) ? `${range.toFixed(0)}% of range` : undefined} />
          <Stat k="24h volume" v={fmtUsd(s.volume24hUsd ?? NaN)} s={`all venues ${fmtUsd(aggVol)}`} />
          {f.adapter.kind === 'perp' && (
            <>
              <Stat k="Mark / Index" v={fmtPrice(s.markPrice ?? NaN)} s={`index ${fmtPrice(s.indexPrice ?? NaN)}`} />
              <Stat k="Basis" v={isFinite(basis) ? fmtPrice(basis) : '—'} s={isFinite(basisBps) ? `${basisBps.toFixed(2)} bps` : undefined} cls={basis >= 0 ? 'up' : 'down'} />
              <Stat
                k={`Funding (${s.fundingIntervalH ?? 8}h)`}
                v={isFinite(fundingPct) ? fundingPct.toFixed(4) + '%' : '—'}
                s={`${isFinite(apr) ? apr.toFixed(1) + '% APR' : ''}${s.nextFundingTime ? ' · in ' + fmtDuration(s.nextFundingTime - now) : ''}`}
                cls={fundingPct >= 0 ? 'up' : 'down'}
              />
              <Stat k="Open interest" v={fmtUsd(s.openInterestUsd ?? NaN)} s={s.openInterest !== undefined ? `${fmtNum(s.openInterest)} ${f.inst.base}` : undefined} />
              <Stat k="OI all perps" v={fmtUsd(aggOi)} s={`${perps.length} venues`} />
              <Stat
                k="Long / short accounts"
                v={s.longShortRatio !== undefined ? s.longShortRatio.toFixed(2) : '—'}
                s={
                  s.longAccount !== undefined ? (
                    <>
                      {(s.longAccount * 100).toFixed(1)}% L · {((s.shortAccount ?? 1 - s.longAccount) * 100).toFixed(1)}% S
                      <div className="bar-split">
                        <div style={{ width: `${s.longAccount * 100}%` }} />
                        <div style={{ flex: 1 }} />
                      </div>
                    </>
                  ) : (
                    'not published by this venue'
                  )
                }
              />
            </>
          )}
          <Stat k="Feed" v={f.status.state} s={`${f.status.latencyMs !== undefined ? f.status.latencyMs.toFixed(0) + 'ms · ' : ''}${f.store.length.toLocaleString()} trades held`} cls={f.status.state === 'open' ? 'up' : 'down'} />
        </div>
      </div>
    </div>
  );
}

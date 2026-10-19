import { useEffect, useState } from 'react';
import { fmtPct, fmtPrice, fmtUsd } from '../core/format';
import type { Ticker, VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { useSettings } from '../store/settings';
import { Empty, NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export interface ScreenerConfig {
  venue: VenueId;
  sort: keyof Ticker;
  desc: boolean;
  minVolume: number;
}

export const SCREENER_DEFAULTS: ScreenerConfig = { venue: 'binancef', sort: 'volume24hUsd', desc: true, minVolume: 1_000_000 };

const SCREENER_VENUES = (Object.keys(ADAPTERS) as VenueId[]).filter((v) => ADAPTERS[v].fetchTickers);

export function Screener({ config: c, setConfig }: PanelProps<ScreenerConfig>) {
  const [rows, setRows] = useState<Ticker[]>([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const setPrimary = useSettings((s) => s.setPrimary);

  useEffect(() => {
    let alive = true;
    const load = () =>
      ADAPTERS[c.venue]
        .fetchTickers!()
        .then((r) => {
          if (!alive) return;
          setRows(r);
          setErr('');
          setLoading(false);
        })
        .catch((e) => {
          if (!alive) return;
          setErr(String(e?.message ?? e));
          setLoading(false);
        });
    setLoading(true);
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.venue]);

  const filtered = rows
    .filter((r) => r.volume24hUsd >= c.minVolume && (!q || r.base.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => {
      const av = a[c.sort] as number | string | undefined;
      const bv = b[c.sort] as number | string | undefined;
      if (typeof av === 'string' || typeof bv === 'string') return (c.desc ? -1 : 1) * String(av).localeCompare(String(bv));
      return (c.desc ? -1 : 1) * ((av ?? -Infinity) - (bv ?? -Infinity));
    });

  const th = (k: keyof Ticker, labelText: string) => (
    <th className="sortable" onClick={() => setConfig(c.sort === k ? { desc: !c.desc } : { sort: k, desc: true })}>
      {labelText} {c.sort === k ? (c.desc ? '▾' : '▴') : ''}
    </th>
  );

  return (
    <div className="panel">
      <Toolbar>
        <Select value={c.venue} options={SCREENER_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))} onChange={(venue) => setConfig({ venue })} />
        <input className="ctl" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 90 }} />
        <NumberInput value={c.minVolume} onChange={(minVolume) => setConfig({ minVolume })} width={90} suffix="$ vol" />
        <Spacer />
        <span className="muted">{filtered.length} markets · click to load</span>
      </Toolbar>
      <div className="scroll">
        {err ? (
          <Empty>Could not load {ADAPTERS[c.venue].name} tickers: {err}</Empty>
        ) : loading && !rows.length ? (
          <Empty>Loading…</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                {th('base', 'Symbol')}
                {th('last', 'Price')}
                {th('change24hPct', '24h')}
                {th('volume24hUsd', 'Volume')}
                {th('fundingRate', 'Funding')}
                {th('openInterestUsd', 'OI')}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 400).map((r) => (
                <tr key={r.symbol} className="clickable" onClick={() => setPrimary(r.base, c.venue)} title={`Load ${r.base} on ${ADAPTERS[c.venue].name}`}>
                  <td className="l">
                    <b>{r.base}</b> <span className="muted">{r.symbol !== r.base ? r.symbol : ''}</span>
                  </td>
                  <td>{fmtPrice(r.last)}</td>
                  <td className={r.change24hPct >= 0 ? 'up' : 'down'}>{fmtPct(r.change24hPct)}</td>
                  <td>{fmtUsd(r.volume24hUsd)}</td>
                  <td className={(r.fundingRate ?? 0) >= 0 ? 'up' : 'down'}>{r.fundingRate !== undefined ? (r.fundingRate * 100).toFixed(4) + '%' : '—'}</td>
                  <td>{r.openInterestUsd !== undefined ? fmtUsd(r.openInterestUsd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

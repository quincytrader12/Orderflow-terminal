import { useEffect, useRef, useState } from 'react';
import { fmtPct, fmtPrice, fmtUsd } from '../core/format';
import type { Ticker, VenueId } from '../core/types';
import { ADAPTERS, VENUE_IDS } from '../exchanges';
import { useSettings, type WatchItem } from '../store/settings';
import { Empty, Select, Spacer, Toolbar, VenueTag, type PanelProps } from '../ui/controls';

export type WatchlistConfig = Record<string, never>;
export const WATCHLIST_DEFAULTS: WatchlistConfig = {};

const key = (w: WatchItem) => `${w.venue}:${w.symbol}`;

export function Watchlist(_: PanelProps<WatchlistConfig>) {
  const items = useSettings((s) => s.watchlist);
  const addWatch = useSettings((s) => s.addWatch);
  const removeWatch = useSettings((s) => s.removeWatch);
  const setPrimary = useSettings((s) => s.setPrimary);
  const [data, setData] = useState<Record<string, Ticker | { error: string }>>({});
  const prev = useRef<Record<string, number>>({});
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const [venue, setVenue] = useState<VenueId>('binancef');
  const [base, setBase] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const results = await Promise.all(
        items.map(async (w) => {
          try {
            const t = await ADAPTERS[w.venue].fetchTicker?.(w.symbol);
            return [key(w), t ?? { error: 'not found' }] as const;
          } catch (e) {
            return [key(w), { error: String((e as Error)?.message ?? e) }] as const;
          }
        }),
      );
      if (!alive) return;
      const next = Object.fromEntries(results);
      const f: Record<string, 'up' | 'down'> = {};
      for (const [k, t] of results) {
        if ('last' in t) {
          const p = prev.current[k];
          if (p !== undefined && t.last !== p) f[k] = t.last > p ? 'up' : 'down';
          prev.current[k] = t.last;
        }
      }
      setData(next);
      setFlash(f);
    };
    void load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [items]);

  const add = () => {
    const b = base.trim().toUpperCase();
    if (!b) return;
    // accept either a base asset (BTC) or a venue-native symbol (BTCUSDT, BTC-USD)
    const looksNative = /[-/:]|USDT$|USD$/.test(b) && b.length > 4;
    const symbol = looksNative ? b : ADAPTERS[venue].symbolFor(b);
    if (symbol) addWatch({ venue, symbol });
    setBase('');
  };

  return (
    <div className="panel">
      <Toolbar>
        <Select value={venue} options={VENUE_IDS.map((v) => ({ value: v, label: ADAPTERS[v].name }))} onChange={setVenue} width={120} />
        <input className="ctl" placeholder="BTC, ETHUSDT…" value={base} onChange={(e) => setBase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} style={{ width: 100 }} />
        <button className="chip" onClick={add}>
          + Add
        </button>
        <Spacer />
        <span className="muted">public REST · 5s</span>
      </Toolbar>
      <div className="scroll">
        {items.length === 0 ? (
          <Empty>Add symbols from any supported venue.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Price</th>
                <th>24h</th>
                <th>Volume</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((w) => {
                const t = data[key(w)];
                const ok = t && 'last' in t;
                return (
                  <tr key={key(w)} className="clickable" onClick={() => ok && setPrimary((t as Ticker).base, w.venue)}>
                    <td className="l">
                      <VenueTag venue={w.venue} /> <b>{w.symbol}</b>
                    </td>
                    <td className={flash[key(w)] ?? ''}>{ok ? fmtPrice((t as Ticker).last) : t ? <span className="muted" title={(t as { error: string }).error}>error</span> : '…'}</td>
                    <td className={ok && (t as Ticker).change24hPct >= 0 ? 'up' : 'down'}>{ok ? fmtPct((t as Ticker).change24hPct) : ''}</td>
                    <td className="muted">{ok ? fmtUsd((t as Ticker).volume24hUsd) : ''}</td>
                    <td>
                      <button
                        className="chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeWatch(w);
                        }}
                        title="Remove"
                      >
                        ×
                      </button>
                    </td>
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

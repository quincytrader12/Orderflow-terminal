import { useEffect, useRef } from 'react';
import { fmtPrice, fmtUsd, fmtVol } from '../core/format';
import type { Trade, VenueId } from '../core/types';
import { beep } from '../alerts/engine';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { Chip, Empty, NumberInput, Select, Spacer, Toolbar, useTicker, VenueMask, VenueTag, type PanelProps } from '../ui/controls';

export interface TapeConfig {
  minNotional: number;
  side: 'all' | 'buy' | 'sell';
  aggregate: boolean;
  hiddenVenues: VenueId[];
  usd: boolean;
  sound: boolean;
  rows: number;
}

export const TAPE_DEFAULTS: TapeConfig = { minNotional: 1000, side: 'all', aggregate: true, hiddenVenues: [], usd: true, sound: false, rows: 120 };

interface Row extends Trade {
  count: number;
}

/**
 * Collapse consecutive prints from the same venue, side and millisecond
 * (one aggressive order sweeping several levels) into one row at VWAP.
 */
export function aggregateTrades(trades: Trade[]): Row[] {
  const out: Row[] = [];
  for (const t of trades) {
    const last = out[out.length - 1];
    if (last && last.venue === t.venue && last.side === t.side && last.time === t.time) {
      const q = last.qty + t.qty;
      last.price = (last.price * last.qty + t.price * t.qty) / q;
      last.qty = q;
      last.count++;
    } else out.push({ ...t, count: 1 });
  }
  return out;
}

export function TradesTape({ config: c, setConfig }: PanelProps<TapeConfig>) {
  useTicker(150);
  const tierMid = useSettings((s) => s.tierMid);
  const tierWhale = useSettings((s) => s.tierWhale);
  const soundOn = useSettings((s) => s.soundEnabled);
  const cfg = useRef(c);
  cfg.current = c;

  useEffect(
    () =>
      hub().onTrade((t) => {
        const k = cfg.current;
        if (!k.sound || !soundOn || k.hiddenVenues.includes(t.venue)) return;
        const n = t.price * t.qty;
        if (n >= tierWhale) beep(t.side === 'buy' ? 1040 : 440, 90);
      }),
    [tierWhale, soundOn],
  );

  const H = hub();
  const items = H.tape.items;
  // walk backwards collecting enough raw trades, then aggregate
  const raw: Trade[] = [];
  for (let i = items.length - 1; i >= 0 && raw.length < c.rows * 6; i--) {
    const t = items[i];
    if (c.hiddenVenues.includes(t.venue)) continue;
    if (c.side !== 'all' && t.side !== c.side) continue;
    raw.push(t);
  }
  raw.reverse();
  const rows = (c.aggregate ? aggregateTrades(raw) : raw.map((t) => ({ ...t, count: 1 })))
    .filter((t) => t.price * t.qty >= c.minNotional)
    .slice(-c.rows)
    .reverse();

  const feed = H.primary;
  return (
    <div className="panel">
      <Toolbar>
        <VenueMask hidden={c.hiddenVenues} onChange={(hiddenVenues) => setConfig({ hiddenVenues })} />
        <NumberInput value={c.minNotional} onChange={(minNotional) => setConfig({ minNotional: Math.max(0, minNotional) })} width={80} suffix="$ min" />
        <Select
          value={c.side}
          options={[
            { value: 'all', label: 'Both sides' },
            { value: 'buy', label: 'Buys' },
            { value: 'sell', label: 'Sells' },
          ]}
          onChange={(side) => setConfig({ side })}
        />
        <Chip active={c.aggregate} onClick={() => setConfig({ aggregate: !c.aggregate })} title="Merge same-ms sweeps">
          Agg
        </Chip>
        <Chip active={c.usd} onClick={() => setConfig({ usd: !c.usd })} title="Size in USD">
          $
        </Chip>
        <Chip active={c.sound} onClick={() => setConfig({ sound: !c.sound })} title="Beep on whale-tier prints">
          ♪
        </Chip>
        <Spacer />
      </Toolbar>
      <div className="scroll">
        {rows.length === 0 ? (
          <Empty>Waiting for prints ≥ {fmtUsd(c.minNotional)} on {feed.inst.base}…</Empty>
        ) : (
          <table className="grid tape">
            <thead>
              <tr>
                <th>Time</th>
                <th>Venue</th>
                <th>Price</th>
                <th>{c.usd ? 'Notional' : 'Size'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const n = t.price * t.qty;
                const tier = n >= tierWhale ? 0.42 : n >= tierMid ? 0.2 : 0;
                const bg = tier ? (t.side === 'buy' ? `rgba(38,166,154,${tier})` : `rgba(239,83,80,${tier})`) : undefined;
                const d = new Date(t.time);
                return (
                  <tr key={`${t.time}-${i}-${t.price}`} style={{ background: bg, fontWeight: n >= tierWhale ? 700 : 400 }}>
                    <td className="muted">
                      {d.toLocaleTimeString([], { hour12: false })}.{String(d.getMilliseconds()).padStart(3, '0')}
                    </td>
                    <td>
                      <VenueTag venue={t.venue} />
                    </td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>{fmtPrice(t.price)}</td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>
                      {c.usd ? fmtUsd(n) : fmtVol(t.qty)}
                      {t.count > 1 && <span className="muted"> ×{t.count}</span>}
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

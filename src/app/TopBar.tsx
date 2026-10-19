import { useEffect, useRef, useState } from 'react';
import { fmtPct, fmtPrice } from '../core/format';
import type { VenueId } from '../core/types';
import { ADAPTERS, POPULAR_BASES, VENUE_IDS } from '../exchanges';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { Select, useHubVersion, useTicker } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';

export type ModalKind = 'connection' | 'layouts' | 'add' | 'settings' | null;

function useFps() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        setFps(Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return fps;
}

function SymbolPicker() {
  const base = useSettings((s) => s.base);
  const venue = useSettings((s) => s.primaryVenue);
  const setPrimary = useSettings((s) => s.setPrimary);
  const [text, setText] = useState(base);
  useEffect(() => setText(base), [base]);
  const commit = () => {
    const b = text.trim().toUpperCase();
    if (b && b !== base) setPrimary(b, venue);
    else setText(base);
  };
  return (
    <div className="group" title="Primary instrument: drives footprint, DOM, historical chart and history">
      <input
        className="ctl mono"
        list="bases"
        value={text}
        onChange={(e) => setText(e.target.value.toUpperCase())}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        style={{ width: 70, fontWeight: 700 }}
        aria-label="Base asset"
      />
      <datalist id="bases">
        {POPULAR_BASES.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <Select value={venue} options={VENUE_IDS.map((v) => ({ value: v, label: ADAPTERS[v].name }))} onChange={(v) => setPrimary(base, v)} title="Primary venue" width={130} />
    </div>
  );
}

function AggregateChips() {
  useHubVersion();
  const agg = useSettings((s) => s.aggregateVenues);
  const primary = useSettings((s) => s.primaryVenue);
  const toggle = useSettings((s) => s.toggleAggregate);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const H = hub();
  const feeds = H.aggregate;
  return (
    <div className="venue-mask" ref={ref}>
      <button className="chip" onClick={() => setOpen(!open)} title="Aggregate set: venues streamed for composite panels">
        Σ
        {feeds.map((f) => (
          <span key={f.key} className={`status-dot status-${f.status.state}`} style={{ outline: `1px solid ${VENUE_COLORS[f.inst.venue]}`, outlineOffset: 1 }} title={`${f.adapter.name}: ${f.status.state}${f.status.error ? ' — ' + f.status.error : ''}`} />
        ))}
      </button>
      {open && (
        <div className="popover" style={{ minWidth: 300 }}>
          <div className="pop-title">Aggregate set</div>
          {VENUE_IDS.map((v) => {
            const f = feeds.find((x) => x.inst.venue === v);
            const on = agg.includes(v) || v === primary;
            return (
              <label key={v} className="check" style={{ justifyContent: 'space-between' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={on} disabled={v === primary} onChange={() => toggle(v as VenueId)} />
                  <span className="dot" style={{ background: VENUE_COLORS[v] }} />
                  {ADAPTERS[v].name}
                  {v === primary && <span className="tag">primary</span>}
                </span>
                {f && (
                  <span className="muted mono" style={{ fontSize: 10 }}>
                    <span className={`status-dot status-${f.status.state}`} /> {f.rate.toFixed(0)}/s{f.status.latencyMs !== undefined ? ` · ${f.status.latencyMs.toFixed(0)}ms` : ''}
                  </span>
                )}
              </label>
            );
          })}
          <div className="popover-foot">Trades, CVD, OI, liquidations, spread, orderbook and heatmap (composite) read every visible member. Footprint, DOM and historical chart read the primary only.</div>
        </div>
      )}
    </div>
  );
}

export function TopBar({ onOpen, alertCount }: { onOpen: (m: ModalKind) => void; alertCount: number }) {
  useTicker(500);
  useHubVersion();
  const showFps = useSettings((s) => s.showFps);
  const fps = useFps();
  const H = hub();
  const f = H.primary;
  const last = f.lastPrice();
  const ch = f.stats.change24hPct;
  const bf = H.backfill;
  const now = new Date();
  return (
    <div className="topbar">
      <div className="brand">
        <span className="logo">
          <i style={{ height: 14 }} />
          <i style={{ height: 9 }} />
          <i style={{ height: 12 }} />
        </span>
        ORDERFLOW<span className="muted hide-sm">TERMINAL</span>
      </div>
      <div className="sep" />
      <SymbolPicker />
      <div className="group">
        <span className={`price-big ${(ch ?? 0) >= 0 ? 'up' : 'down'}`}>{fmtPrice(last)}</span>
        {ch !== undefined && <span className={(ch ?? 0) >= 0 ? 'up mono' : 'down mono'}>{fmtPct(ch)}</span>}
        <span className={`status-dot status-${f.status.state}`} title={`${f.adapter.name} ${f.status.state}${f.status.error ? ': ' + f.status.error : ''}`} />
      </div>
      <div className="sep" />
      <AggregateChips />
      <button className="chip" onClick={() => onOpen('connection')} title="Connection & history source">
        <span className={`status-dot status-${bf.state === 'done' ? 'open' : bf.state === 'loading' ? 'connecting' : bf.state === 'error' ? 'error' : 'idle'}`} />
        History
        {bf.state === 'loading' && (
          <span className="progress">
            <div style={{ width: `${Math.round(bf.progress * 100)}%` }} />
          </span>
        )}
      </button>
      <div style={{ flex: 1 }} />
      <button className="chip" onClick={() => onOpen('add')} title="Add a panel">
        + Panel
      </button>
      <button className="chip" onClick={() => onOpen('layouts')} title="Layout gallery & saved layouts">
        ▦ Layouts
      </button>
      <button className="chip" onClick={() => onOpen('settings')} title="Settings">
        ⚙
      </button>
      {alertCount > 0 && (
        <span className="chip" title="Alerts fired this session" style={{ color: 'var(--warn)' }}>
          🔔 {alertCount}
        </span>
      )}
      <div className="sep hide-sm" />
      <span className="mono muted hide-sm" title="UTC time">
        {now.toISOString().slice(11, 19)} UTC
      </span>
      {showFps && <span className="mono muted hide-sm">{fps} fps</span>}
    </div>
  );
}

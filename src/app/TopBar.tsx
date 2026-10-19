import { useEffect, useRef, useState } from 'react';
import { fmtPct, fmtPrice } from '../core/format';
import type { VenueId } from '../core/types';
import { ADAPTERS, POPULAR_BASES, VENUE_IDS } from '../exchanges';
import { hub } from '../market/hub';
import { useSettings } from '../store/settings';
import { Select, useHubVersion, useTicker } from '../ui/controls';
import { VENUE_COLORS } from '../ui/theme';
import { FilterSelect, ThemeSwatches } from '../ui/ThemeControls';
import { desktop, type CcxtExchangeInfo } from '../desktop/bridge';
import { useAmtLive } from '../desktop/amt';
import { sealTerminal } from './LockScreen';

/** Pyramid mark with three candles — Novus Ordo. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="lg-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.55)" />
          <stop offset="1" stopColor="rgba(255,255,255,0.08)" />
        </linearGradient>
      </defs>
      <path d="M16 3 L29 27 H3 Z" fill="url(#lg-glass)" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="10" y="17" width="3" height="7" rx="1" fill="var(--buy)" />
      <rect x="14.5" y="12" width="3" height="12" rx="1" fill="var(--accent)" />
      <rect x="19" y="15" width="3" height="9" rx="1" fill="var(--sell)" />
    </svg>
  );
}

export type ModalKind = 'connection' | 'layouts' | 'add' | 'settings' | 'keys' | null;

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
  const aggHasCcxt = useSettings((s) => s.aggregateVenues.includes('ccxt'));
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
      <Select value={venue} options={VENUE_IDS.map((v) => ({ value: v, label: v === 'ccxt' ? 'CCXT (any exchange)' : ADAPTERS[v].name }))} onChange={(v) => setPrimary(base, v)} title="Primary venue" width={130} />
      {(venue === 'ccxt' || aggHasCcxt) && <CcxtPicker />}
    </div>
  );
}

/** Exchange / market type for the CCXT venue (any of CCXT's 100+ exchanges). */
function CcxtPicker() {
  const s = useSettings();
  const [list, setList] = useState<CcxtExchangeInfo[]>([]);
  const [text, setText] = useState(s.ccxtExchange);
  useEffect(() => setText(s.ccxtExchange), [s.ccxtExchange]);
  useEffect(() => {
    desktop?.ccxt.exchanges().then(setList).catch(() => undefined);
  }, []);
  if (!desktop) return <span className="chip" title="CCXT runs in the desktop app">CCXT: desktop app</span>;
  const commit = () => {
    const id = text.trim().toLowerCase();
    if (list.some((x) => x.id === id)) s.set({ ccxtExchange: id });
    else setText(s.ccxtExchange);
  };
  return (
    <>
      <input
        className="ctl"
        list="ccxt-ex-top"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        style={{ width: 92 }}
        title={`CCXT exchange (${list.length} available)`}
      />
      <datalist id="ccxt-ex-top">
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
            {x.pro ? '' : ' (REST polling)'}
          </option>
        ))}
      </datalist>
      <Select
        value={s.ccxtType}
        options={[
          { value: 'spot', label: 'Spot' },
          { value: 'swap', label: 'Perp' },
        ]}
        onChange={(ccxtType) => s.set({ ccxtType })}
      />
      <Select value={s.ccxtQuote} options={['USDT', 'USDC', 'USD']} onChange={(ccxtQuote) => s.set({ ccxtQuote })} />
    </>
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

/** Running AMT bots with a one-click kill switch; hidden when none run. */
function AlgoKill() {
  const snaps = useAmtLive((s) => s.snaps);
  const list = Object.values(snaps);
  if (!desktop || !list.length) return null;
  const live = list.some((b) => b.mode === 'live');
  const pnl = list.reduce((a, b) => a + (b.stats?.pnl ?? 0) + (b.position?.upnl ?? 0), 0);
  return (
    <button
      className={`chip algo-kill ${live ? 'live' : ''}`}
      title={`${list.map((b) => `${b.mode.toUpperCase()} ${b.symbol}`).join(', ')} — click to stop every bot`}
      onClick={() => {
        if (confirm(`Stop all ${list.length} AMT bot(s) now? Open positions stay open (with their exchange stops).`)) void desktop!.amt.stopAll();
      }}
    >
      <span className="status-dot status-open" /> ALGO {list.length} · <span className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(2)}</span> ⏹
    </button>
  );
}

export function TopBar({ onOpen, onFocusChart, alertCount }: { onOpen: (m: ModalKind) => void; onFocusChart: () => void; alertCount: number }) {
  const locked = useSettings((s) => s.layoutLocked);
  const setS = useSettings((s) => s.set);
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
      <div className="brand" title="Novus Ordo — by Quincy Gininda">
        <Logo />
        <span className="brand-text">
          <span className="brand-name">NOVUS ORDO</span>
          <span className="brand-by hide-sm">by Quincy Gininda</span>
        </span>
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
      <AlgoKill />
      <button className="chip" onClick={() => onOpen('keys')} title="API key vault">
        🔑 Keys
      </button>
      <button className="chip" onClick={() => onOpen('add')} title="Add a panel">
        + Panel
      </button>
      <button className="chip" onClick={onFocusChart} title="Maximise the main chart (click again to restore)">
        ⤢ Chart
      </button>
      <button className={`chip ${locked ? 'locked' : ''}`} onClick={() => setS({ layoutLocked: !locked })} title={locked ? 'Layout locked — click to unlock' : 'Lock the layout (splits stay resizable)'}>
        {locked ? '🔒' : '🔓'}
      </button>
      <button className="chip" onClick={() => onOpen('layouts')} title="Layout gallery & saved layouts">
        ▦ Layouts
      </button>
      <ThemeSwatches />
      <FilterSelect />
      <button className="chip seal" onClick={() => void sealTerminal()} title="Seal the terminal — back to the ledger-key lock screen (bots keep running)">
        ⛨ Seal
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

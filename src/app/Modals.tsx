import { useEffect, useState, type ReactNode } from 'react';
import type { IJsonModel } from 'flexlayout-react';
import { byodInfo, type ByodInfo } from '../history/byod';
import { isDesktop } from '../desktop/bridge';
import { ADAPTERS } from '../exchanges';
import { hub } from '../market/hub';
import { PANELS, type Category } from '../panels/registry';
import { useSettings, type HistorySource } from '../store/settings';
import { NumberInput, useHubVersion } from '../ui/controls';
import { AppearanceSettings } from '../ui/ThemeControls';
import { deleteNamed, listSaved, PRESETS, saveNamed, type SavedLayout } from './layouts';

export function Modal({ title, onClose, children, footer, width }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-label={title}>
        <header>
          {title}
          <button className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
  );
}

const SOURCES: { id: HistorySource; name: string; text: string; desktopOnly?: boolean }[] = [
  { id: 'local', name: 'Local database', text: 'Trades recorded by this app in its SQLite database, with any recent gap filled from the exchange.', desktopOnly: true },
  { id: 'exchange', name: 'Exchange REST backfill', text: 'Pull recent aggregated trades from the venue’s public API on load (Binance spot/futures and the simulator). Other venues start live.' },
  { id: 'byod', name: 'Custom (BYOD)', text: 'Your own history server speaking the v1 protocol (/v1/info, /v1/trades, /v1/liquidations) — e.g. server/history-server.mjs in this repo.' },
  { id: 'none', name: 'Live only', text: 'No history. Footprint and DOM build from the moment the terminal opens.' },
];

export function ConnectionModal({ onClose }: { onClose: () => void }) {
  useHubVersion();
  const s = useSettings();
  const [url, setUrl] = useState(s.byodUrl);
  const [token, setToken] = useState(s.byodToken);
  const [source, setSource] = useState<HistorySource>(s.historySource);
  const [minutes, setMinutes] = useState(s.backfillMinutes);
  const [test, setTest] = useState<{ state: 'idle' | 'testing' | 'ok' | 'error'; msg?: string; info?: ByodInfo }>({ state: 'idle' });
  const H = hub();
  const bf = H.backfill;

  const runTest = async () => {
    setTest({ state: 'testing' });
    try {
      const info = await byodInfo(url, token);
      setTest({ state: 'ok', info, msg: `${info.server} · ${info.exchanges.map((e) => `${e.id}: ${e.symbols.map((x) => x.symbol).join(', ')}`).join(' · ')}` });
    } catch (e) {
      setTest({ state: 'error', msg: String((e as Error).message ?? e) });
    }
  };

  const apply = () => {
    if (source === 'byod' && test.state !== 'ok') {
      void runTest();
      return;
    }
    s.set({ historySource: source, byodUrl: url, byodToken: token, backfillMinutes: minutes });
    onClose();
  };

  return (
    <Modal
      title="Connection & history"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={() => void H.runBackfill()}>
            Reload history
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={apply}>
            {source === 'byod' && test.state !== 'ok' ? 'Test & apply' : 'Apply'}
          </button>
        </>
      }
    >
      <div className="section-title">Live data</div>
      <p className="muted" style={{ marginTop: 0, lineHeight: 1.5 }}>
        Your browser connects directly to each venue’s public WebSocket — no backend, no account, no data leaving your device. Primary:{' '}
        <b style={{ color: 'var(--text)' }}>
          {H.primary.adapter.name} {H.primary.inst.symbol}
        </b>
        .
      </p>
      <table className="grid" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>Venue</th>
            <th>Symbol</th>
            <th>Status</th>
            <th>Msg/s</th>
            <th>Latency</th>
            <th>Trades held</th>
          </tr>
        </thead>
        <tbody>
          {H.aggregate.map((f) => (
            <tr key={f.key}>
              <td>{f.adapter.name}</td>
              <td className="mono">{f.inst.symbol}</td>
              <td title={f.status.error}>
                <span className={`status-dot status-${f.status.state}`} /> {f.status.state}
                {f.status.error && f.status.state !== 'open' ? <span className="muted"> — {f.status.error}</span> : null}
              </td>
              <td>{f.rate.toFixed(0)}</td>
              <td>{f.status.latencyMs !== undefined ? f.status.latencyMs.toFixed(0) + 'ms' : '—'}</td>
              <td>{f.store.length.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="section-title">History source</div>
      <div className="radio-cards">
        {SOURCES.filter((x) => !x.desktopOnly || isDesktop).map((x) => (
          <div key={x.id} className={`radio-card ${source === x.id ? 'on' : ''}`} onClick={() => setSource(x.id)} role="radio" aria-checked={source === x.id}>
            <b>{x.name}</b>
            <span>{x.text}</span>
          </div>
        ))}
      </div>
      {source !== 'none' && (
        <div className="form-row">
          <span>Lookback</span>
          <NumberInput value={minutes} onChange={(m) => setMinutes(Math.max(1, Math.min(1440, Math.round(m))))} suffix="minutes" width={90} />
        </div>
      )}
      {source === 'byod' && (
        <>
          <div className="form-row">
            <span>Server URL</span>
            <input className="ctl mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8080" />
          </div>
          <div className="form-row">
            <span>Auth token (optional)</span>
            <input className="ctl mono" value={token} onChange={(e) => setToken(e.target.value)} type="password" placeholder="Bearer token" />
          </div>
          <div className="form-row">
            <span />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn ghost" onClick={() => void runTest()} disabled={test.state === 'testing'}>
                {test.state === 'testing' ? 'Testing…' : 'Test connection'}
              </button>
              {test.msg && <span className={test.state === 'ok' ? 'up' : 'down'}>{test.msg}</span>}
            </div>
          </div>
        </>
      )}
      <div className="muted" style={{ marginTop: 6 }}>
        Current: <b>{bf.state}</b> {bf.message}
      </div>
    </Modal>
  );
}

function Thumb({ thumb }: { thumb: (typeof PRESETS)[number]['thumb'] }) {
  return (
    <div className="mini" style={{ gridTemplateColumns: thumb.cols, gridTemplateRows: thumb.rows }}>
      {thumb.cells.map(([name, area]) => (
        <div key={name + area} style={{ gridArea: area }}>
          {name}
        </div>
      ))}
    </div>
  );
}

export function LayoutsModal({ onClose, onApply, current }: { onClose: () => void; onApply: (json: IJsonModel) => void; current: () => IJsonModel }) {
  const [saved, setSaved] = useState<SavedLayout[]>(listSaved());
  const [name, setName] = useState('');
  const [importText, setImportText] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal title="Layouts" onClose={onClose} width={860}>
      <div className="section-title">Gallery</div>
      <div className="gallery">
        {PRESETS.map((p) => (
          <div
            key={p.id}
            className="gallery-card"
            onClick={() => {
              onApply(p.build());
              onClose();
            }}
          >
            <Thumb thumb={p.thumb} />
            <b>{p.name}</b>
            <span>{p.description}</span>
          </div>
        ))}
      </div>
      <div className="section-title">Saved layouts</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input className="ctl" placeholder="Name this layout…" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, height: 28 }} />
        <button
          className="btn"
          disabled={!name.trim()}
          onClick={() => {
            saveNamed(name.trim(), current());
            setSaved(listSaved());
            setName('');
          }}
        >
          Save current
        </button>
      </div>
      {saved.length === 0 ? (
        <div className="muted">No saved layouts yet. Layouts, panel settings and journal persist in this browser.</div>
      ) : (
        saved.map((l) => (
          <div key={l.name} className="list-row" style={{ alignItems: 'center' }}>
            <b style={{ flex: 1 }}>{l.name}</b>
            <span className="muted">{new Date(l.time).toLocaleString()}</span>
            <button
              className="chip"
              onClick={() => {
                onApply(l.json);
                onClose();
              }}
            >
              Load
            </button>
            <button
              className="chip"
              onClick={() => {
                deleteNamed(l.name);
                setSaved(listSaved());
              }}
            >
              Delete
            </button>
          </div>
        ))
      )}
      <div className="section-title">Import / export</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button className="btn ghost" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(current()))}>
          Copy current layout JSON
        </button>
        <button
          className="btn ghost"
          disabled={!importText.trim()}
          onClick={() => {
            try {
              const json = JSON.parse(importText);
              if (!json.layout) throw new Error('missing "layout"');
              onApply(json);
              onClose();
            } catch (e) {
              setErr(String((e as Error).message));
            }
          }}
        >
          Import JSON
        </button>
        {err && <span className="down">{err}</span>}
      </div>
      <textarea className="ctl mono" rows={3} placeholder="Paste layout JSON to import" value={importText} onChange={(e) => setImportText(e.target.value)} />
    </Modal>
  );
}

const CATS: Category[] = ['Charts', 'Orderflow', 'Order book', 'Derivatives', 'Market', 'Account', 'Tools'];

export type Placement = 'active' | 'left' | 'right' | 'bottom' | 'dock-left' | 'dock-right' | 'dock-bottom';

const PLACEMENTS: { id: Placement; label: string }[] = [
  { id: 'active', label: 'Active area (as a tab)' },
  { id: 'left', label: 'New column — left' },
  { id: 'right', label: 'New column — right' },
  { id: 'bottom', label: 'New row — bottom' },
  { id: 'dock-left', label: 'Left dock (collapsible)' },
  { id: 'dock-right', label: 'Right dock (collapsible)' },
  { id: 'dock-bottom', label: 'Bottom dock (collapsible)' },
];

export function AddPanelModal({ onClose, onAdd }: { onClose: () => void; onAdd: (id: string, where: Placement) => void }) {
  const [where, setWhere] = useState<Placement>('active');
  return (
    <Modal title="Add panel" onClose={onClose} width={820}>
      <div className="section-title">Place in</div>
      <div className="chip-row">
        {PLACEMENTS.map((p) => (
          <button key={p.id} className={`chip ${where === p.id ? 'active' : ''}`} onClick={() => setWhere(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="muted" style={{ marginBottom: 4 }}>
        You can also drag any tab by its title onto any side of any panel or the window edge; drag the gaps between panels to resize.
      </div>
      {CATS.map((cat) => (
        <div key={cat}>
          <div className="section-title">{cat}</div>
          <div className="panel-list">
            {PANELS.filter((p) => p.category === cat).map((p) => (
              <div
                key={p.id}
                className="panel-item"
                onClick={() => {
                  onAdd(p.id, where);
                  onClose();
                }}
              >
                <b>
                  {p.title} {p.aggregated && <span className="tag">Σ</span>}
                </b>
                <span>{p.description}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Modal>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  return (
    <Modal title="Settings" onClose={onClose} width={820}>
      <AppearanceSettings />
      <div className="section-title">Display</div>
      <div className="form-row">
        <span>FPS counter</span>
        <label className="check">
          <input type="checkbox" checked={s.showFps} onChange={(e) => s.set({ showFps: e.target.checked })} /> show in top bar
        </label>
      </div>
      <div className="section-title">Sound & alerts</div>
      <div className="form-row">
        <span>Sounds</span>
        <label className="check">
          <input type="checkbox" checked={s.soundEnabled} onChange={(e) => s.set({ soundEnabled: e.target.checked })} /> enable alert and tape sounds
        </label>
      </div>
      <div className="form-row">
        <span>Browser notifications</span>
        <div>
          <button className="btn ghost" onClick={() => typeof Notification !== 'undefined' && void Notification.requestPermission()}>
            {typeof Notification === 'undefined' ? 'Not supported' : `Permission: ${Notification.permission}`}
          </button>
        </div>
      </div>
      <div className="section-title">Trade size tiers (tape, bubbles)</div>
      <div className="form-row">
        <span>Mid tier from</span>
        <NumberInput value={s.tierMid} onChange={(tierMid) => s.set({ tierMid })} suffix="$" width={110} />
      </div>
      <div className="form-row">
        <span>Whale tier from</span>
        <NumberInput value={s.tierWhale} onChange={(tierWhale) => s.set({ tierWhale })} suffix="$" width={110} />
      </div>
      <div className="section-title">Venues</div>
      <div className="muted" style={{ lineHeight: 1.6 }}>
        {Object.values(ADAPTERS)
          .map((a) => `${a.name}${a.hasLiquidations ? ' (liquidations)' : ''}`)
          .join(' · ')}
      </div>
      <div className="section-title">Data</div>
      <button
        className="btn danger"
        onClick={() => {
          if (!confirm('Reset all settings, layouts, alerts and journal stored in this browser?')) return;
          try {
            for (const k of ['oft-settings', 'oft-layout', 'oft-saved-layouts']) localStorage.removeItem(k);
          } catch {
            /* ignore */
          }
          location.reload();
        }}
      >
        Reset everything
      </button>
    </Modal>
  );
}

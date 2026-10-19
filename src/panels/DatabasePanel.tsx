import { useEffect, useState } from 'react';
import { fmtDateTime, fmtNum } from '../core/format';
import { desktop, DesktopOnlyError, type DbInfo } from '../desktop/bridge';
import { ADAPTERS } from '../exchanges';
import type { VenueId } from '../core/types';
import { useSettings } from '../store/settings';
import { Empty, NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export type DatabaseConfig = Record<string, never>;
export const DATABASE_DEFAULTS: DatabaseConfig = {};

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${(n / 1e3).toFixed(0)} KB`);

export function DatabasePanel(_: PanelProps<DatabaseConfig>) {
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [stats, setStats] = useState<{ venue: string; symbol: string; n: number; first: number; last: number }[]>([]);
  const [msg, setMsg] = useState('');
  const recordTrades = useSettings((s) => s.recordTrades);
  const recordScope = useSettings((s) => s.recordScope);
  const set = useSettings((s) => s.set);

  const reload = () => {
    if (!desktop) return;
    desktop.db.info().then(setInfo).catch((e) => setMsg(String(e.message ?? e)));
    desktop.db.stats().then(setStats).catch(() => undefined);
  };
  useEffect(() => {
    reload();
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, []);

  if (!desktop)
    return (
      <div className="panel">
        <Empty>{new DesktopOnlyError('The local SQLite database').message}</Empty>
      </div>
    );

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setMsg(`${label}…`);
    try {
      const r = await fn();
      setMsg(`${label}: ${typeof r === 'number' ? `${r.toLocaleString()} rows` : 'done'}`);
      reload();
    } catch (e) {
      setMsg(String((e as Error).message ?? e));
    }
  };

  return (
    <div className="panel">
      <Toolbar>
        <label className="check">
          <input type="checkbox" checked={recordTrades} onChange={(e) => set({ recordTrades: e.target.checked })} /> Record trades
        </label>
        <Select
          value={recordScope}
          options={[
            { value: 'primary', label: 'Primary only' },
            { value: 'aggregate', label: 'All Σ venues' },
          ]}
          onChange={(recordScope) => set({ recordScope })}
        />
        <span className="muted">keep</span>
        <NumberInput value={info?.retentionDays ?? 3} onChange={(d) => void run('Retention saved', () => desktop!.db.setRetention(d))} width={48} suffix="days" />
        <Spacer />
        <button className="chip" onClick={() => void run('Pruned', () => desktop!.db.prune())}>
          Prune
        </button>
        <button className="chip" onClick={() => void run('Compacted', () => desktop!.db.vacuum())}>
          Compact
        </button>
      </Toolbar>
      <div className="scroll">
        {info && (
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <div className="stat">
              <div className="k">Size</div>
              <div className="v">{fmtBytes(info.size)}</div>
              <div className="s" title={info.file} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {info.file}
              </div>
            </div>
            <div className="stat">
              <div className="k">Trades</div>
              <div className="v">{fmtNum(info.trades, 2)}</div>
              <div className="s">{stats.length} instruments</div>
            </div>
            <div className="stat">
              <div className="k">API keys</div>
              <div className="v">{info.secrets}</div>
              <div className="s">encrypted</div>
            </div>
            <div className="stat">
              <div className="k">Wallets</div>
              <div className="v">{info.wallets}</div>
              <div className="s">public addresses</div>
            </div>
          </div>
        )}
        {msg && <div className="muted" style={{ padding: '4px 10px' }}>{msg}</div>}
        {stats.length === 0 ? (
          <Empty>Nothing recorded yet. With recording on, live trades are written here and used as the “Local database” history source on the next launch.</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Trades</th>
                <th>From</th>
                <th>To</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.venue + s.symbol}>
                  <td className="l">
                    <span className="venue-tag">{ADAPTERS[s.venue as VenueId]?.short ?? s.venue}</span> {s.symbol}
                  </td>
                  <td>{s.n.toLocaleString()}</td>
                  <td className="muted">{fmtDateTime(s.first)}</td>
                  <td className="muted">{fmtDateTime(s.last)}</td>
                  <td>
                    <button className="chip" onClick={() => void run('Exported', async () => (await desktop!.db.exportCsv(s.venue, s.symbol))?.rows ?? 0)}>
                      CSV
                    </button>{' '}
                    <button
                      className="chip"
                      onClick={() => {
                        if (confirm(`Delete all recorded trades for ${s.symbol}?`)) void run('Deleted', () => desktop!.db.deleteInstrument(s.venue, s.symbol));
                      }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

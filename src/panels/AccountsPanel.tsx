import { useEffect, useState } from 'react';
import { fmtNum, fmtPrice, fmtTime, fmtUsd } from '../core/format';
import { desktop, DesktopOnlyError, type AccountSnapshot, type SecretRecord } from '../desktop/bridge';
import { vault } from '../desktop/vault';
import { hub } from '../market/hub';
import { Chip, Empty, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export interface AccountsConfig {
  secretId: string;
  tab: 'balances' | 'positions' | 'orders' | 'fills';
  refreshSec: number;
}

export const ACCOUNTS_DEFAULTS: AccountsConfig = { secretId: '', tab: 'balances', refreshSec: 20 };

/** Unified CCXT symbol for the primary instrument, when it maps cleanly. */
function primaryUnified(): string | undefined {
  const f = hub().primary;
  if (f.inst.venue === 'ccxt') return f.inst.symbol.split('::')[1];
  const quote = /USDT$/.test(f.inst.symbol) || f.inst.symbol.includes('-USDT') ? 'USDT' : 'USD';
  return `${f.inst.base}/${quote}`;
}

export function AccountsPanel({ config: c, setConfig }: PanelProps<AccountsConfig>) {
  const [keys, setKeys] = useState<SecretRecord[]>([]);
  const [data, setData] = useState<AccountSnapshot | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    vault
      .list()
      .then((all) => {
        const ex = all.filter((k) => k.kind === 'exchange');
        setKeys(ex);
        if (!c.secretId && ex[0]) setConfig({ secretId: ex[0].id });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!c.secretId) return;
    if (!desktop) {
      setErr(new DesktopOnlyError('Exchange accounts').message);
      return;
    }
    let alive = true;
    const load = () => {
      setLoading(true);
      desktop!.ccxt
        .account(c.secretId, primaryUnified())
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr('');
        })
        .catch((e) => alive && setErr(String(e?.message ?? e)))
        .finally(() => alive && setLoading(false));
    };
    load();
    const t = setInterval(load, Math.max(5, c.refreshSec) * 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [c.secretId, c.refreshSec]);

  const tabErr = data?.errors[{ balances: 'balances', positions: 'positions', orders: 'openOrders', fills: 'myTrades' }[c.tab]];

  return (
    <div className="panel">
      <Toolbar>
        <Select
          value={c.secretId}
          options={[{ value: '', label: keys.length ? 'Choose key…' : 'No exchange keys' }, ...keys.map((k) => ({ value: k.id, label: `${k.label} · ${k.exchange}` }))]}
          onChange={(secretId) => setConfig({ secretId })}
          width={170}
        />
        {(['balances', 'positions', 'orders', 'fills'] as const).map((t) => (
          <Chip key={t} active={c.tab === t} onClick={() => setConfig({ tab: t })}>
            {t[0].toUpperCase() + t.slice(1)}
          </Chip>
        ))}
        <Spacer />
        <span className="muted">{loading ? 'refreshing…' : data ? data.exchange : ''}</span>
      </Toolbar>
      <div className="scroll">
        {!keys.length ? (
          <Empty>Add an exchange API key in 🔑 Keys (top bar) to see balances, positions and orders through CCXT.</Empty>
        ) : err ? (
          <Empty>{err}</Empty>
        ) : !data ? (
          <Empty>Loading account…</Empty>
        ) : tabErr ? (
          <Empty>{tabErr}</Empty>
        ) : c.tab === 'balances' ? (
          <table className="grid">
            <thead>
              <tr>
                <th>Asset</th>
                <th>Total</th>
                <th>Free</th>
                <th>In use</th>
              </tr>
            </thead>
            <tbody>
              {data.balances.map((b) => (
                <tr key={b.currency}>
                  <td>
                    <b>{b.currency}</b>
                  </td>
                  <td>{fmtNum(b.total, 4)}</td>
                  <td className="muted">{b.free === null ? '—' : fmtNum(b.free, 4)}</td>
                  <td className="muted">{b.used === null ? '—' : fmtNum(b.used, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : c.tab === 'positions' ? (
          data.positions.length ? (
            <table className="grid">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Size</th>
                  <th>Notional</th>
                  <th>Entry</th>
                  <th>Mark</th>
                  <th>uPnL</th>
                  <th>Liq.</th>
                </tr>
              </thead>
              <tbody>
                {data.positions.map((p) => (
                  <tr key={p.symbol + p.side}>
                    <td>{p.symbol}</td>
                    <td className={p.side === 'long' ? 'up' : 'down'}>{p.side?.toUpperCase()}</td>
                    <td>{fmtNum(p.contracts, 4)}</td>
                    <td>{fmtUsd(p.notional)}</td>
                    <td>{fmtPrice(p.entryPrice)}</td>
                    <td>{fmtPrice(p.markPrice)}</td>
                    <td className={(p.unrealizedPnl ?? 0) >= 0 ? 'up' : 'down'}>{fmtUsd(p.unrealizedPnl)}</td>
                    <td className="muted">{fmtPrice(p.liquidationPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No open positions.</Empty>
          )
        ) : c.tab === 'orders' ? (
          data.openOrders.length ? (
            <table className="grid">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th>Price</th>
                  <th>Amount</th>
                  <th>Filled</th>
                </tr>
              </thead>
              <tbody>
                {data.openOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="muted">{o.time ? fmtTime(o.time) : '—'}</td>
                    <td>{o.symbol}</td>
                    <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side?.toUpperCase()}</td>
                    <td className="muted">{o.type}</td>
                    <td>{fmtPrice(o.price)}</td>
                    <td>{fmtNum(o.amount, 4)}</td>
                    <td>{fmtNum(o.filled, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No open orders.</Empty>
          )
        ) : data.myTrades.length ? (
          <table className="grid">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Price</th>
                <th>Amount</th>
                <th>Cost</th>
                <th>Fee</th>
              </tr>
            </thead>
            <tbody>
              {data.myTrades.map((t) => (
                <tr key={t.id}>
                  <td className="muted">{fmtTime(t.time)}</td>
                  <td>{t.symbol}</td>
                  <td className={t.side === 'buy' ? 'up' : 'down'}>{t.side?.toUpperCase()}</td>
                  <td>{fmtPrice(t.price)}</td>
                  <td>{fmtNum(t.amount, 4)}</td>
                  <td>{fmtNum(t.cost, 2)}</td>
                  <td className="muted">{t.fee === null ? '—' : `${fmtNum(t.fee, 4)} ${t.feeCurrency ?? ''}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No recent fills for {primaryUnified()}.</Empty>
        )}
      </div>
    </div>
  );
}

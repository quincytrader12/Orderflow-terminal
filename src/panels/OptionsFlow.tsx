import { useEffect } from 'react';
import { create } from 'zustand';
import { fmtTime, fmtUsd } from '../core/format';
import type { ConnState, OptionTrade } from '../core/types';
import { connectOptionsFlow, fetchRecentOptionTrades, OPTION_UNDERLYINGS } from '../exchanges/deribit';
import { Chip, Empty, NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';

export interface OptionsConfig {
  underlying: string;
  minPremium: number;
  blockOnly: boolean;
}

export const OPTIONS_DEFAULTS: OptionsConfig = { underlying: 'BTC', minPremium: 5_000, blockOnly: false };

interface Stream {
  trades: OptionTrade[];
  status: ConnState;
  error?: string;
}

const useOptions = create<Record<string, Stream>>(() => ({}));
const conns = new Map<string, { refs: number; close(): void }>();

function retain(u: string) {
  const c = conns.get(u);
  if (c) {
    c.refs++;
    return;
  }
  const put = (p: Partial<Stream>) => useOptions.setState((s) => ({ [u]: { ...(s[u] ?? { trades: [], status: 'idle' }), ...p } }));
  put({ status: 'connecting' });
  fetchRecentOptionTrades(u)
    .then((ts) => useOptions.setState((s) => ({ [u]: { ...(s[u] ?? { status: 'idle' }), trades: merge(s[u]?.trades ?? [], ts) } })))
    .catch(() => undefined);
  const conn = connectOptionsFlow(
    u,
    (ts) => useOptions.setState((s) => ({ [u]: { ...(s[u] ?? { status: 'open' }), trades: merge(s[u]?.trades ?? [], ts) } })),
    (status, error) => put({ status, error }),
  );
  conns.set(u, { refs: 1, close: conn.close });
}

function release(u: string) {
  const c = conns.get(u);
  if (!c) return;
  if (--c.refs <= 0) {
    c.close();
    conns.delete(u);
  }
}

function merge(a: OptionTrade[], b: OptionTrade[]) {
  const seen = new Set(a.map((t) => t.id));
  const out = [...a, ...b.filter((t) => !seen.has(t.id))].sort((x, y) => x.time - y.time);
  return out.slice(-3000);
}

const fmtExpiry = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(/ /g, '');

export function OptionsFlow({ config: c, setConfig }: PanelProps<OptionsConfig>) {
  const stream = useOptions((s) => s[c.underlying]);
  useEffect(() => {
    retain(c.underlying);
    return () => release(c.underlying);
  }, [c.underlying]);
  const trades = (stream?.trades ?? []).filter((t) => t.premiumUsd >= c.minPremium && (!c.blockOnly || t.block));

  let callBuy = 0;
  let callSell = 0;
  let putBuy = 0;
  let putSell = 0;
  const byStrike = new Map<string, number>();
  for (const t of trades) {
    if (t.kind === 'C') t.side === 'buy' ? (callBuy += t.premiumUsd) : (callSell += t.premiumUsd);
    else t.side === 'buy' ? (putBuy += t.premiumUsd) : (putSell += t.premiumUsd);
    const k = `${t.strike}${t.kind}`;
    byStrike.set(k, (byStrike.get(k) ?? 0) + t.premiumUsd);
  }
  const calls = callBuy + callSell;
  const puts = putBuy + putSell;
  const top = [...byStrike].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <div className="panel">
      <Toolbar>
        <Select value={c.underlying} options={OPTION_UNDERLYINGS} onChange={(underlying) => setConfig({ underlying })} />
        <NumberInput value={c.minPremium} onChange={(minPremium) => setConfig({ minPremium: Math.max(0, minPremium) })} width={80} suffix="$ prem" />
        <Chip active={c.blockOnly} onClick={() => setConfig({ blockOnly: !c.blockOnly })}>
          Blocks only
        </Chip>
        <Spacer />
        <span className={`status-dot status-${stream?.status ?? 'idle'}`} title={stream?.error ?? stream?.status} />
        <span className="muted">Deribit</span>
      </Toolbar>
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat">
          <div className="k">Call premium</div>
          <div className="v up">{fmtUsd(calls)}</div>
          <div className="s">buy {fmtUsd(callBuy)} · sell {fmtUsd(callSell)}</div>
        </div>
        <div className="stat">
          <div className="k">Put premium</div>
          <div className="v down">{fmtUsd(puts)}</div>
          <div className="s">buy {fmtUsd(putBuy)} · sell {fmtUsd(putSell)}</div>
        </div>
        <div className="stat">
          <div className="k">Put / call</div>
          <div className="v">{calls ? (puts / calls).toFixed(2) : '—'}</div>
          <div className="bar-split">
            <div style={{ width: `${calls + puts ? (calls / (calls + puts)) * 100 : 50}%` }} />
            <div style={{ flex: 1 }} />
          </div>
        </div>
        <div className="stat">
          <div className="k">Top strikes</div>
          <div className="s" style={{ lineHeight: 1.5 }}>
            {top.map(([k, v]) => (
              <span key={k} className="tag" style={{ color: k.endsWith('C') ? 'var(--buy)' : 'var(--sell)' }}>
                {k} {fmtUsd(v, 1)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="scroll">
        {trades.length === 0 ? (
          <Empty>{stream?.status === 'error' ? `Deribit unavailable: ${stream.error}` : 'Waiting for option prints…'}</Empty>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Time</th>
                <th>Expiry</th>
                <th>Strike</th>
                <th>Type</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>IV</th>
                <th>Premium</th>
              </tr>
            </thead>
            <tbody>
              {trades
                .slice(-250)
                .reverse()
                .map((t) => (
                  <tr key={t.id} style={{ fontWeight: t.premiumUsd >= 100_000 ? 700 : 400 }}>
                    <td className="muted">{fmtTime(t.time)}</td>
                    <td>{fmtExpiry(t.expiry)}</td>
                    <td>{t.strike.toLocaleString()}</td>
                    <td className={t.kind === 'C' ? 'up' : 'down'}>{t.kind === 'C' ? 'CALL' : 'PUT'}</td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>
                      {t.side.toUpperCase()}
                      {t.block && <span className="tag" style={{ marginLeft: 4 }}>BLOCK</span>}
                      {t.liquidation && <span className="tag" style={{ marginLeft: 4 }}>LIQ</span>}
                    </td>
                    <td>{t.amount}</td>
                    <td className="muted">{t.price.toFixed(4)}</td>
                    <td className="muted">{t.iv !== undefined ? t.iv.toFixed(1) + '%' : '—'}</td>
                    <td className={t.side === 'buy' ? 'up' : 'down'}>{fmtUsd(t.premiumUsd)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

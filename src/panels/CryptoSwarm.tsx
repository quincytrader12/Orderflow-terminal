// The crypto swarm's screen: its own account on Hyperliquid, its agents and
// their council, open trades with their decisions, results, and its rules.
import { useEffect, useMemo, useState } from 'react';
import { openConnections } from '../app/connect';
import type { CSwarmLine, CSwarmPosition, CSwarmState, SecretRecord } from '../desktop/bridge';
import { desktop } from '../desktop/bridge';
import { vault } from '../desktop/vault';
import { refreshCSwarm, useCSwarm } from '../cswarm/store';
import { px, sideWord, usd } from '../cswarm/notify';
import { Chip, Empty, NumberInput, Select, useTicker, type PanelProps } from '../ui/controls';

export interface CryptoSwarmConfig {
  tab: 'live' | 'rules';
}
export const CRYPTO_SWARM_DEFAULTS: CryptoSwarmConfig = { tab: 'live' };

const AGENTS: { id: string; name: string; role: string }[] = [
  { id: 'auction', name: 'Auctioneer', role: 'intraday value area, IB breakouts, the 80% rule' },
  { id: 'trend', name: 'Trend', role: 'daily momentum, hourly breakouts' },
  { id: 'tape', name: 'Tape', role: 'aggressive flow and the book' },
  { id: 'crowd', name: 'Crowd', role: 'funding: who is crowded' },
  { id: 'guardian', name: 'Guardian', role: 'spread and volatility vetoes' },
  { id: 'forest', name: 'Forest', role: 'odds learned from every trade' },
  { id: 'risk', name: 'Risk', role: 'compounding size, limits, floor' },
];
const NAME: Record<string, string> = Object.fromEntries(AGENTS.map((a) => [a.id, a.name]).concat([['swarm', 'Swarm'], ['council', 'Council']]));
const clean = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const signed = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
};

export function CryptoSwarm({ config, setConfig }: PanelProps<CryptoSwarmConfig>) {
  useTicker(1000);
  const { state: st, lines, error } = useCSwarm();
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [keys, setKeys] = useState<SecretRecord[]>([]);
  useEffect(() => {
    void refreshCSwarm();
    vault
      .list()
      .then((l) => setKeys(l.filter((k) => k.kind === 'exchange' && k.exchange === 'hyperliquid')))
      .catch(() => undefined);
  }, []);
  if (!desktop) return <Empty>The crypto swarm runs in the desktop app: it trades from the desktop process with your Hyperliquid key.</Empty>;
  if (!st) return <Empty>{error ? `Starting… (${error})` : 'Starting the crypto swarm…'}</Empty>;
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setErr('');
    try {
      await f();
    } catch (e) {
      setErr(clean(e));
    } finally {
      setBusy('');
      void refreshCSwarm();
    }
  };
  return (
    <div className="cs">
      <Header st={st} keys={keys} busy={busy} run={run} />
      {err && <div className="down cs-err">{err}</div>}
      <div className="cs-tabs">
        <Chip active={config.tab === 'live'} onClick={() => setConfig({ tab: 'live' })}>
          Swarm
        </Chip>
        <Chip active={config.tab === 'rules'} onClick={() => setConfig({ tab: 'rules' })}>
          Rules
        </Chip>
      </div>
      {config.tab === 'live' ? <Live st={st} lines={lines} /> : <Rules st={st} busy={busy} run={run} />}
    </div>
  );
}

function Header({ st, keys, busy, run }: { st: CSwarmState; keys: SecretRecord[]; busy: string; run: (w: string, f: () => Promise<unknown>) => void }) {
  const [pick, setPick] = useState(st.secretId ?? keys[0]?.id ?? '');
  useEffect(() => setPick((p) => p || st.secretId || keys[0]?.id || ''), [keys, st.secretId]);
  const eq = st.equity;
  const b = st.book;
  const today = eq !== null && b.dayStart > 0 ? eq - b.dayStart : null;
  const total = eq !== null && b.start > 0 ? eq - b.start : null;
  const dd = eq !== null && b.peak > 0 ? (b.peak - eq) / b.peak : 0;
  const winRate = st.totals.trades ? st.totals.wins / st.totals.trades : null;
  const key = keys.find((k) => k.id === st.secretId);
  return (
    <>
      <div className="cs-head">
        <div className="cs-modes">
          <Chip active={st.mode === 'paper'} onClick={() => !st.running && run('mode', () => desktop!.cswarm.mode('paper'))}>
            Paper
          </Chip>
          <Chip active={st.mode === 'live'} onClick={() => !st.running && (keys.length ? run('mode', () => desktop!.cswarm.mode('live', pick || keys[0].id)) : openConnections())}>
            Live
          </Chip>
          {st.mode === 'live' && keys.length > 0 && (
            <Select value={st.secretId ?? pick} options={keys.map((k) => ({ value: k.id, label: `${k.label}${k.meta.fields.sandbox === 'true' ? ' · testnet' : ''}${k.meta.fields.trading === 'enabled' ? '' : ' (read-only)'}` }))} onChange={(id) => (setPick(id), !st.running && run('mode', () => desktop!.cswarm.mode('live', id)))} width={170} />
          )}
          {!keys.length && (
            <button className="chip" onClick={openConnections} title="Connect your Hyperliquid account (an API wallet key — it can trade, never withdraw)">
              Connect Hyperliquid
            </button>
          )}
        </div>
        <span style={{ flex: 1 }} />
        {st.running ? (
          <>
            <span className="cs-live-dot" /> <span className="muted">{st.mode === 'live' ? `LIVE${st.sandbox ? ' (testnet)' : ''}${key ? ` · ${key.label}` : ''}` : 'paper'} · running</span>
            <button className="chip" disabled={!!busy} onClick={() => run('stop', () => desktop!.cswarm.stop(false))} title="Stop proposing and managing; open positions stay (live: with their exchange stop)">
              Stop
            </button>
            <button className="chip" disabled={!!busy || !st.open.length} onClick={() => confirm('Stop the crypto swarm and close every open position at market?') && run('stop', () => desktop!.cswarm.stop(true))}>
              Stop & close all
            </button>
          </>
        ) : (
          <button className="chip cs-start" disabled={!!busy} onClick={() => run('start', () => desktop!.cswarm.start())}>
            {busy === 'start' ? 'Starting…' : `▶ Start crypto swarm (${st.mode})`}
          </button>
        )}
      </div>
      <div className="cs-tiles">
        <Tile label={st.mode === 'live' ? 'Hyperliquid account' : 'Paper account'} value={eq === null ? '—' : usd(eq)} sub={`started ${usd(b.start || 0)}`} />
        <Tile label="Today" value={today === null ? '—' : signed(today)} tone={today === null ? '' : today >= 0 ? 'up' : 'down'} sub={b.dayStart ? `${((today ?? 0) / b.dayStart * 100).toFixed(1)}%` : ''} />
        <Tile label="All time" value={total === null ? '—' : signed(total)} tone={total === null ? '' : total >= 0 ? 'up' : 'down'} sub={`${st.totals.trades} trades${winRate !== null ? ` · ${Math.round(winRate * 100)}% won` : ''}`} />
        <Tile label="Floor" value={b.floor ? usd(b.floor) : '—'} sub={dd > 0.001 ? `${(dd * 100).toFixed(1)}% under the high` : 'at its high'} />
        <Tile label="Forest" value={st.forest.trained ? `${st.forest.trained.n} trades` : `${st.forest.samples}/30`} sub={st.forest.trained?.accuracy != null ? `${Math.round(st.forest.trained.accuracy * 100)}% right (vs ${Math.round((st.forest.trained.baseline ?? 0) * 100)}%)` : 'learning — the prior decides'} />
      </div>
    </>
  );
}

function Tile({ label, value, sub, tone = '' }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="cs-tile">
      <div className="muted">{label}</div>
      <div className={`mono cs-tile-v ${tone}`}>{value}</div>
      {sub && <div className="muted cs-tile-s">{sub}</div>}
    </div>
  );
}

function agentStatus(st: CSwarmState, id: string): string {
  const c = st.coins;
  if (!st.running) return 'off';
  if (id === 'auction') {
    if (!st.cfg.agents[id]) return 'off';
    const warm = c.filter((x) => x.engines[id]?.warm).length;
    return warm === c.length ? 'reading the tape' : `warming up (${warm}/${c.length})`;
  }
  if (id === 'trend') return st.cfg.agents.trend ? c.map((x) => `${x.coin} ${x.daily ? (x.daily.dir > 0 ? `↑${x.daily.up}/3` : `↓${3 - x.daily.up}/3`) : '…'}`).join(' ') : 'off';
  if (id === 'crowd') return c.map((x) => `${x.coin} ${x.funding !== null ? `${(x.funding * 24 * 365 * 100).toFixed(0)}%` : '…'}`).join(' ');
  if (id === 'forest') return st.forest.trained ? `learned ${st.forest.trained.n}` : 'prior';
  if (id === 'risk') return st.book.pausedUntil > Date.now() ? 'pausing' : `${st.open.length}/${st.cfg.risk.maxOpen} open`;
  if (id === 'guardian') return c.some((x) => x.feed === 'error') ? 'feed problem' : 'watching';
  return 'listening';
}

function Live({ st, lines }: { st: CSwarmState; lines: CSwarmLine[] }) {
  const feed = useMemo(() => [...lines].reverse().slice(0, 120), [lines]);
  return (
    <div className="cs-body">
      <div className="cs-agents">
        {AGENTS.map((a) => {
          const s = agentStatus(st, a.id);
          const stat = st.byAgent[a.id as 'auction'];
          return (
            <div key={a.id} className={`cs-agent${s === 'off' ? ' off' : ''}`} title={a.role}>
              <b>{a.name}</b>
              <span className="muted">{s}</span>
              {stat && stat.trades > 0 && <span className={`mono ${stat.pnl >= 0 ? 'up' : 'down'}`}>{signed(stat.pnl)} · {stat.trades}</span>}
            </div>
          );
        })}
      </div>
      {st.running && (
        <div className="cs-scroll">
        <table className="grid cs-table">
          <thead>
            <tr>
              <th>Coin</th>
              <th>Price</th>
              <th>Daily trend</th>
              <th>Funding / yr</th>
              <th>Auctioneer</th>
            </tr>
          </thead>
          <tbody>
            {st.coins.map((c) => (
              <tr key={c.coin} title={c.feedError ?? ''}>
                <td>
                  <span className={c.feed === 'open' ? 'up' : c.feed === 'error' ? 'down' : 'muted'}>●</span> {c.coin}
                </td>
                <td className="mono">{px(c.price)}</td>
                <td className={c.daily ? (c.daily.dir > 0 ? 'up' : 'down') : 'muted'}>{c.daily ? (c.daily.dir > 0 ? `up ${c.daily.up}/3` : `down ${3 - c.daily.up}/3`) : '…'}</td>
                <td className="mono">{c.funding !== null ? `${(c.funding * 24 * 365 * 100).toFixed(1)}%` : '—'}</td>
                {(['auction'] as const).map((a) => (
                  <td key={a} className="muted" title={c.engines[a]?.lastSkip ? `${c.engines[a].lastSkip!.event}: ${c.engines[a].lastSkip!.reason}` : ''}>
                    {c.engines[a] ? c.engines[a].state : 'off'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="section-title">Open trades</div>
      {st.open.length ? <Positions rows={st.open} open /> : <div className="muted cs-none">None — the council has not taken a trade{st.running ? ' yet' : ''}.</div>}
      <div className="section-title">The council</div>
      <div className="cs-feed">
        {feed.length ? (
          feed.map((l, i) => (
            <div key={i} className={`cs-line ${l.kind}`}>
              <span className="mono muted">{ago(l.t)}</span>
              <b className={`cs-who ${l.agent}`}>{NAME[l.agent] ?? l.agent}</b>
              <span>{l.text}</span>
            </div>
          ))
        ) : (
          <div className="muted">Quiet. Start the swarm: the agents read each coin's tape (the order-flow ones need 20–60 minutes to learn the session's value), and every proposal is discussed here.</div>
        )}
      </div>
      <div className="section-title">Results</div>
      {st.closed.length ? <Positions rows={st.closed} /> : <div className="muted cs-none">No closed trades yet.</div>}
    </div>
  );
}

function Positions({ rows, open = false }: { rows: CSwarmPosition[]; open?: boolean }) {
  return (
    <table className="grid cs-table">
      <thead>
        <tr>
          <th>Coin</th>
          <th>Side</th>
          <th>Agent</th>
          <th>Entry</th>
          <th>{open ? 'Stop / target' : 'Exit'}</th>
          <th>{open ? 'Open P&L' : 'P&L'}</th>
          <th>{open ? 'Decisions' : 'Why out'}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const pnl = open ? p.upnl ?? 0 : p.pnl ?? 0;
          const r = open ? ((p.price ?? p.entry) - p.entry) * (p.side === 'buy' ? 1 : -1) / Math.max(1e-12, Math.abs(p.entry - p.stop0)) : p.r ?? 0;
          return (
            <tr key={p.id} title={`${p.setup} — ${p.why}\n${p.summary}\n${p.mgmt.map((m) => `• ${m.text}`).join('\n')}`}>
              <td>{p.coin}</td>
              <td className={p.side === 'buy' ? 'up' : 'down'}>{sideWord(p)}</td>
              <td>{NAME[p.agent]}</td>
              <td className="mono">{px(p.entry)}</td>
              <td className="mono">{open ? `${px(p.stop)} / ${px(p.target)}` : px(p.exit)}</td>
              <td className={`mono ${pnl >= 0 ? 'up' : 'down'}`}>
                {signed(pnl)} <span className="muted">{`${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}</span>
              </td>
              <td className="muted">{open ? (p.mgmt.length ? p.mgmt[p.mgmt.length - 1].text : 'holding as planned') : p.reason}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Rules({ st, busy, run }: { st: CSwarmState; busy: string; run: (w: string, f: () => Promise<unknown>) => void }) {
  const c = st.cfg;
  const [coins, setCoins] = useState(c.coins.join(', '));
  useEffect(() => setCoins(c.coins.join(', ')), [c.coins]);
  const lock = st.running;
  const save = (patch: Parameters<NonNullable<typeof desktop>['cswarm']['config']>[0]) => run('config', () => desktop!.cswarm.config(patch));
  const r = c.risk;
  const row = (label: string, el: React.ReactNode, hint: string) => (
    <label className="swarm-rule">
      <span>{label}</span>
      {el}
      <span className="muted">{hint}</span>
    </label>
  );
  return (
    <fieldset className="swarm-rules cs-rules" disabled={lock || !!busy}>
      {lock && <div className="muted swarm-note">Stop the swarm to change its rules.</div>}
      <div className="section-title">Markets — Hyperliquid perpetuals</div>
      {row('Coins', <input className="ctl mono" value={coins} onChange={(e) => setCoins(e.target.value)} onBlur={() => save({ coins: coins.split(/[\s,]+/).filter(Boolean) })} style={{ width: 180 }} />, 'traded against USDC; one position per coin. BTC, ETH and SOL have the deepest books')}
      <div className="section-title">Agents that propose trades</div>
      {(['auction', 'trend'] as const).map((a) => row(NAME[a], <input type="checkbox" checked={c.agents[a]} onChange={(e) => save({ agents: { [a]: e.target.checked } })} />, AGENTS.find((x) => x.id === a)!.role))}
      <div className="section-title">Risk — compounding, and keeping the account alive</div>
      {row('Risk per trade', <NumberInput value={r.riskPct} onChange={(riskPct) => save({ risk: { riskPct } })} min={0.1} step={0.25} suffix="%" />, 'of what the account is worth now: trades grow with profits and shrink after losses')}
      {row('Most per trade', <NumberInput value={r.maxRiskPct} onChange={(maxRiskPct) => save({ risk: { maxRiskPct } })} min={0.25} step={0.25} suffix="%" />, 'after the edge, drawdown and odds adjustments')}
      {row('Leverage, all positions', <NumberInput value={r.maxLeverage} onChange={(maxLeverage) => save({ risk: { maxLeverage } })} min={1} step={0.5} suffix="×" />, 'positions together at most this × the account (isolated margin, within each coin’s cap)')}
      {row('Leverage, one coin', <NumberInput value={r.perCoinLeverage} onChange={(perCoinLeverage) => save({ risk: { perCoinLeverage } })} min={1} step={0.5} suffix="×" />, 'the size comes from the stop; this only caps it')}
      {row('Positions at once', <NumberInput value={r.maxOpen} onChange={(maxOpen) => save({ risk: { maxOpen: Math.max(1, Math.round(maxOpen)) } })} min={1} step={1} />, 'crypto moves together: few positions at once')}
      {row('Daily loss limit', <NumberInput value={r.dailyLossPct} onChange={(dailyLossPct) => save({ risk: { dailyLossPct } })} min={1} step={1} suffix="%" />, 'no new trades for the rest of the day')}
      {row('Pause after', <NumberInput value={r.lossStreak} onChange={(lossStreak) => save({ risk: { lossStreak: Math.max(0, Math.round(lossStreak)) } })} min={0} step={1} suffix="losses" />, `in a row, for ${r.pauseMin} minutes (0 = off)`)}
      {row('Account floor', <NumberInput value={Math.round(r.floorShare * 100)} onChange={(v) => save({ risk: { floorShare: v / 100 } })} min={10} step={5} suffix="% of start" />, `stops trading under it; once the account reaches ${r.lockAt}× its start, the floor rises to ${Math.round(r.lockShare * 100)}% of its high — profits are locked in`)}
      {row('Edge sizing', <NumberInput value={Math.round(r.kellyShare * 100)} onChange={(v) => save({ risk: { kellyShare: v / 100 } })} min={0} step={5} suffix="% Kelly" />, `after ${r.minTrades} closed trades, size follows the record (between half and 1.5× the normal risk)`)}
      <div className="section-title">Entries — smarter fills</div>
      {(() => {
        const en = { holdSec: 30, ...(c.entry ?? { maker: true, waitMs: 5000, chaseBps: 5 }) };
        const set = (p: Partial<typeof en>) => save({ entry: { ...en, ...p } });
        return (
          <>
            {row('Rest at the best price first', <input type="checkbox" checked={en.maker} onChange={(e) => set({ maker: e.target.checked })} />, `an entry waits at the best bid (or offer) for a maker fill — ${c.makerFeeBps ?? 1.5} bps instead of ${c.feeBps} bps plus slippage — unless the order book and the tape are pushing hard its way (then it takes the price at once). Stops and exits are never delayed`)}
            {row('Wait for a fill', <NumberInput value={en.waitMs / 1000} onChange={(v) => set({ waitMs: Math.max(1, Math.min(30, v)) * 1000 })} min={1} step={1} suffix="s" />, 'not filled by then: the resting order is cancelled')}
            {row('Micro: wait for better timing', <NumberInput value={en.holdSec} onChange={(v) => set({ holdSec: Math.max(0, Math.min(120, Math.round(v))) })} min={0} step={5} suffix="s at most" />, 'when Micro reads bad timing — a liquidation cascade against the trade, a burst the other way, the order book leaning against it — the entry waits for it to clear, checking every second. Works for every trade, strategies deployed "as tested" included: the trade still happens (only the moment changes), unless the stop or the target is reached while it waits. 0 = off')}
            {row('Chase at most', <NumberInput value={en.chaseBps} onChange={(chaseBps) => set({ chaseBps: Math.max(0, chaseBps) })} min={0} step={1} suffix="bps" />, 'if the price has moved further than this from where it waited, the trade is skipped — chasing would cost more than the edge')}
          </>
        );
      })()}
      <div className="section-title">Paper account</div>
      {row('Paper start', <NumberInput value={c.paperStartUsd} onChange={(paperStartUsd) => save({ paperStartUsd })} min={10} step={10} suffix="USDC" />, 'what the paper account starts with (about R500 ≈ $27–30)')}
      <div className="swarm-rule">
        <span>Reset</span>
        <button className="chip" type="button" onClick={() => confirm('Reset the paper account and clear its trades? What the forest learned is kept.') && run('reset', () => desktop!.cswarm.resetPaper())}>
          Reset the paper account
        </button>
        <span className="muted">the forest keeps what it learned</span>
      </div>
      <div className="muted swarm-note">
        Costs counted: {c.feeBps} bps fee and {c.slippageBps} bps slippage each way. The Guardian's vetoes (spread over {st.cfg.council.maxSpreadBps} bps, 1-minute moves over {st.cfg.council.maxVolBps} bps) and the one-position-per-coin rule are fixed. Futures can be liquidated: the swarm uses isolated margin and an exchange-side stop on every live position.
      </div>
    </fieldset>
  );
}

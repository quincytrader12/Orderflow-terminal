import { useEffect, useState } from 'react';
import { fmtAgo, fmtTime, fmtUsd } from '../core/format';
import { desktop, type SecretRecord, type WalletRecord } from '../desktop/bridge';
import { vault } from '../desktop/vault';
import { useSettings } from '../store/settings';
import { useMeme } from '../meme/scanner';
import { multiple, pnlSol } from '../meme/swarm/book';
import { bankrollPlan } from '../meme/swarm/bankroll';
import { calibrate } from '../meme/swarm/outcomes';
import { swarm, useSwarm, type AgentId } from '../meme/swarm/swarm';
import { Chip, Empty, NumberInput, Select, Spacer, Toolbar, useTicker, type PanelProps } from '../ui/controls';

export interface MemeSwarmConfig {
  tab: 'live' | 'trades' | 'results' | 'rules' | 'wallet';
}

export const MEME_SWARM_DEFAULTS: MemeSwarmConfig = { tab: 'live' };

const AGENTS: { id: AgentId; name: string; job: string }[] = [
  { id: 'scout', name: 'Scout', job: 'finds every new coin' },
  { id: 'sentinel', name: 'Sentinel', job: 'viability — rejects rugs' },
  { id: 'herald', name: 'Herald', job: 'virality — is it catching on' },
  { id: 'strategist', name: 'Strategist', job: 'picks the entries' },
  { id: 'manager', name: 'Manager', job: 'runs the trades' },
];

const pct = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);
const sol = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(3)} SOL`;

export function MemeSwarm({ config: c, setConfig }: PanelProps<MemeSwarmConfig>) {
  useTicker(1000);
  const sw = useSwarm();
  const { tokens, solUsd, select } = useMeme();
  const st = sw.stats;
  const now = Date.now();

  const line = (id: AgentId) => {
    switch (id) {
      case 'scout':
        return `${st.scout.seen} coins seen · ${st.scout.perMin}/min`;
      case 'sentinel':
        return `${st.sentinel.pass} pass · ${st.sentinel.watch} watch · ${st.sentinel.reject} rejected`;
      case 'herald':
        return `${st.herald.scored} scored · ${st.herald.viral} viral (60+)`;
      case 'strategist':
        return `${sw.outcomes.filter((o) => o.kind === 'pick').length} picks`;
      case 'manager':
        return `${st.manager.open} open · ${st.manager.closed} closed · ${sol(st.manager.pnlSol)}`;
    }
  };

  return (
    <div className="panel meme swarm">
      <Toolbar>
        <button className={`chip swarm-power ${sw.enabled ? 'on' : ''}`} onClick={() => sw.set({ enabled: !sw.enabled })} title="Turn the swarm on or off (it keeps running with its panel closed)">
          {sw.enabled ? '■ Swarm on' : '▶ Start swarm'}
        </button>
        <button
          className={`meme-tag swarm-mode ${sw.mode}`}
          onClick={() => setConfig({ tab: 'wallet' })}
          title={sw.mode === 'live' ? (sw.wallet?.limits.armed ? 'Trading real SOL from the swarm wallet, on its own' : 'Live mode, but not armed — nothing is bought') : 'Paper trading — switch to live under Wallet'}
        >
          {sw.mode === 'live' ? (sw.wallet?.limits.armed ? '● LIVE' : 'live · not armed') : 'paper'}
        </button>
        {(['live', 'trades', 'results', 'rules', 'wallet'] as const).map((t) => (
          <Chip key={t} active={c.tab === t} onClick={() => setConfig({ tab: t })}>
            {t[0].toUpperCase() + t.slice(1)}
          </Chip>
        ))}
        <Spacer />
        <span className="muted">SOL {solUsd > 0 ? fmtUsd(solUsd, 2) : '—'}</span>
      </Toolbar>

      <div className="swarm-agents">
        {AGENTS.map((a) => (
          <div key={a.id} className={`swarm-agent ${sw.enabled ? 'on' : ''}`}>
            <div className="swarm-agent-name">
              <span className="swarm-pulse" /> {a.name}
            </div>
            <div className="muted">{a.job}</div>
            <div className="mono swarm-agent-line">{line(a.id)}</div>
          </div>
        ))}
      </div>

      <div className="scroll swarm-body">
        {c.tab === 'live' && (
          <>
            {st.herald.narratives.length > 0 && (
              <div className="swarm-narratives">
                <span className="muted">Hot narratives this hour:</span>
                {st.herald.narratives.map((n) => (
                  <span key={n.word} className="meme-tag">
                    {n.word} ×{n.count}
                  </span>
                ))}
              </div>
            )}
            {st.sentinel.top.length > 0 && (
              <div className="muted swarm-rejects">
                Most common reasons coins are turned down: {st.sentinel.top.map((r) => `${r.why} (${r.n})`).join(' · ')}
              </div>
            )}
            <div className="section-title">Coins the swarm is reading</div>
            {sw.reads.length ? (
              <table className="grid swarm-reads">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Heat</th>
                    <th>Virality</th>
                    <th>Viability</th>
                    <th>Conviction</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {sw.reads.map((r) => (
                    <tr key={r.mint} onClick={() => select(r.mint)} className={r.enter ? 'pick' : ''}>
                      <td>
                        <b>{r.symbol}</b> <span className="muted">{Number.isFinite(r.mcapUsd) ? fmtUsd(r.mcapUsd, 1) : ''}</span>
                      </td>
                      <td className="mono">{r.heat}</td>
                      <td className="mono">{r.virality?.score ?? '—'}</td>
                      <td className={`mono ${r.viability.verdict === 'reject' ? 'down' : r.viability.verdict === 'pass' ? 'up' : ''}`}>{r.viability.verdict === 'reject' ? 'rejected' : `${r.viability.score} ${r.viability.verdict}`}</td>
                      <td className="mono">{r.conviction}</td>
                      <td className="swarm-why" title={[r.decision, ...(r.virality?.reasons ?? []), ...r.viability.reasons].join('\n')}>
                        {r.enter ? '✅ ' : ''}
                        {r.decision}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>{sw.enabled ? 'Reading the first coins…' : 'Start the swarm to watch the meme-coin chain.'}</Empty>
            )}
            <div className="section-title">What the bots are doing</div>
            <div className="swarm-log">
              {[...sw.log]
                .reverse()
                .slice(0, 80)
                .map((l, i) => (
                  <div key={l.t + l.text + i} className={`swarm-logline a-${l.agent}`} onClick={() => l.mint && select(l.mint)}>
                    <span className="mono muted">{fmtTime(l.t)}</span> <b>{AGENTS.find((a) => a.id === l.agent)?.name}</b> {l.text}
                  </div>
                ))}
            </div>
          </>
        )}

        {c.tab === 'trades' && (
          <>
            {sw.positions.length ? (
              <table className="grid swarm-trades">
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Opened</th>
                    <th>Cost</th>
                    <th>Now</th>
                    <th>Peak</th>
                    <th>P&amp;L</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...sw.positions].reverse().map((p) => {
                    const tok = tokens[p.mint];
                    const m = p.closedAt ? p.realizedSol / p.costSol : tok ? multiple(p, tok, solUsd) : NaN;
                    const pnl = p.closedAt ? p.realizedSol - p.costSol : pnlSol(p, tok, solUsd);
                    return (
                      <tr key={p.id} onClick={() => select(p.mint)} title={[p.why, ...p.fills.map((f) => `${fmtTime(f.t)} ${f.side} ${f.sol.toFixed(3)} SOL — ${f.why}`)].join('\n')}>
                        <td>
                          <b>{p.symbol}</b> <span className="muted">conv {p.conviction}</span>
                        </td>
                        <td className="mono">{fmtAgo(p.openedAt, now)} ago</td>
                        <td className="mono">{p.costSol} SOL</td>
                        <td className="mono">{Number.isFinite(m) ? `${m.toFixed(2)}×` : '—'}</td>
                        <td className="mono">{p.peakMult.toFixed(2)}×</td>
                        <td className={`mono ${pnl >= 0 ? 'up' : 'down'}`}>{Number.isFinite(pnl) ? sol(pnl) : '—'}</td>
                        <td className="muted">
                          {p.live ? 'LIVE · ' : ''}
                          {p.closedAt ? p.closeReason : p.pending ? 'selling…' : p.tpDone ? `open · ${p.tpDone} take-profit${p.tpDone > 1 ? 's' : ''} hit` : 'open'}
                        </td>
                        <td>
                          {!p.closedAt && (
                            <button
                              className="chip"
                              disabled={p.pending}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`Sell all of ${p.symbol} now${p.live ? ' (real SOL)' : ''}?`)) swarm.sellNow(p.id);
                              }}
                            >
                              Sell
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty>No trades yet — the Strategist only buys when heat, virality and viability all line up.</Empty>
            )}
            <div className="muted swarm-note">
              Paper trades are priced exactly on the bonding curve (fee and price impact included) or on the pool; live trades book what the chain says was paid and received.
              {sw.positions.some((p) => !p.closedAt) && (
                <>
                  {' '}
                  <a
                    onClick={() => {
                      const open = sw.positions.filter((p) => !p.closedAt);
                      if (confirm(`Sell all ${open.length} open position${open.length > 1 ? 's' : ''} now?`)) for (const p of open) swarm.sellNow(p.id);
                    }}
                  >
                    Sell everything
                  </a>
                </>
              )}
              {sw.positions.length > 0 && !sw.positions.some((p) => p.live && !p.closedAt) && (
                <>
                  {' '}
                  <a onClick={() => confirm('Clear all paper trades and results?') && sw.reset()}>Clear history</a>
                </>
              )}
            </div>
          </>
        )}

        {c.tab === 'results' && <Results />}
        {c.tab === 'rules' && <Rules />}
        {c.tab === 'wallet' && <Wallet />}
      </div>
    </div>
  );
}

function Results() {
  const outcomes = useSwarm((s) => s.outcomes);
  const rows = calibrate(outcomes);
  const done = outcomes.filter((o) => o.done).length;
  return (
    <>
      <div className="muted swarm-note">
        Every pick — and, for comparison, a sample of coins that passed the Sentinel but were not picked — is followed for an hour from the moment of the call. The best market cap it reached in that hour decides 2×, 5×, 10×; "dead" means it ended the hour at a fifth or less. {outcomes.length} calls followed, {done} complete.
      </div>
      <table className="grid swarm-results">
        <thead>
          <tr>
            <th>Group</th>
            <th>Calls</th>
            <th>Reached 2×</th>
            <th>5×</th>
            <th>10×</th>
            <th>Graduated</th>
            <th>Dead</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.label}>
              <td>{b.label}</td>
              <td className="mono">{b.n}</td>
              <td className="mono">{b.n ? pct(b.x2) : '—'}</td>
              <td className="mono">{b.n ? pct(b.x5) : '—'}</td>
              <td className="mono">{b.n ? pct(b.x10) : '—'}</td>
              <td className="mono">{b.n ? pct(b.graduated) : '—'}</td>
              <td className="mono down">{b.n ? pct(b.dead) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="muted swarm-note">If picks don't beat the "passed, not picked" row, the rules are not adding anything yet — tighten them under Rules. A few dozen calls are needed before the numbers mean much.</div>
    </>
  );
}

function Rules() {
  const { strategy: s, manager: m, setStrategy, setManager } = useSwarm();
  const [tp, setTp] = useState(m.takeProfits.map((t) => `${t.at}:${Math.round(t.sell * 100)}`).join(', '));
  const row = (label: string, el: React.ReactNode, hint: string) => (
    <label className="swarm-rule">
      <span>{label}</span>
      {el}
      <span className="muted">{hint}</span>
    </label>
  );
  return (
    <div className="swarm-rules">
      <div className="section-title">Strategist — when to enter</div>
      {row('Min heat', <NumberInput value={s.minHeat} onChange={(minHeat) => setStrategy({ minHeat })} min={0} step={5} />, 'strength of the buying, 0–100')}
      {row('Min virality', <NumberInput value={s.minVirality} onChange={(minVirality) => setStrategy({ minVirality })} min={0} step={5} />, 'new wallets, narrative, socials, 0–100')}
      {row('Min viability', <NumberInput value={s.minViability} onChange={(minViability) => setStrategy({ minViability })} min={0} step={5} />, 'after the Sentinel’s penalties, 0–100')}
      {row('Max age', <NumberInput value={s.maxAgeMin} onChange={(maxAgeMin) => setStrategy({ maxAgeMin })} min={1} step={5} suffix="min" />, 'early is where the multiples are')}
      {row('Curve from', <NumberInput value={Math.round(s.minCurve * 100)} onChange={(v) => setStrategy({ minCurve: v / 100 })} min={0} step={5} suffix="%" />, 'not the first seconds: bundles and snipers')}
      {row('Curve to', <NumberInput value={Math.round(s.maxCurve * 100)} onChange={(v) => setStrategy({ maxCurve: v / 100 })} min={0} step={5} suffix="%" />, 'not the very top: graduation gets sold into')}
      {row('Max market cap', <NumberInput value={s.maxMcapUsd} onChange={(maxMcapUsd) => setStrategy({ maxMcapUsd })} min={1000} step={25000} suffix="$" />, 'room to run')}
      {row('Min pool liquidity', <NumberInput value={s.minLiquidityUsd} onChange={(minLiquidityUsd) => setStrategy({ minLiquidityUsd })} min={0} step={5000} suffix="$" />, 'migrated coins')}
      <div className="section-title">Manager — how to run the trade</div>
      {row('Size', <NumberInput value={m.sizeSol} onChange={(sizeSol) => setManager({ sizeSol })} min={0.01} step={0.05} suffix="SOL" />, 'per trade')}
      {row('Max open', <NumberInput value={m.maxOpen} onChange={(maxOpen) => setManager({ maxOpen })} min={1} step={1} />, 'positions at once')}
      {row(
        'Take profits',
        <input
          className="ctl mono"
          value={tp}
          style={{ width: 120 }}
          onChange={(e) => setTp(e.target.value)}
          onBlur={() => {
            const parsed = tp
              .split(',')
              .map((x) => x.split(':').map(Number))
              .filter(([at, s2]) => at > 1 && s2 > 0 && s2 <= 100)
              .map(([at, s2]) => ({ at, sell: s2 / 100 }))
              .sort((a, b) => a.at - b.at);
            if (parsed.length) setManager({ takeProfits: parsed });
          }}
        />,
        'multiple:% of what is left — "2:50, 5:50" sells half at 2×, half the rest at 5×',
      )}
      {row('Stop loss', <NumberInput value={Math.round(m.stopLoss * 100)} onChange={(v) => setManager({ stopLoss: v / 100 })} min={5} step={5} suffix="%" />, 'out when down this much')}
      {row('Trail from', <NumberInput value={m.trailFrom} onChange={(trailFrom) => setManager({ trailFrom })} min={1} step={0.25} suffix="×" />, 'start trailing once up this much')}
      {row('Trail', <NumberInput value={Math.round(m.trail * 100)} onChange={(v) => setManager({ trail: v / 100 })} min={5} step={5} suffix="%" />, 'give back at most this from the peak')}
      {row('Stale after', <NumberInput value={m.staleMin} onChange={(staleMin) => setManager({ staleMin })} min={1} step={5} suffix="min" />, `no new high, and under ${m.staleBelow}×`)}
      {row('Daily loss limit', <NumberInput value={m.dailyLossSol} onChange={(dailyLossSol) => setManager({ dailyLossSol })} min={0.01} step={0.1} suffix="SOL" />, 'no new trades for the day after this')}
      <div className="muted swarm-note">The Sentinel's rejections (live mint or freeze authority, creator dumping, bundled launches, top 10 over 50 %, wash trading, idle trading, thin pools, creators whose earlier coins rugged) are not adjustable: they are the rugs.</div>
    </div>
  );
}

/** The swarm's own trading wallet: live mode, its limits, and the arm switch. */
function Wallet() {
  const sw = useSwarm();
  const w = sw.wallet;
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const rpcId = useSettings((s) => s.memeRpcSecretId);
  const swarmRpc = () => rpcId || undefined;
  const setSettings = useSettings((s) => s.set);
  const [rpcs, setRpcs] = useState<SecretRecord[]>([]);
  const [rpcTest, setRpcTest] = useState('');
  const [phantoms, setPhantoms] = useState<WalletRecord[]>([]);
  const [homePick, setHomePick] = useState('');
  const [sendAmt, setSendAmt] = useState(0.1);
  const loadPhantoms = () =>
    desktop?.wallet
      .list()
      .then((l) => {
        const v = l.filter((x) => x.verified);
        setPhantoms(v);
        setHomePick((h) => h || v[0]?.address || '');
      })
      .catch(() => undefined);
  useEffect(() => void loadPhantoms(), []);
  useEffect(() => {
    vault
      .list()
      .then((l) => setRpcs(l.filter((r) => r.kind === 'solana-rpc')))
      .catch(() => undefined);
  }, []);
  const run = async (what: string, f: () => Promise<unknown>) => {
    setBusy(what);
    setErr('');
    try {
      await f();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy('');
      await swarm.refreshWallet();
    }
  };
  if (!desktop) return <Empty>Live trading runs in the desktop app: the wallet key stays in its main process.</Empty>;
  const limit = (k: 'maxBuySol' | 'dailySpendSol' | 'reserveSol', v: number) => run('limits', () => desktop!.swarm.setLimits({ [k]: v }));
  const row = (label: string, el: React.ReactNode, hint: string) => (
    <label className="swarm-rule">
      <span>{label}</span>
      {el}
      <span className="muted">{hint}</span>
    </label>
  );
  return (
    <div className="swarm-rules">
      <div className="section-title">Mode</div>
      <div className="swarm-modes">
        <Chip active={sw.mode === 'paper'} onClick={() => sw.set({ mode: 'paper' })}>
          Paper
        </Chip>
        <Chip active={sw.mode === 'live'} onClick={() => sw.set({ mode: 'live' })}>
          Live
        </Chip>
        <span className="muted">
          {sw.mode === 'paper'
            ? 'Trades are simulated against the real market. Nothing leaves a wallet.'
            : w?.limits.armed
              ? 'The swarm buys, manages and sells on its own from the wallet below — no approval clicks. Telegram gets a card for each buy, each new multiple and each sale.'
              : 'Live, but not armed: picks are logged and nothing is bought until you arm the wallet below.'}
        </span>
      </div>

      <div className="section-title">Solana RPC</div>
      <div className="swarm-arm">
        <Select value={rpcs.some((r) => r.id === rpcId) ? rpcId : ''} options={[{ value: '', label: 'Public RPC (slow, rate-limited)' }, ...rpcs.map((r) => ({ value: r.id, label: r.label }))]} onChange={(memeRpcSecretId) => setSettings({ memeRpcSecretId })} title="The RPC the scanner's on-chain checks and the swarm's trades go through" width={240} />
        <button
          className="chip"
          disabled={!!busy}
          onClick={async () => {
            setRpcTest('testing…');
            const t0 = performance.now();
            try {
              const slot = await desktop!.solana.rpc('getSlot', [{ commitment: 'confirmed' }], rpcId || undefined);
              setRpcTest(`✓ working · slot ${Number(slot).toLocaleString('en-US')} · ${Math.round(performance.now() - t0)} ms`);
            } catch (e) {
              setRpcTest(`✗ ${String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
            }
          }}
        >
          Test RPC
        </button>
        {rpcTest && <span className={`mono ${rpcTest.startsWith('✓') ? 'up' : rpcTest.startsWith('✗') ? 'down' : 'muted'}`}>{rpcTest}</span>}
      </div>
      <div className="muted swarm-note">{rpcs.length ? 'Used for the on-chain safety checks, balances and every live trade.' : 'Add a private RPC (Helius, QuickNode) in 🔌 Connect → Solana RPC: trades land faster and checks are not rate-limited.'}</div>

      <div className="section-title">Swarm wallet</div>
      {w ? (
        <>
          <div className="swarm-wallet">
            <div>
              <div className="muted">Address — send SOL here to fund it</div>
              <div className="mono swarm-address" onClick={() => navigator.clipboard.writeText(w.address)} title="Copy">
                {w.address}
              </div>
            </div>
            <div>
              <div className="muted">Balance</div>
              <div className="mono swarm-balance">{w.sol === null ? '—' : `${w.sol.toFixed(4)} SOL`}</div>
            </div>
            <div>
              <div className="muted">Spent today</div>
              <div className="mono">
                {w.spentToday.toFixed(3)} / {w.limits.dailySpendSol} SOL
              </div>
            </div>
          </div>
          {(() => {
            const plan = w.sol !== null ? bankrollPlan(w.sol) : null;
            const usd = useMeme.getState().solUsd;
            return (
              <div className="swarm-bankroll">
                <button
                  className="chip"
                  disabled={!!busy || !plan || 'error' in plan}
                  title="Size the swarm to the SOL in this wallet: positions, per-trade and daily caps, loss limit, fee reserve, priority fee"
                  onClick={() =>
                    plan &&
                    !('error' in plan) &&
                    run('limits', async () => {
                      await desktop!.swarm.setLimits({ maxBuySol: plan.sizeSol, dailySpendSol: plan.dailySpendSol, reserveSol: plan.reserveSol, priorityLamports: plan.priorityLamports });
                      sw.setManager({ sizeSol: plan.sizeSol, maxOpen: plan.maxOpen, dailyLossSol: plan.dailyLossSol });
                    })
                  }
                >
                  Set up for my balance
                </button>
                <span className="muted">
                  {!plan
                    ? 'Balance not known yet (the RPC has not answered).'
                    : 'error' in plan
                      ? plan.error
                      : `${plan.maxOpen} coin${plan.maxOpen > 1 ? 's' : ''} × ${plan.sizeSol} SOL${usd > 0 ? ` (≈ $${(plan.sizeSol * usd).toFixed(2)} each)` : ''}, ${plan.reserveSol} SOL kept for fees, stop for the day after losing ${plan.dailyLossSol} SOL — uses ${(plan.deployedSol + plan.reserveSol).toFixed(3)} of ${plan.balanceSol.toFixed(3)} SOL.`}
                  {sw.manager.sizeSol === (plan && !('error' in plan) ? plan.sizeSol : NaN) && sw.manager.maxOpen === (plan && !('error' in plan) ? plan.maxOpen : NaN) ? ' ✓ in use' : ''}
                </span>
              </div>
            );
          })()}
          <div className="swarm-arm">
            {w.limits.armed ? (
              <button className="chip swarm-armed" disabled={!!busy} onClick={() => run('arm', () => desktop!.swarm.setLimits({ armed: false }))}>
                ■ Disarm — stop buying
              </button>
            ) : (
              <button className="chip swarm-arm-btn" disabled={!!busy} onClick={() => run('arm', () => desktop!.swarm.setLimits({ armed: true }))}>
                Arm live trading…
              </button>
            )}
            <span className="muted">{w.limits.armed ? 'Armed: the swarm signs its own trades within the limits below. Open positions keep being managed and sold after you disarm.' : 'Arming asks for confirmation in a system dialog.'}</span>
          </div>
          {row('Per trade', <NumberInput value={w.limits.maxBuySol} onChange={(v) => limit('maxBuySol', v)} min={0.001} step={0.01} suffix="SOL" />, `hard cap; the swarm buys ${Math.min(sw.manager.sizeSol, w.limits.maxBuySol)} SOL (the smaller of this and Rules → Size)`)}
          {row('Per day', <NumberInput value={w.limits.dailySpendSol} onChange={(v) => limit('dailySpendSol', v)} min={0.001} step={0.1} suffix="SOL" />, 'total bought per day, then it stops')}
          {row('Keep for fees', <NumberInput value={w.limits.reserveSol} onChange={(v) => limit('reserveSol', v)} min={0} step={0.01} suffix="SOL" />, 'never spent on coins, so sells can always pay their fee')}
          {row(
            'Slippage',
            <NumberInput value={w.limits.slippageBps / 100} onChange={(v) => run('limits', () => desktop!.swarm.setLimits({ slippageBps: Math.round(v * 100) }))} min={1} step={1} suffix="%" />,
            'meme coins move fast: 10–20 % is normal',
          )}
          {row(
            'Priority fee',
            <NumberInput value={w.limits.priorityLamports / 1e9} onChange={(v) => run('limits', () => desktop!.swarm.setLimits({ priorityLamports: Math.round(v * 1e9) }))} min={0} step={0.0001} suffix="SOL" />,
            'most it pays to land a trade quickly',
          )}
          <div className="section-title">Home wallet — your Phantom</div>
          {w.home ? (
            <>
              <div className="swarm-arm">
                <span className="mono">
                  ✓ {w.home.slice(0, 4)}…{w.home.slice(-4)}
                </span>
                <span className="muted">withdrawals and profits go here, and nowhere else</span>
                <button className="chip" disabled={!!busy} onClick={() => run('home', () => desktop!.swarm.setHome(null))}>
                  Change…
                </button>
              </div>
              <div className="swarm-arm">
                <NumberInput value={sendAmt} onChange={setSendAmt} min={0.001} step={0.05} suffix="SOL" />
                <button className="chip" disabled={!!busy} onClick={() => run('send', () => desktop!.swarm.withdraw(sendAmt, swarmRpc()))}>
                  Send to Phantom…
                </button>
                <button className="chip" disabled={!!busy} onClick={() => run('send', () => desktop!.swarm.withdraw('all', swarmRpc()))}>
                  Send everything…
                </button>
              </div>
              {row(
                'Profits home',
                <NumberInput value={w.limits.sweepAboveSol} onChange={(v) => run('limits', () => desktop!.swarm.setLimits({ sweepAboveSol: v }))} min={0} step={0.1} suffix="SOL" />,
                w.limits.sweepAboveSol > 0 ? `keep ${w.limits.sweepAboveSol} SOL for trading; anything over it goes to your Phantom automatically` : 'off — set how much SOL to keep for trading, and the rest goes to your Phantom automatically',
              )}
            </>
          ) : (
            <div className="swarm-arm">
              {phantoms.length ? (
                <>
                  <Select value={homePick} options={phantoms.map((x) => ({ value: x.address, label: `${x.address.slice(0, 4)}…${x.address.slice(-4)}` }))} onChange={setHomePick} width={130} />
                  <button className="chip swarm-arm-btn" disabled={!!busy || !homePick} onClick={() => run('home', () => desktop!.swarm.setHome(homePick))}>
                    Use as home…
                  </button>
                  <span className="muted">The swarm will send withdrawals and profits to this wallet only.</span>
                </>
              ) : (
                <>
                  <button className="chip swarm-arm-btn" disabled={!!busy} onClick={() => run('connect', async () => (await desktop!.wallet.connectPhantom(), await loadPhantoms()))}>
                    Connect Phantom…
                  </button>
                  <span className="muted">Sign the connect message in Phantom (it opens in your browser); the swarm can then send its profits home to it.</span>
                </>
              )}
            </div>
          )}
          <div className="swarm-arm">
            <button className="chip" disabled={!!busy} onClick={() => run('export', () => desktop!.swarm.exportKey())}>
              Export to Phantom…
            </button>
            <button className="chip" disabled={!!busy} onClick={() => run('remove', () => desktop!.swarm.remove())}>
              Remove wallet…
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="muted swarm-note">
            Phantom asks you to approve every trade, so the swarm trades from a wallet of its own. Its key is encrypted in the vault and used only by the app's main process. Fund it with a small amount and send profits back to Phantom when you like — or import it into Phantom with Export.
          </div>
          <div className="swarm-arm">
            <button className="chip swarm-arm-btn" disabled={!!busy} onClick={() => run('create', () => desktop!.swarm.create())}>
              Create swarm wallet
            </button>
            <span className="muted">or import one:</span>
            <input className="ctl mono" type="password" placeholder="private key (base58, as Phantom exports it)" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ width: 280 }} />
            <button className="chip" disabled={!!busy || !secret.trim()} onClick={() => run('import', async () => (await desktop!.swarm.importKey(secret.trim()), setSecret('')))}>
              Import
            </button>
          </div>
        </>
      )}
      {busy && <div className="muted swarm-note">Working…</div>}
      {err && <div className="down swarm-note">{err}</div>}
      <div className="muted swarm-note">
        Trades go through Jupiter (pump.fun coins included), with pump.fun's own API as the fallback, and are sent through the Solana RPC chosen above — a private one (Helius, QuickNode) lands them faster. Most meme coins go to zero: only fund this wallet with what you can afford to lose.
      </div>
    </div>
  );
}

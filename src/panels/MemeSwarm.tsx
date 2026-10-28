import { useState } from 'react';
import { fmtAgo, fmtTime, fmtUsd } from '../core/format';
import { useMeme } from '../meme/scanner';
import { multiple, pnlSol } from '../meme/swarm/book';
import { calibrate } from '../meme/swarm/outcomes';
import { useSwarm, type AgentId } from '../meme/swarm/swarm';
import { Chip, Empty, NumberInput, Spacer, Toolbar, useTicker, type PanelProps } from '../ui/controls';

export interface MemeSwarmConfig {
  tab: 'live' | 'trades' | 'results' | 'rules';
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
        <span className="meme-tag">paper</span>
        {(['live', 'trades', 'results', 'rules'] as const).map((t) => (
          <Chip key={t} active={c.tab === t} onClick={() => setConfig({ tab: t })}>
            {t === 'live' ? 'Live' : t === 'trades' ? 'Trades' : t === 'results' ? 'Results' : 'Rules'}
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
                        <td className="muted">{p.closedAt ? p.closeReason : p.tpDone ? `open · ${p.tpDone} take-profit${p.tpDone > 1 ? 's' : ''} hit` : 'open'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <Empty>No trades yet — the Strategist only buys when heat, virality and viability all line up.</Empty>
            )}
            <div className="muted swarm-note">
              Paper trades: fills priced exactly on the bonding curve (fee and price impact included) or on the pool. Live trading through Phantom comes next.
              {sw.positions.length > 0 && (
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

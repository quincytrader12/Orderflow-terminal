// Who decides a deployed strategy's trades, and what the swarm's council has
// done with its signals so far — shown wherever deployed strategies are listed
// (DEPL in the Strategy Lab, the deploy gate in the crypto swarm view).
//
//   council   the strategy proposes; the council (trend, tape, crowd, forest)
//             votes and can block it; the safety bots (Guardian, Risk) too
//   tested    the strategy trades as it was tested: the council's votes are
//             advice on the record; only Guardian and Risk can stop a trade
//
// The record keeps both honest: every signal the council blocked is followed
// to its exits anyway, so you can see whether the council saved you money or
// cost you money on that strategy.
import { useCSwarm } from '../cswarm/store';
import { desktop, type LabBook } from '../desktop/bridge';
import type { Authority, LabDeployed } from './store';

const BOT: Record<string, string> = { forest: 'the forest', guardian: 'Guardian', risk: 'Risk', score: 'not enough votes', trend: 'Trend', tape: 'Tape', micro: 'Micro (timing)', crowd: 'Crowd' };
const r2 = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}R`;

export function AuthoritySwitch({ d, compact }: { d: LabDeployed; compact?: boolean }) {
  const a: Authority = d.authority ?? 'council';
  const set = (x: Authority) => void desktop?.lab.authority(d.id, x);
  return (
    <span className={`auth-switch${compact ? ' compact' : ''}`} role="radiogroup" aria-label="Who decides its trades">
      <button role="radio" aria-checked={a === 'council'} className={a === 'council' ? 'on' : ''} onClick={() => set('council')} title="The swarm's council votes on every signal and can block it (and Guardian and Risk can stop it)">
        Council decides
      </button>
      <button role="radio" aria-checked={a === 'tested'} className={a === 'tested' ? 'on t' : ''} onClick={() => set('tested')} title="Trade as tested: the council's votes are only advice; Guardian (spread, volatility spikes) and Risk (daily loss, drawdown, size) can still stop a trade">
        Trade as tested
      </button>
    </span>
  );
}

/** the council's record on one strategy, in a line */
export function bookLine(b: LabBook | undefined, authority: Authority | undefined): string {
  if (!b || !b.signals) return authority === 'tested' ? 'No signals yet. As tested: only Guardian and Risk can stop its trades.' : 'No signals yet.';
  const parts = [`${b.signals} signal${b.signals > 1 ? 's' : ''}`, `${b.taken} trade${b.taken === 1 ? '' : 's'} closed${b.taken ? ` (${r2(b.takenR)})` : ''}`];
  if (b.blocked) {
    const who = Object.entries(b.blockedBy)
      .sort((x, y) => y[1] - x[1])
      .map(([k, n]) => `${BOT[k] ?? k} ${n}`)
      .join(', ');
    parts.push(`${b.blocked} blocked (${who})`);
    if (b.shadowN) parts.push(`the blocked ones would have made ${r2(b.shadowR)} over ${b.shadowN} — ${b.shadowR < 0 ? 'the council saved you money' : 'the council cost you money'}`);
  }
  if (b.refused) parts.push(`${b.refused} missed: the swarm already held the coin`);
  return parts.join(' · ');
}

export function useLabBook(id: string): LabBook | undefined {
  return useCSwarm((s) => s.state?.labBook?.[id]);
}

export function LabBookLine({ d }: { d: LabDeployed }) {
  const b = useLabBook(d.id);
  return <span className={`muted auth-book${b && b.shadowN && b.shadowR > 0 ? ' warn' : ''}`}>{bookLine(b, d.authority)}</span>;
}

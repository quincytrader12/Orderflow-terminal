// The swarm's memory of how its calls turned out — the data the strategy is
// tuned on. Every coin the Strategist would trade (and, for comparison, a
// sample of coins that passed the Sentinel but were not picked) is followed
// for an hour: its peak multiple, whether it graduated, whether it rugged.
// The table then answers the real question: at each conviction level, how
// often did a pick reach 2×, 5×, 10×, and how often did it go to zero?

export interface Outcome {
  mint: string;
  symbol: string;
  t0: number;
  mcap0: number;
  /** picked by the Strategist, or a passed-but-not-picked comparison sample */
  kind: 'pick' | 'control';
  conviction: number;
  heat: number;
  virality: number;
  viability: number;
  peak: number;
  last: number;
  graduated: boolean;
  done: boolean;
}

export const FOLLOW_MS = 60 * 60_000;

export function newOutcome(o: Omit<Outcome, 'peak' | 'last' | 'graduated' | 'done'>): Outcome {
  return { ...o, peak: 1, last: 1, graduated: false, done: false };
}

/** Update with the coin's market cap now (SOL), or mark it done after the hour. */
export function follow(o: Outcome, mcapSol: number, migrated: boolean, now: number) {
  if (o.done) return;
  if (mcapSol > 0 && o.mcap0 > 0) {
    o.last = mcapSol / o.mcap0;
    o.peak = Math.max(o.peak, o.last);
  }
  if (migrated) o.graduated = true;
  if (now - o.t0 >= FOLLOW_MS) o.done = true;
}

export interface Bucket {
  label: string;
  n: number;
  x2: number;
  x5: number;
  x10: number;
  /** fell to a fifth of the entry market cap or less */
  dead: number;
  graduated: number;
}

/** Hit rates by conviction (picks) and for the comparison sample. */
export function calibrate(rows: Outcome[]): Bucket[] {
  const make = (label: string, sel: Outcome[]): Bucket => {
    const n = sel.length || 1;
    return {
      label,
      n: sel.length,
      x2: sel.filter((o) => o.peak >= 2).length / n,
      x5: sel.filter((o) => o.peak >= 5).length / n,
      x10: sel.filter((o) => o.peak >= 10).length / n,
      dead: sel.filter((o) => o.last <= 0.2).length / n,
      graduated: sel.filter((o) => o.graduated).length / n,
    };
  };
  const picks = rows.filter((o) => o.kind === 'pick');
  return [
    make('Conviction 80+', picks.filter((o) => o.conviction >= 80)),
    make('Conviction 65–79', picks.filter((o) => o.conviction >= 65 && o.conviction < 80)),
    make('Conviction < 65', picks.filter((o) => o.conviction < 65)),
    make('All picks', picks),
    make('Passed, not picked', rows.filter((o) => o.kind === 'control')),
  ];
}

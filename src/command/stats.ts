// What the Command Center shows, worked out from the swarm's book: profit and
// loss (banked and open), the equity curve, capital at risk, today's spend
// against the budget, hit rate, best multiple, and the execution tape.
import { markPrice, pnlSol, type Position } from '../meme/swarm/book';
import type { MemeToken } from '../meme/token';

export interface OpenLine {
  id: string;
  mint: string;
  symbol: string;
  costSol: number;
  /** what the tokens still held are worth at the price now */
  valueSol: number;
  realizedSol: number;
  mult: number;
  peak: number;
  live: boolean;
}

export interface TapeLine {
  key: string;
  t: number;
  side: 'buy' | 'sell';
  symbol: string;
  mint: string;
  sol: number;
  mult: number;
  why: string;
  live: boolean;
}

export interface CommandStats {
  pnlSol: number;
  realizedSol: number;
  unrealizedSol: number;
  /** cumulative P&L: a point per closed trade, then now (with the open trades) */
  equity: { t: number; v: number }[];
  open: OpenLine[];
  atRiskSol: number;
  picks: number;
  closed: number;
  winRate: number | null;
  bestMult: number;
  spentToday: number;
  /** cumulative SOL put into trades today, a point per buy */
  spend: { t: number; v: number }[];
  lostToday: number;
  tape: TapeLine[];
}

export function commandStats(positions: Position[], tokens: Record<string, MemeToken | undefined>, solUsd: number, now: number): CommandStats {
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  let realized = 0;
  let unrealized = 0;
  let atRisk = 0;
  let best = 0;
  let wins = 0;
  const open: OpenLine[] = [];
  const closed = positions.filter((p) => p.closedAt).sort((a, b) => a.closedAt! - b.closedAt!);
  const equity: { t: number; v: number }[] = [];
  let run = 0;
  for (const p of closed) {
    run += p.realizedSol - p.costSol;
    equity.push({ t: p.closedAt!, v: run });
    if (p.realizedSol > p.costSol) wins++;
  }
  for (const p of positions) {
    best = Math.max(best, p.peakMult);
    if (p.closedAt) {
      realized += p.realizedSol - p.costSol;
      continue;
    }
    const tok = tokens[p.mint];
    const px = tok ? markPrice(tok, solUsd) : NaN;
    const value = p.left * (px > 0 ? px : p.entryPx);
    atRisk += value;
    unrealized += pnlSol(p, tok, solUsd);
    open.push({ id: p.id, mint: p.mint, symbol: p.symbol, costSol: p.costSol, valueSol: value, realizedSol: p.realizedSol, mult: px > 0 && p.entryPx > 0 ? px / p.entryPx : NaN, peak: p.peakMult, live: Boolean(p.live) });
  }
  if (equity.length || open.length) equity.push({ t: now, v: run + unrealized });

  const buysToday = positions.filter((p) => p.openedAt >= dayStart).sort((a, b) => a.openedAt - b.openedAt);
  const spend: { t: number; v: number }[] = [{ t: dayStart, v: 0 }];
  let spent = 0;
  for (const p of buysToday) spend.push({ t: p.openedAt, v: (spent += p.costSol) });
  spend.push({ t: now, v: spent });
  const lostToday = -positions.filter((p) => p.closedAt && p.closedAt >= dayStart).reduce((a, p) => a + (p.realizedSol - p.costSol), 0);

  const tape: TapeLine[] = [];
  for (const p of positions) for (const f of p.fills) tape.push({ key: `${p.id}:${f.t}:${f.side}:${f.sol}`, t: f.t, side: f.side, symbol: p.symbol, mint: p.mint, sol: f.sol, mult: f.mult, why: f.why, live: Boolean(p.live) });
  tape.sort((a, b) => b.t - a.t);

  return {
    pnlSol: realized + unrealized,
    realizedSol: realized,
    unrealizedSol: unrealized,
    equity,
    open: open.sort((a, b) => b.valueSol - a.valueSol),
    atRiskSol: atRisk,
    picks: positions.length,
    closed: closed.length,
    winRate: closed.length ? wins / closed.length : null,
    bestMult: best,
    spentToday: spent,
    spend,
    lostToday: Math.max(0, lostToday),
    tape: tape.slice(0, 40),
  };
}

/** Messages per second from a counter sampled once a second (last `n` samples). */
export class Rate {
  private last: number | null = null;
  readonly samples: number[] = [];
  constructor(private n = 60) {}
  push(count: number) {
    const d = this.last === null ? 0 : Math.max(0, count - this.last);
    this.last = count;
    this.samples.push(d);
    if (this.samples.length > this.n) this.samples.shift();
    return d;
  }
  /** mean over the last `k` samples */
  mean(k = 5) {
    const s = this.samples.slice(-k);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0;
  }
}

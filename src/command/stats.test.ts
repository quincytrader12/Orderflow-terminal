import { describe, expect, it } from 'vitest';
import { applyTrade } from '../meme/token';
import { markPrice, openPosition, type Position } from '../meme/swarm/book';
import { runner, trade } from '../meme/swarm/fixtures';
import { commandStats, Rate } from './stats';

describe('Command Center numbers', () => {
  it('splits P&L into banked and open, values what is at risk, and draws the equity curve and tape', () => {
    const { tok, now } = runner(6);
    const open = openPosition(tok, 0.1, now, 150, 'test', 80)!;
    const won: Position = { ...open, id: 'won', openedAt: now - 30_000, closedAt: now - 20_000, realizedSol: 0.25, costSol: 0.1, peakMult: 3.1, left: 0, fills: [{ t: now - 20_000, side: 'sell', sol: 0.25, tokens: 1, mult: 3.1, why: 'tp' }] };
    const lost: Position = { ...open, id: 'lost', openedAt: now - 40_000, closedAt: now - 10_000, realizedSol: 0.06, costSol: 0.1, peakMult: 1.2, left: 0, fills: [] };
    // the open coin runs up after the buy
    for (let i = 0; i < 10; i++) applyTrade(tok, trade(tok, 'buy', `R${i}`, 1, now + 1_000 + i));
    const s = commandStats([won, lost, open], { [tok.mint]: tok }, 150, now + 20_000);
    expect(s.realizedSol).toBeCloseTo(0.15 - 0.04, 9);
    const value = open.left * markPrice(tok, 150);
    expect(s.atRiskSol).toBeCloseTo(value, 9);
    expect(s.unrealizedSol).toBeCloseTo(value - 0.1, 9);
    expect(s.pnlSol).toBeCloseTo(0.11 + value - 0.1, 9);
    expect(s.open[0].mult).toBeGreaterThan(1);
    expect(s.equity.map((e) => +e.v.toFixed(4))).toEqual([0.15, 0.11, +(0.11 + value - 0.1).toFixed(4)]);
    expect(s).toMatchObject({ picks: 3, closed: 2, winRate: 0.5, bestMult: 3.1 });
    expect(s.spentToday).toBeCloseTo(0.3, 9);
    expect(s.lostToday).toBe(0);
    // newest first: the open trade's buy came after the winner's sell
    expect(s.tape.map((t) => t.side)).toEqual(['buy', 'sell']);
  });

  it('counts messages per second from a running counter', () => {
    const r = new Rate(3);
    expect([r.push(10), r.push(14), r.push(20), r.push(21)]).toEqual([0, 4, 6, 1]);
    expect(r.samples).toEqual([4, 6, 1]);
    expect(r.mean(2)).toBe(3.5);
  });
});

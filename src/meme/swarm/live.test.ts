import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmFill, SwarmLimits } from '../../desktop/bridge';
import { useMeme } from '../scanner';
import { markPrice, MILESTONES, newMilestone, type Position } from './book';
import { runner } from './fixtures';

// the desktop bridge, faked: the swarm wallet's buy and sell
const fake = vi.hoisted(() => ({
  buy: vi.fn(),
  sell: vi.fn(),
  wallet: vi.fn(async () => null),
  balance: vi.fn(),
}));
vi.mock('../../desktop/bridge', () => ({ desktop: { swarm: fake } }));

const { mergeSwarm, swarm, useSwarm } = await import('./swarm');

const LIMITS: SwarmLimits = { armed: true, maxBuySol: 0.05, dailySpendSol: 0.5, reserveSol: 0.02, slippageBps: 1500, priorityLamports: 300_000, sweepAboveSol: 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(armed = true) {
  const { tok, now } = runner(8);
  tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
  useMeme.setState({ tokens: { [tok.mint]: tok }, solUsd: 150 });
  useSwarm.setState({ mode: 'live', positions: [], outcomes: [], log: [], wallet: { address: 'Swarm111', limits: { ...LIMITS, armed }, spentToday: 0, sol: 1 } });
  return { tok, now };
}

describe('the swarm, trading live', () => {
  beforeEach(() => {
    fake.buy.mockReset();
    fake.sell.mockReset();
  });

  it('buys on its own within the wallet cap and books what the chain says was paid', async () => {
    const { tok, now } = setup();
    const tokens = 0.05 / markPrice(tok, 150);
    fake.buy.mockResolvedValue({ signature: 'BuyTx', via: 'Jupiter', solDelta: -0.0503, tokenDelta: String(Math.round(tokens * 1e6)), decimals: 6 } satisfies SwarmFill);
    swarm.tick(now);
    expect(fake.buy).toHaveBeenCalledWith(tok.mint, 0.05, undefined);
    await flush();
    const p = useSwarm.getState().positions[0];
    expect(p).toMatchObject({ mint: tok.mint, costSol: 0.0503, live: { decimals: 6, buyTx: 'BuyTx' } });
    expect(p.tokens).toBeCloseTo(tokens, 3);
    expect(p.entryPx).toBeCloseTo(0.0503 / tokens, 12);
    // a second tick does not buy it again
    swarm.tick(now + 2_000);
    expect(fake.buy).toHaveBeenCalledTimes(1);
  });

  it('does not buy unless the wallet is armed, and says why', () => {
    const { tok, now } = setup(false);
    swarm.tick(now);
    expect(fake.buy).not.toHaveBeenCalled();
    expect(useSwarm.getState().log.map((l) => l.text)).toContain(`${tok.symbol}: not bought — live trading is not armed (Wallet tab)`);
  });

  it('takes profit with a real sell of the right share, books the SOL received, and retries a failed sell later', async () => {
    const { tok, now } = setup();
    const px = markPrice(tok, 150);
    const p: Position = {
      id: 'live-1',
      mint: tok.mint,
      symbol: tok.symbol,
      openedAt: now - 60_000,
      costSol: 0.05,
      entryPx: px / 3.2,
      tokens: 1000,
      left: 1000,
      realizedSol: 0,
      peakMult: 1,
      peakAt: now - 60_000,
      tpDone: 0,
      fills: [],
      why: 'test',
      conviction: 80,
      live: { rawLeft: '1000000000', decimals: 6, buyTx: 'BuyTx' },
    };
    useSwarm.setState({ positions: [p], wallet: { ...useSwarm.getState().wallet!, limits: { ...LIMITS, maxBuySol: 0 } } });
    fake.buy.mockRejectedValue(new Error('cap'));
    fake.sell.mockRejectedValueOnce(new Error('RPC timeout'));
    swarm.tick(now);
    // half of what is left, in raw units
    expect(fake.sell).toHaveBeenCalledWith(tok.mint, '340000000', undefined);
    await flush();
    const q = useSwarm.getState().positions.find((x) => x.id === 'live-1')!;
    expect(q.retryAt).toBeGreaterThan(Date.now());
    expect(q.tpDone).toBe(0);
    // within the retry wait nothing is sent; after it the sell goes through
    swarm.tick(now + 1_000);
    expect(fake.sell).toHaveBeenCalledTimes(1);
    q.retryAt = 0;
    fake.sell.mockResolvedValueOnce({ signature: 'SellTx', via: 'pump.fun', solDelta: 0.054, tokenDelta: '-340000000', decimals: 6 } satisfies SwarmFill);
    swarm.tick(now + 2_000);
    await flush();
    const r = useSwarm.getState().positions.find((x) => x.id === 'live-1')!;
    expect(r).toMatchObject({ tpDone: 1, realizedSol: 0.054, left: 660, live: { rawLeft: '660000000' } });
    expect(r.closedAt).toBeUndefined();
    expect(r.milestones).toEqual([2]);
    expect(useSwarm.getState().log.map((l) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/sold live — 0\.0540 SOL back — take profit at 3×/), expect.stringMatching(/: 2× — position worth/)]));
  });
});

describe('the swarm, live, when things go wrong', () => {
  const held = (tok: ReturnType<typeof setup>['tok'], now: number, over: Partial<Position> = {}): Position => {
    const px = markPrice(tok, 150);
    return { id: 'live-2', mint: tok.mint, symbol: tok.symbol, openedAt: now - 60_000, costSol: 0.05, entryPx: px / 3.2, tokens: 1000, left: 1000, realizedSol: 0, peakMult: 1, peakAt: now - 60_000, tpDone: 0, fills: [], why: 'test', conviction: 80, live: { rawLeft: '1000000000', decimals: 6, buyTx: 'BuyTx' }, ...over };
  };
  beforeEach(() => {
    fake.buy.mockReset();
    fake.sell.mockReset();
  });

  it('books a sale the RPC did not report at the share asked for and the price now', async () => {
    const { tok, now } = setup();
    useSwarm.setState({ positions: [held(tok, now)], wallet: { ...useSwarm.getState().wallet!, limits: { ...LIMITS, maxBuySol: 0 } } });
    fake.buy.mockRejectedValue(new Error('cap'));
    fake.sell.mockResolvedValueOnce({ signature: 'S', via: 'Jupiter', solDelta: null, tokenDelta: null, decimals: null } satisfies SwarmFill);
    swarm.tick(now);
    await flush();
    const p = useSwarm.getState().positions.find((x) => x.id === 'live-2')!;
    expect(p).toMatchObject({ tpDone: 1, left: 660, live: { rawLeft: '660000000' } });
    expect(p.realizedSol).toBeCloseTo(340 * p.entryPx * 3.2, 6);
    expect(useSwarm.getState().log.map((l) => l.text)).toContain(`${tok.symbol}: the RPC did not report the sale's amounts yet — booked at the price now`);
  });

  it('after a restart: a sell that was in flight is managed again, and a coin already traded is not bought again', async () => {
    const { tok, now } = setup();
    const restored = mergeSwarm({ positions: [held(tok, now, { pending: true, retryAt: now + 9e9, closedAt: now - 1000 })] }, useSwarm.getState());
    expect(restored.positions[0]).toMatchObject({ pending: false, retryAt: undefined });
    useSwarm.setState({ positions: restored.positions, enabled: false });
    useSwarm.setState({ enabled: true });
    swarm.sync();
    swarm.tick(now);
    expect(fake.buy).not.toHaveBeenCalled();
    useSwarm.setState({ enabled: false });
    swarm.sync();
  });

  it('counts buys still in flight towards the most coins open at once', async () => {
    const { now } = setup();
    // three more clean runners: four picks in one tick
    const more = [runner(8, now - 8 * 60_000), runner(8, now - 8 * 60_000), runner(8, now - 8 * 60_000)];
    for (const m of more) m.tok.meta = { twitter: 'x', telegram: 't', fetchedAt: now };
    useMeme.setState((s) => ({ tokens: { ...s.tokens, ...Object.fromEntries(more.map((m) => [m.tok.mint, m.tok])) } }));
    useSwarm.setState((s) => ({ manager: { ...s.manager, maxOpen: 2 } }));
    fake.buy.mockReturnValue(new Promise(() => {})); // never settles: all still in flight
    swarm.tick(Math.max(now, ...more.map((m) => m.now)));
    expect(fake.buy.mock.calls.length).toBe(2);
    useSwarm.setState((s) => ({ manager: { ...s.manager, maxOpen: 4 } }));
  });
});

describe('progress milestones', () => {
  it('reports each multiple once, the highest one reached', () => {
    const p = { milestones: undefined } as unknown as Position;
    expect(newMilestone(p, 1.9)).toBeNull();
    expect(newMilestone(p, 2.4)).toBe(2);
    expect(newMilestone(p, 2.8)).toBeNull();
    expect(newMilestone(p, 11)).toBe(10);
    expect(p.milestones).toEqual([2, 5, 10]);
    expect(newMilestone(p, 120)).toBe(100);
    expect(MILESTONES).toContain(1000);
  });
});

import { describe, expect, it } from 'vitest';
import { ensureHistory, priceSeries, sketchSeries } from './history';
import { coin, T0, trade } from './swarm/fixtures';
import { applyTrade, type DexInfo } from './token';

const NOW = T0 + 30 * 3_600_000;
const dex = (over: Partial<DexInfo> = {}): DexInfo => ({
  pairAddress: 'Pool1',
  dexId: 'pumpswap',
  url: '',
  priceUsd: 0.0002,
  mcapUsd: 200_000,
  liquidityUsd: 50_000,
  volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
  txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
  change: { m5: 10, h1: 100, h6: 300, h24: 900 },
  pairCreatedAt: T0,
  boosts: 0,
  socials: [],
  ...over,
});

describe('Focus chart history', () => {
  it('a pool coin with no history yet still gets a line, from its price changes', () => {
    const tok = coin();
    tok.source = 'dex';
    tok.mcapSol = 1000;
    tok.dex = dex();
    const s = priceSeries(tok, NOW);
    expect(s.map((p) => Math.round(p.mcapSol))).toEqual([100, 250, 500, 909, 1000]);
    expect(s[0].t).toBe(NOW - 24 * 3_600_000);
    // a pool younger than a day: only the changes it has lived through
    tok.dex = dex({ pairCreatedAt: NOW - 2 * 3_600_000 });
    expect(sketchSeries(tok, NOW)).toHaveLength(3);
  });

  it('a coin just launched on the curve: its launch and now', () => {
    const tok = coin();
    applyTrade(tok, trade(tok, 'buy', 'A', 1, T0 + 5_000));
    const s = priceSeries(tok, T0 + 10_000);
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s[0]).toEqual({ t: T0, mcapSol: tok.firstMcapSol });
    expect(s[s.length - 1].mcapSol).toBe(tok.mcapSol);
  });

  it('a failed history download is retried after half a minute, a good one after two', async () => {
    const tok = coin();
    tok.source = 'dex';
    tok.dex = dex();
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new Error('429');
    };
    await expect(ensureHistory(tok, 150, fail)).rejects.toThrow('429');
    await ensureHistory(tok, 150, fail).catch(() => undefined);
    expect(calls).toBe(1);
    tok.historyAt! -= 31_000;
    await ensureHistory(tok, 150, async () => ({ data: { attributes: { ohlcv_list: [[T0 / 1000, 0, 0, 0, 0.0001], [T0 / 1000 + 60, 0, 0, 0, 0.0002]] } } }));
    expect(tok.history).toHaveLength(2);
    const at = tok.historyAt!;
    tok.historyAt = at - 31_000;
    await ensureHistory(tok, 150, fail).catch(() => undefined);
    expect(calls).toBe(1);
  });
});

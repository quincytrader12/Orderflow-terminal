import { describe, expect, it } from 'vitest';
import { parseMiniTicker } from './solTicker';

describe('SOL ticker', () => {
  it("reads Binance's 24 h mini-ticker and ignores anything else", () => {
    expect(parseMiniTicker({ e: '24hrMiniTicker', s: 'SOLUSDT', c: '187.42', o: '180.10', h: '190.00', l: '178.55', v: '2400000', q: '448000000' })).toEqual({ price: 187.42, open: 180.1, high: 190, low: 178.55, volUsd: 448_000_000 });
    expect(parseMiniTicker({ result: null, id: 1 })).toBeNull();
    expect(parseMiniTicker({ e: '24hrMiniTicker', c: '0' })).toBeNull();
    expect(parseMiniTicker(null)).toBeNull();
  });
});

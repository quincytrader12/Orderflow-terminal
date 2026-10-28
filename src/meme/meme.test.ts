import { describe, expect, it } from 'vitest';
import { dexListings, dexTokens, parsePair, solPriceUsd, SOL_MINT } from './dexscreener';
import { curveProgress, mcapSolAt, multipleToGraduate, parsePumpMessage, PUMP_MCAP_SOL_END, PUMP_MCAP_SOL_START, PUMP_V_TOKENS0, PUMP_V_TOKENS_END, pumpSub, vTokensAtMcap, type PumpCreate, type PumpTrade } from './pump';
import { checkSafety } from './safety';
import { assess, roomTo } from './score';
import { applyTrade, devActivity, flow, progressGain, stageOf, tokenFromCreate, type MemeToken } from './token';

const T0 = 1_800_000_000_000;
const DEV = 'Dev1111111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111pump';

const createMsg = {
  signature: 'sig0',
  mint: MINT,
  traderPublicKey: DEV,
  txType: 'create',
  initialBuy: 35_000_000,
  solAmount: 1,
  bondingCurveKey: 'Curve11111111111111111111111111111111111111',
  vTokensInBondingCurve: 1_038_000_000,
  vSolInBondingCurve: 31,
  marketCapSol: 28.8,
  name: 'Frog Coin',
  symbol: 'FROG',
  uri: 'https://ipfs.io/ipfs/x',
  pool: 'pump',
};

function coin(): MemeToken {
  return tokenFromCreate(parsePumpMessage(createMsg, T0) as PumpCreate);
}

/** A trade moving the curve by `sol` (constant product), as PumpPortal reports it. */
function trade(tok: MemeToken, side: 'buy' | 'sell', wallet: string, sol: number, t: number): PumpTrade {
  const k = tok.vSol * tok.vTokens;
  const vSol = tok.vSol + (side === 'buy' ? sol : -sol);
  const vTokens = k / vSol;
  const tokens = Math.abs(tok.vTokens - vTokens);
  return { kind: 'trade', mint: tok.mint, side, wallet, sol, tokens, balanceAfter: null, vTokens, vSol, mcapSol: (vSol / vTokens) * 1e9, pool: 'pump', signature: `s${t}${wallet}`, t };
}

describe('pump.fun bonding curve', () => {
  it('launches near 28 SOL and graduates near 411 SOL — about 14.7× along the curve', () => {
    expect(PUMP_MCAP_SOL_START).toBeCloseTo(27.96, 2);
    expect(PUMP_MCAP_SOL_END).toBeCloseTo(410.9, 1);
    expect(curveProgress(PUMP_V_TOKENS0)).toBe(0);
    expect(curveProgress(PUMP_V_TOKENS_END)).toBe(1);
    expect(curveProgress((PUMP_V_TOKENS0 + PUMP_V_TOKENS_END) / 2)).toBeCloseTo(0.5, 9);
    expect(multipleToGraduate(PUMP_MCAP_SOL_START)).toBeCloseTo(14.7, 1);
    expect(multipleToGraduate(500)).toBe(1);
    expect(vTokensAtMcap(mcapSolAt(600_000_000))).toBeCloseTo(600_000_000, 0);
  });

  it('parses PumpPortal launches, trades and migrations; ignores acknowledgements', () => {
    const c = parsePumpMessage(createMsg, T0) as PumpCreate;
    expect(c).toMatchObject({ kind: 'create', mint: MINT, symbol: 'FROG', creator: DEV, initialBuySol: 1, initialBuyTokens: 35_000_000, bondingCurve: createMsg.bondingCurveKey, mcapSol: 28.8, t: T0 });
    expect(parsePumpMessage({ mint: MINT, txType: 'sell', traderPublicKey: 'W', solAmount: 0.5, tokenAmount: 1000, newTokenBalance: 0, vTokensInBondingCurve: 1e9, vSolInBondingCurve: 32, marketCapSol: 32 }, T0)).toMatchObject({ kind: 'trade', side: 'sell', wallet: 'W', sol: 0.5, balanceAfter: 0 });
    expect(parsePumpMessage({ mint: MINT, txType: 'migrate', pool: 'pump-amm', signature: 'm' }, T0)).toEqual({ kind: 'migrate', mint: MINT, pool: 'pump-amm', signature: 'm', t: T0 });
    expect(parsePumpMessage({ message: 'Successfully subscribed to token creation events.' })).toBeNull();
    expect(JSON.parse(pumpSub.trades(['a', 'b']))).toEqual({ method: 'subscribeTokenTrade', keys: ['a', 'b'] });
  });
});

describe('order flow on a coin', () => {
  it('counts buys, sells, wallets, the top buyer, churn and the creator', () => {
    const tok = coin();
    applyTrade(tok, trade(tok, 'buy', 'A', 2, T0 + 10_000));
    applyTrade(tok, trade(tok, 'buy', 'B', 1, T0 + 20_000));
    applyTrade(tok, trade(tok, 'buy', 'A', 2, T0 + 30_000));
    applyTrade(tok, trade(tok, 'sell', 'A', 1, T0 + 40_000));
    applyTrade(tok, trade(tok, 'sell', DEV, 0.5, T0 + 50_000));
    const f = flow(tok, T0 + 60_000, 300);
    expect(f).toMatchObject({ buys: 3, sells: 2, buySol: 5, sellSol: 1.5, netSol: 3.5, buyers: 2, churners: 1 });
    expect(f.topBuyerShare).toBeCloseTo(0.8, 9);
    expect(flow(tok, T0 + 60_000, 25)).toMatchObject({ buys: 0, sells: 2 });
    expect(tok.trades.at(-1)!.dev).toBe(true);
    const d = devActivity(tok);
    expect(d.sold).toBe(true);
    expect(d.soldShare).toBeGreaterThan(0);
    expect(d.soldShare).toBeLessThan(1);
    expect(progressGain(tok, T0 + 60_000, 300)).toBeGreaterThan(0);
  });

  it('moves to the final stretch at 70 % of the curve, and to migrated after migration', () => {
    const tok = coin();
    expect(stageOf(tok)).toBe('new');
    tok.vTokens = PUMP_V_TOKENS0 - 0.75 * 793_100_000;
    expect(stageOf(tok)).toBe('final');
    tok.migrated = true;
    expect(stageOf(tok)).toBe('migrated');
  });
});

describe('reading a coin', () => {
  it('an early runner: many wallets, strong net buying, curve filling fast, creator holding', () => {
    const tok = coin();
    let t = T0 + 30_000;
    for (let i = 0; i < 45; i++) {
      applyTrade(tok, trade(tok, 'buy', `W${i}`, 0.4 + (i % 5) * 0.1, (t += 4_000)));
      if (i % 6 === 5) applyTrade(tok, trade(tok, 'sell', `S${i}`, 0.2, (t += 2_000)));
    }
    tok.safety = { checkedAt: t, mintRevoked: true, freezeRevoked: true, top10: 0.18, top1: 0.04 };
    const a = assess(tok, t + 1000, 150);
    expect(a.heat).toBeGreaterThanOrEqual(60);
    expect(a.tags).toContain('Early runner');
    expect(a.flags.filter((f) => f.level !== 'info')).toEqual([]);
    expect(a.summary).toMatch(/^45 wallets bought in 5 min · \+[\d.]+ SOL net · curve \d+% · creator still holding · [\d.]+× to graduate/);
    expect(a.mcapUsd).toBeCloseTo(tok.mcapSol * 150, 6);
  });

  it('the creator dumping kills the heat and is flagged; so are unrevoked authorities and whale holders', () => {
    const tok = coin();
    let t = T0 + 30_000;
    for (let i = 0; i < 30; i++) applyTrade(tok, trade(tok, 'buy', `W${i}`, 0.5, (t += 3_000)));
    const before = assess(tok, t, 150).heat;
    const sell = trade(tok, 'sell', DEV, 1.5, (t += 1_000));
    sell.tokens = 35_000_000;
    applyTrade(tok, sell);
    tok.safety = { checkedAt: t, mintRevoked: false, freezeRevoked: false, top10: 0.62, top1: 0.2 };
    const a = assess(tok, t + 1000, 150);
    expect(a.heat).toBeLessThan(before * 0.4);
    expect(a.flags.map((f) => f.text)).toEqual([
      'The creator sold their whole launch bag',
      'Mint authority not revoked — more tokens can be printed',
      'Freeze authority not revoked — your tokens could be frozen (honeypot risk)',
      'Top 10 wallets hold 62% of the supply',
      'One wallet holds 20% of the supply',
    ]);
    expect(a.tags).not.toContain('Early runner');
  });

  it('a pool coin is read from DexScreener: volume surge, buy share, momentum, liquidity', () => {
    const pair = parsePair({
      pairAddress: 'P',
      dexId: 'pumpswap',
      url: 'https://dexscreener.com/solana/p',
      priceUsd: '0.0012',
      marketCap: 1_200_000,
      liquidity: { usd: 140_000 },
      volume: { m5: 60_000, h1: 200_000, h6: 600_000, h24: 900_000 },
      txns: { m5: { buys: 180, sells: 70 }, h1: { buys: 900, sells: 600 }, h24: { buys: 5000, sells: 4000 } },
      priceChange: { m5: 12, h1: 45, h6: 80, h24: 300 },
      pairCreatedAt: T0 - 3 * 3_600_000,
      info: { imageUrl: 'img', websites: [{ url: 'https://frog.xyz' }], socials: [{ type: 'twitter', url: 'https://x.com/frog' }] },
      boosts: { active: 10 },
    });
    const tok: MemeToken = { ...coin(), source: 'dex', migrated: true, dex: pair, trades: [] };
    const a = assess(tok, T0, 150);
    expect(a.heat).toBeGreaterThanOrEqual(70);
    expect(a.tags).toEqual(expect.arrayContaining(['Volume surge', 'Boosted']));
    expect(a.mcapUsd).toBe(1_200_000);
    expect(a.summary).toBe('250 trades in 5 min (72% buys) · volume 3.6× its hourly pace · +12% in 5 min');
    expect(roomTo(a.mcapUsd, 12_000_000)).toBe(10);
  });
});

describe('DexScreener', () => {
  const get = (routes: Record<string, unknown>) => async (url: string) => {
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return v;
    throw new Error(`no route ${url}`);
  };

  it('keeps Solana listings, boosted first, one per mint', async () => {
    const rows = await dexListings(
      get({
        'token-profiles/latest': [
          { chainId: 'solana', tokenAddress: 'A', icon: 'ia', links: [{ type: 'twitter', url: 'https://x.com/a' }] },
          { chainId: 'ethereum', tokenAddress: '0x1' },
        ],
        'token-boosts/latest': [{ chainId: 'solana', tokenAddress: 'A', totalAmount: 50 }, { chainId: 'solana', tokenAddress: 'B', amount: 10 }],
      }),
    );
    expect(rows.map((r) => [r.mint, r.boosted, r.boostAmount])).toEqual([
      ['A', true, 50],
      ['B', true, 10],
    ]);
    expect(rows[0].links).toEqual([{ type: 'twitter', url: 'https://x.com/a' }]);
  });

  it('picks each coin’s deepest pool, and SOL’s price from its deepest stablecoin pool', async () => {
    const toks = await dexTokens(
      get({
        'tokens/v1/solana/A': [
          { baseToken: { address: 'A', name: 'Aa', symbol: 'AA' }, liquidity: { usd: 5_000 }, dexId: 'raydium' },
          { baseToken: { address: 'A', name: 'Aa', symbol: 'AA' }, liquidity: { usd: 90_000 }, dexId: 'pumpswap' },
        ],
      }),
      ['A'],
    );
    expect(toks).toHaveLength(1);
    expect(toks[0].pair.dexId).toBe('pumpswap');
    const px = await solPriceUsd(
      get({
        [`tokens/v1/solana/${SOL_MINT}`]: [
          { baseToken: { address: SOL_MINT }, quoteToken: { symbol: 'USDC' }, priceUsd: '150.1', liquidity: { usd: 9e6 } },
          { baseToken: { address: SOL_MINT }, quoteToken: { symbol: 'USDT' }, priceUsd: '149.0', liquidity: { usd: 1e6 } },
          { baseToken: { address: SOL_MINT }, quoteToken: { symbol: 'BONK' }, priceUsd: '170', liquidity: { usd: 5e7 } },
        ],
      }),
    );
    expect(px).toBe(150.1);
  });
});

describe('on-chain safety', () => {
  it('reads the authorities and holder concentration, leaving out the curve and pool vaults', async () => {
    const calls: string[] = [];
    const rpc = async (method: string) => {
      calls.push(method);
      if (method === 'getAccountInfo') return { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: '1000000000000000', decimals: 6 } } } } };
      if (method === 'getTokenLargestAccounts')
        return {
          value: [
            { address: 'acc-curve', uiAmount: 700_000_000 },
            { address: 'acc-pool', uiAmount: 100_000_000 },
            { address: 'acc-whale', uiAmount: 60_000_000 },
            { address: 'acc-2', uiAmount: 20_000_000 },
          ],
        };
      if (method === 'getMultipleAccounts')
        return {
          value: [
            { data: { parsed: { info: { owner: 'CurvePda' } } } },
            { data: { parsed: { info: { owner: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' } } } },
            { data: { parsed: { info: { owner: 'Whale' } } } },
            { data: { parsed: { info: { owner: 'Someone' } } } },
          ],
        };
      throw new Error(method);
    };
    const s = await checkSafety(rpc, MINT, ['CurvePda'], T0);
    expect(s).toEqual({ checkedAt: T0, mintRevoked: true, freezeRevoked: true, top10: 0.08, top1: 0.06 });
    expect(calls).toEqual(['getAccountInfo', 'getTokenLargestAccounts', 'getMultipleAccounts']);
  });

  it('reports a failed check instead of throwing', async () => {
    const s = await checkSafety(async () => ({ value: null }), MINT, [], T0);
    expect(s.error).toBe('not a token mint');
    expect(s.mintRevoked).toBeNull();
  });
});

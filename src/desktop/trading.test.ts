import { describe, expect, it } from 'vitest';
import { describeOrder, estimateValue, pickSymbol, unifiedCandidates, useTicket } from './trading';

const info = { base: 'BTC', quote: 'USDT', exchange: 'Bybit', sandbox: true, last: 50_000, bid: 49_990, ask: 50_010, inverse: false };

describe('order ticket helpers', () => {
  it('maps the chart instrument to unified CCXT symbols', () => {
    expect(unifiedCandidates({ venue: 'binancef', symbol: 'BTCUSDT', base: 'BTC' })[0]).toBe('BTC/USDT:USDT');
    expect(unifiedCandidates({ venue: 'coinbase', symbol: 'BTC-USD', base: 'BTC' })[0]).toBe('BTC/USD');
    expect(unifiedCandidates({ venue: 'okx', symbol: 'ETH-USDT-SWAP', base: 'ETH' })[0]).toBe('ETH/USDT:USDT');
    expect(unifiedCandidates({ venue: 'ccxt', symbol: 'kucoin::SOL/USDT', base: 'SOL' })).toEqual(['SOL/USDT']);
    const c = unifiedCandidates({ venue: 'hyperliquid', symbol: 'BTC', base: 'BTC' });
    expect(pickSymbol(c, ['BTC/USDC:USDC', 'BTC/USDT'])).toBe('BTC/USDC:USDC');
    expect(pickSymbol(c, ['ETH/USDT'])).toBeNull();
  });

  it('estimates value and describes the order for confirmation', () => {
    const req = { symbol: 'BTC/USDT:USDT', side: 'buy' as const, type: 'limit' as const, sizeMode: 'base' as const, size: 0.02, price: 49_000, postOnly: true, leverage: 5 };
    expect(estimateValue(req, info)).toBe(980);
    expect(estimateValue({ ...req, type: 'market' }, info)).toBeCloseTo(1000.2);
    expect(estimateValue({ ...req, sizeMode: 'quote', size: 250 }, info)).toBe(250);
    const text = describeOrder(req, info);
    expect(text).toContain('BUY 0.02 BTC BTC/USDT:USDT limit @ 49,000');
    expect(text).toContain('(post-only, 5×)');
    expect(text).toContain('on Bybit TESTNET');
  });

  it('hands DOM prices to the ticket', () => {
    const n = useTicket.getState().nonce;
    useTicket.getState().send(123.5, 'sell');
    expect(useTicket.getState()).toMatchObject({ price: 123.5, side: 'sell', nonce: n + 1 });
  });
});

import { create } from 'zustand';
import { fmtUsd } from '../core/format';
import type { Instrument } from '../core/types';
import { adapter } from '../exchanges';
import type { MarketInfo, OrderRequest } from './bridge';

/** Price handed from the DOM ladder (or any panel) to the order ticket. */
export const useTicket = create<{ price: number | null; side: 'buy' | 'sell' | null; nonce: number; send(price: number, side?: 'buy' | 'sell'): void }>((set) => ({
  price: null,
  side: null,
  nonce: 0,
  send: (price, side) => set((s) => ({ price, side: side ?? null, nonce: s.nonce + 1 })),
}));

/** Quote currency guessed from a venue-native symbol (BTCUSDT, BTC-USD, BTC). */
function quoteOf(inst: Instrument): string | null {
  const m = /(USDT|USDC|USD|EUR)$/.exec(inst.symbol.replace(/[-_/]?(SWAP|PERP)$/i, '').replace(/[-_/]/g, ''));
  return m ? m[1] : null;
}

/**
 * Unified CCXT symbols that could match the chart's instrument, best first.
 * The ticket uses the first one the key's exchange actually lists.
 */
export function unifiedCandidates(inst: Instrument): string[] {
  if (inst.venue === 'ccxt') return [inst.symbol.slice(inst.symbol.indexOf('::') + 2)];
  const b = inst.base.toUpperCase();
  let perp = false;
  try {
    perp = adapter(inst.venue).kind === 'perp';
  } catch {
    /* unknown venue */
  }
  const q = quoteOf(inst);
  const quotes = [...new Set([q, 'USDT', 'USDC', 'USD'].filter(Boolean) as string[])];
  const linear = quotes.map((x) => `${b}/${x}:${x}`);
  const spot = quotes.map((x) => `${b}/${x}`);
  return perp ? [...linear, `${b}/USD:${b}`, ...spot] : [...spot, ...linear];
}

export function pickSymbol(candidates: string[], listed: Iterable<string>): string | null {
  const set = listed instanceof Set ? listed : new Set(listed);
  return candidates.find((c) => set.has(c)) ?? null;
}

const TYPE_LABEL: Record<OrderRequest['type'], string> = { market: 'Market', limit: 'Limit', 'stop-market': 'Stop', 'stop-limit': 'Stop limit' };

/** Price the order is expected to execute at, for estimates. */
export function execPrice(req: Pick<OrderRequest, 'type' | 'price' | 'triggerPrice' | 'side'>, info: Pick<MarketInfo, 'last' | 'bid' | 'ask'>): number {
  if (req.type === 'limit' || req.type === 'stop-limit') return req.price ?? NaN;
  if (req.type === 'stop-market') return req.triggerPrice ?? NaN;
  return (req.side === 'buy' ? info.ask : info.bid) ?? info.last;
}

/** Rough order value in quote currency (the main process recomputes it exactly). */
export function estimateValue(req: OrderRequest, info: Pick<MarketInfo, 'last' | 'bid' | 'ask' | 'inverse'>): number {
  const px = execPrice(req, info);
  if (!(req.size > 0) || !(px > 0)) return NaN;
  return req.sizeMode === 'quote' ? req.size : req.size * px;
}

/** Exactly the number that was entered, with thousands separators. */
const plain = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 10 }));

/** One-line human description used in the confirmation and the Telegram note. */
export function describeOrder(req: OrderRequest, info: Pick<MarketInfo, 'base' | 'quote' | 'exchange' | 'sandbox' | 'last' | 'bid' | 'ask' | 'inverse'>): string {
  const size = req.sizeMode === 'quote' ? `${plain(req.size)} ${info.quote} of ${info.base}` : `${plain(req.size)} ${info.base}`;
  const at =
    req.type === 'market'
      ? 'at market'
      : req.type === 'limit'
        ? `@ ${plain(req.price)}`
        : req.type === 'stop-market'
          ? `stop ${plain(req.triggerPrice)}`
          : `stop ${plain(req.triggerPrice)} → limit ${plain(req.price)}`;
  const flags = [req.reduceOnly && 'reduce-only', req.postOnly && 'post-only', req.tif && req.tif !== 'GTC' && req.tif, req.leverage && `${req.leverage}×`].filter(Boolean);
  const v = estimateValue(req, info);
  return `${req.side.toUpperCase()} ${size} ${req.symbol} ${TYPE_LABEL[req.type].toLowerCase()} ${at}${flags.length ? ` (${flags.join(', ')})` : ''} ≈ ${isFinite(v) ? fmtUsd(v) : '—'} on ${info.exchange}${info.sandbox ? ' TESTNET' : ''}`;
}

export { TYPE_LABEL };

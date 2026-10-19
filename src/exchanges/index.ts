import type { VenueId } from '../core/types';
import type { VenueAdapter } from './adapter';
import { binanceFutures, binanceSpot } from './binance';
import { bitfinex } from './bitfinex';
import { bitget } from './bitget';
import { bybit } from './bybit';
import { ccxtVenue } from './ccxt';
import { coinbase } from './coinbase';
import { hyperliquid } from './hyperliquid';
import { kraken } from './kraken';
import { okx } from './okx';
import { simulator } from './simulator';

export const ADAPTERS: Record<VenueId, VenueAdapter> = {
  binancef: binanceFutures,
  binance: binanceSpot,
  bybit,
  okx,
  hyperliquid,
  coinbase,
  kraken,
  bitget,
  bitfinex,
  ccxt: ccxtVenue,
  sim: simulator,
};

export const VENUE_IDS = Object.keys(ADAPTERS) as VenueId[];

export function adapter(id: VenueId): VenueAdapter {
  return ADAPTERS[id];
}

export const POPULAR_BASES = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE', 'SUI', 'LINK', 'AVAX', 'ADA', 'LTC'];

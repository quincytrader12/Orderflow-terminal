// Shared domain types. All quantities are normalised to base-asset units and
// all timestamps are epoch milliseconds.

export type VenueId =
  | 'binancef'
  | 'binance'
  | 'bybit'
  | 'okx'
  | 'hyperliquid'
  | 'coinbase'
  | 'kraken'
  | 'bitget'
  | 'bitfinex'
  | 'ccxt'
  | 'sim';

export type Side = 'buy' | 'sell';

export interface Instrument {
  venue: VenueId;
  /** Venue-native symbol, e.g. BTCUSDT, BTC-USDT-SWAP, BTC */
  symbol: string;
  /** Canonical base asset, e.g. BTC */
  base: string;
}

export interface Trade {
  venue: VenueId;
  price: number;
  qty: number;
  /** Aggressor side: buy = taker lifted the ask */
  side: Side;
  time: number;
}

export interface Liquidation {
  venue: VenueId;
  symbol: string;
  /** Side of the position that was liquidated */
  position: 'long' | 'short';
  price: number;
  qty: number;
  time: number;
}

export interface BookLevel {
  price: number;
  qty: number;
}

export interface BookUpdate {
  /** true: replace the whole book; false: apply deltas (qty 0 removes) */
  snapshot: boolean;
  bids: [number, number][];
  asks: [number, number][];
  time: number;
}

export interface MarketStats {
  venue: VenueId;
  time: number;
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingTime?: number;
  /** Funding interval in hours (8 for most, 1 for Hyperliquid) */
  fundingIntervalH?: number;
  openInterest?: number;
  openInterestUsd?: number;
  longShortRatio?: number;
  longAccount?: number;
  shortAccount?: number;
  volume24hUsd?: number;
  change24hPct?: number;
  high24h?: number;
  low24h?: number;
  last?: number;
}

export interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** taker buy base volume when the venue provides it */
  buyVolume?: number;
}

export interface Ticker {
  venue: VenueId;
  symbol: string;
  base: string;
  last: number;
  change24hPct: number;
  volume24hUsd: number;
  fundingRate?: number;
  openInterestUsd?: number;
  high24h?: number;
  low24h?: number;
}

export interface NewsItem {
  id: string;
  time: number;
  title: string;
  source: string;
  url?: string;
  coins: string[];
}

export interface OptionTrade {
  id: string;
  time: number;
  instrument: string;
  underlying: string;
  expiry: number;
  strike: number;
  kind: 'C' | 'P';
  side: Side;
  /** contracts (1 contract = 1 underlying on Deribit) */
  amount: number;
  /** premium per contract in underlying units */
  price: number;
  indexPrice: number;
  premiumUsd: number;
  iv?: number;
  block: boolean;
  liquidation: boolean;
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface VenueStatus {
  state: ConnState;
  msgs: number;
  lastMsg: number;
  error?: string;
  latencyMs?: number;
}

export const INTERVALS: Record<string, number> = {
  '1s': 1_000,
  '5s': 5_000,
  '15s': 15_000,
  '30s': 30_000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const TIME_RANGES: Record<string, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '12h': 43_200_000,
  '24h': 86_400_000,
};

import type { Kline } from '../core/types';
import type { TokenInfo, WalletActivity, WalletBalances } from '../shared/solana';

/** Shapes returned by the desktop main process (electron/*.mjs). */
export interface SecretRecord {
  id: string;
  label: string;
  kind: SecretKind;
  exchange: string | null;
  meta: { fields: Record<string, string> };
  created: number;
  updated: number;
  backend: 'os' | 'local' | 'browser';
}

export type SecretKind = 'exchange' | 'solana-rpc' | 'telegram' | 'api';

export interface SecretInput {
  id?: string;
  label: string;
  kind: SecretKind;
  exchange?: string | null;
  /** null removes a field; empty string keeps the stored value */
  fields: Record<string, string | null>;
}

export interface CcxtExchangeInfo {
  id: string;
  name: string;
  pro: boolean;
  credentials: string[];
}

export interface CcxtMarket {
  symbol: string;
  base: string;
  quote: string;
  type: string;
  contract: boolean;
  linear?: boolean;
}

export interface CcxtTicker {
  symbol: string;
  last: number;
  change24hPct: number;
  volume24hUsd: number;
  high24h?: number;
  low24h?: number;
}

export type CcxtEvent =
  | { sid: string; kind: 'status'; state: 'connecting' | 'open' | 'error' | 'closed'; error?: string }
  | { sid: string; kind: 'trades'; trades: { p: number; q: number; s: 'buy' | 'sell'; t: number }[] }
  | { sid: string; kind: 'book'; bids: [number, number][]; asks: [number, number][]; t: number }
  | { sid: string; kind: 'stats'; stats: Record<string, number> };

export interface AccountSnapshot {
  exchange: string;
  balances: { currency: string; total: number; free: number | null; used: number | null }[];
  positions: { symbol: string; side: string; contracts: number; notional: number; entryPrice: number; markPrice: number; unrealizedPnl: number; leverage: number; liquidationPrice: number }[];
  openOrders: { id: string; symbol: string; side: string; type: string; price: number; amount: number; filled: number; status: string; time: number }[];
  myTrades: { id: string; symbol: string; side: string; price: number; amount: number; cost: number; fee: number | null; feeCurrency: string | null; time: number }[];
  errors: Record<string, string>;
}

export type OrderType = 'market' | 'limit' | 'stop-market' | 'stop-limit';
export type TimeInForce = 'GTC' | 'IOC' | 'FOK';

export interface OrderRequest {
  /** unified CCXT symbol, e.g. BTC/USDT or BTC/USDT:USDT */
  symbol: string;
  side: 'buy' | 'sell';
  type: OrderType;
  /** size in base units, or in quote (USD) */
  sizeMode: 'base' | 'quote';
  size: number;
  price?: number;
  triggerPrice?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  tif?: TimeInForce;
  leverage?: number;
}

export interface OrderResult {
  id: string | null;
  status: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: OrderType;
  amount: number;
  price: number | null;
  filled: number | null;
  notionalUsd: number;
  exchange: string;
  sandbox: boolean;
}

export interface TradingLimits {
  maxOrderUsd: number;
  maxOrdersPerMinute: number;
  maxPriceDeviationPct: number;
}

export interface MarketInfo {
  exchange: string;
  exchangeId: string;
  label: string;
  sandbox: boolean;
  trading: boolean;
  symbol: string;
  base: string;
  quote: string;
  settle: string | null;
  type: string;
  contract: boolean;
  inverse: boolean;
  contractSize: number;
  minAmount: number | null;
  minCost: number | null;
  last: number;
  bid: number | null;
  ask: number | null;
  maker: number | null;
  taker: number | null;
  canLeverage: boolean;
  stops: boolean;
  freeBase: number | null;
  freeQuote: number | null;
  limits: TradingLimits;
}

export interface OrderLogRow {
  id: number;
  t: number;
  action: 'place' | 'cancel' | 'cancel-all' | 'close';
  exchange: string | null;
  sandbox: number;
  symbol: string | null;
  side: string | null;
  type: string | null;
  amount: number | null;
  price: number | null;
  trigger_price: number | null;
  notional_usd: number | null;
  status: 'placed' | 'rejected' | 'error' | 'cancelled';
  order_id: string | null;
  message: string | null;
}

export interface DbInfo {
  file: string;
  size: number;
  trades: number;
  secrets: number;
  wallets: number;
  retentionDays: number;
}

export interface WalletRecord {
  address: string;
  chain: string;
  label: string | null;
  verified: number;
  connected_at: number;
}

export interface NovusApi {
  desktop: true;
  app: { info(): Promise<{ version: string; platform: string; userData: string; db: DbInfo; vaultBackend: string; retentionDays: number }>; openExternal(url: string): Promise<void> };
  net: { fetchJson<T = any>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T> };
  vault: {
    list(): Promise<SecretRecord[]>;
    save(rec: SecretInput): Promise<string>;
    remove(id: string): Promise<void>;
    copy(id: string, field: string): Promise<boolean>;
    test(id: string): Promise<{ ok: boolean; exchange: string; assets: number }>;
  };
  ccxt: {
    exchanges(): Promise<CcxtExchangeInfo[]>;
    markets(id: string): Promise<CcxtMarket[]>;
    ohlcv(id: string, symbol: string, tf: string, limit: number): Promise<Kline[]>;
    tickers(id: string): Promise<CcxtTicker[]>;
    ticker(id: string, symbol: string): Promise<CcxtTicker>;
    account(secretId: string, symbol?: string): Promise<AccountSnapshot>;
    subscribe(sid: string, id: string, symbol: string): Promise<boolean>;
    unsubscribe(sid: string): Promise<void>;
    onEvent(fn: (e: CcxtEvent) => void): () => void;
  };
  trade: {
    marketInfo(secretId: string, symbol: string): Promise<MarketInfo>;
    place(secretId: string, req: OrderRequest): Promise<OrderResult>;
    cancel(secretId: string, orderId: string, symbol: string): Promise<boolean>;
    cancelAll(secretId: string, symbol?: string): Promise<number>;
    close(secretId: string, symbol: string, side?: string): Promise<{ id: string | null; side: string; amount: number }>;
    limits(): Promise<TradingLimits>;
    setLimits(l: Partial<TradingLimits>): Promise<TradingLimits>;
    log(limit?: number): Promise<OrderLogRow[]>;
  };
  db: {
    info(): Promise<DbInfo>;
    record(venue: string, symbol: string, rows: { p: number; q: number; s: 'buy' | 'sell'; t: number }[]): Promise<number>;
    query(venue: string, symbol: string, from: number, to: number): Promise<{ time: number; price: number; qty: number; side: 'buy' | 'sell' }[]>;
    stats(): Promise<{ venue: string; symbol: string; n: number; first: number; last: number }[]>;
    prune(days?: number): Promise<number>;
    deleteInstrument(venue: string, symbol: string): Promise<number>;
    vacuum(): Promise<void>;
    setRetention(days: number): Promise<void>;
    exportCsv(venue: string, symbol: string): Promise<{ path: string; rows: number } | null>;
  };
  wallet: {
    connectPhantom(): Promise<{ address: string; verified: boolean }>;
    watch(address: string): Promise<boolean>;
    list(): Promise<WalletRecord[]>;
    remove(address: string): Promise<void>;
    balances(address: string, rpcSecretId?: string): Promise<WalletBalances>;
    tokenInfo(mints: string[]): Promise<TokenInfo>;
    activity(address: string, rpcSecretId?: string): Promise<WalletActivity[]>;
  };
  telegram: {
    me(id: string): Promise<{ username: string; name: string }>;
    detect(id: string): Promise<{ id: string; title: string }>;
    send(id: string, html: string): Promise<void>;
    /** start answering commands for this bot key, or stop with null */
    commands(id: string | null): Promise<boolean>;
    setStatus(snap: { price: string; status: string }): Promise<void>;
  };
}

/** Present only inside the Electron desktop app. */
export const desktop: NovusApi | undefined = typeof window !== 'undefined' ? (window as unknown as { novus?: NovusApi }).novus : undefined;
export const isDesktop = Boolean(desktop);

export class DesktopOnlyError extends Error {
  constructor(feature: string) {
    super(`${feature} runs in the Novus Ordo desktop app (browsers block exchange APIs and local databases).`);
  }
}

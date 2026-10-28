import type { Kline } from '../core/types';
import type { MainReportData, ReportKind } from '../shared/report';
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
  baseQty: number;
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

/** Result of testing an exchange key (read-only; no orders). */
export interface KeyTest {
  ok: boolean;
  exchange: string;
  /** where it was tested, and how the key is saved */
  environment: 'live' | 'testnet';
  saved: 'live' | 'testnet';
  assets: number;
  futures: boolean | null;
  futuresError: string | null;
  /** Binance live keys: what the key may do */
  permissions: { reading: boolean; spotTrading: boolean; futures: boolean; withdrawals: boolean; ipRestricted: boolean } | null;
  /** the public IP the exchange sees */
  ip: string | null;
}

export interface AmtParams {
  profileMinutes: number;
  valueAreaPct: number;
  binBps: number;
  sessionHours: number;
  warmupMinutes: number;
  flowSec: number;
  deltaThreshold: number;
  intensityMin: number;
  useBook: boolean;
  bookBandBps: number;
  bookImbalanceMin: number;
  maxSpreadBps: number;
  probeBins: number;
  acceptSec: number;
  rejectSec: number;
  reentrySec: number;
  style: 'scalp' | 'intraday' | 'orderflow' | 'adaptive' | 'trend';
  setups: { fade: boolean; breakout: boolean; reentry: boolean; ibBreakout: boolean; priorAccept: boolean; priorReject: boolean; absorption: boolean; continuation: boolean; sweep: boolean };
  ibMinutes: number;
  ibAcceptMin: number;
  priorAcceptMin: number;
  priorRejectMin: number;
  intradayFlowSec: number;
  intradayDelta: number;
  ibTargetX: number;
  maxTradesPerSession: number;
  flatBeforeCloseMin: number;
  trailAtR: number;
  // order-flow hybrid
  barSec: number;
  fpBinBps: number;
  imbalanceRatio: number;
  stackMin: number;
  contRetestSec: number;
  absorbSec: number;
  absorbX: number;
  absorbDelta: number;
  absorbMaxBins: number;
  absorbConfirmSec: number;
  flipSec: number;
  flipDelta: number;
  levelBins: number;
  swingBars: number;
  poolHours: number;
  roundBps: number;
  sweepMinBps: number;
  sweepMaxBps: number;
  sweepReclaimSec: number;
  sweepBurstX: number;
  sweepHoldSec: number;
  sweepQuietSec: number;
  sweepLiqShare: number;
  sweepCooloffMin: number;
  ofiSec: number;
  ofiMin: number;
  queueMin: number;
  wallX: number;
  wallMinSec: number;
  wallBandBps: number;
  ofTargetR: number;
  ofRegime: boolean;
  // trend (daily time-series momentum, spot)
  trendL1: number;
  trendL2: number;
  trendL3: number;
  volDays: number;
  /** annualised volatility to aim for, % */
  targetVol: number;
  maxExposure: number;
  /** % of the balance the target must move before it trades */
  rebalanceBand: number;
  trendShort: boolean;
  /** only trades that go with the coin's daily trend (every style but trend) */
  trendFilter: boolean;
  /** trade manager (every style but intraday; always on for adaptive) */
  manageTrades: boolean;
  steamAtR: number;
  steamMomentum: number;
  // adaptive scalper (judgement layer)
  minScore: number;
  stopNoiseX: number;
  stopCostX: number;
  maxStopNoise: number;
  stallSec: number;
  exitMomentum: number;
  extendMomentum: number;
  trailNoiseX: number;
  watchSec: number;
  benchMin: number;
  erChop: number;
  erTrend: number;
  stopBufferBins: number;
  minRR: number;
  maxHoldSec: number;
  breakevenAtR: number;
  cooldownSec: number;
  riskUsd: number;
  maxPositionUsd: number;
  maxDailyLossUsd: number;
  maxTradesPerHour: number;
  allowShort: boolean;
  /** 'fixed' risks riskUsd; 'balance' risks riskPct of the current balance (compounding) */
  sizing: 'fixed' | 'balance';
  accountUsd: number;
  riskPct: number;
  maxLeverage: number;
  dailyLossPct: number;
  maxDrawdownPct: number;
  lossStreak: number;
  pauseMin: number;
  minNotionalUsd: number;
  targetCostX: number;
  feeBps: number;
  slippageBps: number;
  /** 'maker': post-only limit entries (and patient exits) at the maker fee, market only while the trade still pays */
  orderMode: 'maker' | 'market';
  makerFeeBps: number;
  makerWaitSec: number;
  makerChaseR: number;
  exitMakerSec: number;
  /** also rest limits on breakout-type entries (by default they go at market) */
  makerInitiative: boolean;
}

/** Growth, drawdown and score for one part of a training run. */
export interface AmtTrainSegment {
  trades: number;
  wins: number;
  winRate: number | null;
  pnl: number;
  fees: number;
  growthPct: number;
  maxDrawdownPct: number;
  profitFactor: number | null;
  score: number | null;
  startBalance: number;
}

export interface AmtTrainRow {
  params: Partial<AmtParams>;
  train: AmtTrainSegment;
  test: AmtTrainSegment;
  base: boolean;
}

export interface AmtTrainResult {
  verdict: 'verified' | 'no-edge';
  params: AmtParams | null;
  best: AmtTrainRow | null;
  baseline: { train: AmtTrainSegment; test: AmtTrainSegment };
  leaders: AmtTrainRow[];
  searched: number;
  count: number;
  from: number;
  to: number;
  splitT: number;
  venue: string;
  symbol: string;
}

export interface AmtBot {
  id: string;
  name: string;
  mode: 'paper' | 'live';
  exchangeId: string;
  symbol: string;
  secretId: string | null;
  exchangeStop: boolean;
  params: AmtParams;
  updated: number;
  running: boolean;
  feed: string | null;
}

export type AmtBotInput = Omit<AmtBot, 'id' | 'updated' | 'running' | 'feed'> & { id?: string };

export interface AmtTrade {
  side: 'buy' | 'sell';
  setup: string;
  entry: number;
  exit: number;
  qty: number;
  pnl: number;
  fees: number;
  opened: number;
  closed: number;
  reason: string;
  why: string;
  /** the stop and target the trade was opened with, and its risk per unit */
  stop0?: number;
  target0?: number;
  risk?: number;
}

export interface AmtStats {
  trades: number;
  wins: number;
  losses: number;
  pnl: number;
  fees: number;
  grossWin: number;
  grossLoss: number;
  maxDrawdown: number;
  pnlToday: number;
  winRate: number | null;
  profitFactor: number | null;
}

export interface AmtSnapshot {
  id: string;
  running: boolean;
  mode: 'paper' | 'live';
  symbol: string;
  exchange: string;
  sandbox: boolean;
  feed: string;
  feedError: string | null;
  startedAt: number;
  style: AmtParams['style'];
  session: { start: number; end: number; open: number; high: number; low: number; ib: { high: number; low: number; done: boolean } | null; trades: number; value: { vah: number; val: number; poc: number } | null } | null;
  state: string;
  t: number;
  last: number;
  bin: number;
  va: { vah: number; val: number; poc: number } | null;
  prior: { vah: number; val: number; poc: number } | null;
  probe: { dir: number; extreme: number; outsideSec: number; accepted: boolean } | null;
  flow: { deltaRatio: number; intensity: number | null } | null;
  book: { imbalance: number; spreadBps: number } | null;
  position: { side: 'buy' | 'sell'; entry: number; qty: number; stop: number; target: number; setup: string; why: string; t: number; upnl: number; be: boolean } | null;
  pending: string | null;
  /** a resting post-only limit (maker execution) */
  working: { kind: 'entry' | 'exit'; side: 'buy' | 'sell'; price: number; ageSec: number } | null;
  stats: AmtStats;
  halted: string | null;
  /** balance the bot sizes from (balance sizing only) */
  balance: number | null;
  warmupSec: number;
  lastSignal: { t: number; setup: string; side: string; price: number; why: string } | null;
  lastSkip: { t: number; event: string; reason: string } | null;
  trades: AmtTrade[];
  /** [price, volume, delta] around the last price */
  profile: [number, number, number][];
  /** one-minute candles [time, open, high, low, close, volume], oldest first */
  candles?: [number, number, number, number, number, number][];
  /** order-flow hybrid read-out (orderflow style only) */
  orderflow: AmtOrderFlow | null;
  /** the adaptive scalper's state of mind (adaptive style only) */
  brain: AmtBrain | null;
  /** trend bot read-out (trend style only) */
  trend?: AmtTrend;
  /** the coin's daily trend, when the daily-trend filter is on */
  daily?: { dir: number; up: number; votes: { L: number; ret: number; vote: number }[]; missing?: boolean } | null;
}

export interface AmtTrend {
  ready: boolean;
  explain: string;
  votes: { L: number; ret: number; vote: number }[];
  vol: number | null;
  scale: number | null;
  /** target share of the balance in the coin (−1…1) */
  target: number | null;
  held: number;
  equity: number | null;
  start: number;
  cash: number | null;
  units: number | null;
  base: string;
  closeT: number | null;
  nextCheck: number;
}

export interface AmtTrendStats {
  end: number;
  totalPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  volPct: number;
}

export interface AmtTrendBacktest {
  strategy: AmtTrendStats & { trades: number; fees: number; timeInMarket: number };
  hold: AmtTrendStats;
  years: { year: number; strategyPct: number; holdPct: number; partial?: boolean }[];
  equity: [number, number][];
  holdCurve: [number, number][];
  from: number;
  to: number;
  days: number;
  feeBps: number;
  startUsd: number;
  exchangeId: string;
  symbol: string;
}

export interface AmtBrain {
  /** typical one-minute range (price units) */
  noise: number | null;
  /** stop width in noise units — widens after noise stop-outs */
  noiseX: number;
  /** multiplies the stall time and the momentum needed to cut */
  patience: number;
  regime: { kind: 'rotation' | 'trend' | 'mixed' | 'unknown'; er: number | null; dir: number } | null;
  /** momentum −1…+1 in the open position's direction */
  momentum: number | null;
  benched: { setup: string; minutes: number; why: string }[];
  thoughts: { t: number; text: string }[];
}

export interface AmtOrderFlow {
  /** order-flow imbalance −1…+1 (null without a fresh book) */
  ofi: number | null;
  queue: number | null;
  walls: { side: 'bid' | 'ask'; price: number; q: number; ageSec: number; iceberg: boolean }[];
  /** walls pulled before price reached them, last 5 min */
  pulls: number;
  zone: { dir: number; lo: number; hi: number; touched: boolean } | null;
  sweep: { dir: number; level: number; kind: string } | null;
  absorb: { dir: number; at: number; level: string } | null;
  pools: number;
}

/** Hard limits on the swarm's live trading, kept in the main process. */
export interface SwarmLimits {
  armed: boolean;
  maxBuySol: number;
  dailySpendSol: number;
  reserveSol: number;
  slippageBps: number;
  priorityLamports: number;
  /** profits home: SOL kept in the swarm wallet, the rest sent to Phantom (0 = off) */
  sweepAboveSol: number;
}

/** A confirmed swap: the real SOL and token changes (raw units) in the wallet. */
export interface SwarmFill {
  signature: string;
  via: string;
  solDelta: number | null;
  tokenDelta: string | null;
  decimals: number | null;
  /** a sell that emptied the coin: SOL of token-account rent reclaimed by closing it */
  rentBack?: number;
}

export interface AmtEvent {
  id: string;
  t: number;
  kind: 'started' | 'stopped' | 'entry' | 'exit' | 'skip' | 'info' | 'warn' | 'error' | 'think' | 'trade' | 'story';
  text: string;
  data?: { story?: 'watch' | 'pass' | 'entry' | 'manage' | 'exit' | 'stopped'; outcome?: 'profit' | 'even' | 'loss'; trade?: AmtTrade } & Record<string, unknown>;
}

export interface AmtBacktest {
  /** whether the daily-trend filter ran ('unavailable' when daily candles could not load) */
  dailyTrend?: 'on' | 'off' | 'unavailable';
  stats: AmtStats;
  trades: AmtTrade[];
  equity: [number, number][];
  from: number | null;
  to: number | null;
  count: number;
  bin: number;
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
  app: { info(): Promise<{ version: string; platform: string; userData: string; db: DbInfo; vaultBackend: string; retentionDays: number; safeMode?: boolean }>; openExternal(url: string): Promise<void>; locked(): Promise<boolean>; unlock(code: string): Promise<boolean>; seal(): Promise<boolean>; changeKey(current: string, next: string): Promise<boolean>; leaveSafeMode(): Promise<void>; fullscreen(on?: boolean): Promise<boolean>; isFullscreen(): Promise<boolean>; onFullscreen(fn: (on: boolean) => void): () => void; status(): Promise<{ locked: boolean; sealedAt: number | null; botsRunning: number; botsLive: number }>; onSealed(fn: (reason: string) => void): () => void };
  net: { fetchJson<T = any>(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<T> };
  vault: {
    list(): Promise<SecretRecord[]>;
    save(rec: SecretInput): Promise<string>;
    remove(id: string): Promise<void>;
    copy(id: string, field: string): Promise<boolean>;
    test(id: string, opts?: { env?: 'live' | 'testnet' }): Promise<KeyTest>;
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
  report: { data(kind: ReportKind, venue?: string, symbol?: string): Promise<MainReportData> };
  amt: {
    list(): Promise<AmtBot[]>;
    defaults(): Promise<AmtParams>;
    presets(): Promise<Record<'scalp' | 'intraday' | 'growth' | 'orderflow' | 'adaptive' | 'trend', AmtParams>>;
    save(cfg: AmtBotInput): Promise<string>;
    remove(id: string): Promise<void>;
    start(id: string): Promise<boolean>;
    stop(id: string, flatten?: boolean): Promise<boolean>;
    stopAll(): Promise<number>;
    snapshot(id: string): Promise<AmtSnapshot | null>;
    events(id: string): Promise<AmtEvent[]>;
    backtest(params: AmtParams, venue: string, symbol: string, from?: number): Promise<AmtBacktest>;
    train(params: AmtParams, venue: string, symbol: string, opts?: { days?: number; n?: number }): Promise<AmtTrainResult>;
    trendBacktest(params: AmtParams, exchangeId: string, symbol: string, fromYear: number): Promise<AmtTrendBacktest>;
    onTrain(fn: (m: { progress: number }) => void): () => void;
    onStatus(fn: (s: AmtSnapshot) => void): () => void;
    onEvent(fn: (e: AmtEvent) => void): () => void;
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
  swarm: {
    wallet(): Promise<{ address: string; limits: SwarmLimits; spentToday: number; home: string | null } | null>;
    create(): Promise<string>;
    importKey(secret: string): Promise<string>;
    exportKey(): Promise<boolean>;
    remove(): Promise<boolean>;
    setLimits(p: Partial<SwarmLimits>): Promise<SwarmLimits>;
    /** the owner's verified Phantom wallet as home (null to clear) */
    setHome(address: string | null): Promise<string | null>;
    withdraw(sol: number | 'all', rpcSecretId?: string): Promise<(SwarmFill & { sol: number }) | null>;
    sweep(rpcSecretId?: string): Promise<(SwarmFill & { sol: number }) | null>;
    balance(rpcSecretId?: string): Promise<{ sol: number; spentToday: number; limits: SwarmLimits }>;
    buy(mint: string, sol: number, rpcSecretId?: string): Promise<SwarmFill>;
    sell(mint: string, raw: string, rpcSecretId?: string): Promise<SwarmFill>;
    notify(id: string, html: string): Promise<void>;
    notifyPhoto(id: string, png: Uint8Array, caption: string): Promise<void>;
    fetchImage(url: string): Promise<string>;
  };
  solana: {
    /** read-only JSON-RPC (getAccountInfo, getTokenLargestAccounts, getMultipleAccounts, …) */
    rpc(method: string, params: unknown[], rpcSecretId?: string): Promise<any>;
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
    sendPhoto(id: string, png: Uint8Array, caption: string): Promise<void>;
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

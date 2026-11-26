import type { XPost } from '../shared/xapi';
import type { Authority, LabConfig, LabDeployed, LabStatus, LabTest } from '../lab/store';
import type { ResearchResult, VariantScore } from '../lab/research';
import type { FarmCfg, FarmState } from '../lab/farm';

/** the edge finder's state as the desktop process reports it */
export type FarmView = FarmState & { starting?: boolean; wanted?: boolean };
import type { StrategySpec } from '../lab/backtest';
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

export type SecretKind = 'exchange' | 'solana-rpc' | 'telegram' | 'x-api' | 'api';

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
  /** smallest order, in base units (when the exchange says) */
  minAmount?: number | null;
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
  /** exchange-specific checks (Hyperliquid: the API wallet is approved for the account) */
  checks?: { ok: boolean | null; text: string }[] | null;
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
  /** live trend bots sharing one account's cash: the share of the free quote currency this one sizes from */
  capitalShare: number;
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

// ---------- the crypto swarm (Hyperliquid) ----------

export type CSwarmAgent = 'scalper' | 'auction' | 'trend' | 'lab' | 'tape' | 'crowd' | 'guardian' | 'forest' | 'risk';
export interface CSwarmVote {
  bot: CSwarmAgent;
  stance: 'for' | 'against' | 'abstain' | 'veto';
  weight: number;
  why: string;
}
export interface CSwarmPosition {
  id: string;
  /** how it was entered (smarter entries): a maker fill, taken at the price, part filled */
  entryHow?: string;
  /** when Micro held the entry for better timing, and what came of it */
  heldHow?: string;
  mode: 'paper' | 'live';
  coin: string;
  symbol: string;
  /** scalper: trades from before the Scalper agent was retired */
  agent: 'scalper' | 'auction' | 'trend';
  agentName?: string;
  owner: 'engine' | 'swarm';
  side: 'buy' | 'sell';
  setup: string;
  why: string;
  entry: number;
  qty: number;
  notional: number;
  stop: number;
  target: number;
  stop0: number;
  target0: number;
  risk: number;
  riskUsd: number;
  riskPct: number;
  lev: number;
  openedAt: number;
  fees: number;
  votes: CSwarmVote[];
  summary: string;
  odds: { pWin: number; pLoss: number; expR: number; trust: number };
  mgmt: { t: number; text: string }[];
  be: boolean;
  trailed: boolean;
  equityAtEntry: number;
  potential?: number;
  price?: number | null;
  upnl?: number;
  exit?: number;
  pnl?: number;
  r?: number;
  reason?: string;
  closedAt?: number;
}
export interface CSwarmLine {
  t: number;
  agent: CSwarmAgent | 'swarm' | 'council';
  text: string;
  kind: 'info' | 'warn' | 'error' | 'propose' | 'vote' | 'trade' | 'pass' | 'win' | 'loss';
}
export interface CSwarmRisk {
  riskPct: number;
  minRiskPct: number;
  maxRiskPct: number;
  kellyShare: number;
  minTrades: number;
  maxLeverage: number;
  perCoinLeverage: number;
  maxOpen: number;
  dailyLossPct: number;
  ddCut1: number;
  ddCut2: number;
  lossStreak: number;
  pauseMin: number;
  floorShare: number;
  lockAt: number;
  lockShare: number;
  minNotional: number;
}
export interface CSwarmConfig {
  exchangeId: string;
  coins: string[];
  agents: { auction: boolean; trend: boolean };
  paperStartUsd: number;
  feeBps: number;
  slippageBps: number;
  /** the fee for an order that rests in the book (maker) */
  makerFeeBps?: number;
  /** smarter entries: rest at the best price first, wait this long, chase no further than this */
  entry?: { maker: boolean; waitMs: number; chaseBps: number; holdSec?: number };
  risk: CSwarmRisk;
  council: Record<string, number>;
}
export interface CSwarmState {
  running: boolean;
  /** paused for new trades (open ones still managed) */
  holding?: boolean;
  mode: 'paper' | 'live';
  secretId: string | null;
  sandbox: boolean;
  cfg: CSwarmConfig;
  equity: number | null;
  book: { start: number; peak: number; floor: number; dayStart: number; streak: number; pausedUntil: number };
  open: CSwarmPosition[];
  closed: CSwarmPosition[];
  totals: { trades: number; wins: number; pnl: number };
  byAgent: Record<'auction' | 'trend', { trades: number; wins: number; pnl: number; avgR: number | null }>;
  /** per deployed Lab strategy: what the council did with its signals, and what the blocked ones would have made (R) */
  labBook?: Record<string, LabBook>;
  coins: { coin: string; symbol: string; price: number; feed: string; feedError: string | null; funding: number | null; daily: { dir: number; up: number } | null; engines: Record<string, { state: string; warm: boolean; lastSkip: { t: number; event: string; reason: string } | null; lastSignal: { setup: string; side: string; t: number } | null }> }[];
  lines: CSwarmLine[];
  forest: { samples: number; trained: { n: number; accuracy: number | null; baseline: number | null; trainedAt: number } | null; shadowOpen: number };
}
/** The three moments of a trade, for the chart card and Telegram. */
export interface CSwarmNotify {
  kind: 'notify';
  stage: 'setup' | 'manage' | 'result';
  mode: 'paper' | 'live';
  position: CSwarmPosition;
  /** [time, open, high, low, close] */
  candles: [number, number, number, number, number][];
  timeframe: '1m' | '1h';
  va: { vah: number; val: number; poc: number } | null;
  equity: number | null;
}
export type CSwarmEvent = { kind: 'line'; line: CSwarmLine } | CSwarmNotify;

/** A pending phone verification: send exactly `sol` SOL to `address` before `until`. */
export interface PhoneProof {
  sol: string;
  address: string;
  until: number;
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
  app: { info(): Promise<{ version: string; platform: string; userData: string; db: DbInfo; vaultBackend: string; retentionDays: number; safeMode?: boolean }>; openExternal(url: string): Promise<void>; locked(): Promise<boolean>; unlock(code: string): Promise<boolean>; seal(): Promise<boolean>; changeKey(current: string, next: string): Promise<boolean>; leaveSafeMode(): Promise<void>; fullscreen(on?: boolean): Promise<boolean>; isFullscreen(): Promise<boolean>; onFullscreen(fn: (on: boolean) => void): () => void; status(): Promise<{ locked: boolean; sealedAt: number | null; botsRunning: number; botsLive: number }>; restart(): Promise<boolean>; autoStart(on?: boolean): Promise<{ on: boolean; supported: boolean; packaged: boolean }>; onSealed(fn: (reason: string) => void): () => void; stayAwake?(on?: boolean): Promise<boolean>; onAwake?(fn: (on: boolean) => void): () => void };
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
    /** a market's recorded trades as typed columns (time, price, qty, side: 1 = buy), read off the main thread */
    query(venue: string, symbol: string, from: number, to: number): Promise<TradeColumns>;
    stats(): Promise<{ venue: string; symbol: string; n: number; first: number; last: number }[]>;
    prune(days?: number): Promise<number>;
    deleteInstrument(venue: string, symbol: string): Promise<number>;
    vacuum(): Promise<void>;
    setRetention(days: number): Promise<void>;
    exportCsv(venue: string, symbol: string): Promise<{ path: string; rows: number } | null>;
  };
  screens: {
    state(): Promise<ScreensState>;
    /** pop a panel out into its own window (on a screen, or beside the terminal); its window id */
    popout(panel: string, title: string, config: Record<string, unknown>, displayId?: number | null): Promise<number>;
    move(id: number, displayId: number, mode?: 'fill' | 'full' | 'float'): Promise<boolean>;
    /** tile a window ('self': this one) on its screen — a half, quarter or third of the whole screen — or 'full' (toggle full screen) */
    tile?(id: number | 'self', cell: TileCell): Promise<boolean>;
    /** every popped-out window on a screen ('self': this window's), side by side or in a grid */
    arrange?(displayId: number | 'self'): Promise<number>;
    /** minimise this window */
    minimize?(): Promise<void>;
    focus(id: number): Promise<boolean>;
    close(id: number): Promise<boolean>;
    /** this window's id */
    self(): Promise<number | null>;
    onChanged(fn: (s: ScreensState) => void): () => void;
    /** from a popped-out window: close it and open the panel back in the terminal */
    dock(panel: string, title: string, config: Record<string, unknown>): Promise<boolean>;
    /** the main window: a popped-out panel is coming back */
    onDock?(fn: (d: { panel: string; title: string; config: Record<string, unknown> }) => void): () => void;
    /** from a popped-out window: the order-book history the terminal has recorded (null when it cannot be had) */
    heatHistory?(): Promise<unknown>;
    /** the main window: a popped-out window asks for that history */
    onHeatAsk?(fn: (id: number) => void): () => void;
    heatReply?(id: number, data: unknown): void;
  };
  lab: {
    state(): Promise<LabStatus>;
    result(): Promise<ResearchResult | null>;
    config(patch: Partial<LabConfig>): Promise<LabConfig>;
    run(patch?: Partial<LabConfig>): Promise<LabStatus['last']>;
    cancel(): Promise<void>;
    test(spec: StrategySpec, patch?: Partial<LabConfig>): Promise<LabTest>;
    /** the optimizer: versions of a strategy measured inside the training years (never on the unseen data) */
    optimize?(specs: { id: string; spec: StrategySpec }[], patch?: Partial<LabConfig>): Promise<VariantScore[]>;
    /** candles from the Lab's history cache (topped up from the exchange): up to three years */
    bars?(coin: string, tf: '1m' | '5m' | '15m' | '1h' | '4h' | '1d', years: number): Promise<{ bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[]; source: string }>;
    deploy(args: { rank?: number; spec?: StrategySpec; tfH?: number; stats?: LabDeployed['stats']; authority?: Authority }, targets?: { crypto: boolean; meme: boolean }, coins?: string[]): Promise<string>;
    undeploy(id: string): Promise<void>;
    toggle(id: string, on: boolean): Promise<void>;
    /** who decides its trades: the council, or the strategy as tested (only Guardian and Risk can stop it) */
    authority(id: string, a: Authority): Promise<void>;
    onState(fn: (s: LabStatus) => void): () => void;
    onEvent(fn: (e: { kind: string; at?: number; id?: string; name?: string }) => void): () => void;
    /** the edge finder: a strategy farm that runs by itself while the terminal is open */
    farm?: {
      state(): Promise<FarmView>;
      start(patch?: Partial<FarmCfg>): Promise<FarmView>;
      stop(): Promise<FarmView>;
      /** keep a strategy for good (never pruned or hidden), or let it go */
      pin(id: string, on: boolean): Promise<FarmView>;
      /** the account the strategies are judged for, in dollars (and the rand it was given in) */
      account?(usd: number, zar: number | null): Promise<FarmView>;
      onState(fn: (s: FarmView) => void): () => void;
    };
  };
  cswarm: {
    state(): Promise<CSwarmState>;
    start(): Promise<boolean>;
    stop(flatten?: boolean): Promise<boolean>;
    /** pause (true) or resume (false) new trades */
    hold(on: boolean): Promise<boolean>;
    config(patch: Partial<Omit<CSwarmConfig, 'risk' | 'agents'>> & { risk?: Partial<CSwarmRisk>; agents?: Partial<CSwarmConfig['agents']> }): Promise<CSwarmConfig>;
    mode(mode: 'paper' | 'live', secretId?: string | null): Promise<'paper' | 'live'>;
    resetPaper(): Promise<void>;
    onState(fn: (s: CSwarmState) => void): () => void;
    onEvent(fn: (e: CSwarmEvent) => void): () => void;
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
    /** verify Phantom from the phone: it sends exactly `sol` to the swarm wallet (asks to confirm here) */
    verifyPhone(rpcSecretId?: string): Promise<PhoneProof | null>;
    verifyCancel(): Promise<boolean>;
    verifyState(): Promise<PhoneProof | null>;
    onVerified(fn: (r: { address?: string; expired?: boolean; refused?: string }) => void): () => void;
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
  /** X (Twitter) recent search, with the X API key in the vault */
  x: { search(id: string, query: string, max: number): Promise<XPost[]> };
  telegram: {
    me(id: string): Promise<{ username: string; name: string }>;
    detect(id: string): Promise<{ id: string; title: string }>;
    send(id: string, html: string): Promise<void>;
    sendPhoto(id: string, png: Uint8Array, caption: string): Promise<void>;
    /** start answering commands for this bot key, or stop with null */
    commands(id: string | null): Promise<boolean>;
    setStatus(snap: { price: string; status: string }): Promise<void>;
  };
  care: {
    status(): Promise<CareStatus>;
    config(patch: Partial<CareConfig>): Promise<CareStatus>;
    /** the bot chosen on the Telegram panel: the background engine sends with it too */
    bot?(id: string | null): Promise<CareStatus>;
    sendNow(kind: 'daily' | 'weekly'): Promise<boolean>;
    health(): Promise<StrategyHealth[]>;
    costs(): Promise<{ measured: Record<string, MeasuredCosts>; forTests: TestCosts }>;
  };
  journal: {
    list(q?: { from?: number; to?: number; mode?: 'live' | 'paper'; source?: JournalRow['source']; strategy?: string; limit?: number }): Promise<JournalRow[]>;
    note(id: string, note: string): Promise<void>;
    taxYears(): Promise<number[]>;
    exportCsv(): Promise<string | null>;
    tax(year: number): Promise<{ path: string; trades: number; totals: { gainsZar: number; lossesZar: number; feesZar: number; netZar: number }; missingRates: number; fxError: string } | null>;
  };
  backup: {
    create(password: string, storage: Record<string, string>): Promise<{ path: string; summary: { keys: number; trades: number; strategies: number; settings: number } } | null>;
    restore(password: string): Promise<{ storage: Record<string, string>; keys: number; trades: number } | null>;
  };
}

/** while you are away: the daily message, warnings and the weekly report (electron/care) */
export interface CareConfig {
  secretId: string;
  daily: boolean;
  dailyHour: number;
  weekly: boolean;
  /** 0 = Sunday */
  weekday: number;
  weeklyHour: number;
  warnings: boolean;
  health: boolean;
  /** offer ready teams on the phone, with Deploy buttons */
  offers: boolean;
  /** after a restart, say on Telegram that Novus Ordo waits for the ledger key */
  wakeNotice: boolean;
}
/** did the Telegram messages arrive (electron/care/delivery.mjs) */
export interface TgDelivery {
  lastOkAt: number;
  lastOkWhat: string;
  lastFailAt: number;
  lastFailWhat: string;
  /** the last failure, in plain words */
  lastWhy: string;
  failsInRow: number;
  /** two or more failures in a row since the last message that arrived */
  failing: boolean;
  recent: { t: number; ok: boolean; what: string; why?: string }[];
}

export interface CareStatus {
  delivery?: TgDelivery | null;
  cfg: CareConfig;
  running: boolean;
  lastDaily: string;
  lastWeekly: string;
  sentAt: number | null;
  nextDaily: number;
  problems: { key: string; text: string }[];
}
export interface StrategyHealth {
  id: string;
  name: string;
  on: boolean;
  deployedAt: number | null;
  status: 'early' | 'ok' | 'behind' | 'stopped' | 'quiet';
  words: string;
  trades: number;
  wins: number;
  winRate: number | null;
  avgR: number | null;
  totalR: number;
  pnl: number;
  ddR: number;
  tested: { winRate: number | null; avgR: number | null; sharpe: number | null; perYear: number | null };
  blocked: { n: number; shadowN: number; shadowR: number } | null;
  lastAt: number | null;
}
export interface MeasuredCosts {
  n: number;
  slips: number;
  slipBps: number | null;
  slipAvgBps: number | null;
  feeBps: number | null;
  feeTrades: number;
  roundTripBps: number | null;
}
export interface TestCosts {
  feeBps: number;
  slipBps: number;
  measured: boolean;
  n: number;
  venue: string | null;
  why: string;
}
export interface JournalRow {
  id: string;
  source: 'swarm' | 'lab' | 'bot' | 'lane';
  who: string | null;
  strategy_id: string | null;
  mode: 'live' | 'paper';
  venue: string | null;
  symbol: string | null;
  coin: string | null;
  quote: string | null;
  side: 'buy' | 'sell';
  qty: number | null;
  entry: number | null;
  exit: number | null;
  ask_entry: number | null;
  ask_exit: number | null;
  fees: number;
  fee_real: number;
  fills_real: number;
  pnl: number;
  r: number | null;
  risk_usd: number | null;
  opened: number | null;
  closed: number;
  reason: string | null;
  why: string | null;
  detail: string | null;
  note: string | null;
}

/** Present only inside the Electron desktop app. */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** where a tile sits: halves, quarters, thirds of the whole screen, or full screen */
export type TileCell = 'full' | 'left' | 'right' | 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br' | 'l3' | 'm3' | 'r3';

export interface ScreensState {
  displays: { id: number; label: string; primary: boolean; internal: boolean; bounds: ScreenRect; workArea: ScreenRect; scale: number }[];
  windows: { id: number; kind: 'main' | 'panel'; title: string; panel: string | null; displayId: number; bounds: ScreenRect; maximized: boolean; fullScreen: boolean; visible: boolean; tiled?: string | null }[];
}

export const desktop: NovusApi | undefined = typeof window !== 'undefined' ? (window as unknown as { novus?: NovusApi }).novus : undefined;
export const isDesktop = Boolean(desktop);

export class DesktopOnlyError extends Error {
  constructor(feature: string) {
    super(`${feature} runs in the Novus Ordo desktop app (browsers block exchange APIs and local databases).`);
  }
}

export interface LabBook {
  signals: number;
  blocked: number;
  /** who blocked: a bot's veto, or "score" (not enough votes for) */
  blockedBy: Record<string, number>;
  /** refused because the swarm already held the coin */
  refused: number;
  taken: number;
  takenR: number;
  /** blocked signals followed to their exits anyway */
  shadowN: number;
  shadowR: number;
}

/** recorded trades as typed columns: compact to send between processes */
export interface TradeColumns {
  t: Float64Array;
  p: Float64Array;
  q: Float64Array;
  s: Uint8Array;
}

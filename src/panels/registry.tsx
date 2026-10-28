import type { ReactElement } from 'react';
import type { PanelProps } from '../ui/controls';
import { AccountsPanel, ACCOUNTS_DEFAULTS } from './AccountsPanel';
import { AlertsPanel, ALERTS_DEFAULTS } from './AlertsPanel';
import { AmtScalper, AMT_DEFAULTS } from './AmtScalper';
import { DatabasePanel, DATABASE_DEFAULTS } from './DatabasePanel';
import { MemeScanner, MEME_SCANNER_DEFAULTS } from './MemeScanner';
import { MemeToken, MEME_TOKEN_DEFAULTS } from './MemeToken';
import { OrderTicket, TICKET_DEFAULTS } from './OrderTicket';
import { WalletPanel, WALLET_DEFAULTS } from './WalletPanel';
import { YahooPanel, YAHOO_DEFAULTS } from './YahooPanel';
import { TelegramPanel, TELEGRAM_DEFAULTS } from './TelegramPanel';
import { Calculator, CALC_DEFAULTS } from './Calculator';
import { CvdChart, CVD_DEFAULTS } from './CvdChart';
import { DepthChart, DEPTH_DEFAULTS } from './DepthChart';
import { DomLadder, DOM_DEFAULTS } from './DomLadder';
import { FlowPulse, FLOW_DEFAULTS } from './FlowPulse';
import { FootprintChart, FOOTPRINT_DEFAULTS } from './FootprintChart';
import { FundingMonitor, FUNDING_DEFAULTS } from './FundingMonitor';
import { HistoricalChart, HISTORICAL_DEFAULTS } from './HistoricalChart';
import { Journal, JOURNAL_DEFAULTS } from './Journal';
import { LiquidityHeatmap, HEATMAP_DEFAULTS } from './LiquidityHeatmap';
import { Liquidations, LIQ_DEFAULTS } from './Liquidations';
import { NewsFeed, NEWS_DEFAULTS } from './NewsFeed';
import { OpenInterest, OI_DEFAULTS } from './OpenInterest';
import { OptionsFlow, OPTIONS_DEFAULTS } from './OptionsFlow';
import { Orderbook, ORDERBOOK_DEFAULTS } from './Orderbook';
import { OrderbookStats, OBSTATS_DEFAULTS } from './OrderbookStats';
import { Screener, SCREENER_DEFAULTS } from './Screener';
import { SpreadChart, SPREAD_DEFAULTS } from './SpreadChart';
import { SymbolSummary, SUMMARY_DEFAULTS } from './SymbolSummary';
import { TradesTape, TAPE_DEFAULTS } from './TradesTape';
import { VolumeProfilePanel, VPROFILE_DEFAULTS } from './VolumeProfilePanel';
import { Watchlist, WATCHLIST_DEFAULTS } from './Watchlist';
import { WhaleTracker, WHALES_DEFAULTS } from './WhaleTracker';

export type Category = 'Meme' | 'Charts' | 'Orderflow' | 'Order book' | 'Derivatives' | 'Market' | 'Account' | 'Algo' | 'Tools';

export interface PanelDef {
  id: string;
  title: string;
  description: string;
  category: Category;
  component: (p: PanelProps<any>) => ReactElement;
  defaults: Record<string, unknown>;
  /** reads the aggregate set (has a Σ venue mask) rather than the primary only */
  aggregated?: boolean;
}

export const PANELS: PanelDef[] = [
  { id: 'memescan', title: 'Meme Scanner', category: 'Meme', component: MemeScanner, defaults: { ...MEME_SCANNER_DEFAULTS }, description: 'Live Solana meme coins: every pump.fun launch, coins near graduation, migrated and DexScreener-listed coins — heat, flow, room to your target and rug flags.' },
  { id: 'memetoken', title: 'Meme Token', category: 'Meme', component: MemeToken, defaults: { ...MEME_TOKEN_DEFAULTS }, description: 'One meme coin: bonding curve, market cap, on-chain safety checks, buy/sell flow, creator activity, live trades and chart.' },
  { id: 'footprint', title: 'Footprint Chart', category: 'Charts', component: FootprintChart, defaults: { ...FOOTPRINT_DEFAULTS }, description: 'Bid×ask clusters, delta, imbalances, POC, heatmap/CVD/VP/bubble overlays, time/tick/volume/range bars.' },
  { id: 'heatmap', title: 'Liquidity Heatmap', category: 'Charts', component: LiquidityHeatmap, defaults: { ...HEATMAP_DEFAULTS }, aggregated: true, description: 'Historical depth-of-market heatmap with trade bubbles and live book profile.' },
  { id: 'historical', title: 'Historical Chart', category: 'Charts', component: HistoricalChart, defaults: { ...HISTORICAL_DEFAULTS }, description: 'Candlesticks or TPO market profile with VWAP, session volume profile, MAs and EMA clouds.' },
  { id: 'vprofile', title: 'Volume Profile', category: 'Charts', component: VolumeProfilePanel, defaults: { ...VPROFILE_DEFAULTS }, description: 'Session or rolling volume profile with POC, value area and delta per level.' },
  { id: 'dom', title: 'DOM Ladder', category: 'Order book', component: DomLadder, defaults: { ...DOM_DEFAULTS }, description: 'Price ladder: resting bids/asks, traded volume, delta and session range. Click a level to price the Order Ticket.' },
  { id: 'orderbook', title: 'Orderbook', category: 'Order book', component: Orderbook, defaults: { ...ORDERBOOK_DEFAULTS }, aggregated: true, description: 'Composite multi-venue order book with per-venue contribution.' },
  { id: 'depth', title: 'Depth Chart', category: 'Order book', component: DepthChart, defaults: { ...DEPTH_DEFAULTS }, aggregated: true, description: 'Cumulative bid/ask depth across venues.' },
  { id: 'obstats', title: 'Orderbook Stats', category: 'Order book', component: OrderbookStats, defaults: { ...OBSTATS_DEFAULTS }, aggregated: true, description: 'Spread, depth within 0.5/2/10% and book imbalance per venue.' },
  { id: 'tape', title: 'Trades Tape', category: 'Orderflow', component: TradesTape, defaults: { ...TAPE_DEFAULTS }, aggregated: true, description: 'Time & sales across venues with size tiers, filters and aggregation.' },
  { id: 'flowpulse', title: 'Flow Pulse', category: 'Orderflow', component: FlowPulse, defaults: { ...FLOW_DEFAULTS }, aggregated: true, description: 'Rolling 30s/1m/5m/15m buy vs sell notional and per-venue delta.' },
  { id: 'cvd', title: 'CVD', category: 'Orderflow', component: CvdChart, defaults: { ...CVD_DEFAULTS }, aggregated: true, description: 'Cumulative volume delta per venue and aggregated.' },
  { id: 'whales', title: 'Whale Tracker', category: 'Orderflow', component: WhaleTracker, defaults: { ...WHALES_DEFAULTS }, aggregated: true, description: 'Large prints and liquidations across venues with net whale flow.' },
  { id: 'liquidations', title: 'Liquidations', category: 'Derivatives', component: Liquidations, defaults: { ...LIQ_DEFAULTS }, aggregated: true, description: 'Forced orders feed with long/short totals and timeline.' },
  { id: 'oi', title: 'Open Interest', category: 'Derivatives', component: OpenInterest, defaults: { ...OI_DEFAULTS }, aggregated: true, description: 'Open interest in USD per venue and aggregated.' },
  { id: 'funding', title: 'Funding', category: 'Derivatives', component: FundingMonitor, defaults: { ...FUNDING_DEFAULTS }, aggregated: true, description: 'Funding rates, APR, countdown and basis across perp venues.' },
  { id: 'options', title: 'Options Flow', category: 'Derivatives', component: OptionsFlow, defaults: { ...OPTIONS_DEFAULTS }, description: 'Deribit option prints: premium, IV, strikes, put/call and block trades.' },
  { id: 'spread', title: 'Spread Chart', category: 'Market', component: SpreadChart, defaults: { ...SPREAD_DEFAULTS }, aggregated: true, description: 'Price difference of each venue versus the primary.' },
  { id: 'summary', title: 'Symbol Summary', category: 'Market', component: SymbolSummary, defaults: { ...SUMMARY_DEFAULTS }, description: 'Price, 24h stats, funding, OI, long/short ratio and basis.' },
  { id: 'screener', title: 'Screener', category: 'Market', component: Screener, defaults: { ...SCREENER_DEFAULTS }, description: 'All perps on a venue: price, change, volume, funding, OI.' },
  { id: 'watchlist', title: 'Watchlist', category: 'Market', component: Watchlist, defaults: { ...WATCHLIST_DEFAULTS }, description: 'Prices for any symbol on any supported venue.' },
  { id: 'yahoo', title: 'Yahoo Finance', category: 'Market', component: YahooPanel, defaults: { ...YAHOO_DEFAULTS }, description: 'Stocks, indices, futures, FX and crypto from Yahoo Finance: quote board, search and candles.' },
  { id: 'news', title: 'News', category: 'Market', component: NewsFeed, defaults: { ...NEWS_DEFAULTS }, description: 'Real-time headlines (Tree of Alpha) filtered by coin.' },
  { id: 'ticket', title: 'Order Ticket', category: 'Account', component: OrderTicket, defaults: { ...TICKET_DEFAULTS }, description: 'Place market, limit, stop and stop-limit orders on any CCXT exchange, with value cap, confirmation and an order log. Click a DOM level to set the price.' },
  { id: 'accounts', title: 'Exchange Accounts', category: 'Account', component: AccountsPanel, defaults: { ...ACCOUNTS_DEFAULTS }, description: 'Balances, positions, open orders and fills from any CCXT exchange using keys in your vault.' },
  { id: 'wallet', title: 'Phantom Wallet', category: 'Account', component: WalletPanel, defaults: { ...WALLET_DEFAULTS }, description: 'Connect Phantom (signed proof of ownership) or watch any Solana address: SOL, tokens and USD value.' },
  { id: 'database', title: 'Database', category: 'Account', component: DatabasePanel, defaults: { ...DATABASE_DEFAULTS }, description: 'Local SQLite: recorded trades per instrument, retention, CSV export, key and wallet counts.' },
  { id: 'amt', title: 'AMT Bots', category: 'Algo', component: AmtScalper, defaults: { ...AMT_DEFAULTS }, description: 'Auction Market Theory bots for any symbol — Scalp (rolling value, order flow, minutes) or Intraday (initial balance, prior-day value, holds for hours). Paper or live, on/off switch, backtest on recorded trades.' },
  { id: 'telegram', title: 'Telegram Bot', category: 'Tools', component: TelegramPanel, defaults: { ...TELEGRAM_DEFAULTS }, description: 'Send alerts to Telegram and answer /price and /status from your chat.' },
  { id: 'alerts', title: 'Alerts', category: 'Tools', component: AlertsPanel, defaults: { ...ALERTS_DEFAULTS }, description: 'Twelve alert types evaluated in your browser against the live feed.' },
  { id: 'journal', title: 'Journal', category: 'Tools', component: Journal, defaults: { ...JOURNAL_DEFAULTS }, description: 'Timestamped trading notes stored in your browser.' },
  { id: 'calculator', title: 'Calculator', category: 'Tools', component: Calculator, defaults: { ...CALC_DEFAULTS }, description: 'Position size, risk/reward, liquidation estimate and market-cap math.' },
];

export const PANEL_MAP = Object.fromEntries(PANELS.map((p) => [p.id, p]));

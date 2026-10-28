import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { VenueId } from '../core/types';
import type { FilterId, GlassLevel, ThemeId } from '../ui/theme';

/** localStorage wrapper that never throws (private mode, blocked storage, previews). */
export const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export type HistorySource = 'none' | 'exchange' | 'byod' | 'local';

export type AlertType =
  | 'price_above'
  | 'price_below'
  | 'large_trade'
  | 'liquidation'
  | 'liq_cascade'
  | 'cvd_divergence'
  | 'absorption'
  | 'wall_appear'
  | 'wall_pulled'
  | 'volume_spike'
  | 'delta_spike'
  | 'oi_change';

export interface AlertRule {
  id: string;
  type: AlertType;
  enabled: boolean;
  /** primary: only the primary instrument; aggregate: every visible venue */
  scope: 'primary' | 'aggregate';
  /** price for price alerts, USD notional for size alerts, percent for OI change, multiple for volume spike */
  value: number;
  windowSec: number;
  cooldownSec: number;
  sound: boolean;
  notify: boolean;
  note?: string;
}

export interface FiredAlert {
  id: string;
  ruleId: string;
  type: AlertType;
  time: number;
  message: string;
  price?: number;
}

export interface JournalEntry {
  id: string;
  time: number;
  base: string;
  price: number;
  text: string;
  tags: string[];
}

export interface SavedWallet {
  address: string;
  chain: 'solana';
  /** true when ownership was proven by a signed message */
  verified: boolean;
  label?: string;
}

export interface WatchItem {
  venue: VenueId;
  symbol: string;
}

export interface Settings {
  base: string;
  primaryVenue: VenueId;
  aggregateVenues: VenueId[];
  historySource: HistorySource;
  /** CCXT venue: exchange id, market type and quote currency */
  ccxtExchange: string;
  ccxtType: 'spot' | 'swap';
  ccxtQuote: string;
  /** desktop: record trades into the local database */
  recordTrades: boolean;
  recordScope: 'primary' | 'aggregate';
  wallets: SavedWallet[];
  /** Telegram bot (vault key id), alert forwarding and command replies */
  telegramSecretId: string;
  telegramAlerts: boolean;
  /** the bots' plain-English story: watching, entry, safe, exit */
  telegramBotStory: boolean;
  telegramCommands: boolean;
  /** ask before sending each order from the ticket */
  confirmOrders: boolean;
  /** scheduled Telegram reports (local time of this computer) */
  telegramDaily: boolean;
  telegramWeekly: boolean;
  reportTime: string;
  /** 0 = Sunday … 6 = Saturday */
  reportWeekday: number;
  lastDailyReport: string;
  lastWeeklyReport: string;
  /** instant Telegram notice when the primary data feed goes down / recovers */
  telegramFeedAlerts: boolean;
  /** meme scanner: Solana RPC (vault key id; '' = public RPC) */
  memeRpcSecretId: string;
  byodUrl: string;
  byodToken: string;
  backfillMinutes: number;
  theme: ThemeId;
  filter: FilterId;
  glass: GlassLevel;
  soundEnabled: boolean;
  /** USD thresholds for tape size tiers */
  tierMid: number;
  tierWhale: number;
  alerts: AlertRule[];
  fired: FiredAlert[];
  journal: JournalEntry[];
  watchlist: WatchItem[];
  showFps: boolean;
}

interface Actions {
  set(p: Partial<Settings>): void;
  setPrimary(base: string, venue: VenueId): void;
  toggleAggregate(v: VenueId): void;
  upsertAlert(a: AlertRule): void;
  removeAlert(id: string): void;
  pushFired(f: FiredAlert): void;
  clearFired(): void;
  addJournal(e: JournalEntry): void;
  updateJournal(id: string, p: Partial<JournalEntry>): void;
  removeJournal(id: string): void;
  addWatch(w: WatchItem): void;
  removeWatch(w: WatchItem): void;
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const DEFAULT_ALERTS: AlertRule[] = [
  { id: 'a-large', type: 'large_trade', enabled: true, scope: 'primary', value: 1_000_000, windowSec: 0, cooldownSec: 10, sound: true, notify: false },
  { id: 'a-liq', type: 'liquidation', enabled: true, scope: 'primary', value: 250_000, windowSec: 0, cooldownSec: 10, sound: true, notify: false },
];

const initial: Settings = {
  base: 'BTC',
  primaryVenue: 'binancef',
  aggregateVenues: ['binancef', 'bybit', 'okx', 'hyperliquid', 'coinbase'],
  // the desktop app keeps its own trade database, so it backfills from there first
  historySource: typeof window !== 'undefined' && (window as { novus?: unknown }).novus ? 'local' : 'exchange',
  ccxtExchange: 'kucoin',
  ccxtType: 'spot',
  ccxtQuote: 'USDT',
  recordTrades: true,
  recordScope: 'primary',
  wallets: [],
  telegramSecretId: '',
  telegramAlerts: false,
  telegramBotStory: true,
  telegramCommands: false,
  confirmOrders: true,
  telegramDaily: true,
  telegramWeekly: true,
  reportTime: '16:00',
  reportWeekday: 0,
  lastDailyReport: '',
  lastWeeklyReport: '',
  telegramFeedAlerts: true,
  memeRpcSecretId: '',
  byodUrl: 'http://localhost:8080',
  byodToken: '',
  backfillMinutes: 30,
  theme: 'grey',
  filter: 'none',
  glass: 'medium',
  soundEnabled: true,
  tierMid: 50_000,
  tierWhale: 500_000,
  alerts: DEFAULT_ALERTS,
  fired: [],
  journal: [],
  watchlist: [
    { venue: 'binancef', symbol: 'BTCUSDT' },
    { venue: 'binancef', symbol: 'ETHUSDT' },
    { venue: 'binancef', symbol: 'SOLUSDT' },
    { venue: 'hyperliquid', symbol: 'HYPE' },
    { venue: 'coinbase', symbol: 'BTC-USD' },
    { venue: 'kraken', symbol: 'BTC/USD' },
  ],
  showFps: true,
};

export const useSettings = create<Settings & Actions>()(
  persist(
    (set) => ({
      ...initial,
      set: (p) => set(p),
      setPrimary: (base, venue) =>
        set((s) => ({
          base: base.toUpperCase(),
          primaryVenue: venue,
          aggregateVenues: s.aggregateVenues.includes(venue) ? s.aggregateVenues : [venue, ...s.aggregateVenues],
        })),
      toggleAggregate: (v) =>
        set((s) => {
          if (v === s.primaryVenue) return {};
          const has = s.aggregateVenues.includes(v);
          return { aggregateVenues: has ? s.aggregateVenues.filter((x) => x !== v) : [...s.aggregateVenues, v] };
        }),
      upsertAlert: (a) => set((s) => ({ alerts: s.alerts.some((x) => x.id === a.id) ? s.alerts.map((x) => (x.id === a.id ? a : x)) : [...s.alerts, a] })),
      removeAlert: (id) => set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) })),
      pushFired: (f) => set((s) => ({ fired: [f, ...s.fired].slice(0, 200) })),
      clearFired: () => set({ fired: [] }),
      addJournal: (e) => set((s) => ({ journal: [e, ...s.journal] })),
      updateJournal: (id, p) => set((s) => ({ journal: s.journal.map((j) => (j.id === id ? { ...j, ...p } : j)) })),
      removeJournal: (id) => set((s) => ({ journal: s.journal.filter((j) => j.id !== id) })),
      addWatch: (w) => set((s) => (s.watchlist.some((x) => x.venue === w.venue && x.symbol === w.symbol) ? {} : { watchlist: [...s.watchlist, w] })),
      removeWatch: (w) => set((s) => ({ watchlist: s.watchlist.filter((x) => !(x.venue === w.venue && x.symbol === w.symbol)) })),
    }),
    {
      name: 'oft-settings',
      version: 4,
      // v1 had dark/light themes only
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) p.theme = p.theme === 'light' ? 'white' : 'grey';
        // v3: alerts follow the market on the chart, not every venue of the coin
        if (version < 3 && Array.isArray(p.alerts)) p.alerts = (p.alerts as AlertRule[]).map((r) => ({ ...r, scope: 'primary' }));
        // too many messages: Telegram now carries the bots' plain-English story; chart alerts and orders are opt-in
        if (version < 4) {
          p.telegramAlerts = false;
          p.telegramBotStory = true;
        }
        return p as unknown as Settings & Actions;
      },
      storage: createJSONStorage(() => safeStorage),
      partialize: (s) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'function')) as Settings,
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<Settings>) }),
    },
  ),
);

export function getSettings() {
  return useSettings.getState();
}

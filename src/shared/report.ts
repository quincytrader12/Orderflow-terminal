/**
 * Telegram daily report and weekly overview: pure composition from data the
 * desktop process (database, accounts, wallets) and the UI (live market,
 * order flow, alerts) collected. Output is Telegram HTML.
 */
import { fmtNum, fmtPct, fmtPrice, fmtUsd } from '../core/format';
import { escapeHtml } from './telegram';

export type ReportKind = 'daily' | 'weekly';

export interface PriceRange {
  n: number;
  low: number;
  high: number;
  open: number;
  close: number;
  first: number;
  last: number;
}

export interface ValueLevels extends PriceRange {
  bin: number;
  poc: number;
  vah: number;
  val: number;
  hvn: number[];
  lvn: number[];
  /** [price, volume] */
  profile: [number, number][];
  /** recorded trades, or estimated from candles when too little was recorded */
  source?: 'trades' | 'candles';
}

export interface BotTradeRef {
  bot: string;
  symbol: string;
  setup: string;
  side: string;
  pnl: number;
  closed: number;
}

export interface MainReportData {
  kind: ReportKind;
  from: number;
  to: number;
  value?: ValueLevels | null;
  priorDay?: ValueLevels | null;
  today?: PriceRange | null;
  priorWeek?: ValueLevels | null;
  bots: {
    trades: number;
    wins: number;
    pnl: number;
    fees: number;
    maxDrawdown: number;
    bots: { name: string; symbol: string; mode: string; trades: number; wins: number; pnl: number; fees: number }[];
    setups: { setup: string; trades: number; wins: number; pnl: number }[];
    best: BotTradeRef | null;
    worst: BotTradeRef | null;
    equity: [number, number][];
  };
  orders: { placed: number; rejected: number; error: number; cancelled: number };
  recorded: { instruments: number; trades: number; size: number };
  accounts: { label: string; exchange: string; balances: { currency: string; total: number }[]; positions: { symbol: string; side: string; contracts: number; unrealizedPnl: number; notional: number }[]; error: string | null }[];
  wallets: { address: string; sol?: number; usd?: number; tokens?: { symbol: string; amount: number; usd: number | null }[]; error?: string }[];
}

export interface MarketReport {
  symbol: string;
  venueName: string;
  last: number;
  change24hPct?: number;
  high24h?: number;
  low24h?: number;
  volume24hUsd?: number;
  fundingRate?: number;
  fundingIntervalH?: number;
  oiUsd?: number;
  oiChangePct?: number;
  oiSince?: number;
  /** from candles over the report window */
  periodOpen?: number;
  periodHigh?: number;
  periodLow?: number;
  feeds: { name: string; ok: boolean }[];
}

export interface FlowEvent {
  side: 'buy' | 'sell';
  usd: number;
  price: number;
  time: number;
  venue: string;
}

export interface ReportInput {
  kind: ReportKind;
  now: number;
  tz: string;
  market: MarketReport | null;
  watch: { symbol: string; venue: string; last: number; changePct?: number }[];
  flow: { since: number; liqLongUsd: number; liqShortUsd: number; topLiqs: FlowEvent[]; topWhales: FlowEvent[] };
  alerts: { count: number; byType: Record<string, number> };
  main: MainReportData | null;
  mainError?: string;
}

const e = escapeHtml;
const signedUsd = (v: number) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const amount = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 1 ? 2 : 6 });
const pct = (wins: number, n: number) => (n ? `${Math.round((wins / n) * 100)}%` : '—');

function when(now: number, tz: string, kind: ReportKind, from: number) {
  const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
  const time = new Date(now).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  return kind === 'weekly' ? `${day(from)} → ${day(now)} · ${time} (${tz})` : `${day(now)} · ${time} (${tz})`;
}

/** Where a price sits against a value area, in AMT terms. */
export function vsValue(p: number, v: Pick<ValueLevels, 'vah' | 'val'>): 'above' | 'inside' | 'below' {
  return p > v.vah ? 'above' : p < v.val ? 'below' : 'inside';
}

/** AMT read of today's open against the prior day's value. */
export function openContext(open: number, prior: ValueLevels): string {
  const where = vsValue(open, prior);
  if (where === 'above') return `Opened <b>above</b> prior-day value → initiative buyers. Acceptance above ${fmtPrice(prior.vah)} favours continuation; a move back inside and holding sets up the 80% rule toward ${fmtPrice(prior.val)}.`;
  if (where === 'below') return `Opened <b>below</b> prior-day value → initiative sellers. Acceptance below ${fmtPrice(prior.val)} favours continuation; a move back inside and holding sets up the 80% rule toward ${fmtPrice(prior.vah)}.`;
  return `Opened <b>inside</b> prior-day value → balance. Expect responsive trade at the edges (${fmtPrice(prior.val)}–${fmtPrice(prior.vah)}) until one side is accepted outside.`;
}

/** Weekly value migration: higher, lower or overlapping. */
export function migration(cur: ValueLevels, prev: ValueLevels): string {
  if (cur.val > prev.vah) return 'Value migrated <b>higher</b> (no overlap) — buyers in control.';
  if (cur.vah < prev.val) return 'Value migrated <b>lower</b> (no overlap) — sellers in control.';
  if (cur.poc > prev.poc) return 'Overlapping value, POC <b>higher</b> — balance with an upward lean.';
  if (cur.poc < prev.poc) return 'Overlapping value, POC <b>lower</b> — balance with a downward lean.';
  return 'Value unchanged — balance.';
}

function marketLines(r: ReportInput): string[] {
  const m = r.market;
  if (!m) return ['<i>No live market data (feed not connected).</i>'];
  const L: string[] = [`<b>${e(m.symbol)}</b> · ${e(m.venueName)}`];
  if (r.kind === 'weekly' && m.periodOpen) {
    const ch = ((m.last - m.periodOpen) / m.periodOpen) * 100;
    L.push(`Week: ${fmtPrice(m.periodOpen)} → <b>${fmtPrice(m.last)}</b> (${fmtPct(ch)}) · range ${fmtPrice(m.periodLow ?? NaN)}–${fmtPrice(m.periodHigh ?? NaN)}`);
  } else {
    const parts = [`Price <b>${fmtPrice(m.last)}</b>`];
    if (m.change24hPct !== undefined) parts.push(`${fmtPct(m.change24hPct)} 24h`);
    const hi = m.high24h ?? m.periodHigh;
    const lo = m.low24h ?? m.periodLow;
    if (hi && lo) parts.push(`range ${fmtPrice(lo)}–${fmtPrice(hi)}`);
    if (m.volume24hUsd) parts.push(`vol ${fmtUsd(m.volume24hUsd)}`);
    L.push(parts.join(' · '));
  }
  const d: string[] = [];
  if (m.fundingRate !== undefined) d.push(`Funding ${(m.fundingRate * 100).toFixed(4)}% (${fmtPct(m.fundingRate * (24 / (m.fundingIntervalH ?? 8)) * 365 * 100, 1)} APR)`);
  if (m.oiUsd) d.push(`OI ${fmtUsd(m.oiUsd)}${m.oiChangePct !== undefined ? ` (${fmtPct(m.oiChangePct, 1)}${oiSince(m, r)})` : ''}`);
  if (d.length) L.push(d.join(' · '));
  return L;
}

function oiSince(m: MarketReport, r: ReportInput): string {
  if (!m.oiSince) return '';
  const from = r.main?.from ?? r.now - (r.kind === 'weekly' ? 7 : 1) * 86_400_000;
  // history that reaches back to the window start is simply "24h"/"7d"
  if (m.oiSince - from < 3_600_000) return r.kind === 'weekly' ? ' 7d' : ' 24h';
  return ` since ${new Date(m.oiSince).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: r.tz })}`;
}

function valueLines(r: ReportInput): string[] {
  const main = r.main;
  const v = main?.value;
  const L: string[] = [];
  if (!v) return ['<i>Not enough recorded trades yet for a value area — keep “Record trades” on.</i>'];
  const last = r.market?.last ?? v.close;
  L.push(`${r.kind === 'weekly' ? 'Weekly' : '24h'} value${v.source === 'candles' ? ' (from candles)' : ''}: VAH <b>${fmtPrice(v.vah)}</b> · POC <b>${fmtPrice(v.poc)}</b> · VAL <b>${fmtPrice(v.val)}</b> — price ${vsValue(last, v)} value`);
  if (v.hvn.length) L.push(`High-volume nodes: ${v.hvn.map((p) => fmtPrice(p)).join(', ')}`);
  if (v.lvn.length) L.push(`Low-volume nodes: ${v.lvn.map((p) => fmtPrice(p)).join(', ')}`);
  if (r.kind === 'daily' && main?.priorDay && main.today) L.push(openContext(main.today.open, main.priorDay));
  if (r.kind === 'weekly' && main?.priorWeek) L.push(`${migration(v, main.priorWeek)} Prior week POC ${fmtPrice(main.priorWeek.poc)}.`);
  return L;
}

function flowLines(r: ReportInput): string[] {
  const f = r.flow;
  const L: string[] = [];
  const since = f.since > r.main?.from! ? ` (since ${new Date(f.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })})` : '';
  if (f.liqLongUsd || f.liqShortUsd) L.push(`Liquidations${since}: longs ${fmtUsd(f.liqLongUsd)} · shorts ${fmtUsd(f.liqShortUsd)}`);
  const row = (x: FlowEvent, liq: boolean) => `${liq ? (x.side === 'sell' ? 'long liq' : 'short liq') : x.side === 'buy' ? 'buy' : 'sell'} ${fmtUsd(x.usd)} @ ${fmtPrice(x.price)} (${e(x.venue)})`;
  if (f.topLiqs.length) L.push(`Largest liquidations: ${f.topLiqs.map((x) => row(x, true)).join(' · ')}`);
  if (f.topWhales.length) L.push(`Largest prints: ${f.topWhales.map((x) => row(x, false)).join(' · ')}`);
  if (!L.length) L.push('<i>No large prints or liquidations recorded while the app was open.</i>');
  return L;
}

function botLines(r: ReportInput): string[] {
  const b = r.main?.bots;
  if (!b || !b.trades) return ['No AMT bot trades in this period.'];
  const L = [`${b.trades} trades · win rate ${pct(b.wins, b.trades)} · net <b>${signedUsd(b.pnl)}</b> · fees $${b.fees.toFixed(2)} · max drawdown $${b.maxDrawdown.toFixed(2)}`];
  for (const x of b.bots) L.push(`• ${e(x.name)} (${e(x.symbol)}, ${x.mode}): ${x.trades} trades · ${pct(x.wins, x.trades)} · ${signedUsd(x.pnl)}`);
  if (r.kind === 'weekly' && b.setups.length) L.push('By setup: ' + b.setups.map((s) => `${e(s.setup)} ${s.trades}× ${pct(s.wins, s.trades)} ${signedUsd(s.pnl)}`).join(' · '));
  if (b.best) L.push(`Best: ${signedUsd(b.best.pnl)} ${e(b.best.setup)} ${b.best.side === 'buy' ? 'long' : 'short'} ${e(b.best.symbol)}`);
  if (b.worst && b.worst.pnl < 0) L.push(`Worst: ${signedUsd(b.worst.pnl)} ${e(b.worst.setup)} ${b.worst.side === 'buy' ? 'long' : 'short'} ${e(b.worst.symbol)}`);
  return L;
}

/** Exchange errors often carry the signed request URL: keep only the reason. */
export function cleanError(msg: string): string {
  const s = msg
    .replace(/\s*\b(GET|POST|PUT|DELETE)?\s*https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (s.length < 12 ? `${s} — request failed (offline or blocked?)`.trim() : s).slice(0, 140);
}

function accountLines(r: ReportInput): string[] {
  const L: string[] = [];
  for (const a of r.main?.accounts ?? []) {
    if (a.error && !a.balances.length) {
      L.push(`• ${e(a.label)}: <i>${e(cleanError(a.error))}</i>`);
      continue;
    }
    L.push(`• ${e(a.label)} (${e(a.exchange)}): ${a.balances.map((x) => `${e(x.currency)} ${amount(x.total)}`).join(' · ') || 'no balances'}`);
    for (const p of a.positions.slice(0, 5)) L.push(`   ${p.side?.toUpperCase()} ${amount(p.contracts)} ${e(p.symbol)} · uPnL ${signedUsd(p.unrealizedPnl ?? 0)}`);
  }
  for (const w of r.main?.wallets ?? []) {
    const short = `${w.address.slice(0, 4)}…${w.address.slice(-4)}`;
    if (w.error) L.push(`• Phantom ${short}: <i>${e(cleanError(w.error))}</i>`);
    else L.push(`• Phantom ${short}: <b>${fmtUsd(w.usd ?? 0)}</b> · SOL ${amount(w.sol ?? 0)}${w.tokens?.length ? ' · ' + w.tokens.map((t) => `${e(t.symbol)} ${t.usd !== null ? fmtUsd(t.usd) : fmtNum(t.amount, 2)}`).join(' · ') : ''}`);
  }
  return L;
}

export function composeReport(r: ReportInput): string {
  const title = r.kind === 'weekly' ? '🗓 <b>Novus Ordo — Weekly overview</b>' : '📊 <b>Novus Ordo — Daily report</b>';
  const S: string[] = [title, when(r.now, r.tz, r.kind, r.main?.from ?? r.now - (r.kind === 'weekly' ? 7 : 1) * 86_400_000), ''];
  S.push(...marketLines(r), '');
  if (r.watch.length) {
    S.push('<b>Watchlist</b>', r.watch.map((w) => `${e(w.symbol)} ${fmtPrice(w.last)}${w.changePct !== undefined ? ` ${fmtPct(w.changePct, 1)}` : ''}`).join(' · '), '');
  }
  S.push('<b>Auction (value)</b>', ...valueLines(r), '');
  S.push('<b>Order flow</b>', ...flowLines(r), '');
  S.push('<b>AMT bots</b>', ...botLines(r), '');
  const o = r.main?.orders;
  if (o) S.push(`<b>Orders</b> ${o.placed} placed · ${o.cancelled} cancelled · ${o.rejected} rejected by limits · ${o.error} failed`, '');
  const acc = accountLines(r);
  if (acc.length) S.push('<b>Accounts</b>', ...acc, '');
  const types = Object.entries(r.alerts.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${e(t.replace(/_/g, ' '))} ×${n}`);
  S.push(`<b>Alerts</b> ${r.alerts.count} fired${types.length ? ` (${types.join(', ')})` : ''}`);
  if (r.main?.recorded) S.push(`<b>Recorded data</b> ${fmtNum(r.main.recorded.trades, 1)} trades · ${r.main.recorded.instruments} instruments · ${(r.main.recorded.size / 1e6).toFixed(0)} MB`);
  if (r.mainError) S.push(`<i>Some desktop data was unavailable: ${e(r.mainError)}</i>`);
  if (r.market) S.push('', 'Feeds: ' + r.market.feeds.map((f) => `${e(f.name)} ${f.ok ? '✓' : '✗'}`).join(' · '));
  return S.join('\n');
}

/** Local date key and whether a scheduled report is due. */
export function dueReports(now: Date, s: { time: string; weekday: number; daily: boolean; weekly: boolean; lastDaily: string; lastWeekly: string }) {
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [hh, mm] = s.time.split(':').map(Number);
  const reached = now.getHours() * 60 + now.getMinutes() >= (hh || 0) * 60 + (mm || 0);
  return {
    key,
    daily: s.daily && reached && s.lastDaily !== key,
    weekly: s.weekly && reached && now.getDay() === s.weekday && s.lastWeekly !== key,
  };
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Approximate value from candles (each candle's volume spread evenly over
 * its range) — used when the database has not recorded enough trades.
 */
export function candleValue(candles: Candle[], bins = 80, pctIn = 70): ValueLevels | null {
  const cs = candles.filter((c) => c.high > 0 && c.volume >= 0);
  if (cs.length < 5) return null;
  const lo = Math.min(...cs.map((c) => c.low));
  const hi = Math.max(...cs.map((c) => c.high));
  const step = (hi - lo) / bins || 1;
  const vol = new Array(bins).fill(0);
  for (const c of cs) {
    const a = Math.min(bins - 1, Math.floor((c.low - lo) / step));
    const b = Math.min(bins - 1, Math.floor((c.high - lo) / step));
    for (let i = a; i <= b; i++) vol[i] += c.volume / (b - a + 1);
  }
  const total = vol.reduce((x, y) => x + y, 0);
  let poc = 0;
  for (let i = 1; i < bins; i++) if (vol[i] > vol[poc]) poc = i;
  let up = poc;
  let dn = poc;
  let acc = vol[poc];
  while (acc < (total * pctIn) / 100 && (dn > 0 || up < bins - 1)) {
    const u = up < bins - 1 ? vol[up + 1] : -1;
    const d = dn > 0 ? vol[dn - 1] : -1;
    if (u >= d) acc += vol[++up];
    else acc += vol[--dn];
  }
  const px = (i: number) => lo + (i + 0.5) * step;
  return {
    n: cs.length,
    low: lo,
    high: hi,
    open: cs[0].open,
    close: cs[cs.length - 1].close,
    first: cs[0].time,
    last: cs[cs.length - 1].time,
    bin: step,
    poc: px(poc),
    vah: lo + (up + 1) * step,
    val: lo + dn * step,
    hvn: [],
    lvn: [],
    profile: vol.map((v, i) => [px(i), v] as [number, number]),
    source: 'candles',
  };
}

/** Recorded trades describe a window's value only if they cover most of it. */
export function coversWindow(v: Pick<PriceRange, 'first' | 'last'> | null | undefined, from: number, to: number, share = 0.6): boolean {
  return Boolean(v && v.last - v.first >= (to - from) * share);
}

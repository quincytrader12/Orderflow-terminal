import type { Kline } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { hub } from '../market/hub';
import { whaleEvents } from '../market/collectors';
import { candleValue, composeReport, coversWindow, dueReports, type FlowEvent, type MainReportData, type ReportInput, type ReportKind } from '../shared/report';
import { escapeHtml } from '../shared/telegram';
import { getSettings, useSettings } from '../store/settings';
import { desktop } from './bridge';
import { equityChart, priceChart } from './reportCharts';
import { telegram } from './telegram';

/**
 * Telegram daily report and weekly overview: gathers live market data here,
 * stored data (bots, orders, value areas, accounts, wallets) from the desktop
 * process, composes the message and renders chart images.
 */

const DAY = 86_400_000;
export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

export interface BuiltReport {
  kind: ReportKind;
  html: string;
  images: { png: Uint8Array; caption: string }[];
}

async function gather(kind: ReportKind, now: number): Promise<{ input: ReportInput; klines: Kline[] }> {
  const H = hub();
  const f = H.primary;
  const from = now - (kind === 'weekly' ? 7 : 1) * DAY;
  const s = getSettings();

  const klines = await timeout(f.adapter.fetchKlines(f.inst.symbol, kind === 'weekly' ? '1h' : '15m', kind === 'weekly' ? 168 : 96), 20_000).catch(() => [] as Kline[]);
  const last = f.lastPrice();
  const st = f.stats;
  const oi = f.oi.items.filter((p) => p.time >= from);
  const market = isFinite(last) || klines.length
    ? {
        symbol: f.inst.symbol,
        venueName: f.adapter.name,
        last: isFinite(last) ? last : klines[klines.length - 1]?.close ?? NaN,
        change24hPct: st.change24hPct,
        high24h: st.high24h,
        low24h: st.low24h,
        volume24hUsd: st.volume24hUsd,
        fundingRate: st.fundingRate,
        fundingIntervalH: st.fundingIntervalH,
        oiUsd: st.openInterestUsd,
        oiChangePct: oi.length > 1 && oi[0].value ? ((oi[oi.length - 1].value - oi[0].value) / oi[0].value) * 100 : undefined,
        oiSince: oi.length > 1 ? oi[0].time : undefined,
        periodOpen: klines[0]?.open,
        periodHigh: klines.length ? Math.max(...klines.map((k) => k.high)) : undefined,
        periodLow: klines.length ? Math.min(...klines.map((k) => k.low)) : undefined,
        feeds: H.aggregate.map((x) => ({ name: x.adapter.short, ok: x.status.state === 'open' })),
      }
    : null;

  const watch = (
    await Promise.allSettled(
      s.watchlist.slice(0, 10).map(async (w) => {
        const t = await timeout(ADAPTERS[w.venue].fetchTicker?.(w.symbol) ?? Promise.resolve(null), 10_000);
        return t ? { symbol: w.symbol, venue: w.venue, last: t.last, changePct: t.change24hPct } : null;
      }),
    )
  ).flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));

  const events = whaleEvents.items.filter((x) => x.time >= from);
  const toFlow = (x: (typeof events)[number]): FlowEvent => ({ side: x.side, usd: x.usd, price: x.price, time: x.time, venue: ADAPTERS[x.venue]?.short ?? x.venue });
  const liqs = events.filter((x) => x.kind === 'liq');
  const flow = {
    since: events[0]?.time ?? now,
    liqLongUsd: liqs.filter((x) => x.side === 'sell').reduce((a, x) => a + x.usd, 0),
    liqShortUsd: liqs.filter((x) => x.side === 'buy').reduce((a, x) => a + x.usd, 0),
    topLiqs: [...liqs].sort((a, b) => b.usd - a.usd).slice(0, 3).map(toFlow),
    topWhales: events.filter((x) => x.kind === 'trade').sort((a, b) => b.usd - a.usd).slice(0, 3).map(toFlow),
  };

  const fired = s.fired.filter((a) => a.time >= from);
  const byType: Record<string, number> = {};
  for (const a of fired) byType[a.type] = (byType[a.type] ?? 0) + 1;

  let main: MainReportData | null = null;
  let mainError: string | undefined;
  if (desktop) {
    try {
      main = await desktop.report.data(kind, f.inst.venue, f.inst.symbol);
    } catch (e) {
      mainError = String((e as Error).message ?? e);
    }
  } else mainError = 'bots, accounts, wallets and recorded value need the desktop app';
  if (main?.value) main.value.source = 'trades';
  if (main) {
    // reference levels must come from fully recorded periods
    const dayStart = Math.floor(now / DAY) * DAY;
    if (!coversWindow(main.priorDay, dayStart - DAY, dayStart)) main.priorDay = null;
    if (!coversWindow(main.priorWeek, from - 7 * DAY, from)) main.priorWeek = null;
    if (main.today && main.today.first - dayStart > 30 * 60_000) main.today = null;
  }
  // too little recorded history for this window: read value from the candles instead
  if (klines.length && (!main || !coversWindow(main.value, from, now))) {
    const v = candleValue(klines);
    if (main) main.value = v;
    else main = { kind, from, to: now, value: v, bots: { trades: 0, wins: 0, pnl: 0, fees: 0, maxDrawdown: 0, bots: [], setups: [], best: null, worst: null, equity: [] }, orders: { placed: 0, rejected: 0, error: 0, cancelled: 0 }, recorded: { instruments: 0, trades: 0, size: 0 }, accounts: [], wallets: [] };
  }

  return { input: { kind, now, tz: localTz(), market, watch, flow, alerts: { count: fired.length, byType }, main, mainError }, klines };
}

/** Compose the report text and render its chart images (without sending). */
export async function buildReport(kind: ReportKind, now = Date.now()): Promise<BuiltReport> {
  const { input, klines } = await gather(kind, now);
  const html = composeReport(input);
  const images: BuiltReport['images'] = [];
  const m = input.market;
  const v = input.main?.value ?? null;
  if (klines.length && m) {
    const prior = kind === 'weekly' ? input.main?.priorWeek : input.main?.priorDay;
    const png = await priceChart({
      title: `${m.symbol} · ${kind === 'weekly' ? '1h · 7 days' : '15m · 24h'}`,
      subtitle: `${m.venueName} · ${new Date(now).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`,
      klines,
      value: v,
      prior,
      last: m.last,
      weekly: kind === 'weekly',
    });
    const caption = v ? `<b>${escapeHtml(m.symbol)}</b> ${kind === 'weekly' ? 'weekly' : '24h'} value · VAH ${v.vah.toPrecision(6)} · POC ${v.poc.toPrecision(6)} · VAL ${v.val.toPrecision(6)}` : `<b>${escapeHtml(m.symbol)}</b>`;
    images.push({ png, caption });
  }
  const eq = input.main?.bots.equity ?? [];
  if (eq.length >= 2) {
    const b = input.main!.bots;
    images.push({
      png: await equityChart({ title: `AMT bots · ${kind === 'weekly' ? 'week' : '24h'} equity`, subtitle: `${b.trades} trades · ${b.pnl >= 0 ? '+' : '−'}$${Math.abs(b.pnl).toFixed(2)}`, points: eq }),
      caption: `<b>AMT bots</b> ${kind === 'weekly' ? 'weekly' : 'daily'} equity curve`,
    });
  }
  return { kind, html, images };
}

export async function sendReport(kind: ReportKind, built?: BuiltReport) {
  const s = getSettings();
  if (!s.telegramSecretId) throw new Error('Choose a Telegram bot first');
  const r = built ?? (await buildReport(kind));
  await telegram.send(s.telegramSecretId, r.html);
  for (const img of r.images) await telegram.sendPhoto(s.telegramSecretId, img.png, img.caption);
  return r;
}

let started = false;

/** Check every 30 s whether the daily or weekly report is due (local time). */
export function startReportScheduler() {
  if (started) return;
  started = true;
  let busy = false;
  let retryAt = 0;
  const check = async () => {
    const s = getSettings();
    if (busy || !s.telegramSecretId || Date.now() < retryAt) return;
    const due = dueReports(new Date(), { time: s.reportTime, weekday: s.reportWeekday, daily: s.telegramDaily, weekly: s.telegramWeekly, lastDaily: s.lastDailyReport, lastWeekly: s.lastWeeklyReport });
    if (!due.daily && !due.weekly) return;
    busy = true;
    try {
      if (due.daily) {
        await sendReport('daily');
        useSettings.getState().set({ lastDailyReport: due.key });
      }
      if (due.weekly) {
        await sendReport('weekly');
        useSettings.getState().set({ lastWeeklyReport: due.key });
      }
    } catch (e) {
      console.warn('telegram report', e);
      // try again in 10 minutes (network down, bot not linked yet …)
      retryAt = Date.now() + 600_000;
    } finally {
      busy = false;
    }
  };
  setInterval(() => void check(), 30_000);
  setTimeout(() => void check(), 15_000);
  startFeedWatch();
}

/** Instant notice when the primary feed has been down for 2 minutes, and when it recovers. */
function startFeedWatch() {
  let downSince = 0;
  let notified = false;
  setInterval(() => {
    const s = getSettings();
    const f = hub().primary;
    const down = f.status.state === 'error' || f.status.state === 'closed';
    if (down) {
      downSince ||= Date.now();
      if (!notified && Date.now() - downSince > 120_000 && s.telegramFeedAlerts && s.telegramSecretId) {
        notified = true;
        void telegram.send(s.telegramSecretId, `⚠️ <b>Data feed down</b>\n${escapeHtml(f.adapter.name)} ${escapeHtml(f.inst.symbol)} has been disconnected for 2 minutes${f.status.error ? `: ${escapeHtml(f.status.error)}` : ''}.`).catch(() => undefined);
      }
    } else {
      if (notified && s.telegramFeedAlerts && s.telegramSecretId) void telegram.send(s.telegramSecretId, `✅ <b>Data feed restored</b>\n${escapeHtml(f.adapter.name)} ${escapeHtml(f.inst.symbol)} is streaming again.`).catch(() => undefined);
      downSince = 0;
      notified = false;
    }
  }, 15_000);
}

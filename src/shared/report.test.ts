import { describe, expect, it, vi } from 'vitest';
import { candleValue, cleanError, composeReport, coversWindow, dueReports, migration, openContext, vsValue, type MainReportData, type ReportInput, type ValueLevels } from './report';
import { splitHtml, tgSendPhoto } from './telegram';

const lv = (val: number, poc: number, vah: number): ValueLevels => ({ n: 1000, low: val - 500, high: vah + 500, open: poc, close: poc, first: 0, last: 1, bin: 10, poc, vah, val, hvn: [poc + 200], lvn: [vah + 100], profile: [] });

const main: MainReportData = {
  kind: 'daily',
  from: Date.UTC(2026, 9, 18, 14),
  to: Date.UTC(2026, 9, 19, 14),
  value: lv(98_400, 98_900, 99_300),
  priorDay: lv(98_200, 98_600, 99_000),
  today: { n: 10, low: 99_000, high: 99_600, open: 99_150, close: 98_950, first: 0, last: 1 },
  bots: {
    trades: 3,
    wins: 2,
    pnl: 12.4,
    fees: 1.2,
    maxDrawdown: 4,
    bots: [{ name: 'BTC perp', symbol: 'BTC/USDT:USDT', mode: 'paper', trades: 3, wins: 2, pnl: 12.4, fees: 1.2 }],
    setups: [{ setup: 'breakout', trades: 2, wins: 2, pnl: 16.4 }],
    best: { bot: 'BTC perp', symbol: 'BTC/USDT:USDT', setup: 'breakout', side: 'buy', pnl: 9.1, closed: 0 },
    worst: { bot: 'BTC perp', symbol: 'BTC/USDT:USDT', setup: 'fade', side: 'sell', pnl: -4, closed: 0 },
    equity: [],
  },
  orders: { placed: 4, rejected: 1, error: 0, cancelled: 2 },
  recorded: { instruments: 3, trades: 1_200_000, size: 120e6 },
  accounts: [{ label: 'Bybit <main>', exchange: 'Bybit', balances: [{ currency: 'USDT', total: 2450.12 }], positions: [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 0.01, unrealizedPnl: 3.2, notional: 990 }], error: null }],
  wallets: [{ address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', sol: 5.2, usd: 1234.5, tokens: [{ symbol: 'JUP', amount: 100, usd: 80 }] }],
};

const input: ReportInput = {
  kind: 'daily',
  now: Date.UTC(2026, 9, 19, 14),
  tz: 'Africa/Johannesburg',
  market: { symbol: 'BTCUSDT', venueName: 'Binance Futures', last: 98_950, change24hPct: -0.42, high24h: 99_600, low24h: 97_800, volume24hUsd: 4.2e9, fundingRate: 0.0001, fundingIntervalH: 8, oiUsd: 8.1e9, oiChangePct: 2.3, feeds: [{ name: 'BNF', ok: true }] },
  watch: [{ symbol: 'ETHUSDT', venue: 'binancef', last: 3420, changePct: 1.2 }],
  flow: { since: Date.UTC(2026, 9, 18, 14), liqLongUsd: 2.5e6, liqShortUsd: 1e6, topLiqs: [{ side: 'sell', usd: 1.2e6, price: 98_000, time: 0, venue: 'BNF' }], topWhales: [{ side: 'buy', usd: 3e6, price: 98_500, time: 0, venue: 'BNF' }] },
  alerts: { count: 7, byType: { large_trade: 4, liquidation: 3 } },
  main,
};

describe('report composition', () => {
  it('builds the daily report with every section and escapes user text', () => {
    const html = composeReport(input);
    expect(html).toMatch(/^📊 <b>Novus Ordo — Daily report<\/b>\nMon, 19 Oct 2026 · 16:00 \(Africa\/Johannesburg\)/);
    expect(html).toContain('Price <b>98,950.0</b> · -0.42% 24h · range 97,800.0–99,600.0 · vol $4.20B');
    expect(html).toContain('Funding 0.0100% (+11.0% APR) · OI $8.10B (+2.3%)');
    expect(html).toContain('ETHUSDT 3,420.0 +1.2%');
    expect(html).toContain('24h value: VAH <b>99,300.0</b> · POC <b>98,900.0</b> · VAL <b>98,400.0</b> — price inside value');
    expect(html).toContain('Opened <b>above</b> prior-day value');
    expect(html).toContain('Liquidations: longs $2.50M · shorts $1.00M');
    expect(html).toContain('3 trades · win rate 67% · net <b>+$12.40</b>');
    expect(html).toContain('Worst: −$4.00 fade short');
    expect(html).toContain('<b>Orders</b> 4 placed · 2 cancelled · 1 rejected by limits · 0 failed');
    expect(html).toContain('Bybit &lt;main&gt; (Bybit): USDT 2,450.12');
    expect(html).toContain('LONG 0.01 BTC/USDT:USDT · uPnL +$3.20');
    expect(html).toContain('Phantom vine…KPTg: <b>$1.23K</b> · SOL 5.2 · JUP $80.00');
    expect(html).toContain('<b>Alerts</b> 7 fired (large trade ×4, liquidation ×3)');
    expect(html).toContain('1.2M trades · 3 instruments · 120 MB');
  });

  it('builds the weekly overview with value migration and setups', () => {
    const html = composeReport({ ...input, kind: 'weekly', market: { ...input.market!, periodOpen: 95_000, periodHigh: 100_100, periodLow: 94_500 }, main: { ...main, kind: 'weekly', priorWeek: lv(96_000, 96_500, 97_000) } });
    expect(html).toMatch(/^🗓 <b>Novus Ordo — Weekly overview<\/b>/);
    expect(html).toContain('Week: 95,000.0 → <b>98,950.0</b> (+4.16%) · range 94,500.0–100,100.0');
    expect(html).toContain('Weekly value: VAH');
    expect(html).toContain('Value migrated <b>higher</b> (no overlap)');
    expect(html).toContain('By setup: breakout 2× 100% +$16.40');
  });

  it('degrades gracefully without desktop data or live market', () => {
    const html = composeReport({ ...input, market: null, main: null, mainError: 'needs the desktop app', watch: [] });
    expect(html).toContain('No live market data');
    expect(html).toContain('Not enough recorded trades yet');
    expect(html).toContain('No AMT bot trades in this period.');
    expect(html).toContain('needs the desktop app');
  });

  it('reads AMT context', () => {
    const prior = lv(100, 105, 110);
    expect(vsValue(111, prior)).toBe('above');
    expect(openContext(95, prior)).toMatch(/below.*80% rule toward 110/);
    expect(openContext(104, prior)).toMatch(/inside.*balance/);
    expect(migration(lv(100, 106, 112), prior)).toMatch(/POC <b>higher<\/b>/);
    expect(migration(lv(80, 85, 90), prior)).toMatch(/lower/);
  });

  it('only trusts recorded value that covers the window, and cleans exchange errors', () => {
    expect(coversWindow({ first: 0, last: 30 * 60_000 }, 0, 86_400_000)).toBe(false);
    expect(coversWindow({ first: 0, last: 20 * 3_600_000 }, 0, 86_400_000)).toBe(true);
    expect(coversWindow(null, 0, 1)).toBe(false);
    expect(cleanError('binance GET https://api.binance.com/sapi/v1/capital/config/getall?timestamp=1&signature=abc')).toBe('binance — request failed (offline or blocked?)');
    expect(cleanError('bybit {"retCode":10003,"retMsg":"API key is invalid."}')).toBe('bybit {"retCode":10003,"retMsg":"API key is invalid."}');
    const html = composeReport({ ...input, market: { ...input.market!, oiSince: input.now - 86_000_000 }, main: { ...main, value: { ...main.value!, source: 'candles' } } });
    expect(html).toContain('OI $8.10B (+2.3% 24h)');
    expect(html).toContain('24h value (from candles): VAH');
  });

  it('approximates value from candles', () => {
    const k = (i: number, lo: number, hi: number, v: number) => ({ time: i, open: lo, high: hi, low: lo, close: hi, volume: v });
    const v = candleValue([k(0, 90, 110, 10), k(1, 99, 101, 100), k(2, 99, 101, 100), k(3, 98, 102, 50), k(4, 90, 95, 5)])!;
    expect(v.poc).toBeGreaterThan(99);
    expect(v.poc).toBeLessThan(101);
    expect(v.val).toBeGreaterThanOrEqual(97);
    expect(v.vah).toBeLessThanOrEqual(103);
    expect(candleValue([])).toBeNull();
  });
});

describe('report schedule', () => {
  const base = { time: '16:00', weekday: 0, daily: true, weekly: true, lastDaily: '', lastWeekly: '' };
  it('is due once per day from 16:00 local time, weekly on the chosen day', () => {
    const sun = new Date(2026, 9, 18, 15, 59);
    expect(dueReports(sun, base)).toEqual({ key: '2026-10-18', daily: false, weekly: false });
    const later = new Date(2026, 9, 18, 16, 0);
    expect(dueReports(later, base)).toEqual({ key: '2026-10-18', daily: true, weekly: true });
    expect(dueReports(new Date(2026, 9, 18, 22, 30), { ...base, lastDaily: '2026-10-18', lastWeekly: '2026-10-18' })).toMatchObject({ daily: false, weekly: false });
    expect(dueReports(new Date(2026, 9, 19, 16, 5), { ...base, lastDaily: '2026-10-18', lastWeekly: '2026-10-18' })).toMatchObject({ daily: true, weekly: false });
    expect(dueReports(later, { ...base, daily: false, weekly: false })).toMatchObject({ daily: false, weekly: false });
  });
});

describe('Telegram transport', () => {
  it('splits long messages on line breaks', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
    const parts = splitHtml(lines.join('\n'), 1000);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join('\n')).toBe(lines.join('\n'));
  });

  it('uploads PNGs with sendPhoto as multipart', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => ({ json: async () => ({ ok: true, result: {} }) }) as Response);
    await tgSendPhoto('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '42', new Uint8Array([137, 80, 78, 71]), '<b>chart</b>', fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/sendPhoto$/);
    const form = init.body as FormData;
    expect(form.get('chat_id')).toBe('42');
    expect(form.get('caption')).toBe('<b>chart</b>');
    expect(form.get('parse_mode')).toBe('HTML');
    expect((form.get('photo') as Blob).size).toBe(4);
    await expect(tgSendPhoto('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', '', new Uint8Array(), '')).rejects.toThrow(/Detect chat/);
  });
});

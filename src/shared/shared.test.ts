import { describe, expect, it, vi } from 'vitest';
import { recentActivity } from './solana';
import { escapeHtml, TelegramCommands, tgDetectChat, tgSend } from './telegram';
import { parseChart, yahooChart, yahooSearch, RANGE_INTERVAL } from './yahoo';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

/** Fake Bot API: records calls and replies from a method → result map. */
function botApi(results: Record<string, unknown>) {
  const calls: { method: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    const method = url.split('/').pop()!;
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return { json: async () => ({ ok: true, result: results[method] ?? true }) } as Response;
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('Yahoo Finance', () => {
  const sample = {
    chart: {
      result: [
        {
          meta: { symbol: 'AAPL', shortName: 'Apple Inc.', currency: 'USD', exchangeName: 'NMS', regularMarketPrice: 210, chartPreviousClose: 200, regularMarketDayHigh: 212, regularMarketDayLow: 199, regularMarketVolume: 5e7, regularMarketTime: 1_700_000_000 },
          timestamp: [1_700_000_000, 1_700_000_300, 1_700_000_600],
          indicators: { quote: [{ open: [200, null, 205], high: [206, null, 211], low: [199, null, 204], close: [205, null, 210], volume: [100, null, 200] }] },
        },
      ],
    },
  };

  it('parses quote and drops null bars', () => {
    const r = parseChart(sample);
    expect(r.bars).toHaveLength(2);
    expect(r.bars[0]).toEqual({ time: 1_700_000_000_000, open: 200, high: 206, low: 199, close: 205, volume: 100 });
    expect(r.quote).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', price: 210, prevClose: 200, change: 10, changePct: 5, currency: 'USD' });
  });

  it('reports Yahoo errors', () => {
    expect(() => parseChart({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } })).toThrow(/delisted/);
  });

  it('builds chart and search requests with a browser user agent', async () => {
    const fetchJson = vi.fn(async (url: string) => (url.includes('/search') ? { quotes: [{ symbol: 'NQ=F', shortname: 'Nasdaq 100 Jun 26', quoteType: 'FUTURE', exchDisp: 'CME' }, { name: 'no symbol' }] } : sample));
    await yahooChart(fetchJson, '^GSPC', '5d');
    expect(fetchJson.mock.calls[0][0]).toContain('/v8/finance/chart/%5EGSPC?range=5d&interval=15m');
    expect((fetchJson.mock.calls[0] as any)[1].headers['User-Agent']).toMatch(/Mozilla/);
    expect(await yahooSearch(fetchJson, 'nasdaq')).toEqual([{ symbol: 'NQ=F', name: 'Nasdaq 100 Jun 26', type: 'FUTURE', exchange: 'CME' }]);
    expect(RANGE_INTERVAL['1y']).toBe('1d');
  });
});

describe('Telegram', () => {
  it('rejects malformed tokens before calling the API', async () => {
    await expect(tgSend('nope', '1', 'x')).rejects.toThrow(/bot token/);
  });

  it('detects the chat from the latest update', async () => {
    const { fetchImpl } = botApi({ getUpdates: [{ update_id: 1, message: { chat: { id: 111, first_name: 'Old' } } }, { update_id: 2, message: { chat: { id: 42, first_name: 'Quincy' } } }] });
    expect(await tgDetectChat(TOKEN, fetchImpl)).toEqual({ id: '42', title: 'Quincy' });
    const empty = botApi({ getUpdates: [] });
    await expect(tgDetectChat(TOKEN, empty.fetchImpl)).rejects.toThrow(/press Start/);
  });

  it('sends HTML messages to the configured chat', async () => {
    const { calls, fetchImpl } = botApi({});
    await tgSend(TOKEN, '42', `<b>${escapeHtml('a<b & c')}</b>`, fetchImpl);
    expect(calls[0]).toEqual({ method: 'sendMessage', body: { chat_id: '42', text: '<b>a&lt;b &amp; c</b>', parse_mode: 'HTML', disable_web_page_preview: true } });
  });

  it('answers commands only in the configured chat and advances the offset', async () => {
    const { calls, fetchImpl } = botApi({});
    const bot = new TelegramCommands(TOKEN, '42', () => ({ price: 'BTC 100', status: 'all good' }), fetchImpl);
    const replies = await bot.handle([
      { update_id: 10, message: { chat: { id: 42 }, text: '/price' } },
      { update_id: 11, message: { chat: { id: 999 }, text: '/status' } },
      { update_id: 12, message: { chat: { id: 42 }, text: '/status@novus_bot' } },
      { update_id: 13, message: { chat: { id: 42 }, text: 'hello' } },
    ]);
    expect(replies).toEqual(['BTC 100', 'all good']);
    expect(calls.every((c) => c.body.chat_id === '42')).toBe(true);
    expect((bot as any).offset).toBe(14);
  });
});

describe('Solana activity', () => {
  it('maps signatures to activity rows', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ result: [{ signature: 'sig1', blockTime: 1_700_000_000, err: null, memo: null }, { signature: 'sig2', blockTime: null, err: { InstructionError: [] }, memo: 'hi' }] }),
    })) as unknown as typeof fetch;
    expect(await recentActivity('Addr', 'https://rpc.test', 2, fetchImpl)).toEqual([
      { signature: 'sig1', time: 1_700_000_000_000, ok: true, memo: null },
      { signature: 'sig2', time: null, ok: false, memo: 'hi' },
    ]);
  });
});

import type { ConnState, OptionTrade } from '../core/types';
import { fetchJson, ManagedSocket, num } from './ws';

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** Parse a Deribit option name such as BTC-27DEC24-100000-C (expiry 08:00 UTC). */
export function parseOptionName(name: string) {
  const m = /^([A-Z]+)(?:_[A-Z]+)?-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$/.exec(name);
  if (!m) return null;
  const [, underlying, d, mon, yy, strike, kind] = m;
  const expiry = Date.UTC(2000 + Number(yy), MONTHS[mon], Number(d), 8);
  return { underlying, expiry, strike: num(strike.replace('d', '.')), kind: kind as 'C' | 'P' };
}

export function toOptionTrade(t: any): OptionTrade | null {
  const p = parseOptionName(t.instrument_name);
  if (!p) return null;
  const index = num(t.index_price);
  const price = num(t.price);
  const amount = num(t.amount);
  // BTC/ETH options are inverse (premium quoted in the underlying); USDC options are linear
  const linear = /_USDC-/.test(t.instrument_name);
  return {
    id: String(t.trade_id),
    time: t.timestamp,
    instrument: t.instrument_name,
    underlying: p.underlying,
    expiry: p.expiry,
    strike: p.strike,
    kind: p.kind,
    side: t.direction === 'buy' ? 'buy' : 'sell',
    amount,
    price,
    indexPrice: index,
    premiumUsd: linear ? price * amount : price * index * amount,
    iv: t.iv !== undefined ? num(t.iv) : undefined,
    block: Boolean(t.block_trade_id),
    liquidation: Boolean(t.liquidation),
  };
}

export const OPTION_UNDERLYINGS = ['BTC', 'ETH'];

/** Live Deribit option trades for one underlying. */
export function connectOptionsFlow(
  underlying: string,
  onTrades: (t: OptionTrade[]) => void,
  onStatus: (s: ConnState, e?: string) => void,
) {
  let id = 1;
  const sock = new ManagedSocket({
    url: 'wss://www.deribit.com/ws/api/v2',
    staleMs: 90_000,
    onState: onStatus,
    onOpen: (ws) => {
      ws.send({ jsonrpc: '2.0', id: id++, method: 'public/set_heartbeat', params: { interval: 30 } });
      ws.send({ jsonrpc: '2.0', id: id++, method: 'public/subscribe', params: { channels: [`trades.option.${underlying}.100ms`] } });
    },
    onMessage: (m: any) => {
      if (m.method === 'heartbeat' && m.params?.type === 'test_request') {
        sock.send({ jsonrpc: '2.0', id: id++, method: 'public/test', params: {} });
        return;
      }
      if (m.method !== 'subscription') return;
      const trades = (m.params.data as any[]).map(toOptionTrade).filter((x): x is OptionTrade => x !== null);
      if (trades.length) onTrades(trades);
    },
  });
  void sock.connect();
  return { close: () => sock.close() };
}

/** Recent option trades to seed the panel (REST). */
export async function fetchRecentOptionTrades(underlying: string, count = 200): Promise<OptionTrade[]> {
  const r = await fetchJson(
    `https://www.deribit.com/api/v2/public/get_last_trades_by_currency?currency=${underlying}&kind=option&count=${count}&sorting=desc`,
  );
  return ((r.result?.trades ?? []) as any[])
    .map(toOptionTrade)
    .filter((x): x is OptionTrade => x !== null)
    .reverse();
}

import { useEffect, useState } from 'react';
import type { Kline } from '../../core/types';
import type { Feed } from '../../market/hub';

const cache = new Map<string, { time: number; bars: Kline[]; pending?: Promise<Kline[]> }>();

export async function loadKlines(feed: Feed, interval: string, limit: number, maxAgeMs = 60_000): Promise<Kline[]> {
  const key = `${feed.key}|${interval}|${limit}`;
  const c = cache.get(key);
  if (c && Date.now() - c.time < maxAgeMs) return c.bars;
  if (c?.pending) return c.pending;
  const pending = feed.adapter.fetchKlines(feed.inst.symbol, interval, limit);
  cache.set(key, { time: c?.time ?? 0, bars: c?.bars ?? [], pending });
  try {
    const bars = await pending;
    cache.set(key, { time: Date.now(), bars });
    return bars;
  } catch (e) {
    cache.set(key, { time: c?.time ?? 0, bars: c?.bars ?? [] });
    throw e;
  }
}

/** Fetch klines for a feed and refresh periodically. */
export function useKlines(feed: Feed | undefined, interval: string, limit: number, refreshMs = 60_000) {
  const [state, setState] = useState<{ bars: Kline[]; error?: string; loading: boolean }>({ bars: [], loading: true });
  const key = feed ? `${feed.key}|${interval}|${limit}` : '';
  useEffect(() => {
    if (!feed) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    const load = () =>
      loadKlines(feed, interval, limit, refreshMs)
        .then((bars) => alive && setState({ bars, loading: false }))
        .catch((e) => alive && setState((s) => ({ ...s, loading: false, error: String(e?.message ?? e) })));
    load();
    const t = setInterval(load, refreshMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs]);
  return state;
}

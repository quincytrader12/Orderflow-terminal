import type { ConnState, NewsItem } from '../core/types';
import { fetchJson, ManagedSocket } from './ws';

/** Normalise a Tree of Alpha message (headline, tweet or blog item). */
export function toNewsItem(m: any): NewsItem | null {
  if (!m || typeof m !== 'object') return null;
  const title: string = m.title || m.en || m.body || '';
  if (!title) return null;
  const coins = new Set<string>();
  for (const s of m.symbols ?? []) coins.add(String(s).replace(/(USDT|_.*)$/, ''));
  for (const s of m.suggestions ?? []) if (s?.coin) coins.add(String(s.coin));
  if (m.coin) coins.add(String(m.coin));
  return {
    id: String(m._id ?? m.id ?? `${m.time}-${title.slice(0, 24)}`),
    time: Number(m.time) || Date.now(),
    title: title.trim(),
    source: m.source || (m.type === 'direct' ? 'Twitter' : 'News'),
    url: m.url || m.link,
    coins: [...coins],
  };
}

export function connectNews(onItem: (n: NewsItem) => void, onStatus: (s: ConnState, e?: string) => void) {
  const sock = new ManagedSocket({
    url: 'wss://news.treeofalpha.com/ws',
    onState: onStatus,
    onMessage: (m) => {
      const n = toNewsItem(m);
      if (n) onItem(n);
    },
  });
  void sock.connect();
  return { close: () => sock.close() };
}

export async function fetchRecentNews(limit = 50): Promise<NewsItem[]> {
  const rows = await fetchJson<any[]>(`https://news.treeofalpha.com/api/news?limit=${limit}`);
  return rows.map(toNewsItem).filter((n): n is NewsItem => n !== null);
}

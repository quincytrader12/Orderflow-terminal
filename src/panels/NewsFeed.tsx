import { create } from 'zustand';
import { useEffect, useState } from 'react';
import { fmtAgo, fmtTime } from '../core/format';
import type { ConnState, NewsItem } from '../core/types';
import { connectNews, fetchRecentNews } from '../exchanges/news';
import { hub } from '../market/hub';
import { Chip, Empty, Spacer, Toolbar, useHubVersion, useTicker, type PanelProps } from '../ui/controls';

export interface NewsConfig {
  onlyPrimary: boolean;
}

export const NEWS_DEFAULTS: NewsConfig = { onlyPrimary: false };

/** Shared news stream: one socket regardless of how many News panels are open. */
const useNews = create<{ items: NewsItem[]; status: ConnState; error?: string }>(() => ({ items: [], status: 'idle' }));
let newsRefs = 0;
let newsConn: { close(): void } | null = null;

function retainNews() {
  if (newsRefs++ > 0) return;
  fetchRecentNews()
    .then((items) => useNews.setState((s) => ({ items: dedupe([...s.items, ...items]) })))
    .catch(() => undefined);
  newsConn = connectNews(
    (n) => useNews.setState((s) => ({ items: dedupe([n, ...s.items]).slice(0, 300) })),
    (status, error) => useNews.setState({ status, error }),
  );
}

function releaseNews() {
  if (--newsRefs > 0) return;
  newsConn?.close();
  newsConn = null;
}

function dedupe(items: NewsItem[]) {
  const seen = new Set<string>();
  return items
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => b.time - a.time);
}

export function NewsFeed({ config: c, setConfig }: PanelProps<NewsConfig>) {
  useHubVersion();
  useTicker(10_000);
  const { items, status, error } = useNews();
  const [q, setQ] = useState('');
  useEffect(() => {
    retainNews();
    return releaseNews;
  }, []);
  const base = hub().primary.inst.base;
  const shown = items.filter(
    (n) => (!c.onlyPrimary || n.coins.includes(base) || n.title.toUpperCase().includes(base)) && (!q || n.title.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div className="panel">
      <Toolbar>
        <Chip active={c.onlyPrimary} onClick={() => setConfig({ onlyPrimary: !c.onlyPrimary })}>
          Only {base}
        </Chip>
        <input className="ctl" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 110 }} />
        <Spacer />
        <span className={`status-dot status-${status}`} title={error ?? status} />
        <span className="muted">Tree of Alpha</span>
      </Toolbar>
      <div className="scroll">
        {shown.length === 0 ? (
          <Empty>{status === 'open' ? 'Waiting for headlines…' : status === 'error' ? `News stream unavailable (${error ?? 'error'}). Retrying…` : 'Connecting to news stream…'}</Empty>
        ) : (
          shown.map((n) => (
            <div className="list-row" key={n.id}>
              <span className="muted mono" style={{ width: 54, flexShrink: 0 }} title={fmtTime(n.time)}>
                {fmtAgo(n.time)}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ lineHeight: 1.35 }}>{n.url ? <a href={n.url} target="_blank" rel="noreferrer noopener" style={{ color: 'var(--text)', textDecoration: 'none' }}>{n.title}</a> : n.title}</div>
                <div style={{ marginTop: 3 }}>
                  <span className="tag">{n.source}</span>
                  {n.coins.slice(0, 6).map((c2) => (
                    <span className="tag" key={c2} style={c2 === base ? { color: 'var(--accent)' } : undefined}>
                      {c2}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

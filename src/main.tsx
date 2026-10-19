import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { Embed } from './app/Embed';
import { alreadyUnlocked, LockScreen } from './app/LockScreen';
import type { VenueId } from './core/types';
import { ADAPTERS } from './exchanges';
import { useSettings, type HistorySource } from './store/settings';
import { FILTERS, THEMES, type FilterId, type ThemeId } from './ui/theme';
import './styles.css';

const params = new URLSearchParams(location.search);

// Shareable state in the URL: ?base=ETH&venue=bybit&agg=binancef,okx&history=none&theme=neon-green&filter=vivid
const s = useSettings.getState();
const venue = params.get('venue') as VenueId | null;
const base = params.get('base');
if (base || (venue && venue in ADAPTERS)) s.setPrimary(base ?? s.base, venue && venue in ADAPTERS ? venue : s.primaryVenue);
const agg = params.get('agg');
if (agg !== null) {
  const list = agg.split(',').filter((v): v is VenueId => v in ADAPTERS);
  s.set({ aggregateVenues: Array.from(new Set([useSettings.getState().primaryVenue, ...list])) });
}
const history = params.get('history') as HistorySource | null;
if (history && ['none', 'exchange', 'byod'].includes(history)) s.set({ historySource: history });
const theme = params.get('theme');
if (theme && theme in THEMES) s.set({ theme: theme as ThemeId });
const filter = params.get('filter');
if (filter && FILTERS.some((f) => f.id === filter)) s.set({ filter: filter as FilterId });

const embed = params.get('embed');

/** The terminal mounts only after the ledger key is accepted. */
function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'locked' | 'open'>('checking');
  useEffect(() => {
    void alreadyUnlocked().then((open) => setState(open ? 'open' : 'locked'));
  }, []);
  if (state === 'checking') return <div className="lock" />;
  if (state === 'locked') return <LockScreen onUnlocked={() => setState('open')} />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gate>{embed ? <Embed panelId={embed} params={params} /> : <App />}</Gate>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { Embed } from './app/Embed';
import type { VenueId } from './core/types';
import { ADAPTERS } from './exchanges';
import { useSettings, type HistorySource } from './store/settings';
import './styles.css';

const params = new URLSearchParams(location.search);

// Shareable state in the URL: ?base=ETH&venue=bybit&agg=binancef,okx&history=none&theme=light
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
if (theme === 'light' || theme === 'dark') s.set({ theme });

const embed = params.get('embed');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{embed ? <Embed panelId={embed} params={params} /> : <App />}</StrictMode>,
);

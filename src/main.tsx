import { Component, StrictMode, useEffect, useState, type ReactNode } from 'react';
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
  // show the lock screen at once; a window reload while already unlocked skips it
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void alreadyUnlocked().then((o) => o && setOpen(true));
  }, []);
  if (!open) return <LockScreen onUnlocked={() => setOpen(true)} />;
  return <>{children}</>;
}

/** Any render error shows a recovery screen instead of a blank window. */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('render failed', error);
  }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="crash">
        <h2>Something went wrong while drawing the terminal</h2>
        <pre>{String(e.stack ?? e.message).slice(0, 1600)}</pre>
        <div className="crash-actions">
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              // a saved layout or setting from an older version is the usual culprit
              for (const k of Object.keys(localStorage)) if (/^(oft-|novus-layout)/.test(k)) localStorage.removeItem(k);
              location.reload();
            }}
          >
            Reset layout & settings, then reload
          </button>
        </div>
        <p className="muted">Your API keys, database and ledger key are not affected by the reset.</p>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Crash>
      <Gate>{embed ? <Embed panelId={embed} params={params} /> : <App />}</Gate>
    </Crash>
  </StrictMode>,
);

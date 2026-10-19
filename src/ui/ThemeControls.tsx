import { useSettings } from '../store/settings';
import { Select } from './controls';
import { FILTERS, GLASS_LEVELS, THEME_IDS, THEMES } from './theme';

/** Row of glass swatches for switching theme from the top bar. */
export function ThemeSwatches() {
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  return (
    <div className="swatches" role="radiogroup" aria-label="Theme">
      {THEME_IDS.map((id) => (
        <button
          key={id}
          role="radio"
          aria-checked={theme === id}
          aria-label={THEMES[id].name}
          title={THEMES[id].name}
          className={`swatch ${theme === id ? 'on' : ''}`}
          style={{ background: THEMES[id].swatch }}
          onClick={() => set({ theme: id })}
        />
      ))}
    </div>
  );
}

export function FilterSelect() {
  const filter = useSettings((s) => s.filter);
  const set = useSettings((s) => s.set);
  return <Select value={filter} options={FILTERS.map((f) => ({ value: f.id, label: `◐ ${f.name}` }))} onChange={(filter) => set({ filter })} title="Display filter" />;
}

/** Full appearance editor used in the settings modal. */
export function AppearanceSettings() {
  const { theme, filter, glass, set } = useSettings();
  return (
    <>
      <div className="section-title">Theme</div>
      <div className="theme-cards">
        {THEME_IDS.map((id) => (
          <button key={id} className={`theme-card ${theme === id ? 'on' : ''}`} onClick={() => set({ theme: id })}>
            <span className="theme-preview" style={{ background: THEMES[id].css['--bg-image'] }}>
              <span className="theme-glass" style={{ background: THEMES[id].css['--glass'], borderColor: THEMES[id].css['--glass-border'] }}>
                <i style={{ background: THEMES[id].pal.buy }} />
                <i style={{ background: THEMES[id].pal.sell }} />
                <i style={{ background: THEMES[id].pal.accent }} />
              </span>
            </span>
            <b>{THEMES[id].name}</b>
          </button>
        ))}
      </div>
      <div className="section-title">Filter</div>
      <div className="chip-row">
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip ${filter === f.id ? 'active' : ''}`} onClick={() => set({ filter: f.id })}>
            {f.name}
          </button>
        ))}
      </div>
      <div className="section-title">Glass</div>
      <div className="chip-row">
        {GLASS_LEVELS.map((g) => (
          <button key={g.id} className={`chip ${glass === g.id ? 'active' : ''}`} onClick={() => set({ glass: g.id })}>
            {g.name}
          </button>
        ))}
      </div>
    </>
  );
}

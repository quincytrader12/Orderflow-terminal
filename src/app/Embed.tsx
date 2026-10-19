import { useEffect, useState } from 'react';
import { hub } from '../market/hub';
import { startCollectors } from '../market/collectors';
import { PANEL_MAP } from '../panels/registry';
import { useThemeAttr } from './App';

/** Parse URL params onto a panel's default config, keeping each key's type. */
export function configFromParams(defaults: Record<string, unknown>, params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const [k, def] of Object.entries(defaults)) {
    const raw = params.get(k);
    if (raw === null) continue;
    if (typeof def === 'number') {
      const n = Number(raw);
      if (isFinite(n)) out[k] = n;
    } else if (typeof def === 'boolean') out[k] = raw === '1' || raw === 'true';
    else if (Array.isArray(def)) out[k] = raw ? raw.split(',') : [];
    else out[k] = raw;
  }
  return out;
}

/**
 * Single-panel view for iframes: ?embed=footprint&base=BTC&venue=binancef&interval=5m
 * Any panel config key can be passed as a query parameter.
 */
export function Embed({ panelId, params }: { panelId: string; params: URLSearchParams }) {
  useThemeAttr();
  const def = PANEL_MAP[panelId];
  const [config, setConfig] = useState(() => (def ? configFromParams(def.defaults, params) : {}));
  useEffect(() => {
    hub();
    startCollectors();
  }, []);
  if (!def)
    return (
      <div className="empty">
        Unknown panel “{panelId}”. Available: {Object.keys(PANEL_MAP).join(', ')}
      </div>
    );
  const C = def.component;
  return (
    <div className="embed-root">
      <C config={config} setConfig={(p: Record<string, unknown>) => setConfig((c) => ({ ...c, ...p }))} nodeId="embed" />
      <div className="embed-brand">Orderflow Terminal</div>
    </div>
  );
}

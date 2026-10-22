import { useEffect, useState } from 'react';
import { fmtPrice } from '../core/format';
import { desktop } from '../desktop/bridge';
import { hub } from '../market/hub';
import { useTicker } from '../ui/controls';
import { useLock } from './lock';

const ago = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/**
 * Top-left of the lock screen after the terminal has been locked: proof it is
 * still running — a live activity bar, how long it has been locked and why,
 * the market feed and the bots still working underneath.
 */
export function RunningBar() {
  useTicker(1000);
  const lockedAt = useLock((s) => s.lockedAt) ?? Date.now();
  const reason = useLock((s) => s.reason);
  const [bots, setBots] = useState<{ running: number; live: number } | null>(null);
  useEffect(() => {
    if (!desktop) return;
    const load = () =>
      desktop!.app
        .status()
        .then((s) => setBots({ running: s.botsRunning, live: s.botsLive }))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const f = hub().primary;
  const live = f.status.state === 'open';
  const price = f.lastPrice();
  return (
    <div className="running-bar" role="status" aria-label="Terminal running">
      <div className="rb-head">
        <span className="rb-dot" /> TERMINAL RUNNING <span className="rb-sealed">· SEALED</span>
      </div>
      <div className="rb-track">
        <div className="rb-sweep" />
      </div>
      <div className="rb-line">
        Locked {new Date(lockedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {ago(Date.now() - lockedAt)} ago{reason ? ` · ${reason}` : ''}
      </div>
      <div className="rb-line">
        <span className={live ? 'rb-ok' : 'rb-warn'}>{live ? '● ' : '○ '}</span>
        {f.inst.symbol} {Number.isFinite(price) ? fmtPrice(price) : '—'} · {live ? 'market data live' : f.status.state}
      </div>
      {bots && (
        <div className="rb-line">
          <span className={bots.running ? 'rb-ok' : 'rb-idle'}>{bots.running ? '● ' : '○ '}</span>
          {bots.running ? `${bots.running} AMT bot${bots.running > 1 ? 's' : ''} running${bots.live ? ` (${bots.live} live)` : ''}` : 'No bots running'}
        </div>
      )}
    </div>
  );
}

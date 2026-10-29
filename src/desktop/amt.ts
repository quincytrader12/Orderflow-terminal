import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { AmtBot, AmtEvent, AmtSnapshot } from './bridge';
import { desktop } from './bridge';

/** Latest status of every running bot, for the top-bar kill switch and panels. */
export const useAmtLive = create<{ snaps: Record<string, AmtSnapshot>; put(s: AmtSnapshot): void }>((set) => ({
  snaps: {},
  put: (s) =>
    set((st) => {
      const snaps = { ...st.snaps };
      if (s.running) snaps[s.id] = s;
      else delete snaps[s.id];
      return { snaps };
    }),
}));

let started = false;
const eventListeners = new Set<(e: AmtEvent) => void>();

/** One IPC subscription for the whole app; panels listen through it. */
export function startAmtService() {
  if (!desktop || started) return;
  started = true;
  desktop.amt.onStatus((s) => s && useAmtLive.getState().put(s));
  desktop.amt.onEvent((e) => {
    eventListeners.forEach((fn) => fn(e));
  });
}

export function onAmtEvent(fn: (e: AmtEvent) => void) {
  eventListeners.add(fn);
  return () => {
    eventListeners.delete(fn);
  };
}

/** Bot configs, refreshed whenever a bot starts, stops or trades. */
export function useAmtBots(): [AmtBot[] | null, () => void] {
  const [bots, setBots] = useState<AmtBot[] | null>(null);
  const reload = () => {
    desktop?.amt
      .list()
      .then(setBots)
      .catch(() => setBots([]));
  };
  useEffect(() => {
    reload();
    return onAmtEvent((e) => (e.kind === 'started' || e.kind === 'stopped') && reload());
  }, []);
  return [bots, reload];
}

export const AMT_STATE_LABEL: Record<string, string> = {
  warmup: 'Building value',
  balance: 'Balance — rotating inside value',
  'probe-up': 'Probing above value',
  'probe-down': 'Probing below value',
  'accepted-up': 'Accepted above value — imbalance up',
  'accepted-down': 'Accepted below value — imbalance down',
  'ib-forming': 'Initial balance forming (opening range)',
  'awaiting-prior': 'Waiting for one full session of prior value',
};

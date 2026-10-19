import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { AmtBot, AmtEvent, AmtSnapshot } from './bridge';
import { desktop } from './bridge';
import { escapeHtml } from '../shared/telegram';
import { getSettings } from '../store/settings';
import { botEntryChart } from './reportCharts';
import { forwardAlert, telegram } from './telegram';

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
    if (e.kind === 'entry') void entryWithChart(e);
    else if (e.kind === 'exit' || e.kind === 'stopped' || e.kind === 'error') forwardAlert(`AMT bot · ${e.kind}`, e.text);
  });
}

/** Entries go to Telegram as a picture of the profile with entry, stop and target. */
async function entryWithChart(e: AmtEvent) {
  const s = getSettings();
  if (!s.telegramAlerts || !s.telegramSecretId) return;
  try {
    const snap = await desktop!.amt.snapshot(e.id);
    if (!snap?.position || !snap.profile.length) throw new Error('no snapshot');
    const side = snap.position.side === 'buy' ? 'LONG' : 'SHORT';
    const png = await botEntryChart(snap, `${snap.mode === 'live' ? '' : 'PAPER · '}${side} · ${snap.position.setup}`);
    await telegram.sendPhoto(s.telegramSecretId, png, `🤖 <b>AMT bot entry</b>\n${escapeHtml(e.text)}`);
  } catch {
    forwardAlert('AMT bot · entry', e.text);
  }
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
};

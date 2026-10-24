import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { AmtBot, AmtEvent, AmtSnapshot } from './bridge';
import { desktop } from './bridge';
import { escapeHtml } from '../shared/telegram';
import { getSettings } from '../store/settings';
import { botEntryChart, botExitChart } from './reportCharts';
import { telegram } from './telegram';

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
    forwardStory(e);
  });
}

const lastProblem = new Map<string, number>();

/**
 * Telegram hears the bot's story: what it is watching and why, the entry,
 * the moment the trade is safe, and how it ended — the decision in plain
 * words with the numbers behind it. A problem that needs a look is sent once
 * an hour at most.
 */
function forwardStory(e: AmtEvent) {
  const s = getSettings();
  if (!s.telegramBotStory || !s.telegramSecretId) return;
  let text: string | null = null;
  if (e.kind === 'story') text = e.text;
  else if (e.kind === 'trade') text = `📈 Trend bot: ${e.text}`;
  else if (e.kind === 'error') {
    const last = lastProblem.get(e.text) ?? 0;
    if (Date.now() - last < 3_600_000) return;
    lastProblem.set(e.text, Date.now());
    text = `⚠️ A bot needs a look: ${e.text}`;
  }
  if (!text) return;
  // the decision in bold, the reasoning and numbers under it
  const [head, ...rest] = text.split('\n');
  const html = [`<b>${escapeHtml(head)}</b>`, ...rest.map((l) => escapeHtml(l).replace(/^(Why|Why I closed|Plan|Stop|Level|Now|Trade|Detail|Bot's notes):/, '<i>$1:</i>'))].join('\n');
  if (e.kind === 'story' && (e.data?.story === 'entry' || (e.data?.story === 'exit' && e.data.trade))) void withChart(e, s.telegramSecretId, html, head);
  else telegram.send(s.telegramSecretId, html).catch((err) => console.warn('telegram story', err));
}

/** Telegram's limit for a photo caption. */
const CAPTION_MAX = 1024;

/**
 * Entries and exits also send a picture: the candles with the trade drawn on
 * them (entry, stop, target, and the exit once closed), the value area and
 * the volume profile. The story is the caption when it fits; a longer one
 * follows the picture as its own message. Without a chart, the text alone.
 */
async function withChart(e: AmtEvent, secretId: string, html: string, head: string) {
  try {
    const snap = await desktop!.amt.snapshot(e.id);
    if (!snap?.profile.length) throw new Error('no snapshot');
    const paper = snap.mode === 'live' ? '' : 'PAPER · ';
    let png: Uint8Array;
    const tr = e.data?.trade;
    if (e.data?.story === 'exit' && tr) {
      const side = tr.side === 'buy' ? 'LONG' : 'SHORT';
      const result = e.data.outcome === 'profit' ? 'closed in profit' : e.data.outcome === 'even' ? 'closed at breakeven' : 'closed at a loss';
      png = await botExitChart(snap, `${paper}${side} · ${tr.setup} · ${result}`, tr);
    } else {
      if (!snap.position) throw new Error('no position');
      const side = snap.position.side === 'buy' ? 'LONG' : 'SHORT';
      png = await botEntryChart(snap, `${paper}${side} · ${snap.position.setup}`);
    }
    if (html.length <= CAPTION_MAX) return await telegram.sendPhoto(secretId, png, html);
    await telegram.sendPhoto(secretId, png, `<b>${escapeHtml(head)}</b>`);
  } catch (err) {
    console.warn('telegram trade chart', err);
  }
  await telegram.send(secretId, html).catch((err) => console.warn('telegram story', err));
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
